import { test } from "node:test";
import assert from "node:assert/strict";
import { base64Encode, extensionIdFromSpki, generateSigningKey } from "../src/lib/crx.js";
import { makeBackup, newRecord, parseBackup } from "../src/lib/store.js";

async function zipRecord() {
  const key = await generateSigningKey();
  return {
    record: {
      ...newRecord("kaovilai", "github-bot-command-palette"),
      template: "github-bot-command-palette-v{version}.zip",
      extensionId: await extensionIdFromSpki(key.spki),
      installed: { tag: "v1.2.0", digest: "sha256:" + "a".repeat(64), version: "1.2.0" },
      releases: [{ tag: "v1.2.0", assets: [] }],
      pages: [{ url: "https://api.github.com/x", etag: 'W/"abc"', next: null, count: 1 }],
    },
    pkcs8: base64Encode(key.pkcs8),
  };
}

// Requirement: export/import restores the list including the per-repo signing keys.
test("a backup restores every record and signing key, without the release cache", async () => {
  const zip = await zipRecord();
  const records = [zip.record, { ...newRecord("gorhill", "uBlock"), extensionId: "fkgkibajhfbepljeaefdnfnegdcjomkh" }];
  const restored = await parseBackup(JSON.stringify(makeBackup(records, { "kaovilai/github-bot-command-palette": zip.pkcs8 })));
  assert.equal(restored.repos.length, 2);
  assert.equal(restored.keys["kaovilai/github-bot-command-palette"], zip.pkcs8);
  assert.equal(restored.repos[0].extensionId, zip.record.extensionId);
  assert.equal(restored.repos[0].template, zip.record.template);
  assert.deepEqual(restored.repos[0].installed, zip.record.installed);
  assert.equal(restored.repos[0].releases, null);
  assert.equal(restored.repos[0].pages, null);
  assert.equal(restored.repos[1].extensionId, "fkgkibajhfbepljeaefdnfnegdcjomkh");
});

test("parseBackup rejects files that are not Extainium backups", async () => {
  await assert.rejects(parseBackup("{}"), /not an extainium-backup version 1 or 2 file/);
  await assert.rejects(parseBackup("nope"), /not JSON/);
});

// F3: version 2 templates are validated like manual entries.
test("parseBackup rejects an invalid template", async () => {
  const b = makeBackup([{ ...newRecord("o", "r"), template: "ext-{ver}.zip" }], {});
  await assert.rejects(parseBackup(JSON.stringify(b)), /repo #1 \(o\/r\): template: asset template/);
});
