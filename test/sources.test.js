// CWS and update-URL sources in the manager (contract: extainium-sources-contract.md,
// sections Sources, Permissions, Lib API, Background, Backup). The update
// servers answer with the real saved answers (test/fixtures/SOURCES.md); the
// CWS install uses the real Just Black CRX, whose size and hash the real
// answer announces.

import { test } from "node:test";
import assert from "node:assert/strict";
import nodeCrypto from "node:crypto";
import { readFileSync } from "node:fs";
import { extensionIdFromSpki, packCrx3 } from "../src/lib/crx.js";
import * as manager from "../src/lib/manager.js";
import { newRecord, newSourceRecord } from "../src/lib/store.js";
import { CWS_ORIGINS } from "../src/lib/sources.js";
import { updatesXml } from "../scripts/release-files.js";
import { fakeChrome, fakeGithub } from "./helpers/fake-chrome.js";
import {
  DARK_READER, JUST_BLACK, JUST_BLACK_CODEBASE, REAL_APPS, fixtureBytes, fixtureText, fakeUpdateServers,
} from "./helpers/fake-update.js";

const {
  addRepo, checkAll, checkRepo, dismissInstallBlocked, environment, exportBackup, importBackup, installFile, installRelease,
  installedOverview, linkInstalledToGithub, removeRepo, setTemplate, trackInstalled, trackedView,
} = manager;

const JB_KEY = `cws:${JUST_BLACK}`;
const JB_HASH = "97146df4dd16804575c8599cea9e7f49412f4e369f64c631e38c09bf111c7bb3"; // hash_sha256 of the real answer
const MV2_UBO = "cjpalhdlnbpafiamejdnhcphjbkeiagm";
const SUSPENDER = "klbibkeccnjlkjkiokjodocebajanakg";
const UBO = "fkgkibajhfbepljeaefdnfnegdcjomkh";
const UBO_UPDATE_URL = "https://cdn.jsdelivr.net/gh/gorhill/uBlock@master/dist/chromium/update.xml";
const CWS_URL = "https://clients2.google.com/service/update2/crx";
const RSA_CRX = fixtureBytes("signed-rsa.crx"); // node:crypto-signed, manifest version 1.0
const RSA_ID = JSON.parse(fixtureText("crx-fixtures.json"))["signed-rsa.crx"];
const ECDSA_CRX = fixtureBytes("signed-ecdsa.crx");
const ECDSA_ID = JSON.parse(fixtureText("crx-fixtures.json"))["signed-ecdsa.crx"];
const zip = new Uint8Array(readFileSync(new URL("./fixtures/ext-root.zip", import.meta.url))); // manifest version 1.0
const hex = (b) => nodeCrypto.createHash("sha256").update(b).digest("hex");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const OP = "extainium-op";
// The cleanup retry after a confirmed install and the refusal check wait for these.
Object.assign(manager.cleanupTiming, { retryMs: 5, settleMs: 1 });

// A browser profile at the current schema; CWS hosts granted unless grant is false.
function profile({ extensions = [], grant = true, platform = "android" } = {}) {
  const env = fakeChrome({ extensions });
  env.store.schema = 2;
  env.setPlatform(platform);
  if (grant) for (const o of CWS_ORIGINS) env.granted.add(o);
  return env;
}
const cwsExt = (id, version, name = "Ext") => ({ id, version, name, enabled: true, installType: "normal", updateUrl: CWS_URL });
const browserInstalls = (env, id, version, name = "Example") => {
  env.install(id, version, name);
  return manager.handleExtensionInstalled({ id, version, name, enabled: true });
};
// A synthetic app element in the real answer's form.
const appXml = (id, { version = "1.0", codebase = `https://clients2.googleusercontent.com/crx/blobs/X/${id.toUpperCase()}.crx`, hash = "0".repeat(64), size = 1 } = {}) =>
  `<app appid="${id}" cohort="1::" cohortname="" status="ok"><updatecheck _esbAllowlist="true" codebase="${codebase}" fp="1.${hash}" hash_sha256="${hash}" protected="0" size="${size}" status="ok" version="${version}"/></app>`;

// ---- CWS: add, check, view ----

// Contract: check = GET update2/crx?response=updatecheck&acceptformat=crx3&prodversion=<browser>&x=id=..&v=..&uc.
test("adding a CWS link checks the store anonymously and the view shows the announced build", async () => {
  const env = profile();
  fakeGithub([]);
  const servers = fakeUpdateServers({ cws: { [JUST_BLACK]: REAL_APPS.get(JUST_BLACK) } });
  const key = await addRepo(`https://chromewebstore.google.com/detail/just-black/${JUST_BLACK}?hl=de`);
  assert.equal(key, JB_KEY);
  assert.equal(servers.cwsRequests.length, 1);
  const [req] = servers.cwsRequests;
  assert.deepEqual(req.params, { response: "updatecheck", acceptformat: "crx3", prodversion: "158.0.8127.100" });
  assert.deepEqual(req.xs, [{ id: JUST_BLACK, v: "0.0.0.0", uc: "" }]);
  assert.equal(req.credentials, "omit");
  const [view] = await trackedView();
  assert.equal(view.key, JB_KEY);
  assert.equal(view.source, "cws");
  assert.equal(view.record.extensionId, JUST_BLACK);
  assert.equal(view.title, JUST_BLACK, "not installed and no name known yet: the ID");
  assert.equal(view.sourceLabel, "Chrome Web Store");
  assert.equal(view.sourceUrl, `https://chromewebstore.google.com/detail/${JUST_BLACK}`);
  assert.deepEqual(view.needsOrigins, []);
  assert.deepEqual(view.latest, { version: "3", codebase: JUST_BLACK_CODEBASE, size: 6593, hash: JB_HASH });
  assert.equal(view.state, "not-installed");
  assert.equal(view.pendingInstall, null);
  assert.equal(view.hasKey, false);
});

// Contract: CWS install = download codebase, check size and hash_sha256, verifyCrx with publisher proof, ID = record ID, hand-off.
test("installing a CWS record hands off the announced CRX after its checks; onInstalled commits it", async () => {
  const env = profile();
  fakeGithub([]);
  const crx = fixtureBytes("cws-just-black-3.crx");
  fakeUpdateServers({ cws: { [JUST_BLACK]: REAL_APPS.get(JUST_BLACK) }, files: { [JUST_BLACK_CODEBASE]: crx } });
  await addRepo(JUST_BLACK);
  const progress = [];
  const result = await installRelease(JB_KEY, undefined, (t) => progress.push(t));
  assert.deepEqual(result, { extensionId: JUST_BLACK, version: "3", name: "Just Black" });
  assert.ok(progress.length >= 2);
  assert.deepEqual(env.handedOff, [crx]);
  let [view] = await trackedView();
  assert.equal(view.pendingInstall.version, "3");
  assert.equal(view.title, "Just Black", "the name from the CRX manifest");
  await browserInstalls(env, JUST_BLACK, "3", "Just Black");
  [view] = await trackedView();
  assert.deepEqual(view.record.installed, { tag: null, digest: "sha256:" + JB_HASH, version: "3" });
  assert.equal(view.state, "current");
  assert.equal(view.pendingInstall, null);
});

test("a CWS download that differs from the announcement, lacks the publisher proof or is another extension is not handed off", async () => {
  const crx = fixtureBytes("cws-just-black-3.crx");
  const tampered = crx.slice();
  tampered[tampered.length - 100] ^= 1;
  const cases = [
    ["one byte changed", { [JUST_BLACK]: REAL_APPS.get(JUST_BLACK) }, { [JUST_BLACK_CODEBASE]: tampered }, JUST_BLACK,
      new RegExp(`^install ${JB_KEY}: the download's sha256 [0-9a-f]{64} does not match the announced ${JB_HASH}$`)],
    ["one byte short", { [JUST_BLACK]: REAL_APPS.get(JUST_BLACK) }, { [JUST_BLACK_CODEBASE]: crx.slice(0, -1) }, JUST_BLACK,
      new RegExp(`^install ${JB_KEY}: downloaded 6592 bytes, the update server announced 6593$`)],
    ["self-signed", { [RSA_ID]: appXml(RSA_ID, { hash: hex(RSA_CRX), size: RSA_CRX.length }) },
      { [`https://clients2.googleusercontent.com/crx/blobs/X/${RSA_ID.toUpperCase()}.crx`]: RSA_CRX }, RSA_ID,
      /no Chrome Web Store publisher proof/],
    ["another extension's CRX", { [DARK_READER]: appXml(DARK_READER, { version: "3", codebase: JUST_BLACK_CODEBASE, hash: JB_HASH, size: 6593 }) },
      { [JUST_BLACK_CODEBASE]: crx }, DARK_READER,
      new RegExp(`^install cws:${DARK_READER}: the CRX installs as extension ${JUST_BLACK}, not as ${DARK_READER}$`)],
    ["another version than announced", { [JUST_BLACK]: appXml(JUST_BLACK, { version: "4", codebase: JUST_BLACK_CODEBASE, hash: JB_HASH, size: 6593 }) },
      { [JUST_BLACK_CODEBASE]: crx }, JUST_BLACK,
      new RegExp(`^install ${JB_KEY}: the CRX holds version "3", the update server announced 4$`)],
  ];
  for (const [name, cws, files, id, error] of cases) {
    const env = profile();
    fakeGithub([]);
    fakeUpdateServers({ cws, files });
    await addRepo(id);
    await assert.rejects(installRelease(`cws:${id}`), (e) => error.test(e.message), name);
    assert.equal(env.handedOff.length, 0, name);
  }
});

// Contract: noupdate with v=0.0.0.0 = not offered to this browser; never claimed removed.
test("a store answer of noupdate shows the extension as not offered, keeps the malware hint and installs nothing", async () => {
  const env = profile({ extensions: [cwsExt(MV2_UBO, "1.62.0", "uBlock Origin"), cwsExt(SUSPENDER, "7.1.8")] });
  fakeGithub([]);
  fakeUpdateServers({ cws: Object.fromEntries([MV2_UBO, SUSPENDER].map((id) => [id, REAL_APPS.get(id)])) });
  await trackInstalled(MV2_UBO);
  await trackInstalled(SUSPENDER);
  const views = await trackedView();
  assert.deepEqual(views.map((v) => [v.key, v.state, v.latest, v.record.unavailable]), [
    [`cws:${MV2_UBO}`, "not-offered", null, { malware: false }],
    [`cws:${SUSPENDER}`, "not-offered", null, { malware: true }],
  ]);
  assert.equal(views[0].title, "uBlock Origin");
  assert.deepEqual(views.map((v) => v.canInstall), [false, false]);
  await assert.rejects(installRelease(`cws:${MV2_UBO}`), /^Error: install cws:\w+: the Chrome Web Store offers no build of this extension to this browser$/);
  assert.equal(env.handedOff.length, 0);
});

test("adding an ID the store does not know fails with the store's status and keeps nothing", async () => {
  const env = profile();
  fakeGithub([]);
  fakeUpdateServers({ cws: { ["a".repeat(32)]: REAL_APPS.get("a".repeat(32)) } });
  await assert.rejects(addRepo("a".repeat(32)), /^Error: check cws:a{32}: the Chrome Web Store does not know this extension \(error-unknownApplication\)$/);
  assert.deepEqual(Object.keys(env.store).filter((k) => k.startsWith("repo:")), []);
});

// Contract: batches split so each URL stays under 7000 bytes.
test("checkAll checks 200 CWS records in batches under 7000 characters, each ID once", async () => {
  const env = profile();
  fakeGithub([]);
  const ids = Array.from({ length: 200 }, (_, i) => hex(String(i)).slice(0, 32).replace(/[0-9a-f]/g, (c) => "abcdefghijklmnop"[parseInt(c, 16)]));
  for (const id of ids) env.store[`repo:cws:${id}`] = newSourceRecord("cws", id);
  const servers = fakeUpdateServers({ cws: Object.fromEntries(ids.map((id) => [id, appXml(id, { version: "2.0" })])) });
  const { errors } = await checkAll();
  assert.deepEqual(errors, []);
  assert.ok(servers.cwsRequests.length > 1);
  for (const r of servers.cwsRequests) assert.ok(r.url.length <= 7000, String(r.url.length));
  assert.deepEqual(servers.cwsRequests.flatMap((r) => r.ids).sort(), [...ids].sort());
  assert.ok((await trackedView()).every((v) => v.latest.version === "2.0"));
});

test("a failed store request gives each record of it an error naming the record and the status; GitHub records are still checked", async () => {
  const env = profile();
  fakeGithub([{ tag: "v1", assets: [] }]);
  env.store["repo:o/r"] = newRecord("o", "r");
  env.store[`repo:${JB_KEY}`] = newSourceRecord("cws", JUST_BLACK);
  fakeUpdateServers({ status: 503 });
  const { errors } = await checkAll();
  assert.deepEqual(errors, [`check ${JB_KEY}: HTTP 503 from clients2.google.com`]);
  assert.equal(env.store[`repo:${JB_KEY}`].error, errors[0]);
  assert.ok(env.store["repo:o/r"].releases, "the GitHub record was checked");
});

test("a store answer that lists an extension not asked for is refused", async () => {
  profile();
  fakeGithub([]);
  fakeUpdateServers({ cws: { [JUST_BLACK]: REAL_APPS.get(DARK_READER) } });
  await assert.rejects(addRepo(JUST_BLACK), new RegExp(`^Error: check ${JB_KEY}: the update server's answer lists extension "${DARK_READER}", which was not asked for$`));
});

// Contract: new hosts are optional; the view lists the origins a record still needs.
test("without the CWS host permission nothing is fetched, the error names the origin and the view lists the origins", async () => {
  const env = profile({ grant: false });
  fakeGithub([]);
  const servers = fakeUpdateServers({ cws: { [JUST_BLACK]: REAL_APPS.get(JUST_BLACK) } });
  await assert.rejects(addRepo(JUST_BLACK), /^Error: check cws:\w+: no host permission for https:\/\/clients2\.google\.com\/\*$/);
  assert.equal(servers.cwsRequests.length, 0);
  env.store[`repo:${JB_KEY}`] = newSourceRecord("cws", JUST_BLACK);
  assert.deepEqual((await trackedView())[0].needsOrigins, CWS_ORIGINS);
  env.granted.add("https://*/*");
  assert.deepEqual((await trackedView())[0].needsOrigins, []);
});

test("adding a CWS ID that a GitHub record already follows is refused", async () => {
  const env = profile();
  fakeGithub([]);
  env.store["repo:o/r"] = { ...newRecord("o", "r"), extensionId: JUST_BLACK };
  await assert.rejects(addRepo(JUST_BLACK), new RegExp(`^Error: add repo: extension ${JUST_BLACK} is already tracked as o/r$`));
});

// ---- self-hosted update URLs ----

const uboExt = (version = "1.76.0") => ({ id: UBO, version, name: "uBlock Origin", enabled: true, installType: "normal", updateUrl: UBO_UPDATE_URL });

// Contract: GET <update_url>?x=id%3D<id>%26v%3D<version>%26uc; its host as an optional permission.
test("tracking a self-hosted extension needs its host, then reads its update.xml (the real uBlock one) with its installed version", async () => {
  const env = profile({ extensions: [uboExt()] });
  fakeGithub([]);
  const servers = fakeUpdateServers({ files: { [UBO_UPDATE_URL]: fixtureText("ublock-jsdelivr-update.xml") } });
  let [row] = await installedOverview();
  assert.deepEqual({ kind: row.kind, canTrack: row.canTrack, needsOrigins: row.needsOrigins, updateHost: row.updateHost, trackedKey: row.trackedKey },
    { kind: "selfUpdating", canTrack: "updateUrl", needsOrigins: ["https://cdn.jsdelivr.net/*"], updateHost: "cdn.jsdelivr.net", trackedKey: null });
  await assert.rejects(trackInstalled(UBO), /^Error: check url:\w+: no host permission for https:\/\/cdn\.jsdelivr\.net\/\*$/);
  // Review F2 (owner decision): a missing permission does not delete the new
  // record; it keeps the error and the view asks for the origin.
  assert.deepEqual(Object.keys(env.store).filter((k) => k.startsWith("repo:")), [`repo:url:${UBO}`]);
  assert.deepEqual((await trackedView())[0].needsOrigins, ["https://cdn.jsdelivr.net/*"]);
  assert.deepEqual(servers.requests, [], "nothing fetched without the permission");
  env.granted.add("https://cdn.jsdelivr.net/*");
  await checkRepo(`url:${UBO}`).then(manager.refreshBadge); // as the card's check does
  assert.deepEqual(servers.requests, [`${UBO_UPDATE_URL}?x=id%3D${UBO}%26v%3D1.76.0%26uc`]);
  const [view] = await trackedView();
  assert.equal(view.source, "updateUrl");
  assert.equal(view.record.extensionId, UBO);
  assert.equal(view.title, "uBlock Origin");
  assert.equal(view.sourceLabel, "cdn.jsdelivr.net");
  assert.equal(view.sourceUrl, UBO_UPDATE_URL);
  assert.deepEqual(view.latest, { version: "1.77.0", codebase: "https://github.com/gorhill/uBlock/releases/download/1.77.0/uBlock0_1.77.0.chromium.crx", size: null, hash: null });
  assert.equal(view.state, "update");
  assert.deepEqual(view.needsOrigins, [], "github.com is a required host");
  assert.equal(env.badge, "1", "the badge counts updates of every source");
  [row] = await installedOverview();
  assert.deepEqual([row.kind, row.trackedKey, row.canTrack], ["tracked", `url:${UBO}`, null]);
});

const SELF_URL = "https://example.org/ext/update.xml";
const selfHosted = (id, version) => ({ id, version, name: "Example", enabled: true, installType: "normal", updateUrl: SELF_URL });
// updates.xml as Extainium's own release script writes it (scripts/release-files.js).
const serveUpdate = ({ appid, version, codebase, crx }) => fakeUpdateServers({ files: { [SELF_URL]: updatesXml({ appid, version, codebase }), [codebase]: crx } });

test("installing a self-hosted record verifies the CRX's ID and version and hands it off", async () => {
  const env = profile({ extensions: [selfHosted(RSA_ID, "0.9")] });
  env.granted.add("https://example.org/*");
  fakeGithub([]);
  serveUpdate({ appid: RSA_ID, version: "1.0", codebase: "https://example.org/ext/x.crx", crx: RSA_CRX });
  const key = await trackInstalled(RSA_ID);
  assert.deepEqual([(await trackedView())[0].state, (await trackedView())[0].canInstall], ["update", true]);
  assert.deepEqual(await installRelease(key), { extensionId: RSA_ID, version: "1.0", name: "Example" });
  assert.deepEqual(env.handedOff, [RSA_CRX]);
  await browserInstalls(env, RSA_ID, "1.0");
  assert.deepEqual((await trackedView())[0].record.installed, { tag: null, digest: "sha256:" + hex(RSA_CRX), version: "1.0" });
});

test("a self-hosted CRX of another ID or version than announced is refused", async () => {
  for (const [crx, version, error] of [
    [ECDSA_CRX, "1.0", new RegExp(`^install url:${RSA_ID}: the CRX installs as extension ${ECDSA_ID}, not as ${RSA_ID}$`)],
    [RSA_CRX, "9.9", new RegExp(`^install url:${RSA_ID}: the CRX holds version "1.0", the update server announced 9.9$`)],
  ]) {
    const env = profile({ extensions: [selfHosted(RSA_ID, "0.9")] });
    env.granted.add("https://example.org/*");
    fakeGithub([]);
    serveUpdate({ appid: RSA_ID, version, codebase: "https://example.org/ext/x.crx", crx });
    await trackInstalled(RSA_ID);
    await assert.rejects(installRelease(`url:${RSA_ID}`), (e) => error.test(e.message));
    assert.equal(env.handedOff.length, 0);
  }
});

test("noupdate for the installed version is current; an update.xml without the extension is an error", async () => {
  const env = profile({ extensions: [selfHosted(RSA_ID, "0.9")] });
  env.granted.add("https://example.org/*");
  fakeGithub([]);
  const xml = (id) => `<?xml version="1.0"?><gupdate xmlns="http://www.google.com/update2/response" protocol="2.0"><app appid="${id}"><updatecheck status="noupdate"/></app></gupdate>`;
  const servers = fakeUpdateServers({ files: { [SELF_URL]: xml(RSA_ID) } });
  await trackInstalled(RSA_ID);
  const [view] = await trackedView();
  assert.equal(view.state, "current");
  assert.equal(view.latest.version, "0.9");
  // Review F6: the view says that no downloadable build exists (no Reinstall).
  assert.deepEqual([view.latest.codebase, view.canInstall], [null, false]);
  await assert.rejects(installRelease(`url:${RSA_ID}`), /^Error: install url:\w+: the update server offers nothing newer than the installed version 0\.9$/);
  assert.equal(servers.requests.length, 2, "the install checked again");
  fakeUpdateServers({ files: { [SELF_URL]: xml(ECDSA_ID) } });
  const { errors } = await checkAll();
  assert.deepEqual(errors, [`check url:${RSA_ID}: example.org lists no update for this extension`]);
});

// ---- redirects to hosts without a permission (review F2) ----
// Chromium follows a redirect for an extension only to a host it holds a
// permission for, else fetch fails without saying why (measured, see
// fakeUpdateServers). Owner decision: the error names the destination's
// origin, the record remembers it and its view asks for it.

const MIRROR = "https://mirror.example.net/ext/update.xml";
test("an update check redirected to a host without a permission names that origin, keeps the new record and asks for the origin", async () => {
  const env = profile({ extensions: [selfHosted(RSA_ID, "0.9")] });
  env.granted.add("https://example.org/*");
  fakeGithub([]);
  fakeUpdateServers({
    redirects: { [SELF_URL]: MIRROR },
    files: { [MIRROR]: updatesXml({ appid: RSA_ID, version: "1.0", codebase: "https://example.org/ext/x.crx" }) },
  });
  await assert.rejects(trackInstalled(RSA_ID),
    new RegExp(`^Error: check url:${RSA_ID}: example\\.org redirects to mirror\\.example\\.net, and there is no host permission for https://mirror\\.example\\.net/\\*$`));
  let [view] = await trackedView();
  assert.equal(view.key, `url:${RSA_ID}`, "the new record is kept");
  assert.match(view.record.error, /redirects to mirror\.example\.net/);
  assert.deepEqual(view.needsOrigins, ["https://mirror.example.net/*"]);
  env.granted.add("https://mirror.example.net/*");
  await checkRepo(`url:${RSA_ID}`);
  [view] = await trackedView();
  assert.deepEqual([view.needsOrigins, view.record.error, view.state, view.latest.version], [[], null, "update", "1.0"]);
});

test("a CRX download redirected to a host without a permission names that origin and hands off nothing; granted, it installs", async () => {
  const env = profile({ extensions: [selfHosted(RSA_ID, "0.9")] });
  env.granted.add("https://example.org/*");
  fakeGithub([]);
  const codebase = "https://example.org/ext/x.crx";
  const blob = "https://objects.example.net/blob/x.crx";
  fakeUpdateServers({ files: { [SELF_URL]: updatesXml({ appid: RSA_ID, version: "1.0", codebase }), [blob]: RSA_CRX }, redirects: { [codebase]: blob } });
  const key = await trackInstalled(RSA_ID);
  await assert.rejects(installRelease(key),
    new RegExp(`^Error: download ${key} 1\\.0: example\\.org redirects to objects\\.example\\.net, and there is no host permission for https://objects\\.example\\.net/\\*$`));
  assert.equal(env.handedOff.length, 0);
  assert.deepEqual((await trackedView())[0].needsOrigins, ["https://objects.example.net/*"]);
  env.granted.add("https://objects.example.net/*");
  assert.deepEqual(await installRelease(key), { extensionId: RSA_ID, version: "1.0", name: "Example" });
  assert.deepEqual(env.handedOff, [RSA_CRX]);
});

test("without the webRequest API a redirect that fails asks for https://*/*; a redirect to http is refused as not https", async () => {
  const env = profile({ extensions: [selfHosted(RSA_ID, "0.9")] });
  env.granted.add("https://example.org/*");
  delete globalThis.chrome.webRequest;
  fakeGithub([]);
  fakeUpdateServers({
    redirects: { [SELF_URL]: MIRROR },
    files: { [MIRROR]: updatesXml({ appid: RSA_ID, version: "1.0", codebase: "https://example.org/ext/x.crx" }) },
  });
  await assert.rejects(trackInstalled(RSA_ID),
    new RegExp(`^Error: check url:${RSA_ID}: example\\.org redirects to a host the browser does not name; there is no host permission for https://\\*/\\*$`));
  assert.deepEqual((await trackedView())[0].needsOrigins, ["https://*/*"]);
  env.granted.add("https://*/*");
  await checkRepo(`url:${RSA_ID}`);
  assert.deepEqual((await trackedView())[0].needsOrigins, []);

  const http = profile({ extensions: [selfHosted(RSA_ID, "0.9")] });
  http.granted.add("https://example.org/*");
  fakeGithub([]);
  fakeUpdateServers({ redirects: { [SELF_URL]: "http://example.org/ext/update.xml" } });
  await assert.rejects(trackInstalled(RSA_ID),
    new RegExp(`^Error: check url:${RSA_ID}: example\\.org redirects to http://example\\.org/ext/update\\.xml, which is not an https URL$`));
  assert.deepEqual(Object.keys(http.store).filter((k) => k.startsWith("repo:")), [], "no permission can help: the record goes");
});

// ---- the Installed list ----

test("installedOverview groups every installed extension by kind with its track action", async () => {
  const TITANIUM = "jlbggdgofbcndkkdimpeccablefilpkm";
  const ids = Array.from({ length: 7 }, (_, i) => String.fromCharCode(97 + i).repeat(32));
  const env = profile({ grant: false, extensions: [
    { ...cwsExt(ids[0], "1.0", "A store one"), icons: [{ size: 16, url: "chrome://extension-icon/a/16/0" }, { size: 128, url: "chrome://extension-icon/a/128/0" }] },
    { id: ids[1], version: "2", name: "B self", enabled: true, installType: "normal", updateUrl: "https://gitflic.ru/x/update.xml" },
    { id: ids[2], version: "3", name: "C plain", enabled: false, installType: "normal" },
    { id: ids[3], version: "4", name: "D unpacked", enabled: true, installType: "development" },
    { id: ids[4], version: "5", name: "E policy", enabled: true, installType: "admin", updateUrl: CWS_URL },
    { id: TITANIUM, version: "6", name: "Titanium", enabled: true, installType: "normal" },
    { id: ids[5], version: "7", name: "F linked", enabled: true, installType: "normal" },
    { id: ids[6], version: "8", name: "G http", enabled: true, installType: "normal", updateUrl: "http://example.org/u.xml" },
  ] });
  env.store["repo:o/r"] = { ...newRecord("o", "r"), extensionId: ids[5] };
  const rows = Object.fromEntries((await installedOverview()).map((r) => [r.name, [r.kind, r.canTrack, r.trackedKey, r.needsOrigins, r.icon, r.updateHost]]));
  assert.deepEqual(rows, {
    "A store one": ["cws", "cws", null, CWS_ORIGINS, "chrome://extension-icon/a/128/0", "clients2.google.com"],
    "B self": ["selfUpdating", "updateUrl", null, ["https://gitflic.ru/*"], null, "gitflic.ru"],
    "C plain": ["unmanaged", "github", null, [], null, null],
    "D unpacked": ["unmanaged", "github", null, [], null, null],
    "E policy": ["browser", null, null, [], null, "clients2.google.com"],
    Titanium: ["browser", null, null, [], null, null],
    "F linked": ["tracked", null, "o/r", [], null, null],
    "G http": ["selfUpdating", null, null, [], null, "example.org"],
  });
});

test("trackInstalled refuses browser-provided and unmanaged extensions and a second track", async () => {
  const env = profile({ extensions: [
    { id: "a".repeat(32), version: "1", name: "Policy", enabled: true, installType: "admin", updateUrl: CWS_URL },
    { id: "b".repeat(32), version: "1", name: "Plain", enabled: true, installType: "normal" },
    cwsExt(JUST_BLACK, "3", "Just Black"),
  ] });
  fakeGithub([]);
  fakeUpdateServers({ cws: { [JUST_BLACK]: REAL_APPS.get(JUST_BLACK) } });
  await assert.rejects(trackInstalled("a".repeat(32)), /^Error: track a{32}: Policy cannot be tracked through its own update server: the browser provides it$/);
  await assert.rejects(trackInstalled("b".repeat(32)), /^Error: track b{32}: Plain cannot be tracked through its own update server: it has no update URL; link it to a GitHub repo instead$/);
  await assert.rejects(trackInstalled("c".repeat(32)), /^Error: track c{32}: no installed extension has this ID$/);
  assert.equal(await trackInstalled(JUST_BLACK), JB_KEY);
  await assert.rejects(trackInstalled(JUST_BLACK), new RegExp(`^Error: track ${JUST_BLACK}: ${JB_KEY} is already tracked$`));
  assert.equal((await trackedView())[0].state, "current");
  assert.equal(Object.keys(env.store).filter((k) => k.startsWith("repo:")).length, 1);
});

// Contract: linkInstalledToGithub adds a GitHub record for an unmanaged extension; identity rules unchanged.
test("linking an unmanaged extension to a GitHub repo follows its ID; an asset of another ID is an identity change", async () => {
  const PLAIN = "b".repeat(32);
  const env = profile({ extensions: [{ id: PLAIN, version: "0.5", name: "Plain", enabled: true, installType: "normal" }, cwsExt(JUST_BLACK, "3")] });
  const { privateKey } = nodeCrypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
  const pkcs8 = new Uint8Array(privateKey.export({ type: "pkcs8", format: "der" }));
  const otherId = await extensionIdFromSpki(new Uint8Array(nodeCrypto.createPublicKey(privateKey).export({ type: "spki", format: "der" })));
  fakeGithub([{ tag: "v1", assets: [{ name: "example.crx", bytes: await packCrx3(zip, pkcs8) }] }]);
  await assert.rejects(linkInstalledToGithub(PLAIN, JUST_BLACK), new RegExp(`^Error: link ${PLAIN}: not a GitHub repository: "${JUST_BLACK}"$`));
  await assert.rejects(linkInstalledToGithub(JUST_BLACK, "o/r"), new RegExp(`^Error: link ${JUST_BLACK} to o/r: Ext updates from its own update URL ${CWS_URL}; track it instead$`));
  assert.equal(await linkInstalledToGithub(PLAIN, "https://github.com/o/r"), "o/r");
  await assert.rejects(linkInstalledToGithub(PLAIN, "o/s"), new RegExp(`^Error: link ${PLAIN} to o/s: extension ${PLAIN} is already tracked as o/r$`));
  let [view] = await trackedView();
  assert.deepEqual([view.key, view.source, view.record.extensionId, view.title, view.sourceLabel, view.sourceUrl], ["o/r", "github", PLAIN, "Plain", "GitHub", "https://github.com/o/r"]);
  await setTemplate("o/r", "example.crx");
  [view] = await trackedView();
  assert.equal(view.state, "identity-change");
  assert.equal(view.canInstall, true, "a matching asset exists (the identity change is the state's business)");
  assert.deepEqual([view.record.identityChange.from, view.record.identityChange.to], [PLAIN, otherId]);
});

// AGENTS.md: every exported state-changing function runs under operation(), once.
test("the new operations take the operation lock once each", async () => {
  const PLAIN = "b".repeat(32);
  const env = profile({ extensions: [cwsExt(DARK_READER, "1"), { id: PLAIN, version: "1", name: "Plain", enabled: true, installType: "normal" }] });
  fakeGithub([]);
  fakeUpdateServers({
    cws: { [JUST_BLACK]: REAL_APPS.get(JUST_BLACK), [DARK_READER]: appXml(DARK_READER) },
    files: { [JUST_BLACK_CODEBASE]: fixtureBytes("cws-just-black-3.crx") },
  });
  const counted = async (name, call) => {
    const n = env.locks.requests.filter((x) => x === OP).length;
    await call();
    assert.equal(env.locks.requests.filter((x) => x === OP).length - n, 1, name);
  };
  await counted("addRepo (CWS)", () => addRepo(JUST_BLACK));
  await counted("installRelease (CWS)", () => installRelease(JB_KEY));
  await counted("trackInstalled", () => trackInstalled(DARK_READER));
  await counted("linkInstalledToGithub", () => linkInstalledToGithub(PLAIN, "o/r"));
  await counted("checkAll (all sources)", () => checkAll());
  await counted("dismissInstallBlocked", () => dismissInstallBlocked());
  assert.equal(env.locks.isHeld(OP), false);
});

// ---- Extainium updating itself ----

// Contract: the new instance's runtime.onInstalled (reason "update") confirms its own pending install.
test("Extainium tracks its own update URL, installs its next version, and the new instance confirms that install", async () => {
  const { privateKey } = nodeCrypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
  const pkcs8 = new Uint8Array(privateKey.export({ type: "pkcs8", format: "der" }));
  const selfId = await extensionIdFromSpki(new Uint8Array(nodeCrypto.createPublicKey(privateKey).export({ type: "spki", format: "der" })));
  const updateUrl = "https://github.com/edxeth/extainium/releases/latest/download/updates.xml";
  const codebase = "https://github.com/edxeth/extainium/releases/download/v1.0/extainium.crx";
  const env = profile({ platform: "desktop", extensions: [{ id: selfId, version: "0.9", name: "Extainium", enabled: true, installType: "normal", updateUrl }] });
  env.runtimeId = selfId;
  env.manifestVersion = "0.9";
  fakeGithub([]);
  fakeUpdateServers({ files: { [updateUrl]: updatesXml({ appid: selfId, version: "1.0", codebase }), [codebase]: await packCrx3(zip, pkcs8) } });
  assert.equal(await manager.confirmOwnInstall({ reason: "update", previousVersion: "0.8" }), false, "nothing waits");
  const key = await trackInstalled(selfId);
  assert.deepEqual((await trackedView())[0].needsOrigins, []);
  await installRelease(key);
  // The browser replaces the running Extainium: no management.onInstalled reaches the old instance.
  env.install(selfId, "1.0", "Extainium");
  env.manifestVersion = "1.0";
  assert.equal(await manager.confirmOwnInstall({ reason: "update", previousVersion: "0.9" }), true);
  const [view] = await trackedView();
  assert.equal(view.record.installed.version, "1.0");
  assert.equal(view.state, "current");
  assert.equal(view.pendingInstall, null);
});

// ---- the desktop flag hint ----

async function quickRefusedInstall(env, { fileGone = true } = {}) {
  // Without the flag Chromium's installer refuses at once and deletes the copy.
  env.onDownloadStarted = async (id) => { if (fileGone) env.files.get(id).exists = false; };
  await installFile(RSA_CRX, "x.crx");
  await sleep(50);
}

// Contract: desktop pending installs completed but never confirmed whose copy vanished at once -> installBlocked { at, hint: "flag" }.
test("on desktop, a hand-off that completed at once and whose copy the browser deleted sets installBlocked until dismissed", async () => {
  const env = profile({ platform: "desktop" });
  fakeGithub([]);
  let e = await environment();
  assert.deepEqual(e, { platform: "desktop", browserVersion: "156.0.8078.79", installNeedsFlag: true, installBlocked: null });
  await quickRefusedInstall(env);
  e = await environment();
  assert.equal(e.installBlocked.hint, "flag");
  assert.ok(Number.isFinite(e.installBlocked.at));
  assert.deepEqual((await trackedView()).installBlocked, e.installBlocked);
  await dismissInstallBlocked();
  assert.equal((await environment()).installBlocked, null);
  assert.equal((await trackedView()).installBlocked, null);
});

test("installBlocked stays unset on Android, with Titanium's helper, when the copy remains, and is cleared by a confirmed install", async () => {
  const android = profile();
  fakeGithub([]);
  assert.deepEqual(await environment(), { platform: "android", browserVersion: "158.0.8127.100", installNeedsFlag: false, installBlocked: null });
  await quickRefusedInstall(android);
  assert.equal((await environment()).installBlocked, null, "Android");
  const titanium = profile({ platform: "desktop", extensions: [{ id: "jlbggdgofbcndkkdimpeccablefilpkm", version: "1", name: "Titanium", enabled: true, installType: "normal" }] });
  fakeGithub([]);
  assert.equal((await environment()).installNeedsFlag, false);
  await quickRefusedInstall(titanium);
  assert.equal((await environment()).installBlocked, null, "Titanium's helper");
  const kept = profile({ platform: "desktop" });
  fakeGithub([]);
  await quickRefusedInstall(kept, { fileGone: false });
  assert.equal((await environment()).installBlocked, null, "the copy remains");
  const cleared = profile({ platform: "desktop" });
  fakeGithub([]);
  await quickRefusedInstall(cleared);
  assert.ok((await environment()).installBlocked);
  await installFile(ECDSA_CRX, "y.crx");
  await browserInstalls(cleared, ECDSA_ID, "1.0");
  assert.equal((await environment()).installBlocked, null, "installs work now");
});

// Review F9: the refusal check must not depend on the hand-off's page staying
// open: the candidate is stored on the install entry and the sweep (service
// worker) judges it.
test("on desktop, a refused install whose page went away before its download ended is detected by the sweep", async () => {
  const env = profile({ platform: "desktop" });
  fakeGithub([]);
  env.newDownloadState = "in_progress";
  const { promise: started, resolve } = Promise.withResolvers();
  env.onDownloadStarted = async () => resolve();
  installFile(RSA_CRX, "x.crx"); // its page goes away below; it never ends
  await started;
  while (!env.changedListeners.size) await sleep(1);
  env.locks.abandon(OP);
  // No prompt held the download: it completed at once, the installer refused
  // and deleted the copy, and no page heard of it.
  const f = env.files.get(1);
  Object.assign(f, { state: "complete", endTime: new Date(Date.parse(f.startTime) + 15).toISOString(), exists: false });
  await manager.sweepDownloads();
  const { installBlocked } = await environment();
  assert.equal(installBlocked && installBlocked.hint, "flag");
});

test("on desktop, a refused install whose copy vanished after its page's check is detected by the sweep; a copy that stays is not", async () => {
  const env = profile({ platform: "desktop" });
  fakeGithub([]);
  await quickRefusedInstall(env, { fileGone: false }); // the page's check still sees the copy
  assert.equal((await environment()).installBlocked, null);
  env.files.get(1).exists = false; // the installer deleted it later; the page is gone
  await manager.sweepDownloads();
  assert.equal((await environment()).installBlocked?.hint, "flag");

  const kept = profile({ platform: "desktop" });
  fakeGithub([]);
  await quickRefusedInstall(kept, { fileGone: false });
  await manager.sweepDownloads(Date.now() + manager.PENDING_GRACE_MS + 1000);
  assert.deepEqual(kept.removed, [1], "the copy outlived the prompt's grace period and was deleted");
  await manager.sweepDownloads(Date.now() + 2 * manager.PENDING_GRACE_MS);
  assert.equal((await environment()).installBlocked, null);
});

// Closure review F9 (repro sweep-races.mjs, first case): a hand-off's
// onStarted write is queued for the state lock ahead of the sweep, so the
// sweep's entries differ from what it saw before taking the lock; it judges
// the entries it reads under the lock.
test("on desktop, a sweep judges a refused download whose start was recorded just before the sweep took the lock", async () => {
  const env = profile({ platform: "desktop" });
  fakeGithub([]);
  await environment();
  const STATE = "extainium-state";
  const { promise: held, resolve: release } = Promise.withResolvers();
  const { promise: got, resolve: acquired } = Promise.withResolvers();
  const locker = navigator.locks.request(STATE, async () => { acquired(); await held; });
  await got;
  const now = Date.now();
  const entry = {
    token: "late", repoKey: null, extensionId: RSA_ID, version: "1.0", installed: { version: "1.0", tag: null, digest: null },
    at: now, downloadId: null, downloadDone: false, promptAt: null, confirmedAt: null, fileGone: false,
  };
  env.store["install:late"] = entry;
  const started = navigator.locks.request(STATE, async () => {
    env.store["install:late"] = { ...entry, downloadId: 42, startedAt: now };
    env.files.set(42, { state: "complete", exists: false, startTime: new Date(now).toISOString(), endTime: new Date(now + 15).toISOString() });
  });
  const sweeping = manager.sweepDownloads();
  while ((await navigator.locks.query()).pending.filter((x) => x.name === STATE).length < 2) await sleep(1);
  release();
  await Promise.all([locker, started, sweeping]);
  await manager.sweepDownloads();
  assert.equal((await environment()).installBlocked?.hint, "flag");
});

// Closure review F13 (repro sweep-races.mjs, second case): an older refusal
// candidate judged after a newer install was confirmed is retired.
test("on desktop, an old refusal candidate does not set installBlocked after a later install was confirmed", async () => {
  const env = profile({ platform: "desktop" });
  fakeGithub([]);
  const old = await installFile(RSA_CRX, "a.crx");
  await sleep(30); // the page's own check still sees the copy
  const newer = await installFile(ECDSA_CRX, "b.crx");
  await browserInstalls(env, newer.extensionId, "1.0");
  assert.equal((await environment()).installBlocked, null);
  env.files.get(1).exists = false; // the old copy is gone only now
  await manager.sweepDownloads();
  assert.equal((await environment()).installBlocked, null, "installs work: the newer one was confirmed");
  assert.equal(Object.values(env.store).some((e) => e && e.token === old.token && e.refusalCandidate), false, "the old candidate is retired");
});

// ---- backup format 4 ----

test("a backup carries CWS and update-URL records and restores them; an existing record keeps its state", async () => {
  const env = profile({ extensions: [uboExt()] });
  env.granted.add("https://cdn.jsdelivr.net/*");
  fakeGithub([]);
  fakeUpdateServers({ cws: { [JUST_BLACK]: REAL_APPS.get(JUST_BLACK) }, files: { [UBO_UPDATE_URL]: fixtureText("ublock-jsdelivr-update.xml") } });
  await addRepo(JUST_BLACK);
  await trackInstalled(UBO);
  const text = await exportBackup();
  const backup = JSON.parse(text);
  assert.equal(backup.version, 4);
  assert.deepEqual(backup.repos, []);
  assert.deepEqual(backup.sources.map(({ addedAt, ...s }) => s), [
    { source: "cws", id: JUST_BLACK, name: null, installed: null },
    { source: "updateUrl", id: UBO, updateUrl: UBO_UPDATE_URL, name: "uBlock Origin", installed: null },
  ]);
  const fresh = profile({ extensions: [uboExt()] });
  fresh.granted.add("https://cdn.jsdelivr.net/*");
  fakeGithub([]);
  fakeUpdateServers({ cws: { [JUST_BLACK]: REAL_APPS.get(JUST_BLACK) }, files: { [UBO_UPDATE_URL]: fixtureText("ublock-jsdelivr-update.xml") } });
  const { count, errors } = await importBackup(text);
  assert.equal(count, 2);
  assert.deepEqual(errors, []);
  const views = await trackedView();
  assert.deepEqual(views.map((v) => [v.key, v.state]), [[JB_KEY, "not-installed"], [`url:${UBO}`, "update"]]);
  fresh.store[`repo:${JB_KEY}`] = { ...fresh.store[`repo:${JB_KEY}`], name: "Kept" };
  await importBackup(text);
  assert.equal(fresh.store[`repo:${JB_KEY}`].name, "Kept");
});

// Review F4: one record per extension ID, as addRepo and trackInstalled keep it:
// an incoming record of an ID that an existing or earlier imported record
// follows is skipped with a warning.
test("importing a backup skips a record whose extension ID another record already follows, with a warning", async () => {
  const env = profile();
  fakeGithub([]);
  fakeUpdateServers({ cws: { [JUST_BLACK]: REAL_APPS.get(JUST_BLACK) } });
  env.store["repo:o/r"] = { ...newRecord("o", "r"), extensionId: JUST_BLACK };
  const backup = {
    format: "extainium-backup", version: 4, exportedAt: "2026-11-24T00:00:00.000Z", keys: {}, fileKeys: {},
    repos: [{ owner: "p", repo: "q", template: null, includePrereleases: false, extensionId: DARK_READER, installed: null, addedAt: 1 }],
    sources: [
      { source: "cws", id: JUST_BLACK, name: "Just Black", installed: null, addedAt: 1 },
      { source: "cws", id: DARK_READER, name: "Dark Reader", installed: null, addedAt: 1 },
      { source: "updateUrl", id: UBO, updateUrl: UBO_UPDATE_URL, name: "uBlock Origin", installed: null, addedAt: 1 },
      { source: "cws", id: UBO, name: "uBlock Origin", installed: null, addedAt: 1 },
    ],
  };
  const { count, warnings } = await importBackup(JSON.stringify(backup));
  assert.deepEqual(Object.keys(env.store).filter((k) => k.startsWith("repo:")).sort(), ["repo:o/r", "repo:p/q", `repo:url:${UBO}`]);
  assert.deepEqual(warnings, [
    `cws:${JUST_BLACK}: extension ${JUST_BLACK} is already tracked as o/r; cws:${JUST_BLACK} was not imported`,
    `cws:${DARK_READER}: extension ${DARK_READER} is already tracked as p/q; cws:${DARK_READER} was not imported`,
    `cws:${UBO}: extension ${UBO} is already tracked as url:${UBO}; cws:${UBO} was not imported`,
  ]);
  assert.equal(count, 2, "the records imported");
  // A backup of the same profile, imported again, changes nothing and warns about nothing.
  const again = await importBackup(await exportBackup());
  assert.deepEqual(again.warnings, []);
  assert.deepEqual(Object.keys(env.store).filter((k) => k.startsWith("repo:")).sort(), ["repo:o/r", "repo:p/q", `repo:url:${UBO}`]);
});

// Closure review F11 (repro backup-orphan-key.mjs): which records are imported
// is decided before any key moves; the key of a skipped record stays a file
// key (selectable for file installs), never an orphan repo key.
test("importing a backup whose GitHub record is skipped for a duplicate ID keeps that record's key as a file key", async () => {
  const env = profile();
  fakeGithub([]);
  fakeUpdateServers({ cws: {} });
  const newKey = () => {
    const { privateKey, publicKey } = nodeCrypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
    return { b64: privateKey.export({ type: "pkcs8", format: "der" }).toString("base64"), spki: new Uint8Array(publicKey.export({ type: "spki", format: "der" })) };
  };
  const stored = newKey(); // already a file key here
  const fresh = newKey(); // only in the backup
  const storedId = await extensionIdFromSpki(stored.spki);
  const freshId = await extensionIdFromSpki(fresh.spki);
  env.store[`filekey:${storedId}`] = stored.b64;
  env.store[`repo:cws:${storedId}`] = newSourceRecord("cws", storedId);
  env.store[`repo:cws:${freshId}`] = newSourceRecord("cws", freshId);
  const gh = (repo, extensionId) => ({ owner: "o", repo, template: null, includePrereleases: false, extensionId, installed: null, addedAt: 1 });
  const backup = {
    format: "extainium-backup", version: 4, exportedAt: "2026-11-24T00:00:00.000Z",
    repos: [gh("r", storedId), gh("s", freshId)], sources: [], keys: { "o/r": stored.b64, "o/s": fresh.b64 }, fileKeys: {},
  };
  const { count, warnings } = await importBackup(JSON.stringify(backup));
  assert.equal(count, 0);
  assert.deepEqual(warnings, [
    `o/r: extension ${storedId} is already tracked as cws:${storedId}; o/r was not imported`,
    `o/s: extension ${freshId} is already tracked as cws:${freshId}; o/s was not imported`,
  ]);
  assert.deepEqual(Object.keys(env.store).filter((k) => k.startsWith("key:")), [], "no repo key without its repo");
  assert.deepEqual((await manager.fileKeysView()).map((k) => k.extensionId).sort(), [storedId, freshId].sort());
  assert.equal(env.store[`filekey:${storedId}`], stored.b64);
  assert.equal(env.store[`filekey:${freshId}`], fresh.b64);
});

test("a version 4 backup with a malformed source entry is refused naming the entry and field", async () => {
  profile();
  fakeGithub([]);
  const base = { format: "extainium-backup", version: 4, exportedAt: "2026-11-24T00:00:00.000Z", repos: [], keys: {}, fileKeys: {} };
  for (const [entry, error] of [
    [{ source: "amo", id: JUST_BLACK }, /^Error: import backup: sources #1: source is not "cws" or "updateUrl": "amo"$/],
    [{ source: "cws", id: "x" }, /^Error: import backup: sources #1: id is not 32 letters a-p: "x"$/],
    [{ source: "updateUrl", id: UBO, updateUrl: "http://h/u.xml" }, /^Error: import backup: sources #1 \(url:\w+\): updateUrl is not an https URL: "http:\/\/h\/u.xml"$/],
    [{ source: "cws", id: JUST_BLACK, installed: "3" }, /sources #1 \(cws:\w+\): installed is not null/],
    [{ source: "cws", id: JUST_BLACK, name: 5 }, /sources #1 \(cws:\w+\): name is not null/],
  ]) {
    await assert.rejects(importBackup(JSON.stringify({ ...base, sources: [entry] })), error, JSON.stringify(entry));
  }
  await assert.rejects(importBackup(JSON.stringify({ ...base, sources: [{ source: "cws", id: JUST_BLACK }, { source: "cws", id: JUST_BLACK }] })), /sources #2 \(cws:\w+\): listed twice/);
  await assert.rejects(importBackup(JSON.stringify(base)), /^Error: import backup: sources is not a list$/);
});

// Phone run 0.1.20: removing the last store record left Extainium holding Google's
// hosts. Optional host permissions no record needs any more are given back.
test("removing the last record that needs an optional host gives that permission back; others stay", async () => {
  const env = profile();
  fakeGithub([]);
  const OTHER = "a".repeat(32);
  fakeUpdateServers({ cws: { [JUST_BLACK]: REAL_APPS.get(JUST_BLACK), [OTHER]: appXml(OTHER) } });
  env.granted.add("https://cdn.example.org/*"); // granted for a record that no longer exists
  env.granted.add("https://*/*"); // broad grant: covers no CWS origin pattern exactly, needed by nothing
  await addRepo(JUST_BLACK);
  await addRepo(OTHER);

  await removeRepo(JB_KEY, false);
  for (const o of CWS_ORIGINS) assert.ok(env.granted.has(o), `${o} stays: another store record needs it`);
  assert.ok(!env.granted.has("https://cdn.example.org/*"), "an origin no record needs is given back");

  await removeRepo(`cws:${OTHER}`, false);
  for (const o of CWS_ORIGINS) assert.ok(!env.granted.has(o), `${o} is given back with the last store record`);
  assert.ok(!env.granted.has("https://*/*"), "the broad grant is given back when nothing needs it");
  const required = JSON.parse(readFileSync(new URL("../src/manifest.json", import.meta.url), "utf8")).host_permissions;
  for (const o of required) assert.ok(env.granted.has(o), `required ${o} is never removed`);
});
