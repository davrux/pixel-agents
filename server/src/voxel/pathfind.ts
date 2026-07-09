/**
 * Server-side A* over the voxel world for NPC movement (and future click-to-walk).
 * Nodes are standable cells: solid non-water ground below, two air cells for the
 * body. Steps go to the 4 horizontal neighbours at the same height or ±1 (walk up/
 * down one block). Bounded by maxNodes so a blocked/foolish goal can't stall the
 * tick. Returns the list of cells from just-after-start to the goal, or null.
 */
import { isWaterId } from '@pixel/shared';

interface Vec {
  x: number;
  y: number;
  z: number;
}
interface Grid {
  getBlock(x: number, y: number, z: number): number;
}

/** A cell you can stand in: ground (solid, not water) below + body space clear. */
function standable(w: Grid, x: number, y: number, z: number): boolean {
  const below = w.getBlock(x, y - 1, z);
  if (below === 0 || isWaterId(below)) return false; // need solid, dry ground
  return w.getBlock(x, y, z) === 0 && w.getBlock(x, y + 1, z) === 0; // body clear
}

/** The standable y at column (x,z) nearest to `nearY` (checks nearY, ±1), or null. */
function stepY(w: Grid, x: number, z: number, nearY: number): number | null {
  for (const dy of [0, 1, -1]) if (standable(w, x, nearY + dy, z)) return nearY + dy;
  return null;
}

const key = (x: number, y: number, z: number): string => `${x},${y},${z}`;
const DIRS: [number, number][] = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
];

/** A* path of cells from `start` to `goal` (inclusive of goal, excluding start),
 *  or null if unreachable within maxNodes. Coordinates are integer feet cells. */
export function findPath(w: Grid, start: Vec, goal: Vec, maxNodes = 1200): Vec[] | null {
  const s = { x: Math.floor(start.x), y: Math.floor(start.y), z: Math.floor(start.z) };
  const g = { x: Math.floor(goal.x), y: Math.floor(goal.y), z: Math.floor(goal.z) };
  const h = (x: number, y: number, z: number): number => Math.abs(x - g.x) + Math.abs(z - g.z) + Math.abs(y - g.y) * 0.5;
  const open = new Map<string, { x: number; y: number; z: number; g: number; f: number }>();
  const came = new Map<string, string>();
  const gScore = new Map<string, number>();
  const startK = key(s.x, s.y, s.z);
  open.set(startK, { ...s, g: 0, f: h(s.x, s.y, s.z) });
  gScore.set(startK, 0);

  let nodes = 0;
  while (open.size && nodes++ < maxNodes) {
    // Pop the lowest-f open node.
    let bestK = '';
    let best = Infinity;
    for (const [k, n] of open) if (n.f < best) ((best = n.f), (bestK = k));
    const cur = open.get(bestK)!;
    open.delete(bestK);
    if (cur.x === g.x && cur.z === g.z && Math.abs(cur.y - g.y) <= 1) {
      // Reconstruct.
      const path: Vec[] = [];
      let k: string | undefined = key(cur.x, cur.y, cur.z);
      while (k && k !== startK) {
        const [x, y, z] = k.split(',').map(Number);
        path.push({ x, y, z });
        k = came.get(k);
      }
      path.reverse();
      return path.length ? path : null;
    }
    for (const [dx, dz] of DIRS) {
      const nx = cur.x + dx,
        nz = cur.z + dz;
      const ny = stepY(w, nx, nz, cur.y);
      if (ny == null) continue;
      const nk = key(nx, ny, nz);
      const tentative = cur.g + 1 + (ny !== cur.y ? 0.4 : 0);
      if (tentative < (gScore.get(nk) ?? Infinity)) {
        came.set(nk, key(cur.x, cur.y, cur.z));
        gScore.set(nk, tentative);
        open.set(nk, { x: nx, y: ny, z: nz, g: tentative, f: tentative + h(nx, ny, nz) });
      }
    }
  }
  return null;
}
