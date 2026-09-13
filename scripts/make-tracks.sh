#!/usr/bin/env bash
# Write the race tracks into assets/tiled/zones/ — raceway and speedway.
#
#   scripts/make-tracks.sh            write the map
#   scripts/make-tracks.sh --check    fail if the committed map differs from the generator
#
# A GENERATED map, unlike every other one here: an oval is geometry, not design, and this exists
# so there is something to drive on. It is a real .tmj — open it in Tiled and shape it, and then
# stop running this.
set -euo pipefail
cd "$(dirname "$0")/../server"
exec node --import tsx scripts/make-tracks.mts "$@"
