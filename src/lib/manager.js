// Operations behind the UI and the background worker. Runs in extension pages
// and the service worker; installs (blob URLs) only work in pages.
// Every exported operation that changes state runs as a whole, one at a time
// across all contexts, under the operation lock (operation(), withOpLock in
// store.js), including its network calls and a hand-off's download up to its
// completion. Inside an operation, code calls internal functions (…Now),
// never an exported operation: the lock is not re-entrant. The event handlers
// (handleExtensionInstalled, reconcileInstalls, sweepDownloads) do not take it and must be
// correct while an operation runs. Every read-modify-write of stored state,
// in operations and handlers, runs under the short withStateLock.

import {
  base64Decode, base64Encode, extensionIdFromCrx, extensionIdFromSpki,
  generateSigningKey, importSigningKey, isCrx, packCrx3, verifyCrx, zipFromCrx,
} from "./crx.js";
import { normalizeExtensionZip, parseZip, readManifest, verifyZip } from "./zip.js";
import { MAX_RELEASE_PAGES, downloadAsset, downloadAssetHead, fetchReleaseFeed, fetchReleases, sha256Hex } from "./github.js";
import {
  compareVersions, deriveTemplate, isPackageAsset, latestFor, matchAssets, parseRepo, selectRelease, updateState, validateTemplate,
} from "./releases.js";
import {
  INSTALL_PREFIX, findRepo, getFileKey, getRepo, getSettings, getSigningKey, listFileKeys, listInstalls,
  listKeyDeletions, listRepos, listSigningKeys, makeBackup, markKeyForDeletion, migrateStorage, newRecord,
  newSourceRecord, parseBackup, patchRepo, putFileKeyIfAbsent, putInstall, putRepo, putSigningKeyIfAbsent, removeFileKey,
  removeInstall, removeKeyDeletion, removeRepoRecord, removeSigningKey, repoKey, setSettings, sourceOf, updateRepo, withOpLock,
  withStateLock,
} from "./store.js";
import {
  CWS_ORIGINS, TITANIUM_HELPER_ID, cwsCheckBatches, isCwsUpdateUrl, manifestName, originOf, parseSourceInput,
  parseUpdateManifest, readUpdatecheck, updateUrlCheckUrl,
} from "./sources.js";
import { installCrx } from "./install.js";
import { fetchFrom, missingOriginsOf } from "./net.js";

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

// The host permissions a record needs: the CWS hosts, or a self-hosted
// record's update URL host and the host of the build it announced last; and
// the destinations of the redirect that made its last fetch fail for want of
// a permission (record.redirectOrigins, see rememberOrigins).
function neededOrigins(record) {
  const redirects = record.redirectOrigins || [];
  if (record.source === "cws") return [...CWS_ORIGINS, ...redirects];
  if (record.source !== "updateUrl") return [];
  return [originOf(record.updateUrl), ...(record.latest && record.latest.codebase ? [originOf(record.latest.codebase)] : []), ...redirects];
}

// Sets record key's redirectOrigins to the origins its last fetch needs, so
// the view asks for those only (needsOrigins): a fetchFrom failure's
// error.neededOrigins (net.js), [] after a fetch that answered. They are
// replaced, never added to, so an origin an earlier redirect needed is not
// asked for once the server stops redirecting there.
function rememberOrigins(key, origins) {
  return updateRepo(key, (r) => ({ ...r, redirectOrigins: origins }));
}

// state of a CWS or update-URL record: "not-offered" (its server offers no
// build to this browser), "unknown" (no successful check yet, or versions
// that do not compare), "not-installed", "update" or "current".
function sourceState(record, ext) {
  if (record.unavailable) return "not-offered";
  if (!record.latest) return "unknown";
  if (!ext) return "not-installed";
  const order = orderOrNull(record.latest.version, ext.version);
  if (order === null) return record.latest.version === ext.version ? "current" : "unknown";
  return order > 0 ? "update" : "current";
}

function orderOrNull(a, b) {
  try {
    return compareVersions(a, b);
  } catch {
    return null; // a version outside the grammar, e.g. "2024-01"
  }
}

const SOURCE_LABELS = { github: "GitHub", cws: "Chrome Web Store" };

// [{ key, record, latest, ext, state, hasKey, pendingInstall, source, title,
//   sourceLabel, sourceUrl, needsOrigins }] for the UI and the badge.
// state: updateState's states for GitHub records, sourceState's for the
// others, or "identity-change" while record.identityChange waits for
// confirmIdentityChange, or "waiting" instead of "update" while a hand-off of
// the latest build may have been accepted and wait for Chromium to apply it
// (pendingInstall.waiting): tentative, the browser's version alone decides.
// pendingInstall: { version, tag, promptAt, waiting } of a CRX handed to the
// browser whose install was not confirmed yet, or null: the newest prompt
// (promptOrder) while it may still be answered (isPromptWaiting) or when it
// may have been accepted, else the newest one that may have been accepted, else
// the newest; promptAt is when its "Add extension?" prompt appeared (its
// download completed), null while it is still downloading (see
// isPromptWaiting); waiting: its copy vanished without an install event
// (vanishedAt, see judgeVanished), so Chromium may apply it later.
// source: "github" | "cws" | "updateUrl"; latest: latestFor(record) for
// GitHub, record.latest ({ version, codebase, size, hash } or null) for the
// others; title: the best known name; sourceLabel: "GitHub", "Chrome Web
// Store" or the update URL's host; sourceUrl: the repo page, the store page
// or the update URL; needsOrigins: the host permissions (origin patterns) the
// record needs and the extension does not hold yet, [] when all are granted;
// canInstall: a downloadable build exists (GitHub: latest has an asset; CWS
// and update URL: latest has a codebase and the server offers a build; false
// after a self-hosted "noupdate", whose latest has codebase null). It says
// nothing about an identity change (state) or missing permissions.
// The array also carries installBlocked: environment()'s installBlocked.
export async function trackedView() {
  await ready();
  const [records, exts, keys, installs, { installBlocked = null }] = await Promise.all([
    listRepos(), installedExtensions(), listSigningKeys(), listInstalls(), chrome.storage.local.get("installBlocked"),
  ]);
  const views = await Promise.all(records.map(async (record) => {
    const key = repoKey(record);
    const source = sourceOf(record);
    const github = source === "github";
    const latest = github ? latestFor(record) : record.latest;
    const ext = (record.extensionId && exts.get(record.extensionId)) || null;
    let state = record.identityChange ? "identity-change" : github ? updateState({ latest, installed: record.installed }, ext) : sourceState(record, ext);
    const open = installs
      .filter((i) => i.repoKey === key && i.extensionId === record.extensionId && !i.confirmedAt && i.version)
      .sort(promptOrder);
    const promptOf = (i) => (i.downloadDone ? promptTime(i) : null);
    // A later dismissed prompt does not hide an earlier one that may have been accepted.
    const pending = open[0] && (open[0].vanishedAt || isPromptWaiting({ promptAt: promptOf(open[0]) }))
      ? open[0]
      : open.find((i) => i.vanishedAt) || open[0];
    const pendingInstall = pending
      ? { version: pending.version, tag: pending.installed && pending.installed.tag, promptAt: promptOf(pending), waiting: !!pending.vanishedAt }
      : null;
    if (state === "update" && pending && pending.vanishedAt && isLatestBuild(pending.installed, latest, github)) state = "waiting";
    return {
      key, record, latest, ext, state,
      hasKey: key in keys,
      pendingInstall,
      source,
      title: github ? (ext ? ext.name : record.repo) : (ext && ext.name) || record.name || record.id,
      sourceLabel: SOURCE_LABELS[source] || new URL(record.updateUrl).host,
      sourceUrl: github ? `https://github.com/${record.owner}/${record.repo}`
        : source === "cws" ? `https://chromewebstore.google.com/detail/${record.id}` : record.updateUrl,
      needsOrigins: await missingOriginsOf(neededOrigins(record)),
      canInstall: github ? !!(latest && latest.asset) : !record.unavailable && !!(latest && latest.codebase),
    };
  }));
  views.installBlocked = installBlocked;
  return views;
}

// ---- Browser environment ----

// The browser's full version ("158.0.8127.100"): the Chromium (or Google
// Chrome) brand of navigator.userAgentData's fullVersionList, else the user
// agent's Chrome/<version> (which user-agent reduction may shorten to x.0.0.0).
export async function browserVersion() {
  const uad = navigator.userAgentData;
  if (uad && typeof uad.getHighEntropyValues === "function") {
    const { fullVersionList = [] } = await uad.getHighEntropyValues(["fullVersionList"]);
    const brand = fullVersionList.find((b) => b.brand === "Chromium") || fullVersionList.find((b) => b.brand === "Google Chrome");
    if (brand && /^\d+(\.\d+){3}$/.test(brand.version)) return brand.version;
  }
  const ua = String(navigator.userAgent || "");
  const m = /Chrome\/(\d+\.\d+\.\d+\.\d+)/.exec(ua);
  if (!m) throw new Error(`read browser version: no Chrome/<version> in the user agent ${JSON.stringify(ua)}`);
  return m[1];
}

async function platformOf() {
  if (/Android/.test(String(navigator.userAgent || ""))) return "android";
  return (await chrome.runtime.getPlatformInfo()).os === "android" ? "android" : "desktop";
}

// True on desktop browsers other than Titanium: an off-store CRX installs
// there only with chrome://flags/#extension-mime-request-handling set to
// "Always prompt for install" (ungoogled-chromium's flag).
async function installNeedsFlag() {
  return (await platformOf()) === "desktop" && !(await installedExtensions()).has(TITANIUM_HELPER_ID);
}

// { platform: "android" | "desktop", browserVersion, installNeedsFlag,
//   installBlocked: { at, hint: "flag" } | null }. installBlocked: a desktop
// hand-off whose download completed within INSTALL_REFUSED_MS of its start
// (no "Add extension?" prompt held it) and whose copy the browser's installer
// deleted without an install: the browser refused the off-store install, so
// the flag is not set. Cleared by the next confirmed install or by
// dismissInstallBlocked.
export async function environment() {
  await ready();
  const [platform, version, needsFlag, { installBlocked = null }] = await Promise.all([
    platformOf(), browserVersion(), installNeedsFlag(), chrome.storage.local.get("installBlocked"),
  ]);
  return { platform, browserVersion: version, installNeedsFlag: needsFlag, installBlocked };
}

// Forgets view.installBlocked (the UI's banner was dismissed).
export const dismissInstallBlocked = operation(() => withStateLock(() => chrome.storage.local.remove("installBlocked")));

// ---- Installed extensions ----

const BROWSER_INSTALL_TYPES = new Set(["admin", "sideload", "other"]);

// kind of an installed extension: "tracked" (trackedKey is the record that
// follows it), "browser" (installed by policy, another program or the
// browser, or Titanium's helper), "cws" (updates from the CWS), "selfUpdating"
// (another update URL) or "unmanaged" (no update URL).
function installedKind(ext, trackedKey) {
  if (trackedKey) return "tracked";
  if (BROWSER_INSTALL_TYPES.has(ext.installType) || ext.id === TITANIUM_HELPER_ID) return "browser";
  if (ext.updateUrl && isCwsUpdateUrl(ext.updateUrl)) return "cws";
  return ext.updateUrl ? "selfUpdating" : "unmanaged";
}

const isHttpsUrl = (url) => {
  try {
    return new URL(url).protocol === "https:";
  } catch {
    return false;
  }
};

// How an untracked extension of kind can be tracked: "cws", "updateUrl"
// (an https update URL), "github" (linked to a repo) or null.
function canTrackOf(ext, kind) {
  if (kind === "cws") return "cws";
  if (kind === "selfUpdating") return isHttpsUrl(ext.updateUrl) ? "updateUrl" : null;
  return kind === "unmanaged" ? "github" : null;
}

// The largest icon chrome.management lists, or null.
const bestIcon = (ext) => [...(ext.icons || [])].sort((a, b) => b.size - a.size)[0]?.url || null;

// Every installed extension: [{ id, name, version, enabled, icon, installType,
// updateUrl, kind, trackedKey, canTrack, needsOrigins, updateHost }], sorted
// by name. kind: installedKind's; trackedKey: the record that follows it, or
// null; canTrack: canTrackOf's; needsOrigins: the host permissions that
// tracking it needs and the extension does not hold yet (request them before
// trackInstalled); updateHost: the update URL's host, or null.
export async function installedOverview() {
  await ready();
  const [records, all] = await Promise.all([listRepos(), chrome.management.getAll()]);
  const trackedBy = new Map(records.filter((r) => r.extensionId).map((r) => [r.extensionId, repoKey(r)]));
  const rows = await Promise.all(all.map(async (ext) => {
    const trackedKey = trackedBy.get(ext.id) || null;
    const kind = installedKind(ext, trackedKey);
    const canTrack = canTrackOf(ext, kind);
    const needed = canTrack === "cws" ? CWS_ORIGINS : canTrack === "updateUrl" ? [originOf(ext.updateUrl)] : [];
    let updateHost = null;
    try {
      updateHost = ext.updateUrl ? new URL(ext.updateUrl).host : null;
    } catch {
      updateHost = null; // not a URL: shown without a host
    }
    return {
      id: ext.id, name: ext.name, version: ext.version, enabled: ext.enabled, icon: bestIcon(ext),
      installType: ext.installType || null, updateUrl: ext.updateUrl || null,
      kind, trackedKey, canTrack, needsOrigins: await missingOriginsOf(needed), updateHost,
    };
  }));
  return rows.sort((a, b) => String(a.name).localeCompare(String(b.name)) || a.id.localeCompare(b.id));
}

// True when installed ({ tag, digest, version } of a hand-off) is the latest
// build: GitHub by tag, and by digest when both are known; the other sources by version.
function isLatestBuild(installed, latest, github) {
  if (!latest || !installed) return false;
  if (!github) return installed.version === latest.version;
  if (installed.tag !== latest.tag) return false;
  const digest = latest.asset && latest.asset.digest;
  return !digest || !installed.digest || installed.digest === digest;
}

// The state of the hand-off token returned (installFile's token): "confirmed",
// "waiting" (its copy vanished without an install event: Chromium may apply it
// later, see vanishedAt), "pending" (not confirmed yet, or declined) or null
// once the entry is gone or ended.
export async function handOffState(token) {
  await ready();
  const e = await getInstall(token);
  if (!e) return null;
  if (e.confirmedAt) return "confirmed";
  if (!e.version) return null;
  return e.vanishedAt ? "waiting" : "pending";
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
  if (sourceOf(record) !== "github") {
    const error = (await checkSourcesNow([record])).get(key);
    if (error) throw new Error(error);
    return getRepo(key);
  }
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

// Checks every repo; one failure does not stop the others. Returns { updates,
// errors }. Stores lastCheck { at, updates }; the errors stay on the records
// (record.error), from which the UI counts them (ui-logic.js checkErrorCount).
export const checkAll = operation(checkAllNow);

async function checkAllNow() {
  const errors = [];
  const records = await listRepos();
  for (const r of records.filter((x) => sourceOf(x) === "github")) {
    try {
      await checkRepoNow(repoKey(r));
    } catch (e) {
      errors.push(e.message);
    }
  }
  for (const error of (await checkSourcesNow(records.filter((x) => sourceOf(x) !== "github"))).values()) {
    if (error) errors.push(error);
  }
  const updates = await refreshBadge();
  await chrome.storage.local.set({ lastCheck: { at: Date.now(), updates } });
  return { updates, errors };
}

// ---- Checks of CWS and update-URL records ----

const CHECK_FETCH = { credentials: "omit", cache: "no-store" };

// Stores a successful check: the newest build, or, after "noupdate", that
// none is offered. installedVersion: the version the request named (v=), for
// which "noupdate" means "up to date"; null when it named 0.0.0.0.
function applyUpdatecheck(key, result, checkedAt, installedVersion) {
  const done = { error: null, checkedAt, redirectOrigins: [] };
  if (result.kind === "update") return patchRepo(key, { latest: result.latest, unavailable: null, ...done });
  if (installedVersion) {
    return patchRepo(key, { latest: { version: installedVersion, codebase: null, size: null, hash: null }, unavailable: null, ...done });
  }
  return patchRepo(key, { latest: null, unavailable: { malware: result.malware }, ...done });
}

// Checks CWS and update-URL records: all CWS records in batched requests
// (cwsCheckBatches), each update-URL record with its own request. One
// failure does not stop the others; each record keeps its error. Returns
// Map(key -> error message or null).
async function checkSourcesNow(records) {
  const results = new Map();
  const checkedAt = Date.now();
  // e: the failure; fetched: the update server answered. The origins a
  // fetch failure names (e.neededOrigins), or none after an answer, replace
  // the remembered ones; a failure before any fetch leaves them.
  const fail = async (key, e, fetched = false) => {
    const error = `check ${key}: ${e.message}`;
    results.set(key, error);
    await patchRepo(key, { error, checkedAt });
    const origins = e.neededOrigins || (fetched ? [] : null);
    if (origins) await rememberOrigins(key, origins);
  };
  const cws = records.filter((r) => r.source === "cws");
  if (cws.length) {
    const missing = await missingOriginsOf([CWS_ORIGINS[0]]);
    if (missing.length) {
      for (const r of cws) await fail(repoKey(r), new Error(`no host permission for ${missing.join(", ")}`));
    } else {
      const version = await browserVersion();
      for (const batch of cwsCheckBatches(cws.map((r) => r.id), version)) {
        let apps = null;
        let batchError = null;
        let fetched = false;
        try {
          const res = await fetchFrom(batch.url, CHECK_FETCH);
          fetched = true;
          apps = parseUpdateManifest(await res.text()).apps;
          const extra = apps.find((a) => !batch.ids.includes(a.appid));
          if (extra) throw new Error(`the update server's answer lists extension ${JSON.stringify(extra.appid)}, which was not asked for`);
        } catch (e) {
          batchError = e;
        }
        for (const id of batch.ids) {
          const key = repoKey({ source: "cws", id });
          try {
            if (batchError) throw batchError;
            const app = apps.find((a) => a.appid === id);
            if (!app) throw new Error("the update server's answer has no entry for this extension");
            await applyUpdatecheck(key, readUpdatecheck(app, { needHashAndSize: true }), checkedAt, null);
            results.set(key, null);
          } catch (e) {
            await fail(key, e, fetched);
          }
        }
      }
    }
  }
  for (const record of records.filter((r) => r.source === "updateUrl")) {
    const key = repoKey(record);
    let fetched = false;
    try {
      const missing = await missingOriginsOf([originOf(record.updateUrl)]);
      if (missing.length) throw new Error(`no host permission for ${missing.join(", ")}`);
      const ext = (await installedExtensions()).get(record.id);
      const version = ext ? ext.version : null;
      const url = updateUrlCheckUrl(record.updateUrl, record.id, version || "0.0.0.0");
      const res = await fetchFrom(url, CHECK_FETCH);
      fetched = true;
      const { apps } = parseUpdateManifest(await res.text());
      const app = apps.find((a) => a.appid === record.id);
      if (!app) throw new Error(`${new URL(record.updateUrl).host} lists no update for this extension`);
      await applyUpdatecheck(key, readUpdatecheck(app), checkedAt, version);
      results.set(key, null);
    } catch (e) {
      await fail(key, e, fetched);
    }
  }
  return results;
}

// Adds a record and runs its first check. When that fails, the record is
// removed again, unless it still needs host permissions (needsOrigins: a
// missing permission or a redirect to a host without one): then it stays with
// its error, so the UI can request them in a gesture and check again; the
// error is thrown in both cases. The record must not follow an extension
// another record follows.
async function addSourceRecordNow(record, what) {
  const key = repoKey(record);
  await withStateLock(async () => {
    for (const r of await listRepos()) {
      if (repoKey(r) === key) throw new Error(`${what}: ${key} is already tracked`);
      if (record.extensionId && r.extensionId === record.extensionId) throw new Error(`${what}: extension ${record.extensionId} is already tracked as ${repoKey(r)}`);
    }
    await putRepo(record);
  });
  try {
    await checkRepoNow(key);
  } catch (e) {
    await withStateLock(async () => {
      const r = await findRepo(key);
      if (r && !(await missingOriginsOf(neededOrigins(r))).length) await removeRepoRecord(key);
    });
    await refreshBadge();
    throw e;
  }
  await refreshBadge();
  return key;
}

// input: owner/repo, a GitHub URL, a CWS link or an extension ID (parseSourceInput).
// A CWS item needs the CWS_ORIGINS host permissions (the first check fails without them).
export const addRepo = operation(async (input) => {
  const parsed = parseSourceInput(input);
  if (parsed.source === "cws") {
    const ext = (await installedExtensions()).get(parsed.id);
    return addSourceRecordNow(newSourceRecord("cws", parsed.id, { name: ext ? ext.name : null }), "add repo");
  }
  const { owner, repo } = parsed;
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

// Throws unless key is a GitHub record (templates and pre-releases apply to releases only).
async function requireGithub(key, what) {
  if (sourceOf(await getRepo(key)) !== "github") throw new Error(`${what}: ${key} is not a GitHub repo`);
}

async function setTemplateNow(key, template) {
  await requireGithub(key, `set template of ${key}`);
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
  await requireGithub(key, `set pre-releases of ${key}`);
  await patchRepo(key, { includePrereleases });
  return relink(key);
});

// ---- Hand-off to the browser and download cleanup ----
// Each CRX handed to the browser gets an "install:<token>" entry:
//   { token, repoKey|null, extensionId, version|null, installed: {tag, digest, version},
//     crxHash, signedWith|null, supersededBy|null, downloadId|null, startedAt|null,
//     downloadDone, promptAt|null, at, confirmedAt|null, fileGone, removeError|null,
//     refusalCandidate?, fromVersion?, vanishedAt?, fileRemoved?, foundGone? }
// startedAt: when download() returned the download ID.
// fromVersion: the extension's installed version at the hand-off, or null.
// vanishedAt: when Extainium saw the prompted copy gone without an install
// event and without deleting it itself (judgeVanished). Only a hint: Chromium's
// installer deletes the copy when the prompt is accepted, also when it then
// delays the update of a running extension until its processes are gone or the
// browser restarts, but also on an installer failure, and anyone may delete it.
// Such an entry waits, past CONFIRM_WINDOW_MS, for its install event or for
// reconcileInstalls, which compares the browser's version.
// refusalCandidate: a desktop hand-off (installNeedsFlag) whose download
// completed within INSTALL_REFUSED_MS of its start: true until judged
// (judgeRefusal), then false. A candidate's copy is judgeRefusal's alone,
// never judgeVanished's.
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
// supersededBy its token) except those whose copy vanished (judgeVanished: that
// prompt may have been accepted, and Chromium may still apply it), and an event
// confirms the newest vanished prompted entry, else the newest prompted entry
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
// A desktop hand-off whose download completes this soon after it started was
// not held by an "Add extension?" prompt (Chromium completes the download only
// once the prompt is answered); measured: ~15 ms when the installer refused.
export const INSTALL_REFUSED_MS = 3000;

const getInstall = async (token) => (await chrome.storage.local.get(INSTALL_PREFIX + token))[INSTALL_PREFIX + token] || null;

// Deletes the entry's downloaded file and its download-list item; inside the lock.
// A download still in progress is left alone (erase would cancel it). The item
// is erased only once its file is gone or the download was interrupted (erase
// deletes the partial file). Keeps the entry with removeError when the file
// could not be deleted.
// quiet: a failure is not recorded as removeError (a retry follows).
// fileRemoved: Extainium removed the file itself (the item may still be listed
// when erase failed), so its absence says nothing about the installer.
// foundGone: the file was gone already, not deleted by Extainium (the item
// says so, or removeFile reports it deleted after a stale file check): the
// sweep's evidence for judgeVanished.
async function deleteCopy(entry, { quiet = false } = {}) {
  const id = entry.downloadId;
  try {
    const [item] = await chrome.downloads.search({ id });
    if (!item) return { ...entry, fileGone: true, removeError: null };
    if (item.state === "in_progress") return entry;
    if (copyGone(item)) entry = { ...entry, foundGone: true };
    else if (item.state === "complete") {
      try {
        await chrome.downloads.removeFile(id);
        entry = { ...entry, fileRemoved: true };
      } catch (e) {
        // "Invalid downloadId": the item was erased meanwhile, nothing left to address.
        if (/invalid download ?id/i.test(e.message)) return { ...entry, fileGone: true, removeError: null };
        if (!/already deleted/i.test(e.message)) throw e;
        entry = { ...entry, foundGone: true };
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
  return e.fileGone && !e.vanishedAt && now - e.at >= CONFIRM_WINDOW_MS;
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
  const exts = await installedExtensions();
  const fromVersion = exts.has(extensionId) ? exts.get(extensionId).version : null;
  const conflict = await withStateLock(async () => {
    const at = Date.now();
    if (claim) {
      const changed = await claimLocked(claim, extensionId, exts);
      if (changed) return changed;
    }
    if (newFileKey) await putFileKeyIfAbsent(extensionId, newFileKey);
    await putInstall({
      token, repoKey: key, extensionId, version: manifest.version, installed, crxHash, fromVersion,
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
    if (e) await putInstall({ ...e, downloadId, startedAt: Date.now() });
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
  const needsFlag = !failure && (await installNeedsFlag());
  // Earlier prompts this one may supersede are judged first (judgeVanished): starts the browser's file check.
  const sameVersion = (o) => o.token !== token && !o.confirmedAt && o.version === manifest.version && o.downloadDone && o.extensionId === extensionId;
  if (!failure && (await listInstalls()).some((o) => sameVersion(o) && !o.vanishedAt)) {
    await chrome.downloads.search({});
    await sleep(cleanupTiming.settleMs);
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
    if (needsFlag && !e.confirmedAt && e.startedAt && e.promptAt - e.startedAt < INSTALL_REFUSED_MS) e.refusalCandidate = true;
    // management.onInstalled may have come first.
    if (e.confirmedAt) e = await deleteCopy(e, { quiet: true });
    else if (e.version) {
      // Its prompt is up now and has replaced the earlier ones of this ID and
      // version, except those that may have been accepted: Chromium may still apply them.
      for (let o of await listInstalls()) {
        if (!sameVersion(o)) continue;
        if (!o.vanishedAt && o.downloadId !== null && !o.fileGone) o = judgeVanished(o, copyGone((await chrome.downloads.search({ id: o.downloadId }))[0]), now);
        await storeInstall(o.vanishedAt ? o : { ...o, version: null, supersededBy: token, signedWith: null }, now);
      }
    }
    await storeInstall(e, now);
    await deleteReleasedKeys(now);
    return e;
  });
  // Not awaited: the install result does not wait for the cleanup retry.
  if (end && end.confirmedAt && !end.fileGone) retryDeletes([token]).catch((e) => console.error("[Extainium] delete CRX copy:", e));
  // A quick answer while this page stays open; the sweep judges it otherwise.
  if (end && needsFlag && !end.confirmedAt && end.version) watchCopy(token).catch((e) => console.error("[Extainium] check install copy:", e));
  await armSweep();
  await refreshBadge();
  if (failure) throw failure;
  return { token, promptAt: end ? end.promptAt : null, confirmed: !!(end && end.confirmedAt) };
}

// Judges a refusal candidate (see the entry fields) inside the lock, item
// being its download (downloads.search, after a search started the browser's
// file check, as in retryDeletes): the copy gone while the install is still
// unconfirmed means the installer refused it, so installBlocked is recorded
// (see environment). A confirmed install, a vanished download item, or any
// install confirmed after the candidate's download completed (installWorkedAt:
// installs work, newer evidence than the candidate's) ends the candidate; a
// copy still present leaves it for a later judgement. Returns the entry.
async function judgeRefusal(e, item) {
  if (!e.refusalCandidate) return e;
  const { installWorkedAt = 0 } = await chrome.storage.local.get("installWorkedAt");
  if (e.confirmedAt || !item || promptTime(e) <= installWorkedAt) return { ...e, refusalCandidate: false };
  if (item.exists !== false) return e;
  await chrome.storage.local.set({ installBlocked: { at: promptTime(e), hint: "flag" } });
  return { ...e, refusalCandidate: false };
}

// True when download item (downloads.search) shows its completed file gone.
const copyGone = (item) => !!item && item.state === "complete" && item.exists === false;

// Judges whether a prompted, unconfirmed entry's copy vanished without an
// install event (vanishedAt, a hint that the prompt was accepted and Chromium
// delays the update), gone telling that the copy is gone (copyGone after a
// started file check, or deleteCopy's foundGone). Chromium's installer deletes
// the copy once the prompt is accepted, also when it then delays the update,
// while a dismissed prompt leaves it (crx_installer.cc CleanupTempFiles; seen
// on ungoogled-chromium 156); an installer failure or anyone else may delete
// it too, so the browser's version decides later (reconcileInstalls). A copy
// Extainium removed itself (fileRemoved) and a refusal candidate's copy
// (judgeRefusal's alone) are never judged here. Returns the entry.
function judgeVanished(e, gone, now = Date.now()) {
  if (!gone || e.vanishedAt || e.confirmedAt || !e.version || !e.downloadDone || e.fileRemoved || e.refusalCandidate !== undefined) return e;
  return { ...e, vanishedAt: now };
}

// A desktop download that completed within INSTALL_REFUSED_MS of its start
// (downloads.search's startTime and endTime): no prompt held it.
const completedAtOnce = (item) => item.state === "complete" && !!item.startTime && !!item.endTime
  && Date.parse(item.endTime) - Date.parse(item.startTime) < INSTALL_REFUSED_MS;

// In the hand-off's page on desktop, after the download completed (there it
// completes once the prompt is answered): judges a refusal candidate
// (judgeRefusal) or else a vanished copy (judgeVanished) once the browser's
// file check had time to notice a deleted copy. The sweep judges both as
// well, for a page that went away and on Android.
async function watchCopy(token) {
  await sleep(cleanupTiming.retryMs);
  await chrome.downloads.search({});
  await sleep(cleanupTiming.settleMs);
  await withStateLock(async () => {
    const e = await getInstall(token);
    if (!e || e.confirmedAt || e.downloadId === null) return;
    const [item] = await chrome.downloads.search({ id: e.downloadId });
    await storeInstall(e.refusalCandidate ? await judgeRefusal(e, item) : judgeVanished(e, copyGone(item)));
  });
  await refreshBadge();
}

// management.onInstalled: confirms the pending install of info.id at
// info.version that the browser applied (settleInstalled): the newest prompted
// one whose copy vanished (judged here first: Chromium applies the last
// accepted prompt), else the newest prompted one (promptOrder; the one still
// in flight only when none was prompted, none when several are), while its
// record is still linked to info.id (a file install never relinks a repo).
export async function handleExtensionInstalled(info) {
  await ready();
  const retry = [];
  await withStateLock(async () => {
    const now = Date.now();
    const ofVersion = [];
    for (let e of await ofVersionLocked(info.id, info.version)) {
      if (e.version && e.downloadDone && !e.fileGone && e.downloadId !== null) {
        e = judgeVanished(e, copyGone((await chrome.downloads.search({ id: e.downloadId }))[0]), now);
      }
      ofVersion.push(e);
    }
    const prompted = ofVersion.filter((e) => e.version && e.downloadDone);
    const flying = ofVersion.filter((e) => e.version && !e.downloadDone && inFlight(e, now));
    const newest = prompted.find((e) => e.vanishedAt) || prompted[0] || (flying.length === 1 ? flying[0] : null);
    await settleInstalled(info, ofVersion, newest, now, retry);
  });
  await refreshBadge();
  await retryDeletes(retry);
}

// The unconfirmed entries of extension id at version, newest prompt first (promptOrder); inside the lock.
const ofVersionLocked = async (id, version) => (await listInstalls())
  .filter((e) => e.extensionId === id && !e.confirmedAt && e.installed && e.installed.version === version)
  .sort(promptOrder);

// Inside the lock: confirms entry newest (or none) of ofVersionLocked(info.id,
// info.version) as installed and commits it to its repo record while that is
// still linked to info.id. Every other prompted or ended unconfirmed entry of
// that ID and version (superseded, detached, or older ones a previous version
// left) ends: its prompt is over. Entries still in flight stay: their prompt
// is yet to come. A vanished entry of an older version ends too: the browser
// installed a newer one instead (it applies only the last accepted). The
// copies of the ended ones are deleted (tokens left to retry go to retry).
async function settleInstalled(info, ofVersion, newest, now, retry) {
  for (let e of ofVersion) {
    if (e !== newest && !e.downloadDone && e.version && inFlight(e, now)) continue; // its prompt is yet to come
    if (e === newest) {
      e = { ...e, confirmedAt: now, signedWith: null };
      // Installs work now: no older refusal candidate may report otherwise (judgeRefusal).
      await chrome.storage.local.remove("installBlocked");
      await chrome.storage.local.set({ installWorkedAt: now });
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
  for (const e of await listInstalls()) {
    if (e.extensionId !== info.id || e.confirmedAt || !e.vanishedAt || !e.version || !e.installed) continue;
    if (orderOrNull(info.version, e.installed.version) > 0) await storeInstall(await endEntry(e), now);
  }
  await deleteReleasedKeys(now);
}

// Ends an unconfirmed entry that will not be applied; inside the lock. Its
// copy (gone already) leaves the download list.
async function endEntry(e) {
  const ended = { ...e, version: null, signedWith: null };
  return ended.downloadId !== null && !ended.fileGone ? deleteCopy(ended, { quiet: true }) : ended;
}

// Compares the browser's versions with the vanished entries (vanishedAt): the
// browser applies a delayed update at its next start without any
// management.onInstalled event (seen on ungoogled-chromium 156). Runs at the
// browser's start (startedAt: when it started) and with the periodic check.
// Per extension: a vanished entry whose version is installed now, and was not
// the installed version at its hand-off (fromVersion; a same-version rebuild
// is told apart only by its install event), is confirmed as by
// handleExtensionInstalled (the newest prompt of them, promptOrder). Otherwise
// a vanished entry ends when its extension is gone or runs a newer version,
// and at the browser's start when it was prompted before (Chromium applies
// pending updates while it starts, so one not applied then never applies).
export async function reconcileInstalls({ startedAt = null } = {}) {
  await ready();
  const exts = await installedExtensions();
  const retry = [];
  await withStateLock(async () => {
    const now = Date.now();
    const vanished = (await listInstalls()).filter((e) => e.vanishedAt && !e.confirmedAt && e.version && e.installed);
    for (const id of new Set(vanished.map((e) => e.extensionId))) {
      const ext = exts.get(id);
      const mine = vanished.filter((e) => e.extensionId === id).sort(promptOrder);
      const applied = ext && mine.find((e) => e.version === ext.version && e.fromVersion != null && e.fromVersion !== e.version);
      if (applied) {
        const ofVersion = (await ofVersionLocked(id, ext.version)).map((e) => (e.token === applied.token ? applied : e));
        await settleInstalled({ id, version: ext.version }, ofVersion, applied, now, retry);
      }
      for (const { token } of mine) {
        const e = await getInstall(token); // settleInstalled may have ended it
        if (!e || e.confirmedAt || !e.version) continue;
        if (!ext || orderOrNull(ext.version, e.version) > 0 || (startedAt !== null && promptTime(e) < startedAt)) {
          await storeInstall(await endEntry(e), now);
        }
      }
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
// longer listed counts as ended now). It also judges refusal candidates
// (judgeRefusal) and, for every other entry, vanished copies (judgeVanished)
// before their copies are deleted, so neither depends on the hand-off's page
// staying open; a copy found gone while deleting it (a stale file check) is
// judged too. A download whose end the sweep finds becomes a refusal candidate
// when it completed at once on desktop. The platform
// and the candidates are decided under the lock, on the entries read there
// (an entry may have changed since the snapshot taken before it); the
// browser's file check is started before the lock for the entries seen then,
// and a candidate whose copy still shows waits for the next sweep.
export async function sweepDownloads(now = Date.now()) {
  await ready();
  const pending = (await listInstalls()).filter((e) => !e.fileGone && !e.confirmedAt && (e.downloadId !== null || !e.downloadDone));
  const undecided = (e) => e.downloadDone && e.version && !e.vanishedAt;
  if (pending.some((e) => e.refusalCandidate || undecided(e)) || (pending.some((e) => !e.downloadDone) && (await installNeedsFlag()))) {
    // Starts the browser's file check, so the searches below see a deleted copy.
    await chrome.downloads.search({});
    await sleep(cleanupTiming.settleMs);
  }
  await withStateLock(async () => {
    let needsFlag = null; // installNeedsFlag(), read once when an entry's end is found
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
        if (!e.confirmedAt && item && completedAtOnce(item) && (needsFlag ??= await installNeedsFlag())) e.refusalCandidate = true;
      }
      if (!e.fileGone && (e.refusalCandidate || undecided(e))) {
        const [item] = await chrome.downloads.search({ id: e.downloadId });
        e = e.refusalCandidate ? await judgeRefusal(e, item) : judgeVanished(e, copyGone(item), now);
      }
      const due = e.confirmedAt || failed || now - promptTime(e) >= PENDING_GRACE_MS;
      if (!e.fileGone && due) e = await deleteCopy(e);
      e = judgeVanished(e, !!e.foundGone, now);
      if (e.fileGone && e.refusalCandidate) e = { ...e, refusalCandidate: false }; // its copy outlived the prompt: not refused
      await storeInstall(e, now);
    }
    await deleteReleasedKeys(now);
    // Entries whose copy is gone only wait for a late install event: no sweep needed.
    if ((await listInstalls()).some((e) => !e.fileGone)) await armSweep();
  });
  await refreshBadge();
}

// Schedules the next sweepDownloads (the service worker runs it on SWEEP_ALARM);
// re-creating the alarm moves it, so at most one is pending.
function armSweep() {
  return chrome.alarms.create(SWEEP_ALARM, { delayInMinutes: PENDING_GRACE_MS / 60000 + 0.5 });
}

// Turns a .crx or .zip into an installable CRX after checking the archive.
// A CRX must pass signature verification (verifyCrx, with verifyOptions).
// Zips are signed with keyPkcs8. name: the file's name for errors.
// Returns { crx, extensionId, manifest, entries (the CRX's zip entries) }.
async function prepare(bytes, keyPkcs8, name, verifyOptions = {}) {
  if (isCrx(bytes)) {
    const extensionId = await verifyCrx(bytes, name, verifyOptions);
    const entries = parseZip(zipFromCrx(bytes));
    await verifyZip(entries);
    return { crx: bytes, extensionId, manifest: await readManifest(entries), entries };
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
// A CWS or update-URL record (no tag) installs the newest build its server
// announces (installSourceNow).
export const installRelease = operation(async (key, tag, onProgress = () => {}) => {
  const record = await getRepo(key);
  if (sourceOf(record) !== "github") {
    if (tag) throw new Error(`install ${key}: not a GitHub repo, so there is no release ${tag}`);
    return installSourceNow(key, onProgress);
  }
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

// Installs the newest build of a CWS or update-URL record: checks again
// (CRX URLs are version-specific), downloads the announced codebase, checks
// its size and SHA-256 against the announcement, verifies the CRX (for the
// CWS also Google's publisher proof), its ID (the record's) and its version
// (the announced one), then hands it to the browser. Returns { extensionId, version, name }.
async function installSourceNow(key, onProgress) {
  const what = `install ${key}`;
  const error = (await checkSourcesNow([await getRepo(key)])).get(key);
  if (error) throw new Error(`${what}: ${error}`);
  const record = await getRepo(key);
  const cws = record.source === "cws";
  if (record.unavailable) {
    throw new Error(`${what}: ${cws ? "the Chrome Web Store" : new URL(record.updateUrl).host} offers no build of this extension to this browser`);
  }
  const latest = record.latest;
  if (!latest.codebase) throw new Error(`${what}: the update server offers nothing newer than the installed version ${latest.version}`);
  const missing = await missingOriginsOf([originOf(latest.codebase)]);
  if (missing.length) throw new Error(`${what}: no host permission for ${missing.join(", ")}`);
  onProgress(`Downloading ${record.name || record.id} ${latest.version}…`);
  let bytes;
  try {
    bytes = new Uint8Array(await (await fetchFrom(latest.codebase)).arrayBuffer());
  } catch (e) {
    await rememberOrigins(key, e.neededOrigins || []);
    throw new Error(`download ${key} ${latest.version}: ${e.message}`);
  }
  if (latest.size !== null && bytes.length !== latest.size) {
    throw new Error(`${what}: downloaded ${bytes.length} bytes, the update server announced ${latest.size}`);
  }
  const digest = await sha256Hex(bytes);
  if (latest.hash !== null && digest !== latest.hash) {
    throw new Error(`${what}: the download's sha256 ${digest} does not match the announced ${latest.hash}`);
  }
  if (!isCrx(bytes)) throw new Error(`${what}: the download from ${new URL(latest.codebase).host} is not a CRX file`);
  onProgress("Checking CRX…");
  const { crx, extensionId, manifest, entries } = await prepare(bytes, null, `${key} ${latest.version}`, { publisherProof: cws });
  if (extensionId !== record.id) throw new Error(`${what}: the CRX installs as extension ${extensionId}, not as ${record.id}`);
  if (manifest.version !== latest.version) {
    throw new Error(`${what}: the CRX holds version ${JSON.stringify(manifest.version)}, the update server announced ${latest.version}`);
  }
  const name = (await manifestName(manifest, entries)) || record.name || record.id;
  await patchRepo(key, { name });
  onProgress("Handing the CRX to the browser…");
  await handOff(crx, {
    repoKey: key, extensionId, manifest: { ...manifest, name },
    installed: { tag: null, digest: `sha256:${digest}`, version: manifest.version },
  });
  return { extensionId, version: manifest.version, name };
}

// Starts tracking an installed extension through its own update server:
// a "cws" record when its update URL is the CWS, an "updateUrl" record for
// another https update URL (Extainium itself included). Assumes the UI was
// granted installedOverview's needsOrigins (else the first check fails and
// nothing is added). Returns the record's key.
export const trackInstalled = operation(async (id) => {
  const ext = (await installedExtensions()).get(id);
  if (!ext) throw new Error(`track ${id}: no installed extension has this ID`);
  const kind = installedKind(ext, null);
  const canTrack = canTrackOf(ext, kind);
  if (canTrack === "cws") return addSourceRecordNow(newSourceRecord("cws", id, { name: ext.name }), `track ${id}`);
  if (canTrack === "updateUrl") {
    return addSourceRecordNow(newSourceRecord("updateUrl", id, { updateUrl: ext.updateUrl, name: ext.name }), `track ${id}`);
  }
  const why = kind === "browser" ? "the browser provides it"
    : kind === "unmanaged" ? "it has no update URL; link it to a GitHub repo instead"
      : `its update URL is not https: ${JSON.stringify(ext.updateUrl)}`;
  throw new Error(`track ${id}: ${ext.name} cannot be tracked through its own update server: ${why}`);
});

// Starts tracking GitHub repo text (owner/repo or a GitHub URL) for an
// installed extension without an update URL ("unmanaged"), linked to its ID.
// Identity rules as for any GitHub record: an asset that installs as another
// ID leads to an identity change once an asset is chosen. Returns the key.
export const linkInstalledToGithub = operation(async (id, text) => {
  const parsed = parseSourceInput(text);
  if (parsed.source !== "github") throw new Error(`link ${id}: not a GitHub repository: "${String(text).trim()}"`);
  const { owner, repo } = parsed;
  const key = repoKey({ owner, repo });
  const what = `link ${id} to ${key}`;
  const ext = (await installedExtensions()).get(id);
  if (!ext) throw new Error(`${what}: no installed extension has this ID`);
  const kind = installedKind(ext, null);
  if (kind !== "unmanaged") {
    throw new Error(`${what}: ${ext.name} ${kind === "browser" ? "is provided by the browser" : `updates from its own update URL ${ext.updateUrl}; track it instead`}`);
  }
  return addSourceRecordNow({ ...newRecord(owner, repo), extensionId: id }, what);
});

// Runs when this extension starts (runtime.onInstalled, onStartup): an
// install of Extainium itself that Extainium handed to the browser is
// confirmed by the new instance, as the old one was replaced before
// management.onInstalled could reach it. Confirms the pending entry for the
// running version (handleExtensionInstalled). Returns true when one waited.
export async function confirmOwnInstall() {
  await ready();
  const id = chrome.runtime.id;
  const { version } = chrome.runtime.getManifest();
  const waiting = (await listInstalls()).some((e) => e.extensionId === id && !e.confirmedAt && e.installed && e.installed.version === version);
  if (waiting) await handleExtensionInstalled({ id, version });
  return waiting;
}

// ---- Extainium itself ----

// Storage key: set when the user removed Extainium's own record (removeRepo),
// however it was created; trackSelf never tracks it again after that.
const SELF_OPT_OUT = "selfOptOut";

// On desktop browsers other than Titanium (installNeedsFlag), nothing updates
// Extainium by itself, so it follows its own https update_url, as
// trackInstalled would: runs at every start, unless the user ever removed
// Extainium's record (SELF_OPT_OUT) or it is tracked already. A first check
// that fails throws (its record is removed unless it waits for host access)
// and is tried again at the next start. On Titanium the browser's own updater
// updates it. Returns the new record's key, or null.
export const trackSelf = operation(async () => {
  if ((await chrome.storage.local.get(SELF_OPT_OUT))[SELF_OPT_OUT]) return null;
  if (!(await installNeedsFlag())) return null;
  const id = chrome.runtime.id;
  if ((await listRepos()).some((r) => r.extensionId === id)) return null;
  const ext = (await installedExtensions()).get(id);
  if (!ext || canTrackOf(ext, installedKind(ext, null)) !== "updateUrl") return null;
  return addSourceRecordNow(newSourceRecord("updateUrl", id, { updateUrl: ext.updateUrl, name: ext.name }), `track ${id}`);
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
// sweepDownloads); until then it stays, and is exported. Removing Extainium's
// own record opts out of trackSelf for good.
export const removeRepo = operation(async (key, uninstall) => {
  const record = await getRepo(key);
  if (uninstall && record.extensionId && (await installedExtensions()).has(record.extensionId)) {
    await chrome.management.uninstall(record.extensionId, { showConfirmDialog: true });
  }
  await withStateLock(async () => {
    await removeRepoRecord(key);
    // Extainium's own record, however created: the user opted out of trackSelf.
    if (record.extensionId === chrome.runtime.id) await chrome.storage.local.set({ [SELF_OPT_OUT]: Date.now() });
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
// pre-release setting. One record follows an extension ID (as in
// addSourceRecordNow): a backup record of an ID that an existing or earlier
// imported record follows is skipped with a warning. Which records are
// imported is decided first, before any key moves. A key lives in one place:
// a backup key that is already another repo's key is not imported (a warning
// says so), a stored file key that the backup brings as the key of an
// imported repo moves to that repo, and backup file keys are added unless the
// key is a stored repo key. The key of a skipped record stays where it is; one
// stored nowhere becomes the file key of its extension, so it stays usable.
// Returns { count (records imported), errors, conflicts: [{ key, keptId, backupId }], warnings }.
export const importBackup = operation(async (text) => {
  const { repos, keys, fileKeys, warnings } = await parseBackup(text);
  const conflicts = [];
  let count = 0;
  await withStateLock(async () => {
    // A stored key that differs from the backup's decides the repo's ID.
    const keptIds = new Map();
    for (const [k, b64] of Object.entries(keys)) {
      const stored = await getSigningKey(k);
      if (stored && stored !== b64) keptIds.set(k, { keptId: await idOfKey(stored), backupId: await idOfKey(b64) });
    }
    // The records to write (by key), and the keys of the backup records skipped.
    const existing = new Map((await listRepos()).map((r) => [repoKey(r), r]));
    const writes = new Map();
    const skipped = new Set();
    for (const rec of repos) {
      const k = repoKey(rec);
      const current = existing.get(k) || null;
      let next;
      if (sourceOf(rec) !== "github") {
        if (current) {
          count++; // a tracked one keeps its state
          continue;
        }
        next = rec;
      } else {
        const kept = keptIds.get(k);
        const base = current || { ...rec, extensionId: null, installed: null };
        next = {
          ...base,
          template: rec.template,
          includePrereleases: rec.includePrereleases,
          extensionId: base.extensionId ?? (kept ? kept.keptId : rec.extensionId),
          installed: base.installed ?? (kept ? null : rec.installed),
        };
      }
      const records = new Map([...existing, ...writes]);
      const other = next.extensionId && [...records.values()].find((r) => r.extensionId === next.extensionId && repoKey(r) !== k);
      if (other) {
        warnings.push(`${k}: extension ${next.extensionId} is already tracked as ${repoKey(other)}; ${k} was not imported`);
        skipped.add(k);
        continue;
      }
      writes.set(k, next);
      count++;
    }
    for (const [k, b64] of Object.entries(keys)) {
      if (skipped.has(k) && !writes.has(k)) {
        const stored = [...Object.values(await listSigningKeys()), ...Object.values(await listFileKeys())];
        if (stored.includes(b64)) continue; // stays where it is
        const id = await idOfKey(b64);
        if ((await putFileKeyIfAbsent(id, b64)) !== b64) warnings.push(`${k}: extension ${id} already has another file key; the backup's key of ${k} was not imported`);
        continue;
      }
      const owner = Object.entries(await listSigningKeys()).find(([o, v]) => v === b64 && o !== k);
      if (owner) {
        warnings.push(`${k}: the backup's signing key is already the key of ${owner[0]}; it was not imported for ${k}`);
        continue;
      }
      const kept = await putSigningKeyIfAbsent(k, b64);
      if (kept !== b64) conflicts.push({ key: k, ...keptIds.get(k) });
    }
    const repoKeys = new Set(Object.values(await listSigningKeys()));
    for (const [id, b64] of Object.entries(await listFileKeys())) if (repoKeys.has(b64)) await removeFileKey(id);
    for (const [id, b64] of Object.entries(fileKeys)) if (!repoKeys.has(b64)) await putFileKeyIfAbsent(id, b64);
    for (const next of writes.values()) await putRepo(next);
  });
  // The backup has no release cache; fetch it so the list shows versions again.
  const { errors } = await checkAllNow();
  return { count, errors, conflicts, warnings };
});
