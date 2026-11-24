import { test } from "node:test";
import assert from "node:assert/strict";
import { exportBackup, trackedView } from "../src/lib/manager.js";
import { fakeChrome } from "./helpers/fake-chrome.js";

// Its own file: the stored-data migration runs once per module load.
// F14: one record whose template cannot be derived (the installed asset's name
// gives a template over the 200-character limit) falls back to "choose the
// asset again"; the other records migrate and backup works.
test("a record whose asset gives no valid template migrates to the choose-the-asset-again state", async () => {
  const env = fakeChrome();
  const digest = "sha256:" + "a".repeat(64);
  env.store["repo:o/r"] = {
    owner: "o", repo: "r", pattern: "^(example|other).*\\.zip$", includePrereleases: false, extensionId: null, keyPkcs8: null,
    installed: { tag: "v1", digest, version: "1" },
    releases: [{ tag: "v1", assets: [{ name: "example" + "x".repeat(205) + ".zip", digest }] }], addedAt: 1,
  };
  env.store["repo:o/fine"] = {
    owner: "o", repo: "fine", pattern: "^fine\\.zip$", includePrereleases: false, extensionId: null, keyPkcs8: null,
    installed: null, releases: null, addedAt: 1,
  };
  const view = Object.fromEntries((await trackedView()).map((v) => [v.key, v]));
  assert.equal(view["o/r"].record.template, null);
  assert.match(view["o/r"].record.error, /choose the asset again/i);
  assert.equal(view["o/fine"].record.template, "fine.zip");
  assert.equal(env.store.schema, 2);
  const backup = JSON.parse(await exportBackup());
  assert.deepEqual(backup.repos.map((r) => r.repo), ["fine", "r"]);
});
