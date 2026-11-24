// Builds the signed CRX3 fixtures with node:crypto only, independently of
// src/lib/crx.js, following Chromium's components/crx_file/crx3.proto:
//   "Cr24" | u32le 3 | u32le header size | CrxFileHeader | zip
//   CrxFileHeader: 2 = sha256_with_rsa, 3 = sha256_with_ecdsa (AsymmetricKeyProof
//   { 1 = public_key, 2 = signature }), 10000 = signed_header_data (SignedData { 1 = crx_id })
//   signature over "CRX3 SignedData\0" | u32le size of SignedData | SignedData | zip
// Usage: node test/fixtures/make-crx-fixtures.js (writes next to this file).
// Keys are generated anew on each run, so the files change; crx-fixtures.json
// records each file's extension ID, derived here from its key.
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";

const dir = new URL("./", import.meta.url);
const zip = readFileSync(new URL("ext-root.zip", dir));

const varint = (n) => {
  const out = [];
  for (; n > 0x7f; n >>>= 7) out.push((n & 0x7f) | 0x80);
  out.push(n);
  return Buffer.from(out);
};
const field = (num, data) => Buffer.concat([varint(num * 8 + 2), varint(data.length), data]);
const u32 = (n) => {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(n);
  return b;
};
const spki = (key) => key.publicKey.export({ type: "spki", format: "der" });
const crxIdOf = (key) => createHash("sha256").update(spki(key)).digest().subarray(0, 16);
const idOf = (key) => [...crxIdOf(key).toString("hex")].map((c) => String.fromCharCode(97 + parseInt(c, 16))).join("");

// proofs: [{ type: 2 | 3, key (its public key goes in the proof), signer (signs) }]
function crx(idKey, proofs, archive = zip) {
  const signedData = field(1, crxIdOf(idKey));
  const payload = Buffer.concat([Buffer.from("CRX3 SignedData\0", "latin1"), u32(signedData.length), signedData, archive]);
  const header = Buffer.concat([
    ...proofs.map((p) => field(p.type, Buffer.concat([field(1, spki(p.key)), field(2, sign("sha256", payload, p.signer.privateKey))]))),
    field(10000, signedData),
  ]);
  return Buffer.concat([Buffer.from("Cr24", "latin1"), u32(3), u32(header.length), header, archive]);
}

const rsa = () => generateKeyPairSync("rsa", { modulusLength: 2048 });
const a = rsa();
const b = rsa();
const ec = generateKeyPairSync("ec", { namedCurve: "prime256v1" }); // DER (ECDSA-Sig-Value) signatures

const files = {
  // One valid RSA proof of the ID key.
  "signed-rsa.crx": [a, crx(a, [{ type: 2, key: a, signer: a }])],
  // One valid ECDSA P-256 proof of the ID key.
  "signed-ecdsa.crx": [ec, crx(ec, [{ type: 3, key: ec, signer: ec }])],
  // The ID key's proof carries a signature made with another key.
  "signed-wrong-key.crx": [a, crx(a, [{ type: 2, key: a, signer: b }])],
  // A valid ID proof plus a second RSA proof whose signature is not its key's.
  "signed-extra-bad-proof.crx": [a, crx(a, [{ type: 2, key: a, signer: a }, { type: 2, key: b, signer: a }])],
  // A valid proof of key b only; the declared crx_id is key a's.
  "signed-no-id-proof.crx": [a, crx(a, [{ type: 2, key: b, signer: b }])],
};
const ids = {};
for (const [name, [idKey, bytes]] of Object.entries(files)) {
  writeFileSync(new URL(name, dir), bytes);
  ids[name] = idOf(idKey);
}
writeFileSync(new URL("crx-fixtures.json", dir), JSON.stringify(ids, null, 2) + "\n");
console.log(ids);
