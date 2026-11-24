// Maps the lib's developer error messages ("<operation> <subject>: <cause>") to
// a plain sentence with the next step. The raw message stays as a detail line.
// Patterns match the stable parts of the messages in src/lib/*.js.

const RULES = [
  // github.js: RateLimitError
  [/rate limit exhausted until (.+?) \(/, (m) =>
    `GitHub's request limit is used up until ${m[1]}. Try again then, or add a GitHub token under Files & settings.`],
  [/^fetch (\S+) releases: HTTP 404/, (m) =>
    `${m[1]} was not found on GitHub. Check the owner/repo spelling; private repositories are not supported.`],
  [/^fetch \S+ releases: HTTP 401/, () =>
    "GitHub rejected the token. Replace or clear it under Files & settings."],
  [/^fetch \S+ releases: HTTP (\d+)/, (m) =>
    `GitHub did not answer the request (HTTP ${m[1]}). Try again later.`],
  // fetch() itself: offline, DNS, blocked
  [/failed to fetch|networkerror|network error|load failed/i, () =>
    "Cannot reach GitHub. Check the connection, then try again."],
  // releases.js parseRepo
  [/^parse repo:/, () =>
    "Enter a repository as owner/repo or a github.com URL, for example gorhill/uBlock."],
  [/^(?:add repo|track \S+): (\S+) is already tracked/, (m) => `${m[1]} is already tracked.`],
  // manager.js: an earlier install of the same version still waits for the browser
  [/was handed to the browser at .* is not confirmed; answer its prompt, or try again after (.+)$/, (m) =>
    `The browser still has an install prompt open for this version. Answer it, or try again after ${m[1]}.`],
  [/signing key was replaced meanwhile; try again/, () => "The signing key changed while this ran. Try again."],
  // store.js backup (before the template rule: a backup can carry a bad template)
  [/^import backup|^backup /, () =>
    "This file is not an Extainium backup, or it is damaged. Choose a file made with Export."],
  // releases.js asset template
  [/^asset template:/, () =>
    "That file name template is not valid. Use {version} for the version and * for any text, for example uBlock0_{version}.chromium.zip."],
  // manager.js install guards
  [/confirm the identity change first/, () =>
    "This release installs as a separate extension. Tap Use the new ID on the card first, or choose another asset."],
  [/^install \S+: no release has an asset matching|^install \S+: no release /, () =>
    "No release has a file that matches the template. Choose the asset again under More."],
  [/^install \S+ \S+: template .* matches \d+ assets/, () =>
    "The template matches several files in this release. Choose the asset under More."],
  [/^install .*: tracked repo .* has no signing key/, () =>
    "That repo has no signing key yet. Sign the file with a new key instead."],
  [/^track \S+: a different signing key/, () =>
    "This repo already has another signing key, so the file cannot be tracked with it. Install the file again, signed with that repo's key."],
  // github.js getBytes / verify, install.js downloads
  [/^download |^accept download|download of .* interrupted|download #\d+ of .* vanished|^verify (?!zip)/, (m, ctx) =>
    `The download or its check failed. Tap ${ctx.retry || "Update"} to retry.`],
  // crx.js, zip.js: package parsing
  [/^parse CRX|^protobuf|^extension ID|^import signing key|^parse zip|^read zip entry|^verify zip|^read manifest|^normalize extension zip/, () =>
    "This is not a valid extension package (.crx or .zip), or the file is damaged."],
  // chrome.management.uninstall when the user cancels the browser dialog
  [/user cancell?ed|uninstall.*cancell?ed|cancell?ed.*uninstall/i, () => "Uninstall cancelled. The repo is still tracked."],
];

// friendly(error or message, { retry: label of the retry button }) -> { text, detail }
export function friendly(err, ctx = {}) {
  const raw = String((err && err.message) || err || "");
  for (const [re, say] of RULES) {
    const m = raw.match(re);
    if (m) return { text: say(m, ctx), detail: raw };
  }
  return { text: "Something unexpected went wrong. The details below help a bug report.", detail: raw };
}
