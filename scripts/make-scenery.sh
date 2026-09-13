#!/usr/bin/env bash
# Build the tracks' surroundings from the Dust Racing 2D art: ground tiles and plant decals.
#
#   scripts/make-scenery.sh            write them
#   scripts/make-scenery.sh --check    fail if the committed files differ
#
# The sources and everything this writes are CC BY-SA 3.0 — see
# assets/third-party/dust-racing/README.md.
set -euo pipefail
cd "$(dirname "$0")/../server"
exec node --import tsx scripts/make-scenery.mts "$@"
