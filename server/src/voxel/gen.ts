/**
 * Deterministic, seed-based terrain generator (server-authoritative). Produces a
 * chunk's CHUNK^3 block ids as a pure function of (chunk coords, seed), so a
 * chunk generates identically whether it's made now or regenerated later. Block
 * ids match the client registry (blocks.ts): 1 grass, 2 dirt, 3 stone, 7 sand.
 */
import { CHUNK, CHUNK_VOL, cellIndex } from '@pixel/shared';

const AIR = 0;
const GRASS = 1;
const DIRT = 2;
const STONE = 3;
const SAND = 7;

const BASE_HEIGHT = 14; // average surface y
const HILL_AMP = 9; // ± surface variation
const SEA = 8; // below this the surface is sandy

/** Integer hash → [0,1). */
function hash2(x: number, z: number, seed: number): number {
  let h = (x | 0) * 374761393 + (z | 0) * 668265263 + (seed | 0) * 1274126177;
  h = (h ^ (h >>> 13)) >>> 0;
  h = (h * 1274126177) >>> 0;
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

const smooth = (t: number): number => t * t * (3 - 2 * t);

/** Value noise in [0,1] at world (x,z) with a given cell size. */
function valueNoise(x: number, z: number, cell: number, seed: number): number {
  const gx = Math.floor(x / cell);
  const gz = Math.floor(z / cell);
  const fx = smooth((x - gx * cell) / cell);
  const fz = smooth((z - gz * cell) / cell);
  const a = hash2(gx, gz, seed);
  const b = hash2(gx + 1, gz, seed);
  const c = hash2(gx, gz + 1, seed);
  const d = hash2(gx + 1, gz + 1, seed);
  return a + (b - a) * fx + (c - a) * fz + (a - b - c + d) * fx * fz;
}

/** Surface height at world (x,z): two octaves of value noise. */
export function surfaceHeight(x: number, z: number, seed: number): number {
  const n = valueNoise(x, z, 48, seed) * 0.7 + valueNoise(x, z, 16, seed + 101) * 0.3;
  return Math.floor(BASE_HEIGHT + (n * 2 - 1) * HILL_AMP);
}

/** Generate a chunk's cells from the seed alone (no persistence). */
export function generateChunk(cx: number, cy: number, cz: number, seed: number): Uint8Array {
  const cells = new Uint8Array(CHUNK_VOL);
  const baseX = cx * CHUNK;
  const baseY = cy * CHUNK;
  const baseZ = cz * CHUNK;
  for (let lz = 0; lz < CHUNK; lz++) {
    for (let lx = 0; lx < CHUNK; lx++) {
      const h = surfaceHeight(baseX + lx, baseZ + lz, seed);
      const beach = h <= SEA;
      for (let ly = 0; ly < CHUNK; ly++) {
        const wy = baseY + ly;
        let id = AIR;
        if (wy < 0) id = STONE; // bedrock fill below y=0
        else if (wy < h - 4) id = STONE;
        else if (wy < h) id = beach ? SAND : DIRT;
        else if (wy === h) id = beach ? SAND : GRASS;
        if (id !== AIR) cells[cellIndex(lx, ly, lz)] = id;
      }
    }
  }
  return cells;
}
