// Sources other than GitHub releases: the Chrome Web Store (CWS) and
// self-hosted update URLs (an installed extension's manifest update_url).
// Pure parsing and URL building here; the operations are in manager.js.
//   parseSourceInput: what the add field accepts (owner/repo, GitHub links,
//     CWS links, bare extension IDs)
//   parseUpdateManifest / readUpdatecheck: the gupdate XML (protocol 2.0)
//     that both kinds of update server answer with
//   cwsCheckBatches / updateUrlCheckUrl: the update-check request URLs
//   originOf: the host permission a URL needs

import { parseRepo } from "./releases.js";
import { readEntry } from "./zip.js";

export const CWS_UPDATE_URL = "https://clients2.google.com/service/update2/crx";
// Hosts of the CWS update check and of the CRX downloads it points to
// (codebase https://clients2.googleusercontent.com/crx/blobs/...).
export const CWS_ORIGINS = ["https://clients2.google.com/*", "https://clients2.googleusercontent.com/*"];
// Titanium's bundled helper extension: provided by the browser, never tracked.
export const TITANIUM_HELPER_ID = "jlbggdgofbcndkkdimpeccablefilpkm";
// The update server's limit is the URL length (~8 KB measured), not a count of IDs.
export const CWS_MAX_URL_LENGTH = 7000;


// The extension ID of a CWS detail link, or null when url is not a CWS item
// link. New store: chromewebstore.google.com/detail/[<slug>/]<id>[/...]; old
// store: chrome.google.com/webstore/detail/[<slug>/]<id>[/...]. Throws when
// it is a store link without an ID in that place.
function cwsLinkId(url, raw) {
  const host = url.hostname.toLowerCase();
  const parts = url.pathname.split("/").filter(Boolean);
  let rest;
  if (host === "chromewebstore.google.com") rest = parts[0] === "detail" ? parts.slice(1) : null;
  else if (host === "chrome.google.com" && parts[0] === "webstore") rest = parts[1] === "detail" ? parts.slice(2) : null;
  else return null;
  // [<id>, ...] or [<slug>, <id>, ...]
  const id = rest && [rest[0], rest[1]].find((p) => p !== undefined && /^[a-p]{32}$/i.test(p));
  if (!id) throw new Error(`parse source: no extension ID (32 letters a-p) in the Chrome Web Store link "${raw}"`);
  return id.toLowerCase();
}

// "owner/repo", a github.com URL, a CWS link or a bare extension ID ->
// { source: "github", owner, repo } | { source: "cws", id } (id lowercase).
// Errors name the input: "parse source: ..." for store links and ID-like
// input, parseRepo's "parse repo: ..." for everything else.
export function parseSourceInput(text) {
  const raw = String(text).trim();
  if (/^[a-p]{32}$/i.test(raw)) return { source: "cws", id: raw.toLowerCase() };
  if (/^[a-z]{32}$/i.test(raw)) throw new Error(`parse source: "${raw}" is not an extension ID: an ID has 32 letters a-p`);
  let url = null;
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : "https://" + raw);
  } catch {
    url = null;
  }
  if (url && /^https?:$/.test(url.protocol)) {
    const id = cwsLinkId(url, raw);
    if (id) return { source: "cws", id };
  }
  return { source: "github", ...parseRepo(raw) };
}

// The origin pattern ("https://host/*") that an http(s) URL needs as a host permission.
export function originOf(url) {
  const u = new URL(url);
  return `${u.protocol}//${u.hostname}/*`;
}

// True when url's host and path are the CWS update service (any query).
export function isCwsUpdateUrl(url) {
  try {
    const u = new URL(url);
    return u.hostname === "clients2.google.com" && u.pathname === "/service/update2/crx";
  } catch {
    return false;
  }
}

const xParam = (id, version) => `x=${encodeURIComponent(`id=${id}&v=${version}&uc`)}`;

// The CWS update-check URLs for ids: [{ url, ids }], each URL at most
// maxLength characters, every ID in exactly one, in order. v=0.0.0.0, so the
// answer always describes the newest build, and "noupdate" means that the
// store offers no build to this browser.
export function cwsCheckBatches(ids, browserVersion, maxLength = CWS_MAX_URL_LENGTH) {
  const base = `${CWS_UPDATE_URL}?response=updatecheck&acceptformat=crx3&prodversion=${encodeURIComponent(browserVersion)}`;
  const batches = [];
  let cur = null;
  for (const id of ids) {
    const part = "&" + xParam(id, "0.0.0.0");
    if (base.length + part.length > maxLength) throw new Error(`check Chrome Web Store: extension ${id} does not fit a URL of ${maxLength} characters`);
    if (!cur || cur.url.length + part.length > maxLength) {
      cur = { url: base, ids: [] };
      batches.push(cur);
    }
    cur.url += part;
    cur.ids.push(id);
  }
  return batches;
}

// The update check of a self-hosted extension: updateUrl with x=id=..&v=..&uc
// appended; its own query is kept as written, its fragment dropped.
export function updateUrlCheckUrl(updateUrl, id, version) {
  const base = String(updateUrl).replace(/#[^]*$/, "");
  const sep = !base.includes("?") ? "?" : /[?&]$/.test(base) ? "" : "&";
  return base + sep + xParam(id, version);
}

// ---- gupdate XML (protocol 2.0) ----

const GUPDATE_NS = "http://www.google.com/update2/response";
const XML_ENTITIES = { lt: "<", gt: ">", amp: "&", quot: '"', apos: "'" };
const NAME = "[A-Za-z_][A-Za-z0-9_.-]*(?::[A-Za-z_][A-Za-z0-9_.-]*)?";
// XML's whitespace (production S): space, tab, CR and LF only. JavaScript's
// \s also matches no-break and other Unicode spaces, which XML refuses there.
const S = "[ \\t\\r\\n]";
const START_TAG = new RegExp(`<(${NAME})((?:${S}+${NAME}${S}*=${S}*(?:"[^"<]*"|'[^'<]*'))*)${S}*(/?)>`, "y");
const END_TAG = new RegExp(`</(${NAME})${S}*>`, "y");
const ATTRIBUTE = new RegExp(`(${NAME})${S}*=${S}*(?:"([^"<]*)"|'([^'<]*)')`, "g");
// The XML declaration: version 1.0, optionally UTF-8 and standalone.
const XML_DECL = new RegExp(`^<\\?xml${S}+version${S}*=${S}*(["'])1\\.0\\1(?:${S}+encoding${S}*=${S}*(["'])[Uu][Tt][Ff]-8\\2)?(?:${S}+standalone${S}*=${S}*(["'])(?:yes|no)\\3)?${S}*\\?>`);
// A character outside XML 1.0's Char production.
const NOT_XML_CHAR = /[^\t\n\r\u0020-\ud7ff\ue000-\ufffd\u{10000}-\u{10ffff}]/u;
// The children each element may have; any other element is refused.
const CHILDREN = { gupdate: ["daystart", "app"], daystart: [], app: ["updatecheck"], updatecheck: [] };

// Parses an update manifest strictly: the gupdate document that Chromium's
// updater reads (safe_manifest_parser.cc) and the CWS and self-hosted servers
// send. Accepted: an XML declaration, comments, whitespace, single- or
// double-quoted attributes, the five predefined entities and character
// references; a <gupdate xmlns="http://www.google.com/update2/response"
// protocol="2.0"> root holding <daystart/> and <app appid> elements, each app
// holding at most one empty <updatecheck/>. Refused: anything else (a
// DOCTYPE, CDATA, text, other elements, other namespaces or prefixes, a
// duplicate attribute or appid, a truncated document). Unknown attributes
// (_esbAllowlist, cohort, ...) are kept but not interpreted. Attribute
// values are normalised as XML requires (a literal tab or newline is a space).
// Returns { apps: [{ appid, status (null when absent), updatecheck: null |
// { status, codebase, version, size, hash (hash_sha256), malware
// (_malware="true"), attrs (every attribute) } }] }, values as decoded
// strings or null.
export function parseUpdateManifest(text) {
  const fail = (msg) => new Error(`parse update manifest: ${msg}`);
  if (typeof text !== "string") throw fail(`not text: ${typeof text}`);
  const src = text.replace(/^\ufeff/, "").replace(/\r\n?/g, "\n");
  const bad = NOT_XML_CHAR.exec(src);
  if (bad) throw fail(`character U+${bad[0].codePointAt(0).toString(16).toUpperCase().padStart(4, "0")} at offset ${bad.index} is not allowed in XML`);
  const decode = (raw, at) => raw.replace(/[\t\n]/g, " ").replace(/&([^;&]*);?/g, (ref, body) => {
    let cp = null;
    if (ref.endsWith(";")) {
      if (/^#[0-9]{1,8}$/.test(body)) cp = Number(body.slice(1));
      else if (/^#x[0-9a-fA-F]{1,8}$/.test(body)) cp = parseInt(body.slice(2), 16);
      else if (Object.hasOwn(XML_ENTITIES, body)) return XML_ENTITIES[body];
    }
    const ch = cp !== null && cp <= 0x10ffff ? String.fromCodePoint(cp) : null;
    if (ch === null || NOT_XML_CHAR.test(ch)) throw fail(`bad entity or character reference ${JSON.stringify(ref.slice(0, 20))} near offset ${at}`);
    return ch;
  });
  const stack = []; // open elements { name, attrs, children }
  let root = null;
  let pos = 0;
  if (/^<\?xml[ \t\n?]/.test(src)) {
    const decl = XML_DECL.exec(src);
    if (!decl) throw fail(`not a well-formed XML 1.0 UTF-8 declaration: ${JSON.stringify(src.slice(0, Math.max(src.indexOf("?>") + 2, 0) || 60))}`);
    pos = decl[0].length;
  }
  while (pos < src.length) {
    const lt = src.indexOf("<", pos);
    const chunk = src.slice(pos, lt === -1 ? src.length : lt);
    if (/[^ \t\n]/.test(chunk)) throw fail(`unexpected text at offset ${pos}: ${JSON.stringify(chunk.trim().slice(0, 30))}`);
    if (lt === -1) break;
    pos = lt;
    if (src.startsWith("<!--", pos)) {
      const end = src.indexOf("-->", pos + 4);
      if (end === -1) throw fail(`truncated: the comment at offset ${pos} is not closed`);
      if (src.slice(pos + 4, end).includes("--") || src[end - 1] === "-") throw fail(`"--" inside the comment at offset ${pos}`);
      pos = end + 3;
    } else if (src.startsWith("<!", pos) || src.startsWith("<?", pos)) {
      throw fail(`unsupported markup at offset ${pos}: ${JSON.stringify(src.slice(pos, pos + 20))}`);
    } else if (src.startsWith("</", pos)) {
      END_TAG.lastIndex = pos;
      const m = END_TAG.exec(src);
      if (!m) throw fail(`truncated or malformed end tag at offset ${pos}: ${JSON.stringify(src.slice(pos, pos + 20))}`);
      const open = stack.pop();
      if (!open || open.name !== m[1]) throw fail(`</${m[1]}> at offset ${pos} does not close <${open ? open.name : "nothing"}>`);
      pos = END_TAG.lastIndex;
    } else {
      START_TAG.lastIndex = pos;
      const m = START_TAG.exec(src);
      if (!m) throw fail(`truncated or malformed tag at offset ${pos}: ${JSON.stringify(src.slice(pos, pos + 20))}`);
      const [, name, rawAttrs, selfClosing] = m;
      // No prototype: "__proto__" and the like are attribute names like any other.
      const attrs = Object.create(null);
      for (const [, n, v1, v2] of rawAttrs.matchAll(ATTRIBUTE)) {
        if (Object.hasOwn(attrs, n)) throw fail(`attribute ${n} appears twice on <${name}> at offset ${pos}`);
        attrs[n] = decode(v1 ?? v2, pos);
      }
      const parent = stack.at(-1);
      if (!parent) {
        if (root) throw fail(`a second root element <${name}> at offset ${pos}`);
        if (name !== "gupdate") throw fail(`the root element is <${name}>, not <gupdate>`);
        if (attrs.xmlns !== GUPDATE_NS) throw fail(`<gupdate> does not declare xmlns="${GUPDATE_NS}": ${JSON.stringify(attrs.xmlns ?? null)}`);
        if (attrs.protocol !== "2.0") throw fail(`<gupdate> protocol is not "2.0": ${JSON.stringify(attrs.protocol ?? null)}`);
      } else if (!CHILDREN[parent.name].includes(name)) {
        throw fail(`unexpected element <${name}> inside <${parent.name}> at offset ${pos}`);
      }
      for (const n of Object.keys(attrs)) {
        if (n.includes(":") || (n === "xmlns" && parent)) throw fail(`unsupported attribute ${n} on <${name}> at offset ${pos}`);
      }
      const el = { name, attrs, children: [] };
      if (parent) parent.children.push(el);
      else root = el;
      pos = START_TAG.lastIndex;
      if (!selfClosing) stack.push(el);
    }
  }
  if (!root) throw fail(`no <gupdate> element: ${JSON.stringify(src.slice(0, 60))}`);
  if (stack.length) throw fail(`truncated: <${stack.at(-1).name}> is not closed`);
  const apps = [];
  const seen = new Set();
  for (const app of root.children.filter((c) => c.name === "app")) {
    const { appid, status = null } = app.attrs;
    if (typeof appid !== "string") throw fail("an <app> has no appid");
    if (seen.has(appid)) throw fail(`app ${appid} is listed twice`);
    seen.add(appid);
    if (app.children.length > 1) throw fail(`app ${appid} has ${app.children.length} <updatecheck> elements`);
    const uc = app.children.length ? app.children[0].attrs : null;
    apps.push({
      appid, status,
      updatecheck: uc && {
        attrs: uc,
        status: uc.status ?? null,
        codebase: uc.codebase ?? null,
        version: uc.version ?? null,
        size: uc.size ?? null,
        hash: uc.hash_sha256 ?? null,
        malware: uc._malware === "true",
      },
    });
  }
  return { apps };
}

const VERSION_RE = /^(0|[1-9]\d{0,4})(\.(0|[1-9]\d{0,4})){0,3}$/;
// True for a Chromium extension version: 1-4 dot-separated integers 0-65535 without leading zeros.
export const isExtensionVersion = (v) => typeof v === "string" && VERSION_RE.test(v) && v.split(".").every((p) => Number(p) <= 65535);

// The outcome of one app of an update manifest:
// { kind: "update", latest: { version, codebase, size, hash } } (size and
// hash null when not announced) or { kind: "noupdate", malware }.
// needHashAndSize: required for the CWS, which always sends both.
// Throws for an error status or a value out of shape; the caller names the
// operation in front of the message.
export function readUpdatecheck(app, { needHashAndSize = false } = {}) {
  const fail = (msg) => new Error(msg);
  if (app.status === "error-unknownApplication") throw fail("the Chrome Web Store does not know this extension (error-unknownApplication)");
  if (app.status !== null && app.status !== "ok") throw fail(`the update server answered status ${JSON.stringify(app.status)}`);
  const uc = app.updatecheck;
  if (!uc) throw fail("the update server's answer has no <updatecheck>");
  if (uc.status === "noupdate") return { kind: "noupdate", malware: uc.malware };
  if (uc.status !== null && uc.status !== "ok") throw fail(`the update server answered updatecheck status ${JSON.stringify(uc.status)}`);
  if (!isExtensionVersion(uc.version)) throw fail(`the announced version is not an extension version: ${JSON.stringify(uc.version)}`);
  let codebase = null;
  try {
    codebase = new URL(uc.codebase);
  } catch {
    codebase = null;
  }
  if (!codebase || codebase.protocol !== "https:") throw fail(`the announced codebase is not an https URL: ${JSON.stringify(uc.codebase)}`);
  if (uc.size !== null && !/^(0|[1-9]\d{0,14})$/.test(uc.size)) throw fail(`the announced size is not a number of bytes: ${JSON.stringify(uc.size)}`);
  if (uc.hash !== null && !/^[0-9a-fA-F]{64}$/.test(uc.hash)) throw fail(`the announced hash_sha256 is not 64 hex digits: ${JSON.stringify(uc.hash)}`);
  if (needHashAndSize && (uc.size === null || uc.hash === null)) throw fail(`the update server announced no ${uc.size === null ? "size" : "hash_sha256"}`);
  return {
    kind: "update",
    latest: { version: uc.version, codebase: uc.codebase, size: uc.size === null ? null : Number(uc.size), hash: uc.hash === null ? null : uc.hash.toLowerCase() },
  };
}

// The display name of a CRX manifest: "__MSG_<key>__" is resolved from
// _locales/<default_locale>/messages.json (keys case-insensitive, as in
// Chromium); null when it cannot be resolved.
export async function manifestName(manifest, entries) {
  const name = manifest && manifest.name;
  if (typeof name !== "string" || !name) return null;
  const m = /^__MSG_(\w+)__$/.exec(name);
  if (!m) return name;
  const locale = manifest.default_locale;
  const file = typeof locale === "string" ? entries.find((e) => e.name === `_locales/${locale}/messages.json`) : null;
  if (!file) return null;
  try {
    const messages = JSON.parse(new TextDecoder().decode(await readEntry(file)).replace(/^\ufeff/, ""));
    const key = Object.keys(messages).find((k) => k.toLowerCase() === m[1].toLowerCase());
    const text = key && messages[key] && messages[key].message;
    return typeof text === "string" && text ? text : null;
  } catch {
    return null;
  }
}
