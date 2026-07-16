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
- **Arcade** cabinets (Pixels + Voxel) run DOS shareware via js-dos; server-wide
  savegames + admin "bring your own WAD"; bundles built by `scripts/build-shareware-bundles.mjs`.
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
