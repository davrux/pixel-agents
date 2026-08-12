# Tiled as the level/sprite editor — design + execution plan

Branch: `office/tiled-catalog`. Supersedes the earlier `office/tiled-schema` branch's
approach on several points (rectangle Action/Blocked areas, DB32-everywhere, full
orientation/rotation-group support) — those were reconsidered and rejected in the planning
discussion that produced this doc. That branch's `exportLayoutToTmj`/`importTmjToLayout`
scripts are evidence a Tiled bridge is feasible, not reusable as-is.

Goal: let the user edit levels in [Tiled](https://www.mapeditor.org/) and sprites in
Pixelorama-style tools, instead of (or alongside) the in-house LayoutEditor/FurnitureEditor.
Guiding principle throughout: replace our engine's ad-hoc "Sonderlocken" with Tiled-native
equivalents wherever a genuinely good fit exists, and only fall back to custom properties
where Tiled has no concept at all — not contorting our model to force a fit.

## Decisions

**Two different "source of truth" answers, for two different things:**

- **Map layout** (`OfficeLayout`, per-zone): stays the internal runtime schema. `.tmj` is a
  pure edit-time bridge (export to edit in Tiled, re-import after). Reason: `officeState.ts`
  (pathfinding/walkability/actions/sorting) and the renderer read typed flat arrays
  everywhere; making `.tmj` authoritative would mean rewriting that whole engine to read
  Tiled's untyped property bags, and we'd still need a typed intermediate layer at runtime
  anyway. Workflow discipline for concurrent edits (in-game editor vs. re-importing a stale
  `.tmj`) is informal — no version-check/lock, just don't edit the same zone in both places
  at once.
- **Furniture catalog** (`FurnitureCatalogEntry[]`, global — not per-zone): a Tiled tileset
  *becomes* the source of truth, replacing `assets/furniture/<TYPE>/manifest.json` entirely.
  This is tractable (unlike the map) because it's a small, static, boot-time-only catalog
  build (`buildFurnitureCatalog()`), not the live simulation engine. **No export/import step
  at all** — the `.tsx`/`.tsj` file on disk IS the data; edit it in Tiled, save, done. Only
  the dev server watching that file and reloading is new work (prod import comes later, not
  in this pass).

## Per-feature mapping

| Sonderlocke | Resolution |
|---|---|
| `type` (furniture identity — `PlacedFurniture`/`FurnitureCatalogEntry`/`FurnitureSync`) | **renamed to `id` everywhere**, internal and Tiled-facing alike. "Type" implied a taxonomy; this is an identity (the stable key every placed instance references), which is exactly what `category` is for — keeping both named `type` was actively misleading. Touches: the shared types, `getCatalogEntry`/`isMirroredLeft` and every call site, `FurnitureSync`'s wire schema field, the Tiled `id` custom property (was `type`) on every `furniture-*.tsj` tile and on `FurnitureObject`'s no-GID fallback. Old saved layouts (DB rows with a literal `type` JSON key) self-heal on load via `layoutSerializer.ts`'s `promoteLegacyTypeKey` — no DB migration needed. |
| Classifying a Ground-layer tile as floor vs. wall vs. void on import | **reads the `category` property explicitly** (`floor` / `walls`), not implicit property-presence sniffing (previously: "has a `bitmask` prop → wall") and not which file it came from — a mapper reorganizing tileset files can't silently break import. `FloorTile`/`WallTile` each get `category` baked as a fixed constant (`FLOOR_CATEGORY`/`WALL_CATEGORY` in `server/src/tiled/categories.ts`, the single source both the bake script and `mapBridge.ts` import) on every one of their tiles — trivially the same value throughout, since the Tiled *class* already fully determines it, but explicit beats implicit for the actual classification logic. |
| Category, the full picture | One flat mental model of **9** categories: **floor**, **walls** (each their own Tiled class — `FloorTile`/`WallTile` — with `category` fixed per the row above) plus the 7 furniture ones (`desks`, `chairs`, `storage`, `electronics`, `decor`, `kitchens`, `misc` — via `FurnitureTile.category`, enum `Category` in Pixels.tiled-project, shared with floor/walls in the same enum). |
| Actions (`tileActions`, `PlacedFurniture.action`) | **Point objects**, not rectangles — one per acted-on tile/instance, custom properties for params (`kind`, `url`, `video`, `pose`). Position IS the tile reference — col/row are always derived from the point's x/y on import, never stored as their own properties (Tiled doesn't keep custom properties in sync when an object is dragged, so a stored col/row would silently go stale the moment you move the point). Meeting-room area grouping stays flood-fill/adjacency-derived at import time, same as today. |
| Block tiles (`tileBlocked`) | dedicated parameterless tile layer ("Collision"), painted like any tile layer. |
| Walls vs. floor in one cell (`tileWallFloorPattern`/`Set`/`Color`) | walls get their **own tile layer** (`WallLayer`, normally named "Wall") above Ground, instead of sharing Ground with the floor. `tiles[i]` still holds either a floor pattern or `WALL` and a wall cell still blocks all 16px — the extra layer buys only one thing, and it's the thing thin walls need: the floor a wall stands on. Whatever FloorTile the mapper paints in Ground under a wall is imported into the parallel `tileWallFloorPattern`/`tileWallFloorSet`/`tileWallFloorColor` arrays and drawn beneath the wall sprite, so a 6px strip shows room floor around it instead of the flat `WALL_COLOR` fill a wall cell used to paint. Absent (`null`) keeps that old flat fill exactly, so wall sets whose art covers the whole tile — and every layout saved before this — render unchanged. WallTiles found in **Ground** are still imported as walls (pre-`WallLayer` maps, hand-made maps without one); they just get no floor beneath. |
| Approach-Sides (`PlacedFurniture.approachSides`) | one string property (`"N,E"`), not 4 bools — matches `Array<'N'\|'S'\|'E'\|'W'>` via join/split. Empty/absent = unrestricted. |
| On/Off pairing (`groupId`+`state`, `onTrigger`) | 2-3 custom properties on two tileset tiles. The "on" side's own animation (if any) is a native Tiled tile `<animation>`. |
| Rotation/orientation groups (`groupId`+`orientation`, `rotationScheme`) | **dropped entirely.** Affects 8/44 current types (`DESK`, `SOFA`, `PC`, `LAPTOP`, `WOODEN_CHAIR`, `CUSHIONED_CHAIR`, `SMALL_TABLE`, `KITCHEN_COUNTER`). Each orientation becomes its own independent catalog entry, placed manually, no rotate-in-place tool. Tiled's rotate handle geometrically rotates the graphic, which is wrong for perspective pixel art; a custom Tiled plugin was ruled out as disproportionate. Horizontal flip is a related but separate concern — see the `flippedHorizontally` row below. |
| Furniture recoloring (`PlacedFurniture.color`) | **dropped entirely**, not even kept as metadata. Sprites render exactly as drawn. `colorize.ts`'s `adjustSprite` stays — turns out it's also used for character hue-shifting (`spriteData.ts`), not furniture-only as first assumed; only the furniture-specific call sites (LayoutEditor's placement/drag/select recolor) are removed. |
| Floor/wall recoloring (`tileColors`) | **closed palette, baked as real tileset variants** (was continuous HSBC). Both floor and wall now share one **64-color palette, Kerrie Lake's "Resurrect 64"** (lospec.com/palette-list/resurrect-64) — originally floor used DB32 (32) and wall a separate DawnBringer16 (16), kept apart only so wall's ×16 autotile-bitmask multiplier wouldn't also multiply against a large color count; at 64 colors that's 2 sets × 16 masks × 64 colors = 2048 wall tiles, still a perfectly reasonable sheet size, so keeping two different palettes stopped being worth the inconsistency. `shared/src/office/palettes.ts`'s `PALETTE_64` is the single source; `FLOOR_PALETTE`/`WALL_PALETTE` both reference it. The in-game LayoutEditor's floor/wall picker is a swatch picker over the same closed palette (not just a Tiled-side snap) — see Phase 1. **The closed palette also retired the live game's runtime colorize step entirely** — the server no longer decodes/colorizes `assets/floors/floor_N.png`/`assets/walls/wall_N.png` or sends them over Colyseus (`floorTilesLoaded`/`wallTilesLoaded` are gone); the client fetches the same baked `png/floor.png`/`wall-{0,1}.png` sheets Tiled itself paints from, once, as plain static HTTP (`server` mounts `/assets/tiled/png`, `client/src/net/tiledSheets.ts` fetches + slices them into `shared/src/office/floorTiles.ts`/`wallTiles.ts`'s per-(pattern\|bitmask, swatch) lookup tables — see `paletteSwatchIndex` in `palettes.ts`). The in-game Floor Pattern Editor (`FloorEditor.ts`) was retired outright rather than ported — new floor/wall art or colors go exclusively through the Tiled/bake-script pipeline now, same as furniture. `colorize.ts`'s `colorizeSprite`/`getColorizedSprite` (Colorize/HSL-recenter mode) survive only as a build-time dependency of `bake-floor-wall-tiled.mts`; `adjustSprite` (the separate hue-shift mode) is unaffected and still runs live for characters/pets. |
| `canPlaceOnWalls` / `canPlaceOnFloor` | **dropped entirely** — verified zero runtime consumers anywhere (wall-mounting is derived purely from the physical tile under the item, `officeState.ts computeApproachTiles`). Pure dead editor-time palette filters. |
| `canPlaceOnSurfaces` | Two consumers today turned out to be the same underlying fact used twice. (1) Action-click tiebreak among 2+ stacked actionable items — **dropped, folds into native Tiled object-list order** (see zOffset below). (2) Pet logic (`occupiedDeskSurfaceTiles`) — genuine, kept. **Renamed to `occupiesSurface`** to reflect its one remaining job. |
| `zOffset` / manual stacking override | subsumed by Tiled's native **object list order** within an object layer (drag to reorder in the Objects panel) — no numeric property, ever (export sorts objects into the list by current zOffset; import re-derives zOffset purely from each object's index in that list). Overlapping-object *selectability while editing* was never really about zOffset; Tiled's own Objects panel + Alt-click cycling already solves that. |
| `PlacedFurniture.uid` | **never exported at all** — it's internal engine plumbing only (station claims, on/off toggle state, editor selection), not something a Tiled edit needs to preserve. Every import (furniture, text, images) generates a fresh one. |
| `FurnitureObject.id` | **Always written**, GID or not — identity is a flat property read, full stop, no registry lookup needed to know what's placed. (Earlier revision omitted it when a GID was present, reasoning Tiled already shows it inherited from the tile — technically true, but it made import's identity resolution depend on resolving the GID back through the tileset registry for no real benefit, since the GID's only actual job is picking the right sprite + flip state to *display*. Yes, Tiled now shows the same value twice for GID-backed objects; that's an acceptable, harmless redundancy for a meaningfully simpler import path.) |
| `flippedHorizontally` (was: `mirrorSide` catalog flag + a virtual `":left"` catalog id) | **Revised.** The old design gated flipping behind a catalog-level `mirrorSide` flag and represented a flipped instance as a wholly separate catalog id (`"SOFA_SIDE:left"`) with no tile of its own. Now it's a plain per-instance boolean, `PlacedFurniture.flippedHorizontally`, adopted directly from Tiled's own object-flip concept (named after Tiled's `FLIPPED_HORIZONTALLY_FLAG`) — no catalog gate, since Tiled itself has none (any object can be flipped there). `id` stays clean (`"SOFA_SIDE"`, never `":left"`). Export sets Tiled's native GID flip bit purely so the canvas shows a real mirrored sprite; import reads that same bit back into `flippedHorizontally` — a display concern only, entirely separate from `id`. Tiled's object model also supports vertical/diagonal flip and continuous rotation; neither is adopted, since our hand-drawn 2.5D perspective art would render broken under either (same reasoning as the dropped rotation groups above) — import silently ignores them. Old saved layouts with the `":left"` suffix self-heal via `layoutSerializer.ts`'s `promoteLegacyLeftSuffix`. |
| Walls (`TileType.WALL`, bitmask autotile) | **Wang Sets** (Tiled's native autotiling, formerly "Terrain") — exact match for our 4-neighbor-bitmask → 1-of-16-sprites system. Multiple wall styles = multiple Wang Sets in the tileset. No custom property, no import-time autotile recompute. |
| Image fit mode (`PlacedImage.fit`) | **dropped** — a placed image's Tiled object (a GID-backed tile object from `images.tsj`, see docs/design/tiled-custom-properties-reference.md's Image section — there's no separate "Image Object" concept in Tiled's own format) already has free-form width/height (stretch = size=footprint; center = size=native, unchanged). The only reason we had the enum was decoupling a click-hitbox from visual size for our own hard-to-click canvas editor; Tiled has its own selection UI. |
| Void / grid growth (`TileType.VOID`) | **dropped** — an empty Tiled cell (GID 0) already means what VOID means; Tiled's native Map → Resize Map already does directional grow/shrink. |
| `isDesk` | no property needed, either side — already purely derived from `category==='desks'` today, stays derived from whichever tileset file a tile lives in. |
| Category, furniture specifically | A `category` custom property on `FurnitureTile` (not which tileset file a tile lives in) — the original one-file-per-category plan was confusing for wall-*mounted* items specifically, since a mapper can place them anywhere in Tiled (no placement enforcement), so a dedicated `furniture-wallmount.tsj` implied a restriction that didn't exist; those tiles moved into `furniture-decor.tsj`, and the `wall` category value itself was dropped (folded into `decor`) once it read confusingly next to the structural "Wände" (see the Category-full-picture row above). Which tileset FILE a furniture tile lives in is not load-bearing at all now — `parseFurnitureTileset` reads `category` per-tile and `assetLoader.ts` globs every `furniture-*.tsj` regardless of name. |

## Directory layout

Self-contained, everything commitable (replaces `assets/tiled/`'s prior contents, which were
from the rejected branch's rectangle/rotation-era approach and are gone):

As actually built (`.tsj`/JSON, not `.tsx`/XML — no XML parser dependency; `category` is now
a per-tile property, not a file split, see the Category row above, so a furniture file's name
is just an arbitrary grouping, not semantically load-bearing):

```
assets/tiled/
├── Pixels.tiled-project        # custom property type defs
├── floor.tsj                   # → png/floor.png
├── wall-0.tsj / wall-1.tsj     # → png/wall-0.png / png/wall-1.png
├── furniture-desks.tsj         # → png/furniture/desks/*.png
├── furniture-chairs.tsj
├── furniture-electronics.tsj
├── furniture-decor.tsj         # includes `category: "wall"` (wall-mounted) items too
├── furniture-kitchens.tsj
├── furniture-misc.tsj
├── png/
│   ├── floor.png               # generated: 11 patterns × 64 Resurrect-64 colors
│   ├── wall-0.png / wall-1.png # generated: 16 bitmask pieces × 64 Resurrect-64 colors
│   └── furniture/<category>/*.png   # migrated once from assets/furniture/<TYPE>/*.png
└── zones/<zoneId>.tmj          # export/import working file per zone (OfficeLayout stays
                                 # authoritative in the DB either way)
```

Generated PNGs and `.tsx` files are committed (so `git clone` + open the Tiled project just
works, no mandatory build step first). `assets/furniture/<TYPE>/manifest.json` is retired
once the migration script has run and the new loader is verified — not dual-maintained.

## Execution phases

Each phase gated by `pnpm -r run check-types`, `pnpm --filter @pixel/client run build`,
`bash .claude/skills/mmo-readiness/check.sh`, committed separately.

1. **Shared model simplification** (no Tiled involvement yet — cleans up the engine per the
   decisions above, de-risks everything downstream by shipping on a simpler base first):
   - Remove rotation-group machinery from `furnitureCatalog.ts` (`rotationGroups` map,
     `getRotatedType`, `rotationScheme`/`orientation`-linking) while keeping plain
     `mirrorSide` flip support.
   - Remove `PlacedFurniture.color` and furniture recolor UI in `LayoutEditor` (placement
     ghost, drag preview, select-tool live recolor). `colorize.ts`'s `adjustSprite` stays —
     also used for character hue-shifting, not furniture-only.
   - Switch floor/wall `tileColors` from continuous `ColorValue{h,s,b,c}` to a closed
     palette (DB32 for floor, Dawnbringer16 for wall) — swatch picker replaces the HSBC
     sliders in `LayoutEditor` for floor/wall specifically.
   - Remove `canPlaceOnWalls`/`canPlaceOnFloor` (type, manifest field, editor checkboxes,
     asset pipeline).
   - Rename `canPlaceOnSurfaces` → `occupiesSurface`; drop its role in the furniture-action
     click tiebreak (`officeState.ts`), keep it for `occupiedDeskSurfaceTiles` (pet logic).
   - Existing manifests/saved layouts affected by these cuts: no converter, per this
     project's norm — old data just renders with the simplified behavior going forward.

2. **Furniture catalog → Tiled tileset**:
   - One-time migration script: read all `assets/furniture/<TYPE>/manifest.json` + PNGs,
     group by category, emit `assets/tiled/furniture-<category>.tsx` with the properties
     above, copy PNGs into `assets/tiled/png/furniture/<category>/`.
   - New `buildFurnitureCatalog()` path that reads these Tiled tileset files (prefer `.tsj`
     JSON over `.tsx` XML — no XML parser dependency) instead of `manifest.json` trees.
   - Dev-server file watcher: touching any `assets/tiled/furniture-*.tsx` (or `.tsj`)
     reloads the in-memory catalog immediately, matching "save in Tiled → live" from the
     planning discussion. Prod hot-reload/import path is explicitly out of scope for now.
   - Cut over once verified; delete the old manifest-reading code path and the 44
     `manifest.json` files.

3. **Floor/wall palette baking**:
   - Script generates `png/floor.png` (11 patterns × DB32) and `png/wall-0.png`/
     `png/wall-1.png` (16 bitmask pieces × Dawnbringer16), plus their `.tsx` (wall ones as
     Wang Sets).
   - Wire the same generated palette into the runtime (Phase 1 already switched
     `tileColors` to closed-palette; this phase produces the actual baked assets Tiled
     shows, sourced from the same palette definition).

4. **Map (zone) bridge**: `exportLayoutToTmj`/`importTmjToLayout` per the mapping table
   above (point objects, Wang Sets, native object order, GID-0 void) — write fresh, do not
   extend the old branch's scripts. Output/input path fixed at `assets/tiled/zones/<zoneId>.tmj`.

## Explicitly deferred / open

- Prod server picking up catalog/zone changes (dev-only file-watch for now).
- Exact migration script robustness (malformed manifests, edge cases in the 44 existing
  furniture folders) — handle as encountered, this is a one-time script, not permanent
  infrastructure.
- Whether `zones/*.tmj` snapshots get committed as history or treated as pure scratch —
  leaning toward committing (diffable, doubles as a way to hand off a level without DB
  access) but not firmly decided.

## Custom property reference

Every custom property currently round-tripped through Tiled, by class (see
`assets/tiled/Pixels.tiled-project` for the exact JSON — this table is the human-readable
version of the same thing). "Enum" means Tiled shows a dropdown (or checkbox list, for
`ApproachSide`); the property is still stored as a plain string underneath.

**`FloorTile`** (tile, `floor.tsj`)

| Property | Type | Values | Notes |
|---|---|---|---|
| `pattern` | int | 1–11 | which of the 11 floor art patterns |
| `hue` | int | 0–359 | paired with `sat`, identifies a `PALETTE_64` swatch |
| `sat` | int | 0–100 | see `hue` |
| `category` | enum `Category` | always `floor` | fixed per tile by the bake script — see the Category rows above |

**`WallTile`** (tile, `wall-0.tsj`/`wall-1.tsj`)

| Property | Type | Values | Notes |
|---|---|---|---|
| `bitmask` | int | 0–15 | 4-neighbor autotile mask (N=1,E=2,S=4,W=8) — which of the 16 pieces |
| `hue` / `sat` | int | same as `FloorTile` | same `PALETTE_64` |
| `category` | enum `Category` | always `walls` | fixed per tile by the bake script |

**`FurnitureTile`** (tile, `furniture-*.tsj`)

| Property | Type | Values | Notes |
|---|---|---|---|
| `id` | string | stable identifier, e.g. `SOFA_SIDE` | was called `type` — an identity, not a taxonomy (that's `category`'s job). The key saved layouts reference — renaming this breaks every layout that placed it (old DB rows self-heal via `promoteLegacyTypeKey`, see the mapping table above) |
| `label` | string | free text | curated display name, not mechanically derivable from `id` (e.g. `PC_FRONT_ON_1` → "PC", `MONITOR` → "Conference Monitor") |
| `category` | enum `Category` | `desks`, `chairs`, `storage`, `electronics`, `decor`, `kitchens`, `misc` (the furniture subset — `floor`/`walls` are the other two, see `FloorTile`/`WallTile` above) | pure browsing label — which file a tile lives in no longer matters |
| `backgroundTiles` | int | 0+ | rows from the top of the footprint that are walkable-through ("background") rather than solid |
| `occupiesSurface` | bool | | sits on top of a desk/surface — affects z-sort and pet placement |
| `orientation` | enum `Orientation` | `front`, `back`, `side` | which facing this art shows; also namespaces an on/off state-pair key alongside `stateGroup` |
| `stateGroup` | string | free text, shared between two tiles | pairs an on/off variant together |
| `state` | enum `FurnitureState` | `on`, `off` | needs a matching `stateGroup` pair |
| `onTrigger` | enum `OnTrigger` | `autoFacing`, `click` | what flips an on/off pair — `autoFacing` = an agent sits facing it, `click` = the `toggle` Action |
| `appliance` | enum `ApplianceKind` | `coffee` | interaction station kind |

**`FurnitureObject`** (object, "Furniture" layer)

| Property | Type | Values | Notes |
|---|---|---|---|
| `id` | string | stable identifier | **always present**, GID or not (see the mapping table above) |
| `name` | string | free text | this *instance's* name (e.g. a conference room's stable name) — not the catalog label |
| `approachSides` | enum `ApproachSide` (flags) | any combination of `N`, `S`, `E`, `W` | which side(s) a player may approach from; empty = automatic |
| `actionKind` | enum `ActionKind` | `meetingRoom`, `meetingManager`, `iframe`, `appliance`, `arcade`, `toggle`, or empty | per-instance Action override |
| `actionVideo` | bool | | only meaningful when `actionKind = meetingRoom` |
| `actionUrl` | string | `https://` URL | only meaningful when `actionKind = iframe` |
| `actionPose` | enum `ApplianceKind` | `coffee` | only meaningful when `actionKind = appliance` |
| *(not a property)* `flippedHorizontally` | — | — | in Tiled, use the object's native **Flip Horizontally** action — no custom property involved. Export/import translate this to/from Tiled's own GID flip bit directly (see the `flippedHorizontally` mapping-table row above). |

**`ActionArea`** (object, "Actions" layer)

Same four `action*` properties as `FurnitureObject` above. Placed as either a Point (one
tile) or a Rectangle (every tile it covers) — no `col`/`row`/size property either way, the
shape's own x/y/width/height on the map IS the tile reference, always re-derived on import
(never stored, since Tiled doesn't keep custom properties in sync when you drag or resize an
object). Export collapses a solid rectangular block of same-action tiles into one Rectangle;
an irregular shape still exports as one Point per tile. Overlapping shapes resolve by object-
list order, later wins — see docs/design/tiled-custom-properties-reference.md's ActionArea
section for the full explanation.

**Never round-tripped at all**: `uid` (every import generates a fresh one — pure internal
engine identity, see the mapping table above), `zOffset` (derived from the object's position
in the Objects panel list).
