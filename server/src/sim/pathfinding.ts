import type { BuildingTemplate } from '@pixel/shared';
import { isWalkable } from '@pixel/shared';

export interface Cell {
  col: number;
  row: number;
}

/**
 * Breadth-first search on the 4-connected tile grid (no diagonals), matching
 * the original engine. Returns the path from start to goal EXCLUDING the start
 * tile and INCLUDING the goal, or an empty array if unreachable / already there.
 *
 * The goal tile itself may be blocked (e.g. a chair the character sits "on");
 * pass allowGoalBlocked=true to permit stepping onto it as the final tile.
 */
export function findPath(
  start: Cell,
  goal: Cell,
  t: BuildingTemplate,
  blocked: Set<string>,
  allowGoalBlocked = true,
): Cell[] {
  if (start.col === goal.col && start.row === goal.row) return [];

  const key = (c: number, r: number) => `${c},${r}`;
  const goalKey = key(goal.col, goal.row);
  const visited = new Set<string>([key(start.col, start.row)]);
  const prev = new Map<string, string>();
  const queue: Cell[] = [start];
  const dirs = [
    [0, 1],
    [0, -1],
    [1, 0],
    [-1, 0],
  ];

  let found = false;
  while (queue.length > 0) {
    const cur = queue.shift()!;
    if (cur.col === goal.col && cur.row === goal.row) {
      found = true;
      break;
    }
    for (const [dc, dr] of dirs) {
      const nc = cur.col + dc;
      const nr = cur.row + dr;
      const nk = key(nc, nr);
      if (visited.has(nk)) continue;
      const isGoal = nk === goalKey;
      const walkable = isWalkable(nc, nr, t, blocked) || (isGoal && allowGoalBlocked);
      if (!walkable) continue;
      visited.add(nk);
      prev.set(nk, key(cur.col, cur.row));
      queue.push({ col: nc, row: nr });
    }
  }

  if (!found) return [];

  // Reconstruct.
  const path: Cell[] = [];
  let curKey = goalKey;
  const startKey = key(start.col, start.row);
  while (curKey !== startKey) {
    const [c, r] = curKey.split(',').map(Number);
    path.push({ col: c, row: r });
    const p = prev.get(curKey);
    if (!p) break;
    curKey = p;
  }
  path.reverse();
  return path;
}

/** Pick a random walkable tile (for wandering). */
export function randomWalkable(
  t: BuildingTemplate,
  blocked: Set<string>,
  rng: () => number = Math.random,
): Cell {
  for (let attempt = 0; attempt < 50; attempt++) {
    const col = 1 + Math.floor(rng() * (t.cols - 2));
    const row = 1 + Math.floor(rng() * (t.rows - 2));
    if (isWalkable(col, row, t, blocked)) return { col, row };
  }
  return { col: 1, row: 1 };
}
