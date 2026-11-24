import { SWEEP_ALARM, checkAll, confirmOwnInstall, handleExtensionInstalled, refreshBadge, sweepDownloads } from "./lib/manager.js";

const ALARM = "check-updates";
const PERIOD_MINUTES = 6 * 60;

async function ensureAlarm() {
  if (!(await chrome.alarms.get(ALARM))) {
    await chrome.alarms.create(ALARM, { delayInMinutes: 1, periodInMinutes: PERIOD_MINUTES });
  }
}

// After Extainium installed a newer Extainium, the new instance confirms that
// install (the old one was replaced before management.onInstalled reached it).
const confirmSelf = () => confirmOwnInstall().catch((e) => console.error("[Extainium] confirm own install:", e));

// The badge text does not survive a browser restart or an extension update.
chrome.runtime.onInstalled.addListener(() => confirmSelf().then(ensureAlarm).then(refreshBadge));
chrome.runtime.onStartup.addListener(() => confirmSelf().then(ensureAlarm).then(sweepDownloads).then(refreshBadge));

chrome.alarms.onAlarm.addListener((alarm) => {
  // Checks every source (GitHub, Chrome Web Store, update URLs). Check errors
  // are kept in lastCheck and on each record, where the UI shows them.
  if (alarm.name === ALARM) sweepDownloads().then(checkAll);
  else if (alarm.name === SWEEP_ALARM) sweepDownloads();
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
