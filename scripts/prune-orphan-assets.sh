#!/usr/bin/env bash
# Delete stored asset rows whose id no tileset carries any more — leftovers of art
# packages that came and went. They cannot be placed (a mapper only paints what a
# tileset offers) but they still travel to every client on every join, as pixels,
# because a row without a file has no image to point at.
#
# Usage:
#   scripts/prune-orphan-assets.sh [--apply] [--type furniture|playerAvatar]
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
