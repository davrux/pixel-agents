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

/**
 * Which half of the kart a shape belongs to.
 *
 * `front` is drawn OVER the driver — the bonnet, the bumper, the steering wheel; everything else
 * is `behind` and the figure sits on top of it. That split is the whole of "kann die Figur darauf
 * sitzen": the renderer draws the back half, then the body, then the front half, and the driver is
 * in the kart rather than on the roof of it.
 */
type Layer = 'behind' | 'front';
type Shape = { layer: Layer } & (
  | { kind: 'box'; x0: number; x1: number; y0: number; y1: number; rgb: RGB }
  | { kind: 'ellipse'; cx: number; cy: number; rx: number; ry: number; rgb: RGB }
  | { kind: 'poly'; pts: readonly (readonly [number, number])[]; rgb: RGB }
);

export const LAYERS: readonly Layer[] = ['behind', 'front'];

/**
 * The kart, once, in units where it is about 36 long and 30 across the tyres.
 *
 * Short, fat and round, which is the point: the first drawing of this was a tapered tub with a
 * pointed nose and open wheels on stalks, and it read as a Formula car — said in those words. A
 * fun kart is nearly as wide as it is long, has no nose to speak of, and its wheels are FAT discs
 * at the corners rather than thin cylinders out on suspension. The body is an ellipse rather than
 * a polygon for the same reason: there is not a straight line on a toy.
 */
function kartShapes(livery: Livery): readonly Shape[] {
  const { hull, lit, dark } = livery;
  const wheel = (cx: number, cy: number, rx: number, ry: number): Shape[] => [
    { layer: 'behind', kind: 'ellipse', cx, cy, rx, ry, rgb: TYRE },
    // A lighter band across the middle of each tyre — a flat black disc at this size reads as a
    // hole in the picture rather than as rubber.
    { layer: 'behind', kind: 'ellipse', cx, cy, rx: rx * 0.62, ry: ry * 0.5, rgb: TRIM },
  ];
  return [
    // Four fat tyres at the corners. Rear ones bigger, which is what makes a kart look eager.
    ...wheel(-11.0, -12.0, 6.4, 4.6),
    ...wheel(-11.0, 12.0, 6.4, 4.6),
    ...wheel(10.5, -11.6, 5.4, 4.0),
    ...wheel(10.5, 11.6, 5.4, 4.0),
    // The body: one round tub, wider at the back, with a bumper rail all the way round.
    { layer: 'behind', kind: 'ellipse', cx: -1.0, cy: 0, rx: 18.0, ry: 10.6, rgb: dark },
    { layer: 'behind', kind: 'ellipse', cx: -1.0, cy: 0, rx: 16.6, ry: 9.2, rgb: hull },
    // A lit strip along the top edge, so the tub has a shape and not just an outline.
    { layer: 'behind', kind: 'ellipse', cx: -1.0, cy: -3.6, rx: 14.0, ry: 3.8, rgb: lit },
    // The seat, and the head rest behind it. The figure sits on top of both — and an EMPTY kart
    // has to read as a kart with a seat in it rather than as a kart with a hole in it, which is
    // what a big near-black ellipse looked like on the grid.
    { layer: 'behind', kind: 'ellipse', cx: -3.6, cy: 0, rx: 6.6, ry: 5.2, rgb: TRIM },
    { layer: 'behind', kind: 'ellipse', cx: -3.6, cy: 0, rx: 5.2, ry: 3.9, rgb: SEAT },
    { layer: 'behind', kind: 'box', x0: -13.6, x1: -9.8, y0: -5.4, y1: 5.4, rgb: TRIM },

    // ── in front of the driver ───────────────────────────────────────────────
    // The bonnet, drawn over the figure's knees, and a pale bumper so the front end reads.
    { layer: 'front', kind: 'ellipse', cx: 10.5, cy: 0, rx: 8.4, ry: 8.6, rgb: hull },
    { layer: 'front', kind: 'ellipse', cx: 10.0, cy: -2.6, rx: 6.4, ry: 3.2, rgb: lit },
    { layer: 'front', kind: 'ellipse', cx: 15.6, cy: 0, rx: 3.4, ry: 7.4, rgb: NOSE },
    // The wheel, right where a pair of hands would be.
    { layer: 'front', kind: 'ellipse', cx: 3.4, cy: 0, rx: 1.6, ry: 4.4, rgb: TRIM },
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

/** One kart, rasterised as two stacked frames: row 0 is what is behind the driver, row 1 what is
 *  in front. The renderer draws them either side of the body. */
function drawKart(shapes: readonly Shape[], w: number, h: number): PNG {
  const png = new PNG({ width: w, height: h * LAYERS.length });
  png.data.fill(0);
  // Kart units are 40 long by 32 wide (the shapes above sit inside that); the frame scales to it,
  // so changing the art size in VEHICLE_ART needs no second number here.
  const scale = Math.min(w / 40, h / 32);
  for (let row = 0; row < LAYERS.length; row++) {
  const only = LAYERS[row];
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
          for (const shape of shapes) if (shape.layer === only && inside(shape, kx, ky)) rgb = shape.rgb;
          if (!rgb) continue;
          r += rgb[0];
          g += rgb[1];
          b += rgb[2];
          hits++;
        }
      }
      if (hits === 0) continue;
      const i = ((row * h + py) * w + px) * 4;
      png.data[i] = Math.round(r / hits);
      png.data[i + 1] = Math.round(g / hits);
      png.data[i + 2] = Math.round(b / hits);
      png.data[i + 3] = Math.round((hits / (SS * SS)) * 255);
    }
  }
  }
  // The dark edge, as a pass over the finished frame: any solid pixel with a see-through
  // neighbour is pulled towards the outline colour, weighted by how see-through it is.
  const alphaAt = (row: number, x: number, y: number): number =>
    x < 0 || x >= w || y < 0 || y >= h ? 0 : png.data[((row * h + y) * w + x) * 4 + 3];
  const edged = Buffer.from(png.data);
  for (let row = 0; row < LAYERS.length; row++) {
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = ((row * h + y) * w + x) * 4;
      if (png.data[i + 3] < 128) continue;
      const open =
        255 - alphaAt(row, x - 1, y) + (255 - alphaAt(row, x + 1, y)) +
        (255 - alphaAt(row, x, y - 1)) + (255 - alphaAt(row, x, y + 1));
      if (open === 0) continue;
      const t = Math.min(1, open / (255 * 2));
      for (let c = 0; c < 3; c++) edged[i + c] = Math.round(png.data[i + c] + (EDGE[c] - png.data[i + c]) * t);
    }
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
