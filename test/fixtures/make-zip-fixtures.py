#!/usr/bin/env python3
"""Builds the ZIP fixtures in this folder with Python's zipfile, independently
of src/lib/zip.js, and checks each with Python's reader.
Run from anywhere: python3 test/fixtures/make-zip-fixtures.py"""
import io
import json
import pathlib
import zipfile

HERE = pathlib.Path(__file__).parent
MANIFEST = {"name": "Example", "version": "1.0", "manifest_version": 3}
# Fixed timestamps so the fixtures are reproducible.
DATE = (2026, 1, 1, 0, 0, 0)


def build(entries, compression=zipfile.ZIP_DEFLATED, comment=b""):
    out = io.BytesIO()
    with zipfile.ZipFile(out, "w", compression=compression) as z:
        for name, data in entries:
            z.writestr(zipfile.ZipInfo(name, DATE), data, compress_type=compression)
        z.comment = comment
    return out.getvalue()


def write(name, data):
    (HERE / name).write_bytes(data)


def names(data):
    with zipfile.ZipFile(io.BytesIO(data)) as z:
        return z.namelist()


def rejects(data, member):
    try:
        with zipfile.ZipFile(io.BytesIO(data)) as z:
            z.read(member)
    except (zipfile.BadZipFile, EOFError, OSError) as e:
        return repr(e)
    raise AssertionError("Python's reader accepted a corrupt archive")


# A valid extension zip with manifest.json at the root.
root = build([("manifest.json", json.dumps(MANIFEST)), ("background.js", "console.log('example');\n" * 20)])
write("ext-root.zip", root)

# Wrapped in a folder; one file name uses CP437 (UTF-8 flag clear): byte 0x82 is "é".
wrapped = build([
    ("wrapper/manifest.json", json.dumps({**MANIFEST, "background": {"service_worker": "caf\u00e9.js"}})),
    ("wrapper/cafe.js", "console.log(1);\n"),
])
cp437 = wrapped.replace(b"wrapper/cafe.js", b"wrapper/caf\x82.js")
assert "wrapper/caf\u00e9.js" in names(cp437), names(cp437)
write("wrapped-cp437.zip", cp437)

# Wrapped, with a UTF-8 name (zipfile sets the UTF-8 flag for non-ASCII names).
utf8 = build([
    ("wrapper/manifest.json", json.dumps({**MANIFEST, "background": {"service_worker": "na\u00efve.js"}})),
    ("wrapper/na\u00efve.js", "console.log(2);\n"),
])
assert "wrapper/na\u00efve.js" in names(utf8)
write("wrapped-utf8.zip", utf8)

# Stored manifest with one byte changed after the CRC was written.
stored = build([("manifest.json", json.dumps(MANIFEST))], compression=zipfile.ZIP_STORED)
bad_crc = stored.replace(b'"Example"', b'"ExampLe"', 1)
print("bad-crc.zip:", rejects(bad_crc, "manifest.json"))
write("bad-crc.zip", bad_crc)

# Deflated background.js whose declared uncompressed size (local and central
# header) is one byte short of the real content.
real = build([("manifest.json", json.dumps(MANIFEST)), ("background.js", "x" * 100)])
with zipfile.ZipFile(io.BytesIO(real)) as z:
    info = z.getinfo("background.js")
size_le = (100).to_bytes(4, "little")
crc_le = info.CRC.to_bytes(4, "little")
bad_size = real.replace(crc_le + info.compress_size.to_bytes(4, "little") + size_le,
                        crc_le + info.compress_size.to_bytes(4, "little") + (99).to_bytes(4, "little"))
assert bad_size.count((99).to_bytes(4, "little")) >= 2 and bad_size != real
print("bad-size.zip:", rejects(bad_size, "background.js"))
write("bad-size.zip", bad_size)

print("fixtures written to", HERE)
