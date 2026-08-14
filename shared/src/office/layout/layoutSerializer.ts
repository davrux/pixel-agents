import type { FurnitureInstance, OfficeLayout, PlacedFurniture, Seat, TileType as TileTypeVal } from '../types.js';
import { DEFAULT_COLS, DEFAULT_ROWS, Direction, TILE_SIZE, TileType, WALK_OVER_DEPTH } from '../types.js';
import { getCatalogEntry, resolveBackgroundTiles, resolveCanSitOn, resolveCanWalkOver, resolveSitFacing } from './furnitureCatalog.js';
import { emptyWallEdges, hIndex, vIndex } from '../wallEdges.js';

/** Convert flat tile array from layout into 2D grid */
export function layoutToTileMap(layout: OfficeLayout): TileTypeVal[][] {
  const map: TileTypeVal[][] = [];
  for (let r = 0; r < layout.rows; r++) {
    const row: TileTypeVal[] = [];
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
    const entry = getCatalogEntry(item.id);
    if (!entry) continue;
    const x = item.col * TILE_SIZE;
    const y = item.row * TILE_SIZE;
    const spriteH = entry.sprite.length;
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

    const sprite = entry.sprite; // furniture renders exactly as drawn — no recoloring

    instances.push({
      sprite,
      x,
      y,
      zY,
      ...(item.flippedHorizontally ? { mirrored: true } : {}),
      ...(item.flippedVertically ? { flippedVertically: true } : {}),
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
    const entry = getCatalogEntry(item.id);
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
    const entry = getCatalogEntry(item.id);
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


/** Generate seats from every sittable item — see resolveCanSitOn/
 *  resolveSitFacing, which is where the "is this sittable, and which way do you
 *  face" question is now answered (it used to be inferred here, from the
 *  'chairs' category plus an art-orientation string plus the direction of the
 *  nearest desk). */
export function layoutToSeats(furniture: PlacedFurniture[]): Map<string, Seat> {
  const seats = new Map<string, Seat>();

  // Every footprint tile below the background rows becomes a seat, so a 2-tile
  // couch seats two.
  for (const item of furniture) {
    const entry = getCatalogEntry(item.id);
    if (!entry || !resolveCanSitOn(item, entry)) continue;

    const facingDir = resolveSitFacing(item, entry);
    let seatCount = 0;
    const bgRows = resolveBackgroundTiles(item, entry);
    for (let dr = bgRows; dr < entry.footprintH; dr++) {
      for (let dc = 0; dc < entry.footprintW; dc++) {
        const tileCol = item.col + dc;
        const tileRow = item.row + dr;

        // First seat uses chair uid (backward compat), subsequent use uid:N
        const seatUid = seatCount === 0 ? item.uid : `${item.uid}:${seatCount}`;
        seats.set(seatUid, {
          uid: seatUid,
          seatCol: tileCol,
          seatRow: tileRow,
          facingDir,
          assigned: false,
        });
        seatCount++;
      }
    }
  }

  return seats;
}

/** Get the set of tiles occupied by seats (so they can be excluded from blocked tiles)
 * @internal */
export function getSeatTiles(seats: Map<string, Seat>): Set<string> {
  const tiles = new Set<string>();
  for (const seat of seats.values()) {
    tiles.add(`${seat.seatCol},${seat.seatRow}`);
  }
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
  const tiles: TileTypeVal[] = [];
  const tileColors: Array<number | null> = [];
  for (let r = 0; r < DEFAULT_ROWS; r++) {
    for (let c = 0; c < DEFAULT_COLS; c++) {
      tiles.push(c < 10 ? TileType.FLOOR_1 : TileType.FLOOR_2);
      tileColors.push(null); // Natural — this fallback is cosmetically irrelevant; default-layout.json provides the real default
    }
  }
  // Minimal fallback with no furniture — the default-layout.json provides the real default
  return {
    version: 1,
    cols: DEFAULT_COLS,
    rows: DEFAULT_ROWS,
    tiles,
    tileColors,
    walls: borderWalls(DEFAULT_COLS, DEFAULT_ROWS),
    furniture: [],
  };
}

/** A wall-bordered open field of FLOOR_3 — the starting layout for any generated
 *  zone (the plaza, and every user-created zone). Optional furniture (e.g. a beam
 *  pad) is placed on top. Resizing happens later via the layout editor. */
export function createBlankZoneLayout(
  cols: number,
  rows: number,
  furniture: OfficeLayout['furniture'] = [],
): OfficeLayout {
  const tiles: TileTypeVal[] = [];
  const tileColors: Array<number | null> = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      tiles.push(TileType.FLOOR_3);
      tileColors.push(null);
    }
  }
  return { version: 1, cols, rows, tiles, tileColors, walls: borderWalls(cols, rows), furniture };
}

/** The plaza: the second builtin zone, with a beam pad (walk onto it → zone
 *  picker). Deliberately visually distinct from the office. */
export function createPlazaLayout(): OfficeLayout {
  // Walkable beam pad via backgroundTiles.
  return createBlankZoneLayout(20, 14, [{ uid: 'plaza-beam', id: 'BEAM_PAD', col: 3, row: 3 }]);
}

/** Serialize layout to JSON string
 * @internal */
export function serializeLayout(layout: OfficeLayout): string {
  return JSON.stringify(layout);
}

/** Deserialize layout from JSON string — no legacy-data migration (see
 *  git history if a very old layout ever needs resurrecting): a saved
 *  layout is only ever produced by this session's own serializeLayout or a
 *  fresh Tiled import, both of which already write the current shape.
 * @internal */
export function deserializeLayout(json: string): OfficeLayout | null {
  try {
    const obj = JSON.parse(json);
    if (obj && obj.version === 1 && Array.isArray(obj.tiles) && Array.isArray(obj.furniture)) {
      return obj as OfficeLayout;
    }
  } catch {
    /* ignore parse errors */
  }
  return null;
}
