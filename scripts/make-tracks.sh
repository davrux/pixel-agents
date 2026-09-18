#!/usr/bin/env bash
# Write the race tracks into assets/tiled/zones/ — raceway and monza.
#
#   scripts/make-tracks.sh            write the map
#   scripts/make-tracks.sh --check    fail if the committed map differs from the generator
#   scripts/make-tracks.sh --profile  print each lap's radius and clearance per 2 %, which is how
#                                     a bridge's stretch is chosen (it needs a straight one with
#                                     room beside it) and how a corner's difficulty is judged
#
# A GENERATED map, unlike every other one here: an oval is geometry, not design, and this exists
# so there is something to drive on. It is a real .tmj — open it in Tiled and shape it, and then
# stop running this.
set -euo pipefail
cd "$(dirname "$0")/../server"
exec node --import tsx scripts/make-tracks.mts "$@"
