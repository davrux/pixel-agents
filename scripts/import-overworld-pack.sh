#!/usr/bin/env bash
# Re-derive everything this project takes from the "Zelda-like tilesets and
# sprites" pack's Overworld.png (ArMM1998, public domain / CC0 — see the
# README credit): the floor patterns (assets/floors/overworld_*.png), the
# baked natural-only floor-overworld set, and decal-overworld.tsj — the whole
# sheet as a grid decal tileset, every non-empty 16x16 cell a paintable
# DecalTile. Run once at import time — nothing in a normal build calls this,
# and the derived art is committed.
#
# The pack itself is NOT in this repository (it is public domain, but there
# is no reason to carry the source collage twice). Put its PNGs in
# tmp/zelda-like/ first, so that tmp/zelda-like/Overworld.png exists.
#
# Usage: scripts/import-overworld-pack.sh
#   Always safe to re-run: both halves are pure functions of the pack plus the
#   judgement tables in server/scripts/gen-overworld.mts. (Decal tiles carry
#   no hand-set behaviour — a decal is a picture and nothing else — so unlike
#   a furniture tileset there is nothing a rewrite could destroy.)
set -e

cd "$(dirname "$0")/../server"

node --import tsx scripts/gen-overworld.mts
exec node --import tsx scripts/bake-floor-wall-tiled.mts
