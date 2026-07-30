#!/usr/bin/env bash
# Builds the Electron desktop release (unsigned Linux AppImage).
#
# Game/arcade content is NOT bundled — the desktop app fetches it from whatever
# server it's pointed at, same as the browser client (see
# client/src/arcade/ArcadeUI.ts resolveArcadeUrl + desktop/electron-builder.yml,
# which explicitly excludes jsdos/bundles/** from the packaged app). So the
# built app can play every game the connected server serves from
# ARCADE_CONTENT_DIR, without shipping ~80 MB of ROMs/bundles in the asar.
set -e

cd "$(dirname "$0")/.."

pnpm run dist:desktop

echo
echo "Built: desktop/release/"
ls -1 desktop/release/*.AppImage 2>/dev/null
