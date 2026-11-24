import { test } from "node:test";
import assert from "node:assert/strict";
import { updatesXml, withUpdateUrl } from "../scripts/release-files.js";

// Item 10: the update manifest format of Chrome's docs
// (developer.chrome.com/docs/extensions/how-to/distribute/host-on-linux#update_manifest).
test("updates.xml is a gupdate manifest with the appid, version and codebase", () => {
  assert.equal(
    updatesXml({ appid: "jojihfmjoonfhnjlioapjefjmdcddgol", version: "0.1.13", codebase: "https://example.org/x/extainium.crx" }),
    "<?xml version='1.0' encoding='UTF-8'?>\n"
      + "<gupdate xmlns='http://www.google.com/update2/response' protocol='2.0'>\n"
      + "  <app appid='jojihfmjoonfhnjlioapjefjmdcddgol'>\n"
      + "    <updatecheck codebase='https://example.org/x/extainium.crx' version='0.1.13' />\n"
      + "  </app>\n"
      + "</gupdate>\n"
  );
});

test("a codebase URL with & and ' is XML-escaped in its attribute", () => {
  const xml = updatesXml({ appid: "a".repeat(32), version: "1.0", codebase: "https://example.org/x.crx?a=1&b='2'" });
  assert.match(xml, /codebase='https:\/\/example\.org\/x\.crx\?a=1&amp;b=&apos;2&apos;'/);
});

test("updates.xml and update_url reject values that are not an ID, a version or an http(s) URL, naming them", () => {
  const ok = { appid: "a".repeat(32), version: "1.0", codebase: "https://example.org/x.crx" };
  assert.throws(() => updatesXml({ ...ok, appid: "jojih" }), /appid is not an extension ID: "jojih"/);
  assert.throws(() => updatesXml({ ...ok, version: "1.0-beta" }), /not an extension version: "1.0-beta"/);
  assert.throws(() => updatesXml({ ...ok, codebase: "dist/extainium.crx" }), /codebase: not an absolute URL: "dist\/extainium.crx"/);
  assert.throws(() => withUpdateUrl({}, "file:///tmp/updates.xml"), /update_url: not an http\(s\) URL: "file:\/\/\/tmp\/updates.xml"/);
});

test("withUpdateUrl adds update_url and keeps the other manifest fields", () => {
  assert.deepEqual(withUpdateUrl({ name: "E", version: "1" }, "https://example.org/u.xml"), { name: "E", version: "1", update_url: "https://example.org/u.xml" });
});
