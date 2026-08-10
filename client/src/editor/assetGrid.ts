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

/** Mark whichever `.seg` child matches `value` (by its `data-value`) as
 *  `.on` — the update half of buildZoomSeg/buildViewToggle, for callers that
 *  change the underlying state elsewhere (e.g. after a re-render) and need
 *  the already-built control to reflect it without rebuilding the control
 *  itself. */
export function markSegOn(seg: HTMLElement, value: string): void {
  seg.querySelectorAll<HTMLElement>('.seg').forEach((el) => el.classList.toggle('on', el.dataset.value === value));
}

/** A 1×/2×/4× segmented zoom control (`.pa-seg`, shares paSkin's styling). */
export function buildZoomSeg(current: Zoom, onSet: (z: Zoom) => void): HTMLDivElement {
  const seg = document.createElement('div');
  seg.className = 'pa-seg';
  for (const z of [1, 2, 4] as const) {
    const s = document.createElement('div');
    s.className = 'seg' + (current === z ? ' on' : '');
    s.textContent = `${z}×`;
    s.dataset.value = String(z);
    s.onclick = () => onSet(z);
    seg.appendChild(s);
  }
  return seg;
}

/** A two-way segmented toggle (`.pa-seg`) — e.g. Category vs. Import source. */
export function buildViewToggle<T extends string>(
  options: Array<{ value: T; label: string }>,
  current: T,
  onSet: (v: T) => void,
): HTMLDivElement {
  const seg = document.createElement('div');
  seg.className = 'pa-seg';
  for (const opt of options) {
    const s = document.createElement('div');
    s.className = 'seg' + (current === opt.value ? ' on' : '');
    s.textContent = opt.label;
    s.dataset.value = opt.value;
    s.onclick = () => onSet(opt.value);
    seg.appendChild(s);
  }
  return seg;
}
