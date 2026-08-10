/**
 * The "uponu" wall logos, injected into the furniture catalog at load time (like
 * the conference monitor): real, editable furniture following WHITEBOARD.png's
 * wall-hanging convention, not baked into a static PNG. Two variants — the traced
 * wordmark and the older framed plaque.
 */
import type { SpriteData } from '@pixel/shared/office/types.js';

const T = ''; // transparent

/** The real wordmark, traced 1:1 from the source pixel art (Documents/
 *  pixeluponu.png — a 42×8 grid upscaled 48× to 2000×367, pure white on
 *  transparent, every module solid). Stored as the finished 42×8 image rather
 *  than as a per-letter font + kerning pass: the letterforms are lowercase and
 *  individually kerned (the `o` and second `u` are wider than the first `u`,
 *  the `p` carries a descender into the last row), so reassembling them from
 *  uniform glyph cells would not reproduce it. One char per pixel, `X` = ink. */
const WORDMARK = [
  'XX...XX..XXXXX....XXXX...XXXXXX...XX...XXX',
  'XX...XXX.XXXXXX..XXXXXX..XXXXXXX..XX...XXX',
  'XX...XXX.....XX..XX..XXX.XXX..XX..XX...XXX',
  'XX...XXX.....XX.XXX...XX.XX...XXX.XX...XXX',
  'XX...XXX.XXXXXX..XX...XX.XX...XXX.XXX..XXX',
  'XXXXXXXX.XXXXXX..XXXXXXX.XX...XXX..XXXXXXX',
  '.XXXXXXX.XXXX.....XXXXX..XX...XXX..XXXXXXX',
  '..XXXXX..XX........XXX...XX....XX....XXXXX',
];
const WORDMARK_W = WORDMARK[0].length; // 42
const WORDMARK_H = WORDMARK.length; // 8

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

/** The wordmark itself, centered on a transparent canvas — no panel and no
 *  frame, matching the source art: white ink straight onto the wall (WALL_COLOR
 *  is dark, so it reads without a backing plate). 3 tiles wide rather than the
 *  whiteboard's 2, because the 42px wordmark does not fit in 32px and scaling
 *  it down would land on fractional pixels and destroy the letterforms. */
export function logoSprite(): SpriteData {
  const canvasW = 48; // 3 tiles
  const canvasH = 32; // 2 tiles
  const g: SpriteData = Array.from({ length: canvasH }, () => new Array<string>(canvasW).fill(T));
  const ink = '#ffffff';

  const left = Math.floor((canvasW - WORDMARK_W) / 2);
  const top = Math.floor((canvasH - WORDMARK_H) / 2);
  for (let y = 0; y < WORDMARK_H; y++) {
    for (let x = 0; x < WORDMARK_W; x++) {
      if (WORDMARK[y][x] === 'X') g[top + y][left + x] = ink;
    }
  }
  return g;
}

/** The original design: a white frame around a dark panel, with the wordmark
 *  in white ink — kept as a second, smaller/punchier plaque alongside the
 *  traced wordmark above, rather than replaced by it. Still uses the hand-built
 *  5px font, since it is a plaque of its own design, not a copy of the art. */
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
    height: 32,
    footprintH: 2,
    isDesk: false,
    canPlaceOnSurfaces: false,
  };
  // width/footprintW are per-entry: the traced wordmark needs 3 tiles, the
  // classic plaque still fits in 2.
  return [
    {
      entry: { ...base, id: 'UPONU_LOGO', label: 'Uponu Logo', width: 48, footprintW: 3 },
      sprite: logoSprite(),
    },
    {
      entry: { ...base, id: 'UPONU_LOGO_DARK', label: 'Uponu Logo (Dark)', width: 32, footprintW: 2 },
      sprite: logoSpriteClassic(),
    },
  ];
}
