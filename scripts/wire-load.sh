#!/usr/bin/env bash
# Measure what a MOVING world costs on the wire: N headless viewers, all walking.
#
#   scripts/wire-load.sh                                  10 walkers, 20 s, localhost:2599
#   scripts/wire-load.sh --walkers 30 --seconds 30        more load, longer window
#   scripts/wire-load.sh --watchers 20                    viewers that watch without walking
#   scripts/wire-load.sh --pid 12345                       also report that server's CPU
#   scripts/wire-load.sh --url http://host:2567 --i-know   somewhere other than localhost
#
# Reports per-viewer KB/s, the cost PER MOVING ENTITY (the number that extrapolates) and the
# room's whole uplink. It CREATES accounts through /desktop/token, which only SQL can remove --
# hence the localhost guard. Point it at an isolated instance:
#
#   PIXEL_STREAM_PORT=2599 PIXEL_STREAM_DATA_DIR=/tmp/x PIXEL_ADMIN_TOKEN=test12 \
#     scripts/pixel-agents.sh
set -euo pipefail
cd "$(dirname "$0")/../server"
exec node --import tsx scripts/wire-load.mts "$@"
