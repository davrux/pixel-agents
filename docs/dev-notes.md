# Dev notes (project memory)

Curated, in-repo working memory for this project — kept here (committed + pushed)
because the agent's `~/.claude` store is wiped on every dev-container rebuild.
**Conventions & invariants live in [`AGENTS.md`](../AGENTS.md)**; this file is the
*current state, where things live, decisions, gotchas, and open items* — update it
as work progresses. It is a curated summary, not a changelog (git has the history).

## Big picture
Server-authoritative MMO on **Colyseus + `/feed`** (one port), browser
**clients on the same backend** (any server change applies to all):
- **Pixels** (`client/index.html` → `client/src/scenes/OfficeScene.ts`) — 2D Phaser
  office; zones = rooms (SimRoom).
- **Meet** (`client/meet.html` → `client/src/meet/main.ts`) — standalone ad-hoc
  meeting-room join page (`/meet/<slug>`), no pixel-agents account required.
- **Admin** (`client/admin.html` → `client/src/admin/`) — admin-only user/room mgmt.

(A 3D voxel-sandbox client existed on this branch; removed — see
`origin/voxel-backup` for its history if it's ever wanted back.)

Auth/users/sessions/zones/voice/conference/chat are **shared server-side** (single
`pixel.db`). Identity = `user_id` (login id). See `AGENTS.md` for the invariants.

## Roles & access control (on main)
- `users.role` = **admin | user | customer** (+ `allow_pixels` for customers).
  admin = everything; user = create/edit their OWN zones (creator becomes that
  zone's admin); customer = external guest.
- **Customer gating:** only assigned rooms (`zone_customers`); the Pixels 2D client
  needs `allow_pixels` (portal join is a non-spatial "spectator"); no agents (feed
  rejects them); no arcade WAD endpoints. Zone lists + portal options are
  filtered per customer. Shown in-world as "Customer".
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
`/admin-site` (admin) — client-side via the shared ChatUI `clientCommand` hook.
Add a matching command for any new destination (see AGENTS.md convention).

## Other subsystems (brief)
- **Arcade** cabinets (Pixels) run games via js-dos (DOS); server-wide
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
  per-cabinet match; host/join/mode/start; onLeave hook wired in SimRoom;
  sends `arcadeLobby` + `arcadeLaunch`). Client: ArcadeUI 👥 button → lobby modal →
  on `arcadeLaunch` boot the game.
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
- **Conference** = WebEx-style monitor calls (ConferenceUI + LiveKit). The People
  panel carries two different mutes per member: 🔊 + the slider are **local**
  (this viewer's playback only, volume persisted by name in localStorage), while
  "Mute for all" sends a `{t:'mute'}` data message to that member, whose own
  client switches its mic off — so it's off at the source for everyone, and they
  can unmute themselves again with their Mic button. No moderator role, no
  server enforcement. LiveKitConference drops every tile — cameras *and* screen shares —
  into one stage; ConferenceUI owns the layout on top of it: a page-filling grid
  (tile size solved in JS, since CSS auto-fit strands everyone in one row) or one
  focused tile plus a filmstrip. Click a tile to focus it, "▦ Grid"/Esc/double-click
  to go back; a new screen share focuses itself once.
  Camera/mic permission is assumed to fail regularly, because on Firefox it does
  — Firefox drops a grant as soon as capture stops, so it re-prompts on every
  join (and on every Cam re-enable, since LiveKit stops the camera track on mute
  to kill the hardware light and has to re-acquire it). Hence: one combined
  `enableCameraAndMicrophone()` for a single prompt, a join that degrades to
  mic-only or watch-only instead of failing whole (a refused camera used to take
  the mic with it — `getUserMedia` is all-or-nothing), `camOn`/`micOn` that only
  claim what is really published, and `Room.getLocalDevices(kind, false)` so
  enumerating devices never fires a permission request of its own (the default
  `true` re-prompts whenever a label is blank or a list is empty — Firefox's
  speaker list usually is). **Zone voice** = per-zone WebRTC + proximity, and it
  defers `getUserMedia` until the first unmute, so joining a zone never prompts.
- **Mumble (desktop only)** — a real Mumble client, split across the two processes:
  - `desktop/src/mumble/` is main-process: `varint.ts` (Mumble's own big-endian
    varint — **not** protobuf's LEB128, which is in `protobuf.ts`), `protocol.ts`
    (framing `[u16 type][u32 len]`, the ~10 messages we use, `FrameReader`, and the
    legacy voice packet), `session.ts` (TLS + state machine), `settings.ts` (config
    in `userData/mumble.json`, secrets via `safeStorage`, TOFU cert check),
    `service.ts` (owns one session, validates every IPC payload).
  - `client/src/voice/Mumble*.ts` is renderer: WebCodecs Opus encode/decode, an
    80 ms jitter buffer, per-user mixing, the panel and the settings block. The
    panel is its own top-bar entry (not inside Audio) and can be pinned open;
    in the office that means it opts out of setMenu's one-panel-at-a-time rule
    (`body.pa-mumble-pinned` shifts the other right-hand popovers aside).
  - **Playback must stay in one clock domain.** Two rules keep pitch correct, and
    both were once broken, which made voices drift low and slow:
    1. `masterGain → ctx.destination`, with the speaker chosen via `setSinkId` **on
       the AudioContext**. Routing through `MediaStreamAudioDestinationNode` into an
       `<audio srcObject>` — the old way to get `setSinkId` — hands audio to
       Chromium's WebRTC renderer, which has its own playout clock and time-stretches
       when it thinks it has drifted. The element is used **only** when the engine
       exposes no `setSinkId` on the context. A call that merely *rejects* must not
       reach for it: Chromium refuses a non-default sink until mic permission is
       granted, and playback starts on sync, racing (or preceding) `startMic` — so
       with the mic off that refusal is the normal state, and the fallback would give
       up correct pitch for a device the element can't select either. We stay on the
       default device and retry the context sink (again after `startMic`, which is
       what grants the permission).
    2. The jitter buffer is the `pa-voice-playout` worklet: a per-user ring read at
       exactly one sample per output sample, so arrival timing can never affect
       pitch. It emits silence when starved and drops the oldest audio above 250 ms,
       but never stretches. Scheduling each frame as its own
       `AudioBufferSourceNode` (the old approach) had no ceiling, so every TCP stall
       permanently added its own duration to that peer's latency.
    Set `localStorage.pa-mb-audiodebug = '1'` for per-peer depth/underrun/drop/loss
    lines. Depth should sit near 80 ms and return there after a stall.
  - Remote frame sizes are **not** the 20 ms we transmit — official Mumble also
    sends 10/40/60 ms, so `opusDurationUs` reads the real duration off the packet's
    TOC byte. The terminator bit likewise rides the last frame that still *carries*
    audio, so it must be decoded before the end-of-spurt reset.
  - **Why the split:** browsers can't open a raw TLS socket, but an Electron
    renderer *is* Chromium and has WebCodecs — so protocol lives in main, all audio
    in the renderer, and Opus packets cross IPC opaque. Audio uses `send`, not
    `invoke` (a promise per 20 ms frame is waste); control stays on `invoke`.
  - Voice rides Mumble's `UDPTunnel` over TCP — no UDP, no `CryptSetup`, no OCB2.
    We announce version 1.3.0 and deliberately **not** `version_v2`, or Murmur
    switches to the 1.5 protobuf voice format we don't parse.
  - Node's `tls` does **not** go through Chromium's `setCertificateVerifyProc`, so
    `verifyMumblePeer` checks the shared `certTrust.ts` store itself — and converts
    Node's `AA:BB:` hex to Chromium's `sha256/<base64>` so one trust decision covers
    both paths.
  - The pixel-agents server is uninvolved apart from an optional
    `GET /mumble/config` address suggestion (`MUMBLE_HOST`/`_PORT`/`_CHANNEL`).

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
