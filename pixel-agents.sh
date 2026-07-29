#!/usr/bin/env bash
set -e

cd "$(dirname "$0")"
node feeder/pixel-agents-feeder.cjs --server wss://pixels.meik.info/feed "$@"
