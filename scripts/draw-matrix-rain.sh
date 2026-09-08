#!/usr/bin/env bash
# Draw the Matrix rain tile (assets/effects/matrix-rain.png).
#
#   scripts/draw-matrix-rain.sh              write the tile
#   scripts/draw-matrix-rain.sh --check      fail if the committed tile differs from the drawing
#   scripts/draw-matrix-rain.sh --preview    write a 6x magnified copy, two tiles stacked
#
# Committed art; this is how it is (re)drawn. Size comes from MATRIX_RAIN_SHEET in
# shared/src/office/effects.ts, not from here.
set -euo pipefail
cd "$(dirname "$0")/../server"
exec node --import tsx scripts/draw-matrix-rain.mts "$@"
