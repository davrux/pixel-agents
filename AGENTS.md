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
    fallback. **A wire-format change bumps `PROTOCOL_VERSION`** (`shared/protocol.ts`)
    in the same commit — adding, removing or reordering a synced schema field, or
    changing what a message means. The desktop app ships its own bundle and only
    updates when the user triggers it (`desktop/src/updater.ts`; never at all on
    macOS, which refuses unsigned updates), so without the bump an older build
    decodes the new state into nonsense silently; with it, the client offers the
    update instead (`client/src/ui/versionGate.ts`). Gate on that number, never on the build version:
    `git describe` changes with every commit and would cry wolf in development.
    **The app's name and its `userData` directory are set explicitly and
    separately** (`desktop/src/appPaths.ts`, `userDataDir.ts`), before
    `requestSingleInstanceLock()` — which keys the lock off `userData`. Both
    defaults were wrong: `app.getName()` fell through to the package name
    `@pixel/desktop`, so the slash became a path separator and per-user state
    landed in a nested `~/.config/@pixel/desktop/`, while the tray item's D-Bus
    `Id` went out as `@pixel/desktop_status_icon_1`. The directory name is a
    constant and deliberately NOT derived from the display name: `userData` holds
    the bearer token and the trusted-cert store, so a path that follows the app's
    name logs every user out the day somebody renames the app. Rename freely;
    leave `DATA_DIR` alone. The one-time move of the old directory is tested
    (`userDataDir.test.ts`) because its one unacceptable outcome is pointing at an
    empty directory while the real state sits next door.
    **A tray icon is never a way back that can be relied on.** `new Tray()`
    succeeds on Linux with nothing to draw it, so it reports an availability it
    cannot know; `probeTrayHost()` asks the session bus and is the most that can
    be established, and even a host that accepts the item may discard it (vanilla
    GNOME draws no tray at all, and with the appindicator extension Chromium
    answering `Get` on `IconName` with an error makes the extension drop the
    item). So close-to-tray stays opt-in from the tray menu, off by default, and
    forced off whenever the bus says outright that nothing is listening — and a
    second launch stays a way back to a hidden window.

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
- **The GET gate is an allow-list, and world data is not on it.** `isPublicGet`
  (`auth.ts`) names what an anonymous caller may fetch: the login page and `/login`,
  the register page and `/register` (an account is what a caller comes there to get, and
  the POST still demands the admin token), `/health`, `/matchmake` (the room authorizes
  itself in `onAuth`), and the client BUILD's own directories — which carry no world data and, by contract, no secret. It
  used to be the other way round: anything under `/assets/` or ending in an asset
  EXTENSION was public "because the desktop app fetches them cross-origin, cookie-less".
  Measured 2026-08-20, that published the whole world's art — every tileset sheet,
  `sets.json`, and every picture a pushed map wrote to disk, which is not necessarily in
  git either. The desktop half had expired too: it sends a bearer through `serverFetch`,
  which the gate accepts, and only three client fetches were still using a bare `fetch`
  (they now go through it — a cross-origin request from `app://` carries no cookie, so
  that helper is the only thing identifying the caller). `/assets/tiled/**` and
  `/arcade/content/**` are refused ABOVE the build prefixes, because they share a mount
  point with them. The guest meeting page stays reachable: `/meet/:slug` and its `/info`
  are registered before the gate, on purpose.
  The build stays public deliberately, and two facts settle it rather than taste. The
  **public guest page shares its chunks with the app** — `/meet/<slug>` pulls `bridge`,
  `ConferenceUI`, `livekit-client` and `preload-helper` out of `/assets/`, and they are
  content-hashed and partly loaded by dynamic import, so gating that prefix either breaks
  guest links or needs the guest page split into its own bundle (duplicating ~550 KB of
  LiveKit). And the same bundle is downloadable from a **public GitHub release** as the
  desktop AppImage, so a gate on the server would protect nothing that is not already
  published. What it must therefore keep being true is the contract the gate leans on: no
  secret in `client/src`, which `mmo-readiness` fails on.
- **No credentialed cross-origin surface.** `desktopCors` echoes the request Origin for
  the three paths the desktop needs and deliberately sends no
  `Access-Control-Allow-Credentials` — but Colyseus ships that header in its matchmaker
  defaults and applies them to every response, so the contract was false in practice
  until `index.ts` deleted it. Origin-echo plus credentials is exactly what lets any
  website read a cookie-authenticated response; it was harmless only because those three
  paths answer nothing sensitive, and it was a trap primed for the day a data route
  joined them. Both this and the allow-list are checked by `mmo-readiness`, with a
  planted hole per rule.
- **Secrets stay on the server**: LiveKit key/secret, the admin token and scrypt
  hashes never reach a client. A viewer gets only its own agent token and
  short-lived, room-scoped LiveKit JWTs whose identity is its own avatar. Bound
  the length of anything you verify, so verification can't become a CPU DoS.
- **Serve over TLS in production.** The session cookie and the desktop bearer
  token are capabilities; media needs a secure context anyway. Plain HTTP is for
  development only.
- **This section is verified, not trusted.** `mmo-readiness`'s security check
  (`.claude/skills/mmo-readiness/security.mjs`) fails a route that neither
  authorizes itself nor stands on an allow-list with a written reason, a message
  handler that keys off a payload id, a message type nobody sends (dead surface —
  that is how `meetingRoomJoin` kept granting call membership from any distance
  long after anything sent it), a voice token minted for a non-member, an
  unattributed or unbounded chat line, and a secret in anything sent to a client.
  Its own rules are self-tested (`check.sh --selftest`) because a grep that stops
  matching keeps printing PASS. So: **a change that adds a surface adds its gate
  and, if the surface is new in kind, its rule plus that rule's self-test case** —
  and an allow-list entry always carries the reason it is safe.

## Memory

A world that runs for weeks and a tab that stays open all day fail differently
from a crash: they get slow, days later, with nothing to bisect. So memory is a
contract too, and it is **verified, not trusted** — `mmo-readiness`'s memory check
(`.claude/skills/mmo-readiness/leaks.mjs`) asks the same question the security
check asks: is the release present in the code that acquires?

- **Anything keyed by something that comes and goes is deleted when it goes.** A
  `Map` on a room keyed by `sessionId`, `userId` or an entity id must have a
  delete on the path where that thing disappears — `onLeave`, the removal event,
  the layout rebuild. `savedSpots` is why this is written down: a write-dedup entry
  per user, with no delete site anywhere, so a room kept one per visitor it ever
  had. Rebuilding a collection wholesale counts (`this.points =
  layoutToSitPoints(…)` is bounded by the layout); a `WeakMap` counts by
  construction.
- **The same rule in the database is a foreign key, not a list of DELETEs.** Rows
  that belong to an account (`server/src/schema/tables.ts`) declare
  `ON DELETE CASCADE`, so `DELETE FROM users` takes the sessions, preferences,
  stored positions, arcade saves, zone grants and meeting rooms with it. It was a
  hand-maintained list at each call site before, and the two call sites had already
  drifted: `/delete` forgot the user's meeting rooms where `DELETE
  /admin/users/:id` removed them. Measured on this repo's dev world 2026-08-27, 22
  rows belonged to accounts that no longer existed. `node:sqlite` enforces foreign
  keys by default, so nothing has to be switched on — but no table had declared one,
  so there was nothing to enforce. Two exceptions, each written down where it lives:
  a private avatar is one row of the shared `assets` table keyed
  (type, name) and a constraint cannot be conditional on another column (hence the
  orphan-avatar task at boot), and `zones.owner_id` must SET NULL rather than
  cascade — deleting an owner may not delete everyone else's world.
  **A new table with a `user_id` needs no thought and gets none**:
  `userDataCascade.int.test.ts` fails until it either cascades or is named there with
  the reason it must not. That check lives in the suite rather than in
  `mmo-readiness` deliberately — it reads the live schema through
  `PRAGMA foreign_key_list`, which is the truth, where a grep over DDL strings would
  only see one of the two places a table can be created.
  What a cascade does NOT cover is a per-user blob INSIDE a row: five of those lived
  in `settings` (keyed by user id inside one JSON object per kind) with no delete site
  at all, and they are tables now for that reason as much as for speed —
  `playerPos` cost 0.016 ms per write at thirteen entries and **5.3 ms at ten
  thousand**, on the thread the simulation ticks on, because every checkpoint parsed
  and rewrote the whole object. One row by primary key is 0.004 ms at any size.
- **A subscription on a process-wide emitter is a reference to everything behind
  it.** `controlBus.on` and `director.on` in a room need their `off` in
  `onDispose`, or the emitter retains the room, its state, its clients and its
  layout for the life of the server. This is the largest single leak this codebase
  can have, and the check asks the general question — is the emitter imported? — so
  a third bus is covered the day it appears.
- **A timer either gets cleared or gets `unref()`.** Beyond memory: a referenced
  interval turns "the server is idle" into "the server will not exit".
- **A blob URL is revoked, a per-entity texture is removed, a synced entry is
  deleted.** GPU memory is not collected for you, and a `MapSchema` entry nobody
  deletes is worse than a leak — it grows the state EVERY client decodes, forever.
- **Growth on purpose states its bound.** The runtime atlas, the warn-once sets and
  the per-preset caches all grow; each is named in `leaks.mjs`'s allow-list with the
  bound that makes it safe (keyed by content, by the tileset table, by an enum), so
  "this one is fine" is a decision somebody wrote down. The rules are self-tested
  like the security ones, and two of the planted leaks are the real regressions this
  check was written after. So: **a change that adds a place where state accumulates
  adds its release and, if the surface is new in kind, its rule plus that rule's
  self-test case.**
- **Measure with `heapUsed` after a forced GC, not RSS.** V8 does not hand memory
  back, so RSS climbs on a process that retains nothing: 1.4 MB per join/leave cycle
  here, while the live heap was flat. Start an isolated instance
  (`PIXEL_STREAM_DATA_DIR` at a scratch dir) with `--inspect`, drive it with a
  headless Colyseus client, and read `process.memoryUsage().heapUsed` after
  `HeapProfiler.collectGarbage`. Measured 2026-08-20: 36 join/leave cycles 64.3 →
  64.6 MB; 150 visits by 30 accounts through a room an anchor client kept alive 73.5
  → 73.6 MB, no object class growing. The static rules stay necessary anyway — a
  per-user Map entry is ~100 bytes, so 10 000 visitors is 1 MB nobody would spot on
  a graph.

## Conventions

### Code

- **`noUnusedLocals` is on, and it is a dead-code check, not a style rule.** An
  unused import is how dead code hides: a function loses its last caller, the import
  naming it stays, and every later "is this still used?" search finds the import and
  answers yes. Set 2026-08-27; the first run found 54 places, among them a whole
  unused table (`zone_meta` plus the two private methods that were its only callers),
  a write-only copy of the furniture catalog kept "for the editors" after the
  furniture editor was gone, and a documented pet-spawn rule that existed only as two
  constants and a comment. It also caught me deleting a field that was in use.
  `noUnusedParameters` is deliberately NOT on: a callback that ignores an early
  argument still has to name it, and `_`-prefixing every one of those is noise.
- **Never put a raw control character in a source file — write the escape.** A NUL
  used as a cache-key separator (`` `${a}\0${b}` ``) is a good idiom, but written as
  an actual 0x00 byte it makes GNU grep treat the whole file as binary, and every
  grep-based check then walks past it in silence — `mmo-readiness`'s security and
  memory rules included, since they are greps. Two client files had this (measured
  2026-08-27: `MatrixUI.ts` and `timeline.ts`, two bytes each) and searching them for
  a symbol they contained returned nothing at all, which is exactly the failure mode
  a check cannot report. `\0` in the source is the same character to the engine and
  visible to everything else.
- **Decorator gotcha:** `@colyseus/schema` needs `experimentalDecorators` +
  `useDefineForClassFields: false`, and `tsconfig` maps `@pixel/shared/office/*`
  to source so tsx applies decorators correctly. Don't "fix" these into a bundle.
- **Sprites are data:** `SpriteData = string[][]` of hex colours (`''` =
  transparent). Character sheets default to 16×32, 4 direction rows (down, up,
  right, left), 7 frames/row,
  but frame size is per-character (≤64×64) and per-pose frame counts are
  **track-driven** via `CharacterSpec` (`sprites/characterSpec.ts`). Adding a pose
  means a new `CharacterPose` + a `spriteForPose` branch + a track name.
- **Measuring performance:** judge by **frame/CPU time**, not proxies like
  triangle count (greedy meshing once measured *slower* despite −20 % tris). The
  client has a perf overlay — **F8** or `?perf=1` — showing fps, frame time,
  character count and `tex/p/f` (live textures / atlas pages / packed frames), and sleeps its render
  loop when nothing moves.
  On the server, drive `OfficeState.update` over a real layout and take the MINIMUM of several
  interleaved runs — the mean is dominated by GC and the OS, and a first attempt at the numbers
  below had more noise than signal (a turned map came out *faster* than an upright one).
  Measured 2026-08-20 on uponu (158 placements): **0.062 ms/tick** as authored, 0.073 with
  every piece quarter-turned, 0.097 with every piece at a free angle — so turning a whole map
  costs about a thirtieth of a millisecond, and rotation is not a performance question.
  What WAS one, found by asking: `getCatalogEntry` was a linear `find` over all 1773 assets and
  is called from per-tick loops, at **24.2 µs per call**. It is a Map now (61 ns), which took
  that tick from 2.056 ms to 0.062 — **33× faster than before any of the turning work**. The
  lesson generalises: before believing a new feature is slow, measure what was already there.
  `entryFor` also memoizes per placement (a WeakMap), because every non-default placement built
  a fresh entry on every call: 1138 ns → 69 ns for a turned or resized piece.
- **Sprites reach the GPU through one runtime atlas** (`client/src/render/sprites.ts`):
  `spriteTexture()` packs each SpriteData into shared canvas pages and returns
  `{key, frame}`, and `atlasFromImage()` packs a rectangle of an IMAGE into the same
  pages with one `drawImage` — which is how character and NPC art gets there, since it
  arrives as a PNG sheet. A texture per sprite (or per skin) is what breaks batching — a
  painted decal field is hundreds of distinct 16×16 pieces, i.e. hundreds of binds per
  frame — so anything that draws a sprite goes through one of those two functions, never
  `createCanvas` of its own. Two exceptions, both deliberate: the Matrix effect
  (fresh pixels every frame) and uploaded background images (real PNGs).
- **Characters and NPCs are drawn from their sheet, not from pixels.** `poseFrames.ts`
  (shared) turns a pose into a COLUMN — same rule as `spriteForPose`, arithmetic instead
  of arrays — and `client/src/art/sheetStore.ts` hands the renderer that cell out of the
  atlas. So the client holds no hex for art at all; pixels are read from a sheet only by
  the two callers that work on pixels (the character editor, the Matrix effect).
  Measured with 18 characters: update time **7.55 → 0.36 ms**, JS heap **74.6 → 46.6 MB**,
  still one atlas page. The pixel implementation in `spriteData.ts` stays as the
  REFERENCE `poseFrames.int.test.ts` measures the arithmetic against, across every
  bundled sheet, pose, direction and frame — keep the two independent, because that test
  is the only reason "the index picks the same picture" is a fact.
- **Character, NPC and avatar art travels as a PNG, not as pixels.** The bundled
  sheets already ARE images (`assets/characters/char_*.png`, `assets/pets/*.png`);
  what a join used to ship was one hex string per pixel. Entries now carry a URL into
  `/art/<kind>/<id>?v=<hash>` (`server/src/artApi.ts`) plus the metadata a sheet cannot
  hold — name, `CharacterSpec`, NPC config, and the frame size, without which a client
  would slice a 16×16 pet on the 16×32 character default. Measured: `characterSpritesLoaded`
  668 → 2.9 KB, `petSpritesLoaded` 163 → 1.4 KB, a player avatar 77 → 0.2 KB, and the
  sheets themselves are 20.5 KB for the whole roster (PNG written with
  `filterType: 0, deflateStrategy: 0` — pngjs's RLE default costs 5× on pixel art).
  Two rules that keep it honest: the route stays out of `/assets/` — that prefix is the
  client BUILD and is the one thing served anonymously, while an avatar is personal art
  (the gate used to exempt by file EXTENSION too, which is why `/art/<kind>/<id>` carries
  none; see § Security); and the URL-building half stays free of bundle lookups
  (`server/src/art/artUrl.ts`) — asking `getMergedBundle()` from inside the bundle
  build recurses into a stack overflow on the first join.
  **A sheet carries all four sides.** `left` used to be mirrored from `right` on every
  load, which is the one direction the engine invented — and only correct for symmetric
  art (a bag on one shoulder, a dog's saddle). It is a row now: the bundled sheets were
  converted once (`scripts/add-left-row.sh`, idempotent), stored rows by a one-time boot
  migration (`art/migrateLeftRow.ts`, remembered in `_migrations`), and the editor fills
  it from a mirrored right on **save and export** so three-row data cannot be written
  again. Two rules that keep it from rotting: a sheet's rows are the longest PRESENT
  prefix of (down, up, right, left) — `rowsPresent`, because an EMPTY row draws an
  invisible character in that direction, which is worse than no row — and the only place
  that still mirrors is the sprite store's door (`withLeftRow`), never the drawing path.
  **The database holds the same PNG**, not pixels: `appStore` packs character-shaped
  rows on write and unpacks them on read (`art/artStore.ts`), so every caller still
  deals in SpriteData and nothing else in the server learned about images. Saves are
  still validated as SpriteData BEFORE encoding, which is why packing added no untrusted
  binary path of its own.
  **Saving art is a PNG over HTTP** (protocol 8), not a room message: `POST /art/avatar` for
  your own avatar and `POST /art/asset/:type/:name` for a gallery skin or an NPC
  (`artSaveApi.ts`), with the sheet as the BODY and its metadata in an `X-Pixel-Sheet` header —
  base64 in a JSON body would add a third to every save. One hex string per pixel was 95.3 KB
  where the image is 2.8 KB, a factor of 34 on a real sheet (measured on char_0).
  Being a route rather than a message buys four things, and it is worth knowing which: its own
  size limit stated per route instead of the transport's global one; an ANSWER, so a refused
  sheet reaches the editor as a reason instead of vanishing; two fewer message types on the
  room's surface; and a decode that nothing in the room refers to any more, so moving it to a
  worker later is a change to one file. What it does NOT buy is protecting the tick: HTTP and
  the room share one process and one thread.
  That makes a client's PNG the one untrusted IMAGE this server decodes, and `art/sheetPng.ts`
  is the gate the older warning here asked for: a byte cap (2 MB, derived — the largest legal
  sheet is 1.50 MB even as incompressible noise), the PNG signature, an 8-bit non-interlaced
  IHDR, and the DECLARED dimensions checked against the frame size and `MAX_SHEET_CELLS` — all
  before pngjs sees the file, so a 73-byte bomb claiming 30000×30000 never reaches a decoder.
  The sheet is then re-encoded rather than stored as it arrived, so what other viewers are
  served is a PNG this server wrote, and the pixels are never spelled out as hex on the way (48
  → 12.9 ms for the largest legal sheet; the format check they existed for is meaningless for
  decoder output, and the geometry is decided from the header). Authorisation comes from the
  session, never the payload: `/art/avatar` takes no id at all, and the asset route needs an
  admin. The rooms hear about a save through the control bus (`AVATAR_CHANGED_EVENT`, or
  `ASSET_CHANGED_EVENT` as before) — verified end to end in a browser: the POST answers 200 and
  the client re-fetches the art at its new content hash. `mmo-readiness` has a rule for the
  shape (a client-supplied image is bounded and header-checked before decoding) with its own
  planted hole. Legacy rows read back untouched; `scripts/repack-art.sh` shrinks an old
  world on purpose (measured here: 495 → 16 KB), verifying every row by unpacking it
  again before keeping the write. One thing to know: the decoder canonicalises hex to
  upper case, so a packed row reads back equal in colour but not in string case — the
  runtime atlas keys sprites by object identity, so nothing depends on the text.
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
stylesheet must mirror the same tokens — including non-CSS colour literals: a
Phaser tint or a canvas fill names the same hex as its CSS counterpart.

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
  channels feed the first frame — the baked atlas, the catalog message, the layout
  message and the character sheets — and nothing orders them. Drawing as they landed
  gave grey floors, black boxes where trees belong and a burst of "no art for …"
  warnings, all repainted a moment later. So: fetch the HTTP art, wait for both
  messages, then fetch only the tilesets the layout NAMES (`floorSets`/`wallSets` — a
  ground or wall cell can refer to nothing else, so the palette this zone never paints,
  the roads it has not drawn and the collision marker nothing renders all stay home:
  177 KB of 774 KB here, and one sheet more per pack imported) plus the ref images this
  map's placements name (`prefetchRefImages`), and draw once. `update()` returns early while it runs, because the renderer syncs
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
  **A ground cell keeps the way Tiled turned it.** All three flip bits survive the
  import as one small mask per cell (`OfficeLayout.tileFlip`, resolved only by
  `office/tileOrientation.ts`), so every one of Tiled's eight orientations — two
  mirrors, a half turn, and the four diagonal states — draws in the game as it does in
  the editor. Three things make that safe and cheap. The bits used to be *stripped*
  (`baseGid`), which was itself a fix: a mirrored gid matches no tileset range, and the
  cell silently became VOID, invisible and unwalkable. It is cosmetic only, so it lives
  in the layout and touches nothing but the renderer — a mirrored cell is the same tile
  of the same sheet, and what makes it walkable is still that ground is there. And the
  array is **left out entirely unless the map turns something**, so today it costs
  nothing; a dense array of 3192 zeros would otherwise travel to every client on every
  join. The diagonal states are only expressible because `groundFits` already requires
  a ground tile to be exactly one square cell — a quarter turn of a 16×32 tile would
  overflow its neighbours.
  **A decal turns the same way, when its art can take it.** Decals go through the same
  table (`orientationOf`, the placement's three booleans instead of a mask) and get all
  eight orientations — but only where the art is SQUARE, and that is decided at import,
  not in the renderer: a decal may be several cells tall, and a 32×16 piece turned a
  quarter of the way round would occupy 16×32, i.e. cells nobody painted. What Tiled
  draws for an oversized rotated tile in a tile layer is not something a checkout can be
  compared against, so the import keeps the two mirrors, drops the turn, and names the id
  — the same shape of refusal as `groundFits`.
  **A placed OBJECT turns too, and that is where a turn stops being cosmetic.** Furniture and
  images carry Tiled's object `rotation` (the same field a text label already used), and for
  furniture `entryFor` swaps the piece's sides for a quarter turn — so the cells it blocks,
  the seats it offers, its approach tiles, where a pet perches and how it sorts all follow the
  picture, and its sitter turns with it. That is the whole reason the turn is resolved in
  `entryFor` and not in the renderer: a picture-only rotation is a collision bug with a
  plausible screenshot. Tiled's own pivot decides where the piece lands — "clockwise around
  (x, y)", the bottom-left corner of the unrotated box, so the box SWINGS rather than spinning
  in place (`turnedTopLeftPx`).
  **Any angle is honoured; what a turn cannot carry is dropped, loudly.** A quarter turn keeps
  everything — the sides swap and seats, facing and depth come with them. Any other angle is
  drawn as Tiled shows it and occupies the RECTANGLE around the turned art (`turnedExtent`),
  which is the only answer axis-aligned cells have for a diagonal piece; it covers cells the
  art does not reach, so the piece keeps blocking (never walk through a couch) but loses its
  seats — a seat on a cell where there is no couch is worse than a couch you cannot sit on.
  Air rows go the same way for any turn at all: `backgroundTiles` says "my TOP rows are air",
  which stops meaning anything once the top is a side, so it is dropped towards SOLID. Both
  losses are written onto the placement as ordinary overrides (`canSitOn`, `backgroundTiles`),
  so nothing downstream has to learn about angles, and both are named in a notice the push
  prints. Images take any angle with nothing to drop — a free pixel box, no cells.
  Two numerical details that are load-bearing: the quarter turns are an EXACT swap rather than
  `cos(90°)`, whose 6e-17 would ceil into an extra blocked cell, and a free extent is rounded
  to whole pixels first, because a 32×16 couch at 37° measures 32.04 tall and those four
  hundredths would otherwise cost a whole row.
  **Turning is not a performance question** — measured, because it looks like one: see the
  numbers under "Measuring performance". The old comment saying
  rotation was deliberately not adopted is a warning now rather than a rule: art drawn from
  one fixed camera angle still has no sensible rotated frame, so a turned desk reads wrong
  however correctly it is drawn — it is turn-symmetric pieces (a rug, a crate, a plant) that
  make this worth having.
  **`FurnitureSync.angle` is a synced schema field**, so this bumped `PROTOCOL_VERSION` to 5:
  the client draws the piece and decides what a seat tile is, so a turn that stayed on the
  server would have it drawing across the wrong cells and refusing clicks on real seats.
  Both paths are measured, not argued: the tests pin the table against where the four
  corners of a cell land, and the orientations were read back out of a screenshot of the
  running client — pixel-exact for all eight, where an unturned cell differs in 96 to 226
  of the pixels its art paints.
  **No tile class decides anything any more.** `FloorTile` and `WallTile` are both
  gone: neither carried a property, and the one fact they encoded — how tall a cell
  is — is stated by the tileset itself (`tilewidth`/`tileheight`, passed to the
  client in `sets.json` and kept in one `SheetGrid` table). A `SheetCellRef` is now
  just (sheet, row, col), and a sheet cell is a sheet cell whether it draws ground or
  a wall piece. What still classifies is the LAYER (`GroundLayer`,
  `WallLatticeLayer`, `DecalLayer`, `CollisionLayer`) and, for things with
  behaviour, `FurnitureTile`/`DecalTile` — those carry real properties.
- **A placement's own size is honoured, and it means more than the picture.** Tiled
  lets you resize a tile object; `PlacedFurniture.width/height` carries that, and
  `entryFor(item)` hands every reader the catalog entry as it applies to THAT placement
  — drawn size, footprint in cells, and the air rows scaled with it. That is the point:
  a size decides blocking, seats, approach tiles, pet perching and depth, so resolving
  it anywhere but in one place lets the collision disagree with the picture. Ignoring it
  used to be two bugs at once — drawn at the art's size AND anchored by the art's
  footprint, so a machine placed at 16×16 from 32×32 art sat a cell too high.
  `entryFor` returns the shared entry unchanged when there is no override, so the normal
  case allocates nothing in per-tick loops.
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
- **A map's pictures are files, not rows.** An image placement carries the path to its
  file under `assets/tiled` (`PlacedImage.src`, layout **version 3**), and the client
  fetches it over HTTP like every other sheet. It used to be stored as a base64 row and
  shipped in an `imagesLoaded` message on every join — a copy of a file that is already
  in git (measured: 60 KB per join for one 46 KB picture, 237 KB when three unused rows
  were still there). The `image` asset type is gone with it: a pushed map writes any
  picture the server lacks to DISK (`tiled/zoneImport.ts`), and nothing writes it to the
  database. A v2 layout is migrated on read by resolving the id against
  `png/src/images/` — and a placement whose file cannot be found is dropped rather than
  carried forward as a hole.
  One trap this sprang, worth knowing before adding the next field: `sanitizeLayoutImages`
  rebuilds every image from a WHITELIST, so `src` — added by that very change — was stripped
  on every write path, the renderer then skipped each image for want of a path, and a map's
  pictures silently stopped appearing (uponu's own logo included, until 2026-08-20). A field
  added to a layout type is not saved until it is named there, and a path that ends up in a
  client fetch is validated there too.
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
  process-wide). Two tasks today: stored asset rows no tileset carries any more, and
  personal avatars whose account is gone (~77 KB each; the delete paths already clean
  up, so this is for a restored or hand-edited database). A task added there must
  honour the contract in that file's header:
  two independent sources of evidence, a refusal when the evidence looks broken (an
  unreadable tileset registry makes every row look unused — that is a deployment to
  fix, not a licence to delete), a grace period so recent work is never touched, it may
  destroy only what nothing can reach (no tileset offers the id, no layout places it),
  and it may never keep the server from starting. The guards live in pure functions and are tested; nothing here waits
  for a human to read a report, because nobody is watching a boot.
- **The database holds no furniture at all any more.** Furniture used to be uploaded
  into it as pixels; art then moved into Tiled tilesets, and the rows of retired
  packages stayed behind — ids nobody could place, since a mapper only paints what a
  tileset offers, and not inert either: a row without a file has no image to point at,
  so it travelled as SpriteData in `furnitureAssetsLoaded` on every join (695 of them
  were 1.33 MB of a 1.79 MB message). The boot pruned those, and kept the rows a
  tileset still carried, because those were live overrides.
  That whole shape is gone: `furniture` is **not an ASSET_TYPE**, no client can write
  one (the editor offers characters and NPCs only), and nothing merges one over a
  tileset entry. What is left of it is one boot task that retires the remaining rows
  (`maintenance/retireFurniture.ts`) — unreachable by construction rather than by
  inference, so it needs no grace period, but it writes a copy beside the database
  first, because a row a tileset still carries had been overriding that art until this
  build and that may be somebody's work. The report tells the two groups apart, since
  "retired 40 rows" does not say whether a map just changed.
  The one question that outlived the prune is asked directly now: a stored map that
  places an id **no tileset offers** is a map to re-author and nothing can repair it
  automatically, so `report-unavailable-placements` compares the layouts against the
  tilesets and says nothing on a healthy world (measured: 1775 offered, 127 placed, 0
  missing). `scripts/prune-orphan-assets.sh` remains for the other prune — personal
  avatars whose account is gone.
- **One database, opened by more than one process.** All state lives in `pixel.db` through the
  shared `db.ts` connection — and the server is not the only thing that opens it: every
  maintenance script does (`prune-orphan-assets`, `repack-art`, a zone push), usually while a
  server is running. So the connection sets `busy_timeout = 5000` and `journal_mode = WAL`:
  importing `db.ts` WRITES (a `CREATE TABLE IF NOT EXISTS` for the migration bookkeeping), which
  takes SQLite's write lock, and without a timeout a second process gets
  `SQLITE_BUSY: database is locked` and dies while still importing. That is not theory — it is
  what made about one in eight parallel test runs fail with a bare "test failed", no assertion,
  a different file each time (whoever lost the race), and it took the TAP reporter to see the
  stack. WAL costs the two sidecar files (`-wal`, `-shm`) next to `pixel.db`: a BACKUP must
  therefore be `VACUUM INTO` (which is what `worldReset` and the prune script already do) rather
  than a file copy, since copying `pixel.db` alone would lose whatever is still in the log.
  **Tests never open it.** `server/test-data-dir.mjs` is loaded with `--import`, so every test
  child gets its own temp data directory before any module can open a database — a suite has no
  business touching the world a developer is standing in, least of all one that runs a migration
  on import and honours `PIXEL_RESET_WORLD`. A file that wants its own directory still sets it
  itself; `dbIsolation.int.test.ts` asserts both halves and fails without the setup.
- **Fifteen tables from a pre-fork database are dropped at boot**
  (`schema/dropRetiredTables.ts`): eight `voxel_*` plus `portals` from a voxel world
  that is gone, `dm_keys`/`dm_messages` from a Matrix-side store, `monitor_locks`,
  `arcade_wads`, `zone_customers`, and `zone_meta` (whose only callers were two private
  methods nobody called). They were referenced by **no file of any type** in this repo,
  and — the fact that settled it — **no code creates them**: they arrived with a
  database adopted from the older layout (`migrateFromSplitDbs`, `dataBootstrap`), so a
  fresh deployment never had them. Two held personal data, which is why leaving them was
  not neutral: nothing deleted a row when the account went, because nothing knew they
  were there. Dropped on the dev world 2026-08-27, 37 rows in total.
  **A table needs two independent pieces of evidence to be dropped**, and the second is
  machine-checked: its name is on `RETIRED_TABLES` (a decision written down after
  searching the repo) *and* not on `LIVE_TABLES` (what this server creates, which
  `schemaTables.int.test.ts` rebuilds from the source's own `CREATE TABLE` statements
  and fails on any drift, in both directions). A table on **neither** list is reported
  and left alone — the unknown case must never resolve to "delete", or this becomes the
  way a future table disappears because nobody added it here.
  One deliberate exception to the house rule: **no `VACUUM INTO` snapshot is taken**
  first, unlike every other destructive step here. That was asked for explicitly, and it
  is the line to change if a deployment ever wants the drop to be undoable.
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
  engine, every `onMessage` handler guarded, the entity/zone/portal invariants —
  and the **security section**, which checks the gates rather than listing them:
  every HTTP route gated or explicitly public, no handler acting on a
  payload-supplied identity, meeting tokens only for members, chat attributed and
  bounded, no secret in a client payload — and the **memory section**, which
  requires the release next to the acquisition: per-connection Maps deleted from,
  bus subscriptions balanced, timers cleared or unref'd, blob URLs revoked,
  textures removed, synced entries deleted, and every deliberate cache naming its
  bound. Treat its failures as blockers.
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
  One exception, and it is narrow: an **optional field that an older client ignores
  without misreading anything** is not a format change in this sense. The client
  accepts version 3 and nothing else on purpose (`client/src/net/bridge.ts`, because a
  v1 ground cell holds a pattern where a v2 one holds a tile id), so a bump blacks out
  every shipped desktop build until it updates — and it ships its own bundle with no
  auto-updater. `tileFlip` is the case that earned this sentence: an old client draws
  the cell unmirrored, i.e. exactly what it drew before. A change where an old client
  would draw the WRONG thing still bumps the layout version *and* `PROTOCOL_VERSION`.
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
