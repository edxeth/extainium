// The extension pages' decisions (src/ui-logic.js), fed with real trackedView
// entries where they judge records (closure review F15: regression tests for
// F1, F5, F6, F7, F12 and F14 of the sources reviews).

import { test } from "node:test";
import assert from "node:assert/strict";
import fc from "fast-check";
import * as manager from "../src/lib/manager.js";
import { newRecord, newSourceRecord } from "../src/lib/store.js";
import { CWS_ORIGINS } from "../src/lib/sources.js";
import { updatesXml } from "../scripts/release-files.js";
import { addOrigins, askOrigins, cardId, checkLine, offersInstall, popupSummary } from "../src/ui-logic.js";
import { fakeChrome, fakeGithub } from "./helpers/fake-chrome.js";
import { JUST_BLACK, REAL_APPS, fakeUpdateServers, fixtureText } from "./helpers/fake-update.js";

const { checkAll, checkRepo, removeRepo, setTemplate, trackInstalled, trackedView } = manager;
const ID = "a".repeat(32);
const MV2_UBO = "cjpalhdlnbpafiamejdnhcphjbkeiagm"; // the store answers noupdate (fixture)
const RSA_ID = JSON.parse(fixtureText("crx-fixtures.json"))["signed-rsa.crx"];
const SELF_URL = "https://example.org/ext/update.xml";
const CWS_URL = "https://clients2.google.com/service/update2/crx";

function profile(extensions = []) {
  const env = fakeChrome({ extensions });
  env.store.schema = 2;
  env.setPlatform("android");
  for (const o of CWS_ORIGINS) env.granted.add(o);
  env.granted.add("https://example.org/*");
  fakeGithub([]);
  return env;
}

// ---- F1: Add requests the store's hosts in its gesture ----

test("the Add form requests the store's hosts for a bare ID and both store link forms, nothing for a GitHub repo", () => {
  for (const input of [ID, `https://chromewebstore.google.com/detail/name/${ID}`, `https://chrome.google.com/webstore/detail/name/${ID}`]) {
    assert.deepEqual(addOrigins(input), CWS_ORIGINS, input);
  }
  for (const input of ["gorhill/uBlock", "https://github.com/gorhill/uBlock", "not a source"]) assert.deepEqual(addOrigins(input), [], input);
});

test("asking for origins requests them at once; a decline stops Add and Track, while Check and Install go on", async () => {
  const calls = [];
  const answer = (granted) => (req) => { calls.push(req); return Promise.resolve(granted); };
  const asked = askOrigins(answer(false), CWS_ORIGINS, { required: true });
  assert.deepEqual(calls, [{ origins: CWS_ORIGINS }], "requested synchronously, inside the gesture");
  await assert.rejects(asked, /^Error: grant access: clients2\.google\.com, clients2\.googleusercontent\.com was not granted$/);
  assert.equal(await askOrigins(answer(true), CWS_ORIGINS, { required: true }), true);
  // F12: a declined (possibly stale) redirect origin does not block a check; the lib reports what it needs.
  assert.equal(await askOrigins(answer(false), ["https://old.example.net/*"], { required: false }), false);
  calls.length = 0;
  assert.equal(await askOrigins(answer(false), [], { required: true }), true);
  assert.deepEqual(calls, [], "nothing to ask");
});

// ---- F7: the Installed tab's link finds the right card ----

test("card ids differ for every two record keys, also where GitHub names differ only in - and /", () => {
  assert.notEqual(cardId("a/b-c"), cardId("a-b/c"));
  const key = fc.oneof(
    fc.tuple(fc.stringMatching(/^[a-z0-9_.-]{1,8}$/), fc.stringMatching(/^[a-z0-9_.-]{1,8}$/)).map(([o, r]) => `${o}/${r}`),
    fc.stringMatching(/^[a-p]{32}$/).map((id) => `cws:${id}`),
    fc.string(),
  );
  fc.assert(fc.property(key, key, (a, b) => a === b || cardId(a) !== cardId(b)));
  fc.assert(fc.property(key, (k) => /^card-[A-Za-z0-9_]*$/.test(cardId(k))));
});

// ---- F6: a card offers an install only for a downloadable build ----

test("a self-hosted record whose server answers noupdate offers no Reinstall; one with an update offers it", async () => {
  profile([{ id: RSA_ID, version: "0.9", name: "Example", enabled: true, installType: "normal", updateUrl: SELF_URL }]);
  const noupdate = `<?xml version="1.0"?><gupdate xmlns="http://www.google.com/update2/response" protocol="2.0"><app appid="${RSA_ID}"><updatecheck status="noupdate"/></app></gupdate>`;
  fakeUpdateServers({ files: { [SELF_URL]: noupdate } });
  await trackInstalled(RSA_ID);
  let [view] = await trackedView();
  assert.deepEqual([view.state, offersInstall(view)], ["current", false]);
  fakeUpdateServers({ files: { [SELF_URL]: updatesXml({ appid: RSA_ID, version: "1.0", codebase: "https://example.org/ext/x.crx" }) } });
  await checkRepo(`url:${RSA_ID}`);
  [view] = await trackedView();
  assert.deepEqual([view.state, offersInstall(view)], ["update", true]);
  assert.equal(offersInstall({ ...view, state: "identity-change" }), false, "an identity change is confirmed first");
});

// ---- F5: the popup does not call a not-offered record up to date ----

test("the popup summary counts a store record the server offers no build of as needing attention", async () => {
  profile([{ id: MV2_UBO, version: "1.62.0", name: "uBlock Origin", enabled: true, installType: "normal", updateUrl: CWS_URL }]);
  fakeUpdateServers({ cws: { [MV2_UBO]: REAL_APPS.get(MV2_UBO) } });
  await trackInstalled(MV2_UBO);
  const view = await trackedView();
  const summary = popupSummary(view);
  assert.deepEqual([summary.state, summary.attention.map((v) => v.key), summary.headline], ["attention", [`cws:${MV2_UBO}`], "1 extension needs attention"]);
  assert.equal(popupSummary([]).state, "empty");
});

// ---- F14: the error count follows the records' current errors ----

test("the last-check line counts the records' current errors after a card's check, a template fix and a removal", async () => {
  const env = profile();
  const DARK_READER = "eimadpbcbfnmbkopoojfekhnkhdbieeh";
  env.store[`repo:cws:${JUST_BLACK}`] = newSourceRecord("cws", JUST_BLACK);
  env.store[`repo:cws:${DARK_READER}`] = newSourceRecord("cws", DARK_READER);
  env.store["repo:o/r"] = newRecord("o", "r");
  const when = (at) => `at ${at}`;
  const github = globalThis.fetch;
  globalThis.fetch = async (input, init) => (String(input).startsWith("https://api.github.com/repos/o/r/") ? new Response("down", { status: 503 }) : github(input, init));
  fakeUpdateServers({ status: 503 });
  await checkAll();
  const { lastCheck } = await chrome.storage.local.get("lastCheck");
  assert.equal(checkLine(lastCheck, await trackedView(), when), `Last checked at ${lastCheck.at} · 3 errors`);
  // Closure review repro (lastcheck-stale.mjs): a new template clears the record's error.
  await setTemplate("o/r", "ext-{version}.zip");
  assert.match(checkLine(env.store.lastCheck, await trackedView(), when), / · 2 errors$/);
  fakeUpdateServers({ cws: { [JUST_BLACK]: REAL_APPS.get(JUST_BLACK) } });
  await checkRepo(`cws:${JUST_BLACK}`);
  assert.match(checkLine(env.store.lastCheck, await trackedView(), when), / · 1 error$/);
  await removeRepo(`cws:${DARK_READER}`);
  assert.equal(checkLine(env.store.lastCheck, await trackedView(), when), `Last checked at ${lastCheck.at}`);
  assert.equal(checkLine(null, [], when), "Not checked yet. Checks run every 6 hours.");
});
