// Updates whose downloaded copy vanished without an install event. Observed on
// ungoogled-chromium 156 and in a throwaway-profile experiment: after "Add
// extension" the installer deletes the downloaded CRX, but a running extension
// keeps its old version and management.onInstalled fires only once the
// extension's processes are gone; after a browser restart the version changes
// without any event. A dismissed prompt leaves the CRX in place. An installer
// failure deletes the copy too (crx_installer.cc CleanupTempFiles), so a
// vanished copy is only a hint (owner decision, closure review 2026-11-24): the
// card says "Waiting for Chromium", keeps the install button, and turns current
// only when the browser reports the version.

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

async function vanishedUpdate(opts) {
  const s = await updateSetup(opts);
  answerPrompt(s.env, { accept: true });
  await installRelease(K);
  await sleep(30); // the page's check of the copy (cleanupTiming)
  return s;
}

// Owner decision 2 (F5): a vanished copy is a tentative "Waiting for Chromium" that keeps the install offered.
test("a copy that vanished without an install event shows Waiting for Chromium, still offers the install, and stays past the grace period and the confirmation window", async () => {
  const { env } = await vanishedUpdate();
  let [view] = await trackedView();
  assert.deepEqual([view.state, view.pendingInstall.version, view.pendingInstall.waiting], ["waiting", "1.0", true]);
  assert.equal(offersInstall(view), true, "the prompt may have been cancelled: install again stays possible");
  assert.equal(env.badge, "", "not counted as an update to install");
  await sweepDownloads(Date.now() + manager.PENDING_GRACE_MS + 1);
  await sweepDownloads(Date.now() + manager.CONFIRM_WINDOW_MS + 1);
  [view] = await trackedView();
  assert.deepEqual([view.state, view.pendingInstall.waiting], ["waiting", true], "kept: Chromium may apply it at its restart");
});

// Requirement: keep the dismissed handling for real declines (the copy stays).
test("a dismissed prompt leaves the copy and stays an update; deleting the copy later does not make it waiting", async () => {
  const { env } = await updateSetup();
  answerPrompt(env, { accept: false });
  await installRelease(K);
  await sleep(30);
  let [view] = await trackedView();
  assert.deepEqual([view.state, view.pendingInstall.waiting], ["update", false]);
  await sweepDownloads(Date.now() + manager.PENDING_GRACE_MS + 1);
  assert.deepEqual(env.removed, [1], "Extainium deleted the declined copy");
  await sweepDownloads(Date.now() + 2 * manager.PENDING_GRACE_MS);
  [view] = await trackedView();
  assert.equal(view.state, "update");
  assert.ok(!view.pendingInstall || !view.pendingInstall.waiting);
});

// A copy Extainium deleted itself never counts as vanished.
test("a declined copy that Extainium deleted but could not erase from the download list is not taken for a vanished one", async () => {
  const { env } = await updateSetup({ platform: "android" });
  await installRelease(K);
  const erase = chrome.downloads.erase;
  chrome.downloads.erase = async () => { throw new Error("erase failed"); };
  await sweepDownloads(Date.now() + manager.PENDING_GRACE_MS + 1);
  chrome.downloads.erase = erase;
  assert.deepEqual([env.removed, env.files.get(1).exists], [[1], false], "deleted, still listed");
  await sweepDownloads(Date.now() + manager.PENDING_GRACE_MS + 2);
  const [view] = await trackedView();
  assert.ok(!view.pendingInstall || !view.pendingInstall.waiting);
  assert.equal(view.state, "update");
});

// The sweep judges the copy when no page checked it, on Android too.
test("the sweep finds a vanished copy when no page checked it", async () => {
  const { env } = await updateSetup({ platform: "android" });
  await installRelease(K);
  assert.equal((await trackedView())[0].pendingInstall.waiting, false);
  env.files.get(1).exists = false; // accepted at the prompt later; the installer deleted the copy
  await sweepDownloads(Date.now() + manager.PENDING_GRACE_MS + 1);
  const [view] = await trackedView();
  assert.deepEqual([view.state, view.pendingInstall.waiting], ["waiting", true]);
  assert.deepEqual(env.removed, [], "the browser's installer deleted the copy, not Extainium");
});

test("the install event of the waiting version commits it and ends the entry", async () => {
  const { env, key, crx } = await vanishedUpdate();
  env.install(key.id, "1.0");
  await manager.handleExtensionInstalled({ id: key.id, version: "1.0" });
  const [view] = await trackedView();
  assert.equal(view.state, "current");
  assert.deepEqual(view.record.installed, { tag: "v1", digest: sha256(crx), version: "1.0" });
  assert.equal(view.pendingInstall, null);
  assert.deepEqual(entries(env), []);
});

// Owner decision 2: a startup or periodic comparison that sees the version installed resolves it to current.
test("a comparison after a browser restart commits a waiting update the browser applied without an event", async () => {
  const { env, key, crx } = await vanishedUpdate();
  await reconcileInstalls();
  assert.equal((await trackedView())[0].state, "waiting", "not applied yet: nothing changes");
  env.install(key.id, "1.0"); // applied while the browser started
  await reconcileInstalls({ startedAt: Date.now() + 1 });
  const [view] = await trackedView();
  assert.equal(view.state, "current");
  assert.deepEqual(view.record.installed, { tag: "v1", digest: sha256(crx), version: "1.0" });
  assert.deepEqual(entries(env), []);
});

// Chromium applies pending updates while it starts: one prompted before the start and not applied never applies.
test("a browser start without the version ends the waiting entry; a periodic comparison and an entry prompted after the start keep it", async () => {
  const { env } = await vanishedUpdate();
  const [{ promptAt }] = entries(env);
  await reconcileInstalls();
  await reconcileInstalls({ startedAt: promptAt });
  assert.equal((await trackedView())[0].state, "waiting");
  await reconcileInstalls({ startedAt: promptAt + 1 });
  const [view] = await trackedView();
  assert.deepEqual([view.state, view.pendingInstall], ["update", null]);
  assert.equal(view.record.installed.version, "0.9");
  assert.deepEqual(entries(env), []);
});

test("a comparison ends a waiting entry whose extension was uninstalled or runs a newer version, without committing it", async () => {
  for (const change of ["uninstalled", "newer"]) {
    const { env, key } = await vanishedUpdate();
    if (change === "uninstalled") env.extensions = [];
    else env.install(key.id, "1.5");
    await reconcileInstalls();
    const [view] = await trackedView();
    assert.equal(view.pendingInstall, null, change);
    assert.equal(view.record.installed.version, "0.9", change);
    assert.deepEqual(entries(env), [], change);
  }
});

// Observed: two accepted updates while delayed; Chromium applies only the newest (one install event).
test("the install event of a newer version also ends an older waiting entry of that extension", async () => {
  const { env, key } = await vanishedUpdate();
  env.install(key.id, "1.1");
  await manager.handleExtensionInstalled({ id: key.id, version: "1.1" });
  assert.equal((await trackedView())[0].pendingInstall, null);
  assert.deepEqual(entries(env), []);
});

// F4: a refusal candidate's deleted copy is judged once, as a refusal, never also as a waiting update.
test("a refused desktop install whose copy the browser deleted sets installBlocked and never becomes waiting", async () => {
  // Judged by the sweep (the page went away).
  const s = await updateSetup();
  const now = Date.now();
  s.env.store["install:t"] = {
    token: "t", repoKey: K, extensionId: s.key.id, version: "1.0", installed: { tag: "v1", digest: sha256(s.crx), version: "1.0" },
    crxHash: "x", fromVersion: "0.9", signedWith: null, supersededBy: null, downloadId: 1, startedAt: now - 10000, downloadDone: true,
    promptAt: now - 9990, at: now - 10000, confirmedAt: null, fileGone: false, removeError: null, refusalCandidate: true,
  };
  s.env.files.set(1, { filename: "x", state: "complete", exists: false, startTime: new Date(now - 10000).toISOString(), endTime: new Date(now - 9990).toISOString() });
  await sweepDownloads();
  await sweepDownloads(Date.now() + manager.PENDING_GRACE_MS + 1);
  assert.equal(s.env.store.installBlocked.hint, "flag");
  assert.equal(s.env.store["install:t"].vanishedAt, undefined);
  assert.equal((await trackedView())[0].state, "update");
  // Judged by the page's check first, then swept.
  const p = await updateSetup();
  p.env.onDownloadStarted = async (id) => { p.env.files.get(id).exists = false; }; // completed at once, copy deleted
  await installRelease(K);
  await sleep(30);
  assert.equal(p.env.store.installBlocked.hint, "flag");
  await sweepDownloads(Date.now() + manager.PENDING_GRACE_MS + 1);
  assert.ok(entries(p.env).every((e) => !e.vanishedAt));
  assert.deepEqual([(await trackedView())[0].state, (await trackedView())[0].pendingInstall.waiting], ["update", false]);
});

// F6: Chromium's file check is throttled (once per 10 s): the copy may still show while it is gone.
test("a sweep that deletes a copy the stale file check still lists finds it gone and keeps the entry as waiting", async () => {
  const { env } = await updateSetup({ platform: "android" });
  await installRelease(K);
  env.files.get(1).exists = false; // the installer deleted it
  const search = chrome.downloads.search;
  chrome.downloads.search = async (q) => (await search(q)).map((i) => ({ ...i, exists: true })); // not noticed yet
  await sweepDownloads(Date.now() + manager.PENDING_GRACE_MS + 1);
  chrome.downloads.search = search;
  const [e] = entries(env);
  assert.ok(e.vanishedAt, "removeFile said it was deleted already");
  assert.deepEqual(env.removed, []);
  await sweepDownloads(Date.now() + manager.CONFIRM_WINDOW_MS + 1);
  assert.equal((await trackedView())[0].state, "waiting");
});

// F7: a same-version rebuild is not proven applied by the version alone; its install event decides (digest rule).
test("a waiting rebuild of the installed version is not committed by a version comparison; its install event commits it", async () => {
  const { env, key, builds } = await twoBuilds({ version: "1.0" });
  answerPrompt(env, { accept: true });
  await installRelease(K); // v2, the rebuild
  await sleep(30);
  assert.equal((await trackedView())[0].state, "waiting");
  await reconcileInstalls();
  let [view] = await trackedView();
  assert.deepEqual([view.state, view.record.installed.digest], ["waiting", sha256(builds.v1)]);
  manager.handleExtensionInstalled({ id: key.id, version: "1.0" }).catch(() => {});
  await sleep(30);
  [view] = await trackedView();
  assert.deepEqual([view.state, view.record.installed.digest], ["current", sha256(builds.v2)], "the event commits the rebuild");
  // After a restart, the comparison cannot tell: the entry ends, the card offers the rebuild again.
  const s = await twoBuilds({ version: "1.0" });
  answerPrompt(s.env, { accept: true });
  await installRelease(K);
  await sleep(30);
  await reconcileInstalls({ startedAt: Date.now() + 1 });
  [view] = await trackedView();
  assert.deepEqual([view.state, view.record.installed.digest, view.pendingInstall], ["update", sha256(s.builds.v1), null]);
});

// F9: a later dismissed hand-off never discards an earlier one that may have been accepted.
test("a later dismissed hand-off of the same version keeps the earlier vanished one, which its install event commits", async () => {
  const { env, key, builds } = await twoBuilds({ platform: "android" });
  await installRelease(K, "v1");
  env.files.get(1).exists = false; // accepted; Chromium delays it (no sweep judged it yet)
  await installRelease(K, "v2"); // its prompt is dismissed: the copy stays
  assert.equal(entryOf(env, "v1").version, "1.0", "not superseded");
  assert.ok(entryOf(env, "v1").vanishedAt);
  let [view] = await trackedView();
  assert.equal(view.pendingInstall.tag, "v2", "the open prompt shows first");
  for (const e of entries(env)) { // the grace period of both prompts passed, in their order
    env.store["install:" + e.token] = { ...e, at: e.at - manager.PENDING_GRACE_MS - 1, promptAt: e.promptAt - manager.PENDING_GRACE_MS - 1 };
  }
  await sweepDownloads();
  [view] = await trackedView();
  assert.deepEqual([view.pendingInstall.tag, view.pendingInstall.waiting, view.state], ["v1", true, "update"]);
  env.install(key.id, "1.0");
  await manager.handleExtensionInstalled({ id: key.id, version: "1.0" });
  [view] = await trackedView();
  assert.equal(view.record.installed.digest, sha256(builds.v1), "the accepted build, not the dismissed one");
  assert.equal(view.pendingInstall, null);
});

// F8: the order is the prompts' order, not the order Extainium noticed the copies vanish.
test("of several vanished hand-offs, the newest prompt is shown and committed, whatever order they were detected in", async () => {
  for (const how of ["event", "restart"]) {
    const { env, key, builds } = await twoBuilds({ platform: "android" });
    await installRelease(K, "v1");
    env.files.get(1).exists = false;
    await installRelease(K, "v2");
    env.files.get(2).exists = false;
    await sweepDownloads();
    // Detected the other way round: v2 first.
    const a = entryOf(env, "v1"), b = entryOf(env, "v2");
    env.store["install:" + a.token] = { ...a, vanishedAt: b.promptAt + 10 };
    env.store["install:" + b.token] = { ...b, vanishedAt: a.promptAt };
    assert.equal((await trackedView())[0].pendingInstall.tag, "v2", how);
    env.install(key.id, "1.0");
    if (how === "event") await manager.handleExtensionInstalled({ id: key.id, version: "1.0" });
    else await reconcileInstalls({ startedAt: Date.now() + 1 });
    const [view] = await trackedView();
    assert.deepEqual([view.state, view.record.installed.digest], ["current", sha256(builds.v2)], how);
  }
});

// "At the latest after a browser restart": what Chromium did not apply while starting ends, also next to one it applied.
test("a browser start that applied one vanished update ends the other vanished updates of that extension", async () => {
  const key = await crxKey();
  const builds = { v1: await packCrx3(zip, key.pkcs8), v3: await packCrx3(await versionZip("2.0"), key.pkcs8) };
  const { env } = await updateSetup({ platform: "android", key, builds });
  await installRelease(K, "v3");
  env.files.get(1).exists = false;
  await installRelease(K, "v1"); // accepted last: Chromium applies this one
  env.files.get(2).exists = false;
  await sweepDownloads();
  env.install(key.id, "1.0");
  await reconcileInstalls({ startedAt: Date.now() + 1 });
  const [view] = await trackedView();
  assert.deepEqual([view.record.installed.tag, view.state, view.pendingInstall], ["v1", "update", null]);
  assert.deepEqual(entries(env).filter((e) => e.version && !e.confirmedAt), []);
});

// F11: the badge follows every change of a pending install.
test("the badge drops an update once its copy vanished, found by the page's check or by the sweep", async () => {
  for (const platform of ["desktop", "android"]) {
    const { env } = await updateSetup({ platform });
    await manager.refreshBadge();
    assert.equal(env.badge, "1", platform);
    if (platform === "desktop") {
      answerPrompt(env, { accept: true });
      await installRelease(K);
      await sleep(30);
    } else {
      await installRelease(K);
      env.files.get(1).exists = false;
      await sweepDownloads();
    }
    assert.equal((await trackedView())[0].state, "waiting", platform);
    assert.equal(env.badge, "", platform);
  }
});

// F12 (lib side): an install from a file is followed until the browser confirms it.
test("handOffState tells a file install's waiting, pending and confirmed states apart, also confirmed without an event", async () => {
  const { env, key, crx } = await updateSetup();
  answerPrompt(env, { accept: true });
  const accepted = await manager.installFile(crx, "example.crx");
  await sleep(30);
  assert.equal(await manager.handOffState(accepted.token), "waiting");
  answerPrompt(env, { accept: false });
  const dismissed = await manager.installFile(crx, "example.crx");
  await sleep(30);
  assert.equal(await manager.handOffState(dismissed.token), "pending");
  assert.equal(await manager.handOffState(accepted.token), "waiting", "the later dismissed one does not end it");
  env.install(key.id, "1.0"); // applied at a browser start, no event
  const erase = chrome.downloads.erase;
  chrome.downloads.erase = async () => { throw new Error("erase failed"); }; // keeps the confirmed entry listed
  await reconcileInstalls({ startedAt: Date.now() + 1 });
  chrome.downloads.erase = erase;
  assert.equal(await manager.handOffState(accepted.token), "confirmed");
  assert.equal(await manager.handOffState(dismissed.token), null, "its prompt ended with the restart");
  assert.equal(await manager.handOffState("no-such-token"), null);
});

// F13: model of the browser: Titanium's prompt is modal (a new prompt replaces an unanswered one),
// an accepted update waits while the extension runs, Chromium applies only the last accepted one
// (with an install event when the extension goes idle, without one at a restart), refuses a
// downgrade (its copy is deleted all the same), and anyone may delete a copy.
test("property: hand-offs, prompt answers, vanishing copies, install events, restarts and sweeps never claim current without the browser's version, never lose an update that may still apply, and keep the badge in step", async () => {
  const key = await crxKey();
  const builds = { v1: await packCrx3(zip, key.pkcs8), v2: await packCrx3(rebuiltZip(), key.pkcs8), v3: await packCrx3(await versionZip("2.0"), key.pkcs8) };
  const versionOf = { v0: "0.9", v1: "1.0", v2: "1.0", v3: "2.0" };
  const step = fc.oneof(
    fc.record({ op: fc.constant("handOff"), tag: fc.constantFrom("v1", "v2", "v3") }),
    fc.record({ op: fc.constantFrom("accept", "accept", "dismiss", "idle", "restart", "reconcile") }),
    fc.record({ op: fc.constant("vanish"), i: fc.nat(7) }),
    fc.record({ op: fc.constant("sweep"), late: fc.constantFrom(0, manager.PENDING_GRACE_MS + 1, manager.CONFIRM_WINDOW_MS + 1) }),
  );
  await fc.assert(
    fc.asyncProperty(fc.boolean(), fc.boolean(), fc.array(step, { minLength: 1, maxLength: 12 }), async (rebuildIsLatest, runs1, steps) => {
      const tags = rebuildIsLatest ? ["v1", "v2"] : ["v1", "v2", "v3"];
      const { env } = await updateSetup({ platform: "android", version: runs1 ? "1.0" : "0.9", key, builds: Object.fromEntries(tags.map((t) => [t, builds[t]])) });
      const latest = tags.at(-1);
      await manager.refreshBadge();
      let applied = runs1 ? "v1" : "v0"; // the build Chromium runs
      let waiting = null; // the accepted prompt Chromium applies later
      let foreign = false; // a copy was deleted by someone else
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
            env.files.get(p.downloadId).exists = false;
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
            if (!f || !f.exists) break;
            f.exists = false;
            foreign = true;
            break;
          }
          case "idle":
            if (apply()) await manager.handleExtensionInstalled({ id: key.id, version: version() });
            break;
          case "restart": {
            apply();
            if (open()) open().answer = "dismiss";
            const startedAt = Date.now() + 1;
            await sweepDownloads();
            await reconcileInstalls({ startedAt });
            // Chromium applied what it would while starting: nothing prompted before waits any more.
            assert.deepEqual(entries(env).filter((e) => e.vanishedAt && e.version && !e.confirmedAt), [], `waiting after a start: ${JSON.stringify(steps)}`);
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
        const at = JSON.stringify(steps);
        if (view.state === "current") {
          assert.equal(version(), versionOf[latest], `current only with the browser's version: ${at}`);
          assert.equal(view.record.installed.digest, sha256(builds[latest]), `current only with the latest build committed: ${at}`);
          if (!foreign) assert.equal(applied, latest, `current only when Chromium runs the latest build: ${at}`);
        }
        if (waiting) {
          const e = env.store["install:" + waiting.token];
          assert.ok(e && e.version && !e.confirmedAt, `the update Chromium may still apply keeps its entry: ${at}`);
        }
        const updates = view.state === "update" ? 1 : 0;
        assert.equal(env.badge, updates ? String(updates) : "", `the badge counts the updates offered: ${at}`);
      }
    }),
    { numRuns: 80 }
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
