import { test } from "node:test";
import assert from "node:assert/strict";
import { base64Encode, extensionIdFromSpki, generateSigningKey } from "../src/lib/crx.js";
import { makeBackup, newRecord, parseBackup } from "../src/lib/store.js";

async function zipRecord() {
  const key = await generateSigningKey();
  return {
    ...newRecord("kaovilai", "github-bot-command-palette"),
    pattern: "^x$",
    keyPkcs8: base64Encode(key.pkcs8),
    extensionId: await extensionIdFromSpki(key.spki),
    installed: { tag: "v1.2.0", digest: "sha256:aa", version: "1.2.0" },
    releases: [{ tag: "v1.2.0", assets: [] }],
    etag: 'W/"abc"',
  };
}

// Requirement: export/import restores the list including the per-repo signing keys.
test("a backup restores every record with its signing key, without the release cache", async () => {
  const records = [await zipRecord(), { ...newRecord("gorhill", "uBlock"), extensionId: "fkgkibajhfbepljeaefdnfnegdcjomkh" }];
  const text = JSON.stringify(makeBackup(records));
  const restored = await parseBackup(text);
  assert.equal(restored.length, 2);
  assert.equal(restored[0].keyPkcs8, records[0].keyPkcs8);
  assert.equal(restored[0].extensionId, records[0].extensionId);
  assert.deepEqual(restored[0].installed, records[0].installed);
  assert.equal(restored[0].releases, null);
  assert.equal(restored[0].etag, null);
  assert.equal(restored[1].extensionId, "fkgkibajhfbepljeaefdnfnegdcjomkh");
});

test("parseBackup rejects a key that does not derive the stored extension ID", async () => {
  const r = { ...(await zipRecord()), extensionId: "a".repeat(32) };
  await assert.rejects(parseBackup(JSON.stringify(makeBackup([r]))), /derives ID [a-p]{32}, file says a{32}/);
});

test("parseBackup rejects files that are not Extainium backups", async () => {
  await assert.rejects(parseBackup("{}"), /not an extainium-backup version 1 file/);
  await assert.rejects(parseBackup("nope"), /not JSON/);
});
