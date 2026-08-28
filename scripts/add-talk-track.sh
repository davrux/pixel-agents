#!/usr/bin/env bash
# Give the bundled pet sheets a two-frame `talk` track, derived from their stand frame.
#
# The engine asks for a `talk` pose when a pet chats beside an agent, but the sheets carry only
# walk/sit/idle — so a chatting pet drew the idle frame and stood still. This widens each sheet
# from 6 to 8 columns: column 6 is that row's stand frame, column 7 the same pixels one row
# higher, which reads as a small bounce and is fully determined by the art already there.
#
# The other half of the change is a `talk` track appended to PET_SPRITE_SPEC. Either order is
# safe: a spec claiming art a file lacks falls back to the idle frame rather than drawing a gap.
#
# Usage:
#   scripts/add-talk-track.sh [--apply] [path…]    # default: the bundled sheets
#
# Idempotent: a sheet already 8 columns wide is skipped. Every write is verified by reading the
# file back and comparing all eight columns; a sheet that does not match is left untouched.
set -euo pipefail
cd "$(dirname "$0")/../server"
exec node --import tsx scripts/add-talk-track.mts "$@"
