#!/usr/bin/env bash
# Add the fourth (left) row to character/pet sheets by mirroring the right row, once.
#
# Sheets used to carry three rows and the client mirrored right at load time — the one
# direction the engine had to invent, and only correct for symmetric art. Left is a row
# like any other now; this is the one-time conversion for art drawn before that.
#
# Usage:
#   scripts/add-left-row.sh [--apply] [path…]     # default: the bundled sheets
#
# Idempotent: a sheet that already has four rows is skipped, so it is safe to re-run.
set -euo pipefail
cd "$(dirname "$0")/../server"
exec node --import tsx scripts/add-left-row.mts "$@"
