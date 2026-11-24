// Pure logic for tracking GitHub releases: repo parsing, versions, asset
// file name templates, release selection and update state.

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

// Asset file name templates: literal text, "{version}" for the version part
// and "*" for any run of characters, e.g. "uBlock0_{version}.chromium.crx".
// Matched by simulating a small NFA: time O(name length x template length),
// no backtracking, and no RegExp is ever built from user or backup input.

export const VERSION_TOKEN = "{version}";
export const TEMPLATE_MAX_LENGTH = 200;
// Pre-release labels a {version} may carry after the numeric part, case-insensitive:
// "1.2.3-rc", "1.2.3-RC1", "1.2.3-preview.1", "1.77.1b3", "2.0-beta.2".
export const PRERELEASE_LABELS = ["alpha", "a", "beta", "b", "pre", "preview", "rc", "dev", "canary", "nightly", "snapshot"];
const LABELS = new Set(PRERELEASE_LABELS);

const isDigit = (c) => c >= "0" && c <= "9";
const isLetter = (c) => (c >= "a" && c <= "z") || (c >= "A" && c <= "Z");

// Longest version token at name[i]: digits(.digits)* then optionally
// [-.]? label ([-.]? digits(.digits)*)?. Returns its end index, or -1.
function scanVersion(name, i) {
  let j = i;
  if (!isDigit(name[j])) return -1;
  const digits = (k) => { while (isDigit(name[k])) k++; return k; };
  j = digits(j);
  while (name[j] === "." && isDigit(name[j + 1])) j = digits(j + 1);
  let k = j;
  if (name[k] === "-" || name[k] === ".") k++;
  let l = k;
  while (isLetter(name[l])) l++;
  if (l === k || !LABELS.has(name.slice(k, l).toLowerCase())) return j;
  j = l;
  k = name[j] === "-" || name[j] === "." ? j + 1 : j;
  if (isDigit(name[k])) {
    j = digits(k);
    while (name[j] === "." && isDigit(name[j + 1])) j = digits(j + 1);
  }
  return j;
}

// A version can start at i: a digit not preceded by a digit or by "digit.".
const canStart = (name, i) => isDigit(name[i]) && !isDigit(name[i - 1]) && !(name[i - 1] === "." && isDigit(name[i - 2]));

// Version tokens from left to right, each the longest at its start.
function versionTokens(name) {
  const out = [];
  for (let i = 0; i < name.length; i++) {
    if (!canStart(name, i)) continue;
    const end = scanVersion(name, i);
    out.push({ start: i, end, text: name.slice(i, end) });
    i = end - 1;
  }
  return out;
}

// "v1.2.3", "release-1.2", "1.77.1b3", "v1.2.3-preview.1" -> the version; null if no digits.
export function versionFromTag(tag) {
  const [first] = versionTokens(String(tag));
  return first ? first.text : null;
}

function parseVersion(v) {
  const s = String(v).trim().replace(/^v/i, "");
  if (scanVersion(s, 0) !== s.length) throw new Error(`compare versions: not a version: "${v}"`);
  const m = s.match(/^(\d+(?:\.\d+)*)(?:[-.]?([A-Za-z]+)[-.]?(\d*))?/);
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

// Throws unless template is a usable template string. Returns it.
export function validateTemplate(template) {
  const show = JSON.stringify(template);
  if (typeof template !== "string" || !template) throw new Error(`asset template: not a non-empty string: ${show}`);
  if (template.length > TEMPLATE_MAX_LENGTH) throw new Error(`asset template: longer than ${TEMPLATE_MAX_LENGTH} characters: ${show.slice(0, 60)}…`);
  if (/[\u0000-\u001f\u007f/\\]/.test(template)) throw new Error(`asset template: control character or slash in ${show}`);
  if (/[{}]/.test(template.split(VERSION_TOKEN).join(""))) {
    throw new Error(`asset template: only {version} may use braces: ${show}`);
  }
  return template;
}

// NFA of a template. States: { lit?: char, any?: true, digit?, dot?, sep?, letter?: label trie node, eps: [] }
function compileTemplate(template) {
  validateTemplate(template);
  const states = [];
  const add = (s) => (states.push({ eps: [], ...s }), states.length - 1);
  const start = add({});
  let cur = start;
  const link = (from, to) => states[from].eps.push(to);
  for (let i = 0; i < template.length; ) {
    if (template.startsWith(VERSION_TOKEN, i)) {
      cur = addVersion(cur);
      i += VERSION_TOKEN.length;
    } else if (template[i] === "*") {
      const loop = add({});
      link(cur, loop);
      states[loop].any = loop; // any char -> stay
      cur = loop;
      i++;
    } else {
      const next = add({});
      const ch = template[i];
      on(cur, (c) => c === ch, next);
      cur = next;
      i++;
    }
  }
  return { states, start, accept: cur };

  // Sub-automaton of the {version} grammar used by scanVersion.
  function addVersion(from) {
    const end = add({});
    const num = (entry) => { // digits(.digits)* from entry; returns the state after a digit
      const d = add({});
      const dot = add({});
      on(entry, isDigit, d); on(d, isDigit, d); on(d, (c) => c === ".", dot); on(dot, isDigit, d);
      return d;
    };
    const core = num(from);
    link(core, end);
    const sep1 = add({});
    on(core, (c) => c === "-" || c === ".", sep1);
    link(core, sep1);
    // Label trie, case-insensitive.
    const labelEnds = [];
    for (const label of PRERELEASE_LABELS) {
      let s = sep1;
      for (const ch of label) {
        const n = add({});
        on(s, (c) => c.toLowerCase() === ch, n);
        s = n;
      }
      labelEnds.push(s);
    }
    const afterLabel = add({});
    for (const s of labelEnds) link(s, afterLabel);
    link(afterLabel, end);
    const sep2 = add({});
    link(afterLabel, sep2);
    on(afterLabel, (c) => c === "-" || c === ".", sep2);
    const n2 = num(sep2);
    link(n2, end);
    return end;
  }
  function on(from, test, to) {
    states[from].on = [...(states[from].on || []), [test, to]];
  }
}

function closure(states, set) {
  const stack = [...set];
  while (stack.length) {
    const s = stack.pop();
    for (const t of states[s].eps) if (!set.has(t)) { set.add(t); stack.push(t); }
  }
  return set;
}

function runNfa({ states, start, accept }, name) {
  let cur = closure(states, new Set([start]));
  for (const c of name) {
    const next = new Set();
    for (const s of cur) {
      const st = states[s];
      if (st.any !== undefined) next.add(st.any);
      if (st.on) for (const [test, to] of st.on) if (test(c)) next.add(to);
    }
    if (!next.size) return false;
    cur = closure(states, next);
  }
  return cur.has(accept);
}

// True when the whole file name matches the template.
export function matchTemplate(template, name) {
  return runNfa(compileTemplate(template), String(name));
}

// Template for assetName that finds the same asset in later releases: the
// tag's version (or, when the name does not contain it, every dotted version
// such as 2.3.4) becomes {version}; the rest stays literal.
export function deriveTemplate(assetName, tag) {
  const name = String(assetName);
  if (name.includes(VERSION_TOKEN)) throw new Error(`derive asset template: name contains ${VERSION_TOKEN}: "${name}"`);
  const version = versionFromTag(tag);
  // Occurrences of the tag's version that are whole versions in the name.
  let chosen = [];
  for (let i = version ? name.indexOf(version) : -1; i >= 0; i = name.indexOf(version, i + version.length)) {
    if (canStart(name, i) && scanVersion(name, i) === i + version.length) chosen.push({ start: i, end: i + version.length });
  }
  if (!chosen.length) chosen = versionTokens(name).filter((t) => t.text.includes("."));
  let out = "";
  let at = 0;
  for (const t of chosen) {
    out += name.slice(at, t.start) + VERSION_TOKEN;
    at = t.end;
  }
  return validateTemplate(out + name.slice(at));
}

export function matchAssets(release, template) {
  const nfa = compileTemplate(template);
  return release.assets.filter((a) => runNfa(nfa, a.name));
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

// Newest release (by publish date) with at least one asset matching template.
// Returns { release, assets } or null.
export function selectRelease(releases, template, includePrereleases) {
  const nfa = compileTemplate(template);
  const sorted = releases
    .filter((r) => includePrereleases || !r.prerelease)
    .sort((a, b) => Date.parse(b.publishedAt) - Date.parse(a.publishedAt));
  for (const release of sorted) {
    const assets = release.assets.filter((a) => runNfa(nfa, a.name));
    if (assets.length) return { release, assets };
  }
  return null;
}

// The release a tracked record would install now:
// { release, tag, asset (null when several match), candidates } or null.
export function latestFor(record) {
  if (!record.releases || !record.template) return null;
  const sel = selectRelease(record.releases, record.template, record.includePrereleases);
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
// Release order decides first: a newer release is an update, an older one never
// is. Only the same release with another digest (a rebuild) is an update too.
export function updateState(repo, ext) {
  if (!repo.latest) return "no-asset";
  if (!repo.latest.asset) return "ambiguous";
  if (!ext) return "not-installed";
  const mine = repo.installed && repo.installed.version === ext.version ? repo.installed : null;
  const latest = versionFromTag(repo.latest.tag);
  // Compare tag with tag when Extainium installed the running version, as
  // manifest versions often encode pre-releases differently ("1.77.1.3" for "1.77.1b3").
  const running = mine && mine.tag ? versionFromTag(mine.tag) : ext.version;
  const order = latest && running ? orderOrNull(latest, running) : null;
  if (order > 0) return "update";
  if (order < 0) return "current";
  // Same release (or no comparable versions): a rebuild has another digest.
  if (mine && mine.digest && repo.latest.asset.digest) return mine.digest === repo.latest.asset.digest ? "current" : "update";
  if (mine && mine.tag) return mine.tag === repo.latest.tag ? "current" : "update";
  return order === 0 ? "current" : "unknown";
}

// compareVersions, or null for a version outside the grammar (e.g. manifest "2024-01").
function orderOrNull(a, b) {
  try {
    return compareVersions(a, b);
  } catch {
    return null;
  }
}
