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

import type { FurnitureInstance, SpriteData, WallEdges } from './types.js';
import { TILE_SIZE } from './types.js';
import { latticeIndex, latticeMask } from './wallEdges.js';

/** wallSheets[setName][bitmask][0] = Natural (raw, uncolorized); [1+i] = the
 *  set's palette colorized. Populated once by the client's tiledSheets loader.
 *  Keyed by NAME rather than by a position in a list — see floorTiles.ts for
 *  what that positional index cost. */
let wallSheets: Record<string, SpriteData[][]> = {};

/** Set wall tile sets (called once the baked sheets are fetched + sliced —
 *  see client/src/net/tiledSheets.ts). */
export function setWallSheets(sheets: Record<string, SpriteData[][]>): void {
  wallSheets = sheets;
}

/** Check if wall sprites have been loaded */
export function hasWallSprites(): boolean {
  return Object.keys(wallSheets).length > 0;
}

/** The named set, else whichever loaded first — a map naming a set this build
 *  does not have (renamed or removed tileset) still draws walls. Warned once. */
const warnedWallSets = new Set<string>();
function wallSet(name: string | undefined): SpriteData[][] | undefined {
  if (name !== undefined) {
    const hit = wallSheets[name];
    if (hit) return hit;
    if (!warnedWallSets.has(name)) {
      warnedWallSets.add(name);
      console.warn(`[wallTiles] unknown wall set "${name}" — falling back`);
    }
  }
  const names = Object.keys(wallSheets);
  return names.length > 0 ? wallSheets[names[0]] : undefined;
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
export function getWallEdgeInstances(walls: WallEdges, cols: number, rows: number, setNames: string[] = []): FurnitureInstance[] {
  if (Object.keys(wallSheets).length === 0) return [];
  const instances: FurnitureInstance[] = [];
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
      const set = wallSet(setNames[walls.latticeSet?.[li] ?? 0]);
      const sprite = set?.[piece]?.[(walls.latticeColor?.[li] ?? null) === null ? 0 : (walls.latticeColor![li] as number) + 1];
      if (!sprite) continue;
      instances.push({
        sprite,
        // Bottom-anchored like every wall sprite (see getWallSprite), then
        // shifted onto the lattice.
        x: c * TILE_SIZE - TILE_SIZE / 2,
        y: r * TILE_SIZE - TILE_SIZE / 2 + (TILE_SIZE - sprite.length),
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
): FurnitureInstance[] {
  if (Object.keys(wallSheets).length === 0) return [];
  const instances: FurnitureInstance[] = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const i = r * cols + c;
      const piece = faces.piece[i];
      if (piece == null) continue;
      const set = wallSet(setNames[faces.set?.[i] ?? 0]);
      const swatch = faces.color?.[i] ?? null;
      const sprite = set?.[piece]?.[swatch === null ? 0 : swatch + 1];
      if (!sprite) continue;
      instances.push({
        sprite,
        x: c * TILE_SIZE,
        // Bottom-anchored, like every wall sprite (the art sits in the bottom
        // 16 rows of a 32-tall slot).
        y: r * TILE_SIZE + (TILE_SIZE - sprite.length),
        zY: (r + 1) * TILE_SIZE,
      });
    }
  }
  return instances;
}
