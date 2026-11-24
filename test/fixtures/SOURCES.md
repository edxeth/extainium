# Fixtures of the CWS and update-URL sources

Fetched with curl on 2026-11-24 (anonymous, no cookies), saved unchanged:

- `cws-updatecheck-3ids.xml`: `GET https://clients2.google.com/service/update2/crx?response=updatecheck&acceptformat=crx3&prodversion=158.0.8127.100&x=id%3D<id>%26v%3D0.0.0.0%26uc` for Just Black (aghfnjkcakhmadgdomlmlhhaocbkloab), Dark Reader (eimadpbcbfnmbkopoojfekhnkhdbieeh) and uBlock Origin Lite (ddkjiahejlhfcafbddmgiahcphecmpfh).
- `cws-noupdate-malware-unknown.xml`: the same request for uBlock Origin MV2 (cjpalhdlnbpafiamejdnhcphjbkeiagm, noupdate), The Great Suspender (klbibkeccnjlkjkiokjodocebajanakg, noupdate with _malware="true") and aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa (error-unknownApplication).
- `cws-just-black-3.crx`: the codebase of Just Black in the first answer (6593 bytes, sha256 97146df4dd16804575c8599cea9e7f49412f4e369f64c631e38c09bf111c7bb3, both as the answer announces). Carries Google's publisher proof.
- `ublock-jsdelivr-update.xml`: `GET https://cdn.jsdelivr.net/gh/gorhill/uBlock@master/dist/chromium/update.xml`, the update_url of uBlock Origin's self-hosted CRX.
