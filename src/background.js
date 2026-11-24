import {
  SWEEP_ALARM, checkAll, confirmOwnInstall, handleExtensionInstalled, reconcileInstalls, refreshBadge, releaseUnusedOrigins,
  sweepDownloads, trackSelf,
} from "./lib/manager.js";

const ALARM = "check-updates";
const PERIOD_MINUTES = 6 * 60;

async function ensureAlarm() {
  if (!(await chrome.alarms.get(ALARM))) {
    await chrome.alarms.create(ALARM, { delayInMinutes: 1, periodInMinutes: PERIOD_MINUTES });
  }
}

// Runs fn, logging its failure, so one failed step does not stop the next.
const step = (what, fn) => () => Promise.resolve().then(fn).catch((e) => console.error(`[Extainium] ${what}:`, e));

// After Extainium installed a newer Extainium, the new instance's update event is
// that install's event (the old one was replaced before management.onInstalled reached it).
const confirmSelf = (details) => step("confirm own install", () => confirmOwnInstall(details))();
// Compares the browser's versions with pending installs (Chromium may apply
// them later, at the latest at its start, without an install event).
// startedAt: when the browser started (reconcileInstalls).
const reconcile = (startedAt = null) => step("reconcile installs", () => reconcileInstalls({ startedAt }))();
// On desktop, Extainium follows its own update URL unless the user removed it (Titanium updates it itself).
const selfTrack = step("track Extainium itself", trackSelf);
const sweep = step("sweep downloads", () => sweepDownloads());
// Gives back optional host permissions no record needs (also those left by older versions).
const releaseHosts = step("release unused host permissions", releaseUnusedOrigins);

// The badge text does not survive a browser restart or an extension update.
chrome.runtime.onInstalled.addListener((details) =>
  confirmSelf(details).then(() => reconcile()).then(ensureAlarm).then(selfTrack).then(releaseHosts).then(refreshBadge));
// A start is no install event: a version that changed since a hand-off is reconcile's evidence.
chrome.runtime.onStartup.addListener(() => {
  const startedAt = Date.now();
  return ensureAlarm().then(sweep).then(() => reconcile(startedAt)).then(selfTrack).then(refreshBadge);
});

chrome.alarms.onAlarm.addListener((alarm) => {
  // Checks every source (GitHub, Chrome Web Store, update URLs). Check errors
  // are kept in lastCheck and on each record, where the UI shows them.
  if (alarm.name === ALARM) sweep().then(() => reconcile()).then(checkAll);
  else if (alarm.name === SWEEP_ALARM) sweep().then(() => reconcile());
});

// The popup closes while a check runs, so it asks the service worker.
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg && msg.type === "check") {
    checkAll().then(sendResponse, (e) => sendResponse({ error: e.message }));
    return true;
  }
});

// Confirms pending installs (commits record.installed), deletes their CRX copies, refreshes the badge.
chrome.management.onInstalled.addListener((info) => {
  handleExtensionInstalled(info).catch((e) => console.error("[Extainium] confirm install:", e));
});
chrome.management.onUninstalled.addListener(() => refreshBadge());
