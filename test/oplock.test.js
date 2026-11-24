// The operation lock (owner decision after the round-3 closure review): every
// operation that changes state runs as a whole, one at a time, across the
// service worker and the pages; event handlers take only the state lock.
// Contexts are separate instances of manager.js sharing one fake browser
// profile (storage, downloads and Web Locks).

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import nodeCrypto from "node:crypto";
import fc from "fast-check";
import { extensionIdFromCrx } from "../src/lib/crx.js";
import * as page from "../src/lib/manager.js";
import { newRecord } from "../src/lib/store.js";
import { fakeChrome, fakeGithub, v1Backup } from "./helpers/fake-chrome.js";

const worker = await import("../src/lib/manager.js?context=worker");
const popup = await import("../src/lib/manager.js?context=popup");
// The fakes' file check is instant, so the sweep's wait for the browser's file check need not be real.
for (const m of [page, worker, popup]) m.cleanupTiming.settleMs = 1;

const zip = new Uint8Array(readFileSync(new URL("./fixtures/ext-root.zip", import.meta.url))); // manifest version 1.0
const K = "o/r";
const OP = "extainium-op";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const opWaiting = async () => (await navigator.locks.query()).pending.some((l) => l.name === OP);

function newPkcs8() {
  const { privateKey } = nodeCrypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
  return privateKey.export({ type: "pkcs8", format: "der" }).toString("base64");
}
function idOfPkcs8(b64) {
  const spki = nodeCrypto.createPublicKey(nodeCrypto.createPrivateKey({ key: Buffer.from(b64, "base64"), format: "der", type: "pkcs8" }))
    .export({ type: "spki", format: "der" });
  const hex = nodeCrypto.createHash("sha256").update(spki).digest("hex").slice(0, 32);
  return [...hex].map((c) => String.fromCharCode(97 + parseInt(c, 16))).join("");
}
const v1Record = (extra = {}) => ({
  owner: "o", repo: "r", pattern: "^example\\.zip$", includePrereleases: false, extensionId: null, keyPkcs8: null,
  installed: null, releases: null, etag: null, checkedAt: null, error: null, addedAt: 1, ...extra,
});
const zipReleases = (...tags) => tags.map((tag) => ({ tag, assets: [{ name: "example.zip", bytes: zip }] }));

// o/r tracked with a stored signing key; releases v2 and v1 of the same zip.
async function trackedWithKey(key = newPkcs8()) {
  const env = profile();
  const gh = fakeGithub(zipReleases("v2", "v1"));
  await page.importBackup(v1Backup([v1Record({ keyPkcs8: key })]));
  return { env, gh, key };
}

// Starts page.installRelease(K, tag) with its download left in progress; resolves once it waits for the download.
async function startInFlight(env, tag) {
  env.newDownloadState = "in_progress";
  const { promise: started, resolve } = Promise.withResolvers();
  env.onDownloadStarted = async (id) => { env.onDownloadStarted = null; resolve(id); };
  const installing = page.installRelease(K, tag);
  const id = await started;
  while (!env.changedListeners.size) await sleep(1);
  env.newDownloadState = "complete";
  return { id, installing };
}
const completeDownload = (env, id) => {
  env.files.get(id).state = "complete";
  env.emitChanged({ id, state: { previous: "in_progress", current: "complete" } });
};
// A fresh browser profile at the current storage schema. (Each context migrates
// once per module instance; a profile without the schema mark would be
// migrated again by a context that has not run yet.)
function profile(options) {
  const env = fakeChrome(options);
  env.store.schema = 2;
  return env;
}
const apiRequests = (gh) => gh.requests.filter((r) => r.url.startsWith("https://api.github.com/")).length;
const opRequests = (env) => env.locks.requests.filter((n) => n === OP).length;

// ---- one operation at a time ----

test("a background check started in the service worker while a page hands off an install runs only after the hand-off's download completed", async () => {
  const { env, gh } = await trackedWithKey();
  const first = await startInFlight(env, "v1");
  const before = apiRequests(gh);
  const checking = worker.checkAll();
  await sleep(20);
  assert.equal(apiRequests(gh), before, "the check made no request while the hand-off runs");
  assert.ok(await opWaiting(), "the check waits for the operation lock");
  completeDownload(env, first.id);
  await first.installing;
  const { errors } = await checking;
  assert.deepEqual(errors, []);
  assert.ok(apiRequests(gh) > before, "the check ran afterwards");
});

test("two operations started together from different contexts run one after the other", async () => {
  const { env } = await trackedWithKey();
  const order = []; // GitHub requests (repo path) and operation ends, in order
  const fetch0 = globalThis.fetch;
  globalThis.fetch = async (...args) => {
    const m = /\/(o\/[rs])\/releases/.exec(String(args[0]));
    if (m) order.push(m[1]);
    await sleep(2);
    return fetch0(...args);
  };
  // The popup adds o/s while the worker checks o/r: the check's requests come after the add ended.
  const adding = popup.addRepo("o/s").then(() => order.push("end add"));
  const checking = worker.checkAll().then(() => order.push("end check"));
  await Promise.all([adding, checking]);
  globalThis.fetch = fetch0;
  const endAdd = order.indexOf("end add");
  assert.ok(endAdd > 0, JSON.stringify(order));
  assert.deepEqual([...new Set(order.slice(0, endAdd))], ["o/s"], `only the add's requests before it ended: ${JSON.stringify(order)}`);
  assert.ok(order.slice(endAdd + 1).includes("o/r"), JSON.stringify(order));
  assert.equal(order.at(-1), "end check");
  assert.ok(env.store["repo:o/s"]);
});

// ---- not re-entrant: internals, never a nested lock ----

test("operations that run other operations' internals complete and take the operation lock once each", { timeout: 15000 }, async () => {
  const { env } = await trackedWithKey();
  const counted = async (name, call) => {
    const n = opRequests(env);
    await call();
    assert.equal(opRequests(env) - n, 1, `${name} takes the operation lock once`);
  };
  await counted("import (runs a check of all repos)", () => page.importBackup(v1Backup([v1Record()])));
  await counted("set template (checks and links)", () => page.setTemplate(K, "example.zip"));
  await counted("choose asset", () => page.chooseAsset(K, "example.zip", "v1"));
  await counted("pre-releases", () => page.setPrereleases(K, true));
  await counted("add (first check)", () => page.addRepo("o/s"));
  const f = await page.installFile(zip, "local.zip", null);
  await counted("track a file install (first check)", () => page.trackInstalledFile("o/t", { ...f, keyPkcs8: null }));
  await counted("check all", () => worker.checkAll());
  assert.equal(env.locks.isHeld(OP), false);
});

// ---- the UI's wait notice ----

test("whenQueued tells an operation that waits for another one, and when it starts", async () => {
  const { env } = await trackedWithKey();
  const seen = [];
  await page.whenQueued(() => seen.push("waiting"), () => page.checkRepo(K));
  assert.deepEqual(seen, [], "no notice when the lock is free");
  const first = await startInFlight(env, "v1");
  const checking = page.whenQueued(() => {
    seen.push("waiting");
    return () => seen.push("started");
  }, () => page.checkRepo(K));
  await sleep(10);
  assert.deepEqual(seen, ["waiting"]);
  completeDownload(env, first.id);
  await first.installing;
  await checking;
  assert.deepEqual(seen, ["waiting", "started"]);
  // The notice belongs to the one call: a later operation gets none.
  const second = await startInFlight(env, "v2");
  const later = page.checkRepo(K);
  await sleep(10);
  completeDownload(env, second.id);
  await Promise.all([second.installing, later]);
  assert.deepEqual(seen, ["waiting", "started"]);
});

// ---- F2: install events are attributed sequentially ----

// F2 repro (overlap-unknown-id): the first download's ID is delayed and a
// second install is started; the browser installs the first build.
test("an install started while the first hand-off waits for its download ID waits; the install event commits the first build", async () => {
  const { env } = await trackedWithKey();
  const begun = Promise.withResolvers();
  const gate = Promise.withResolvers();
  env.onDownloadStarted = async () => { env.onDownloadStarted = null; begun.resolve(); await gate.promise; };
  const first = page.installRelease(K, "v1");
  await begun.promise;
  const second = page.installRelease(K, "v2");
  await sleep(10);
  assert.equal(env.handedOff.length, 1, "the second hand-off has not started");
  const id = await extensionIdFromCrx(env.handedOff[0]);
  env.install(id, "1.0");
  await worker.handleExtensionInstalled({ id, version: "1.0" });
  assert.equal((await page.trackedView())[0].record.installed.tag, "v1");
  gate.resolve();
  await first;
  await second;
  assert.equal(env.handedOff.length, 2);
  assert.equal((await page.trackedView())[0].pendingInstall.tag, "v2", "the second prompt is pending now");
});

// F2 (closure review): with several entries in flight and none prompted (only
// possible after a page went away), the event names no build: none is credited.
test("an install event while several hand-offs of the version are in flight and none was prompted confirms none", async () => {
  const id = "a".repeat(32);
  const env = profile();
  Object.assign(env.store, { schema: 2, "repo:o/r": { ...newRecord("o", "r"), extensionId: id } });
  const now = Date.now();
  for (const [n, tag] of [[1, "v1"], [2, "v2"]]) {
    env.store["install:t" + n] = {
      token: "t" + n, repoKey: K, extensionId: id, version: "1.0", installed: { tag, digest: null, version: "1.0" }, crxHash: "h" + n,
      signedWith: null, supersededBy: null, downloadId: n, downloadDone: false, promptAt: null, at: now - 1000 + n,
      confirmedAt: null, fileGone: false, removeError: null,
    };
    env.files.set(n, { filename: "f" + n, bytes: new Uint8Array(1), state: "in_progress", exists: true });
  }
  env.install(id, "1.0");
  await worker.handleExtensionInstalled({ id, version: "1.0" });
  assert.equal(env.store["repo:o/r"].installed, null, "nothing committed");
  assert.deepEqual(["t1", "t2"].map((t) => [env.store["install:" + t].confirmedAt, env.store["install:" + t].version]), [[null, "1.0"], [null, "1.0"]]);
});

// ---- F11: one prompt clock for the lib and the UI ----

test("the view's pending install carries the prompt time; isPromptWaiting uses it, and a download in progress is still waiting", async () => {
  const id = "a".repeat(32);
  const env = profile();
  const now = Date.now();
  const entry = {
    token: "t", repoKey: K, extensionId: id, version: "1.0", installed: { tag: "v1", digest: null, version: "1.0" }, crxHash: "x",
    signedWith: null, supersededBy: null, downloadId: 1, downloadDone: true, promptAt: now, at: now - page.PENDING_GRACE_MS - 1000,
    confirmedAt: null, fileGone: false, removeError: null,
  };
  Object.assign(env.store, { schema: 2, "repo:o/r": { ...newRecord("o", "r"), extensionId: id }, "install:t": entry });
  // F11 repro (pending-ui-clock): a slow download completed just now.
  let pending = (await page.trackedView())[0].pendingInstall;
  assert.equal(pending.promptAt, now);
  assert.equal(page.isPromptWaiting(pending, now + 1000), true, "a fresh prompt is not expired");
  assert.equal(page.isPromptWaiting(pending, now + page.PENDING_GRACE_MS), false);
  env.store["install:t"] = { ...entry, downloadDone: false, promptAt: null };
  pending = (await page.trackedView())[0].pendingInstall;
  assert.equal(pending.promptAt, null, "still downloading");
  assert.equal(page.isPromptWaiting(pending, now + 10 * page.PENDING_GRACE_MS), true);
});

// ---- F12: one owner per key ----

// F12 repro (rollback-import): an import started while a track's first check
// is pending runs after the failed track; the key ends in one place.
test("an import started during a track whose first check fails runs after it, and the file's key ends in exactly one place", async () => {
  const env = profile();
  fakeGithub([]);
  const f = await page.installFile(zip, "local.zip", null);
  const fetch0 = globalThis.fetch;
  const started = Promise.withResolvers();
  const gate = Promise.withResolvers();
  let first = true;
  globalThis.fetch = async (url, init) => {
    if (first && String(url).startsWith("https://api.github.com/")) {
      first = false;
      started.resolve();
      await gate.promise;
      return new Response("missing", { status: 404 });
    }
    return fetch0(url, init);
  };
  const tracking = page.trackInstalledFile(K, { ...f, keyPkcs8: null });
  await started.promise;
  const backup = JSON.stringify({ format: "extainium-backup", version: 2, exportedAt: "2026-11-24T00:00:00.000Z", repos: [], keys: { "o/s": f.keyPkcs8 } });
  const importing = worker.importBackup(backup);
  await sleep(10);
  assert.equal(env.store["key:o/s"], undefined, "the import waits for the track");
  gate.resolve();
  await assert.rejects(tracking, /HTTP 404/);
  await importing;
  globalThis.fetch = fetch0;
  const places = [env.store["filekey:" + f.extensionId], env.store["key:o/r"], env.store["key:o/s"]].filter((v) => v === f.keyPkcs8);
  assert.equal(places.length, 1, "the key lives in one place");
  assert.equal(env.store["key:o/s"], f.keyPkcs8, "the imported repo owns it");
});

// F12: the rollback never removes or overwrites a key that another repo owns.
// (Another owner cannot appear during a track any more; the test puts it there.)
test("a failed track does not put the file key back when another repo owns that key meanwhile", async () => {
  const env = profile();
  fakeGithub([]);
  const f = await page.installFile(zip, "local.zip", null);
  const fetch0 = globalThis.fetch;
  const started = Promise.withResolvers();
  const gate = Promise.withResolvers();
  globalThis.fetch = async (url, init) => {
    if (String(url).startsWith("https://api.github.com/")) {
      started.resolve();
      await gate.promise;
      return new Response("missing", { status: 404 });
    }
    return fetch0(url, init);
  };
  const tracking = page.trackInstalledFile(K, { ...f, keyPkcs8: null });
  await started.promise;
  env.store["key:o/s"] = f.keyPkcs8;
  gate.resolve();
  await assert.rejects(tracking, /HTTP 404/);
  globalThis.fetch = fetch0;
  assert.equal(env.store["key:o/r"], undefined, "the track's own repo key is removed");
  assert.equal(env.store["filekey:" + f.extensionId], undefined, "not restored as a file key");
  assert.equal(env.store["key:o/s"], f.keyPkcs8, "the other repo keeps it");
});

test("an import never gives a key that another repo owns to a second repo, and moves a file key it brings as a repo key", async () => {
  const env = profile();
  fakeGithub([]);
  const f = await page.installFile(zip, "local.zip", null);
  const backup = (keys) => JSON.stringify({ format: "extainium-backup", version: 2, exportedAt: "2026-11-24T00:00:00.000Z", repos: [], keys });
  await page.importBackup(backup({ "o/s": f.keyPkcs8 }));
  assert.equal(env.store["key:o/s"], f.keyPkcs8);
  assert.equal(env.store["filekey:" + f.extensionId], undefined, "the file key moved to the repo");
  const { warnings } = await page.importBackup(backup({ "o/t": f.keyPkcs8 }));
  assert.equal(env.store["key:o/t"], undefined, "not a second repo's key");
  assert.match(warnings.join("\n"), /o\/t: the backup's signing key is already the key of o\/s/);
});

// ---- forgetting a file key (phone run 0.1.15, request m-f46c0cd8) ----

test("forgetFileKey deletes a kept file key: no longer listed, exported or usable; a later zip gets a new ID", async () => {
  const env = profile();
  fakeGithub([]);
  const f = await page.installFile(zip, "local.zip", null);
  await page.forgetFileKey(f.extensionId);
  assert.deepEqual(await page.fileKeysView(), []);
  assert.deepEqual(JSON.parse(await page.exportBackup()).fileKeys, {});
  await assert.rejects(page.installFile(zip, "local.zip", "file:" + f.extensionId), /no file key is stored for extension/);
  const again = await page.installFile(zip, "local.zip", null);
  assert.notEqual(again.extensionId, f.extensionId);
  await assert.rejects(page.forgetFileKey(f.extensionId), new RegExp(`forget file key: no file key is stored for extension ${f.extensionId}`));
  assert.equal(env.store["filekey:" + again.extensionId], again.keyPkcs8, "other file keys stay");
});

// ---- the result of an install from a file (phone run 0.1.15, request m-f46c0cd8) ----

test("installFile reports when the prompt appeared, and whether the browser already confirmed the install", async () => {
  const env = profile();
  fakeGithub([]);
  const t0 = Date.now();
  const r = await page.installFile(zip, "local.zip", null);
  assert.equal(r.confirmed, false);
  assert.ok(r.promptAt >= t0 && r.promptAt <= Date.now(), "the prompt time");
  assert.equal(page.isPromptWaiting(r), true);
  // Chromium may report the install before download() resolves.
  const fresh = profile();
  fakeGithub([]);
  fresh.searchHook = async (id) => {
    fresh.searchHook = null;
    const crxId = await extensionIdFromCrx(fresh.files.get(id).bytes);
    fresh.install(crxId, "1.0");
    await worker.handleExtensionInstalled({ id: crxId, version: "1.0" });
  };
  const early = await page.installFile(zip, "local.zip", null);
  assert.equal(early.confirmed, true);
});

// ---- model: random operation mixes from several contexts ----

// Operations from the page, the popup and the worker, the browser's install
// events and sweeps run concurrently; a scheduler orders all storage and
// network calls. Invariants: a key is stored in at most one place; a key that
// signed a pending install (in flight or within the prompt's grace period) is
// stored; each install event confirms at most one entry, and a repo's
// installed build is one handed off for it.
test("property: random mixes of operations, install events and sweeps keep the key and confirmation invariants", async () => {
  const R = newPkcs8();
  const contexts = [page, popup, worker];
  const step = fc.record({
    // Installs and events weighted up, so events often land during a hand-off.
    op: fc.constantFrom("install", "install", "fileInstall", "track", "remove", "removeUninstall", "import", "check", "prerelease", "event", "event", "event", "sweep", "forget"),
    ctx: fc.nat(2),
    which: fc.boolean(),
    delay: fc.nat(40), // ms before an event or sweep, so they land in the middle of operations
  });
  await fc.assert(
    fc.asyncProperty(fc.scheduler(), fc.array(step, { minLength: 2, maxLength: 6 }), fc.boolean(), async (s, steps, apiFails) => {
      const env = profile();
      const gh = fakeGithub(zipReleases("v2", "v1"));
      await page.importBackup(v1Backup([v1Record({ keyPkcs8: R })]));
      const f = await page.installFile(zip, "local.zip", null);
      env.install(f.extensionId, "1.0");
      await page.handleExtensionInstalled({ id: f.extensionId, version: "1.0" });
      const F = f.keyPkcs8;
      const rId = idOfPkcs8(R);
      // A clock that never repeats a value: each event's confirmedAt names that event.
      const now0 = Date.now;
      let tick = now0();
      Date.now = () => ++tick;
      const local = chrome.storage.local;
      const entries = new Map(); // token -> every version of the entry written
      const set = async (obj) => {
        for (const [k, v] of Object.entries(obj)) if (k.startsWith("install:")) entries.set(v.token, [...(entries.get(v.token) || []), v]);
        return local.set(obj);
      };
      chrome.storage.local = { get: s.scheduleFunction(local.get), set: s.scheduleFunction(set), remove: s.scheduleFunction(local.remove) };
      const fetch0 = globalThis.fetch;
      const scheduledFetch = s.scheduleFunction(async (url, init) =>
        (apiFails && String(url).startsWith("https://api.github.com/") ? new Response("no such repo", { status: 404 }) : fetch0(url, init)));
      globalThis.fetch = async (...args) => {
        await sleep(2);
        return scheduledFetch(...args);
      };
      const expected = /already tracked|not tracked|HTTP 404|no file key is stored|signing key|identity/;
      const tolerate = (p) => p.catch((e) => { if (!expected.test(e.message)) throw e; });
      const events = [];
      const run = async ({ op, ctx, which, delay }) => {
        if (op === "event" || op === "sweep") await sleep(delay);
        const m = contexts[ctx];
        const repo = which ? K : "o/s";
        switch (op) {
          case "install": return tolerate(m.installRelease(K, which ? "v1" : "v2"));
          case "fileInstall": return tolerate(m.installFile(zip, "local.zip", "file:" + f.extensionId));
          case "track": return tolerate(m.trackInstalledFile("o/s", { ...f, keyPkcs8: null }));
          case "remove": return tolerate(m.removeRepo(repo, false));
          case "removeUninstall": return tolerate(m.removeRepo(repo, true));
          case "import": return tolerate(m.importBackup(JSON.stringify({
            format: "extainium-backup", version: 2, exportedAt: "2026-11-24T00:00:00.000Z", repos: [], keys: { "o/t": which ? R : F },
          })));
          case "check": return m.checkAll();
          case "prerelease": return tolerate(m.setPrereleases(K, which));
          case "event": {
            const id = which ? rId : f.extensionId;
            events.push(id);
            env.install(id, "1.0");
            return worker.handleExtensionInstalled({ id, version: "1.0" });
          }
          case "sweep": return worker.sweepDownloads(Date.now() + (which ? page.PENDING_GRACE_MS : 0));
          case "forget": return tolerate(m.forgetFileKey(f.extensionId));
        }
      };
      const results = await s.waitFor(Promise.allSettled(steps.map(run)));
      chrome.storage.local = local;
      globalThis.fetch = fetch0;
      Date.now = now0;
      for (const r of results) if (r.status === "rejected") throw r.reason;
      const now = tick;
      // A key is stored in at most one place.
      for (const k of [R, F]) {
        const places = Object.entries(env.store).filter(([n, v]) => (n.startsWith("key:") || n.startsWith("filekey:")) && v === k).map(([n]) => n);
        assert.ok(places.length <= 1, `one place for a key: ${places}`);
      }
      // A key that signed a pending install is stored.
      for (const e of Object.values(env.store)) {
        if (!e || !e.token || !e.signedWith || e.confirmedAt) continue;
        const pending = e.downloadDone ? now - (e.promptAt ?? e.at) < page.PENDING_GRACE_MS : e.downloadId !== null || now - e.at < page.NO_DOWNLOAD_ID_MS;
        if (pending) assert.ok(env.store["key:" + e.signedWith], `the key of pending install ${e.token} is stored`);
      }
      // Each event confirms at most one entry; a repo's installed build was handed off for it.
      const confirmed = [...entries.values()].filter((vs) => vs.some((v) => v.confirmedAt)).map((vs) => vs.find((v) => v.confirmedAt));
      for (const id of new Set(confirmed.map((e) => e.extensionId))) {
        assert.ok(confirmed.filter((e) => e.extensionId === id).length <= events.filter((x) => x === id).length, `no more confirmations of ${id} than events`);
      }
      const byEvent = Object.groupBy(confirmed, (e) => e.confirmedAt);
      for (const [at, group] of Object.entries(byEvent)) assert.equal(group.length, 1, `the event at ${at} confirmed ${group.length} entries`);
      for (const [n, rec] of Object.entries(env.store)) {
        if (!n.startsWith("repo:") || !rec.installed) continue;
        // Tracking the file install takes over its confirmed build.
        if (rec.extensionId === f.extensionId && JSON.stringify(rec.installed) === JSON.stringify(f.installed)) continue;
        const key = n.slice("repo:".length);
        const handed = [...entries.values()].flat().filter((e) => e.installed && JSON.stringify(e.installed) === JSON.stringify(rec.installed));
        assert.ok(handed.some((e) => e.repoKey === key || e.extensionId === rec.extensionId), `${key}: installed ${JSON.stringify(rec.installed)} was handed off for it`);
      }
      assert.equal(env.locks.isHeld(OP), false, "no operation left holding the lock");
      void gh;
    }),
    { numRuns: 60 }
  );
});
