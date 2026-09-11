#!/usr/bin/env -S node --import tsx
/**
 * Draw the phoenix flame — a FRAME SEQUENCE, not a tile, and that is the whole design decision.
 *
 * The sweep styles (rain, beam) are a wavefront: one band scrolled across the figure, which is why
 * they tile. A flame is not. It sits where the figure is and boils, so scrolling it would read as a
 * passing light rather than as burning. Six frames in one row, played over the phase.
 *
 * The shape is a width profile that narrows towards the top with a per-frame sine wobble, filled
 * radially — white-hot core, orange body, red edge — plus embers above the tip. Flames read as
 * flames because of that colour ORDER, not because of their outline: a single-colour silhouette
 * looks like a leaf. The same lesson the scuffle cloud recorded, from the other end.
 *
 * Frame 0 catches at the feet, 2-3 engulf, 5 has all but died back, so playing 0→5 works for a
 * dissolve and the client plays the same frames for the arrival (a fire that assembles a bird
 * looks like a fire either way round, which is the cheap half of this style).
 *
 * Deterministic (a seeded LCG, never Math.random): the sheet is committed, so a second run must
 * produce the same bytes or `--check` would report art nobody changed.
 *
 * Run: scripts/draw-phoenix.sh [--check] [--preview]
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

import { PNG } from 'pngjs';

import { PHOENIX_SHEET } from '@pixel/shared/office/effects.js';

const WRITE_OPTIONS = { filterType: 0, deflateLevel: 9, deflateStrategy: 0 } as const;

const REPO = path.join(import.meta.dirname, '..', '..');
const OUT = path.join(REPO, 'assets', 'effects', `${PHOENIX_SHEET.id}.png`);
const CHECK = process.argv.includes('--check');
const PREVIEW = process.argv.includes('--preview');

const FW = PHOENIX_SHEET.frameW;
const FH = PHOENIX_SHEET.frameH;
const FRAMES = PHOENIX_SHEET.frames;
const W = FW * FRAMES;

const CORE = [0xff, 0xf4, 0xc4] as const;
const BODY = [0xff, 0xa5, 0x2b] as const;
const EDGE = [0xd8, 0x3b, 0x1c] as const;
const EMBER = [0xff, 0xd0, 0x6a] as const;

/** How tall the flame stands in each frame, as a fraction of the frame height. */
const HEIGHT = [0.55, 0.85, 1, 1, 0.78, 0.45];
/** Half-width at the base, in pixels — 9 of 12 leaves a margin the wobble can use. */
const BASE_HALF = 9;

function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

const png = new PNG({ width: W, height: FH });
png.data.fill(0);

const put = (x: number, y: number, rgb: readonly number[], a = 1): void => {
  if (x < 0 || x >= W || y < 0 || y >= FH || a <= 0) return;
  const i = (y * W + x) * 4;
  png.data[i] = rgb[0];
  png.data[i + 1] = rgb[1];
  png.data[i + 2] = rgb[2];
  png.data[i + 3] = Math.min(255, Math.round(a * 255));
};

const rand = lcg(0x9f17);
for (let f = 0; f < FRAMES; f++) {
  const left = f * FW;
  const centre = left + Math.floor(FW / 2);
  const amp = HEIGHT[f];
  let tip = FH;
  for (let y = FH - 1; y >= 0; y--) {
    // 0 at the feet, 1 at the top of the frame.
    const t = (FH - 1 - y) / (FH - 1);
    if (t > amp) continue;
    tip = Math.min(tip, y);
    // Narrows towards the tip, with a wobble that differs per frame so the fire moves.
    const taper = 1 - t / amp;
    const wobble = Math.sin(y * 0.7 + f * 1.9) * 1.6 + Math.sin(y * 0.31 + f * 2.7) * 0.9;
    const half = Math.max(0.6, taper * BASE_HALF + wobble * taper);
    for (let dx = -Math.ceil(half); dx <= Math.ceil(half); dx++) {
      const d = Math.abs(dx) / half;
      if (d > 1) continue;
      // The colour ORDER is what makes this a flame; a single-colour silhouette is a leaf.
      const rgb = d < 0.34 ? CORE : d < 0.72 ? BODY : EDGE;
      // The very tip thins out rather than ending in a flat line.
      const alpha = t > amp * 0.88 ? 0.55 : 1;
      put(centre + dx, y, rgb, alpha);
    }
  }
  // Embers above the tip: few, bright, and only where the flame has already been.
  const embers = f < 2 ? 2 : f < 4 ? 5 : 7;
  for (let i = 0; i < embers; i++) {
    const y = Math.max(0, tip - 1 - Math.floor(rand() * 5));
    const x = centre + Math.floor((rand() * 2 - 1) * (BASE_HALF - 3));
    put(x, y, EMBER, 0.5 + rand() * 0.5);
  }
}

const bytes = PNG.sync.write(png, WRITE_OPTIONS);

if (PREVIEW) {
  const ZOOM = 6;
  const big = new PNG({ width: W * ZOOM, height: FH * ZOOM });
  for (let i = 0; i < big.data.length; i += 4) {
    big.data[i] = 0x14;
    big.data[i + 1] = 0x16;
    big.data[i + 2] = 0x1c;
    big.data[i + 3] = 0xff;
  }
  for (let y = 0; y < FH; y++) {
    for (let x = 0; x < W; x++) {
      const src = (y * W + x) * 4;
      const a = png.data[src + 3] / 255;
      for (let dy = 0; dy < ZOOM; dy++) {
        for (let dx = 0; dx < ZOOM; dx++) {
          const dst = ((y * ZOOM + dy) * W * ZOOM + x * ZOOM + dx) * 4;
          big.data[dst] = Math.round(png.data[src] * a + big.data[dst] * (1 - a));
          big.data[dst + 1] = Math.round(png.data[src + 1] * a + big.data[dst + 1] * (1 - a));
          big.data[dst + 2] = Math.round(png.data[src + 2] * a + big.data[dst + 2] * (1 - a));
        }
      }
    }
  }
  const preview = path.join(REPO, 'tmp', `${PHOENIX_SHEET.id}-preview.png`);
  fs.mkdirSync(path.dirname(preview), { recursive: true });
  fs.writeFileSync(preview, PNG.sync.write(big, WRITE_OPTIONS));
  console.log(`preview: ${preview} (${FRAMES} frames at ${ZOOM}x, on the canvas ground)`);
}

if (CHECK) {
  const on_disk = fs.existsSync(OUT) ? fs.readFileSync(OUT) : Buffer.alloc(0);
  if (!on_disk.equals(bytes)) {
    console.error(`${OUT} differs from the drawing — run scripts/draw-phoenix.sh`);
    process.exit(1);
  }
  console.log(`${OUT} matches the drawing`);
} else {
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, bytes);
  console.log(`wrote ${OUT} (${W}x${FH}, ${FRAMES} frames of ${FW}x${FH}, ${bytes.length} bytes)`);
}
