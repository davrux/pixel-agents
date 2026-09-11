#!/usr/bin/env bash
# Draw the implosion's hole (assets/effects/implode.png).
#
#   scripts/draw-implode.sh              write the sheet
#   scripts/draw-implode.sh --check      fail if the committed sheet differs from the drawing
#   scripts/draw-implode.sh --preview    write an 8x magnified copy on the floor's grey
#
# Committed art; this is how it is (re)drawn. Size and frame count come from IMPLODE_SHEET in
# shared/src/office/effects.ts, not from here.
set -euo pipefail
cd "$(dirname "$0")/../server"
exec node --import tsx scripts/draw-implode.mts "$@"
