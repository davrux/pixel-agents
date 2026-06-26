# AGENTS.md — working agreements for this repo

Guidance for any human or AI agent extending **pixel-agents**. Read this before
adding features. The golden rule: **build on the existing stack — Colyseus +
Phaser — don't introduce a parallel engine.**

## What this is

A multi-agent "office" world: Claude agents stream their activity to a central
server, which simulates animated pixel characters in an office; browsers render
the shared world. A rewrite of the original pixel-agents, swapping only the tech
(backend → Colyseus, frontend → Phaser); all graphics/animations/fonts/office
layout were carried over 1:1.

## Tech stack (the basis for all extensions)

- **Server: [Colyseus](https://colyseus.io/) 0.16** (`@colyseus/core`,
  `@colyseus/ws-transport`, `@colyseus/schema` 3.x) — authoritative simulation +
  state sync. Runs from TypeScript via **tsx** (no bundling).
- **Client: [Phaser](https://phaser.io/) 3.90** + `colyseus.js` 0.16, built with
  **Vite**. The client is a **pure renderer** of synced state.
- **pnpm workspace**, three packages:
  - `shared/` (`@pixel/shared`) — the office engine (FSM, characters, pets,
    sprites, colorize, layout) **and** the Colyseus schema. Runs on the server;
    its pure helpers are reused by the client renderer.
  - `server/` (`@pixel/server`) — Colyseus room, asset decoding, Claude `/feed`
    ingest, SQLite store (layouts + sessions + settings).
  - `client/` (`@pixel/client`) — Phaser scene, renderer, layout editor, UI.
- **Persistence:** Node's built-in `node:sqlite` (needs **Node 24**). No native
  deps.
- **TypeScript** everywhere, `moduleResolution: Bundler`, ESM (`.js` import
  specifiers resolve to `.ts`).

**Do not** add a different game engine, a physics engine, or a second rendering
path. New gameplay belongs in the shared office engine; new visuals belong in the
Phaser renderer. If a feature seems to need another tool, raise it first.

## Architecture rules (keep these invariants)

1. **Server-authoritative.** All simulation/decision logic (movement, seating,
   stations, FSM, pose) runs in `shared/office` **on the server's tick loop**
   (`SimRoom` → `OfficeState.update`). Every viewer sees one identical world.
2. **The client never simulates.** It renders the synced `@pixel/shared/schema`
   state and interpolates. Do not run the FSM or pick behaviour client-side. If
   the client needs to know something (e.g. a character's pose), **sync it in the
   schema** — don't recompute it from partial data.
3. **Deterministic, grid-based.** Movement is tile-based A* on a grid
   (`layout/tileMap.ts`). No physics engine — it would break determinism and
   headless server execution.
4. **Data model first.** Places an agent can occupy are `InteractionPoint`s
   (`posture: sit|stand`, `occupantId` for one-capacity reservation). Seats
   (chairs) still use the older `Seat` type and are meant to fold into
   `InteractionPoint` over time. Appliances (e.g. `COFFEE_MACHINE`) yield a
   `stand` point — extend `APPLIANCE_TYPES` in `officeState.ts` to add more.
5. **Animation is pose-driven.** A character's `CharacterPose`
   (`idle|walk|typing|reading|coffee`) is computed server-side
   (`getCharacterPose`) and synced. The renderer resolves frames through the
   single `spriteForPose()` mapping. **Add a new animation by adding a pose +
   one branch there + the frames** — never branch on `state`/tool in the
   renderer again.
6. **One port for everything.** Browser, Colyseus and the agent feed (`/feed`)
   share one HTTP server/port. Don't add extra listeners; mount on the shared
   server (see `attachFeedServer`).
7. **Never trust the client — validate on the server.** Every `onMessage`
   handler and `/feed` payload is untrusted input. Client-side checks (disabled
   buttons, input `maxlength`, format masks) are **UX only**; the authoritative
   gate lives in `SimRoom`. Validate identity/length/format/bounds there before
   persisting or mutating state, and reject silently on failure (e.g.
   `validCharacterData`, `validFurnitureData`, the asset-id regex, layout-name
   rules). When you add a new editable asset or message, add its server-side
   validator in the same change — a frontend-only check is not a check.

## Conventions

- **Decorator gotcha:** `@colyseus/schema` needs `experimentalDecorators` +
  `useDefineForClassFields:false`. `tsconfig` maps `@pixel/shared/office/*` to
  source so tsx applies decorators correctly. Don't "fix" these into a bundle.
- **Sprites are data:** `SpriteData = string[][]` of hex colours
  (`'' ` = transparent). Character sheets default to 16×32, 3 direction rows
  (down/up/right; left is mirrored), 7 frames/row (0–2 walk, 3–4 typing, 5–6
  reading; index 7+ feeds the `coffee` pose). Frame *size* is per-character and
  may differ (≤64×64): the editor resizes in-place, and a bundled PNG can carry
  an optional sibling manifest `assets/characters/char_N.json` =
  `CharacterSpec` (`{ frame:{w,h}, tracks:[{name,frames,play}] }`, see
  `shared/.../sprites/characterSpec.ts`). Absent → `DEFAULT_CHARACTER_SPEC`
  (the historical layout). The spec rides on `LoadedCharacterData.spec` to the
  client. Per-pose frame *counts* are still fixed in the engine/`spriteForPose`
  for now (track-driven playback is the next step).
- **Config via `PIXEL_STREAM_*` env** (matches the original + the feeder):
  `PIXEL_STREAM_PORT`, `PIXEL_STREAM_HOST`, `PIXEL_STREAM_TOKEN`,
  `PIXEL_STREAM_DATA_DIR`. Token also via `--token`.
- **Auth:** token login → HttpOnly cookie session in SQLite (`pixel_stream_sid`),
  validated in `SimRoom.onAuth`. Expired sessions auto-pruned. The feeder's
  `--user` becomes the agent's `folderName` (used for per-viewer sound filtering).
- **Default layout is read-only** and must never be overwritten.
- **Commits:** imperative, no `Co-Authored-By`/AI trailer. Don't commit or push
  without being asked.

## Build / run / deploy

```bash
pnpm install
# Dev (two processes; vite is HMR-only):
pnpm dev:server          # Colyseus + /feed
pnpm dev:client          # http://localhost:5173 (HMR)
# Production (one server, one port — this is what users/deploys use):
pnpm build               # type-check + vite build → client/dist
pnpm start               # serves client/dist + Colyseus + /feed on one port
```

There is **no separate client server in production** — `pnpm start` (and the
multi-stage `Dockerfile`) serve the built client from the same origin. A viewer
needs only a browser; an agent needs only Claude + `feeder/pixel-agents-feeder.cjs`
(`--server ws://host:PORT/feed --user <name> --token <t>`).

## Before you ship

- `pnpm -r run check-types` (or `tsc --noEmit` per package) must be clean.
- `pnpm build` must succeed.
- For engine changes, prefer a small headless test driving `OfficeState`
  directly (see how stations/poses were verified) plus a quick run with `MOCK=N`.
- Keep the client a renderer; keep logic in `shared` on the server.
