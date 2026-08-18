#!/usr/bin/env bash
# Re-derive the road art from the MetroCity Outdoor pack: decal-roads.tsj plus its
# sheet copy, a 20x20 grid whose arrangement IS the content — a junction is a block
# of pieces you mark and stamp, which is why this is a grid tileset and not 305
# separate images.
#
# The pack is not in this repository. Put it under tmp/metro/ first, so that
# "tmp/metro/MetroCity Outdoor 2.0/MetroCity 2.0/Road.png" exists.
#
# Always safe to re-run: byte-identical output for an unchanged pack, labels kept.
#
# Usage: scripts/import-road-sheet.sh [--dry-run]
set -e
exec "$(dirname "$0")/import-sheet.sh" \
  --src "tmp/metro/MetroCity Outdoor 2.0/MetroCity 2.0/Road.png" \
  --name decal-roads \
  --id-prefix ROAD \
  --id-style rcpad \
  "$@"
