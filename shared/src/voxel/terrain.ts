/**
 * Deterministic terrain math shared by the server generator (gen.ts) and the client
 * travel map. Keeping the noise + surface-height + biome logic here means the map can
 * paint the WHOLE world (any x,z) from the seed alone — no "explored" caching — and it
 * always matches what the server actually generates.
 */
export type Biome = 'desert' | 'snow' | 'plains';

export const SEA = 12; // water fills land below this, up to here
export const ROCK_LINE = SEA + 22; // above → bare rock peaks
export const SNOW_LINE = SEA + 30; // above → snow-capped peaks (any biome)

// Guaranteed spawn-side lake (default world only): a curved bowl near origin.
export const LAKE_CX = 10;
export const LAKE_CZ = 0;
export const LAKE_R = 10;
export const LAKE_FLOOR = SEA - 9;
export const LAKE_RIM = SEA;
export const SPAWN_PAD = SEA + 1;

// ── value noise (integer-hash based, seedable) ──────────────────────────────────
export function hash2(x: number, z: number, seed: number): number {
  let h = (x | 0) * 374761393 + (z | 0) * 668265263 + (seed | 0) * 1274126177;
  h = (h ^ (h >>> 13)) >>> 0;
  h = (h * 1274126177) >>> 0;
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}
export function hash3(x: number, y: number, z: number, seed: number): number {
  let h = (x | 0) * 374761393 + (y | 0) * 1103515245 + (z | 0) * 668265263 + (seed | 0) * 1274126177;
  h = (h ^ (h >>> 13)) >>> 0;
  h = (h * 1274126177) >>> 0;
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}
const smooth = (t: number): number => t * t * (3 - 2 * t);
const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;

export function noise2(x: number, z: number, cell: number, seed: number): number {
  const gx = Math.floor(x / cell);
  const gz = Math.floor(z / cell);
  const fx = smooth((x - gx * cell) / cell);
  const fz = smooth((z - gz * cell) / cell);
  const a = hash2(gx, gz, seed);
  const b = hash2(gx + 1, gz, seed);
  const c = hash2(gx, gz + 1, seed);
  const d = hash2(gx + 1, gz + 1, seed);
  return lerp(lerp(a, b, fx), lerp(c, d, fx), fz);
}
export function noise3(x: number, y: number, z: number, cell: number, seed: number): number {
  const gx = Math.floor(x / cell),
    gy = Math.floor(y / cell),
    gz = Math.floor(z / cell);
  const fx = smooth((x - gx * cell) / cell);
  const fy = smooth((y - gy * cell) / cell);
  const fz = smooth((z - gz * cell) / cell);
  const c000 = hash3(gx, gy, gz, seed),
    c100 = hash3(gx + 1, gy, gz, seed);
  const c010 = hash3(gx, gy + 1, gz, seed),
    c110 = hash3(gx + 1, gy + 1, gz, seed);
  const c001 = hash3(gx, gy, gz + 1, seed),
    c101 = hash3(gx + 1, gy, gz + 1, seed);
  const c011 = hash3(gx, gy + 1, gz + 1, seed),
    c111 = hash3(gx + 1, gy + 1, gz + 1, seed);
  return lerp(lerp(lerp(c000, c100, fx), lerp(c010, c110, fx), fy), lerp(lerp(c001, c101, fx), lerp(c011, c111, fx), fy), fz);
}
export const ridged = (x: number, z: number, cell: number, seed: number): number => 1 - Math.abs(noise2(x, z, cell, seed) * 2 - 1);
const smoothstep = (a: number, b: number, t: number): number => {
  const u = Math.max(0, Math.min(1, (t - a) / (b - a)));
  return u * u * (3 - 2 * u);
};

/** Biome from low-frequency temperature × humidity noise (Luanti-style climate map). */
export function biomeAt(x: number, z: number, seed: number): Biome {
  const temp = noise2(x, z, 160, seed + 900);
  const hum = noise2(x, z, 160, seed + 901);
  if (temp > 0.62 && hum < 0.42) return 'desert';
  if (temp < 0.32) return 'snow';
  return 'plains';
}

/** Surface land height at (x,z): continents dip into basins + rise into mountains,
 *  plus rolling hills. `spawnLake` carves the guaranteed lake near origin. */
export function surfaceHeight(x: number, z: number, seed: number, spawnLake = false): number {
  const cont = noise2(x, z, 80, seed);
  const land = 8 + cont * 30;
  const hills = (noise2(x, z, 24, seed + 11) * 2 - 1) * 4;
  const mtnMask = smoothstep(0.72, 0.96, cont);
  const mtn = Math.pow(ridged(x, z, 48, seed + 7), 1.6) * 36;
  let h = land + hills + mtnMask * mtn;
  if (spawnLake) {
    const d = Math.hypot(x - LAKE_CX, z - LAKE_CZ);
    if (d < LAKE_R) {
      const t = d / LAKE_R;
      h = LAKE_RIM + (LAKE_FLOOR - LAKE_RIM) * (1 - t * t);
    } else if (d < LAKE_R + 4) {
      const t = (d - LAKE_R) / 4;
      h = LAKE_RIM + (h - LAKE_RIM) * (t * t * (3 - 2 * t));
    }
    if (Math.hypot(x, z) < 3) h = SPAWN_PAD;
  }
  return Math.floor(h);
}

/** Tint an 0xRRGGBB colour by a multiplier (clamped per channel). */
function shade(rgb: number, f: number): number {
  const r = Math.max(0, Math.min(255, ((rgb >> 16) & 255) * f));
  const g = Math.max(0, Math.min(255, ((rgb >> 8) & 255) * f));
  const b = Math.max(0, Math.min(255, (rgb & 255) * f));
  return (r << 16) | (g << 8) | b;
}

/** Representative top-surface colour at (x,z) for the map — mirrors the generator's
 *  surface-block choice (water/beach/snow/rock/desert/grass) with light height relief. */
export function surfaceColor(x: number, z: number, seed: number, spawnLake = false): number {
  const h = surfaceHeight(x, z, seed, spawnLake);
  if (h < SEA) {
    const depth = Math.max(0, Math.min(1, (SEA - h) / 12));
    return shade(0x2f6bd8, 1 - depth * 0.5); // deeper water → darker blue
  }
  const beach = h <= SEA + 1 && h >= SEA - 1;
  const biome = biomeAt(x, z, seed);
  const base = beach
    ? 0xd8cf9c
    : h > SNOW_LINE
      ? 0xf0f4f8
      : h > ROCK_LINE
        ? 0x8f8f8f
        : biome === 'desert'
          ? 0xe0d29a
          : biome === 'snow'
            ? 0xeaf2f6
            : 0x5aa032; // grass
  const t = Math.max(0, Math.min(1, (h - SEA) / 50));
  return shade(base, 0.8 + t * 0.35); // subtle height relief
}
