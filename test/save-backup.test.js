import { test } from "node:test";
import assert from "node:assert/strict";
import * as manager from "../src/lib/manager.js";
import { exportBackup, saveBackup } from "../src/lib/manager.js";
import { fakeChrome, fakeGithub } from "./helpers/fake-chrome.js";

// Item 7: on Titanium the completed export never showed in downloads.search,
// although onChanged reported "complete" (Chromium dispatches it only after
// the file is written and published). saveBackup reports the end from the
// download's own events, registered before download() is called.

function setup() {
  const env = fakeChrome();
  fakeGithub([]);
  env.newDownloadState = "in_progress";
  return env;
}

test("saveBackup reports a saved backup from the complete event even when search no longer lists the download", async () => {
  const env = setup();
  env.onDownloadStarted = async (id) => {
    setTimeout(() => {
      env.files.delete(id);
      env.emitChanged({ id, state: { previous: "in_progress", current: "complete" } });
    }, 5);
  };
  const result = await saveBackup("extainium-backup-2026-11-24.json");
  assert.deepEqual(result, { saved: true, id: 1, error: null });
  assert.equal(env.changedListeners.size, 0, "listeners are removed");
});

test("a complete event that comes before download() resolves is not missed", async () => {
  const env = setup();
  env.onDownloadStarted = async (id) => {
    env.files.delete(id);
    env.emitChanged({ id, state: { previous: "in_progress", current: "complete" } });
  };
  assert.deepEqual(await saveBackup("b.json"), { saved: true, id: 1, error: null });
});

test("saveBackup saves the export: the downloaded file is the backup JSON", async () => {
  const env = setup();
  env.newDownloadState = "complete";
  assert.equal((await saveBackup("b.json")).saved, true);
  const saved = JSON.parse(new TextDecoder().decode(env.files.get(1).bytes));
  const expected = JSON.parse(await exportBackup());
  assert.deepEqual({ ...saved, exportedAt: null }, { ...expected, exportedAt: null });
  assert.equal(env.files.get(1).filename, "b.json");
});

test("a canceled location dialog (interrupted, USER_CANCELED) reports the backup as not saved, naming the reason", async () => {
  const env = setup();
  env.onDownloadStarted = async (id) => {
    setTimeout(() => env.emitChanged({ id, state: { current: "interrupted" }, error: { current: "USER_CANCELED" } }), 5);
  };
  assert.deepEqual(await saveBackup("b.json"), { saved: false, id: 1, error: "download #1: USER_CANCELED" });
});

test("a download erased before it ended reports the backup as not saved instead of waiting forever", async () => {
  const env = setup();
  env.onDownloadStarted = async (id) => { setTimeout(() => env.emitErased(id), 5); };
  assert.deepEqual(await saveBackup("b.json"), { saved: false, id: 1, error: "download #1 was erased before it ended" });
});

test("a refused download call is reported with the operation and the file name", async () => {
  fakeChrome();
  fakeGithub([]);
  chrome.downloads.download = async () => { throw new Error("Invalid filename"); };
  await assert.rejects(saveBackup("../b.json"), /save backup \.\.\/b\.json: Invalid filename/);
});


// ---- Round 3 F8: early events are buffered per download in arrival order ----

// F8 repro: "complete" and then another delta (exists) for the same download
// arrive before download() returns, and search no longer lists it.
test("a complete event followed by another change before download() resolves still reports the backup saved", async () => {
  const env = setup();
  env.onDownloadStarted = async (id) => {
    env.files.delete(id);
    env.emitChanged({ id, state: { previous: "in_progress", current: "complete" } });
    env.emitChanged({ id, exists: { previous: true, current: false } });
  };
  assert.deepEqual(await saveBackup("b.json"), { saved: true, id: 1, error: null });
});

// F8 repro: the erase arrives before download() returns.
test("a download erased before download() resolves reports the backup as not saved", async () => {
  const env = setup();
  env.onDownloadStarted = async (id) => {
    env.files.delete(id);
    env.emitErased(id);
  };
  assert.deepEqual(await saveBackup("b.json"), { saved: false, id: 1, error: "download #1 was erased before it ended" });
});

// Arrival order decides: the end that came first is the result.
test("an early complete event followed by an early erase reports the backup saved", async () => {
  const env = setup();
  env.onDownloadStarted = async (id) => {
    env.files.delete(id);
    env.emitChanged({ id, state: { current: "complete" } });
    env.emitErased(id);
  };
  assert.deepEqual(await saveBackup("b.json"), { saved: true, id: 1, error: null });
});

test("early events of other downloads do not decide the result", async () => {
  const env = setup();
  env.onDownloadStarted = async (id) => {
    env.emitChanged({ id: id + 1, state: { current: "interrupted" }, error: { current: "FILE_FAILED" } });
    env.emitErased(id + 2);
    setTimeout(() => {
      env.files.delete(id);
      env.emitChanged({ id, state: { current: "complete" } });
    }, 5);
  };
  assert.deepEqual(await saveBackup("b.json"), { saved: true, id: 1, error: null });
});

// (owner decision) Never wait forever: without any end event or search result
// the save ends after saveTiming.confirmMs as "could not confirm".
test("a download whose end is never reported ends as not confirmed after the time limit", async (t) => {
  const env = setup();
  const saved = { ...manager.saveTiming };
  manager.saveTiming.confirmMs = 20;
  t.after(() => Object.assign(manager.saveTiming, saved));
  env.onDownloadStarted = async (id) => { env.files.delete(id); };
  const result = await saveBackup("b.json");
  assert.equal(result.saved, false);
  assert.equal(result.id, 1);
  assert.match(result.error, /^download #1: could not confirm that the backup was saved/);
  assert.equal(env.changedListeners.size, 0, "listeners are removed");
  assert.equal(env.erasedListeners.size, 0);
});


// ---- Closure review F8: search is optional and never decides or blocks ----

// F8 repro (save-search): a failing search overrode the complete event.
test("a failing downloads.search does not override the complete event", async () => {
  const env = setup();
  env.onDownloadStarted = async (id) => env.emitChanged({ id, state: { current: "complete" } });
  chrome.downloads.search = async () => { throw new Error("search unavailable"); };
  assert.deepEqual(await saveBackup("b.json"), { saved: true, id: 1, error: null });
});

// F8 repro (save-search-hangs): a search that never returns blocked the time limit.
test("a downloads.search that never returns does not block the time limit", async (t) => {
  const env = setup();
  const saved = { ...manager.saveTiming };
  manager.saveTiming.confirmMs = 15;
  t.after(() => Object.assign(manager.saveTiming, saved));
  env.onDownloadStarted = async (id) => { env.files.delete(id); };
  chrome.downloads.search = () => new Promise(() => {});
  const result = await Promise.race([saveBackup("b.json"), new Promise((r) => setTimeout(() => r("still waiting"), 500))]);
  assert.notEqual(result, "still waiting");
  assert.equal(result.saved, false);
  assert.match(result.error, /could not confirm/);
  assert.equal(env.changedListeners.size, 0, "listeners are removed");
});

// Search may still add an end the events did not bring.
test("a downloads.search that finds the download complete reports it saved", async () => {
  const env = setup();
  env.newDownloadState = "complete";
  assert.deepEqual(await saveBackup("b.json"), { saved: true, id: 1, error: null });
});
