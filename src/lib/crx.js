// CRX3 container: parse, pack, sign, and derive extension IDs.
// Format: components/crx_file/crx3.proto in Chromium.
//   "Cr24" | u32le version=3 | u32le header length | CrxFileHeader | zip
// CrxFileHeader: 2 = sha256_with_rsa (AsymmetricKeyProof), 3 = sha256_with_ecdsa,
//   10000 = signed_header_data (SignedData { 1 = crx_id })
// AsymmetricKeyProof: 1 = public_key (SPKI DER), 2 = signature

const MAGIC = [0x43, 0x72, 0x32, 0x34]; // "Cr24"
const SIGNATURE_CONTEXT = new TextEncoder().encode("CRX3 SignedData\0");
const RSA = { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" };
const ECDSA_KEY = { name: "ECDSA", namedCurve: "P-256" };
const ECDSA_SIG = { name: "ECDSA", hash: "SHA-256" };

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
  // signedHeaderData: the SignedData bytes as stored, which the signatures
  // cover; crxId is read from exactly these bytes. A repeated field would
  // leave the declared ID and the signed bytes ambiguous, so it is refused.
  const header = { rsa: [], ecdsa: [], crxId: null, signedHeaderData: null, zipOffset };
  const fields = parseFields(bytes.subarray(12, zipOffset));
  const signed = fields.filter((f) => f.field === 10000);
  if (signed.length > 1) throw new Error(`parse CRX: signed_header_data appears ${signed.length} times, expected once`);
  for (const f of fields) {
    if (f.field === 2) header.rsa.push(parseProof(f.data));
    else if (f.field === 3) header.ecdsa.push(parseProof(f.data));
  }
  if (signed.length) {
    header.signedHeaderData = signed[0].data;
    const ids = parseFields(signed[0].data).filter((s) => s.field === 1);
    if (ids.length > 1) throw new Error(`parse CRX: signed_header_data holds crx_id ${ids.length} times, expected once`);
    if (ids.length) header.crxId = ids[0].data;
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

// DER ECDSA-Sig-Value (SEQUENCE { INTEGER r, INTEGER s }), the form CRX3
// stores, to the fixed-size r || s that WebCrypto verifies. Null unless the
// encoding is canonical DER, as BoringSSL's ECDSA_SIG_from_bytes (Chromium's
// verifier) and OpenSSL require: short-form lengths (a P-256 signature has at
// most 72 bytes), each INTEGER nonnegative and minimal (a leading zero octet
// only before an octet with its high bit set), no bytes after the SEQUENCE.
function ecdsaDerToRaw(der, size = 32) {
  if (der.length < 8 || der[0] !== 0x30 || der[1] > 0x7f || der[1] !== der.length - 2) return null;
  const out = new Uint8Array(2 * size);
  let pos = 2;
  for (const at of [0, size]) {
    if (pos + 2 > der.length || der[pos] !== 0x02) return null;
    const len = der[pos + 1];
    if (len === 0 || len > 0x7f || pos + 2 + len > der.length) return null;
    let int = der.subarray(pos + 2, pos + 2 + len);
    if (int[0] & 0x80) return null; // negative
    if (int[0] === 0 && len > 1 && !(int[1] & 0x80)) return null; // non-minimal
    if (int[0] === 0) int = int.subarray(1);
    if (int.length > size) return null;
    out.set(int, at + size - int.length);
    pos += 2 + len;
  }
  return pos === der.length ? out : null;
}

// Verifies a CRX3 file as Chromium's crx_verifier.cc (VerifyCrx3) does: every
// RSA (PKCS#1 v1.5 SHA-256) and ECDSA (P-256 SHA-256) proof must verify over
// "CRX3 SignedData\0" | u32le size | signed header data | archive, and one
// proof's key must derive the crx_id the signed header declares.
// what: the file's name for errors. Returns the extension ID.
export async function verifyCrx(bytes, what = "CRX") {
  const fail = (msg) => new Error(`verify ${what}: ${msg}`);
  let header;
  try {
    header = parseCrx(bytes);
  } catch (e) {
    throw fail(e.message);
  }
  if (!header.signedHeaderData || !header.crxId) throw fail("the header has no signed crx_id");
  if (header.crxId.length !== 16) throw fail(`the signed crx_id has ${header.crxId.length} bytes, expected 16`);
  const id = extensionIdFromCrxId(header.crxId);
  const shd = header.signedHeaderData;
  const payload = concatBytes(SIGNATURE_CONTEXT, u32le(shd.length), shd, bytes.subarray(header.zipOffset));
  const proofs = [...header.rsa.map((p) => ["RSA", p]), ...header.ecdsa.map((p) => ["ECDSA", p])];
  let idProof = false;
  for (const [kind, { publicKey, signature }] of proofs) {
    if (!publicKey || !signature) throw fail(`an ${kind} proof lacks its key or signature`);
    const keyId = await extensionIdFromSpki(publicKey);
    let key;
    try {
      key = await crypto.subtle.importKey("spki", publicKey, kind === "RSA" ? RSA : ECDSA_KEY, false, ["verify"]);
    } catch (e) {
      throw fail(`the key of ${kind} proof ${keyId} is not an ${kind === "RSA" ? "RSA" : "ECDSA P-256"} public key (${e.message})`);
    }
    const sig = kind === "RSA" ? signature : ecdsaDerToRaw(signature);
    if (!sig) throw fail(`the ECDSA signature of key ${keyId} is not canonical DER: ${base16(signature.subarray(0, 80))}`);
    const ok = await crypto.subtle.verify(kind === "RSA" ? RSA : ECDSA_SIG, key, sig, payload);
    if (!ok) throw fail(`the ${kind} signature of key ${keyId} does not verify; the file is damaged or was altered`);
    if (keyId === id) idProof = true;
  }
  if (!idProof) throw fail(`no proof's key derives the declared extension ID ${id}`);
  return id;
}

const base16 = (bytes) => Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");

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
