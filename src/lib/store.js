// Tracked repos in chrome.storage.local, one key per repo ("repo:owner/name"),
// so a background check and a page edit of different repos never clobber.
// Record: { owner, repo, pattern, includePrereleases, extensionId, keyPkcs8,
//   installed: { tag, digest, version } | null, releases, etag, checkedAt, error, addedAt }
// keyPkcs8 is the base64 PKCS#8 signing key for zip assets (null for .crx assets).

import { base64Decode, extensionIdFromSpki, importSigningKey } from "./crx.js";

const PREFIX = "repo:";
export const BACKUP_FORMAT = "extainium-backup";

export const repoKey = (r) => `${r.owner}/${r.repo}`.toLowerCase();

export function newRecord(owner, repo) {
  return {
    owner,
    repo,
    pattern: null,
    includePrereleases: false,
    extensionId: null,
    keyPkcs8: null,
    installed: null,
    releases: null,
    etag: null,
    checkedAt: null,
    error: null,
    addedAt: Date.now(),
  };
}

export async function listRepos() {
  const all = await chrome.storage.local.get(null);
  return Object.entries(all)
    .filter(([k]) => k.startsWith(PREFIX))
    .map(([, v]) => v)
    .sort((a, b) => repoKey(a).localeCompare(repoKey(b)));
}

export async function getRepo(key) {
  const k = PREFIX + key;
  const v = (await chrome.storage.local.get(k))[k];
  if (!v) throw new Error(`get tracked repo: "${key}" is not tracked`);
  return v;
}

export async function hasRepo(key) {
  const k = PREFIX + key;
  return k in (await chrome.storage.local.get(k));
}

export function putRepo(record) {
  return chrome.storage.local.set({ [PREFIX + repoKey(record)]: record });
}

// Re-reads the record right before writing so concurrent edits of other fields survive.
export async function patchRepo(key, patch) {
  const record = { ...(await getRepo(key)), ...patch };
  await putRepo(record);
  return record;
}

export function deleteRepo(key) {
  return chrome.storage.local.remove(PREFIX + key);
}

export async function getSettings() {
  const { settings } = await chrome.storage.local.get("settings");
  return { githubToken: "", ...settings };
}

export async function setSettings(patch) {
  await chrome.storage.local.set({ settings: { ...(await getSettings()), ...patch } });
}

// Backup without the release cache; contains the signing keys.
export function makeBackup(records, now = new Date()) {
  return {
    format: BACKUP_FORMAT,
    version: 1,
    exportedAt: now.toISOString(),
    repos: records.map(({ releases, etag, error, ...keep }) => ({ ...keep, releases: null, etag: null, error: null })),
  };
}

// Validates a backup and returns its records. Each signing key must parse
// and derive the extension ID stored next to it.
export async function parseBackup(text) {
  let data;
  try {
    data = JSON.parse(text);
  } catch (e) {
    throw new Error(`import backup: not JSON (${e.message})`);
  }
  if (!data || data.format !== BACKUP_FORMAT || data.version !== 1) {
    throw new Error(`import backup: not an ${BACKUP_FORMAT} version 1 file`);
  }
  if (!Array.isArray(data.repos)) throw new Error("import backup: repos is not a list");
  for (const r of data.repos) {
    if (typeof r.owner !== "string" || typeof r.repo !== "string") {
      throw new Error(`import backup: entry without owner/repo: ${JSON.stringify(r).slice(0, 80)}`);
    }
    if (r.keyPkcs8) {
      const { spki } = await importSigningKey(base64Decode(r.keyPkcs8));
      const id = await extensionIdFromSpki(spki);
      if (r.extensionId && r.extensionId !== id) {
        throw new Error(`import backup: ${repoKey(r)} key derives ID ${id}, file says ${r.extensionId}`);
      }
    }
  }
  return data.repos.map((r) => ({ ...newRecord(r.owner, r.repo), ...r }));
}
