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
];

export const WATER_ID = 27;
export const PORTAL_ID = 28;
export const LAVA_ID = 29;
export const LADDER_ID = 32;
export const TORCH_ID = 33;

/** Transparent blocks: they must NOT hide the faces of adjacent opaque blocks (you
 *  should see the block a glass pane sits on THROUGH it), and only cull against the
 *  same id (connected glass/ice). ice, glass, obsidian glass, leaves, portal, ladder, torch. */
export const TRANSPARENT = new Set<number>([13, 14, 16, 21, 28, 32, 33]);

/** Non-solid blocks: the player passes through them (like fluids). Ladders + torches. */
export const NONSOLID = new Set<number>([LADDER_ID, TORCH_ID]);
/** Climbable blocks: overlapping one lets the player climb (up/down, no fall). */
export const CLIMBABLE = new Set<number>([LADDER_ID]);
/** Light-emitting blocks: the client places a point light at nearby instances. */
export const LIGHT_BLOCKS = new Set<number>([TORCH_ID]);

/** Tiles drawn at runtime (not PNG files): water, lava, portal + composited ores. */
export const SYNTHETIC_TILES = ['water', 'portal', 'lava', 'coal_ore', 'iron_ore'];

/** Every PNG tile the atlas must load (derived from defs, minus synthetic ones). */
export const BLOCK_TEXTURES = [...new Set(BLOCKS.slice(1).flatMap((d) => [d.tiles.top, d.tiles.side, d.tiles.bottom]))].filter(
  (t) => !SYNTHETIC_TILES.includes(t),
);

/** Extra PNGs loaded into the atlas' image map but NOT used as block faces — they're
 *  composited by synthetic tiles (e.g. stone + mineral overlay → ore). */
export const OVERLAY_TEXTURES = ['mineral_coal', 'mineral_iron'];

/** All placeable block ids (everything except air). */
export const ALL_BLOCK_IDS = BLOCKS.map((_, i) => i).filter((i) => i > 0);

/** Default quick-slot hotbar (block ids) — the "b" picker can swap any slot. */
export const DEFAULT_HOTBAR = [1, 2, 3, 4, 7, 17, 21, 22, 15];
