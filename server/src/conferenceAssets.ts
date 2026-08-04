/**
 * Generated placeholder conference monitor injected into the furniture catalog at
 * load time, so a conference screen is real, editable furniture (refine the art in
 * the in-game furniture editor). Tagged `conference: true`; clicking it joins a
 * per-monitor video call (C-RTC). Placeable in any zone.
 */
import type { SpriteData } from '@pixel/shared/office/types.js';

const T = ''; // transparent

/** A wall monitor: bezel + dark screen + a green power LED. 2×1 tiles — wide
 *  and flat like an actual screen, not the whiteboard's square footprint. */
export function monitorSprite(): SpriteData {
  const w = 32;
  const h = 16;
  const g: SpriteData = Array.from({ length: h }, () => new Array<string>(w).fill(T));
  const bezel = '#2b2f36';
  const bezelLt = '#3a4048';
  const screen = '#10243a';
  const glow = '#1c3a5c';
  const led = '#46e06a';
  const screenBottom = h - 2; // leave a thin bezel chin
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const onBezel = x < 2 || x >= w - 2 || y < 1 || y >= screenBottom;
      if (onBezel) {
        g[y][x] = y === 0 || x === 0 ? bezelLt : bezel; // slight top/left highlight
      } else {
        // Screen with a faint diagonal reflection.
        g[y][x] = (x - y) % 9 === 0 ? glow : screen;
      }
    }
  }
  // Power LED, bottom-right of the bezel chin.
  g[h - 1][w - 4] = led;
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
        height: 16,
        footprintW: 2,
        footprintH: 1,
        isDesk: false,
        conference: true,
        // Wide + flat like a real screen (not the whiteboard's square 2x2).
        // Flexible about where it goes: floor, on top of a desk/table, or
        // mounted on a wall.
        canPlaceOnWalls: true,
        canPlaceOnFloor: true,
        canPlaceOnSurfaces: true,
      },
      sprite: monitorSprite(),
    },
  ];
}
