#!/usr/bin/env bash
# Rewrite stored character/NPC/avatar art from SpriteData (one hex string per pixel)
# into a PNG sheet — 24× smaller for the same art. New saves are packed already; this is
# for rows written before that.
#
# Usage:
#   scripts/repack-art.sh [--apply]
#
# Without --apply it only reports what would change. Every row is verified by unpacking
# it again and comparing colours before the write is kept, and a row that does not match
# is left exactly as it was.
set -euo pipefail
cd "$(dirname "$0")/../server"
exec node --import tsx scripts/repack-art.mts "$@"
