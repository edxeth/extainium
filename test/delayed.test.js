// Hand-offs the browser has not confirmed. Observed on ungoogled-chromium 156
// and in a throwaway-profile experiment: after "Add extension" the installer
// deletes the downloaded CRX, but a running extension keeps its old version and
// management.onInstalled fires only once its processes are gone; after a
// browser restart the version changes without any event. A dismissed prompt
// leaves the CRX, an installer failure deletes it too, and Chromium's file
// checks are throttled, so the copy says nothing about the answer (owner
// decision, final round 2026-11-24): every unconfirmed hand-off after its
// prompt is "Not applied yet" with Install again; only the browser's evidence
// (an install event, or a version change since the hand-off) resolves it, and
// a browser start ends what it did not apply.

import { test } from "node:test";
import assert from "node:assert/strict";
import nodeCrypto from "node:crypto";
import { readFileSync } from "node:fs";
import fc from "fast-check";
import { extensionIdFromSpki, packCrx3 } from "../src/lib/crx.js";
import * as manager from "../src/lib/manager.js";
import { newRecord, newSourceRecord } from "../src/lib/store.js";
import { compareVersions } from "../src/lib/releases.js";
import { buildZip, crc32, parseZip, readManifest } from "../src/lib/zip.js";
import { offersInstall } from "../src/ui-logic.js";
import { updatesXml } from "../scripts/release-files.js";
import { fakeChrome, fakeGithub } from "./helpers/fake-chrome.js";
import { fakeUpdateServers } from "./helpers/fake-update.js";

const { installRelease, reconcileInstalls, sweepDownloads, trackedView } = manager;
const zip = new Uint8Array(readFileSync(new URL("./fixtures/ext-root.zip", import.meta.url))); // manifest version 1.0
const K = "o/r";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sha256 = (bytes) => "sha256:" + nodeCrypto.createHash("sha256").update(bytes).digest("hex");
Object.assign(manager.cleanupTiming, { retryMs: 5, settleMs: 1 });

async function crxKey() {
  const { privateKey } = nodeCrypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
  const pkcs8 = new Uint8Array(privateKey.export({ type: "pkcs8", format: "der" }));
  const spki = new Uint8Array(nodeCrypto.createPublicKey(privateKey).export({ type: "spki", format: "der" }));
  return { pkcs8, id: await extensionIdFromSpki(spki) };
}

// Another build of the same manifest version (one more file).
function rebuiltZip() {
  const data = new TextEncoder().encode("different rebuild");
  return buildZip([...parseZip(zip), { name: "new.txt", flags: 0, method: 0, mtime: 0, mdate: 0, crc: crc32(data), uncompSize: data.length, data }]);
}

// The fixture with manifest version set to version.
async function versionZip(version) {
  const entries = parseZip(zip);
  const data = new TextEncoder().encode(JSON.stringify({ ...(await readManifest(entries)), version }));
  return buildZip([...entries.filter((e) => e.name !== "manifest.json"),
    { name: "manifest.json", flags: 0, method: 0, mtime: 0, mdate: 0, crc: crc32(data), uncompSize: data.length, data }]);
}

const release = (tag, crx, n) => ({
  tag, prerelease: false, publishedAt: `2026-0${n}-01T00:00:00Z`, updatedAt: `2026-0${n}-01T00:00:00Z`, htmlUrl: "",
  assets: [{ name: "example.crx", url: `https://github.com/o/r/releases/download/${tag}/example.crx`, size: crx.length, digest: sha256(crx) }],
});

// A tracked GitHub repo whose extension runs version (0.9: record.installed
// v0; 1.0: release v1's build) with releases builds ({ tag: crx }, oldest
// first; default: v1 holds the 1.0 CRX).
async function updateSetup({ platform = "desktop", version = "0.9", builds = null, key = null } = {}) {
  key ??= await crxKey();
  builds ??= { v1: await packCrx3(zip, key.pkcs8) };
  const env = fakeChrome({ extensions: [{ id: key.id, version, name: "Example", enabled: true, installType: "normal" }] });
  env.store.schema = 2;
  env.setPlatform(platform);
  const tags = Object.keys(builds);
  fakeGithub(tags.map((tag, n) => ({ tag, publishedAt: release(tag, builds[tag], n + 1).publishedAt, assets: [{ name: "example.crx", bytes: builds[tag], digest: sha256(builds[tag]) }] })));
  env.store["repo:o/r"] = {
    ...newRecord("o", "r"), template: "example.crx", extensionId: key.id,
    installed: version === "0.9" ? { tag: "v0", digest: null, version: "0.9" } : { tag: "v1", digest: sha256(builds.v1), version: "1.0" },
    releases: tags.map((tag, n) => release(tag, builds[tag], n + 1)).reverse(),
  };
  return { env, key, crx: builds.v1, builds };
}

// Two builds of version 1.0: release v1 (a) and the rebuild v2 (b), the latest.
async function twoBuilds(opts = {}) {
  const key = await crxKey();
  const builds = { v1: await packCrx3(zip, key.pkcs8), v2: await packCrx3(rebuiltZip(), key.pkcs8) };
  return updateSetup({ ...opts, key, builds });
}

// The user answers the prompt a while after it appeared (a desktop download
// completes once the prompt is answered); accept: the installer deletes the
// copy (Chromium does this before it decides to delay the update).
function answerPrompt(env, { accept }) {
  env.hooks.beforeSet = async (obj) => {
    for (const v of Object.values(obj)) if (v && v.token && v.startedAt && !v.downloadDone) v.startedAt -= 10000;
  };
  env.onDownloadStarted = async (id) => { if (accept) env.files.get(id).exists = false; };
}

const entries = (env) => Object.values(env.store).filter((v) => v && v.token);
const entryOf = (env, tag) => entries(env).find((e) => e.installed.tag === tag);

const DAY = 24 * 60 * 60 * 1000;

// A hand-off of release tag (default: the latest) whose prompt the user answers (answerPrompt).
async function promptedUpdate(opts = {}, { accept = true, tag } = {}) {
  const s = await updateSetup(opts);
  answerPrompt(s.env, { accept });
  await installRelease(K, tag);
  await sleep(30); // the page's check of a refusal candidate (cleanupTiming)
  return s;
}

// Owner decision 1: one neutral state after the prompt, whatever happened to the copy.
test("an unconfirmed hand-off after its prompt is Not applied yet with Install again, whether its copy was deleted or kept, past the grace period and days later", async () => {
  for (const accept of [true, false]) {
    const { env } = await promptedUpdate({}, { accept });
    let [view] = await trackedView();
    assert.deepEqual([view.state, view.pendingInstall.version, offersInstall(view)], ["not-applied", "1.0", true], "accept " + accept);
    assert.equal(env.badge, "", "not counted as an update to install");
    await sweepDownloads(Date.now() + manager.PENDING_GRACE_MS + 1);
    await sweepDownloads(Date.now() + 3 * DAY);
    [view] = await trackedView();
    assert.deepEqual([view.state, view.pendingInstall.version], ["not-applied", "1.0"], "kept until browser evidence or a browser start, accept " + accept);
    assert.deepEqual(entries(env).map((e) => [e.version, e.confirmedAt]), [["1.0", null]]);
    assert.deepEqual(Object.keys(entries(env)[0]).filter((k) => /vanish|foundGone|fileRemoved/.test(k)), [], "no file-based classification is stored");
  }
});

// F6 (closure repro "idempotent desktop"): the copy is only Extainium's to delete, never evidence.
test("file checks never decide the state: a stale check and a delete that reports success for a missing file leave the entry pending until browser evidence", async () => {
  const { env, key, crx } = await updateSetup();
  answerPrompt(env, { accept: false });
  await installRelease(K);
  env.files.get(1).exists = false; // deleted by someone; the browser's throttled check has not noticed
  const search = chrome.downloads.search;
  chrome.downloads.search = async (q) => (await search(q)).map((i) => ({ ...i, exists: true }));
  chrome.downloads.removeFile = async () => {}; // desktop DeleteFile reports success for a missing path
  await sweepDownloads(Date.now() + manager.PENDING_GRACE_MS + 1);
  chrome.downloads.search = search;
  await sweepDownloads(Date.now() + 3 * DAY);
  const [e] = entries(env);
  assert.deepEqual([e && e.version, e && e.confirmedAt, e && e.fileGone], ["1.0", null, true], "kept, its copy cleaned up");
  assert.equal((await trackedView())[0].state, "not-applied");
  env.install(key.id, "1.0"); // applied while the browser started, no event
  await reconcileInstalls({ startedAt: Date.now() + 1 });
  const [view] = await trackedView();
  assert.deepEqual([view.state, view.record.installed], ["current", { tag: "v1", digest: sha256(crx), version: "1.0" }]);
  assert.deepEqual(entries(env), []);
});

test("the install event of the pending version commits it and ends the entry", async () => {
  const { env, key, crx } = await promptedUpdate();
  env.install(key.id, "1.0");
  await manager.handleExtensionInstalled({ id: key.id, version: "1.0" });
  const [view] = await trackedView();
  assert.equal(view.state, "current");
  assert.deepEqual(view.record.installed, { tag: "v1", digest: sha256(crx), version: "1.0" });
  assert.equal(view.pendingInstall, null);
  assert.deepEqual(entries(env), []);
});

// Owner decision 2: a version that changed since the hand-off resolves it, without an event.
test("a comparison after a browser restart commits a pending update the browser applied without an event", async () => {
  const { env, key, crx } = await promptedUpdate();
  await reconcileInstalls();
  assert.equal((await trackedView())[0].state, "not-applied", "not applied yet: nothing changes");
  env.install(key.id, "1.0"); // applied while the browser started
  await reconcileInstalls({ startedAt: Date.now() + 1 });
  const [view] = await trackedView();
  assert.equal(view.state, "current");
  assert.deepEqual(view.record.installed, { tag: "v1", digest: sha256(crx), version: "1.0" });
  assert.deepEqual(entries(env), []);
});

// Chromium applies pending updates while it starts: one prompted before the start and not applied never applies.
test("a browser start without the version ends the pending entry and offers the update again; a periodic comparison and an entry prompted after the start keep it", async () => {
  for (const accept of [true, false]) {
    const { env } = await promptedUpdate({}, { accept });
    const [{ promptAt }] = entries(env);
    await reconcileInstalls();
    await reconcileInstalls({ startedAt: promptAt });
    assert.equal((await trackedView())[0].state, "not-applied");
    await reconcileInstalls({ startedAt: promptAt + 1 });
    const [view] = await trackedView();
    assert.deepEqual([view.state, view.pendingInstall], ["update", null]);
    assert.equal(view.record.installed.version, "0.9");
    assert.equal(env.badge, "1", "offered again");
    assert.deepEqual(entries(env), []);
  }
});

test("a comparison ends a pending entry whose extension was uninstalled or runs a newer version, without committing it; a first install waits for the extension", async () => {
  for (const change of ["uninstalled", "newer"]) {
    const { env, key } = await promptedUpdate();
    if (change === "uninstalled") env.extensions = [];
    else env.install(key.id, "1.5");
    await reconcileInstalls();
    const [view] = await trackedView();
    assert.equal(view.pendingInstall, null, change);
    assert.equal(view.record.installed.version, "0.9", change);
    assert.deepEqual(entries(env), [], change);
  }
  // Not installed at the hand-off: its prompt may still be answered.
  const { env, key, crx } = await updateSetup({ platform: "android" });
  env.extensions = [];
  await installRelease(K);
  await reconcileInstalls();
  assert.deepEqual(entries(env).map((e) => [e.fromVersion, e.version]), [[null, "1.0"]]);
  env.install(key.id, "1.0");
  await manager.handleExtensionInstalled({ id: key.id, version: "1.0" });
  assert.deepEqual((await trackedView())[0].record.installed, { tag: "v1", digest: sha256(crx), version: "1.0" });
});

// Observed: two accepted updates while delayed; Chromium applies only the newest (one install event).
test("the install event of a newer version also ends an older pending entry of that extension", async () => {
  const { env, key } = await promptedUpdate();
  env.install(key.id, "1.1");
  await manager.handleExtensionInstalled({ id: key.id, version: "1.1" });
  assert.equal((await trackedView())[0].pendingInstall, null);
  assert.deepEqual(entries(env), []);
});

// F9 + F7 (closure repros "stale file check must not supersede", "event cannot prefer"):
// a later hand-off ends nothing, and an event names a version, not a build.
test("a later hand-off of the same version never ends an earlier one; their install event records the version without a digest and keeps the newest prompt pending", async () => {
  for (const stale of [false, true]) {
    const { env, key } = await twoBuilds({ platform: "android" });
    await installRelease(K, "v1");
    env.files.get(1).exists = false; // accepted (or its install failed); Chromium delays it
    const search = chrome.downloads.search;
    if (stale) chrome.downloads.search = async (q) => (await search(q)).map((i) => ({ ...i, exists: true }));
    await sleep(2);
    await installRelease(K, "v2"); // its prompt shows now; it may be dismissed or still open
    await sweepDownloads();
    chrome.downloads.search = search;
    assert.deepEqual([entryOf(env, "v1").version, entryOf(env, "v2").version], ["1.0", "1.0"], "the later hand-off ends nothing");
    assert.equal((await trackedView())[0].pendingInstall.tag, "v2", "the newest prompt shows");
    env.install(key.id, "1.0");
    await manager.handleExtensionInstalled({ id: key.id, version: "1.0" });
    const [view] = await trackedView();
    assert.deepEqual(view.record.installed, { tag: null, digest: null, version: "1.0" }, "either build may run: no digest is guessed");
    assert.deepEqual([entryOf(env, "v1"), entryOf(env, "v2").version, entryOf(env, "v2").fromVersion], [undefined, "1.0", "1.0"],
      "the newest prompt may still be unanswered; from now on only its own install event resolves it");
    assert.equal(view.pendingInstall.tag, "v2");
  }
});

// F7 (closure repro "version change alone"): a version change does not name the build either.
test("a version change with two builds of that version pending records the version without a digest", async () => {
  const { env, key } = await twoBuilds({ platform: "android" });
  await installRelease(K, "v1");
  env.files.get(1).exists = false; // v1 accepted
  await sleep(2);
  await installRelease(K, "v2");
  env.files.get(2).exists = false; // v2's install failed: its copy is deleted as well
  await sweepDownloads();
  env.install(key.id, "1.0"); // the browser applied v1 at its start, without an event
  await reconcileInstalls({ startedAt: Date.now() + 1 });
  const [view] = await trackedView();
  assert.deepEqual(view.record.installed, { tag: null, digest: null, version: "1.0" });
  assert.deepEqual(entries(env).filter((e) => e.version && !e.confirmedAt), [], "the browser start ends both");
});

// F7: a same-version rebuild is not proven applied by the version alone; its install event decides (digest rule).
test("a pending rebuild of the installed version is not committed by a version comparison; its install event commits it; a browser start without it offers it again", async () => {
  const { env, key, builds } = await twoBuilds({ version: "1.0" });
  answerPrompt(env, { accept: true });
  await installRelease(K); // v2, the rebuild
  await sleep(30);
  assert.equal((await trackedView())[0].state, "not-applied");
  await reconcileInstalls();
  let [view] = await trackedView();
  assert.deepEqual([view.state, view.record.installed.digest], ["not-applied", sha256(builds.v1)]);
  await manager.handleExtensionInstalled({ id: key.id, version: "1.0" });
  [view] = await trackedView();
  assert.deepEqual([view.state, view.record.installed.digest], ["current", sha256(builds.v2)], "the event commits the rebuild");
  const s = await twoBuilds({ version: "1.0" });
  answerPrompt(s.env, { accept: true });
  await installRelease(K);
  await sleep(30);
  await reconcileInstalls({ startedAt: Date.now() + 1 });
  [view] = await trackedView();
  assert.deepEqual([view.state, view.record.installed.digest, view.pendingInstall], ["update", sha256(s.builds.v1), null]);
});

// F7 (closure repro "self startup"): a start of Extainium is no install event.
test("Extainium's own pending rebuild is confirmed by its runtime update event, never by a plain start", async () => {
  const { env, key, builds } = await twoBuilds({ platform: "android", version: "1.0" });
  env.runtimeId = key.id;
  env.manifestVersion = "1.0";
  await installRelease(K, "v2");
  env.files.get(1).exists = false; // failed, or still waiting
  assert.equal(await manager.confirmOwnInstall({ reason: "chrome_update" }), false);
  assert.equal(await manager.confirmOwnInstall(undefined), false);
  assert.equal((await trackedView())[0].record.installed.digest, sha256(builds.v1), "a start is not an install event");
  assert.equal(await manager.confirmOwnInstall({ reason: "update", previousVersion: "1.0" }), true);
  assert.equal((await trackedView())[0].record.installed.digest, sha256(builds.v2), "the new instance's update event is its install event");
});

// F8 (closure repro "sweep must order"): prompt times come from the browser, never from the sweep's clock.
test("a completion the sweep recovers keeps the browser's completion time as its prompt time, for the order and the browser start", async () => {
  const { env } = await twoBuilds({ platform: "android" });
  await installRelease(K, "v1");
  const old = entryOf(env, "v1");
  env.store["install:" + old.token] = { ...old, downloadDone: false, promptAt: null }; // its page went away before recording the completion
  await sleep(5);
  await installRelease(K, "v2");
  await sleep(5);
  await sweepDownloads();
  const recovered = entryOf(env, "v1");
  assert.equal(recovered.promptAt, Date.parse(env.files.get(1).endTime));
  assert.equal((await trackedView())[0].pendingInstall.tag, "v2", "the newest prompt");
  await reconcileInstalls({ startedAt: entryOf(env, "v2").promptAt });
  assert.deepEqual([entryOf(env, "v1"), entryOf(env, "v2").version], [undefined, "1.0"], "prompted before the start: ended; after it: kept");
});

// F5: the refusal rule stays; any later evidence that an install of that extension worked retracts its banner.
test("a quick Add on desktop may raise the flag banner, but the install's event, its version change or any later install event of that extension retracts it", async () => {
  for (const how of ["event", "restart", "later event"]) {
    const { env, key } = await updateSetup();
    env.onDownloadStarted = async (id) => { env.files.get(id).exists = false; }; // answered within INSTALL_REFUSED_MS; the update waits
    await installRelease(K);
    await sleep(30);
    assert.equal(env.store.installBlocked && env.store.installBlocked.hint, "flag", how);
    assert.equal((await trackedView())[0].state, "not-applied", how);
    if (how === "event") {
      env.install(key.id, "1.0");
      await manager.handleExtensionInstalled({ id: key.id, version: "1.0" });
    } else if (how === "restart") {
      env.install(key.id, "1.0");
      await reconcileInstalls({ startedAt: Date.now() + 1 });
    } else {
      await reconcileInstalls({ startedAt: Date.now() + 1 }); // not applied: the entry ends
      assert.deepEqual(entries(env), [], how);
      env.install(key.id, "1.1");
      await manager.handleExtensionInstalled({ id: key.id, version: "1.1" });
    }
    assert.equal(env.store.installBlocked, undefined, how);
  }
});

// F11: the badge counts the updates offered; Not applied yet is not one.
test("the badge drops an update once its prompt showed and counts it again when a browser start ends it", async () => {
  for (const platform of ["desktop", "android"]) {
    const { env } = await updateSetup({ platform });
    await manager.refreshBadge();
    assert.equal(env.badge, "1", platform);
    await installRelease(K);
    await sleep(30);
    assert.deepEqual([(await trackedView())[0].state, env.badge], ["not-applied", ""], platform);
    await reconcileInstalls({ startedAt: Date.now() + 1 });
    assert.deepEqual([(await trackedView())[0].state, env.badge], ["update", "1"], platform);
  }
});

// F12 (lib side): an install from a file follows the same rules.
test("handOffState is pending for every unconfirmed file install after its prompt, confirmed by evidence, and null once ended", async () => {
  const { env, key, crx } = await updateSetup();
  answerPrompt(env, { accept: true });
  const accepted = await manager.installFile(crx, "example.crx");
  assert.equal(accepted.fromVersion, "0.9");
  await sleep(2);
  answerPrompt(env, { accept: false });
  const dismissed = await manager.installFile(crx, "example.crx");
  await sleep(30);
  assert.deepEqual([await manager.handOffState(accepted.token), await manager.handOffState(dismissed.token)], ["pending", "pending"]);
  env.install(key.id, "1.0"); // applied at a browser start, no event
  const erase = chrome.downloads.erase;
  chrome.downloads.erase = async () => { throw new Error("erase failed"); }; // keeps the resolved entries listed
  await reconcileInstalls({ startedAt: Date.now() + 1 });
  chrome.downloads.erase = erase;
  assert.equal(await manager.handOffState(accepted.token), "confirmed");
  assert.equal(await manager.handOffState(dismissed.token), null, "its prompt ended with the restart");
  assert.equal(await manager.handOffState("no-such-token"), null);
});

// F13 + owner decision 7: model of the browser. Titanium's prompt is modal (a new prompt replaces an
// unanswered one), an accepted update waits while the extension runs, Chromium applies only the
// last accepted one (with an install event when the extension goes idle, without one at a
// restart), refuses a downgrade (its copy is deleted all the same), anyone may delete a copy and
// the browser's file checks may be stale.
test("property: hand-offs, answers, deleted copies, stale file checks, install events, restarts and sweeps: current only on the browser's version, no guessed digest, no lost entry that may still apply, and the badge counts the updates offered", async () => {
  const key = await crxKey();
  const builds = { v1: await packCrx3(zip, key.pkcs8), v2: await packCrx3(rebuiltZip(), key.pkcs8), v3: await packCrx3(await versionZip("2.0"), key.pkcs8) };
  const versionOf = { v0: "0.9", v1: "1.0", v2: "1.0", v3: "2.0" };
  // Weighted towards hand-offs of version 1.0, answers and install events, so several pending builds of one version meet often.
  const step = fc.oneof(
    { arbitrary: fc.record({ op: fc.constant("handOff"), tag: fc.constantFrom("v1", "v2", "v1", "v2", "v3") }), weight: 5 },
    { arbitrary: fc.record({ op: fc.constant("accept") }), weight: 4 },
    { arbitrary: fc.record({ op: fc.constant("idle") }), weight: 3 },
    { arbitrary: fc.record({ op: fc.constant("restart") }), weight: 1 },
    { arbitrary: fc.record({ op: fc.constantFrom("dismiss", "reconcile", "stale") }), weight: 1 },
    { arbitrary: fc.record({ op: fc.constant("vanish"), i: fc.nat(7) }), weight: 1 },
    { arbitrary: fc.record({ op: fc.constant("sweep"), late: fc.constantFrom(0, manager.PENDING_GRACE_MS + 1, 3 * DAY) }), weight: 1 },
  );
  await fc.assert(
    fc.asyncProperty(fc.boolean(), fc.boolean(), fc.array(step, { minLength: 1, maxLength: 14 }), async (rebuildIsLatest, runs1, steps) => {
      const tags = rebuildIsLatest ? ["v1", "v2"] : ["v1", "v2", "v3"];
      const { env } = await updateSetup({ platform: "android", version: runs1 ? "1.0" : "0.9", key, builds: Object.fromEntries(tags.map((t) => [t, builds[t]])) });
      const latest = tags.at(-1);
      const search = chrome.downloads.search;
      let stale = false; // the browser's file check has not noticed deleted copies
      chrome.downloads.search = async (q) => (await search(q)).map((i) => (stale ? { ...i, exists: true } : i));
      await manager.refreshBadge();
      let applied = runs1 ? "v1" : "v0"; // the build Chromium runs
      let waiting = null; // the accepted prompt Chromium applies later
      const prompts = []; // { token, tag, downloadId, answer }
      const open = () => (prompts.at(-1) && prompts.at(-1).answer === null ? prompts.at(-1) : null);
      const version = () => env.extensions.find((e) => e.id === key.id).version;
      const apply = () => {
        if (!waiting) return false;
        env.install(key.id, versionOf[waiting.tag]);
        applied = waiting.tag;
        waiting = null;
        return true;
      };
      let committed = JSON.stringify(env.store["repo:o/r"].installed);
      for (const s of steps) {
        switch (s.op) {
          case "handOff": {
            if (open()) open().answer = "dismiss";
            if (s.tag === "v3" && rebuildIsLatest) break;
            const before = new Set(Object.keys(env.store));
            await installRelease(K, s.tag);
            const e = Object.entries(env.store).find(([k]) => k.startsWith("install:") && !before.has(k))[1];
            prompts.push({ token: e.token, tag: s.tag, downloadId: e.downloadId, answer: null });
            break;
          }
          case "accept": {
            const p = open();
            if (!p) break;
            p.answer = "accept";
            const f = env.files.get(p.downloadId); // gone when Extainium already deleted the copy
            if (f) f.exists = false;
            // Chromium refuses a downgrade; its installer deletes the copy all the same.
            if (compareVersions(versionOf[p.tag], version()) >= 0) waiting = p;
            break;
          }
          case "dismiss":
            if (open()) open().answer = "dismiss";
            break;
          case "vanish": {
            const p = prompts.length ? prompts[s.i % prompts.length] : null;
            const f = p && env.files.get(p.downloadId);
            if (f) f.exists = false;
            break;
          }
          case "stale":
            stale = !stale;
            break;
          case "idle":
            if (apply()) await manager.handleExtensionInstalled({ id: key.id, version: version() });
            break;
          case "restart": {
            apply();
            if (open()) open().answer = "dismiss";
            const startedAt = Date.now() + 1;
            await sweepDownloads();
            await reconcileInstalls({ startedAt });
            assert.deepEqual(entries(env).filter((e) => e.version && !e.confirmedAt && e.downloadDone), [], "pending after a start: " + JSON.stringify(steps));
            break;
          }
          case "reconcile":
            await reconcileInstalls();
            break;
          case "sweep":
            if (s.late && open()) open().answer = "dismiss"; // not answered within the grace period
            await sweepDownloads(Date.now() + s.late);
            break;
        }
        const [view] = await trackedView();
        const at = JSON.stringify({ rebuildIsLatest, runs1, steps });
        const installed = view.record.installed;
        if (JSON.stringify(installed) !== committed) {
          committed = JSON.stringify(installed);
          assert.equal(installed.version, version(), "a commit names the browser's version: " + at);
          if (installed.digest !== null) assert.equal(installed.digest, sha256(builds[applied]), "a committed digest is the build Chromium runs: " + at);
        }
        if (view.state === "current") assert.equal(version(), versionOf[latest], "current only with the browser's version: " + at);
        if (waiting) {
          const e = env.store["install:" + waiting.token];
          assert.ok(e && e.version && !e.confirmedAt, "the update Chromium may still apply keeps its entry: " + at);
        }
        if (view.state === "not-applied") {
          assert.ok(entries(env).some((e) => e.version && !e.confirmedAt && e.downloadDone && e.installed.tag === latest), "Not applied yet only with a pending prompt of the latest build: " + at);
        }
        assert.equal(env.badge, view.state === "update" ? "1" : "", "the badge counts the updates offered: " + at);
      }
    }),
    { numRuns: 300 }
  );
});

// ---- Extainium itself ----

async function selfSetup({ platform = "desktop", helper = false, updateUrl = "https://github.com/edxeth/extainium/releases/latest/download/updates.xml" } = {}) {
  const key = await crxKey();
  const self = { id: key.id, version: "0.9", name: "Extainium", enabled: true, installType: "normal", ...(updateUrl ? { updateUrl } : {}) };
  const exts = [self, ...(helper ? [{ id: "jlbggdgofbcndkkdimpeccablefilpkm", version: "1", name: "Titanium", enabled: true, installType: "normal" }] : [])];
  const env = fakeChrome({ extensions: exts });
  env.store.schema = 2;
  env.setPlatform(platform);
  env.runtimeId = key.id;
  env.manifestVersion = "0.9";
  fakeGithub([]);
  const codebase = "https://github.com/edxeth/extainium/releases/download/v1.0/extainium.crx";
  const crx = await packCrx3(zip, key.pkcs8);
  const servers = updateUrl ? fakeUpdateServers({ files: { [updateUrl]: updatesXml({ appid: key.id, version: "1.0", codebase }), [codebase]: crx } }) : null;
  return { env, key, servers, updateUrl };
}

// Contract: on desktop (installNeedsFlag) Extainium tracks itself through its own update_url.
test("on desktop Extainium tracks its own update URL until the user removes its record", async () => {
  const { env, key } = await selfSetup();
  assert.equal(await manager.trackSelf(), `url:${key.id}`);
  const [view] = await trackedView();
  assert.deepEqual([view.key, view.state, view.latest.version], [`url:${key.id}`, "update", "1.0"]);
  assert.equal(await manager.trackSelf(), null, "already tracked");
  await manager.removeRepo(`url:${key.id}`, false);
  assert.equal(await manager.trackSelf(), null, "the user removed it");
  assert.deepEqual(await trackedView(), Object.assign([], { installBlocked: null }));
  assert.ok(env.store.selfOptOut);
});

// F10: the opt-out holds however the record was created.
test("removing a self record that trackSelf did not create opts out of self-tracking too", async () => {
  const { env, key, updateUrl } = await selfSetup();
  env.store["repo:url:" + key.id] = newSourceRecord("updateUrl", key.id, { updateUrl, name: "Extainium" });
  await manager.removeRepo("url:" + key.id, false);
  assert.equal(await manager.trackSelf(), null);
  assert.equal(env.store["repo:url:" + key.id], undefined);
});

test("Extainium does not track itself on Titanium (Android or the desktop helper) nor without an https update URL", async () => {
  for (const opts of [{ platform: "android" }, { helper: true }, { updateUrl: null }, { updateUrl: "http://example.org/u.xml" }]) {
    const { env } = await selfSetup(opts);
    assert.equal(await manager.trackSelf(), null, JSON.stringify(opts));
    assert.deepEqual(Object.keys(env.store).filter((k) => k.startsWith("repo:")), [], JSON.stringify(opts));
  }
});

test("a first self-tracking check that fails is tried again at the next start", async () => {
  const { key, servers } = await selfSetup();
  const real = globalThis.fetch;
  globalThis.fetch = async () => { throw new TypeError("Failed to fetch"); };
  await assert.rejects(manager.trackSelf(), /Failed to fetch|cannot reach/);
  globalThis.fetch = real;
  assert.ok(servers);
  assert.equal(await manager.trackSelf(), `url:${key.id}`);
});

// F10 (closure repro "interruption while setting"): the opt-out is written before the record goes.
test("an interrupted opt-out write keeps Extainium's record, so a later start does not recreate a removed card", async () => {
  const { env, key } = await selfSetup();
  assert.equal(await manager.trackSelf(), "url:" + key.id);
  env.hooks.beforeSet = async (obj) => { if ("selfOptOut" in obj) throw new Error("interrupted opt-out write"); };
  await assert.rejects(manager.removeRepo("url:" + key.id, false), /interrupted/);
  env.hooks.beforeSet = null;
  assert.ok(env.store["repo:url:" + key.id], "the removal failed as a whole");
  assert.equal(await manager.trackSelf(), null, "still tracked, not recreated");
  await manager.removeRepo("url:" + key.id, false);
  assert.equal(await manager.trackSelf(), null);
  assert.equal(env.store["repo:url:" + key.id], undefined);
});
