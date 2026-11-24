import { test } from "node:test";
import assert from "node:assert/strict";
import fc from "fast-check";
import { buildZip, normalizeExtensionZip, parseZip, readManifest } from "../src/lib/zip.js";

const enc = new TextEncoder();

async function deflateRaw(bytes) {
  const s = new Blob([bytes]).stream().pipeThrough(new CompressionStream("deflate-raw"));
  return new Uint8Array(await new Response(s).arrayBuffer());
}

function stored(name, text) {
  const data = enc.encode(text);
  return { name, flags: 0x800, method: 0, mtime: 0, mdate: 33, crc: 0, compSize: data.length, uncompSize: data.length, data };
}

// Round-trip: every field buildZip writes is read back by parseZip, in order.
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
      assert.deepEqual(parsed, entries.map((e) => ({ ...e, compSize: e.data.length })));
    })
  );
});

test("parseZip rejects bytes without a central directory", () => {
  assert.throws(() => parseZip(enc.encode("not a zip at all, just text bytes")), /no end-of-central-directory/);
});

test("readManifest inflates a deflated manifest.json", async () => {
  const json = enc.encode('{"name":"Demo","version":"1.2.3"}');
  const data = await deflateRaw(json);
  const zip = buildZip([{ name: "manifest.json", flags: 0, method: 8, mtime: 0, mdate: 0, crc: 0, compSize: data.length, uncompSize: json.length, data }]);
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

test("normalizeExtensionZip fails when no manifest.json exists", async () => {
  await assert.rejects(normalizeExtensionZip(buildZip([stored("a.txt", "x")])), /no manifest.json/);
});
