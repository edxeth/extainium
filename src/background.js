import { SWEEP_ALARM, checkAll, cleanupDownloads, refreshBadge, sweepDownloads } from "./lib/manager.js";

const ALARM = "check-updates";
const PERIOD_MINUTES = 6 * 60;

async function ensureAlarm() {
  if (!(await chrome.alarms.get(ALARM))) {
    await chrome.alarms.create(ALARM, { delayInMinutes: 1, periodInMinutes: PERIOD_MINUTES });
  }
}

function logCheck(result) {
  if (result.errors.length) console.warn("[Extainium] check errors:", result.errors);
}

// The badge text does not survive a browser restart or an extension update.
chrome.runtime.onInstalled.addListener(() => ensureAlarm().then(refreshBadge));
chrome.runtime.onStartup.addListener(() => ensureAlarm().then(sweepDownloads).then(refreshBadge));

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARM) sweepDownloads().then(checkAll).then(logCheck);
  else if (alarm.name === SWEEP_ALARM) sweepDownloads();
});

// The popup closes while a check runs, so it asks the service worker.
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg && msg.type === "check") {
    checkAll().then(sendResponse, (e) => sendResponse({ error: e.message }));
    return true;
  }
});

chrome.management.onInstalled.addListener((info) => {
  cleanupDownloads(info.id).then(refreshBadge);
});
chrome.management.onUninstalled.addListener(() => refreshBadge());
