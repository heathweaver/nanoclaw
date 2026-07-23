#!/bin/bash
# Sync per-job application files from the agent group workspaces into iCloud
# Drive, one folder per job (named for the job slug), so they appear on Heath's
# other Mac. Runs on the host (the container can't reach iCloud). Idempotent:
# copies only when the source is newer. Invoked on an interval by launchd.
#
# Covers every group that produces job applications: the jobsearch intake group
# and the Twiglit-triggered groups (chat + twig runs share the jobsearch pipeline).

set -u
BASE="/Users/heathweaver/Development/nanoclaw/groups"
# NOTE: do not name this array GROUPS — that is a reserved bash special variable
# (the user's numeric group IDs) and assignments to it are silently ignored,
# which makes this loop iterate GIDs and sync nothing.
JOB_GROUPS=(jobsearch twiglit_main twiglit_work)
ICLOUD="$HOME/Library/Mobile Documents/com~apple~CloudDocs/Job Applications"

mkdir -p "$ICLOUD"
shopt -s nullglob

for g in "${JOB_GROUPS[@]}"; do
  APPS="$BASE/$g/applications"
  CV="$BASE/$g/cv"
  [ -d "$APPS" ] || continue

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
done
