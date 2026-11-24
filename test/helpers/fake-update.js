// Fakes of the update servers the CWS and update-URL sources talk to, fed
// with the real answers saved in test/fixtures (see test/fixtures/SOURCES.md).

import { readFileSync } from "node:fs";

const fixture = (name) => new URL(`../fixtures/${name}`, import.meta.url);
export const fixtureText = (name) => readFileSync(fixture(name), "utf8");
export const fixtureBytes = (name) => new Uint8Array(readFileSync(fixture(name)));

// The <app> elements of a real CWS answer, byte for byte: Map(appid -> element text).
export function realApps(xml) {
  const apps = new Map();
  for (const m of xml.matchAll(/<app appid="([a-p]{32})"[^>]*?(?:\/>|>.*?<\/app>)/gs)) apps.set(m[1], m[0]);
  return apps;
}
// The real answer's prolog up to the first <app> (declaration, <gupdate>, <daystart/>).
export const CWS_HEAD = (() => {
  const xml = fixtureText("cws-updatecheck-3ids.xml");
  return xml.slice(0, xml.indexOf("<app "));
})();

// The real Just Black theme (CWS, 6593 bytes) and its app element in the real answer.
export const JUST_BLACK = "aghfnjkcakhmadgdomlmlhhaocbkloab";
export const DARK_READER = "eimadpbcbfnmbkopoojfekhnkhdbieeh";
export const UBO_LITE = "ddkjiahejlhfcafbddmgiahcphecmpfh";
export const REAL_APPS = new Map([...realApps(fixtureText("cws-updatecheck-3ids.xml")), ...realApps(fixtureText("cws-noupdate-malware-unknown.xml"))]);
export const JUST_BLACK_CODEBASE = /codebase="([^"]+)"/.exec(REAL_APPS.get(JUST_BLACK))[1];

// Serves the CWS update check (an app element per requested ID: cws[id], or
// error-unknownApplication; HTTP 400 for a URL over 8000 characters, the
// server's measured limit) and files: { [url]: bytes | text | (url) => Response }.
// A file URL also matches with a query appended (update checks add x=...).
// Unmatched requests go to the fetch installed before (fakeGithub's).
// redirects: { [url]: destination URL } answers a request of url (also with a
// query appended) with a redirect, as Chromium handles one for an extension
// (measured in Chromium 156, see the F2 notes in the lib fix report): the
// extension's chrome.webRequest.onBeforeRedirect reports it a moment later;
// with redirect: "manual" the answer is an opaque redirect that does not say
// where; followed, it fails with TypeError "Failed to fetch" unless the
// extension holds a host permission for the destination, which then answers
// (response.url and redirected tell).
// Returns { cwsRequests: [{ url, ids, params }], requests: [url] }.
export function fakeUpdateServers({ cws = {}, files = {}, status = 200, redirects = {} } = {}) {
  const prev = globalThis.fetch;
  const log = { cwsRequests: [], requests: [] };
  const matches = (url, k) => url === k || url.startsWith(k + "?") || url.startsWith(k + "&");
  let requestId = 0;
  globalThis.fetch = async function serve(input, init = {}, id = String(++requestId)) {
    const url = String(input);
    if (url.startsWith("blob:")) return prev(input, init);
    const from = Object.keys(redirects).find((k) => matches(url, k));
    if (from) {
      log.requests.push(url);
      const to = redirects[from];
      const event = globalThis.chrome.webRequest && globalThis.chrome.webRequest.onBeforeRedirect;
      if (event) setTimeout(() => event.dispatch({ requestId: id, url, redirectUrl: to }), 20);
      if (init.redirect === "manual") return { type: "opaqueredirect", status: 0, ok: false, redirected: false, url, headers: new Headers() };
      const u = new URL(to);
      if (!(await globalThis.chrome.permissions.contains({ origins: [`${u.protocol}//${u.hostname}/*`] }))) throw new TypeError("Failed to fetch");
      const res = await serve(to, init, id);
      Object.defineProperty(res, "url", { value: res.url || to });
      Object.defineProperty(res, "redirected", { value: true });
      return res;
    }
    if (url.startsWith("https://clients2.google.com/service/update2/crx?")) {
      const u = new URL(url);
      const xs = u.searchParams.getAll("x").map((x) => Object.fromEntries(new URLSearchParams(x)));
      log.requests.push(url);
      log.cwsRequests.push({ url, ids: xs.map((x) => x.id), xs, params: Object.fromEntries([...u.searchParams].filter(([k]) => k !== "x")), credentials: init.credentials });
      if (url.length > 8000) return new Response("<html>400 Bad Request</html>", { status: 400 });
      if (status !== 200) return new Response("error", { status });
      const apps = xs.map((x) => cws[x.id] ?? `<app appid="${x.id}" status="error-unknownApplication"/>`);
      return new Response(`${CWS_HEAD}${apps.join("")}</gupdate>`, { status: 200, headers: { "content-type": "text/xml; charset=UTF-8" } });
    }
    for (const [k, v] of Object.entries(files)) {
      if (url !== k && !url.startsWith(k + "?") && !url.startsWith(k + "&")) continue;
      log.requests.push(url);
      if (typeof v === "function") return v(url);
      return new Response(v, { status: 200 });
    }
    return prev(input, init);
  };
  return log;
}
