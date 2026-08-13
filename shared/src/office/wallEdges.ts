/**
 * Walls as edges between cells (see types.ts's WallEdges): indexing, the
 * crossing test movement uses, and the lattice-point mask rendering uses.
 *
 * The two halves of this file are the whole point of the edge model:
 *   - `crossingBlocked` answers "can you step from A to B", which is what a
 *     wall physically is. A wall no longer costs a walkable cell.
 *   - `latticeMask` turns the edge set back into the N/E/S/W mask the existing
 *     wall autotile already draws (see wallTiles.ts), so the art is unchanged —
 *     it just renders on the lattice, half a tile up and left of the cells.
 */
import type { WallEdges } from './types.js';

/** Index of the vertical edge on column boundary `c` in row `r`
 *  — the edge between cells (c-1,r) and (c,r). c ranges 0..cols. */
export function vIndex(cols: number, c: number, r: number): number {
  return r * (cols + 1) + c;
}

/** Index of the horizontal edge on row boundary `r` in column `c`
 *  — the edge between cells (c,r-1) and (c,r). r ranges 0..rows. */
export function hIndex(cols: number, c: number, r: number): number {
  return r * cols + c;
}

/** Index of lattice point (c,r), the corner shared by cells (c-1,r-1)…(c,r).
 *  Both ranges are inclusive of the far edge, so the grid is (cols+1)×(rows+1). */
export function latticeIndex(cols: number, c: number, r: number): number {
  return r * (cols + 1) + c;
}

export function emptyWallEdges(cols: number, rows: number): WallEdges {
  return {
    vertical: new Array((cols + 1) * rows).fill(false),
    horizontal: new Array(cols * (rows + 1)).fill(false),
  };
}

/**
 * Is the step between two 4-adjacent cells blocked by a wall edge?
 *
 * Only ever called for orthogonal neighbours — the grid is 4-connected
 * everywhere (see tileMap.ts's DIRS_4), so there is no diagonal case to think
 * about, and a diagonal argument returns false rather than guessing.
 */
export function crossingBlocked(
  walls: WallEdges | undefined,
  cols: number,
  fromCol: number,
  fromRow: number,
  toCol: number,
  toRow: number,
): boolean {
  if (!walls) return false;
  const dc = toCol - fromCol;
  const dr = toRow - fromRow;
  if (dr === 0 && (dc === 1 || dc === -1)) {
    // Crossing a column boundary: the edge is on the higher of the two columns.
    return !!walls.vertical[vIndex(cols, Math.max(fromCol, toCol), fromRow)];
  }
  if (dc === 0 && (dr === 1 || dr === -1)) {
    return !!walls.horizontal[hIndex(cols, fromCol, Math.max(fromRow, toRow))];
  }
  return false;
}

/**
 * The autotile mask for lattice point (c,r): which of the four edges meeting
 * there carry a wall. Same N=1/E=2/S=4/W=8 convention as the cell autotile, so
 * the same baked pieces apply (see wallTiles.ts's getWallSprite).
 *
 * "North" from a lattice point is the vertical edge above it, i.e. the one in
 * row r-1 on this column boundary; "east" is the horizontal edge to its right,
 * in column c on this row boundary.
 */
export function latticeMask(walls: WallEdges, cols: number, rows: number, c: number, r: number): number {
  let mask = 0;
  if (r > 0 && walls.vertical[vIndex(cols, c, r - 1)]) mask |= 1; // N
  if (c < cols && walls.horizontal[hIndex(cols, c, r)]) mask |= 2; // E
  if (r < rows && walls.vertical[vIndex(cols, c, r)]) mask |= 4; // S
  if (c > 0 && walls.horizontal[hIndex(cols, c - 1, r)]) mask |= 8; // W
  return mask;
}

/** Does any wall edge touch this lattice point? (mask !== 0, without building
 *  the mask — used to skip empty lattice points cheaply while rendering.) */
export function latticeOccupied(walls: WallEdges, cols: number, rows: number, c: number, r: number): boolean {
  return latticeMask(walls, cols, rows, c, r) !== 0;
}

/** Whether a cell has a wall on its north edge — the edge-model replacement for
 *  "the tile above is a WALL", which is how wall-mounted furniture anchors. */
export function wallOnNorthEdge(walls: WallEdges | undefined, cols: number, col: number, row: number): boolean {
  if (!walls) return false;
  return !!walls.horizontal[hIndex(cols, col, row)];
}

/**
 * "col,row" of every cell carrying a north-wall face piece — non-walkable by
 * construction, since a face depicts solid wall.
 *
 * Derived rather than painted for the same reason furniture footprints are (see
 * officeState.ts's computeBlockedTiles, which unions both): there is no such
 * thing as a wall surface you may stand in, so requiring the mapper to paint
 * Collision over every face would be a step that is always needed and easy to
 * forget — and forgetting it produces a wall you can walk into from behind,
 * which reads as a bug rather than as a missing brush stroke. The edge run along
 * a faced wall's base only blocks approach from that side; this blocks the wall's
 * own body.
 */
export function faceBlockedTiles(walls: WallEdges | undefined, cols: number): Set<string> {
  const keys = new Set<string>();
  const piece = walls?.faces?.piece;
  if (!piece) return keys;
  for (let i = 0; i < piece.length; i++) {
    if (piece[i] != null) keys.add(`${i % cols},${Math.floor(i / cols)}`);
  }
  return keys;
}
