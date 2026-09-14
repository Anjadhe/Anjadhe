#!/usr/bin/env bash
# Copies the demo deck (docs/demo-deck/index.html, the source of truth) into the
# website, where it is served at /demo-deck/index.html and embedded in the home
# hero (HeroDeck.tsx). Run after editing the deck; commit the website copy there.
set -euo pipefail
here="$(cd "$(dirname "$0")/.." && pwd)"
site="${ANJADHE_WEBSITE_DIR:-$here/../anjadhe-website}"
mkdir -p "$site/public/demo-deck"
cp "$here/docs/demo-deck/index.html" "$site/public/demo-deck/index.html"
echo "synced -> $site/public/demo-deck/index.html"
