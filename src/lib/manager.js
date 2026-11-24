// Operations behind the UI and the background worker. Runs in extension pages
// and the service worker; installs (blob URLs) only work in pages.
// Every read-modify-write of stored state runs under withStateLock (store.js);
// network and crypto work happens outside the lock, and its result is
// committed under the lock against a fresh read.

import {
  base64Decode, base64Encode, extensionIdFromCrx, extensionIdFromSpki,
  generateSigningKey, importSigningKey, isCrx, packCrx3, verifyCrx, zipFromCrx,
} from "./crx.js";
import { normalizeExtensionZip, parseZip, readManifest, verifyZip } from "./zip.js";
import { MAX_RELEASE_PAGES, downloadAsset, downloadAssetHead, fetchReleaseFeed, fetchReleases, sha256Hex } from "./github.js";
import {
  deriveTemplate, isPackageAsset, latestFor, matchAssets, parseRepo, selectRelease, updateState, validateTemplate,
} from "./releases.js";
import {
  INSTALL_PREFIX, findRepo, getFileKey, getRepo, getSettings, getSigningKey, listFileKeys, listInstalls,
  listKeyDeletions, listRepos, listSigningKeys, makeBackup, markKeyForDeletion, migrateStorage, newRecord,
  parseBackup, patchRepo, putFileKeyIfAbsent, putInstall, putRepo, putSigningKeyIfAbsent, removeFileKey,
  removeInstall, removeKeyDeletion, removeRepoRecord, removeSigningKey, repoKey, updateRepo, withStateLock,
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

// The badge background: the UI accent, --accent in style.css (light scheme,
// oklch(0.5 0.19 259)) as sRGB hex, the only form setBadgeBackgroundColor takes.
export const BADGE_COLOR = "#055bcc";

export async function refreshBadge() {
  const n = (await trackedView()).filter((v) => v.state === "update").length;
  await chrome.action.setBadgeBackgroundColor({ color: BADGE_COLOR });
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

// The releases.atom entries of owner/repo as one comparable string, or null
// when the feed is unavailable (any failure: the check then uses the API).
async function feedSnapshot(record) {
  try {
    return (await fetchReleaseFeed(record.owner, record.repo)).map((e) => `${e.id} ${e.updated}`).join("\n");
  } catch {
    return null;
  }
}

const criteriaOf = (r) => ({ template: r.template, includePrereleases: r.includePrereleases });
const sameCriteria = (a, b) => !!a && !!b && a.template === b.template && a.includePrereleases === b.includePrereleases;

// Checks a repo for new releases. The releases API (rate-limited) is called
// only when the repo's releases.atom feed (not rate-limited) differs from the
// one the last full check saw, the release cache is empty, the selection
// criteria changed since, or the feed is unavailable. The feed is read before
// the API, so a release published in between shows as a change next time.
export async function checkRepo(key) {
  await ready();
  const record = await getRepo(key);
  const { githubToken } = await getSettings();
  const checkedAt = Date.now();
  const feed = await feedSnapshot(record);
  if (feed !== null && feed === record.feed && record.releases && record.pages && sameCriteria(record.checkedCriteria, criteriaOf(record))) {
    return patchRepo(key, { error: null, checkedAt });
  }
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
    feed,
    checkedCriteria: criteriaOf(record),
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

// The repo's signing key; a new one is generated and stored on first use,
// only while the repo is tracked (a removal may have deleted its key).
// When two contexts race, the first stored key wins and both use it.
async function ensureSigningKey(key) {
  const existing = await getSigningKey(key);
  if (existing) return existing;
  const fresh = base64Encode((await generateSigningKey()).pkcs8);
  return withStateLock(async () => {
    if (!(await findRepo(key))) throw new Error(`sign ${key}: the repo is no longer tracked`);
    return putSigningKeyIfAbsent(key, fresh);
  });
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
//     crxHash, signedWith|null, supersededBy|null, downloadId|null, downloadDone, at,
//     confirmedAt|null, fileGone, removeError|null }
// crxHash (sha256 hex of the CRX) names the build the entry stands for.
// signedWith names the repo whose stored signing key signed the CRX, while the
// install may still use that key (cleared once it is confirmed, failed or
// superseded); a key removeRepo marked for deletion stays until no entry holds
// it (holdsKey), at most PENDING_GRACE_MS after the hand-off.
// management.onInstalled with the same ID and version confirms an entry: only
// then is record.installed committed. The event names no build, but
// Titanium's "Add extension?" prompt is modal, so a new tap replaces the
// earlier prompt: a new hand-off supersedes the earlier unconfirmed entries of
// the same ID and version (version null, supersededBy its token), and an event
// confirms only the newest. The downloaded copy is deleted after the
// confirmation (superseded copies of that version with it), or after
// PENDING_GRACE_MS when the prompt was declined or the install failed, and
// only once the download has finished. Only downloads Extainium started are
// ever deleted.
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

// True while install entry e may still install a CRX signed with repo k's key.
const holdsKey = (e, k, now) => e.signedWith === k && !e.confirmedAt && now - e.at < PENDING_GRACE_MS;

// Deletes the signing keys removeRepo(key, true) marked once no install entry
// holds them; inside the lock. A repo tracked again meanwhile keeps its key.
async function deleteReleasedKeys(now = Date.now()) {
  const marked = await listKeyDeletions();
  if (!marked.length) return;
  const installs = await listInstalls();
  for (const k of marked) {
    if (!(await findRepo(k))) {
      if (installs.some((e) => holdsKey(e, k, now))) continue;
      await removeSigningKey(k);
    }
    await removeKeyDeletion(k);
  }
}

// claim: { key, keyPkcs8, change } for an install of tracked repo key; checked
// and linked (claimLocked) in the same locked step that records the entry, so
// no removal of the repo or its key can come between. fileKey: the key that
// signed a zip installed without a repo, kept in the file-key store.
async function handOff(crx, { repoKey: key, extensionId, manifest, installed, claim = null, fileKey = null }) {
  const token = crypto.randomUUID();
  const crxHash = await sha256Hex(crx);
  const exts = claim ? await installedExtensions() : null;
  const conflict = await withStateLock(async () => {
    const at = Date.now();
    if (claim) {
      const changed = await claimLocked(claim, extensionId, exts);
      if (changed) return changed;
    }
    if (fileKey) await putFileKeyIfAbsent(extensionId, fileKey);
    for (const e of await listInstalls()) {
      if (e.confirmedAt || !e.version || e.extensionId !== extensionId || e.version !== manifest.version) continue;
      await storeInstall({ ...e, version: null, supersededBy: token, signedWith: null }, at);
    }
    await putInstall({
      token, repoKey: key, extensionId, version: manifest.version, installed, crxHash,
      signedWith: claim && claim.keyPkcs8 ? claim.key : null, supersededBy: null,
      downloadId: null, downloadDone: false, at, confirmedAt: null, fileGone: false, removeError: null,
    });
    return null;
  });
  if (conflict) {
    await refreshBadge();
    throw identityError(claim.key, conflict);
  }
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
      e = { ...e, version: null, signedWith: null }; // a failed download installs nothing
      if (e.downloadId === null) await removeInstall(token);
      else await storeInstall(await deleteCopy(e));
      await deleteReleasedKeys();
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

// management.onInstalled: confirms the newest pending install of info.id at
// info.version and commits it to its repo record, while that record is still
// linked to info.id (a file install never relinks a repo). Every other
// unconfirmed entry of that ID and version (superseded, detached, or older
// ones a previous version left) ends: its prompt is over. The copies of all of
// them are deleted, and keys they held are released.
export async function handleExtensionInstalled(info) {
  await ready();
  const retry = [];
  await withStateLock(async () => {
    const now = Date.now();
    const ofVersion = (await listInstalls())
      .filter((e) => e.extensionId === info.id && !e.confirmedAt && e.installed && e.installed.version === info.version)
      .sort((a, b) => b.at - a.at);
    const newest = ofVersion.find((e) => e.version === info.version) || null;
    for (let e of ofVersion) {
      if (e === newest) {
        e = { ...e, confirmedAt: now, signedWith: null };
        const record = e.repoKey && (await findRepo(e.repoKey));
        if (record && record.extensionId === info.id) await putRepo({ ...record, installed: e.installed });
      } else {
        e = { ...e, version: null, supersededBy: e.supersededBy || (newest && newest.token), signedWith: null };
      }
      if (e.downloadDone && e.downloadId !== null && !e.fileGone) {
        e = await deleteCopy(e, { quiet: true });
        if (!e.fileGone) retry.push(e.token);
      }
      await storeInstall(e, now);
    }
    await deleteReleasedKeys(now);
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
    await deleteReleasedKeys(now);
  });
}

// Turns a .crx or .zip into an installable CRX after checking the archive.
// A CRX must pass signature verification (verifyCrx). Zips are signed with
// keyPkcs8. name: the file's name for errors. Returns { crx, extensionId, manifest }.
async function prepare(bytes, keyPkcs8, name) {
  if (isCrx(bytes)) {
    const extensionId = await verifyCrx(bytes, name);
    const entries = parseZip(zipFromCrx(bytes));
    await verifyZip(entries);
    return { crx: bytes, extensionId, manifest: await readManifest(entries) };
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

// Inside handOff's lock, for an install of tracked repo key: checks that the
// repo is still tracked and the signing key used (keyPkcs8, null for a CRX)
// is still the stored one, and links the record to extensionId, unless it is
// linked to another installed extension (exts): then record.identityChange
// { from, to: extensionId, ...change } is set and that record returned.
async function claimLocked({ key, keyPkcs8, change }, extensionId, exts) {
  const r = await findRepo(key);
  if (!r) throw new Error(`install ${key}: the repo is no longer tracked`);
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
  const { crx, extensionId, manifest } = await prepare(bytes, keyPkcs8, asset.name);
  onProgress("Handing the CRX to the browser…");
  await handOff(crx, {
    repoKey: key, extensionId, manifest,
    installed: { tag: release.tag, digest: asset.digest, version: manifest.version },
    claim: { key, keyPkcs8, change: { tag: release.tag, asset: asset.name } },
  });
  return { extensionId, version: manifest.version, name: manifest.name };
}

// signWith value that picks the file key of an extension: FILE_KEY_CHOICE + ID.
export const FILE_KEY_CHOICE = "file:";

// Installs a local .crx/.zip. A zip is signed with the key signWith names:
// a tracked repo's ("owner/repo"; the install then belongs to that repo, and
// an ID other than the repo's installed one needs confirmIdentityChange
// first), a file key (FILE_KEY_CHOICE + extension ID, see fileKeysView), or,
// when signWith is empty, a new key. A zip installed without a repo keeps its
// key in the file-key store, so it is exported and can be attached later by
// trackInstalledFile. A CRX carries its author's key and never belongs to a
// tracked repo: signWith is ignored for it. Page only.
// Returns { extensionId, keyPkcs8 (key of an install without a repo, or null),
// installed, name, token, repoKey: the tracked repo the install belongs to, or null }.
export async function installFile(bytes, filename, signWith) {
  await ready();
  const crxFile = isCrx(bytes);
  const fileKeyId = !crxFile && signWith && signWith.startsWith(FILE_KEY_CHOICE) ? signWith.slice(FILE_KEY_CHOICE.length) : null;
  const repo = crxFile || fileKeyId ? null : signWith || null;
  let keyPkcs8 = null;
  if (fileKeyId) {
    keyPkcs8 = await getFileKey(fileKeyId);
    if (!keyPkcs8) throw new Error(`install ${filename}: no file key is stored for extension ${fileKeyId}`);
  } else if (repo) {
    keyPkcs8 = await getSigningKey(repo);
    if (!keyPkcs8) throw new Error(`install ${filename}: tracked repo ${repo} has no signing key`);
  } else if (!crxFile) {
    keyPkcs8 = base64Encode((await generateSigningKey()).pkcs8);
  }
  const { crx, extensionId, manifest } = await prepare(bytes, keyPkcs8, filename);
  const installed = { tag: null, digest: null, version: manifest.version };
  const token = await handOff(crx, {
    repoKey: repo, extensionId, manifest: { ...manifest, name: manifest.name || filename }, installed,
    claim: repo ? { key: repo, keyPkcs8, change: { tag: null, asset: filename } } : null,
    fileKey: repo ? null : keyPkcs8,
  });
  return { extensionId, keyPkcs8: repo ? null : keyPkcs8, installed, name: manifest.name, token, repoKey: repo };
}

// The file keys (zips installed from a file without a repo), for the sign-with
// choice of installFile: [{ value (the signWith value), extensionId, name,
// version }], name and version of the installed extension or null.
export async function fileKeysView() {
  await ready();
  const [fileKeys, exts] = await Promise.all([listFileKeys(), installedExtensions()]);
  return Object.keys(fileKeys).sort().map((id) => {
    const ext = exts.get(id);
    return { value: FILE_KEY_CHOICE + id, extensionId: id, name: ext ? ext.name : null, version: ext ? ext.version : null };
  });
}

// Starts tracking a repo for an extension installed from a file. The record,
// the file's signing key (from the file-key store, or fileResult.keyPkcs8)
// and the link to its ID are decided and written in one locked step, before
// the network check: a key stored meanwhile (e.g. by an import) is never
// overruled, and the file's key is never lost. The key moves from the
// file-key store to the repo.
export async function trackInstalledFile(input, fileResult) {
  await ready();
  const { owner, repo } = parseRepo(input);
  const key = repoKey({ owner, repo });
  const exts = await installedExtensions();
  const created = await withStateLock(async () => {
    if (await findRepo(key)) throw new Error(`track ${key}: ${key} is already tracked`);
    const fileKey = (await getFileKey(fileResult.extensionId)) || fileResult.keyPkcs8;
    if (fileKey) {
      const kept = await putSigningKeyIfAbsent(key, fileKey);
      if (kept !== fileKey) {
        throw new Error(`track ${key}: a different signing key (extension ${await idOfKey(kept)}) is stored for this repo; the file was signed as ${fileResult.extensionId}`);
      }
      await removeFileKey(fileResult.extensionId);
    }
    const entry = await getInstall(fileResult.token);
    let installed = null;
    if (entry && entry.confirmedAt) installed = entry.installed;
    else if (entry) await putInstall({ ...entry, repoKey: key, signedWith: fileKey && entry.version ? key : null });
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
// and the key is marked for deletion. It is deleted at once when no pending
// install signed with it remains, else once those are confirmed, superseded,
// failed or past PENDING_GRACE_MS (handleExtensionInstalled, handOff,
// sweepDownloads); until then it stays, and is exported.
export async function removeRepo(key, uninstall) {
  await ready();
  const record = await getRepo(key);
  if (uninstall && record.extensionId && (await installedExtensions()).has(record.extensionId)) {
    await chrome.management.uninstall(record.extensionId, { showConfirmDialog: true });
  }
  await withStateLock(async () => {
    await removeRepoRecord(key);
    // Its pending installs end with it (their copies are still deleted).
    for (const e of await listInstalls()) if (e.repoKey === key) await storeInstall(detached(e));
    if (uninstall && (await getSigningKey(key))) {
      await markKeyForDeletion(key);
      await deleteReleasedKeys();
    }
  });
  await refreshBadge();
}

// Repos and keys are read in one locked snapshot, so a repo is never exported without its key.
export async function exportBackup() {
  await ready();
  const backup = await withStateLock(async () => makeBackup(await listRepos(), await listSigningKeys(), new Date(), await listFileKeys()));
  return JSON.stringify(backup, null, 2);
}

// Saves the export to Downloads as filename. Page only (blob URL). The browser
// may first ask where to save; the result comes once the download ended:
// { saved, id, error } (error: why it was not saved, e.g. "download #3:
// USER_CANCELED"). The end is read from the download's own onChanged events,
// listened to before download() is called so none is missed. A completed
// export may be missing from downloads.search on Titanium (seen on the phone;
// cause not found in Chromium's source), so search is only consulted for a
// download that already ended, and an empty result means "not known yet".
export async function saveBackup(filename) {
  const url = URL.createObjectURL(new Blob([await exportBackup()], { type: "application/json" }));
  let id = null;
  const early = new Map(); // events that arrive before download() returns the id
  let settle;
  const ended = new Promise((resolve) => { settle = resolve; });
  const end = (state, error) => {
    if (state === "complete") settle({ saved: true, error: null });
    else if (state === "interrupted") settle({ saved: false, error: `download #${id}: ${error || "interrupted"}` });
  };
  const onChanged = (d) => {
    if (id === null) early.set(d.id, d);
    else if (d.id === id && d.state) end(d.state.current, d.error && d.error.current);
  };
  const onErased = (erasedId) => {
    if (erasedId === id) settle({ saved: false, error: `download #${id} was erased before it ended` });
  };
  chrome.downloads.onChanged.addListener(onChanged);
  chrome.downloads.onErased.addListener(onErased);
  try {
    try {
      id = await chrome.downloads.download({ url, filename });
    } catch (e) {
      throw new Error(`save backup ${filename}: ${e.message}`);
    }
    const first = early.get(id);
    if (first && first.state) end(first.state.current, first.error && first.error.current);
    const [item] = await chrome.downloads.search({ id });
    if (item) end(item.state, item.error);
    return { id, ...(await ended) };
  } finally {
    chrome.downloads.onChanged.removeListener(onChanged);
    chrome.downloads.onErased.removeListener(onErased);
    // The browser may still read the blob just after the download ended.
    setTimeout(() => URL.revokeObjectURL(url), 60000).unref?.();
  }
}

// Imports a backup (validated as a whole first). A stored signing key is never
// replaced: a backup key that differs is reported in conflicts and the current
// key, ID and installation stay. Tracked repos take the backup's template and
// pre-release setting. File keys are added unless the key is a stored repo key.
// Returns { count, errors, conflicts: [{ key, keptId, backupId }], warnings }.
export async function importBackup(text) {
  await ready();
  const { repos, keys, fileKeys, warnings } = await parseBackup(text);
  const conflicts = [];
  await withStateLock(async () => {
    for (const [k, b64] of Object.entries(keys)) {
      const kept = await putSigningKeyIfAbsent(k, b64);
      if (kept !== b64) conflicts.push({ key: k, keptId: await idOfKey(kept), backupId: await idOfKey(b64) });
    }
    const repoKeys = new Set(Object.values(await listSigningKeys()));
    for (const [id, b64] of Object.entries(fileKeys)) if (!repoKeys.has(b64)) await putFileKeyIfAbsent(id, b64);
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
