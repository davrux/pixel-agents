#!/usr/bin/env -S node --import tsx
/**
 * Draw the kart, sixteen headings, as one committed strip.
 *
 * A kart is seen from straight above, so every heading is a DIFFERENT picture rather than the same
 * one rotated: the nose foreshortens, the wheels change which face they show, and the seat moves
 * across the hull. Drawing it that way by hand sixteen times would drift; instead the kart is
 * described ONCE in its own coordinates (x forward, y to the right, origin at the centre of mass)
 * as an ordered list of filled shapes, and each frame is that description turned and rasterised.
 * Deterministic by construction, so `--check` means something.
 *
 * Two things decide how it reads, and both were tuned by looking at the strip rather than reasoned:
 *
 *  - **Coverage, not a hard test.** Each pixel is sampled 4x4 and the colours averaged, so a hull
 *    edge at 22.5 degrees gets a partial pixel instead of a staircase. On a 24-pixel sprite the
 *    staircase is the whole silhouette, and sixteen staircases at sixteen angles read as sixteen
 *    different karts.
 *  - **A dark edge, added afterwards.** Every opaque pixel touching transparency is pulled towards
 *    the house outline colour. Pixel art at this size has no other way to separate a red kart from
 *    a red kerb, and doing it as a pass means the shapes stay simple.
 *
 * The proportions are the physical ones: KART_RADIUS_PX is 9, so the hull is 19 long and 12 wide
 * and the frame is 24 square — a kart that draws bigger than it collides is a kart that looks like
 * it was shoved through a wall.
 *
 * Run: scripts/draw-kart.sh [--check] [--preview]
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

import { PNG } from 'pngjs';

import { KART_SHEET } from '@pixel/shared/office/race/kartArt.js';

const WRITE_OPTIONS = { filterType: 0, deflateLevel: 9, deflateStrategy: 0 } as const;

const REPO = path.join(import.meta.dirname, '..', '..');
const OUT = path.join(REPO, 'assets', 'vehicles', `${KART_SHEET.id}.png`);
const CHECK = process.argv.includes('--check');
const PREVIEW = process.argv.includes('--preview');

const W = KART_SHEET.frameW;
const H = KART_SHEET.frameH;
const N = KART_SHEET.headings;
const SS = 4; // subsamples per pixel per axis

type RGB = readonly [number, number, number];

/** The palette is the house one (AGENTS.md, UI tokens): primary red, the two greys, the outline. */
const TYRE: RGB = [0x14, 0x13, 0x12];
const HULL: RGB = [0xc5, 0x1a, 0x1b];
const HULL_LIT: RGB = [0xe2, 0x58, 0x5a];
const HULL_DARK: RGB = [0x5c, 0x0f, 0x10];
const SEAT: RGB = [0x26, 0x24, 0x22];
const TRIM: RGB = [0x37, 0x34, 0x2f];
const NOSE: RGB = [0xf1, 0xef, 0xec];
const EDGE: RGB = [0x0a, 0x09, 0x08];

/** A shape in kart space. Painter's order: later shapes win where they overlap. */
type Shape =
  | { kind: 'box'; x0: number; x1: number; y0: number; y1: number; rgb: RGB }
  | { kind: 'ellipse'; cx: number; cy: number; rx: number; ry: number; rgb: RGB }
  | { kind: 'poly'; pts: readonly (readonly [number, number])[]; rgb: RGB };

/**
 * The kart, once. Forward is +x, right is +y, and the origin is where the model puts the centre.
 * Read it as a top-down go-kart: rear axle and fat rear tyres, a tapered hull, side pods, a seat
 * with a head rest behind it, thin front tyres out on stalks and a white nose cone.
 */
const KART: readonly Shape[] = [
  // Rear tyres — fat, set wide. Drawn first so the hull's edge cuts across them.
  { kind: 'box', x0: -9.0, x1: -4.0, y0: -7.4, y1: -4.0, rgb: TYRE },
  { kind: 'box', x0: -9.0, x1: -4.0, y0: 4.0, y1: 7.4, rgb: TYRE },
  // Front tyres — narrower, further forward, the open-wheel stance.
  { kind: 'box', x0: 3.6, x1: 7.2, y0: -7.0, y1: -4.0, rgb: TYRE },
  { kind: 'box', x0: 3.6, x1: 7.2, y0: 4.0, y1: 7.0, rgb: TYRE },
  // Axles, so the wheels belong to something instead of floating beside the tub.
  { kind: 'box', x0: -7.6, x1: -5.6, y0: -6.2, y1: 6.2, rgb: TRIM },
  { kind: 'box', x0: 4.2, x1: 5.6, y0: -5.8, y1: 5.8, rgb: TRIM },
  // The tub: a long box with the nose drawn into it, NOT a wedge. The first attempt tapered from
  // the rear axle forward and every frame read as an arrowhead rather than as a vehicle.
  {
    kind: 'poly',
    rgb: HULL,
    pts: [
      [6.4, -3.3],
      [9.6, -1.1],
      [9.6, 1.1],
      [6.4, 3.3],
      [-9.2, 3.3],
      [-9.2, -3.3],
    ],
  },
  // Frame rails down each flank, and a lit strip along the top — the two things that stop the tub
  // reading as a flat lozenge at this size.
  { kind: 'box', x0: -8.4, x1: 4.4, y0: -4.5, y1: -3.1, rgb: HULL_DARK },
  { kind: 'box', x0: -8.4, x1: 4.4, y0: 3.1, y1: 4.5, rgb: HULL_DARK },
  { kind: 'box', x0: -8.8, x1: 5.4, y0: -3.0, y1: -1.5, rgb: HULL_LIT },
  // Cockpit: a seat the driver sits IN, a head rest behind it, the wheel ahead of it. Small on
  // purpose — a character is drawn on top of this, and a big dark hole swallows them.
  { kind: 'box', x0: -6.4, x1: -1.4, y0: -2.4, y1: 2.4, rgb: SEAT },
  { kind: 'box', x0: -8.6, x1: -6.8, y0: -2.2, y1: 2.2, rgb: TRIM },
  { kind: 'box', x0: 1.2, x1: 2.6, y0: -1.8, y1: 1.8, rgb: TRIM },
  // Nose tip — white, so which way a kart faces reads at a glance from across the map.
  { kind: 'poly', rgb: NOSE, pts: [[10.2, 0.0], [8.0, -1.6], [8.0, 1.6]] },
];

const inside = (s: Shape, x: number, y: number): boolean => {
  if (s.kind === 'box') return x >= s.x0 && x <= s.x1 && y >= s.y0 && y <= s.y1;
  if (s.kind === 'ellipse') {
    const dx = (x - s.cx) / s.rx;
    const dy = (y - s.cy) / s.ry;
    return dx * dx + dy * dy <= 1;
  }
  // Even-odd crossing count: the hull is convex, but the test costs nothing and never lies.
  let hit = false;
  for (let i = 0, j = s.pts.length - 1; i < s.pts.length; j = i++) {
    const [xi, yi] = s.pts[i];
    const [xj, yj] = s.pts[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) hit = !hit;
  }
  return hit;
};

const png = new PNG({ width: W * N, height: H });
png.data.fill(0);

for (let f = 0; f < N; f++) {
  const a = (f / N) * Math.PI * 2;
  const ca = Math.cos(a);
  const sa = Math.sin(a);
  for (let py = 0; py < H; py++) {
    for (let px = 0; px < W; px++) {
      let r = 0;
      let g = 0;
      let b = 0;
      let hits = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          // Screen pixel centre, relative to the frame's middle, then turned BACK into kart space.
          const ox = px - W / 2 + (sx + 0.5) / SS;
          const oy = py - H / 2 + (sy + 0.5) / SS;
          const kx = ox * ca + oy * sa;
          const ky = -ox * sa + oy * ca;
          let rgb: RGB | null = null;
          for (const shape of KART) if (inside(shape, kx, ky)) rgb = shape.rgb;
          if (!rgb) continue;
          r += rgb[0];
          g += rgb[1];
          b += rgb[2];
          hits++;
        }
      }
      if (hits === 0) continue;
      const i = (py * W * N + f * W + px) * 4;
      png.data[i] = Math.round(r / hits);
      png.data[i + 1] = Math.round(g / hits);
      png.data[i + 2] = Math.round(b / hits);
      png.data[i + 3] = Math.round((hits / (SS * SS)) * 255);
    }
  }
}

// The dark edge, as a pass over the finished frames: any solid pixel with a see-through neighbour
// is pulled towards the outline colour, weighted by how see-through that neighbour is. At 24 px a
// red kart on a red kerb has no silhouette without it.
const alphaAt = (f: number, x: number, y: number): number => {
  if (x < 0 || x >= W || y < 0 || y >= H) return 0;
  return png.data[(y * W * N + f * W + x) * 4 + 3];
};
const edged = Buffer.from(png.data);
for (let f = 0; f < N; f++) {
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = (y * W * N + f * W + x) * 4;
      if (png.data[i + 3] < 128) continue;
      const open =
        (255 - alphaAt(f, x - 1, y)) +
        (255 - alphaAt(f, x + 1, y)) +
        (255 - alphaAt(f, x, y - 1)) +
        (255 - alphaAt(f, x, y + 1));
      if (open === 0) continue;
      const t = Math.min(1, open / 510) * 0.75;
      for (let c = 0; c < 3; c++) edged[i + c] = Math.round(png.data[i + c] * (1 - t) + EDGE[c] * t);
    }
  }
}
png.data.set(edged);

if (PREVIEW) {
  // Each heading on a strip of road, so the silhouette is judged against what it is driven on
  // rather than against a checkerboard.
  const ROAD: RGB = [0x3a, 0x3a, 0x3c];
  const prev = new PNG({ width: W * N, height: H });
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W * N; x++) {
      const i = (y * W * N + x) * 4;
      const a = png.data[i + 3] / 255;
      for (let c = 0; c < 3; c++) prev.data[i + c] = Math.round(png.data[i + c] * a + ROAD[c] * (1 - a));
      prev.data[i + 3] = 255;
    }
  }
  const to = path.join(REPO, 'tmp', 'kart-preview.png');
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.writeFileSync(to, PNG.sync.write(prev, WRITE_OPTIONS));
  console.log(`preview → ${to}`);
}

const bytes = PNG.sync.write(png, WRITE_OPTIONS);
if (CHECK) {
  const have = fs.existsSync(OUT) ? fs.readFileSync(OUT) : null;
  if (have && have.equals(bytes)) {
    console.log(`✓ ${path.relative(REPO, OUT)} is up to date`);
    process.exit(0);
  }
  console.error(`✗ ${path.relative(REPO, OUT)} differs — run scripts/draw-kart.sh`);
  process.exit(1);
}
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, bytes);
console.log(`wrote ${path.relative(REPO, OUT)} (${N}×${W}×${H}, ${bytes.length} bytes)`);
