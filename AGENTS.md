# AGENTS.md

Extainium: a Manifest V3 extension for the Titanium Android browser (Chromium) that tracks GitHub repos and installs and updates their release `.crx`/`.zip` files as browser extensions; it also tracks Chrome Web Store items and self-hosted (`update_url`) extensions (`src/lib/sources.js`, records `cws:<id>` / `url:<id>`), also on desktop ungoogled-chromium. Plain JavaScript, no framework, no bundler.

- `src/lib/` is ES modules shared by the extension and the node tests; UI files (`src/options.js`, `src/popup.js`, `src/friendly.js`, `src/theme*.js`) import from it, never the other way round.
- Every exported state-changing function in `src/lib/manager.js` is wrapped by `operation()` (Web Lock `extainium-op`, held across all extension contexts for the whole operation). Inside an operation call the internal `…Now` functions, never another exported operation: that deadlocks (`test/oplock.test.js` covers it). Event handlers (`handleExtensionInstalled`, `sweepDownloads`) take only `withStateLock` from `src/lib/store.js`.
- Read-modify-write of `chrome.storage.local` goes through `withStateLock` / `updateRepo` in `src/lib/store.js`.
- Signing keys live in `key:<owner/repo>` and `filekey:<extension id>` storage entries, one place per key. Never print or log key material; backups contain keys.
- `src/friendly.js` maps lib error messages to UI text by matching their wording. Changing an error message in `src/lib/` requires updating the matching rule there.
- New hosts go in `optional_host_permissions` only (a new required host disables the extension on update until re-approved); the UI requests a record's `needsOrigins` in the click handler. Update-server and CRX fetches go through `fetchFrom` in `src/lib/net.js`: a redirect to a host without a permission fails naming that origin (read from `webRequest.onBeforeRedirect`), and the record keeps it in `redirectOrigins`, so `needsOrigins` lists it.
- One record per extension ID: adding, tracking and backup import refuse or skip a second record of an ID.
- `src/manifest.json` `version` is the only version. Bump it for every build installed on a device: Chromium updates in place only to a higher version.
- `DESIGN.md` holds the UI decisions; style with the tokens in `src/style.css`, no new colours.
- `dist/` and the signing key are build outputs; never commit them.

## Commands

| Command | What it does |
| --- | --- |
| `npm test` | Full suite (node --test with fast-check). Needs `python3` for the `updates.xml` property test. Run before handoff. |
| `./build.sh` | Writes `dist/extainium.crx` signed with `$EXTAINIUM_PEM` (default `~/.config/extainium/extainium.pem`, created if missing). Needs `zip`. |
| `scripts/release.sh` | Publishes a GitHub release for the manifest version with `update_url` set. Public and irreversible: run only when the user asks for a release. |
| `python3 test/fixtures/make-zip-fixtures.py` | Regenerates the zip fixtures; `node test/fixtures/make-crx-fixtures.js` the CRX fixtures. |

## Tests in test/

- The stored-data migration runs once per module load: a test that needs a fresh migration goes in its own test file.
- Update servers: `test/helpers/fake-update.js` serves the real saved answers listed in `test/fixtures/SOURCES.md`, and redirects as Chromium handles them for an extension (`redirects` option); `fakeChrome`'s `env.setPlatform("desktop")`, `env.granted` (host permissions) and `env.runtimeId` cover the desktop and permission paths.
- Use the fakes in `test/helpers/fake-chrome.js` and `test/helpers/fake-locks.js`; expected results come from specs or independent references (node:crypto, Python's zipfile and XML parser), not from Extainium's own encoders.

## Testing on a device

- Titanium installs a CRX only from a download started by an extension page and served as `application/x-chrome-extension`. To sideload a build: serve `dist/extainium.crx` with that Content-Type, `adb reverse` the port, and open `chrome-extension://jlbggdgofbcndkkdimpeccablefilpkm/install.html#<url-encoded crx URL>` (Titanium's bundled helper) in a normal tab, not a Custom Tab. Close open Extainium tabs first, or the update waits.
- DevTools: `adb forward tcp:<port> localabstract:chrome_devtools_remote`; with several adb devices set `ANDROID_SERIAL`.
