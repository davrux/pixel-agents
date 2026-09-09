import { TileType } from '../types.js';
import type { WallEdges, GroundMap } from '../types.js';
import { crossingBlocked } from '../wallEdges.js';

/**
 * Can you step from one 4-adjacent cell to another? "Walkable" is about the
 * destination cell; this is about the boundary between the two, which is where
 * a wall lives in the edge model (see wallEdges.ts). Every neighbour expansion
 * in this file goes through here — a walkable cell you can't reach because a
 * wall stands between you and it is exactly what edge walls express.
 */
export function canStep(
  fromCol: number,
  fromRow: number,
  toCol: number,
  toRow: number,
  tileMap: GroundMap,
  blockedTiles: Set<string>,
  walls?: WallEdges,
): boolean {
  if (!isWalkable(toCol, toRow, tileMap, blockedTiles)) return false;
  const cols = tileMap.length > 0 ? tileMap[0].length : 0;
  return !crossingBlocked(walls, cols, fromCol, fromRow, toCol, toRow);
}

/** Can an entity STAND on this cell: in bounds, not VOID, not blocked by
 *  furniture or a tileBlocked flag. Walls don't appear here — a wall is an edge
 *  between cells, so it's canStep above that refuses to cross one. */
export function isWalkable(
  col: number,
  row: number,
  tileMap: GroundMap,
  blockedTiles: Set<string>,
): boolean {
  // Not-a-tile first, and not as belt-and-braces: `undefined < 0` and
  // `undefined >= rows` are BOTH false, so a bad coordinate sailed straight
  // through the range check into `tileMap[undefined][undefined]` — a TypeError
  // that killed whatever was asking. It cost a player their zone: a stored spawn
  // position of `{}` (see appStore.getPlayerPos) made every join throw
  // "Cannot read properties of undefined (reading 'undefined')" during
  // matchmaking. A coordinate that isn't a tile index simply isn't walkable.
  if (!Number.isInteger(col) || !Number.isInteger(row)) return false;
  const rows = tileMap.length;
  const cols = rows > 0 ? tileMap[0].length : 0;
  if (row < 0 || row >= rows || col < 0 || col >= cols) return false;
  const t = tileMap[row][col];
  if (t === TileType.VOID) return false;
  if (blockedTiles.has(`${col},${row}`)) return false;
  return true;
}

/** Get walkable tile positions (grid coords) for wandering */
export function getWalkableTiles(
  tileMap: GroundMap,
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
  tileMap: GroundMap,
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

/**
 * The four steps a pawn may take. Exported because it is the AUTHORITY on the grid being
 * 4-connected — `wallEdges.ts` already refers to it by name for that reason, and a second copy in
 * a caller is a second place where a diagonal could quietly appear.
 */
export const DIRS_4 = [
  { dc: 0, dr: -1 }, // up
  { dc: 0, dr: 1 }, // down
  { dc: -1, dr: 0 }, // left
  { dc: 1, dr: 0 }, // right
];

/** BFS pathfinding on 4-connected grid (no diagonals), uniform cost. Returns
 *  path excluding start, including end. The hot path — pet wandering, seats,
 *  appliance approach, etc. — none of which need to avoid anything.
 *
 *  `maxSteps` bounds the search in STEPS, inclusively: a path of exactly that many steps is
 *  still returned, and nothing beyond the bound is ever enqueued. See `findPath` for why a
 *  caller wants one. */
function bfsPath(
  startCol: number,
  startRow: number,
  endCol: number,
  endRow: number,
  tileMap: GroundMap,
  blockedTiles: Set<string>,
  walls?: WallEdges,
  maxSteps?: number,
): Array<{ col: number; row: number }> {
  const key = (c: number, r: number) => `${c},${r}`;
  const startKey = key(startCol, startRow);
  const endKey = key(endCol, endRow);

  const visited = new Set<string>();
  visited.add(startKey);

  const parent = new Map<string, string>();
  // A head index rather than `queue.shift()` — the shape `pathAwayFrom` already uses. The
  // traversal order is identical, so every path this returns is the one it returned before; what
  // goes away is the shifting, and a search that fails on uponu shifted a ~2600-element array
  // ~2600 times. Measured over uponu: a failing whole-component search 1302 → 1150 µs, a long
  // path that exists 3191 → 2875 µs. That is 11-13 %, not a factor — V8's shift is better than it
  // looks — so take it for what it is: free, uniform, and not the fix for anything. What made the
  // expensive cases cheap is bounding them (see `maxSteps`).
  const queue: Array<{ col: number; row: number; steps: number }> = [
    { col: startCol, row: startRow, steps: 0 },
  ];

  for (let head = 0; head < queue.length; head++) {
    const curr = queue[head];
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

    // The goal is matched when a node is POPPED, above — which is what makes the bound
    // inclusive: a node reached in exactly `maxSteps` steps still answers before its own
    // neighbours are refused here.
    if (maxSteps !== undefined && curr.steps >= maxSteps) continue;

    for (const d of DIRS_4) {
      const nc = curr.col + d.dc;
      const nr = curr.row + d.dr;
      const nk = key(nc, nr);

      if (visited.has(nk)) continue;
      if (!canStep(curr.col, curr.row, nc, nr, tileMap, blockedTiles, walls)) continue;

      visited.add(nk);
      parent.set(nk, currKey);
      queue.push({ col: nc, row: nr, steps: curr.steps + 1 });
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
 *  uniform-cost case stays on the cheaper plain BFS above.
 *
 *  `maxSteps` is honoured here too, and it counts STEPS rather than cost. That distinction is the
 *  whole reason a step is carried alongside the cost: `AVOID_TILE_COST` is 8, so a legal 12-step
 *  route across one avoided tile costs 19 — a cap read off the cost would refuse a path well
 *  inside the step bound while claiming to be one.
 *
 *  What a bounded Dijkstra gives up, stated rather than papered over: the cost-settled `visited`
 *  set makes it INCOMPLETE under a step cap, because a node settled by a cheap long route can
 *  hide an expensive short one that would have reached the goal inside the bound. The two
 *  guarantees are "never expands past `maxSteps`" and "never returns a path longer than
 *  `maxSteps`"; completeness is not among them. Today's only bounded caller passes no
 *  `avoidTiles` and therefore takes the BFS branch. The fix, if one is ever needed, is a Pareto
 *  frontier keyed by (node, steps) — don't build it without a caller. */
function dijkstraPath(
  startCol: number,
  startRow: number,
  endCol: number,
  endRow: number,
  tileMap: GroundMap,
  blockedTiles: Set<string>,
  avoidTiles: Set<string>,
  walls?: WallEdges,
  maxSteps?: number,
): Array<{ col: number; row: number }> {
  const key = (c: number, r: number) => `${c},${r}`;
  const startKey = key(startCol, startRow);
  const endKey = key(endCol, endRow);

  const dist = new Map<string, number>([[startKey, 0]]);
  const parent = new Map<string, string>();
  const visited = new Set<string>();

  // Binary min-heap of [cost, col, row, steps] — ordered by cost, with the step count carried
  // along so `maxSteps` can be honoured without confusing the two.
  const heap: Array<[number, number, number, number]> = [[0, startCol, startRow, 0]];
  const heapPush = (item: [number, number, number, number]): void => {
    heap.push(item);
    let i = heap.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (heap[p][0] <= heap[i][0]) break;
      [heap[p], heap[i]] = [heap[i], heap[p]];
      i = p;
    }
  };
  const heapPop = (): [number, number, number, number] | undefined => {
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
    const [cost, col, row, steps] = heapPop()!;
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
    if (maxSteps !== undefined && steps >= maxSteps) continue;
    for (const d of DIRS_4) {
      const nc = col + d.dc;
      const nr = row + d.dr;
      const nk = key(nc, nr);
      if (visited.has(nk)) continue;
      if (!canStep(col, row, nc, nr, tileMap, blockedTiles, walls)) continue;
      const nd = cost + (avoidTiles.has(nk) ? AVOID_TILE_COST : 1);
      if ((dist.get(nk) ?? Infinity) <= nd) continue;
      dist.set(nk, nd);
      parent.set(nk, k);
      heapPush([nd, nc, nr, steps + 1]);
    }
  }
  return [];
}

/** Pathfinding on a 4-connected grid (no diagonals). Returns path excluding
 *  start, including end. `avoidTiles` (e.g. tile actions a plain walk-click
 *  shouldn't cut through) makes entering those tiles cost more instead of
 *  blocking them outright — a detour wins when one exists, but the tile is
 *  still reachable (including as the destination itself) when there's none.
 *
 *  **`maxSteps` bounds the search, and without one what bounds it is the reachable walkable
 *  component — i.e. the whole map.** That is fine for a click, whose target the player can see,
 *  and wrong for anything asked on a cadence: a search that CANNOT reach its target is the most
 *  expensive kind, because it exhausts everything it can reach before saying no. `pathAwayFrom`
 *  was rewritten around that fact for the flee half of a chase (428 µs → ~30); the chase half
 *  passes `PET_CHASE_RANGE_TILES` here for the same reason. Both branches honour it, because a
 *  bound only one of them respects is a bound that lies.
 *
 *  A tenth positional parameter is the trigger to turn these into an options object; nine is
 *  already one too many, and converting twenty call sites inside a perf fix would bury it. */
export function findPath(
  startCol: number,
  startRow: number,
  endCol: number,
  endRow: number,
  tileMap: GroundMap,
  blockedTiles: Set<string>,
  avoidTiles?: Set<string>,
  walls?: WallEdges,
  maxSteps?: number,
): Array<{ col: number; row: number }> {
  if (startCol === endCol && startRow === endRow) return [];
  // End must be walkable (or be a chair tile which may be adjacent to desk)
  // We allow the end tile even if it's not strictly walkable for chair positions
  if (!isWalkable(endCol, endRow, tileMap, blockedTiles)) return [];
  // Manhattan distance is a lower bound on the number of 4-connected steps (each step changes it
  // by one), so a target beyond the bound costs no search at all. It does NOT address the case the
  // bound exists for — a quarry five tiles away behind a wall is well inside Manhattan reach — so
  // don't mistake this line for the fix.
  if (maxSteps !== undefined && Math.abs(endCol - startCol) + Math.abs(endRow - startRow) > maxSteps) return [];
  if (!avoidTiles || avoidTiles.size === 0) {
    return bfsPath(startCol, startRow, endCol, endRow, tileMap, blockedTiles, walls, maxSteps);
  }
  return dijkstraPath(startCol, startRow, endCol, endRow, tileMap, blockedTiles, avoidTiles, walls, maxSteps);
}
