#!/usr/bin/env bash
# Re-derive everything this project takes from the "Zelda-like tilesets and
# sprites" pack's Overworld.png (ArMM1998, public domain / CC0 — see the
# README credit): the floor patterns (assets/floors/overworld_*.png), the
# baked natural-only floor-overworld set, the furniture-overworld tileset and
# the flat ground patches appended to decal.tsj. Run once at import time —
# nothing in a normal build calls this, and the derived art is committed.
#
# The pack itself is NOT in this repository (it is public domain, but there
# is no reason to carry the source collage). Put its PNGs in tmp/zelda-like/
# first, so that tmp/zelda-like/Overworld.png exists.
#
# Usage: scripts/import-overworld-pack.sh [--force]
#
#   scripts/import-overworld-pack.sh           # first import; refuses to clobber
#   scripts/import-overworld-pack.sh --force   # rewrite furniture-overworld.tsj too
#
# --force is destructive: furniture-overworld.tsj is maintained BY HAND in
# Tiled after the import (that is where an item gets a property no rule over
# an art pack could decide), and rewriting it discards every such edit. The
# floor half is always safe to re-run — it is a pure function of the pack plus
# the judgement tables in server/scripts/gen-overworld.mts. decal.tsj is only
# ever appended to, never rewritten.
set -e

cd "$(dirname "$0")/../server"

node --import tsx scripts/gen-overworld.mts "$@"
exec node --import tsx scripts/bake-floor-wall-tiled.mts
