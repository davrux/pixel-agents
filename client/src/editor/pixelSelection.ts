/**
 * Shared marquee selection + pixel clipboard for the sprite editors. The
 * clipboard is module-global, so a region copied in one frame can be pasted into
 * another frame — or even across editors (character ↔ furniture).
 */
import type { SpriteData } from '@pixel/shared/office/types.js';

/** A rectangle in sprite-pixel coordinates. */
export interface PixelRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

let clipboard: SpriteData | null = null;

/** Rect from two corner cells (inclusive), normalised to top-left + size. */
export function rectFromCorners(x0: number, y0: number, x1: number, y1: number): PixelRect {
  const x = Math.min(x0, x1);
  const y = Math.min(y0, y1);
  return { x, y, w: Math.abs(x1 - x0) + 1, h: Math.abs(y1 - y0) + 1 };
}

/** Copy the pixels under `r` from `sprite` into the shared clipboard. */
export function copyRegion(sprite: SpriteData, r: PixelRect): void {
  const out: SpriteData = [];
  for (let y = 0; y < r.h; y++) {
    const row: string[] = [];
    for (let x = 0; x < r.w; x++) row.push(sprite[r.y + y]?.[r.x + x] ?? '');
    out.push(row);
  }
  clipboard = out;
}

export function hasClipboard(): boolean {
  return clipboard !== null;
}

/** Stamp the clipboard onto `sprite` with its top-left at (ox, oy), clipped to
 *  bounds. Replaces cells (incl. transparent ones) — a faithful region paste.
 *  Returns false when the clipboard is empty. */
export function pasteRegion(sprite: SpriteData, ox: number, oy: number): boolean {
  if (!clipboard) return false;
  for (let y = 0; y < clipboard.length; y++) {
    for (let x = 0; x < clipboard[y].length; x++) {
      const ty = oy + y;
      const tx = ox + x;
      if (ty >= 0 && ty < sprite.length && tx >= 0 && tx < (sprite[ty]?.length ?? 0)) {
        sprite[ty][tx] = clipboard[y][x];
      }
    }
  }
  return true;
}
