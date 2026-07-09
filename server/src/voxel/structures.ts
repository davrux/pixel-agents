/**
 * Procedural STRUCTURES stamped into the seed-based terrain (server-authoritative).
 *
 * A structure is a pure per-cell field: `blockAt(wx,wy,wz)` returns a block id to force
 * at that world cell (0 = air, i.e. carve), or `null` to leave the terrain untouched.
 * `bounds` is a cheap AABB so the generator only queries structures near a cell. Because
 * it's stateless + deterministic, chunks stay reproducible and re-generate identically.
 *
 * This is the shared mechanism for authored-looking content in a generated world — the
 * castle below is the first user; **dungeons will plug in the same way** (add a
 * `buildDungeon(...)` returning a StructureGen and hand it out from `worldStructures`,
 * e.g. scattered by a seed-hash). Keep structure logic here, not in gen.ts.
 */
import { surfaceHeight } from '@pixel/shared';

export interface StructureGen {
  /** World-space AABB (inclusive) — gen.ts skips structures whose box excludes the cell. */
  bounds: { x0: number; y0: number; z0: number; x1: number; y1: number; z1: number };
  /** Forced block id at a world cell (0 = carve to air), or null to keep the terrain. */
  blockAt(wx: number, wy: number, wz: number): number | null;
}

// Block ids (mirror blocks.ts / gen.ts).
const AIR = 0;
const STONE = 3;
const COBBLE = 4;
const GLASS = 14;
const PLANKS = 18;
const LADDER = 32;
const TORCH = 33;
const DOOR = 35; // closed door (2-tall; place at both cells)
const STONE_BRICK = 66;
const SANDSTONE_BRICK = 67; // paler → keep + towers stand out from the grey walls

/**
 * A stylised, enterable fairy-tale castle centred on (cx,cz): a plinth levelling the
 * ground, a crenellated curtain wall with a front gate arch, four corner towers, and a
 * central hollow keep (door, windows, two floors joined by a ladder, spire). Blocky —
 * our palette has no slopes — but recognisable and walkable.
 */
export function buildCastle(cx: number, cz: number, seed: number): StructureGen {
  const baseY = surfaceHeight(cx, cz, seed); // courtyard floor sits at the centre's ground level
  const OUT = 11; // curtain-wall half-extent (23×23 core)
  const WALL_H = 6; // wall height above the floor
  const TOWER_H = 11; // corner-tower height
  const KEEP = 4; // keep half-extent (9×9)
  const KEEP_DZ = 5; // keep pushed toward +Z (back) → open courtyard (incl. spawn at 0,0) + gate at the front (−Z)
  const KEEP_H = 15; // keep height
  const FLOOR2 = 7; // keep's second floor
  const PLINTH = 16; // how deep the stone base fills below the floor

  const crenel = (a: number, b: number): number => ((a + b) & 1 ? SANDSTONE_BRICK : AIR); // battlement teeth

  // Corner tower shell (3×3 at each corner, hollow 1-cell core → decorative), rel. coords.
  const towerBlock = (ax: number, az: number, dx: number, dz: number, ly: number): number | null => {
    if (ly > TOWER_H) return AIR; // clear anything above the tower
    if (ly === TOWER_H) return crenel(dx, dz); // crenellated top
    if (ly < 0) return STONE;
    const onShell = ax === OUT + 1 || az === OUT + 1 || ax === OUT - 1 || az === OUT - 1;
    return onShell ? SANDSTONE_BRICK : AIR; // shell walls, hollow inside
  };

  // Central keep (hollow, enterable), coords relative to the keep centre (kx,kz).
  const keepBlock = (kx: number, kz: number, ly: number): number | null => {
    const kr = Math.max(Math.abs(kx), Math.abs(kz));
    if (ly < 0) return STONE; // plinth under the keep
    if (ly === 0) return COBBLE; // ground floor
    // Spire: a thin post above the roof centre.
    if (kr === 0 && ly > KEEP_H && ly <= KEEP_H + 4) return PLANKS;
    if (ly > KEEP_H + 4) return AIR;
    if (ly > KEEP_H) return kr === 0 ? PLANKS : AIR; // spire column, rest cleared
    if (ly === KEEP_H) return kr === KEEP ? crenel(kx, kz) : PLANKS; // roof + crenellations
    if (kr === KEEP) {
      // Outer keep wall: front door (−Z), else windows at two levels, else brick.
      if (kz === -KEEP && kx === 0 && (ly === 1 || ly === 2)) return AIR; // doorway (door placed below)
      if ((ly === 3 || ly === 9) && (Math.abs(kx) === 2 || Math.abs(kz) === 2)) return GLASS; // windows
      return SANDSTONE_BRICK;
    }
    // Interior (hollow). Second floor of planks with a hatch at the ladder cell.
    const ladderCell = kx === 0 && kz === KEEP - 1; // against the back (+Z) wall
    if (ly === FLOOR2 && !ladderCell) return PLANKS;
    if (ladderCell && ly >= 1 && ly <= KEEP_H - 1) return LADDER; // climb ground→roof
    if (kz === -KEEP + 1 && kx === 0 && ly === 1) return AIR; // keep the doorway clear inside
    // A torch on the interior back wall for light.
    if (kx === 0 && kz === KEEP - 1 && (ly === 3 || ly === 10)) return TORCH;
    return AIR;
  };

  return {
    bounds: { x0: cx - OUT - 1, y0: baseY - PLINTH, z0: cz - OUT - 1, x1: cx + OUT + 1, y1: baseY + KEEP_H + 5, z1: cz + OUT + 1 },
    blockAt(wx, wy, wz) {
      const dx = wx - cx,
        dz = wz - cz,
        ly = wy - baseY;
      const ax = Math.abs(dx),
        az = Math.abs(dz);
      const ring = Math.max(ax, az);

      // Keep (offset toward the back).
      const kx = dx,
        kz = dz - KEEP_DZ;
      if (Math.max(Math.abs(kx), Math.abs(kz)) <= KEEP) return keepBlock(kx, kz, ly);

      if (ring > OUT + 1) return null; // outside the whole footprint → terrain
      if (ly < -PLINTH) return null;
      if (ly < 0) return STONE; // plinth: level the ground up to the floor

      // Corner towers (3×3 around each corner).
      if (ax >= OUT - 1 && az >= OUT - 1) return towerBlock(ax, az, dx, dz, ly);

      // Curtain wall on the perimeter ring.
      if (ring === OUT) {
        if (ly > WALL_H) return AIR;
        if (ly === WALL_H) return crenel(dx, dz); // battlements
        if (dz === -OUT && Math.abs(dx) <= 1 && ly >= 1 && ly <= 3) return AIR; // front gate arch
        return STONE_BRICK;
      }
      if (ring > OUT) return null; // (towers handled; nothing else beyond the wall)

      // Courtyard interior.
      if (ly === 0) return COBBLE; // floor
      if (ly === 1 && ax === OUT - 2 && az === OUT - 2) return TORCH; // corner floor torches
      return AIR; // open courtyard air (also clears any terrain poking in)
    },
  };
}

/** Structures for a world. A world id of `castle` gets one castle at the origin; extend
 *  this for other authored worlds and (later) seed-scattered dungeons. */
export function worldStructures(worldId: string, seed: number): StructureGen[] {
  if (worldId === 'castle') return [buildCastle(0, 0, seed)];
  return [];
}
