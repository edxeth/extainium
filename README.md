# Extainium

Install and update browser extensions from GitHub releases, the way
[Obtainium](https://github.com/ImranR98/Obtainium) does for Android apps. Built for
[Titanium Browser for Android](https://github.com/jqssun/android-titanium-browser),
a Chromium browser with desktop extension support.

## Install

1. In Titanium, open the [latest release](../../releases/latest) and tap
   `extainium.crx`; in "Choose where to download" tap **Download**.
2. Open the main menu (⋮) > **Extensions** > **Open extensions menu**, tap ⋮ next
   to **Titanium** > **Options** (the "Titanium Extension" page).
3. Under **Extension marketplaces**, at **Install from file**, tap **Set**, pick
   `extainium.crx`, then tap **Go**.
4. Titanium may ask "Download file again?" (tap **Download**) and "Confirm
   download" (tap **Keep**). Then tap **Add extension** and **Got it**.
5. Extainium updates itself from this repo's latest release. An update takes
   effect once no Extainium tab is open; to update right away, tap **Update** on
   Titanium's extensions page (developer mode).

Titanium's extensions page lists Extainium under "Review 1 extension that may
be unsafe" ("can't verify where this extension comes from"). Chromium shows
this for every extension whose update address is not the Chrome Web Store's,
and nothing in an extension can avoid it. Tap **Keep this extension** once; it
stays dismissed across updates.

## Use

- **Track a repo:** type `owner/repo` or paste any github.com link of it, then
  pick the release file (`.crx` or `.zip`). Extainium remembers a file
  name template such as `uBlock0_{version}.chromium.crx` (`{version}` for the
  version, `*` for any text) to find the same file in later releases.
- **Updates:** a check runs every 6 hours and on demand (**Check all**); the
  toolbar badge counts available updates. Tap **Update** on a card; Titanium
  asks once to add the extension.
- **Pre-releases:** off by default; turn on **Include pre-releases** per repo under
  **More**. **Install a specific release** there installs any listed release.
- **Install from file:** install a local `.crx` or `.zip` and optionally track it
  with a repo afterwards.
- **Backup:** **Files & settings** > **Export** saves the list and signing keys;
  **Import** restores it.
- **Theme:** System, Light or Dark under **Files & settings**.
- **GitHub token (optional):** raises GitHub's limit from 60 to 5000 API requests
  per hour. A fine-grained token with no permissions is enough for public repos.

## How it works

- A `.crx` keeps its author's key and extension ID. Its CRX3 signatures (RSA
  and ECDSA P-256) are verified as Chromium does before install; a damaged or
  altered file is refused.
- A `.zip` is packed into a CRX signed with a key Extainium creates once per
  repo, so updates keep the same extension ID and the extension's data. The
  key of a `.zip` installed from a file without a repo is kept under
  **Files & settings** > **Kept keys** until the file is tracked or the key is
  forgotten.
- Removing a repo keeps its key, and it re-attaches if the repo is added again.
  Only **Remove and uninstall** deletes it (two taps), once no install signed
  with it is still downloading or waiting at the browser's prompt. An import
  never replaces a stored key with a different one.
- A check first reads the repo's `releases.atom` feed, which costs no API
  quota, and calls the GitHub API only when the feed shows a change, the asset
  template or pre-release setting changed, the last full check is over 24 hours
  old, or the feed is unavailable or not in GitHub's plain Atom form.
- A release or file that would install under a different extension ID than the
  installed one waits for your confirmation, because the extension's data does
  not carry over.
- Actions run one at a time across the options page, the popup and the
  background check. An action that has to wait says "Waiting for another
  action…". While Titanium's Add or uninstall prompt is open, other actions
  wait for your answer; closing the page releases them.

### How the install works on Titanium

Titanium allows off-store CRX installs when the download is started by an
extension page. Extainium downloads the CRX through `chrome.downloads`; Titanium
then shows its "Add extension?" prompt. The download's file name has no
extension (e.g. `uBlock_Origin-1_77_0-1795526022241`): Chromium rates a `.crx`
file downloaded without a user gesture as dangerous and then asks "Confirm
download / Keep" before the prompt, while it recognises the CRX by its MIME type
whatever the name (Chromium 158: `download_file_types.asciipb` `crx` entry,
`download_target_determiner.cc` `GenerateSafeFileName`, `extensions::IsExtensionDownload`).
An install counts once the browser reports
it (`management.onInstalled` with the expected ID and version), not when the
download finishes. That event names no particular build, but Titanium's prompt
is modal, so a new install of the same extension version replaces an earlier
one still waiting once its own download completed (its prompt is up): the
event confirms the newest prompt. A replacement still downloading, or one that
fails, replaces nothing. Because installs run one at a time, a second one starts only
after the first one's download completed. If the page closes before an install's
download even started, the install counts as failed after ten minutes. The CRX copies in Downloads are deleted after the
install, or two minutes after the prompt of a declined or failed one, and
never while the download is still running. A release or file that would
install under another extension ID than the installed one waits for your
confirmation.

## Privacy

Extainium connects only to GitHub: `api.github.com`, `github.com` (release
feeds and download links) and GitHub's release download hosts
(`objects.githubusercontent.com`, `release-assets.githubusercontent.com`).
It sends no data anywhere else. The optional token is kept in
`chrome.storage.local` and sent only to `api.github.com`. The backup file
contains the signing keys of your `.zip`-based extensions: keep it private.
Without those keys a reinstall gets a new extension ID and loses its data.

## Build

Needs Node.js 22 or later, `zip`, and `python3` for one test.

```sh
npm install
npm test
./build.sh      # dist/extainium.zip and dist/extainium.crx
```

`build.sh` signs the CRX with `$EXTAINIUM_PEM` (default
`~/.config/extainium/extainium.pem`) and creates that key, mode 600, if it is
missing. The key fixes the extension ID: a build signed with your own key is a
separate extension from the published one.

Two optional environment variables turn on self-hosted updates:

- `EXTAINIUM_UPDATE_URL` is inserted as `update_url` into the built manifest
  (`src/manifest.json` is not changed). The browser polls that URL.
- `EXTAINIUM_CODEBASE` is the URL of the published `extainium.crx`; the build
  then writes `dist/updates.xml`, the
  [update manifest](https://developer.chrome.com/docs/extensions/how-to/distribute/host-on-linux#update_manifest)
  for it.

`scripts/release.sh` sets both for this repo's GitHub releases, builds, and
publishes `extainium.crx`, `extainium.zip` and `updates.xml` as release
`v<version>` (needs `gh`, a clean pushed tree, and a new version in
`src/manifest.json`).

Layout: `src/lib/` holds the logic as ES modules shared by the extension and
the tests; `src/options.*` and `src/popup.*` are the UI; `DESIGN.md` records the
UI decisions.

## Credits and license

Extainium is a fork of the
[Titanium extension](https://github.com/jqssun/android-titanium-extension) by
jqssun, whose CRX3 packer and zip handling it builds on. GPL-2.0, see
[LICENSE](LICENSE).
