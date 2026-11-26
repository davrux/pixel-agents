/**
 * Any picture a player chooses, turned into what a television accepts: a grid of equal frames in
 * one PNG plus a delay per frame (see `shared/office/tvScreen.ts` for why the CLIENT does this —
 * the browser can decode every format, so the server only ever has to check a PNG).
 *
 * A GIF goes through our own decoder so it animates in every browser; anything else the browser
 * can open (PNG, JPEG, WebP, …) through `createImageBitmap`, as a single still frame — an animated
 * WebP or APNG therefore shows its first frame, which is the honest answer for formats with no
 * decoder here.
 */
import {
  TV_MAX_FRAMES,
  TV_MAX_FRAME_H,
  TV_MAX_FRAME_W,
  tvFrameDelay,
  tvFrameRect,
  tvGrid,
} from '@pixel/shared/office/tvScreen.js';

import { isGif, parseGif, renderGif } from './gifDecode.js';

export interface TvPicture {
  png: Blob;
  frameW: number;
  frameH: number;
  delays: number[];
}

/** Read at most this much of a file. A 50 MB GIF is a video, and the result is 48 frames anyway. */
const MAX_FILE_BYTES = 50 * 1024 * 1024;

/** Fit w×h inside the television's frame bounds, keeping the aspect and never scaling up. */
function fitFrame(w: number, h: number): { w: number; h: number } {
  const s = Math.min(1, TV_MAX_FRAME_W / w, TV_MAX_FRAME_H / h);
  return { w: Math.max(1, Math.round(w * s)), h: Math.max(1, Math.round(h * s)) };
}

/**
 * Which source frames to keep when there are more than TV_MAX_FRAMES, spread evenly, and the delay
 * each kept frame then lasts — the sum of the frames it stands in for, so the loop still takes as
 * long as the original and plays to its end rather than being cut off.
 */
export function thinFrames(delays: number[], max = TV_MAX_FRAMES): { keep: number[]; delays: number[] } {
  const n = delays.length;
  if (n <= max) return { keep: delays.map((_, i) => i), delays: delays.map(tvFrameDelay) };
  const keep: number[] = [];
  for (let k = 0; k < max; k++) keep.push(Math.floor((k * n) / max));
  const out = keep.map((start, k) => {
    const end = k + 1 < keep.length ? keep[k + 1] : n;
    let sum = 0;
    for (let i = start; i < end; i++) sum += tvFrameDelay(delays[i]);
    return Math.min(sum, 65_535);
  });
  return { keep, delays: out };
}

function canvas(w: number, h: number): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
}

function ctx2d(c: HTMLCanvasElement): CanvasRenderingContext2D {
  const ctx = c.getContext('2d');
  if (!ctx) throw new Error('no 2D canvas');
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  return ctx;
}

export async function packTvPicture(file: File): Promise<TvPicture> {
  if (file.size > MAX_FILE_BYTES) throw new Error('That file is too big (50 MB at most).');
  const bytes = new Uint8Array(await file.arrayBuffer());

  // One source frame at a time is drawn into its cell, scaled; nothing but the grid is kept.
  const pack = (srcW: number, srcH: number, delays: number[], draw: (into: (src: CanvasImageSource, i: number) => void) => void): Promise<TvPicture> => {
    const frame = fitFrame(srcW, srcH);
    const grid = tvGrid(frame.w, frame.h, delays.length);
    const out = canvas(grid.width, grid.height);
    const g = ctx2d(out);
    draw((src, i) => {
      const at = tvFrameRect(i, frame.w, frame.h, grid.cols);
      g.drawImage(src, at.x, at.y, frame.w, frame.h);
    });
    return new Promise((resolve, reject) =>
      out.toBlob((blob) => (blob ? resolve({ png: blob, frameW: frame.w, frameH: frame.h, delays }) : reject(new Error('could not encode'))), 'image/png'),
    );
  };

  if (isGif(bytes)) {
    const gif = parseGif(bytes);
    const { keep, delays } = thinFrames(gif.frames.map((f) => f.delay));
    const slot = new Map(keep.map((src, k) => [src, k]));
    const full = canvas(gif.width, gif.height);
    const fg = full.getContext('2d');
    if (!fg) throw new Error('no 2D canvas');
    return pack(gif.width, gif.height, delays, (into) => {
      renderGif(gif, bytes, (i) => slot.has(i), (i, rgba) => {
        fg.putImageData(new ImageData(new Uint8ClampedArray(rgba), gif.width, gif.height), 0, 0);
        into(full, slot.get(i)!);
      });
    });
  }

  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(new Blob([bytes], { type: file.type || 'application/octet-stream' }));
  } catch {
    throw new Error('That file is not a picture this browser can open.');
  }
  try {
    return await pack(bitmap.width, bitmap.height, [0].map(tvFrameDelay), (into) => into(bitmap, 0));
  } finally {
    bitmap.close();
  }
}
