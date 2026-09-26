#!/usr/bin/env bash
# Copies the demo deck (docs/demo-deck/index.html) into the website, where it is
# served at /demo-deck/index.html. Since 2026-09-22 the site's home page no
# longer embeds it: it tells the same story as scrolling sections in its own
# code (Home.tsx + src/components/sections/story/), so a deck edit has to be
# carried there by hand. This copy is only the standalone deck now.
set -euo pipefail
here="$(cd "$(dirname "$0")/.." && pwd)"
site="${ANJADHE_WEBSITE_DIR:-$here/../anjadhe-website}"
mkdir -p "$site/public/demo-deck"
cp "$here/docs/demo-deck/index.html" "$site/public/demo-deck/index.html"
echo "synced -> $site/public/demo-deck/index.html"
