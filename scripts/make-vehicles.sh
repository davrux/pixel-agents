#!/usr/bin/env bash
# Build the game-scale vehicle sprites from the Dust Racing 2D sources.
#
#   scripts/make-vehicles.sh            write assets/vehicles/car-*.png
#   scripts/make-vehicles.sh --check    fail if the committed sprites differ
#
# The sources and everything this writes are CC BY-SA 3.0 — see assets/third-party/dust-racing/README.md.
set -euo pipefail
cd "$(dirname "$0")/../server"
exec node --import tsx scripts/make-vehicles.mts "$@"
