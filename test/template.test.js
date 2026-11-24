import { test } from "node:test";
import assert from "node:assert/strict";
import fc from "fast-check";
import { PRERELEASE_LABELS, deriveTemplate, matchTemplate, validateTemplate } from "../src/lib/releases.js";

// F10: the pre-release tag forms from the review; the derived template must
// find the picked asset and the same asset of a later stable release.
test("templates derived from pre-release assets match the picked asset and later releases", () => {
  const cases = [
    ["ext-v1.2.3-rc.zip", "v1.2.3-rc", "ext-v{version}.zip"],
    ["ext-v1.2.3-RC1.zip", "v1.2.3-RC1", "ext-v{version}.zip"],
    ["ext-1.2.3-preview.1.zip", "v1.2.3-preview.1", "ext-{version}.zip"],
    ["uBlock0_1.77.1b3.chromium.crx", "1.77.1b3", "uBlock0_{version}.chromium.crx"],
  ];
  for (const [name, tag, want] of cases) {
    const t = deriveTemplate(name, tag);
    assert.equal(t, want, name);
    assert.ok(matchTemplate(t, name), name);
    assert.ok(matchTemplate(t, name.replace(tag.replace(/^v/, ""), "1.2.4")), name + " later stable");
  }
});

test("matchTemplate: * matches any run, {version} only a version, the rest is literal", () => {
  assert.ok(matchTemplate("ext-*.zip", "ext-anything-at-all.zip"));
  assert.ok(matchTemplate("ext-*.zip", "ext-.zip"));
  assert.ok(!matchTemplate("ext-*.zip", "ext-a.zip.sig"));
  assert.ok(matchTemplate("ext-{version}.zip", "ext-10.0.zip"));
  assert.ok(!matchTemplate("ext-{version}.zip", "ext-.zip"));
  assert.ok(!matchTemplate("ext-{version}.zip", "ext-1.2-firefox.zip"), "firefox is not a pre-release label");
  assert.ok(!matchTemplate("ext-{version}.zip", "ext-latest.zip"));
  assert.ok(matchTemplate("(a+)+", "(a+)+"), "regex syntax is literal text");
  assert.ok(!matchTemplate("(a+)+", "aaa"));
  assert.ok(!matchTemplate("Ext.zip", "ext.zip"), "literal text is case-sensitive");
});

// F10: literal text is matched by code points, as the name is read; an emoji
// (two UTF-16 code units) in the name still matches its derived template.
test("a template derived from a name with an emoji matches that name", () => {
  const name = "example-😀-1.2.zip";
  const t = deriveTemplate(name, "v1.2");
  assert.equal(t, "example-😀-{version}.zip");
  assert.ok(matchTemplate(t, name));
  assert.ok(matchTemplate(t, "example-😀-1.3.zip"));
  assert.ok(!matchTemplate(t, "example-😁-1.3.zip"));
});

// The tag's version is replaced only where it is a whole version in the name.
test("deriveTemplate does not replace the tag's version inside a longer version", () => {
  assert.equal(deriveTemplate("ext-1.10.zip", "v1"), "ext-{version}.zip");
  assert.equal(deriveTemplate("ext-1.2-rc1.zip", "v1.2"), "ext-{version}.zip");
});

// F3: matching time is linear in the name; hostile templates and names finish quickly.
test("hostile templates against long names finish in bounded time", () => {
  const started = performance.now();
  assert.equal(matchTemplate("*a*a*a*a*a*a*a*a*a*a*a*a*a*a*a*a*a*a*b", "a".repeat(20000)), false);
  assert.equal(matchTemplate("{version}{version}{version}{version}{version}x", "1.".repeat(5000) + "1"), false);
  assert.ok(performance.now() - started < 3000, `took ${performance.now() - started} ms`);
});

test("validateTemplate rejects empty, overlong, slash, control-character and unknown-placeholder templates", () => {
  for (const bad of ["", "x".repeat(201), "a/b.zip", "a\nb", "ext-{ver}.zip", "ext-{version.zip", 5, null]) {
    assert.throws(() => validateTemplate(bad), /asset template/, JSON.stringify(bad));
  }
  assert.equal(validateTemplate("uBlock0_{version}.chromium.crx"), "uBlock0_{version}.chromium.crx");
});

// Generators for the derivation property: realistic asset names prefix + version + suffix.
const digits = fc.integer({ min: 0, max: 999 }).map(String);
const core = fc.array(digits, { minLength: 1, maxLength: 4 }).map((p) => p.join("."));
const label = fc.constantFrom(...PRERELEASE_LABELS, ...PRERELEASE_LABELS.map((l) => l.toUpperCase()));
const pre = fc.option(
  fc.tuple(fc.constantFrom("", "-", "."), label, fc.option(fc.tuple(fc.constantFrom("", "-", "."), core), { nil: null }))
    .map(([s, l, n]) => s + l + (n ? n[0] + n[1] : "")),
  { nil: "" }
);
const version = fc.tuple(core, pre).map(([c, p]) => c + p);
// A word after the version must not start with a pre-release label run ("rc", "a0"),
// which would make the version part itself ambiguous.
// F10: words also hold non-ASCII and non-BMP characters (e.g. emoji), which
// are literal text in a template.
const wide = fc.integer({ min: 0xa0, max: 0x10ffff })
  .filter((n) => n < 0xd800 || n > 0xdfff)
  .map((n) => String.fromCodePoint(n));
const wordChar = fc.oneof(fc.constantFrom(..."abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"), wide, fc.constantFrom("😀", "𝔘", "é", "中"));
const word = fc.tuple(fc.oneof(fc.constantFrom(..."abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ"), wide), fc.array(wordChar, { maxLength: 8 }))
  .map(([first, rest]) => first + rest.join(""))
  .filter((w) => !PRERELEASE_LABELS.includes((w.match(/^[A-Za-z]+/) || [""])[0].toLowerCase()));
// The prefix must not end with a digit, a letter run glued to the version is fine ("v1.2").
const prefix = fc.tuple(fc.array(word, { maxLength: 2 }), fc.constantFrom("", "_", "-", "-v", "_v", "v"))
  .map(([ws, end]) => ws.join("-") + (ws.length ? end || "-" : end));
const suffix = fc.tuple(fc.array(fc.tuple(fc.constantFrom(".", "_", "-"), word), { maxLength: 2 }), fc.constantFrom(".zip", ".crx", ".chromium.crx"))
  .map(([parts, ext]) => parts.map(([s, w]) => s + w).join("") + ext);
const tagPrefix = fc.constantFrom("", "v", "V", "release-", "version ");

test("property: a derived template matches the asset it came from and the same name with another version", () => {
  fc.assert(
    fc.property(prefix, version, suffix, version, tagPrefix, (pre_, v, suf, other, tp) => {
      const name = pre_ + v + suf;
      const t = deriveTemplate(name, tp + v);
      assert.ok(matchTemplate(t, name), `${t} vs ${name}`);
      assert.ok(matchTemplate(t, pre_ + other + suf), `${t} vs ${pre_ + other + suf}`);
    })
  );
});
