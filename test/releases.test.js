import { test } from "node:test";
import assert from "node:assert/strict";
import fc from "fast-check";
import {
  compareVersions, deriveTemplate, latestFor, matchAssets, parseRepo,
  selectRelease, simplifyReleases, updateState, versionFromTag,
} from "../src/lib/releases.js";

test("parseRepo accepts owner/repo and github.com URLs of the repo or a release", () => {
  const want = { owner: "gorhill", repo: "uBlock" };
  for (const input of [
    "gorhill/uBlock",
    " gorhill/uBlock ",
    "https://github.com/gorhill/uBlock",
    "https://github.com/gorhill/uBlock/",
    "https://github.com/gorhill/uBlock.git",
    "http://www.github.com/gorhill/uBlock/tree/master/src",
    "github.com/gorhill/uBlock",
    "https://github.com/gorhill/uBlock/releases",
    "https://github.com/gorhill/uBlock/releases/tag/1.77.0",
    "https://github.com/gorhill/uBlock/releases/download/1.77.0/uBlock0_1.77.0.chromium.crx",
  ]) {
    assert.deepEqual(parseRepo(input), want, input);
  }
  assert.deepEqual(parseRepo("kaovilai/github-bot-command-palette"), { owner: "kaovilai", repo: "github-bot-command-palette" });
});

test("parseRepo rejects other hosts and inputs without owner and repo", () => {
  for (const input of ["", "gorhill", "https://gitlab.com/gorhill/uBlock", "https://github.com/gorhill", "a b/c", "github.com/gorhill"]) {
    assert.throws(() => parseRepo(input), /parse repo/, input);
  }
});

test("compareVersions orders numerically with pre-releases before releases", () => {
  const cases = [
    ["1.10", "1.9", 1],
    ["1.0", "1.0.0", 0],
    ["v1.2", "1.2", 0],
    ["1.77.0", "1.77.0", 0],
    ["1.77.1", "1.77.0", 1],
    ["1.77.1b3", "1.77.0", 1],
    ["1.77.1b3", "1.77.1", -1],
    ["1.77.1b3", "1.77.1b10", -1],
    ["2.0-rc1", "2.0-beta2", 1],
    ["0.0.1", "0.0.0.9", 1],
    // F12: every dotted number of a pre-release part counts.
    ["2.0-rc.2.10", "2.0-rc.2.9", 1],
    ["2.0-rc.2.0", "2.0-rc.2", 0],
    ["2.0-beta.1.2.3", "2.0-beta.1.2.4", -1],
  ];
  for (const [a, b, want] of cases) {
    assert.equal(compareVersions(a, b), want, `${a} vs ${b}`);
    assert.equal(compareVersions(b, a), 0 - want || 0, `${b} vs ${a}`);
  }
  assert.throws(() => compareVersions("latest", "1.0"), /not a version: "latest"/);
});

test("versionFromTag extracts the version part of common tag styles", () => {
  assert.equal(versionFromTag("v1.2.1"), "1.2.1");
  assert.equal(versionFromTag("1.77.1b3"), "1.77.1b3");
  assert.equal(versionFromTag("release-3.4"), "3.4");
  assert.equal(versionFromTag("nightly"), null);
});

const asset = (name) => ({ name, url: "https://example.invalid/" + name, size: 1, digest: null });
const release = (tag, names, extra = {}) => ({ tag, name: tag, prerelease: false, publishedAt: "2026-01-01T00:00:00Z", htmlUrl: "", assets: names.map(asset), ...extra });

test("deriveTemplate generalizes the version so the same asset is found in later releases", () => {
  const ublock = deriveTemplate("uBlock0_1.77.0.chromium.crx", "1.77.0");
  const later = release("1.78.0", ["uBlock0_1.78.0.chromium.crx", "uBlock0_1.78.0.chromium.zip", "uBlock0_1.78.0.firefox.signed.xpi"]);
  assert.deepEqual(matchAssets(later, ublock).map((a) => a.name), ["uBlock0_1.78.0.chromium.crx"]);
  const beta = release("1.77.1b3", ["uBlock0_1.77.1b3.chromium.crx", "uBlock0_1.77.1b3.chromium.zip"]);
  assert.deepEqual(matchAssets(beta, ublock).map((a) => a.name), ["uBlock0_1.77.1b3.chromium.crx"]);

  const palette = deriveTemplate("github-bot-command-palette-v1.2.0.zip", "v1.2.0");
  const next = release("v1.2.1", ["github-bot-command-palette-v1.2.1.crx", "github-bot-command-palette-v1.2.1.zip", "github-bot-command-palette.crx", "github-bot-command-palette.zip"]);
  assert.deepEqual(matchAssets(next, palette).map((a) => a.name), ["github-bot-command-palette-v1.2.1.zip"]);
});

test("deriveTemplate generalizes dotted numbers when the tag version is not in the name, and keeps fixed names literal", () => {
  const p = deriveTemplate("ext-2.3.4-chrome.zip", "release-42");
  assert.deepEqual(matchAssets(release("release-43", ["ext-2.4.0-chrome.zip", "ext-2.4.0-firefox.zip"]), p).map((a) => a.name), ["ext-2.4.0-chrome.zip"]);
  const fixed = deriveTemplate("extension.zip", "v1.0");
  assert.deepEqual(matchAssets(release("v2.0", ["extension.zip", "extension.zip.sig", "my-extension.zip"]), fixed).map((a) => a.name), ["extension.zip"]);
});

test("simplifyReleases drops drafts and keeps asset digests", () => {
  const api = [
    { tag_name: "v2", name: "", draft: true, prerelease: false, published_at: "x", html_url: "h2", assets: [] },
    { tag_name: "v1", name: "One", draft: false, prerelease: true, published_at: "2026-01-01T00:00:00Z", html_url: "h1",
      assets: [{ name: "a.zip", browser_download_url: "u", size: 3, digest: "sha256:ab" }] },
  ];
  assert.deepEqual(simplifyReleases(api), [
    { tag: "v1", name: "One", prerelease: true, publishedAt: "2026-01-01T00:00:00Z", htmlUrl: "h1", assets: [{ name: "a.zip", url: "u", size: 3, digest: "sha256:ab" }] },
  ]);
});

test("selectRelease picks the newest release with a matching asset and honors the pre-release toggle", () => {
  const releases = [
    release("1.0", ["x-1.0.crx"], { publishedAt: "2026-01-01T00:00:00Z" }),
    release("1.2b1", ["x-1.2b1.crx"], { publishedAt: "2026-03-01T00:00:00Z", prerelease: true }),
    release("1.1", ["notes.txt"], { publishedAt: "2026-02-01T00:00:00Z" }),
  ];
  const p = deriveTemplate("x-1.0.crx", "1.0");
  assert.equal(selectRelease(releases, p, false).release.tag, "1.0");
  assert.equal(selectRelease(releases, p, true).release.tag, "1.2b1");
  assert.equal(selectRelease(releases, "nothing", true), null);
});

test("latestFor leaves the asset unset when several assets match", () => {
  const record = { template: "*.zip", includePrereleases: false, releases: [release("v1", ["a.zip", "b.zip"])] };
  const latest = latestFor(record);
  assert.equal(latest.asset, null);
  assert.deepEqual(latest.candidates.map((a) => a.name), ["a.zip", "b.zip"]);
});

test("updateState: digest decides when Extainium installed the running version, versions decide otherwise", () => {
  const latest = { tag: "1.78.0", asset: { ...asset("u_1.78.0.crx"), digest: "sha256:new" } };
  const ext = (version) => ({ id: "x", version });
  assert.equal(updateState({ latest: null, installed: null }, null), "no-asset");
  assert.equal(updateState({ latest: { ...latest, asset: null }, installed: null }, ext("1")), "ambiguous");
  assert.equal(updateState({ latest, installed: null }, null), "not-installed");
  // Installed outside Extainium: compare the tag's version with the manifest version.
  assert.equal(updateState({ latest, installed: null }, ext("1.77.0")), "update");
  assert.equal(updateState({ latest, installed: null }, ext("1.78.0")), "current");
  // Installed by Extainium and still running that version: compare digests, then tags.
  assert.equal(updateState({ latest, installed: { tag: "1.78.0", digest: "sha256:new", version: "1.78.0" } }, ext("1.78.0")), "current");
  assert.equal(updateState({ latest, installed: { tag: "1.78.0", digest: "sha256:old", version: "1.78.0" } }, ext("1.78.0")), "update");
  assert.equal(updateState({ latest: { ...latest, asset: asset("n") }, installed: { tag: "1.77.0", digest: null, version: "5" } }, ext("5")), "update");
  assert.equal(updateState({ latest: { tag: "nightly", asset: asset("n") }, installed: null }, ext("5")), "unknown");
});

// F12: version ordering decides first; a digest difference only marks a rebuild of the same release.
test("updateState never offers an older release as an update", () => {
  const ext = { id: "x", version: "2.0.0" };
  const stable = { tag: "v1.9.0", asset: { ...asset("ext.crx"), digest: "sha256:stable" } };
  assert.equal(updateState({ latest: stable, installed: { tag: "v2.0.0-beta1", digest: "sha256:beta", version: "2.0.0" } }, ext), "current");
  assert.equal(updateState({ latest: stable, installed: null }, ext), "current");
  const beta2 = { tag: "v2.0.0-beta2", asset: { ...asset("ext.crx"), digest: "sha256:beta2" } };
  assert.equal(updateState({ latest: beta2, installed: { tag: "v2.0.0-beta1", digest: "sha256:beta", version: "2.0.0" } }, ext), "update");
  // F12: a dotted pre-release number decides the order, so 2.9 is not an update over 2.10.
  const older = { tag: "2.0-rc.2.9", asset: { ...asset("ext.crx"), digest: "sha256:older" } };
  assert.equal(updateState({ latest: older, installed: { tag: "2.0-rc.2.10", digest: "sha256:newer", version: "2.0" } }, { id: "x", version: "2.0" }), "current");
  const rebuild = { tag: "v2.0.0-beta1", asset: { ...asset("ext.crx"), digest: "sha256:rebuilt" } };
  assert.equal(updateState({ latest: rebuild, installed: { tag: "v2.0.0-beta1", digest: "sha256:beta", version: "2.0.0" } }, ext), "update");
});

// F15: version ordering against an independent reference. Versions are
// generated as structures { core, pre: { label, nums } | null } and written out
// in the forms the grammar accepts; the reference compares the structures as the
// compareVersions contract says: dotted core numbers (missing = 0), then a
// pre-release sorts before none, then label text (case-insensitive), then the
// dotted pre-release numbers (missing = 0).
const LABEL_LIST = ["alpha", "a", "beta", "b", "pre", "preview", "rc", "dev", "canary", "nightly", "snapshot"];
// Small numbers and short lists, so that generated versions often share a
// core and a label and the later parts decide.
const nums = fc.array(fc.integer({ min: 0, max: 12 }), { minLength: 1, maxLength: 3 });
const structured = fc.record({
  core: fc.array(fc.integer({ min: 0, max: 1 }), { minLength: 1, maxLength: 2 }),
  pre: fc.option(fc.record({ label: fc.oneof(fc.constant("rc"), fc.constantFrom(...LABEL_LIST)), nums: fc.option(nums, { nil: [] }) }), { nil: null }),
});
const written = (v) => fc.tuple(fc.constantFrom("", "v"), fc.constantFrom("", "-", "."), fc.constantFrom("", "-", "."), fc.boolean())
  .map(([lead, s1, s2, upper]) => {
    let out = lead + v.core.join(".");
    if (v.pre) {
      out += s1 + (upper ? v.pre.label.toUpperCase() : v.pre.label);
      if (v.pre.nums.length) out += s2 + v.pre.nums.join(".");
    }
    return out;
  });
const versionPair = structured.chain((v) => written(v).map((text) => ({ v, text })));

function cmpNums(a, b) {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    if (d) return Math.sign(d);
  }
  return 0;
}
function reference(x, y) {
  const c = cmpNums(x.core, y.core);
  if (c) return c;
  if (!x.pre || !y.pre) return x.pre ? -1 : y.pre ? 1 : 0;
  if (x.pre.label !== y.pre.label) return x.pre.label < y.pre.label ? -1 : 1;
  return cmpNums(x.pre.nums, y.pre.nums);
}

test("property: compareVersions agrees with the reference order, is antisymmetric and transitive", () => {
  fc.assert(
    fc.property(versionPair, versionPair, versionPair, (a, b, c) => {
      const ab = compareVersions(a.text, b.text);
      assert.equal(ab, reference(a.v, b.v), `${a.text} vs ${b.text}`);
      assert.equal(compareVersions(b.text, a.text), -ab || 0, `antisymmetry ${a.text} ${b.text}`);
      const bc = compareVersions(b.text, c.text);
      if (ab <= 0 && bc <= 0) assert.ok(compareVersions(a.text, c.text) <= 0, `transitivity ${a.text} ${b.text} ${c.text}`);
    }),
    { numRuns: 2000 }
  );
});
