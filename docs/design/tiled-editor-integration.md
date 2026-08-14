# Tiled as the level/sprite editor — design record

What this is: the reasoning behind moving level and catalog authoring into
[Tiled](https://www.mapeditor.org/), kept because the *why* is still load-bearing
— the decisions below are what the code does today. The migration itself is
done; where a decision was later revised, the row says so rather than being
quietly rewritten, because "we tried X and it broke like this" is the part worth
keeping.

For "what do I type into which field", see
`docs/design/tiled-custom-properties-reference.md` — that is the maintained
reference, and this document deliberately no longer repeats it.

Branch: `office/tiled-catalog`. Supersedes the earlier `office/tiled-schema`
branch's approach on several points (rectangle Action/Blocked areas,
DB32-everywhere, full orientation/rotation-group support) — those were
reconsidered and rejected in the planning discussion that produced this doc.

Guiding principle throughout: replace our engine's ad-hoc "Sonderlocken" with
Tiled-native equivalents wherever a genuinely good fit exists, and only fall back
to custom properties where Tiled has no concept at all — not contorting our model
to force a fit. Authoring now happens in Tiled **only**: the in-game
LayoutEditor, FurnitureEditor and FloorEditor have all been removed.

## Decisions

**Two different "source of truth" answers, for two different things:**

- **Map layout** (`OfficeLayout`, per-zone): stays the internal runtime schema. The `.tmj`
  is the authored source and is read **one way only** — there is no exporter any more
  (`OfficeLayout` → `.tmj` existed to re-open an in-game edit in Tiled; with the in-game
  editors gone, a second writer of `.tmj` could only overwrite the mapper's own file).
  So the `.tmj` is where a zone is authored, `OfficeLayout` is what the engine runs, and
  nothing travels back. Reason for keeping the runtime schema at all: `officeState.ts`
  (pathfinding/walkability/actions/sorting) and the renderer read typed flat arrays
  everywhere; making `.tmj` authoritative would mean rewriting that whole engine to read
  Tiled's untyped property bags, and we'd still need a typed intermediate layer at runtime
  anyway. There is no longer a second place to edit a zone from — the in-game
  editors are gone — so the old "don't edit the same zone in two places" caveat
  is moot. A `.tmj` reaches a server by being pushed to it
  (`server/scripts/push-zones.mts` → `POST /tiled/zone`), which imports it and
  makes it that zone's active layout.
- **Furniture catalog** (`FurnitureCatalogEntry[]`, global — not per-zone): a Tiled tileset
  *becomes* the source of truth, replacing `assets/furniture/<TYPE>/manifest.json` entirely.
  This is tractable (unlike the map) because it's a small, static, boot-time-only catalog
  build, not the live simulation engine. **No export/import step at all** — the
  `.tsj` file on disk IS the data; edit it in Tiled, save, done. The dev server
  watches those files and rebuilds the catalog on save.

## Per-feature mapping

| Sonderlocke | Resolution |
|---|---|
| `type` (furniture identity — `PlacedFurniture`/`FurnitureCatalogEntry`/`FurnitureSync`) | **renamed to `id` everywhere**, internal and Tiled-facing alike. "Type" implied a taxonomy; this is an identity (the stable key every placed instance references), which is exactly what `category` is for — keeping both named `type` was actively misleading. Touches: the shared types, `getCatalogEntry`/`isMirroredLeft` and every call site, `FurnitureSync`'s wire schema field, the Tiled `id` custom property (was `type`) on every `furniture-*.tsj` tile and on `FurnitureObject`'s no-GID fallback. Old saved layouts (DB rows with a literal `type` JSON key) self-heal on load via `layoutSerializer.ts`'s `promoteLegacyTypeKey` — no DB migration needed. |
| Classifying a Ground-layer tile as floor vs. wall vs. void on import | **the tile's Tiled class** (`FloorTile`/`WallTile`), plus which layer class it was painted on. Not property sniffing, and not the tileset's filename — a mapper reorganising files can't silently break import. *Revised:* this briefly went through a `category` property baked onto every floor/wall tile, on "explicit beats implicit" grounds; the class already determines it completely, so the property was pure duplication and went when categories did. |
| Categories | **Gone entirely.** There was a flat model of nine (floor, walls, and seven furniture ones), and furniture behaviour was derived from it: chairs were sittable because their category said `chairs`. That meant a correctly drawn, correctly categorised chair could still be unsittable because some *other* property was missing, with nothing in Tiled to point at. Each capability is now its own property on the tile, always present, with its default filled in — see the reference doc and `server/src/tiled/furnitureProps.ts`. |
| Actions (`tileActions`, `PlacedFurniture.action`) | **Point objects**, not rectangles — one per acted-on tile/instance, custom properties for params (`kind`, `url`, `video`, `pose`). Position IS the tile reference — col/row are always derived from the point's x/y on import, never stored as their own properties (Tiled doesn't keep custom properties in sync when an object is dragged, so a stored col/row would silently go stale the moment you move the point). Meeting-room area grouping stays flood-fill/adjacency-derived at import time, same as today. |
| Block tiles (`tileBlocked`) | dedicated parameterless tile layer ("Collision"), painted like any tile layer. |
| Walls (`OfficeLayout.walls`) | **edges between cells**, not cells of their own. A wall cell used to block all 16px and hide a floor tile for 6px of art; as an edge it blocks only the step between its two cells and both stay walkable floor. Stored as the two boundary grids (vertical (cols+1)×rows, horizontal cols×(rows+1)). Rendering needs no new art: the four edges meeting at a lattice point form exactly the N/E/S/W mask the baked pieces were cut for, so a wall network draws as those same pieces on the lattice — half a tile up and left of the cell grid. Collision splits into `isWalkable` ("can you stand here", unchanged) and `canStep` ("can you cross A→B", the new one every neighbour expansion goes through). Authored on a single `WallLatticeLayer` with offsetx/offsety = -8, so painting in Tiled draws on the boundaries and the Wang brush keeps working. |
| Approach-Sides (`PlacedFurniture.approachSides`) | one string property (`"N,E"`), not 4 bools — matches `Array<'N'\|'S'\|'E'\|'W'>` via join/split. Empty/absent = unrestricted. |
| On/Off pairing | The "off" tile names its partner: `onState` = the on tile's `id`. The on side's animation (if any) is a native Tiled tile `<animation>`. *Revised:* was a shared `stateGroup` string plus `state: on\|off` plus an `onTrigger` enum — three properties that had to agree, paired by convention. What flips it now follows from the Action instead of a fourth setting: a `toggle` Action means a click, no action means it lights up for whoever sits facing it. |
| Rotation/orientation groups (`groupId`+`orientation`, `rotationScheme`) | **dropped entirely.** Affects 8/44 current types (`DESK`, `SOFA`, `PC`, `LAPTOP`, `WOODEN_CHAIR`, `CUSHIONED_CHAIR`, `SMALL_TABLE`, `KITCHEN_COUNTER`). Each orientation becomes its own independent catalog entry, placed manually, no rotate-in-place tool. Tiled's rotate handle geometrically rotates the graphic, which is wrong for perspective pixel art; a custom Tiled plugin was ruled out as disproportionate. Horizontal flip is a related but separate concern — see the `flippedHorizontally` row below. |
| Furniture recoloring (`PlacedFurniture.color`) | **dropped entirely**, not even kept as metadata. Sprites render exactly as drawn. `colorize.ts`'s `adjustSprite` stays — turns out it's also used for character hue-shifting (`spriteData.ts`), not furniture-only as first assumed; only the furniture-specific call sites (LayoutEditor's placement/drag/select recolor) are removed. |
| Floor/wall recoloring (`tileColors`) | **closed palette, baked as real tileset variants** (was continuous HSBC). Both floor and wall now share one **64-color palette, Kerrie Lake's "Resurrect 64"** (lospec.com/palette-list/resurrect-64) — originally floor used DB32 (32) and wall a separate DawnBringer16 (16), kept apart only so wall's ×16 autotile-bitmask multiplier wouldn't also multiply against a large color count; at 64 colors that's 2 sets × 16 masks × 64 colors = 2048 wall tiles, still a perfectly reasonable sheet size, so keeping two different palettes stopped being worth the inconsistency. `shared/src/office/palettes.ts`'s `PALETTE_64` is the single source; `FLOOR_PALETTE`/`WALL_PALETTE` both reference it. The in-game LayoutEditor's floor/wall picker is a swatch picker over the same closed palette (not just a Tiled-side snap) — see Phase 1. **The closed palette also retired the live game's runtime colorize step entirely** — the server no longer decodes/colorizes `assets/floors/floor_N.png`/`assets/walls/wall_N.png` or sends them over Colyseus (`floorTilesLoaded`/`wallTilesLoaded` are gone); the client fetches the same baked `png/floor.png`/`wall-{0,1}.png` sheets Tiled itself paints from, once, as plain static HTTP (`server` mounts `/assets/tiled/png`, `client/src/net/tiledSheets.ts` fetches + slices them into `shared/src/office/floorTiles.ts`/`wallTiles.ts`'s per-(pattern\|bitmask, swatch) lookup tables — see `paletteSwatchIndex` in `palettes.ts`). The in-game Floor Pattern Editor (`FloorEditor.ts`) was retired outright rather than ported — new floor/wall art or colors go exclusively through the Tiled/bake-script pipeline now, same as furniture. `colorize.ts`'s `colorizeSprite`/`getColorizedSprite` (Colorize/HSL-recenter mode) survive only as a build-time dependency of `bake-floor-wall-tiled.mts`; `adjustSprite` (the separate hue-shift mode) is unaffected and still runs live for characters/pets. |
| `canPlaceOnWalls` / `canPlaceOnFloor` | **dropped entirely** — verified zero runtime consumers anywhere (wall-mounting is derived purely from the physical tile under the item, `officeState.ts computeApproachTiles`). Pure dead editor-time palette filters. |
| `canPlaceOnSurfaces` | **Gone.** Its click-tiebreak job folded into native Tiled object-list order (see zOffset below); its pet job was renamed `occupiesSurface` and then dropped too, once a pet's perch became an explicit `petCanSitOn` and "is something already standing here" replaced enumerating the kinds of thing that could be in the way. |
| `zOffset` / manual stacking override | subsumed by Tiled's native **object list order** within an object layer (drag to reorder in the Objects panel) — no numeric property, ever (import derives zOffset purely from each object's index in that list). Overlapping-object *selectability while editing* was never really about zOffset; Tiled's own Objects panel + Alt-click cycling already solves that. |
| `PlacedFurniture.uid` | **never stored in the map** — it's internal engine plumbing only (station claims, on/off toggle state), not something a map needs to carry. Every import (furniture, text, images) generates a fresh one. |
| `FurnitureObject.id` | **Not written for a GID-backed placement** — its identity is the tile whose sprite it draws. *Revised twice:* first omitted, then written always ("identity should be a flat property read, no registry lookup"), now omitted again. The flat read was genuinely simpler, but it made identity a hand-editable field that OVERRODE the GID, so retyping it swapped the item while Tiled went on drawing the old sprite. The rectangle placeholder for an item with no tile at all keeps its `id`, because there nothing else says what it is. `name` went the same way: Tiled objects have a native Name field, and a custom property beside it meant two places to type and only one that worked. |
| `flippedHorizontally` (was: `mirrorSide` catalog flag + a virtual `":left"` catalog id) | **Revised.** The old design gated flipping behind a catalog-level `mirrorSide` flag and represented a flipped instance as a wholly separate catalog id (`"SOFA_SIDE:left"`) with no tile of its own. Now it's a plain per-instance boolean, `PlacedFurniture.flippedHorizontally`, adopted directly from Tiled's own object-flip concept (named after Tiled's `FLIPPED_HORIZONTALLY_FLAG`) — no catalog gate, since Tiled itself has none (any object can be flipped there). `id` stays clean (`"SOFA_SIDE"`, never `":left"`). Import reads Tiled's native GID flip bit into `flippedHorizontally` — a display concern only, entirely separate from `id`. Tiled's object model also supports vertical/diagonal flip and continuous rotation; neither is adopted, since our hand-drawn 2.5D perspective art would render broken under either (same reasoning as the dropped rotation groups above) — import silently ignores them. Old saved layouts with the `":left"` suffix self-heal via `layoutSerializer.ts`'s `promoteLegacyLeftSuffix`. |
| Wall autotiling | **Wang Sets** (Tiled's native autotiling) over the 16 bitmask pieces, so painting a wall picks the piece. No custom property, no import-time autotile recompute. Note this pairs with the edge model above, not with the old `TileType.WALL` cells: the same 16 pieces, painted on the lattice. |
| Image fit mode (`PlacedImage.fit`) | **dropped** — a placed image's Tiled object (a GID-backed tile object from `images.tsj`, see docs/design/tiled-custom-properties-reference.md's Image section — there's no separate "Image Object" concept in Tiled's own format) already has free-form width/height (stretch = size=footprint; center = size=native, unchanged). The only reason we had the enum was decoupling a click-hitbox from visual size for our own hard-to-click canvas editor; Tiled has its own selection UI. |
| Void / grid growth (`TileType.VOID`) | **dropped** — an empty Tiled cell (GID 0) already means what VOID means; Tiled's native Map → Resize Map already does directional grow/shrink. |
| `isDesk` | **Gone.** It was derived from `category === 'desks'` and did two jobs: a z-sort lift for items standing on a surface, and marking where a pet may rest. The first is handled by object-list order (zOffset), the second is now `petCanSitOn` on the tile. |
| Which tileset file a tile lives in | **Not load-bearing at all**, including its name: a furniture tileset is one whose tiles carry the `FurnitureTile` class (`isFurnitureTileset`), so a pack can be called anything. *Revised:* the `furniture-` prefix decided this in four places, which made a naming convention do a job the class already did — the same duplication a `category` property on floor/wall tiles was removed for. A one-file-per-category plan was considered and dropped separately: a dedicated `furniture-wallmount.tsj` implied a placement restriction that does not exist. Floor and wall filenames ARE load-bearing, for an unrelated reason — a layout stores an index into FLOOR_SET_FILES / WALL_SET_FILES. |

## Directory layout

Everything derived is committed, so `git clone` + open the Tiled project just
works with no mandatory build step. The tileset names carry their palette
(`-resurrect64` / `-endesga`) or their source pack (`-metro`); see
`shared/src/office/tiledSheetLayout.ts`, whose `FLOOR_SET_FILES` /
`WALL_SET_FILES` arrays are append-only, because a saved layout stores the index.

```
assets/tiled/
├── Pixels.tiled-project              # custom property/class definitions
├── floor-resurrect64.tsj             # 11 patterns × 64 swatches + Natural
├── floor-endesga.tsj
├── floor-metro-resurrect64.tsj       # 7 patterns derived from the MetroCity pack
├── floor-metro-endesga.tsj
├── wall-metro-resurrect64.tsj        # 16 bitmask pieces + 4 north-wall faces
├── wall-metro-endesga.tsj
├── collision.tsj                     # one parameterless "blocked" marker tile
├── images.tsj                        # placed background images
├── furniture-{chairs,decor,desks,electronics,kitchens,misc}.tsj
├── furniture-metro-{home,hospital,vehicles}.tsj   # generated, then hand-maintained
├── png/                              # every sheet above, baked
└── zones/<zoneId>.tmj                # per-zone working file (gitignored; the DB
                                      # stays authoritative either way)
```

Scripts that produce these live in `server/scripts/`: `bake-floor-wall-tiled.mts`
(floor/wall sheets), `gen-metro-source-art.mts` (wall/floor art from the pack),
`gen-metro-furniture.mts` (one-time furniture slice; refuses to re-run over
hand-edited tilesets), `bake-images-tiled.mts`, `bake-generated-furniture.mts`
(code-drawn fixtures so the bridge has a sprite to draw), and
`sync-furniture-properties.mts` (keeps every tile carrying every property).

## Still open

- The **furniture catalog** still only reloads on a dev-server file watch; only
  zones can be pushed. A tileset change therefore still needs a deploy.
- `zones/*.tmj` are gitignored, i.e. treated as scratch — which is exactly why
  they have to be pushed: no deploy carries them. Committing them would make
  levels diffable and hand-offable without DB access; the argument against is
  that the DB is authoritative and two copies drift. Undecided, and worth noting
  the cost of the status quo: a zone file lost or corrupted has no history.
- A push is rejected wholesale if its zone id is malformed, but a map authored
  against different tilesets than the server has is accepted with a warning and
  a count of placements that did not resolve. Refusing outright would be the
  stricter choice; it would also block a mapper whose one new tile has not been
  deployed yet.
- A furniture item can still be uploaded as a DB override through the server's
  `saveAsset` path, left from the removed in-game editor. Nothing sends one
  anymore.

## Custom property reference

Moved out. `docs/design/tiled-custom-properties-reference.md` is the maintained
one; this document used to carry a second copy, which drifted from it — the
floor/wall tables here still listed `pattern`/`hue`/`sat` properties long after
those became position-derived, and the furniture table still listed properties
that had been deleted.
