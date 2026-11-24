import { test } from "node:test";
import assert from "node:assert/strict";
import { PENDING_GRACE_MS, cleanupDownloads, sweepDownloads } from "../src/lib/manager.js";

// Faithful-enough fake of the chrome.storage / chrome.downloads calls the cleanup uses.
function fakeChrome(pendingDownloads) {
  const removed = [];
  const erased = [];
  let store = { pendingDownloads };
  globalThis.chrome = {
    storage: { local: {
      get: async (k) => ({ [k]: store[k] }),
      set: async (o) => { store = { ...store, ...o }; },
    } },
    downloads: {
      removeFile: async (id) => { removed.push(id); },
      erase: async ({ id }) => { erased.push(id); },
    },
  };
  return { removed, erased, pending: () => store.pendingDownloads };
}

// Requirement: the CRX copy is deleted once its extension installs.
test("cleanupDownloads removes only the downloads of the installed extension", async () => {
  const f = fakeChrome({ 1: { extensionId: "a", at: 0 }, 2: { extensionId: "b", at: 0 } });
  await cleanupDownloads("a");
  assert.deepEqual(f.removed, [1]);
  assert.deepEqual(f.erased, [1]);
  assert.deepEqual(Object.keys(f.pending()), ["2"]);
});

// Requirement: declined prompts and failed installs leave no CRX behind after the grace period.
test("sweepDownloads removes downloads older than the grace period and keeps recent ones", async () => {
  const now = 10 * PENDING_GRACE_MS;
  const f = fakeChrome({
    1: { extensionId: "a", at: now - PENDING_GRACE_MS },
    2: { extensionId: "b", at: now - PENDING_GRACE_MS + 1 },
    3: { extensionId: "c", at: 0 },
  });
  await sweepDownloads(now);
  assert.deepEqual(f.removed, [1, 3]);
  assert.deepEqual(Object.keys(f.pending()), ["2"]);
});

test("a file that is already gone is still erased from the download list", async () => {
  const f = fakeChrome({ 7: { extensionId: "a", at: 0 } });
  chrome.downloads.removeFile = async () => { throw new Error("Download file already deleted"); };
  await sweepDownloads(PENDING_GRACE_MS);
  assert.deepEqual(f.erased, [7]);
  assert.deepEqual(f.pending(), {});
});
