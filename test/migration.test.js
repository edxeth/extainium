import { test } from "node:test";
import assert from "node:assert/strict";
import nodeCrypto from "node:crypto";
import { exportBackup, sweepDownloads, trackedView } from "../src/lib/manager.js";
import { exportedKey, fakeChrome } from "./helpers/fake-chrome.js";

// The asset pattern format Extainium 0.1 stored: derivePattern's output, with
// this exact version sub-pattern (src/lib/releases.js at commit 1cd36e3).
const OLD_VER = "\\d+(?:\\.\\d+)*(?:-?(?:alpha|beta|pre|rc|a|b)\\.?\\d+)?";

const UBLOCK_ID = "fkgkibajhfbepljeaefdnfnegdcjomkh";
const ublockRelease = {
  tag: "1.77.0", name: "uBlock Origin 1.77.0", prerelease: false, publishedAt: "2026-11-01T00:00:00Z", htmlUrl: "https://github.com/gorhill/uBlock/releases/tag/1.77.0",
  assets: ["uBlock0_1.77.0.chromium.crx", "uBlock0_1.77.0.chromium.zip", "uBlock0_1.77.0.firefox.signed.xpi"].map((name) => ({
    name, url: "https://github.com/gorhill/uBlock/releases/download/1.77.0/" + name, size: 1, digest: "sha256:" + nodeCrypto.createHash("sha256").update(name).digest("hex"),
  })),
};
const oldRecord = (owner, repo, extra) => ({
  owner, repo, pattern: null, includePrereleases: false, extensionId: null, keyPkcs8: null, installed: null,
  releases: [ublockRelease], etag: 'W/"x"', checkedAt: 1, error: null, addedAt: 1, ...extra,
});

// Storage as Extainium 0.1.3 left it on the phone (gorhill/uBlock tracked with
// the derived pattern), plus a zip repo with a key and a leftover download map.
function oldStorage() {
  const pkcs8 = nodeCrypto.generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs8", format: "der" }).toString("base64");
  return {
    pkcs8,
    store: {
      "repo:gorhill/ublock": oldRecord("gorhill", "uBlock", { pattern: "^uBlock0_" + OLD_VER + "\\.chromium\\.crx$", extensionId: UBLOCK_ID }),
      "repo:k/zip": oldRecord("k", "zip", { pattern: "^uBlock0_" + OLD_VER + "\\.chromium\\.zip$", keyPkcs8: pkcs8 }),
      // Hand-edited pattern made of literal text and ".*": converted as written.
      "repo:k/wild": oldRecord("k", "wild", { pattern: "^uBlock0_.*chromium\\.crx" }),
      // Hand-edited regex that has no template form; the installed digest identifies the asset.
      "repo:k/edited": oldRecord("k", "edited", { pattern: "^uBlock0_\\d.*\\.chromium\\.crx$", installed: { tag: "1.77.0", digest: ublockRelease.assets[0].digest, version: "1.77.0" } }),
      // Hand-edited pattern with nothing to derive a template from.
      "repo:k/lost": oldRecord("k", "lost", { pattern: "^(a+)+$" }),
      pendingDownloads: { 24: { extensionId: UBLOCK_ID, at: 0 } },
      settings: { githubToken: "" },
    },
  };
}

// Requirement: existing phone data keeps working after the update (stored formats migrate).
test("stored 0.1 records migrate: patterns become templates, keys move out of records, old downloads are swept", async () => {
  const env = fakeChrome({ extensions: [{ id: UBLOCK_ID, version: "1.77.0", name: "uBlock Origin", enabled: true }] });
  const { store, pkcs8 } = oldStorage();
  Object.assign(env.store, store);
  env.files.set(24, { filename: "uBlock.crx", bytes: new Uint8Array(1), state: "complete", exists: true });

  const view = Object.fromEntries((await trackedView()).map((v) => [v.key, v]));
  assert.equal(view["gorhill/ublock"].record.template, "uBlock0_{version}.chromium.crx");
  assert.equal(view["gorhill/ublock"].latest.asset.name, "uBlock0_1.77.0.chromium.crx");
  assert.equal(view["gorhill/ublock"].record.extensionId, UBLOCK_ID);
  assert.equal(view["gorhill/ublock"].state, "current");
  assert.equal(view["k/zip"].record.template, "uBlock0_{version}.chromium.zip");
  assert.equal(view["k/wild"].record.template, "uBlock0_*chromium.crx*");
  assert.equal(view["k/edited"].record.template, "uBlock0_{version}.chromium.crx");
  assert.equal(view["k/lost"].record.template, null);
  assert.match(view["k/lost"].record.error, /choose the asset again/i);
  for (const k of Object.keys(env.store).filter((x) => x.startsWith("repo:"))) {
    assert.ok(!("pattern" in env.store[k]) && !("keyPkcs8" in env.store[k]), k + " keeps no old fields");
  }
  assert.equal(exportedKey(await exportBackup(), "k/zip"), pkcs8);
  assert.ok(!("pendingDownloads" in env.store));

  await sweepDownloads(Date.now());
  assert.deepEqual(env.removed, [24], "the 0.1 download left from the phone run is still cleaned up");
});
