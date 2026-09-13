#!/usr/bin/env -S node --import tsx
/**
 * Draw the karts — one picture each, pointing EAST, one per colour on the grid.
 *
 * This is the hand-drawn kart from before the Dust Racing cars, brought back because a race in
 * this world is meant to be funny before it is meant to be accurate ("wenn es ein Fun bringen
 * soll sind lustige carts besser"), and rebuilt around what the cars got right: ONE frame that
 * the renderer rotates, rather than the sixteen headings the original strip carried. Sixteen
 * discrete angles is a kart that snaps between pictures as it turns, which is the opposite of
 * what was asked for.
 *
 * The kart is described ONCE in its own coordinates — x forward, y to the right, origin at the
 * centre of mass — as an ordered list of filled shapes, and the frame is that description
 * rasterised. Deterministic by construction, so `--check` means something.
 *
 * Two things decide how it reads, and both were tuned by looking at the sprite rather than
 * reasoned:
 *
 *  - **Coverage, not a hard test.** Each pixel is sampled 4×4 and the colours averaged, so a
 *    rounded nose gets partial pixels instead of a staircase.
 *  - **A dark edge, added afterwards.** Every opaque pixel touching transparency is pulled towards
 *    the house outline colour. Pixel art at this size has no other way to separate a red kart from
 *    a red kerb, and doing it as a pass means the shapes stay simple.
 *
 * The proportions are physical: the hull is as long as the art says a kart is, and the collision
 * radius (KART_RADIUS_PX) is half its width — a kart that draws bigger than it collides is a kart
 * that looks like it was shoved through a wall.
 *
 * Run: scripts/draw-karts.sh [--check]
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

import { PNG } from 'pngjs';

import { VEHICLE_ART } from '@pixel/shared/office/race/kartArt.js';

const WRITE_OPTIONS = { filterType: 0, deflateLevel: 9, deflateStrategy: 0 } as const;

const REPO = path.join(import.meta.dirname, '..', '..');
const OUT_DIR = path.join(REPO, 'assets', 'vehicles');
const CHECK = process.argv.includes('--check');
const SS = 4; // subsamples per pixel per axis

type RGB = readonly [number, number, number];

/** Shared parts: the house outline, the rubber, the dark trim, and a white nose. */
const TYRE: RGB = [0x14, 0x13, 0x12];
const SEAT: RGB = [0x26, 0x24, 0x22];
const TRIM: RGB = [0x37, 0x34, 0x2f];
const NOSE: RGB = [0xf1, 0xef, 0xec];
const EDGE: RGB = [0x0a, 0x09, 0x08];

/** Per kart: the hull, a lit strip and a shaded rail, so a colour reads as a shape and not a blob. */
interface Livery {
  hull: RGB;
  lit: RGB;
  dark: RGB;
}

/**
 * One livery per grid slot, in VEHICLE_ART's order.
 *
 * The lit and dark tones are derived rather than picked, so a new colour is one triple: a kart is
 * a small sprite and hand-mixing three shades of eight colours is eight chances to get one wrong.
 */
const HULLS: readonly RGB[] = [
  [0xc5, 0x1a, 0x1b], // red — the house primary
  [0x31, 0x6d, 0xc9], // blue
  [0xe7, 0xda, 0x00], // yellow — the house highlight
  [0x5a, 0xa3, 0x48], // green
  [0xd4, 0x7a, 0x1e], // orange
  [0x8a, 0x4c, 0xc0], // violet
  [0x2f, 0xb3, 0xc0], // cyan
  [0xd6, 0x62, 0x9e], // pink
];
const mix = (c: RGB, towards: RGB, t: number): RGB =>
  [
    Math.round(c[0] + (towards[0] - c[0]) * t),
    Math.round(c[1] + (towards[1] - c[1]) * t),
    Math.round(c[2] + (towards[2] - c[2]) * t),
  ] as const;
const liveryFor = (hull: RGB): Livery => ({
  hull,
  lit: mix(hull, [0xff, 0xff, 0xff], 0.38),
  dark: mix(hull, [0x00, 0x00, 0x00], 0.55),
});

type Shape =
  | { kind: 'box'; x0: number; x1: number; y0: number; y1: number; rgb: RGB }
  | { kind: 'ellipse'; cx: number; cy: number; rx: number; ry: number; rgb: RGB }
  | { kind: 'poly'; pts: readonly (readonly [number, number])[]; rgb: RGB };

/**
 * The kart, once, in units where it is 40 long and 26 across the rear tyres.
 *
 * Read it as a top-down go-kart: fat rear tyres on an axle, a tub with side rails, a seat with a
 * head rest behind it, thin front tyres out on stalks, a steering wheel and a white nose cone.
 * The tub is a long box with the nose drawn INTO it rather than a wedge — an early version tapered
 * from the rear axle forward and read as an arrowhead rather than as a vehicle.
 */
function kartShapes(livery: Livery): readonly Shape[] {
  const { hull, lit, dark } = livery;
  return [
    // Rear tyres — fat, set WIDE of the tub. The width matters more than the size: a first
    // version had the tub nearly as wide as the track, the tyres stuck out three pixels, and the
    // whole thing read as a brick with a nose on it.
    { kind: 'box', x0: -17.0, x1: -8.0, y0: -15.5, y1: -9.5, rgb: TYRE },
    { kind: 'box', x0: -17.0, x1: -8.0, y0: 9.5, y1: 15.5, rgb: TYRE },
    // Rear axle, so the wheels belong to something instead of floating beside the tub.
    { kind: 'box', x0: -14.5, x1: -10.5, y0: -14.0, y1: 14.0, rgb: TRIM },
    // Front tyres — narrower, on stalks, the open-wheel stance that says go-kart.
    { kind: 'box', x0: 7.0, x1: 14.5, y0: -15.0, y1: -9.5, rgb: TYRE },
    { kind: 'box', x0: 7.0, x1: 14.5, y0: 9.5, y1: 15.0, rgb: TYRE },
    { kind: 'box', x0: 8.6, x1: 12.0, y0: -13.5, y1: 13.5, rgb: TRIM },
    // The tub: narrow, so the wheels stand clear of it either side.
    {
      kind: 'poly',
      rgb: hull,
      pts: [
        [11.0, -8.0],
        [17.5, -2.6],
        [17.5, 2.6],
        [11.0, 8.0],
        [-17.5, 8.0],
        [-17.5, -8.0],
      ],
    },
    // A shaded rail down each flank and a lit strip along the top — the two things that stop the
    // tub reading as a flat lozenge at this size.
    { kind: 'box', x0: -16.5, x1: 9.0, y0: -8.2, y1: -6.4, rgb: dark },
    { kind: 'box', x0: -16.5, x1: 9.0, y0: 6.4, y1: 8.2, rgb: dark },
    { kind: 'box', x0: -16.0, x1: 10.0, y0: -6.2, y1: -3.4, rgb: lit },
    // The cockpit, and the head rest behind it.
    { kind: 'box', x0: -12.5, x1: -2.0, y0: -5.0, y1: 5.0, rgb: SEAT },
    { kind: 'box', x0: -17.0, x1: -13.2, y0: -4.6, y1: 4.6, rgb: TRIM },
    // The wheel, right where a pair of hands would be.
    { kind: 'ellipse', cx: 2.0, cy: 0, rx: 1.5, ry: 4.0, rgb: TRIM },
    // Nose tip — white, so which way a kart faces reads at a glance from across the map.
    { kind: 'poly', rgb: NOSE, pts: [[19.5, 0.0], [14.5, -3.4], [14.5, 3.4]] },
  ];
}

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

/** One kart, rasterised into a PNG of the art's own size. */
function drawKart(shapes: readonly Shape[], w: number, h: number): PNG {
  const png = new PNG({ width: w, height: h });
  png.data.fill(0);
  // Kart units are 40 long by 32 wide (the shapes above sit inside that); the frame scales to it,
  // so changing the art size in VEHICLE_ART needs no second number here.
  const scale = Math.min(w / 40, h / 32);
  for (let py = 0; py < h; py++) {
    for (let px = 0; px < w; px++) {
      let r = 0;
      let g = 0;
      let b = 0;
      let hits = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const kx = (px - w / 2 + (sx + 0.5) / SS) / scale;
          const ky = (py - h / 2 + (sy + 0.5) / SS) / scale;
          let rgb: RGB | null = null;
          for (const shape of shapes) if (inside(shape, kx, ky)) rgb = shape.rgb;
          if (!rgb) continue;
          r += rgb[0];
          g += rgb[1];
          b += rgb[2];
          hits++;
        }
      }
      if (hits === 0) continue;
      const i = (py * w + px) * 4;
      png.data[i] = Math.round(r / hits);
      png.data[i + 1] = Math.round(g / hits);
      png.data[i + 2] = Math.round(b / hits);
      png.data[i + 3] = Math.round((hits / (SS * SS)) * 255);
    }
  }
  // The dark edge, as a pass over the finished frame: any solid pixel with a see-through
  // neighbour is pulled towards the outline colour, weighted by how see-through it is.
  const alphaAt = (x: number, y: number): number =>
    x < 0 || x >= w || y < 0 || y >= h ? 0 : png.data[(y * w + x) * 4 + 3];
  const edged = Buffer.from(png.data);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      if (png.data[i + 3] < 128) continue;
      const open =
        255 - alphaAt(x - 1, y) + (255 - alphaAt(x + 1, y)) + (255 - alphaAt(x, y - 1)) + (255 - alphaAt(x, y + 1));
      if (open === 0) continue;
      const t = Math.min(1, open / (255 * 2));
      for (let c = 0; c < 3; c++) edged[i + c] = Math.round(png.data[i + c] + (EDGE[c] - png.data[i + c]) * t);
    }
  }
  png.data.set(edged);
  return png;
}

let differs = false;
VEHICLE_ART.forEach((art, i) => {
  const png = drawKart(kartShapes(liveryFor(HULLS[i % HULLS.length])), art.w, art.h);
  const bytes = PNG.sync.write(png, WRITE_OPTIONS);
  const out = path.join(OUT_DIR, `${art.id}.png`);
  if (CHECK) {
    const onDisk = fs.existsSync(out) ? fs.readFileSync(out) : Buffer.alloc(0);
    if (!onDisk.equals(bytes)) {
      console.error(`${path.relative(REPO, out)} differs from the generator`);
      differs = true;
    }
    return;
  }
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(out, bytes);
  console.log(`wrote ${path.relative(REPO, out)} (${art.w}×${art.h}, ${bytes.length} bytes)`);
});
if (CHECK) {
  if (differs) {
    console.error('run scripts/draw-karts.sh');
    process.exit(1);
  }
  console.log(`all ${VEHICLE_ART.length} karts match the generator`);
}
