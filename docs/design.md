# pixel-agents — design

How the system is put together and why. The README covers what it is and how to
build a world with it; [AGENTS.md](../AGENTS.md) carries the rules a contributor
must follow. This document is the reasoning behind those rules — read it when
you need to know *why* something is shaped the way it is, and the code when you
need to know exactly what it does.

It replaces a shelf of per-feature design documents, plans and PRDs written while
those features were being built. They described work that has since shipped and
changed; the code is the truth now, and git history has the originals.

## Shape of the system

Three TypeScript packages in a pnpm workspace, plus two satellites:

| Package | Runs where | What it owns |
|---|---|---|
| `shared/` | server (and, for pure helpers, the client) | the office engine — entities, movement, the FSM, layout, sprites — and the Colyseus schema |
| `server/` | Node 24 | the authoritative room, the Claude feed, the Tiled import, SQLite, auth |
| `client/` | browser | a Phaser renderer and input forwarder, plus the UI |
| `desktop/` | Electron | a native shell around the same client build |
| `feeder/` | wherever Claude runs | tails transcripts into the server's feed |

**One process, one port.** The viewer, the Colyseus websocket and the agent feed
(`/feed`) share a single HTTP server. There is no separate client server in
production; `pnpm start` serves the built client from the same origin. Anything
that needs a listener mounts on the shared one.

Persistence is Node's built-in `node:sqlite` — one file, `pixel.db`, one
connection (`server/src/db.ts`), no native dependencies.

## The server simulates; the client draws

All decisions happen in `shared/src/office` on the server's tick loop (`SimRoom` →
`OfficeState.update`), and the result is synced through `@pixel/schema`. The
client renders that state and forwards input. It does not run the FSM, resolve
collisions, or decide where anything is — so every viewer sees one identical
world, and a modified client cannot desync it.

The one exception is **presentation timing**: the animation frame within a synced
pose is advanced locally, as is the Matrix dissolve effect. The rule of thumb is
*sync state and intent, not frames* — anything two viewers could legitimately see
a frame apart is presentation. If a frame ever drives gameplay (attack active
frames, say), that timing moves back to the server.

Movement is tile-based A* on a grid. No physics engine: determinism and headless
execution are worth more here than a solver, and both are lost the moment
floating-point contact resolution enters the loop.

### Entities

`EntitySync` (id, transform, coarse state) is the base schema; `CharacterSync`
and `PetSync` extend it, and a new kind of thing — a monster, an NPC, an item —
extends it too rather than redeclaring a transform. Movement and pose primitives
live in `shared/src/office/engine/entity.ts` and are shared by everything that moves.

**A player is a `Character` with `isPlayer = true`**, not a parallel code path.
That is what keeps player and agent behaviour from drifting apart.

### Occupancy is one model

Every place a character can occupy — a chair, the tile in front of a coffee
machine — is an `InteractionPoint` with a `posture` and a single `occupantId`,
in one map on `OfficeState`. There used to be two models: seats with an
`assigned` boolean for agents, and stations for everything else. A player sitting
down was recorded in neither, so an agent could be sent to the chair a player was
already sitting on.

Claims go through `claimPoint`, and the exclusion is symmetric: an agent is never
sent to an occupied point, and a player is refused one, whoever got there first.
A character holds at most two point ids — `homePointId` (its own desk, a
reservation it keeps while fetching coffee) and `atPointId` (where it is now).
Pets keep their own claim set because pet and character ids share a number space,
but the exclusion between them is mutual.

Appliance approach tiles are derived, not authored: `computeApproachTiles` yields
a stand point for *every* walkable tile around a footprint, and `findFreeStation`
picks randomly among the free ones — which is what spreads visitors around an
item instead of stacking them on one side.

### Poses

A character's `CharacterPose` (`idle|walk|typing|reading|coffee`) is computed
server-side and synced; the renderer resolves frames through the single
`spriteForPose()` mapping. A new animation is a new pose plus one branch there
plus the frames — never a branch on tool names or state strings in the renderer,
which is what the original had and what made every new behaviour a render change.

## Zones and maps

A zone is an explorable space, and each one is an instance of the *same* room
type, matchmade by `zone` (`filterBy(['zone'])`). Not a room class per zone: a
new zone is a row in the registry plus one map, and both come into being by
pushing a `.tmj` for a new id.

`DEFAULT_ZONE` is only the id a client lands in when it names none. A zone whose
map was never pushed renders as an empty field rather than refusing to open.

### The Tiled pipeline

Tiled is the level editor, and the import is **one-way**: `.tmj` → the runtime
`OfficeLayout` stored in SQLite. There is no exporter and no in-game editor. Two
editable copies of a level is one too many, and the direction that lost is the
one nobody was authoring in.

What the import derives rather than reads is deliberate:

- **Walls** are edges on a half-offset lattice, so a wall costs no walkable cell.
  A piece's bitmask asserts edges into its neighbours; overlapping assertions are
  unioned, which is why a half-open wall cannot be painted by accident.
- **Approach tiles, seats and blocked cells** come from footprints and the
  Collision layer — never from coordinates stored in properties, because Tiled
  does not keep properties in sync when a shape is dragged, and a stale
  coordinate is worse than none.
- **Behaviour is stated, never inferred.** Each capability is its own property
  with its default present on every tile (`sync-furniture-properties`), so the
  absence of a property is a bug rather than a silent default. This replaced a
  taxonomy where `category === 'chairs'` decided sittability.

Furniture behaviour resolves **instance first, then catalog**: a placement
carries only its overrides.

### Getting a map onto a server

Maps are versioned, and a bundled one **seeds a zone that has no map yet** when
the server starts, so a fresh deployment (or one whose world was just wiped)
comes up with the world that is in the image rather than an empty field.

Seeding stops there. A zone that already has a map keeps it — a push is an
authored act against *that* deployment, and a release does not get to revert one;
that is also why this is not a sync on every start. Changing a live map is
`scripts/push-zones.sh`,
which authenticates with `PIXEL_ADMIN_TOKEN` in a header rather than a session
(the push routes are registered before the login gate, which would 401 a
session-less request). The push compares content hashes first and sends only the
tilesets and PNGs the server lacks, then has it rebuild its furniture catalog.

## Trust and authorization

**Assume the client is fully compromised.** Every byte from it — join options,
message payloads, headers — is attacker-controlled. Every access-control decision
is resolved server-side from the account: identity, admin status, zone
assignment, spectator status, capabilities. A client flag may at most affect a
self-only, privilege-free presentation choice; if a client can influence an
authorization outcome, that is a bug.

- **Personal data is keyed by the authenticated `userId`** from `onAuth`, never
  by an id in the payload. A user can read and change only their own avatar,
  preferences, password and agent token.
- **Shared and admin actions go through `permissions.ts`** — `may(client,
  capability, zoneId?)`. Gallery and asset edits, zone creation and deletion,
  user management and granting zone-admins need global admin; a zone's map,
  arrival point and NPCs need that zone's admin. Default to deny.
- **Secrets stay on the server**: LiveKit's key and secret, the admin token and
  scrypt password hashes never reach a client. A viewer receives only its own
  agent token, and short-lived room-scoped LiveKit JWTs whose identity is its own
  avatar. Tokens and passwords are length-bounded so verification cannot become
  a CPU denial of service, and login failures are throttled per account (not per
  IP, so a shared proxy address cannot lock everyone out).
- Client-side hiding of controls is **UX only**. The server is the gate.

Sessions are HttpOnly cookies in SQLite for the browser and `Authorization:
Bearer <sid>` for the desktop shell — the same session store either way. Both are
capabilities: production must be TLS, either the built-in certificate or a
terminating proxy. Media capture requires a secure context anyway.

## Accounts

Users live in the `users` table keyed by a lowercase, immutable `user_id` (the
login id, and the agent owner key) with a free display name, a scrypt password, an
admin flag and a per-user agent token. There is no open self-registration:
presenting `PIXEL_ADMIN_TOKEN` at login makes that user an admin and creates the
account if it is new, which is how the first one is bootstrapped. With no admin
token configured there is no login at all, and therefore **no way in**: rooms
and the feed both require an account. The server says so at startup and binds to
loopback instead of serving an ungated app to the network — a forgotten token in
production must not silently open the door.

Agents authenticate the feed with their owner's agent token; an agent's avatar is
always named after the player it belongs to.

## Real-time media

**Meetings** are LiveKit calls tied to content: a `meetingRoom` action on an area
or a piece of furniture. Walking in *is* joining — membership is derived from the
tile you stand on, server-side, and the server mints the token only for a member.
The identity in that token is `p<playerId>`, which is how the client maps a
speaking participant back to an avatar (that is what puts the ring under it).

The viewer's **audio settings** — input and output device, volume, mic gain,
voice-activity threshold — are a property of the viewer, not of a call, so they
live in one store (`client/src/voice/audioSettings.ts`) that every call reads and
that pushes changes into a running one. The microphone is captured through a Web
Audio graph (gain → limiter → gate) and *that* processed track is published, which
is what makes those sliders mean anything in a meeting.

There is deliberately no zone-wide, always-on call any more: conversation happens
in meeting areas, which a mapper places.

**Mumble** (desktop only) is a real Mumble client speaking the protocol from the
Electron main process — a browser cannot open the raw TLS socket. It connects
straight from the user's machine; the pixel-agents server never relays it and
holds none of its credentials.

**Matrix** is the chat client, including E2EE. It talks to its own homeserver
directly, on the same footing as Mumble: started before the pixel-agents
connection, so an outage here does not take chat with it.

## The desktop shell

The same client bundle runs in two environments: served by the server, and loaded
from a local `app://` origin in Electron while talking to a *remote* server. The
shell exists for two things a browser tab cannot give: a stable secure origin so
`getUserMedia`, WebRTC and persistent storage behave, and OS-keychain storage for
the session token.

That split is where client bugs come from, so:

- **No relative URLs to the server** — `fetch('/api/…')` hits `app://` in the
  shell. Resolve through the helpers in `net/room.ts`.
- **Don't derive the server from `window.location`**; the configured origin comes
  from the desktop bridge.
- **Auth differs** (cookie vs bearer), and requests from `app://` are
  cross-origin, so CORS and cookie behaviour differ too.
- `window.location.reload()` is silently dropped there — use `reloadApp()`.
- Desktop-only capabilities go through the typed preload bridge with a graceful
  browser fallback.

## Data and its lifecycle

One database, `pixel.db`: users and sessions, zones and their maps, asset
overrides, per-user preferences and positions, meeting rooms, arcade saves.

Assets are a **merge layer**: bundled files are the read-only defaults, and rows
in the `assets` table override or add individual entries. That is how a character
skin or a furniture sprite can be edited in-game without touching the repo.

A deployment accumulates state that is no longer authored where it is stored —
maps that come from Tiled now, editor-era overrides, positions into zones that no
longer exist. `PIXEL_RESET_WORLD=<token>` empties everything except the accounts
and their avatars, once per token, before any store reads or seeds. What survives
is an allow-list, so a table added later is wiped by default: covering new *world*
data for free is the right failure mode, and new *account* data announces itself
loudly by being emptied.

## Arcade content

The arcade cabinets run DOS and console games in the browser (js-dos and a
self-hosted EmulatorJS — no CDN, same stance as everything else here). **No game
content is in the repo or the image**: it is provided at runtime from
`ARCADE_CONTENT_DIR`, a bind-mounted directory built separately with `pnpm
build:arcade`. That is deliberate — bundles can contain licensed WADs, which must
never enter the repository or a published image. A server without that directory
simply offers an empty catalog.

## Known gaps

These are intended, not designed around:

- **No interest management.** Every client in a zone receives the full zone
  state. Fine at today's counts; when it bites, add spatial filtering — never
  move authority to the client to make it cheaper.
- **No reconnection grace.** `onLeave` despawns immediately; a dropped socket
  loses the entity until rejoin. `allowReconnection` is the fix when it matters.
- **Single process.** Matchmaking and state are in-process. Horizontal scale
  needs a Colyseus presence driver; keep rooms shared-nothing so that stays
  possible.
- **Thin automated tests.** Auth, matchmaking and the Mumble protocol have real
  test coverage; the office engine has none, and it is the part where a
  regression is least visible.
- **No progression, no combat.** Levels, stats, monsters and dungeons are
  intended and unbuilt. When they arrive, the rules and the authority go
  server-side and the results sync — exactly like movement and interaction.
