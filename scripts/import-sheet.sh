#!/usr/bin/env bash
# Import an art pack's sheet as a grid decal tileset — the generic importer. For the
# packs already in this world there is a wrapper each (import-overworld-pack.sh,
# import-road-sheet.sh) carrying that pack's provenance; use this one for a NEW pack,
# then add its wrapper in the same commit.
#
# Usage:
#   scripts/import-sheet.sh --src tmp/<pack>/Sheet.png --name decal-<thing> \
#       --id-prefix XX [--id-style colrow|rcpad] [--tile 16] [--dry-run]
#
#   --id-style colrow   XX_7_5        (column then row)
#   --id-style rcpad    XX_R03C07     (row and column, two digits each)
#
# Read .claude/skills/tiled-asset-import first — it carries the decisions this
# command cannot make for you (what the art IS, sheet or collection).
#
# ⚠️  Ids are identity: every placement in every map resolves through them. Never
#     change --id-prefix, --id-style or --tile for a set that already exists.
set -e
cd "$(dirname "$0")/../server"
exec node --import tsx scripts/import-sheet.mts "$@"
