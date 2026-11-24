import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseReleaseFeed } from "../src/lib/github.js";
import { checkAll, checkRepo, importBackup, setPrereleases, setTemplate, trackedView } from "../src/lib/manager.js";
import { fakeChrome, fakeGithub, v1Backup } from "./helpers/fake-chrome.js";

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
  const gh = fakeGithub([zipRel("1.77.0")], { owner: "gorhill", repo: "uBlock", feed: ublockFeed });
  await importBackup(v1Backup([v1Record({ owner: "gorhill", repo: "uBlock" })]));
  gh.requests.length = 0;
  await checkRepo("gorhill/ublock");
  assert.equal(apiRequests(gh).length, 0);
  gh.feed = ublockFeed.replace("<updated>2026-11-24T12:02:36Z</updated>", "<updated>2026-11-24T13:00:00Z</updated>");
  await checkRepo("gorhill/ublock");
  assert.equal(apiRequests(gh).length, 1);
});
