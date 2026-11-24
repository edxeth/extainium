// CRX3 container: parse, pack, sign, and derive extension IDs.
// Format: components/crx_file/crx3.proto in Chromium.
//   "Cr24" | u32le version=3 | u32le header length | CrxFileHeader | zip
// CrxFileHeader: 2 = sha256_with_rsa (AsymmetricKeyProof), 3 = sha256_with_ecdsa,
//   10000 = signed_header_data (SignedData { 1 = crx_id })
// AsymmetricKeyProof: 1 = public_key (SPKI DER), 2 = signature

const MAGIC = [0x43, 0x72, 0x32, 0x34]; // "Cr24"
const SIGNATURE_CONTEXT = new TextEncoder().encode("CRX3 SignedData\0");
const RSA = { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" };

export const CRX_MIME = "application/x-chrome-extension";

export function concatBytes(...parts) {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

function u32le(n) {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, n, true);
  return b;
}

function varint(n) {
  const out = [];
  for (; n > 0x7f; n = Math.floor(n / 128)) out.push((n & 0x7f) | 0x80);
  out.push(n);
  return Uint8Array.from(out);
}

function bytesField(fieldNumber, data) {
  return concatBytes(varint(fieldNumber * 8 + 2), varint(data.length), data);
}

function readVarint(bytes, pos) {
  let n = 0;
  for (let mul = 1; ; mul *= 128) {
    if (pos >= bytes.length) throw new Error(`protobuf: truncated varint at byte ${pos}`);
    const b = bytes[pos++];
    n += (b & 0x7f) * mul;
    if (b < 0x80) return [n, pos];
  }
}

// Returns [{ field, data }] for length-delimited fields; skips other wire types.
function parseFields(bytes) {
  const fields = [];
  let pos = 0;
  while (pos < bytes.length) {
    let tag;
    [tag, pos] = readVarint(bytes, pos);
    const field = Math.floor(tag / 8);
    const wire = tag & 7;
    if (wire === 0) [, pos] = readVarint(bytes, pos);
    else if (wire === 1) pos += 8;
    else if (wire === 5) pos += 4;
    else if (wire === 2) {
      let len;
      [len, pos] = readVarint(bytes, pos);
      if (pos + len > bytes.length) throw new Error(`protobuf: field ${field} length ${len} overruns message`);
      fields.push({ field, data: bytes.subarray(pos, pos + len) });
      pos += len;
    } else throw new Error(`protobuf: unsupported wire type ${wire} for field ${field}`);
  }
  if (pos !== bytes.length) throw new Error("protobuf: message truncated");
  return fields;
}

export function isCrx(bytes) {
  return bytes.length >= 4 && MAGIC.every((b, i) => bytes[i] === b);
}

function parseProof(data) {
  const proof = { publicKey: null, signature: null };
  for (const f of parseFields(data)) {
    if (f.field === 1) proof.publicKey = f.data;
    else if (f.field === 2) proof.signature = f.data;
  }
  return proof;
}

// Parses the CRX3 header. Needs only the first 12 + headerLength bytes.
export function parseCrx(bytes) {
  if (!isCrx(bytes)) throw new Error("parse CRX: missing Cr24 magic");
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.length < 12) throw new Error(`parse CRX: only ${bytes.length} bytes`);
  const version = dv.getUint32(4, true);
  if (version !== 3) throw new Error(`parse CRX: unsupported version ${version}`);
  const headerLength = dv.getUint32(8, true);
  const zipOffset = 12 + headerLength;
  if (zipOffset > bytes.length) {
    throw new Error(`parse CRX: header length ${headerLength} exceeds ${bytes.length} bytes`);
  }
  const header = { rsa: [], ecdsa: [], crxId: null, zipOffset };
  for (const f of parseFields(bytes.subarray(12, zipOffset))) {
    if (f.field === 2) header.rsa.push(parseProof(f.data));
    else if (f.field === 3) header.ecdsa.push(parseProof(f.data));
    else if (f.field === 10000) {
      for (const s of parseFields(f.data)) if (s.field === 1) header.crxId = s.data;
    }
  }
  return header;
}

// Inverse of parseCrx for the fields it reads.
export function encodeCrx({ rsa = [], ecdsa = [], crxId }, zip) {
  const proof = (p) => concatBytes(bytesField(1, p.publicKey), bytesField(2, p.signature));
  const header = concatBytes(
    ...rsa.map((p) => bytesField(2, proof(p))),
    ...ecdsa.map((p) => bytesField(3, proof(p))),
    bytesField(10000, bytesField(1, crxId))
  );
  return concatBytes(Uint8Array.from(MAGIC), u32le(3), u32le(header.length), header, zip);
}

// The bytes each CRX3 signature covers.
export function signedPayload(crxId, zip) {
  const signedData = bytesField(1, crxId);
  return concatBytes(SIGNATURE_CONTEXT, u32le(signedData.length), signedData, zip);
}

async function sha256(bytes) {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
}

export async function crxIdFromSpki(spki) {
  return (await sha256(spki)).slice(0, 16);
}

// Chromium maps each hex digit 0-f of the 16-byte ID to a-p.
export function extensionIdFromCrxId(crxId) {
  if (crxId.length !== 16) throw new Error(`extension ID: crx_id has ${crxId.length} bytes, expected 16`);
  let id = "";
  for (const b of crxId) id += String.fromCharCode(97 + (b >> 4), 97 + (b & 15));
  return id;
}

export async function extensionIdFromSpki(spki) {
  return extensionIdFromCrxId(await crxIdFromSpki(spki));
}

// The ID Chromium assigns: the crx_id of the signed header, which must be
// the hash of one of the proof keys, RSA or ECDSA (crx_verifier.cc checks both lists).
export async function extensionIdFromCrx(bytes) {
  const header = parseCrx(bytes);
  if (!header.crxId) throw new Error("extension ID from CRX: no signed crx_id in header");
  const id = extensionIdFromCrxId(header.crxId);
  for (const p of [...header.rsa, ...header.ecdsa]) {
    if (p.publicKey && (await extensionIdFromSpki(p.publicKey)) === id) return id;
  }
  throw new Error(`extension ID from CRX: no key in header hashes to crx_id ${id}`);
}

export function zipFromCrx(bytes) {
  return bytes.subarray(parseCrx(bytes).zipOffset);
}

export function base64Encode(bytes) {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(s);
}

export function base64Decode(text) {
  return Uint8Array.from(atob(text), (c) => c.charCodeAt(0));
}

// A new extractable RSA-2048 key as DER bytes: { pkcs8, spki }.
export async function generateSigningKey() {
  const pair = await crypto.subtle.generateKey(
    { ...RSA, modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]) },
    true,
    ["sign", "verify"]
  );
  const pkcs8 = new Uint8Array(await crypto.subtle.exportKey("pkcs8", pair.privateKey));
  return { pkcs8, spki: new Uint8Array(await crypto.subtle.exportKey("spki", pair.publicKey)) };
}

// pkcs8: DER bytes of an RSA private key. Returns { privateKey, spki }.
export async function importSigningKey(pkcs8) {
  let privateKey;
  try {
    privateKey = await crypto.subtle.importKey("pkcs8", pkcs8, RSA, true, ["sign"]);
  } catch (e) {
    throw new Error(`import signing key: not an RSA PKCS#8 key (${e.message})`);
  }
  const { kty, n, e } = await crypto.subtle.exportKey("jwk", privateKey);
  const publicKey = await crypto.subtle.importKey("jwk", { kty, n, e }, RSA, true, ["verify"]);
  return { privateKey, spki: new Uint8Array(await crypto.subtle.exportKey("spki", publicKey)) };
}

// Packs a zip into a CRX3 signed with the RSA key in pkcs8 (DER bytes).
export async function packCrx3(zip, pkcs8) {
  const { privateKey, spki } = await importSigningKey(pkcs8);
  const crxId = await crxIdFromSpki(spki);
  const signature = new Uint8Array(
    await crypto.subtle.sign(RSA.name, privateKey, signedPayload(crxId, zip))
  );
  return encodeCrx({ rsa: [{ publicKey: spki, signature }], crxId }, zip);
}
