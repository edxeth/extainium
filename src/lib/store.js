// Extension state in chrome.storage.local:
//   "repo:owner/name"  tracked repo record (see newRecord)
//   "key:owner/name"   base64 PKCS#8 RSA signing key for zip assets; written
//                      once, kept when the repo is no longer tracked (retained
//                      key), deleted only together with an uninstall
//   "install:<token>"  a CRX handed to the browser, until its install is
//                      confirmed and its downloaded copy deleted (manager.js)
//   "schema"           storage format version (SCHEMA)
// Every read-modify-write runs inside withStateLock, a Web Lock shared by the
// service worker and the extension pages, so no write is based on a stale read.

import { base64Decode, extensionIdFromSpki, importSigningKey } from "./crx.js";
import { deriveTemplate, parseRepo, validateTemplate, VERSION_TOKEN } from "./releases.js";

export const REPO_PREFIX = "repo:";
export const KEY_PREFIX = "key:";
export const INSTALL_PREFIX = "install:";
export const SCHEMA = 2;
export const BACKUP_FORMAT = "extainium-backup";
export const BACKUP_VERSION = 2;
const LOCK_NAME = "extainium-state";

export const repoKey = (r) => `${r.owner}/${r.repo}`.toLowerCase();

// Runs fn() while holding the state lock in this browser profile.
export function withStateLock(fn) {
  return navigator.locks.request(LOCK_NAME, () => fn());
}

// Record: { owner, repo, template, includePrereleases, extensionId,
//   installed: { tag, digest, version } | null  (confirmed by management.onInstalled),
//   identityChange: { from, to, tag, asset } | null  (relink waiting for confirmation),
//   releases, pages, checkedAt, error, addedAt }
// releases and pages are the release cache of the last check.
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
    checkedAt: null,
    error: null,
    addedAt: Date.now(),
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

export async function getSettings() {
  const { settings } = await chrome.storage.local.get("settings");
  return { githubToken: "", ...settings };
}

export function setSettings(patch) {
  return withStateLock(async () => {
    await chrome.storage.local.set({ settings: { ...(await getSettings()), ...patch } });
  });
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
    if (asset) return { template: deriveTemplate(asset.name, rel.tag), error: null };
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

// Backup of the configuration (no release caches) and every signing key, retained ones included.
export function makeBackup(records, keys, now = new Date()) {
  return {
    format: BACKUP_FORMAT,
    version: BACKUP_VERSION,
    exportedAt: now.toISOString(),
    repos: records.map((r) => ({
      owner: r.owner,
      repo: r.repo,
      template: r.template,
      includePrereleases: r.includePrereleases,
      extensionId: r.extensionId,
      installed: r.installed,
      addedAt: r.addedAt,
    })),
    keys,
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

// Validates a backup (format 1 or 2) against the full schema and returns
// { repos: [records without caches], keys: { "owner/name": pkcs8 }, warnings: [] }.
// Throws "import backup: ..." naming the entry, field and value on the first problem.
export async function parseBackup(text) {
  let data;
  try {
    data = JSON.parse(text);
  } catch (e) {
    throw new Error(`import backup: not JSON (${e.message})`);
  }
  if (!data || typeof data !== "object" || data.format !== BACKUP_FORMAT || (data.version !== 1 && data.version !== 2)) {
    throw new Error(`import backup: not an ${BACKUP_FORMAT} version 1 or 2 file`);
  }
  if (!Array.isArray(data.repos)) throw new Error("import backup: repos is not a list");
  const keys = {};
  const warnings = [];
  if (data.version === 2) {
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
    const inst = r.installed;
    if (inst !== null && inst !== undefined) {
      const ok = typeof inst === "object" && !Array.isArray(inst)
        && (inst.tag === null || typeof inst.tag === "string")
        && (inst.digest === null || (typeof inst.digest === "string" && DIGEST_RE.test(inst.digest)))
        && typeof inst.version === "string" && inst.version.length <= 64;
      if (!ok) throw new Error(`${where}: installed is not null or { tag, digest, version }: ${show(inst)}`);
    }
    if (r.addedAt !== undefined && !Number.isFinite(r.addedAt)) throw new Error(`${where}: addedAt is not a number: ${show(r.addedAt)}`);
    let template;
    if (data.version === 2) {
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
      installed: inst ? { tag: inst.tag, digest: inst.digest, version: inst.version } : null,
      addedAt: r.addedAt ?? Date.now(),
    });
  }
  // A zip repo's key must derive its stored extension ID.
  for (const rec of repos) {
    const b64 = keys[repoKey(rec)];
    if (!b64 || !rec.extensionId) continue;
    const id = await extensionIdFromSpki((await importSigningKey(base64Decode(b64))).spki);
    if (id !== rec.extensionId) {
      throw new Error(`import backup: ${repoKey(rec)} key derives ID ${id}, file says ${rec.extensionId}`);
    }
  }
  return { repos, keys, warnings };
}
