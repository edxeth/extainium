import { test } from "node:test";
import assert from "node:assert/strict";
import { chooseAsset, trackedView } from "../src/lib/manager.js";
import { fakeChrome } from "./helpers/fake-chrome.js";

// Its own file: the stored-data migration runs once per module load.
// A .zip asset, so linking signs with a local key and needs no download.
const release = {
  tag: "1.77.0", name: "1.77.0", prerelease: false, publishedAt: "2026-11-01T00:00:00Z", htmlUrl: "https://github.com/k/lost/releases/tag/1.77.0",
  assets: [{ name: "lost-1.77.0.zip", url: "https://github.com/k/lost/releases/download/1.77.0/lost-1.77.0.zip", size: 1, digest: null }],
};

// Requirement: choosing the asset again resolves the migration's "choose the asset again" error.
test("choosing an asset clears the error left by a pattern that could not be converted", async () => {
  const env = fakeChrome({ extensions: [] });
  env.store["repo:k/lost"] = {
    owner: "k", repo: "lost", pattern: "^(a+)+$", includePrereleases: false, extensionId: null, keyPkcs8: null, installed: null,
    releases: [release], etag: null, checkedAt: 1, error: null, addedAt: 1,
  };
  const [before] = await trackedView();
  assert.match(before.record.error, /choose the asset again/i);

  await chooseAsset("k/lost", "lost-1.77.0.zip", "1.77.0");

  const [after] = await trackedView();
  assert.equal(after.record.template, "lost-{version}.zip");
  assert.equal(after.record.error, null);
});
