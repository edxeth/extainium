import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import fc from "fast-check";
import { parseReleaseFeed } from "../src/lib/github.js";
import { checkAll, checkRepo, importBackup, setPrereleases, setTemplate, trackedView } from "../src/lib/manager.js";
import { atomFeed, fakeChrome, fakeGithub, v1Backup } from "./helpers/fake-chrome.js";

const v1Record = (extra = {}) => ({
  owner: "o", repo: "r", pattern: "^ext\\.zip$", includePrereleases: false, extensionId: null, keyPkcs8: null,
  installed: null, releases: null, etag: null, checkedAt: null, error: null, addedAt: 1, ...extra,
});
const pre = (n) => ({ tag: "beta" + n, prerelease: true, publishedAt: "2026-11-01T00:00:00Z", assets: [{ name: "ext.zip", bytes: new Uint8Array(1) }] });
const stable = { tag: "v1", publishedAt: "2026-10-01T00:00:00Z", assets: [{ name: "ext.zip", bytes: new Uint8Array(1) }] };
const apiRequests = (gh) => gh.requests.filter((r) => r.url.startsWith("https://api.github.com/"));

// F11: a stable release behind a full page of pre-releases is found via Link rel="next".
test("the check follows pagination until an eligible release is found", async () => {
  fakeChrome();
  const gh = fakeGithub([...Array.from({ length: 30 }, (_, i) => pre(i)), stable]);
  await importBackup(v1Backup([v1Record()]));
  const [view] = await trackedView();
  assert.equal(view.latest && view.latest.tag, "v1");
  assert.equal(apiRequests(gh).length, 2);
  assert.match(apiRequests(gh)[1].url, /page=2/);
});

// F11: pagination stops after 5 pages.
test("the check reads at most 5 pages", async () => {
  fakeChrome();
  const gh = fakeGithub([...Array.from({ length: 200 }, (_, i) => pre(i)), stable]);
  await importBackup(v1Backup([v1Record()]));
  assert.equal(apiRequests(gh).length, 5);
  const [view] = await trackedView();
  assert.equal(view.state, "no-asset");
});

// F11: each consulted page is revalidated with its own ETag; 304 pages reuse the cache.
test("a recheck sends each page's ETag and keeps the cached releases on 304", async () => {
  fakeChrome();
  const gh = fakeGithub([...Array.from({ length: 30 }, (_, i) => pre(i)), stable]);
  await importBackup(v1Backup([v1Record()]));
  gh.requests.length = 0;
  await checkRepo("o/r");
  const reqs = apiRequests(gh);
  assert.equal(reqs.length, 2);
  assert.ok(reqs.every((r) => r.headers["If-None-Match"]), "both pages are conditional");
  assert.notEqual(reqs[0].headers["If-None-Match"], reqs[1].headers["If-None-Match"]);
  const [view] = await trackedView();
  assert.equal(view.latest.tag, "v1");
  // A new stable release on page 1 changes page 1 only; the new release is found there.
  gh.releases.unshift({ tag: "v2", publishedAt: "2026-11-20T00:00:00Z", assets: [{ name: "ext.zip", bytes: new Uint8Array(1) }] });
  gh.requests.length = 0;
  await checkRepo("o/r");
  assert.equal(apiRequests(gh).length, 1);
  assert.equal((await trackedView())[0].latest.tag, "v2");
});

// F11: turning pre-releases off after a check that stopped at page 1 (it had a
// pre-release) fetches page 2 for the stable release, as a check would.
test("turning pre-releases off fetches the pages the earlier check did not read", async () => {
  fakeChrome();
  fakeGithub([...Array.from({ length: 30 }, (_, i) => pre(i)), stable]);
  await importBackup(v1Backup([v1Record({ includePrereleases: true })]));
  await setPrereleases("o/r", false);
  const [view] = await trackedView();
  assert.equal(view.latest && view.latest.tag, "v1");
});

// F11: a template typed for an asset that only an older page holds.
test("a new template that the cached pages do not match fetches further pages", async () => {
  fakeChrome();
  const old = { tag: "v0", publishedAt: "2026-09-01T00:00:00Z", assets: [{ name: "legacy.zip", bytes: new Uint8Array(1) }] };
  fakeGithub([...Array.from({ length: 30 }, (_, i) => pre(i)), stable, old]);
  await importBackup(v1Backup([v1Record({ includePrereleases: true })]));
  await setTemplate("o/r", "legacy.zip");
  const [view] = await trackedView();
  assert.equal(view.latest && view.latest.tag, "v0");
});


// ---- Item 3: the releases.atom feed decides whether the API is needed ----
// Saved with curl from https://github.com/gorhill/uBlock/releases.atom on 2026-11-24.
const ublockFeed = readFileSync(new URL("./fixtures/ublock-releases.atom", import.meta.url), "utf8");
const feedRequests = (gh) => gh.requests.filter((r) => r.url.endsWith("/releases.atom"));

// Expected entries as listed by grep on the saved file (the feed's 10 newest releases and tags).
test("the real uBlock releases.atom parses to its 10 entries with their ids and updated times, newest first", () => {
  const entries = parseReleaseFeed(ublockFeed);
  assert.equal(entries.length, 10);
  assert.deepEqual(entries[0], { id: "tag:github.com,2008:Repository/33263118/1.77.1b4", updated: "2026-11-24T12:02:36Z" });
  assert.deepEqual(entries[5], { id: "tag:github.com,2008:Repository/33263118/1.77.0", updated: "2026-11-22T18:05:49Z" });
  assert.deepEqual(entries[9], { id: "tag:github.com,2008:Repository/33263118/1.76.5b5", updated: "2026-11-19T15:53:02Z" });
});

test("a page that is not an Atom feed is rejected with an error naming it", () => {
  assert.throws(() => parseReleaseFeed("<!DOCTYPE html><html>rate limited</html>"), /parse releases feed: not an Atom feed: "<!DOCTYPE html>/);
});

const zipRel = (tag, extra = {}) => ({ tag, publishedAt: "2026-10-01T00:00:00Z", assets: [{ name: "ext.zip", bytes: new Uint8Array(1) }], ...extra });

async function feedSetup(feed = true) {
  fakeChrome();
  const gh = fakeGithub([zipRel("v1")], { feed });
  await importBackup(v1Backup([v1Record()]));
  return gh;
}

test("a recheck whose releases.atom is unchanged makes no API request", async () => {
  const gh = await feedSetup();
  gh.requests.length = 0;
  const before = (await trackedView())[0].record.checkedAt;
  await new Promise((r) => setTimeout(r, 2));
  await checkRepo("o/r");
  assert.equal(apiRequests(gh).length, 0);
  assert.equal(feedRequests(gh).length, 1);
  const [view] = await trackedView();
  assert.ok(view.record.checkedAt > before, "the check time advances");
  assert.equal(view.latest.tag, "v1");
});

test("Check all with unchanged feeds makes no API request", async () => {
  const gh = await feedSetup();
  gh.requests.length = 0;
  const { errors } = await checkAll();
  assert.deepEqual(errors, []);
  assert.equal(apiRequests(gh).length, 0);
});

test("a new release in releases.atom leads to an API check that finds it", async () => {
  const gh = await feedSetup();
  gh.releases.unshift(zipRel("v2", { publishedAt: "2026-11-01T00:00:00Z" }));
  gh.requests.length = 0;
  await checkRepo("o/r");
  assert.equal(apiRequests(gh).length, 1);
  assert.ok(apiRequests(gh)[0].headers["If-None-Match"], "the ETag is still sent");
  assert.equal((await trackedView())[0].latest.tag, "v2");
});

// GitHub moves a release's updated time (the feed's <updated>) when an asset is uploaded.
test("a changed updated time of a release in releases.atom leads to an API check", async () => {
  const gh = await feedSetup();
  gh.releases[0].updatedAt = "2026-10-01T00:05:00Z";
  gh.requests.length = 0;
  await checkRepo("o/r");
  assert.equal(apiRequests(gh).length, 1);
});

test("an unavailable releases.atom falls back to the API", async () => {
  const gh = await feedSetup();
  gh.feed = null;
  gh.requests.length = 0;
  await checkRepo("o/r");
  assert.equal(apiRequests(gh).length, 1);
  await checkRepo("o/r");
  assert.equal(apiRequests(gh).length, 2, "still unavailable: the API again");
});

test("a first check with an empty cache calls the API even though a feed is available", async () => {
  fakeChrome();
  const gh = fakeGithub([zipRel("v1")], { feed: true });
  await importBackup(v1Backup([v1Record()]));
  assert.equal(apiRequests(gh).length, 1);
  assert.equal((await trackedView())[0].latest.tag, "v1");
});

test("a selection criterion changed since the last full check calls the API although the feed is unchanged", async () => {
  const gh = await feedSetup();
  await setPrereleases("o/r", true);
  gh.requests.length = 0;
  await checkRepo("o/r");
  assert.equal(apiRequests(gh).length, 1);
  gh.requests.length = 0;
  await checkRepo("o/r");
  assert.equal(apiRequests(gh).length, 0, "after that full check the feed decides again");
});

test("with the real uBlock feed a recheck skips the API until an entry's updated time changes", async () => {
  fakeChrome();
  // The API's updated_at of 1.77.0 is the feed entry's <updated> (GitHub reports the same time in both).
  const gh = fakeGithub([zipRel("1.77.0", { updatedAt: "2026-11-22T18:05:49Z" })], { owner: "gorhill", repo: "uBlock", feed: ublockFeed });
  await importBackup(v1Backup([v1Record({ owner: "gorhill", repo: "uBlock" })]));
  gh.requests.length = 0;
  await checkRepo("gorhill/ublock");
  assert.equal(apiRequests(gh).length, 0);
  gh.feed = ublockFeed.replace("<updated>2026-11-24T12:02:36Z</updated>", "<updated>2026-11-24T13:00:00Z</updated>");
  await checkRepo("gorhill/ublock");
  assert.equal(apiRequests(gh).length, 1);
});


// ---- Round 3 F5: the feed may stand in for the API only when it covers the selection ----

// F5 repro: ten newer pre-releases push the selected stable release out of the
// ten-entry feed; a rebuild of its asset must still be seen.
test("a selected release outside the feed's ten entries is revalidated through the API", async () => {
  fakeChrome();
  const pres = Array.from({ length: 10 }, (_, i) => ({ tag: "pre" + i, prerelease: true, publishedAt: "2026-11-0" + (i % 9 + 1) + "T00:00:00Z", assets: [] }));
  const stableRel = { tag: "v1", publishedAt: "2026-10-01T00:00:00Z", assets: [{ name: "ext.zip", bytes: new Uint8Array([1]), digest: "sha256:" + "a".repeat(64) }] };
  const gh = fakeGithub([...pres, stableRel], { feed: true });
  await importBackup(v1Backup([v1Record()]));
  stableRel.assets[0].digest = "sha256:" + "b".repeat(64);
  stableRel.updatedAt = "2026-11-24T12:00:00Z";
  gh.requests.length = 0;
  await checkRepo("o/r");
  assert.equal(apiRequests(gh).length, 1);
  const [view] = await trackedView();
  assert.equal(view.latest.asset.digest, "sha256:" + "b".repeat(64));
});

// F5 (owner decision): a full API check is forced once the last one is older than 24 hours.
test("a check more than 24 hours after the last full check calls the API although the feed covers the selection", async (t) => {
  const gh = await feedSetup();
  const now0 = Date.now;
  t.after(() => { Date.now = now0; });
  gh.requests.length = 0;
  Date.now = () => now0() + 23 * 3600 * 1000;
  await checkRepo("o/r");
  assert.equal(apiRequests(gh).length, 0, "within 24 hours the feed decides");
  Date.now = () => now0() + 24 * 3600 * 1000 + 1000;
  await checkRepo("o/r");
  assert.equal(apiRequests(gh).length, 1);
});

// F5: a feed entry newer than any the last full check saw (here a tag without a
// release, which the feed also lists) calls the API, though the selected release is unchanged.
test("a feed entry newer than the last full check saw calls the API even when the selected release is unchanged", async () => {
  const gh = await feedSetup();
  gh.feed = atomFeed([{ tag: "v2-tag", updatedAt: "2026-11-01T00:00:00Z" }, ...gh.releases]);
  gh.requests.length = 0;
  await checkRepo("o/r");
  assert.equal(apiRequests(gh).length, 1);
  gh.requests.length = 0;
  await checkRepo("o/r");
  assert.equal(apiRequests(gh).length, 0, "after that full check the feed decides again");
});

// ---- Round 3 F6: the feed is parsed fully or rejected ----

const atomDoc = (entries) => `<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom">${entries}</feed>`;

// F6 repro: entries with attributes were silently skipped.
test("feed entries with attributes are read", () => {
  const feed = (n) => atomDoc(`<entry xml:lang="en"><id>release-${n}</id><updated>2026-11-24T00:00:00Z</updated></entry>`);
  assert.deepEqual(parseReleaseFeed(feed(1)), [{ id: "release-1", updated: "2026-11-24T00:00:00Z" }]);
  assert.deepEqual(parseReleaseFeed(feed(2)), [{ id: "release-2", updated: "2026-11-24T00:00:00Z" }]);
});

// XML 1.0: predefined entities, character references and CDATA sections are text.
test("entity-escaped and CDATA text in a feed entry is decoded", () => {
  const doc = atomDoc(`<entry><id>a&amp;b&lt;&#99;&#x64;<![CDATA[<e>&amp;]]></id><updated><![CDATA[2026-11-24T00:00:00Z]]></updated></entry>`);
  assert.deepEqual(parseReleaseFeed(doc), [{ id: "a&b<cd<e>&amp;", updated: "2026-11-24T00:00:00Z" }]);
});

// F6 repro: a truncated document parsed as an empty feed.
test("a truncated feed is rejected, naming the unclosed element", () => {
  assert.throws(() => parseReleaseFeed("<feed xmlns=\"http://www.w3.org/2005/Atom\"><entry><id>x</id>"), /parse releases feed: truncated: <entry> is not closed/);
});

test("a document whose root is not an Atom feed is rejected", () => {
  assert.throws(() => parseReleaseFeed("<feed><entry><id>x</id><updated>2026-11-24T00:00:00Z</updated></entry></feed>"), /parse releases feed: not an Atom feed/);
  assert.throws(() => parseReleaseFeed("<rss xmlns=\"http://www.w3.org/2005/Atom\"></rss>"), /parse releases feed: not an Atom feed/);
});

test("an entry without an id or with an updated time that is not a date is rejected, naming the entry", () => {
  assert.throws(() => parseReleaseFeed(atomDoc("<entry><updated>2026-11-24T00:00:00Z</updated></entry>")), /parse releases feed: entry #1 has 0 <id> elements/);
  assert.throws(() => parseReleaseFeed(atomDoc("<entry><id>x</id><updated>soon</updated></entry>")), /parse releases feed: entry #1: <updated> is not a date: "soon"/);
});

// F6 + F5: two different feeds that the old parser read as the same empty list.
test("a new release in a feed whose entries carry attributes leads to an API check", async () => {
  const withAttrs = (gh) => atomFeed(gh.releases).replaceAll("<entry>", '<entry xml:lang="en">');
  fakeChrome();
  const gh = fakeGithub([zipRel("v1")], { feed: "" });
  gh.feed = withAttrs(gh);
  await importBackup(v1Backup([v1Record()]));
  gh.releases.unshift(zipRel("v2", { publishedAt: "2026-11-01T00:00:00Z" }));
  gh.feed = withAttrs(gh);
  gh.requests.length = 0;
  await checkRepo("o/r");
  assert.equal(apiRequests(gh).length, 1);
  assert.equal((await trackedView())[0].latest.tag, "v2");
});

test("a truncated releases.atom falls back to the API", async () => {
  const gh = await feedSetup();
  const full = atomFeed(gh.releases);
  gh.feed = full.slice(0, full.indexOf("</entry>"));
  gh.requests.length = 0;
  await checkRepo("o/r");
  assert.equal(apiRequests(gh).length, 1);
});

// ---- Closure review F6: only GitHub's plain Atom form is accepted ----

// F6 repro (feed-prefixed-entry): a valid Atom entry under a declared prefix
// was skipped, so the shortcut missed the new release.
test("a feed whose new entry uses an Atom prefix is rejected, so the check uses the API and finds the release", async () => {
  const gh = await feedSetup();
  gh.releases.unshift(zipRel("v2", { publishedAt: "2026-11-01T00:00:00Z" }));
  gh.feed = atomFeed(gh.releases).replace("<feed xmlns=", '<feed xmlns:a="http://www.w3.org/2005/Atom" xmlns=').replace("<entry>", "<a:entry>").replace("</entry>", "</a:entry>");
  assert.throws(() => parseReleaseFeed(gh.feed), /unsupported namespace declaration xmlns:a="http:\/\/www\.w3\.org\/2005\/Atom" on <feed>/);
  gh.requests.length = 0;
  await checkRepo("o/r");
  assert.equal(apiRequests(gh).length, 1);
  assert.equal((await trackedView())[0].latest.tag, "v2");
});

// F6 repro (feed-inherited-entity): "toString" was found on the entity table's prototype.
test("an entity other than the five predefined ones is rejected, also one named like an object property", () => {
  for (const name of ["toString", "constructor", "nbsp"]) {
    const doc = atomDoc(`<entry><id>x</id><updated>2026-11-24T00:00:00Z</updated><title>&${name};</title></entry>`);
    assert.throws(() => parseReleaseFeed(doc), new RegExp(`bad character reference "&${name};"`));
  }
});

test("prefixed elements other than GitHub's declared media:*, and prefixed attributes other than xml:*, are rejected", () => {
  const entry = (inner) => `<entry><id>x</id><updated>2026-11-24T00:00:00Z</updated>${inner}</entry>`;
  const media = (entries) => `<feed xmlns="http://www.w3.org/2005/Atom" xmlns:media="http://search.yahoo.com/mrss/">${entries}</feed>`;
  assert.deepEqual(parseReleaseFeed(media(entry('<media:thumbnail height="30" width="30" url="u"/>'))), [{ id: "x", updated: "2026-11-24T00:00:00Z" }]);
  assert.throws(() => parseReleaseFeed(atomDoc(entry('<media:thumbnail url="u"/>'))), /unsupported element <media:thumbnail>/, "media: undeclared");
  assert.throws(() => parseReleaseFeed(media(entry('<x:note xmlns:x="urn:x"/>'))), /unsupported namespace declaration xmlns:x/);
  assert.throws(() => parseReleaseFeed(media(entry("<x:note/>"))), /unsupported element <x:note>/);
  assert.throws(() => parseReleaseFeed(media(entry('<title x:y="1">t</title>'))), /unsupported prefixed attribute x:y/);
  assert.throws(() => parseReleaseFeed('<feed xmlns="http://www.w3.org/2005/Atom" xmlns:media="urn:other"></feed>'), /unsupported namespace declaration xmlns:media="urn:other"/);
});

// ---- Closure review F10: the stored feed snapshot is compared entry by entry ----

// F10 repro (feed-max-misses-change): a tag-only entry with a future commit date
// stayed the newest entry while a new release appeared.
test("a new release in the feed calls the API although another entry has a later time", async () => {
  const gh = await feedSetup("");
  const tagOnly = { tag: "future-tag", updatedAt: "2027-01-01T00:00:00Z" };
  gh.feed = atomFeed([tagOnly, ...gh.releases]);
  await checkRepo("o/r");
  gh.releases.unshift(zipRel("v2", { publishedAt: "2026-11-24T12:00:00Z" }));
  gh.feed = atomFeed([tagOnly, ...gh.releases]);
  gh.requests.length = 0;
  await checkRepo("o/r");
  assert.equal(apiRequests(gh).length, 1);
  assert.equal((await trackedView())[0].latest.tag, "v2");
});

test("a feed entry that went away or changed its id calls the API", async () => {
  const gh = await feedSetup("");
  const tags = [{ tag: "t2", updatedAt: "2026-06-01T00:00:00Z" }, { tag: "t1", updatedAt: "2026-05-01T00:00:00Z" }];
  gh.feed = atomFeed([...tags, ...gh.releases]);
  await checkRepo("o/r");
  gh.requests.length = 0;
  await checkRepo("o/r");
  assert.equal(apiRequests(gh).length, 0, "unchanged: the feed decides");
  gh.feed = atomFeed([tags[0], ...gh.releases]);
  await checkRepo("o/r");
  assert.equal(apiRequests(gh).length, 1, "an entry went away");
  gh.feed = atomFeed([{ tag: "t3", updatedAt: "2026-06-01T00:00:00Z" }, ...gh.releases]);
  await checkRepo("o/r");
  assert.equal(apiRequests(gh).length, 2, "an entry changed its id");
});

// ---- Round 3 F9: property test of the Atom parser against the generator's own entries ----

const XML_ESCAPES = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" };
// Text as XML character data: each code point literal (when allowed), as a
// predefined entity, or as a decimal or hex character reference, by choice.
function escapeText(s, choices) {
  let out = "";
  let i = 0;
  for (const ch of s) {
    const c = choices.length ? choices[i++ % choices.length] : 0;
    const cp = ch.codePointAt(0);
    if (c === 0 && !XML_ESCAPES[ch]) out += ch;
    else if (c <= 1) out += XML_ESCAPES[ch] || ch;
    else if (c === 2) out += `&#${cp};`;
    else out += `&#x${cp.toString(16)};`;
  }
  return out;
}
// One element's text: escaped, in a CDATA section (when it holds no "]]>"), or split around a comment.
function encodeText(s, { mode, choices }) {
  if (mode === "cdata" && !s.includes("]]>")) return `<![CDATA[${s}]]>`;
  if (mode === "split" && s.length > 1) {
    const cut = [...s].length >> 1;
    const cps = [...s];
    return escapeText(cps.slice(0, cut).join(""), choices) + "<!-- x -->" + `<![CDATA[${cps.slice(cut).join("").replaceAll("]]>", "]]]]><![CDATA[>")}]]>`;
  }
  return escapeText(s, choices);
}
const attr = fc.tuple(fc.constantFrom("xml:lang", "data-x", "rel", "type"), fc.string({ maxLength: 8 }), fc.constantFrom('"', "'"), fc.constantFrom("", " "))
  .map(([n, v, q, sp]) => ` ${n}${sp}=${sp}${q}${escapeText(v, [1])}${q}`);
const attrs = fc.uniqueArray(attr, { maxLength: 2, selector: (a) => a.trim().split(/\s*=/)[0] }).map((a) => a.join(""));
const textChars = fc.constantFrom("a", "Z", "0", ":", "/", ".", "-", " ", "<", ">", "&", "'", '"', "]", "é", "€", "😀", ";", "#");
const encoding = fc.record({ mode: fc.constantFrom("escape", "cdata", "split"), choices: fc.array(fc.integer({ min: 0, max: 3 }), { maxLength: 4 }) });
const entryGen = fc.record({
  id: fc.string({ unit: textChars, minLength: 1, maxLength: 24 }).map((s) => s.trim()).filter((s) => s.length > 0),
  updated: fc.date({ min: new Date("2000-01-01T00:00:00Z"), max: new Date("2100-01-01T00:00:00Z"), noInvalidDate: true }).map((d) => d.toISOString().replace(/\.\d{3}Z$/, "Z")),
  idEnc: encoding, updatedEnc: encoding,
  entryAttrs: attrs, idAttrs: attrs,
  extras: fc.subarray(["link", "title", "content", "thumb", "author"]),
  idFirst: fc.boolean(),
});
function entryXml(e) {
  const extra = {
    link: `<link rel="alternate" type="text/html" href="https://github.com/o/r/releases/tag/x&amp;y"/>`,
    title: `<title>${escapeText(e.id, [1])}</title>`,
    content: `<content type="html">&lt;p&gt;notes &lt;id&gt;fake&lt;/id&gt;&lt;/p&gt;</content>`,
    thumb: `<media:thumbnail height="30" width="30" url="https://avatars.example/u/1?s=60&amp;v=4"/>`,
    author: "<author><name>someone</name></author>",
  };
  const id = `<id${e.idAttrs}>${encodeText(e.id, e.idEnc)}</id>`;
  const updated = `<updated>${encodeText(e.updated, e.updatedEnc)}</updated>`;
  const parts = e.idFirst ? [id, updated] : [updated, id];
  return `<entry${e.entryAttrs}>\n  ${[e.extras.includes("link") ? extra.link : "", parts[0], ...e.extras.filter((x) => x !== "link").map((x) => extra[x]), parts[1]].join("\n  ")}\n</entry>`;
}
const feedGen = fc.record({ entries: fc.array(entryGen, { maxLength: 6 }), prolog: fc.boolean(), comment: fc.boolean() }).map(({ entries, prolog, comment }) => ({
  entries,
  doc: (prolog ? '<?xml version="1.0" encoding="UTF-8"?>\n' : "")
    + (comment ? "<!-- generated -->\n" : "")
    + '<feed xmlns="http://www.w3.org/2005/Atom" xmlns:media="http://search.yahoo.com/mrss/" xml:lang="en-US">\n'
    + "<id>tag:github.com,2008:https://github.com/o/r/releases</id>\n<title>Release notes from r</title>\n<updated>2026-01-01T00:00:00Z</updated>\n"
    + entries.map(entryXml).join("\n")
    + "\n</feed>\n",
}));

test("property: a generated Atom feed with attributes, escapes and CDATA parses to exactly its entries", () => {
  fc.assert(fc.property(feedGen, ({ entries, doc }) => {
    assert.deepEqual(parseReleaseFeed(doc), entries.map((e) => ({ id: e.id, updated: e.updated })));
  }), { numRuns: 300 });
});

test("property: every truncation of a generated Atom feed before its closing </feed> is rejected", () => {
  fc.assert(fc.property(feedGen, fc.double({ min: 0, max: 1, noNaN: true, maxExcluded: true }), ({ doc }, at) => {
    const end = doc.lastIndexOf("</feed>") + "</feed>".length;
    const cut = Math.floor(at * end);
    assert.throws(() => parseReleaseFeed(doc.slice(0, cut)), /^Error: parse releases feed: /);
  }), { numRuns: 300 });
});

