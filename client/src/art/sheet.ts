/**
 * Reading pixels out of an image, in the browser.
 *
 * Two callers, both of which genuinely work on pixels: the sheet store, which hands cells
 * to the character editor and to the Matrix effect (see art/sheetStore.ts), and the
 * editor's own "import a PNG". The drawing path does not appear here — it points the GPU
 * at a cell of the sheet instead (`atlasFromImage`).
 */
import type { SpriteData } from '@pixel/shared/office/types.js';

import { serverFetch } from '../net/room';

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

/** Fetch a sheet as an image — no slicing, no pixels. What the renderer registers. */
export async function fetchSheetBitmap(url: string): Promise<ImageBitmap> {
  const res = await serverFetch(url);
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return createImageBitmap(await res.blob());
}
