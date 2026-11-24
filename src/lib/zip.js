// Minimal zip reader/writer for extension packages (no zip64, no encryption).

const EOCD_SIG = 0x06054b50;
const CENTRAL_SIG = 0x02014b50;
const LOCAL_SIG = 0x04034b50;
const FLAG_ENCRYPTED = 0x1;
const FLAG_DATA_DESCRIPTOR = 0x8;
const FLAG_UTF8 = 0x800;

// CP437, the ZIP default name encoding when the UTF-8 flag is clear (APPNOTE 4.4.4, appendix D).
const CP437_HIGH =
  "ÇüéâäàåçêëèïîìÄÅÉæÆôöòûùÿÖÜ¢£¥₧ƒáíóúñÑªº¿⌐¬½¼¡«»░▒▓│┤╡╢╖╕╣║╗╝╜╛┐└┴┬├─┼╞╟╚╔╩╦╠═╬╧╨╤╥╙╘╒╓╫╪┘┌█▄▌▐▀αßΓπΣσµτΦΘΩδ∞φε∩≡±≥≤⌠⌡÷≈°∙·√ⁿ²■\u00a0";

function decodeName(bytes, flags) {
  if (flags & FLAG_UTF8) return new TextDecoder().decode(bytes);
  let s = "";
  for (const b of bytes) s += b < 0x80 ? String.fromCharCode(b) : CP437_HIGH[b - 0x80];
  return s;
}

import { concatBytes } from "./crx.js";

// Returns entries { name, nameBytes, flags, method, mtime, mdate, crc, compSize, uncompSize, data }
// where data is the stored (possibly compressed) bytes and name is decoded
// from nameBytes as UTF-8 (flag bit 11) or CP437.
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
    const flags = dv.getUint16(p + 8, true);
    const nameBytes = bytes.slice(p + 46, p + 46 + nameLen);
    const name = decodeName(nameBytes, flags);
    if (localOffset + 30 > bytes.length || dv.getUint32(localOffset, true) !== LOCAL_SIG) {
      throw new Error(`parse zip: local header for ${name} missing at offset ${localOffset}`);
    }
    const localNameLen = dv.getUint16(localOffset + 26, true);
    const localName = bytes.subarray(localOffset + 30, localOffset + 30 + localNameLen);
    if (localNameLen !== nameLen || localName.some((b, i) => b !== nameBytes[i])) {
      const localShown = decodeName(localName, dv.getUint16(localOffset + 6, true));
      throw new Error(`parse zip: central directory names "${name}" but its local header names "${localShown}"`);
    }
    const dataStart = localOffset + 30 + localNameLen + dv.getUint16(localOffset + 28, true);
    if (dataStart + compSize > bytes.length) throw new Error(`parse zip: data of ${name} overruns file`);
    entries.push({
      name,
      nameBytes,
      flags,
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
// Names are written as their original nameBytes when present (flags kept),
// else as UTF-8 with the UTF-8 flag set for non-ASCII names.
export function buildZip(entries) {
  const enc = new TextEncoder();
  const locals = [];
  const central = [];
  let offset = 0;
  for (const e of entries) {
    const name = e.nameBytes || enc.encode(e.name);
    const nonAscii = !e.nameBytes && name.some((b) => b >= 0x80);
    const flags = (e.flags & ~FLAG_DATA_DESCRIPTOR) | (nonAscii ? FLAG_UTF8 : 0);
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
  if (entry.flags & FLAG_ENCRYPTED) throw new Error(`read zip entry ${entry.name}: encrypted entries are not supported`);
  if (entry.method === 0) return entry.data;
  if (entry.method === 8) {
    try {
      return await inflateRaw(entry.data);
    } catch (e) {
      throw new Error(`read zip entry ${entry.name}: corrupt deflate data (${e.message})`);
    }
  }
  throw new Error(`read zip entry ${entry.name}: unsupported compression method ${entry.method}`);
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

export function crc32(bytes) {
  let c = 0xffffffff;
  for (const b of bytes) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

const hex32 = (n) => "0x" + n.toString(16).padStart(8, "0");

// Rejects an archive whose entries do not decompress to their declared size and CRC-32.
export async function verifyZip(entries) {
  for (const e of entries) {
    const data = await readEntry(e);
    if (data.length !== e.uncompSize) {
      throw new Error(`verify zip: entry "${e.name}" has ${data.length} bytes, its header declares ${e.uncompSize}`);
    }
    const crc = crc32(data);
    if (crc !== e.crc) {
      throw new Error(`verify zip: entry "${e.name}" CRC-32 is ${hex32(crc)}, its header declares ${hex32(e.crc)}`);
    }
  }
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

// Checks every entry's size and CRC-32, then moves the shallowest folder
// holding manifest.json to the zip root, as release zips often wrap the
// extension in a folder. Name bytes and flags are kept as they were.
// Returns { bytes, manifest }.
export async function normalizeExtensionZip(bytes) {
  const entries = parseZip(bytes);
  await verifyZip(entries);
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
  // Entries are selected by decoded name, as entries of one folder may use
  // different name encodings. Each is stripped of its own prefix bytes: those
  // up to and including its n-th "/" (0x2f is never part of a multi-byte UTF-8
  // character or a CP437 character), n being the folder depth of the prefix.
  const depth = prefix.split("/").length - 1;
  const stripped = entries
    .filter((e) => e.name.startsWith(prefix) && e.name.length > prefix.length)
    .map((e) => {
      let cut = 0;
      for (let n = 0; n < depth; n++) cut = e.nameBytes.indexOf(0x2f, cut) + 1;
      if (decodeName(e.nameBytes.subarray(0, cut), e.flags) !== prefix) {
        throw new Error(`normalize extension zip: cannot strip folder "${prefix}" from the name bytes of "${e.name}"`);
      }
      return { ...e, name: e.name.slice(prefix.length), nameBytes: e.nameBytes.slice(cut) };
    });
  return { bytes: buildZip(stripped), manifest: await readManifest(stripped) };
}
