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
   it runs in `shared/src/office` on the server's tick loop (`SimRoom` →
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
  client has a perf overlay — **F8** or `?perf=1` — showing fps, frame time,
  character count and `tex/p/f` (live textures / atlas pages / packed frames), and sleeps its render
  loop when nothing moves.
- **Sprites reach the GPU through one runtime atlas** (`client/src/render/sprites.ts`):
  `spriteTexture()` packs each SpriteData into shared canvas pages and returns
  `{key, frame}`. A texture per sprite is what breaks batching — a painted decal
  field is hundreds of distinct 16×16 pieces, i.e. hundreds of binds per frame —
  so anything that draws a sprite goes through that function, never
  `createCanvas` of its own. Two exceptions, both deliberate: the Matrix effect
  (fresh pixels every frame) and uploaded background images (real PNGs).
- **A baked sheet is already an atlas — never slice one into pixels.** Floor and
  wall sheets are registered as one texture per set and drawn by frame
  (`registerSheetTexture`/`sheetFrame`); `shared` names a cell (`SheetCellRef`)
  and stays free of graphics concepts. Slicing them into `SpriteData` is what the
  client used to do, and it turned 533 KB of PNG into ~34 MB of hex strings
  (measured 88.6 → 58.9 MB of heap when it stopped). The same applies to any art
  that arrives as an image: keep it an image.

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

- **The client waits for its art, then draws once** (the loading phase in
  `OfficeScene.runLoadingPhase`, panel in `ui/loadingOverlay.ts`). Four independent
  channels feed the first frame — sets.json plus the sheet PNGs, the baked atlas, the
  catalog message, the layout message — and nothing orders them. Drawing as they landed
  gave grey floors, black boxes where trees belong and a burst of "no art for …"
  warnings, all repainted a moment later. So: fetch the HTTP art, wait for both
  messages, prefetch the ref images THIS map's placements name (`prefetchRefImages`),
  draw once. `update()` returns early while it runs, because the renderer syncs
  furniture every frame and would otherwise resolve ids whose art has not arrived —
  which is what it did, invisibly in Chrome and 62 times over in Firefox.
  Two rules that keep it honest: the wait has a deadline (a panel that never goes away
  is worse than a partial world), and the live-change paths stay — a tileset saved in
  Tiled still introduces art nobody has fetched, and that repaint is what draws it.

### Content pipeline

- **Importing an art pack follows the `tiled-asset-import` skill**
  (`.claude/skills/tiled-asset-import/`). It carries the three decisions every
  import faces — what each piece IS (floor, flat decal, standing decal, furniture),
  sheet or collection, palette or natural-only — and the mechanics that have each
  cost a bug: the 2 px gap plus 1 px extrusion on every sheet, ids as identity,
  deterministic output, and appends that leave existing gids alone.
- **`png/src` is art, `png/baked` is a build product.** ALL art lives under
  `assets/tiled/png/src/` — whether it was drawn by hand (`floors/`, `walls/`) or
  cut from a pack by an import (`furniture/`, `decal/`, `sheets/`, `images/`). A
  map designer only ever puts files there. `png/baked/` holds exactly what can be
  reproduced from `png/src/` alone — the palette-baked floor and wall sheets and the
  furniture atlas — and **nobody places anything in it**. The atlas restores itself
  on the next start; the sheets need `bake-floor-wall-tiled.mts`, deliberately by
  hand, because that bake also writes the floor/wall TILESETS and a changed tile
  count would move every gid in every map.
  That property is the point, and it is what decides where a file goes: the two
  imported grid sheets (`decal-overworld`, `decal-roads`) are cut from packs that
  live outside the repo, so a checkout cannot regenerate them — they are source,
  not build output, however script-written they look. Get that wrong and "clean out
  baked/" silently destroys art.
- **Authoring format follows what a TILE has to say; the browser gets one image
  per kind.** A furniture piece is one object with its own size and its own
  behaviour, so it is one tile → a collection of images. Ground and decoration cut
  from an art sheet are pictures per cell whose arrangement IS the content → a grid
  sheet. Those two are the only choices, and Tiled cannot open the atlas anyway (it
  is shelf-packed with 28 frame sizes). Delivery is then uniform: a grid sheet is
  already one image, and collections are packed into the atlas.
- **The atlas is baked by the server, not by remembering to run a script.**
  `ensureFurnitureAtlas` (`server/src/tiled/furnitureAtlas.ts`) re-bakes at startup
  and on a tileset save when the source art has changed, fingerprinted by CONTENT
  so a fresh clone does not rewrite the artifact. `scripts/bake-atlas.sh` stays for
  baking without a server and for `--check`. Why it matters: a stale atlas silently
  changes the delivery format — ids it lacks travel as single files instead — so
  "one image or many" would depend on whether somebody ran a script. It is still
  committed, because two of the baked sheets are cut from packs that live outside
  the repo and cannot be regenerated from a checkout.
- **Nothing outside the tileset says where art lives.** A `.tsj` names its own
  image; `sets.json` passes that path (and the atlas manifest's) to the client. The
  client used to assemble `png/<set>.png` itself, and moving the baked sheets would
  then have needed a client release to find art that had not changed.
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
- **The GroundLayer decides what is ground — not the tile.** A cell painted on
  `GroundLayer` becomes ground whatever tileset it came from: the layout stores the
  tile's LOCAL ID plus which set it belongs to (`OfficeLayout.tiles` +
  `tileFloorSet`/`floorSets`), so an imported art sheet is ground exactly like a
  palette-baked floor set, and no bake is needed for either. This replaced a
  `class === 'FloorTile'` test in the importer that turned every other ground tile
  into VOID — silently, and VOID is neither drawn nor walkable, so a region painted
  with pack art was both invisible and closed. The one restriction left is physical:
  a ground cell is one map cell, so a tileset with bigger tiles is refused with a
  message (`groundFits`).
  Ground and decal are now the same shape (a cell of a sheet) and differ only in
  what the layer means: ground is underneath and makes the cell standable, a decal
  is a picture and never affects walkability. **Only the ground makes a cell
  walkable** — art alone never does.
  **No tile class decides anything any more.** `FloorTile` and `WallTile` are both
  gone: neither carried a property, and the one fact they encoded — how tall a cell
  is — is stated by the tileset itself (`tilewidth`/`tileheight`, passed to the
  client in `sets.json` and kept in one `SheetGrid` table). A `SheetCellRef` is now
  just (sheet, row, col), and a sheet cell is a sheet cell whether it draws ground or
  a wall piece. What still classifies is the LAYER (`GroundLayer`,
  `WallLatticeLayer`, `DecalLayer`, `CollisionLayer`) and, for things with
  behaviour, `FurnitureTile`/`DecalTile` — those carry real properties.
- **Decoration is a decal, not an object.** A `DecalTile` painted on a
  `DecalLayer` is a picture and nothing else — it lives in the *layout* (one
  `layoutLoaded`, like the floor), never in `OfficeState.furniture`, so it has no
  synced fields and no scan walks it. That is what lets a map paint hundreds of
  ground patches; a furniture placement costs fifteen synced fields and eleven
  linear scans, which is right for a chair and wrong for grass. Consequences to
  keep: a decal never blocks (the `CollisionLayer` does that), carries no Action,
  and states no behaviour of its own. Anything that must be *interacted with*
  stays furniture. Add a decal property the same way as a furniture one: in
  `DECAL_TILE_PROPS`, in the `DecalTile` class, then distribute with
  `scripts/sync-furniture-properties.sh` (it dispatches per tile class).
- **Flat-or-standing belongs to the layer, not the tile.** A `DecalLayer`'s own
  `occludes` property decides whether everything painted on it lies under the
  characters or sorts against them, and the import copies that answer onto each
  cell (`PlacedDecal.occludes`). Deliberately not a tile property: whether a
  picture is background or an obstacle is a fact about the *place* — the same tree
  is scenery on a hillside and an obstacle beside a path — and a tile-layer cell
  has nowhere to carry an override, so a tile-level answer would force one for the
  whole map. It is also what lets furniture art be painted as a decal, since
  nothing is then read off the tile that a `FurnitureTile` could not answer.
- **A map's tileset table says where each tileset ENDS, not just where it starts.**
  The gid ranges come from the `.tmj`'s own `tilesets` array, and each entry is
  capped at the next entry's `firstgid` (`resolveFromTmjTilesets`) — never at the
  tileset's current tile count on disk. That is what makes **appending** art to a
  tileset harmless for maps saved before it: an older map keeps resolving to what its
  author painted, and simply cannot reach the new tiles until it is saved in Tiled
  again. Taking the count from disk instead let a grown tileset swallow the first
  cells of the next one — a decal in an older map came back as a fountain frame,
  silently. The cap is the smaller of the two answers, so a map NEWER than the
  tilesets leaves a visible hole rather than drawing the wrong art.
  What this does NOT cover, and no cap can: inserting or reordering tiles inside a
  tileset (local ids move), renaming or deleting an id (placements refer to names),
  and re-baking a grid sheet with a different column count (a ground cell's number
  means another cell). Hence: **append only, never insert, never renumber, retire
  instead of delete** — and if art really is removed, the maps that used it must be
  re-authored.
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
  `PIXEL_ADMIN_TOKEN` (also `--token`), `PIXEL_STREAM_DATA_DIR` (holds
  `pixel.db` plus `cert.pem`/`key.pem`; **defaults to `tmp/data` in the repo** so
  a dev world belongs to its checkout — a deployment always sets it, the image to
  `/data` with a volume mounted there), `PIXEL_RESET_WORLD`.
- **First-start conveniences are development-only** (`dataBootstrap.ts`): the data
  directory is created, a self-signed certificate generated, and a database
  adopted from a former default path. All three are gated on nobody having set
  `PIXEL_STREAM_DATA_DIR`, and that gate is load-bearing — generating a
  certificate in a container's `/data` would flip the server to HTTPS, and the
  deploy topology needs it plain behind Caddy, which terminates TLS itself.
- **`PIXEL_RESET_WORLD=<token>`** empties everything except the `users` table and
  the personal `playerAvatar` assets, once per token, at the next start — before
  any store reads or seeds. A `VACUUM INTO` backup is written first, and no backup
  means no wipe. Survivors are an allow-list (`server/src/worldReset.ts`): a table
  added later is wiped by default, so **if you add one holding account data, add
  it to `KEEP_TABLES` in the same change.**
- **Housekeeping runs at boot, unattended — so it is safe by construction.**
  `maintenance/startupCleanup.ts` runs before anything reads the world (before
  `loadAssetBundle`, since the bundle is built from these rows and then cached
  process-wide). A task added there must honour the contract in that file's header:
  two independent sources of evidence, a refusal when the evidence looks broken (an
  unreadable tileset registry makes every row look unused — that is a deployment to
  fix, not a licence to delete), a grace period so recent work is never touched, it may
  destroy only what nothing can reach (no tileset offers the id, no layout places it),
  and it may never keep the server from starting. The guards live in pure functions and are tested; nothing here waits
  for a human to read a report, because nobody is watching a boot.
- **A stored asset whose id no tileset carries is dead weight, and it travels.**
  Furniture used to be uploaded into the database as pixels; art then moved into Tiled
  tilesets, and the rows of retired packages stayed behind — ids nobody can place,
  since a mapper only paints what a tileset offers. They are not inert: a row without
  a file has no image to point at, so it is sent as SpriteData in
  `furnitureAssetsLoaded` on every join. 695 of them were 1.33 MB of a 1.79 MB
  message. The boot prunes them (see the housekeeping bullet above);
  `scripts/prune-orphan-assets.sh` is how you LOOK — what would go, what the grace
  period holds back, and which PLACED assets no tileset offers any more, the one case
  nothing can repair automatically. `--apply` deletes without waiting for the grace
  period, for when you are reading the list yourself. Both paths share one decision
  function, so they cannot drift. A deployment prunes itself at its next boot.
- **One database.** All state lives in `pixel.db` through the shared `db.ts`
  connection.
- **Accounts:** users live in the `users` table keyed by a lowercase, immutable
  `user_id` (login id and agent-owner key) with a free display name, a scrypt
  password, an admin flag and a per-user agent token. Presenting
  `PIXEL_ADMIN_TOKEN` at login makes that user an admin and creates the account if
  new — the only way to create users. **There is no anonymous mode**: every room
  and the feed require an account, so without a token nobody can join at all, and
  the server binds to loopback rather than serving an ungated app to the network.
  Agents authenticate the feed with their owner's token.
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
  `scripts/sync-furniture-properties.sh --check` must report zero changes. It edits a
  MAP in place (`scripts/lib/jsonEdit.mts`) rather than re-serializing it: a `.tmj` is
  written by Tiled, so rewriting one turned a single added field into a 25 000-line
  diff and the next save in Tiled produced the reverse. Tilesets are ours and are
  re-serialized normally.
- If you added, removed or repainted collection art:
  `scripts/bake-atlas.sh --check` must pass (the server would bake it anyway, but
  the committed artifact is what a deployment starts from).
- If you changed the layout format: bump `OfficeLayout.version`, migrate in
  `migrateLayout`, and make sure a migration that cannot be completed is **not
  persisted** — an incomplete one replaced a real map with 3192 holes once, and the
  only reason it was recoverable is that maps live in git as `.tmj`.
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
