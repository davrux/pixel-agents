/**
 * Static world configuration shared by server (simulation/pathfinding) and
 * client (rendering). Contains NO Colyseus/schema imports so it can be bundled
 * into the browser freely.
 *
 * Today there is a single building template, "office". Adding more buildings
 * (and, later, cities/countries) means adding more entries to BUILDING_TEMPLATES
 * and pointing a Building.templateId at them — the rest of the pipeline is
 * already generic over templateId.
 */

export const TILE_SIZE = 16;

/** Facing directions. Matches the original engine's numbering. */
export const Direction = {
  DOWN: 0,
  LEFT: 1,
  RIGHT: 2,
  UP: 3,
} as const;
export type Direction = (typeof Direction)[keyof typeof Direction];

/** Logical character states (server FSM + client animation selection). */
export const CharState = {
  SPAWN: 'spawn',
  IDLE: 'idle',
  WALK: 'walk',
  TYPE: 'type',
  DESPAWN: 'despawn',
} as const;
export type CharState = (typeof CharState)[keyof typeof CharState];

/** A chair a character can be assigned to. */
export interface SeatDef {
  col: number;
  row: number;
  /** Direction the seated character faces (toward its desk). */
  dir: Direction;
}

/** A decorative / functional furniture sprite to render at a tile. */
export interface FurnitureDef {
  /** Sprite key the client knows how to draw. */
  kind: string;
  col: number;
  row: number;
  /** Footprint in tiles (defaults 1x1); used for walk-blocking. */
  w?: number;
  h?: number;
  /** Whether it blocks walking (default true). */
  blocks?: boolean;
}

export interface BuildingTemplate {
  id: string;
  name: string;
  cols: number;
  rows: number;
  /** Row-major tile grid: 0 = wall, 1 = floor. */
  tiles: number[];
  furniture: FurnitureDef[];
  seats: SeatDef[];
}

// ── Office template ───────────────────────────────────────────────

const OFFICE_COLS = 22;
const OFFICE_ROWS = 16;

function buildOffice(): BuildingTemplate {
  const cols = OFFICE_COLS;
  const rows = OFFICE_ROWS;
  const tiles = new Array(cols * rows).fill(1);

  // Outer wall ring.
  for (let c = 0; c < cols; c++) {
    tiles[c] = 0; // top
    tiles[(rows - 1) * cols + c] = 0; // bottom
  }
  for (let r = 0; r < rows; r++) {
    tiles[r * cols] = 0; // left
    tiles[r * cols + (cols - 1)] = 0; // right
  }

  const furniture: FurnitureDef[] = [];
  const seats: SeatDef[] = [];

  // Workstation bank — two rows of desks (2×2, Modern Interiors free). The chair
  // tile sits directly below the desk; the seated agent faces UP toward it.
  // This mirrors the old repo's office: a desk pool agents sit and work at.
  const deskCols = [3, 7, 11, 15];
  const bandTopRows = [2, 8];
  for (const topRow of bandTopRows) {
    for (const c of deskCols) {
      furniture.push({ kind: 'DESK', col: c, row: topRow, w: 2, h: 2 });
      seats.push({ col: c, row: topRow + 2, dir: Direction.UP });
    }
  }

  // Lounge corner (bottom-left): a sofa over a rug, like the old repo's seating area.
  furniture.push({ kind: 'RUG', col: 2, row: rows - 3, w: 4, h: 2, blocks: false });
  furniture.push({ kind: 'SOFA', col: 3, row: rows - 4, w: 2, h: 2 });

  // Decor: bookshelves along the top wall, palms in the right corners.
  furniture.push({ kind: 'BOOKSHELF', col: 1, row: 1, w: 2, h: 2 });
  furniture.push({ kind: 'BOOKSHELF', col: cols - 3, row: 1, w: 2, h: 2 });
  furniture.push({ kind: 'PALM', col: cols - 3, row: rows - 4, w: 2, h: 3 });
  furniture.push({ kind: 'PALM', col: cols - 6, row: rows - 4, w: 2, h: 3 });

  return { id: 'office', name: 'Office', cols, rows, tiles, furniture, seats };
}

export const BUILDING_TEMPLATES: Record<string, BuildingTemplate> = {
  office: buildOffice(),
};

export function getTemplate(id: string): BuildingTemplate {
  return BUILDING_TEMPLATES[id] ?? BUILDING_TEMPLATES.office;
}

// ── Grid helpers (used by both server sim and client) ─────────────

export function tileIndex(col: number, row: number, cols: number): number {
  return row * cols + col;
}

/** Pixel center of a tile. */
export function tileCenter(col: number, row: number): { x: number; y: number } {
  return { x: col * TILE_SIZE + TILE_SIZE / 2, y: row * TILE_SIZE + TILE_SIZE / 2 };
}

/** Build the set of blocked tiles ("col,row") from walls + blocking furniture. */
export function buildBlockedSet(t: BuildingTemplate): Set<string> {
  const blocked = new Set<string>();
  for (let r = 0; r < t.rows; r++) {
    for (let c = 0; c < t.cols; c++) {
      if (t.tiles[tileIndex(c, r, t.cols)] === 0) blocked.add(`${c},${r}`);
    }
  }
  for (const f of t.furniture) {
    if (f.blocks === false) continue;
    const w = f.w ?? 1;
    const h = f.h ?? 1;
    for (let dy = 0; dy < h; dy++) {
      for (let dx = 0; dx < w; dx++) {
        blocked.add(`${f.col + dx},${f.row + dy}`);
      }
    }
  }
  return blocked;
}

export function isWalkable(
  col: number,
  row: number,
  t: BuildingTemplate,
  blocked: Set<string>,
): boolean {
  if (col < 0 || row < 0 || col >= t.cols || row >= t.rows) return false;
  return !blocked.has(`${col},${row}`);
}
