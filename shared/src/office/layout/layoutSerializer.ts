import type {
  FurnitureInstance,
  InteractionPoint,
  OfficeLayout,
  PlacedDecal,
  PlacedFurniture,
  TileType as TileTypeVal,
  GroundMap,
} from '../types.js';
import { DECAL_DEPTH, DEFAULT_COLS, DEFAULT_ROWS, Direction, TILE_SIZE, TileType, WALK_OVER_DEPTH } from '../types.js';
import { localIdFromPatternAndSwatch } from '../floorTiles.js';
import { getCatalogEntry, resolveBackgroundTiles, resolveCanSitOn, resolveCanWalkOver, resolveSitFacing,
  entryFor,
} from './furnitureCatalog.js';
import { emptyWallEdges, hIndex, vIndex } from '../wallEdges.js';

/** Convert flat tile array from layout into 2D grid */
/**
 * Bring a stored layout up to version 2 — ground cells holding a sheet's local
 * tile id instead of a floor pattern plus a separate colour.
 *
 * A v1 cell said "pattern P, swatch S" where P was the sheet ROW (1-based) and S
 * the column with null meaning column 0, so the id is just that arithmetic put
 * back together: `(P - 1) * columns + (S == null ? 0 : S + 1)`. The column count
 * is per SET, which is why the caller passes a lookup rather than a constant — a
 * palette bake has 65, a natural-only set 1.
 *
 * A set the caller cannot resolve is REPORTED, not guessed at: the cell becomes
 * VOID so it is visibly missing rather than confidently wrong, and `unresolved`
 * names the sets it happened for. Callers must not persist a result with anything
 * unresolved — that is not a converted map, it is a lost one, and it has already
 * happened here: an early boot without a resolver turned all 3192 cells of a real
 * map into holes and wrote them back. Idempotent — a v2 layout is returned as is.
 */
export function migrateLayout(
  layout: OfficeLayout,
  columnsOf: (setName: string) => number | undefined,
  /** v2 → v3: where an image placement's file is, by its id. The caller looks on disk
   *  (this module stays free of the file system); a placement whose art cannot be found
   *  is dropped, because a picture nobody can fetch is a hole either way. */
  imageSrcFor: (imageId: string) => string | undefined = () => undefined,
): { layout: OfficeLayout; unresolved: string[] } {
  if (layout.version === 3) return { layout, unresolved: [] };
  if (layout.version === 2) return migrateImagesToSrc(layout, imageSrcFor);
  const unresolved = new Set<string>();
  const tiles: number[] = [];
  for (let i = 0; i < layout.tiles.length; i++) {
    const pattern = layout.tiles[i];
    // 255 was VOID in v1; it is an ordinary tile id now, which is exactly why the
    // sentinel moved (see TileType.VOID).
    if (pattern === 255 || pattern <= 0) {
      tiles.push(TileType.VOID);
      continue;
    }
    const setName = layout.floorSets?.[layout.tileFloorSet?.[i] ?? 0];
    const columns = setName === undefined ? undefined : columnsOf(setName);
    if (columns === undefined || columns <= 0) {
      unresolved.add(setName ?? '(no set named)');
      tiles.push(TileType.VOID);
      continue;
    }
    tiles.push(localIdFromPatternAndSwatch(pattern, layout.tileColors?.[i], columns));
  }
  const migrated: OfficeLayout = { ...layout, version: 2, tiles };
  delete migrated.tileColors;
  // Straight on to v3, so a v1 map does not need two passes.
  const v3 = migrateImagesToSrc(migrated, imageSrcFor);
  return { layout: v3.layout, unresolved: [...unresolved, ...v3.unresolved] };
}

/**
 * v2 → v3: an image placement carries the path to its file instead of only an id.
 *
 * Images used to live in the database as base64 and travel to every client on join; the
 * file in `assets/tiled` is the source now (the same rule the tilesets follow), so the
 * placement has to say which file. A placement whose file cannot be resolved is dropped
 * and reported — drawing nothing is what it did before, and keeping it would only carry
 * the hole forward.
 */
function migrateImagesToSrc(
  layout: OfficeLayout,
  imageSrcFor: (imageId: string) => string | undefined,
): { layout: OfficeLayout; unresolved: string[] } {
  const unresolved: string[] = [];
  const images = (layout.images ?? []).flatMap((im) => {
    if (im.src) return [im];
    const src = imageSrcFor(im.imageId);
    if (!src) {
      unresolved.push(`image ${im.imageId}`);
      return [];
    }
    return [{ ...im, src }];
  });
  const migrated: OfficeLayout = { ...layout, version: 3 };
  if (layout.images) migrated.images = images;
  return { layout: migrated, unresolved };
}

export function layoutToTileMap(layout: OfficeLayout): GroundMap {
  const map: GroundMap = [];
  for (let r = 0; r < layout.rows; r++) {
    const row: number[] = [];
    for (let c = 0; c < layout.cols; c++) {
      row.push(layout.tiles[r * layout.cols + c]);
    }
    map.push(row);
  }
  return map;
}

/**
 * Convert placed furniture into renderable FurnitureInstance[].
 *
 * Depth is positional — a thing further down the map draws in front — with one
 * exception: among items whose footprints OVERLAP, the one later in Tiled's
 * object list wins, lifted just far enough to sort above what it covers. That is
 * what puts a bowl standing on a table in front of the table, whose sprite is
 * taller and would otherwise win on position alone.
 *
 * `zOffset` used to be added with a ×100_000 multiplier, which made the object
 * list order beat position GLOBALLY: the last object in the list drew in front
 * of everything, anywhere on the map. Overlap-scoped is what was actually
 * wanted, and it needs no per-catalog "this can stand on things" flag, which is
 * how the same problem was solved before.
 */
export function layoutToFurnitureInstances(furniture: PlacedFurniture[]): FurnitureInstance[] {
  const instances: FurnitureInstance[] = [];
  // Stacking order: Tiled's object list (zOffset), array order as the tiebreak.
  const stackOrder = furniture
    .map((f, i) => ({ f, i }))
    .sort((a, b) => (a.f.zOffset ?? 0) - (b.f.zOffset ?? 0) || a.i - b.i)
    .map(({ f }) => f);
  // Highest zY assigned so far per tile, so a later item can clear it. Only the
  // rows an item really occupies count (background rows are air — a painting
  // hung over a desk's top row is not standing on the desk).
  const topByTile = new Map<string, number>();
  for (const item of stackOrder) {
    const entry = entryFor(item);
    if (!entry) continue;
    const x = item.col * TILE_SIZE;
    const y = item.row * TILE_SIZE;
    const spriteH = entry.height;
    let zY = y + spriteH;

    // Seat z-sorting: a character sitting here has to end up on the right side
    // of the seat's own graphic.
    if (resolveCanSitOn(item, entry)) {
      if (resolveSitFacing(item, entry) === Direction.UP) {
        // Sitting with their back to us, so the seat's back occludes them:
        // sort the seat AFTER the character. The bottom footprint row (not the
        // sprite height) so this still holds when background rows have pushed
        // the seats themselves further down.
        zY = (item.row + entry.footprintH) * TILE_SIZE + 1;
      } else {
        // Any other direction: the character is in front of the seat, so cap
        // zY at the first row's bottom and let them sort after it.
        zY = (item.row + 1) * TILE_SIZE;
      }
    }

    // A walk-over decal (rug, doormat) leaves the stacking question alone
    // entirely: it lies UNDER everything by definition, so it neither gets
    // lifted by what it covers nor counts as the thing an item on that tile is
    // standing on. Taking part would let a rug push a chair's zY up by half a
    // step for no reason.
    if (resolveCanWalkOver(item, entry)) {
      zY = WALK_OVER_DEPTH;
    } else {
      // Clear anything already standing on the tiles this item occupies.
      const bgRows = resolveBackgroundTiles(item, entry);
      const tiles: string[] = [];
      for (let dr = bgRows; dr < entry.footprintH; dr++) {
        for (let dc = 0; dc < entry.footprintW; dc++) tiles.push(`${item.col + dc},${item.row + dr}`);
      }
      for (const t of tiles) {
        const below = topByTile.get(t);
        if (below !== undefined && below >= zY) zY = below + 0.5;
      }
      for (const t of tiles) topByTile.set(t, Math.max(topByTile.get(t) ?? 0, zY));
    }

    instances.push({
      // Pixels only when the catalog has them (the server's own copy does; the
      // client's does not — it draws by id from a fetched image).
      ...(entry.sprite ? { sprite: entry.sprite } : {}),
      spriteId: item.id,
      width: entry.width,
      height: entry.height,
      x,
      y,
      zY,
      ...(item.flippedHorizontally ? { mirrored: true } : {}),
      ...(item.flippedVertically ? { flippedVertically: true } : {}),
      ...(item.opacity !== undefined && item.opacity < 1 ? { opacity: item.opacity } : {}),
    });
  }
  return instances;
}

/**
 * Convert painted decals into renderable FurnitureInstance[] — see PlacedDecal.
 *
 * Same output shape as furniture on purpose: a decal is a sprite at a position
 * with a depth, which is exactly what a FurnitureInstance is, so the renderer
 * needs no second concept and no second code path. What differs is only where
 * the depth comes from — and that was decided by the layer the cell was painted
 * on, before this ever runs (see PlacedDecal.occludes):
 *
 *   - flat (the default): DECAL_DEPTH, a fixed band just above the floor, so a
 *     character walks over it wherever they stand. Ties resolve by draw order,
 *     which is paint order — that is how two DecalLayers stack.
 *   - `occludes`: the bottom edge of the sprite, exactly like furniture, so a
 *     character north of it is drawn behind it.
 *
 * None of furniture's stacking machinery applies. There is no overlap lifting
 * (`topByTile`) because a decal is never "standing on" anything, and no seat
 * special case because nobody sits on a decal. A decal whose id is not in the
 * catalog — a tileset removed since the map was saved — is skipped silently,
 * the same way a placed image with a deleted asset is.
 */
export function layoutToDecalInstances(decals: PlacedDecal[] | undefined): FurnitureInstance[] {
  const instances: FurnitureInstance[] = [];
  for (const decal of decals ?? []) {
    const entry = getCatalogEntry(decal.id);
    if (!entry) continue;
    const y = decal.row * TILE_SIZE;
    instances.push({
      ...(entry.sprite ? { sprite: entry.sprite } : {}),
      spriteId: decal.id,
      width: entry.width,
      height: entry.height,
      x: decal.col * TILE_SIZE,
      y,
      zY: decal.occludes ? y + entry.height : DECAL_DEPTH,
      ...(decal.flippedHorizontally ? { mirrored: true } : {}),
      ...(decal.flippedVertically ? { flippedVertically: true } : {}),
      ...(decal.flippedDiagonally ? { flippedDiagonally: true } : {}),
    });
  }
  return instances;
}

/** Get all tiles blocked by furniture footprints, optionally excluding a set of tiles.
 *  Skips top backgroundTiles rows so characters can walk through them, and
 *  `canWalkOver` items entirely — a rug is scenery, not an obstacle. */
export function getBlockedTiles(
  furniture: PlacedFurniture[],
  excludeTiles?: Set<string>,
): Set<string> {
  const tiles = new Set<string>();
  for (const item of furniture) {
    const entry = entryFor(item);
    if (!entry) continue;
    if (resolveCanWalkOver(item, entry)) continue; // walk-over decal — never an obstacle
    const bgRows = resolveBackgroundTiles(item, entry);
    for (let dr = 0; dr < entry.footprintH; dr++) {
      if (dr < bgRows) continue; // skip background rows — characters can walk through
      for (let dc = 0; dc < entry.footprintW; dc++) {
        const key = `${item.col + dc},${item.row + dr}`;
        if (excludeTiles && excludeTiles.has(key)) continue;
        tiles.add(key);
      }
    }
  }
  return tiles;
}

/** "col,row" of every tile occupied by a furniture item marked
 *  `approachThrough` (e.g. a kitchen counter with a coffee machine behind
 *  it) — consulted by computeApproachTiles to keep searching past a blocked
 *  neighbor instead of giving up, for exactly the items that opted in. Does
 *  NOT affect movement/placement blocking itself (see getBlockedTiles) —
 *  the item still occupies its tile normally. */
export function getReachThroughTiles(furniture: PlacedFurniture[]): Set<string> {
  const tiles = new Set<string>();
  for (const item of furniture) {
    if (!item.approachThrough) continue;
    const entry = entryFor(item);
    if (!entry) continue;
    for (let dr = 0; dr < entry.footprintH; dr++) {
      for (let dc = 0; dc < entry.footprintW; dc++) {
        tiles.add(`${item.col + dc},${item.row + dr}`);
      }
    }
  }
  return tiles;
}

/** Tiles explicitly marked non-walkable in the layout itself (layout.tileBlocked),
 *  independent of floor pattern — e.g. a puddle painted with an ordinary floor
 *  pattern. Empty when the layout has no such tiles. */
export function getBlockedFloorTiles(layout: OfficeLayout): Set<string> {
  const tiles = new Set<string>();
  const blocked = layout.tileBlocked;
  if (!blocked) return tiles;
  for (let i = 0; i < blocked.length; i++) {
    if (!blocked[i]) continue;
    tiles.add(`${i % layout.cols},${Math.floor(i / layout.cols)}`);
  }
  return tiles;
}


/** Every sittable item's tiles as `sit` interaction points — see resolveCanSitOn/
 *  resolveSitFacing, which is where the "is this sittable, and which way do you
 *  face" question is answered (it used to be inferred here, from the 'chairs'
 *  category plus an art-orientation string plus the direction of the nearest
 *  desk). The standing counterpart for appliances is built in officeState's
 *  computeApproachTiles; both end up in the one OfficeState.points map. */
export function layoutToSitPoints(furniture: PlacedFurniture[]): Map<string, InteractionPoint> {
  const points = new Map<string, InteractionPoint>();

  // Every footprint tile below the background rows becomes a point, so a 2-tile
  // couch seats two.
  for (const item of furniture) {
    const entry = entryFor(item);
    if (!entry || !resolveCanSitOn(item, entry)) continue;

    const facingDir = resolveSitFacing(item, entry);
    let seatCount = 0;
    const bgRows = resolveBackgroundTiles(item, entry);
    for (let dr = bgRows; dr < entry.footprintH; dr++) {
      for (let dc = 0; dc < entry.footprintW; dc++) {
        // The first point keeps the item's own uid, the rest get `uid:N` — so a
        // one-seat chair's point id is still just the chair's uid.
        const uid = seatCount === 0 ? item.uid : `${item.uid}:${seatCount}`;
        points.set(uid, {
          uid,
          col: item.col + dc,
          row: item.row + dr,
          facingDir,
          posture: 'sit',
          occupantId: null,
        });
        seatCount++;
      }
    }
  }

  return points;
}

/** The tiles of a set of points (so they can be excluded from blocked tiles)
 * @internal */
export function getPointTiles(points: Map<string, InteractionPoint>): Set<string> {
  const tiles = new Set<string>();
  for (const p of points.values()) tiles.add(`${p.col},${p.row}`);
  return tiles;
}

/**
 * Wall edges ringing the outside of a cols×rows field: the map's four outer
 * boundaries. Every cell stays walkable floor — the ring is what stops anyone
 * leaving (see wallEdges.ts).
 */
function borderWalls(cols: number, rows: number): NonNullable<OfficeLayout['walls']> {
  const walls = emptyWallEdges(cols, rows);
  for (let r = 0; r < rows; r++) {
    walls.vertical[vIndex(cols, 0, r)] = true;
    walls.vertical[vIndex(cols, cols, r)] = true;
  }
  for (let c = 0; c < cols; c++) {
    walls.horizontal[hIndex(cols, c, 0)] = true;
    walls.horizontal[hIndex(cols, c, rows)] = true;
  }
  return walls;
}

/** Create a minimal fallback layout (used only when no default-layout.json exists) */
export function createDefaultLayout(): OfficeLayout {
  // Cell 0 of no set at all: walkable (not VOID) and drawn as the renderer's flat
  // fill, because nothing in shared/ knows which tilesets a deployment has. This
  // used to name floor patterns 1 and 2, which was equally arbitrary and merely
  // looked deliberate.
  const tiles = new Array<number>(DEFAULT_COLS * DEFAULT_ROWS).fill(0);
  return {
    version: 3,
    cols: DEFAULT_COLS,
    rows: DEFAULT_ROWS,
    tiles,
    walls: borderWalls(DEFAULT_COLS, DEFAULT_ROWS),
    furniture: [],
  };
}

/**
 * A wall-bordered empty field — what a zone renders as when it has no map yet.
 *
 * This is a fallback, not content: maps come from Tiled now (see
 * tiled/zonePushApi.ts), and nothing generates a world any more. It exists so a
 * zone registered without a successful push still opens instead of failing to
 * build a tile grid. It replaced createBlankZoneLayout, whose job was the
 * starting point for the in-game editor, and the builtin plaza that was that
 * same field plus a beam pad.
 */
export function emptyZoneMap(cols: number, rows: number): OfficeLayout {
  const tiles = new Array<number>(cols * rows).fill(0);
  return { version: 3, cols, rows, tiles, walls: borderWalls(cols, rows), furniture: [] };
}

/** Serialize layout to JSON string
 * @internal */
export function serializeLayout(layout: OfficeLayout): string {
  return JSON.stringify(layout);
}

/** Deserialize layout from JSON string. Accepts both versions — a v1 blob is what
 *  a database written before ground cells held tile ids contains, and it is
 *  converted by migrateLayout, which needs the tilesets and therefore cannot
 *  happen here. Anything else is rejected: this is the shape check that stands
 *  between a hand-edited .tmj (or a patched client) and the database.
 * @internal */
export function deserializeLayout(json: string): OfficeLayout | null {
  try {
    const obj = JSON.parse(json);
    if (obj && [1, 2, 3].includes(obj.version) && Array.isArray(obj.tiles) && Array.isArray(obj.furniture)) {
      return obj as OfficeLayout;
    }
  } catch {
    /* ignore parse errors */
  }
  return null;
}
