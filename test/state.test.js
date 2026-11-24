import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import nodeCrypto from "node:crypto";
import fc from "fast-check";
import { extensionIdFromCrx } from "../src/lib/crx.js";
import {
  PENDING_GRACE_MS, addRepo, checkRepo, chooseAsset, exportBackup, fileKeysView, handleExtensionInstalled, importBackup,
  installFile, installRelease, removeRepo, setPrereleases, sweepDownloads, trackInstalledFile, trackedView,
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


// ---- Item 1: removing a repo with uninstall defers deleting its key ----
// (owner decision) The key is deleted only once no pending or in-flight install
// signed with it remains; until then it stays stored and exported.

async function trackedWithKey(key) {
  const env = fakeChrome();
  fakeGithub([zipRelease("v1")]);
  await importBackup(v1Backup([v1Record({ keyPkcs8: key })]));
  return env;
}
const marks = (env) => Object.keys(env.store).filter((k) => k.startsWith("keydelete:"));

test("a removal with uninstall while an install signed with the key is pending keeps and exports the key until the install expires", async () => {
  const key = newPkcs8();
  const env = await trackedWithKey(key);
  await installRelease(K);
  await removeRepo(K, true);
  assert.equal(env.store["key:" + K], key, "still stored while the install is pending");
  assert.equal(JSON.parse(await exportBackup()).keys[K], key, "exported while it exists");
  await sweepDownloads(Date.now());
  assert.equal(env.store["key:" + K], key, "a sweep within the grace period keeps it");
  await sweepDownloads(Date.now() + PENDING_GRACE_MS);
  assert.equal(env.store["key:" + K], undefined, "deleted once the pending install expired");
  assert.equal(JSON.parse(await exportBackup()).keys[K], undefined);
  assert.deepEqual(marks(env), []);
});

test("a removal with uninstall while an install signed with the key is pending deletes the key once that install is confirmed", async () => {
  const key = newPkcs8();
  const env = await trackedWithKey(key);
  await installRelease(K);
  const id = await extensionIdFromCrx(env.handedOff[0]);
  await removeRepo(K, true);
  assert.equal(env.store["key:" + K], key);
  env.install(id, "1.0");
  await handleExtensionInstalled({ id, version: "1.0" });
  assert.equal(env.store["key:" + K], undefined);
  assert.deepEqual(marks(env), []);
});

test("a removal with uninstall during the hand-off's download keeps the key, and the failed download releases it", async () => {
  const key = newPkcs8();
  const env = await trackedWithKey(key);
  let keptDuring = null;
  env.onDownloadStarted = async (downloadId) => {
    env.onDownloadStarted = null;
    await removeRepo(K, true);
    keptDuring = env.store["key:" + K];
    env.files.get(downloadId).state = "interrupted";
  };
  await assert.rejects(installRelease(K), /interrupted/);
  assert.equal(keptDuring, key, "kept while the hand-off was in flight");
  assert.equal(env.store["key:" + K], undefined, "deleted when the hand-off failed");
  assert.deepEqual(marks(env), []);
});

// A removal with uninstall that completes while an install downloads its asset
// leaves no key behind: the install must not create a new key for the removed repo.
test("an install whose repo is removed with uninstall during the asset download stores no new key", async () => {
  const key = newPkcs8();
  const env = await trackedWithKey(key);
  const { promise: entered, resolve: enter } = Promise.withResolvers();
  const { promise: gate, resolve: release } = Promise.withResolvers();
  const fetch0 = globalThis.fetch;
  globalThis.fetch = async (...args) => {
    if (String(args[0]).endsWith("/example.zip")) { enter(); await gate; }
    return fetch0(...args);
  };
  const install = installRelease(K);
  await entered;
  await removeRepo(K, true);
  release();
  await assert.rejects(install, /no longer tracked/);
  assert.equal(env.store["key:" + K], undefined);
  assert.equal(env.handedOff.length, 0);
});

// Model: an install runs while a removal with uninstall and an export start at
// generated points of its storage calls, and the scheduler orders the calls
// of all three. A key that signed a handed-off CRX stays stored while that
// install may be pending, every export of the repo holds the key, and a
// removed repo's key is gone once the pending installs have expired.
test("property: an install interleaved with a removal with uninstall keeps a handed-off CRX's key until it expires", async () => {
  const key = newPkcs8();
  const point = fc.integer({ min: 0, max: 40 });
  await fc.assert(
    fc.asyncProperty(fc.scheduler(), point, point, async (s, removeAt, exportAt) => {
      const env = await trackedWithKey(key);
      const local = chrome.storage.local;
      let calls = 0;
      let removed = false;
      const exports = [];
      const started = [];
      const startAt = () => {
        if (calls === removeAt) {
          started.push(removeRepo(K, true).then(() => { removed = true; }, (e) => {
            if (!/not tracked/.test(e.message)) throw e;
          }));
        }
        if (calls === exportAt) started.push(exportBackup().then((t) => exports.push(JSON.parse(t))));
        calls++;
      };
      const counted = (fn) => s.scheduleFunction(async (...args) => {
        startAt();
        return fn(...args);
      });
      chrome.storage.local = { get: counted(local.get), set: counted(local.set), remove: counted(local.remove) };
      const install = installRelease(K).catch((e) => {
        if (!/not tracked|no longer tracked/.test(e.message)) throw e;
      });
      await s.waitFor(install);
      while (started.length) await s.waitFor(Promise.all(started.splice(0)));
      chrome.storage.local = local;
      const ids = new Set(await Promise.all(env.handedOff.map(extensionIdFromCrx)));
      if (ids.size) {
        assert.deepEqual([...ids], [idOfPkcs8(key)]);
        assert.equal(env.store["key:" + K], key, "the key of a pending handed-off CRX is stored");
      } else if (removed) {
        assert.equal(env.store["key:" + K], undefined, "nothing pending: deleted at once");
      }
      for (const b of exports) if (b.repos.length) assert.equal(b.keys[K], key, "an export holds a tracked repo's key");
      await sweepDownloads(Date.now() + PENDING_GRACE_MS);
      if (removed) {
        assert.equal(env.store["key:" + K], undefined, "deleted once the pending installs expired");
        assert.deepEqual(marks(env), []);
      }
    }),
    { numRuns: 100 }
  );
});

// ---- Item 5: keys of zips installed from a file without a repo ----

test("a zip installed from a file without a repo keeps its key: listed, exported, restored by an import, and usable again", async () => {
  const env = fakeChrome();
  fakeGithub([]);
  const f = await installFile(zip, "local.zip", null);
  assert.equal(idOfPkcs8(f.keyPkcs8), f.extensionId);
  assert.deepEqual(await fileKeysView(), [{ value: "file:" + f.extensionId, extensionId: f.extensionId, name: null, version: null }]);
  env.install(f.extensionId, "1.0");
  assert.deepEqual((await fileKeysView())[0], { value: "file:" + f.extensionId, extensionId: f.extensionId, name: "Example", version: "1.0" });
  const text = await exportBackup();
  const backup = JSON.parse(text);
  assert.equal(backup.version, 3);
  assert.deepEqual(backup.fileKeys, { [f.extensionId]: f.keyPkcs8 });

  const fresh = fakeChrome();
  fakeGithub([]);
  await importBackup(text);
  assert.equal(fresh.store["filekey:" + f.extensionId], f.keyPkcs8);
  const again = await installFile(zip, "local.zip", "file:" + f.extensionId);
  assert.equal(again.extensionId, f.extensionId, "signed with the restored key: same extension ID");
  assert.equal(await extensionIdFromCrx(fresh.handedOff[0]), f.extensionId);
});

test("tracking a file install attaches the stored file key to the repo and drops it from the file keys", async () => {
  const env = fakeChrome();
  fakeGithub([zipRelease("v1")]);
  const f = await installedFromFile(env);
  // The page's result may be gone (e.g. reloaded); the key comes from the store.
  await trackInstalledFile(K, { ...f, keyPkcs8: null });
  assert.equal(env.store["key:" + K], f.keyPkcs8);
  assert.equal(env.store["filekey:" + f.extensionId], undefined);
  assert.deepEqual(await fileKeysView(), []);
  const backup = JSON.parse(await exportBackup());
  assert.equal(backup.keys[K], f.keyPkcs8);
  assert.deepEqual(backup.fileKeys, {});
  assert.equal(backup.repos[0].extensionId, f.extensionId);
});

test("a file key that the backup also holds as a repo key is imported only as the repo key", async () => {
  const key = newPkcs8();
  const id = idOfPkcs8(key);
  const env = fakeChrome();
  fakeGithub([]);
  await importBackup(JSON.stringify({
    format: "extainium-backup", version: 3, exportedAt: "2026-11-24T00:00:00.000Z",
    repos: [{ owner: "o", repo: "r", template: null, includePrereleases: false, extensionId: id, installed: null, addedAt: 1 }],
    keys: { [K]: key }, fileKeys: { [id]: key },
  }));
  assert.equal(env.store["key:" + K], key);
  assert.equal(env.store["filekey:" + id], undefined);
});


// ---- Round 3 F1: a key hold lasts while the install is in flight ----
// (owner decision) The hold starts its PENDING_GRACE_MS prompt clock only when
// the hand-off download completes; the key is exported while held.

test("a removal with uninstall keeps the key past the grace period while the hand-off download is in progress, then for the grace period after it completes", async () => {
  const key = newPkcs8();
  const env = await trackedWithKey(key);
  env.newDownloadState = "in_progress";
  const { promise: started, resolve } = Promise.withResolvers();
  env.onDownloadStarted = async () => resolve();
  const installing = installRelease(K);
  await started;
  while (!env.changedListeners.size) await new Promise((r) => setTimeout(r, 1));
  await removeRepo(K, true);
  await sweepDownloads(Date.now() + 10 * PENDING_GRACE_MS);
  assert.equal(env.store["key:" + K], key, "held while the download is in progress");
  assert.equal(JSON.parse(await exportBackup()).keys[K], key, "exported while held");
  assert.deepEqual(env.cancelled, [], "the download is not cancelled");
  env.files.get(1).state = "complete";
  env.emitChanged({ id: 1, state: { previous: "in_progress", current: "complete" } });
  await installing;
  await sweepDownloads(Date.now() + PENDING_GRACE_MS - 5000);
  assert.equal(env.store["key:" + K], key, "held within the grace period after the download completed");
  await sweepDownloads(Date.now() + PENDING_GRACE_MS);
  assert.equal(env.store["key:" + K], undefined, "deleted once the prompt expired");
  assert.deepEqual(marks(env), []);
});

test("a removal with uninstall keeps the key past the grace period while the hand-off waits for its download ID", async () => {
  const key = newPkcs8();
  const env = await trackedWithKey(key);
  const { promise: started, resolve } = Promise.withResolvers();
  const { promise: gate, resolve: release } = Promise.withResolvers();
  env.onDownloadStarted = async () => { resolve(); await gate; };
  const installing = installRelease(K);
  await started;
  await removeRepo(K, true);
  await sweepDownloads(Date.now() + 10 * PENDING_GRACE_MS);
  assert.equal(env.store["key:" + K], key, "held while the download ID is not known");
  release();
  await installing;
  await sweepDownloads(Date.now() + PENDING_GRACE_MS);
  assert.equal(env.store["key:" + K], undefined);
});

// A hand-off whose page closed during the download never learns that it
// completed; the sweep reads the download's end from the browser.
test("a sweep finds the end of a download whose hand-off page went away and starts the prompt clock then", async () => {
  const key = newPkcs8();
  const env = await trackedWithKey(key);
  Object.assign(env.store, { "install:t": {
    token: "t", repoKey: K, extensionId: idOfPkcs8(key), version: "1.0", installed: { tag: "v1", digest: null, version: "1.0" },
    crxHash: "x", signedWith: K, supersededBy: null, downloadId: 7, downloadDone: false, at: 1, confirmedAt: null, fileGone: false, removeError: null,
  } });
  env.files.set(7, { filename: "x", bytes: new Uint8Array(1), state: "in_progress", exists: true });
  await removeRepo(K, true);
  const t0 = Date.now();
  await sweepDownloads(t0);
  assert.equal(env.store["key:" + K], key, "in progress: held");
  env.files.get(7).state = "complete";
  await sweepDownloads(t0 + 1000);
  assert.equal(env.store["key:" + K], key, "completed just now: held");
  assert.deepEqual(env.removed, [], "the copy is kept while the prompt may show");
  await sweepDownloads(t0 + 1000 + PENDING_GRACE_MS);
  assert.equal(env.store["key:" + K], undefined);
  assert.deepEqual(env.removed, [7]);
});

// ---- Round 3 F3/F4: a file key lives in one place ----

// F3 repro: tracking moved the file key to the repo before its first check;
// when that check fails, the repo goes and the key must be a file key again.
test("tracking a file install whose first check fails keeps the file key selectable and stores no repo key", async () => {
  const env = fakeChrome();
  fakeGithub([]);
  const f = await installFile(zip, "local.zip", null);
  const fetch0 = globalThis.fetch;
  globalThis.fetch = async (url, init) => (String(url).startsWith("https://api.github.com/") ? new Response("no such repo", { status: 404 }) : fetch0(url, init));
  await assert.rejects(trackInstalledFile(K, { ...f, keyPkcs8: null }), /HTTP 404/);
  assert.equal(env.store["repo:" + K], undefined, "not tracked");
  assert.equal(env.store["filekey:" + f.extensionId], f.keyPkcs8, "the file key is back");
  assert.equal(env.store["key:" + K], undefined, "and not also a repo key");
  assert.deepEqual((await fileKeysView()).map((v) => v.value), ["file:" + f.extensionId]);
  const entry = env.store["install:" + f.token];
  assert.deepEqual({ repoKey: entry.repoKey, version: entry.version, signedWith: entry.signedWith }, { repoKey: null, version: "1.0", signedWith: null }, "the pending file install is as before");
});

// F4 repro: an install with a selected file key read the key before tracking
// moved it to a repo, and its hand-off wrote it back as a file key.
test("an install with a file key that tracking moved meanwhile is refused and does not bring the file key back", async () => {
  const env = fakeChrome();
  fakeGithub([zipRelease("v1")]);
  const f = await installedFromFile(env);
  const { promise: started, resolve } = Promise.withResolvers();
  const { promise: gate, resolve: release } = Promise.withResolvers();
  const get = chrome.storage.local.get;
  let hold = true;
  chrome.storage.local.get = async (k) => {
    const value = await get(k);
    if (hold && k === "filekey:" + f.extensionId) { hold = false; resolve(); await gate; }
    return value;
  };
  const second = installFile(zip, "local.zip", "file:" + f.extensionId);
  await started;
  await trackInstalledFile(K, { ...f, keyPkcs8: null });
  release();
  await assert.rejects(second, new RegExp(`install local\\.zip: the file key of extension ${f.extensionId} is no longer stored`));
  assert.equal(env.store["filekey:" + f.extensionId], undefined, "not written back");
  assert.equal(env.store["key:" + K], f.keyPkcs8);
  assert.equal(env.handedOff.length, 1, "only the first install was handed off");
  await removeRepo(K, true);
  await sweepDownloads(Date.now() + PENDING_GRACE_MS);
  assert.equal(env.store["key:" + K], undefined);
  assert.equal(env.store["filekey:" + f.extensionId], undefined, "the deleted key survives nowhere");
});

// Model (F3/F4): tracking a file install (whose first check fails or succeeds),
// installs signed with the selected file key, and a removal with uninstall run
// concurrently; the scheduler orders all storage and network calls. The file's
// key is never both a file key and a repo key; while the repo is tracked it is
// the repo key; without a successful removal and with the repo untracked it is
// still a selectable file key; after a removal it survives nowhere.
test("property: interleaved track/file-key install/remove keep the file key in exactly one place", async () => {
  const op = fc.constantFrom("track", "install", "remove");
  await fc.assert(
    fc.asyncProperty(fc.scheduler(), fc.array(op, { minLength: 2, maxLength: 4 }), fc.boolean(), async (s, ops, apiFails) => {
      const env = fakeChrome();
      fakeGithub([zipRelease("v1")]);
      const f = await installedFromFile(env);
      const k = f.keyPkcs8;
      const local = chrome.storage.local;
      chrome.storage.local = {
        get: s.scheduleFunction(local.get),
        set: s.scheduleFunction(local.set),
        remove: s.scheduleFunction(local.remove),
      };
      const fetch0 = globalThis.fetch;
      const scheduledFetch = s.scheduleFunction(async (url, init) =>
        (apiFails && String(url).startsWith("https://api.github.com/") ? new Response("no such repo", { status: 404 }) : fetch0(url, init)));
      globalThis.fetch = async (...args) => {
        await new Promise((r) => setTimeout(r, 5));
        return scheduledFetch(...args);
      };
      let removed = false;
      const run = {
        track: () => trackInstalledFile(K, { ...f, keyPkcs8: null }).catch((e) => {
          if (!/already tracked|HTTP 404|not tracked/.test(e.message)) throw e;
        }),
        install: () => installFile(zip, "local.zip", "file:" + f.extensionId).catch((e) => {
          if (!/is no longer stored|no file key is stored/.test(e.message)) throw e;
        }),
        remove: () => removeRepo(K, true).then(() => { removed = true; }, (e) => {
          if (!/not tracked/.test(e.message)) throw e;
        }),
      };
      const results = await s.waitFor(Promise.allSettled(ops.map((o) => run[o]())));
      chrome.storage.local = local;
      globalThis.fetch = fetch0;
      for (const r of results) if (r.status === "rejected") throw r.reason;
      const places = () => ({ file: env.store["filekey:" + f.extensionId] === k, repo: env.store["key:" + K] === k });
      assert.ok(!(places().file && places().repo), "never both a file key and a repo key");
      if (env.store["repo:" + K]) assert.ok(places().repo, "a tracked repo holds the moved key");
      else if (!removed) assert.ok(places().file, "untracked and not removed: still a selectable file key");
      for (const crx of env.handedOff) assert.equal(await extensionIdFromCrx(crx), f.extensionId);
      await sweepDownloads(Date.now() + PENDING_GRACE_MS);
      if (removed) assert.deepEqual(places(), { file: false, repo: false }, "removed with uninstall: the key survives nowhere");
    }),
    { numRuns: 60 }
  );
});



// F4 + F1: an unconfirmed install signed with the file key keeps holding the
// key once tracking moved it to a repo, so a removal with uninstall waits for it.
test("a pending install signed with a file key holds that key after tracking moved it to a repo", async () => {
  const env = fakeChrome();
  fakeGithub([zipRelease("v1")]);
  const f = await installedFromFile(env);
  await installFile(zip, "local.zip", "file:" + f.extensionId);
  await trackInstalledFile(K, { ...f, keyPkcs8: null });
  await removeRepo(K, true);
  assert.equal(env.store["key:" + K], f.keyPkcs8, "held by the pending install");
  await sweepDownloads(Date.now() + PENDING_GRACE_MS);
  assert.equal(env.store["key:" + K], undefined);
});

// F4: the page's copy of a file key never becomes a second repo's key.
test("tracking with a file's key that already is another repo's signing key is refused", async () => {
  const env = fakeChrome();
  fakeGithub([zipRelease("v1")]);
  const f = await installedFromFile(env);
  await trackInstalledFile(K, { ...f, keyPkcs8: null });
  await assert.rejects(trackInstalledFile("o/s", f), new RegExp(`track o/s: the file's key \\(extension ${f.extensionId}\\) is already the signing key of o/r`));
  assert.equal(env.store["key:o/s"], undefined);
  assert.equal(env.store["repo:o/s"], undefined);
});

