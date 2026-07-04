/**
 * Block registry. Each block maps its faces (top/side/bottom) to a texture name
 * in the atlas (tiles from the CC-BY-SA baunilha pack). The mesher multiplies the
 * texture by directional face shade + ambient occlusion. Id 0 = air. Adding a
 * block here is enough — BLOCK_TEXTURES (atlas) is derived from the defs.
 */
export const AIR = 0;

/** Directional face shade (multiplied onto the texture via vertex colour). */
export const SHADE = { top: 1.0, side: 0.82, bottom: 0.6 } as const;

export interface BlockDef {
  name: string;
  tiles: { top: string; side: string; bottom: string };
  tex: string; // hotbar/picker thumbnail
}
function b(name: string, top: string, side: string, bottom: string, tex = side): BlockDef {
  return { name, tiles: { top, side, bottom }, tex };
}
function u(name: string, tile: string): BlockDef {
  return b(name, tile, tile, tile, tile);
}

// 1-indexed palette (0 is air).
export const BLOCKS: BlockDef[] = [
  b('air', '', '', ''),
  b('grass', 'grass_top', 'grass_side', 'dirt', 'grass_top'),
  u('dirt', 'dirt'),
  u('stone', 'stone'),
  u('cobble', 'cobble'),
  u('mossy cobble', 'mossycobble'),
  u('gravel', 'gravel'),
  u('sand', 'sand'),
  u('desert sand', 'desert_sand'),
  u('sandstone', 'sandstone'),
  u('desert stone', 'desert_stone'),
  u('clay', 'clay'),
  u('snow', 'snow'),
  u('ice', 'ice'),
  u('glass', 'glass'),
  u('obsidian', 'obsidian'),
  u('obsidian glass', 'obsidian_glass'),
  b('wood', 'tree_top', 'tree_side', 'tree_top', 'tree_side'),
  u('planks', 'acacia_wood'),
  u('jungle planks', 'junglewood'),
  u('pine planks', 'pine_wood'),
  u('leaves', 'leaves'),
  u('brick', 'brick'),
  u('coal block', 'coal_block'),
  u('copper block', 'copper_block'),
  u('bronze block', 'bronze_block'),
  u('diamond block', 'diamond_block'),
  u('water', 'water'), // id 27 — generated lakes/seas (synthetic tile)
  b('portal', 'glass', 'portal', 'glass', 'portal'), // id 28 — glass cube with a P on the sides
  u('lava', 'lava'), // id 29 — placeable liquid (synthetic tile); flows + burns
  u('coal ore', 'coal_ore'), // id 30 — stone + coal speckle (synthetic composite)
  u('iron ore', 'iron_ore'), // id 31 — stone + iron speckle (synthetic composite)
  u('ladder', 'ladder'), // id 32 — non-solid, climbable (Luanti wood ladder)
  u('torch', 'torch'), // id 33 — non-solid light source (emits a point light nearby)
  b('chest', 'chest_top', 'chest_front', 'chest_top', 'chest_front'), // id 34 — openable storage node
  u('door', 'door'), // id 35 — door (closed): solid, 2-tall, toggles with id 36 on use
  u('door (open)', 'door'), // id 36 — door (open): non-solid + not rendered (walk through)
  u('copper ore', 'copper_ore'), // id 37 — stone + copper speckle (synthetic composite)
  u('tin ore', 'tin_ore'), // id 38
  u('gold ore', 'gold_ore'), // id 39
];

// ── id 40..50 are RESERVED for the fluid FLOW levels (see protocol WATER_FLOW 40-46 /
// LAVA_FLOW 47-50). Those cells are rendered via the fluid path (BLOCKS[source]), never
// via BLOCKS[id], but the array must stay dense so real blocks can use ids ≥ 51. Fill
// the gap with a placeholder and keep them out of the placeable palette (HIDDEN below).
while (BLOCKS.length <= 50) BLOCKS.push(u('(reserved: fluid flow)', 'stone'));
// New content blocks start at id 51 (above the fluid-flow band).
BLOCKS.push(
  u('tall grass', 'tall_grass'), // 51 — cross-plant, plains
  u('fern', 'fern'), // 52 — cross-plant, plains
  u('rose', 'rose'), // 53 — cross-plant, plains
  u('dandelion', 'dandelion'), // 54 — cross-plant, plains
  u('dry shrub', 'dry_shrub'), // 55 — cross-plant, desert
  b('cactus', 'cactus_top', 'cactus_side', 'cactus_top', 'cactus_side'), // 56 — solid cube, desert
  u('wheat', 'wheat_1'), // 57 — wheat seedling (plantable); grows 57→60
  u('wheat', 'wheat_2'), // 58 — growth stage
  u('wheat', 'wheat_3'), // 59 — growth stage
  u('wheat', 'wheat_4'), // 60 — mature (harvest)
  u('straw', 'straw'), // 61 — solid cube (9 wheat)
);

export const WATER_ID = 27;
export const PORTAL_ID = 28;
export const LAVA_ID = 29;
export const LADDER_ID = 32;
export const TORCH_ID = 33;
export const CHEST_ID = 34;
export const DOOR_CLOSED = 35;
export const DOOR_OPEN = 36;

/** Cross-plants: rendered as two crossed double-sided quads (an "X"), not a cube.
 *  tall grass, fern, rose, dandelion, dry shrub + wheat crop stages. Non-solid + transparent. */
export const PLANT = new Set<number>([51, 52, 53, 54, 55, 57, 58, 59, 60]);

/** Transparent blocks: they must NOT hide the faces of adjacent opaque blocks (you
 *  should see the block behind glass/leaves/plants THROUGH it), and only cull against
 *  the same id. ice, glass, obsidian glass, leaves, portal, ladder, torch, doors, plants. */
export const TRANSPARENT = new Set<number>([13, 14, 16, 21, 28, 32, 33, 35, 36, ...PLANT]);

/** Non-solid blocks: the player passes through them (like fluids). Ladders, torches,
 *  open doors, cross-plants. */
export const NONSOLID = new Set<number>([LADDER_ID, TORCH_ID, DOOR_OPEN, ...PLANT]);
/** Climbable blocks: overlapping one lets the player climb (up/down, no fall). */
export const CLIMBABLE = new Set<number>([LADDER_ID]);
/** Light-emitting blocks: the client places a point light at nearby instances. */
export const LIGHT_BLOCKS = new Set<number>([TORCH_ID]);
/** Blocks the mesher never draws (present for physics/state only). An open door. */
export const RENDER_SKIP = new Set<number>([DOOR_OPEN]);
/** Blocks kept out of the placeable palette: an open door, the reserved fluid-flow
 *  ids 40..50, and wheat growth states 58-60 (only the 57 seedling is plantable). */
export const HIDDEN = new Set<number>([DOOR_OPEN, 40, 41, 42, 43, 44, 45, 46, 47, 48, 49, 50, 58, 59, 60]);

/** Tiles drawn at runtime (not PNG files): water, lava, portal + composited ores. */
export const SYNTHETIC_TILES = ['water', 'portal', 'lava', 'coal_ore', 'iron_ore', 'copper_ore', 'tin_ore', 'gold_ore'];

/** Every PNG tile the atlas must load (derived from defs, minus synthetic ones). */
export const BLOCK_TEXTURES = [...new Set(BLOCKS.slice(1).flatMap((d) => [d.tiles.top, d.tiles.side, d.tiles.bottom]))].filter(
  (t) => !SYNTHETIC_TILES.includes(t),
);

/** Extra PNGs loaded into the atlas' image map but NOT used as block faces — they're
 *  composited by synthetic tiles (e.g. stone + mineral overlay → ore). */
export const OVERLAY_TEXTURES = ['mineral_coal', 'mineral_iron', 'mineral_copper', 'mineral_tin', 'mineral_gold'];

/** All placeable block ids (everything except air + state-only hidden ids). */
export const ALL_BLOCK_IDS = BLOCKS.map((_, i) => i).filter((i) => i > 0 && !HIDDEN.has(i));

/** Default quick-slot hotbar (block ids) — the "b" picker can swap any slot. */
export const DEFAULT_HOTBAR = [1, 2, 3, 4, 7, 17, 21, 22, 15];
