import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fc from "fast-check";
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


// ---- Round 3 F9: property test of the update-manifest encoder against Python's XML parser ----
// Independent oracle: xml.etree.ElementTree (expat) parses the document and
// reports the gupdate/app/updatecheck values it holds.
const ORACLE = `
import json, sys, xml.etree.ElementTree as ET
root = ET.fromstring(sys.stdin.buffer.read())
ns = "{http://www.google.com/update2/response}"
apps = root.findall(ns + "app")
checks = [c for a in apps for c in a.findall(ns + "updatecheck")]
print(json.dumps({"root": root.tag, "protocol": root.get("protocol"), "apps": [a.get("appid") for a in apps],
  "checks": [{"codebase": c.get("codebase"), "version": c.get("version")} for c in checks]}))
`;
const parseWithPython = (xml) => JSON.parse(execFileSync("python3", ["-c", ORACLE], { input: xml, encoding: "utf8" }));

const urlChars = fc.constantFrom("a", "Z", "9", "-", ".", "_", "~", "/", "%20", "&", "'", '"', "<", ">", "=", ";", "é", "😀", "]]>", "&amp;");
const updateInput = fc.record({
  appid: fc.stringMatching(/^[a-p]{32}$/),
  version: fc.array(fc.nat({ max: 65535 }), { minLength: 1, maxLength: 4 }).map((p) => p.join(".")),
  codebase: fc.tuple(fc.constantFrom("https://", "http://"), fc.constantFrom("example.org", "cdn.example.com:8443"), fc.string({ unit: urlChars, maxLength: 12 }), fc.string({ unit: urlChars, maxLength: 12 }))
    .map(([scheme, host, path, query]) => `${scheme}${host}/${path}/extainium.crx${query ? "?" + query : ""}`),
});

test("property: updates.xml parses as XML holding exactly one app with the given appid, version and codebase", () => {
  fc.assert(fc.property(updateInput, (input) => {
    assert.deepEqual(parseWithPython(updatesXml(input)), {
      root: "{http://www.google.com/update2/response}gupdate",
      protocol: "2.0",
      apps: [input.appid],
      checks: [{ codebase: input.codebase, version: input.version }],
    });
  }), { numRuns: 60 }); // one python3 process per run
});

