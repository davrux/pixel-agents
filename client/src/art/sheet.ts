/**
 * Turning a PNG sheet back into engine-native SpriteData, in the browser.
 *
 * The server now sends art as a URL instead of pixels (see server/src/artApi.ts), so
 * the client fetches the sheet once per skin and slices it here. One implementation on
 * purpose: the character editor's "import a PNG" does the same slicing, and two copies
 * of "which pixel belongs to which frame" is how the two paths would drift.
 *
 * Layout, matching the encoder: rows are directions in the order down, up, right, left
 * (a sheet with three rows simply has no left row — the renderer mirrors right), and
 * columns are frames left to right. The row COUNT comes from the image height rather
 * than from the direction list, so a sheet that carries a left row keeps it and one that
 * does not is not invented.
 */
import type { SpriteData } from '@pixel/shared/office/types.js';

import { serverFetch } from '../net/room';

/** Row order of a sheet. A file may stop after any of them. */
export const SHEET_DIRECTIONS = ['down', 'up', 'right', 'left'] as const;
export type SheetDirection = (typeof SHEET_DIRECTIONS)[number];

/** Decode an image into a full-size pixel buffer (nearest-neighbour, no smoothing). */
export function imagePixels(img: HTMLImageElement | ImageBitmap): ImageData {
  const w = 'naturalWidth' in img ? img.naturalWidth : img.width;
  const h = 'naturalHeight' in img ? img.naturalHeight : img.height;
  const cv = document.createElement('canvas');
  cv.width = w;
  cv.height = h;
  const ctx = cv.getContext('2d')!;
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(img as CanvasImageSource, 0, 0);
  return ctx.getImageData(0, 0, w, h);
}

/**
 * Read a w×h region of decoded pixels as SpriteData (`#rrggbb`, `#rrggbbaa` when
 * partially transparent, '' when fully transparent). Reads outside the image yield
 * transparent, so a short sheet cannot throw.
 */
export function gridFromImageData(px: ImageData, sx: number, sy: number, w: number, h: number): SpriteData {
  const hx = (n: number): string => n.toString(16).padStart(2, '0');
  const grid: SpriteData = [];
  for (let y = 0; y < h; y++) {
    const row: string[] = [];
    for (let x = 0; x < w; x++) {
      if (sx + x >= px.width || sy + y >= px.height) {
        row.push('');
        continue;
      }
      const i = ((sy + y) * px.width + (sx + x)) * 4;
      const a = px.data[i + 3];
      row.push(a === 0 ? '' : `#${hx(px.data[i])}${hx(px.data[i + 1])}${hx(px.data[i + 2])}${a < 255 ? hx(a) : ''}`);
    }
    grid.push(row);
  }
  return grid;
}

/** Slice a decoded sheet into direction-keyed frame arrays. */
export function sheetToDirections(
  px: ImageData,
  frameW: number,
  frameH: number,
): Partial<Record<SheetDirection, SpriteData[]>> {
  const cols = Math.max(1, Math.floor(px.width / frameW));
  const rows = Math.min(SHEET_DIRECTIONS.length, Math.max(1, Math.floor(px.height / frameH)));
  const out: Partial<Record<SheetDirection, SpriteData[]>> = {};
  for (let r = 0; r < rows; r++) {
    out[SHEET_DIRECTIONS[r]] = Array.from({ length: cols }, (_, c) =>
      gridFromImageData(px, c * frameW, r * frameH, frameW, frameH),
    );
  }
  return out;
}

/** Fetch a sheet from the server and slice it. Throws if it cannot be decoded. */
export async function fetchSheet(
  url: string,
  frameW: number,
  frameH: number,
): Promise<Partial<Record<SheetDirection, SpriteData[]>>> {
  const res = await serverFetch(url);
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  const bitmap = await createImageBitmap(await res.blob());
  try {
    return sheetToDirections(imagePixels(bitmap), frameW, frameH);
  } finally {
    bitmap.close();
  }
}
