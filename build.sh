#!/bin/bash
# Builds dist/extainium.zip and dist/extainium.crx, signed with
# $EXTAINIUM_PEM (default ~/.config/extainium/extainium.pem, generated if missing).
# Self-hosted updates (both optional, unset by default):
#   EXTAINIUM_UPDATE_URL  inserted as "update_url" into the built manifest
#   EXTAINIUM_CODEBASE    URL of the published extainium.crx; dist/updates.xml is
#                         written for it (serve that file at EXTAINIUM_UPDATE_URL)
set -euo pipefail
cd "$(dirname "$0")"
KEY="${EXTAINIUM_PEM:-$HOME/.config/extainium/extainium.pem}"
rm -rf dist && mkdir -p dist
stage="$(mktemp -d)"
trap 'rm -rf "$stage"' EXIT
cp -Rp src/. "$stage"
node scripts/release-files.js manifest "$stage/manifest.json"
(cd "$stage" && zip -qrX "$OLDPWD/dist/extainium.zip" . -x '.*')
node scripts/pack-crx.js dist/extainium.zip "$KEY" dist/extainium.crx
node scripts/release-files.js updates dist/extainium.crx "$stage/manifest.json" dist/updates.xml
