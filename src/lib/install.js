// Hands a CRX to the browser installer. Titanium allows off-store CRX installs
// when the download's initiator is a chrome-extension:// page, so this must run
// in an extension page (blob URLs do not exist in the service worker).

import { CRX_MIME } from "./crx.js";

// Unique per install so the browser never asks "Download file again?".
function crxFilename(base) {
  const cleaned = String(base)
    .replace(/\.(crx|zip)$/i, "")
    .replace(/[^a-zA-Z0-9._-]+/g, "_")
    .replace(/^[._]+|[._]+$/g, "")
    .slice(0, 60);
  return `${cleaned || "extension"}-${Date.now()}.crx`;
}

// Resolves with the download id once the CRX is downloaded; the browser then
// shows its "Add extension?" prompt. A failed download is erased.
export async function installCrx(crxBytes, name) {
  const url = URL.createObjectURL(new Blob([crxBytes], { type: CRX_MIME }));
  const filename = crxFilename(name);
  const id = await chrome.downloads.download({ url, filename });
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (err) => {
      if (settled) return;
      settled = true;
      chrome.downloads.onChanged.removeListener(onChanged);
      URL.revokeObjectURL(url);
      if (!err) return resolve(id);
      // An interrupted download may have left a partial file.
      chrome.downloads.removeFile(id).catch(() => {})
        .then(() => chrome.downloads.erase({ id }))
        .finally(() => reject(err));
    };
    const accept = (danger) => {
      if (danger && danger !== "safe" && danger !== "accepted") {
        chrome.downloads.acceptDanger(id).catch((e) => finish(new Error(`accept download of ${filename}: ${e.message}`)));
      }
    };
    const onState = (state, error) => {
      if (state === "complete") finish();
      else if (state === "interrupted") finish(new Error(`download of ${filename} interrupted: ${error || "unknown reason"}`));
    };
    const onChanged = (delta) => {
      if (delta.id !== id) return;
      accept(delta.danger && delta.danger.current);
      onState(delta.state && delta.state.current, delta.error && delta.error.current);
    };
    chrome.downloads.onChanged.addListener(onChanged);
    chrome.downloads.search({ id }).then(([item]) => {
      if (!item) return finish(new Error(`download #${id} of ${filename} vanished`));
      accept(item.danger);
      onState(item.state, item.error);
    });
  });
}
