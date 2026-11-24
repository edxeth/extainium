// Operations behind the UI and the background worker. Runs in extension pages
// and the service worker; installs (blob URLs) only work in pages.
// Every read-modify-write of stored state runs under withStateLock (store.js);
// network and crypto work happens outside the lock, and its result is
// committed under the lock against a fresh read.

import {
  base64Decode, base64Encode, extensionIdFromCrx, extensionIdFromSpki,
  generateSigningKey, importSigningKey, isCrx, packCrx3, zipFromCrx,
} from "./crx.js";
import { normalizeExtensionZip, parseZip, readManifest, verifyZip } from "./zip.js";
import { downloadAsset, downloadAssetHead, fetchReleases } from "./github.js";
import {
  deriveTemplate, isPackageAsset, latestFor, matchAssets, parseRepo, selectRelease, updateState, validateTemplate,
} from "./releases.js";
import {
  INSTALL_PREFIX, KEY_PREFIX, findRepo, getRepo, getSettings, getSigningKey, listInstalls, listRepos,
  listSigningKeys, makeBackup, migrateStorage, newRecord, parseBackup, patchRepo, putInstall, putRepo,
  putSigningKeyIfAbsent, removeInstall, removeRepoRecord, removeSigningKey, repoKey, updateRepo, withStateLock,
} from "./store.js";
import { installCrx } from "./install.js";

// Migrates stored state once per context before the first operation.
let migrated = null;
function ready() {
  migrated ??= migrateStorage().catch((e) => {
    migrated = null;
    throw e;
  });
  return migrated;
}

async function installedExtensions() {
  const all = await chrome.management.getAll();
  return new Map(all.map((e) => [e.id, e]));
}

async function idOfKey(pkcs8) {
  return extensionIdFromSpki((await importSigningKey(base64Decode(pkcs8))).spki);
}

// [{ key, record, latest, ext, state, hasKey, pendingInstall }] for the UI and the badge.
// state: updateState's states, or "identity-change" while record.identityChange
// waits for confirmIdentityChange. pendingInstall: { version, tag, at } of a CRX
// handed to the browser whose install was not confirmed yet, or null.
export async function trackedView() {
  await ready();
  const [records, exts, keys, installs] = await Promise.all([listRepos(), installedExtensions(), listSigningKeys(), listInstalls()]);
  return records.map((record) => {
    const key = repoKey(record);
    const latest = latestFor(record);
    const ext = (record.extensionId && exts.get(record.extensionId)) || null;
    const state = record.identityChange ? "identity-change" : updateState({ latest, installed: record.installed }, ext);
    const pending = installs
      .filter((i) => i.repoKey === key && !i.confirmedAt && i.version)
      .sort((a, b) => b.at - a.at)[0];
    return {
      key, record, latest, ext, state,
      hasKey: key in keys,
      pendingInstall: pending ? { version: pending.version, tag: pending.installed && pending.installed.tag, at: pending.at } : null,
    };
  });
}

export async function refreshBadge() {
  const n = (await trackedView()).filter((v) => v.state === "update").length;
  await chrome.action.setBadgeBackgroundColor({ color: "#0b57d0" });
  await chrome.action.setBadgeText({ text: n ? String(n) : "" });
  return n;
}

// True when releases hold what the record needs: a release its template
// selects, or, before an asset is chosen, a release with a .crx/.zip asset.
function hasEligible(record, releases) {
  if (record.template) return selectRelease(releases, record.template, record.includePrereleases) !== null;
  return releases.some((r) => (record.includePrereleases || !r.prerelease) && r.assets.some((a) => isPackageAsset(a.name)));
}

// The page cache of the last check as fetchReleases expects it.
function cachedPages(record) {
  if (!record.pages || !record.releases) return null;
  let at = 0;
  return record.pages.map(({ count, ...p }) => {
    const releases = record.releases.slice(at, at + count);
    at += count;
    return { ...p, releases };
  });
}

export async function checkRepo(key) {
  await ready();
  const record = await getRepo(key);
  const { githubToken } = await getSettings();
  const checkedAt = Date.now();
  let res;
  try {
    res = await fetchReleases(record.owner, record.repo, {
      token: githubToken,
      cache: cachedPages(record),
      enough: (releases) => hasEligible(record, releases),
    });
  } catch (e) {
    await patchRepo(key, { error: e.message, checkedAt });
    throw e;
  }
  if (res.rate) await chrome.storage.local.set({ rateLimit: res.rate });
  return patchRepo(key, {
    releases: res.releases,
    pages: res.pages.map(({ releases, ...p }) => ({ ...p, count: releases.length })),
    error: null,
    checkedAt,
  });
}

// Checks every repo; one failure does not stop the others. Returns { updates, errors }.
export async function checkAll() {
  await ready();
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
  await ready();
  const { owner, repo } = parseRepo(input);
  const key = repoKey({ owner, repo });
  await withStateLock(async () => {
    if (await findRepo(key)) throw new Error(`add repo: ${key} is already tracked`);
    await putRepo(newRecord(owner, repo));
  });
  try {
    await checkRepo(key);
  } catch (e) {
    await withStateLock(() => removeRepoRecord(key));
    throw e;
  }
  return key;
}

// The repo's signing key; a new one is generated and stored on first use.
// When two contexts race, the first stored key wins and both use it.
async function ensureSigningKey(key) {
  const existing = await getSigningKey(key);
  if (existing) return existing;
  const fresh = base64Encode((await generateSigningKey()).pkcs8);
  return withStateLock(() => putSigningKeyIfAbsent(key, fresh));
}

// Links the record to the extension ID its current asset installs as: the
// CRX author's key for .crx, the repo's own key for .zip. When the record is
// linked to an installed extension with another ID, it is not relinked;
// record.identityChange { from, to, tag, asset } waits for confirmIdentityChange.
async function link(key) {
  const record = await linkNow(key);
  await refreshBadge();
  return record;
}

async function linkNow(key) {
  const record = await getRepo(key);
  const latest = latestFor(record);
  if (!latest || !latest.asset) return record;
  const newId = /\.crx$/i.test(latest.asset.name)
    ? await extensionIdFromCrx(await downloadAssetHead(latest.asset))
    : await idOfKey(await ensureSigningKey(key));
  const exts = await installedExtensions();
  return withStateLock(async () => {
    const r = await getRepo(key);
    const now = latestFor(r);
    // Changed meanwhile: the change that did it links again.
    if (!now || !now.asset || now.asset.url !== latest.asset.url) return r;
    const next = r.extensionId && r.extensionId !== newId && exts.has(r.extensionId)
      ? { ...r, identityChange: { from: r.extensionId, to: newId, tag: now.tag, asset: now.asset.name } }
      : { ...r, extensionId: newId, identityChange: null };
    await putRepo(next);
    return next;
  });
}

// Accepts a pending identity change: the repo now tracks the new extension ID.
export async function confirmIdentityChange(key) {
  await ready();
  const record = await updateRepo(key, (r) => {
    if (!r.identityChange) throw new Error(`confirm identity change of ${key}: no identity change is pending`);
    return { ...r, extensionId: r.identityChange.to, identityChange: null };
  });
  await refreshBadge();
  return record;
}

// template: asset file name template (releases.js), e.g. "ext-{version}.zip".
export async function setTemplate(key, template) {
  await ready();
  validateTemplate(template);
  // A new template replaces whatever made the old one fail (e.g. a migration error).
  await patchRepo(key, { template, error: null });
  return link(key);
}

export function chooseAsset(key, assetName, tag) {
  return setTemplate(key, deriveTemplate(assetName, tag));
}

export async function setPrereleases(key, includePrereleases) {
  await ready();
  if (typeof includePrereleases !== "boolean") throw new Error(`set pre-releases of ${key}: not true/false: ${includePrereleases}`);
  await patchRepo(key, { includePrereleases });
  return link(key);
}

// ---- Hand-off to the browser and download cleanup ----
// Each CRX handed to the browser gets an "install:<token>" entry:
//   { token, repoKey|null, extensionId, version, installed: {tag, digest, version},
//     downloadId|null, downloadDone, at, confirmedAt|null, fileGone, removeError|null }
// management.onInstalled with the same ID and version confirms it: only then is
// record.installed committed. The downloaded copy is deleted after the
// confirmation, or after PENDING_GRACE_MS when the prompt was declined or the
// install failed. Only downloads Extainium started are ever deleted.
export const PENDING_GRACE_MS = 2 * 60 * 1000;
// How long an unconfirmed install may still be confirmed after its copy was deleted.
export const CONFIRM_WINDOW_MS = 24 * 60 * 60 * 1000;
export const SWEEP_ALARM = "sweep-downloads";

const getInstall = async (token) => (await chrome.storage.local.get(INSTALL_PREFIX + token))[INSTALL_PREFIX + token] || null;

// Deletes the entry's downloaded file and its download-list item; inside the lock.
// Keeps the entry with removeError when the file could not be deleted.
async function deleteCopy(entry) {
  const id = entry.downloadId;
  try {
    try {
      await chrome.downloads.removeFile(id);
    } catch (e) {
      // "Invalid downloadId": the item was erased, nothing left to address.
      if (/invalid download ?id/i.test(e.message)) return { ...entry, fileGone: true, removeError: null };
      // "Download must be complete": interrupted; erase deletes its partial file.
      if (!/already deleted|must be complete/i.test(e.message)) throw e;
    }
    await chrome.downloads.erase({ id });
    return { ...entry, fileGone: true, removeError: null };
  } catch (e) {
    return { ...entry, removeError: `delete download #${id}: ${e.message}` };
  }
}

// Saves entry, or drops it once nothing is left to do for it: confirmed and
// its copy deleted; a failed download with nothing left on disk; or an
// unconfirmed install whose copy is gone and whose confirmation window passed.
function isFinished(e, now) {
  if (e.confirmedAt) return e.fileGone;
  if (!e.version) return e.fileGone || e.downloadId === null;
  return e.fileGone && now - e.at >= CONFIRM_WINDOW_MS;
}

function storeInstall(entry, now = Date.now()) {
  return isFinished(entry, now) ? removeInstall(entry.token) : putInstall(entry);
}

async function handOff(crx, { repoKey: key, extensionId, manifest, installed }) {
  const token = crypto.randomUUID();
  const at = Date.now();
  await withStateLock(() => putInstall({
    token, repoKey: key, extensionId, version: manifest.version, installed,
    downloadId: null, downloadDone: false, at, confirmedAt: null, fileGone: false, removeError: null,
  }));
  const onStarted = (downloadId) => withStateLock(async () => {
    const e = await getInstall(token);
    if (e) await putInstall({ ...e, downloadId });
  });
  let failure = null;
  try {
    await installCrx(crx, `${manifest.name}-${manifest.version}`, { onStarted });
  } catch (e) {
    failure = e;
  }
  await withStateLock(async () => {
    let e = await getInstall(token);
    if (!e) return;
    if (failure) {
      if (e.downloadId === null) return removeInstall(token);
      e = await deleteCopy({ ...e, version: null }); // a failed download installs nothing
      return storeInstall(e);
    }
    e = { ...e, downloadDone: true };
    // management.onInstalled may have come first.
    if (e.confirmedAt) e = await deleteCopy(e);
    return storeInstall(e);
  });
  await chrome.alarms.create(SWEEP_ALARM, { delayInMinutes: PENDING_GRACE_MS / 60000 + 0.5 });
  if (failure) throw failure;
  return token;
}

// management.onInstalled: confirms the pending installs of info.id at
// info.version, commits them to their repo records and deletes their copies.
export async function handleExtensionInstalled(info) {
  await ready();
  await withStateLock(async () => {
    for (let e of await listInstalls()) {
      if (e.extensionId !== info.id || e.confirmedAt || e.version !== info.version) continue;
      e = { ...e, confirmedAt: Date.now() };
      const record = e.repoKey && (await findRepo(e.repoKey));
      if (record) await putRepo({ ...record, extensionId: info.id, installed: e.installed, identityChange: null });
      if (e.downloadDone && e.downloadId !== null) e = await deleteCopy(e);
      await storeInstall(e);
    }
  });
  await refreshBadge();
}

// Deletes copies of declined prompts and failed installs older than the grace
// period, retries failed deletions, and forgets finished entries.
export async function sweepDownloads(now = Date.now()) {
  await ready();
  await withStateLock(async () => {
    for (let e of await listInstalls()) {
      const due = e.confirmedAt ? e.downloadDone : now - e.at >= PENDING_GRACE_MS;
      if (e.downloadId !== null && !e.fileGone && due) e = await deleteCopy(e);
      // A download that never reported its id: nothing Extainium can address.
      if (e.downloadId === null && now - e.at >= PENDING_GRACE_MS) {
        await removeInstall(e.token);
        continue;
      }
      await storeInstall(e, now);
    }
  });
}

// Turns a .crx or .zip into an installable CRX after checking the archive.
// Zips are signed with keyPkcs8. Returns { crx, extensionId, manifest }.
async function prepare(bytes, keyPkcs8) {
  if (isCrx(bytes)) {
    const entries = parseZip(zipFromCrx(bytes));
    await verifyZip(entries);
    return { crx: bytes, extensionId: await extensionIdFromCrx(bytes), manifest: await readManifest(entries) };
  }
  const pkcs8 = base64Decode(keyPkcs8);
  const { bytes: zip, manifest } = await normalizeExtensionZip(bytes);
  const { spki } = await importSigningKey(pkcs8);
  return { crx: await packCrx3(zip, pkcs8), extensionId: await extensionIdFromSpki(spki), manifest };
}

function identityError(key, record) {
  const c = record.identityChange;
  return new Error(`install ${key}: ${c.asset} (${c.tag}) installs as extension ${c.to}, not as the installed ${c.from}; confirm the identity change first`);
}

// Hands the matching asset of release `tag` (default: latest) to the browser.
// Page only. onProgress(text) reports the current step. The install counts
// once the browser confirms it (handleExtensionInstalled); until then the view
// shows it as pendingInstall. Returns { extensionId, version, name }.
export async function installRelease(key, tag, onProgress = () => {}) {
  await ready();
  const record = await getRepo(key);
  if (record.identityChange) throw identityError(key, record);
  let release;
  if (tag) {
    release = (record.releases || []).find((r) => r.tag === tag);
    if (!release) throw new Error(`install ${key}: no release ${tag}`);
  } else {
    const latest = latestFor(record);
    if (!latest) throw new Error(`install ${key}: no release has an asset matching ${record.template}`);
    release = latest.release;
  }
  const assets = matchAssets(release, record.template);
  if (assets.length !== 1) {
    throw new Error(`install ${key} ${release.tag}: template ${record.template} matches ${assets.length} assets`);
  }
  const asset = assets[0];
  onProgress(`Downloading ${asset.name}…`);
  const bytes = await downloadAsset(asset);
  const keyPkcs8 = isCrx(bytes) ? null : await ensureSigningKey(key);
  onProgress(keyPkcs8 ? "Packing and signing CRX…" : "Checking CRX…");
  const { crx, extensionId, manifest } = await prepare(bytes, keyPkcs8);
  if (record.extensionId && record.extensionId !== extensionId && (await installedExtensions()).has(record.extensionId)) {
    const r = await updateRepo(key, (cur) => ({ ...cur, identityChange: { from: cur.extensionId, to: extensionId, tag: release.tag, asset: asset.name } }));
    await refreshBadge();
    throw identityError(key, r);
  }
  if (record.extensionId !== extensionId) await patchRepo(key, { extensionId });
  onProgress("Handing the CRX to the browser…");
  await handOff(crx, { repoKey: key, extensionId, manifest, installed: { tag: release.tag, digest: asset.digest, version: manifest.version } });
  return { extensionId, version: manifest.version, name: manifest.name };
}

// Installs a local .crx/.zip. A zip is signed with the key of tracked repo
// `signWith` or with a new key that is returned for trackInstalledFile. Page only.
export async function installFile(bytes, filename, signWith) {
  await ready();
  let keyPkcs8 = null;
  if (!isCrx(bytes)) {
    keyPkcs8 = signWith ? await getSigningKey(signWith) : base64Encode((await generateSigningKey()).pkcs8);
    if (!keyPkcs8) throw new Error(`install ${filename}: tracked repo ${signWith} has no signing key`);
  }
  const { crx, extensionId, manifest } = await prepare(bytes, keyPkcs8);
  const installed = { tag: null, digest: null, version: manifest.version };
  const token = await handOff(crx, { repoKey: signWith || null, extensionId, manifest: { ...manifest, name: manifest.name || filename }, installed });
  return { extensionId, keyPkcs8: signWith ? null : keyPkcs8, installed, name: manifest.name, token };
}

// Starts tracking a repo for an extension installed from a file.
export async function trackInstalledFile(input, fileResult) {
  await ready();
  const { owner, repo } = parseRepo(input);
  const k = repoKey({ owner, repo });
  const retained = await getSigningKey(k);
  if (fileResult.keyPkcs8 && retained && retained !== fileResult.keyPkcs8) {
    throw new Error(`track ${k}: a different signing key (extension ${await idOfKey(retained)}) is stored for this repo; the file was signed as ${fileResult.extensionId}`);
  }
  const key = await addRepo(input);
  const exts = await installedExtensions();
  await withStateLock(async () => {
    if (fileResult.keyPkcs8) await putSigningKeyIfAbsent(key, fileResult.keyPkcs8);
    const record = await getRepo(key);
    const entry = await getInstall(fileResult.token);
    let installed = null;
    if (entry && entry.confirmedAt) installed = entry.installed;
    else if (entry) await putInstall({ ...entry, repoKey: key });
    else if (exts.get(fileResult.extensionId)?.version === fileResult.installed.version) installed = fileResult.installed;
    await putRepo({ ...record, extensionId: fileResult.extensionId, installed });
  });
  await refreshBadge();
  return key;
}

// Stops tracking. The signing key is kept (it re-attaches if the repo is added
// again and stays in exports) unless uninstall is set: then the extension is
// uninstalled (the browser asks the user; a refusal throws and changes nothing)
// and the key is deleted.
export async function removeRepo(key, uninstall) {
  await ready();
  const record = await getRepo(key);
  if (uninstall && record.extensionId && (await installedExtensions()).has(record.extensionId)) {
    await chrome.management.uninstall(record.extensionId, { showConfirmDialog: true });
  }
  await withStateLock(async () => {
    await removeRepoRecord(key);
    if (uninstall) await removeSigningKey(key);
  });
  await refreshBadge();
}

export async function exportBackup() {
  await ready();
  return JSON.stringify(makeBackup(await listRepos(), await listSigningKeys()), null, 2);
}

// Imports a backup (validated as a whole first). A stored signing key is never
// replaced: a backup key that differs is reported in conflicts and the current
// key, ID and installation stay. Tracked repos take the backup's template and
// pre-release setting. Returns { count, errors, conflicts: [{ key, keptId, backupId }], warnings }.
export async function importBackup(text) {
  await ready();
  const { repos, keys, warnings } = await parseBackup(text);
  const conflicts = [];
  await withStateLock(async () => {
    for (const [k, b64] of Object.entries(keys)) {
      const current = await getSigningKey(k);
      if (!current) await chrome.storage.local.set({ [KEY_PREFIX + k]: b64 });
      else if (current !== b64) conflicts.push({ key: k, keptId: await idOfKey(current), backupId: await idOfKey(b64) });
    }
    for (const rec of repos) {
      const k = repoKey(rec);
      const conflict = conflicts.find((c) => c.key === k);
      const current = await findRepo(k);
      const base = current || { ...rec, extensionId: null, installed: null };
      await putRepo({
        ...base,
        template: rec.template,
        includePrereleases: rec.includePrereleases,
        extensionId: base.extensionId ?? (conflict ? conflict.keptId : rec.extensionId),
        installed: base.installed ?? (conflict ? null : rec.installed),
      });
    }
  });
  // The backup has no release cache; fetch it so the list shows versions again.
  const { errors } = await checkAll();
  return { count: repos.length, errors, conflicts, warnings };
}
