#!/bin/sh
# Pack nenva's Chrome extension for the Chrome Web Store (docs/BROWSER_EXTENSION_STORE.md).
#
#   scripts/pack-extension.sh            -> dist/nenva-browser-extension-<version>.zip
#
# The zip holds what the app copies into its own profile's extension folder
# (js/main/browser/chrome-runtime.js `_prepare`), except that the manifest
# goes WITHOUT its `key`: the store signs the item with a key of its own and
# derives the id from that (docs/BROWSER_EXTENSION_STORE.md "The id"). The worker,
# the content script, the popup, the fixed host name (config.js), the icons,
# and page-operations.js from js/main/browser (shared with main). Nothing is
# built or minified; what reviewers read is what runs.
set -eu
cd "$(dirname "$0")/.."
version=$(node -p "require('./browser-extension/manifest.json').version")
stage=$(mktemp -d)
trap 'rm -rf "$stage"' EXIT
mkdir -p "$stage/ext" dist
for f in worker.js human-input.js popup.html popup.js config.js; do cp "browser-extension/$f" "$stage/ext/"; done
node -e "const m = require('./browser-extension/manifest.json'); delete m.key; require('fs').writeFileSync('$stage/ext/manifest.json', JSON.stringify(m, null, 2) + '\n');"
cp js/main/browser/page-operations.js "$stage/ext/"
mkdir -p "$stage/ext/icons"; cp browser-extension/icons/*.png "$stage/ext/icons/"
node -e "
const host = require('fs').readFileSync('$stage/ext/config.js', 'utf8').match(/'([^']+)'/)[1];
const expected = require('./js/main/browser/chrome-runtime.js').ChromeRuntime.HOST_NAME;
if (host !== expected) { console.error('config.js names host ' + host + ' but the app registers ' + expected); process.exit(1); }
for (const file of ['worker.js', 'human-input.js', 'popup.js', 'page-operations.js']) new Function(require('fs').readFileSync('$stage/ext/' + file, 'utf8'));
"
out="dist/nenva-browser-extension-$version.zip"
rm -f "$out"
(cd "$stage/ext" && zip -qr "$OLDPWD/$out" .)
echo "wrote $out"
unzip -l "$out" | awk 'NR>3 && $4 != "" {print "  " $4}'
