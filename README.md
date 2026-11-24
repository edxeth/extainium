# Extainium

Install and update browser extensions from GitHub releases, the way
[Obtainium](https://github.com/ImranR98/Obtainium) does for Android apps. Built for
[Titanium Browser for Android](https://github.com/jqssun/android-titanium-browser).

- Track a GitHub repo (`owner/repo` or any github.com URL of it), pick the release
  asset (`.crx` or `.zip`) once; a file name template such as
  `uBlock0_{version}.chromium.crx` (`{version}` for the version, `*` for any text)
  finds it in later releases.
- See installed vs. latest version, release date and notes; a check runs every 6
  hours (and on demand), and the toolbar badge counts available updates.
- Install or update with one tap. A `.crx` keeps its author's key and extension ID.
  A `.zip` is packed into a CRX signed with a key Extainium creates once per repo,
  so updates keep the same extension ID and its data.
- Install a local `.crx`/`.zip` and optionally track it with a repo. A local `.zip`
  can be signed with a tracked repo's key; a local `.crx` keeps its author's key and
  never changes which extension a tracked repo follows.
- Export/import the list, including the per-repo signing keys. Removing a repo
  keeps its key (it re-attaches if the repo is added again); only "remove and
  uninstall" deletes it. An import never replaces a different stored key.

## How it installs

Titanium allows off-store CRX installs when the download is started by an
extension page. Extainium downloads the CRX through `chrome.downloads`; Titanium
then shows its "Add extension?" prompt. An install counts once the browser reports
it (`management.onInstalled` with the expected ID and version), not when the
download finishes. As that event names no particular build, a second, different
build of the same extension version is refused for two minutes while the first
may still be at its prompt. The CRX copy in Downloads is deleted after the
install, or two minutes after a declined or failed one, and never while the
download is still running. A release or file that would install under another
extension ID than the installed one waits for your confirmation.

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
