#!/bin/bash
# Builds dist/extainium.zip and dist/extainium.crx, signed with
# $EXTAINIUM_PEM (default ~/.config/extainium/extainium.pem, generated if missing).
set -euo pipefail
cd "$(dirname "$0")"
KEY="${EXTAINIUM_PEM:-$HOME/.config/extainium/extainium.pem}"
rm -rf dist && mkdir -p dist
(cd src && zip -qrX ../dist/extainium.zip . -x '.*')
node scripts/pack-crx.js dist/extainium.zip "$KEY" dist/extainium.crx
