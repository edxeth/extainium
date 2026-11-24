// Redirects of update-server and CRX fetches (src/lib/net.js fetchFrom) and the
// host permissions a record asks for after them (closure review F2, F10, F12).
// Chromium follows a redirect of an extension's fetch to a host it holds a
// permission for, or to one that answers with permissive CORS, also over http;
// otherwise fetch fails with a bare "Failed to fetch", and
// webRequest.onBeforeRedirect may report the hops after that (fake-update.js).

import { test } from "node:test";
import assert from "node:assert/strict";
import * as manager from "../src/lib/manager.js";
import { redirectTiming } from "../src/lib/net.js";
import { CWS_ORIGINS } from "../src/lib/sources.js";
import { updatesXml } from "../scripts/release-files.js";
import { fakeChrome, fakeGithub } from "./helpers/fake-chrome.js";
import { fakeUpdateServers, fixtureBytes, fixtureText } from "./helpers/fake-update.js";

const { checkRepo, installRelease, trackInstalled, trackedView } = manager;
const RSA_CRX = fixtureBytes("signed-rsa.crx"); // manifest version 1.0
const RSA_ID = JSON.parse(fixtureText("crx-fixtures.json"))["signed-rsa.crx"];
const SELF_URL = "https://example.org/ext/update.xml";
const KEY = `url:${RSA_ID}`;
// A failed fetch waits this long for late redirect events (the default is 2 s).
redirectTiming.waitMs = 300;

function profile() {
  const env = fakeChrome({ extensions: [{ id: RSA_ID, version: "0.9", name: "Example", enabled: true, installType: "normal", updateUrl: SELF_URL }] });
  env.store.schema = 2;
  env.setPlatform("android");
  for (const o of CWS_ORIGINS) env.granted.add(o);
  env.granted.add("https://example.org/*");
  fakeGithub([]);
  return env;
}
const feed = (codebase = "https://example.org/ext/x.crx") => updatesXml({ appid: RSA_ID, version: "1.0", codebase });
const records = (env) => Object.keys(env.store).filter((k) => k.startsWith("repo:"));

// ---- F10: the https boundary holds for every hop, also when the fetch succeeds ----

test("a check whose redirect to http succeeds through permissive CORS is refused before its answer is read, with and without webRequest", async () => {
  for (const webRequest of [true, false]) {
    const env = profile();
    if (!webRequest) delete globalThis.chrome.webRequest;
    const insecure = "http://example.org/ext/update.xml";
    fakeUpdateServers({ redirects: { [SELF_URL]: insecure }, cors: [insecure], files: { [insecure]: feed() } });
    await assert.rejects(trackInstalled(RSA_ID),
      new RegExp(`^Error: check ${KEY}: example\\.org redirects to http://example\\.org/ext/update\\.xml, which is not an https URL$`), `webRequest ${webRequest}`);
    assert.deepEqual(records(env), [], "no permission helps: the new record goes");
  }
});

test("a CRX download whose redirect chain passes an http hop is refused although the last hop is https; nothing is handed off", async () => {
  const env = profile();
  const codebase = "https://example.org/ext/x.crx";
  const hop = "http://plain.example.net/x.crx";
  const last = "https://objects.example.net/x.crx";
  env.granted.add("https://objects.example.net/*");
  fakeUpdateServers({ files: { [SELF_URL]: feed(codebase), [last]: RSA_CRX }, redirects: { [codebase]: hop, [hop]: last }, cors: [hop] });
  await trackInstalled(RSA_ID);
  await assert.rejects(installRelease(KEY),
    new RegExp(`^Error: download ${KEY} 1\\.0: example\\.org redirects to http://plain\\.example\\.net/x\\.crx, which is not an https URL$`));
  assert.equal(env.handedOff.length, 0);
});

// ---- F2: late redirect events; the last hop is judged ----

// Closure review repro (redirect-race.mjs): the first hop's event arrives before
// fetch rejects, its host is granted; the ungranted last hop's event comes 20 ms later.
test("a redirect chain whose ungranted last hop is reported after the fetch failed names that hop and keeps the new record", async () => {
  const env = profile();
  env.granted.add("https://mid.example.net/*");
  const middle = "https://mid.example.net/feed";
  const dest = "https://last.example.net/feed";
  globalThis.fetch = async (input) => {
    const event = chrome.webRequest.onBeforeRedirect;
    event.dispatch({ requestId: "1", url: String(input), redirectUrl: middle });
    setTimeout(() => event.dispatch({ requestId: "1", url: middle, redirectUrl: dest }), 20);
    throw new TypeError("Failed to fetch");
  };
  await assert.rejects(trackInstalled(RSA_ID),
    new RegExp(`^Error: check ${KEY}: example\\.org redirects to last\\.example\\.net, and there is no host permission for https://last\\.example\\.net/\\*$`));
  const [view] = await trackedView();
  assert.equal(view.key, KEY, "the record is kept");
  assert.deepEqual(view.needsOrigins, ["https://last.example.net/*"]);
});

test("a redirect whose failing hop is never reported asks for https://*/* and keeps the new record (a permission may be missing)", async () => {
  const env = profile();
  env.granted.add("https://mid.example.net/*");
  globalThis.fetch = async (input) => {
    chrome.webRequest.onBeforeRedirect.dispatch({ requestId: "1", url: String(input), redirectUrl: "https://mid.example.net/feed" });
    throw new TypeError("Failed to fetch");
  };
  await assert.rejects(trackInstalled(RSA_ID),
    new RegExp(`^Error: check ${KEY}: example\\.org redirects to a host the browser does not name; there is no host permission for https://\\*/\\*$`));
  assert.deepEqual(records(env), [`repo:${KEY}`]);
  assert.deepEqual((await trackedView())[0].needsOrigins, ["https://*/*"]);
});

// ---- F12: the remembered redirect origins are the last result's only ----

// Closure review repro (redirect-stale.mjs).
test("after the server stops redirecting, the record no longer asks for the old redirect host", async () => {
  const env = profile();
  const old = "https://old.example.net/feed";
  fakeUpdateServers({ redirects: { [SELF_URL]: old }, files: { [old]: feed() } });
  await assert.rejects(trackInstalled(RSA_ID), /redirects to old\.example\.net/);
  assert.deepEqual((await trackedView())[0].needsOrigins, ["https://old.example.net/*"]);
  env.granted.add("https://old.example.net/*");
  await checkRepo(KEY);
  fakeUpdateServers({ files: { [SELF_URL]: feed() } });
  env.granted.delete("https://old.example.net/*");
  assert.deepEqual((await trackedView())[0].needsOrigins, [], "the last check succeeded: nothing to ask for");
  await checkRepo(KEY);
  const [view] = await trackedView();
  assert.deepEqual([view.record.error, view.needsOrigins, view.record.redirectOrigins], [null, [], []]);
});

test("a new redirect destination replaces the remembered one instead of adding to it", async () => {
  profile();
  const a = "https://a.example.net/feed";
  const b = "https://b.example.net/feed";
  fakeUpdateServers({ redirects: { [SELF_URL]: a }, files: { [a]: feed() } });
  await assert.rejects(trackInstalled(RSA_ID), /redirects to a\.example\.net/);
  fakeUpdateServers({ redirects: { [SELF_URL]: b }, files: { [b]: feed() } });
  await assert.rejects(checkRepo(KEY), /redirects to b\.example\.net/);
  assert.deepEqual((await trackedView())[0].needsOrigins, ["https://b.example.net/*"]);
});
