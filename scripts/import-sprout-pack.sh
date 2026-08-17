#!/usr/bin/env bash
# Re-derive everything this project takes from the Sprout Lands Basic pack:
# the floor patterns and wall pieces, the baked Tiled floor/wall sets, and the
# furniture tilesets. Run once at import time — nothing in a normal build calls
# this, and the derived art is committed.
#
# The pack is NOT in this repository (its licence forbids redistributing it).
# Put it in tmp/sprout/ first, so that tmp/sprout/Objects/ and tmp/sprout/
# Tilesets/ exist. Credit and terms: assets/CREDITS.md.
#
# Usage: scripts/import-sprout-pack.sh [--force]
#
#   scripts/import-sprout-pack.sh           # first import; refuses to clobber
#   scripts/import-sprout-pack.sh --force   # rewrite the furniture tilesets too
#
# --force is destructive: the furniture tilesets are maintained BY HAND in
# Tiled after the import (that is where an item gets a property no rule over an
# art pack could decide), and rewriting them discards every such edit. The
# floor/wall halves are always safe to re-run — they are pure functions of the
# pack plus the tables in server/scripts/gen-sprout-source-art.mts.
set -e

cd "$(dirname "$0")/../server"

node --import tsx scripts/gen-sprout-source-art.mts
node --import tsx scripts/bake-floor-wall-tiled.mts
exec node --import tsx scripts/gen-sprout-furniture.mts "$@"
