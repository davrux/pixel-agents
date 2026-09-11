#!/usr/bin/env -S node --import tsx
/**
 * Draw the point an imploding figure is drawn into: a dark disc with a bright rim.
 *
 * Why it needs art at all, when the style started out as a pure transform: a sprite that only
 * gets smaller reads as a figure walking away from the camera. What makes it a collapse is
 * something AT the point the figure goes into — and the rim is what makes that something read as
 * a hole rather than a blob, because a dark mark on a dark floor is invisible (the same lesson
 * the scuffle cloud recorded).
 *
 * Four frames: open, wide, a thin bright ring as it swallows, then almost shut. The client plays
 * them across the phase and mirrors them for the arrival.
 *
 * Deterministic: no randomness at all here — the shape is circles.
 *
 * Run: scripts/draw-implode.sh [--check] [--preview]
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

import { PNG } from 'pngjs';

import { IMPLODE_SHEET } from '@pixel/shared/office/effects.js';

const WRITE_OPTIONS = { filterType: 0, deflateLevel: 9, deflateStrategy: 0 } as const;

const REPO = path.join(import.meta.dirname, '..', '..');
const OUT = path.join(REPO, 'assets', 'effects', `${IMPLODE_SHEET.id}.png`);
const CHECK = process.argv.includes('--check');
const PREVIEW = process.argv.includes('--preview');

const FW = IMPLODE_SHEET.frameW;
const FH = IMPLODE_SHEET.frameH;
const FRAMES = IMPLODE_SHEET.frames;
const W = FW * FRAMES;

/** The hole itself, and the rim that makes it visible on a dark floor. */
const VOID_COLOR = [0x08, 0x06, 0x10] as const;
const RIM = [0xbf, 0xd8, 0xff] as const;
const RIM_OUTER = [0x5a, 0x86, 0xd8] as const;

/** Outer radius and rim thickness per frame: open, wide, swallowing, nearly shut. */
const RADIUS = [3.2, 6.4, 7.2, 2.4];
const RIM_PX = [1.1, 1.3, 0.8, 1.6];

const png = new PNG({ width: W, height: FH });
png.data.fill(0);

const put = (x: number, y: number, rgb: readonly number[], a: number): void => {
  if (x < 0 || x >= W || y < 0 || y >= FH || a <= 0) return;
  const i = (y * W + x) * 4;
  png.data[i] = rgb[0];
  png.data[i + 1] = rgb[1];
  png.data[i + 2] = rgb[2];
  png.data[i + 3] = Math.min(255, Math.round(a * 255));
};

for (let f = 0; f < FRAMES; f++) {
  const left = f * FW;
  const cx = left + FW / 2 - 0.5;
  const cy = FH / 2 - 0.5;
  const outer = RADIUS[f];
  const rim = RIM_PX[f];
  for (let y = 0; y < FH; y++) {
    for (let x = left; x < left + FW; x++) {
      const d = Math.hypot(x - cx, y - cy);
      if (d > outer + 1) continue;
      if (d > outer) {
        // One pixel of outer glow, so the rim does not end on a hard edge.
        put(x, y, RIM_OUTER, 0.45 * (1 - (d - outer)));
      } else if (d > outer - rim) {
        put(x, y, RIM, 0.95);
      } else {
        // Darker towards the centre: a flat disc reads as a coin, a gradient as depth.
        put(x, y, VOID_COLOR, 0.55 + 0.45 * (1 - d / Math.max(0.001, outer - rim)));
      }
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
  const preview = path.join(REPO, 'tmp', `${IMPLODE_SHEET.id}-preview.png`);
  fs.mkdirSync(path.dirname(preview), { recursive: true });
  fs.writeFileSync(preview, PNG.sync.write(big, WRITE_OPTIONS));
  console.log(`preview: ${preview} (${FRAMES} frames at ${ZOOM}x, on the floor's grey)`);
}

if (CHECK) {
  const on_disk = fs.existsSync(OUT) ? fs.readFileSync(OUT) : Buffer.alloc(0);
  if (!on_disk.equals(bytes)) {
    console.error(`${OUT} differs from the drawing — run scripts/draw-implode.sh`);
    process.exit(1);
  }
  console.log(`${OUT} matches the drawing`);
} else {
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, bytes);
  console.log(`wrote ${OUT} (${W}x${FH}, ${FRAMES} frames of ${FW}x${FH}, ${bytes.length} bytes)`);
}
