#!/usr/bin/env -S node --import tsx
/**
 * Draw the flash a folding figure collapses into: a line of light across the body's middle.
 *
 * Why it needs art, when the fold itself is a transform: a figure squeezed to nothing tells you
 * what the BODY did, not where it went — the same thing the implosion taught, where a uniform
 * squeeze read as walking away from the camera. The line is the seam the figure disappears into,
 * and the glow is what makes it a seam rather than a scratch.
 *
 * Four frames: a thin seam, the flash at its widest, a bright narrow core, a dot. The client plays
 * them across the phase and mirrors them for the arrival.
 *
 * Deterministic: no randomness here at all, the shape is a line and a falloff.
 *
 * Run: scripts/draw-fold.sh [--check] [--preview]
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

import { PNG } from 'pngjs';

import { FOLD_SHEET } from '@pixel/shared/office/effects.js';

const WRITE_OPTIONS = { filterType: 0, deflateLevel: 9, deflateStrategy: 0 } as const;

const REPO = path.join(import.meta.dirname, '..', '..');
const OUT = path.join(REPO, 'assets', 'effects', `${FOLD_SHEET.id}.png`);
const CHECK = process.argv.includes('--check');
const PREVIEW = process.argv.includes('--preview');

const FW = FOLD_SHEET.frameW;
const FH = FOLD_SHEET.frameH;
const FRAMES = FOLD_SHEET.frames;
const W = FW * FRAMES;

const CORE = [0xff, 0xff, 0xff] as const;
const GLOW = [0xbf, 0xe4, 0xff] as const;

/** Half-length of the line per frame, and how far the glow reaches above and below it. */
const HALF_LEN = [5, 15, 9, 2];
const GLOW_PX = [1.2, 3.4, 2.0, 1.0];

const png = new PNG({ width: W, height: FH });
png.data.fill(0);

const put = (x: number, y: number, rgb: readonly number[], a: number): void => {
  if (x < 0 || x >= W || y < 0 || y >= FH || a <= 0) return;
  const i = (y * W + x) * 4;
  const alpha = Math.min(255, Math.round(a * 255));
  if (png.data[i + 3] > alpha) return;
  png.data[i] = rgb[0];
  png.data[i + 1] = rgb[1];
  png.data[i + 2] = rgb[2];
  png.data[i + 3] = alpha;
};

for (let f = 0; f < FRAMES; f++) {
  const left = f * FW;
  const cx = left + FW / 2 - 0.5;
  const cy = FH / 2 - 0.5;
  const half = HALF_LEN[f];
  const glow = GLOW_PX[f];
  for (let y = 0; y < FH; y++) {
    const dy = Math.abs(y - cy);
    if (dy > glow + 1) continue;
    for (let x = left; x < left + FW; x++) {
      const dx = Math.abs(x - cx);
      if (dx > half) continue;
      // Tapered at the ends, so the line has a middle rather than being a bar.
      const along = 1 - Math.pow(dx / Math.max(1, half), 2.2);
      if (dy < 0.6) put(x, y, CORE, along);
      else put(x, y, GLOW, along * 0.6 * (1 - dy / (glow + 1)));
    }
  }
}

const bytes = PNG.sync.write(png, WRITE_OPTIONS);

if (PREVIEW) {
  const ZOOM = 8;
  const big = new PNG({ width: W * ZOOM, height: FH * ZOOM });
  for (let i = 0; i < big.data.length; i += 4) {
    big.data[i] = 0x4a;
    big.data[i + 1] = 0x4a;
    big.data[i + 2] = 0x4a;
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
  const preview = path.join(REPO, 'tmp', `${FOLD_SHEET.id}-preview.png`);
  fs.mkdirSync(path.dirname(preview), { recursive: true });
  fs.writeFileSync(preview, PNG.sync.write(big, WRITE_OPTIONS));
  console.log(`preview: ${preview} (${FRAMES} frames at ${ZOOM}x, on the floor's grey)`);
}

if (CHECK) {
  const on_disk = fs.existsSync(OUT) ? fs.readFileSync(OUT) : Buffer.alloc(0);
  if (!on_disk.equals(bytes)) {
    console.error(`${OUT} differs from the drawing — run scripts/draw-fold.sh`);
    process.exit(1);
  }
  console.log(`${OUT} matches the drawing`);
} else {
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, bytes);
  console.log(`wrote ${OUT} (${W}x${FH}, ${FRAMES} frames of ${FW}x${FH}, ${bytes.length} bytes)`);
}
