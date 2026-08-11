/**
 * Generated time clock (the classic punch clock / "Stechuhr") injected into the
 * furniture catalog at load time, so it is real, editable furniture — refine the
 * art in the in-game editor like any other asset. Mirrors arcadeAssets.
 *
 * Carries `action: { kind: 'timeClock' }`, so walking up to it opens the TimeTracking
 * panel: today's total and the punch buttons. Unlike the arcade cabinet (which
 * still uses the legacy `arcade: true` flag), this one sets the modern single
 * `action` field directly — see buildDynamicCatalog's `asset.action ??
 * legacyCatalogAction(asset)`.
 *
 * A floor-standing pedestal unit rather than the wall-mounted box a real one
 * usually is: it places and reads exactly like the arcade cabinet at 1×2 tiles,
 * with the machine head at eye level and its card slot facing the room.
 */
import type { SpriteData } from '@pixel/shared/office/types.js';

const T = ''; // transparent

// Aged cream enamel over a dark steel chassis, with a brass bezel — the palette
// of the 1950s office machine this is imitating.
const OUTLINE = '#241c16';
const BODY = '#c9b491';
const BODY_LT = '#e0cfae'; // top/left catch light
const BODY_DK = '#9c8865'; // bottom/right shade
const BEZEL = '#d9a838'; // brass ring around the dial
const BEZEL_DK = '#a67c22';
const FACE = '#f4efe3';
const FACE_SHADE = '#ddd5c4';
const HAND = '#2b231b';
const PIN = '#8c1a12'; // red centre pin
const SLOT = '#171310';
const LAMP = '#6bd85e'; // "ready" lamp
const POST = '#5a534a';
const POST_LT = '#7b736a';
const POST_DK = '#3b3630';

/** Paint a filled disc (Bresenham-style radius test) into the grid. */
function disc(g: SpriteData, cx: number, cy: number, r: number, color: string): void {
  for (let y = Math.ceil(cy - r); y <= Math.floor(cy + r); y++) {
    for (let x = Math.ceil(cx - r); x <= Math.floor(cx + r); x++) {
      if (y < 0 || y >= g.length || x < 0 || x >= g[0].length) continue;
      const dx = x - cx;
      const dy = y - cy;
      if (dx * dx + dy * dy <= r * r) g[y][x] = color;
    }
  }
}

/**
 * The time clock: a brass-bezelled dial on a cream machine head, a card slot
 * beneath it, on a dark pedestal. 1×2 tiles (16×32 px).
 */
export function timeClockSprite(): SpriteData {
  const w = 16;
  const h = 32;
  const g: SpriteData = Array.from({ length: h }, () => new Array<string>(w).fill(T));

  // ── Machine head (y 1..19) ──────────────────────────────────────
  const hx0 = 1;
  const hx1 = 15; // exclusive
  const hy0 = 1;
  const hy1 = 20; // exclusive
  for (let y = hy0; y < hy1; y++) {
    for (let x = hx0; x < hx1; x++) {
      const edgeL = x === hx0;
      const edgeR = x === hx1 - 1;
      const edgeT = y === hy0;
      const edgeB = y === hy1 - 1;
      g[y][x] = edgeT || edgeL ? BODY_LT : edgeB || edgeR ? BODY_DK : BODY;
    }
  }
  // Chamfered corners, so the head reads as a rounded casing, not a brick.
  for (const [cx, cy] of [
    [hx0, hy0],
    [hx1 - 1, hy0],
    [hx0, hy1 - 1],
    [hx1 - 1, hy1 - 1],
  ]) {
    g[cy][cx] = T;
  }
  // Dark outline around the casing (drawn after the fill so it wins the edges).
  for (let x = hx0 + 1; x < hx1 - 1; x++) {
    g[hy0][x] = OUTLINE;
    g[hy1 - 1][x] = OUTLINE;
  }
  for (let y = hy0 + 1; y < hy1 - 1; y++) {
    g[y][hx0] = OUTLINE;
    g[y][hx1 - 1] = OUTLINE;
  }

  // ── Dial ────────────────────────────────────────────────────────
  // Centred on a whole pixel (8,7) rather than between two, so the hands have a
  // true centre to radiate from — at a 7px face that is the difference between
  // a clock and a smudge. Sized to leave cream casing visible either side.
  const cx = 8;
  const cy = 7;
  disc(g, cx, cy, 4.5, BEZEL_DK);
  disc(g, cx, cy, 4.0, BEZEL);
  disc(g, cx, cy, 3.5, FACE);
  // A touch of shade low-right on the face so the glass reads curved.
  for (let y = cy; y <= cy + 3; y++) {
    for (let x = cx; x <= cx + 3; x++) {
      const dx = x - cx;
      const dy = y - cy;
      if (dx * dx + dy * dy <= 3.5 * 3.5 && dx + dy >= 4) g[y][x] = FACE_SHADE;
    }
  }
  // Hour ticks at 12 / 3 / 6 / 9, one pixel each.
  g[cy - 3][cx] = HAND;
  g[cy + 3][cx] = HAND;
  g[cy][cx - 3] = HAND;
  g[cy][cx + 3] = HAND;
  // Hands at three o'clock: minute straight up into the 12 tick, hour out to
  // the 3. A right angle, not a symmetric pair — a symmetric pose plus the
  // ticks reads as two eyes and a smile at this size, which is not what a time
  // clock should look like.
  g[cy - 1][cx] = HAND; // minute…
  g[cy - 2][cx] = HAND; // …up to the 12
  g[cy][cx + 1] = HAND; // hour, out to the 3
  g[cy][cx + 2] = HAND;
  g[cy][cx] = PIN;

  // ── Card slot + ready lamp (below the dial) ─────────────────────
  for (let x = 4; x <= 11; x++) {
    g[13][x] = OUTLINE;
    g[14][x] = SLOT;
    g[15][x] = SLOT;
    g[16][x] = OUTLINE;
  }
  for (let x = 4; x <= 11; x++) g[18][x] = BEZEL_DK; // maker's nameplate
  g[12][12] = LAMP; // "ready" indicator, above the slot on the right

  // ── Pedestal + base ─────────────────────────────────────────────
  for (let y = 20; y <= 27; y++) {
    for (let x = 6; x <= 9; x++) g[y][x] = x === 6 ? POST_LT : x === 9 ? POST_DK : POST;
  }
  for (let y = 28; y <= 30; y++) {
    for (let x = 3; x <= 12; x++) g[y][x] = y === 28 ? POST_LT : y === 30 ? POST_DK : POST;
  }
  for (let x = 3; x <= 12; x++) g[31][x] = OUTLINE;

  return g;
}

export interface TimeClockAsset {
  entry: Record<string, unknown>; // LoadedAssetData.catalog item shape
  sprite: SpriteData;
}

/** Catalog entry + sprite for the time clock, to merge into the bundle. */
export function timeClockAssets(): TimeClockAsset[] {
  return [
    {
      entry: {
        id: 'TIME_CLOCK',
        label: 'Time Clock',
        category: 'electronics',
        width: 16,
        height: 32,
        footprintW: 1,
        footprintH: 2,
        isDesk: false,
        canPlaceOnFloor: true,
        action: { kind: 'timeClock' },
      },
      sprite: timeClockSprite(),
    },
  ];
}
