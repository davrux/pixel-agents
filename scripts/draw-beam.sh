#!/usr/bin/env bash
# Draw the transporter beam tile (assets/effects/beam.png).
#
#   scripts/draw-beam.sh              write the tile
#   scripts/draw-beam.sh --check      fail if the committed tile differs from the drawing
#   scripts/draw-beam.sh --preview    write a 6x magnified copy, two tiles stacked
#
# Committed art; this is how it is (re)drawn. Size comes from BEAM_SHEET in
# shared/src/office/effects.ts, not from here.
set -euo pipefail
cd "$(dirname "$0")/../server"
exec node --import tsx scripts/draw-beam.mts "$@"
