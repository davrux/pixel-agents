#!/usr/bin/env bash
# Bake the furniture/decal atlas — the one image the browser fetches instead of
# every single furniture PNG (assets/tiled/png/baked/atlas-furniture.png).
#
# You rarely need this: the server bakes the atlas itself at startup and whenever
# a tileset is saved, if the art has changed. Use it to bake without starting a
# server, or to check the committed artifact.
#
# Usage:
#   scripts/bake-atlas.sh [--dry-run] [--check]
#
#   --dry-run  report what a bake would produce, write nothing
#   --check    exit non-zero if the committed atlas no longer matches the source
#              art under assets/tiled/png/src (for CI and before shipping)
set -euo pipefail
cd "$(dirname "$0")/../server"
exec node --import tsx scripts/bake-furniture-atlas.mts "$@"
