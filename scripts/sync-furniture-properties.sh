#!/usr/bin/env bash
# Give every furniture tile every property, with its default filled in — run
# this in the same commit as any change to FURNITURE_TILE_PROPS (see
# server/src/tiled/furnitureProps.ts and the furniture-behaviour convention in
# AGENTS.md).
#
# It stamps the property onto all ~350 tiles across every
# assets/tiled/furniture*.tsj, clears retired ones out of the zone maps, and
# gives class-less furniture placements their FurnitureObject class. A tile that
# is merely *missing* a property silently behaves as if someone had chosen its
# default — which is the exact failure this exists to prevent.
#
# Usage: scripts/sync-furniture-properties.sh [--check] [--fix-gids]
#
#   scripts/sync-furniture-properties.sh           # write the changes
#   scripts/sync-furniture-properties.sh --check   # report only, exit 1 if
#                                                  # anything would change (CI,
#                                                  # and the pre-ship check)
#   --fix-gids   also renumber any map whose tileset table went stale — always
#                reported, never repaired without this
set -e

cd "$(dirname "$0")/../server"

exec node --import tsx scripts/sync-furniture-properties.mts "$@"
