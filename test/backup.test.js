import { test } from "node:test";
import assert from "node:assert/strict";
import nodeCrypto from "node:crypto";
import { readFileSync } from "node:fs";
import fc from "fast-check";
import { packCrx3 } from "../src/lib/crx.js";
import {
  confirmIdentityChange, exportBackup, importBackup, installRelease, setPrereleases, setTemplate, trackedView,
} from "../src/lib/manager.js";
import { makeBackup, parseBackup } from "../src/lib/store.js";
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

const zip = new Uint8Array(readFileSync(new URL("./fixtures/ext-root.zip", import.meta.url)));
// Independent reference: Chromium's ID is hex(sha256(spki)[0..16]) with 0-f -> a-p.
function idOfPkcs8(b64) {
  const spki = nodeCrypto.createPublicKey(nodeCrypto.createPrivateKey({ key: Buffer.from(b64, "base64"), format: "der", type: "pkcs8" }))
    .export({ type: "spki", format: "der" });
  const hex = nodeCrypto.createHash("sha256").update(spki).digest("hex").slice(0, 32);
  return [...hex].map((c) => String.fromCharCode(97 + parseInt(c, 16))).join("");
}

// F13: after an explicit switch from the repo's zip (own key) to the author's
// CRX, the export holds the retained zip key and the CRX's ID; it imports again.
test("a backup exported after an identity switch from zip to CRX imports with its retained key", async () => {
  const author = pkcs8();
  const crx = await packCrx3(zip, new Uint8Array(Buffer.from(author, "base64")));
  const env = fakeChrome();
  fakeGithub([{ tag: "v1", assets: [{ name: "example.zip", bytes: zip }, { name: "example.crx", bytes: crx }] }]);
  await importBackup(v1Backup([v1Record()]));
  await setTemplate("o/r", "example.zip");
  const zipId = (await trackedView())[0].record.extensionId;
  env.install(zipId, "1.0");
  await setTemplate("o/r", "example.crx");
  await confirmIdentityChange("o/r");
  const text = await exportBackup();
  const retained = JSON.parse(text).keys["o/r"];
  assert.equal(idOfPkcs8(retained), zipId);

  const fresh = fakeChrome();
  fakeGithub([{ tag: "v1", assets: [{ name: "example.zip", bytes: zip }, { name: "example.crx", bytes: crx }] }]);
  const result = await importBackup(text);
  assert.equal(result.count, 1);
  assert.equal(fresh.store["key:o/r"], retained);
  assert.equal(fresh.store["repo:o/r"].extensionId, idOfPkcs8(author));
});

// F13 (no ID-vs-key check on import): a backup that pairs a key with another,
// installed extension ID does not relink silently; the next link asks for an
// identity change and nothing installs before it is confirmed.
test("an imported key that derives another ID than the installed linked extension leads to an identity change", async () => {
  const key = pkcs8();
  const installedId = idOfPkcs8(pkcs8());
  const env = fakeChrome({ extensions: [{ id: installedId, version: "1.0", name: "Example", enabled: true }] });
  fakeGithub([{ tag: "v1", assets: [{ name: "example.zip", bytes: zip }] }]);
  const backup = JSON.stringify({
    format: "extainium-backup", version: 2, exportedAt: "2026-11-24T00:00:00.000Z",
    repos: [{ owner: "o", repo: "r", template: "example.zip", includePrereleases: false, extensionId: installedId, installed: null, addedAt: 1 }],
    keys: { "o/r": key },
  });
  await importBackup(backup);
  await setPrereleases("o/r", false);
  const [view] = await trackedView();
  assert.equal(view.state, "identity-change");
  assert.equal(view.record.extensionId, installedId);
  assert.deepEqual({ from: view.record.identityChange.from, to: view.record.identityChange.to }, { from: installedId, to: idOfPkcs8(key) });
  await assert.rejects(installRelease("o/r"), /identity/i);
  assert.equal(env.handedOff.length, 0);
});

// ---- F15: generated backups ----
// A small pool of real keys (RSA generation is slow); records refer to them.
const KEY_POOL = [pkcs8(), pkcs8(), pkcs8()];
const name = fc.stringMatching(/^[A-Za-z0-9_.-]{1,12}$/);
const id = fc.stringMatching(/^[a-p]{32}$/);
const hex64 = fc.stringMatching(/^[0-9a-f]{64}$/);
// Template text: literal characters a template allows, "*" and {version}.
const literal = fc.stringMatching(/^[A-Za-z0-9_. ()+\-]{1,20}$/);
const template = fc.array(fc.oneof(literal, fc.constant("*"), fc.constant("{version}")), { minLength: 1, maxLength: 5 }).map((p) => p.join(""));
const installed = fc.option(fc.record({
  tag: fc.option(fc.string({ maxLength: 20 }), { nil: null }),
  digest: fc.option(hex64.map((h) => "sha256:" + h), { nil: null }),
  version: fc.string({ maxLength: 64 }),
}).map((i) => ({ ...i })), { nil: null });
const record = fc.record({
  owner: name, repo: name,
  template: fc.option(template, { nil: null }),
  includePrereleases: fc.boolean(),
  extensionId: fc.option(id, { nil: null }),
  installed,
  addedAt: fc.integer({ min: 0, max: 2 ** 45 }),
});
const lowerKey = (r) => `${r.owner}/${r.repo}`.toLowerCase();
const records = fc.uniqueArray(record, { maxLength: 5, selector: lowerKey });
// Keys for some tracked repos and for some repos that are no longer tracked (retained).
const backupInput = fc.tuple(records, fc.array(fc.tuple(name, name), { maxLength: 2 }), fc.array(fc.nat(), { maxLength: 10 }))
  .map(([recs, retained, picks]) => {
    const keys = {};
    [...recs.map(lowerKey), ...retained.map(([o, r]) => `${o}/${r}`.toLowerCase())]
      .forEach((k, i) => { if (picks[i] !== undefined && picks[i] % 3) keys[k] = KEY_POOL[picks[i] % KEY_POOL.length]; });
    return { recs, keys };
  });

test("property: a generated valid backup round-trips through export and parse", async () => {
  await fc.assert(
    fc.asyncProperty(backupInput, async ({ recs, keys }) => {
      const exported = makeBackup(recs, keys, new Date(0));
      const parsed = await parseBackup(JSON.stringify(exported));
      assert.deepEqual(parsed.keys, keys);
      assert.deepEqual(parsed.warnings, []);
      assert.deepEqual(makeBackup(parsed.repos, parsed.keys, new Date(0)), exported);
    }),
    { numRuns: 150 }
  );
});

// Version 1 (Extainium 0.1): a literal anchored pattern becomes that literal
// template, and a record's keyPkcs8 becomes the repo's key.
const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
test("property: a generated valid version 1 backup parses to its literal templates and keys", async () => {
  const v1 = fc.tuple(records, fc.array(literal, { minLength: 5, maxLength: 5 }), fc.array(fc.nat(), { minLength: 5, maxLength: 5 }));
  await fc.assert(
    fc.asyncProperty(v1, async ([recs, lits, picks]) => {
      const old = recs.map((r, i) => ({
        ...r, template: undefined, pattern: "^" + escapeRegex(lits[i]) + "$",
        keyPkcs8: picks[i] % 3 ? KEY_POOL[picks[i] % 3] : null, releases: null, etag: null,
      }));
      const parsed = await parseBackup(v1Backup(old));
      assert.deepEqual(parsed.repos.map((r) => r.template), lits.slice(0, recs.length));
      assert.deepEqual(parsed.keys, Object.fromEntries(old.filter((r) => r.keyPkcs8).map((r) => [lowerKey(r), r.keyPkcs8])));
      assert.deepEqual(parsed.repos.map((r) => [r.owner, r.repo, r.includePrereleases, r.extensionId, r.installed, r.addedAt]),
        recs.map((r) => [r.owner, r.repo, r.includePrereleases, r.extensionId, r.installed, r.addedAt]));
    }),
    { numRuns: 100 }
  );
});

// Invalid values per field; the error names the field (and "import backup").
const BAD = {
  owner: ["a b", 5, "", null, "x/y"],
  repo: ["", 7, "a:b", ["r"]],
  includePrereleases: ["false", 1, null],
  extensionId: ["A".repeat(32), "abc", 5, "q".repeat(32)],
  installed: ["yes", 3, [], { tag: 1, digest: null, version: "1" }, { tag: null, digest: "md5:00", version: "1" }, { tag: null, digest: null, version: 1 }, { tag: null, digest: null, version: "x".repeat(65) }],
  addedAt: ["1", null, {}],
  template: ["", 5, "a/b.zip", "ext-{ver}.zip", "x".repeat(201), "a\u0001b"],
};
const BAD_V1 = { pattern: [5, {}, true], keyPkcs8: [false, 5, "bm90IGEga2V5", "not base64!"] };
const BAD_KEYS = [["Bad Name", null], ["o/r/x", null], [null, "bm90IGEga2V5"], [null, "%%%"], [null, 5]];

test("property: a generated backup with one invalid field is rejected with an error naming that field", async () => {
  const v2Case = fc.tuple(backupInput, fc.constantFrom(...Object.keys(BAD)), fc.nat(), fc.nat()).map(([{ recs, keys }, field, i, j]) => {
    const all = recs.length ? recs : [{ owner: "o", repo: "r", template: null, includePrereleases: false, extensionId: null, installed: null, addedAt: 1 }];
    const exported = makeBackup(all, keys, new Date(0));
    exported.repos[i % all.length][field] = BAD[field][j % BAD[field].length];
    return { text: JSON.stringify(exported), field };
  });
  const v1Case = fc.tuple(records, fc.constantFrom(...Object.keys(BAD_V1)), fc.nat(), fc.nat()).map(([recs, field, i, j]) => {
    const all = (recs.length ? recs : [{ owner: "o", repo: "r", includePrereleases: false, extensionId: null, installed: null, addedAt: 1 }])
      .map((r) => ({ ...r, template: undefined, pattern: null, keyPkcs8: null }));
    all[i % all.length][field] = BAD_V1[field][j % BAD_V1[field].length];
    return { text: v1Backup(all), field };
  });
  const keyCase = fc.tuple(backupInput, fc.constantFrom(...BAD_KEYS)).map(([{ recs, keys }, [badName, badValue]]) => {
    const exported = makeBackup(recs, keys, new Date(0));
    exported.keys[badName ?? "o/r"] = badValue ?? KEY_POOL[0];
    return { text: JSON.stringify(exported), field: "keys" };
  });
  await fc.assert(
    fc.asyncProperty(fc.oneof(v2Case, v1Case, keyCase), async ({ text, field }) => {
      await assert.rejects(parseBackup(text), (e) => {
        assert.match(e.message, /^import backup: /);
        assert.ok(e.message.includes(field), `${e.message} names ${field}`);
        return true;
      });
    }),
    { numRuns: 300 }
  );
});
