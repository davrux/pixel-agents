#!/usr/bin/env bash
# Draw the karts — one picture per grid colour, pointing east, from the shape description in
# server/scripts/draw-karts.mts. Deterministic: same description, same bytes.
#
# Usage: scripts/draw-karts.sh [--check]
#
#   scripts/draw-karts.sh            # write assets/vehicles/car-*.png
#   scripts/draw-karts.sh --check    # fail if the committed art is not what the script draws
set -euo pipefail
cd "$(dirname "$0")/../server"
exec node --import tsx scripts/draw-karts.mts "$@"
