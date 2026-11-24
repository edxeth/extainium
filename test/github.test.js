import { test } from "node:test";
import assert from "node:assert/strict";
import { checkRepo, importBackup, setPrereleases, setTemplate, trackedView } from "../src/lib/manager.js";
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
