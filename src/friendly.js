// Maps the lib's developer error messages ("<operation> <subject>: <cause>") to
// a plain sentence with the next step. The raw message stays as a detail line.
// Patterns match the stable parts of the messages in src/lib/*.js.

const hostOf = (origin) => origin.replace(/^[a-z]+:\/\//, "").replace(/\/\*?$/, "");
// The store's hosts read as "the Chrome Web Store"; another update server by its host name.
const serverName = (host) => (/(?:^|\.)(?:google\.com|googleusercontent\.com)$/.test(host) ? "the Chrome Web Store" : host);

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
  // manager.js fetchFrom: "check <key>: cannot reach <host> (<fetch error>)", also inside install and download.
  [/(?:^|: )(?:check|download) (?:cws|url):\S+(?: \S+)?: cannot reach (\S+) \(/, (m) =>
    `Cannot reach ${serverName(m[1])}. Check the connection, then try again.`],
  // fetch() itself: offline, DNS, blocked. Names the server when the message says which.
  [/failed to fetch|networkerror|network error|load failed/i, (m, ctx, raw) =>
    `Cannot reach ${/google\.com|googleusercontent|\bcws\b|web ?store/i.test(raw) ? "the Chrome Web Store"
      : /github/i.test(raw) || !/https?:\/\/|\burl:/.test(raw) ? "GitHub" : "the update server"}. Check the connection, then try again.`],

  // ---- Sources (Chrome Web Store, self-hosted update URLs) ----
  // Patterns follow the messages of src/lib/manager.js and src/lib/sources.js (sources-lib
  // report, "New error messages"). A failed install re-checks first, so check messages can
  // arrive wrapped as "install <key>: check <key>: ...": those rules are not anchored.
  // The UI's own message when the permission prompt was declined (options.js requestOrigins).
  [/^grant access: (.+) was not granted/, (m) =>
    `Extainium was not allowed to reach ${m[1]}, so nothing changed. Try again and choose Allow.`],
  // check or install without the host permission (e.g. a record restored from a backup).
  [/: no host permission for (\S+(?:, \S+)*)$/, (m) =>
    `Extainium needs access to ${m[1].split(", ").map(hostOf).join(" and ")}, so nothing was checked or installed. Try again and choose Allow when the browser asks.`],
  // sources.js parseSourceInput
  [/^parse source: no extension ID .* in the Chrome Web Store link/, () =>
    "That Chrome Web Store link has no extension ID. Copy the link from the extension's own store page."],
  [/^parse source: .* is not an extension ID/, () =>
    "An extension ID has exactly 32 letters from a to p. Check the ID, or paste the store link instead."],
  // the update server is down or refuses
  [/(?:^|: )check (?:cws|url):\S+: HTTP (\d+) from (\S+)/, (m) =>
    `${serverName(m[2])} did not answer (HTTP ${m[1]}). Try again later.`],
  [/^download (?:cws|url):\S+ \S+: HTTP (\d+) from (\S+)/, (m, ctx) =>
    `The download from ${serverName(m[2])} failed (HTTP ${m[1]}). Tap ${ctx.retry || "Update"} to retry.`],
  // store answers about the extension itself
  [/the Chrome Web Store does not know this extension/, () =>
    "The Chrome Web Store does not know this extension. It was removed from the store, or the ID is wrong."],
  [/^install cws:\S+: the Chrome Web Store offers no build of this extension to this browser/, () =>
    "The Chrome Web Store does not offer this extension to this browser. It may need a newer browser, still use Manifest V2, or be unlisted."],
  [/^install url:\S+: (\S+) offers no build of this extension to this browser/, (m) =>
    `${m[1]} offers no build of this extension to this browser, so there is nothing to install.`],
  [/^install url:\S+: the update server offers nothing newer than the installed version (\S+)/, (m) =>
    `Version ${m[1]} is already the newest one its update server offers.`],
  [/^check url:\S+: (\S+) lists no update for this extension/, (m) =>
    `${m[1]} does not list this extension in its update feed. The author may have moved it; check the extension's homepage.`],
  [/the announced codebase is not an https URL/, () =>
    "The update server points to a download that is not https, so Extainium does not use it."],
  // an answer that does not parse strictly or does not fit the request
  [/parse update manifest:|the update server's answer (?:lists extension|has no entry)|the update server answered (?:updatecheck )?status|the update server's answer has no <updatecheck>|the announced (?:version|size|hash_sha256) is not|the update server announced no (?:size|hash_sha256)|does not fit a URL of/, () =>
    "The update server sent an answer Extainium cannot use. Try again later; if it stays, the extension's update feed has changed."],
  // the download is not what the server announced
  [/^install (?:cws|url):\S+: (?:downloaded \d+ bytes, the update server announced|the download's sha256 \S+ does not match)/, (m, ctx) =>
    `The download was incomplete or changed on the way, so it was not installed. Tap ${ctx.retry || "Update"} to retry.`],
  [/^install (?:cws|url):\S+: the download from (\S+) is not a CRX file/, (m) =>
    `${serverName(m[1])} sent something that is not an extension file, so nothing was installed. Try again later.`],
  [/no proof is signed with Google's publisher key|publisher proof/, () =>
    "This file is not signed by the Chrome Web Store, so it was not installed."],
  [/^install (?:cws|url):\S+: the CRX installs as extension \S+, not as/, () =>
    "The download belongs to a different extension than the tracked one, so it was not installed."],
  [/^install (?:cws|url):\S+: the CRX holds version "([^"]*)", the update server announced (\S+)/, (m) =>
    `The download holds version ${m[1]}, not the announced ${m[2]}, so it was not installed. Try again later.`],
  [/^install (?:cws|url):\S+: not a GitHub repo, so there is no release/, () =>
    "Store and self-hosted extensions install only their newest version."],
  [/^(?:set template|set pre-releases) of \S+: \S+ is not a GitHub repo/, () =>
    "Store and self-hosted extensions have no release files to choose from."],
  // tracking and linking installed extensions (Installed tab, Add)
  [/^(?:add repo|track \S+|link \S+ to \S+): extension \S+ is already tracked as (\S+)/, (m) =>
    `This extension is already tracked${/^(?:cws|url):/.test(m[1]) ? "" : ` as ${m[1]}`}. Its card is on the Extensions tab.`],
  [/^(?:add repo|track \S+|link \S+ to \S+): (?:cws|url):\S+ is already tracked/, () =>
    "This extension is already tracked. Its card is on the Extensions tab."],
  [/^track \S+: no installed extension has this ID/, () =>
    "This extension is no longer installed, so nothing was tracked."],
  [/^link \S+ to \S+: no installed extension has this ID/, () =>
    "This extension is no longer installed, so nothing was linked."],
  [/^track \S+: (.+) cannot be tracked through its own update server: the browser provides it/, (m) =>
    `${m[1]} is provided by the browser, so Extainium does not update it.`],
  [/^track \S+: (.+) cannot be tracked through its own update server: it has no update URL/, (m) =>
    `${m[1]} has no update server of its own. Use Link repo to follow its GitHub releases instead.`],
  [/^track \S+: (.+) cannot be tracked through its own update server: its update URL is not https/, (m) =>
    `${m[1]} updates over plain http, which Extainium does not trust. Use Link repo to follow its GitHub releases instead.`],
  [/^link \S+ to \S+: (.+) is provided by the browser$/, (m) =>
    `${m[1]} is provided by the browser, so it cannot be linked to a repo.`],
  [/^link \S+ to \S+: (.+) updates from its own update URL \S+; track it instead/, (m) =>
    `${m[1]} updates from its own server. Use Track instead.`],
  [/^link \S+: not a GitHub repository:/, () =>
    "Enter the extension's GitHub repository as owner/repo or a github.com link."],
  [/^read browser version:/, () =>
    "Extainium could not read this browser's version, which the Chrome Web Store check needs. Report this with the details below."],
  // ---- end of Sources ----

  // releases.js parseRepo
  [/^parse repo:/, () =>
    "Enter a repository as owner/repo or a github.com URL, for example gorhill/uBlock."],
  [/^(?:add repo|track \S+|link \S+ to \S+): (\S+) is already tracked/, (m) => `${m[1]} is already tracked.`],
  // manager.js: the repo was removed while its install or key ran
  [/^(?:install|sign) (\S+): the repo is no longer tracked/, (m) =>
    `${m[1]} is no longer tracked, so nothing was installed. Add it again to install it.`],
  // manager.js installFile with a file key that is gone (e.g. moved to a tracked repo meanwhile)
  [/^install .*: no file key is stored for extension (\S+)/, (m) =>
    `The key of extension ${m[1]} is no longer stored. Choose the key again: once that extension is tracked, its key is listed under its repo.`],
  [/signing key was replaced meanwhile; try again/, () => "The signing key changed while this ran. Try again."],
  // manager.js saveBackup: the browser refused to start the download
  [/^save backup /, () => "The backup was not saved: the browser did not start the download. Tap Export to try again."],
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
  // crx.js verifyCrx: the CRX's signature does not check out (before the download rule,
  // which keeps GitHub's digest check)
  [/^verify (?!zip:).*?: (?:the header has no signed crx_id|the signed crx_id has|an? (?:RSA|ECDSA) proof lacks|the key of (?:RSA|ECDSA) proof|the (?:RSA|ECDSA) signature of key|no proof's key derives)/, () =>
    "The file's signature does not check out: it may be damaged or tampered with, so it was not installed. Download it again, or ask its author."],
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
    if (m) return { text: say(m, ctx, raw), detail: raw };
  }
  return { text: "Something unexpected went wrong. The details below help a bug report.", detail: raw };
}
