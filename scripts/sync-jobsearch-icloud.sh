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

  # Build the set of job slugs for this group. A job is identified by its
  # package manifest (<slug>.package.md) OR its cover PDF (<slug>-cover.pdf /
  # <slug>-cover+cases.pdf). Keying off .package.md alone silently skipped jobs
  # submitted without one (e.g. Beacon, palantir-fdai-london) — they have a
  # cover but no manifest, so they never reached iCloud. Note-only files
  # (<slug>.md, <slug>-pastesheet.md) are NOT job keys: they belong to a job
  # and get copied by the <slug>* sweep below, but must not spawn their own
  # folder. (sed instead of associative arrays: macOS launchd runs bash 3.2.)
  slugs="$(
    { for f in "$APPS"/*.package.md;     do [ -f "$f" ] && basename "$f" | sed 's/\.package\.md$//'; done
      for f in "$APPS"/*-cover.pdf;       do [ -f "$f" ] && basename "$f" | sed 's/-cover\.pdf$//'; done
      for f in "$APPS"/*-cover+cases.pdf; do [ -f "$f" ] && basename "$f" | sed 's/-cover+cases\.pdf$//'; done
    } | sort -u
  )"

  while IFS= read -r slug; do
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
  done <<EOF
$slugs
EOF
done
