// Extension state in chrome.storage.local:
//   "repo:owner/name"  tracked repo record (see newRecord)
//   "repo:cws:<id>", "repo:url:<id>"  tracked extension of the Chrome Web
//                      Store or of a self-hosted update URL (newSourceRecord)
//   "installBlocked"   { at, hint: "flag" }: a desktop install the browser
//                      refused (manager.js environment)
//   "installWorkedAt"  time of the last confirmed install; an older refusal
//                      candidate cannot set installBlocked (manager.js judgeRefusal)
//   "lastCheck"        { at, updates } of the last checkAll (older ones also
//                      hold errors, no longer read)
//   "key:owner/name"   base64 PKCS#8 RSA signing key for zip assets; written
//                      once, kept when the repo is no longer tracked (retained
//                      key), deleted only together with an uninstall
//   "keydelete:owner/name"  { at }: the repo's key is deleted once no pending
//                      install signed with it remains (removeRepo with uninstall)
//   "filekey:<extension ID>"  base64 PKCS#8 key of a zip installed from a file
//                      without a repo; written once, moved to "key:" when tracked
//   "install:<token>"  a CRX handed to the browser, until its install is
//                      confirmed and its downloaded copy deleted (manager.js)
//   "settings"         { githubToken, theme, observedScheme }
//   "schema"           storage format version (SCHEMA)
// Every read-modify-write runs inside withStateLock, a Web Lock shared by the
// service worker and the extension pages, so no write is based on a stale read.
// Every user or background operation that changes state (manager.js) runs as a
// whole inside withOpLock, a second Web Lock, so operations never interleave.

import { base64Decode, extensionIdFromSpki, importSigningKey } from "./crx.js";
import { deriveTemplate, parseRepo, validateTemplate, VERSION_TOKEN } from "./releases.js";

export const REPO_PREFIX = "repo:";
export const KEY_PREFIX = "key:";
export const INSTALL_PREFIX = "install:";
export const KEY_DELETE_PREFIX = "keydelete:";
export const FILE_KEY_PREFIX = "filekey:";
export const SCHEMA = 2;
export const BACKUP_FORMAT = "extainium-backup";
export const BACKUP_VERSION = 4;
const LOCK_NAME = "extainium-state";
const OP_LOCK_NAME = "extainium-op";

// The key of a record: "owner/name" (lowercase) for GitHub records (no
// source field, or source "github"), "cws:<id>" and "url:<id>" for the others.
// GitHub names never hold ":", so the kinds never collide.
export const repoKey = (r) => (r.source === "cws" ? `cws:${r.id}` : r.source === "updateUrl" ? `url:${r.id}` : `${r.owner}/${r.repo}`.toLowerCase());
export const sourceOf = (r) => r.source || "github";

// Runs fn() while holding the state lock in this browser profile.
export function withStateLock(fn) {
  return navigator.locks.request(LOCK_NAME, () => fn());
}

// Runs fn() while holding the operation lock in this browser profile: one
// operation at a time across the service worker and the extension pages. The
// browser releases the lock when the context holding it goes away. Not
// re-entrant: code inside an operation calls other operations' internals,
// never withOpLock again (that would wait for itself). When another operation
// holds the lock, onWait() is called before waiting; a function it returns is
// called once the lock is granted.
export async function withOpLock(fn, onWait = null) {
  let ran = false;
  const result = await navigator.locks.request(OP_LOCK_NAME, { ifAvailable: true }, (lock) => {
    if (!lock) return null;
    ran = true;
    return fn();
  });
  if (ran) return result;
  const granted = onWait ? onWait() : null;
  return navigator.locks.request(OP_LOCK_NAME, () => {
    if (typeof granted === "function") granted();
    return fn();
  });
}

// Record: { owner, repo, template, includePrereleases, extensionId,
//   installed: { tag, digest, version } | null  (confirmed by management.onInstalled),
//   identityChange: { from, to, tag, asset } | null  (relink waiting for confirmation),
//   releases, pages, feed, checkedCriteria, fullCheckAt, checkedAt, error, addedAt }
// releases and pages are the release cache of the last full check (API, at
// fullCheckAt); feed ({ entries: [[id, updated], ...] }: every releases.atom
// entry it saw, or null; records of older versions hold { newest } and get a
// full check) and checkedCriteria ({ template, includePrereleases } it used)
// decide whether the next check needs the API.
export function newRecord(owner, repo) {
  return {
    owner,
    repo,
    template: null,
    includePrereleases: false,
    extensionId: null,
    installed: null,
    identityChange: null,
    releases: null,
    pages: null,
    feed: null,
    checkedCriteria: null,
    fullCheckAt: null,
    checkedAt: null,
    error: null,
    addedAt: Date.now(),
  };
}

// Record of an extension tracked through its own update server, the CWS
// (source "cws") or the manifest's update_url (source "updateUrl"):
// { source, id, extensionId (= id), updateUrl (updateUrl only), name (best
//   known name, from management or the CRX manifest, or null),
//   installed: { tag: null, digest, version } | null  (confirmed installs),
//   latest: { version, codebase, size, hash } | null  (last check's newest
//   build; size and hash null when the server announced none; codebase null
//   when a self-hosted server answered "noupdate" for the installed version),
//   unavailable: { malware } | null  (the server offers no build to this browser),
//   redirectOrigins: [origin pattern]  (the origins the last fetch's redirect
//     lacked a host permission for, [] after a fetch that answered; absent in
//     older records; not in backups),
//   identityChange: null, checkedAt, error, addedAt }
export function newSourceRecord(source, id, { updateUrl = null, name = null, installed = null, addedAt = Date.now() } = {}) {
  return {
    source,
    id,
    extensionId: id,
    ...(source === "updateUrl" ? { updateUrl } : {}),
    name,
    installed,
    latest: null,
    unavailable: null,
    redirectOrigins: [],
    identityChange: null,
    checkedAt: null,
    error: null,
    addedAt,
  };
}

async function byPrefix(prefix) {
  const all = await chrome.storage.local.get(null);
  return Object.entries(all).filter(([k]) => k.startsWith(prefix));
}

// Reads; safe without the lock.

export async function listRepos() {
  return (await byPrefix(REPO_PREFIX)).map(([, v]) => v).sort((a, b) => repoKey(a).localeCompare(repoKey(b)));
}

export async function findRepo(key) {
  const k = REPO_PREFIX + key;
  return (await chrome.storage.local.get(k))[k] || null;
}

export async function getRepo(key) {
  const record = await findRepo(key);
  if (!record) throw new Error(`get tracked repo: "${key}" is not tracked`);
  return record;
}

export async function getSigningKey(key) {
  const k = KEY_PREFIX + key;
  return (await chrome.storage.local.get(k))[k] || null;
}

// { "owner/name": base64 PKCS#8 } of every stored key, tracked or retained.
export async function listSigningKeys() {
  return Object.fromEntries((await byPrefix(KEY_PREFIX)).map(([k, v]) => [k.slice(KEY_PREFIX.length), v]));
}

export async function listInstalls() {
  return (await byPrefix(INSTALL_PREFIX)).map(([, v]) => v);
}

// Repo keys whose signing key waits for deletion.
export async function listKeyDeletions() {
  return (await byPrefix(KEY_DELETE_PREFIX)).map(([k]) => k.slice(KEY_DELETE_PREFIX.length));
}

export async function getFileKey(extensionId) {
  const k = FILE_KEY_PREFIX + extensionId;
  return (await chrome.storage.local.get(k))[k] || null;
}

// { "<extension ID>": base64 PKCS#8 } of every file key.
export async function listFileKeys() {
  return Object.fromEntries((await byPrefix(FILE_KEY_PREFIX)).map(([k, v]) => [k.slice(FILE_KEY_PREFIX.length), v]));
}

// Writes; call only inside withStateLock.

export function putRepo(record) {
  return chrome.storage.local.set({ [REPO_PREFIX + repoKey(record)]: record });
}

export function removeRepoRecord(key) {
  return chrome.storage.local.remove(REPO_PREFIX + key);
}

// Writes key unless one is stored. Returns the stored key (which wins on a conflict).
export async function putSigningKeyIfAbsent(key, pkcs8) {
  const current = await getSigningKey(key);
  if (current) return current;
  await chrome.storage.local.set({ [KEY_PREFIX + key]: pkcs8 });
  return pkcs8;
}

export function removeSigningKey(key) {
  return chrome.storage.local.remove(KEY_PREFIX + key);
}

export function markKeyForDeletion(key) {
  return chrome.storage.local.set({ [KEY_DELETE_PREFIX + key]: { at: Date.now() } });
}

export function removeKeyDeletion(key) {
  return chrome.storage.local.remove(KEY_DELETE_PREFIX + key);
}

// Writes a file key unless one is stored for the ID. Returns the stored key.
export async function putFileKeyIfAbsent(extensionId, pkcs8) {
  const current = await getFileKey(extensionId);
  if (current) return current;
  await chrome.storage.local.set({ [FILE_KEY_PREFIX + extensionId]: pkcs8 });
  return pkcs8;
}

export function removeFileKey(extensionId) {
  return chrome.storage.local.remove(FILE_KEY_PREFIX + extensionId);
}

export function putInstall(entry) {
  return chrome.storage.local.set({ [INSTALL_PREFIX + entry.token]: entry });
}

export function removeInstall(token) {
  return chrome.storage.local.remove(INSTALL_PREFIX + token);
}

// Locked conveniences.

// Applies fn(record) -> record to a tracked repo atomically. Returns the result.
export function updateRepo(key, fn) {
  return withStateLock(async () => {
    const next = fn(await getRepo(key));
    await putRepo(next);
    return next;
  });
}

export function patchRepo(key, patch) {
  return updateRepo(key, (r) => ({ ...r, ...patch }));
}

// theme: "system" | "light" | "dark", the colour scheme the UI uses.
// observedScheme: "light" | "dark" | null, what prefers-color-scheme reported
// in the options page (a tab); the popup, whose own report can differ, uses it
// while theme is "system".
export async function getSettings() {
  const { settings } = await chrome.storage.local.get("settings");
  return { githubToken: "", theme: "system", observedScheme: null, ...settings };
}

export function setSettings(patch) {
  return withStateLock(async () => {
    await chrome.storage.local.set({ settings: { ...(await getSettings()), ...patch } });
  });
}

export const THEMES = ["system", "light", "dark"];
const SCHEMES = ["light", "dark"];

// { theme, observedScheme, scheme }: scheme is the scheme to show, "light" or
// "dark", or null when theme is "system" and no scheme was observed yet.
export async function getTheme() {
  const { theme, observedScheme } = await getSettings();
  return { theme, observedScheme, scheme: theme === "system" ? observedScheme : theme };
}

export async function setTheme(theme) {
  if (!THEMES.includes(theme)) throw new Error(`set theme: not one of ${THEMES.join(", ")}: ${JSON.stringify(theme)}`);
  return setSettings({ theme });
}

// Records the scheme a tab's matchMedia reports. Writes only on a change, so
// pages that re-render on storage changes are not woken on every load.
export async function recordObservedScheme(scheme) {
  if (!SCHEMES.includes(scheme)) throw new Error(`record observed scheme: not light or dark: ${JSON.stringify(scheme)}`);
  if ((await getSettings()).observedScheme === scheme) return false;
  await setSettings({ observedScheme: scheme });
  return true;
}

// ---- Stored format 0.1 (no schema key) -> SCHEMA 2 ----

// The version sub-pattern of Extainium 0.1's derivePattern (commit 1cd36e3).
const OLD_VERSION_PATTERN = "\\d+(?:\\.\\d+)*(?:-?(?:alpha|beta|pre|rc|a|b)\\.?\\d+)?";
const REGEX_SPECIAL = ".*+?^${}()|[]\\";

// Converts a 0.1 regex pattern to a template when it is literal text,
// derivePattern's version part ("<VER>" as written in notes), ".*" wildcards
// and optional anchors. Returns null for anything else; never compiles it.
export function patternToTemplate(pattern) {
  if (typeof pattern !== "string") return null;
  let body = pattern;
  const anchoredStart = body.startsWith("^");
  if (anchoredStart) body = body.slice(1);
  const anchoredEnd = body.endsWith("$") && !body.endsWith("\\$");
  if (anchoredEnd) body = body.slice(0, -1);
  let out = anchoredStart ? "" : "*";
  for (let i = 0; i < body.length; ) {
    if (body.startsWith(OLD_VERSION_PATTERN, i)) {
      out += VERSION_TOKEN;
      i += OLD_VERSION_PATTERN.length;
    } else if (body.startsWith("<VER>", i)) {
      out += VERSION_TOKEN;
      i += 5;
    } else if (body.startsWith(".*", i)) {
      out += "*";
      i += 2;
    } else if (body[i] === "\\") {
      const c = body[i + 1];
      if (c === undefined || !REGEX_SPECIAL.includes(c) || c === "*" || c === "{" || c === "}") return null;
      out += c;
      i += 2;
    } else if (REGEX_SPECIAL.includes(body[i])) {
      return null;
    } else {
      out += body[i++];
    }
  }
  if (!anchoredEnd) out += "*";
  try {
    return validateTemplate(out.replace(/\*+/g, "*"));
  } catch {
    return null;
  }
}

const CONVERT_HINT = "choose the asset again";

// Template for a stored or imported 0.1 record: converted from its pattern, or
// derived from the asset it installed (found by digest in its release cache).
function templateFromOld(record) {
  if (record.pattern == null) return { template: null, error: null };
  const converted = patternToTemplate(record.pattern);
  if (converted) return { template: converted, error: null };
  const digest = record.installed && record.installed.digest;
  for (const rel of Array.isArray(record.releases) ? record.releases : []) {
    const asset = digest && (rel.assets || []).find((a) => a.digest === digest);
    if (!asset) continue;
    // A name that gives no valid template (e.g. over the length limit) leaves
    // this record to be chosen again; it must not stop the migration.
    try {
      return { template: deriveTemplate(asset.name, rel.tag), error: null };
    } catch {
      break;
    }
  }
  return {
    template: null,
    error: `The asset pattern ${JSON.stringify(record.pattern)} could not be converted to a file name template; ${CONVERT_HINT}.`,
  };
}

// Brings stored state to SCHEMA. Idempotent; runs under the lock.
export function migrateStorage() {
  return withStateLock(async () => {
    const all = await chrome.storage.local.get(null);
    if (all.schema === SCHEMA) return false;
    if (all.schema !== undefined) throw new Error(`migrate storage: unknown schema ${JSON.stringify(all.schema)}`);
    const writes = {};
    const removes = ["pendingDownloads"];
    for (const [k, old] of Object.entries(all)) {
      if (!k.startsWith(REPO_PREFIX)) continue;
      const { pattern, keyPkcs8, etag, ...rest } = old;
      const { template, error } = templateFromOld(old);
      if (keyPkcs8 && !all[KEY_PREFIX + repoKey(old)]) writes[KEY_PREFIX + repoKey(old)] = keyPkcs8;
      writes[k] = { ...newRecord(old.owner, old.repo), ...rest, template, identityChange: null, pages: null, error: error || rest.error || null };
    }
    // 0.1 tracked CRX copies as { [downloadId]: { extensionId, at } }.
    for (const [downloadId, e] of Object.entries(all.pendingDownloads || {})) {
      const token = `migrated-${downloadId}`;
      writes[INSTALL_PREFIX + token] = {
        token, repoKey: null, extensionId: e.extensionId, version: null, installed: null,
        downloadId: Number(downloadId), downloadDone: true, at: e.at, confirmedAt: null, fileGone: false, removeError: null,
      };
    }
    writes.schema = SCHEMA;
    await chrome.storage.local.set(writes);
    await chrome.storage.local.remove(removes);
    return true;
  });
}

// ---- Backups ----

// Backup of the configuration (no release caches), every repo signing key,
// retained ones included, and the file keys ({ "<extension ID>": pkcs8 }).
// Version 4 adds sources: the CWS and update-URL records
// [{ source, id, updateUrl (updateUrl only), name, installed, addedAt }].
export function makeBackup(records, keys, now = new Date(), fileKeys = {}) {
  return {
    format: BACKUP_FORMAT,
    version: BACKUP_VERSION,
    exportedAt: now.toISOString(),
    repos: records.filter((r) => sourceOf(r) === "github").map((r) => ({
      owner: r.owner,
      repo: r.repo,
      template: r.template,
      includePrereleases: r.includePrereleases,
      extensionId: r.extensionId,
      installed: r.installed,
      addedAt: r.addedAt,
    })),
    sources: records.filter((r) => sourceOf(r) !== "github").map((r) => ({
      source: r.source,
      id: r.id,
      ...(r.source === "updateUrl" ? { updateUrl: r.updateUrl } : {}),
      name: r.name,
      installed: r.installed,
      addedAt: r.addedAt,
    })),
    keys,
    fileKeys,
  };
}

const ID_RE = /^[a-p]{32}$/;
const DIGEST_RE = /^sha256:[0-9a-f]{64}$/;
const BASE64_RE = /^[A-Za-z0-9+/]+={0,2}$/;
const show = (v) => (JSON.stringify(v) ?? String(v)).slice(0, 80);

async function checkKey(where, b64) {
  if (typeof b64 !== "string" || !BASE64_RE.test(b64)) throw new Error(`${where}: key is not base64: ${show(b64)}`);
  const { spki } = await importSigningKey(base64Decode(b64)).catch((e) => {
    throw new Error(`${where}: key does not import (${e.message})`);
  });
  return extensionIdFromSpki(spki);
}

// installed of a backup record: null/absent or { tag, digest, version }. Throws naming where.
function checkInstalled(where, inst) {
  if (inst === null || inst === undefined) return null;
  const ok = typeof inst === "object" && !Array.isArray(inst)
    && (inst.tag === null || typeof inst.tag === "string")
    && (inst.digest === null || (typeof inst.digest === "string" && DIGEST_RE.test(inst.digest)))
    && typeof inst.version === "string" && inst.version.length <= 64;
  if (!ok) throw new Error(`${where}: installed is not null or { tag, digest, version }: ${show(inst)}`);
  return { tag: inst.tag, digest: inst.digest, version: inst.version };
}

// The CWS and update-URL records of a version 4 backup, as records.
function parseSources(list, seen) {
  if (!Array.isArray(list)) throw new Error("import backup: sources is not a list");
  return list.map((s, i) => {
    let where = `import backup: sources #${i + 1}`;
    if (!s || typeof s !== "object" || Array.isArray(s)) throw new Error(`${where}: not an object: ${show(s)}`);
    if (s.source !== "cws" && s.source !== "updateUrl") throw new Error(`${where}: source is not "cws" or "updateUrl": ${show(s.source)}`);
    if (typeof s.id !== "string" || !ID_RE.test(s.id)) throw new Error(`${where}: id is not 32 letters a-p: ${show(s.id)}`);
    const key = repoKey(s);
    where += ` (${key})`;
    if (seen.has(key)) throw new Error(`${where}: listed twice`);
    seen.add(key);
    let updateUrl = null;
    if (s.source === "updateUrl") {
      let u = null;
      try {
        u = typeof s.updateUrl === "string" && s.updateUrl.length <= 2048 ? new URL(s.updateUrl) : null;
      } catch {
        u = null;
      }
      if (!u || u.protocol !== "https:") throw new Error(`${where}: updateUrl is not an https URL: ${show(s.updateUrl)}`);
      updateUrl = s.updateUrl;
    }
    if (s.name !== null && s.name !== undefined && !(typeof s.name === "string" && s.name.length <= 200)) {
      throw new Error(`${where}: name is not null or a text of at most 200 characters: ${show(s.name)}`);
    }
    if (s.addedAt !== undefined && !Number.isFinite(s.addedAt)) throw new Error(`${where}: addedAt is not a number: ${show(s.addedAt)}`);
    return newSourceRecord(s.source, s.id, {
      updateUrl, name: s.name ?? null, installed: checkInstalled(where, s.installed), addedAt: s.addedAt ?? Date.now(),
    });
  });
}

// Validates a backup (format 1, 2, 3 or 4) against the full schema and returns
// { repos: [records without caches, GitHub and (version 4) the other sources],
//   keys: { "owner/name": pkcs8 }, fileKeys: { "<extension ID>": pkcs8 }, warnings: [] }.
// Version 3 adds fileKeys; each must derive the ID it is filed under.
// Version 4 adds sources (makeBackup).
// Throws "import backup: ..." naming the entry, field and value on the first problem.
export async function parseBackup(text) {
  let data;
  try {
    data = JSON.parse(text);
  } catch (e) {
    throw new Error(`import backup: not JSON (${e.message})`);
  }
  if (!data || typeof data !== "object" || data.format !== BACKUP_FORMAT || ![1, 2, 3, 4].includes(data.version)) {
    throw new Error(`import backup: not an ${BACKUP_FORMAT} version 1, 2, 3 or 4 file`);
  }
  if (!Array.isArray(data.repos)) throw new Error("import backup: repos is not a list");
  const keys = {};
  const fileKeys = {};
  const warnings = [];
  if (data.version >= 3) {
    if (!data.fileKeys || typeof data.fileKeys !== "object" || Array.isArray(data.fileKeys)) throw new Error("import backup: fileKeys is not an object");
    for (const [id, b64] of Object.entries(data.fileKeys)) {
      const derived = await checkKey(`import backup: fileKeys["${id}"]`, b64);
      if (derived !== id) throw new Error(`import backup: fileKeys["${id}"]: the key is the key of extension ${derived}`);
      fileKeys[id] = b64;
    }
  }
  if (data.version >= 2) {
    if (!data.keys || typeof data.keys !== "object" || Array.isArray(data.keys)) throw new Error("import backup: keys is not an object");
    for (const [k, b64] of Object.entries(data.keys)) {
      const [owner, repo] = k.split("/");
      try {
        if (repoKey(parseRepo(`${owner}/${repo}`)) !== k) throw new Error("not lowercase owner/repo");
      } catch {
        throw new Error(`import backup: keys: invalid repo name ${show(k)}`);
      }
      await checkKey(`import backup: keys["${k}"]`, b64);
      keys[k] = b64;
    }
  }
  const repos = [];
  const seen = new Set();
  for (const [i, r] of data.repos.entries()) {
    let where = `import backup: repo #${i + 1}`;
    if (!r || typeof r !== "object" || Array.isArray(r)) throw new Error(`${where}: not an object: ${show(r)}`);
    for (const f of ["owner", "repo"]) {
      if (typeof r[f] !== "string" || !/^[A-Za-z0-9_.-]+$/.test(r[f])) throw new Error(`${where}: ${f} is not a GitHub name: ${show(r[f])}`);
    }
    const key = repoKey(r);
    where += ` (${key})`;
    if (seen.has(key)) throw new Error(`${where}: listed twice`);
    seen.add(key);
    if (typeof r.includePrereleases !== "boolean") throw new Error(`${where}: includePrereleases is not true/false: ${show(r.includePrereleases)}`);
    if (r.extensionId !== null && !(typeof r.extensionId === "string" && ID_RE.test(r.extensionId))) {
      throw new Error(`${where}: extensionId is not null or 32 letters a-p: ${show(r.extensionId)}`);
    }
    const installed = checkInstalled(where, r.installed);
    if (r.addedAt !== undefined && !Number.isFinite(r.addedAt)) throw new Error(`${where}: addedAt is not a number: ${show(r.addedAt)}`);
    let template;
    if (data.version >= 2) {
      template = r.template;
      if (template !== null) {
        try {
          validateTemplate(template);
        } catch (e) {
          throw new Error(`${where}: template: ${e.message}`);
        }
      }
    } else {
      if (r.pattern !== null && r.pattern !== undefined && typeof r.pattern !== "string") throw new Error(`${where}: pattern is not a string: ${show(r.pattern)}`);
      template = r.pattern == null ? null : patternToTemplate(r.pattern);
      if (r.pattern != null && !template) warnings.push(`${key}: the asset pattern ${show(r.pattern)} could not be converted; ${CONVERT_HINT}`);
      if (r.keyPkcs8 !== null && r.keyPkcs8 !== undefined) {
        if (typeof r.keyPkcs8 !== "string") throw new Error(`${where}: keyPkcs8 is not a string: ${show(r.keyPkcs8)}`);
        await checkKey(`${where}: keyPkcs8`, r.keyPkcs8);
        keys[key] = r.keyPkcs8;
      }
    }
    repos.push({
      ...newRecord(r.owner, r.repo),
      template,
      includePrereleases: r.includePrereleases,
      extensionId: r.extensionId,
      installed,
      addedAt: r.addedAt ?? Date.now(),
    });
  }
  if (data.version >= 4) repos.push(...parseSources(data.sources, seen));
  // A key need not derive the repo's extension ID: a retained zip key stays
  // after an explicit switch to the author's CRX. A pairing that does not fit
  // the installed extension ends in an identity change at the next link.
  return { repos, keys, fileKeys, warnings };
}
