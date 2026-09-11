#!/usr/bin/env bash
# Draw the kart sheet (16 headings) into assets/vehicles/kart.png.
#
#   scripts/draw-kart.sh             write the sheet
#   scripts/draw-kart.sh --check     fail if the committed sheet differs (CI / before you ship)
#   scripts/draw-kart.sh --preview   also write tmp/kart-preview.png, every heading on road
set -euo pipefail
cd "$(dirname "$0")/../server"
exec node --import tsx scripts/draw-kart.mts "$@"
