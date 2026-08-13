import type { FurnitureInstance, OfficeLayout, PlacedFurniture, Seat, TileType as TileTypeVal } from '../types.js';
import { DEFAULT_COLS, DEFAULT_ROWS, Direction, TILE_SIZE, TileType } from '../types.js';
import { getCatalogEntry } from './furnitureCatalog.js';
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

/** Convert placed furniture into renderable FurnitureInstance[] */
export function layoutToFurnitureInstances(furniture: PlacedFurniture[]): FurnitureInstance[] {
  // Pre-compute desk zY per tile so surface items can sort in front of desks
  const deskZByTile = new Map<string, number>();
  for (const item of furniture) {
    const entry = getCatalogEntry(item.id);
    if (!entry || !entry.isDesk) continue;
    const deskZY = item.row * TILE_SIZE + entry.sprite.length;
    for (let dr = 0; dr < entry.footprintH; dr++) {
      for (let dc = 0; dc < entry.footprintW; dc++) {
        const key = `${item.col + dc},${item.row + dr}`;
        const prev = deskZByTile.get(key);
        if (prev === undefined || deskZY > prev) deskZByTile.set(key, deskZY);
      }
    }
  }

  const instances: FurnitureInstance[] = [];
  for (const item of furniture) {
    const entry = getCatalogEntry(item.id);
    if (!entry) continue;
    const x = item.col * TILE_SIZE;
    const y = item.row * TILE_SIZE;
    const spriteH = entry.sprite.length;
    let zY = y + spriteH;

    // Chair z-sorting: ensure characters sitting on chairs render correctly
    if (entry.category === 'chairs') {
      if (entry.orientation === 'back') {
        // Back-facing chairs render IN FRONT of the seated character
        // (the chair back visually occludes the character behind it).
        // Use the bottom footprint row so it sorts after the character
        // even when the chair has background tiles that push seats down.
        zY = (item.row + entry.footprintH) * TILE_SIZE + 1;
      } else {
        // All other chairs: cap zY to first row bottom so characters
        // at any seat tile render in front of the chair
        zY = (item.row + 1) * TILE_SIZE;
      }
    }

    // Surface items render in front of the desk they sit on
    if (entry.occupiesSurface) {
      for (let dr = 0; dr < entry.footprintH; dr++) {
        for (let dc = 0; dc < entry.footprintW; dc++) {
          const deskZ = deskZByTile.get(`${item.col + dc},${item.row + dr}`);
          if (deskZ !== undefined && deskZ + 0.5 > zY) zY = deskZ + 0.5;
        }
      }
    }

    // Manual stacking override ("bring to front" / "send to back" in the
    // editor) — a large multiplier so any nonzero offset decisively wins over
    // the position-based heuristics above (which only ever differ by single
    // digits / fractions of a tile), while the default (unset = 0) leaves
    // every existing layout's ordering completely unchanged.
    if (item.zOffset) zY += item.zOffset * 100_000;

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
 *  Skips top backgroundTiles rows so characters can walk through them. */
export function getBlockedTiles(
  furniture: PlacedFurniture[],
  excludeTiles?: Set<string>,
): Set<string> {
  const tiles = new Set<string>();
  for (const item of furniture) {
    const entry = getCatalogEntry(item.id);
    if (!entry) continue;
    const bgRows = entry.backgroundTiles || 0;
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

/** Get tiles blocked for placement purposes — skips top backgroundTiles rows per item */
export function getPlacementBlockedTiles(
  furniture: PlacedFurniture[],
  excludeUid?: string,
): Set<string> {
  const tiles = new Set<string>();
  for (const item of furniture) {
    if (item.uid === excludeUid) continue;
    const entry = getCatalogEntry(item.id);
    if (!entry) continue;
    const bgRows = entry.backgroundTiles || 0;
    for (let dr = 0; dr < entry.footprintH; dr++) {
      if (dr < bgRows) continue; // skip background rows
      for (let dc = 0; dc < entry.footprintW; dc++) {
        tiles.add(`${item.col + dc},${item.row + dr}`);
      }
    }
  }
  return tiles;
}

/** Map chair orientation to character facing direction — 'front'/'back'/'side'
 *  are the only values the Orientation enum (Pixels.tiled-project) offers.
 *  Assumes the UNFLIPPED sprite — see mirrorFacing for why a flipped
 *  instance still needs this corrected. */
function orientationToFacing(orientation: string): Direction {
  switch (orientation) {
    case 'front':
      return Direction.DOWN;
    case 'back':
      return Direction.UP;
    case 'side':
      return Direction.RIGHT;
    default:
      return Direction.DOWN;
  }
}

/** Mirror a facing direction to match a flipped sprite — orientationToFacing
 *  assumes the chair's UNFLIPPED art (e.g. "side" always means the base
 *  sprite's own rightward-facing pose), so a mapper who flips a chair
 *  horizontally/vertically in Tiled to visually face the other way needs the
 *  seat's actual sit-facing to follow, or a character sitting there faces
 *  into the now-mirrored chair's back. Only ever applied to an
 *  orientation-derived facing — the adjacent-desk-direction fallback below is
 *  already purely positional (real desk geometry), so flipping the chair's
 *  own art has no bearing on it. */
function mirrorFacing(dir: Direction, flippedHorizontally?: boolean, flippedVertically?: boolean): Direction {
  if (flippedHorizontally) {
    if (dir === Direction.LEFT) dir = Direction.RIGHT;
    else if (dir === Direction.RIGHT) dir = Direction.LEFT;
  }
  if (flippedVertically) {
    if (dir === Direction.UP) dir = Direction.DOWN;
    else if (dir === Direction.DOWN) dir = Direction.UP;
  }
  return dir;
}

/** Generate seats from chair furniture.
 *  Facing priority: 1) chair orientation, 2) adjacent desk, 3) forward (DOWN). */
export function layoutToSeats(furniture: PlacedFurniture[]): Map<string, Seat> {
  const seats = new Map<string, Seat>();

  // Build set of all desk tiles
  const deskTiles = new Set<string>();
  for (const item of furniture) {
    const entry = getCatalogEntry(item.id);
    if (!entry || !entry.isDesk) continue;
    for (let dr = 0; dr < entry.footprintH; dr++) {
      for (let dc = 0; dc < entry.footprintW; dc++) {
        deskTiles.add(`${item.col + dc},${item.row + dr}`);
      }
    }
  }

  const dirs: Array<{ dc: number; dr: number; facing: Direction }> = [
    { dc: 0, dr: -1, facing: Direction.UP }, // desk is above chair → face UP
    { dc: 0, dr: 1, facing: Direction.DOWN }, // desk is below chair → face DOWN
    { dc: -1, dr: 0, facing: Direction.LEFT }, // desk is left of chair → face LEFT
    { dc: 1, dr: 0, facing: Direction.RIGHT }, // desk is right of chair → face RIGHT
  ];

  // For each chair, every footprint tile becomes a seat.
  // Multi-tile chairs (e.g. 2-tile couches) produce multiple seats.
  for (const item of furniture) {
    const entry = getCatalogEntry(item.id);
    if (!entry || entry.category !== 'chairs') continue;

    let seatCount = 0;
    const bgRows = entry.backgroundTiles ?? 0;
    for (let dr = bgRows; dr < entry.footprintH; dr++) {
      for (let dc = 0; dc < entry.footprintW; dc++) {
        const tileCol = item.col + dc;
        const tileRow = item.row + dr;

        // Determine facing direction:
        // 1) Chair orientation takes priority
        // 2) Adjacent desk direction
        // 3) Default forward (DOWN)
        let facingDir: Direction = Direction.DOWN;
        if (entry.orientation) {
          facingDir = mirrorFacing(orientationToFacing(entry.orientation), item.flippedHorizontally, item.flippedVertically);
        } else {
          for (const d of dirs) {
            if (deskTiles.has(`${tileCol + d.dc},${tileRow + d.dr}`)) {
              facingDir = d.facing;
              break;
            }
          }
        }

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
