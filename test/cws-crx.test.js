// Google's publisher proof on a real CWS CRX (contract: a CWS install requires
// Chromium's kPublisherKeyHash proof and the record's ID). Oracle: the CRX3
// header read here independently and its signatures verified with node:crypto,
// against the key hash copied from Chromium's crx_verifier.cc.

import { test } from "node:test";
import assert from "node:assert/strict";
import nodeCrypto from "node:crypto";
import { PUBLISHER_KEY_HASH, verifyCrx } from "../src/lib/crx.js";
import { JUST_BLACK, fixtureBytes } from "./helpers/fake-update.js";

// components/crx_file/crx_verifier.cc at tag 158.0.8127.100: kPublisherKeyHash,
// "The SHA256 hash of the DER SPKI "ecdsa_2017_public" Crx3 key".
const CHROMIUM_PUBLISHER_KEY_HASH = Buffer.from([
  0x61, 0xf7, 0xf2, 0xa6, 0xbf, 0xcf, 0x74, 0xcd, 0x0b, 0xc1, 0xfe,
  0x24, 0x97, 0xcc, 0x9b, 0x04, 0x25, 0x4c, 0x65, 0x8f, 0x79, 0xf2,
  0x14, 0x53, 0x92, 0x86, 0x7e, 0xa8, 0x36, 0x63, 0x67, 0xcf]).toString("hex");

const crx = Buffer.from(fixtureBytes("cws-just-black-3.crx"));

// Protobuf length-delimited fields of buf: [{ field, data }] (other wire types skipped).
function fields(buf) {
  const out = [];
  let p = 0;
  const varint = () => {
    let n = 0;
    for (let mul = 1; ; mul *= 128) {
      const b = buf[p++];
      n += (b & 0x7f) * mul;
      if (b < 0x80) return n;
    }
  };
  while (p < buf.length) {
    const tag = varint();
    const wire = tag & 7;
    if (wire === 2) {
      const len = varint();
      out.push({ field: Math.floor(tag / 8), data: buf.subarray(p, p + len) });
      p += len;
    } else if (wire === 0) varint();
    else throw new Error("unexpected wire type " + wire);
  }
  return out;
}
const varintBytes = (n) => {
  const out = [];
  for (; n > 0x7f; n = Math.floor(n / 128)) out.push((n & 0x7f) | 0x80);
  out.push(n);
  return Buffer.from(out);
};
const field = (num, data) => Buffer.concat([varintBytes(num * 8 + 2), varintBytes(data.length), data]);
const sha256 = (b) => nodeCrypto.createHash("sha256").update(b).digest();
const idOfKey = (spki) => [...sha256(spki).subarray(0, 16).toString("hex")].map((c) => String.fromCharCode(97 + parseInt(c, 16))).join("");

function readCrx(bytes) {
  assert.equal(bytes.subarray(0, 4).toString("latin1"), "Cr24");
  assert.equal(bytes.readUInt32LE(4), 3);
  const headerLength = bytes.readUInt32LE(8);
  const header = fields(bytes.subarray(12, 12 + headerLength));
  const zip = bytes.subarray(12 + headerLength);
  const signed = header.find((f) => f.field === 10000).data;
  const payload = Buffer.concat([Buffer.from("CRX3 SignedData\0", "latin1"), Buffer.from(new Uint32Array([signed.length]).buffer), signed, zip]);
  const proofs = header.filter((f) => f.field === 2 || f.field === 3).map((f) => {
    const [key, sig] = [1, 2].map((n) => fields(f.data).find((x) => x.field === n).data);
    return { type: f.field === 2 ? "rsa" : "ecdsa", key, sig };
  });
  return { header, zip, signed, payload, proofs };
}
// Re-encodes a CRX3 from header fields (kept in order) and the archive.
const writeCrx = (header, zip) => {
  const h = Buffer.concat(header.map((f) => field(f.field, f.data)));
  const u32 = (n) => Buffer.from(new Uint32Array([n]).buffer);
  return Buffer.concat([Buffer.from("Cr24", "latin1"), u32(3), u32(h.length), h, zip]);
};
const isPublisher = (p) => sha256(p.key).toString("hex") === CHROMIUM_PUBLISHER_KEY_HASH;

test("the publisher key hash is Chromium's kPublisherKeyHash", () => {
  assert.equal(PUBLISHER_KEY_HASH, CHROMIUM_PUBLISHER_KEY_HASH);
});

test("the real CWS CRX carries a publisher proof that node:crypto verifies, and verifyCrx requiring it returns the store's ID", async () => {
  const { proofs, payload } = readCrx(crx);
  const publisher = proofs.filter(isPublisher);
  assert.equal(publisher.length, 1);
  assert.equal(publisher[0].type, "ecdsa");
  const verified = nodeCrypto.verify("sha256", payload, { key: publisher[0].key, format: "der", type: "spki", dsaEncoding: "der" }, publisher[0].sig);
  assert.ok(verified, "Google's publisher signature verifies (oracle)");
  // The ID the update server announced (appid) is the hash of one proof key.
  assert.ok(proofs.some((p) => idOfKey(p.key) === JUST_BLACK));
  assert.equal(await verifyCrx(new Uint8Array(crx), "Just Black", { publisherProof: true }), JUST_BLACK);
});

test("a validly self-signed CRX passes verifyCrx but not with the publisher proof required", async () => {
  const own = fixtureBytes("signed-ecdsa.crx");
  assert.equal(await verifyCrx(own, "own.crx"), "eodjecdgbiigklkiljonabmikhmlcjhk");
  await assert.rejects(verifyCrx(own, "own.crx", { publisherProof: true }),
    /^Error: verify own.crx: it has no Chrome Web Store publisher proof: no proof is signed with Google's publisher key$/);
});

test("the real CWS CRX without its publisher proof still verifies, but fails when the proof is required", async () => {
  const { header, zip } = readCrx(crx);
  const stripped = writeCrx(header.filter((f) => !(f.field === 3 && isPublisher({ key: fields(f.data).find((x) => x.field === 1).data }))), zip);
  assert.equal(readCrx(stripped).proofs.filter(isPublisher).length, 0);
  assert.equal(await verifyCrx(new Uint8Array(stripped), "stripped"), JUST_BLACK);
  await assert.rejects(verifyCrx(new Uint8Array(stripped), "stripped", { publisherProof: true }), /no Chrome Web Store publisher proof/);
});

test("a publisher proof whose signature was altered fails verification", async () => {
  const { header, zip } = readCrx(crx);
  const altered = header.map((f) => {
    if (f.field !== 3) return f;
    const [k, s] = [1, 2].map((n) => fields(f.data).find((x) => x.field === n).data);
    if (!isPublisher({ key: k })) return f;
    const sig = Buffer.from(s);
    sig[sig.length - 1] ^= 1;
    return { field: 3, data: Buffer.concat([field(1, k), field(2, sig)]) };
  });
  const bytes = writeCrx(altered, zip);
  const pub = readCrx(bytes).proofs.find(isPublisher);
  assert.equal(nodeCrypto.verify("sha256", readCrx(bytes).payload, { key: pub.key, format: "der", type: "spki", dsaEncoding: "der" }, pub.sig), false);
  await assert.rejects(verifyCrx(new Uint8Array(bytes), "altered", { publisherProof: true }), /ECDSA signature of key \w+ does not verify|not canonical DER/);
});
