#!/usr/bin/env bash
# Draw the race track's ground tileset into assets/tiled/png/src/track.png + track.tsj.
#
#   scripts/draw-track-tiles.sh            write them
#   scripts/draw-track-tiles.sh --check    fail if the committed files differ
set -euo pipefail
cd "$(dirname "$0")/../server"
exec node --import tsx scripts/draw-track-tiles.mts "$@"
