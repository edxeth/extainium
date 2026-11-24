// Parsers of the CWS and update-URL sources (contract: extainium-sources-contract.md):
// parseSourceInput, parseUpdateManifest / readUpdatecheck, cwsCheckBatches, updateUrlCheckUrl.
// Expected values come from the real fixtures (test/fixtures/SOURCES.md), the
// link forms the CWS report lists, Python's XML parser (expat) as the oracle
// of the gupdate parser, and WHATWG URLSearchParams for the request URLs.

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import fc from "fast-check";
import {
  CWS_MAX_URL_LENGTH, cwsCheckBatches, parseSourceInput, parseUpdateManifest, readUpdatecheck, updateUrlCheckUrl,
} from "../src/lib/sources.js";
import { fixtureText } from "./helpers/fake-update.js";

const DR = "eimadpbcbfnmbkopoojfekhnkhdbieeh";

// ---- parseSourceInput ----

// Contract: the add field accepts CWS links (old and new store) and bare IDs; IDs are lowercased.
test("CWS links of the new and the old store and bare IDs give the extension ID", () => {
  const cases = [
    `https://chromewebstore.google.com/detail/dark-reader/${DR}`,
    `https://chromewebstore.google.com/detail/dark-reader/${DR}?hl=de&authuser=1`,
    `https://chromewebstore.google.com/detail/dark-reader/${DR}/reviews`,
    `https://chromewebstore.google.com/detail/${DR}`,
    `https://chromewebstore.google.com/detail/%E6%B2%89%E6%B5%B8/${DR}/`,
    `chromewebstore.google.com/detail/dark-reader/${DR.toUpperCase()}`,
    `https://chrome.google.com/webstore/detail/dark-reader/${DR}`,
    `https://chrome.google.com/webstore/detail/${DR}?hl=en`,
    `  ${DR}  `,
    DR.toUpperCase(),
  ];
  for (const input of cases) assert.deepEqual(parseSourceInput(input), { source: "cws", id: DR }, input);
});

test("owner/repo and GitHub links still give a GitHub source", () => {
  assert.deepEqual(parseSourceInput("gorhill/uBlock"), { source: "github", owner: "gorhill", repo: "uBlock" });
  assert.deepEqual(parseSourceInput("https://github.com/gorhill/uBlock/releases"), { source: "github", owner: "gorhill", repo: "uBlock" });
});

// Errors name the bad input.
test("a store link without a valid ID, or 32 letters outside a-p, is refused naming the input", () => {
  for (const input of [
    `https://chromewebstore.google.com/detail/dark-reader/${DR}a`,
    `https://chromewebstore.google.com/detail/dark-reader/${DR.slice(1)}`,
    `https://chromewebstore.google.com/detail/dark-reader/${DR.slice(1)}z`,
    "https://chromewebstore.google.com/search/dark",
    "https://chromewebstore.google.com/category/extensions",
    "https://chrome.google.com/webstore/category/extensions",
    "abcdefghijklmnopqrstuvwxyzabcdef",
  ]) {
    assert.throws(() => parseSourceInput(input), (e) => /^parse source: /.test(e.message) && e.message.includes(input.trim()), input);
  }
  assert.throws(() => parseSourceInput(`https://example.org/detail/x/${DR}`), /^Error: parse repo: not a github.com URL/);
});

const idArb = fc.array(fc.constantFrom(..."abcdefghijklmnop"), { minLength: 32, maxLength: 32 }).map((a) => a.join(""));
const randomCase = (s, flips) => [...s].map((c, i) => (flips[i % flips.length] ? c.toUpperCase() : c)).join("");
const linkParts = fc.record({
  scheme: fc.constantFrom("https://", "http://", ""),
  store: fc.constantFrom("chromewebstore.google.com/detail/", "chrome.google.com/webstore/detail/"),
  slug: fc.option(fc.oneof(fc.stringMatching(/^[a-z0-9-]{1,20}$/), fc.constantFrom("%E6%B2%89%E6%B5%B8", "empty-title", "u-block_origin")), { nil: null }),
  id: idArb,
  flips: fc.array(fc.boolean(), { minLength: 1, maxLength: 32 }),
  suffix: fc.constantFrom("", "/", "/reviews", "?hl=de", "?hl=de&authuser=0", "#details", "/support?x=1"),
});
const buildLink = (p, id) => `${p.scheme}${p.store}${p.slug ? p.slug + "/" : ""}${id}${p.suffix}`;

// Oracle: the generator knows the ID it put into the link.
test("property: a generated CWS link gives the ID it was built with, lowercased", () => {
  fc.assert(fc.property(linkParts, (p) => {
    assert.deepEqual(parseSourceInput(buildLink(p, randomCase(p.id, p.flips))), { source: "cws", id: p.id });
  }), { numRuns: 500 });
});

test("property: a generated CWS link whose ID has a letter outside a-p or another length is refused", () => {
  const broken = fc.tuple(linkParts, fc.nat(31), fc.constantFrom("q", "z", "Q", "1", "", "aa")).map(([p, i, c]) => ({ p, id: p.id.slice(0, i) + c + p.id.slice(i + 1) }));
  fc.assert(fc.property(broken, ({ p, id }) => {
    assert.throws(() => parseSourceInput(buildLink(p, id)), /^Error: parse source: no extension ID/);
  }), { numRuns: 300 });
});

// ---- parseUpdateManifest: real answers ----

// Values as the curl output in test/fixtures shows them.
test("the real CWS answer for three IDs gives each app's version, codebase, size and hash", () => {
  const { apps } = parseUpdateManifest(fixtureText("cws-updatecheck-3ids.xml"));
  assert.deepEqual(apps.map((a) => [a.appid, a.status, a.updatecheck.version, a.updatecheck.size]), [
    ["aghfnjkcakhmadgdomlmlhhaocbkloab", "ok", "3", "6593"],
    [DR, "ok", "4.9.135", "858730"],
    ["ddkjiahejlhfcafbddmgiahcphecmpfh", "ok", "2026.1122.1948", "9191781"],
  ]);
  const dr = readUpdatecheck(apps[1], { needHashAndSize: true });
  assert.deepEqual(dr, { kind: "update", latest: {
    version: "4.9.135",
    codebase: "https://clients2.googleusercontent.com/crx/blobs/ARGaeZJVvUOKBdgChdbwILO5Y1sy6azqCheQn9t2jyPUvlH_92yx4-sr2sJWbfEFdmgvHH2hvh0q06x7HnR4XSt7ElTB-CxUkq5O7quOfE9YldVC-jfPDZUdZ8KpTdIpKw0AxlKa5VEe-xaONeuuUcICg8WWhReI4iYQ/EIMADPBCBFNMBKOPOOJFEKHNKHDBIEEH_4_9_135_0.crx",
    size: 858730,
    hash: "0b7857ae92fd3aeab4292bb755aa0f108de6b68bc12f18d0c87fe757cdd40a9d",
  } });
});

// Contract: noupdate for v=0.0.0.0 = not offered; _malware is the store's only hint; unknown IDs are errors.
test("the real noupdate answers read as not offered (with the malware hint), the unknown ID as an error", () => {
  const [mv2, malware, unknown] = parseUpdateManifest(fixtureText("cws-noupdate-malware-unknown.xml")).apps;
  assert.deepEqual(readUpdatecheck(mv2), { kind: "noupdate", malware: false });
  assert.deepEqual(readUpdatecheck(malware), { kind: "noupdate", malware: true });
  assert.throws(() => readUpdatecheck(unknown), /does not know this extension \(error-unknownApplication\)/);
});

test("the real uBlock update.xml on jsDelivr gives its self-hosted CRX without hash or size", () => {
  const { apps } = parseUpdateManifest(fixtureText("ublock-jsdelivr-update.xml"));
  assert.deepEqual(apps.map((a) => readUpdatecheck(a)), [{ kind: "update", latest: {
    version: "1.77.0", codebase: "https://github.com/gorhill/uBlock/releases/download/1.77.0/uBlock0_1.77.0.chromium.crx", size: null, hash: null,
  } }]);
  assert.equal(apps[0].appid, "fkgkibajhfbepljeaefdnfnegdcjomkh");
  assert.throws(() => readUpdatecheck(apps[0], { needHashAndSize: true }), /announced no size/);
});

// Contract: strict XML parsing, reject unknown and truncated documents.
test("documents outside the strict gupdate form are refused", () => {
  const NS = 'xmlns="http://www.google.com/update2/response" protocol="2.0"';
  const app = '<app appid="x"><updatecheck status="noupdate"/></app>';
  const cases = [
    [`<!DOCTYPE gupdate><gupdate ${NS}/>`, /unsupported markup/],
    [`<gupdate ${NS}><![CDATA[x]]></gupdate>`, /unsupported markup/],
    [`<gupdate ${NS}>text</gupdate>`, /unexpected text/],
    [`<gupdate ${NS}><ping/></gupdate>`, /unexpected element <ping>/],
    [`<gupdate ${NS}><app appid="x"><updatecheck><urls/></updatecheck></app></gupdate>`, /unexpected element <urls>/],
    [`<gupdate ${NS}><g:app appid="x"/></gupdate>`, /unexpected element <g:app>/],
    ['<gupdate xmlns="http://example.org/" protocol="2.0"/>', /does not declare xmlns/],
    ['<gupdate xmlns="http://www.google.com/update2/response" protocol="3.0"/>', /protocol is not "2.0"/],
    [`<gupdate ${NS} xmlns:x="y"/>`, /unsupported attribute xmlns:x/],
    [`<gupdate ${NS}><app appid="x" appid="y"/></gupdate>`, /attribute appid appears twice/],
    [`<gupdate ${NS}><app appid="x"/><app appid="x"/></gupdate>`, /app x is listed twice/],
    [`<gupdate ${NS}><app appid="x"><updatecheck/><updatecheck/></app></gupdate>`, /2 <updatecheck> elements/],
    [`<gupdate ${NS}><app/></gupdate>`, /an <app> has no appid/],
    [`<gupdate ${NS}>${app}`, /truncated: <gupdate> is not closed/],
    [`<gupdate ${NS}><app appid="x"><updatecheck status="noupd`, /truncated or malformed tag/],
    [`<gupdate ${NS}/><gupdate ${NS}/>`, /a second root element/],
    [`<gupdate ${NS}><app appid="&nbsp;"/></gupdate>`, /bad entity/],
    [`<gupdate ${NS}><app appid="&#0;"/></gupdate>`, /bad entity/],
    [`<gupdate ${NS}><app appid="a&b"/></gupdate>`, /bad entity/],
    [`<gupdate ${NS}><!-- open `, /comment at offset \d+ is not closed/],
    [`<?xml version="1.1"?><gupdate ${NS}/>`, /XML 1.0 UTF-8 declaration/],
    [`<gupdate ${NS}>\u0001</gupdate>`, /U\+0001/],
    ["<feed/>", /root element is <feed>/],
    ["", /no <gupdate> element/],
  ];
  for (const [doc, error] of cases) assert.throws(() => parseUpdateManifest(doc), (e) => /^parse update manifest: /.test(e.message) && error.test(e.message), doc);
});

test("an updatecheck with an out-of-shape value is refused naming the value", () => {
  const app = (attrs) => ({ appid: "x", status: "ok", updatecheck: { status: "ok", codebase: "https://h/x.crx", version: "1.0", size: "5", hash: "a".repeat(64), malware: false, ...attrs } });
  assert.throws(() => readUpdatecheck(app({ version: "1.0-beta" })), /not an extension version: "1.0-beta"/);
  assert.throws(() => readUpdatecheck(app({ version: "1.65536" })), /not an extension version/);
  assert.throws(() => readUpdatecheck(app({ codebase: "http://h/x.crx" })), /codebase is not an https URL: "http:\/\/h\/x.crx"/);
  assert.throws(() => readUpdatecheck(app({ size: "-1" })), /size is not a number of bytes: "-1"/);
  assert.throws(() => readUpdatecheck(app({ hash: "xyz" })), /hash_sha256 is not 64 hex digits: "xyz"/);
  assert.throws(() => readUpdatecheck({ ...app({}), status: "restricted" }), /status "restricted"/);
  assert.throws(() => readUpdatecheck(app({ status: "error-osnotsupported" })), /updatecheck status "error-osnotsupported"/);
  assert.throws(() => readUpdatecheck({ appid: "x", status: "ok", updatecheck: null }), /no <updatecheck>/);
});

// ---- parseUpdateManifest against Python's expat ----

const ORACLE = `
import sys, json, xml.etree.ElementTree as ET
NS = "{http://www.google.com/update2/response}"
for line in sys.stdin:
    doc = json.loads(line)
    try:
        root = ET.fromstring(doc.encode("utf-8"))
        out = {"ok": True, "root": root.tag, "protocol": root.get("protocol"), "apps": [
            {"appid": a.get("appid"), "status": a.get("status"),
             "uc": dict(a.find(NS + "updatecheck").attrib) if a.find(NS + "updatecheck") is not None else None}
            for a in root.findall(NS + "app")]}
    except ET.ParseError as e:
        out = {"ok": False, "error": str(e)}
    print(json.dumps(out), flush=True)
`;
const py = spawn("python3", ["-u", "-c", ORACLE], { stdio: ["pipe", "pipe", "inherit"] });
const waiting = [];
createInterface({ input: py.stdout }).on("line", (line) => waiting.shift()(JSON.parse(line)));
const expat = (doc) => new Promise((resolve) => {
  waiting.push(resolve);
  py.stdin.write(JSON.stringify(doc) + "\n");
});
after(() => py.stdin.end());

// Our result in the oracle's shape; the named fields must be the attributes'.
const ours = (doc) => {
  const { apps } = parseUpdateManifest(doc);
  return apps.map(({ appid, status, updatecheck: uc }) => {
    if (uc) {
      const a = uc.attrs;
      assert.deepEqual([uc.status, uc.codebase, uc.version, uc.size, uc.hash, uc.malware],
        [a.status ?? null, a.codebase ?? null, a.version ?? null, a.size ?? null, a.hash_sha256 ?? null, a._malware === "true"]);
    }
    return { appid, status, uc: uc && uc.attrs };
  });
};

// An independent serializer: every way XML allows to write the same attribute value.
const valueChars = fc.constantFrom("a", "Z", "9", " ", "-", "/", ":", ".", "&", "<", ">", '"', "'", "\t", "\n", "é", "😀", "]]>", "=");
const escapeChar = (c, quote, style) => {
  if (c === "&") return ["&amp;", "&#38;", "&#x26;"][style % 3];
  if (c === "<") return ["&lt;", "&#60;", "&#x3C;"][style % 3];
  if (c === quote) return quote === '"' ? ["&quot;", "&#34;"][style % 2] : ["&apos;", "&#39;"][style % 2];
  if (c === ">") return [">", "&gt;"][style % 2];
  if (c === "\t" || c === "\n") return [c, `&#${c.codePointAt(0)};`][style % 2]; // a literal one normalises to a space
  if (c === "é" || c === "😀") return [c, `&#x${c.codePointAt(0).toString(16)};`][style % 2];
  return c;
};
const attrValue = fc.array(fc.tuple(valueChars, fc.nat(5)), { maxLength: 10 });
const serializeAttrs = (attrs, quote, ws) => attrs.map(([n, parts]) => `${ws}${n}=${quote}${parts.map(([c, s]) => escapeChar(c, quote, s)).join("")}${quote}`).join("");
const ws = fc.constantFrom(" ", "  ", "\n", "\t", "\r\n ");
const gap = fc.constantFrom("", "\n", "  ", "\r\n", "<!-- c -->", "\n<!-- a - b -->\n");
const UC_NAMES = ["codebase", "version", "size", "hash_sha256", "status", "fp", "_esbAllowlist", "_malware", "protected", "cohort"];
const ucArb = fc.uniqueArray(fc.tuple(fc.constantFrom(...UC_NAMES), attrValue), { maxLength: 5, selector: (a) => a[0] });
const appArb = fc.record({
  appid: attrValue, status: fc.option(attrValue, { nil: null }),
  uc: fc.option(ucArb, { nil: null }), selfClose: fc.boolean(), quote: fc.constantFrom('"', "'"), ws, gap,
});
const docArb = fc.record({
  decl: fc.constantFrom("", '<?xml version="1.0" encoding="UTF-8"?>', "<?xml version='1.0'?>\n"),
  server: fc.boolean(), daystart: fc.boolean(), quote: fc.constantFrom('"', "'"), gap,
  // Unique appids after XML's normalisation (a literal tab or newline reads as a space).
  apps: fc.uniqueArray(appArb, { maxLength: 4, selector: (a) => a.appid.map(([c, s]) => ((c === "\t" || c === "\n") && s % 2 === 0 ? " " : c)).join("") }),
});
const appXml = (a) => {
  const attrs = [["appid", a.appid], ...(a.status ? [["status", a.status]] : [])];
  const open = `<app${serializeAttrs(attrs, a.quote, a.ws)}`;
  if (!a.uc) return a.selfClose ? open + "/>" : `${open}>${a.gap}</app>`;
  const uc = `<updatecheck${serializeAttrs(a.uc, a.quote, a.ws)}${a.selfClose ? "/>" : "></updatecheck>"}`;
  return `${open}>${a.gap}${uc}${a.gap}</app>`;
};
const docXml = (d) => {
  const q = d.quote;
  const root = `<gupdate xmlns=${q}http://www.google.com/update2/response${q} protocol=${q}2.0${q}${d.server ? " server=" + q + "prod" + q : ""}>`;
  return d.decl + d.gap + root + (d.daystart ? '<daystart elapsed_days="7267"/>' : "") + d.apps.map((a) => d.gap + appXml(a)).join("") + d.gap + "</gupdate>" + d.gap;
};

test("property: a generated gupdate document parses to what Python's XML parser reads from it", async () => {
  await fc.assert(fc.asyncProperty(docArb, async (d) => {
    const doc = docXml(d);
    const ref = await expat(doc);
    assert.ok(ref.ok, `oracle rejected ${JSON.stringify(doc)}: ${ref.error}`);
    assert.deepEqual(ours(doc), ref.apps);
  }), { numRuns: 300 });
});

test("property: every proper prefix of a generated document that cuts off its root's end tag is refused", () => {
  fc.assert(fc.property(docArb, fc.nat(), (d, n) => {
    const doc = docXml(d);
    const end = doc.lastIndexOf("</gupdate>") + "</gupdate>".length;
    const cut = n % end;
    assert.throws(() => parseUpdateManifest(doc.slice(0, cut)), /^Error: parse update manifest: /);
  }), { numRuns: 500 });
});

// Differential: a single edit (insert, delete or replace one character) of a
// valid document; whatever the parser accepts, expat accepts with the same content.
test("property: a document the parser accepts after a random edit is one expat reads the same", async () => {
  const edit = fc.tuple(docArb, fc.nat(), fc.constantFrom("delete", "insert", "replace"), fc.constantFrom("<", ">", "/", '"', "'", "=", "&", ";", " ", "a", "-", "!", "?", ":", "#", "x", "\u0000"));
  await fc.assert(fc.asyncProperty(edit, async ([d, at, kind, ch]) => {
    const doc = docXml(d);
    const i = at % (doc.length + 1);
    const changed = kind === "delete" ? doc.slice(0, i) + doc.slice(i + 1) : kind === "insert" ? doc.slice(0, i) + ch + doc.slice(i) : doc.slice(0, i) + ch + doc.slice(i + 1);
    let mine;
    try {
      mine = ours(changed);
    } catch (e) {
      if (!/^parse update manifest: /.test(e.message)) throw e;
      return;
    }
    const ref = await expat(changed);
    assert.ok(ref.ok, `accepted what expat rejects (${ref.error}): ${JSON.stringify(changed)}`);
    assert.equal(ref.root, "{http://www.google.com/update2/response}gupdate");
    assert.equal(ref.protocol, "2.0");
    assert.deepEqual(mine, ref.apps);
  }), { numRuns: 600 });
});

// ---- request URLs ----

// Contract: batched GET, x=id=<id>&v=0.0.0.0&uc repeated, each URL under 7000 bytes.
test("property: CWS check batches cover every ID once, in order, each URL within the limit and decodable", () => {
  const input = fc.tuple(fc.uniqueArray(idArb, { maxLength: 400 }), fc.integer({ min: 300, max: 9000 }),
    fc.constantFrom("158.0.8127.100", "156.0.8078.79", "158.0.0.0"));
  fc.assert(fc.property(input, ([ids, max, version]) => {
    const batches = cwsCheckBatches(ids, version, max);
    assert.deepEqual(batches.flatMap((b) => b.ids), ids);
    for (const [i, b] of batches.entries()) {
      assert.ok(b.url.length <= max, `${b.url.length} > ${max}`);
      const u = new URL(b.url);
      assert.equal(u.origin + u.pathname, "https://clients2.google.com/service/update2/crx");
      assert.equal(u.searchParams.get("response"), "updatecheck");
      assert.equal(u.searchParams.get("acceptformat"), "crx3");
      assert.equal(u.searchParams.get("prodversion"), version);
      assert.deepEqual(u.searchParams.getAll("x"), b.ids.map((id) => `id=${id}&v=0.0.0.0&uc`));
      // Greedy: the next batch's first ID would not have fitted.
      if (i + 1 < batches.length) assert.ok(b.url.length + `&x=id%3D${batches[i + 1].ids[0]}%26v%3D0.0.0.0%26uc`.length > max);
    }
  }), { numRuns: 200 });
  assert.equal(CWS_MAX_URL_LENGTH, 7000);
});

test("the update-URL check appends x=id&v&uc and keeps the URL's own query as written", () => {
  const id = "fkgkibajhfbepljeaefdnfnegdcjomkh";
  assert.equal(updateUrlCheckUrl("https://cdn.jsdelivr.net/gh/gorhill/uBlock@master/dist/chromium/update.xml", id, "1.76.0"),
    `https://cdn.jsdelivr.net/gh/gorhill/uBlock@master/dist/chromium/update.xml?x=id%3D${id}%26v%3D1.76.0%26uc`);
  assert.equal(updateUrlCheckUrl("https://gitflic.ru/u.xml?ref=a%20b&p=1#frag", id, "0.0.0.0"), `https://gitflic.ru/u.xml?ref=a%20b&p=1&x=id%3D${id}%26v%3D0.0.0.0%26uc`);
  assert.equal(new URL(updateUrlCheckUrl("https://h/u.xml?", id, "1.0")).searchParams.get("x"), `id=${id}&v=1.0&uc`);
});
