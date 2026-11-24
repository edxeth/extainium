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

const ATOM_NS = "http://www.w3.org/2005/Atom";
const XML_ENTITIES = { lt: "<", gt: ">", amp: "&", quot: '"', apos: "'" };
const NAME = "[A-Za-z_][\\w.:-]*";
const START_TAG = new RegExp(`<(${NAME})((?:\\s+${NAME}\\s*=\\s*(?:"[^"<]*"|'[^'<]*'))*)\\s*(/?)>`, "y");
const END_TAG = new RegExp(`</(${NAME})\\s*>`, "y");
const ATTRIBUTE = new RegExp(`(${NAME})\\s*=\\s*(?:"([^"<]*)"|'([^'<]*)')`, "g");

// The entries of a GitHub releases.atom feed, newest first: [{ id, updated }].
// GitHub lists the newest 10 releases and tags; an entry's <updated> is the
// release's updated_at, which moves when an asset is uploaded or the release
// edited. Service workers have no DOMParser, so the XML is read here: elements
// with attributes, comments, processing instructions, CDATA sections, the
// predefined entities and character references. The supported form is
// GitHub's: a <feed> root in the Atom default namespace, whose unprefixed
// <entry> children hold one <id> and one <updated> (a date) each. Anything
// else (a DOCTYPE, an Atom namespace declared elsewhere, unclosed or
// mismatched elements, text outside the root) is rejected, so an unparsed
// document is never taken for an empty feed.
export function parseReleaseFeed(text) {
  const fail = (msg) => new Error(`parse releases feed: ${msg}`);
  const notAtom = () => fail(`not an Atom feed: ${JSON.stringify(text.slice(0, 60))}`);
  const decode = (raw, at) => raw.replace(/&([^;&<]*);?/g, (ref, body, off) => {
    let cp = null;
    if (ref.endsWith(";")) {
      if (/^#[0-9]+$/.test(body)) cp = Number(body.slice(1));
      else if (/^#x[0-9a-fA-F]+$/.test(body)) cp = parseInt(body.slice(2), 16);
      else if (body in XML_ENTITIES) return XML_ENTITIES[body];
    }
    if (cp === null || cp === 0 || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) {
      throw fail(`bad character reference ${JSON.stringify(ref.slice(0, 20))} at byte ${at + off}`);
    }
    return String.fromCodePoint(cp);
  });
  const entries = [];
  const stack = []; // open elements: { name, text (for <id>/<updated> of an entry), entry }
  let rootSeen = false;
  const addText = (s, at) => {
    const top = stack.at(-1);
    if (!top) {
      if (/\S/.test(s)) throw rootSeen ? fail(`text after the root element at byte ${at}`) : notAtom();
    } else if (top.text !== undefined) top.text += s;
  };
  let pos = 0;
  while (pos < text.length) {
    const lt = text.indexOf("<", pos);
    const end = lt === -1 ? text.length : lt;
    if (end > pos) addText(decode(text.slice(pos, end), pos), pos);
    if (lt === -1) break;
    pos = lt;
    const skip = (open, close, what) => {
      const stop = text.indexOf(close, pos + open.length);
      if (stop === -1) throw fail(`truncated: ${what} at byte ${pos} is not closed`);
      const inner = text.slice(pos + open.length, stop);
      pos = stop + close.length;
      return inner;
    };
    if (text.startsWith("<!--", pos)) skip("<!--", "-->", "comment");
    else if (text.startsWith("<![CDATA[", pos)) {
      if (!stack.length) throw notAtom();
      const at = pos;
      addText(skip("<![CDATA[", "]]>", "CDATA section"), at);
    } else if (text.startsWith("<?", pos)) skip("<?", "?>", "processing instruction");
    else if (text.startsWith("<!", pos)) throw stack.length ? fail(`unsupported markup at byte ${pos}: ${JSON.stringify(text.slice(pos, pos + 20))}`) : notAtom();
    else if (text.startsWith("</", pos)) {
      END_TAG.lastIndex = pos;
      const m = END_TAG.exec(text);
      if (!m) throw fail(`truncated or malformed end tag at byte ${pos}: ${JSON.stringify(text.slice(pos, pos + 20))}`);
      const open = stack.pop();
      if (!open || open.name !== m[1]) throw fail(`</${m[1]}> at byte ${pos} does not close <${open ? open.name : "nothing"}>`);
      pos = END_TAG.lastIndex;
      close(open);
    } else {
      START_TAG.lastIndex = pos;
      const m = START_TAG.exec(text);
      if (!m) throw stack.length ? fail(`truncated or malformed tag at byte ${pos}: ${JSON.stringify(text.slice(pos, pos + 20))}`) : notAtom();
      const [, name, rawAttrs, selfClosing] = m;
      const attrs = {};
      for (const [, n, v1, v2] of rawAttrs.matchAll(ATTRIBUTE)) attrs[n] = decode(v1 ?? v2, pos);
      if (!stack.length) {
        if (rootSeen) throw fail(`a second root element <${name}> at byte ${pos}`);
        if (name !== "feed" || attrs.xmlns !== ATOM_NS) throw notAtom();
        rootSeen = true;
      } else {
        // Unprefixed names below the root are Atom only while no element redeclares the namespaces.
        for (const [n, v] of Object.entries(attrs)) {
          if (n === "xmlns" || (n.startsWith("xmlns:") && v === ATOM_NS)) throw fail(`unsupported namespace declaration ${n}="${v}" on <${name}> at byte ${pos}`);
        }
      }
      const parent = stack.at(-1);
      const el = { name };
      if (parent && parent.name === "feed" && stack.length === 1 && name === "entry") el.entry = { id: [], updated: [] };
      else if (parent && parent.entry && (name === "id" || name === "updated")) el.text = "";
      else if (parent && parent.text !== undefined) throw fail(`element <${name}> inside <${parent.name}> at byte ${pos}`);
      el.parent = parent;
      pos = START_TAG.lastIndex;
      stack.push(el);
      if (selfClosing) close(stack.pop());
    }
  }
  if (!rootSeen) throw notAtom();
  if (stack.length) throw fail(`truncated: <${stack.at(-1).name}> is not closed`);
  return entries;

  function close(el) {
    if (el.text !== undefined) el.parent.entry[el.name].push(el.text.trim());
    if (!el.entry) return;
    const n = entries.length + 1;
    for (const f of ["id", "updated"]) {
      if (el.entry[f].length !== 1) throw fail(`entry #${n} has ${el.entry[f].length} <${f}> elements, expected 1`);
    }
    const [id] = el.entry.id;
    const [updated] = el.entry.updated;
    if (!id) throw fail(`entry #${n}: <id> is empty`);
    if (Number.isNaN(Date.parse(updated))) throw fail(`entry #${n}: <updated> is not a date: ${JSON.stringify(updated)}`);
    entries.push({ id, updated });
  }
}

// Reads https://github.com/<owner>/<repo>/releases.atom (no API quota, no token).
export async function fetchReleaseFeed(owner, repo) {
  const url = `https://github.com/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/releases.atom`;
  const res = await fetch(url, { credentials: "omit", cache: "no-store" });
  if (!res.ok) throw new Error(`fetch releases feed ${url}: HTTP ${res.status}`);
  return parseReleaseFeed(await res.text());
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
