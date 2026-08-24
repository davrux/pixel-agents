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
a free top-down character pack. The overworld terrain, buildings and outdoor
props come from **[Zelda-like tilesets and sprites](https://opengameart.org/content/zelda-like-tilesets-and-sprites)**
by **ArMM1998** (public domain / CC0), imported by
`scripts/import-overworld-pack.sh`. The office's own sprites come from the
original pixel-agents. UI font: **FS Pixel Sans**.

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

## Controls

| | |
|---|---|
| **W A S D** / arrows | walk |
| **click** | use what you pointed at — a chair, a coffee machine, an arcade cabinet, a meeting monitor |
| **double click** | go there: walk to that tile |
| **right click** | warp to that tile (instant, no walking — you arrive standing) |
| **C** | sit down where you are |
| **M** | mute/unmute your microphone in the call you are in |
| **F8** | frame-time overlay |
| **/** in chat | slash commands — `/help` lists them, `/reload` restarts the app |

Two gestures, two jobs: **using** a thing is one click, because pointing at it
was already deliberate — a chair counts, sitting down being the most common thing
anyone does in an office; **walking to a tile** takes two. A single click on plain
floor does nothing, which is the point — it has too many other jobs (dismissing a
panel, handing the keyboard back to the game, picking a character to look at) and
each of them used to send the avatar across the office as a side effect.

There is also an **Electron desktop app** (`pnpm dev:desktop`, `pnpm
dist:desktop`) — the same client in a native window, with an OS-keychain-stored
login, a screen-share source picker, a system tray with an unread badge, and a
built-in Mumble client. See [docs/design.md](docs/design.md).

The desktop app ships its **own** bundle and talks to a *remote* server, so unlike a
browser tab it does not get a new client with a deployment — and nothing updates it
behind your back. When a release changes the wire format, the app says so instead of
rendering a wrong world silently (`PROTOCOL_VERSION`, checked on join — see
`client/src/ui/versionGate.ts`): a small **Update** chip appears in the top bar, and
clicking it downloads the new package and restarts. Where the app cannot update itself
— macOS, which refuses unsigned updates, or a build predating the updater — the chip
says why, and this one-liner replaces the AppImage in place:

```bash
curl -L -o ~/.local/share/AppImage/pixel-agents.AppImage https://github.com/davrux/pixel-agents/releases/download/latest/pixel-agents-latest-x86_64.AppImage && chmod +x ~/.local/share/AppImage/pixel-agents.AppImage
```

---

# Building a world with Tiled

The world is **content, not code**. Every zone is authored in
[Tiled](https://www.mapeditor.org/) and nothing about it is generated: if you
want a chair to be sittable, a monitor to light up, or a door to lead somewhere,
you say so on the tile — the engine never infers it.

Open `assets/tiled/Pixels.tiled-project` in Tiled. Everything below lives in that
project (**View → Custom Types Editor**), which is why the properties show up on
your tiles and objects at all.

**Ground is whatever you paint on the GroundLayer.** Any tileset works — a
palette-baked floor set or a sheet straight from an art pack — and only the ground
makes a cell walkable: a decal is a picture and nothing else, so art painted on a
decal layer over an unpainted cell looks fine and cannot be entered. The one limit
is that a ground tile must be 16×16, since a ground cell is one map cell.

**Where the art lives.** All of it is under `assets/tiled/png/src/` — per-tile
furniture and decal PNGs, the grid sheets, the floor patterns and wall geometry,
background images. That is the only place you ever put a file. Beside it,
`png/baked/` is a build product: the palette-baked floor and wall sheets and the
furniture atlas, all reproducible from `png/src` and none of it yours to edit — the
atlas is re-baked by the server itself whenever the art changes. Bringing in a new
art pack follows the `tiled-asset-import` skill, which decides for each piece what
it is and where it goes.

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

## The tile layers

Every map has these, identified by their **class**, not their name:

| Class | Holds | Offset |
|---|---|---|
| `GroundLayer` | floor tiles, painted **everywhere a room reaches** — walls no longer cost a cell | none |
| `WallLatticeLayer` | wall pieces, one per lattice point (the corner shared by four cells) | `offsetx`/`offsety` **−8** |
| `WallFaceLayer` | north-wall face pieces — the flat surface a room is looked at | none |
| `CollisionLayer` | the single "blocked" marker tile from `collision.tsj` | none |
| `DecalLayer` | painted map art — see below. **Several are allowed**, drawn in the order the Layers panel lists them; its `occludes` property decides whether everything on it lies flat or stands | none |

Walls are **edges on a half-offset lattice**: a wall piece's N/E/S/W bitmask says
which of the four edges meeting at that point are wall, so the Wang/Terrain brush
works as usual — you just paint on the boundaries. Two neighbouring points that
disagree about a shared edge both get their way, so you cannot paint a half-open
wall by accident. A faced wall is two things: face pieces on `WallFaceLayer` in
the rows above the base, and an edge run along that base on `WallLatticeLayer` —
the face is the picture, the lattice is the barrier. Don't paint Collision over
faces; a face cell is non-walkable already.

Objects live on object layers: **Furniture**, **Actions**, **Images**, **Text**.

## Decals: art that is not an object

A **decal** is a picture on the map and nothing else. You paint it with the stamp
on a `DecalLayer`, from `decal.tsj` or from any furniture tileset — a tile layer
takes tiles from any set, and Tiled anchors an oversized one at its cell's bottom
edge, exactly as the game then draws it.

Why bother, when a furniture object shows the same picture: **a furniture
placement is a live object.** It has fifteen synced fields, it can be switched,
sat on, claimed and blocked against, and every scan that answers "what is on this
tile" walks past it. That is the right price for a chair and an absurd one for a
patch of grass — and an outdoor map is mostly patches of grass. A decal instead
travels with the map (one message, like the floor), never changes, and no scan
ever looks at it. The thousandth decal costs what the first did.

What you give up, in exchange: a decal cannot be switched on or off, carry an
Action, be sat on, animate, or be overridden per placement — a tile-layer cell
holds a tile and has nowhere to put an override. And it does not block. If it
should, paint the same cell on the `CollisionLayer`.

A `DecalTile` therefore has two properties, not thirteen: `id` (catalog identity,
like a furniture tile's) and `label`. It says nothing about how it draws.

### Flat or standing is a property of the LAYER

Whether you walk **over** a thing or **behind** it is decided by the layer, via
the `occludes` property of the `DecalLayer` class — select the layer, tick the
box:

| Layer `occludes` | Everything painted on it |
|---|---|
| unset / `false` | lies **flat** — drawn just above the floor, characters walk over it wherever they stand. Paving, grass, a shadow, flowers. |
| `true` | **stands** — sorts by its own cell's bottom edge, exactly like furniture, so a character behind it is hidden and one in front of it is not. A tree, a fence, a lamp post. |

On the layer and not on the tile, because whether a picture is background or an
obstacle belongs to the **place**, not to the art: the same tree is scenery on a
far hillside and an obstacle beside the path. So keep at least two decal layers —
say `Ground` and `Standing` — and move a cell between them to change its mind. A
cell also holds only one tile, so a flower on top of a grass patch needs a second
layer anyway; they stack in the order the Layers panel shows.

This is also why furniture art works on a decal layer at all: nothing is read off
the tile that a `FurnitureTile` could not answer.

### Two shapes of decal tileset

- `decal.tsj` is a **collection of images** — each tile names its own PNG. Right
  for standalone pieces: a grass patch, a shadow, a puddle.
- `decal-roads.tsj` is a **grid tileset** — one sheet, a tile's id being its
  position in it. Right when the *arrangement* is the content: road pieces only
  make sense next to each other, so Tiled shows them exactly as the artist laid
  them out and you mark a junction and stamp it as one block. 305 named cells out
  of a 20×20 grid; the 95 blanks are deliberately unnamed, so nothing resolves
  there. Regenerate with `scripts/import-road-sheet.sh`, which copies the sheet
  through untouched and keeps any labels you have already written.

A road you walk on belongs on the `GroundLayer` — that is what makes a cell
walkable. Paint it on a decal layer only where it lies over ground that is already
there. Where a road should stop movement — a central barrier, a wall of parked cars
— paint the `CollisionLayer` over it.

Rule of thumb: if it only needs to be *seen*, it is a decal. If it needs to be
interacted with, sat on, switched, blocked or moved by the server, it is
furniture. Painting a behaviour-carrying tile on a decal layer is allowed — that
is how a decorative chair stops being an object — and the import says loudly which
behaviour you just gave up.

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

### Bringing in one picture as one piece of furniture

Art of a single object usually arrives far too big — a 1024×1024 render of a
coffee machine. Footprint comes from the PNG's size, so that would be a 16×16-tile
object; somebody has to say how many **tiles** the thing is:

```sh
scripts/import-furniture-image.sh ~/Downloads/coffeemachine.png \
    --id ESPRESSO_MACHINE --set kitchens --size 32x32 \
    --erase 440,0,584,170 \
    --prop backgroundTiles=1 --prop actionKind=appliance --prop actionPose=coffee
```

It resamples (area-averaged over premultiplied alpha, hard silhouette, small
palette with the accents kept), lays the catalog's usual shadow row under it,
writes `png/src/furniture/<set>/<ID>.png` and **appends** one tile to
`furniture-<set>.tsj` with every property at its default. `--erase X,Y,W,H` blanks
part of the source first — detached decoration like a floating steam wisp survives
a 30:1 reduction only as specks. `--size` is a box to **fill**, which is what a
machine drawn to fit one wants; add `--fit` when the subject has proportions of its
own — a car seen from the side is 3.4:1 where the vehicle sets' tile is 2:1, and
filling that box ovalises every wheel, so with `--fit` the art keeps its aspect and
sits bottom-centred in the spare rows. `--replace` redraws the PNG of an id that
is already in the set — a better render of the same object — leaving the tileset
untouched, so there is no gid table to repair; it refuses a size the tile does not
already have, because footprint, blocking and seats all come from the PNG's size.
Set the rest of the behaviour on the tile in Tiled; `--help` lists every option.

16px is one tile, so `--size 32x32` is a 2×2-tile object, about as tall as a
character. Afterwards run `scripts/sync-furniture-properties.sh --check`: growing
a tileset moves the next one in every map's own gid table, and `--fix-gids`
repairs that (so does opening and saving the map in Tiled).

For a whole art *pack* this is the wrong tool — that is a sheet or a collection,
and `.claude/skills/tiled-asset-import/` covers which.

## Actions — what happens when you get there (and one that needs nobody)

`actionKind` is a discriminated union: it decides which of the other `action*`
properties is read at all. It can sit on a catalog tile (the type's default), on
a placement (an override), or on an **`ActionArea`** — a Point or Rectangle on
the Actions layer, for a trigger with no furniture behind it. The area's
position *is* the data; a 10×10 meeting room and a single tile use the same
class.

Most of them happen because somebody arrived: on furniture you click it and your
avatar walks up, on a tile it fires the moment you stand there. One does not —
`talkingObject` is triggered by the clock, so it needs no player and ignores
clicks. Place it and walk away; it still speaks. It says two things: the hour, on
the hour — `9 UHR, 9 UHR !!!`, called out twice and in German only, because the
line is one broadcast to everybody rather than something rendered per viewer, and
because it is a whale shouting across a room rather than a status line — and a
random line from the world's quote pool at a random moment every 20 to 60
minutes. There is no property to pick one — a talking object does both.
Each line appears twice: as a speech bubble over the piece, and as a line in the
zone's chat log attributed to it (the placement's name in Tiled if you gave it
one, otherwise the label its art carries). The bubble is a moment you have to be
looking at; the log is what somebody who was in the room can still read. Those
lines never light the chat's unread dot — a speaker on a timer would leave it
permanently lit, and a signal that is always on is not one.

**The hour is the server's, and the zone is Europe/Berlin, hardcoded.** One
clock for the world: everyone standing at the whale hears the same hour at the
same moment, and a viewer whose own machine is an hour out is not told the wrong
time. The zone is in the code (`ANNOUNCE_TIMEZONE`) rather than read from the
process, because it is part of what the line SAYS — it says "9 UHR", in German —
not a property of where the server happens to run. It used to be the process's
own zone, and a container runs on UTC unless somebody sets `TZ`, so the whale
announced the wrong hour with nothing looking broken. Setting `TZ` on the
deployment now changes only its logs; DST is handled, because a named zone
carries its own rules. It announces nothing while a zone is empty: the room does
not tick without a viewer in it, and the first tick after somebody arrives adopts
the hour rather than announcing it — arriving at 9:05 is not being present at
9:00.

**The quotes live in `assets/quotes/talking-objects.txt`** — one quote per line,
`#` for comments, blank lines to group them. That is the whole format: prose in
JSON would mean escaping every quotation mark that belongs to the sentence, and
there would be nowhere to leave a note for the next author. Every talking object
in every zone draws from this one pool. A line longer than 120 characters is
refused when the file is loaded, with a warning naming it, because that is where
the speech bubble truncates — half a sentence and an ellipsis is not a shorter
quote. Attribution, if you want it, is simply part of the line; there is no
author field and nothing checks one, so quoting a real person is on you. Each
piece rolls its own wait, so two whales in a zone drift apart instead of
chanting in unison, and the wait knows nothing about the hour: 20 to 60 minutes
is the whole rule, with no exception for what o'clock it runs out at. When a
quote and the hour land on the same tick both are said and both reach the chat,
and the bubble shows the later one. The file is read at startup: editing it takes
a restart, not a push.

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
| `talkingObject` | shouts the hour by itself (`9 UHR, 9 UHR !!!`), and a quote every 20–60 min — a bubble over the piece, and a chat line | — |

**Where one meeting room ends and the next begins.** Meeting tiles that touch
form one room only if they agree on `meetingRoomName` (and on `actionVideo`).
Four rooms side by side with a shared wall stay four rooms — the engine used to
flood-fill them into one call labelled with whichever name it met first. Two
abutting or overlapping rectangles carrying the *same* name still merge, which is
how you draw an L-shaped room. Unnamed meeting tiles have nothing to tell them
apart, so there adjacency alone still decides.

**Travel is content.** A portal is just furniture whose action is `portal` — a
door, a beam pad. Never hard-code a coordinate jump.

**A web page's shape is the viewer's, not the map's.** An `iframe` action carries
a URL and nothing about how it is framed: each viewer chooses in Settings between
a column pinned beside the world (the game shrinks to make room, so you can still
see where you are standing) and a window over it (far more room on a laptop).
Don't design a map around either one — the same page is a reference panel on a
wide monitor and a full window on a small screen, and only the person looking at
it knows which.

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
| `ActionKind` | *(empty)*, `meetingRoom`, `meetingManager`, `iframe`, `appliance`, `arcade`, `timeClock`, `portal`, `toggle`, `spawnPoint`, `talkingObject` |
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
