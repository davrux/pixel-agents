# pixel-agents

A multi-agent pixel office you can walk around in. Claude agents stream their
transcripts to a server, which simulates them as characters that walk to a desk,
type, read, fetch coffee, spawn sub-agents and idle — and you can join them as a
player, in a world built with the Tiled map editor.

This is a fork of [pixel-agents](https://github.com/pixel-agents-hq/pixel-agents),
ported onto a game-engine stack: **[Colyseus](https://colyseus.io/)** runs an
authoritative server simulation, **[Phaser](https://phaser.io/)** renders it. The
original's art, animations and agent behaviour came over 1:1; everything since —
zones, human players, NPCs, portals, meetings, the Tiled pipeline — grew from
there, aimed at a small MMO-style world.

> 🎮 **A fun, hobby project** — built for the joy of it, not as a hardened
> product. Expect rough edges; no stability, security or support guarantees. Use
> it at your own risk and have fun. 🙂
>
> 🤖 **A pure AI project** — essentially all of the code in this fork was written
> by AI coding agents, which is also why the source is commented the way it is:
> the *why* is written down, because the next contributor has no memory of the
> last conversation.

## Credits

The character and world art builds on the wonderful **MetroCity** pack by
**[JIK-A-4](https://jik-a-4.itch.io/metrocity-free-topdown-character-pack)** —
a free top-down character pack. The office's own sprites come from the original
pixel-agents. UI font: **FS Pixel Sans**.

## Quick start

```bash
pnpm install
pnpm dev:server      # server + Colyseus + agent feed on http://localhost:2567
pnpm dev:client      # http://localhost:5173 (hot reload; production is one port)
```

`MOCK=6 pnpm dev:server` populates the office with six synthetic agents so it is
alive without connecting anything.

For production there is **one** process and **one** port — the server also serves
the built client:

```bash
pnpm build && pnpm start
```

Stream a real Claude agent in:

```bash
scripts/pixel-agents.sh --token <your-agent-token>                 # public server
scripts/pixel-agents.sh --token <your-agent-token> \
  --server ws://localhost:2567/feed                                # your own
```

The token is your per-user agent token (in-app Settings → copy). It identifies
the owner, so your agents follow you.

**`PIXEL_ADMIN_TOKEN` is required to run the thing at all.** Players sign in with
a login id + password, and presenting the admin token at login makes that user an
admin, creating the account if it is new — that is how you bootstrap the first
one. There is no anonymous mode: without the token there is no login, nobody can
join, and the server deliberately binds to loopback rather than serving an
ungated app to the network. All state lives in a single `pixel.db` under
`PIXEL_STREAM_DATA_DIR` — by default `tmp/data` inside the repo, so a
development world belongs to the checkout it was made in. On first start that
directory is created, a self-signed certificate is generated for it (camera,
microphone and screen sharing need a secure context, so `https://localhost:2567`
is the default), and a database from a former default location is adopted if one
is found. A deployment sets the variable and gets none of that.

There is also an **Electron desktop app** (`pnpm dev:desktop`, `pnpm
dist:desktop`) — the same client in a native window, with an OS-keychain-stored
login, a screen-share source picker, a system tray with an unread badge, and a
built-in Mumble client. See [docs/design.md](docs/design.md).

---

# Building a world with Tiled

The world is **content, not code**. Every zone is authored in
[Tiled](https://www.mapeditor.org/) and nothing about it is generated: if you
want a chair to be sittable, a monitor to light up, or a door to lead somewhere,
you say so on the tile — the engine never infers it.

Open `assets/tiled/Pixels.tiled-project` in Tiled. Everything below lives in that
project (**View → Custom Types Editor**), which is why the properties show up on
your tiles and objects at all.

## A zone is one map

A zone is a room in the game and exactly one `.tmj` file:
`assets/tiled/zones/<zoneId>.tmj`. Adding one *is* adding a zone — push a map
for a new id and the server registers it with sensible defaults. There is no
zone table in the code and nothing creates a zone from inside the game.

Maps are versioned in git so levels are diffable and shareable, but **a map only
seeds a zone that has none** — a fresh server comes up with the world in the
image — while **an existing map is never overwritten**. Changing a live map is
therefore always a push:

```bash
scripts/push-zones.sh                          # every map → 127.0.0.1:2567
scripts/push-zones.sh uponu --watch            # re-push that one on every save
scripts/push-zones.sh --server=deploy.host:443 # push everything to production
```

Authentication is `PIXEL_ADMIN_TOKEN`. The push also sends any tilesets and PNGs
the server is missing (compared by content hash, so a one-line map edit doesn't
ship megabytes). `*-noimport.tmj` is never imported — that suffix is your scratch
copy.

## The four layers

Every map has these, identified by their **class**, not their name:

| Class | Holds | Offset |
|---|---|---|
| `GroundLayer` | floor tiles, painted **everywhere a room reaches** — walls no longer cost a cell | none |
| `WallLatticeLayer` | wall pieces, one per lattice point (the corner shared by four cells) | `offsetx`/`offsety` **−8** |
| `WallFaceLayer` | north-wall face pieces — the flat surface a room is looked at | none |
| `CollisionLayer` | the single "blocked" marker tile from `collision.tsj` | none |

Walls are **edges on a half-offset lattice**: a wall piece's N/E/S/W bitmask says
which of the four edges meeting at that point are wall, so the Wang/Terrain brush
works as usual — you just paint on the boundaries. Two neighbouring points that
disagree about a shared edge both get their way, so you cannot paint a half-open
wall by accident. A faced wall is two things: face pieces on `WallFaceLayer` in
the rows above the base, and an edge run along that base on `WallLatticeLayer` —
the face is the picture, the lattice is the barrier. Don't paint Collision over
faces; a face cell is non-walkable already.

Objects live on object layers: **Furniture**, **Actions**, **Images**, **Text**.

## Furniture: the type and the placement

Furniture is two things, and the difference matters:

- a **`FurnitureTile`** in `assets/tiled/furniture*.tsj` — the *catalog entry* for
  a kind of thing, carrying its default behaviour;
- a **`FurnitureObject`** in a map's Furniture layer — one *placement*, carrying
  only the overrides it actually makes.

Absence on a placement means "whatever the type says". Writing every property
onto every placement to be thorough is how you turn all chairs in a map
unsittable on the next import.

Every catalog tile carries **every** property with its default filled in — that
is what `scripts/sync-furniture-properties.sh` maintains — so a mapper never has
to know a property exists in order to use it. Run it (`--check` in CI) whenever
the set of properties changes.

| Property | Type | Meaning |
|---|---|---|
| `id` | string | Stable catalog identifier. Required on the tile. |
| `label` | string | Display name; falls back to `id`. |
| `canSitOn` | bool | May a character sit here? Every footprint tile below the `backgroundTiles` rows becomes a seat, so a two-tile couch seats two. |
| `sitFacing` | `N`/`E`/`S`/`W` | Which way a sitter looks; blank = `N`. Also decides z-order: an `N`-facing seat draws *in front of* the character. |
| `petCanSitOn` | bool | May a pet perch on top? |
| `canWalkOver` | bool | A floor decal — rug, doormat, marking. Blocks nothing and draws just above the floor, below everyone. |
| `backgroundTiles` | int | How many rows from the top of the footprint stay walkable *and* buildable-over (a wall painting's row, a portal pad's tile). |
| `onState` | string | The catalog `id` this tile turns *into* when switched on — see below. |
| `actionKind` | enum | What it does when approached — see below. |
| `actionVideo` | bool | `meetingRoom` only: camera offered, or audio/chat only. |
| `actionUrl` | string | `iframe` only, must be `https://`. |
| `actionPose` | enum | `appliance` only, e.g. `coffee`. |
| `meetingRoomName` | string | `meetingRoom` only: what the room is called. |

Placements additionally take `name`, `approachSides` (a flags enum — **empty
means "every open side", not "none"**) and `approachThrough` (this item may be
searched *past* when another item looks for its approach tiles, e.g. an appliance
behind a kitchen counter).

There is deliberately **no category and no taxonomy**. Behaviour used to be
inferred from one — chairs were sittable because their category said `chairs` —
which meant a correctly drawn, correctly categorised chair could still be
unsittable with nothing in Tiled to point at.

Native Tiled features do the rest: **tile animation** (right-click → Tile
Animation Editor) for a flickering lamp or a spinning fan, and object **flip**
for mirroring a placement.

## Actions — what happens when you get there

`actionKind` is a discriminated union: it decides which of the other `action*`
properties is read at all. It can sit on a catalog tile (the type's default), on
a placement (an override), or on an **`ActionArea`** — a Point or Rectangle on
the Actions layer, for a trigger with no furniture behind it. The area's
position *is* the data; a 10×10 meeting room and a single tile use the same
class.

| `actionKind` | What it does | Reads |
|---|---|---|
| *(empty)* | nothing — scenery | — |
| `meetingRoom` | walking in joins a video/audio call for that area | `actionVideo`, `meetingRoomName` |
| `meetingManager` | opens the meeting-room manager | — |
| `iframe` | opens a web page in-game | `actionUrl` |
| `appliance` | walk up, use it, adopt a pose — `coffee` is the coffee machine | `actionPose` |
| `arcade` | opens the arcade cabinet | — |
| `timeClock` | punch in/out at the time clock — desktop app only | — |
| `portal` | walking onto its footprint offers a destination picker | — |
| `toggle` | a light switch: click flips this tile's own on/off pair | — |
| `spawnPoint` | tile-only, consumed at import to set the zone's arrival tile | — |

**Where one meeting room ends and the next begins.** Meeting tiles that touch
form one room only if they agree on `meetingRoomName` (and on `actionVideo`).
Four rooms side by side with a shared wall stay four rooms — the engine used to
flood-fill them into one call labelled with whichever name it met first. Two
abutting or overlapping rectangles carrying the *same* name still merge, which is
how you draw an L-shaped room. Unnamed meeting tiles have nothing to tell them
apart, so there adjacency alone still decides.

**Travel is content.** A portal is just furniture whose action is `portal` — a
door, a beam pad. Never hard-code a coordinate jump.

## On/off state — the off tile names the on tile

A monitor or a lamp is **two catalog entries**, not one tile with a boolean. Set
`onState` on the *off* tile to the `id` of the *on* tile; the on tile needs
nothing. What flips it follows from the action:

| The tile has | Behaviour |
|---|---|
| `actionKind: toggle` | a light switch — clicking flips it, and nothing else does |
| `onState` and no toggle action | it lights up on its own while an active agent sits facing it |

If `onState` names an id that doesn't exist, the tile simply never toggles.

## Images and text

**Images** are GID-backed tile objects placed from the generated `images.tsj`
(Insert Tile, `T`) — Tiled has no standalone image object, so an image is
structurally a furniture placement under a different name, carrying an
`imageId`. Add tiles to `images.tsj` with Tiled's own Tileset editor (they may
point at any PNG on disk) or re-bake it. **Text** is Tiled's native text object;
nothing custom about it.

## Enums, in one place

| Enum | Values |
|---|---|
| `SitFacing` | *(empty)*, `N`, `E`, `S`, `W` |
| `ApproachSide` (flags) | `N`, `S`, `E`, `W` |
| `ActionKind` | *(empty)*, `meetingRoom`, `meetingManager`, `iframe`, `appliance`, `arcade`, `timeClock`, `portal`, `toggle`, `spawnPoint` |
| `ApplianceKind` | *(empty)*, `coffee` |

## Two things that will bite you

**A placement dragged from the Tilesets panel has no class**, so Tiled offers it
no properties — it still imports correctly (the tile's own values apply), you
just cannot edit its overrides until it has one. Pick `FurnitureObject` in its
Class field, or run `scripts/sync-furniture-properties.sh`, which stamps the
class onto every class-less furniture placement.

**`sitFacing` on a tile describes the unflipped art.** A flipped placement
mirrors it, so an `E`-facing chair flipped horizontally seats you facing `W`. A
value set on the *placement* is taken literally instead — you already know which
way you flipped that one.

---

## Where to read more

- **[AGENTS.md](AGENTS.md)** — the working agreements: architecture invariants,
  security rules, conventions. Read this before changing code.
- **[docs/design.md](docs/design.md)** — how the system is built and why: the
  authoritative simulation, zones, the Tiled pipeline, auth, the desktop shell
  and the voice/chat integrations.
