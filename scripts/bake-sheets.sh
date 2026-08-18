#!/usr/bin/env bash
# Bake the palette floor and wall sheets: every pattern in
# assets/tiled/png/src/floors and every wall geometry in .../walls, times the
# 64-colour palette, into assets/tiled/png/baked/ plus their tilesets.
#
# You need this ONLY when you add, remove or repaint one of those source files,
# or change a palette. Everything else needs no bake: ground can be painted from
# any grid tileset, and the furniture atlas is baked by the server itself.
#
# ⚠️  This rewrites the floor/wall TILESETS too. If the number of patterns or
#     wall pieces changes, every tileset after it shifts and the gids saved in
#     every map move with it — read the tile counts it prints, and if they
#     changed, renumber the maps (scripts/sync-furniture-properties.sh --fix-gids)
#     and verify before pushing.
#
# Usage: scripts/bake-sheets.sh
set -e
cd "$(dirname "$0")/../server"
exec node --import tsx scripts/bake-floor-wall-tiled.mts "$@"
