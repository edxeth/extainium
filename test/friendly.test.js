// friendly() turns the lib's error messages of the sources feature into plain
// text with the next step (review F8, closure review F15): one representative
// message of each source error kind, worded as src/lib throws it (the exact
// messages are asserted in sources.test.js and redirects.test.js), and the
// text the user sees. None may fall through to the generic text.

import { test } from "node:test";
import assert from "node:assert/strict";
import { friendly } from "../src/friendly.js";

const ID = "a".repeat(32);
const OTHER = "b".repeat(32);
const GENERIC = friendly("something no rule knows").text;

const CASES = [
  // network and HTTP (net.js fetchFrom)
  [`check cws:${ID}: cannot reach clients2.google.com (Failed to fetch)`, "Cannot reach the Chrome Web Store. Check the connection, then try again."],
  [`check url:${ID}: cannot reach example.org (Failed to fetch)`, "Cannot reach example.org. Check the connection, then try again."],
  [`check url:${ID}: HTTP 503 from example.org`, "example.org did not answer (HTTP 503). Try again later."],
  [`install cws:${ID}: check cws:${ID}: HTTP 500 from clients2.google.com`, "The Chrome Web Store did not answer (HTTP 500). Try again later."],
  [`download url:${ID} 1.0: HTTP 404 from example.org`, "The download from example.org failed (HTTP 404). Tap Update to retry."],
  // redirects (net.js redirectFailure, fetchFrom)
  [`check url:${ID}: example.org redirects to mirror.example.net, and there is no host permission for https://mirror.example.net/*`,
    "example.org forwards to mirror.example.net. Allow Extainium to reach mirror.example.net when the browser asks, then check again."],
  [`download url:${ID} 1.0: example.org redirects to objects.example.net, and there is no host permission for https://objects.example.net/*`,
    "example.org forwards to objects.example.net. Allow Extainium to reach objects.example.net when the browser asks, then check again."],
  [`check url:${ID}: example.org redirects to a host the browser does not name; there is no host permission for https://*/*`,
    "example.org forwards to another site this browser does not name. Allow Extainium to reach all sites when the browser asks, then check again."],
  [`check url:${ID}: example.org redirects to http://example.org/ext/update.xml, which is not an https URL`,
    "example.org forwards to an address that is not https, so Extainium does not follow it."],
  // permissions
  [`check url:${ID}: no host permission for https://cdn.jsdelivr.net/*`,
    "Extainium needs access to cdn.jsdelivr.net, so nothing was checked or installed. Try again and choose Allow when the browser asks."],
  ["grant access: clients2.google.com, clients2.googleusercontent.com was not granted",
    "Extainium was not allowed to reach clients2.google.com, clients2.googleusercontent.com, so nothing changed. Try again and choose Allow."],
  // input
  [`parse source: no extension ID (32 letters a-p) in the Chrome Web Store link "https://chromewebstore.google.com/detail/x"`,
    "That Chrome Web Store link has no extension ID. Copy the link from the extension's own store page."],
  [`parse source: "${"z".repeat(32)}" is not an extension ID: an ID has 32 letters a-p`,
    "An extension ID has exactly 32 letters from a to p. Check the ID, or paste the store link instead."],
  // the server's answer about the extension
  [`check cws:${ID}: the Chrome Web Store does not know this extension (error-unknownApplication)`,
    "The Chrome Web Store does not know this extension. It was removed from the store, or the ID is wrong."],
  [`install cws:${ID}: the Chrome Web Store offers no build of this extension to this browser`,
    "The Chrome Web Store does not offer this extension to this browser. It may need a newer browser, still use Manifest V2, or be unlisted."],
  [`install url:${ID}: example.org offers no build of this extension to this browser`,
    "example.org offers no build of this extension to this browser, so there is nothing to install."],
  [`install url:${ID}: the update server offers nothing newer than the installed version 0.9`, "Version 0.9 is already the newest one its update server offers."],
  [`check url:${ID}: example.org lists no update for this extension`,
    "example.org does not list this extension in its update feed. The author may have moved it; check the extension's homepage."],
  [`check url:${ID}: the announced codebase is not an https URL: "http://example.org/x.crx"`,
    "The update server points to a download that is not https, so Extainium does not use it."],
  [`check url:${ID}: the update server answered status "restricted"`,
    "The update server sent an answer Extainium cannot use. Try again later; if it stays, the extension's update feed has changed."],
  [`check cws:${ID}: parse update manifest: not well-formed`,
    "The update server sent an answer Extainium cannot use. Try again later; if it stays, the extension's update feed has changed."],
  // the download
  [`install cws:${ID}: downloaded 4 bytes, the update server announced 5`,
    "The download was incomplete or changed on the way, so it was not installed. Tap Update to retry."],
  [`install url:${ID}: the download's sha256 ${"0".repeat(64)} does not match the announced ${"1".repeat(64)}`,
    "The download was incomplete or changed on the way, so it was not installed. Tap Update to retry."],
  [`install url:${ID}: the download from example.org is not a CRX file`,
    "example.org sent something that is not an extension file, so nothing was installed. Try again later."],
  [`verify cws:${ID} 3: it has no Chrome Web Store publisher proof: no proof is signed with Google's publisher key`,
    "This file is not signed by the Chrome Web Store, so it was not installed."],
  [`install cws:${ID}: the CRX installs as extension ${OTHER}, not as ${ID}`,
    "The download belongs to a different extension than the tracked one, so it was not installed."],
  [`install url:${ID}: the CRX holds version "1", the update server announced 2`,
    "The download holds version 1, not the announced 2, so it was not installed. Try again later."],
  // tracking and linking
  [`add repo: extension ${ID} is already tracked as o/r`, "This extension is already tracked as o/r. Its card is on the Extensions tab."],
  [`track ${ID}: no installed extension has this ID`, "This extension is no longer installed, so nothing was tracked."],
  [`link ${ID}: not a GitHub repository: "abc"`, "Enter the extension's GitHub repository as owner/repo or a github.com link."],
  // Apply now of an added update that waits to be applied (manager.js applyDelayed)
  ["apply o/r: no added update waits to be applied", "No added update waits to be applied any more. Tap Check to see the current state."],
  ["apply o/r: Dark Reader is turned off; the browser applies 4.9.99 when it is turned on, at the latest when the browser restarts",
    "Dark Reader is turned off. Chromium applies 4.9.99 when it is turned on again, at the latest when the browser restarts."],
  [`apply url:${ID}: extension ${ID} is not installed`, "This extension is no longer installed, so there is nothing to apply."],
  [`apply o/r: could not turn extension ${ID} on again: Extension is blocked`,
    "The extension could not be turned on again. Turn it on in the browser's extensions page."],
];

test("each kind of source error gets its own plain text with the next step", () => {
  for (const [message, text] of CASES) {
    const f = friendly(new Error(message));
    assert.notEqual(f.text, GENERIC, message);
    assert.equal(f.text, text, message);
    assert.equal(f.detail, message, "the lib's message stays as the detail");
  }
});
