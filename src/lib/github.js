// GitHub REST API access. The token is sent only to api.github.com.

const API = "https://api.github.com";

export class RateLimitError extends Error {}

// Returns { notModified: true } on 304, else { releases (raw API JSON), etag }.
// Also returns rate: { limit, remaining, reset (ms epoch) } when GitHub sends it.
export async function fetchReleases(owner, repo, { etag, token } = {}) {
  const url = `${API}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/releases?per_page=30`;
  const headers = { Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" };
  if (etag) headers["If-None-Match"] = etag;
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(url, { headers, credentials: "omit", cache: "no-store" });
  const rate = res.headers.has("x-ratelimit-remaining")
    ? {
        limit: Number(res.headers.get("x-ratelimit-limit")),
        remaining: Number(res.headers.get("x-ratelimit-remaining")),
        reset: Number(res.headers.get("x-ratelimit-reset")) * 1000,
      }
    : null;
  if (res.status === 304) return { notModified: true, rate };
  if ((res.status === 403 || res.status === 429) && rate && rate.remaining === 0) {
    const at = new Date(rate.reset).toLocaleTimeString();
    throw new RateLimitError(`GitHub API rate limit exhausted until ${at} (fetching ${owner}/${repo} releases)`);
  }
  if (!res.ok) {
    let detail = "";
    try { detail = (await res.json()).message || ""; } catch {}
    throw new Error(`fetch ${owner}/${repo} releases: HTTP ${res.status}${detail ? " " + detail : ""}`);
  }
  return { releases: await res.json(), etag: res.headers.get("etag"), rate };
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
