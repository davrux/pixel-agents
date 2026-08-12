# Tiled Custom Types & Properties — reference

Practical reference for anyone editing `assets/tiled/*.tsj` / `assets/tiled/zones/*.tmj`
directly in Tiled: which custom **class** (Tiled's term for what used to be called
"type") applies where, which properties each one has, and the special cases that
aren't obvious from the property list alone. For the *design rationale* behind these
choices, see `docs/design/tiled-editor-integration.md` — this doc is the "what do I
actually click/type" companion to that one.

All classes and enums below live in `assets/tiled/Pixels.tiled-project` (View →
Custom Types Editor in Tiled — not the Properties panel, see below).

## How Tiled shows this

- **Properties panel** (bottom-right when you select a tile/object/layer): shows a
  `Class` dropdown plus whatever properties that class defines, each with a normal
  or dropdown/checkbox widget depending on its type.
- **Custom Types Editor** (View menu): where the *definitions* below actually live —
  this is a separate view from the Properties panel. If a tile/object looks like it
  has no properties, check it's got the right `Class` assigned first.
- A class with **no members** (FloorTile, WallTile, GroundLayer, CollisionLayer) is a
  pure marker — assigning it doesn't add any fields, it just tags the tile/layer so
  our import code recognizes it. Don't add properties to these by hand; see
  "Position-derived data" below for why.

## Classes

### FloorTile *(useAs: tile)*

No members. Every tile in `floor.tsj` / `floor-warm.tsj` gets this class.

**Position-derived data**: which floor *pattern* a tile is, and which palette
*swatch* (or "Natural") colors it, come purely from the tile's row/column position
in the sheet — never from a property. This is safe because these files are 100%
machine-generated (`server/scripts/bake-floor-wall-tiled.mts`); nothing ever
hand-edits their tile list. **Don't add `pattern`/`hue`/`sat`-style properties here**
— re-bake instead if you need a new pattern (see the design doc's directory layout).

### WallTile *(useAs: tile)*

No members. Every tile in `wall-0.tsj` / `wall-1.tsj` / `wall-0-warm.tsj` /
`wall-1-warm.tsj` gets this class. Same position-derived logic as FloorTile — bitmask
(row) and swatch (column) come from position, not properties.

### FurnitureTile *(useAs: tile)*

Every tile in `furniture-*.tsj`. This is the **catalog definition** — one entry per
furniture *type* (not per placed instance; see FurnitureObject for that).

| Property | Type | Required? | Notes |
|---|---|---|---|
| `id` | string | **required** | Stable catalog identifier. Skipped with a console warning if missing. |
| `label` | string | optional | Display name in the in-game editor palette. Falls back to `id` if blank. |
| `category` | string, enum `Category` | optional (defaults `misc`) | Browsing bucket — see the Category enum below. **Only `desks/chairs/storage/electronics/decor/kitchens/misc` are valid here** — see "Known quirk" at the bottom. |
| `backgroundTiles` | int | optional | How many rows from the *top* of the footprint stay walkable *and* placeable-over by another item (e.g. a wall-mounted painting's row overlapping where a desk could also go; a portal pad's whole tile being walkable so a player can stand right on it). |
| `occupiesSurface` | bool | optional | Item sits on top of a desk surface (monitor, mug) — affects z-sort and pet placement logic. |
| `orientation` | string, enum `Orientation` | optional | See "Special case: orientation" below — behavior depends entirely on category. |
| `stateGroup` | string | only for on/off pairs | See "Special case: state pairs" below. |
| `state` | string, enum `FurnitureState` | only for on/off pairs | `on` or `off` — needs a matching `stateGroup`. |
| `onTrigger` | string, enum `OnTrigger` | optional, only meaningful with a state pair | `autoFacing` (default) or `click` — see state pairs below. |

Animation (a lamp flicker, a spinning fan) is **not** a custom property — use Tiled's
native tile `<animation>` (right-click a tile → "Tile Animation Editor"), pointing at
sibling tiles in the *same* tileset. The anchor tile's own `state`/`stateGroup`
becomes the "on" side; the animation's later frames are read but never become
independent catalog entries.

### FurnitureObject *(useAs: object)*

One per **placed instance**, in a map's Furniture object layer. References a
FurnitureTile via GID for its sprite; everything below is an *instance-level*
override.

| Property | Type | Required? | Notes |
|---|---|---|---|
| `id` | string | **required** | Which FurnitureTile catalog entry this is — always written explicitly, even though a GID-backed object already implies it (deliberate redundancy, see the design doc). |
| `name` | string | optional | E.g. a conference monitor's stable room name. |
| `approachSides` | string, enum `ApproachSide` (flags) | optional | See "Special case: approachSides" below. Empty = unrestricted. |
| `actionKind` | string, enum `ActionKind` | optional | See "Special case: Actions" below. |
| `actionVideo` | bool | only with `actionKind: meetingRoom` | Camera offered or audio/chat-only. |
| `actionUrl` | string | only with `actionKind: iframe` | Must be `https://`. |
| `actionPose` | string, enum `ApplianceKind` | only with `actionKind: appliance` | E.g. `coffee`. |

A furniture item with no Tiled tileset representation (portals, conference monitor,
arcade cabinet, meeting-room kiosk, wall logos — all server-generated in code) still
exports as a `FurnitureObject`, just without a `gid` — a plain rectangle in Tiled's
canvas instead of a real sprite. Round-trips fine either way.

### ActionArea *(useAs: object, Point or Rectangle)*

A tile-triggered action with no furniture backing it — e.g. a portal tile, a
walk-in meeting area. Placed as either a Tiled **Point** (one tile) or a
**Rectangle** (every tile it covers, rounded to whole tiles) — pick whichever
is convenient; a single tile and a 10×10 meeting room use the same class. Its
position/size *is* the data — col/row (or the covered range) are never stored
as separate properties (Tiled doesn't keep custom properties in sync when you
drag or resize a shape, so a stored col/row would silently go stale).

| Property | Type | Notes |
|---|---|---|
| `actionKind` | string, enum `ActionKind` | Same enum, same semantics as FurnitureObject's. |
| `actionVideo` | bool | Only with `meetingRoom`. |
| `actionUrl` | string | Only with `iframe`. |
| `actionPose` | string, enum `ApplianceKind` | Only with `appliance`. |

**Overlaps**: if a Rectangle and a Point (or two Rectangles) cover the same
tile with different settings, whichever is **later in Tiled's own object
list** wins — same last-write-wins precedent as furniture stacking order
(see FurnitureObject above). Reorder in Tiled's Objects panel to change which
one applies.

**Export**: a maximal, fully-solid rectangular block of tiles sharing the
exact same action (same `actionKind` *and* its kind-specific field, e.g. two
`meetingRoom` tiles only merge if `video` also matches) exports as one
Rectangle. An irregular shape (not a solid rectangle) exports as one Point
per tile instead — always correct, just less tidy to look at than a clean
area would be.

### Image *(useAs: object)*

A placed background image (Tiled's native Image object — created via "Insert
Image", not a custom shape).

| Property | Type | Required? | Notes |
|---|---|---|---|
| `imageId` | string | **required** | The stable id this image is stored/looked-up under in the live game. Nothing auto-fills this — pick a name yourself. |

**How to add a new one**: drop the PNG at `assets/tiled/zones/images/<imageId>.png`
(relative to the zone's own `.tmj` — Tiled computes this automatically when you use
"Insert Image" and pick a file from that folder), then set the `imageId` property to
match the filename (no extension). If `imageId` is missing or the file isn't found,
the object is silently skipped on import — no error, it just won't show up.

### GroundLayer *(useAs: layer)*

No members. Assign to whichever tile layer holds floor/wall GIDs — normally named
"Ground", but the **name doesn't matter**, only this class does. There must be
exactly one per map.

### CollisionLayer *(useAs: layer)*

No members. Assign to whichever tile layer holds the collision marker
(`collision.tsj`'s single "blocked" tile) — normally named "Collision", again the
class is what matters, not the name. Exactly one per map.

## Enums

| Enum | Values | Flags? | Used by |
|---|---|---|---|
| `Category` | `floor, walls, desks, chairs, storage, electronics, decor, kitchens, misc` | no | `FurnitureTile.category` |
| `Orientation` | *(empty)*, `front, back, side` | no | `FurnitureTile.orientation` |
| `FurnitureState` | *(empty)*, `on, off` | no | `FurnitureTile.state` |
| `OnTrigger` | *(empty)*, `autoFacing, click` | no | `FurnitureTile.onTrigger` |
| `ApproachSide` | `N, S, E, W` | **yes** | `FurnitureObject.approachSides` |
| `ActionKind` | *(empty)*, `meetingRoom, linkManager, iframe, appliance, arcade, toggle` | no | `FurnitureObject`/`ActionArea`'s `actionKind` |
| `ApplianceKind` | *(empty)*, `coffee` | no | `actionPose` |

`ApproachSide` is the one **flags** enum — Tiled shows it as checkboxes (pick any
combination of N/S/E/W), not a single dropdown, and stores the result as one
comma-joined string (`"N,E"`) — matching `PlacedFurniture.approachSides` exactly.

## Special cases

### Orientation — behavior depends on category

`orientation` (`front`/`back`/`side`) means **two different things** depending on
what it's attached to, and for most items it does nothing at runtime at all:

- **Chairs** (`category: chairs`): actively used. `back` chairs render *in front of*
  the seated character (their backrest occludes); every other value renders behind.
  It also picks the character's seated facing direction, with priority over "face
  the adjacent desk".
- **Everything else** (PC, laptop, …): purely descriptive/cosmetic *unless* it's
  disambiguating two state pairs sharing one `stateGroup` name (see below) — in the
  current bundled data this never actually comes up, since e.g. the PC's front
  on/off pair already uses the unique `stateGroup` value `"PC_front"` rather than a
  bare `"PC"` shared with a side/back variant. If you ever *do* reuse one
  `stateGroup` name across orientations, `orientation` is what keeps their on/off
  pairs from colliding.

### State pairs — needs exactly two tiles, matching stateGroup

An on/off toggle (a monitor, a lamp) is **two separate FurnitureTile entries**, not
one tile with a boolean:

1. Give both tiles the **same** `stateGroup` value (any string you choose, e.g.
   `"MY_LAMP"`).
2. Set `state: off` on one, `state: on` on the other.
3. Optionally set `onTrigger` on either (only needs setting once — it's read from
   whichever side happens to be visited first when the catalog builds, and applied
   to both):
   - **`autoFacing`** (default if omitted): flips on when an active agent is seated
     facing it — no action needed.
   - **`click`**: flips *only* via an explicit click — but this requires the
     **placed instance** (FurnitureObject) to *also* carry `actionKind: toggle`.
     Setting `onTrigger: click` on the tile alone does nothing by itself; the two
     properties work together.

If only one side of a pair exists (no matching `state: on`/`state: off` sibling with
the same `stateGroup`), the whole mechanism silently no-ops — no error, the tile
just never toggles.

### Actions — actionKind decides which other property matters

`actionKind` is a discriminated union, same idea as a TypeScript union type: which
of `actionVideo` / `actionUrl` / `actionPose` actually gets read depends entirely on
its value. The others are ignored (and always exported as empty/false/blank so
you can *see* they exist, even when irrelevant for the current kind):

| `actionKind` | Reads | Ignores |
|---|---|---|
| *(empty)* | — | everything (no action) |
| `meetingRoom` | `actionVideo` | `actionUrl`, `actionPose` |
| `linkManager` | — | all three |
| `iframe` | `actionUrl` (must be `https://`) | `actionVideo`, `actionPose` |
| `appliance` | `actionPose` | `actionVideo`, `actionUrl` |
| `arcade` | — | all three |
| `toggle` | — | all three (flips the *tile's own* on/off pair — see above) |

### approachSides — empty means unrestricted, not "no sides"

An empty `approachSides` (no flags checked) means "every physically open side
works" (the default, automatic behavior) — **not** "this item can't be approached
from anywhere". Only check specific flags when you want to force a restriction
narrower than what open space alone would already allow.

## Known quirks (not yet cleaned up)

- **`Category`'s `floor`/`walls` values don't apply to `FurnitureTile`.** They exist
  for historical reasons (see the design doc) but nothing ever sets them anymore —
  FloorTile/WallTile lost their own `category` property when they became memberless
  marker classes. If you pick `floor` or `walls` for a *furniture* tile's category
  by mistake, the import code catches it (falls back to `misc` with a console
  warning) — but Tiled's own dropdown won't stop you from picking a nonsensical
  value in the first place. Splitting `Category` into a furniture-only enum would
  close this gap; hasn't been done.
