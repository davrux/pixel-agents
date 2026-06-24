# pixel-agents

A **fork of [pixel-agents](https://github.com/pixel-agents-hq/pixel-agents)** used as a template. Instead of polling local `~/.claude/projects` JSONL files, a **central server** receives the transcript **streams** of multiple **clients** over WebSocket and renders their agents together in the pixel office UI.

> 🎮 **This is a fun, hobby project** — built for the joy of it, not as a hardened
> product. Expect rough edges; no stability, security, or support guarantees. Use
> it at your own risk and have fun. 🙂

## Architecture

```
Client A ─┐  client/pixel-agents-client.js (reads local ~/.claude/projects/*.jsonl)
Client B ─┼── WS /feed (user + token in Sec-WebSocket-Protocol header)  ──► port 7171
Client C ─┘   (streams new JSONL lines, no hook)            │ processTranscriptLine
                                                            ▼ (in memory only)
                                          AgentStateStore ──► port 6161  /ws ──► browser
                                                            (display, cookie auth)
```

**Two separate ports, one process, shared in-memory store:**
- **7171** — own listener, accepts ONLY client streams (`/feed`, token-protected via query).
- **6161** — display: serves the SPA and streams state to the browser (`/ws`). Allows display + **layout/seat/UI persistence**, but **no agent control** (control logic comes later). No `/feed` here.

**Frontend auth (same token as the clients):** On first access the viewer shows a
**login page**; the AUTH token is submitted via **`POST /login`** (in the request
body, never in the URL). On success the server starts an **in-memory session**
and sets an **HttpOnly cookie** (`pixel_stream_sid`) holding only an opaque,
random session id — never the token. The cookie survives page reloads; sessions
are in memory, so a server restart just requires a re-login. The `/ws` upgrade
requires a valid session (otherwise it closes with code 4001, and the frontend
redirects to the login page). Static assets are not protected (no secret); the
data flows only over `/ws`.

**AUTH token is required:** the server and clients take the token from `--token`
(or env `PIXEL_STREAM_TOKEN`). No file fallback — without a token the server does
not start.

## What changed (vs. the template)

| File | Change |
|---|---|
| `server/src/streamIngest.ts` | **new** — WS `/feed` endpoint: auth, one agent per client/session, feeds `processTranscriptLine` |
| `startFeedServer()` (in streamIngest.ts) | own Fastify listener for `/feed` only, on its own port |
| `server/src/streamServer.ts` | **new** — server entry: viewer (cookie auth) on `--port` 6161, own feed listener on `--feed-port` 7171; token required; **without** fileWatcher/runtime/hooks |
| `server/src/httpServer.ts` | options `registerExtraRoutes` + `readOnly` (allowlist: display/layout, no agent control) + `viewerAuthToken` (cookie auth) |
| `server/src/viewerAuth.ts` | **new** — login page + `POST /login`, in-memory sessions, HTML gating, `/ws` session check |
| `server/src/clientMessageHandler.ts` | render-order fix: re-send `layoutLoaded` after `existingAgents` (render pre-existing agents) |
| `esbuild.js` | also builds `dist/stream.js` |
| `client/pixel-agents-client.js` | **new** — client (stream feeder) |
| `pixel-agents.sh` | **new** — launcher (serve/client/status/stop) |

`core/`, `webview-ui/` (SPA + assets) and `transcriptParser.ts`/`agentStateStore.ts` are reused **unchanged**.

## Usage

**Server (central):**
```bash
./pixel-agents.sh serve -d --token <T>        # viewer 6161 + feed 7171
./pixel-agents.sh serve -d -p 6161 --feed-port 7171 --token <T>
./pixel-agents.sh --status | --stop
# Viewer: http://<server>:6161  (login page; enter the AUTH token)
```

**Client (each machine with Claude/agent-shell):**
```bash
./pixel-agents.sh client --server ws://<server>:7171/feed --user alice --token <T> -d
```

## Build (pnpm)

```bash
pnpm install     # pnpm workspace: installs root + webview-ui
pnpm build       # production release: dist/stream.js (minified) + dist/webview
```

`./pixel-agents.sh serve --rebuild ...` runs the same build automatically when
`dist/stream.js` is missing.

### Supply-chain security

This is a pnpm workspace; dependency **build/lifecycle scripts are not executed**.
The per-dependency decision lives in `pnpm-workspace.yaml` under `allowBuilds:`
(only `esbuild: false` — esbuild works without its postinstall, binary via
optionalDependencies). Any **new** dependency that ships a build script makes
`pnpm install` stop until it is reviewed and added there on purpose, so no
unknown install hook ever runs silently.

## Validated (end-to-end)

- Multiple clients visible at once, each with its username (`2:bob`, `3:carol`).
- Tool activity streams live to the viewer (`agentToolStart`, `agentStatus:active`).
- In-memory: no file is created, no directory is polled.
- Two ports separated: you cannot feed via 6161; control messages are ignored.
- Cookie auth: login without cookie, app with cookie, `/ws` rejected without cookie.
- Required token: starting without `--token` fails.
- Layout editing is saved and reloaded after a reload.
- A client disconnect removes its agents (`agentClosed`).
