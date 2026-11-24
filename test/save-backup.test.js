import { test } from "node:test";
import assert from "node:assert/strict";
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
