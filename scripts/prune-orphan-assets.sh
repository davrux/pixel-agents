#!/usr/bin/env bash
# Delete stored asset rows nothing can reach any more. Default: personal avatars whose
# account is gone (~77 KB each). `--type furniture` runs the old tileset-based
# classification, which only tells you something about a database from before furniture
# stopped being an asset type — a world that has booted this build has no such rows
# left (see server/src/maintenance/retireFurniture.ts).
#
# Usage:
#   scripts/prune-orphan-assets.sh [--apply] [--type playerAvatar|furniture]
#
# Without --apply it only reports. It never deletes an id that is placed in any zone or
# map — those are reported instead, because that is a map to repair, not a row to
# remove.
#
# --type playerAvatar switches to the other prune the boot performs: personal avatars
# whose account no longer exists (~77 KB each). Same decision function as the boot, so
# the report and the boot cannot drift apart.
set -euo pipefail
cd "$(dirname "$0")/../server"
exec node --import tsx scripts/prune-orphan-assets.mts "$@"
