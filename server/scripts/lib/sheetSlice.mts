/**
 * Slicing an art pack's sprite sheet into individual, tile-aligned items.
 *
 * Extracted from gen-metro-furniture.mts so a second importer can slice the same
 * way rather than carry its own copy: the two rules below are what make a sliced
 * item usable as furniture at all, and two implementations of them would drift.
 *
 * Items are found by 8-connected alpha components rather than by a fixed grid.
 * These packs lay their sheets out on a 16px grid, but the items within it are of
 * wildly different sizes — a 6x60 door frame beside a 128x44 window — so a grid
 * walk would either split items or glue neighbours together.
 */
import { PNG } from 'pngjs';

export const TILE = 16;

/** Components smaller than this are sheet dust (stray antialiasing pixels, a
 *  lone highlight left outside an item's own silhouette), not items. */
export const MIN_PIXELS = 12;

export interface Box {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/** 8-connected components of non-transparent pixels, in reading order. */
export function components(png: PNG, minPixels = MIN_PIXELS): Box[] {
  const { width: W, height: H } = png;
  const alphaAt = (x: number, y: number) => png.data[(y * W + x) * 4 + 3];
  const seen = new Uint8Array(W * H);
  const boxes: Array<Box & { n: number }> = [];
  const stack: number[] = [];
  for (let start = 0; start < W * H; start++) {
    if (seen[start] || alphaAt(start % W, Math.floor(start / W)) === 0) continue;
    seen[start] = 1;
    stack.length = 0;
    stack.push(start);
    let x0 = start % W;
    let x1 = x0;
    let y0 = Math.floor(start / W);
    let y1 = y0;
    let n = 0;
    while (stack.length > 0) {
      const p = stack.pop()!;
      const px = p % W;
      const py = Math.floor(p / W);
      n++;
      if (px < x0) x0 = px;
      if (px > x1) x1 = px;
      if (py < y0) y0 = py;
      if (py > y1) y1 = py;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const nx = px + dx;
          const ny = py + dy;
          if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
          const q = ny * W + nx;
          if (seen[q] || alphaAt(nx, ny) === 0) continue;
          seen[q] = 1;
          stack.push(q);
        }
      }
    }
    boxes.push({ x0, y0, x1, y1, n });
  }
  return boxes
    .filter((b) => b.n >= minPixels)
    .sort((a, b) => a.y0 - b.y0 || a.x0 - b.x0)
    .map(({ x0, y0, x1, y1 }) => ({ x0, y0, x1, y1 }));
}

/**
 * Crop one item out, padded to a whole number of tiles: bottom-aligned and
 * horizontally centred.
 *
 * Furniture art is bottom-anchored, and the catalog derives an item's footprint
 * from its PNG size (tiledFurniture.ts's footprintOf), so an exact multiple of 16
 * is what makes that footprint unambiguous.
 */
export function cropToTiles(src: PNG, box: Box): PNG {
  const w = box.x1 - box.x0 + 1;
  const h = box.y1 - box.y0 + 1;
  const outW = Math.ceil(w / TILE) * TILE;
  const outH = Math.ceil(h / TILE) * TILE;
  const offX = Math.floor((outW - w) / 2);
  const offY = outH - h;
  const out = new PNG({ width: outW, height: outH });
  out.data.fill(0);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const si = ((box.y0 + y) * src.width + (box.x0 + x)) * 4;
      if (src.data[si + 3] === 0) continue;
      const di = ((offY + y) * outW + (offX + x)) * 4;
      out.data[di] = src.data[si];
      out.data[di + 1] = src.data[si + 1];
      out.data[di + 2] = src.data[si + 2];
      out.data[di + 3] = src.data[si + 3];
    }
  }
  return out;
}
