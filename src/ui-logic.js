// Decisions of the extension pages (options.js, popup.js) that need no DOM, so
// the node tests cover them (test/ui-logic.test.js). Imports only from lib/.

import { CWS_ORIGINS, parseSourceInput } from "./lib/sources.js";

// "https://host/*" -> "host".
export const hostOf = (origin) => origin.replace(/^[a-z]+:\/\//, "").replace(/\/\*?$/, "");

// The host permissions the Add form requests in its submit gesture for input:
// a Chrome Web Store link or ID is checked at once and needs the store's
// hosts; anything else needs none (input that does not parse fails in addRepo).
export function addOrigins(input) {
  let parsed;
  try {
    parsed = parseSourceInput(input);
  } catch {
    return [];
  }
  return parsed.source === "cws" ? [...CWS_ORIGINS] : [];
}

// Requests origins with request (chrome.permissions.request, which needs the
// user gesture: call this synchronously in the click handler, before any
// await) and returns a promise of whether they were granted; [] asks nothing.
// required: a decline rejects with "grant access: <hosts> was not granted"
// (Add and Track, which change nothing then); otherwise the action goes on and
// the lib reports what it really needs (Check and Install: a remembered
// redirect origin may be stale, closure review F12).
export function askOrigins(request, origins, { required }) {
  if (!origins || !origins.length) return Promise.resolve(true);
  return request({ origins }).then((granted) => {
    if (!granted && required) throw new Error(`grant access: ${origins.map(hostOf).join(", ")} was not granted`);
    return granted;
  });
}

// The DOM id of record key's card. Injective: every character other than a-z,
// 0-9 becomes _<hex code>_ ("_" included), so "a/b-c" and "a-b/c" differ.
export const cardId = (key) => `card-${key.replace(/[^a-z0-9]/gi, (c) => `_${c.codePointAt(0).toString(16)}_`)}`;

// True when the card of trackedView entry v offers Install / Update /
// Reinstall / Install again: the lib says a downloadable build exists
// (canInstall) and no identity change waits for confirmation. A "waiting"
// card keeps it: a vanished copy does not prove the prompt was accepted.
export const offersInstall = (v) => !!v.canInstall && v.state !== "identity-change";

// Set by the storage migration when a 0.1 regex pattern had no template form:
// a to-do on the card, not a failed check.
export const isConversionError = (msg) => /could not be converted to a file name template/.test(msg || "");

// The number of cards marked Error: records whose last check failed, from the
// records themselves, so a fix by any operation shows at once.
export const checkErrorCount = (view) => view.filter((v) => v.record.error && !isConversionError(v.record.error)).length;

export const plural = (n, one, many) => `${n} ${new Intl.PluralRules("en").select(n) === "one" ? one : many}`;

// The pages' last-check line: when checkAll last ran (lastCheck.at, or null
// before the first) and how many cards show an error now (checkErrorCount).
// when(at) formats the time.
export function checkLine(lastCheck, view, when) {
  if (!lastCheck) return "Not checked yet. Checks run every 6 hours.";
  const errors = checkErrorCount(view);
  return `Last checked ${when(lastCheck.at)}${errors ? ` · ${plural(errors, "error", "errors")}` : ""}`;
}

// The popup's headline for trackedView's view: { state: "empty" | "update" |
// "attention" | "waiting" | "current", updates, attention (entries that need a
// look in Extainium: an identity change, or a server that offers no build to
// this browser), waiting (updates Chromium may apply when the extension
// restarts, trackedView's "waiting"), headline }.
export function popupSummary(view) {
  const updates = view.filter((v) => v.state === "update");
  const attention = view.filter((v) => v.state === "identity-change" || v.state === "not-offered");
  const waiting = view.filter((v) => v.state === "waiting");
  const state = !view.length ? "empty" : updates.length ? "update" : attention.length ? "attention" : waiting.length ? "waiting" : "current";
  const headline = state === "empty"
    ? "No tracked extensions"
    : state === "update"
      ? `${plural(updates.length, "update", "updates")} available`
      : state === "attention"
        ? `${plural(attention.length, "extension needs", "extensions need")} attention`
        : state === "waiting"
          ? `${plural(waiting.length, "update", "updates")} waiting for Chromium`
          : "All up to date";
  return { state, updates, attention, waiting, headline };
}
