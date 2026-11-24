# Extainium

Install and update browser extensions from GitHub releases, the way
[Obtainium](https://github.com/ImranR98/Obtainium) does for Android apps. Built for
[Titanium Browser for Android](https://github.com/jqssun/android-titanium-browser).

- Track a GitHub repo (`owner/repo` or any github.com URL of it), pick the release
  asset (`.crx` or `.zip`) once; a file name template such as
  `uBlock0_{version}.chromium.crx` (`{version}` for the version, `*` for any text)
  finds it in later releases.
- See installed vs. latest version, release date and notes; a check runs every 6
  hours (and on demand), and the toolbar badge counts available updates. A check
  first reads the repo's `releases.atom` feed, which costs no GitHub API quota,
  and skips the API only when the feed shows nothing it could have missed: the
  release selected last time is in the feed with the update time the API
  reported, and the feed's entries (ids and update times) are exactly those the
  last full check saw. A full API check also runs when the release cache is
  empty, the asset template or pre-release setting changed, the last one is more
  than 24 hours old, or the feed is unavailable or not in GitHub's plain Atom
  form.
- Install or update with one tap. A `.crx` keeps its author's key and extension ID;
  its CRX3 signatures (RSA and ECDSA P-256) are verified as Chromium does before
  it is handed to the browser, and a damaged or altered file is refused.
  A `.zip` is packed into a CRX signed with a key Extainium creates once per repo,
  so updates keep the same extension ID and its data.
- Install a local `.crx`/`.zip` and optionally track it with a repo. A local `.zip`
  can be signed with a tracked repo's key, with the key of an earlier untracked
  file install, or with a new key. The key of a `.zip` installed without a repo is
  kept (and exported) until the file is tracked with a repo, which takes it over
  (if that repo's first check fails, the key goes back to the file keys), or
  until you forget it under Files & settings > Kept keys; a `.zip` signed for
  that extension later installs as a different extension. A key is stored in
  one place only: an import does not give a key another repo owns to a second
  repo.
  A local `.crx` keeps its author's key and never changes which extension a
  tracked repo follows.
- Export/import the list, including the per-repo signing keys and the keys of
  untracked file installs (backup format 3; files of format 1 and 2 still
  import). Removing a repo keeps its key (it re-attaches if the repo is added
  again); only "remove and uninstall" deletes it, and only once no install
  signed with it is still downloading or waiting at the browser's prompt (at
  most two minutes after its download completed). An import never replaces a
  different stored key.
- Actions run one at a time across the options page, the popup and the
  background check: an install holds the others until its download has
  completed (not until you answer the browser's prompt). An action that has
  to wait says "Waiting for another action…".

## How it installs

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

## Known limitations

- On Titanium a saved backup did not show up in `chrome.downloads.search`
  afterwards, although the browser reported the download complete and the file
  was in Downloads. Chromium 158's source shows no path that hides such a download
  (the location dialog keeps the same download item; search hides only temporary
  and internal downloads); the cause is open. Extainium reports the export from
  the download's own events; a search may only add a result and never delays it. If no end is
  reported within two minutes, it says it could not confirm the save.
- The extension-less CRX file name that avoids the "Confirm download / Keep"
  step follows from Chromium's source and still needs a check on the phone.

## Privacy

Extainium talks to `api.github.com` and GitHub's release download hosts only. An
optional GitHub token (raises the API limit from 60 to 5000 requests per hour) is
kept in `chrome.storage.local` and sent only to `api.github.com`. The backup file
contains the signing keys of your `.zip`-based extensions: keep it private.
Without those keys a reinstall gets a new extension ID and loses its data.

## Build

```sh
npm install
npm test        # node --test, logic in src/lib
python3 test/fixtures/make-zip-fixtures.py   # regenerates the zip fixtures
./build.sh      # dist/extainium.zip and dist/extainium.crx
```

`build.sh` signs the CRX with `~/.config/extainium/extainium.pem` (or
`$EXTAINIUM_PEM`) and creates that key, mode 600, if it is missing. The key fixes
Extainium's own extension ID; keep it to publish updates.

Self-hosted updates are prepared but off. Two optional environment variables,
unset by default, turn them on:

```sh
EXTAINIUM_UPDATE_URL=https://host/extainium/updates.xml \
EXTAINIUM_CODEBASE=https://host/extainium/extainium.crx ./build.sh
```

- `EXTAINIUM_UPDATE_URL` is inserted as `update_url` into the built manifest
  (`src/manifest.json` is not changed). The browser then polls that URL.
- `EXTAINIUM_CODEBASE` makes the build write `dist/updates.xml`, the
  [gupdate update manifest](https://developer.chrome.com/docs/extensions/how-to/distribute/host-on-linux#update_manifest)
  with the extension ID derived from the signed CRX
  (`jojihfmjoonfhnjlioapjefjmdcddgol` with the release key), the manifest version,
  and the CRX URL.

Publish `dist/extainium.crx` at the codebase URL and `dist/updates.xml` at the
update URL. A build without `update_url` cannot later learn one: the first build
users install must carry it.

Layout: `src/lib/` holds the logic as ES modules shared by the extension and the
tests (`crx.js` CRX3 parse/pack/ID, `zip.js`, `releases.js` repo parsing,
versions, asset templates and update state, `github.js` API access, `store.js`
storage and backup, `install.js`, `manager.js` operations). `src/options.*` and
`src/popup.*` are the UI.

## Credits and license

Extainium is a fork of the
[Titanium extension](https://github.com/jqssun/android-titanium-extension) by
jqssun, whose CRX3 packer and zip handling it builds on. GPL-2.0, see
[LICENSE](LICENSE).
