/**
 * Server-side fluid flow — a Minecraft/Luanti-style finite liquid, recomputed to
 * equilibrium in a bounded box whenever an edit near the fluid happens. Sources are
 * infinite + fixed; flowing levels (1..maxLevel) are derived by a flood from the
 * sources: the fluid falls into air below (landing near-full = level 1) and, where it
 * can't fall, spreads sideways one level thinner each block up to maxLevel. Flowing
 * cells no longer reached by any source recede to air. So digging a hole in a lakebed
 * lets it pour in; breaking a dam floods outward then thins; walling off + removing the
 * source drains it. Generalised over any FluidDef (water OR lava) — the OTHER fluid is
 * treated as a solid wall, so water and lava never overwrite each other.
 */
import { WATER_FLUID, fluidLevel, fluidFlowId, type FluidDef } from '@pixel/shared';

export interface Cell {
  x: number;
  y: number;
  z: number;
  id: number;
}
interface Grid {
  getBlock(x: number, y: number, z: number): number;
}

const DOWN = 24; // how far the fluid may fall within one settle
const key = (x: number, y: number, z: number): string => `${x},${y},${z}`;

/** Recompute flowing fluid (default water) in a box around (ex,ey,ez); returns the
 *  changed cells. Pass LAVA_FLUID to settle lava instead. */
export function settleAround(w: Grid, ex: number, ey: number, ez: number, fluid: FluidDef = WATER_FLUID): Cell[] {
  const R = fluid.maxLevel; // horizontal reach from an edit
  // This fluid's own ids (source + its flowing range); anything else — air aside — is a wall.
  const sameFluid = (id: number): boolean => id === fluid.source || (id >= fluid.flowMin && id <= fluid.flowMax);
  const isSolid = (id: number): boolean => id !== 0 && !sameFluid(id);
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
        if (id === fluid.source) relax(x, y, z, 0);
        else if (sameFluid(id) && !inInner(x, y, z)) relax(x, y, z, fluidLevel(fluid, id));
      }

  // The fluid spreads into cells it can occupy: air OR its own existing flow (which is
  // fluid, not a wall — so re-settling re-levels it instead of treating it as blocked
  // and receding it, which caused oscillation). Sources/solids/other fluids are not fillable.
  const fillable = (id: number): boolean => id === 0 || (sameFluid(id) && id !== fluid.source);

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
    } else if (L < fluid.maxLevel) {
      for (const [dx, dz] of HORIZ) if (fillable(w.getBlock(x + dx, y, z + dz))) relax(x + dx, y, z + dz, L + 1);
    }
  }

  // Source flood ("the lake grows"): from every source, claim horizontally-connected
  // water on a solid/water floor (not falling) at the SAME level as full source. So a
  // dug basin/channel beside a lake fills with flat, full water — part of the lake —
  // instead of stepped flowing water. Falling water (air below) stays flowing.
  const srcQ: string[] = [];
  for (const [k, lv] of level) if (lv === 0) srcQ.push(k);
  const claimed = new Set(srcQ);
  while (srcQ.length) {
    const [x, y, z] = srcQ.pop()!.split(',').map(Number);
    for (const [dx, dz] of HORIZ) {
      const nk = key(x + dx, y, z + dz);
      if (claimed.has(nk)) continue;
      const nlv = level.get(nk);
      if (nlv === undefined || nlv < 1) continue; // only flowing cells become source
      if (w.getBlock(x + dx, y - 1, z + dz) === 0) continue; // falling → keep flowing
      level.set(nk, 0);
      claimed.add(nk);
      srcQ.push(nk);
    }
  }

  // Diff the INNER box: promoted cells → source (full), flow cells → their level,
  // unreached flow → air. Existing sources and solids are never touched.
  const changes: Cell[] = [];
  for (let y = y0; y <= y1; y++)
    for (let z = z0; z <= z1; z++)
      for (let x = x0; x <= x1; x++) {
        const cur = w.getBlock(x, y, z);
        if (cur === fluid.source || isSolid(cur)) continue; // fixed
        const lv = inInner(x, y, z) ? level.get(key(x, y, z)) : undefined;
        const want = lv === undefined ? 0 : lv === 0 ? fluid.source : fluidFlowId(fluid, lv);
        if (want !== cur) changes.push({ x, y, z, id: want });
      }
  return changes;
}
