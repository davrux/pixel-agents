/**
 * Wall sprite storage and the piece lookup edge walls render through.
 *
 * Sprites are pre-baked, closed-palette PNGs (see
 * server/scripts/bake-floor-wall-tiled.mts and client/src/net/tiledSheets.ts)
 * — a direct (piece, swatch) lookup, no runtime HSL colorize.
 *
 * A wall is an EDGE between two cells (see types.ts's WallEdges), so the piece
 * for a lattice point comes from which of the four edges meeting there are wall:
 * the same N=1, E=2, S=4, W=8 mask the old cell autotile used, which is why the
 * baked art needed no changes when walls moved onto the boundaries.
 */

import type { SheetCellRef, SheetInstance, WallEdges } from './types.js';
import { TILE_SIZE } from './types.js';
import { WALL_TILE_H } from './tiledSheetLayout.js';
import { latticeIndex, latticeMask } from './wallEdges.js';

/**
 * Piece (row) count per wall set, keyed by the set's NAME — no pixels.
 *
 * This held the sliced sheets until the client stopped exploding them: two wall
 * sets are 6230 cells and 3.19 million pixels, which as hex strings was the bulk
 * of ~34 MB of heap re-encoding 269 KB of PNG. A baked sheet is already an atlas,
 * so the renderer keeps it as one texture and draws rectangles (see
 * client/src/render/sprites.ts); what belongs here is which sets exist and how
 * many pieces each carries.
 *
 * Keyed by name rather than by a position in a list — see floorTiles.ts for what
 * that positional index cost.
 */
let wallPieceCounts: Record<string, number> = {};

/** Register the wall sets that loaded, with each set's piece count (read off the
 *  sheet's own height — see client/src/net/tiledSheets.ts). */
export function setWallSheetInfo(pieceCounts: Record<string, number>): void {
  wallPieceCounts = pieceCounts;
}

/** Check if wall sheets have been loaded */
export function hasWallSprites(): boolean {
  return Object.keys(wallPieceCounts).length > 0;
}

/** The named set, else whichever loaded first — a map naming a set this build
 *  does not have (renamed or removed tileset) still draws walls. Warned once. */
const warnedWallSets = new Set<string>();
function wallSet(name: string | undefined): string | undefined {
  if (name !== undefined) {
    if (wallPieceCounts[name] !== undefined) return name;
    if (!warnedWallSets.has(name)) {
      warnedWallSets.add(name);
      console.warn(`[wallTiles] unknown wall set "${name}" — falling back`);
    }
  }
  const names = Object.keys(wallPieceCounts);
  return names.length > 0 ? names[0] : undefined;
}

/** The cell a piece + swatch is in, or null when the set has no such piece —
 *  which is how a face piece past a set's own range stays undrawn. */
function wallCell(sheet: string | undefined, piece: number, swatch: number | null): SheetCellRef | null {
  if (sheet === undefined || piece < 0 || piece >= wallPieceCounts[sheet]) return null;
  return { sheet, kind: 'wall', row: piece, col: swatch === null ? 0 : swatch + 1 };
}

/**
 * Build the z-sortable instances for EDGE walls (see types.ts's WallEdges).
 *
 * One instance per lattice point that any wall edge touches, drawn half a tile
 * up and left of the cell grid. The four edges meeting at a lattice point form
 * the same N/E/S/W mask the baked pieces were cut for, which is why moving walls
 * onto the boundaries needed no new art. A latticePiece override wins over the
 * derived mask — that's how a north-wall face gets placed, since nothing derives
 * those from adjacency.
 *
 * zY sorts by the lattice point's own row boundary: a wall on the boundary
 * between rows r-1 and r should occlude anything standing in row r-1 and be
 * occluded by anything in row r, which is what r * TILE_SIZE gives.
 */
export function getWallEdgeInstances(walls: WallEdges, cols: number, rows: number, setNames: string[] = []): SheetInstance[] {
  if (!hasWallSprites()) return [];
  const instances: SheetInstance[] = [];
  // Was anything painted at all? If so the lattice layer is the truth and only
  // painted points draw — anything else invents wall the editor does not show
  // (see mapBridge.ts's import). A layout built in code paints nothing and has
  // only edges, so there the mask is all there is to go on.
  const authored = walls.latticePiece?.some((p) => p != null) ?? false;
  for (let r = 0; r <= rows; r++) {
    for (let c = 0; c <= cols; c++) {
      const li = latticeIndex(cols, c, r);
      const painted = walls.latticePiece?.[li];
      const derived = latticeMask(walls, cols, rows, c, r);
      if (authored ? painted == null : derived === 0) continue;
      const piece = painted ?? derived;
      const ref = wallCell(wallSet(setNames[walls.latticeSet?.[li] ?? 0]), piece, walls.latticeColor?.[li] ?? null);
      if (!ref) continue;
      instances.push({
        ref,
        // Bottom-anchored like every wall sprite, then shifted onto the lattice.
        // Every wall cell is WALL_TILE_H tall by construction (the sheet is cut
        // that way), which is what the sprite's own height used to say here.
        x: c * TILE_SIZE - TILE_SIZE / 2,
        y: r * TILE_SIZE - TILE_SIZE / 2 + (TILE_SIZE - WALL_TILE_H),
        zY: r * TILE_SIZE,
      });
    }
  }
  return instances;
}

/**
 * Build the z-sortable instances for north-wall FACE pieces (see WallEdges.faces).
 *
 * Cell-aligned, with none of the half-tile offset the edge pieces get: a face
 * fills its whole tile, so it has to land on the floor grid or its cornice and
 * vertical seams read 8px off. zY is the cell's bottom edge, so a face occludes
 * whatever stands in the row above it and is occluded by anything in its own
 * row — matching how the wall it depicts would.
 */
export function getWallFaceInstances(
  faces: NonNullable<WallEdges['faces']>,
  cols: number,
  rows: number,
  setNames: string[] = [],
): SheetInstance[] {
  if (!hasWallSprites()) return [];
  const instances: SheetInstance[] = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const i = r * cols + c;
      const piece = faces.piece[i];
      if (piece == null) continue;
      const ref = wallCell(wallSet(setNames[faces.set?.[i] ?? 0]), piece, faces.color?.[i] ?? null);
      if (!ref) continue;
      instances.push({
        ref,
        x: c * TILE_SIZE,
        // Bottom-anchored, like every wall sprite (the art sits in the bottom
        // 16 rows of a 32-tall slot).
        y: r * TILE_SIZE + (TILE_SIZE - WALL_TILE_H),
        zY: (r + 1) * TILE_SIZE,
      });
    }
  }
  return instances;
}
