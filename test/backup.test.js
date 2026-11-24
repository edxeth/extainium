import { test } from "node:test";
import assert from "node:assert/strict";
import nodeCrypto from "node:crypto";
import { exportBackup, importBackup, trackedView } from "../src/lib/manager.js";
import { fakeChrome, fakeGithub, v1Backup } from "./helpers/fake-chrome.js";

const pkcs8 = () => nodeCrypto.generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs8", format: "der" }).toString("base64");
const v1Record = (extra = {}) => ({
  owner: "o", repo: "r", pattern: null, includePrereleases: false, extensionId: null, keyPkcs8: null,
  installed: null, releases: null, etag: null, checkedAt: null, error: null, addedAt: 1, ...extra,
});

// F3: an invalid backup is rejected as a whole, before anything is written.
test("import rejects a backup with a wrongly typed or malformed field and writes nothing", async () => {
  const cases = [
    [{ extensionId: "invalid" }, /extensionId/],
    [{ extensionId: "A".repeat(32) }, /extensionId/],
    [{ includePrereleases: "false" }, /includePrereleases/],
    [{ owner: "a b" }, /owner/],
    [{ repo: 5 }, /repo/],
    [{ keyPkcs8: false }, /keyPkcs8/],
    [{ keyPkcs8: "bm90IGEga2V5" }, /key/],
    [{ installed: { tag: 1, digest: null, version: "1" } }, /installed/],
    [{ installed: "yes" }, /installed/],
  ];
  for (const [extra, error] of cases) {
    const env = fakeChrome();
    fakeGithub([]);
    const good = v1Record({ owner: "good", repo: "one" });
    await assert.rejects(importBackup(v1Backup([good, v1Record(extra)])), (e) => {
      assert.match(e.message, /import backup/);
      assert.match(e.message, error, JSON.stringify(extra));
      return true;
    });
    assert.deepEqual(Object.keys(env.store).filter((k) => k.startsWith("repo:") || k.startsWith("key:")), [], JSON.stringify(extra));
  }
});

// F3: imported release caches and unknown fields never reach storage.
test("import drops release caches and unknown fields", async () => {
  const env = fakeChrome();
  fakeGithub([]);
  await importBackup(v1Backup([v1Record({ releases: "not an array", etag: 5, error: {}, evil: "<img>" })]));
  const rec = env.store["repo:o/r"];
  assert.ok(!("evil" in rec));
  assert.ok(Array.isArray(rec.releases) || rec.releases === null);
  const [view] = await trackedView();
  assert.equal(view.state, "no-asset");
});

// F3: an imported pattern is never compiled as a regex; a catastrophic one cannot hang the import.
test("a backup with a catastrophic regex pattern imports without evaluating it", async () => {
  fakeChrome();
  fakeGithub([{ tag: "v1", assets: [{ name: "a".repeat(40) + "!", bytes: new Uint8Array(1) }] }], { owner: "owner", repo: "repo" });
  await importBackup(v1Backup([v1Record({ owner: "owner", repo: "repo", pattern: "^(a+)+$" })]));
  const [view] = await trackedView();
  assert.equal(view.record.template, null);
});

// Backups round-trip the configuration and every key, including retained ones.
test("export then import into empty storage restores records and keys", async () => {
  const key = pkcs8();
  fakeChrome();
  fakeGithub([]);
  await importBackup(v1Backup([v1Record({ pattern: "^example\\.zip$", keyPkcs8: key })]));
  const text = await exportBackup();
  const env = fakeChrome();
  fakeGithub([]);
  const result = await importBackup(text);
  assert.equal(result.count, 1);
  assert.equal(env.store["repo:o/r"].template, "example.zip");
  assert.equal(JSON.parse(await exportBackup()).keys["o/r"], key);
});
