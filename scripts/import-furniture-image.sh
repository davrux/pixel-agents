#!/usr/bin/env bash
# Bring ONE picture in as ONE piece of furniture, resampled to this world's scale.
#
# For art that arrives as a single oversized image of a single object — a 1024px
# render of a coffee machine — rather than as a pack. A pack is a sheet or a
# collection and goes through scripts/import-sheet.sh or a gen-*.mts slicer; read
# .claude/skills/tiled-asset-import for which of the three you have.
#
# Usage:
#   scripts/import-furniture-image.sh <source.png> --id ID --set SET [options]
#   scripts/import-furniture-image.sh --help        # every option
#
# The two decisions worth thinking about:
#   --size WxH        how many TILES the thing is (16px each). Furniture footprint
#                     is derived from the PNG's size, so this IS the object's
#                     size in the world. 32x32 = 2x2 tiles = about as tall as a
#                     character. It is a box to FILL; add --fit when the subject
#                     has its own proportions to keep (a side-on car is 3.4:1 and
#                     the vehicle box is 2:1 — filling it ovalises the wheels),
#                     and the art sits bottom-centred in the spare rows.
#   --as-is           the picture is ALREADY pixel art at 16px to the tile, so
#                     nothing should be resampled, requantized or shadowed. Its
#                     own size decides --size, and every transform below is off:
#                     the pixels are copied. Use it for art drawn for this world,
#                     not for a render that happens to be small.
#   --erase X,Y,W,H   source rectangles to blank first. A generator likes to add
#                     detached decoration — steam, sparkles, a cast shadow — that
#                     survives a 30:1 reduction as a few stray specks.
#
# Example — the espresso machine in furniture-kitchens, its two steam wisps cut
# off above the machine's top surface:
#   scripts/import-furniture-image.sh ~/Downloads/coffeemachine.png \
#       --id ESPRESSO_MACHINE --set kitchens --size 32x32 \
#       --erase 440,0,584,170 \
#       --prop backgroundTiles=1 --prop actionKind=appliance --prop actionPose=coffee
#
# It only ever APPENDS to furniture-<SET>.tsj, and refuses an --id that exists:
# ids are identity, and a renumbered tile is a placement that silently draws
# nothing. To redraw art that is already in a set — a better render of the same
# object — pass --replace: it rewrites that id's PNG only, leaves the tileset
# alone (so no tilecount change and no gid table to repair), and refuses a --size
# the tile does not already have, since footprint, blocking and seats are all
# derived from the PNG's size. Growing a tileset does move the one after it in a map's table, so
# afterwards run:
#   scripts/sync-furniture-properties.sh --check    # reports a stale gid table
#   scripts/sync-furniture-properties.sh --fix-gids # repairs it
# The furniture atlas needs nothing: the server re-bakes it when the art changed
# (scripts/bake-atlas.sh --check is the CI question).
#
# Behaviour beyond --prop — sittable, what it turns into when switched on — is
# set on the tile in Tiled afterwards. The source image stays out of the repo;
# only the resampled PNG and the tileset entry are committed.
set -e
cd "$(dirname "$0")/../server"
exec node --import tsx scripts/gen-furniture-from-image.mts "$@"
