/**
 * Deterministic, seed-based terrain generator (server-authoritative). A chunk's
 * CHUNK^3 block ids are a pure function of (chunk coords, seed): bedrock floor →
 * stone → dirt → grass, with mountains (ridged noise gated by a continent mask),
 * lakes/seas filled with water up to sea level, 3D-noise caves carved
 * underground, and a deterministic forest. Block ids match blocks.ts.
 */
import { CHUNK, CHUNK_VOL, cellIndex } from '@pixel/shared';

const AIR = 0;
const GRASS = 1;
const DIRT = 2;
const STONE = 3;
const SAND = 7;
const WOOD = 17;
const LEAVES = 21;
export const WATER = 27;

const SEA = 12; // water fills land lower than this, up to here
const TREE_MARGIN = 2; // columns just outside a chunk whose leaves may reach in

// ── noise ─────────────────────────────────────────────────────────────────────
function hash2(x: number, z: number, seed: number): number {
  let h = (x | 0) * 374761393 + (z | 0) * 668265263 + (seed | 0) * 1274126177;
  h = (h ^ (h >>> 13)) >>> 0;
  h = (h * 1274126177) >>> 0;
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}
function hash3(x: number, y: number, z: number, seed: number): number {
  let h = (x | 0) * 374761393 + (y | 0) * 1103515245 + (z | 0) * 668265263 + (seed | 0) * 1274126177;
  h = (h ^ (h >>> 13)) >>> 0;
  h = (h * 1274126177) >>> 0;
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}
const smooth = (t: number): number => t * t * (3 - 2 * t);
const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;

function noise2(x: number, z: number, cell: number, seed: number): number {
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
function noise3(x: number, y: number, z: number, cell: number, seed: number): number {
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
  return lerp(
    lerp(lerp(c000, c100, fx), lerp(c010, c110, fx), fy),
    lerp(lerp(c001, c101, fx), lerp(c011, c111, fx), fy),
    fz,
  );
}
const ridged = (x: number, z: number, cell: number, seed: number): number => 1 - Math.abs(noise2(x, z, cell, seed) * 2 - 1);
const smoothstep = (a: number, b: number, t: number): number => {
  const u = Math.max(0, Math.min(1, (t - a) / (b - a)));
  return u * u * (3 - 2 * u);
};

// Guaranteed lake right beside the spawn (only the default/first world). Centred a
// few blocks off origin with a curved bowl (floor below SEA → fills with water) and
// a flat shore, so you spawn on land next to open water. See surfaceHeight().
const LAKE_CX = 10;
const LAKE_CZ = 0;
const LAKE_R = 10; // water radius
const LAKE_FLOOR = SEA - 9; // deep centre (multi-layer water, like a real lake)
const LAKE_RIM = SEA; // rim height = water level → the lake looks brim-full (flush shore)
const SPAWN_PAD = SEA + 1; // spawn on dry ground one block above the waterline

/** Surface land height at world (x,z): continents dip into basins (lakes/seas)
 *  and rise into mountains, plus rolling hills. cell 80 → variety within a view.
 *  With spawnLake, a lake + shore is carved near origin and the spawn is a flat pad. */
export function surfaceHeight(x: number, z: number, seed: number, spawnLake = false): number {
  const cont = noise2(x, z, 80, seed); // 0..1 continents
  const land = 8 + cont * 30; // 8 (below SEA → water basins) .. 38
  const hills = (noise2(x, z, 24, seed + 11) * 2 - 1) * 4; // ±4 rolling hills
  const mtnMask = smoothstep(0.72, 0.96, cont); // only high continents grow mountains
  const mtn = Math.pow(ridged(x, z, 48, seed + 7), 1.6) * 36; // sharp ridges
  let h = land + hills + mtnMask * mtn;
  if (spawnLake) {
    const d = Math.hypot(x - LAKE_CX, z - LAKE_CZ);
    if (d < LAKE_R) {
      const t = d / LAKE_R; // 0 centre .. 1 rim
      h = LAKE_RIM + (LAKE_FLOOR - LAKE_RIM) * (1 - t * t); // curved bowl, rim flush with waterline
    } else if (d < LAKE_R + 4) {
      const t = (d - LAKE_R) / 4; // blend rim → natural terrain
      h = LAKE_RIM + (h - LAKE_RIM) * (t * t * (3 - 2 * t));
    }
    if (Math.hypot(x, z) < 3) h = SPAWN_PAD; // dry spawn pad just above the waterline
  }
  return Math.floor(h);
}

/** True where a cave should be carved (air) at underground (x,y,z). */
function isCave(x: number, y: number, z: number, seed: number, surface: number): boolean {
  if (y < 2 || y > surface - 3) return false; // keep bedrock + surface crust
  const n1 = noise3(x, y * 1.6, z, 15, seed + 31);
  const n2 = noise3(x, y * 1.6, z, 15, seed + 61);
  return Math.abs(n1 - 0.5) < 0.07 && Math.abs(n2 - 0.5) < 0.07;
}

/** Write a tree at column (wx,wz) with base surface `h`, but only the cells that
 *  fall inside the chunk currently being generated. */
function writeTree(cells: Uint8Array, wx: number, wz: number, h: number, seed: number, baseX: number, baseY: number, baseZ: number): void {
  const th = 4 + (Math.floor(hash2(wx + 5, wz + 9, seed) * 3) % 3); // trunk 4–6
  const put = (x: number, y: number, z: number, id: number): void => {
    const lx = x - baseX,
      ly = y - baseY,
      lz = z - baseZ;
    if (lx < 0 || ly < 0 || lz < 0 || lx >= CHUNK || ly >= CHUNK || lz >= CHUNK) return;
    const i = cellIndex(lx, ly, lz);
    if (cells[i] === AIR || id === WOOD) cells[i] = id; // trunk overrides, leaves fill air
  };
  for (let i = 0; i < th; i++) put(wx, h + 1 + i, wz, WOOD);
  const top = h + 1 + th - 1;
  for (let dy = -1; dy <= 1; dy++)
    for (let dx = -2; dx <= 2; dx++)
      for (let dz = -2; dz <= 2; dz++) {
        const r = dx * dx + dz * dz + dy * dy * 2;
        if (r <= 5) put(wx + dx, top + dy, wz + dz, LEAVES);
      }
  put(wx, top + 1, wz, LEAVES);
}

/** Generate a chunk's cells from the seed alone. `spawnLake` adds the guaranteed
 *  spawn-side lake (default world only). */
export function generateChunk(cx: number, cy: number, cz: number, seed: number, spawnLake = false): Uint8Array {
  const cells = new Uint8Array(CHUNK_VOL);
  const baseX = cx * CHUNK,
    baseY = cy * CHUNK,
    baseZ = cz * CHUNK;

  for (let lz = 0; lz < CHUNK; lz++) {
    for (let lx = 0; lx < CHUNK; lx++) {
      const wx = baseX + lx,
        wz = baseZ + lz;
      const h = surfaceHeight(wx, wz, seed, spawnLake);
      const beach = h <= SEA + 1 && h >= SEA - 1;
      for (let ly = 0; ly < CHUNK; ly++) {
        const wy = baseY + ly;
        let id = AIR;
        if (wy < 0) id = STONE; // bedrock floor — never fall through
        else if (wy < h - 4) id = STONE;
        else if (wy < h) id = DIRT;
        else if (wy === h) id = h < SEA ? SAND : beach ? SAND : GRASS; // sandy shores + lakebeds
        else if (wy <= SEA) id = WATER; // fill lakes/seas above low land
        // carve caves out of the solid interior (not water)
        if ((id === STONE || id === DIRT) && wy >= 0 && isCave(wx, wy, wz, seed, h)) id = AIR;
        if (id !== AIR) cells[cellIndex(lx, ly, lz)] = id;
      }
    }
  }

  // Forest: trees whose columns are in (or just outside) this chunk, on grass.
  for (let wz = baseZ - TREE_MARGIN; wz < baseZ + CHUNK + TREE_MARGIN; wz++) {
    for (let wx = baseX - TREE_MARGIN; wx < baseX + CHUNK + TREE_MARGIN; wx++) {
      if (hash2(wx, wz, seed + 991) >= 0.02) continue; // ~2% of columns
      const h = surfaceHeight(wx, wz, seed, spawnLake);
      if (h <= SEA) continue; // no trees in water/shore
      writeTree(cells, wx, wz, h, seed, baseX, baseY, baseZ);
    }
  }
  return cells;
}
