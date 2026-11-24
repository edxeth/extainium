// Operations behind the UI and the background check. Runs in extension pages
// and the service worker; installs (blob URLs) only work in pages.

import {
  base64Decode, base64Encode, extensionIdFromCrx, extensionIdFromSpki,
  generateSigningKey, importSigningKey, isCrx, packCrx3, zipFromCrx,
} from "./crx.js";
import { normalizeExtensionZip, parseZip, readManifest } from "./zip.js";
import { downloadAsset, downloadAssetHead, fetchReleases } from "./github.js";
import { compilePattern, derivePattern, latestFor, parseRepo, simplifyReleases, updateState } from "./releases.js";
import {
  deleteRepo, getRepo, getSettings, hasRepo, listRepos, makeBackup, newRecord,
  parseBackup, patchRepo, putRepo, repoKey,
} from "./store.js";
import { installCrx } from "./install.js";

async function installedExtensions() {
  const all = await chrome.management.getAll();
  return new Map(all.map((e) => [e.id, e]));
}

// [{ key, record, latest, ext, state }] for the UI and the badge.
export async function trackedView() {
  const [records, exts] = await Promise.all([listRepos(), installedExtensions()]);
  return records.map((record) => {
    const latest = latestFor(record);
    const ext = (record.extensionId && exts.get(record.extensionId)) || null;
    return { key: repoKey(record), record, latest, ext, state: updateState({ latest, installed: record.installed }, ext) };
  });
}

export async function refreshBadge() {
  const n = (await trackedView()).filter((v) => v.state === "update").length;
  await chrome.action.setBadgeBackgroundColor({ color: "#0b57d0" });
  await chrome.action.setBadgeText({ text: n ? String(n) : "" });
  return n;
}

export async function checkRepo(key) {
  const record = await getRepo(key);
  const { githubToken } = await getSettings();
  const checkedAt = Date.now();
  let res;
  try {
    res = await fetchReleases(record.owner, record.repo, {
      etag: record.releases ? record.etag : null,
      token: githubToken,
    });
  } catch (e) {
    await patchRepo(key, { error: e.message, checkedAt });
    throw e;
  }
  if (res.rate) await chrome.storage.local.set({ rateLimit: res.rate });
  if (res.notModified) return patchRepo(key, { error: null, checkedAt });
  return patchRepo(key, { releases: simplifyReleases(res.releases), etag: res.etag, error: null, checkedAt });
}

// Checks every repo; one failure does not stop the others. Returns { updates, errors }.
export async function checkAll() {
  const errors = [];
  for (const r of await listRepos()) {
    try {
      await checkRepo(repoKey(r));
    } catch (e) {
      errors.push(e.message);
    }
  }
  const updates = await refreshBadge();
  await chrome.storage.local.set({ lastCheck: { at: Date.now(), updates, errors } });
  return { updates, errors };
}

export async function addRepo(input) {
  const { owner, repo } = parseRepo(input);
  const key = repoKey({ owner, repo });
  if (await hasRepo(key)) throw new Error(`add repo: ${key} is already tracked`);
  await putRepo(newRecord(owner, repo));
  try {
    await checkRepo(key);
  } catch (e) {
    await deleteRepo(key);
    throw e;
  }
  return key;
}

// Links the record to the extension ID its current asset installs as:
// the CRX author's key for .crx, the repo's own key for .zip.
// Ends with a badge refresh, as the update state may change.
async function link(key) {
  const record = await linkNow(key);
  await refreshBadge();
  return record;
}

async function linkNow(key) {
  const record = await getRepo(key);
  const latest = latestFor(record);
  if (!latest || !latest.asset) return record;
  if (/\.crx$/i.test(latest.asset.name)) {
    const head = await downloadAssetHead(latest.asset);
    return patchRepo(key, { extensionId: await extensionIdFromCrx(head) });
  }
  const keyPkcs8 = record.keyPkcs8 || base64Encode((await generateSigningKey()).pkcs8);
  const { spki } = await importSigningKey(base64Decode(keyPkcs8));
  return patchRepo(key, { keyPkcs8, extensionId: await extensionIdFromSpki(spki) });
}

export async function setPattern(key, pattern) {
  compilePattern(pattern);
  await patchRepo(key, { pattern });
  return link(key);
}

export function chooseAsset(key, assetName, tag) {
  return setPattern(key, derivePattern(assetName, tag));
}

export async function setPrereleases(key, includePrereleases) {
  await patchRepo(key, { includePrereleases });
  return link(key);
}

// CRX copies the browser saved to Downloads, deleted once their extension
// installs or, if the prompt is declined or the install fails, after a grace period.
// pendingDownloads: { [downloadId]: { extensionId, at } }
export const PENDING_GRACE_MS = 2 * 60 * 1000;
export const SWEEP_ALARM = "sweep-downloads";

async function addPendingDownload(downloadId, extensionId) {
  const { pendingDownloads = {} } = await chrome.storage.local.get("pendingDownloads");
  pendingDownloads[downloadId] = { extensionId, at: Date.now() };
  await chrome.storage.local.set({ pendingDownloads });
  await chrome.alarms.create(SWEEP_ALARM, { delayInMinutes: PENDING_GRACE_MS / 60000 + 0.5 });
}

async function removeDownloads(shouldRemove) {
  const { pendingDownloads = {} } = await chrome.storage.local.get("pendingDownloads");
  for (const [downloadId, entry] of Object.entries(pendingDownloads)) {
    if (!shouldRemove(entry)) continue;
    await chrome.downloads.removeFile(Number(downloadId)).catch(() => {}); // file may already be gone
    await chrome.downloads.erase({ id: Number(downloadId) });
    delete pendingDownloads[downloadId];
  }
  await chrome.storage.local.set({ pendingDownloads });
}

// After an install of extensionId.
export function cleanupDownloads(extensionId) {
  return removeDownloads((e) => e.extensionId === extensionId);
}

// Declined prompts, failed installs, and anything left from earlier sessions.
export function sweepDownloads(now = Date.now()) {
  return removeDownloads((e) => now - e.at >= PENDING_GRACE_MS);
}

// Turns a .crx or .zip into an installable CRX. Zips are signed with keyPkcs8.
// Returns { crx, extensionId, manifest }.
async function prepare(bytes, keyPkcs8) {
  if (isCrx(bytes)) {
    return {
      crx: bytes,
      extensionId: await extensionIdFromCrx(bytes),
      manifest: await readManifest(parseZip(zipFromCrx(bytes))),
    };
  }
  const pkcs8 = base64Decode(keyPkcs8);
  const { bytes: zip, manifest } = await normalizeExtensionZip(bytes);
  const { spki } = await importSigningKey(pkcs8);
  return { crx: await packCrx3(zip, pkcs8), extensionId: await extensionIdFromSpki(spki), manifest };
}

// Installs the matching asset of release `tag` (default: latest). Page only.
// onProgress(text) reports the current step.
export async function installRelease(key, tag, onProgress = () => {}) {
  let record = await getRepo(key);
  let release;
  if (tag) {
    release = (record.releases || []).find((r) => r.tag === tag);
    if (!release) throw new Error(`install ${key}: no release ${tag}`);
  } else {
    const latest = latestFor(record);
    if (!latest) throw new Error(`install ${key}: no release has an asset matching ${record.pattern}`);
    release = latest.release;
  }
  const re = compilePattern(record.pattern);
  const assets = release.assets.filter((a) => re.test(a.name));
  if (assets.length !== 1) {
    throw new Error(`install ${key} ${release.tag}: pattern ${record.pattern} matches ${assets.length} assets`);
  }
  const asset = assets[0];
  onProgress(`Downloading ${asset.name}…`);
  const bytes = await downloadAsset(asset);
  if (!isCrx(bytes) && !record.keyPkcs8) {
    record = await patchRepo(key, { keyPkcs8: base64Encode((await generateSigningKey()).pkcs8) });
  }
  onProgress(isCrx(bytes) ? "Checking CRX…" : "Packing and signing CRX…");
  const { crx, extensionId, manifest } = await prepare(bytes, record.keyPkcs8);
  onProgress("Handing the CRX to the browser…");
  const downloadId = await installCrx(crx, `${manifest.name}-${manifest.version}`);
  await addPendingDownload(downloadId, extensionId);
  await patchRepo(key, { extensionId, installed: { tag: release.tag, digest: asset.digest, version: manifest.version } });
  return { extensionId, version: manifest.version, name: manifest.name };
}

// Installs a local .crx/.zip. A zip is signed with the key of tracked repo
// `signWith` or with a new key that is returned for tracking. Page only.
export async function installFile(bytes, filename, signWith) {
  let keyPkcs8 = null;
  if (!isCrx(bytes)) {
    keyPkcs8 = signWith
      ? (await getRepo(signWith)).keyPkcs8
      : base64Encode((await generateSigningKey()).pkcs8);
    if (!keyPkcs8) throw new Error(`install ${filename}: tracked repo ${signWith} has no signing key`);
  }
  const { crx, extensionId, manifest } = await prepare(bytes, keyPkcs8);
  const downloadId = await installCrx(crx, `${manifest.name || filename}-${manifest.version}`);
  await addPendingDownload(downloadId, extensionId);
  const installed = { tag: null, digest: null, version: manifest.version };
  if (signWith) await patchRepo(signWith, { extensionId, installed });
  return { extensionId, keyPkcs8, installed, name: manifest.name };
}

// Starts tracking a repo for an extension installed from a file.
export async function trackInstalledFile(input, fileResult) {
  const key = await addRepo(input);
  await patchRepo(key, {
    extensionId: fileResult.extensionId,
    keyPkcs8: fileResult.keyPkcs8,
    installed: fileResult.installed,
  });
  return key;
}

export async function removeRepo(key, uninstall) {
  const record = await getRepo(key);
  if (uninstall && record.extensionId) {
    await chrome.management.uninstall(record.extensionId, { showConfirmDialog: true });
  }
  await deleteRepo(key);
  await refreshBadge();
}

export async function exportBackup() {
  return JSON.stringify(makeBackup(await listRepos()), null, 2);
}

export async function importBackup(text) {
  const records = await parseBackup(text);
  for (const r of records) await putRepo(r);
  // The backup has no release cache; fetch it so the list shows versions again.
  const { errors } = await checkAll();
  return { count: records.length, errors };
}
