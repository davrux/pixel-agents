# Dev notes (project memory)

Curated, in-repo working memory for this project — kept here (committed + pushed)
because the agent's `~/.claude` store is wiped on every dev-container rebuild.
**Conventions & invariants live in [`AGENTS.md`](../AGENTS.md)**; this file is the
*current state, where things live, decisions, gotchas, and open items* — update it
as work progresses. It is a curated summary, not a changelog (git has the history).

## Big picture
Server-authoritative MMO on **Colyseus + `/feed`** (one port), three browser
**renderers on the same backend** (any server change applies to all):
- **Pixels** (`client/index.html` → `client/src/scenes/OfficeScene.ts`) — 2D Phaser
  office; zones = rooms (SimRoom).
- **Voxel** (`client/voxel.html` → `client/src/voxel/`) — 3D Three.js world
  (VoxelRoom; worlds, separate from zones).
- **Rooms portal** (`client/rooms.html` → `client/src/rooms/main.ts`) — professional
  Teams-style customer view of a zone (chat/voice/meetings), no Phaser.
- **Admin** (`client/admin.html` → `client/src/admin/`) — admin-only user/room mgmt.

Auth/users/sessions/zones/voice/conference/chat are **shared server-side** (single
`pixel.db`). Identity = `user_id` (login id). See `AGENTS.md` for the invariants.

## Roles & access control (on main)
- `users.role` = **admin | user | customer** (+ `allow_pixels` for customers).
  admin = everything; user = create/edit their OWN zones (creator becomes that
  zone's admin); customer = external guest.
- **Customer gating:** only assigned rooms (`zone_customers`); the Pixels 2D client
  needs `allow_pixels` (portal join is a non-spatial "spectator"); never voxel
  worlds; no agents (feed rejects them); no arcade WAD endpoints. Zone lists +
  portal options are filtered per customer. Shown in-world as "Customer".
- **Passwords** (scrypt, `server/src/pwhash.ts`): per-zone entry password + per-
  monitor call password (`zoneStore`); admins/zone-admins/assigned customers bypass.
- **Admin REST API** `server/src/adminApi.ts` (`/admin/*`, admin-gated) backs
  `admin.html`. Login redirects customers → `/rooms.html`.

## Rooms portal
Teams layout (rooms rail / chat / office), integrated chat w/ timestamps, room-wide
voice on `ZoneVoice` directly (no proximity), presence badges (Pixels/Rooms),
meetings via ConferenceUI+LiveKit, auto-reconnect + connection indicator, password
prompts for locked rooms/monitors, "Open in Pixels" when allowed. Joins as a
**spectator** so it doesn't duplicate the user's Pixels avatar.

## Pixels idle-CPU (on main)
`OfficeScene` throttles when nothing moves: skips per-frame entity sync + DOM
overlays, then `game.loop.sleep()` after ~2 s; woken by input/state/voice/tab-focus
(DOM-level listeners, since a slept Phaser loop can't process its own input).
Overlays capped ~20 Hz. Perf overlay: **F8** / `?perf=1`.

## Navigation (slash-commands)
`/voxel`, `/rooms` (carries current zone), `/admin-site` (admin) — client-side via
the shared ChatUI `clientCommand` hook, wired in both Pixels + Voxel. Add a matching
command for any new destination (see AGENTS.md convention).

## Other subsystems (brief)
- **Arcade** cabinets (Pixels + Voxel) run games via js-dos (DOS); server-wide
  savegames. **Fully content-driven — NO games are baked into the image.** The
  operator bind-mounts a content dir (`ARCADE_CONTENT_DIR`) holding the game files
  + a **`catalog.json`** (`ArcadeGame[]`); the server serves the catalog at
  `GET /arcade/catalog` (public metadata) and the files at `/arcade/content/<file>`
  (**auth-gated** — `auth.ts` treats `/arcade/content/` as non-asset). The client
  (`ArcadeUI`) fetches the catalog and renders the launcher from it; the `emulator`
  field selects the loader (`jsdos` now; `emulatorjs` for NES/SNES/… later — just a
  new loader + files, no code per title). Shared `arcade/games.ts` is now only the
  `ArcadeGame` type + `parseArcadeCatalog` validator; the server catalog lives in
  `arcadeCatalog.ts` (cached, reloads on catalog.json mtime change).
  - **Populate the content dir:** `pnpm build:arcade` (→ `scripts/build-shareware-
    bundles.mjs`, output dir = `$ARCADE_CONTENT_DIR` | argv | `tmp/arcade-content`).
    Downloads wolf3d/keen/duke/duke3d shareware; **DOOM/DOOM II/TNT/Plutonia** are
    added only when the LICENSED GOG WADs are present in `tmp/doom-wads` (extracted
    via innoextract, never committed). Writes each `<id>.jsdos` + `catalog.json`.
    Then mount that dir (see `tmp/docker-compose.yml`). "Bring your own WAD" upload
    was removed.
  - **Desktop:** the app is a cross-origin cookie-less `app://` shell, so the
    launcher fetches the (gated) content bytes with the stored **bearer** and hands
    js-dos a blob URL (`ArcadeUI.open`); the browser stays same-origin (cookie).
  - **Add a GAME** (existing emulator): drop its file into the content dir + add a
    `catalog.json` entry (`{id,title,blurb,emulator,file,version?,multiplayer?,`
    `maxPlayers?,core?}`). For a js-dos title, extend the `GAMES` array in
    `build-shareware-bundles.mjs` so the builder packages + catalogs it. No code.
  - **EmulatorJS** (libretro cores → WASM) is wired for non-DOS games (`emulator:
    "emulatorjs"`, `core:` `nes`/`snes`/`gb`/`arcade`/…). Engine is **self-hosted**
    under `client/public/emulatorjs/` (gitignored) — vendor it with `pnpm
    vendor:emulatorjs` (downloads loader + `emulator.min.js/css` + cores; default
    cores fceumm=NES + fbneo=arcade; `ARCADE_EJS_CORES=` to change). Loader:
    `client/src/arcade/emulatorjs.ts` (sets `window.EJS_*`, injects loader.js,
    returns a `{stop}` like js-dos); `ArcadeUI.open()` branches on `game.emulator`.
    Demo ROM: **Nova the Squirrel** (free homebrew NES) — the builder downloads it
    into the content dir (NOT committed; GPLv3 code + CC BY-NC-SA assets → test/
    non-commercial only). Copyrighted ROMs (e.g. **Phoenix**, arcade→fbneo) are
    operator-provided in the content dir + a `catalog.json` entry, never in the repo.
    ⚠ Not yet browser-verified end-to-end; EmulatorJS teardown on close is best-effort
    (no clean dispose API). Digital-input games (NES, Phoenix) play fine on keyboard;
    analog titles (N64) want a gamepad (EmulatorJS supports the Gamepad API).
  - **Add another NEW emulator:** (1) add the value to `ArcadeEmulator` + the
    `EMULATORS` allow-list in `shared/arcade/games.ts`; (2) add a loader (like
    `emulatorjs.ts`/`jsdos.ts`); (3) branch on `game.emulator` in `ArcadeUI.open()`;
    (4) have a builder emit its catalog entries. One loader per emulator, never code
    per title. Self-hosted engine assets go under `client/public/` like `/jsdos/`.
- **Arcade IPX multiplayer (up to 4P)** for doom/doom2/tnt/plutonia. DOS side:
  bundles carry `IPXSETUP.EXE` (from shareware doom19s) + engine packaged as
  `DOOM.EXE` so IPXSETUP launches any variant; the bundle's autoexec always runs
  `NET.BAT` (single-player `DOOM.EXE` by default; a networked launch overlays it).
  Lobby: `server/src/arcadeLobby.ts` `registerArcadeLobby(room)` (per-room,
  per-cabinet match; host/join/mode/start; onLeave hook wired in SimRoom+VoxelRoom;
  sends `arcadeLobby` + `arcadeLaunch`). Client: ArcadeUI 👥 button → lobby modal →
  on `arcadeLaunch` boot the game. Wired in Pixels + Voxel.
  - **Transport is HumbleNet, NOT PeerJS.** js-dos v8 does IPX-over-WebRTC via its
    bundled HumbleNet (`emulators/webrtcnet.wasm`); the "peerServer" is a HumbleNet
    signaling server (default `https://net.dos.zone`), which the standard `peer`
    npm package is **incompatible** with. We therefore use the **public net.dos.zone
    broker** for signaling (metadata only; game data is P2P/WebRTC). The old
    self-hosted `/peerjs` `ExpressPeerServer` in `index.ts` is **dead code** to be
    removed. Self-hosting signaling would require running HumbleNet's own
    `peer-server`, not PeerJS.
  - **Rendezvous (alias):** host launches `{startIpxServer:true, registerAlias:alias}`
    and — because js-dos never auto-registers — ArcadeUI calls
    `window.net.registerAlias(alias)` once the net layer is up (polls for a *fresh*
    `window.net`, not a stale one from a prior match). Joiners launch
    `{connectIpxAddress:alias}` → js-dos polls `queryAliases` until the host
    registers. Host must NOT also set connectIpxAddress (it would wait on its own
    alias → hang at "Creating server").
  - **NET.BAT overlay must be a real ZIP.** js-dos `initFs` only accepts ZIP byte
    arrays, NOT `{path,contents}` — a `{path,contents}` overlay is silently dropped
    (→ launches fell back to solo `DOOM.EXE`, showing the main menu instead of a
    netgame). `client/src/arcade/zip.ts` (`storeZip`) wraps `NET.BAT`
    (`@echo off / IPXSETUP -nodes N [-deathmatch]`) in a STORED zip.
  - **Teardown on close is required.** js-dos does not shut its net down; ArcadeUI
    `teardownNet()` (in `close()`) unregisters the alias (host), calls
    `net.shutdown()`, and drops `window.net` — else the dead session lingers on
    net.dos.zone and every later match hangs at "looking up address".
  - **NAT/TURN for internet play:** peers are all behind NAT (only the server is
    public), so P2P needs a TURN relay. `server/src/arcadeTurn.ts` `arcadeIceServers()`
    mints ephemeral coturn credentials (REST/`use-auth-secret`) and the lobby sends
    them in `arcadeLaunch.iceServers`; the client passes them to js-dos as
    `net:{iceServers: () => [...]}` (js-dos **calls** iceServers as a function, not an
    array). Env: `ARCADE_TURN_URLS` (comma list), `ARCADE_TURN_SECRET`,
    `ARCADE_TURN_TTL` (default 12h), optional `ARCADE_STUN_URLS`. Unset → STUN-only
    (LAN/same-machine only). Operator must run coturn on the public host.
- **Voxel** is a large survival sandbox (see git history / `voxel/`); heaviest client.
- **Conference** = WebEx-style monitor calls (ConferenceUI + LiveKit); per-member
  volume/mute. **Zone voice** = per-zone WebRTC + proximity.

## Ops gotchas
- **Push:** `GIT_SSH_COMMAND="ssh -4" git push …` (Codeberg hangs over IPv6).
- **Package manager:** pnpm only. Verify with `pnpm -r run check-types` +
  `pnpm --filter @pixel/server test` + `pnpm --filter @pixel/client run build`.
- Commits: no AI trailer; few meaningful commits (see AGENTS.md).

## Open / next ideas
- DM/private-chat: explored (OpenPGP E2EE) then **discarded** — decision: if revisited
  it should be a **server-persistent group chat** (server-readable), not E2EE 1:1.
- Admin UI: replace `prompt()` dialogs; monitor list only covers saved layouts.
- rooms portal + conference video not yet browser-verified end-to-end with 2+ media
  participants.
