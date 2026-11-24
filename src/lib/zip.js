// Minimal zip reader/writer for extension packages (no zip64, no encryption).

const EOCD_SIG = 0x06054b50;
const CENTRAL_SIG = 0x02014b50;
const LOCAL_SIG = 0x04034b50;
const FLAG_DATA_DESCRIPTOR = 0x8;

import { concatBytes } from "./crx.js";

// Returns entries { name, flags, method, mtime, mdate, crc, compSize, uncompSize, data }
// where data is the stored (possibly compressed) bytes.
export function parseZip(bytes) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let eocd = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 22 - 65535); i--) {
    if (dv.getUint32(i, true) === EOCD_SIG) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error(`parse zip: no end-of-central-directory record in ${bytes.length} bytes`);
  const count = dv.getUint16(eocd + 10, true);
  let p = dv.getUint32(eocd + 16, true);
  const dec = new TextDecoder();
  const entries = [];
  for (let n = 0; n < count; n++) {
    if (p + 46 > bytes.length || dv.getUint32(p, true) !== CENTRAL_SIG) {
      throw new Error(`parse zip: central directory entry ${n} missing at offset ${p}`);
    }
    const nameLen = dv.getUint16(p + 28, true);
    const extraLen = dv.getUint16(p + 30, true);
    const commentLen = dv.getUint16(p + 32, true);
    const compSize = dv.getUint32(p + 20, true);
    const localOffset = dv.getUint32(p + 42, true);
    const name = dec.decode(bytes.subarray(p + 46, p + 46 + nameLen));
    if (localOffset + 30 > bytes.length || dv.getUint32(localOffset, true) !== LOCAL_SIG) {
      throw new Error(`parse zip: local header for ${name} missing at offset ${localOffset}`);
    }
    const dataStart = localOffset + 30 + dv.getUint16(localOffset + 26, true) + dv.getUint16(localOffset + 28, true);
    if (dataStart + compSize > bytes.length) throw new Error(`parse zip: data of ${name} overruns file`);
    entries.push({
      name,
      flags: dv.getUint16(p + 8, true),
      method: dv.getUint16(p + 10, true),
      mtime: dv.getUint16(p + 12, true),
      mdate: dv.getUint16(p + 14, true),
      crc: dv.getUint32(p + 16, true),
      compSize,
      uncompSize: dv.getUint32(p + 24, true),
      data: bytes.subarray(dataStart, dataStart + compSize),
    });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

// Writes entries as parsed by parseZip. Sizes and CRC are taken as given.
export function buildZip(entries) {
  const enc = new TextEncoder();
  const locals = [];
  const central = [];
  let offset = 0;
  for (const e of entries) {
    const name = enc.encode(e.name);
    const flags = e.flags & ~FLAG_DATA_DESCRIPTOR;
    const lh = new Uint8Array(30 + name.length);
    const l = new DataView(lh.buffer);
    l.setUint32(0, LOCAL_SIG, true);
    l.setUint16(4, 20, true);
    l.setUint16(6, flags, true);
    l.setUint16(8, e.method, true);
    l.setUint16(10, e.mtime, true);
    l.setUint16(12, e.mdate, true);
    l.setUint32(14, e.crc, true);
    l.setUint32(18, e.data.length, true);
    l.setUint32(22, e.uncompSize, true);
    l.setUint16(26, name.length, true);
    lh.set(name, 30);
    const ch = new Uint8Array(46 + name.length);
    const c = new DataView(ch.buffer);
    c.setUint32(0, CENTRAL_SIG, true);
    c.setUint16(4, 20, true);
    c.setUint16(6, 20, true);
    c.setUint16(8, flags, true);
    c.setUint16(10, e.method, true);
    c.setUint16(12, e.mtime, true);
    c.setUint16(14, e.mdate, true);
    c.setUint32(16, e.crc, true);
    c.setUint32(20, e.data.length, true);
    c.setUint32(24, e.uncompSize, true);
    c.setUint16(28, name.length, true);
    c.setUint32(42, offset, true);
    ch.set(name, 46);
    locals.push(lh, e.data);
    central.push(ch);
    offset += lh.length + e.data.length;
  }
  const centralBlob = concatBytes(...central);
  const eocd = new Uint8Array(22);
  const d = new DataView(eocd.buffer);
  d.setUint32(0, EOCD_SIG, true);
  d.setUint16(8, entries.length, true);
  d.setUint16(10, entries.length, true);
  d.setUint32(12, centralBlob.length, true);
  d.setUint32(16, offset, true);
  return concatBytes(...locals, centralBlob, eocd);
}

async function inflateRaw(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

export async function readEntry(entry) {
  if (entry.method === 0) return entry.data;
  if (entry.method === 8) return inflateRaw(entry.data);
  throw new Error(`read zip entry ${entry.name}: unsupported compression method ${entry.method}`);
}

export async function readManifest(entries) {
  const m = entries.find((e) => e.name === "manifest.json");
  if (!m) throw new Error("read manifest: no manifest.json at zip root");
  // Chromium accepts a UTF-8 BOM in manifest.json.
  const text = new TextDecoder().decode(await readEntry(m)).replace(/^\uFEFF/, "");
  try {
    return JSON.parse(text);
  } catch (e) {
    throw new Error(`read manifest: manifest.json is not JSON (${e.message})`);
  }
}

// Moves the shallowest folder holding manifest.json to the zip root, as
// release zips often wrap the extension in a folder.
// Returns { bytes, manifest }.
export async function normalizeExtensionZip(bytes) {
  const entries = parseZip(bytes);
  if (entries.some((e) => e.name === "manifest.json")) {
    return { bytes, manifest: await readManifest(entries) };
  }
  let prefix = null;
  for (const e of entries) {
    if (!e.name.endsWith("/manifest.json")) continue;
    const candidate = e.name.slice(0, -"manifest.json".length);
    if (prefix === null || candidate.length < prefix.length) prefix = candidate;
  }
  if (prefix === null) throw new Error("normalize extension zip: no manifest.json in any folder");
  const stripped = entries
    .filter((e) => e.name.startsWith(prefix) && e.name.length > prefix.length)
    .map((e) => ({ ...e, name: e.name.slice(prefix.length) }));
  return { bytes: buildZip(stripped), manifest: await readManifest(stripped) };
}
