// Fetches of update servers and the builds they announce, with the host
// permission a redirect needs. Chromium follows a redirect of an extension's
// fetch only to a host the extension holds a permission for (or one that
// allows CORS); otherwise fetch fails with a bare "Failed to fetch", and with
// redirect: "manual" the answer is an opaque redirect without its Location
// (both measured in Chromium 156). The destination is read from
// chrome.webRequest.onBeforeRedirect, which reports the extension's own
// requests ("webRequest" permission, which adds no install warning). Without
// that API the destination stays unknown, so the error asks for https://*/*,
// the broad optional host permission.

import { originOf } from "./sources.js";

export const ANY_HTTPS = "https://*/*";
// How long a failed fetch waits for webRequest to report its redirect (its
// events may come after fetch rejected).
export const redirectTiming = { waitMs: 2000, pollMs: 20 };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// The origins of origins that the extension holds no host permission for.
export async function missingOriginsOf(origins) {
  const missing = [];
  for (const o of new Set(origins)) if (!(await chrome.permissions.contains({ origins: [o] }))) missing.push(o);
  return missing;
}

// Collects the redirect destinations of requests of url (hops, in order)
// while it listens; stop() ends it.
function watchRedirects(url) {
  const event = globalThis.chrome && chrome.webRequest && chrome.webRequest.onBeforeRedirect;
  const hops = [];
  if (!event) return { available: false, hops, stop() {} };
  const href = new URL(url).href;
  const ids = new Set();
  const listener = (d) => {
    if (d.url === href) ids.add(d.requestId);
    if (ids.has(d.requestId)) hops.push(d.redirectUrl);
  };
  event.addListener(listener, { urls: ["<all_urls>"] });
  return { available: true, hops, stop: () => event.removeListener(listener) };
}

// An error with the host permissions (origin patterns) that would let the
// operation succeed: error.neededOrigins.
function needing(message, origins) {
  return Object.assign(new Error(message), { neededOrigins: origins });
}

// Why a fetch of url that failed with a network error failed, when it was a
// redirect: an Error naming the destination (with neededOrigins when a host
// permission would help), or null when it was not a redirect or the
// extension holds every permission it needs.
async function redirectFailure(url, init, watch) {
  const host = new URL(url).host;
  if (!watch.hops.length) {
    let probe;
    try {
      probe = await fetch(url, { ...init, redirect: "manual" });
    } catch {
      return null; // not reachable at all
    }
    if (probe.type !== "opaqueredirect") return null;
    for (let t = 0; watch.available && !watch.hops.length && t < redirectTiming.waitMs; t += redirectTiming.pollMs) await sleep(redirectTiming.pollMs);
  }
  if (!watch.hops.length) {
    if (!(await missingOriginsOf([ANY_HTTPS])).length) return null;
    return needing(`${host} redirects to a host the browser does not name; there is no host permission for ${ANY_HTTPS}`, [ANY_HTTPS]);
  }
  const notHttps = watch.hops.find((d) => !/^https:/i.test(d));
  if (notHttps) return new Error(`${host} redirects to ${notHttps}, which is not an https URL`);
  const missing = await missingOriginsOf(watch.hops.map(originOf));
  if (!missing.length) return null;
  const first = new URL(watch.hops.find((d) => missing.includes(originOf(d)))).host;
  return needing(`${host} redirects to ${first}, and there is no host permission for ${missing.join(", ")}`, missing);
}

// GETs url (no credentials unless init says so); throws a message naming the
// host on an HTTP error or a network error, or naming the redirect's
// destination when a redirect to a host without a permission failed (see
// redirectFailure; error.neededOrigins lists the origins to request).
export async function fetchFrom(url, init = {}) {
  const request = { credentials: "omit", ...init };
  const watch = watchRedirects(url);
  try {
    let res;
    try {
      res = await fetch(url, request);
    } catch (e) {
      throw (await redirectFailure(url, request, watch)) || new Error(`cannot reach ${new URL(url).host} (${e.message})`);
    }
    if (!res.ok) throw new Error(`HTTP ${res.status} from ${new URL(url).host}`);
    return res;
  } finally {
    watch.stop();
  }
}
