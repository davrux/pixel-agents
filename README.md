# pixel-agents

A port of [pixel-agents](https://github.com/pixel-agents-hq/pixel-agents) onto a
**game-engine stack**: the original office — **all of its graphics, animations,
fonts, layout and agent behaviour** — runs **1:1**, with only the plumbing
swapped: **[Colyseus](https://colyseus.io/)** replaces the WebSocket transport
and **[Phaser](https://phaser.io/)** replaces the canvas renderer. From that base
it is growing into a small **MMO-style** world (multiple zones, human players
alongside the agents, NPCs, portals).

> 🎮 **This is a fun, hobby project** — built for the joy of it, not as a hardened
> product. Expect rough edges; no stability, security, or support guarantees. Use
> it at your own risk and have fun. 🙂
>
> 🤖 **It is also a pure AI project** — essentially all of the code in this fork was
> written by an AI coding agent. Treat it accordingly.

Multiple Claude clients stream their transcripts to the server; each agent
becomes a pixel character that walks to a desk, types/reads, idles and wanders,
shows permission/waiting bubbles, spawns sub-agents, and shares the office with
the occasional pet — exactly like the original.

## How the 1:1 port works

```
Claude clients ──JSONL──► /feed (WS, shares the viewer port)
   feeder/…feeder.cjs            │ transcriptParser → AgentEvent
                                 ▼
                            AgentDirector (registry + event forwarder)
                                 │  original wire messages ("m" channel)
                                 ▼
Browser (Phaser) ◄── Colyseus :2567 ── RelayRoom
   │                                     • decodes PNG assets → SpriteData (pngjs)
   │                                     • serves default-layout-1.json
   │                                     • replays/streams agentCreated, agentStatus,
   │                                       agentToolStart, agentTeamInfo, … verbatim
   ▼
 office engine (ported 1:1 from the original webview)
   OfficeState FSM · characters · pets · sprites · colorize · layout
   ▼
 PhaserRenderer  — turns the engine's SpriteData into Phaser textures and draws
   floor / walls / furniture / characters / pets / bubbles with the same z-sort
```

- **The office engine is the original code**, copied unchanged into
  `client/src/office/` (`OfficeState`, `characters`, `pets`, `sprites`,
  `colorize`, `floorTiles`, `wallTiles`, `layout`). Only the canvas `renderer.ts`
  and the React/WebSocket glue were dropped.
- **Colyseus is pure transport.** The room carries the *original* `ServerMessage`
  protocol on one channel (`m`); the client feeds those straight into a port of
  the old message handler (`client/src/net/bridge.ts`) which drives `OfficeState`.
  Room state is empty — there is no server-side simulation.
- **The server decodes the assets** (reusing the original `assetLoader` +
  `core/assets` pngjs decoders) and sends the same `characterSpritesLoaded` /
  `floorTilesLoaded` / `furnitureAssetsLoaded` / … messages on join.
- **`PhaserRenderer`** converts each `SpriteData` colour-grid into a cached
  Phaser texture (`render/sprites.ts`) and renders with the original draw order,
  depth-sort, sitting offsets, colorization and bubble placement.

## Packages (pnpm workspace)

| Package | What |
|---|---|
| `shared/` | `WORLD_ROOM` + the internal `AgentEvent` type shared by ingest and the room. |
| `server/` | Colyseus `RelayRoom`, asset decoding (`assetLoader` + `src/core/assets`), `/feed` ingest + `transcriptParser`, `AgentDirector`, mock driver. |
| `client/` | Phaser scene, the ported `office/` engine, `PhaserRenderer`, the Colyseus↔engine `bridge`. |
| `feeder/` | Standalone Node script that streams local `~/.claude/projects/**.jsonl` to `/feed`. |
| `assets/` | The original pixel-agents art: `characters/`, `floors/`, `walls/`, `furniture/` (+manifests), `pets/`, and `default-layout-1.json`. Decoded by the server. |

Font: **FS Pixel Sans** (`client/public/fonts/`), the original's UI font.

## Run (development)

```bash
pnpm install

# Terminal 1 — Colyseus server (+ 6 synthetic agents so the office is alive):
MOCK=6 pnpm dev:server          # http://localhost:2567 (viewer + Colyseus + /feed)

# Terminal 2 — Phaser client (hot-reload dev server only; prod is served by the
# server itself, see Build below):
pnpm dev:client                 # http://localhost:5173
```

Stream a **real** Claude agent into the office (the feed shares the viewer port):

```bash
node feeder/pixel-agents-feeder.cjs \
  --server ws://localhost:2567/feed --user alice --token local
```

`--token` is required by the feeder; the server only enforces it when
`PIXEL_STREAM_TOKEN` is set (otherwise any value is accepted).

### Build & run (single server, single port)

```bash
pnpm build          # type-checks + builds the client into client/dist
pnpm start          # one server: viewer, Colyseus and /feed all on one port
```

In production there is **no separate client server** — `pnpm start` (and the
Docker image) serve the built client from the same origin. A viewer only needs
a browser pointed at the server URL; an agent only needs Claude + the feeder.

## Status

Ported 1:1 and verified: the default office layout, the original character /
furniture / floor / wall / pet sprites and animations, the FSM behaviour
(walk-to-seat, typing/reading, idle-only-when-standing, wandering), permission
and waiting bubbles, sub-agents, team colours, and pets.

Not yet ported: the in-browser layout **editor**, the per-pixel **matrix**
spawn/despawn effect (currently a fade), and furniture auto-on/animation
(furniture renders in its default state). These are deferred.
