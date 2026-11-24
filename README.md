# Extainium

Install and update browser extensions from GitHub releases, the way
[Obtainium](https://github.com/ImranR98/Obtainium) does for Android apps. Built for
[Titanium Browser for Android](https://github.com/jqssun/android-titanium-browser).

- Track a GitHub repo (`owner/repo` or any github.com URL of it), pick the release
  asset (`.crx` or `.zip`) once; a file-name pattern finds it in later releases.
- See installed vs. latest version, release date and notes; a check runs every 6
  hours (and on demand), and the toolbar badge counts available updates.
- Install or update with one tap. A `.crx` keeps its author's key and extension ID.
  A `.zip` is packed into a CRX signed with a key Extainium creates once per repo,
  so updates keep the same extension ID and its data.
- Install a local `.crx`/`.zip` and optionally track it with a repo.
- Export/import the list, including the per-repo signing keys.

## How it installs

Titanium allows off-store CRX installs when the download is started by an
extension page. Extainium downloads the CRX through `chrome.downloads`; Titanium
then shows its "Add extension?" prompt. The CRX copy in Downloads is deleted after
the install, or two minutes after a declined or failed one.

## Privacy

Extainium talks to `api.github.com` and GitHub's release download hosts only. An
optional GitHub token (raises the API limit from 60 to 5000 requests per hour) is
kept in `chrome.storage.local` and sent only to `api.github.com`. The backup file
contains the signing keys of your `.zip`-based extensions: keep it private.
Without those keys a reinstall gets a new extension ID and loses its data.

## Build

```sh
npm install
npm test        # node --test, pure logic in src/lib
./build.sh      # dist/extainium.zip and dist/extainium.crx
```

`build.sh` signs the CRX with `~/.config/extainium/extainium.pem` (or
`$EXTAINIUM_PEM`) and creates that key, mode 600, if it is missing. The key fixes
Extainium's own extension ID; keep it to publish updates.

Layout: `src/lib/` holds the logic as ES modules shared by the extension and the
tests (`crx.js` CRX3 parse/pack/ID, `zip.js`, `releases.js` repo parsing,
versions, asset patterns and update state, `github.js` API access, `store.js`
storage and backup, `install.js`, `manager.js` operations). `src/options.*` and
`src/popup.*` are the UI.

## Credits and license

Extainium is a fork of the
[Titanium extension](https://github.com/jqssun/android-titanium-extension) by
jqssun, whose CRX3 packer and zip handling it builds on. GPL-2.0, see
[LICENSE](LICENSE).
