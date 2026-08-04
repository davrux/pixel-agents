/**
 * Generated placeholder "uponu" wall logo, injected into the furniture catalog at
 * load time (like the conference monitor — refine the art in the in-game furniture
 * editor if wanted). A small framed plaque, same footprint/wall-hanging convention
 * as WHITEBOARD.png: real furniture, editable, not baked into a static PNG.
 */
import type { SpriteData } from '@pixel/shared/office/types.js';

const T = ''; // transparent

/** Bold 9px-tall block font — just enough glyphs to spell "UPONU", with 2px-
 *  thick strokes (vs. a 1px hairline) to match the real wordmark's chunky
 *  weight — a thin single-pixel outline read as spindly next to it. N is 6px
 *  wide (vs. 5 for the others) so its diagonal doesn't collapse into a plain H. */
const GLYPHS: Record<string, string[]> = {
  U: ['XX.XX', 'XX.XX', 'XX.XX', 'XX.XX', 'XX.XX', 'XX.XX', 'XX.XX', 'XXXXX', 'XXXXX'],
  P: ['XXXXX', 'XX.XX', 'XX.XX', 'XX.XX', 'XXXXX', 'XX...', 'XX...', 'XX...', 'XX...'],
  O: ['XXXXX', 'XX.XX', 'XX.XX', 'XX.XX', 'XX.XX', 'XX.XX', 'XX.XX', 'XX.XX', 'XXXXX'],
  N: ['XXX.XX', 'XXX.XX', 'XXX.XX', 'XXX.XX', 'XXXXXX', 'XX.XXX', 'XX.XXX', 'XX.XXX', 'XX.XXX'],
};
const GLYPH_H = 9;
const GAP = 1; // 1px between letters — with 0 they run together into an unreadable blob

/** A small plaque: an off-white background + the "UPONU" wordmark, same 2×2
 *  canvas as the whiteboard but — like WHITEBOARD.png itself — only a small
 *  centered block is actually drawn, with transparent margin above/below, so
 *  it reads as a plaque hanging on the wall rather than a block filling the
 *  tile. No separate frame layer: now that the background is white (was a
 *  dark panel), a white-on-white frame would be invisible anyway. */
export function logoSprite(): SpriteData {
  const canvasW = 32;
  const canvasH = 32;
  const g: SpriteData = Array.from({ length: canvasH }, () => new Array<string>(canvasW).fill(T));
  const panel = '#f4f2ee';
  const ink = '#c51a1b';

  const word = 'UPONU';
  const widths = [...word].map((ch) => GLYPHS[ch][0].length);
  const textW = widths.reduce((a, b) => a + b, 0) + GAP * (word.length - 1);
  const textH = GLYPH_H;

  const padV = 1; // vertical breathing room within the panel
  const panelW = textW; // no horizontal pad — needs the full 32px width already
  const panelH = textH + padV * 2;
  const panelLeft = Math.floor((canvasW - panelW) / 2);
  const panelTop = Math.floor((canvasH - panelH) / 2);
  const textLeft = panelLeft;
  const textTop = panelTop + padV;

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
    cx += w + GAP;
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
