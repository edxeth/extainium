import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import nodeCrypto from "node:crypto";
import fc from "fast-check";
import { extensionIdFromCrx } from "../src/lib/crx.js";
import {
  addRepo, checkRepo, chooseAsset, exportBackup, importBackup, installRelease, removeRepo, setPrereleases, trackedView,
} from "../src/lib/manager.js";
import { exportedKey, fakeChrome, fakeGithub, v1Backup } from "./helpers/fake-chrome.js";

const zip = new Uint8Array(readFileSync(new URL("./fixtures/ext-root.zip", import.meta.url)));
const K = "o/r";

// Independent reference: Chromium's ID is hex(sha256(spki)[0..16]) with 0-f -> a-p.
function idOfPkcs8(b64) {
  const spki = nodeCrypto.createPublicKey(nodeCrypto.createPrivateKey({ key: Buffer.from(b64, "base64"), format: "der", type: "pkcs8" }))
    .export({ type: "spki", format: "der" });
  const hex = nodeCrypto.createHash("sha256").update(spki).digest("hex").slice(0, 32);
  return [...hex].map((c) => String.fromCharCode(97 + parseInt(c, 16))).join("");
}

function newPkcs8() {
  const { privateKey } = nodeCrypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
  return privateKey.export({ type: "pkcs8", format: "der" }).toString("base64");
}

// A record as Extainium 0.1 exported it, for seeding through importBackup.
const v1Record = (extra = {}) => ({
  owner: "o", repo: "r", pattern: "^example\\.zip$", includePrereleases: false, extensionId: null, keyPkcs8: null,
  installed: null, releases: null, etag: null, checkedAt: null, error: null, addedAt: 1, ...extra,
});

const zipRelease = (tag, extra = {}) => ({ tag, assets: [{ name: "example.zip", bytes: zip }], ...extra });

async function storedKey() {
  return exportedKey(await exportBackup(), K);
}

// F1 regression: the schedule of the review's key-race repro. A check holds its
// record write while an install generates the repo's first signing key.
test("a check that commits while an install creates the signing key does not drop the key", async () => {
  let armed = false;
  let held = null;
  let keyWritten = false;
  const env = fakeChrome({ hooks: {
    async beforeSet(obj) {
      const rec = obj["repo:" + K];
      if (Object.keys(obj).some((k) => k.startsWith("key:")) || (rec && rec.keyPkcs8)) keyWritten = true;
      if (!armed || !rec) return;
      armed = false;
      held.resolve();
      // Hold until the install wrote its key, or until it waits for the state lock.
      for (;;) {
        if (keyWritten) return;
        if (globalThis.navigator?.locks && (await navigator.locks.query()).pending.length) return;
        await new Promise((r) => setImmediate(r));
      }
    },
  } });
  fakeGithub([zipRelease("v1")]);
  await importBackup(v1Backup([v1Record()]));
  held = Promise.withResolvers();
  armed = true;
  const check = checkRepo(K);
  await held.promise;
  const result = await installRelease(K);
  await check;
  const signedId = await extensionIdFromCrx(env.handedOff.at(-1));
  assert.equal(result.extensionId, signedId);
  const key = await storedKey();
  assert.ok(key, "the signing key of the handed-off CRX is stored");
  assert.equal(idOfPkcs8(key), signedId);
});

// F1: record read-modify-writes from different contexts serialize; a check
// committing its release cache does not undo a settings change made meanwhile.
test("a check that commits while the pre-release setting changes keeps the new setting", async () => {
  let armed = false;
  let held = null;
  let settingWritten = false;
  fakeChrome({ hooks: {
    async beforeSet(obj) {
      const rec = obj["repo:" + K];
      if (rec && rec.includePrereleases) settingWritten = true;
      if (!armed || !rec) return;
      armed = false;
      held.resolve();
      for (;;) {
        if (settingWritten) return;
        if (globalThis.navigator?.locks && (await navigator.locks.query()).pending.length) return;
        await new Promise((r) => setImmediate(r));
      }
    },
  } });
  fakeGithub([zipRelease("v1")]);
  await importBackup(v1Backup([v1Record()]));
  held = Promise.withResolvers();
  armed = true;
  const check = checkRepo(K);
  await held.promise;
  await setPrereleases(K, true);
  await check;
  const [view] = await trackedView();
  assert.equal(view.record.includePrereleases, true);
});

// F1 model: whatever order storage calls of concurrent checks, pre-release
// toggles, installs and key-less imports resolve in, every zip CRX handed to
// the browser is signed by the one key that stays stored for the repo.
test("property: interleaved check/link/install/import never lose or replace the signing key", async () => {
  const op = fc.constantFrom("check", "link", "install", "import");
  await fc.assert(
    fc.asyncProperty(fc.scheduler(), fc.array(op, { minLength: 2, maxLength: 4 }), async (s, ops) => {
      const env = fakeChrome();
      fakeGithub([zipRelease("v1"), zipRelease("v2b1", { prerelease: true, publishedAt: "2026-02-01T00:00:00Z" })]);
      await importBackup(v1Backup([v1Record()]));
      const local = chrome.storage.local;
      chrome.storage.local = {
        get: s.scheduleFunction(local.get),
        set: s.scheduleFunction(local.set),
        remove: s.scheduleFunction(local.remove),
      };
      const run = {
        check: () => checkRepo(K),
        link: () => setPrereleases(K, true),
        install: () => installRelease(K),
        import: () => importBackup(v1Backup([v1Record()])),
      };
      const settled = Promise.allSettled(ops.map((o) => run[o]()));
      const results = await s.waitFor(settled);
      chrome.storage.local = local;
      for (const r of results) if (r.status === "rejected") throw r.reason;
      const ids = new Set(await Promise.all(env.handedOff.map(extensionIdFromCrx)));
      if (!ids.size) return;
      const key = await storedKey();
      assert.ok(key, "a key that signed a handed-off CRX is still stored");
      assert.deepEqual([...ids], [idOfPkcs8(key)]);
    }),
    { numRuns: 40 } // each run generates an RSA key; 40 runs take about 5 s
  );
});

// F2: stopping tracking keeps the key; the same repo added again keeps its extension ID.
test("removing a repo without uninstalling keeps its signing key, which re-attaches when the repo is added again", async () => {
  const key = newPkcs8();
  const id = idOfPkcs8(key);
  const env = fakeChrome({ extensions: [{ id, version: "1.0", name: "Example", enabled: true }] });
  fakeGithub([zipRelease("v1")]);
  await importBackup(v1Backup([v1Record({ keyPkcs8: key, extensionId: id })]));
  await removeRepo(K, false);
  assert.deepEqual(env.uninstalled, []);
  assert.equal(await storedKey(), key, "the export still holds the retained key");
  await addRepo(K);
  await chooseAsset(K, "example.zip", "v1");
  const [view] = await trackedView();
  assert.equal(view.record.extensionId, id);
  assert.equal(view.state, "current");
});

// F2: a key is deleted only together with an uninstall.
test("removing a repo with uninstall deletes its signing key", async () => {
  const key = newPkcs8();
  const id = idOfPkcs8(key);
  const env = fakeChrome({ extensions: [{ id, version: "1.0", name: "Example", enabled: true }] });
  fakeGithub([zipRelease("v1")]);
  await importBackup(v1Backup([v1Record({ keyPkcs8: key, extensionId: id })]));
  await removeRepo(K, true);
  assert.deepEqual(env.uninstalled, [id]);
  assert.equal(await storedKey(), null);
});

// F2: an import never replaces a different existing key; it reports the conflict.
test("importing a backup with a different key for a tracked repo keeps the current key and reports a conflict", async () => {
  const current = newPkcs8();
  const old = newPkcs8();
  fakeChrome({ extensions: [{ id: idOfPkcs8(current), version: "1.0", name: "Example", enabled: true }] });
  fakeGithub([zipRelease("v1")]);
  await importBackup(v1Backup([v1Record({ keyPkcs8: current, extensionId: idOfPkcs8(current) })]));
  const result = await importBackup(v1Backup([v1Record({ keyPkcs8: old, extensionId: idOfPkcs8(old) })]));
  assert.equal(await storedKey(), current);
  assert.deepEqual(result.conflicts, [{ key: K, keptId: idOfPkcs8(current), backupId: idOfPkcs8(old) }]);
  const [view] = await trackedView();
  assert.equal(view.record.extensionId, idOfPkcs8(current));
});
