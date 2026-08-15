#!/usr/bin/env bash
# Stream a real Claude agent into the office — the feeder with a server already
# filled in, so an agent only has to bring its token.
#
# Usage: scripts/pixel-agents.sh --token <your-agent-token> [options]
#
#   scripts/pixel-agents.sh --token abc123                          # → the public server
#   scripts/pixel-agents.sh --token abc123 \
#     --server ws://localhost:2567/feed                       # → your dev server
#   PIXEL_SERVER_URL=ws://host:6161/feed scripts/pixel-agents.sh --token abc123
#
# --token is the per-user agent token from in-app Settings; the server resolves
# it to your account and labels your agents accordingly. Everything else is
# passed straight through — see feeder/pixel-agents-feeder.cjs for the full set.
set -e

cd "$(dirname "$0")/.."

# The feeder takes the FIRST --server it sees, so ours may only be added when the
# caller gave none: prepending it unconditionally meant `--server ws://localhost…`
# was accepted, ignored, and the agent went to the public server anyway.
default_server=()
case " $* " in
  *" --server "* | *" --server="*) ;;
  *) default_server=(--server "${PIXEL_SERVER_URL:-wss://pixels.meik.info/feed}") ;;
esac

exec node feeder/pixel-agents-feeder.cjs "${default_server[@]}" "$@"
