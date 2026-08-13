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

/** wallSheets[setIndex][bitmask][0] = Natural (raw, uncolorized); [1+i] =
 *  WALL_SET_PALETTES[setIndex][i] colorized. Populated once by the client's
 *  tiledSheets loader from the baked assets/tiled/png/<WALL_SET_FILES[setIndex]>.png
 *  sheets — see tiledSheetLayout.ts's WALL_SET_FILES. */
let wallSheets: SpriteData[][][] = [];

/** Set wall tile sets (called once the baked wall-N.png sheets are fetched +
 *  sliced — see client/src/net/tiledSheets.ts). */
export function setWallSheets(sheets: SpriteData[][][]): void {
  wallSheets = sheets;
}

/** Check if wall sprites have been loaded */
export function hasWallSprites(): boolean {
  return wallSheets.length > 0;
}

/** Get number of available wall sets */
export function getWallSetCount(): number {
  return wallSheets.length;
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
export function getWallEdgeInstances(walls: WallEdges, cols: number, rows: number): FurnitureInstance[] {
  if (wallSheets.length === 0) return [];
  const instances: FurnitureInstance[] = [];
  for (let r = 0; r <= rows; r++) {
    for (let c = 0; c <= cols; c++) {
      const derived = latticeMask(walls, cols, rows, c, r);
      if (derived === 0) continue;
      const li = latticeIndex(cols, c, r);
      const override = walls.latticePiece?.[li];
      const piece = override ?? derived;
      const set = wallSheets[walls.latticeSet?.[li] ?? 0] ?? wallSheets[0];
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
