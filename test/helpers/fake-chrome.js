// In-memory fakes of the chrome.* APIs and of GitHub that the manager uses.
// Storage values are cloned on every read and write, as chrome.storage does.

const clone = (v) => structuredClone(v);
const nativeFetch = globalThis.fetch;

// hooks: { beforeSet(obj), beforeGet(keys) } may return a promise to delay the call.
export function fakeChrome({ extensions = [], hooks = {} } = {}) {
  const env = {
    store: {},
    extensions: extensions.map(clone),
    files: new Map(), // downloadId -> { filename, bytes, state: "in_progress"|"complete"|"interrupted", exists }
    handedOff: [], // CRX bytes passed to chrome.downloads.download, in order
    removed: [],
    erased: [],
    cancelled: [],
    uninstalled: [],
    badge: "",
    hooks,
    nextDownloadId: 1,
    removeFileError: null, // Error to throw from removeFile, or null
    onDownloadStarted: null, // async (id) => {} runs before download() resolves
    searchHook: null, // async (id) => {} runs inside downloads.search
    // Simulates the browser finishing an install of extension id at version.
    install(id, version, name = "Example") {
      env.extensions = env.extensions.filter((e) => e.id !== id);
      env.extensions.push({ id, version, name, enabled: true });
    },
  };
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
    action: {
      setBadgeBackgroundColor: async () => {},
      setBadgeText: async ({ text }) => { env.badge = text; },
    },
    alarms: { create: async () => {}, get: async () => null },
    downloads: {
      download: async ({ url, filename }) => {
        const bytes = new Uint8Array(await (await nativeFetch(url)).arrayBuffer());
        const id = env.nextDownloadId++;
        env.files.set(id, { filename, bytes, state: "complete", exists: true });
        env.handedOff.push(bytes);
        if (env.onDownloadStarted) await env.onDownloadStarted(id);
        return id;
      },
      search: async ({ id }) => {
        if (env.searchHook) await env.searchHook(id);
        const f = env.files.get(id);
        return f ? [{ id, filename: f.filename, state: f.state, danger: "safe", exists: f.exists }] : [];
      },
      onChanged: { addListener() {}, removeListener() {} },
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

// releases: [{ tag, prerelease?, publishedAt?, assets: [{ name, bytes, digest? }] }]
// Serves the releases API (pageSize releases per page, with Link rel="next")
// and the asset downloads, including Range requests.
export function fakeGithub(releases, { pageSize = 30, owner = "o", repo = "r" } = {}) {
  const gh = { releases, requests: [], etags: new Map() };
  const assetUrl = (tag, name) => `https://github.com/${owner}/${repo}/releases/download/${tag}/${name}`;
  const api = (r) => ({
    draft: false,
    tag_name: r.tag,
    name: r.tag,
    prerelease: !!r.prerelease,
    published_at: r.publishedAt || "2026-01-01T00:00:00Z",
    html_url: `https://github.com/${owner}/${repo}/releases/tag/${r.tag}`,
    assets: r.assets.map((a) => ({ name: a.name, browser_download_url: assetUrl(r.tag, a.name), size: a.bytes ? a.bytes.length : 0, digest: a.digest || null })),
  });
  globalThis.fetch = async (input, init = {}) => {
    const url = String(input);
    if (url.startsWith("blob:")) return nativeFetch(input, init);
    gh.requests.push({ url, headers: { ...(init.headers || {}) } });
    const u = new URL(url);
    if (u.hostname === "api.github.com") {
      const page = Number(u.searchParams.get("page") || 1);
      const all = gh.releases.map(api);
      const items = all.slice((page - 1) * pageSize, page * pageSize);
      const etag = `"p${page}-${JSON.stringify(items).length}"`;
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
