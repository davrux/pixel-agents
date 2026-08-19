/**
 * The client's character and NPC art: one PNG sheet per skin, kept as an image.
 *
 * This is what replaced decoding every sheet into SpriteData. The renderer asks for a
 * cell and gets an atlas frame (`atlasFromImage` — one `drawImage`, packed lazily on
 * first use, so a pose nobody strikes costs nothing). Pixels are handed out too, but only
 * to the two callers that genuinely work on pixels: the Matrix effect, which generates
 * its own image every frame, and the character editor, which paints them.
 *
 * Rows are down, up, right, left (see CHARACTER_DIRECTIONS). A sheet drawn before left
 * became a row has three, and its left cells are written as a mirrored right — once, at
 * pack time, not per draw. The seated placeholder for a character with no `sit` track is
 * packed the same way, shifted down and clipped.
 */
import type Phaser from 'phaser';

import type { SpriteData } from '@pixel/shared/office/types.js';

import { atlasFromImage, type SpriteTex } from '../render/sprites';
import { gridFromImageData, imagePixels } from './sheet';

interface Sheet {
  bitmap: ImageBitmap;
  frameW: number;
  frameH: number;
  cols: number;
  /** Rows the file has: 3 (left mirrored at pack time) or 4. */
  rows: number;
  /** Atlas frames by `row:col` (`s` prefix = the seated placeholder). */
  frames: Map<string, SpriteTex>;
  /** Decoded pixels, only materialised if somebody asks (editor, Matrix effect). */
  pixels?: ImageData;
  /** The whole sheet as SpriteData rows — memoised, since the editor and every
   *  thumbnail ask for it repeatedly while a menu is open. */
  template?: { down: SpriteData[]; up: SpriteData[]; right: SpriteData[]; left: SpriteData[] };
}

const sheets = new Map<string, Sheet>();

/** Register (or replace) a skin's sheet. Existing atlas frames are dropped: the art
 *  changed, so a cached frame would draw the previous version. */
export function registerSheet(id: string, bitmap: ImageBitmap, frameW: number, frameH: number): void {
  sheets.set(id, {
    bitmap,
    frameW,
    frameH,
    cols: Math.max(1, Math.floor(bitmap.width / frameW)),
    rows: Math.max(1, Math.floor(bitmap.height / frameH)),
    frames: new Map(),
  });
}

export function hasSheet(id: string): boolean {
  return sheets.has(id);
}

export function forgetSheet(id: string): void {
  sheets.delete(id);
}

/** Frame size of a registered sheet — what the renderer needs besides the texture. */
export function sheetFrameSize(id: string): { w: number; h: number } | null {
  const s = sheets.get(id);
  return s ? { w: s.frameW, h: s.frameH } : null;
}

/** How many columns the sheet actually has — the bound a pose resolves against. */
export function sheetColumns(id: string): number {
  return sheets.get(id)?.cols ?? 0;
}

/**
 * The atlas frame for one cell. `row` is the direction (0 down … 3 left) and `col` the
 * pose's column; `seated` packs the placeholder instead (shifted down, clipped).
 *
 * A left cell on a three-row sheet is packed mirrored from the right row, so callers
 * never have to know which kind of sheet they got.
 */
export function sheetCellFrame(scene: Phaser.Scene, id: string, row: number, col: number, seated = false): SpriteTex | null {
  const s = sheets.get(id);
  if (!s) return null;
  const c = Math.max(0, Math.min(col, s.cols - 1));
  const wantRow = Math.max(0, Math.min(row, 3));
  const mirror = wantRow === 3 && s.rows < 4;
  const srcRow = mirror ? 2 : Math.min(wantRow, s.rows - 1);
  const key = `${seated ? 's' : ''}${wantRow}:${c}`;
  const hit = s.frames.get(key);
  if (hit && scene.textures.exists(hit.key)) return hit;
  const tex = atlasFromImage(
    scene,
    s.bitmap,
    { x: c * s.frameW, y: srcRow * s.frameH, w: s.frameW, h: s.frameH },
    // 28 % of the height, the same shift the pixel placeholder used, so a seated
    // character sits at the height everybody is used to.
    { mirror, shiftY: seated ? Math.max(2, Math.round(s.frameH * 0.28)) : 0 },
  );
  s.frames.set(key, tex);
  return tex;
}

/**
 * One cell as SpriteData. For the Matrix effect (which rebuilds its own pixels every
 * frame) and the editor; the drawing path never needs this. The decode happens once per
 * sheet and is cached — `getImageData` of a whole sheet is one call.
 */
export function sheetCellPixels(id: string, row: number, col: number): SpriteData | null {
  const s = sheets.get(id);
  if (!s) return null;
  if (!s.pixels) s.pixels = imagePixels(s.bitmap);
  const mirror = row === 3 && s.rows < 4;
  const srcRow = mirror ? 2 : Math.min(row, s.rows - 1);
  const grid = gridFromImageData(s.pixels, col * s.frameW, srcRow * s.frameH, s.frameW, s.frameH);
  return mirror ? grid.map((r) => r.slice().reverse()) : grid;
}

/** Every row of a sheet as SpriteData — what the editor opens and what a thumbnail
 *  draws from. Left is materialised (mirrored when the sheet has three rows) so the
 *  editor always starts from four real rows. Memoised per sheet: this is the one
 *  expensive read, and a menu asks for it once per repaint. */
export function sheetTemplate(id: string): { down: SpriteData[]; up: SpriteData[]; right: SpriteData[]; left: SpriteData[] } | null {
  const s = sheets.get(id);
  if (!s) return null;
  if (s.template) return s.template;
  const row = (r: number): SpriteData[] =>
    Array.from({ length: s.cols }, (_, c) => sheetCellPixels(id, r, c)!).filter(Boolean);
  s.template = { down: row(0), up: row(1), right: row(2), left: row(3) };
  return s.template;
}
