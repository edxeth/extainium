// Pure logic for tracking GitHub releases: repo parsing, versions, asset
// patterns, release selection and update state.

const NAME_RE = /^[A-Za-z0-9_.-]+$/;

// Accepts "owner/repo" or any github.com URL inside the repo.
export function parseRepo(input) {
  const raw = String(input).trim();
  let path;
  if (/^[^/\s:]+\/[^/\s]+$/.test(raw) && !/^(www\.)?github\.com\//i.test(raw)) {
    path = raw;
  } else {
    let url;
    try {
      url = new URL(/^[a-z]+:\/\//i.test(raw) ? raw : "https://" + raw);
    } catch {
      throw new Error(`parse repo: not owner/repo or a GitHub URL: "${raw}"`);
    }
    if (!/^(www\.)?github\.com$/i.test(url.hostname)) {
      throw new Error(`parse repo: not a github.com URL: "${raw}"`);
    }
    path = url.pathname.split("/").filter(Boolean).slice(0, 2).join("/");
  }
  let [owner, repo] = path.split("/");
  repo = (repo || "").replace(/\.git$/i, "");
  if (!owner || !repo || !NAME_RE.test(owner) || !NAME_RE.test(repo)) {
    throw new Error(`parse repo: no owner/repo in "${raw}"`);
  }
  return { owner, repo };
}

// "v1.2.3", "release-1.2", "1.77.1b3" -> "1.2.3", "1.2", "1.77.1b3"; null if no digits.
export function versionFromTag(tag) {
  const m = String(tag).match(/\d+(?:\.\d+)*(?:[-.]?[A-Za-z]+\.?\d*)?/);
  return m ? m[0] : null;
}

function parseVersion(v) {
  const m = String(v).trim().match(/^v?(\d+(?:\.\d+)*)(?:[-.]?([A-Za-z]+)\.?(\d*))?/);
  if (!m) throw new Error(`compare versions: not a version: "${v}"`);
  return {
    core: m[1].split(".").map(Number),
    pre: m[2] ? { label: m[2].toLowerCase(), n: Number(m[3] || 0) } : null,
  };
}

// Numeric dotted comparison; missing parts count as 0; a suffix such as
// "b3" or "-rc1" marks a pre-release, which sorts before the plain version.
export function compareVersions(a, b) {
  const x = parseVersion(a);
  const y = parseVersion(b);
  for (let i = 0; i < Math.max(x.core.length, y.core.length); i++) {
    const d = (x.core[i] || 0) - (y.core[i] || 0);
    if (d) return Math.sign(d);
  }
  if (!x.pre || !y.pre) return x.pre ? -1 : y.pre ? 1 : 0;
  if (x.pre.label !== y.pre.label) return x.pre.label < y.pre.label ? -1 : 1;
  return Math.sign(x.pre.n - y.pre.n);
}

export const VERSION_PATTERN = "\\d+(?:\\.\\d+)*(?:-?(?:alpha|beta|pre|rc|a|b)\\.?\\d+)?";

const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// Regex source matching assetName in future releases: the tag's version (or
// else every dotted number) is generalized; the rest is literal.
export function derivePattern(assetName, tag) {
  const version = versionFromTag(tag);
  let parts;
  if (version && assetName.includes(version)) parts = assetName.split(version);
  else parts = assetName.split(/\d+(?:\.\d+)+/);
  return "^" + parts.map(escapeRegex).join(VERSION_PATTERN) + "$";
}

export function compilePattern(pattern) {
  try {
    return new RegExp(pattern);
  } catch (e) {
    throw new Error(`asset pattern: invalid regex "${pattern}" (${e.message})`);
  }
}

export function matchAssets(release, pattern) {
  const re = compilePattern(pattern);
  return release.assets.filter((a) => re.test(a.name));
}

export function isPackageAsset(name) {
  return /\.(crx|zip)$/i.test(name);
}

// Reduces the GitHub "list releases" response to what we store; drops drafts.
export function simplifyReleases(apiReleases) {
  return apiReleases
    .filter((r) => !r.draft)
    .map((r) => ({
      tag: r.tag_name,
      name: r.name || r.tag_name,
      prerelease: r.prerelease,
      publishedAt: r.published_at,
      htmlUrl: r.html_url,
      assets: r.assets.map((a) => ({
        name: a.name,
        url: a.browser_download_url,
        size: a.size,
        digest: a.digest || null,
      })),
    }));
}

// Newest release (by publish date) with at least one asset matching pattern.
// Returns { release, assets } or null.
export function selectRelease(releases, pattern, includePrereleases) {
  const sorted = releases
    .filter((r) => includePrereleases || !r.prerelease)
    .sort((a, b) => Date.parse(b.publishedAt) - Date.parse(a.publishedAt));
  for (const release of sorted) {
    const assets = matchAssets(release, pattern);
    if (assets.length) return { release, assets };
  }
  return null;
}

// The release a tracked record would install now:
// { release, tag, asset (null when several match), candidates } or null.
export function latestFor(record) {
  if (!record.releases || !record.pattern) return null;
  const sel = selectRelease(record.releases, record.pattern, record.includePrereleases);
  if (!sel) return null;
  return {
    release: sel.release,
    tag: sel.release.tag,
    asset: sel.assets.length === 1 ? sel.assets[0] : null,
    candidates: sel.assets,
  };
}

// repo: tracked record { latest: {tag, asset}|null, installed: {tag, digest, version}|null }
// ext: chrome.management info of the linked extension, or null.
// state: "no-asset" | "ambiguous" | "not-installed" | "update" | "current" | "unknown"
export function updateState(repo, ext) {
  if (!repo.latest) return "no-asset";
  if (!repo.latest.asset) return "ambiguous";
  if (!ext) return "not-installed";
  const mine = repo.installed;
  if (mine && mine.version === ext.version) {
    if (mine.digest && repo.latest.asset.digest) {
      return mine.digest === repo.latest.asset.digest ? "current" : "update";
    }
    return mine.tag === repo.latest.tag ? "current" : "update";
  }
  // Installed outside Extainium (or another version): compare versions.
  const latest = versionFromTag(repo.latest.tag);
  if (!latest) return "unknown";
  return compareVersions(latest, ext.version) > 0 ? "update" : "current";
}
