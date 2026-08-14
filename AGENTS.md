# AGENTS.md — working agreements for this repo

Guidance for any human or AI agent extending **pixel-agents**. Read this before
adding features. The golden rule: **build on the existing stack — Colyseus +
Phaser — don't introduce a parallel engine.**

> 🎮 **This is a fun, hobby project** — built for the joy of it, not as a hardened
> product. Expect rough edges; no stability, security, or support guarantees. Use
> it at your own risk and have fun. 🙂
>
> 🤖 **It is also a pure AI project** — essentially all of the code here was written
> by AI coding agents. Treat it accordingly. Because contributors are many and
> mostly autonomous, the architecture invariants below are not style preferences —
> they are the contract that keeps independent extensions composable. A change that
> breaks one is a regression even if it "works". When in doubt, run the
> `mmo-readiness` skill (see *Before you ship*) — it checks the contract for you.

## What this is

A multi-agent "office" world: Claude agents stream their activity to a central
server, which simulates animated pixel characters in an office; browsers render
the shared world. A rewrite of the original pixel-agents, swapping only the tech
(backend → Colyseus, frontend → Phaser); all graphics/animations/fonts/office
layout were carried over 1:1.

**Direction (where this is heading).** Treat this as the seed of a small
**MMO-style** world, not just a viewer. Expect it to grow toward: many
concurrent participants, **player- and NPC-controlled characters** alongside the
agent-driven ones, **character ↔ character / character ↔ NPC interaction**
(collisions, proximity, social/gameplay actions), and richer entities/objects.
Design new features so they survive that scale: keep the server the single
authority over **positions, movement, collision, occupancy and interaction
outcomes**; keep the client a renderer + input forwarder. When you add an entity
or behaviour, ask "does this still work with N players and NPCs moving and
interacting?" — favour authoritative server state + client interpolation over
client-side truth. (We are not there yet; just don't paint us into a corner.)

## MMO foundation — what's already in place

The groundwork for the MMO direction is built; **reuse it, don't reinvent it.**
New features must extend these, not grow a parallel mechanism beside them.

- **Unified entity model.** `EntitySync` (id + transform + coarse `state`) is the
  base schema; `CharacterSync`/`PetSync` extend it, and a new entity kind
  (monster, NPC, item) extends it too — never redeclare transform/sync. Movement,
  pathing and pose primitives live in `shared/office/engine/entity.ts`
  (`MovingEntity`, `stepAlongPath`, `snapToTile`) and are shared by every moving
  thing. **Players are `Character`s with `isPlayer = true`** — not a separate code
  path. Add capabilities by extending the entity/schema, not by forking it.
- **Zones = rooms.** Each explorable space is its own instance of the one room
  type, matchmade by `zone` (`gameServer.define(WORLD_ROOM, SimRoom).filterBy(['zone'])`,
  `ZONES`/`ZoneConfig`/`resolveZone` in `protocol.ts`). Add a zone by adding a
  `ZONES` entry + a layout — **do not** add a new room class per zone.
- **Portals are content, not code.** A portal is placed furniture carrying the
  catalog `portal` flag (a door, a beam pad); the server derives trigger tiles
  from where it is placed and offers a destination picker. Add travel by placing
  furniture and editing `ZONES`, never by hard-coding a coordinate jump.
- **Human players.** Spawn/despawn (spectator toggle), click-to-walk (server
  resolves the path), avatar/skin selection, naming (own avatar = player name;
  agents = `<player>-Agent`), and per-`(name, zone)` persistence of position +
  prefs (SQLite `appStore`). Player input arrives as messages and is resolved
  server-side — see the validation rule below.
- **Data-driven content + editors.** Furniture affordances (`appliance`,
  `portal`), animation groups and on/off state groups are catalog data, authored
  in the in-browser editors (character, NPC, furniture) with a shared pixel
  select/paste tool. New content is data + a catalog entry, not new render code.
- **Server-only NPC brain.** NPC decisions run through a mistreevous behaviour
  tree **on the server**. The BT and its deps must **never** enter the client
  bundle (the skill greps `client/dist` for this).

**Known gaps — fill these the MMO-correct way (don't design around them):**

- **No interest management (AOI).** Every client in a zone currently receives the
  full zone state. This is fine at today's counts but won't scale; when it bites,
  add spatial/range filtering (Colyseus `@filter`/`StateView` or per-client views)
  — **do not** "solve" scale by moving authority to the client.
- **No reconnection grace.** `onLeave` despawns immediately; a dropped socket
  loses the entity until rejoin. Prefer `allowReconnection` when this matters.
- **Single process.** matchMaking + state are in-process; horizontal scale needs a
  Colyseus presence/driver (e.g. Redis). Keep rooms shared-nothing so that stays
  possible — no module-global mutable game state outside a room.
- **No progression / chat / combat yet.** Levels, stats, chat channels, monsters
  and dungeons are intended but unbuilt. When you add them, put the authority and
  rules server-side and sync results, exactly like movement and interaction.

## Tech stack (the basis for all extensions)

- **Server: [Colyseus](https://colyseus.io/) 0.17** (`@colyseus/core`,
  `@colyseus/ws-transport`, `@colyseus/schema` 4.x) — authoritative simulation +
  state sync. Runs from TypeScript via **tsx** (no bundling).
- **Client: [Phaser](https://phaser.io/) 3.90** + `@colyseus/sdk` 0.17 (the
  successor to the `colyseus.js` package, which stopped at 0.16), built with
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
2. **The client never simulates; it may present.** It renders the synced
   `@pixel/shared/schema` state and interpolates. Do not run the FSM, pick
   behaviour, or resolve positions/collisions client-side. If the client needs a
   *decision* (e.g. which pose a character is in), **sync it in the schema** —
   don't recompute it from partial data. **Exception — purely cosmetic
   presentation timing** may be advanced locally from synced state, because it
   never affects simulation and would be wasteful to sync per tick: the
   **animation frame phase** is timed client-side from the synced `pose`+`dir`
   (see `POSE_FRAME_MS` / `getPosePlaybackLength`), and the Matrix sweep is
   advanced locally between the server's ~20 Hz updates. The rule of thumb for
   the MMO direction: **sync state/intent, not frames** — anything that two
   viewers could legitimately see a frame apart is presentation, not state.
   (If a frame ever drives gameplay — e.g. attack "active frames" — that timing
   moves back to the authoritative server.)
3. **Deterministic, grid-based.** Movement is tile-based A* on a grid
   (`layout/tileMap.ts`). No physics engine — it would break determinism and
   headless server execution.
4. **Data model first.** Places an agent can occupy are `InteractionPoint`s
   (`posture: sit|stand`, `occupantId` for one-capacity reservation *per
   point*). Seats (chairs) still use the older `Seat` type and are meant to
   fold into `InteractionPoint` over time. Appliances are data-driven — any
   catalog entry with the `appliance` flag (see `getCatalogEntry(...).appliance`)
   yields a stand point per walkable tile around its footprint (not just
   one), via `OfficeState.computeApproachTiles` — no hardcoded type list to
   extend. That same helper backs conference monitors, arcade cabinets and
   meeting-room kiosks too; `findFreeStation()` already picks randomly among
   every free point, so registering more points per item is what spreads
   simultaneous visitors around one item instead of stacking them.
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
8. **Support Chrome AND Firefox.** The client is a cross-browser web app — every
   feature must work in both current Chrome/Chromium and Firefox (the desktop
   Electron shell is Chromium and counts as Chrome). This matters most for media:
   prefer APIs both implement, and when one lacks an API, degrade gracefully
   rather than break. Concrete examples already in the codebase: output-device
   selection uses `HTMLMediaElement.setSinkId` (both) — **not**
   `AudioContext.setSinkId` (Chrome-only); voice volume boost routes through a
   Web Audio `GainNode` into an `<audio>` element (both), with a muted "pump"
   element for Chrome's remote-track-into-WebAudio quirk. Don't ship a feature
   that only works in one browser; if unavoidable, gate it and keep the other
   browser functional.
9. **Authorization & data isolation are a first-class requirement.** Security is
   not an afterthought — every change must preserve these boundaries:
   - **Assume the client is fully compromised.** This is a deliberate threat-model
     decision: treat *every* byte from a client (join options, message payloads,
     headers) as attacker-controlled. **Every** access-control decision — identity,
     `role`, `isAdmin`, `allowPixels`, zone assignment, spectator/spatial status,
     capabilities — is resolved **server-side from the account/session**, never from
     a value the client sent. A client can *never* grant itself a setting: e.g.
     `allowPixels` (spatial Pixels avatar) and spectator status are derived in
     `SimRoom.onAuth`/`gateEntry` from the stored `User`, and a client join flag must
     never flip an authorization outcome (a client flag may at most affect a
     self-only, privilege-free presentation choice). If a decision can be influenced
     by client input, it is a bug.
   - **Personal data is keyed by the authenticated `userId`** (from `onAuth`),
     **never** a client-supplied id/name. A user can only read/mutate *their own*
     avatar, prefs, viewer settings, password and agent token. Handlers like
     `saveAvatar`/`avatarFromTemplate`/`setPassword`/`setUsername`/viewer-settings
     resolve the target from `authOf(client)`, not from the payload.
   - **Shared/world + admin actions go through `permissions.ts`** — call
     `may(client, capability, zoneId?)`. Gallery/asset edits, zone create/delete,
     user management and granting zone-admins need global admin; a zone's layout/
     arrival/NPCs need that zone's admin (or global). Slash commands are gated by
     their registry `group` (`mayRunCommand`). **Default to deny**; a normal user
     must never reach an admin-only or another-user's area.
   - **Secrets stay on the server.** LiveKit API key/secret, the admin token and
     scrypt password hashes never reach the client; a viewer only ever receives
     **its own** agent token (and short-lived, room-scoped LiveKit JWTs whose
     identity is the requester's own avatar). Tokens/passwords have bounded
     length so verification can't become a CPU DoS.
   - Client-side hiding of controls is **UX only**; the server is the gate. When
     you add a message or command, decide its capability/ownership in the *same*
     change and enforce it server-side.
   - **Serve over TLS in production.** The session cookie and the desktop
     `Authorization: Bearer <sid>` token are confidential capabilities (a valid
     one grants that user's access), so production must be `https`/`wss` — either
     the built-in TLS (drop `cert.pem`/`key.pem` in the data dir, or set
     `PIXEL_TLS_CERT`/`PIXEL_TLS_KEY`) or a TLS-terminating reverse proxy. Media
     (getUserMedia/WebRTC) also requires a secure context. Plain `http` is dev-only.
10. **Every client change must also work in the Electron desktop app.** The same
    client bundle runs in two environments: a browser served by the server, and
    the Electron shell (`desktop/`), where the page is loaded from a local
    `app://` origin and talks to a *remote* server. Whenever you touch the
    client, consider both; the desktop-specific traps are:
    - **No relative URLs to the server.** In the desktop shell,
      `fetch('/api/...')` hits the `app://` origin, not the server. Resolve
      server URLs through the existing helpers (`isDesktop()` +
      `serverHttpOrigin()` in `net/room.ts`; see `resolveArcadeUrl` in
      `arcade/ArcadeUI.ts` and `arcade/wadClient.ts` for the pattern).
    - **Don't derive the server from `window.location`.** On desktop the
      configured server origin comes from `desktop/bridge.ts`
      (`getConfiguredServerOrigin()`); the `window.location`-shaped helpers in
      `room.ts` already handle this — go through them.
    - **Auth differs:** the browser uses the session cookie; the desktop sends
      `Authorization: Bearer <sid>`. New server endpoints and client fetches
      must work with both (and cross-origin requests from `app://` mean CORS
      and cookies behave differently than same-origin browser requests).
    - **`window.location.reload()` is silently dropped** in the `app://` shell —
      use `reloadApp()` from `desktop/bridge.ts`.
    - Desktop-only capabilities (token storage, screen-source picking, window
      controls) go through the typed `PixelDesktopApi` preload bridge, with a
      graceful browser fallback — `isDesktop()` is the discriminator; never
      bake desktop-specific behavior into the public web bundle unguarded.

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
  client. Per-pose frame *counts* are **track-driven**: `getCharacterSprites`
  builds variable-length sequences from the spec's tracks, `spriteForPose`
  indexes them, and the character editor edits the counts/play-mode per track
  (walk/typing/reading/coffee) — the saved override carries its `spec`, and the
  server validates that track frames sum to the frame count. Adding a *new* pose
  still means a new `CharacterPose` + a `spriteForPose` branch + a track name.
- **UI design system (the pixel-menu look) — one look for all chrome.** Every
  in-app UI surface (menus, panels, dialogs, editors, buttons, inputs, chips)
  uses a single style, defined canonically in the CSS block in
  `client/src/scenes/OfficeScene.ts`. **Reuse those classes** instead of
  hand-rolling styles: `.pa-btn` (top-bar buttons), `.pa-panel` +
  `.pa-head`/`.pa-body`/`.pa-x` (popovers/dialogs), `.pa-b` (+ `.primary`/
  `.danger`/`.wide`), `.pa-seg`/`.seg` (tabs), `.pa-chip`, `.pa-menurow`,
  `.pa-list-row`, `.pa-thumb`. A self-contained widget that can't share the
  stylesheet (e.g. `conference/ConferenceUI.ts`) must **mirror the same tokens**.
  Non-CSS color literals count too — e.g. `PhaserRenderer.ts`'s
  `VOICE_RING_COLOR` is a Phaser numeric hex chosen to match the active-tab
  underline; a palette change must update those alongside the CSS.
  - **Tokens** (adopted from uponu.com's brand palette). Font `'FS Pixel
    Sans', ui-monospace, monospace`. Surfaces: window/panel `#1c1a19`, raised
    control `#242220`, inset control/input `#262422`, deep-inset
    (segments/thumbs) `#141312`, menurow `#242220`, segment-on `#37342f`.
    Border **always `2px solid #0a0908`**. Signature bevel =
    `box-shadow:inset 0 2px 0 #4a4744,inset 0 -3px 0 #050505` (panels use
    `#292725`/`#030303` + a `0 12px 28px rgba(0,0,0,.55)` drop). Text
    `#f1efec`/`#f5f3f0`, muted `#adb0b2`, dim/label `#818586`, link/kbd
    `#4998c0`. Accents: primary red `#c51a1b` (inset `#e2585a`/`#5c0f10`) —
    used for primary actions AND for on/off toggle states that read as
    "active" (mic/camera/track "on", conference `button.on`); danger
    `#7c2634` (`#b34a5a`/`#45111a`) is deliberately a **different, darker**
    red so destructive actions stay visually distinct from primary ones; warn
    `#a86a2e`; active/live (status indicators only — equalizer, live-dot,
    active-tab underline, voice ring — never a button) `#7fbf6a`/`#5aa348`;
    highlight `#e7da00`. Radius: buttons `0.35–0.45rem`, panels `0.6rem`.
  - **Deprecated — do NOT use** (the pre-restyle palette): panel bg
    `#14161c`/`#1b1f2a`, control `#2a2f3a`, borders `#3a4150`/`#2c323e` (or any
    `1px solid` on chrome), accent `#3a6df0`, flat `0 8px 0`/`0 6px 0` shadows.
    (`#14161c` is fine only as the Phaser *canvas* background, not UI chrome.)
- **Config via env:** `PIXEL_STREAM_PORT`, `PIXEL_STREAM_HOST`,
  `PIXEL_ADMIN_TOKEN` (admin login token; also `--token`), `PIXEL_STREAM_DATA_DIR`
  (holds the single `pixel.db`).
- **Accounts & auth:** users live in the `users` table (`UserStore`), keyed by a
  lowercase `user_id` (login id, also the agent owner key) with a free display
  `username`, a scrypt password (`pw_algo` records the scheme), an `is_admin`
  flag, and a per-user `agent_token`. Login = login id + password → HttpOnly
  cookie session in SQLite (`pixel_stream_sid`, keyed by `user_id`), validated in
  `SimRoom.onAuth` → `{userId, username, isAdmin}`. Presenting `PIXEL_ADMIN_TOKEN`
  at login makes that user an admin and creates the account if new (the only way
  to create users for now — no open self-registration). No admin token set →
  open dev mode (anonymous, no login). World/asset editing is admin-only. Agents
  authenticate the feed with their own `agent_token` (resolves to the owner);
  the avatar's name is always the player's display name.
- **One database:** all state lives in `pixel.db` via the shared `db.ts`
  connection (sessions, users, settings, assets, layouts, zones); a one-time
  migration imports the old split `layouts.db` + `zones.db`.
- **Default layout is read-only** and must never be overwritten.
- **Slash-commands for navigation & quick actions.** The chat slash-command
  framework (`shared/src/commands.ts`, `user`/`admin` groups, gated by
  `mayRunCommand`) is the canonical way to reach other views/destinations and
  trigger quick actions. **When you add a new destination (page, portal) or a
  chat-triggerable feature, add a matching command** in `commands.ts` and
  handle it — client-side via the shared `ChatUI` `clientCommand` hook for
  navigation (e.g. `/admin-site` opens the in-game admin overlay in-place —
  see `client/src/admin/main.ts`'s `openAdminOverlay`, dynamically imported so
  non-admins never pay for its bundle weight — rather than navigating to a
  separate page, which would tear down the zone's voice call; a destination
  that genuinely needs its own page can still set `window.location`, carrying
  the current zone as `?zone=` where relevant), or server-side in `accountCommands.ts` for
  account/admin actions. It then shows up in `/help` automatically. Current
  set: `/help /afk /users /admin-site /add /delete /set-admin /remove-admin
  /kick`.
- **A tileset is what its tiles say it is, not what it is called.** A furniture
  tileset is one whose tiles carry the `FurnitureTile` class (see
  `isFurnitureTileset`) — the `furniture-` filename prefix used to decide that in
  four separate places and no longer decides anything, so name a new pack
  whatever suits it. **Exception, and it is a real one:** floor and wall tileset
  FILENAMES are load-bearing, because a saved layout stores an index into
  `FLOOR_SET_FILES` / `WALL_SET_FILES` — those arrays are append-only and
  renaming or reordering silently restyles every floor tile in every map.
- **Furniture behaviour is stated on the tile, never inferred.** Whether you can
  sit on something, which way you then face, whether a pet may perch on it, what
  it turns into when switched on — each is its own property, present on **every**
  furniture tile with its default filled in, and overridable per placement (see
  `server/src/tiled/furnitureProps.ts`, which defines the set once for the
  catalog reader, the map bridge and the sync script). Behaviour must never be
  derived from a taxonomy again: it used to come from `category === 'chairs'` and
  friends, so a correctly-drawn, correctly-categorised chair could still be
  unsittable with nothing in Tiled to point at.
  **When you add, rename or retire a furniture property, do it in the same
  commit as `FURNITURE_TILE_PROPS` and then distribute it:**
  ```bash
  cd server && node --import tsx scripts/sync-furniture-properties.mts
  ```
  That stamps the property onto all ~350 tiles across every
  `assets/tiled/furniture*.tsj`, clears retired ones out of the zone maps, and
  gives class-less furniture placements their `FurnitureObject` class. A tile
  that is merely *missing* a property silently behaves as if someone had chosen
  its default — which is the exact failure this whole arrangement exists to
  prevent. Also add the property to **both** the `FurnitureTile` and
  `FurnitureObject` classes in `assets/tiled/Pixels.tiled-project`: Tiled only
  offers a class's own members, so a property missing from `FurnitureObject` is
  settable on the type and invisible on every placement. Keep the object class a
  superset of the tile class, `label`/`name` aside.
- **Zone maps reach a server by being pushed, never by being deployed.**
  `assets/tiled/zones/*.tmj` is gitignored, so a level edit rides along with no
  release. Push it:
  ```bash
  cd server && node --import tsx scripts/push-zones.mts --server=<host:port> [--watch]
  ```
  Auth is `PIXEL_ADMIN_TOKEN` in `X-Pixel-Admin-Token` (see
  `src/tiled/zonePushApi.ts` for why that and not a session; the routes are
  registered *before* the login gate, which 401s any session-less GET). The dev
  server does **not** watch its zones directory — `--watch` against 127.0.0.1 is
  the same command as a deploy push, so local and production behave alike.
  The push also **syncs the tilesets and PNGs the server lacks**, by comparing
  content hashes first so a one-line map edit doesn't ship 3.8 MB; the server
  rebuilds its furniture catalog afterwards. `--no-assets` skips it. Those files
  are committed and do arrive with a deploy, so a pushed one only survives until
  the next release replaces it — which is the right outcome, not a loss.
- **Measuring performance:** judge render/mesher perf by **frame / CPU time**,
  not proxies like triangle count (greedy meshing once measured *slower* despite
  −20 % tris). The Pixels client has a perf overlay — **F8** or `?perf=1` (FPS +
  update() self-time) — and idles/sleeps its render loop when nothing moves.
- **Commits:** imperative, no `Co-Authored-By`/AI trailer. Don't commit or push
  without being asked. Prefer a few meaningful commits over micro-commits, and
  never leave debug scaffolding (e.g. temporary URL hooks) in the code.
- **Pushing to Codeberg:** `origin` (codeberg.org) hangs over IPv6 — always push
  with `GIT_SSH_COMMAND="ssh -4" git push …`.

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
(`--server ws://host:PORT/feed --token <your-agent-token>` — the per-user token
identifies the owner; copy it from in-app Settings).

## Before you ship

- **Run the `mmo-readiness` skill** (`.claude/skills/mmo-readiness/`). It audits
  the architecture contract automatically: typecheck + build, no behaviour-tree /
  server-only deps in `client/dist`, no second game/physics engine, every
  `onMessage` handler has a server-side guard, and the entity/zone/portal
  invariants above. Treat its failures as blockers.
- `pnpm -r run check-types` (or `tsc --noEmit` per package) must be clean.
- `pnpm build` must succeed.
- If you touched furniture properties:
  `cd server && node --import tsx scripts/sync-furniture-properties.mts --check`
  must report zero changes (see the furniture-behaviour convention above).
- For engine changes, prefer a small headless test driving `OfficeState`
  directly (see how stations/poses were verified) plus a quick run with `MOCK=N`.
- For client changes, sanity-check the Electron desktop app too (rule 10) —
  especially anything touching URLs, fetches, auth, or navigation/reload.
- Keep the client a renderer; keep logic in `shared` on the server.

---

## Claude Code — persistent memory

Conversation memory lives in **`.claude/memory/`** inside this repo (gitignored —
not committed). The home directory (`~/.claude/`) is ephemeral and may be wiped
on rebuild; the repo directory is persistent. Read memory from `.claude/memory/`
in the repo at the start of each session.
