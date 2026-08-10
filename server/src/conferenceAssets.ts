/**
 * Generated placeholder conference monitor injected into the furniture catalog at
 * load time, so a conference screen is real, editable furniture (refine the art in
 * the in-game furniture editor). Tagged `conference: true`; clicking it joins a
 * per-monitor video call (C-RTC). Placeable in any zone.
 */
import type { SpriteData } from '@pixel/shared/office/types.js';

const T = ''; // transparent

/** A wall monitor: bezel + dark screen + a green power LED. 2×2 canvas (same
 *  footprint as the whiteboard), but — like WHITEBOARD.png itself — the
 *  actual picture only fills the vertical middle (rows 8-23 of 32, one
 *  tile's worth), leaving transparent margin above/below. Without that
 *  margin it reads as a solid block covering the whole 2x2 footprint instead
 *  of a screen hanging mid-wall. */
export function monitorSprite(): SpriteData {
  const canvasW = 32;
  const canvasH = 32;
  const g: SpriteData = Array.from({ length: canvasH }, () => new Array<string>(canvasW).fill(T));
  const left = 2;
  const top = 8;
  const w = canvasW - left * 2; // 28
  const h = 16;
  const bezel = '#2b2f36';
  const bezelLt = '#3a4048';
  const screen = '#10243a';
  const glow = '#1c3a5c';
  const led = '#46e06a';
  const screenBottom = h - 3; // leave a thin bezel chin
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const onBezel = x < 2 || x >= w - 2 || y < 2 || y >= screenBottom;
      if (onBezel) {
        g[top + y][left + x] = y === 0 || x === 0 ? bezelLt : bezel; // slight top/left highlight
      } else {
        // Screen with a faint diagonal reflection.
        g[top + y][left + x] = (x - y) % 9 === 0 ? glow : screen;
      }
    }
  }
  // Power LED, bottom-right of the bezel chin.
  g[top + h - 2][left + w - 4] = led;
  return g;
}

export interface ConferenceAsset {
  entry: Record<string, unknown>; // LoadedAssetData.catalog item shape
  sprite: SpriteData;
}

/** Catalog entry + sprite for the conference monitor, to merge into the bundle. */
export function conferenceAssets(): ConferenceAsset[] {
  return [
    {
      entry: {
        id: 'MONITOR',
        label: 'Conference Monitor',
        category: 'decor',
        width: 32,
        height: 32,
        footprintW: 2,
        footprintH: 2,
        isDesk: false,
        conference: true,
        canPlaceOnSurfaces: true,
      },
      sprite: monitorSprite(),
    },
  ];
}
