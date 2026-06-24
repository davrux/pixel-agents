#!/usr/bin/env bash
#
# pixel-agents.sh — launcher for pixel-agents (fork of pixel-agents).
#
# Roles:
#   serve   (default)  central server: shows the agents of all clients,
#                       receives their JSONL stream over WS /feed (in-memory).
#   client             reads local ~/.claude/projects/*.jsonl and streams it
#                       to the server (username + AUTH token, no hook).
#
# Server:
#   ./pixel-agents.sh serve -d --token <T>          # background (viewer 6161, feed 7171)
#   ./pixel-agents.sh --status | --stop
# Client:
#   ./pixel-agents.sh client --server ws://<host>:7171/feed --user alice --token <T> -d
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
STATE_DIR="$HOME/.pixel-agents"
PID_FILE="$STATE_DIR/server.pid"
LOG_FILE="$STATE_DIR/server.log"
CLIENT_LOG="$STATE_DIR/client.log"
STREAM_JS="$SCRIPT_DIR/dist/stream.js"
CLIENT_JS="$SCRIPT_DIR/client/pixel-agents-client.js"

PORT=6161
FEED_PORT=7171
HOST=0.0.0.0
TOKEN=""
BACKGROUND=0
REBUILD=0
ACTION=serve
# client opts
C_SERVER=""
C_USER=""
C_ROOT=""

usage() {
  cat <<EOF
pixel-agents.sh — central stream server + client

Actions:
  serve            start the server (default)
  client           client: stream local sessions to the server
  --status         server status
  --stop           stop the server

Server options:
  -p, --port <n>   viewer port, display/read-only only (default 6161)
      --feed-port <n> client-ingest port (default 7171, token-protected)
  -b, --host <h>   bind address (default 0.0.0.0)
      --token <t>  AUTH token (REQUIRED) for viewer AND clients
                   (alternatively env PIXEL_STREAM_TOKEN; no file fallback)
  -d, --background background (daemon)
      --rebuild    rebuild dist/stream.js

Client options (client):
      --server <ws-url>   e.g. ws://host:7171/feed   (required)
      --user <name>       username, <=16 ASCII       (default hostname)
      --token <t>         AUTH token                 (or PIXEL_STREAM_TOKEN)
      --root <dir>        projects root (default ~/.claude/projects)
  -d, --background

SECURITY: the viewer (6161) requires the same token via a login page (POST,
in-memory session; the cookie holds only a session id, not the token). The feed
(7171) is token-protected. /ws only allows display + layout persistence, no agent
control.
EOF
}

[ $# -gt 0 ] && case "$1" in serve|client) ACTION="$1"; shift ;; esac
while [ $# -gt 0 ]; do
  case "$1" in
    -p|--port)   PORT="${2:?}"; shift 2 ;;
    --feed-port) FEED_PORT="${2:?}"; shift 2 ;;
    -b|--host|--bind) HOST="${2:?}"; shift 2 ;;
    --token)     TOKEN="${2:?}"; shift 2 ;;
    --server)    C_SERVER="${2:?}"; shift 2 ;;
    --user)      C_USER="${2:?}"; shift 2 ;;
    --root)      C_ROOT="${2:?}"; shift 2 ;;
    -d|--background) BACKGROUND=1; shift ;;
    --rebuild)   REBUILD=1; shift ;;
    --status)    ACTION=status; shift ;;
    --stop)      ACTION=stop; shift ;;
    -h|--help)   usage; exit 0 ;;
    *) echo "Unknown option: $1" >&2; usage >&2; exit 2 ;;
  esac
done

pid_alive() { [ -n "${1:-}" ] && kill -0 "$1" 2>/dev/null; }
srv_pid() { [ -f "$PID_FILE" ] || return 1; local p; p="$(cat "$PID_FILE" 2>/dev/null)"; pid_alive "$p" || return 1; echo "$p"; }

mkdir -p "$STATE_DIR"

# ── client ──────────────────────────────────────────────────────────
if [ "$ACTION" = client ]; then
  command -v node >/dev/null || { echo "node not found" >&2; exit 1; }
  [ -f "$CLIENT_JS" ] || { echo "pixel-agents-client.js missing: $CLIENT_JS" >&2; exit 1; }
  [ -n "$C_SERVER" ] || { echo "--server <ws-url> required" >&2; exit 2; }
  args=(--server "$C_SERVER")
  [ -n "$C_USER" ]  && args+=(--user "$C_USER")
  [ -n "$TOKEN" ]   && args+=(--token "$TOKEN")
  [ -n "$C_ROOT" ]  && args+=(--root "$C_ROOT")
  if [ "$BACKGROUND" = 1 ]; then
    setsid env node "$CLIENT_JS" "${args[@]}" >"$CLIENT_LOG" 2>&1 < /dev/null &
    echo "[client] background -> $C_SERVER  (log: $CLIENT_LOG)"
  else
    exec node "$CLIENT_JS" "${args[@]}"
  fi
  exit 0
fi

# ── status / stop ───────────────────────────────────────────────────
if [ "$ACTION" = status ]; then
  if p="$(srv_pid)"; then echo "pixel-agents server running (PID $p)."; exit 0; else echo "Server not running."; exit 1; fi
fi
if [ "$ACTION" = stop ]; then
  if p="$(srv_pid)"; then kill "$p" 2>/dev/null || true; rm -f "$PID_FILE"; echo "Server (PID $p) stopped."; else echo "No server."; fi
  exit 0
fi

# ── serve ───────────────────────────────────────────────────────────
if p="$(srv_pid)"; then echo "[serve] already running (PID $p). First: $0 --stop"; exit 0; fi

# AUTH token is REQUIRED (CLI --token or env PIXEL_STREAM_TOKEN) — no file fallback.
EFF_TOKEN="${TOKEN:-${PIXEL_STREAM_TOKEN:-}}"
if [ -z "$EFF_TOKEN" ]; then
  echo "[serve] ERROR: AUTH token required. Start with --token <T> (or set PIXEL_STREAM_TOKEN)." >&2
  exit 2
fi
TOKEN="$EFF_TOKEN"

build() {
  command -v node >/dev/null || { echo "node missing" >&2; exit 1; }
  command -v pnpm >/dev/null || { echo "pnpm missing (npm i -g pnpm)" >&2; exit 1; }
  if [ ! -d "$SCRIPT_DIR/node_modules" ] || [ ! -d "$SCRIPT_DIR/webview-ui/node_modules" ]; then
    ( cd "$SCRIPT_DIR" && pnpm install )   # pnpm workspace installs root + webview-ui
  fi
  ( cd "$SCRIPT_DIR" && pnpm build )       # production: dist/stream.js (minified) + dist/webview
}
if [ "$REBUILD" = 1 ] || [ ! -f "$STREAM_JS" ]; then echo "[serve] building..."; build; fi

run=(env node "$STREAM_JS" --port "$PORT" --feed-port "$FEED_PORT" --host "$HOST" --token "$TOKEN")
if [ "$BACKGROUND" = 1 ]; then
  setsid "${run[@]}" >"$LOG_FILE" 2>&1 < /dev/null &
  echo $! > "$PID_FILE"
  echo "[serve] background (bind $HOST: viewer $PORT, feed $FEED_PORT). Log: $LOG_FILE"
  echo "[serve] AUTH token: $TOKEN   (enter it on the viewer login page)"
  echo "[serve] Viewer: http://${HOST/0.0.0.0/<server>}:$PORT"
  echo "[serve] Status: $0 --status   Stop: $0 --stop"
else
  echo "[serve] AUTH token: $TOKEN"
  exec "${run[@]}"
fi
