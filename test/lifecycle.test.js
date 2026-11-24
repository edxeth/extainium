import { test } from "node:test";
import assert from "node:assert/strict";
import nodeCrypto from "node:crypto";
import { readFileSync } from "node:fs";
import { extensionIdFromSpki, packCrx3 } from "../src/lib/crx.js";
import { buildZip, crc32, parseZip } from "../src/lib/zip.js";
import { newRecord } from "../src/lib/store.js";
import * as manager from "../src/lib/manager.js";
import { fakeChrome, fakeGithub, v1Backup } from "./helpers/fake-chrome.js";

const { importBackup, installFile, installRelease, setPrereleases, sweepDownloads, trackedView } = manager;
const zip = new Uint8Array(readFileSync(new URL("./fixtures/ext-root.zip", import.meta.url))); // manifest version 1.0
const K = "o/r";

async function crxKey() {
  const { privateKey } = nodeCrypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
  const pkcs8 = new Uint8Array(privateKey.export({ type: "pkcs8", format: "der" }));
  const spki = new Uint8Array(nodeCrypto.createPublicKey(privateKey).export({ type: "spki", format: "der" }));
  return { pkcs8, id: await extensionIdFromSpki(spki) };
}
const sha256 = (bytes) => "sha256:" + nodeCrypto.createHash("sha256").update(bytes).digest("hex");

const v1Record = (extra = {}) => ({
  owner: "o", repo: "r", pattern: "^example\\.crx$", includePrereleases: false, extensionId: null, keyPkcs8: null,
  installed: null, releases: null, etag: null, checkedAt: null, error: null, addedAt: 1, ...extra,
});

// The browser's management.onInstalled, delivered to the service worker's handler.
function browserInstalls(env, id, version) {
  env.install(id, version);
  return manager.handleExtensionInstalled({ id, version, name: "Example", enabled: true });
}

// A rebuild of the installed version (same tag and version, new digest) is an update.
async function rebuildSetup() {
  const key = await crxKey();
  const crx = await packCrx3(zip, key.pkcs8);
  const env = fakeChrome({ extensions: [{ id: key.id, version: "1.0", name: "Example", enabled: true }] });
  fakeGithub([{ tag: "v1", assets: [{ name: "example.crx", bytes: crx, digest: sha256(crx) }] }]);
  await importBackup(v1Backup([v1Record({ extensionId: key.id, installed: { tag: "v1", digest: "sha256:" + "0".repeat(64), version: "1.0" } })]));
  return { env, key, crx };
}

// F4: a completed download is not an install.
test("an install the browser has not confirmed leaves the update pending; onInstalled with the ID and version commits it", async () => {
  const { env, key, crx } = await rebuildSetup();
  assert.equal((await trackedView())[0].state, "update");
  await installRelease(K);
  assert.equal(env.handedOff.length, 1);
  let [view] = await trackedView();
  assert.equal(view.state, "update", "declined or not yet confirmed: still an update");
  assert.equal(view.record.installed.digest, "sha256:" + "0".repeat(64));
  await browserInstalls(env, key.id, "1.0");
  [view] = await trackedView();
  assert.equal(view.state, "current");
  assert.deepEqual(view.record.installed, { tag: "v1", digest: sha256(crx), version: "1.0" });
  assert.equal(env.badge, "");
  assert.deepEqual(env.removed, [1], "the CRX copy is deleted after the confirmed install");
});

// F4: an install of a different version (e.g. an older package still running) does not confirm.
test("onInstalled for another version of the extension does not commit the pending install", async () => {
  const { env, key } = await rebuildSetup();
  await installRelease(K);
  await browserInstalls(env, key.id, "0.9");
  const [view] = await trackedView();
  assert.equal(view.record.installed.digest, "sha256:" + "0".repeat(64));
  assert.equal(view.pendingInstall.version, "1.0");
});

// F4 + F6: Chromium may report the install before the download call resolves.
test("an onInstalled event that arrives before the download resolves still commits and removes the file", async () => {
  const { env, key, crx } = await rebuildSetup();
  env.searchHook = async () => {
    env.searchHook = null;
    await browserInstalls(env, key.id, "1.0");
  };
  await installRelease(K);
  const [view] = await trackedView();
  assert.equal(view.state, "current");
  assert.equal(view.record.installed.digest, sha256(crx));
  assert.deepEqual(env.removed, [1]);
});

// F6: concurrent installs each keep their own download record.
test("two concurrent installs both get cleaned up", async () => {
  const key = await crxKey();
  const crx = await packCrx3(zip, key.pkcs8);
  let gets = 0;
  let release;
  const both = new Promise((r) => { release = r; });
  const env = fakeChrome({ hooks: { async beforeGet(keys) {
    // Make both installs read the download bookkeeping before either writes it.
    if (keys === null || (typeof keys === "string" && /pending|install:/.test(keys))) {
      if (++gets === 2) release();
      if (gets <= 2) await Promise.race([both, new Promise((r) => setTimeout(r, 50))]);
    }
  } } });
  await Promise.all([installFile(crx, "one.crx"), installFile(crx, "two.crx")]);
  await browserInstalls(env, key.id, "1.0");
  assert.deepEqual(env.removed.sort(), [1, 2]);
});

// Requirement (cleanup): an install deletes only the copies of the extension that installed.
test("onInstalled deletes only the copies of the extension that was installed", async () => {
  const a = await crxKey();
  const b = await crxKey();
  const env = fakeChrome();
  await installFile(await packCrx3(zip, a.pkcs8), "a.crx");
  await installFile(await packCrx3(zip, b.pkcs8), "b.crx");
  await browserInstalls(env, a.id, "1.0");
  assert.deepEqual(env.removed, [1]);
  assert.deepEqual(env.erased, [1]);
});

// F6: a declined prompt leaves a file that the sweep deletes; nothing is committed.
test("the sweep deletes the copy of a declined install after the grace period and commits nothing", async () => {
  const { env } = await rebuildSetup();
  await installRelease(K);
  await sweepDownloads(Date.now() + manager.PENDING_GRACE_MS);
  assert.deepEqual(env.removed, [1]);
  assert.deepEqual(env.erased, [1]);
  assert.equal((await trackedView())[0].state, "update");
});

// F6: a removal failure other than "already gone" keeps the record so a later sweep retries.
test("a failed file removal keeps the download record for a retry", async () => {
  const { env } = await rebuildSetup();
  await installRelease(K);
  env.removeFileError = new Error("Access denied");
  await sweepDownloads(Date.now() + manager.PENDING_GRACE_MS);
  assert.deepEqual(env.erased, [], "the download entry is not erased while its file remains");
  env.removeFileError = null;
  await sweepDownloads(Date.now() + manager.PENDING_GRACE_MS);
  assert.deepEqual(env.removed, [1]);
  assert.deepEqual(env.erased, [1]);
});

// F6: a file that is already gone counts as removed.
test("a CRX copy the user already deleted is still erased from the download list", async () => {
  const { env } = await rebuildSetup();
  await installRelease(K);
  env.files.get(1).exists = false;
  await sweepDownloads(Date.now() + manager.PENDING_GRACE_MS);
  assert.deepEqual(env.erased, [1]);
  env.erased.length = 0;
  await sweepDownloads(Date.now() + manager.PENDING_GRACE_MS);
  assert.deepEqual(env.erased, [], "nothing left to retry");
});

// F5: a pre-release signed with another key must not silently relink the installed extension.
test("a pre-release signed by a different key asks for confirmation instead of relinking the installed extension", async () => {
  const stable = await crxKey();
  const other = await crxKey();
  const env = fakeChrome({ extensions: [{ id: stable.id, version: "1.0", name: "Example", enabled: true }] });
  fakeGithub([
    { tag: "v1", assets: [{ name: "example.crx", bytes: await packCrx3(zip, stable.pkcs8) }] },
    { tag: "v2b1", prerelease: true, publishedAt: "2026-02-01T00:00:00Z", assets: [{ name: "example.crx", bytes: await packCrx3(zip, other.pkcs8) }] },
  ]);
  await importBackup(v1Backup([v1Record({ extensionId: stable.id })]));
  await setPrereleases(K, true);
  let [view] = await trackedView();
  assert.equal(view.record.extensionId, stable.id, "still linked to the installed extension");
  assert.equal(view.state, "identity-change");
  assert.deepEqual({ from: view.record.identityChange.from, to: view.record.identityChange.to }, { from: stable.id, to: other.id });
  await assert.rejects(installRelease(K), /identity/i);
  assert.equal(env.handedOff.length, 0);
  await manager.confirmIdentityChange(K);
  [view] = await trackedView();
  assert.equal(view.record.extensionId, other.id);
  assert.equal(view.state, "not-installed");
});

// A different build of ext-root.zip with the same manifest version 1.0.
function rebuiltZip() {
  const data = new TextEncoder().encode("different rebuild");
  return buildZip([...parseZip(zip), { name: "new.txt", flags: 0, method: 0, mtime: 0, mdate: 0, crc: crc32(data), uncompSize: data.length, data }]);
}

// Two releases whose CRXs are different builds of extension key.id at version 1.0.
async function twoBuildsSetup() {
  const key = await crxKey();
  const a = await packCrx3(zip, key.pkcs8);
  const b = await packCrx3(rebuiltZip(), key.pkcs8);
  const env = fakeChrome({ extensions: [{ id: key.id, version: "1.0", name: "Example", enabled: true }] });
  fakeGithub([
    { tag: "v1", publishedAt: "2026-01-01T00:00:00Z", assets: [{ name: "example.crx", bytes: a, digest: sha256(a) }] },
    { tag: "v2", publishedAt: "2026-02-01T00:00:00Z", assets: [{ name: "example.crx", bytes: b, digest: sha256(b) }] },
  ]);
  await importBackup(v1Backup([v1Record({ extensionId: key.id, installed: { tag: "old", digest: null, version: "1.0" } })]));
  return { env, key, a, b };
}

// Item 2 (owner decision): Titanium's Add prompt is modal, so a new hand-off of
// another build of the same ID and version supersedes the earlier one at once;
// the install event confirms only the newest, and both copies are deleted.
test("a second build of the same extension version supersedes the first; the event commits only the second", async () => {
  const { env, key, b } = await twoBuildsSetup();
  await installRelease(K, "v1");
  await installRelease(K, "v2");
  assert.equal(env.handedOff.length, 2);
  let [view] = await trackedView();
  assert.equal(view.pendingInstall.tag, "v2");
  const first = Object.values(env.store).find((v) => v && v.installed && v.installed.tag === "v1" && v.token);
  assert.equal(first.version, null, "the first hand-off is no longer confirmable");
  assert.ok(first.supersededBy, "the first hand-off is marked superseded");
  await browserInstalls(env, key.id, "1.0");
  [view] = await trackedView();
  assert.deepEqual(view.record.installed, { tag: "v2", digest: sha256(b), version: "1.0" });
  assert.equal(view.pendingInstall, null);
  assert.deepEqual(env.removed.sort(), [1, 2], "the superseded copy is deleted too");
  assert.deepEqual(Object.keys(env.store).filter((k) => k.startsWith("install:")), []);
});

// Item 2: pending entries of two builds of one ID and version (as an older
// Extainium could leave them): one event confirms only the newest hand-off.
test("an install event matching pending entries of two different builds commits only the newest", async () => {
  const key = await crxKey();
  const env = fakeChrome({ extensions: [{ id: key.id, version: "1.0", name: "Example", enabled: true }] });
  fakeGithub([]);
  await importBackup(v1Backup([v1Record({ extensionId: key.id, installed: { tag: "old", digest: null, version: "1.0" } })]));
  const entry = (token, tag, crxHash, downloadId, at) => ({
    token, repoKey: K, extensionId: key.id, version: "1.0", installed: { tag, digest: null, version: "1.0" }, crxHash,
    downloadId, downloadDone: true, at, confirmedAt: null, fileGone: false, removeError: null,
  });
  const now = Date.now();
  for (const [id, e] of [[1, entry("b", "v2", "bb", 1, now - 1000)], [2, entry("a", "v1", "aa", 2, now - 2000)]]) {
    env.store["install:" + e.token] = e;
    env.files.set(id, { filename: e.token + ".crx", bytes: new Uint8Array(1), state: "complete", exists: true });
  }
  await browserInstalls(env, key.id, "1.0");
  const [view] = await trackedView();
  assert.equal(view.record.installed.tag, "v2");
  assert.deepEqual(env.removed.sort(), [1, 2]);
});

// F5: a local CRX never belongs to a tracked repo, even when one is selected;
// its install does not relink the repo.
test("installing a local CRX with a tracked repo selected does not relink that repo", async () => {
  const a = await crxKey();
  const b = await crxKey();
  const env = fakeChrome({ extensions: [{ id: a.id, version: "1.0", name: "A", enabled: true }] });
  Object.assign(env.store, { schema: 2, "repo:o/r": { ...newRecord("o", "r"), extensionId: a.id }, "key:o/r": Buffer.from(a.pkcs8).toString("base64") });
  const result = await installFile(await packCrx3(zip, b.pkcs8), "other.crx", "o/r");
  assert.equal(result.repoKey, null);
  await browserInstalls(env, b.id, "1.0");
  const [view] = await trackedView();
  assert.equal(view.record.extensionId, a.id);
  assert.equal(view.record.identityChange, null);
});

// F5: a zip signed with a tracked repo's key whose ID is not the repo's
// installed extension needs the identity-change confirmation first.
test("a local zip signed with a repo key of another ID than the installed one asks for an identity change", async () => {
  const author = await crxKey();
  const repoKeyPair = await crxKey();
  const env = fakeChrome({ extensions: [{ id: author.id, version: "1.0", name: "A", enabled: true }] });
  Object.assign(env.store, { schema: 2, "repo:o/r": { ...newRecord("o", "r"), extensionId: author.id }, "key:o/r": Buffer.from(repoKeyPair.pkcs8).toString("base64") });
  await assert.rejects(installFile(zip, "local.zip", "o/r"), /identity/i);
  assert.equal(env.handedOff.length, 0);
  const [view] = await trackedView();
  assert.equal(view.record.extensionId, author.id);
  assert.deepEqual({ from: view.record.identityChange.from, to: view.record.identityChange.to }, { from: author.id, to: repoKeyPair.id });
  await manager.confirmIdentityChange(K);
  await installFile(zip, "local.zip", "o/r");
  await browserInstalls(env, repoKeyPair.id, "1.0");
  const [after] = await trackedView();
  assert.equal(after.record.extensionId, repoKeyPair.id);
  assert.equal(after.record.installed.version, "1.0");
});

const pendingEntry = (extra) => ({
  token: "t", repoKey: null, extensionId: "a".repeat(32), version: "1.0", installed: null, crxHash: "x",
  downloadId: 1, downloadDone: false, at: 1, confirmedAt: null, fileGone: false, removeError: null, ...extra,
});

// F6: the sweep never cancels a download still in progress; it deletes the copy once it is complete
// and (round 3 F1, owner decision) the grace period from its completion, when the prompt appeared, has passed.
test("the sweep leaves a download in progress alone and deletes it the grace period after it completed", async () => {
  const env = fakeChrome();
  Object.assign(env.store, { schema: 2, "install:t": pendingEntry() });
  env.files.set(1, { filename: "large.crx", bytes: new Uint8Array(1), state: "in_progress", exists: true });
  await sweepDownloads(manager.PENDING_GRACE_MS + 1);
  assert.deepEqual(env.cancelled, []);
  assert.deepEqual(env.erased, []);
  assert.ok(env.store["install:t"], "the entry is kept");
  env.files.get(1).state = "complete";
  await sweepDownloads(manager.PENDING_GRACE_MS + 2);
  assert.deepEqual(env.removed, [], "the prompt of the completed download may still show");
  await sweepDownloads(2 * manager.PENDING_GRACE_MS + 2);
  assert.deepEqual(env.removed, [1]);
  assert.deepEqual(env.erased, [1]);
});

// F6: an interrupted download has no complete file; erase deletes the partial file.
test("the sweep erases an interrupted download without removing a file first", async () => {
  const env = fakeChrome();
  Object.assign(env.store, { schema: 2, "install:t": pendingEntry() });
  env.files.set(1, { filename: "broken.crx", bytes: new Uint8Array(1), state: "interrupted", exists: false });
  await sweepDownloads(manager.PENDING_GRACE_MS + 1);
  assert.deepEqual(env.removed, []);
  assert.deepEqual(env.erased, [1]);
});

// F6: a sweep while a hand-off still waits for its download ID keeps the entry,
// so the download is tracked and cleaned up later.
test("a sweep during a hand-off that has no download ID yet keeps tracking it", async () => {
  const env = fakeChrome();
  const { promise: started, resolve: enter } = Promise.withResolvers();
  const { promise: gate, resolve: release } = Promise.withResolvers();
  env.onDownloadStarted = async () => { enter(); await gate; };
  const install = installFile(zip, "x.zip", null);
  await started;
  await sweepDownloads(Date.now() + manager.PENDING_GRACE_MS + 1);
  release();
  const result = await install;
  assert.equal(env.store["install:" + result.token].downloadId, 1);
  await sweepDownloads(Date.now() + manager.PENDING_GRACE_MS + 1);
  assert.deepEqual(env.removed, [1]);
});

// Phone run item A: a declined install of a repo that is then removed does not
// show as pending when the repo is tracked again; its copy is still deleted.
test("removing a repo ends its pending installs, so tracking it again shows none", async () => {
  const { env, key } = await rebuildSetup();
  await installRelease(K);
  assert.ok((await trackedView())[0].pendingInstall);
  await manager.removeRepo(K, false);
  await importBackup(v1Backup([v1Record({ extensionId: key.id })]));
  assert.equal((await trackedView())[0].pendingInstall, null);
  await sweepDownloads(Date.now() + manager.PENDING_GRACE_MS);
  assert.deepEqual(env.removed, [1]);
  assert.deepEqual(Object.keys(env.store).filter((k) => k.startsWith("install:")), []);
});

// Phone run item A: a pending install left by a repo that is no longer tracked
// (as already stored on the phone) is ended by the sweep.
test("the sweep ends pending installs of repos that are no longer tracked", async () => {
  const key = await crxKey();
  const env = fakeChrome();
  fakeGithub([]);
  Object.assign(env.store, { schema: 2, "install:t": pendingEntry({ repoKey: K, extensionId: key.id, downloadDone: true, at: Date.now() }) });
  env.files.set(1, { filename: "declined.crx", bytes: new Uint8Array(1), state: "complete", exists: true });
  await sweepDownloads(Date.now());
  await importBackup(v1Backup([v1Record({ extensionId: key.id })]));
  assert.equal((await trackedView())[0].pendingInstall, null);
  await browserInstalls(env, key.id, "1.0");
  assert.equal((await trackedView())[0].record.installed, null, "the ended install is not committed");
  await sweepDownloads(Date.now() + manager.PENDING_GRACE_MS);
  assert.deepEqual(env.removed, [1]);
  assert.deepEqual(Object.keys(env.store).filter((k) => k.startsWith("install:")), []);
});

// Phone run item B: right after an install the browser may still hold the
// file; the deletion is retried shortly, and the failure is not recorded.
test("a copy the browser still holds right after the install is deleted by a quiet retry", async (t) => {
  const { env, key } = await rebuildSetup();
  const saved = { ...manager.cleanupTiming };
  Object.assign(manager.cleanupTiming, { retryMs: 5, settleMs: 1 });
  t.after(() => Object.assign(manager.cleanupTiming, saved));
  await installRelease(K);
  const removeFile = chrome.downloads.removeFile;
  let failures = 1;
  chrome.downloads.removeFile = async (id) => {
    if (failures-- > 0) throw new Error("Unable to remove file");
    return removeFile(id);
  };
  const errors = [];
  env.hooks.beforeSet = async (obj) => {
    for (const v of Object.values(obj)) if (v && v.removeError) errors.push(v.removeError);
  };
  await browserInstalls(env, key.id, "1.0");
  assert.deepEqual(env.removed, [1]);
  assert.deepEqual(env.erased, [1]);
  assert.deepEqual(errors, []);
  assert.deepEqual(Object.keys(env.store).filter((k) => k.startsWith("install:")), []);
});


// Item 4: a CRX is verified before the hand-off; a damaged one never reaches the browser.
test("a CRX release asset with a changed archive byte is refused before the hand-off", async () => {
  const key = await crxKey();
  const crx = await packCrx3(zip, key.pkcs8);
  crx[crx.length - 30] ^= 1;
  const env = fakeChrome();
  fakeGithub([{ tag: "v1", assets: [{ name: "example.crx", bytes: crx }] }]);
  await importBackup(v1Backup([v1Record()]));
  await assert.rejects(installRelease(K), new RegExp(`verify example\\.crx: the RSA signature of key ${key.id} does not verify`));
  assert.equal(env.handedOff.length, 0);
  await assert.rejects(installFile(crx, "local.crx", null), /verify local\.crx: the RSA signature/);
  assert.equal(env.handedOff.length, 0);
});

// Item 6: Chromium (158) classes a ".crx" download started without a user
// gesture as dangerous, and chrome.downloads.acceptDanger then shows the
// "Confirm download"/Keep dialog. A name without any "." keeps no extension
// (download_target_determiner.cc GenerateSafeFileName passes no MIME type for
// an extension-less name) and gets the default, not-dangerous file type, while
// the install path keys on the MIME type alone.
test("the CRX is handed to the browser under a file name without any dot", async () => {
  const key = await crxKey();
  const env = fakeChrome();
  await installFile(await packCrx3(zip, key.pkcs8), "uBlock0_1.77.0.chromium.crx", null);
  const { filename } = env.files.get(1);
  assert.match(filename, /^[A-Za-z0-9_-]+$/, filename);
  assert.match(filename, /^Example-1_0-\d+$/, "names the extension and version");
});


// ---- Round 3 F2: a replacement supersedes only once its prompt is up ----
// (owner decision) An earlier pending entry is superseded only when the
// replacement's hand-off download completed; before that the earlier entry
// stays confirmable with its key hold, and an install event in between is the
// earlier one's. A replacement that fails to start or is interrupted supersedes nothing.

// Releases v1 and v2 with the same zip (manifest 1.0), tracked with a stored signing key.
async function zipBuildsSetup() {
  const { privateKey } = nodeCrypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
  const pkcs8 = privateKey.export({ type: "pkcs8", format: "der" }).toString("base64");
  const env = fakeChrome();
  fakeGithub(["v2", "v1"].map((tag) => ({ tag, assets: [{ name: "example.zip", bytes: zip }] })));
  await importBackup(v1Backup([v1Record({ pattern: "^example\\.zip$", keyPkcs8: pkcs8 })]));
  return { env, pkcs8 };
}
const entryOf = (env, tag) => Object.values(env.store).find((v) => v && v.token && v.installed && v.installed.tag === tag);

// Starts installRelease(K, tag) with its download left in progress; resolves once the hand-off waits for it.
async function startInFlight(env, tag) {
  env.newDownloadState = "in_progress";
  const { promise: started, resolve } = Promise.withResolvers();
  env.onDownloadStarted = async (id) => { env.onDownloadStarted = null; resolve(id); };
  const installing = installRelease(K, tag);
  const id = await started;
  while (!env.changedListeners.size) await new Promise((r) => setTimeout(r, 1));
  env.newDownloadState = "complete";
  return { id, installing };
}
const completeDownload = (env, id) => {
  env.files.get(id).state = "complete";
  env.emitChanged({ id, state: { previous: "in_progress", current: "complete" } });
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// F2 repro, with the op lock: a replacement started while the first download
// is in flight waits for it; when its download then fails to start it supersedes nothing.
test("a replacement started during the first download waits for it, and when it fails to start supersedes nothing", async () => {
  const { env } = await zipBuildsSetup();
  const first = await startInFlight(env, "v1");
  const download = chrome.downloads.download;
  let calls = 0;
  chrome.downloads.download = async () => { calls++; throw new Error("start rejected"); };
  const second = installRelease(K, "v2");
  await sleep(10);
  assert.equal(calls, 0, "the replacement waits while the first download is in flight");
  completeDownload(env, first.id);
  await first.installing;
  await assert.rejects(second, /start rejected/);
  chrome.downloads.download = download;
  assert.equal(calls, 1);
  const e = entryOf(env, "v1");
  assert.deepEqual({ version: e.version, signedWith: e.signedWith, supersededBy: e.supersededBy }, { version: "1.0", signedWith: K, supersededBy: null });
  const { extensionId } = await first.installing;
  await browserInstalls(env, extensionId, "1.0");
  assert.equal((await trackedView())[0].record.installed.tag, "v1");
});

test("a removal with uninstall queued behind an in-flight install and a replacement that fails to start keeps the key of the first install's prompt", async () => {
  const { env, pkcs8 } = await zipBuildsSetup();
  const first = await startInFlight(env, "v1");
  const download = chrome.downloads.download;
  chrome.downloads.download = async () => { throw new Error("start rejected"); };
  const second = installRelease(K, "v2");
  const removal = manager.removeRepo(K, true);
  await sleep(10);
  assert.ok(env.store["repo:" + K], "the removal waits");
  completeDownload(env, first.id);
  await first.installing;
  await assert.rejects(second, /start rejected/);
  chrome.downloads.download = download;
  await removal;
  assert.equal(env.store["key:" + K], pkcs8, "held by the first install's prompt");
  await sweepDownloads(Date.now() + manager.PENDING_GRACE_MS);
  assert.equal(env.store["key:" + K], undefined);
});

// F2 repro: the event of the first prompt arrives while the second download is only starting.
test("an install event that arrives while the replacement is still downloading commits the earlier build", async () => {
  const { env } = await zipBuildsSetup();
  const first = await installRelease(K, "v1");
  const second = await startInFlight(env, "v2");
  assert.equal(entryOf(env, "v1").version, "1.0", "the first is still confirmable while the second downloads");
  await browserInstalls(env, first.extensionId, "1.0");
  assert.equal((await trackedView())[0].record.installed.tag, "v1");
  completeDownload(env, second.id);
  await second.installing;
  assert.equal((await trackedView())[0].pendingInstall.tag, "v2", "the second prompt is pending now");
  await browserInstalls(env, first.extensionId, "1.0");
  assert.equal((await trackedView())[0].record.installed.tag, "v2");
});

test("an interrupted replacement supersedes nothing: the earlier prompt's install event still commits it", async () => {
  const { env } = await zipBuildsSetup();
  const first = await installRelease(K, "v1");
  const second = await startInFlight(env, "v2");
  env.files.get(second.id).state = "interrupted";
  env.emitChanged({ id: second.id, state: { previous: "in_progress", current: "interrupted" }, error: { current: "NETWORK_FAILED" } });
  await assert.rejects(second.installing, /interrupted/);
  assert.equal(entryOf(env, "v1").version, "1.0");
  assert.equal((await trackedView())[0].pendingInstall.tag, "v1");
  await browserInstalls(env, first.extensionId, "1.0");
  assert.equal((await trackedView())[0].record.installed.tag, "v1");
});

