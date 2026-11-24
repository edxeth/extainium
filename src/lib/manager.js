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
import { MAX_RELEASE_PAGES, downloadAsset, downloadAssetHead, fetchReleases, sha256Hex } from "./github.js";
import {
  deriveTemplate, isPackageAsset, latestFor, matchAssets, parseRepo, selectRelease, updateState, validateTemplate,
} from "./releases.js";
import {
  INSTALL_PREFIX, findRepo, getRepo, getSettings, getSigningKey, listInstalls, listRepos,
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
      .filter((i) => i.repoKey === key && i.extensionId === record.extensionId && !i.confirmedAt && i.version)
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
  const created = await withStateLock(async () => {
    if (await findRepo(key)) throw new Error(`add repo: ${key} is already tracked`);
    const record = newRecord(owner, repo);
    await putRepo(record);
    return record;
  });
  await checkNewRepo(key, created);
  return key;
}

// First check of a record just created; when it fails, the record is removed
// again unless another operation (e.g. an import) changed it meanwhile.
async function checkNewRepo(key, created) {
  try {
    await checkRepo(key);
  } catch (e) {
    await withStateLock(async () => {
      const r = await findRepo(key);
      const untouched = r && ["addedAt", "template", "includePrereleases", "extensionId"].every((f) => r[f] === created[f]);
      if (untouched) await removeRepoRecord(key);
    });
    throw e;
  }
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
  const isCrxAsset = /\.crx$/i.test(latest.asset.name);
  const signingKey = isCrxAsset ? null : await ensureSigningKey(key);
  const newId = isCrxAsset ? await extensionIdFromCrx(await downloadAssetHead(latest.asset)) : await idOfKey(signingKey);
  const exts = await installedExtensions();
  return withStateLock(async () => {
    const r = await getRepo(key);
    const now = latestFor(r);
    // Changed meanwhile: the change that did it links again.
    if (!now || !now.asset || now.asset.url !== latest.asset.url) return r;
    if (signingKey && (await getSigningKey(key)) !== signingKey) {
      throw new Error(`link ${key}: its signing key was replaced meanwhile; try again`);
    }
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
  return relink(key);
}

// Links after a change of the selection criteria. When the cached releases
// hold nothing the new criteria select and the last check stopped before the
// last page, further pages are fetched first, as a check would.
async function relink(key) {
  const r = await getRepo(key);
  const truncated = r.pages && r.pages.length && r.pages.length < MAX_RELEASE_PAGES && r.pages.at(-1).next;
  if (r.releases && truncated && !hasEligible(r, r.releases)) await checkRepo(key);
  return link(key);
}

export function chooseAsset(key, assetName, tag) {
  return setTemplate(key, deriveTemplate(assetName, tag));
}

export async function setPrereleases(key, includePrereleases) {
  await ready();
  if (typeof includePrereleases !== "boolean") throw new Error(`set pre-releases of ${key}: not true/false: ${includePrereleases}`);
  await patchRepo(key, { includePrereleases });
  return relink(key);
}

// ---- Hand-off to the browser and download cleanup ----
// Each CRX handed to the browser gets an "install:<token>" entry:
//   { token, repoKey|null, extensionId, version|null, installed: {tag, digest, version},
//     crxHash, downloadId|null, downloadDone, at, confirmedAt|null, fileGone, removeError|null }
// crxHash (sha256 hex of the CRX) names the one build the entry stands for.
// management.onInstalled with the same ID and version confirms it: only then is
// record.installed committed. The event names no build, so two different
// builds of one ID and version are never pending together: a second one is
// refused while the first may still be at its prompt (PENDING_GRACE_MS), and
// later replaces it (version null: no longer confirmable). The downloaded copy
// is deleted after the confirmation, or after PENDING_GRACE_MS when the prompt
// was declined or the install failed, and only once the download has finished.
// Only downloads Extainium started are ever deleted.
export const PENDING_GRACE_MS = 2 * 60 * 1000;
// How long an unconfirmed install may still be confirmed after its copy was deleted.
export const CONFIRM_WINDOW_MS = 24 * 60 * 60 * 1000;
export const SWEEP_ALARM = "sweep-downloads";

const getInstall = async (token) => (await chrome.storage.local.get(INSTALL_PREFIX + token))[INSTALL_PREFIX + token] || null;

// Deletes the entry's downloaded file and its download-list item; inside the lock.
// A download still in progress is left alone (erase would cancel it). The item
// is erased only once its file is gone or the download was interrupted (erase
// deletes the partial file). Keeps the entry with removeError when the file
// could not be deleted.
// quiet: a failure is not recorded as removeError (a retry follows).
async function deleteCopy(entry, { quiet = false } = {}) {
  const id = entry.downloadId;
  try {
    const [item] = await chrome.downloads.search({ id });
    if (!item) return { ...entry, fileGone: true, removeError: null };
    if (item.state === "in_progress") return entry;
    if (item.state === "complete" && item.exists !== false) {
      try {
        await chrome.downloads.removeFile(id);
      } catch (e) {
        // "Invalid downloadId": the item was erased meanwhile, nothing left to address.
        if (/invalid download ?id/i.test(e.message)) return { ...entry, fileGone: true, removeError: null };
        if (!/already deleted/i.test(e.message)) throw e;
      }
    }
    await chrome.downloads.erase({ id });
    return { ...entry, fileGone: true, removeError: null };
  } catch (e) {
    return quiet ? entry : { ...entry, removeError: `delete download #${id}: ${e.message}` };
  }
}

// Chromium's installer deletes the downloaded CRX itself right before
// management.onInstalled, but the download item does not know yet; removeFile
// then fails ("Unable to remove file" on Android's MediaStore paths). The item
// learns its file is gone from a file-existence check that downloads.search
// starts, at most once per 10 s (downloads_api.cc CheckForHistoryFilesRemoval).
// So the deletion is retried once, quietly: after retryMs a search starts the
// check, and settleMs later removeFile reports "already deleted" and the item is
// erased. A copy still left is handled by the sweep.
export const cleanupTiming = { retryMs: 11000, settleMs: 1000 };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function retryDeletes(tokens) {
  if (!tokens.length) return;
  await sleep(cleanupTiming.retryMs);
  await chrome.downloads.search({});
  await sleep(cleanupTiming.settleMs);
  await withStateLock(async () => {
    for (const token of tokens) {
      const e = await getInstall(token);
      if (e && !e.fileGone && e.downloadId !== null) await storeInstall(await deleteCopy(e, { quiet: true }));
    }
  });
}

// An install entry that no tracked repo can use any more: not confirmable and
// unassociated, kept only until its copy is deleted.
const detached = (e) => ({ ...e, repoKey: null, version: e.confirmedAt ? e.version : null });

// Saves entry, or drops it once nothing is left to do for it: confirmed and
// its copy deleted; a failed, replaced or detached install (version null)
// with nothing left on disk; or an
// unconfirmed install whose copy is gone and whose confirmation window passed.
function isFinished(e, now) {
  if (e.confirmedAt) return e.fileGone;
  if (!e.version) return e.fileGone;
  return e.fileGone && now - e.at >= CONFIRM_WINDOW_MS;
}

function storeInstall(entry, now = Date.now()) {
  return isFinished(entry, now) ? removeInstall(entry.token) : putInstall(entry);
}

async function handOff(crx, { repoKey: key, extensionId, manifest, installed }) {
  const token = crypto.randomUUID();
  const crxHash = await sha256Hex(crx);
  const at = Date.now();
  await withStateLock(async () => {
    for (const e of await listInstalls()) {
      if (e.confirmedAt || !e.version || e.extensionId !== extensionId || e.version !== manifest.version || e.crxHash === crxHash) continue;
      if (at - e.at < PENDING_GRACE_MS) {
        const when = (t) => new Date(t).toLocaleTimeString();
        throw new Error(`install ${manifest.name} ${manifest.version}: another build of extension ${extensionId} ${manifest.version} was handed to the browser at ${when(e.at)} and is not confirmed; answer its prompt, or try again after ${when(e.at + PENDING_GRACE_MS)}`);
      }
      // Its prompt is over; the browser's event could not tell it from this build.
      await storeInstall({ ...e, version: null }, at);
    }
    await putInstall({
      token, repoKey: key, extensionId, version: manifest.version, installed, crxHash,
      downloadId: null, downloadDone: false, at, confirmedAt: null, fileGone: false, removeError: null,
    });
  });
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
  const retry = await withStateLock(async () => {
    let e = await getInstall(token);
    if (!e) return false;
    if (failure) {
      if (e.downloadId === null) {
        await removeInstall(token);
        return false;
      }
      e = await deleteCopy({ ...e, version: null }); // a failed download installs nothing
      await storeInstall(e);
      return false;
    }
    e = { ...e, downloadDone: true };
    // management.onInstalled may have come first.
    if (e.confirmedAt) e = await deleteCopy(e, { quiet: true });
    await storeInstall(e);
    return !!e.confirmedAt && !e.fileGone;
  });
  // Not awaited: the install result does not wait for the cleanup retry.
  if (retry) retryDeletes([token]).catch((e) => console.error("[Extainium] delete CRX copy:", e));
  await chrome.alarms.create(SWEEP_ALARM, { delayInMinutes: PENDING_GRACE_MS / 60000 + 0.5 });
  if (failure) throw failure;
  return token;
}

// management.onInstalled: confirms the pending installs of info.id at
// info.version, commits them to their repo records and deletes their copies.
// One event installs one build: pending entries of different builds (crxHash)
// cannot be told apart, so then none is committed. A record is committed only
// while it is still linked to info.id; a file install never relinks a repo.
export async function handleExtensionInstalled(info) {
  await ready();
  const retry = [];
  await withStateLock(async () => {
    const matching = (await listInstalls()).filter((e) => e.extensionId === info.id && !e.confirmedAt && e.version === info.version);
    if (new Set(matching.map((e) => e.crxHash)).size > 1) return;
    for (let e of matching) {
      e = { ...e, confirmedAt: Date.now() };
      const record = e.repoKey && (await findRepo(e.repoKey));
      if (record && record.extensionId === info.id) await putRepo({ ...record, installed: e.installed });
      if (e.downloadDone && e.downloadId !== null) {
        e = await deleteCopy(e, { quiet: true });
        if (!e.fileGone) retry.push(e.token);
      }
      await storeInstall(e);
    }
  });
  await refreshBadge();
  await retryDeletes(retry);
}

// Deletes copies of declined prompts and failed installs older than the grace
// period, retries failed deletions, and forgets finished entries.
export async function sweepDownloads(now = Date.now()) {
  await ready();
  await withStateLock(async () => {
    for (let e of await listInstalls()) {
      // A pending install of a repo that is no longer tracked.
      if (e.repoKey && !(await findRepo(e.repoKey))) e = detached(e);
      if (e.downloadId === null) {
        // The hand-off may still wait for its download ID (onStarted records it);
        // forgotten only after the confirmation window.
        if (now - e.at >= CONFIRM_WINDOW_MS) await removeInstall(e.token);
        else await putInstall(e);
        continue;
      }
      const due = e.confirmedAt || now - e.at >= PENDING_GRACE_MS;
      if (!e.fileGone && due) e = await deleteCopy(e);
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
  return new Error(`install ${key}: ${c.asset}${c.tag ? ` (${c.tag})` : ""} installs as extension ${c.to}, not as the installed ${c.from}; confirm the identity change first`);
}

// Before a hand-off for tracked repo key: under the lock, checks that the
// signing key used (keyPkcs8, null for a CRX) is still the stored one, and links
// the record to extensionId, unless it is linked to another installed
// extension: then record.identityChange { from, to: extensionId, ...change }
// is set and identityError thrown.
async function claimIdentity(key, extensionId, keyPkcs8, change) {
  const exts = await installedExtensions();
  const conflict = await withStateLock(async () => {
    const r = await getRepo(key);
    if (keyPkcs8 && (await getSigningKey(key)) !== keyPkcs8) {
      throw new Error(`install ${key}: its signing key was replaced meanwhile; try again`);
    }
    if (r.extensionId && r.extensionId !== extensionId && exts.has(r.extensionId)) {
      const next = { ...r, identityChange: { from: r.extensionId, to: extensionId, ...change } };
      await putRepo(next);
      return next;
    }
    if (r.extensionId !== extensionId) await putRepo({ ...r, extensionId });
    return null;
  });
  if (conflict) {
    await refreshBadge();
    throw identityError(key, conflict);
  }
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
  await claimIdentity(key, extensionId, keyPkcs8, { tag: release.tag, asset: asset.name });
  onProgress("Handing the CRX to the browser…");
  await handOff(crx, { repoKey: key, extensionId, manifest, installed: { tag: release.tag, digest: asset.digest, version: manifest.version } });
  return { extensionId, version: manifest.version, name: manifest.name };
}

// Installs a local .crx/.zip. A zip is signed with the key of tracked repo
// `signWith` (the install then belongs to that repo; an ID other than the
// repo's installed one needs confirmIdentityChange first) or with a new key
// that is returned for trackInstalledFile. A CRX carries its author's key and
// never belongs to a tracked repo: signWith is ignored for it. Page only.
// Returns { extensionId, keyPkcs8 (new key or null), installed, name, token,
// repoKey: the tracked repo the install belongs to, or null }.
export async function installFile(bytes, filename, signWith) {
  await ready();
  const repo = isCrx(bytes) ? null : signWith || null;
  let keyPkcs8 = null;
  if (!isCrx(bytes)) {
    keyPkcs8 = repo ? await getSigningKey(repo) : base64Encode((await generateSigningKey()).pkcs8);
    if (!keyPkcs8) throw new Error(`install ${filename}: tracked repo ${repo} has no signing key`);
  }
  const { crx, extensionId, manifest } = await prepare(bytes, keyPkcs8);
  if (repo) await claimIdentity(repo, extensionId, keyPkcs8, { tag: null, asset: filename });
  const installed = { tag: null, digest: null, version: manifest.version };
  const token = await handOff(crx, { repoKey: repo, extensionId, manifest: { ...manifest, name: manifest.name || filename }, installed });
  return { extensionId, keyPkcs8: repo ? null : keyPkcs8, installed, name: manifest.name, token, repoKey: repo };
}

// Starts tracking a repo for an extension installed from a file. The record,
// the file's signing key and the link to its ID are decided and written in
// one locked step, before the network check: a key stored meanwhile (e.g. by
// an import) is never overruled, and the file's key is never lost.
export async function trackInstalledFile(input, fileResult) {
  await ready();
  const { owner, repo } = parseRepo(input);
  const key = repoKey({ owner, repo });
  const exts = await installedExtensions();
  const created = await withStateLock(async () => {
    if (await findRepo(key)) throw new Error(`track ${key}: ${key} is already tracked`);
    if (fileResult.keyPkcs8) {
      const kept = await putSigningKeyIfAbsent(key, fileResult.keyPkcs8);
      if (kept !== fileResult.keyPkcs8) {
        throw new Error(`track ${key}: a different signing key (extension ${await idOfKey(kept)}) is stored for this repo; the file was signed as ${fileResult.extensionId}`);
      }
    }
    const entry = await getInstall(fileResult.token);
    let installed = null;
    if (entry && entry.confirmedAt) installed = entry.installed;
    else if (entry) await putInstall({ ...entry, repoKey: key });
    else if (exts.get(fileResult.extensionId)?.version === fileResult.installed.version) installed = fileResult.installed;
    const record = { ...newRecord(owner, repo), extensionId: fileResult.extensionId, installed };
    await putRepo(record);
    return record;
  });
  await checkNewRepo(key, created);
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
    // Its pending installs end with it (their copies are still deleted).
    for (const e of await listInstalls()) if (e.repoKey === key) await storeInstall(detached(e));
  });
  await refreshBadge();
}

// Repos and keys are read in one locked snapshot, so a repo is never exported without its key.
export async function exportBackup() {
  await ready();
  const backup = await withStateLock(async () => makeBackup(await listRepos(), await listSigningKeys()));
  return JSON.stringify(backup, null, 2);
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
      const kept = await putSigningKeyIfAbsent(k, b64);
      if (kept !== b64) conflicts.push({ key: k, keptId: await idOfKey(kept), backupId: await idOfKey(b64) });
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
