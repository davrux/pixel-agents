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
- A class with **no members** (FloorTile, WallTile, GroundLayer, WallLatticeLayer, WallFaceLayer, CollisionLayer) is a
  pure marker — assigning it doesn't add any fields, it just tags the tile/layer so
  our import code recognizes it. Don't add properties to these by hand; see
  "Position-derived data" below for why.

## Classes

### FloorTile *(useAs: tile)*

No members. Every tile in `floor-resurrect64.tsj` / `floor-metro-resurrect64.tsj` /
`floor-endesga.tsj` / `floor-metro-endesga.tsj` gets this class.

**Position-derived data**: which floor *pattern* a tile is, and which palette
*swatch* (or "Natural") colors it, come purely from the tile's row/column position
in the sheet — never from a property. This is safe because these files are 100%
machine-generated (`server/scripts/bake-floor-wall-tiled.mts`); nothing ever
hand-edits their tile list. **Don't add `pattern`/`hue`/`sat`-style properties here**
— re-bake instead if you need a new pattern (see the design doc's directory layout).

### WallTile *(useAs: tile)*

No members. Every tile in `wall-metro-resurrect64.tsj` / `wall-metro-endesga.tsj`
gets this class. Same position-derived logic as FloorTile — piece (row) and swatch
(column) come from position, not properties.

Both are the **thin** wall style: a 6px strip, not art covering a whole tile. Paint
them on the **WallLatticeLayer** (see below), where they sit on the cell boundaries
and cost no walkable cell. The last four pieces in each set are the north-wall
**face** pieces — stackable wall surface, one cell tall each, which nothing derives
from adjacency, so they only appear where you paint them.

### FurnitureTile *(useAs: tile)*

Every tile in `furniture-*.tsj`. This is the **catalog definition** — one entry per
furniture *type* (not per placed instance; see FurnitureObject for that).

The `furniture-metro-*.tsj` files (home / hospital / vehicles, all `METRO_`-prefixed
ids) are machine-generated from the MetroCity pack by
`server/scripts/gen-metro-furniture.mts` — don't hand-edit them, re-run that instead.
Everything else about them is ordinary: same class, same properties, same catalog.

**Every tile carries every property below**, defaults included — not just the ones
that differ. `server/scripts/sync-furniture-properties.mts` is what keeps that
true; run it whenever the set changes (see AGENTS.md). So "Required?" here means
what the value has to *say*, not whether the property is present: a property is
never absent, and nothing has to be added by hand.

| Property | Type | Required? | Notes |
|---|---|---|---|
| `id` | string | **required** | Stable catalog identifier. Skipped with a console warning if missing. |
| `label` | string | optional | Display name. Falls back to `id` if blank. |
| `canSitOn` | bool | optional | May a character sit here? Every footprint tile below the `backgroundTiles` rows becomes a seat, so a 2-tile couch seats two. |
| `sitFacing` | string, enum `SitFacing` | optional | Which way a sitting character looks: `N`/`E`/`S`/`W`. Blank = `N`. Describes the *unflipped* art — a flipped placement mirrors it (see "Special case: sitFacing"). |
| `petCanSitOn` | bool | optional | May a pet perch on top? It also has to fit: a pet takes the first footprint column with no other item standing on it. |
| `canWalkOver` | bool | optional | Is this a floor decal you walk **over** — a rug, a doormat, a painted marking? It blocks nothing and renders just above the floor, below every character and every other item. Both halves come together on purpose: exempting it from collision alone would still draw a two-row rug over the feet of whoever stands on its upper row, because ordinary furniture sorts by its sprite's bottom edge. |
| `backgroundTiles` | int | optional | How many rows from the *top* of the footprint stay walkable *and* placeable-over by another item (e.g. a wall-mounted painting's row overlapping where a desk could also go; a portal pad's whole tile being walkable so a player can stand right on it). |
| `onState` | string | optional | Catalog `id` this tile turns *into* when switched on — set on the "off" half only. See "Special case: state pairs". |
| `actionKind` | string, enum `ActionKind` | optional | This *type's* default Action — every placed instance gets this unless it carries its own override (see FurnitureObject below). Same enum, same "Special case: Actions" semantics as FurnitureObject's. There are no other per-kind flags anymore (no `conference`/`arcade`/`meetingRoom`/`appliance`/`portal` booleans, no hardcoded id special-cases) — this is the *only* way a catalog type gets a default action. |
| `actionVideo` | bool | only with `actionKind: meetingRoom` | Camera offered or audio/chat-only. |
| `actionUrl` | string | only with `actionKind: iframe` | Must be `https://`. |
| `actionPose` | string, enum `ApplianceKind` | only with `actionKind: appliance` | E.g. `coffee` — this is how the bundled coffee machine (`COFFEE_MACHINE` in `furniture-kitchens.tsj`) is wired up. |

There is deliberately **no category, and no taxonomy of any kind**. Behaviour used
to be inferred from one: chairs were sittable because their category said
`chairs`, desks hosted pets because theirs said `desks`. That made a correctly
drawn, correctly categorised chair unsittable if any of several other properties
were missing, with nothing in Tiled to point at. Each capability is now its own
visible property.

Animation (a lamp flicker, a spinning fan) is **not** a custom property — use Tiled's
native tile `<animation>` (right-click a tile → "Tile Animation Editor"), pointing at
sibling tiles in the *same* tileset. Point an off-tile's `onState` at the animation's
anchor frame; the later frames are read but never become independent catalog entries.

### FurnitureObject *(useAs: object)*

One per **placed instance**, in a map's Furniture object layer. References a
FurnitureTile via GID for its sprite; everything below is an *instance-level*
override.

| Property | Type | Required? | Notes |
|---|---|---|---|
| `id` | string | required unless the object has a `gid` (see below) | Which FurnitureTile catalog entry this is. Only consulted when the object has **no** `gid`: for a GID-backed placement the tile *is* the identity, and a leftover `id` property is ignored with a warning on import — retyping it used to swap the item while Tiled kept drawing the old sprite (see the design doc's `FurnitureObject.id` row). |
| `name` | string | optional | E.g. a conference monitor's stable room name. |
| `approachSides` | string, enum `ApproachSide` (flags) | optional | See "Special case: approachSides" below. Empty = unrestricted. |
| `approachThrough` | bool | optional | Marks THIS item as a blocker players may search past when some other item's approach-tile search reaches it — e.g. a kitchen counter with an appliance mounted behind it. Still blocks ordinary movement/placement; only changes what counts as a dead end for *other* items' approach search. Default `false`. |
| `actionKind` | string, enum `ActionKind` | optional | See "Special case: Actions" below. |
| `actionVideo` | bool | only with `actionKind: meetingRoom` | Camera offered or audio/chat-only. |
| `actionUrl` | string | only with `actionKind: iframe` | Must be `https://`. |
| `actionPose` | string, enum `ApplianceKind` | only with `actionKind: appliance` | E.g. `coffee`. |
| `canSitOn` | bool | optional | Overrides the tile's own value for this placement only — makes one coffee machine sittable, or one chair not. |
| `sitFacing` | string, enum `SitFacing` | optional | Overrides the tile's value. Taken **literally**: unlike the inherited default it is not mirrored by a flip, since you already know which way you flipped this one. |
| `petCanSitOn` | bool | optional | Overrides the tile's value. |
| `canWalkOver` | bool | optional | Overrides the tile's value — e.g. one rug of a kind that is normally furniture, or a mat you *do* want to block. |
| `backgroundTiles` | int | optional | Overrides the tile's value — the only way to make a furniture tile walkable in one spot, since the Collision layer can only ever *add* blocking. |

Unlike a FurnitureTile, a placed object carries **only the overrides it actually
makes** — absence means "whatever this type says", and that distinction is the
whole point: writing `canSitOn: false` onto every placement of a sittable chair
just to be thorough would turn every chair in the map unsittable on the next
import.

You still *see* every field, because Tiled offers a class's members to any object
assigned that class, file contents notwithstanding. That is why the class matters:
**a placement dragged or pasted straight from the Tilesets panel has no class at
all**, so Tiled shows it nothing to set. Either pick `FurnitureObject` in its
Class field, or run

```bash
cd server && node --import tsx scripts/sync-furniture-properties.mts
```

which stamps the class onto every class-less furniture placement in
`assets/tiled/zones/*.tmj` (decided by the tile each gid points at, never by the
layer). Import itself doesn't care — it accepts a `FurnitureObject` *or* any
object whose tile is a `FurnitureTile` — so this is purely about what Tiled lets
you edit.

A furniture item with no Tiled tileset representation (portals, conference monitor,
arcade cabinet, meeting-room kiosk, wall logos — all server-generated in code) still
is placed as a `FurnitureObject`, just without a `gid` — a plain rectangle in Tiled's
canvas instead of a real sprite. Imports fine either way. **These types have no
default action on their catalog entry** — unlike a real `FurnitureTile` (which can
set one, see above), there's no tile to bake it onto, so every placed `DOOR`/
`BEAM_PAD`/`ARCADE`/`MONITOR`/`MEETING_KIOSK` instance must set its own `actionKind`
explicitly or it simply does nothing when clicked/walked onto.

`flippedHorizontally`/`flippedVertically` aren't custom properties — they're Tiled's
own native object flip (right-click the object, or flip before placing from the
Tilesets panel), and only take effect on a `gid`-backed object (a plain rectangle
with no sprite has nothing to mirror). No catalog-level gate on either direction —
whether a vertical flip looks right for a given hand-drawn piece is the mapper's own
call in Tiled, not something this engine restricts.

**Placing furniture by dragging a sprite straight from the Tilesets panel** (rather
than copy-pasting an existing `FurnitureObject`) creates a `gid`-backed object with
*no* class and *no* properties at all — Tiled doesn't inherit a tile's own class onto
an object placed from it. Import still recognizes these: any object whose `gid`
resolves to a `FurnitureTile` counts as furniture even without `type:
'FurnitureObject'`, and its `id` falls back to whatever's baked onto that tile. Set
the object's own `id`/`name`/`approachSides`/action fields by hand afterward if you
need an instance-level override — otherwise it just uses the type's defaults, same
as any other placed instance.

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
| `meetingRoomName` | string | Only with `meetingRoom`: what the room is called. Shown on both call windows — the small ambient popup and the expanded meeting window — so walking straight from one area into the next is recognisable; without it both just say "Meeting area". Whitespace-collapsed, trimmed and capped at 32 characters (UTF-8 intact, and a cap landing inside a surrogate pair drops the half-character rather than emitting it). Named for the action kind that owns it, like its `action*` neighbours: "room" alone is ambiguous here (LiveKit, Colyseus and Matrix all have rooms), and a Tiled object's own `name` field is already taken by furniture instance names. |

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

A placed background image. **There is no such thing as a standalone image
object in Tiled** — its own JSON format only gives an object a `gid` (tile
reference) or `text`, nothing else image-related (checked against Tiled's
own format reference). So this is, structurally, exactly a `FurnitureObject`
under a different name: a real GID-backed tile object, placed via **Insert
Tile (T)** from `images.tsj` (see below), not a custom shape.

| Property | Type | Required? | Notes |
|---|---|---|---|
| `imageId` | string | required unless the object has a `gid` (see below) | The stable id this image is stored/looked-up under in the live game. Always present on the tile itself (baked by bake-images-tiled.mts), so a plain Insert Tile placement with no properties of its own still resolves correctly — see FurnitureObject's identical `id` fallback above. |

Tiled's native horizontal/vertical flip (right-click the object, or the
Tileset panel's flip buttons before placing) is supported and is read on import —
unlike furniture's hand-drawn 2.5D art, an arbitrary uploaded image has no
fixed camera angle, so both directions are safe (see
`PlacedImage.flippedHorizontally`/`flippedVertically`).

**`images.tsj`** *(ImageTile, useAs: tile)* is a generated "collection of
images" tileset — one tile per image uploaded via the in-game Assets editor,
each its own independently-sized PNG (no shared grid). Regenerate it with
`node --import tsx scripts/bake-images-tiled.mts` (from `server/`) whenever
the image library changes — not automatic, run it by hand. **To place a new
image**: run that script (if the image you want isn't in the tileset yet),
then Insert Tile (T), pick it from the Tilesets panel, and place/scale it
like any other tile object. If `imageId` can't be resolved (neither the
object's own property nor the tile's), the object is silently skipped on
import — no error, it just won't show up.

You don't have to go through the bake script at all, though: **Tiled's own
Tileset editor** (open `images.tsj`, "Edit Tileset", then "Add Tiles") lets
you add a tile pointing at *any* PNG on disk directly — import reads that
tile's own `image` path first, falling back to the
`png/images/<imageId>.png` convention only for a bare (non-tile) Image
object. Give the new tile an `imageId` property (on the tile, or on the
object placed from it) so it has a stable id in the live game; the tile's
`image` path is otherwise read exactly as Tiled wrote it, no re-baking
needed.

A copy-pasted object keeps carrying whatever `type`/properties it was copied
from even after you change its content — e.g. duplicating an `Image` object
and turning it into a text label leaves a stale `type: 'Image'` +`imageId`
behind, which used to double-import as both a (broken) image and a text
label. Import now treats a native Tiled Text object (anything with its own
`text` field) as authoritative over any such leftover `type`, so this no
longer happens — but it's worth clearing the stale properties by hand too,
since Tiled's own UI still shows them.

### GroundLayer *(useAs: layer)*

No members. Assign to whichever tile layer holds floor GIDs — normally named
"Ground", but the **name doesn't matter**, only this class does. There must be
exactly one per map.

Paint floor **everywhere a room reaches**, walls included: walls are edges on the
boundaries now (see WallLatticeLayer), so every cell is walkable floor and none of
them is hidden by a wall.

### WallLatticeLayer *(useAs: layer)*

No members. Assign to the tile layer holding wall GIDs — normally named "Walls",
with **`offsetx` and `offsety` both −8**. That half-tile offset is the whole
idea: the same wall tiles, drawn on the cell *boundaries* instead of in the
cells, so a wall no longer costs a walkable cell.

One tile per **lattice point** (a corner shared by four cells), not per cell. A
wall piece's own N/E/S/W bitmask states which of the four edges meeting at that
point are wall, so painting a piece paints those edges — which means the Wang /
Terrain brush works exactly as it always did, you're just drawing on the
boundaries. Two neighbouring points that disagree about the edge they share both
get their way (the edges are unioned), so you can't paint a half-open wall by
accident.

Lattice point (c,r) is the top-left corner of cell (c,r), so the layer is
map-sized and the map's far right/bottom boundary points have no tile to paint.
Keep the usual VOID margin and this never comes up; a wall on the very last
row/column has to move one cell inward.

The **north-wall face** pieces (the last four in each metro wall set) do NOT go
here — they belong on WallFaceLayer below. A face fills a whole tile, and this
layer is offset half a tile, so a face painted here lands 8px off the floor grid.

### WallFaceLayer *(useAs: layer)*

No members. Assign to the tile layer holding north-wall **face** pieces — normally
named "WallFaces", with **no offset**. Cell-aligned, unlike WallLatticeLayer: a
face is the flat wall surface a room is looked *at*, filling whole tiles, so it
sits on the floor grid.

Stack the pieces to whatever height the wall should be (cornice on top, baseboard
at the bottom, fill between; the 1-tall variant carries both). A correctly built
faced wall is two things:

1. face pieces here, in the rows above the wall's base, and
2. a horizontal edge run on WallLatticeLayer along that base — the barrier.

**Don't paint Collision over the faces** — a face cell is non-walkable
automatically, the same way a furniture footprint is. A face depicts solid wall,
so there is no case where you'd want to stand in one.

### CollisionLayer *(useAs: layer)*

No members. Assign to whichever tile layer holds the collision marker
(`collision.tsj`'s single "blocked" tile) — normally named "Collision", again the
class is what matters, not the name. Exactly one per map.

## Enums

| Enum | Values | Flags? | Used by |
|---|---|---|---|
| `SitFacing` | *(empty)*, `N, E, S, W` | no | `FurnitureTile`/`FurnitureObject`'s `sitFacing` |
| `ApproachSide` | `N, S, E, W` | **yes** | `FurnitureObject.approachSides` |
| `ActionKind` | *(empty)*, `meetingRoom, meetingManager, iframe, appliance, arcade, portal, toggle, spawnPoint` | no | `FurnitureTile`/`FurnitureObject`/`ActionArea`'s `actionKind` |
| `ApplianceKind` | *(empty)*, `coffee` | no | `actionPose` |

`ApproachSide` is the one **flags** enum — Tiled shows it as checkboxes (pick any
combination of N/S/E/W), not a single dropdown, and stores the result as one
comma-joined string (`"N,E"`) — matching `PlacedFurniture.approachSides` exactly.

## Special cases

### sitFacing — and what a flip does to it

`sitFacing` says which way a character sitting here looks, as a compass letter.
Blank means `N`, which suits the common case (a seat at a desk against a wall) and
is wrong visibly rather than subtly when it doesn't.

It also decides the **z-order**: a seat whose sitFacing is `N` renders *in front
of* the character (you are looking away, so its backrest occludes you); any other
direction renders behind them.

A tile's value describes the **unflipped** art, so a flipped placement mirrors it:
flip an `E`-facing chair horizontally and its seat faces `W`, or a character would
sit looking into the chair's back. An override set on the *placement* is taken
literally instead — you already know which way you flipped that one.

This replaced an `orientation` property (`front`/`back`/`side`) that meant
different things on different items: on a chair it picked a facing (only if the
category was `chairs`, otherwise silently nothing) and drove the z-order; on
everything else it was decoration, except that it also namespaced state-pair keys.
Three jobs, one string, no way to say "face west".

### State pairs — the off tile names the on tile

An on/off toggle (a monitor, a lamp) is **two separate FurnitureTile entries**, not
one tile with a boolean. Set `onState` on the "off" tile to the **`id` of the "on"
tile**. That is the whole wiring; the on tile itself needs nothing.

What flips it follows from the Action, so there is no separate setting:

| The tile has | Behaviour |
|---|---|
| `actionKind: toggle` | a light switch — walk up, click, it flips, and nothing else flips it |
| `onState` and no toggle action | lights up on its own while an active agent sits facing it |

If `onState` names an id that doesn't exist, the tile simply never toggles — no
error. (This replaced a scheme where both tiles shared a `stateGroup` string and
each declared `state: on`/`off`, plus an `onTrigger` enum read from whichever half
the catalog builder happened to visit first. Naming the partner outright says the
same thing without three properties having to agree.)

### Actions — actionKind decides which other property matters

`actionKind` is a discriminated union, same idea as a TypeScript union type: which
of `actionVideo` / `actionUrl` / `actionPose` actually gets read depends entirely on
its value. The others are ignored (they still show up as empty/false/blank, because Tiled offers
a class's whole member list, so you can *see* they exist even when irrelevant here):

| `actionKind` | Reads | Ignores |
|---|---|---|
| *(empty)* | — | everything (no action) |
| `meetingRoom` | `actionVideo` | `actionUrl`, `actionPose` |
| `meetingManager` | — | all three |
| `iframe` | `actionUrl` (must be `https://`) | `actionVideo`, `actionPose` |
| `appliance` | `actionPose` | `actionVideo`, `actionUrl` |
| `arcade` | — | all three |
| `portal` | — | all three (walking onto the item's footprint offers a destination picker) |
| `toggle` | — | all three (flips the *tile's own* on/off pair — see above) |
| `spawnPoint` | — | all three; TILE-only, consumed once at import to set the zone's arrival point (see zoneImport.ts) — does nothing at runtime, not a real trigger like the others |

### approachSides — empty means unrestricted, not "no sides"

An empty `approachSides` (no flags checked) means "every physically open side
works" (the default, automatic behavior) — **not** "this item can't be approached
from anywhere". Only check specific flags when you want to force a restriction
narrower than what open space alone would already allow.

## Known quirks (not yet cleaned up)

- **A plain rectangle FurnitureObject inherits nothing.** Server-generated
  furniture (portals, the arcade cabinet, …) exports as a bare rectangle rather
  than a tile object when no GID backs it, and Tiled only shows inherited tile
  properties for *tile* objects — so on those placements the behaviour properties
  aren't offered at all. Harmless in practice (those ids get their behaviour from
  code, not from a tile), but it's the one place the "you always see the full set"
  promise doesn't hold.
