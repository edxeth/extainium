// Usage: node scripts/pack-crx.js <in.zip> <key.pem> <out.crx>
// Signs the zip with the RSA key in key.pem, generating the key (mode 600) if missing.
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import nodeCrypto from "node:crypto";
import { extensionIdFromCrx, packCrx3 } from "../src/lib/crx.js";

const [zipPath, keyPath, outPath] = process.argv.slice(2);
if (!outPath) throw new Error("usage: node scripts/pack-crx.js <in.zip> <key.pem> <out.crx>");

if (!existsSync(keyPath)) {
  mkdirSync(dirname(keyPath), { recursive: true, mode: 0o700 });
  const { privateKey } = nodeCrypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
  writeFileSync(keyPath, privateKey.export({ type: "pkcs8", format: "pem" }), { mode: 0o600 });
  chmodSync(keyPath, 0o600);
  console.log(`generated signing key ${keyPath}`);
}

const key = nodeCrypto.createPrivateKey(readFileSync(keyPath));
const crx = await packCrx3(new Uint8Array(readFileSync(zipPath)), new Uint8Array(key.export({ type: "pkcs8", format: "der" })));
writeFileSync(outPath, crx);
console.log(`${outPath}: extension ID ${await extensionIdFromCrx(crx)}`);
