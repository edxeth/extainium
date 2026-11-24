// Operations behind the UI and the background worker. Runs in extension pages
// and the service worker; installs (blob URLs) only work in pages.
// Every exported operation that changes state runs as a whole, one at a time
// across all contexts, under the operation lock (operation(), withOpLock in
// store.js), including its network calls and a hand-off's download up to its
// completion. Inside an operation, code calls internal functions (…Now),
// never an exported operation: the lock is not re-entrant. The event handlers
// (handleExtensionInstalled, sweepDownloads) do not take it and must be
// correct while an operation runs. Every read-modify-write of stored state,
// in operations and handlers, runs under the short withStateLock.

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
  removeInstall, removeKeyDeletion, removeRepoRecord, removeSigningKey, repoKey, setSettings, updateRepo, withOpLock,
  withStateLock,
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

// The UI's wait notice for the next operation started (whenQueued).
let waitNotice = null;

// An exported operation: fn(...args) runs under the operation lock.
function operation(fn) {
  return (...args) => {
    const onWait = waitNotice;
    waitNotice = null;
    return withOpLock(async () => {
      await ready();
      return fn(...args);
    }, onWait);
  };
}

// Calls call(), which must start one operation synchronously; when that
// operation has to wait for another one (in any context), onWait() is called
// first, and a function it returns once the operation runs. Returns call()'s result.
export function whenQueued(onWait, call) {
  waitNotice = onWait;
  try {
    return call();
  } finally {
    waitNotice = null;
  }
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
// waits for confirmIdentityChange. pendingInstall: { version, tag, promptAt } of
// a CRX handed to the browser whose install was not confirmed yet, or null;
// promptAt is when its "Add extension?" prompt appeared (its download
// completed), null while it is still downloading (see isPromptWaiting).
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
      .sort(promptOrder)[0];
    return {
      key, record, latest, ext, state,
      hasKey: key in keys,
      pendingInstall: pending
        ? { version: pending.version, tag: pending.installed && pending.installed.tag, promptAt: pending.downloadDone ? promptTime(pending) : null }
        : null,
    };
  });
}

// True while a pending install ({ promptAt }, as in trackedView) may still be
// confirmed at the browser's prompt: still downloading, or within
// PENDING_GRACE_MS of its prompt, the clock the key holds and cleanup use.
export function isPromptWaiting(pending, now = Date.now()) {
  return pending.promptAt === null || now - pending.promptAt < PENDING_GRACE_MS;
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

// The page cache of the last check as fetchReleases expects it. A cache from
// before releases carried updatedAt is not reused, so the next full check
// stores it and the feed can stand in for the API again.
function cachedPages(record) {
  if (!record.pages || !record.releases || record.releases.some((r) => !r.updatedAt)) return null;
  let at = 0;
  return record.pages.map(({ count, ...p }) => {
    const releases = record.releases.slice(at, at + count);
    at += count;
    return { ...p, releases };
  });
}

// The releases.atom entries of owner/repo, or null when the feed is
// unavailable or not understood (any failure: the check then uses the API).
async function readFeed(record) {
  try {
    return await fetchReleaseFeed(record.owner, record.repo);
  } catch {
    return null;
  }
}

const criteriaOf = (r) => ({ template: r.template, includePrereleases: r.includePrereleases });
const sameCriteria = (a, b) => !!a && !!b && a.template === b.template && a.includePrereleases === b.includePrereleases;
// A full API check is due at least this often, whatever the feed shows.
export const FULL_CHECK_MAX_AGE_MS = 24 * 60 * 60 * 1000;
// The stored form of a feed: every entry's id and updated time, in feed order.
const feedSnapshot = (feed) => ({ entries: feed.map((e) => [e.id, e.updated]) });
const sameSnapshot = (a, b) => !!a && !!b && Array.isArray(a.entries) && JSON.stringify(a.entries) === JSON.stringify(b.entries);
// The tag of a feed entry: GitHub's ids are tag:github.com,2008:Repository/<repo id>/<tag>.
const feedTag = (id) => (/^tag:github\.com,2008:Repository\/\d+\/(.+)$/.exec(id) || [])[1] ?? null;

// True when the feed shows that the API would select what the cache selects:
// the feed is exactly the one the last full check saw (every entry's id and
// updated time; any added, removed or changed entry needs the API), and the
// release selected last time is in it with the updated time the API reported
// for it. Also requires a cache, unchanged selection criteria and a full check
// within FULL_CHECK_MAX_AGE_MS. (The feed holds only the newest 10 releases
// and tags; a selected release outside it always needs the API.)
function feedCovers(record, feed, now) {
  if (!feed || !record.feed || !record.releases || !record.pages) return false;
  if (!sameCriteria(record.checkedCriteria, criteriaOf(record))) return false;
  if (!(now - record.fullCheckAt < FULL_CHECK_MAX_AGE_MS)) return false;
  const latest = latestFor(record);
  if (!latest) return false;
  const entry = feed.find((e) => feedTag(e.id) === latest.tag);
  const updated = Date.parse(latest.release.updatedAt);
  if (!entry || Number.isNaN(updated) || Date.parse(entry.updated) !== updated) return false;
  return sameSnapshot(feedSnapshot(feed), record.feed);
}

// Checks a repo for new releases. The releases API (rate-limited) is called
// unless the repo's releases.atom feed (not rate-limited) covers the release
// selected last time (feedCovers). The feed is read before the API, so a
// release published in between shows as a newer entry next time.
export const checkRepo = operation(checkRepoNow);

async function checkRepoNow(key) {
  const record = await getRepo(key);
  const { githubToken } = await getSettings();
  const checkedAt = Date.now();
  const feed = await readFeed(record);
  if (feedCovers(record, feed, checkedAt)) return patchRepo(key, { error: null, checkedAt });
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
    feed: feed && feedSnapshot(feed),
    checkedCriteria: criteriaOf(record),
    fullCheckAt: checkedAt,
    error: null,
    checkedAt,
  });
}

// Checks every repo; one failure does not stop the others. Returns { updates, errors }.
export const checkAll = operation(checkAllNow);

async function checkAllNow() {
  const errors = [];
  for (const r of await listRepos()) {
    try {
      await checkRepoNow(repoKey(r));
    } catch (e) {
      errors.push(e.message);
    }
  }
  const updates = await refreshBadge();
  await chrome.storage.local.set({ lastCheck: { at: Date.now(), updates, errors } });
  return { updates, errors };
}

export const addRepo = operation(async (input) => {
  const { owner, repo } = parseRepo(input);
  const key = repoKey({ owner, repo });
  await withStateLock(async () => {
    if (await findRepo(key)) throw new Error(`add repo: ${key} is already tracked`);
    await putRepo(newRecord(owner, repo));
  });
  await checkNewRepo(key);
  return key;
});

// First check of a record just created; when it fails, the record is removed
// again, and undo() runs in the same locked step.
async function checkNewRepo(key, undo = null) {
  try {
    await checkRepoNow(key);
  } catch (e) {
    await withStateLock(async () => {
      await removeRepoRecord(key);
      if (undo) await undo();
    });
    throw e;
  }
}

// The repo's signing key; a new one is generated and stored on first use.
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
  const newId = isCrxAsset ? await extensionIdFromCrx(await downloadAssetHead(latest.asset)) : await idOfKey(await ensureSigningKey(key));
  const exts = await installedExtensions();
  return updateRepo(key, (r) => (r.extensionId && r.extensionId !== newId && exts.has(r.extensionId)
    ? { ...r, identityChange: { from: r.extensionId, to: newId, tag: latest.tag, asset: latest.asset.name } }
    : { ...r, extensionId: newId, identityChange: null }));
}

// Accepts a pending identity change: the repo now tracks the new extension ID.
export const confirmIdentityChange = operation(async (key) => {
  const record = await updateRepo(key, (r) => {
    if (!r.identityChange) throw new Error(`confirm identity change of ${key}: no identity change is pending`);
    return { ...r, extensionId: r.identityChange.to, identityChange: null };
  });
  await refreshBadge();
  return record;
});

// template: asset file name template (releases.js), e.g. "ext-{version}.zip".
export const setTemplate = operation(setTemplateNow);

async function setTemplateNow(key, template) {
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
  if (r.releases && truncated && !hasEligible(r, r.releases)) await checkRepoNow(key);
  return link(key);
}

export const chooseAsset = operation((key, assetName, tag) => setTemplateNow(key, deriveTemplate(assetName, tag)));

export const setPrereleases = operation(async (key, includePrereleases) => {
  if (typeof includePrereleases !== "boolean") throw new Error(`set pre-releases of ${key}: not true/false: ${includePrereleases}`);
  await patchRepo(key, { includePrereleases });
  return relink(key);
});

// ---- Hand-off to the browser and download cleanup ----
// Each CRX handed to the browser gets an "install:<token>" entry:
//   { token, repoKey|null, extensionId, version|null, installed: {tag, digest, version},
//     crxHash, signedWith|null, supersededBy|null, downloadId|null, downloadDone,
//     promptAt|null, at, confirmedAt|null, fileGone, removeError|null }
// crxHash (sha256 hex of the CRX) names the build the entry stands for.
// downloadDone: the hand-off download completed, so the browser shows its
// "Add extension?" prompt; promptAt: when that was seen (null before; entries
// of older versions lack it and count from at).
// signedWith names the repo whose stored signing key signed the CRX, while the
// install may still use that key (cleared once it is confirmed, failed or
// superseded); a key removeRepo marked for deletion stays until no entry holds
// it (holdsKey): while the install is in flight (no download ID yet, or
// downloading), and then PENDING_GRACE_MS from promptAt.
// A hand-off runs inside its operation up to its download's completion, so the
// next hand-off starts only after that: hand-offs, their superseding and the
// attribution of install events are sequential. An entry stays in flight
// after its operation only when its page went away meanwhile (the browser then
// releases the operation lock). With a download ID, the sweep reads the
// download's end from the browser. Without one, the CRX's blob URL died with
// that page, so no download can start any more: after NO_DOWNLOAD_ID_MS the
// entry counts as failed and releases its key hold (holdsKey, sweepDownloads).
// management.onInstalled with the same ID and version confirms an entry: only
// then is record.installed committed. The event names no build, but
// Titanium's "Add extension?" prompt is modal, so a new prompt replaces the
// earlier one: once a hand-off's download completes, it supersedes the earlier
// prompted, unconfirmed entries of the same ID and version (version null,
// supersededBy its token), and an event confirms the newest prompted entry
// (promptOrder), or the entry in flight when none was prompted (Chromium may
// report the install before download() returns). When several are in flight
// and none was prompted (possible only after a page went away), the event is
// ambiguous and confirms none. An entry still in flight supersedes nothing yet
// and is not ended by an event; a hand-off that fails supersedes nothing. The downloaded
// copy is deleted after the confirmation (superseded copies of that version
// with it), or PENDING_GRACE_MS after promptAt when the prompt was declined or
// the install failed, and only once the download has finished. Only downloads
// Extainium started are ever deleted.
export const PENDING_GRACE_MS = 2 * 60 * 1000;
// How long an unconfirmed install may still be confirmed after its copy was deleted.
export const CONFIRM_WINDOW_MS = 24 * 60 * 60 * 1000;
export const SWEEP_ALARM = "sweep-downloads";
// How long an entry without a download ID stays in flight (see above). A live
// hand-off gets its ID from download() within moments; this only bounds
// entries whose page went away before that.
export const NO_DOWNLOAD_ID_MS = 10 * 60 * 1000;

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

// The time an entry's prompt appeared, or its hand-off time for entries of older versions.
const promptTime = (e) => e.promptAt ?? e.at;

// Unconfirmed entries in the order their prompts appeared, newest first:
// entries whose download completed, by promptTime; then those still in flight, newest first.
const promptOrder = (a, b) => Number(b.downloadDone) - Number(a.downloadDone) || promptTime(b) - promptTime(a);

// True while install entry e is in flight: its download may still complete.
const inFlight = (e, now) => !e.downloadDone && (e.downloadId !== null || now - e.at < NO_DOWNLOAD_ID_MS);

// True while install entry e may still install a CRX signed with repo k's key:
// in flight, or within PENDING_GRACE_MS of its prompt.
const holdsKey = (e, k, now) => e.signedWith === k && !e.confirmedAt
  && (e.downloadDone ? now - promptTime(e) < PENDING_GRACE_MS : inFlight(e, now));

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

// Inside an operation. claim: { key, keyPkcs8 (the repo key that signed the
// CRX, or null), change } for an install of tracked repo key; linked (claimLocked) in the same locked step that records
// the entry. newFileKey: the new key of a zip installed without a repo, kept
// in the file-key store. Returns { token, promptAt, confirmed } once the
// download completed: promptAt is when the prompt appeared, confirmed is true
// when the browser already reported the install.
async function handOff(crx, { repoKey: key, extensionId, manifest, installed, claim = null, newFileKey = null }) {
  const token = crypto.randomUUID();
  const crxHash = await sha256Hex(crx);
  const exts = claim ? await installedExtensions() : null;
  const conflict = await withStateLock(async () => {
    const at = Date.now();
    if (claim) {
      const changed = await claimLocked(claim, extensionId, exts);
      if (changed) return changed;
    }
    if (newFileKey) await putFileKeyIfAbsent(extensionId, newFileKey);
    await putInstall({
      token, repoKey: key, extensionId, version: manifest.version, installed, crxHash,
      signedWith: claim && claim.keyPkcs8 ? claim.key : null, supersededBy: null,
      downloadId: null, downloadDone: false, promptAt: null, at, confirmedAt: null, fileGone: false, removeError: null,
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
  // Armed before the download: if this page closes mid-download, only a sweep
  // resolves the entry (sweepDownloads re-arms itself while entries remain).
  await armSweep();
  let failure = null;
  try {
    await installCrx(crx, `${manifest.name}-${manifest.version}`, { onStarted });
  } catch (e) {
    failure = e;
  }
  const end = await withStateLock(async () => {
    let e = await getInstall(token);
    if (!e) return null;
    if (failure) {
      e = { ...e, version: null, signedWith: null }; // a failed download installs nothing
      if (e.downloadId === null) await removeInstall(token);
      else await storeInstall(await deleteCopy(e));
      await deleteReleasedKeys();
      return null;
    }
    const now = Date.now();
    e = { ...e, downloadDone: true, promptAt: e.promptAt ?? now };
    // management.onInstalled may have come first.
    if (e.confirmedAt) e = await deleteCopy(e, { quiet: true });
    else if (e.version) {
      // Its prompt is up now and has replaced the earlier ones of this ID and version.
      for (const o of await listInstalls()) {
        if (o.token === token || o.confirmedAt || !o.version || !o.downloadDone) continue;
        if (o.extensionId !== e.extensionId || o.version !== e.version) continue;
        await storeInstall({ ...o, version: null, supersededBy: token, signedWith: null }, now);
      }
    }
    await storeInstall(e, now);
    await deleteReleasedKeys(now);
    return e;
  });
  // Not awaited: the install result does not wait for the cleanup retry.
  if (end && end.confirmedAt && !end.fileGone) retryDeletes([token]).catch((e) => console.error("[Extainium] delete CRX copy:", e));
  await armSweep();
  if (failure) throw failure;
  return { token, promptAt: end ? end.promptAt : null, confirmed: !!(end && end.confirmedAt) };
}

// management.onInstalled: confirms the pending install of info.id at
// info.version whose prompt appeared last (promptOrder; the one still in
// flight only when none was prompted, none when several are) and commits it
// to its repo record, while that
// record is still linked to info.id (a file install never relinks a repo).
// Every other prompted or ended unconfirmed entry of that ID and version
// (superseded, detached, or older ones a previous version left) ends: its
// prompt is over. Entries still in flight stay: their prompt is yet to come.
// The copies of the ended ones are deleted, and keys they held are released.
export async function handleExtensionInstalled(info) {
  await ready();
  const retry = [];
  await withStateLock(async () => {
    const now = Date.now();
    const ofVersion = (await listInstalls())
      .filter((e) => e.extensionId === info.id && !e.confirmedAt && e.installed && e.installed.version === info.version)
      .sort(promptOrder);
    const prompted = ofVersion.filter((e) => e.version && e.downloadDone);
    const flying = ofVersion.filter((e) => e.version && !e.downloadDone && inFlight(e, now));
    const newest = prompted[0] || (flying.length === 1 ? flying[0] : null);
    for (let e of ofVersion) {
      if (e !== newest && flying.includes(e)) continue; // its prompt is yet to come
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

// Deletes copies of declined prompts and failed installs once their grace
// period after the prompt passed, retries failed deletions, and forgets
// finished entries. A hand-off whose page went away before its download ended
// never records the end; the sweep reads it from the browser (an item no
// longer listed counts as ended now).
export async function sweepDownloads(now = Date.now()) {
  await ready();
  await withStateLock(async () => {
    for (let e of await listInstalls()) {
      // A pending install of a repo that is no longer tracked.
      if (e.repoKey && !(await findRepo(e.repoKey))) e = detached(e);
      if (e.downloadId === null) {
        // Its hand-off may still wait for its download ID (onStarted records
        // it); past NO_DOWNLOAD_ID_MS its page went away, so no download can
        // start (the blob URL died with the page): failed, nothing to delete.
        if (!inFlight(e, now)) await removeInstall(e.token);
        else await putInstall(e);
        continue;
      }
      let failed = false;
      if (!e.downloadDone && !e.fileGone) {
        const [item] = await chrome.downloads.search({ id: e.downloadId });
        if (item && item.state === "in_progress") {
          await putInstall(e); // in flight: its copy stays, and it holds its key
          continue;
        }
        failed = !!item && item.state === "interrupted";
        if (failed) e = { ...e, version: null, signedWith: null }; // installs nothing
        e = { ...e, downloadDone: true, promptAt: e.promptAt ?? now };
      }
      const due = e.confirmedAt || failed || now - promptTime(e) >= PENDING_GRACE_MS;
      if (!e.fileGone && due) e = await deleteCopy(e);
      await storeInstall(e, now);
    }
    await deleteReleasedKeys(now);
    // Entries whose copy is gone only wait for a late install event: no sweep needed.
    if ((await listInstalls()).some((e) => !e.fileGone)) await armSweep();
  });
}

// Schedules the next sweepDownloads (the service worker runs it on SWEEP_ALARM);
// re-creating the alarm moves it, so at most one is pending.
function armSweep() {
  return chrome.alarms.create(SWEEP_ALARM, { delayInMinutes: PENDING_GRACE_MS / 60000 + 0.5 });
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

// Inside handOff's lock, for an install of tracked repo key: links the record
// to extensionId, unless it is linked to another installed extension (exts):
// then record.identityChange { from, to: extensionId, ...change } is set and
// that record returned.
async function claimLocked({ key, change }, extensionId, exts) {
  const r = await getRepo(key);
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
export const installRelease = operation(async (key, tag, onProgress = () => {}) => {
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
});

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
// installed, name, token, repoKey: the tracked repo the install belongs to, or
// null, promptAt: when the browser's prompt appeared (as in trackedView's
// pendingInstall), confirmed: the browser already reported the install }.
export const installFile = operation(async (bytes, filename, signWith) => {
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
  const { token, promptAt, confirmed } = await handOff(crx, {
    repoKey: repo, extensionId, manifest: { ...manifest, name: manifest.name || filename }, installed,
    claim: repo ? { key: repo, keyPkcs8, change: { tag: null, asset: filename } } : null,
    newFileKey: repo || fileKeyId ? null : keyPkcs8,
  });
  return { extensionId, keyPkcs8: repo ? null : keyPkcs8, installed, name: manifest.name, token, repoKey: repo, promptAt, confirmed };
});

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

// Deletes the file key of extension extensionId (see fileKeysView). A zip
// signed for it later gets a new key, so it installs as a different extension.
export const forgetFileKey = operation((extensionId) => withStateLock(async () => {
  if (!(await getFileKey(extensionId))) throw new Error(`forget file key: no file key is stored for extension ${extensionId}`);
  await removeFileKey(extensionId);
}));

// Starts tracking a repo for an extension installed from a file. The record,
// the file's signing key (from the file-key store, or fileResult.keyPkcs8)
// and the link to its ID are written in one locked step, before the network
// check: a stored repo key is never overruled, and the file's key is never
// lost. The key moves from the file-key store to the repo; unconfirmed
// installs signed with it then hold it as the repo's key. When the first
// check fails and the record is removed again, the key and those installs
// return to where they were in the same locked step, so the key is never in
// two places nor lost: the repo key goes only while it is still the one
// created here, and the file key comes back only while no repo owns the key.
export const trackInstalledFile = operation(async (input, fileResult) => {
  const { owner, repo } = parseRepo(input);
  const key = repoKey({ owner, repo });
  const exts = await installedExtensions();
  const id = fileResult.extensionId;
  const created = await withStateLock(async () => {
    if (await findRepo(key)) throw new Error(`track ${key}: ${key} is already tracked`);
    const stored = await getFileKey(id);
    const fileKey = stored || fileResult.keyPkcs8;
    let createdKey = null;
    if (fileKey) {
      const before = await getSigningKey(key);
      if (!stored && before !== fileKey) {
        const other = Object.entries(await listSigningKeys()).find(([, v]) => v === fileKey);
        if (other) throw new Error(`track ${key}: the file's key (extension ${id}) is already the signing key of ${other[0]}`);
      }
      const kept = await putSigningKeyIfAbsent(key, fileKey);
      if (kept !== fileKey) {
        throw new Error(`track ${key}: a different signing key (extension ${await idOfKey(kept)}) is stored for this repo; the file was signed as ${id}`);
      }
      if (!before) createdKey = fileKey;
      await removeFileKey(id);
    }
    const entry = await getInstall(fileResult.token);
    let installed = null;
    if (entry && entry.confirmedAt) installed = entry.installed;
    else if (exts.get(id)?.version === fileResult.installed.version && !entry) installed = fileResult.installed;
    const attached = [];
    for (const e of await listInstalls()) {
      if (e.confirmedAt || e.extensionId !== id) continue;
      const own = e.token === fileResult.token;
      if (!own && (e.repoKey !== null || !e.version || !fileKey)) continue;
      attached.push(e);
      await putInstall({ ...e, repoKey: own ? key : e.repoKey, signedWith: fileKey && e.version ? key : null });
    }
    await putRepo({ ...newRecord(owner, repo), extensionId: id, installed });
    return { stored, createdKey, attached };
  });
  await checkNewRepo(key, async () => {
    if (created.createdKey && (await getSigningKey(key)) === created.createdKey) await removeSigningKey(key);
    const back = created.stored || created.createdKey;
    if (back && !Object.values(await listSigningKeys()).includes(back)) await putFileKeyIfAbsent(id, back);
    for (const was of created.attached) {
      const e = await getInstall(was.token);
      if (e) await putInstall({ ...e, repoKey: was.repoKey, signedWith: was.signedWith });
    }
  });
  await refreshBadge();
  return key;
});

// Stops tracking. The signing key is kept (it re-attaches if the repo is added
// again and stays in exports) unless uninstall is set: then the extension is
// uninstalled (the browser asks the user; a refusal throws and changes nothing)
// and the key is marked for deletion. It is deleted at once when no pending
// install signed with it remains, else once those are confirmed, superseded,
// failed or past PENDING_GRACE_MS (handleExtensionInstalled, handOff,
// sweepDownloads); until then it stays, and is exported.
export const removeRepo = operation(async (key, uninstall) => {
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
});

// Repos and keys are read in one locked snapshot (event handlers may delete a
// released key meanwhile), so a repo is never exported without its key.
export const exportBackup = operation(async () => {
  const backup = await withStateLock(async () => makeBackup(await listRepos(), await listSigningKeys(), new Date(), await listFileKeys()));
  return JSON.stringify(backup, null, 2);
});

// Saves the GitHub token used by checks.
export const setGithubToken = operation((githubToken) => setSettings({ githubToken }));

// How long saveBackup waits for the end of its download before it reports
// that the save could not be confirmed (the browser may first ask where to save).
export const saveTiming = { confirmMs: 2 * 60 * 1000 };

// Saves the export to Downloads as filename. Page only (blob URL). The browser
// may first ask where to save; the result comes once the download ended:
// { saved, id, error } (error: why it was not saved, e.g. "download #3:
// USER_CANCELED"). The end is read from the download's own onChanged and
// onErased events, listened to before download() is called; events that
// arrive before it returns the ID are kept in arrival order and replayed for
// that ID, and the first end (complete, interrupted or erased) decides. A
// completed export may be missing from downloads.search on Titanium (seen on
// the phone; cause not found in Chromium's source), so search is optional: it
// is not awaited and may only add an end; its failure or stall changes
// nothing. Without any end after saveTiming.confirmMs the result is "not
// saved" with a "could not confirm" error. The export is an operation; the
// save itself is not (the browser's location dialog waits for the user).
export async function saveBackup(filename) {
  const url = URL.createObjectURL(new Blob([await exportBackup()], { type: "application/json" }));
  let id = null;
  const early = []; // [downloadId, apply] of events before download() returns the ID
  let settle;
  const ended = new Promise((resolve) => { settle = resolve; });
  const end = (state, error) => {
    if (state === "complete") settle({ saved: true, error: null });
    else if (state === "interrupted") settle({ saved: false, error: `download #${id}: ${error || "interrupted"}` });
  };
  const onEvent = (eventId, apply) => {
    if (id === null) early.push([eventId, apply]);
    else if (eventId === id) apply();
  };
  const onChanged = (d) => onEvent(d.id, () => d.state && end(d.state.current, d.error && d.error.current));
  const onErased = (erasedId) => onEvent(erasedId, () => settle({ saved: false, error: `download #${id} was erased before it ended` }));
  chrome.downloads.onChanged.addListener(onChanged);
  chrome.downloads.onErased.addListener(onErased);
  let timer = null;
  try {
    try {
      id = await chrome.downloads.download({ url, filename });
    } catch (e) {
      throw new Error(`save backup ${filename}: ${e.message}`);
    }
    for (const [eventId, apply] of early.splice(0)) if (eventId === id) apply();
    timer = setTimeout(() => settle({
      saved: false,
      error: `download #${id}: could not confirm that the backup was saved; no end of the download was reported within ${Math.round(saveTiming.confirmMs / 1000)} s`,
    }), saveTiming.confirmMs);
    chrome.downloads.search({ id }).then(([item]) => item && end(item.state, item.error), () => {});
    return { id, ...(await ended) };
  } finally {
    clearTimeout(timer);
    chrome.downloads.onChanged.removeListener(onChanged);
    chrome.downloads.onErased.removeListener(onErased);
    // The browser may still read the blob just after the download ended.
    setTimeout(() => URL.revokeObjectURL(url), 60000).unref?.();
  }
}

// Imports a backup (validated as a whole first). A stored signing key is never
// replaced: a backup key that differs is reported in conflicts and the current
// key, ID and installation stay. Tracked repos take the backup's template and
// pre-release setting. A key lives in one place: a backup key that is already
// another repo's key is not imported (a warning says so), a stored file key
// that the backup brings as a repo key moves to that repo, and backup file
// keys are added unless the key is a stored repo key.
// Returns { count, errors, conflicts: [{ key, keptId, backupId }], warnings }.
export const importBackup = operation(async (text) => {
  const { repos, keys, fileKeys, warnings } = await parseBackup(text);
  const conflicts = [];
  await withStateLock(async () => {
    for (const [k, b64] of Object.entries(keys)) {
      const owner = Object.entries(await listSigningKeys()).find(([o, v]) => v === b64 && o !== k);
      if (owner) {
        warnings.push(`${k}: the backup's signing key is already the key of ${owner[0]}; it was not imported for ${k}`);
        continue;
      }
      const kept = await putSigningKeyIfAbsent(k, b64);
      if (kept !== b64) conflicts.push({ key: k, keptId: await idOfKey(kept), backupId: await idOfKey(b64) });
    }
    const repoKeys = new Set(Object.values(await listSigningKeys()));
    for (const [id, b64] of Object.entries(await listFileKeys())) if (repoKeys.has(b64)) await removeFileKey(id);
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
  const { errors } = await checkAllNow();
  return { count: repos.length, errors, conflicts, warnings };
});
