/**
 * Generated placeholder arcade cabinet injected into the furniture catalog at load
 * time, so a playable cabinet is real, editable furniture (refine the art in the
 * in-game editor). Tagged `arcade: true`; clicking it opens the shared ArcadeUI and
 * boots a DOS game (js-dos). Placeable in any zone. Mirrors conferenceAssets.
 */
import type { SpriteData } from '@pixel/shared/office/types.js';

const T = ''; // transparent

/** An upright arcade cabinet: lit marquee, screen, control panel with buttons. 1×2 tiles. */
export function arcadeCabinetSprite(): SpriteData {
  const w = 16;
  const h = 32;
  const g: SpriteData = Array.from({ length: h }, () => new Array<string>(w).fill(T));
  const body = '#3a2560'; // cabinet purple
  const bodyLt = '#4d3378';
  const trim = '#14101f';
  const marquee = '#f03a3a'; // lit red header
  const screen = '#0f1830';
  const scan = '#26406e'; // faint scanline / glow
  const floor = '#7a1414'; // little red "scene" at the screen bottom
  const btnA = '#f0c020';
  const btnB = '#30c0f0';
  const x0 = 1;
  const x1 = w - 1; // cabinet spans x0..x1 (thin margins)
  for (let y = 0; y < h; y++) {
    for (let x = x0; x < x1; x++) {
      g[y][x] = x === x0 || x === x1 - 1 ? bodyLt : body;
    }
  }
  // Marquee header (top).
  for (let y = 1; y <= 3; y++) for (let x = x0 + 1; x < x1 - 1; x++) g[y][x] = marquee;
  // Screen (dark, with scanlines + a red floor strip = "a game").
  for (let y = 6; y <= 14; y++) {
    for (let x = x0 + 1; x < x1 - 1; x++) {
      g[y][x] = y === 6 || y === 14 || x === x0 + 1 || x === x1 - 2 ? trim : y % 3 === 0 ? scan : screen;
    }
  }
  for (let x = x0 + 2; x < x1 - 2; x++) g[13][x] = floor;
  // Control panel (deck) + two buttons + joystick dot.
  for (let y = 20; y <= 23; y++) for (let x = x0 + 1; x < x1 - 1; x++) g[y][x] = trim;
  g[22][x0 + 2] = '#d83030'; // joystick knob
  g[22][x1 - 3] = btnA;
  g[22][x1 - 2] = btnB;
  // Base / legs.
  for (let y = 29; y < h; y++) for (let x = x0; x < x1; x++) g[y][x] = trim;
  return g;
}

export interface ArcadeAsset {
  entry: Record<string, unknown>; // LoadedAssetData.catalog item shape
  sprite: SpriteData;
}

/** Catalog entry + sprite for the arcade cabinet, to merge into the bundle. */
export function arcadeAssets(): ArcadeAsset[] {
  return [
    {
      entry: {
        id: 'ARCADE',
        label: 'Arcade Cabinet',
        category: 'decor',
        width: 16,
        height: 32,
        footprintW: 1,
        footprintH: 2,
        isDesk: false,
        arcade: true,
      },
      sprite: arcadeCabinetSprite(),
    },
  ];
}
