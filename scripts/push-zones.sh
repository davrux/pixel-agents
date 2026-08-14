#!/usr/bin/env bash
# Push zone maps to a running server — the only way a zone edit reaches one.
# assets/tiled/zones/*.tmj is gitignored, so a level never rides along with a
# deploy; this sends it over HTTP and the server imports it as that zone's
# active layout. Works the same locally and against the deploy host.
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
#
# Zone names may be given with or without .tmj; scratch copies (*-noimport.tmj)
# are always skipped. See server/scripts/push-zones.mts for the details, and
# scripts/tiled-import.sh for the offline alternative when no server is running.
set -e

cd "$(dirname "$0")/../server"

exec node --import tsx scripts/push-zones.mts "$@"
