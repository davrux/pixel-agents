#!/usr/bin/env bash
# Push zone maps to a running server — the only way a zone edit reaches one.
# The .tmj files are committed (so levels are shareable and diffable), but no
# deploy installs one: nothing reads them at runtime. This sends the file over
# HTTP and the server imports it as that zone's map. Works the same locally and against the deploy host, and sends
# any tilesets/PNGs the server is missing along with it.
#
# Usage: scripts/push-zones.sh [zone…] [options]
#
#   scripts/push-zones.sh                          # every map → 127.0.0.1:2567
#   scripts/push-zones.sh uponu --watch            # re-push that one on every save
#   scripts/push-zones.sh --server=deploy.host:443 # push everything to the deploy
#
#   --server=<host:port>  default 127.0.0.1:2567
#   --token=<t>           default $PIXEL_ADMIN_TOKEN, else read from ./.env
#   --watch               keep running and push each map when it changes
#   --insecure            accept a self-signed cert (implied for loopback)
#   --no-assets           skip the tileset/PNG sync, push only the maps
#
# Zone names may be given with or without .tmj; scratch copies (*-noimport.tmj)
# are always skipped. See server/scripts/push-zones.mts for the details, and
# scripts/tiled-import.sh for the offline alternative when no server is running.
set -e

cd "$(dirname "$0")/../server"

exec node --import tsx scripts/push-zones.mts "$@"
