/**
 * Block registry. Each block maps its faces (top/side/bottom) to a texture name
 * in the atlas (see textures.ts, tiles from the CC-BY-SA baunilha pack). The
 * mesher multiplies the texture by a directional face shade + ambient occlusion
 * for the polished voxel look. Id 0 = air.
 */
export const AIR = 0;

/** Directional face shade (multiplied onto the texture via vertex colour). */
export const SHADE = { top: 1.0, side: 0.82, bottom: 0.6 } as const;

export interface BlockDef {
  name: string;
  tiles: { top: string; side: string; bottom: string };
  /** Texture used for the hotbar thumbnail. */
  tex: string;
}
function b(name: string, top: string, side: string, bottom: string, tex = side): BlockDef {
  return { name, tiles: { top, side, bottom }, tex };
}

// 1-indexed palette (0 is air).
export const BLOCKS: BlockDef[] = [
  b('air', '', '', ''),
  b('grass', 'grass_top', 'grass_side', 'dirt', 'grass_top'),
  b('dirt', 'dirt', 'dirt', 'dirt'),
  b('stone', 'stone', 'stone', 'stone'),
  b('wood', 'tree_top', 'tree_side', 'tree_top', 'tree_side'),
  b('leaves', 'leaves', 'leaves', 'leaves'),
  b('sand', 'sand', 'sand', 'sand'),
  b('brick', 'brick', 'brick', 'brick'),
];

/** Every unique tile the atlas must load. */
export const BLOCK_TEXTURES = ['grass_top', 'grass_side', 'dirt', 'stone', 'tree_side', 'tree_top', 'leaves', 'sand', 'brick'];

/** Palette offered in the hotbar (block ids), in order. */
export const HOTBAR: number[] = [1, 2, 3, 4, 5, 6, 7];
