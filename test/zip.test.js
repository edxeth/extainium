import { test } from "node:test";
import assert from "node:assert/strict";
import fc from "fast-check";
import { readFileSync } from "node:fs";
import { crc32 } from "node:zlib";
import { buildZip, normalizeExtensionZip, parseZip, readManifest } from "../src/lib/zip.js";

const enc = new TextEncoder();

async function deflateRaw(bytes) {
  const s = new Blob([bytes]).stream().pipeThrough(new CompressionStream("deflate-raw"));
  return new Uint8Array(await new Response(s).arrayBuffer());
}

function stored(name, text) {
  const data = enc.encode(text);
  return { name, flags: 0x800, method: 0, mtime: 0, mdate: 33, crc: crc32(data), compSize: data.length, uncompSize: data.length, data };
}

// Round-trip: every field buildZip writes is read back by parseZip, in order.
// Names without nameBytes are written as UTF-8, flagged as such when not ASCII (APPNOTE bit 11).
test("property: parseZip inverts buildZip", () => {
  const entry = fc.record({
    name: fc.string({ unit: "grapheme", minLength: 1, maxLength: 40 }),
    flags: fc.constantFrom(0, 0x800, 0x2, 0x802),
    method: fc.constantFrom(0, 8),
    mtime: fc.integer({ min: 0, max: 0xffff }),
    mdate: fc.integer({ min: 0, max: 0xffff }),
    crc: fc.integer({ min: 0, max: 0xffffffff }),
    uncompSize: fc.integer({ min: 0, max: 0xffffffff }),
    data: fc.uint8Array({ maxLength: 300 }),
  });
  fc.assert(
    fc.property(fc.array(entry, { maxLength: 8 }), (entries) => {
      const parsed = parseZip(buildZip(entries));
      assert.deepEqual(parsed, entries.map((e) => {
        const nameBytes = enc.encode(e.name);
        const flags = e.flags | (nameBytes.some((b) => b >= 0x80) ? 0x800 : 0);
        return { ...e, nameBytes, flags, compSize: e.data.length };
      }));
    })
  );
});

test("parseZip rejects bytes without a central directory", () => {
  assert.throws(() => parseZip(enc.encode("not a zip at all, just text bytes")), /no end-of-central-directory/);
});

test("readManifest inflates a deflated manifest.json", async () => {
  const json = enc.encode('{"name":"Demo","version":"1.2.3"}');
  const data = await deflateRaw(json);
  const zip = buildZip([{ name: "manifest.json", flags: 0, method: 8, mtime: 0, mdate: 0, crc: crc32(json), compSize: data.length, uncompSize: json.length, data }]);
  assert.deepEqual(await readManifest(parseZip(zip)), { name: "Demo", version: "1.2.3" });
});

// Release zips often wrap the extension in a folder; Chromium needs manifest.json at the root.
test("normalizeExtensionZip moves the shallowest manifest folder to the root", async () => {
  const zip = buildZip([
    stored("ext/manifest.json", '{"name":"Wrapped","version":"2.0"}'),
    stored("ext/js/a.js", "x"),
    stored("ext/vendor/manifest.json", "{}"),
    stored("README.md", "outside"),
  ]);
  const out = await normalizeExtensionZip(zip);
  assert.deepEqual(parseZip(out.bytes).map((e) => e.name), ["manifest.json", "js/a.js", "vendor/manifest.json"]);
  assert.equal(out.manifest.version, "2.0");
});

const fixture = (name) => new Uint8Array(readFileSync(new URL("./fixtures/" + name, import.meta.url)));
const has = (hay, needle) => Buffer.from(hay).includes(Buffer.from(needle, "latin1"));

// F8: archives built by Python's zipfile (test/fixtures/make-zip-fixtures.py).
test("normalizing a wrapped zip keeps CP437 name bytes and their flag, so the manifest's file reference still resolves", async () => {
  const { bytes, manifest } = await normalizeExtensionZip(fixture("wrapped-cp437.zip"));
  assert.equal(manifest.background.service_worker, "caf\u00e9.js");
  assert.ok(has(bytes, "caf\x82.js"), "original CP437 bytes kept");
  assert.ok(!has(bytes, "caf\xc3\xa9.js"), "not re-encoded as UTF-8");
  const entry = parseZip(bytes).find((e) => e.name === "caf\u00e9.js");
  assert.ok(entry, "CP437 name decodes to café.js");
  assert.equal(entry.flags & 0x800, 0);
});

test("normalizing a wrapped zip keeps UTF-8 names with the UTF-8 flag", async () => {
  const { bytes } = await normalizeExtensionZip(fixture("wrapped-utf8.zip"));
  const entry = parseZip(bytes).find((e) => e.name === "na\u00efve.js");
  assert.ok(entry);
  assert.equal(entry.flags & 0x800, 0x800);
});

// F9: integrity checks; Python's reader rejects both fixtures.
test("a zip entry with a wrong CRC-32 is rejected with an error naming the entry", async () => {
  await assert.rejects(normalizeExtensionZip(fixture("bad-crc.zip")), /CRC-32.*manifest\.json|manifest\.json.*CRC-32/);
});

test("a zip entry whose size differs from its declared size is rejected with an error naming the entry", async () => {
  await assert.rejects(normalizeExtensionZip(fixture("bad-size.zip")), /background\.js/);
});

test("a valid root zip from Python's zipfile passes the integrity checks", async () => {
  const { manifest } = await normalizeExtensionZip(fixture("ext-root.zip"));
  assert.equal(manifest.version, "1.0");
});

test("normalizeExtensionZip fails when no manifest.json exists", async () => {
  await assert.rejects(normalizeExtensionZip(buildZip([stored("a.txt", "x")])), /no manifest.json/);
});
