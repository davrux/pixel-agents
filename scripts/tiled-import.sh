#!/usr/bin/env bash
# Import every assets/tiled/zones/*.tmj file into its own zone's saved
# layout — run this after hand-editing (or adding) zone files directly in
# Tiled. Each file's target zone comes from its own Map `mapName` property
# (Tiled: View -> Custom Types Editor -> Map), not its filename — see
# server/src/tiled/zoneImport.ts; falls back to the filename only when that
# property is absent.
#
# This writes straight into this machine's database, so it only works where
# that database is — use it to seed one offline, or when no server is running.
# To get a map onto a server (including the local dev one), use
# scripts/push-zones.sh instead; nothing imports zone files automatically.
#
# Usage: scripts/tiled-import.sh
#   Takes no arguments: a zone has exactly one map, so each file simply becomes
#   its zone's map (there are no named layouts any more).
set -e

cd "$(dirname "$0")/../server"

node --import tsx scripts/tiled-import-all-zones.mts "$@"
