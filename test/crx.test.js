import { test } from "node:test";
import assert from "node:assert/strict";
import nodeCrypto from "node:crypto";
import { readFileSync } from "node:fs";
import fc from "fast-check";
import {
  encodeCrx, extensionIdFromCrx, extensionIdFromSpki, generateSigningKey,
  importSigningKey, packCrx3, parseCrx, zipFromCrx,
} from "../src/lib/crx.js";

// Independent reference: Chromium's ID is hex(sha256(spki)[0..16]) with 0-f -> a-p.
function referenceId(spkiDer) {
  const hex = nodeCrypto.createHash("sha256").update(spkiDer).digest("hex").slice(0, 32);
  return [...hex].map((c) => String.fromCharCode(97 + parseInt(c, 16))).join("");
}

const pem = nodeCrypto.generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey;
const pkcs8 = new Uint8Array(pem.export({ type: "pkcs8", format: "der" }));
const spkiDer = nodeCrypto.createPublicKey(pem).export({ type: "spki", format: "der" });

test("uBlock Origin's GitHub CRX header yields its known ID fkgkibajhfbepljeaefdnfnegdcjomkh", async () => {
  const header = new Uint8Array(readFileSync(new URL("./fixtures/ublock-1.77.0-crx-header.bin", import.meta.url)));
  assert.equal(await extensionIdFromCrx(header), "fkgkibajhfbepljeaefdnfnegdcjomkh");
});

test("extension ID from SPKI matches the reference derivation", async () => {
  assert.equal(await extensionIdFromSpki(new Uint8Array(spkiDer)), referenceId(spkiDer));
});

test("packCrx3 output follows the CRX3 spec: signature verifies with node:crypto, ID matches the key", async () => {
  const zip = new TextEncoder().encode("PK fake zip payload \u00e9");
  const crx = await packCrx3(zip, pkcs8);
  const buf = Buffer.from(crx);
  assert.equal(buf.subarray(0, 4).toString("latin1"), "Cr24");
  assert.equal(buf.readUInt32LE(4), 3);
  const header = parseCrx(crx);
  assert.equal(header.rsa.length, 1);
  assert.deepEqual(Buffer.from(header.rsa[0].publicKey), spkiDer);
  // Signed payload per crx3.proto: context, u32le size of SignedData, SignedData, archive.
  const crxId = nodeCrypto.createHash("sha256").update(spkiDer).digest().subarray(0, 16);
  const signedData = Buffer.concat([Buffer.from([0x0a, 0x10]), crxId]);
  const size = Buffer.alloc(4);
  size.writeUInt32LE(signedData.length);
  const payload = Buffer.concat([Buffer.from("CRX3 SignedData\0", "latin1"), size, signedData, Buffer.from(zip)]);
  assert.ok(nodeCrypto.verify("sha256", payload, nodeCrypto.createPublicKey(pem), Buffer.from(header.rsa[0].signature)));
  assert.equal(await extensionIdFromCrx(crx), referenceId(spkiDer));
  assert.deepEqual(zipFromCrx(crx), zip);
});

test("a generated signing key survives PKCS#8 export/import with the same public key", async () => {
  const key = await generateSigningKey();
  const imported = await importSigningKey(key.pkcs8);
  assert.deepEqual(imported.spki, key.spki);
});

// F7: Chromium's crx_verifier accepts the developer key from an RSA or an ECDSA proof.
test("an ECDSA-only CRX3, signed independently with node:crypto, yields the ID of its P-256 key", async () => {
  const ec = nodeCrypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const ecSpki = ec.publicKey.export({ type: "spki", format: "der" });
  const crxId = nodeCrypto.createHash("sha256").update(ecSpki).digest().subarray(0, 16);
  const zip = new Uint8Array(readFileSync(new URL("./fixtures/ext-root.zip", import.meta.url)));
  const signedData = Buffer.concat([Buffer.from([0x0a, 0x10]), crxId]);
  const size = Buffer.alloc(4);
  size.writeUInt32LE(signedData.length);
  const payload = Buffer.concat([Buffer.from("CRX3 SignedData\0", "latin1"), size, signedData, zip]);
  const signature = nodeCrypto.sign("sha256", payload, ec.privateKey);
  assert.ok(nodeCrypto.verify("sha256", payload, ec.publicKey, signature));
  const crx = encodeCrx({ ecdsa: [{ publicKey: new Uint8Array(ecSpki), signature: new Uint8Array(signature) }], crxId: new Uint8Array(crxId) }, zip);
  assert.equal(await extensionIdFromCrx(crx), referenceId(ecSpki));
});

test("extensionIdFromCrx rejects a header whose crx_id no key hashes to", async () => {
  const crx = encodeCrx({ rsa: [{ publicKey: new Uint8Array(spkiDer), signature: new Uint8Array(4) }], crxId: new Uint8Array(16) }, new Uint8Array());
  await assert.rejects(extensionIdFromCrx(crx), /no key in header hashes to crx_id aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/);
});

test("parseCrx rejects non-CRX bytes and a header longer than the file", () => {
  assert.throws(() => parseCrx(new TextEncoder().encode("PK\x03\x04....")), /missing Cr24 magic/);
  const crx = encodeCrx({ crxId: new Uint8Array(16) }, new Uint8Array());
  assert.throws(() => parseCrx(crx.subarray(0, crx.length - 1)), /exceeds/);
});

// Round-trip: parseCrx reads back every proof, the crx_id and the archive offset that encodeCrx wrote.
test("property: parseCrx inverts encodeCrx", () => {
  const bytes = (max) => fc.uint8Array({ maxLength: max });
  const proof = fc.record({ publicKey: bytes(300), signature: bytes(300) });
  fc.assert(
    fc.property(
      fc.array(proof, { maxLength: 3 }),
      fc.array(proof, { maxLength: 2 }),
      fc.uint8Array({ minLength: 16, maxLength: 16 }),
      bytes(200),
      (rsa, ecdsa, crxId, zip) => {
        const crx = encodeCrx({ rsa, ecdsa, crxId }, zip);
        const h = parseCrx(crx);
        const plain = (proofs) => proofs.map((p) => ({ ...p })); // fc.record objects have no prototype
        assert.deepEqual(h.rsa, plain(rsa));
        assert.deepEqual(h.ecdsa, plain(ecdsa));
        assert.deepEqual(h.crxId, crxId);
        assert.deepEqual(crx.subarray(h.zipOffset), zip);
      }
    )
  );
});
