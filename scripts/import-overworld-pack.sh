#!/usr/bin/env bash
# Re-derive the overworld art from the "Zelda-like tilesets and sprites" pack
# (ArMM1998, public domain / CC0 — see the README credit): decal-overworld.tsj plus
# its sheet copy, the whole 40x36 grid with every non-empty cell paintable.
#
# The pack itself is NOT in this repository (it is public domain, but there is no
# reason to carry the source collage twice). Put its PNGs under tmp/gfx/ first, so
# that tmp/gfx/Overworld.png exists.
#
# Always safe to re-run: the output is a pure function of the pack, so an unchanged
# pack rewrites byte-identical files, and labels set in Tiled are kept. The sheet
# goes to assets/tiled/png/src/sheets/ — source art, since a checkout cannot
# regenerate it without the pack.
#
# It used to bake a floor set from the same pack as well (floor-overworld, 187
# hand-cut patterns). That set is gone: ground is whatever you paint on the
# GroundLayer, so the sheet itself is paintable as ground and no bake is needed.
#
# Usage: scripts/import-overworld-pack.sh [--dry-run]
set -e
exec "$(dirname "$0")/import-sheet.sh" \
  --src tmp/gfx/Overworld.png \
  --name decal-overworld \
  --id-prefix OW \
  --id-style colrow \
  "$@"
