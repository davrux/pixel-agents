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
 *  weight — a thin single-pixel outline read as spindly next to it. The real
 *  uponu wordmark is extremely rounded (O is a near-perfect ring, P's bowl and
 *  U's base are curved); U/P/O chamfer their outer top/bottom corners (a
 *  single pixel cut to `.` instead of `X`) to hint at that curvature within
 *  the grid — a standard low-cost pixel-art way to imply roundness without
 *  the resolution for a true curve. N is 7px wide: a 2px-thick vertical on
 *  each side with a 1px diagonal stepping through the 3 columns between them
 *  (top-left to bottom-right, 3 rows per step) — packing the diagonal to the
 *  same 2px thickness as the verticals leaves no room for the background gaps
 *  that make it read as a diagonal at all, so it collapses into a solid block
 *  instead of a letter. */
const GLYPHS: Record<string, string[]> = {
  U: ['XX.XX', 'XX.XX', 'XX.XX', 'XX.XX', 'XX.XX', 'XX.XX', 'XX.XX', 'XXXXX', '.XXX.'],
  P: ['.XXX.', 'XX.XX', 'XX.XX', 'XX.XX', 'XXXXX', 'XX...', 'XX...', 'XX...', 'XX...'],
  O: ['.XXX.', 'XX.XX', 'XX.XX', 'XX.XX', 'XX.XX', 'XX.XX', 'XX.XX', 'XX.XX', '.XXX.'],
  N: ['XXX..XX', 'XXX..XX', 'XXX..XX', 'XX.X.XX', 'XX.X.XX', 'XX.X.XX', 'XX..XXX', 'XX..XXX', 'XX..XXX'],
};
const GLYPH_H = 9;
const GAP = 1; // 1px between letters — with 0 they run together into an unreadable blob

/** The original tiny 5px-tall font, kept around as the "classic" dark variant
 *  below — some walls read better with the smaller, punchier plaque than the
 *  larger bold one. N is 4px wide so its diagonal doesn't collapse into a
 *  plain H. */
const GLYPHS_CLASSIC: Record<string, string[]> = {
  U: ['X.X', 'X.X', 'X.X', 'X.X', 'XXX'],
  P: ['XXX', 'X.X', 'XXX', 'X..', 'X..'],
  O: ['XXX', 'X.X', 'X.X', 'X.X', 'XXX'],
  N: ['X..X', 'XX.X', 'X.XX', 'X..X', 'X..X'],
};
const GLYPH_H_CLASSIC = 5;

const WORD = 'UPONU';

function wordWidth(glyphs: Record<string, string[]>, gap: number): number {
  const widths = [...WORD].map((ch) => glyphs[ch][0].length);
  return widths.reduce((a, b) => a + b, 0) + gap * (WORD.length - 1);
}

function drawWord(
  g: SpriteData,
  glyphs: Record<string, string[]>,
  glyphH: number,
  gap: number,
  left: number,
  top: number,
  ink: string,
): void {
  let cx = left;
  for (const ch of WORD) {
    const glyph = glyphs[ch];
    const w = glyph[0].length;
    for (let y = 0; y < glyphH; y++) {
      for (let x = 0; x < w; x++) {
        if (glyph[y][x] === 'X') g[top + y][cx + x] = ink;
      }
    }
    cx += w + gap;
  }
}

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

  const textW = wordWidth(GLYPHS, GAP);
  const textH = GLYPH_H;

  const padV = 1; // vertical breathing room within the panel
  const panelW = textW; // no horizontal pad — needs the full 32px width already
  const panelH = textH + padV * 2;
  const panelLeft = Math.floor((canvasW - panelW) / 2);
  const panelTop = Math.floor((canvasH - panelH) / 2);

  for (let y = 0; y < panelH; y++) {
    for (let x = 0; x < panelW; x++) g[panelTop + y][panelLeft + x] = panel;
  }
  drawWord(g, GLYPHS, GLYPH_H, GAP, panelLeft, panelTop + padV, ink);
  return g;
}

/** The original design: a white frame around a dark panel, with the wordmark
 *  in white ink — kept as a second, smaller/punchier plaque alongside the
 *  bold red-on-white one above, rather than replaced by it. */
export function logoSpriteClassic(): SpriteData {
  const canvasW = 32;
  const canvasH = 32;
  const g: SpriteData = Array.from({ length: canvasH }, () => new Array<string>(canvasW).fill(T));
  const frame = '#f4f2ee';
  const panel = '#242220';
  const ink = '#ffffff';

  const textW = wordWidth(GLYPHS_CLASSIC, 1);
  const textH = GLYPH_H_CLASSIC;

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

  for (let y = 0; y < frameH; y++) {
    for (let x = 0; x < frameW; x++) g[frameTop + y][frameLeft + x] = frame;
  }
  for (let y = 0; y < panelH; y++) {
    for (let x = 0; x < panelW; x++) g[panelTop + y][panelLeft + x] = panel;
  }
  drawWord(g, GLYPHS_CLASSIC, GLYPH_H_CLASSIC, 1, panelLeft + panelPad, panelTop + panelPad, ink);
  return g;
}

export interface LogoAsset {
  entry: Record<string, unknown>; // LoadedAssetData.catalog item shape
  sprite: SpriteData;
}

/** Catalog entries + sprites for the uponu wall logos, to merge into the bundle. */
export function logoAssets(): LogoAsset[] {
  const base = {
    category: 'wall',
    width: 32,
    height: 32,
    footprintW: 2,
    footprintH: 2,
    isDesk: false,
    // Wall-only, same as the whiteboard — a logo plaque doesn't belong on the
    // floor or a desk.
    canPlaceOnWalls: true,
    canPlaceOnSurfaces: false,
  };
  return [
    {
      entry: { ...base, id: 'UPONU_LOGO', label: 'Uponu Logo' },
      sprite: logoSprite(),
    },
    {
      entry: { ...base, id: 'UPONU_LOGO_DARK', label: 'Uponu Logo (Dark)' },
      sprite: logoSpriteClassic(),
    },
  ];
}
