/**
 * Deterministic, seed-based terrain generator (server-authoritative). A chunk's
 * CHUNK^3 block ids are a pure function of (chunk coords, seed): bedrock floor →
 * stone → dirt → grass, with mountains (ridged noise gated by a continent mask),
 * lakes/seas filled with water up to sea level, 3D-noise caves carved
 * underground, and a deterministic forest. Block ids match blocks.ts.
 */
import { CHUNK, CHUNK_VOL, cellIndex, hash2, hash3, noise3, biomeAt, surfaceHeight, SEA, ROCK_LINE, SNOW_LINE } from '@pixel/shared';

export { surfaceHeight, biomeAt } from '@pixel/shared'; // re-export for existing importers

/** Bump this whenever terrain generation changes. A world whose stored gen version is
 *  older is wiped (edited chunks dropped) so it regenerates fresh — see ChunkStore.meta.
 *  Lets a world-affecting change ship a fresh default map without manual world deletion. */
export const GEN_VERSION = 5; // bumped: mese ore (deep + rare)

const AIR = 0;
const GRASS = 1;
const DIRT = 2;
const STONE = 3;
const SAND = 7;
const DESERT_SAND = 8;
const SANDSTONE = 9;
const SNOW = 12;
const ICE = 13;
const WOOD = 17;
const LEAVES = 21;
export const WATER = 27;
const COAL_ORE = 30; // stone speckled with coal — common, upper stone
const IRON_ORE = 31; // stone speckled with iron — deeper
const COPPER_ORE = 37; // mid-depth
const TIN_ORE = 38; // mid-depth, rarer
const GOLD_ORE = 39; // deep + rare
const DIAMOND_ORE = 94; // deepest + rarest (top tool tier)
const MESE_ORE = 95; // deepest + rarest (top tool tier)
// Decorative surface plants (ids 51+; cross-plants except cactus).
const TALL_GRASS = 51;
const FERN = 52;
const ROSE = 53;
const DANDELION = 54;
const DRY_SHRUB = 55;
const CACTUS = 56;
const PAPYRUS = 72;
const MUSH_RED = 73;
const MUSH_BROWN = 74;
const GERANIUM = 75;
const VIOLA = 76;

const TREE_MARGIN = 2; // columns just outside a chunk whose leaves may reach in
// SEA, ROCK_LINE, SNOW_LINE, the noise fns, biomeAt + surfaceHeight now live in
// @pixel/shared (voxel/terrain) so the client map can paint the world from the seed.

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
      const biome = biomeAt(wx, wz, seed);
      // Per-biome surface + subsurface (deep stone stays STONE so caves/ores still work).
      const topId =
        h < SEA || beach
          ? SAND // sandy lakebeds/seabeds + shores, all biomes
          : h > SNOW_LINE
            ? SNOW // snow-capped peaks (any biome)
            : h > ROCK_LINE
              ? STONE // bare rocky peaks
              : biome === 'desert'
                ? DESERT_SAND
                : biome === 'snow'
                  ? SNOW
                  : GRASS;
      const subId = biome === 'desert' ? SANDSTONE : DIRT;
      for (let ly = 0; ly < CHUNK; ly++) {
        const wy = baseY + ly;
        let id = AIR;
        if (wy < 0) id = STONE; // bedrock floor — never fall through
        else if (wy < h - 4) id = STONE;
        else if (wy < h) id = subId;
        else if (wy === h) id = topId;
        else if (wy <= SEA) id = biome === 'snow' && wy === SEA ? ICE : WATER; // frozen surface in the cold
        // carve caves out of the solid interior (not water)
        if ((id === STONE || id === DIRT) && wy >= 0 && isCave(wx, wy, wz, seed, h)) id = AIR;
        // Ores in solid stone (after caves): small clumps (2³ cells share a roll → veins).
        // Coal is common in the upper stone; iron sits deeper. Mining them drops the ore.
        if (id === STONE && wy < h - 2) {
          if (hash3(wx >> 1, wy >> 1, wz >> 1, seed + 4001) < 0.03) id = COAL_ORE;
          else if (wy < 24 && hash3(wx >> 1, wy >> 1, wz >> 1, seed + 4002) < 0.022) id = IRON_ORE;
          else if (wy < 20 && hash3(wx >> 1, wy >> 1, wz >> 1, seed + 4003) < 0.014) id = COPPER_ORE;
          else if (wy < 16 && hash3(wx >> 1, wy >> 1, wz >> 1, seed + 4004) < 0.01) id = TIN_ORE;
          else if (wy < 8 && hash3(wx >> 1, wy >> 1, wz >> 1, seed + 4005) < 0.006) id = GOLD_ORE;
          else if (wy < 6 && hash3(wx >> 1, wy >> 1, wz >> 1, seed + 4006) < 0.0045) id = DIAMOND_ORE; // deepest + rarest
          else if (wy < 6 && hash3(wx >> 1, wy >> 1, wz >> 1, seed + 4007) < 0.0045) id = MESE_ORE; // deepest + rarest
        }
        // Surface decoration: a plant on the cell just above dry ground (biome-dependent).
        if (id === AIR && wy === h + 1 && h > SEA && !beach) {
          const rr = hash3(wx, 7, wz, seed + 5000);
          if (biome === 'plains')
            id =
              rr < 0.09 ? TALL_GRASS : rr < 0.11 ? FERN : rr < 0.118 ? ROSE : rr < 0.126 ? DANDELION
              : rr < 0.132 ? GERANIUM : rr < 0.138 ? VIOLA : rr < 0.142 ? MUSH_RED : rr < 0.146 ? MUSH_BROWN : AIR;
          else if (biome === 'desert') id = rr < 0.02 ? CACTUS : rr < 0.05 ? DRY_SHRUB : AIR;
        }
        // Papyrus clusters on the shore (beach cells next to water).
        if (id === AIR && wy === h + 1 && beach && hash3(wx, 9, wz, seed + 5100) < 0.09) id = PAPYRUS;
        if (id !== AIR) cells[cellIndex(lx, ly, lz)] = id;
      }
    }
  }

  // Forest: trees whose columns are in (or just outside) this chunk, on grass.
  for (let wz = baseZ - TREE_MARGIN; wz < baseZ + CHUNK + TREE_MARGIN; wz++) {
    for (let wx = baseX - TREE_MARGIN; wx < baseX + CHUNK + TREE_MARGIN; wx++) {
      const biome = biomeAt(wx, wz, seed);
      if (biome === 'desert') continue; // deserts are treeless
      const density = biome === 'snow' ? 0.008 : 0.02; // sparse taiga vs temperate forest
      if (hash2(wx, wz, seed + 991) >= density) continue;
      if (spawnLake && Math.hypot(wx, wz) < 6) continue; // keep the spawn clear (no tree to spawn on)
      const h = surfaceHeight(wx, wz, seed, spawnLake);
      if (h <= SEA || h > ROCK_LINE) continue; // no trees in water/shore or on bare peaks
      writeTree(cells, wx, wz, h, seed, baseX, baseY, baseZ);
    }
  }
  return cells;
}
