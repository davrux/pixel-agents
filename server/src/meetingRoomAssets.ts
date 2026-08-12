/**
 * Generated placeholder meeting-room kiosk injected into the furniture catalog at
 * load time, so it's real, editable furniture. Has no Tiled tileset
 * representation (no `action` default on the catalog entry) — every placed
 * instance must carry its own explicit `action: { kind: 'linkManager' }` (see
 * FurnitureObject's actionKind in Pixels.tiled-project); clicking one opens a
 * dialog to mint an ad-hoc video/audio room (random link, optional password,
 * an expiry) — see meetingRoomStore.ts + the `meetingRoomCreate` handler in
 * SimRoom.ts. Placeable in any zone. Mirrors conferenceAssets.ts / arcadeAssets.ts.
 */
import type { SpriteData } from '@pixel/shared/office/types.js';

const T = ''; // transparent

/** A slim standalone kiosk: teal column, a small screen with a "link" glyph, and
 *  a blinking signal dot on top. 1×2 tiles. */
export function meetingKioskSprite(): SpriteData {
  const w = 16;
  const h = 32;
  const g: SpriteData = Array.from({ length: h }, () => new Array<string>(w).fill(T));
  const body = '#1d5a5a'; // kiosk teal
  const bodyLt = '#2c7d7d';
  const trim = '#0e2f2f';
  const screen = '#0a1f2e';
  const link = '#3ae0c0'; // glowing link-icon teal
  const signal = '#46e06a'; // signal LED, matches the conference monitor's LED colour
  const x0 = 2;
  const x1 = w - 2; // narrower column than the arcade cabinet — a kiosk, not a machine
  for (let y = 4; y < h; y++) {
    for (let x = x0; x < x1; x++) {
      g[y][x] = x === x0 || x === x1 - 1 ? bodyLt : body;
    }
  }
  // Small screen near the top.
  for (let y = 7; y <= 15; y++) {
    for (let x = x0 + 1; x < x1 - 1; x++) {
      g[y][x] = y === 7 || y === 15 || x === x0 + 1 || x === x1 - 2 ? trim : screen;
    }
  }
  // A simple two-link "chain" glyph on the screen (☌-ish: two offset squares).
  g[10][x0 + 2] = link;
  g[10][x0 + 3] = link;
  g[11][x0 + 3] = link;
  g[12][x0 + 4] = link;
  g[12][x0 + 5] = link;
  g[11][x0 + 4] = link;
  // Signal dot above the kiosk (a small antenna tip).
  g[1][w / 2 - 1] = trim;
  g[2][w / 2 - 1] = trim;
  g[0][w / 2 - 1] = signal;
  // Base / foot.
  for (let x = x0 - 1; x <= x1; x++) g[h - 1][x] = trim;
  return g;
}

export interface MeetingRoomAsset {
  entry: Record<string, unknown>; // LoadedAssetData.catalog item shape
  sprite: SpriteData;
}

/** Catalog entry + sprite for the meeting-room kiosk, to merge into the bundle. */
export function meetingRoomAssets(): MeetingRoomAsset[] {
  return [
    {
      entry: {
        id: 'MEETING_KIOSK',
        label: 'Meeting Room Kiosk',
        category: 'decor',
        width: 16,
        height: 32,
        footprintW: 1,
        footprintH: 2,
        isDesk: false,
      },
      sprite: meetingKioskSprite(),
    },
  ];
}
