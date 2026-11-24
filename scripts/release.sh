#!/bin/bash
# Publishes a GitHub release of the version in src/manifest.json:
# builds with update_url pointing at the latest release's updates.xml, then
# uploads extainium.crx, extainium.zip and updates.xml to tag v<version>.
# Needs: gh (logged in, with push rights to the repo), a clean committed tree
# that is pushed, and the signing key build.sh uses ($EXTAINIUM_PEM).
set -euo pipefail
cd "$(dirname "$0")/.."

version="$(node -p 'JSON.parse(require("fs").readFileSync("src/manifest.json", "utf8")).version')"
tag="v$version"
# owner/repo of the origin remote (gh's default repo may be another remote, e.g. upstream).
origin_url="$(git remote get-url origin)"
repo="${EXTAINIUM_REPO:-$(printf '%s\n' "$origin_url" | sed -E 's#^(https://github\.com/|git@github\.com:)##; s#\.git$##')}"
case "$repo" in
  */*) ;;
  *) echo "release: cannot read owner/repo from origin $origin_url; set EXTAINIUM_REPO" >&2; exit 1 ;;
esac

if [ -n "$(git status --porcelain)" ]; then
  echo "release $tag: the working tree has uncommitted changes" >&2
  exit 1
fi
if gh release view "$tag" --repo "$repo" >/dev/null 2>&1; then
  echo "release $tag: already exists in $repo; bump the version in src/manifest.json" >&2
  exit 1
fi
head="$(git rev-parse HEAD)"
git fetch --quiet origin
if ! git branch -r --contains "$head" | grep -q .; then
  echo "release $tag: commit $head is not pushed to origin" >&2
  exit 1
fi

export EXTAINIUM_UPDATE_URL="https://github.com/$repo/releases/latest/download/updates.xml"
export EXTAINIUM_CODEBASE="https://github.com/$repo/releases/download/$tag/extainium.crx"
npm test
./build.sh

gh release create "$tag" --repo "$repo" --target "$head" --title "Extainium $version" \
  --notes "Install: download extainium.crx below, then in Titanium open the extensions menu > Titanium > Options > Install from file and pick it. Installed copies update themselves from this repo's latest release." \
  dist/extainium.crx dist/extainium.zip dist/updates.xml
echo "released $tag to https://github.com/$repo/releases/tag/$tag"
