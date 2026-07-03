/**
 * Server-side water flow — a Minecraft/Luanti-style finite liquid, recomputed to
 * equilibrium in a bounded box whenever an edit near water happens. Sources (id 27,
 * lakes/seas) are infinite + fixed; flowing water (levels 1..7) is derived by a
 * flood from the sources: it falls into air below (landing near-full = level 1) and,
 * where it can't fall, spreads sideways one level thinner each block up to level 7.
 * Flowing cells no longer reached by any source recede to air. So digging a hole in
 * a lakebed lets water pour in; breaking a dam floods outward then thins; walling
 * off + removing the source drains it.
 */
import { WATER_SOURCE, WATER_MAX_LEVEL, isWaterId, waterLevel, flowId } from '@pixel/shared';

export interface Cell {
  x: number;
  y: number;
  z: number;
  id: number;
}
interface Grid {
  getBlock(x: number, y: number, z: number): number;
}

const R = WATER_MAX_LEVEL; // horizontal reach from an edit
const DOWN = 24; // how far water may fall within one settle
const key = (x: number, y: number, z: number): string => `${x},${y},${z}`;
const isSolid = (id: number): boolean => id !== 0 && !isWaterId(id);

/** Recompute flowing water in a box around (ex,ey,ez); returns the changed cells. */
export function settleAround(w: Grid, ex: number, ey: number, ez: number): Cell[] {
  const x0 = ex - R,
    x1 = ex + R,
    z0 = ez - R,
    z1 = ez + R,
    y0 = ey - DOWN,
    y1 = ey + 2;
  // Inner box = cells we may rewrite; padded by 1 = read-only context (inflow from
  // neighbouring water outside the edited box).
  const inInner = (x: number, y: number, z: number): boolean => x >= x0 && x <= x1 && y >= y0 && y <= y1 && z >= z0 && z <= z1;

  const level = new Map<string, number>(); // cell → best water level (0 source .. 7)
  const queue: [number, number, number][] = [];
  const relax = (x: number, y: number, z: number, lv: number): void => {
    const k = key(x, y, z);
    if (lv < (level.get(k) ?? 99)) {
      level.set(k, lv);
      queue.push([x, y, z]);
    }
  };

  // Seed: sources (infinite, level 0) anywhere, plus water on the padding ring
  // (inflow from outside the edited box). Interior FLOW is deliberately NOT seeded —
  // it must be re-derived from sources/inflow so cut-off water recedes.
  for (let y = y0 - 1; y <= y1 + 1; y++)
    for (let z = z0 - 1; z <= z1 + 1; z++)
      for (let x = x0 - 1; x <= x1 + 1; x++) {
        const id = w.getBlock(x, y, z);
        if (id === WATER_SOURCE) relax(x, y, z, 0);
        else if (isWaterId(id) && !inInner(x, y, z)) relax(x, y, z, waterLevel(id));
      }

  // Water spreads into cells it can occupy: air OR existing flowing water (which is
  // fluid, not a wall — so re-settling re-levels it instead of treating it as blocked
  // and receding it, which caused oscillation). Sources/solids are not fillable.
  const fillable = (id: number): boolean => id === 0 || (isWaterId(id) && id !== WATER_SOURCE);

  // Flood: fall into a fillable cell below (→ level 1), else spread sideways (level+1 ≤ 7).
  const HORIZ = [
    [1, 0],
    [-1, 0],
    [0, 1],
    [0, -1],
  ];
  while (queue.length) {
    const [x, y, z] = queue.pop()!;
    const L = level.get(key(x, y, z))!;
    if (fillable(w.getBlock(x, y - 1, z))) {
      relax(x, y - 1, z, 1); // falls, lands near-full
    } else if (L < WATER_MAX_LEVEL) {
      for (const [dx, dz] of HORIZ) if (fillable(w.getBlock(x + dx, y, z + dz))) relax(x + dx, y, z + dz, L + 1);
    }
  }

  // Diff the INNER box: air/flow cells become the computed level; unreached flow
  // recedes to air. Sources and solids are never touched.
  const changes: Cell[] = [];
  for (let y = y0; y <= y1; y++)
    for (let z = z0; z <= z1; z++)
      for (let x = x0; x <= x1; x++) {
        const cur = w.getBlock(x, y, z);
        if (cur === WATER_SOURCE || isSolid(cur)) continue; // fixed
        const lv = level.get(key(x, y, z));
        const want = lv !== undefined && lv >= 1 && inInner(x, y, z) ? flowId(lv) : 0;
        if (want !== cur) changes.push({ x, y, z, id: want });
      }
  return changes;
}
