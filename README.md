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
| `desktop/` | Electron shell that wraps the built client as a native desktop app (secure `app://` origin, OS-keychain token storage, screen-share source picker). |
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
  --server ws://localhost:2567/feed --token <your-agent-token>
```

`--token` is your **per-user agent token** (copy it from in-app Settings); the
server resolves it to your account and labels your agents accordingly. In open
dev mode (no `PIXEL_ADMIN_TOKEN`) there are no accounts, so any value is accepted
and the agents are labelled generically.

### Build & run (single server, single port)

```bash
pnpm vendor:mediapipe   # once: self-hosted segmenter for the video background
                        # filters (~19 MB into client/public/mediapipe, gitignored)
pnpm build          # type-checks + builds the client into client/dist
pnpm start          # one server: viewer, Colyseus and /feed all on one port
```

`vendor:mediapipe` is optional but recommended: it is what makes the conference
**Filter** button (background blur / virtual background) work, self-hosted with no
CDN. Without it everything else runs and the picker says how to install it. The
Docker image and the AppImage workflow run it for you.

In production there is **no separate client server** — `pnpm start` (and the
Docker image) serve the built client from the same origin. A viewer only needs
a browser pointed at the server URL; an agent only needs Claude + the feeder.

### Desktop client (Electron)

`desktop/` is a thin Electron shell around the same built web client. It exists
so the office can run as a native window with two things a plain browser tab
can't give you: a **stable secure origin** (`app://bundle`) so `getUserMedia` /
WebRTC screen-sharing and persistent settings work reliably, and **OS-keychain
storage** for your login token (encrypted at rest via Electron `safeStorage`).
It also adds an in-window screen-source picker and HUD window controls.

The shell only renders the UI — it still talks to a **server you point it at**
(local or remote). It bundles the client build, not the server.

**Run in development** (builds the client + the Electron main/preload, then
launches the app):

```bash
pnpm dev:desktop
```

Make sure a server is running (`pnpm dev:server`, or a remote one) to connect
to. On first launch the app shows a **Connection** screen — enter the server URL
(e.g. `http://localhost:2567`); it probes `/health`, then takes you to sign-in.
The server URL and token persist across relaunches; you can change the server or
sign out from within the app.

**Build a distributable** (currently a Linux AppImage, unsigned):

```bash
pnpm dist:desktop     # → desktop/release/pixel-agents-<version>-<arch>.AppImage
```

`pnpm build:desktop` just compiles the shell (client build + Electron
main/preload) without packaging. Both require `electron`'s postinstall to have
fetched its Chromium binary (allowed in `pnpm-workspace.yaml`).

CI (`.github/workflows/desktop.yml`) builds the AppImage on every push. A `v*`
tag gets it attached to that release; every `master` commit overwrites the
rolling `latest` prerelease, so the newest master build is always at a fixed URL:

```bash
curl -LO https://github.com/davrux/pixel-agents/releases/download/latest/pixel-agents-latest-x86_64.AppImage
chmod +x pixel-agents-latest-x86_64.AppImage
```

#### Mumble voice (desktop only)

The desktop app is also a **Mumble client**. Set a server, name and (optionally)
a certificate under *Settings → Mumble voice*, then open the **🎧 Mumble** panel
from the top bar and flip its switch: you get the server's channel tree, its
users, push-to-talk with a threshold gate, and per-user volume — alongside, but
independent of, the built-in zone voice. The 📌 pin keeps the panel open while
you play instead of closing when you open another menu. You can only be in one
call at a time, so turning Mumble on parks zone voice (and a conference parks
both).

**Join/leave alerts** (on by default, toggled in the same panel) raise a normal
OS notification when someone enters or leaves *your* channel — so an unattended
window still tells you a colleague dropped in. Moves that don't touch your
channel stay silent, your own channel switch never announces the people already
there, and a burst (a server restart, a group move) is coalesced into one
notification. Clicking it focuses the app window.

It connects **straight from your machine** to the voice server: the pixel-agents
server never relays it and holds none of your credentials. Connection details
live in Electron's `userData`; the server password and certificate passphrase go
to the OS keychain. On first connect you are asked to trust the voice server's
certificate by fingerprint, the same prompt the app uses for self-signed servers.

Certificates are Mumble's notion of an account. Point *Identity* at the `.p12`
your Mumble client exports (Configure → Certificate Wizard → Export) to appear as
your existing registered user; without one you connect as an unregistered guest.
Once connected, **Register me** asks the server to register you, if it allows it.

Browsers can't open the raw TLS socket Mumble needs, so this is desktop-only. An
operator can set `MUMBLE_HOST`/`MUMBLE_PORT`/`MUMBLE_CHANNEL` (see
`.env.example`) purely so the app can *suggest* the community's address.

### Accounts & login

Set **`PIXEL_ADMIN_TOKEN`** (or `--token`) to enable accounts. Players sign in
with a **login id + password**; presenting the admin token additionally makes
that user an **admin** and **creates the account if it doesn't exist yet**
(a password, min 6 chars, is required to create one). There is no open
self-registration and no anonymous mode while the token is set — bootstrap the
first admin by logging in with the token, a new login id, and a password.

- **Login id** (`user_id`) is lowercase-unique and immutable; the **display
  name** is free and shown on your avatar (empty → the login id).
- Each user gets a **per-user agent token** (Settings → copy) that their agents
  pass as `--token`; it identifies the owner, so their agents follow them.
- **Editing the world/assets** (layouts, zones, the shared character gallery) is
  **admin-only**. Everyone can edit their own avatar.
- Change password / display name and view your agent token under **Settings**.

With no admin token set, the server runs in **open dev mode**: no login, an
anonymous viewer, and editing open to all. All state lives in a single
`pixel.db` (in `PIXEL_STREAM_DATA_DIR`, default `~/.pixel-agents2`).

## Status

Ported 1:1 and verified: the default office layout, the original character /
furniture / floor / wall / pet sprites and animations, the FSM behaviour
(walk-to-seat, typing/reading, idle-only-when-standing, wandering), permission
and waiting bubbles, sub-agents, team colours, and pets.

Not yet ported: the in-browser layout **editor**, the per-pixel **matrix**
spawn/despawn effect (currently a fade), and furniture auto-on/animation
(furniture renders in its default state). These are deferred.

## Credits

The character/world art is based on the amazing work of **JIK-A-4 — Metro City**
(free top-down character pack):
<https://jik-a-4.itch.io/metrocity-free-topdown-character-pack>.
