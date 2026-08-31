#!/usr/bin/env bash
# Draw the scuffle cloud sheet (assets/effects/scuffle.png).
#
#   scripts/draw-scuffle-cloud.sh              write the sheet
#   scripts/draw-scuffle-cloud.sh --check      fail if the committed sheet differs from the drawing
#   scripts/draw-scuffle-cloud.sh --preview    also write an 8x magnified copy to look at
#
# The sheet is committed art; this script is how it is (re)drawn. Frame size and count come from
# SCUFFLE_SHEET in shared/src/office/effects.ts, not from here.
set -euo pipefail
cd "$(dirname "$0")/../server"
exec node --import tsx scripts/draw-scuffle-cloud.mts "$@"
