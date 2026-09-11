#!/usr/bin/env bash
# Draw the smoke puff (assets/effects/smoke.png).
#
#   scripts/draw-smoke.sh              write the sheet
#   scripts/draw-smoke.sh --check      fail if the committed sheet differs from the drawing
#   scripts/draw-smoke.sh --preview    write a 7x magnified copy on the floor's grey
#
# Committed art; this is how it is (re)drawn. Size and frame count come from SMOKE_SHEET in
# shared/src/office/effects.ts, not from here.
set -euo pipefail
cd "$(dirname "$0")/../server"
exec node --import tsx scripts/draw-smoke.mts "$@"
