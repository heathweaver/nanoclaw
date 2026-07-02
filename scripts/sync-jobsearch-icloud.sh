#!/bin/bash
# Sync per-job application files from the jobsearch group workspace into iCloud
# Drive, one folder per job (named for the job slug), so they appear on Heath's
# other Mac. Runs on the host (the container can't reach iCloud). Idempotent:
# copies only when the source is newer. Invoked on an interval by launchd.

set -u
GROUP="/Users/heathweaver/Development/nanoclaw/groups/jobsearch"
APPS="$GROUP/applications"
CV="$GROUP/cv"
ICLOUD="$HOME/Library/Mobile Documents/com~apple~CloudDocs/Job Applications"

mkdir -p "$ICLOUD"
[ -d "$APPS" ] || exit 0

shopt -s nullglob
for pkg in "$APPS"/*.package.md; do
  base="$(basename "$pkg")"
  slug="${base%.package.md}"
  [ -n "$slug" ] || continue
  dest="$ICLOUD/$slug"
  mkdir -p "$dest"
  # Everything in applications/ whose name starts with the slug (package, cover,
  # cover+cases, screenshots), plus any CV whose name contains the slug.
  for f in "$APPS/$slug"*; do
    [ -f "$f" ] && cp -p -n "$f" "$dest/" 2>/dev/null
    [ -f "$f" ] && [ "$f" -nt "$dest/$(basename "$f")" ] && cp -p "$f" "$dest/" 2>/dev/null
  done
  for f in "$CV/"*"$slug"*.pdf; do
    [ -f "$f" ] && cp -p "$f" "$dest/" 2>/dev/null
  done
done
