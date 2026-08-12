#!/usr/bin/env bash
# Import every assets/tiled/zones/*.tmj file into its own zone's saved
# layout — run this after hand-editing (or adding) zone files directly in
# Tiled. Each file's target zone comes from its own Map `mapName` property
# (Tiled: View -> Custom Types Editor -> Map), not its filename — see
# server/src/tiled/zoneImport.ts; falls back to the filename only when that
# property is absent. Never runs automatically (no file watcher), so run
# this by hand whenever zone files change.
#
# Usage: scripts/tiled-import.sh [layoutName]
#   layoutName — the saved layout name each zone gets, defaults to
#                "TiledImport" (see tiled-import-all-zones.mts)
set -e

cd "$(dirname "$0")/../server"

node --import tsx scripts/tiled-import-all-zones.mts "$@"
