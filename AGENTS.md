# AGENTS.md — working agreements

Rules for anyone extending **pixel-agents**, human or AI. Read this before
changing code. [README.md](README.md) says what the project is and how to build a
world with it; [docs/design.md](docs/design.md) explains why the system is shaped
this way. This file is the short, binding version: **what you must and must not
do.**

The golden rule: **build on the existing stack — Colyseus + Phaser — don't
introduce a parallel engine.**

> 🤖 Essentially all of this code was written by AI agents working mostly
> autonomously. The invariants below are therefore not style preferences: they are
> the contract that keeps independent extensions composable. A change that breaks
> one is a regression even if it works. When in doubt, run the `mmo-readiness`
> skill — it checks the contract for you.

Direction: this is the seed of a small **MMO-style** world — many participants,
players and NPCs beside the agents, interaction between them. Design so that
survives: authoritative server state plus client interpolation, never client-side
truth. When you add something, ask "does this still hold with N players moving and
interacting?"

## Architecture invariants

1. **The server simulates.** Movement, seating, stations, the FSM, poses — all of
   it runs in `shared/office` on the server's tick loop (`SimRoom` →
   `OfficeState.update`). Every viewer sees one identical world.
2. **The client renders and forwards input; it may present.** It draws synced
   `@pixel/shared/schema` state and interpolates. It must not run the FSM, pick
   behaviour or resolve positions. If the client needs a *decision*, sync it —
   don't recompute it from partial data. The one exception is **presentation
   timing** (animation frame phase within a synced pose, the Matrix sweep):
   cosmetic, wasteful to sync, never gameplay. Sync state and intent, not frames.
   If a frame ever drives gameplay, its timing moves back to the server.
3. **Deterministic and grid-based.** Tile-based A* (`layout/tileMap.ts`). No
   physics engine — it would cost determinism and headless execution.
4. **One occupancy model.** Every place a character can be is an
   `InteractionPoint` (`posture`, one `occupantId`) in `OfficeState.points` —
   chairs and appliance stand tiles alike. Claims go through `claimPoint` and are
   **symmetric**: agents and players exclude each other, whoever got there first.
   A character holds at most `homePointId` (its reservation) and `atPointId`
   (where it is). Approach tiles are derived (`computeApproachTiles`), never a
   hardcoded list per type.
5. **Animation is pose-driven.** `CharacterPose` is computed server-side and
   synced; the renderer resolves frames through `spriteForPose()` alone. A new
   animation = a new pose + one branch there + the frames. Never branch on
   `state` or tool names in the renderer.
6. **One port for everything.** Browser, Colyseus and the agent feed share one
   HTTP server. Mount on it (`attachFeedServer`); don't add listeners.
7. **Never trust the client.** Every `onMessage` handler and every `/feed` payload
   is untrusted input. Client-side checks are UX only; the authoritative gate is
   server-side. Validate identity, length, format and bounds before persisting or
   mutating, and reject silently. A new message ships with its server-side
   validator in the same change.
8. **Reuse the entity, zone and portal model.** Synced entities extend
   `EntitySync`; players are `Character`s with `isPlayer = true`. A zone is an
   instance of the one room type (`filterBy(['zone'])`) — never a room class per
   zone. Travel is placed furniture with a `portal` action — never a hard-coded
   coordinate jump.
9. **Support Chrome *and* Firefox.** Every feature works in both current
   Chrome/Chromium (the Electron shell counts as Chrome) and Firefox. This bites
   hardest in media: use `HTMLMediaElement.setSinkId` (both), not
   `AudioContext.setSinkId` (Chrome only). If an API exists in only one, gate it
   and keep the other browser working.
10. **Every client change must also work in Electron.** The same bundle runs
    served-by-the-server and from a local `app://` origin talking to a *remote*
    server. So: no relative URLs to the server (`fetch('/api/…')` hits `app://`) —
    go through `net/room.ts`'s helpers; don't derive the server from
    `window.location`; auth is a cookie in the browser and a bearer token on the
    desktop; `window.location.reload()` is silently dropped — use `reloadApp()`;
    desktop-only capabilities go through the typed preload bridge with a browser
    fallback.

## Security

Security is a first-class requirement, not a later pass.

- **Assume the client is fully compromised.** Every access-control decision —
  identity, `isAdmin`, `allowPixels`, zone assignment, spectator status,
  capabilities — is resolved **server-side from the account/session**, never from
  a value the client sent. A client flag may at most affect a self-only,
  privilege-free presentation choice. If client input can influence an
  authorization outcome, it is a bug.
- **Personal data is keyed by the authenticated `userId`** (from `onAuth`), never
  by an id or name in the payload. A user reads and mutates only their own avatar,
  preferences, viewer settings, password and agent token.
- **Shared and admin actions go through `permissions.ts`** — `may(client,
  capability, zoneId?)`. Gallery/asset edits, zone create/delete, user management
  and granting zone-admins need global admin; a zone's map, arrival point and NPCs
  need that zone's admin. Slash commands are gated by their registry group
  (`mayRunCommand`). **Default to deny.**
- **Secrets stay on the server**: LiveKit key/secret, the admin token and scrypt
  hashes never reach a client. A viewer gets only its own agent token and
  short-lived, room-scoped LiveKit JWTs whose identity is its own avatar. Bound
  the length of anything you verify, so verification can't become a CPU DoS.
- **Serve over TLS in production.** The session cookie and the desktop bearer
  token are capabilities; media needs a secure context anyway. Plain HTTP is for
  development only.

## Conventions

### Code

- **Decorator gotcha:** `@colyseus/schema` needs `experimentalDecorators` +
  `useDefineForClassFields: false`, and `tsconfig` maps `@pixel/shared/office/*`
  to source so tsx applies decorators correctly. Don't "fix" these into a bundle.
- **Sprites are data:** `SpriteData = string[][]` of hex colours (`''` =
  transparent). Character sheets default to 16×32, 3 direction rows, 7 frames/row,
  but frame size is per-character (≤64×64) and per-pose frame counts are
  **track-driven** via `CharacterSpec` (`sprites/characterSpec.ts`). Adding a pose
  means a new `CharacterPose` + a `spriteForPose` branch + a track name.
- **Measuring performance:** judge by **frame/CPU time**, not proxies like
  triangle count (greedy meshing once measured *slower* despite −20 % tris). The
  client has a perf overlay — **F8** or `?perf=1` — and sleeps its render loop
  when nothing moves.

### UI — one look for all chrome

Every in-app surface (menus, panels, dialogs, editors, buttons, inputs, chips)
uses one style, defined canonically in the CSS block in
`client/src/scenes/OfficeScene.ts`. **Reuse those classes** rather than
hand-rolling: `.pa-btn`, `.pa-panel` + `.pa-head`/`.pa-body`/`.pa-x`, `.pa-b`
(+ `.primary`/`.danger`/`.wide`), `.pa-seg`/`.seg`, `.pa-chip`, `.pa-menurow`,
`.pa-list-row`, `.pa-thumb`. A self-contained widget that cannot share the
stylesheet must mirror the same tokens — including non-CSS colour literals (e.g.
`PhaserRenderer`'s `VOICE_RING_COLOR` matches the active-tab underline).

Tokens (from uponu.com's palette). Font `'FS Pixel Sans', ui-monospace,
monospace`. Surfaces: window/panel `#1c1a19`, raised `#242220`, inset `#262422`,
deep-inset `#141312`, segment-on `#37342f`. Border **always `2px solid #0a0908`**.
Bevel `inset 0 2px 0 #4a4744, inset 0 -3px 0 #050505` (panels: `#292725`/`#030303`
plus `0 12px 28px rgba(0,0,0,.55)`). Text `#f1efec`/`#f5f3f0`, muted `#adb0b2`,
dim `#818586`, link `#4998c0`. Accents: primary red `#c51a1b` (inset
`#e2585a`/`#5c0f10`) for primary actions *and* "on" toggle states; danger `#7c2634`
(`#b34a5a`/`#45111a`) deliberately darker so destructive stays distinct; warn
`#a86a2e`; live/active green `#7fbf6a`/`#5aa348` for status indicators only, never
a button; highlight `#e7da00`. Radius: buttons `0.35–0.45rem`, panels `0.6rem`.

**Deprecated — do not use** (pre-restyle): panel `#14161c`/`#1b1f2a`, control
`#2a2f3a`, borders `#3a4150`/`#2c323e` or any `1px solid` on chrome, accent
`#3a6df0`, flat `0 8px 0` shadows. (`#14161c` is fine as the Phaser *canvas*
background only.)

### Content pipeline

- **A tileset is what its tiles say it is, not what it is called.** A furniture
  tileset is one whose tiles carry the `FurnitureTile` class
  (`isFurnitureTileset`) — no filename prefix decides anything. A layout *names*
  the sets it uses and per-tile numbers index that table, so renaming is safe and
  reordering is a no-op. Nothing enumerates tileset filenames; the client asks
  `/assets/tiled/sets.json`.
- **Furniture behaviour is stated on the tile, never inferred.** Sittability,
  facing, pet perching, what it turns into when switched on — each is its own
  property, present on **every** furniture tile with its default filled in, and
  overridable per placement (`server/src/tiled/furnitureProps.ts`). When you add,
  rename or retire a property, do it in the same commit as `FURNITURE_TILE_PROPS`
  and then distribute it with `scripts/sync-furniture-properties.sh`. Add it to
  **both** the `FurnitureTile` and `FurnitureObject` classes in
  `Pixels.tiled-project` — Tiled only offers a class's own members, so a property
  missing from `FurnitureObject` is settable on the type and invisible on every
  placement. Keep the object class a superset of the tile class.
- **A zone has exactly one map, and it comes from Tiled.** The `layouts` table is
  keyed by zone id: no named layouts, no active-layout pointer, no bundled
  read-only default, no code-generated zone. The import is one-way; there is no
  exporter and no in-game world editor.
- **Zone maps are versioned but pushed, never deployed.**
  `assets/tiled/zones/*.tmj` is committed so levels are diffable and shareable,
  and a bundled map **seeds a zone that has none** at startup
  (`tiled/seedBundledZones.ts`), so a fresh deployment has a world. Seeding never
  overwrites: a zone that already has a map keeps it, because a push is authored
  against *that* deployment and a release must not undo one. Changing a live map
  is always `scripts/push-zones.sh` (auth: `PIXEL_ADMIN_TOKEN` in
  `X-Pixel-Admin-Token`). Scratch copies (`*-noimport.tmj`) stay out of git.
- **Slash-commands for navigation and quick actions.** The framework in
  `shared/src/commands.ts` (`user`/`admin` groups, gated by `mayRunCommand`) is the
  canonical way to reach another view or trigger a quick action — client-side via
  `ChatUI`'s `clientCommand` hook, server-side in `accountCommands.ts`. A new
  destination or chat-triggerable feature gets a command in the same change; it
  then shows up in `/help` automatically.

### Operations

- **Config via env:** `PIXEL_STREAM_PORT`, `PIXEL_STREAM_HOST`,
  `PIXEL_ADMIN_TOKEN` (also `--token`), `PIXEL_STREAM_DATA_DIR` (holds the single
  `pixel.db`), `PIXEL_RESET_WORLD`.
- **`PIXEL_RESET_WORLD=<token>`** empties everything except the `users` table and
  the personal `playerAvatar` assets, once per token, at the next start — before
  any store reads or seeds. A `VACUUM INTO` backup is written first, and no backup
  means no wipe. Survivors are an allow-list (`server/src/worldReset.ts`): a table
  added later is wiped by default, so **if you add one holding account data, add
  it to `KEEP_TABLES` in the same change.**
- **One database.** All state lives in `pixel.db` through the shared `db.ts`
  connection.
- **Accounts:** users live in the `users` table keyed by a lowercase, immutable
  `user_id` (login id and agent-owner key) with a free display name, a scrypt
  password, an admin flag and a per-user agent token. Presenting
  `PIXEL_ADMIN_TOKEN` at login makes that user an admin and creates the account if
  new — the only way to create users. No admin token set = open dev mode
  (anonymous, no login). Agents authenticate the feed with their owner's token.
- **Shell scripts are the front door.** Anything a human runs is a `.sh` in
  `scripts/`, and *what* it starts — node, tsx, anything — is the wrapper's
  business, not the caller's. Never put `node --import tsx scripts/….mts` in docs,
  a README or a CI step. A new human-facing script gets its wrapper in the same
  change, with its usage in the header comment (`scripts/push-zones.sh` is the
  house style). Data — configs, fixtures — does not belong in `scripts/`; it lives
  under `assets/`.
- **Commits:** imperative, no `Co-Authored-By` or AI trailer. Don't commit or push
  without being asked. Prefer a few meaningful commits over micro-commits, and
  never leave debug scaffolding behind.

## Before you ship

- **Run the `mmo-readiness` skill** (`.claude/skills/mmo-readiness/`): typecheck +
  build, no behaviour-tree or server-only code in `client/dist`, no second game
  engine, every `onMessage` handler guarded, and the entity/zone/portal
  invariants. Treat its failures as blockers.
- `pnpm -r run check-types` and `pnpm build` must be clean.
- If you touched furniture properties:
  `scripts/sync-furniture-properties.sh --check` must report zero changes.
- If you touched the server: `cd server && pnpm test`. If you touched the desktop
  Mumble protocol: `cd desktop && pnpm test`.
- For engine changes, drive `OfficeState` directly in a small headless test, plus
  a run with `MOCK=N`. For client changes, sanity-check the Electron shell too —
  especially URLs, fetches, auth and navigation.
- Keep the client a renderer; keep logic in `shared` on the server.

## Claude Code — persistent memory

Conversation memory lives in **`.claude/memory/`** inside this repo (gitignored).
The home directory (`~/.claude/`) is ephemeral and may be wiped on rebuild; the
repo directory persists. Read it at the start of a session.
