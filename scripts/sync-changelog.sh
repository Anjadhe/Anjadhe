#!/usr/bin/env bash
# Copy release-notes/*.md into the website's content/changelog/ with the
# frontmatter the site's changelog page and /changelog.json feed read
# (version, date). The date is the tag's commit date; a note whose tag
# isn't cut yet falls back to the note's own last commit date, so the
# website can be prepared before the tag exists.
#
# Usage: scripts/sync-changelog.sh [path-to-anjadhe-website]
# RELEASING.md step 5 runs this next to the Download tag bump.
set -euo pipefail
APP_DIR="$(cd "$(dirname "$0")/.." && pwd)"
SITE_DIR="${1:-$APP_DIR/../anjadhe-website}"
OUT="$SITE_DIR/content/changelog"
[ -d "$SITE_DIR" ] || { echo "website repo not found at $SITE_DIR" >&2; exit 1; }
mkdir -p "$OUT"
n=0
for f in "$APP_DIR"/release-notes/v*.md; do
    tag="$(basename "$f" .md)"
    date="$(git -C "$APP_DIR" log -1 --format=%cs "$tag" -- 2>/dev/null || true)"
    [ -n "$date" ] || date="$(git -C "$APP_DIR" log -1 --format=%cs -- "$f")"
    [ -n "$date" ] || date="$(date +%F)"
    {
        printf -- '---\nversion: %s\ndate: %s\n---\n' "${tag#v}" "$date"
        # Drop the "# vX" heading — the page renders the version itself.
        sed -e '1{/^# /d;}' -e '1{/^$/d;}' "$f"
    } > "$OUT/$tag.md"
    n=$((n+1))
done
echo "synced $n release notes → $OUT"
