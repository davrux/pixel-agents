/** Small shared building blocks for sprite palettes/grids — used by both the
 *  Assets panel (OfficeScene) and the Layout-Editor's placement palettes, so
 *  the two don't grow independent, drifting implementations of the same
 *  "show sprites, let me zoom, let me switch how they're grouped" UI. */
import type { SpriteData } from '@pixel/shared/office/types.js';

export type Zoom = 1 | 2 | 4;

/** (Re)draw a sprite 1:1 onto an existing canvas — resizes it to match, so
 *  this also works to repaint a thumbnail in place (e.g. when the picked
 *  paint colour changes, see the Layout-Editor's Floor/Wall preview refresh),
 *  keeping the same DOM element instead of replacing it. */
export function drawSpriteOnCanvas(cv: HTMLCanvasElement, sprite: SpriteData | undefined): void {
  const h = sprite?.length ?? 0;
  const w = h > 0 ? (sprite![0]?.length ?? 0) : 0;
  cv.width = Math.max(1, w);
  cv.height = Math.max(1, h);
  const ctx = cv.getContext('2d');
  if (!ctx || !sprite) return;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < sprite[y].length; x++) {
      const c = sprite[y][x];
      if (!c) continue;
      ctx.fillStyle = c;
      ctx.fillRect(x, y, 1, 1);
    }
  }
}

/** A pixel-art thumbnail drawn 1:1 onto a canvas, optionally CSS-scaled by
 *  `zoom` (default 1 = native size). Canvas + explicit pixel scaling (not an
 *  `<img>` with max-width/max-height) keeps non-square sprites honest instead
 *  of squishing/shrinking them to fit a fixed box. */
export function spriteThumbCanvas(sprite: SpriteData | undefined, zoom: Zoom = 1): HTMLCanvasElement {
  const cv = document.createElement('canvas');
  drawSpriteOnCanvas(cv, sprite);
  if (zoom !== 1) {
    cv.style.width = `${cv.width * zoom}px`;
    cv.style.height = `${cv.height * zoom}px`;
    cv.style.imageRendering = 'pixelated';
  }
  return cv;
}
