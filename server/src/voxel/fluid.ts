/**
 * Server-side fluid flow — a Luanti-style cellular automaton that spreads/recedes
 * GRADUALLY over sim ticks (not instantly), so water visibly flows out and lava
 * creeps slowly. One `stepFluid` call advances the flow by ONE cell-generation for
 * the cells in an "active" set; the room ticks it (water every tick, lava every
 * `viscosity` ticks) and feeds the changed cells' neighbours back in until the pool
 * reaches equilibrium. Levels follow Luanti: a source is full; flowing levels thin
 * by one each block away from the source (our ids: level 1 = thick/near source ..
 * maxLevel = thin/far), and water falling from above fills to thick. A flowing cell
 * with no path back to a source keeps thinning each tick until it dries to air, so
 * cut-off water recedes. Water is renewable (2+ source neighbours on a floor make a
 * new source); lava is not. Each fluid treats the OTHER as a solid wall.
 */
import { fluidFlowId, isPlant, type FluidDef } from '@pixel/shared';

export interface Cell {
  x: number;
  y: number;
  z: number;
  id: number;
}
interface Grid {
  getBlock(x: number, y: number, z: number): number;
}

const key = (x: number, y: number, z: number): string => `${x},${y},${z}`;
const HORIZ = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
];
const NB6 = [
  [1, 0, 0],
  [-1, 0, 0],
  [0, 1, 0],
  [0, -1, 0],
  [0, 0, 1],
  [0, 0, -1],
];

/** Advance the fluid one cell-generation over `active`; returns the changed cells and
 *  the next active set (neighbours of anything that changed + neighbours a source
 *  drives). `budget` caps cells processed per call; the rest are carried to `next`. */
export function stepFluid(w: Grid, active: Set<string>, fluid: FluidDef, budget = 6000): { changes: Cell[]; next: Set<string> } {
  const changes: Cell[] = [];
  const next = new Set<string>();
  const sameFluid = (id: number): boolean => id === fluid.source || (id >= fluid.flowMin && id <= fluid.flowMax);
  // level: 0 = source, 1..maxLevel = flowing (1 thick/near source), -1 = not this fluid.
  const lvlOf = (id: number): number => (id === fluid.source ? 0 : id >= fluid.flowMin && id <= fluid.flowMax ? id - fluid.flowMin + 1 : -1);

  let n = 0;
  for (const k of active) {
    if (n++ >= budget) {
      next.add(k); // over budget this tick — reconsider next tick
      continue;
    }
    const [x, y, z] = k.split(',').map(Number);
    const cur = w.getBlock(x, y, z);

    // A source is fixed but DRIVES flow: keep its down + side neighbours active so the
    // pool starts/refills. (It never changes, so it won't re-add itself → no churn.)
    if (cur === fluid.source) {
      next.add(key(x, y - 1, z));
      for (const [dx, dz] of HORIZ) next.add(key(x + dx, y, z + dz));
      continue;
    }
    // Non-solid plants (flowers/grass/crops/fire) are "buildable_to": the fluid flows
    // INTO them and replaces them (Luanti). Real solids and the OTHER fluid are walls.
    const isPlantCell = cur !== 0 && !sameFluid(cur) && isPlant(cur);
    if (cur !== 0 && !sameFluid(cur) && !isPlantCell) continue;

    // cur is air / this fluid's flow / a replaceable plant → recompute its target level.
    let target = -1; // -1 = should be air (dry)
    const above = w.getBlock(x, y + 1, z);
    if (sameFluid(above)) {
      target = 1; // fed from above → falling, fills to thick
    } else {
      let best = Infinity;
      let srcNeighbours = 0;
      for (const [dx, dz] of HORIZ) {
        const L = lvlOf(w.getBlock(x + dx, y, z + dz));
        if (L === 0) {
          best = Math.min(best, 1);
          srcNeighbours++;
        } else if (L >= 1 && L < fluid.maxLevel) {
          best = Math.min(best, L + 1);
        }
      }
      // Renewable (water): 2+ source neighbours + solid/fluid support below → new source.
      if (fluid.renewable && srcNeighbours >= 2 && w.getBlock(x, y - 1, z) !== 0) target = 0;
      else if (best !== Infinity) target = best;
    }

    // A plant is only overrun when fluid actually reaches it (target ≥ 0); otherwise
    // leave it standing (don't clear it to air just because it's not a fluid).
    if (isPlantCell && target < 0) continue;
    const newId = target < 0 ? 0 : target === 0 ? fluid.source : fluidFlowId(fluid, target);
    if (newId !== cur) {
      changes.push({ x, y, z, id: newId });
      next.add(k); // may keep changing (e.g. thinning further) — revisit
      for (const [a, b, c] of NB6) next.add(key(x + a, y + b, z + c));
    }
  }
  return { changes, next };
}

/** Cells to (re)activate when the world is edited at (x,y,z): the cell + its 6
 *  neighbours, so any adjacent fluid re-evaluates the change on the next tick. */
export function seedCells(x: number, y: number, z: number): string[] {
  const out = [key(x, y, z)];
  for (const [a, b, c] of NB6) out.push(key(x + a, y + b, z + c));
  return out;
}
