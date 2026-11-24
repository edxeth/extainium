import { test } from "node:test";
import assert from "node:assert/strict";
import nodeCrypto from "node:crypto";
import { readFileSync } from "node:fs";
import { extensionIdFromSpki, packCrx3 } from "../src/lib/crx.js";
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
