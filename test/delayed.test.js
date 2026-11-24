// Updates Chromium accepts but applies later (delayed installs). Observed on
// ungoogled-chromium 156 and in a throwaway-profile experiment: after "Add
// extension" the installer deletes the downloaded CRX, but a running extension
// keeps its old version and management.onInstalled does not fire until the
// extension's processes are gone (disable, idle, reload) or the browser
// restarts; then the version changes (after a restart without any
// management.onInstalled event). A dismissed prompt leaves the CRX in place.
// Chromium 156: chrome_extension_registrar_delegate.cc OnExtensionInstalled,
// update_install_gate.cc, crx_installer.cc CleanupTempFiles.

import { test } from "node:test";
import assert from "node:assert/strict";
import nodeCrypto from "node:crypto";
import { readFileSync } from "node:fs";
import { extensionIdFromSpki, packCrx3 } from "../src/lib/crx.js";
import * as manager from "../src/lib/manager.js";
import { newRecord } from "../src/lib/store.js";
import { updatesXml } from "../scripts/release-files.js";
import { fakeChrome, fakeGithub } from "./helpers/fake-chrome.js";
import { fakeUpdateServers } from "./helpers/fake-update.js";

const { installRelease, sweepDownloads, trackedView } = manager;
const zip = new Uint8Array(readFileSync(new URL("./fixtures/ext-root.zip", import.meta.url))); // manifest version 1.0
const K = "o/r";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sha256 = (bytes) => "sha256:" + nodeCrypto.createHash("sha256").update(bytes).digest("hex");
Object.assign(manager.cleanupTiming, { retryMs: 5, settleMs: 1 });
Object.assign(manager.applyTiming, { waitMs: 200, pollMs: 5 });

async function crxKey() {
  const { privateKey } = nodeCrypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
  const pkcs8 = new Uint8Array(privateKey.export({ type: "pkcs8", format: "der" }));
  const spki = new Uint8Array(nodeCrypto.createPublicKey(privateKey).export({ type: "spki", format: "der" }));
  return { pkcs8, id: await extensionIdFromSpki(spki) };
}

// A tracked GitHub repo whose extension runs 0.9; release v1 holds its 1.0 CRX.
async function updateSetup({ platform = "desktop" } = {}) {
  const key = await crxKey();
  const crx = await packCrx3(zip, key.pkcs8);
  const env = fakeChrome({ extensions: [{ id: key.id, version: "0.9", name: "Example", enabled: true, installType: "normal" }] });
  env.store.schema = 2;
  env.setPlatform(platform);
  fakeGithub([{ tag: "v1", assets: [{ name: "example.crx", bytes: crx, digest: sha256(crx) }] }]);
  env.store["repo:o/r"] = {
    ...newRecord("o", "r"), template: "example.crx", extensionId: key.id,
    installed: { tag: "v0", digest: null, version: "0.9" },
    releases: [{ tag: "v1", prerelease: false, publishedAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z", htmlUrl: "", assets: [{ name: "example.crx", url: "https://github.com/o/r/releases/download/v1/example.crx", size: crx.length, digest: sha256(crx) }] }],
  };
  return { env, key, crx };
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

async function delayedUpdate(opts) {
  const s = await updateSetup(opts);
  answerPrompt(s.env, { accept: true });
  await installRelease(K);
  await sleep(30); // the page's check of the copy (cleanupTiming)
  return s;
}

// Requirement: an accepted update the browser has not applied yet is "delayed", never "not confirmed".
test("an accepted update whose copy the installer deleted without an install event shows as delayed, also after the grace period", async () => {
  const { env } = await delayedUpdate();
  let [view] = await trackedView();
  assert.equal(view.state, "delayed");
  assert.deepEqual([view.pendingInstall.version, view.pendingInstall.delayed], ["1.0", true]);
  assert.equal(env.badge, "", "a delayed update is not an update to install");
  await sweepDownloads(Date.now() + manager.PENDING_GRACE_MS + 1);
  await sweepDownloads(Date.now() + manager.CONFIRM_WINDOW_MS + 1);
  [view] = await trackedView();
  assert.equal(view.state, "delayed");
  assert.equal(view.pendingInstall.delayed, true, "kept past the confirmation window: the browser applies it at its restart");
});

// Requirement: keep the dismissed handling for real declines (the copy stays).
test("a dismissed prompt leaves the copy and stays an update; deleting the copy later does not make it delayed", async () => {
  const { env } = await updateSetup();
  answerPrompt(env, { accept: false });
  await installRelease(K);
  await sleep(30);
  let [view] = await trackedView();
  assert.deepEqual([view.state, view.pendingInstall.delayed], ["update", false]);
  await sweepDownloads(Date.now() + manager.PENDING_GRACE_MS + 1);
  assert.deepEqual(env.removed, [1], "Extainium deleted the declined copy");
  await sweepDownloads(Date.now() + 2 * manager.PENDING_GRACE_MS);
  [view] = await trackedView();
  assert.equal(view.state, "update");
  assert.ok(!view.pendingInstall || !view.pendingInstall.delayed);
});

// Requirement (dismissed handling): a copy Extainium deleted itself never counts as the installer's deletion.
test("a declined copy that Extainium deleted but could not erase from the download list is not taken for an accepted update", async () => {
  const { env } = await updateSetup({ platform: "android" });
  await installRelease(K);
  const erase = chrome.downloads.erase;
  chrome.downloads.erase = async () => { throw new Error("erase failed"); };
  await sweepDownloads(Date.now() + manager.PENDING_GRACE_MS + 1);
  chrome.downloads.erase = erase;
  assert.deepEqual([env.removed, env.files.get(1).exists], [[1], false], "deleted, still listed");
  await sweepDownloads(Date.now() + manager.PENDING_GRACE_MS + 2);
  const [view] = await trackedView();
  assert.ok(!view.pendingInstall || !view.pendingInstall.delayed);
  assert.equal(view.state, "update");
});

// Requirement: acceptance is found also when the hand-off's page is gone (the sweep judges it), on Android too.
test("the sweep finds an accepted, unapplied update when no page checked it", async () => {
  const { env } = await updateSetup({ platform: "android" });
  await installRelease(K);
  assert.equal((await trackedView())[0].pendingInstall.delayed, false);
  env.files.get(1).exists = false; // accepted at the prompt later; the installer deleted the copy
  await sweepDownloads(Date.now() + manager.PENDING_GRACE_MS + 1);
  const [view] = await trackedView();
  assert.deepEqual([view.state, view.pendingInstall.delayed], ["delayed", true]);
  assert.deepEqual(env.removed, [], "the browser's installer deleted the copy, not Extainium");
});

// Requirement: a delayed update resolves to current when management.onInstalled finally fires.
test("the install event of the delayed version commits it and ends the entry", async () => {
  const { env, key, crx } = await delayedUpdate();
  env.install(key.id, "1.0");
  await manager.handleExtensionInstalled({ id: key.id, version: "1.0" });
  const [view] = await trackedView();
  assert.equal(view.state, "current");
  assert.deepEqual(view.record.installed, { tag: "v1", digest: sha256(crx), version: "1.0" });
  assert.equal(view.pendingInstall, null);
  assert.deepEqual(entries(env), []);
});

// Requirement: on startup compare installed versions with delayed entries (no event after a browser restart).
test("reconciling after a browser restart commits a delayed update the browser applied without an event", async () => {
  const { env, key, crx } = await delayedUpdate();
  await manager.reconcileInstalls();
  assert.equal((await trackedView())[0].state, "delayed", "not applied yet: nothing changes");
  env.install(key.id, "1.0"); // applied while the browser started
  await manager.reconcileInstalls();
  const [view] = await trackedView();
  assert.equal(view.state, "current");
  assert.deepEqual(view.record.installed, { tag: "v1", digest: sha256(crx), version: "1.0" });
  assert.deepEqual(entries(env), []);
});

test("reconciling ends a delayed entry whose extension was uninstalled or runs a newer version, without committing it", async () => {
  for (const change of ["uninstalled", "newer"]) {
    const { env, key } = await delayedUpdate();
    if (change === "uninstalled") env.extensions = [];
    else env.install(key.id, "1.5");
    await manager.reconcileInstalls();
    const [view] = await trackedView();
    assert.equal(view.pendingInstall, null, change);
    assert.equal(view.record.installed.version, "0.9", change);
    assert.deepEqual(entries(env), [], change);
  }
});

// Observed: two accepted updates while delayed; Chromium applies only the newest (one install event).
test("the install event of a newer version also ends an older delayed entry of that extension", async () => {
  const { env, key } = await delayedUpdate();
  env.install(key.id, "1.1");
  await manager.handleExtensionInstalled({ id: key.id, version: "1.1" });
  assert.equal((await trackedView())[0].pendingInstall, null);
  assert.deepEqual(entries(env), []);
});

// Experiment: disable, about 5 s later Chromium applies the delayed update (still disabled), enable.
function chromiumAppliesWhenDisabled(env, id, version) {
  env.onSetEnabled = async (extId, enabled) => {
    if (extId === id && !enabled) setTimeout(() => env.install(id, version), 20);
  };
}

test("Apply now turns the extension off until the browser applies the update, turns it on again, and commits it", async () => {
  const { env, key, crx } = await delayedUpdate();
  chromiumAppliesWhenDisabled(env, key.id, "1.0");
  const result = await manager.applyDelayed(K);
  assert.deepEqual(result, { applied: true, version: "1.0", name: "Example" });
  assert.deepEqual(env.setEnabledCalls, [[key.id, false], [key.id, true]]);
  const [view] = await trackedView();
  assert.equal(view.ext.enabled, true);
  assert.equal(view.state, "current");
  assert.deepEqual(view.record.installed, { tag: "v1", digest: sha256(crx), version: "1.0" });
  assert.deepEqual(Object.keys(env.store).filter((k) => k.startsWith("reenable:")), []);
});

test("Apply now turns the extension on again when the browser does not apply the update in time; it stays delayed", async () => {
  const { env, key } = await delayedUpdate();
  const result = await manager.applyDelayed(K);
  assert.deepEqual(result, { applied: false, version: "1.0", name: "Example" });
  assert.deepEqual(env.setEnabledCalls, [[key.id, false], [key.id, true]]);
  const [view] = await trackedView();
  assert.deepEqual([view.ext.enabled, view.state], [true, "delayed"]);
  assert.deepEqual(Object.keys(env.store).filter((k) => k.startsWith("reenable:")), []);
});

test("Apply now refuses a disabled extension and a record without a delayed update", async () => {
  const { env, key } = await updateSetup();
  await assert.rejects(manager.applyDelayed(K), /^Error: apply o\/r: no added update waits to be applied$/);
  answerPrompt(env, { accept: true });
  await installRelease(K);
  await sleep(30);
  env.extensions[0].enabled = false;
  await assert.rejects(manager.applyDelayed(K), new RegExp("^Error: apply o/r: Example is turned off"));
  assert.deepEqual(env.setEnabledCalls, []);
  assert.equal(key.id.length, 32);
});

// A page that went away during Apply now (it runs in the page) must not leave the extension off.
test("an extension Apply now left turned off is turned on again by restoreDisabled", async () => {
  const { env, key } = await delayedUpdate();
  env.onSetEnabled = async (id, enabled) => {
    if (!enabled) throw new Error("page closed"); // the apply stops right after turning it off
  };
  await assert.rejects(manager.applyDelayed(K), /page closed/);
  env.onSetEnabled = null;
  // setEnabled(true) in the apply's cleanup ran; simulate it never ran as the page was gone:
  env.extensions[0].enabled = false;
  env.store["reenable:" + key.id] = Date.now();
  assert.equal(env.alarms.has(manager.SWEEP_ALARM), true, "a sweep is armed to restore it");
  await manager.restoreDisabled();
  assert.equal(env.extensions[0].enabled, true);
  assert.deepEqual(Object.keys(env.store).filter((k) => k.startsWith("reenable:")), []);
  // A marker for an extension that is on, or gone, is just dropped.
  env.store["reenable:" + "z".repeat(32)] = Date.now();
  await manager.restoreDisabled();
  assert.deepEqual(Object.keys(env.store).filter((k) => k.startsWith("reenable:")), []);
});

// Requirement: an update installed from a file says "added" when accepted but delayed, too.
test("handOffState tells a file install's delayed, pending and confirmed states apart", async () => {
  const { env, key, crx } = await updateSetup();
  answerPrompt(env, { accept: true });
  const accepted = await manager.installFile(crx, "example.crx");
  await sleep(30);
  assert.equal(await manager.handOffState(accepted.token), "delayed");
  answerPrompt(env, { accept: false });
  const dismissed = await manager.installFile(crx, "example.crx");
  await sleep(30);
  assert.equal(await manager.handOffState(dismissed.token), "pending");
  env.install(key.id, "1.0");
  env.removeFileError = new Error("Access denied"); // keeps the confirmed entry until its copy is gone
  await manager.handleExtensionInstalled({ id: key.id, version: "1.0" });
  // The event confirms the newest prompt of that version (handleExtensionInstalled).
  assert.equal(await manager.handOffState(dismissed.token), "confirmed");
  assert.equal(await manager.handOffState("no-such-token"), null);
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
  return { env, key, servers };
}

// Contract: on desktop (installNeedsFlag) Extainium tracks itself through its own update_url.
test("on desktop Extainium tracks its own update URL by itself, once: a removed record stays removed", async () => {
  const { env, key } = await selfSetup();
  assert.equal(await manager.trackSelf(), `url:${key.id}`);
  let [view] = await trackedView();
  assert.deepEqual([view.key, view.state, view.latest.version], [`url:${key.id}`, "update", "1.0"]);
  assert.equal(await manager.trackSelf(), null, "already tracked");
  await manager.removeRepo(`url:${key.id}`, false);
  assert.equal(await manager.trackSelf(), null, "the user removed it");
  assert.deepEqual(await trackedView(), Object.assign([], { installBlocked: null }));
  assert.ok(env.store.selfTracked);
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

// Apply now for Extainium itself is runtime.reload(), which applies a delayed update (experiment E3).
test("Apply now on Extainium's own delayed update reloads Extainium", async () => {
  const { env, key } = await selfSetup();
  const k = await manager.trackSelf();
  answerPrompt(env, { accept: true });
  await installRelease(k);
  await sleep(30);
  assert.equal((await trackedView())[0].state, "delayed");
  manager.applyDelayed(k);
  await sleep(30);
  assert.equal(env.reloads, 1);
  assert.deepEqual(env.setEnabledCalls, [], "Extainium never turns itself off");
  assert.equal(key.id.length, 32);
});
