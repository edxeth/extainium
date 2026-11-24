// GitHub REST API access. The token is sent only to api.github.com.

import { simplifyReleases } from "./releases.js";

const API = "https://api.github.com";

export class RateLimitError extends Error {}

export const MAX_RELEASE_PAGES = 5;

function rateOf(res) {
  return res.headers.has("x-ratelimit-remaining")
    ? {
        limit: Number(res.headers.get("x-ratelimit-limit")),
        remaining: Number(res.headers.get("x-ratelimit-remaining")),
        reset: Number(res.headers.get("x-ratelimit-reset")) * 1000,
      }
    : null;
}

// The rel="next" URL of a Link header, or null. Only api.github.com URLs are followed.
function nextLink(res, what) {
  const link = res.headers.get("link");
  if (!link) return null;
  for (const part of link.split(",")) {
    const m = part.match(/^\s*<([^>]*)>\s*;\s*rel="next"\s*$/);
    if (!m) continue;
    if (!m[1].startsWith(API + "/")) throw new Error(`fetch ${what}: next page link leaves ${API}: ${m[1]}`);
    return m[1];
  }
  return null;
}

// One page of the releases list: { notModified, releases (raw API JSON), etag, next, rate }.
async function fetchPage(url, etag, token, what) {
  const headers = { Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" };
  if (etag) headers["If-None-Match"] = etag;
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(url, { headers, credentials: "omit", cache: "no-store" });
  const rate = rateOf(res);
  if (res.status === 304) return { notModified: true, next: nextLink(res, what), rate };
  if ((res.status === 403 || res.status === 429) && rate && rate.remaining === 0) {
    const at = new Date(rate.reset).toLocaleTimeString();
    throw new RateLimitError(`GitHub API rate limit exhausted until ${at} (fetching ${what})`);
  }
  if (!res.ok) {
    let detail = "";
    try { detail = (await res.json()).message || ""; } catch {}
    throw new Error(`fetch ${what}: HTTP ${res.status}${detail ? " " + detail : ""}`);
  }
  return { notModified: false, releases: await res.json(), etag: res.headers.get("etag"), next: nextLink(res, what), rate };
}

// Reads release pages, newest first, following Link rel="next" until
// enough(releasesSoFar) holds or MAX_RELEASE_PAGES pages were read.
// cache: pages of the previous check, [{ url, etag, next, releases }]; a page
// whose URL matches is revalidated with its ETag and reused on 304.
// Returns { pages: [{ url, etag, next, releases }], releases (all pages), rate }
// with releases reduced by simplifyReleases.
export async function fetchReleases(owner, repo, { token, cache = null, enough = () => true } = {}) {
  const what = `${owner}/${repo} releases`;
  let url = `${API}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/releases?per_page=30`;
  const pages = [];
  let rate = null;
  for (let i = 0; url && i < MAX_RELEASE_PAGES; i++) {
    const cached = cache && cache[i] && cache[i].url === url ? cache[i] : null;
    const res = await fetchPage(url, cached && cached.etag, token, what);
    rate = res.rate || rate;
    const page = res.notModified
      ? { ...cached, next: res.next || cached.next }
      : { url, etag: res.etag, next: res.next, releases: simplifyReleases(res.releases) };
    pages.push(page);
    const releases = pages.flatMap((p) => p.releases);
    if (enough(releases)) break;
    url = page.next;
  }
  return { pages, releases: pages.flatMap((p) => p.releases), rate };
}

async function getBytes(url, init, what) {
  const res = await fetch(url, { credentials: "omit", ...init });
  if (!res.ok) throw new Error(`download ${what}: HTTP ${res.status} from ${url}`);
  return new Uint8Array(await res.arrayBuffer());
}

export function sha256Hex(bytes) {
  return crypto.subtle.digest("SHA-256", bytes).then((h) =>
    Array.from(new Uint8Array(h), (b) => b.toString(16).padStart(2, "0")).join("")
  );
}

// Downloads a release asset and checks it against GitHub's digest ("sha256:<hex>").
export async function downloadAsset(asset) {
  const bytes = await getBytes(asset.url, {}, asset.name);
  if (asset.digest) {
    const [algo, want] = asset.digest.split(":");
    if (algo !== "sha256") throw new Error(`verify ${asset.name}: unsupported digest "${asset.digest}"`);
    const got = await sha256Hex(bytes);
    if (got !== want) throw new Error(`verify ${asset.name}: sha256 ${got} does not match GitHub digest ${want}`);
  }
  return bytes;
}

// First bytes of an asset, enough for a CRX header.
export function downloadAssetHead(asset) {
  return getBytes(asset.url, { headers: { Range: "bytes=0-65535" } }, asset.name);
}
