// Release files for self-hosted updates (build.sh).
//   node scripts/release-files.js manifest <manifest.json>
//     inserts "update_url": $EXTAINIUM_UPDATE_URL when that is set; else leaves the file alone.
//   node scripts/release-files.js updates <extension.crx> <manifest.json> <updates.xml>
//     writes the gupdate update manifest for $EXTAINIUM_CODEBASE (the CRX's URL)
//     when that is set: appid from the CRX's key, version from the manifest.
// Format: https://developer.chrome.com/docs/extensions/how-to/distribute/host-on-linux#update_manifest
import { readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { verifyCrx } from "../src/lib/crx.js";

function checkUrl(what, url) {
  let u;
  try {
    u = new URL(url);
  } catch {
    throw new Error(`${what}: not an absolute URL: ${JSON.stringify(url)}`);
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") throw new Error(`${what}: not an http(s) URL: ${JSON.stringify(url)}`);
  return url;
}

const xmlEscape = (s) => String(s).replace(/[&<>'"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&apos;", '"': "&quot;" })[c]);

export function withUpdateUrl(manifest, updateUrl) {
  return { ...manifest, update_url: checkUrl("update_url", updateUrl) };
}

export function updatesXml({ appid, version, codebase }) {
  if (!/^[a-p]{32}$/.test(appid)) throw new Error(`updates.xml: appid is not an extension ID: ${JSON.stringify(appid)}`);
  if (!/^\d+(\.\d+){0,3}$/.test(version)) throw new Error(`updates.xml: not an extension version: ${JSON.stringify(version)}`);
  checkUrl("updates.xml codebase", codebase);
  return [
    "<?xml version='1.0' encoding='UTF-8'?>",
    "<gupdate xmlns='http://www.google.com/update2/response' protocol='2.0'>",
    `  <app appid='${appid}'>`,
    `    <updatecheck codebase='${xmlEscape(codebase)}' version='${version}' />`,
    "  </app>",
    "</gupdate>",
    "",
  ].join("\n");
}

async function main([mode, ...args]) {
  const env = process.env;
  if (mode === "manifest" && args.length === 1) {
    if (!env.EXTAINIUM_UPDATE_URL) return;
    const manifest = JSON.parse(readFileSync(args[0], "utf8"));
    writeFileSync(args[0], JSON.stringify(withUpdateUrl(manifest, env.EXTAINIUM_UPDATE_URL), null, 2) + "\n");
    console.log(`${args[0]}: update_url ${env.EXTAINIUM_UPDATE_URL}`);
  } else if (mode === "updates" && args.length === 3) {
    const [crxPath, manifestPath, out] = args;
    if (!env.EXTAINIUM_CODEBASE) {
      console.log(`${out}: not written (EXTAINIUM_CODEBASE is not set)`);
      return;
    }
    const appid = await verifyCrx(new Uint8Array(readFileSync(crxPath)), crxPath);
    const { version } = JSON.parse(readFileSync(manifestPath, "utf8"));
    writeFileSync(out, updatesXml({ appid, version, codebase: env.EXTAINIUM_CODEBASE }));
    console.log(`${out}: ${appid} ${version} at ${env.EXTAINIUM_CODEBASE}`);
  } else {
    throw new Error("usage: release-files.js manifest <manifest.json> | updates <extension.crx> <manifest.json> <updates.xml>");
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) await main(process.argv.slice(2));
