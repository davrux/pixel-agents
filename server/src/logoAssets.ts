/**
 * Generated placeholder "uponu" wall logo, injected into the furniture catalog at
 * load time (like the conference monitor — refine the art in the in-game furniture
 * editor if wanted). A small framed plaque, same footprint/wall-hanging convention
 * as WHITEBOARD.png: real furniture, editable, not baked into a static PNG.
 */
import type { SpriteData } from '@pixel/shared/office/types.js';

const T = ''; // transparent

/** Tiny 5px-tall block font — just enough glyphs to spell "UPONU". Widths vary
 *  per glyph (N is 4px wide so its diagonal doesn't collapse into a plain H). */
const GLYPHS: Record<string, string[]> = {
  U: ['X.X', 'X.X', 'X.X', 'X.X', 'XXX'],
  P: ['XXX', 'X.X', 'XXX', 'X..', 'X..'],
  O: ['XXX', 'X.X', 'X.X', 'X.X', 'XXX'],
  N: ['X..X', 'XX.X', 'X.XX', 'X..X', 'X..X'],
};
const GLYPH_H = 5;

/** A small framed plaque: white frame + dark panel + the "UPONU" wordmark, same
 *  2×2 canvas as the whiteboard but — like WHITEBOARD.png itself — only a small
 *  centered block is actually drawn, with transparent margin around it, so it
 *  reads as a plaque hanging on the wall rather than a block filling the tile. */
export function logoSprite(): SpriteData {
  const canvasW = 32;
  const canvasH = 32;
  const g: SpriteData = Array.from({ length: canvasH }, () => new Array<string>(canvasW).fill(T));
  const frame = '#f4f2ee';
  const panel = '#ffffff';
  const ink = '#c51a1b';

  const word = 'UPONU';
  const widths = [...word].map((ch) => GLYPHS[ch][0].length);
  const textW = widths.reduce((a, b) => a + b, 0) + (word.length - 1); // letters + 1px gaps
  const textH = GLYPH_H;

  const panelPad = 2; // panel margin around the text
  const framePad = 2; // frame thickness around the panel
  const panelW = textW + panelPad * 2;
  const panelH = textH + panelPad * 2;
  const frameW = panelW + framePad * 2;
  const frameH = panelH + framePad * 2;
  const frameLeft = Math.floor((canvasW - frameW) / 2);
  const frameTop = Math.floor((canvasH - frameH) / 2);
  const panelLeft = frameLeft + framePad;
  const panelTop = frameTop + framePad;
  const textLeft = panelLeft + panelPad;
  const textTop = panelTop + panelPad;

  for (let y = 0; y < frameH; y++) {
    for (let x = 0; x < frameW; x++) g[frameTop + y][frameLeft + x] = frame;
  }
  for (let y = 0; y < panelH; y++) {
    for (let x = 0; x < panelW; x++) g[panelTop + y][panelLeft + x] = panel;
  }
  let cx = textLeft;
  for (const ch of word) {
    const glyph = GLYPHS[ch];
    const w = glyph[0].length;
    for (let y = 0; y < GLYPH_H; y++) {
      for (let x = 0; x < w; x++) {
        if (glyph[y][x] === 'X') g[textTop + y][cx + x] = ink;
      }
    }
    cx += w + 1;
  }
  return g;
}

export interface LogoAsset {
  entry: Record<string, unknown>; // LoadedAssetData.catalog item shape
  sprite: SpriteData;
}

/** Catalog entry + sprite for the uponu wall logo, to merge into the bundle. */
export function logoAssets(): LogoAsset[] {
  return [
    {
      entry: {
        id: 'UPONU_LOGO',
        label: 'Uponu Logo',
        category: 'wall',
        width: 32,
        height: 32,
        footprintW: 2,
        footprintH: 2,
        isDesk: false,
        // Wall-only, same as the whiteboard — a logo plaque doesn't belong on
        // the floor or a desk.
        canPlaceOnWalls: true,
        canPlaceOnSurfaces: false,
      },
      sprite: logoSprite(),
    },
  ];
}
