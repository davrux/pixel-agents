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
| Actions (`tileActions`, `PlacedFurniture.action`) | **Point objects**, not rectangles — one per acted-on tile/instance, custom properties for params (`kind`, `url`, `video`). Meeting-room area grouping stays flood-fill/adjacency-derived at import time, same as today. |
| Block tiles (`tileBlocked`) | dedicated parameterless tile layer ("Collision"), painted like any tile layer. |
| Approach-Sides (`PlacedFurniture.approachSides`) | one string property (`"N,E"`), not 4 bools — matches `Array<'N'\|'S'\|'E'\|'W'>` via join/split. Empty/absent = unrestricted. |
| On/Off pairing (`groupId`+`state`, `onTrigger`) | 2-3 custom properties on two tileset tiles. The "on" side's own animation (if any) is a native Tiled tile `<animation>`. |
| Rotation/orientation groups (`groupId`+`orientation`, `rotationScheme`) | **dropped entirely.** Affects 8/44 current types (`DESK`, `SOFA`, `PC`, `LAPTOP`, `WOODEN_CHAIR`, `CUSHIONED_CHAIR`, `SMALL_TABLE`, `KITCHEN_COUNTER`). Each orientation becomes its own independent catalog entry, placed manually, no rotate-in-place tool. Tiled's rotate handle geometrically rotates the graphic, which is wrong for perspective pixel art; a custom Tiled plugin was ruled out as disproportionate. `mirrorSide` (plain horizontal flip, e.g. wall monitors) is unrelated and stays — uses Tiled's native GID flip bit, no group linkage. |
| Furniture recoloring (`PlacedFurniture.color`) | **dropped entirely**, not even kept as metadata. Sprites render exactly as drawn. `colorize.ts`'s `adjustSprite` stays — turns out it's also used for character hue-shifting (`spriteData.ts`), not furniture-only as first assumed; only the furniture-specific call sites (LayoutEditor's placement/drag/select recolor) are removed. |
| Floor/wall recoloring (`tileColors`) | **closed palette, baked as real tileset variants** (was continuous HSBC). Floor: full **DB32** (32 colors). Wall: **Dawnbringer 16** (its own established palette, not a DB32 subset) — wall tiles already carry a ×16 multiplier from the 4-neighbor autotile bitmask, so DB32 there would be 2 sets × 16 × 32 = 1024 tiles vs. 512 at 16. Floor has no such multiplier (11 patterns × 32 = 352). Since we're not keeping two parallel color systems, the in-game LayoutEditor's floor/wall picker also becomes a swatch picker over the same closed palette (not just a Tiled-side snap) — see Phase 1. |
| `canPlaceOnWalls` / `canPlaceOnFloor` | **dropped entirely** — verified zero runtime consumers anywhere (wall-mounting is derived purely from the physical tile under the item, `officeState.ts computeApproachTiles`). Pure dead editor-time palette filters. |
| `canPlaceOnSurfaces` | Two consumers today turned out to be the same underlying fact used twice. (1) Action-click tiebreak among 2+ stacked actionable items — **dropped, folds into native Tiled object-list order** (see zOffset below). (2) Pet logic (`occupiedDeskSurfaceTiles`) — genuine, kept. **Renamed to `occupiesSurface`** to reflect its one remaining job. |
| `zOffset` / manual stacking override | subsumed by Tiled's native **object list order** within an object layer (drag to reorder in the Objects panel) — no numeric property needed. Overlapping-object *selectability while editing* was never really about zOffset; Tiled's own Objects panel + Alt-click cycling already solves that. |
| Walls (`TileType.WALL`, bitmask autotile) | **Wang Sets** (Tiled's native autotiling, formerly "Terrain") — exact match for our 4-neighbor-bitmask → 1-of-16-sprites system. Multiple wall styles = multiple Wang Sets in the tileset. No custom property, no import-time autotile recompute. |
| Image fit mode (`PlacedImage.fit`) | **dropped** — Tiled's Image Object already has free-form width/height (stretch = size=footprint; center = size=native, unchanged). The only reason we had the enum was decoupling a click-hitbox from visual size for our own hard-to-click canvas editor; Tiled has its own selection UI. |
| Void / grid growth (`TileType.VOID`) | **dropped** — an empty Tiled cell (GID 0) already means what VOID means; Tiled's native Map → Resize Map already does directional grow/shrink. |
| `isDesk` | no property needed, either side — already purely derived from `category==='desks'` today, stays derived from whichever tileset file a tile lives in. |
| Category | no property — **one Tiled tileset FILE per category** (mirrors today's 8 `FURNITURE_CATEGORIES`). Tiled shows each as its own tab. Category is now a pure browsing label, not a placement constraint (follows from dropping `canPlaceOnWalls`/`OnFloor`) — a dual-context item (e.g. usable on wall or floor) just gets filed wherever makes sense to browse; if its ART genuinely differs by context, that's two independent catalog entries, same pattern as dropped rotation. |

## Directory layout

Self-contained, everything commitable (replaces `assets/tiled/`'s prior contents, which were
from the rejected branch's rectangle/rotation-era approach and are gone):

```
assets/tiled/
├── Pixels.tiled-project        # custom property type defs
├── floor.tsx                   # → png/floor.png
├── wall-0.tsx / wall-1.tsx     # → png/wall-0.png / png/wall-1.png
├── furniture-desks.tsx         # → png/furniture/desks/*.png
├── furniture-chairs.tsx        # → png/furniture/chairs/*.png
├── furniture-storage.tsx
├── furniture-electronics.tsx
├── furniture-decor.tsx
├── furniture-wallmount.tsx     # named to avoid clashing with wall-0/1.tsx (the WALL AUTOTILE tilesets)
├── furniture-kitchen.tsx
├── furniture-misc.tsx
├── png/
│   ├── floor.png               # generated: 11 patterns × 32 DB32 colors
│   ├── wall-0.png / wall-1.png # generated: 16 bitmask pieces × 16 DB16 colors
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
