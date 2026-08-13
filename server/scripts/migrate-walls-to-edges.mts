#!/usr/bin/env -S node --import tsx
/**
 * One-time migration: WALL cells → wall EDGES (see shared/src/office/types.ts's
 * WallEdges). Converts saved layouts in place.
 *
 * A wall was a whole cell: it blocked all 16px and hid a floor tile, for 6px of
 * art. As an edge it blocks only the step between two cells, and both cells stay
 * walkable — so every former wall cell becomes floor here, which is why a
 * migrated room is one cell wider in each direction than it was.
 *
 * Where the wall lands, per wall cell: on its NORTH boundary unless the cell
 * above is itself a wall cell, and independently on its WEST boundary unless the
 * cell to the left is. Always north/west, never south/east.
 *
 * That one rule covers every case. A 1-cell-thick run puts its line on the far
 * side from the room it joins, so the former wall cell becomes part of a room
 * rather than an enclosed pocket. Wall-MOUNTED furniture keeps working for free:
 * art that hung on a wall cell now stands in that cell with the wall on its
 * north edge, which is exactly what wallOnNorthEdge tests. A thicker wall mass
 * gets edges only on its outer boundary, never inside itself. A gap in a run (a
 * doorway) simply has no edges and stays passable. A ring's corner cell has
 * out-of-bounds/floor on both its north and west, so it gets both a horizontal
 * and a vertical edge, which the autotile draws as a corner.
 *
 * Run (from server/): node --import tsx scripts/migrate-walls-to-edges.mts [zone]
 *   zone — restrict to layouts of one zone (default: all)
 */
import { DatabaseSync } from 'node:sqlite';
import * as os from 'node:os';
import { TileType } from '../../shared/src/office/types.js';
import type { OfficeLayout } from '../../shared/src/office/types.js';
import { emptyWallEdges, hIndex, latticeIndex, vIndex } from '../../shared/src/office/wallEdges.js';

const only = process.argv[2];
const db = new DatabaseSync(`${os.homedir()}/.pixel-agents2/pixel.db`);
const rows = db.prepare('SELECT name, data FROM layouts').all() as Array<{ name: string; data: string }>;
const update = db.prepare('UPDATE layouts SET data = ? WHERE name = ?');

for (const row of rows) {
  if (only && !row.name.startsWith(`${only}/`)) continue;
  const l = JSON.parse(row.data) as OfficeLayout;
  const { cols, rows: R } = l;
  const tiles = l.tiles as number[];
  const wallCells: number[] = [];
  for (let i = 0; i < tiles.length; i++) if (tiles[i] === TileType.WALL) wallCells.push(i);
  if (wallCells.length === 0) {
    console.log(`· ${row.name}: no WALL cells`);
    continue;
  }

  const walls = emptyWallEdges(cols, R);
  const latticeSet: number[] = new Array((cols + 1) * (R + 1)).fill(0);
  const latticeColor: Array<number | null> = new Array((cols + 1) * (R + 1)).fill(null);
  const isWallCell = (c: number, r: number): boolean =>
    c >= 0 && r >= 0 && c < cols && r < R && tiles[r * cols + c] === TileType.WALL;

  for (const i of wallCells) {
    const c = i % cols;
    const r = Math.floor(i / cols);
    const placed: Array<[number, number]> = []; // lattice points this cell's edges touch
    if (!isWallCell(c, r - 1)) {
      walls.horizontal[hIndex(cols, c, r)] = true;
      placed.push([c, r], [c + 1, r]);
    }
    if (!isWallCell(c - 1, r)) {
      walls.vertical[vIndex(cols, c, r)] = true;
      placed.push([c, r], [c, r + 1]);
    }
    // Carry the cell's wall set/swatch onto the lattice points its edges touch,
    // so a migrated wall keeps the exact style it was painted with.
    for (const [lc, lr] of placed) {
      const li = latticeIndex(cols, lc, lr);
      latticeSet[li] = l.tileWallSet?.[i] ?? 0;
      latticeColor[li] = l.tileColors?.[i] ?? null;
    }
  }
  walls.latticeSet = latticeSet;
  walls.latticeColor = latticeColor;

  // Former wall cells become ordinary floor — the floor we already stored for
  // beneath them (see tileWallFloorPattern), so the room reads unchanged apart
  // from being a cell wider.
  let floored = 0;
  for (const i of wallCells) {
    const pattern = l.tileWallFloorPattern?.[i] ?? null;
    tiles[i] = (pattern ?? TileType.FLOOR_1) as number;
    if (l.tileFloorSet) l.tileFloorSet[i] = l.tileWallFloorSet?.[i] ?? 0;
    if (l.tileColors) l.tileColors[i] = l.tileWallFloorColor?.[i] ?? null;
    floored++;
  }

  l.walls = walls;
  delete l.tileWallSet;
  delete l.tileWallMask;
  delete l.tileWallFloorPattern;
  delete l.tileWallFloorSet;
  delete l.tileWallFloorColor;

  const vCount = walls.vertical.filter(Boolean).length;
  const hCount = walls.horizontal.filter(Boolean).length;
  update.run(JSON.stringify(l), row.name);
  console.log(`✓ ${row.name}: ${wallCells.length} wall cells → ${vCount} vertical + ${hCount} horizontal edges, ${floored} cells now floor`);
}
db.close();
