/**
 * Generated placeholder portal furniture (door + beam pad) injected into the
 * furniture catalog at load time, so zone portals are real, editable furniture.
 * Has no Tiled tileset representation (no `action` default on the catalog
 * entry) — every placed instance must carry its own explicit
 * `action: { kind: 'portal' }` (see FurnitureObject's actionKind in
 * Pixels.tiled-project); walking up to one offers a destination picker.
 */
import type { SpriteData } from '@pixel/shared/office/types.js';

const T = ''; // transparent

function grid(w: number, h: number): SpriteData {
  return Array.from({ length: h }, () => new Array<string>(w).fill(T));
}

/** A simple wooden door, 16×24 (1 tile wide, drawn tall like other furniture). */
export function doorSprite(): SpriteData {
  const w = 16;
  const h = 24;
  const g = grid(w, h);
  const frame = '#4a2f14';
  const panel = '#8a5a2a';
  const panelLt = '#9c6630';
  const knob = '#e8c24a';
  for (let y = 1; y < h; y++) {
    for (let x = 2; x < w - 2; x++) {
      const edge = x === 2 || x === w - 3 || y === 1 || y === h - 1;
      g[y][x] = edge ? frame : (x + y) % 6 === 0 ? panelLt : panel;
    }
  }
  // Inset panel divider lines.
  for (let x = 4; x <= w - 5; x++) {
    g[8][x] = frame;
    g[15][x] = frame;
  }
  // Door knob.
  g[12][w - 5] = knob;
  g[13][w - 5] = knob;
  return g;
}

/** A glowing transporter pad, 16×16 (floor — placed non-blocking so you stand on it). */
export function beamPadSprite(): SpriteData {
  const w = 16;
  const h = 16;
  const g = grid(w, h);
  const cx = 7.5;
  const cy = 8.5;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const d = Math.hypot(x - cx, y - cy);
      if (d > 7.2) continue;
      if (d > 5.6) g[y][x] = '#1aa6c8';
      else if (d > 4.6) g[y][x] = '#0a3340';
      else if (d > 3) g[y][x] = '#3ce6ff';
      else g[y][x] = (x + y) % 2 === 0 ? '#0a3340' : '#0f5066';
    }
  }
  return g;
}

export interface PortalAsset {
  entry: Record<string, unknown>; // LoadedAssetData.catalog item shape
  sprite: SpriteData;
}

/** Catalog entries + sprites for the portal furniture, to merge into the bundle. */
export function portalAssets(): PortalAsset[] {
  return [
    {
      entry: {
        id: 'DOOR',
        label: 'Door',
        category: 'decor',
        width: 16,
        height: 24,
        footprintW: 1,
        footprintH: 1,
        isDesk: false,
        backgroundTiles: 1, // non-blocking → you step onto the door tile to use it
      },
      sprite: doorSprite(),
    },
    {
      entry: {
        id: 'BEAM_PAD',
        label: 'Beam Pad',
        category: 'decor',
        width: 16,
        height: 16,
        footprintW: 1,
        footprintH: 1,
        isDesk: false,
        backgroundTiles: 1, // non-blocking → you can stand on the pad
      },
      sprite: beamPadSprite(),
    },
  ];
}
