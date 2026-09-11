#!/usr/bin/env bash
# Draw the phoenix flame sheet (assets/effects/phoenix.png).
#
#   scripts/draw-phoenix.sh              write the sheet
#   scripts/draw-phoenix.sh --check      fail if the committed sheet differs from the drawing
#   scripts/draw-phoenix.sh --preview    write a 6x magnified copy on the canvas ground
#
# Committed art; this is how it is (re)drawn. Size and frame count come from PHOENIX_SHEET in
# shared/src/office/effects.ts, not from here.
set -euo pipefail
cd "$(dirname "$0")/../server"
exec node --import tsx scripts/draw-phoenix.mts "$@"
