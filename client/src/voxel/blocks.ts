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
];

/** Every unique tile the atlas must load (derived from the block defs). */
export const BLOCK_TEXTURES = [...new Set(BLOCKS.slice(1).flatMap((d) => [d.tiles.top, d.tiles.side, d.tiles.bottom]))];

/** All placeable block ids (everything except air). */
export const ALL_BLOCK_IDS = BLOCKS.map((_, i) => i).filter((i) => i > 0);

/** Default quick-slot hotbar (block ids) — the "b" picker can swap any slot. */
export const DEFAULT_HOTBAR = [1, 2, 3, 4, 7, 17, 21, 22, 15];
