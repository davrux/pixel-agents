/**
 * Shared voxel protocol — used by BOTH the server (authoritative world + chunk
 * store) and the client (rendering + edit intents). Keeps the chunk size, the
 * in-chunk indexing, the AOI radius, and the wire codec identical on both ends.
 *
 * Wire model:
 *  - Chunks are streamed as BINARY messages (type 'c'): a 12-byte header
 *    (cx,cy,cz as int32 LE) + an RLE payload of CHUNK_VOL block ids. Chunks are
 *    far too big for Colyseus schema state, so they never live in the room state.
 *  - Chunk unloads (out of AOI) are a small JSON message (type 'u': {cx,cy,cz}).
 *  - Block edits are small JSON: client→server 'edit' {x,y,z,id}; the server
 *    validates + persists + broadcasts 'edit' {x,y,z,id} to nearby clients.
 *  - Players live in Colyseus schema state (VoxelPlayerSync) with position sent
 *    via 'move'. Chat reuses the existing 'chat' pattern.
 */

export const VOXEL_ROOM = 'voxel';

// ── Water / fluid ids (shared so server sim + client render agree) ───────────
// A full "source" block (id 27, lakes/seas) plus 7 "flowing" levels (ids 40..46,
// level 1 = highest/near source .. level 7 = thinnest/farthest). The server's
// fluid sim spreads flowing water from sources; the client renders each level at a
// lower surface height. Level 0 = source/falling (full height).
export const WATER_SOURCE = 27;
export const WATER_FLOW_MIN = 40; // level 1
export const WATER_FLOW_MAX = 46; // level 7
export const WATER_MAX_LEVEL = 7;

export const isWaterId = (id: number): boolean => id === WATER_SOURCE || (id >= WATER_FLOW_MIN && id <= WATER_FLOW_MAX);
/** 0 for a source/full block, 1..7 for flowing levels. */
export const waterLevel = (id: number): number => (id === WATER_SOURCE ? 0 : id >= WATER_FLOW_MIN && id <= WATER_FLOW_MAX ? id - WATER_FLOW_MIN + 1 : 0);
/** Block id for a flowing-water level (1..7); level ≤0 → source. */
export const flowId = (level: number): number => (level <= 0 ? WATER_SOURCE : WATER_FLOW_MIN + Math.min(WATER_MAX_LEVEL, level) - 1);

// ── Lava — a second finite liquid ────────────────────────────────────────────
// Source id 29 + 4 flowing levels (ids 47..50). Spreads less far than water (4 vs
// 7 levels), is rendered emissive/opaque, and burns players standing in it. The
// server fluid sim + client mesher are generalised over any FluidDef so both
// liquids share one implementation.
export const LAVA_SOURCE = 29;
export const LAVA_FLOW_MIN = 47; // level 1
export const LAVA_FLOW_MAX = 50; // level 4
export const LAVA_MAX_LEVEL = 4;

export const isLavaId = (id: number): boolean => id === LAVA_SOURCE || (id >= LAVA_FLOW_MIN && id <= LAVA_FLOW_MAX);

/** A finite liquid: an infinite source id + a contiguous run of flowing-level ids. */
export interface FluidDef {
  source: number;
  flowMin: number;
  flowMax: number;
  maxLevel: number;
}
export const WATER_FLUID: FluidDef = { source: WATER_SOURCE, flowMin: WATER_FLOW_MIN, flowMax: WATER_FLOW_MAX, maxLevel: WATER_MAX_LEVEL };
export const LAVA_FLUID: FluidDef = { source: LAVA_SOURCE, flowMin: LAVA_FLOW_MIN, flowMax: LAVA_FLOW_MAX, maxLevel: LAVA_MAX_LEVEL };
export const FLUIDS: FluidDef[] = [WATER_FLUID, LAVA_FLUID];

/** The fluid an id belongs to, or null if it is not a liquid. */
export const fluidOf = (id: number): FluidDef | null => {
  for (const f of FLUIDS) if (id === f.source || (id >= f.flowMin && id <= f.flowMax)) return f;
  return null;
};
export const isFluidId = (id: number): boolean => fluidOf(id) !== null;
/** 0 for a source/full block, 1..maxLevel for flowing levels of THIS fluid. */
export const fluidLevel = (f: FluidDef, id: number): number => (id === f.source ? 0 : id - f.flowMin + 1);
/** Block id for a flowing level of THIS fluid (level ≤0 → source). */
export const fluidFlowId = (f: FluidDef, level: number): number => (level <= 0 ? f.source : f.flowMin + Math.min(f.maxLevel, level) - 1);

// ── Non-block material items (lumps, ingots) ─────────────────────────────────
// Inventory ids: placeable blocks are 1..31; non-block MATERIAL items start at 100.
// Materials aren't placeable — they live only in the inventory, drop as flat
// billboards (not cubes), and feed crafting/smelting. The server's inv/drop maps are
// keyed by number, so they already carry any id; only the "is this placeable?" and
// "how is it drawn?" branches care about the split.
// Item-id ranges: placeable blocks 1..MAX_BLOCK_ID, MATERIALS 100..199, TOOLS 200..299.
// MAX_BLOCK_ID is the highest valid placeable block id (bump it when blocks.ts grows);
// the server's place guard uses it so materials/tools can't be placed as blocks.
// Placeable blocks are 1..MAX_BLOCK_ID. NOTE ids 40..50 are the fluid FLOW levels
// (WATER_FLOW/LAVA_FLOW) — content blocks resume at 51 (see blocks.ts). Bump this when
// blocks.ts grows so the server place guard admits the new ids.
export const MAX_BLOCK_ID = 76;
export const TNT_ID = 71; // ignite via the use-action → fuse → explosion
export const CHEST_ID = 34; // openable storage node (per-position inventory, server-side)
export const FURNACE_ID = 62; // placed smelting node — using it opens the smelting UI
export const SAPLING = 63; // planted → grows into a tree over time
export const SOIL = 64; // farmland — dirt/grass tilled by a hoe; crops grow on it
export const DESERT_SOIL = 65; // farmland from tilled sand/desert-sand; crops grow on it too
export const isSoil = (id: number): boolean => id === SOIL || id === DESERT_SOIL;
// Farming: wheat grows through 4 cross-plant stages (57 seedling → 60 mature). Only the
// seedling (57) is plantable; 58-60 are growth states the server advances over time.
export const WHEAT_SEED = 57;
export const WHEAT_MATURE = 60;
export const STRAW = 61; // 9 wheat → a straw block
export const isCrop = (id: number): boolean => id >= WHEAT_SEED && id <= WHEAT_MATURE;
/** Blocks that need a solid block beneath them: cross-plants (51-55), wheat crops
 *  (57-60) and saplings (63). When their support is removed they pop off + drop. */
export const needsGround = (id: number): boolean => (id >= 51 && id <= 55) || (id >= 72 && id <= 76) || isCrop(id) || id === SAPLING;
export const DOOR_CLOSED = 35; // door (solid); toggles with DOOR_OPEN via the use action
export const DOOR_OPEN = 36; // door (open): non-solid, not rendered
export const COPPER_ORE = 37;
export const TIN_ORE = 38;
export const GOLD_ORE = 39;
export const MATERIAL_BASE = 100;
export const TOOL_BASE = 200;
export const isMaterialId = (id: number): boolean => id >= MATERIAL_BASE && id < TOOL_BASE;
export const isToolId = (id: number): boolean => id >= TOOL_BASE;
export const COAL_LUMP = 100;
export const IRON_LUMP = 101;
export const STEEL_INGOT = 102;
export const STICK = 103;
export const COPPER_LUMP = 104;
export const TIN_LUMP = 105;
export const GOLD_LUMP = 106;
export const COPPER_INGOT = 107;
export const TIN_INGOT = 108;
export const GOLD_INGOT = 109;
export const BRONZE_INGOT = 110;
export const WHEAT = 111; // harvested from mature wheat
export const BREAD = 112; // 3 wheat → bread; eaten to restore hunger

// Craftable tool item ids (each maps to a luanti tool_capabilities key on the client).
// Owning one (count ≥1 in the inventory) unlocks its dig speed; unowned tools fall back
// to bare-hand digging. Tiers: wood (start) → stone → steel.
export const TOOL_IDS: Record<string, number> = {
  pick_wood: 200, pick_stone: 201, pick_steel: 202,
  axe_wood: 210, axe_stone: 211, axe_steel: 212,
  shovel_wood: 220, shovel_stone: 221, shovel_steel: 222,
  sword_wood: 230, sword_stone: 231, sword_steel: 232,
  hoe_wood: 240, hoe_stone: 241, hoe_steel: 242,
};
/** The tool every player starts with so they can bootstrap (hand→wood→pick→stone). */
export const STARTER_TOOL = TOOL_IDS.pick_wood;
/** Max durability (block-breaks) of a tool, by tier (id%10: 0=wood,1=stone,2=steel).
 *  A tool wears one use per block broken and shatters at zero (Minecraft-ish counts). */
export const toolMaxUses = (toolId: number): number => [60, 132, 250][toolId % 10] ?? 60;
/** Hoe tool ids — used (not to dig, but) to till dirt/grass into SOIL via the use action. */
export const isHoe = (id: number): boolean => id === TOOL_IDS.hoe_wood || id === TOOL_IDS.hoe_stone || id === TOOL_IDS.hoe_steel;

// Ore block → the item it drops when mined (Luanti: ore drops a lump, not the ore
// block). Anything not listed drops itself. Used at the spawnDrop call site.
// Block → the item it drops when broken (default: itself). Ores drop lumps; an open
// door drops the (closed) door item, not the state-only open id.
export const ORE_DROPS: Record<number, number> = {
  3: 4, // mining STONE drops COBBLE (Minecraft/Luanti; smelt cobble back to stone). This
  //     is how you obtain cobble — the input for stone tools + the furnace.
  30: COAL_LUMP,
  31: IRON_LUMP,
  [COPPER_ORE]: COPPER_LUMP,
  [TIN_ORE]: TIN_LUMP,
  [GOLD_ORE]: GOLD_LUMP,
  [DOOR_OPEN]: DOOR_CLOSED,
  [SOIL]: 2, // tilled soil breaks back into dirt
  [DESERT_SOIL]: 8, // desert soil breaks back into desert sand
};
export const dropFor = (blockId: number): number => ORE_DROPS[blockId] ?? blockId;

// ── Crafting ─────────────────────────────────────────────────────────────────
// Block→block recipes (Luanti-flavoured), shared so the server validates the exact
// set the client shows. `in` is consumed from the stack inventory, `out` is granted.
export interface CraftRecipe {
  in: { block: number; count: number }[];
  out: { block: number; count: number };
}
export const CRAFT_RECIPES: CraftRecipe[] = [
  { in: [{ block: 17, count: 1 }], out: { block: 18, count: 4 } }, // 1 wood → 4 planks
  { in: [{ block: 18, count: 1 }], out: { block: STICK, count: 4 } }, // 1 planks → 4 sticks
  { in: [{ block: 7, count: 4 }], out: { block: 9, count: 1 } }, // 4 sand → 1 sandstone
  { in: [{ block: COAL_LUMP, count: 9 }], out: { block: 23, count: 1 } }, // 9 coal lumps → 1 coal block
  // Tools (Luanti: material head + sticks). Wood = planks, stone = cobble, steel = ingots.
  { in: [{ block: 18, count: 3 }, { block: STICK, count: 2 }], out: { block: TOOL_IDS.pick_wood, count: 1 } },
  { in: [{ block: 18, count: 3 }, { block: STICK, count: 2 }], out: { block: TOOL_IDS.axe_wood, count: 1 } },
  { in: [{ block: 18, count: 1 }, { block: STICK, count: 2 }], out: { block: TOOL_IDS.shovel_wood, count: 1 } },
  { in: [{ block: 18, count: 2 }, { block: STICK, count: 1 }], out: { block: TOOL_IDS.sword_wood, count: 1 } },
  { in: [{ block: 4, count: 3 }, { block: STICK, count: 2 }], out: { block: TOOL_IDS.pick_stone, count: 1 } },
  { in: [{ block: 4, count: 3 }, { block: STICK, count: 2 }], out: { block: TOOL_IDS.axe_stone, count: 1 } },
  { in: [{ block: 4, count: 1 }, { block: STICK, count: 2 }], out: { block: TOOL_IDS.shovel_stone, count: 1 } },
  { in: [{ block: 4, count: 2 }, { block: STICK, count: 1 }], out: { block: TOOL_IDS.sword_stone, count: 1 } },
  { in: [{ block: STEEL_INGOT, count: 3 }, { block: STICK, count: 2 }], out: { block: TOOL_IDS.pick_steel, count: 1 } },
  { in: [{ block: STEEL_INGOT, count: 3 }, { block: STICK, count: 2 }], out: { block: TOOL_IDS.axe_steel, count: 1 } },
  { in: [{ block: STEEL_INGOT, count: 1 }, { block: STICK, count: 2 }], out: { block: TOOL_IDS.shovel_steel, count: 1 } },
  { in: [{ block: STEEL_INGOT, count: 2 }, { block: STICK, count: 1 }], out: { block: TOOL_IDS.sword_steel, count: 1 } },
  // Functional nodes (Luanti): torch = coal + stick, ladder = sticks.
  { in: [{ block: COAL_LUMP, count: 1 }, { block: STICK, count: 1 }], out: { block: 33, count: 4 } }, // → 4 torches
  { in: [{ block: STICK, count: 3 }], out: { block: 32, count: 3 } }, // 3 sticks → 3 ladders
  { in: [{ block: 18, count: 8 }], out: { block: CHEST_ID, count: 1 } }, // 8 planks → 1 chest
  { in: [{ block: 18, count: 6 }], out: { block: DOOR_CLOSED, count: 1 } }, // 6 planks → 1 door
  // Metals: alloy bronze from copper + tin; pack ingots into storage blocks.
  { in: [{ block: COPPER_INGOT, count: 1 }, { block: TIN_INGOT, count: 1 }], out: { block: BRONZE_INGOT, count: 1 } },
  { in: [{ block: COPPER_INGOT, count: 9 }], out: { block: 24, count: 1 } }, // → copper block
  { in: [{ block: BRONZE_INGOT, count: 9 }], out: { block: 25, count: 1 } }, // → bronze block
  { in: [{ block: WHEAT, count: 9 }], out: { block: STRAW, count: 1 } }, // 9 wheat → straw block
  { in: [{ block: 4, count: 8 }], out: { block: FURNACE_ID, count: 1 } }, // 8 cobble → furnace
  // Decorative build blocks.
  { in: [{ block: 3, count: 4 }], out: { block: 66, count: 4 } }, // 4 stone → 4 stone brick
  { in: [{ block: 9, count: 4 }], out: { block: 67, count: 4 } }, // 4 sandstone → 4 sandstone brick
  { in: [{ block: 15, count: 4 }], out: { block: 68, count: 4 } }, // 4 obsidian → 4 obsidian brick
  { in: [{ block: 18, count: 6 }], out: { block: 69, count: 1 } }, // 6 planks → 1 bookshelf
  { in: [{ block: STEEL_INGOT, count: 9 }], out: { block: 70, count: 1 } }, // 9 steel ingot → steel block
  { in: [{ block: COAL_LUMP, count: 4 }, { block: 7, count: 4 }], out: { block: TNT_ID, count: 1 } }, // 4 coal + 4 sand → TNT
  { in: [{ block: WHEAT, count: 3 }], out: { block: BREAD, count: 1 } }, // 3 wheat → 1 bread (food)
  // Hoes (2 material heads + 2 sticks) — till dirt/grass into farmland.
  { in: [{ block: 18, count: 2 }, { block: STICK, count: 2 }], out: { block: TOOL_IDS.hoe_wood, count: 1 } },
  { in: [{ block: 4, count: 2 }, { block: STICK, count: 2 }], out: { block: TOOL_IDS.hoe_stone, count: 1 } },
  { in: [{ block: STEEL_INGOT, count: 2 }, { block: STICK, count: 2 }], out: { block: TOOL_IDS.hoe_steel, count: 1 } },
];

// ── Smelting (furnace) ───────────────────────────────────────────────────────
// Each smelt consumes one input item + one unit of fuel and yields the output
// (Luanti-flavoured cook results). Fuel is any FUEL_ITEMS id (simplified from
// Luanti's per-item burn times: one fuel = one smelt). Shared so the server
// validates the exact set the client's smelting panel shows.
export interface SmeltRecipe {
  in: number;
  out: number;
  count: number;
}
export const SMELT_RECIPES: SmeltRecipe[] = [
  { in: IRON_LUMP, out: STEEL_INGOT, count: 1 }, // iron lump → steel ingot
  { in: COPPER_LUMP, out: COPPER_INGOT, count: 1 }, // copper lump → copper ingot
  { in: TIN_LUMP, out: TIN_INGOT, count: 1 }, // tin lump → tin ingot
  { in: GOLD_LUMP, out: GOLD_INGOT, count: 1 }, // gold lump → gold ingot
  { in: 7, out: 14, count: 1 }, // sand → glass
  { in: 4, out: 3, count: 1 }, // cobble → stone
];
/** Items usable as furnace fuel (coal lump, wood, planks, coal block). */
export const FUEL_ITEMS: number[] = [COAL_LUMP, 17, 18, 23];

export const CHUNK = 16; // chunk edge; a chunk is CHUNK^3 block ids
export const CHUNK_VOL = CHUNK * CHUNK * CHUNK; // 4096

/** AOI: how many chunks around the player's chunk are streamed (radius). */
export const VIEW_CHUNKS = 4; // horizontal (x/z)
export const VIEW_CHUNKS_Y = 2; // vertical (y)

/** In-chunk cell index (x,y,z each 0..CHUNK-1). Order: y outer, z, x inner. */
export const cellIndex = (x: number, y: number, z: number): number => x + CHUNK * (z + CHUNK * y);

/** Floor-divide a world coord by CHUNK → chunk coord (handles negatives). */
export const toChunk = (v: number): number => Math.floor(v / CHUNK);
/** Local coord within a chunk (0..CHUNK-1), correct for negatives. */
export const toLocal = (v: number): number => ((v % CHUNK) + CHUNK) % CHUNK;

export const chunkKey = (cx: number, cy: number, cz: number): string => `${cx},${cy},${cz}`;

/** RLE-encode CHUNK_VOL block ids → compact bytes (runs of count:uint16 LE, value). */
export function encodeCells(cells: Uint8Array): Uint8Array {
  const out: number[] = [];
  let i = 0;
  while (i < cells.length) {
    const v = cells[i];
    let n = 1;
    while (i + n < cells.length && cells[i + n] === v && n < 0xffff) n++;
    out.push(n & 0xff, (n >> 8) & 0xff, v);
    i += n;
  }
  return Uint8Array.from(out);
}

/** Decode an RLE payload back to CHUNK_VOL block ids. */
export function decodeCells(buf: Uint8Array): Uint8Array {
  const cells = new Uint8Array(CHUNK_VOL);
  let o = 0;
  for (let i = 0; i + 2 < buf.length; i += 3) {
    const n = buf[i] | (buf[i + 1] << 8);
    const v = buf[i + 2];
    cells.fill(v, o, o + n);
    o += n;
  }
  return cells;
}

/** Pack a chunk for the wire: [cx,cy,cz int32 LE][RLE cells]. */
export function packChunk(cx: number, cy: number, cz: number, cells: Uint8Array): Uint8Array {
  const payload = encodeCells(cells);
  const out = new Uint8Array(12 + payload.length);
  const dv = new DataView(out.buffer);
  dv.setInt32(0, cx, true);
  dv.setInt32(4, cy, true);
  dv.setInt32(8, cz, true);
  out.set(payload, 12);
  return out;
}

export interface UnpackedChunk {
  cx: number;
  cy: number;
  cz: number;
  cells: Uint8Array;
}

/** Unpack a wire chunk (accepts ArrayBuffer or a byte view). */
export function unpackChunk(buf: ArrayBuffer | Uint8Array): UnpackedChunk {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return {
    cx: dv.getInt32(0, true),
    cy: dv.getInt32(4, true),
    cz: dv.getInt32(8, true),
    cells: decodeCells(bytes.subarray(12)),
  };
}
