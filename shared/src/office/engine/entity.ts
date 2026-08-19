/**
 * Shared entity core — the transform + tile-movement primitives every moving
 * entity uses (agents, NPCs, and later players & monsters). The per-kind engines
 * (characters.ts, pets.ts, …) layer their own decision/animation logic on top;
 * this is the common substrate so movement isn't reimplemented per kind.
 *
 * Part of the foundation spike (F1): unify Character + Pet onto one entity model.
 */
import { Direction, TILE_SIZE } from '../types.js';

/** A tile coordinate step in a path. */
interface TileStep {
  col: number;
  row: number;
}

/** The transform + movement state shared by every moving entity. Character and
 *  Pet both structurally satisfy this, so shared movement code operates on both. */
interface MovingEntity {
  dir: Direction;
  /** Pixel position (tile-center anchored). */
  x: number;
  y: number;
  tileCol: number;
  tileRow: number;
  /** Remaining path steps (excludes the current tile). */
  path: TileStep[];
  /** 0–1 lerp progress between the current tile and path[0]. */
  moveProgress: number;
}

/** Pixel center of a tile. */
export function tileCenter(col: number, row: number): { x: number; y: number } {
  return { x: col * TILE_SIZE + TILE_SIZE / 2, y: row * TILE_SIZE + TILE_SIZE / 2 };
}

/** Cardinal direction from one tile toward an adjacent tile. */
function directionBetween(fromCol: number, fromRow: number, toCol: number, toRow: number): Direction {
  const dc = toCol - fromCol;
  const dr = toRow - fromRow;
  if (dc > 0) return Direction.RIGHT;
  if (dc < 0) return Direction.LEFT;
  if (dr > 0) return Direction.DOWN;
  return Direction.UP;
}

/** Snap an entity's pixel position to its current tile center. */
export function snapToTile(e: MovingEntity): void {
  const c = tileCenter(e.tileCol, e.tileRow);
  e.x = c.x;
  e.y = c.y;
}

/**
 * Advance an entity one tick along `path` toward the next step at `speedPxPerSec`:
 * faces the step, lerps the pixel position, and on arrival commits the tile +
 * shifts the path. No-op when the path is empty (callers handle arrival). Shared
 * by the character WALK and pet WANDER/chase/flee movement.
 */
export function stepAlongPath(e: MovingEntity, dt: number, speedPxPerSec: number): void {
  const next = e.path[0];
  if (!next) return;
  e.dir = directionBetween(e.tileCol, e.tileRow, next.col, next.row);
  e.moveProgress += (speedPxPerSec / TILE_SIZE) * dt;
  const from = tileCenter(e.tileCol, e.tileRow);
  const to = tileCenter(next.col, next.row);
  const t = Math.min(e.moveProgress, 1);
  e.x = from.x + (to.x - from.x) * t;
  e.y = from.y + (to.y - from.y) * t;
  if (e.moveProgress >= 1) {
    e.tileCol = next.col;
    e.tileRow = next.row;
    e.x = to.x;
    e.y = to.y;
    e.path.shift();
    e.moveProgress = 0;
  }
}
