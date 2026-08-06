import { TileType } from '../types.js';

/** Check if a tile is walkable (floor, carpet, or doorway, and not blocked by furniture) */
export function isWalkable(
  col: number,
  row: number,
  tileMap: TileType[][],
  blockedTiles: Set<string>,
): boolean {
  const rows = tileMap.length;
  const cols = rows > 0 ? tileMap[0].length : 0;
  if (row < 0 || row >= rows || col < 0 || col >= cols) return false;
  const t = tileMap[row][col];
  if (t === TileType.WALL || t === TileType.VOID) return false;
  if (blockedTiles.has(`${col},${row}`)) return false;
  return true;
}

/** Get walkable tile positions (grid coords) for wandering */
export function getWalkableTiles(
  tileMap: TileType[][],
  blockedTiles: Set<string>,
): Array<{ col: number; row: number }> {
  const rows = tileMap.length;
  const cols = rows > 0 ? tileMap[0].length : 0;
  const tiles: Array<{ col: number; row: number }> = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      if (isWalkable(c, r, tileMap, blockedTiles)) {
        tiles.push({ col: c, row: r });
      }
    }
  }
  return tiles;
}

/** The walkable tile closest to (col,row) — searched outward ring by ring
 *  (Chebyshev distance) so a click on a wall, blocked floor tile, or furniture
 *  footprint still resolves to a nearby spot instead of failing outright.
 *  Returns (col,row) itself if already walkable; null if the grid has no
 *  walkable tile at all. */
export function nearestWalkableTile(
  col: number,
  row: number,
  tileMap: TileType[][],
  blockedTiles: Set<string>,
): { col: number; row: number } | null {
  if (isWalkable(col, row, tileMap, blockedTiles)) return { col, row };
  const rows = tileMap.length;
  const cols = rows > 0 ? tileMap[0].length : 0;
  const maxRadius = Math.max(rows, cols);
  for (let radius = 1; radius <= maxRadius; radius++) {
    for (let dr = -radius; dr <= radius; dr++) {
      for (let dc = -radius; dc <= radius; dc++) {
        if (Math.max(Math.abs(dc), Math.abs(dr)) !== radius) continue; // only this ring
        const c = col + dc;
        const r = row + dr;
        if (isWalkable(c, r, tileMap, blockedTiles)) return { col: c, row: r };
      }
    }
  }
  return null;
}

const DIRS_4 = [
  { dc: 0, dr: -1 }, // up
  { dc: 0, dr: 1 }, // down
  { dc: -1, dr: 0 }, // left
  { dc: 1, dr: 0 }, // right
];

/** BFS pathfinding on 4-connected grid (no diagonals), uniform cost. Returns
 *  path excluding start, including end. The hot path — NPC wandering, seats,
 *  appliance approach, etc. — none of which need to avoid anything. */
function bfsPath(
  startCol: number,
  startRow: number,
  endCol: number,
  endRow: number,
  tileMap: TileType[][],
  blockedTiles: Set<string>,
): Array<{ col: number; row: number }> {
  const key = (c: number, r: number) => `${c},${r}`;
  const startKey = key(startCol, startRow);
  const endKey = key(endCol, endRow);

  const visited = new Set<string>();
  visited.add(startKey);

  const parent = new Map<string, string>();
  const queue: Array<{ col: number; row: number }> = [{ col: startCol, row: startRow }];

  while (queue.length > 0) {
    const curr = queue.shift()!;
    const currKey = key(curr.col, curr.row);

    if (currKey === endKey) {
      const path: Array<{ col: number; row: number }> = [];
      let k = endKey;
      while (k !== startKey) {
        const [c, r] = k.split(',').map(Number);
        path.unshift({ col: c, row: r });
        k = parent.get(k)!;
      }
      return path;
    }

    for (const d of DIRS_4) {
      const nc = curr.col + d.dc;
      const nr = curr.row + d.dr;
      const nk = key(nc, nr);

      if (visited.has(nk)) continue;
      if (!isWalkable(nc, nr, tileMap, blockedTiles)) continue;

      visited.add(nk);
      parent.set(nk, currKey);
      queue.push({ col: nc, row: nr });
    }
  }
  return [];
}

/** Extra cost for entering a tile in `avoidTiles` (see findPath) — high
 *  enough that any real detour wins, but finite so a dead end still resolves
 *  by walking straight through (or onto, if it's the destination itself). */
const AVOID_TILE_COST = 8;

/** Dijkstra with a per-tile entry cost, for when some tiles should be routed
 *  around rather than cut through. A binary min-heap keeps this fast even on
 *  a 100x100 grid — this only runs when `avoidTiles` is non-empty; the
 *  uniform-cost case stays on the cheaper plain BFS above. */
function dijkstraPath(
  startCol: number,
  startRow: number,
  endCol: number,
  endRow: number,
  tileMap: TileType[][],
  blockedTiles: Set<string>,
  avoidTiles: Set<string>,
): Array<{ col: number; row: number }> {
  const key = (c: number, r: number) => `${c},${r}`;
  const startKey = key(startCol, startRow);
  const endKey = key(endCol, endRow);

  const dist = new Map<string, number>([[startKey, 0]]);
  const parent = new Map<string, string>();
  const visited = new Set<string>();

  // Binary min-heap of [cost, col, row].
  const heap: Array<[number, number, number]> = [[0, startCol, startRow]];
  const heapPush = (item: [number, number, number]): void => {
    heap.push(item);
    let i = heap.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (heap[p][0] <= heap[i][0]) break;
      [heap[p], heap[i]] = [heap[i], heap[p]];
      i = p;
    }
  };
  const heapPop = (): [number, number, number] | undefined => {
    if (heap.length === 0) return undefined;
    const top = heap[0];
    const last = heap.pop()!;
    if (heap.length > 0) {
      heap[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = 2 * i + 2;
        let smallest = i;
        if (l < heap.length && heap[l][0] < heap[smallest][0]) smallest = l;
        if (r < heap.length && heap[r][0] < heap[smallest][0]) smallest = r;
        if (smallest === i) break;
        [heap[i], heap[smallest]] = [heap[smallest], heap[i]];
        i = smallest;
      }
    }
    return top;
  };

  while (heap.length > 0) {
    const [cost, col, row] = heapPop()!;
    const k = key(col, row);
    if (visited.has(k)) continue;
    visited.add(k);
    if (k === endKey) {
      const path: Array<{ col: number; row: number }> = [];
      let cur = endKey;
      while (cur !== startKey) {
        const [c, r] = cur.split(',').map(Number);
        path.unshift({ col: c, row: r });
        cur = parent.get(cur)!;
      }
      return path;
    }
    for (const d of DIRS_4) {
      const nc = col + d.dc;
      const nr = row + d.dr;
      const nk = key(nc, nr);
      if (visited.has(nk)) continue;
      if (!isWalkable(nc, nr, tileMap, blockedTiles)) continue;
      const nd = cost + (avoidTiles.has(nk) ? AVOID_TILE_COST : 1);
      if ((dist.get(nk) ?? Infinity) <= nd) continue;
      dist.set(nk, nd);
      parent.set(nk, k);
      heapPush([nd, nc, nr]);
    }
  }
  return [];
}

/** Pathfinding on a 4-connected grid (no diagonals). Returns path excluding
 *  start, including end. `avoidTiles` (e.g. tile actions a plain walk-click
 *  shouldn't cut through) makes entering those tiles cost more instead of
 *  blocking them outright — a detour wins when one exists, but the tile is
 *  still reachable (including as the destination itself) when there's none. */
export function findPath(
  startCol: number,
  startRow: number,
  endCol: number,
  endRow: number,
  tileMap: TileType[][],
  blockedTiles: Set<string>,
  avoidTiles?: Set<string>,
): Array<{ col: number; row: number }> {
  if (startCol === endCol && startRow === endRow) return [];
  // End must be walkable (or be a chair tile which may be adjacent to desk)
  // We allow the end tile even if it's not strictly walkable for chair positions
  if (!isWalkable(endCol, endRow, tileMap, blockedTiles)) return [];
  if (!avoidTiles || avoidTiles.size === 0) {
    return bfsPath(startCol, startRow, endCol, endRow, tileMap, blockedTiles);
  }
  return dijkstraPath(startCol, startRow, endCol, endRow, tileMap, blockedTiles, avoidTiles);
}
