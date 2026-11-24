import {
  SWEEP_ALARM, checkAll, confirmOwnInstall, handleExtensionInstalled, reconcileInstalls, refreshBadge, restoreDisabled, sweepDownloads,
  trackSelf,
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

// After Extainium installed a newer Extainium, the new instance confirms that
// install (the old one was replaced before management.onInstalled reached it).
const confirmSelf = step("confirm own install", confirmOwnInstall);
// Updates the browser applied at its start (delayed ones, no install event) are confirmed.
const reconcile = step("reconcile installs", reconcileInstalls);
// Extensions an interrupted Apply now left turned off are turned on again.
const restore = step("restore disabled extensions", restoreDisabled);
// On desktop, Extainium follows its own update URL once (Titanium updates it itself).
const selfTrack = step("track Extainium itself", trackSelf);
const sweep = step("sweep downloads", () => sweepDownloads());

// The badge text does not survive a browser restart or an extension update.
chrome.runtime.onInstalled.addListener(() =>
  confirmSelf().then(restore).then(reconcile).then(ensureAlarm).then(selfTrack).then(refreshBadge));
chrome.runtime.onStartup.addListener(() =>
  confirmSelf().then(restore).then(ensureAlarm).then(sweep).then(reconcile).then(selfTrack).then(refreshBadge));

chrome.alarms.onAlarm.addListener((alarm) => {
  // Checks every source (GitHub, Chrome Web Store, update URLs). Check errors
  // are kept in lastCheck and on each record, where the UI shows them.
  if (alarm.name === ALARM) sweep().then(reconcile).then(checkAll);
  else if (alarm.name === SWEEP_ALARM) restore().then(sweep).then(reconcile);
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
