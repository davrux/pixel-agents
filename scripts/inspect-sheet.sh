#!/usr/bin/env bash
# Look at an art sheet and propose what each cell is, with the evidence — step 0 of
# importing a pack (see .claude/skills/tiled-asset-import).
#
# Usage:
#   scripts/inspect-sheet.sh <sheet.png> [--tile 16] [--contact out.png]
#
#   --tile     cell size in px (default 16)
#   --contact  write a 3x magnified sheet with a coloured frame per cell:
#              green GROUND · blue BLOCK · yellow FLAT · red STANDING · grey EMPTY
#
# Prints how many cells fall into each proposal and what the proposal means. The
# classification is evidence, not a verdict: whether a piece needs BEHAVIOUR (only
# then is it furniture) and what it depicts stay with you.
set -euo pipefail
# Paths are resolved against YOUR working directory before we move into server/,
# which is where the script has to run from (its imports resolve there).
args=()
for a in "$@"; do
  case "$a" in
    --*) args+=("$a") ;;
    /*) args+=("$a") ;;  # already absolute (e.g. a --contact target)
    *) if [ -e "$a" ]; then args+=("$(cd "$(dirname "$a")" && pwd)/$(basename "$a")"); else args+=("$(pwd)/$a"); fi ;;
  esac
done
cd "$(dirname "$0")/../server"
exec node --import tsx scripts/inspect-sheet.mts "${args[@]}"
