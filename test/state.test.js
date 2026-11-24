import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import nodeCrypto from "node:crypto";
import fc from "fast-check";
import { extensionIdFromCrx } from "../src/lib/crx.js";
import {
  addRepo, checkRepo, chooseAsset, exportBackup, handleExtensionInstalled, importBackup, installFile, installRelease,
  removeRepo, setPrereleases, trackInstalledFile, trackedView,
} from "../src/lib/manager.js";
import { newRecord, parseBackup } from "../src/lib/store.js";
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

// A v2 backup tracking o/r (no template, not linked) with signing key b64.
const keyBackup = (b64) => JSON.stringify({
  format: "extainium-backup", version: 2, exportedAt: "2026-11-24T00:00:00.000Z",
  repos: [{ owner: "o", repo: "r", template: null, includePrereleases: false, extensionId: null, installed: null, addedAt: 1 }],
  keys: { [K]: b64 },
});

// A zip installed from a file with a new key and confirmed by the browser.
async function installedFromFile(env) {
  const f = await installFile(zip, "local.zip", null);
  env.install(f.extensionId, "1.0");
  await handleExtensionInstalled({ id: f.extensionId, version: "1.0" });
  return f;
}

// F1: an import that stores another key for the repo while trackInstalledFile
// waits for the network check never leaves the record linked to the file's
// extension without the file's key.
test("tracking a file install while an import brings another key keeps the file's key with its link", async () => {
  const env = fakeChrome();
  fakeGithub([{ tag: "v1", assets: [] }]);
  const f = await installedFromFile(env);
  const { promise: entered, resolve: enter } = Promise.withResolvers();
  const { promise: gate, resolve: release } = Promise.withResolvers();
  const fetch0 = globalThis.fetch;
  let first = true;
  globalThis.fetch = async (...args) => {
    if (first && String(args[0]).startsWith("https://api.github.com/")) { first = false; enter(); await gate; }
    return fetch0(...args);
  };
  const tracking = trackInstalledFile(K, f);
  await entered;
  const other = newPkcs8();
  const result = await importBackup(keyBackup(other));
  release();
  await tracking;
  const rec = env.store["repo:" + K];
  assert.equal(rec.extensionId, f.extensionId);
  assert.equal(env.store["key:" + K], f.keyPkcs8, "the key of the linked extension is stored");
  assert.deepEqual(result.conflicts.map((c) => c.backupId), [idOfPkcs8(other)]);
});

// F1: an export is one snapshot: a remove-with-uninstall that runs meanwhile
// never yields a repo without its key.
test("an export overlapping a remove with uninstall holds a repo only together with its key", async () => {
  const key = newPkcs8();
  const id = idOfPkcs8(key);
  let arm = false;
  let n = 0;
  const { promise: entered, resolve: enter } = Promise.withResolvers();
  const { promise: gate, resolve: release } = Promise.withResolvers();
  const env = fakeChrome({ extensions: [{ id, version: "1.0", name: "E", enabled: true }], hooks: { async beforeGet(keys) {
    if (arm && keys === null && ++n === 2) { enter(); await gate; }
  } } });
  Object.assign(env.store, { schema: 2, ["repo:" + K]: { ...newRecord("o", "r"), extensionId: id }, ["key:" + K]: key });
  await trackedView();
  arm = true;
  const exporting = exportBackup();
  await entered;
  let removed = false;
  const removing = removeRepo(K, true).then(() => { removed = true; });
  // Let the removal finish, or wait until it queues behind the export's lock.
  while (!removed && !(await navigator.locks.query()).pending.length) await new Promise((r) => setImmediate(r));
  release();
  const backup = JSON.parse(await exporting);
  await removing;
  assert.equal(backup.repos.length === 1, !!backup.keys[K], JSON.stringify({ repos: backup.repos.length, key: !!backup.keys[K] }));
});

// F1 model of the multi-step operations: whatever order the storage calls of
// concurrent track-from-file, import (with another key), export and
// remove-with-uninstall resolve in, a repo linked to the file's extension has
// the file's key, a repo linked to the imported key's extension has that key,
// and every export holds the key of each repo linked to one of them.
test("property: interleaved track/import/export/remove keep each linked ID with its signing key", async () => {
  const op = fc.constantFrom("track", "import", "export", "remove");
  const other = newPkcs8();
  const otherId = idOfPkcs8(other);
  await fc.assert(
    fc.asyncProperty(fc.scheduler(), fc.array(op, { minLength: 2, maxLength: 4 }), async (s, ops) => {
      const env = fakeChrome();
      fakeGithub([zipRelease("v1")]);
      const f = await installedFromFile(env);
      const keyOf = { [f.extensionId]: f.keyPkcs8, [otherId]: other };
      const local = chrome.storage.local;
      chrome.storage.local = {
        get: s.scheduleFunction(local.get),
        set: s.scheduleFunction(local.set),
        remove: s.scheduleFunction(local.remove),
      };
      // The network is slower than local crypto: a reply takes a few ms of real
      // time (so key parsing elsewhere can finish meanwhile), then is scheduled.
      const fetch0 = globalThis.fetch;
      const scheduledFetch = s.scheduleFunction(fetch0);
      globalThis.fetch = async (...args) => {
        await new Promise((r) => setTimeout(r, 10));
        return scheduledFetch(...args);
      };
      const exports = [];
      const run = {
        track: () => trackInstalledFile(K, f).catch((e) => {
          if (!/already tracked|different signing key/.test(e.message)) throw e;
        }),
        import: () => importBackup(keyBackup(other)),
        export: async () => exports.push(await exportBackup()),
        remove: () => removeRepo(K, true).catch((e) => {
          if (!/not tracked/.test(e.message)) throw e;
        }),
      };
      const results = await s.waitFor(Promise.allSettled(ops.map((o) => run[o]())));
      chrome.storage.local = local;
      globalThis.fetch = fetch0;
      for (const r of results) if (r.status === "rejected") throw r.reason;
      const rec = env.store["repo:" + K];
      if (rec && keyOf[rec.extensionId]) assert.equal(env.store["key:" + K], keyOf[rec.extensionId], "the linked ID's key is stored");
      for (const text of exports) {
        const b = JSON.parse(text);
        for (const r of b.repos) {
          if (keyOf[r.extensionId]) assert.equal(b.keys[K], keyOf[r.extensionId], "the export holds the linked ID's key");
        }
        await parseBackup(text);
      }
    }),
    { numRuns: 60 }
  );
});
