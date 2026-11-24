import { test } from "node:test";
import assert from "node:assert/strict";
import { base64Encode, extensionIdFromSpki, generateSigningKey } from "../src/lib/crx.js";
import { getSettings, getTheme, makeBackup, newRecord, parseBackup, recordObservedScheme, setSettings, setTheme } from "../src/lib/store.js";
import { fakeChrome } from "./helpers/fake-chrome.js";

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
  await assert.rejects(parseBackup("{}"), /not an extainium-backup version 1, 2, 3 or 4 file/);
  await assert.rejects(parseBackup("nope"), /not JSON/);
});

// F3: version 2 templates are validated like manual entries.
test("parseBackup rejects an invalid template", async () => {
  const b = makeBackup([{ ...newRecord("o", "r"), template: "ext-{ver}.zip" }], {});
  await assert.rejects(parseBackup(JSON.stringify(b)), /repo #1 \(o\/r\): template: asset template/);
});


// ---- Item 9: theme setting (system | light | dark) and the scheme a tab observed ----

test("the theme defaults to system with no observed scheme, so the popup has no scheme to force", async () => {
  fakeChrome();
  assert.deepEqual(await getTheme(), { theme: "system", observedScheme: null, scheme: null });
});

test("with theme system the scheme is the one the options page observed; light or dark overrides it", async () => {
  fakeChrome();
  assert.equal(await recordObservedScheme("dark"), true);
  assert.deepEqual(await getTheme(), { theme: "system", observedScheme: "dark", scheme: "dark" });
  await setTheme("light");
  assert.deepEqual(await getTheme(), { theme: "light", observedScheme: "dark", scheme: "light" });
  await setTheme("dark");
  await recordObservedScheme("light");
  assert.equal((await getTheme()).scheme, "dark");
});

test("recording an unchanged observed scheme writes nothing", async () => {
  const env = fakeChrome();
  await recordObservedScheme("dark");
  let writes = 0;
  env.hooks.beforeSet = async () => { writes++; };
  assert.equal(await recordObservedScheme("dark"), false);
  assert.equal(writes, 0);
});

test("theme and scheme setters reject other values, naming them, and keep the token setting", async () => {
  fakeChrome();
  await setSettings({ githubToken: "t" });
  await assert.rejects(async () => setTheme("auto"), /set theme: not one of system, light, dark: "auto"/);
  await assert.rejects(recordObservedScheme("no-preference"), /record observed scheme: not light or dark: "no-preference"/);
  await setTheme("dark");
  assert.equal((await getSettings()).githubToken, "t");
});
