// In-memory fakes of the chrome.* APIs and of GitHub that the manager uses.
// Storage values are cloned on every read and write, as chrome.storage does.

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { installFakeLocks } from "./fake-locks.js";

const clone = (v) => structuredClone(v);
const nativeFetch = globalThis.fetch;
// The host permissions the extension holds without asking (src/manifest.json).
const REQUIRED_HOSTS = JSON.parse(readFileSync(new URL("../../src/manifest.json", import.meta.url), "utf8")).host_permissions;
export const USER_AGENTS = {
  android: "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/158.0.8127.100 Mobile Safari/537.36",
  desktop: "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.8078.79 Safari/537.36",
};
// Chrome's host permission check for an origin pattern "scheme://host/*",
// for the pattern forms the extension uses.
const grants = (pattern, origin) => pattern === origin || pattern === "<all_urls>" || (pattern === "https://*/*" && origin.startsWith("https://"));

// hooks: { beforeSet(obj), beforeGet(keys) } may return a promise to delay the call.
// Each call also installs fresh Web Locks (env.locks, see fake-locks.js), so a
// lock a test left held never blocks the next test.
export function fakeChrome({ extensions = [], hooks = {} } = {}) {
  const env = {
    locks: installFakeLocks(),
    store: {},
    extensions: extensions.map(clone),
    files: new Map(), // downloadId -> { filename, bytes, state: "in_progress"|"complete"|"interrupted", exists, startTime, endTime? (ISO) }
    handedOff: [], // CRX bytes passed to chrome.downloads.download, in order
    removed: [],
    erased: [],
    cancelled: [],
    uninstalled: [],
    badge: "",
    alarms: new Map(), // name -> info of the last chrome.alarms.create
    hooks,
    nextDownloadId: 1,
    removeFileError: null, // Error to throw from removeFile, or null
    onDownloadStarted: null, // async (id) => {} runs before download() resolves
    searchHook: null, // async (id) => {} runs inside downloads.search
    newDownloadState: "complete", // state a new download starts in
    changedListeners: new Set(),
    erasedListeners: new Set(),
    redirectListeners: new Set(), // chrome.webRequest.onBeforeRedirect listeners
    // Dispatches chrome.downloads.onChanged / onErased to the registered listeners.
    emitChanged(delta) { for (const l of [...env.changedListeners]) l(delta); },
    emitErased(id) { for (const l of [...env.erasedListeners]) l(id); },
    // Simulates the browser finishing an install of extension id at version.
    install(id, version, name = "Example") {
      env.extensions = env.extensions.filter((e) => e.id !== id);
      env.extensions.push({ id, version, name, enabled: true });
    },
    granted: new Set(REQUIRED_HOSTS), // origin patterns held (chrome.permissions)
    runtimeId: "jojihfmjoonfhnjlioapjefjmdcddgol", // chrome.runtime.id
    manifestVersion: "0.1.18", // chrome.runtime.getManifest().version
    platformOs: "android", // chrome.runtime.getPlatformInfo().os
    userAgent: USER_AGENTS.android,
    // "android" (Titanium) or "desktop" (Linux ungoogled-chromium).
    setPlatform(kind) {
      env.platformOs = kind === "android" ? "android" : "linux";
      env.userAgent = USER_AGENTS[kind];
    },
  };
  Object.defineProperty(globalThis.navigator, "userAgent", { get: () => env.userAgent, configurable: true });
  const pick = (keys) => {
    if (keys === null || keys === undefined) return clone(env.store);
    const list = typeof keys === "string" ? [keys] : Array.isArray(keys) ? keys : Object.keys(keys);
    return Object.fromEntries(list.filter((k) => k in env.store).map((k) => [k, clone(env.store[k])]));
  };
  globalThis.chrome = {
    storage: { local: {
      get: async (keys) => {
        if (hooks.beforeGet) await hooks.beforeGet(keys);
        return pick(keys);
      },
      set: async (obj) => {
        if (hooks.beforeSet) await hooks.beforeSet(obj);
        Object.assign(env.store, clone(obj));
      },
      remove: async (keys) => {
        if (hooks.beforeRemove) await hooks.beforeRemove(keys);
        for (const k of typeof keys === "string" ? [keys] : keys) delete env.store[k];
      },
    } },
    management: {
      getAll: async () => clone(env.extensions),
      get: async (id) => {
        const e = env.extensions.find((x) => x.id === id);
        if (!e) throw new Error(`Failed to find extension with id ${id}.`);
        return clone(e);
      },
      uninstall: async (id) => {
        env.uninstalled.push(id);
        env.extensions = env.extensions.filter((e) => e.id !== id);
      },
    },
    permissions: {
      getAll: async () => ({ permissions: [], origins: [...env.granted] }),
      contains: async ({ origins = [] }) => origins.every((o) => [...env.granted].some((p) => grants(p, o))),
      request: async ({ origins = [] }) => {
        for (const o of origins) env.granted.add(o);
        return true;
      },
    },
    runtime: {
      get id() { return env.runtimeId; },
      getManifest: () => ({ manifest_version: 3, name: "Extainium", version: env.manifestVersion }),
      getPlatformInfo: async () => ({ os: env.platformOs, arch: "arm64" }),
    },
    // Without a "webRequest" permission (or on a browser without the API) a test deletes it.
    // dispatch (fake only) delivers { requestId, url, redirectUrl } to the listeners.
    webRequest: {
      onBeforeRedirect: {
        addListener: (l) => env.redirectListeners.add(l),
        removeListener: (l) => env.redirectListeners.delete(l),
        dispatch: (details) => { for (const l of [...env.redirectListeners]) l(details); },
      },
    },
    action: {
      setBadgeBackgroundColor: async () => {},
      setBadgeText: async ({ text }) => { env.badge = text; },
    },
    alarms: {
      create: async (name, info) => { env.alarms.set(name, info); },
      get: async (name) => (env.alarms.has(name) ? { name, ...env.alarms.get(name) } : null),
    },
    downloads: {
      download: async ({ url, filename }) => {
        const bytes = new Uint8Array(await (await nativeFetch(url)).arrayBuffer());
        const id = env.nextDownloadId++;
        const startTime = new Date().toISOString();
        env.files.set(id, { filename, bytes, state: env.newDownloadState, exists: true, startTime, ...(env.newDownloadState === "complete" ? { endTime: startTime } : {}) });
        env.handedOff.push(bytes);
        if (env.onDownloadStarted) await env.onDownloadStarted(id);
        return id;
      },
      search: async ({ id }) => {
        if (env.searchHook) await env.searchHook(id);
        const f = env.files.get(id);
        return f ? [{ id, filename: f.filename, state: f.state, danger: "safe", exists: f.exists, startTime: f.startTime, endTime: f.endTime }] : [];
      },
      onChanged: { addListener: (l) => env.changedListeners.add(l), removeListener: (l) => env.changedListeners.delete(l) },
      onErased: { addListener: (l) => env.erasedListeners.add(l), removeListener: (l) => env.erasedListeners.delete(l) },
      acceptDanger: async () => {},
      removeFile: async (id) => {
        if (env.removeFileError) throw env.removeFileError;
        const f = env.files.get(id);
        if (!f) throw new Error("Invalid downloadId");
        if (f.state !== "complete") throw new Error("Download must be complete");
        if (!f.exists) throw new Error("Download file already deleted");
        f.exists = false;
        env.removed.push(id);
      },
      // Chromium's erase cancels an in-progress download (env.cancelled records it).
      erase: async ({ id }) => {
        if (env.files.get(id)?.state === "in_progress") env.cancelled.push(id);
        env.files.delete(id);
        env.erased.push(id);
        return [id];
      },
    },
  };
  return env;
}

// A releases.atom feed in GitHub's format (as in fixtures/ublock-releases.atom)
// for releases: [{ tag, publishedAt?, updatedAt? }], newest 10 first.
export function atomFeed(releases, { owner = "o", repo = "r" } = {}) {
  const entries = releases.slice(0, 10).map((r) => `  <entry>
    <id>tag:github.com,2008:Repository/1/${r.tag}</id>
    <updated>${r.updatedAt || r.publishedAt || "2026-01-01T00:00:00Z"}</updated>
    <link rel="alternate" type="text/html" href="https://github.com/${owner}/${repo}/releases/tag/${r.tag}"/>
    <title>${r.tag}</title>
    <content type="html">&lt;p&gt;notes&lt;/p&gt;</content>
  </entry>`);
  return `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom" xmlns:media="http://search.yahoo.com/mrss/" xml:lang="en-US">
  <id>tag:github.com,2008:https://github.com/${owner}/${repo}/releases</id>
  <title>Release notes from ${repo}</title>
  <updated>2026-01-01T00:00:00Z</updated>
${entries.join("\n")}
</feed>
`;
}

// releases: [{ tag, prerelease?, publishedAt?, updatedAt?, assets: [{ name, bytes, digest? }] }]
// (updatedAt defaults to publishedAt, as in atomFeed)
// Serves the releases API (pageSize releases per page, with Link rel="next"),
// the asset downloads, including Range requests, and, when feed is set (gh.feed:
// true for atomFeed(gh.releases), or the feed text), releases.atom; else the feed is 404.
export function fakeGithub(releases, { pageSize = 30, owner = "o", repo = "r", feed = null } = {}) {
  const gh = { releases, requests: [], etags: new Map(), feed };
  const assetUrl = (tag, name) => `https://github.com/${owner}/${repo}/releases/download/${tag}/${name}`;
  const api = (r) => ({
    draft: false,
    tag_name: r.tag,
    name: r.tag,
    prerelease: !!r.prerelease,
    published_at: r.publishedAt || "2026-01-01T00:00:00Z",
    // GitHub's feed shows a release's updated_at as the entry's <updated> (as atomFeed does).
    updated_at: r.updatedAt || r.publishedAt || "2026-01-01T00:00:00Z",
    html_url: `https://github.com/${owner}/${repo}/releases/tag/${r.tag}`,
    assets: r.assets.map((a) => ({ name: a.name, browser_download_url: assetUrl(r.tag, a.name), size: a.bytes ? a.bytes.length : 0, digest: a.digest || null })),
  });
  globalThis.fetch = async (input, init = {}) => {
    const url = String(input);
    if (url.startsWith("blob:")) return nativeFetch(input, init);
    gh.requests.push({ url, headers: { ...(init.headers || {}) } });
    const u = new URL(url);
    if (url === `https://github.com/${owner}/${repo}/releases.atom`) {
      if (gh.feed === null) return new Response("not found", { status: 404 });
      const text = gh.feed === true ? atomFeed(gh.releases, { owner, repo }) : gh.feed;
      return new Response(text, { status: 200, headers: { "content-type": "application/atom+xml; charset=utf-8" } });
    }
    if (u.hostname === "api.github.com") {
      const page = Number(u.searchParams.get("page") || 1);
      const all = gh.releases.map(api);
      const items = all.slice((page - 1) * pageSize, page * pageSize);
      // A content hash, as GitHub's: any change of the page's data changes it.
      const etag = `"p${page}-${createHash("sha256").update(JSON.stringify(items)).digest("hex").slice(0, 16)}"`;
      const headers = { etag };
      if (page * pageSize < all.length) {
        headers.link = `<https://api.github.com/repositories/1/releases?per_page=${pageSize}&page=${page + 1}>; rel="next", <https://api.github.com/repositories/1/releases?per_page=${pageSize}&page=9>; rel="last"`;
      }
      if ((init.headers || {})["If-None-Match"] === etag) return new Response(null, { status: 304, headers });
      return new Response(JSON.stringify(items), { status: 200, headers });
    }
    for (const r of gh.releases) {
      for (const a of r.assets) {
        if (assetUrl(r.tag, a.name) !== url) continue;
        const range = (init.headers || {}).Range;
        if (range) {
          const [, from, to] = range.match(/bytes=(\d+)-(\d+)/);
          return new Response(a.bytes.slice(Number(from), Number(to) + 1), { status: 206 });
        }
        return new Response(a.bytes, { status: 200 });
      }
    }
    return new Response("not found", { status: 404 });
  };
  return gh;
}

// The signing key of repo key k in an exported backup (any backup version).
export function exportedKey(backupJson, k) {
  const b = JSON.parse(backupJson);
  if (b.keys) return b.keys[k] || null;
  const r = b.repos.find((x) => `${x.owner}/${x.repo}`.toLowerCase() === k);
  return (r && r.keyPkcs8) || null;
}

// A version 1 backup (the format Extainium 0.1 exported) for seeding state.
export function v1Backup(repos) {
  return JSON.stringify({ format: "extainium-backup", version: 1, exportedAt: "2026-11-24T00:00:00.000Z", repos });
}
