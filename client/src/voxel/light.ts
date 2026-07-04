/**
 * Voxel light engine — two independent channels, Minecraft/Luanti-style:
 *
 *  • skylight  — sunlight from straight above. A cell is fully sky-lit (15) while no
 *    opaque block sits anywhere above it in its column, else 0. Column tops are cached
 *    per (x,z) so vertically-stacked chunks share the scan. This is what darkens caves
 *    and building interiors while the surface stays bright.
 *  • blocklight — point light from torches / mese lamps / lava, flood-filled outward
 *    (BFS, −1 per step, blocked by opaque cells) up to RADIUS. Sources are found by
 *    scanning each chunk's own cells once (cached), so a chunk's light gathers sources
 *    from its 3×3×3 neighbourhood (RADIUS < CHUNK ⇒ that reach is enough, seam-free).
 *
 * Both are baked into per-vertex attributes (aSky / aBlock, 0..1) by the mesher; the
 * terrain shader (see main.ts) combines them with the live day/night colour so the
 * world re-lights over the day without re-meshing.
 */
import { CHUNK, chunkKey, toChunk, isFluidId, isLavaId } from '@pixel/shared';
import { AIR, TRANSPARENT, NONSOLID, TORCH_ID } from './blocks.js';
import type { VoxelWorld } from './world.js';

export const MAX_LIGHT = 15;
const RADIUS = 8; // block-light reach in levels (< CHUNK so a chunk only sees ±1 chunk of sources)
const SKY_TOP = CHUNK * 4; // top of the generated column range (see world.columnTop)
const SKY_BOTTOM = -CHUNK * 2;

/** Emission level of a light-source block (0 = not a source). */
function sourceLevel(id: number): number {
  if (id === TORCH_ID) return 13;
  if (id === 79) return 14; // mese lamp
  if (id === 80) return 13; // fire
  if (isLavaId(id)) return 12;
  return 0;
}

/** Opaque to light = a full cube that stops both channels (air, fluids, glass/leaves,
 *  torches/ladders/plants all let light through). */
function opaqueForLight(id: number): boolean {
  return id !== AIR && !isFluidId(id) && !TRANSPARENT.has(id) && !NONSOLID.has(id);
}

// Highest opaque-to-light block y in a column, cached per "x,z". A cell is sky-lit iff
// its y is strictly above this. Missing = no opaque block found (open sky all the way).
const heightCache = new Map<string, number>();
// Light-source cells of a chunk (scanned from its raw cells once), cached per chunk.
const sourceCache = new Map<string, { x: number; y: number; z: number; l: number }[]>();

/** Drop cached light data for a chunk (its column heights + source list) after an edit. */
export function invalidateLight(cx: number, cy: number, cz: number): void {
  sourceCache.delete(chunkKey(cx, cy, cz));
  const x0 = cx * CHUNK,
    z0 = cz * CHUNK;
  for (let lz = 0; lz < CHUNK; lz++) for (let lx = 0; lx < CHUNK; lx++) heightCache.delete(`${x0 + lx},${z0 + lz}`);
}

/** Reset all cached light state (e.g. on teleport to a fresh world). */
export function clearLightCache(): void {
  heightCache.clear();
  sourceCache.clear();
}

function columnTop(world: VoxelWorld, x: number, z: number): number {
  const key = `${x},${z}`;
  const hit = heightCache.get(key);
  if (hit !== undefined) return hit;
  let top = SKY_BOTTOM - 1; // nothing opaque → sky reaches the bottom
  for (let y = SKY_TOP; y >= SKY_BOTTOM; y--) {
    if (opaqueForLight(world.get(x, y, z))) {
      top = y;
      break;
    }
  }
  heightCache.set(key, top);
  return top;
}

function chunkSources(world: VoxelWorld, cx: number, cy: number, cz: number): { x: number; y: number; z: number; l: number }[] {
  const key = chunkKey(cx, cy, cz);
  const hit = sourceCache.get(key);
  if (hit) return hit;
  const list: { x: number; y: number; z: number; l: number }[] = [];
  const raw = world.rawChunk(cx, cy, cz);
  if (raw) {
    const x0 = cx * CHUNK,
      y0 = cy * CHUNK,
      z0 = cz * CHUNK;
    for (let ly = 0; ly < CHUNK; ly++)
      for (let lz = 0; lz < CHUNK; lz++)
        for (let lx = 0; lx < CHUNK; lx++) {
          const l = sourceLevel(raw[lx + CHUNK * (lz + CHUNK * ly)]);
          if (l) list.push({ x: x0 + lx, y: y0 + ly, z: z0 + lz, l });
        }
  }
  sourceCache.set(key, list);
  return list;
}

/** Light levels (0..15) sampled by the mesher for the neighbour cell of each face. */
export interface LightSampler {
  sky(x: number, y: number, z: number): number;
  block(x: number, y: number, z: number): number;
}

/**
 * Compute light for one chunk plus a 1-cell border (the cells faces look into). Skylight
 * comes straight from the column cache; blocklight is BFS-flooded from every source in the
 * 3×3×3 chunk neighbourhood over a RADIUS-padded grid, then sampled by the mesher.
 */
export function computeChunkLight(world: VoxelWorld, cx: number, cy: number, cz: number): LightSampler {
  const x0 = cx * CHUNK,
    y0 = cy * CHUNK,
    z0 = cz * CHUNK;

  // Gather sources from this chunk and its 26 neighbours (RADIUS < CHUNK ⇒ nothing farther reaches).
  const sources: { x: number; y: number; z: number; l: number }[] = [];
  for (let dz = -1; dz <= 1; dz++)
    for (let dy = -1; dy <= 1; dy++)
      for (let dx = -1; dx <= 1; dx++) {
        const list = chunkSources(world, cx + dx, cy + dy, cz + dz);
        for (const s of list) sources.push(s);
      }

  const sky = (x: number, y: number, z: number): number => (y > columnTop(world, x, z) ? MAX_LIGHT : 0);

  if (sources.length === 0) return { sky, block: () => 0 };

  // Flood grid: the kept region (chunk + 1 border) padded by RADIUS so BFS from any
  // in-range source resolves correctly inside the region. Grid origin = chunk origin − GO.
  const GO = RADIUS + 1;
  const GS = CHUNK + 2 * GO;
  const gx0 = x0 - GO,
    gy0 = y0 - GO,
    gz0 = z0 - GO;
  const idx = (lx: number, ly: number, lz: number): number => lx + GS * (lz + GS * ly);
  const inGrid = (lx: number, ly: number, lz: number): boolean => lx >= 0 && lx < GS && ly >= 0 && ly < GS && lz >= 0 && lz < GS;
  const blk = new Uint8Array(GS * GS * GS);

  // Seed the BFS with every source (clamped into the grid), taking the max where they overlap.
  let queue: number[] = [];
  for (const s of sources) {
    const lx = s.x - gx0,
      ly = s.y - gy0,
      lz = s.z - gz0;
    if (!inGrid(lx, ly, lz)) continue;
    const i = idx(lx, ly, lz);
    if (s.l > blk[i]) {
      blk[i] = s.l;
      queue.push(i);
    }
  }
  const NB = [
    [1, 0, 0],
    [-1, 0, 0],
    [0, 1, 0],
    [0, -1, 0],
    [0, 0, 1],
    [0, 0, -1],
  ];
  // BFS: spread level−1 into non-opaque neighbours (a source cell itself always lights).
  while (queue.length) {
    const next: number[] = [];
    for (const i of queue) {
      const level = blk[i];
      if (level <= 1) continue;
      const lx = i % GS;
      const lz = Math.floor(i / GS) % GS;
      const ly = Math.floor(i / (GS * GS));
      for (const [nx, ny, nz] of NB) {
        const ax = lx + nx,
          ay = ly + ny,
          az = lz + nz;
        if (!inGrid(ax, ay, az)) continue;
        if (opaqueForLight(world.get(gx0 + ax, gy0 + ay, gz0 + az))) continue;
        const j = idx(ax, ay, az);
        if (level - 1 > blk[j]) {
          blk[j] = level - 1;
          next.push(j);
        }
      }
    }
    queue = next;
  }

  const block = (x: number, y: number, z: number): number => {
    const lx = x - gx0,
      ly = y - gy0,
      lz = z - gz0;
    return inGrid(lx, ly, lz) ? blk[idx(lx, ly, lz)] : 0;
  };
  return { sky, block };
}
