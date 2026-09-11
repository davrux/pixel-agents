#!/usr/bin/env -S node --import tsx
/**
 * Draw the puff a figure vanishes in — the ninja exit.
 *
 * This style borrowed the pets' scuffle cloud at first, because that art was already committed,
 * and it was wrong twice over: a comic brawl puff has a paw and a tail poking out of it, and at
 * 32x32 over a 16x32 figure it read as a fight rather than an exit.
 *
 * So: soft grey blobs, no comic outline, and the mass RISES across the five frames while it thins
 * — smoke goes up, a scuffle stays put. The lesson the scuffle cloud DID record still holds
 * though, from the other side: a mark in a single dark colour is invisible on a dark floor, so
 * this is a light fill with a slightly darker shoulder rather than grey-on-grey.
 *
 * Deterministic (a seeded LCG, never Math.random): the sheet is committed, so a second run must
 * produce the same bytes or `--check` would report art nobody changed.
 *
 * Run: scripts/draw-smoke.sh [--check] [--preview]
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

import { PNG } from 'pngjs';

import { SMOKE_SHEET } from '@pixel/shared/office/effects.js';

const WRITE_OPTIONS = { filterType: 0, deflateLevel: 9, deflateStrategy: 0 } as const;

const REPO = path.join(import.meta.dirname, '..', '..');
const OUT = path.join(REPO, 'assets', 'effects', `${SMOKE_SHEET.id}.png`);
const CHECK = process.argv.includes('--check');
const PREVIEW = process.argv.includes('--preview');

const FW = SMOKE_SHEET.frameW;
const FH = SMOKE_SHEET.frameH;
const FRAMES = SMOKE_SHEET.frames;
const W = FW * FRAMES;

/** Light core, mid body, darker shoulder — the order is what makes a blob read as volume. */
const CORE = [0xf2, 0xf3, 0xf5] as const;
const BODY = [0xcf, 0xd2, 0xd8] as const;
const SHOULDER = [0x9a, 0x9f, 0xa8] as const;

/** Per frame: how big the mass is, how far it has risen, and how solid it still is. */
const SPREAD = [0.45, 0.85, 1, 0.95, 0.8];
const RISE = [0, 1.5, 3.5, 6, 9];
const SOLID = [0.85, 1, 0.95, 0.65, 0.32];
/** Blobs per frame — few, because a puff is a silhouette and not a particle system. */
const BLOBS = 7;

function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

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
  // The mass sits low in the frame and climbs: the sheet is anchored at the figure's feet.
  const cy = FH - 7 - RISE[f];
  // The same blob layout in every frame, so the puff grows and rises rather than reshuffling.
  const rand = lcg(0x5d0c);
  const blobs: Array<{ x: number; y: number; r: number }> = [];
  for (let b = 0; b < BLOBS; b++) {
    const ang = (b / BLOBS) * Math.PI * 2 + 0.6;
    const dist = (0.7 + rand() * 0.6) * 5.2 * SPREAD[f];
    blobs.push({
      x: cx + Math.cos(ang) * dist,
      y: cy + Math.sin(ang) * dist * 0.62,
      r: (2.6 + rand() * 2.2) * SPREAD[f],
    });
  }
  // Colour by the FIELD the blobs add up to, not blob by blob. Drawing each one with its own
  // core-body-shoulder rings made every circle's edge visible inside the mass, so it read as a
  // bunch of bubbles; summing first gives one silhouette with an interior.
  for (let y = 0; y < FH; y++) {
    for (let x = left; x < left + FW; x++) {
      let field = 0;
      for (const b of blobs) {
        const d = Math.hypot(x - b.x, y - b.y) / b.r;
        if (d < 1) field += (1 - d) * (1 - d);
      }
      if (field <= 0.02) continue;
      const rgb = field > 0.5 ? CORE : field > 0.18 ? BODY : SHOULDER;
      put(x, y, rgb, SOLID[f] * Math.min(1, 0.45 + field * 2));
    }
  }
}

const bytes = PNG.sync.write(png, WRITE_OPTIONS);

if (PREVIEW) {
  const ZOOM = 7;
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
  const preview = path.join(REPO, 'tmp', `${SMOKE_SHEET.id}-preview.png`);
  fs.mkdirSync(path.dirname(preview), { recursive: true });
  fs.writeFileSync(preview, PNG.sync.write(big, WRITE_OPTIONS));
  console.log(`preview: ${preview} (${FRAMES} frames at ${ZOOM}x, on the floor's grey)`);
}

if (CHECK) {
  const on_disk = fs.existsSync(OUT) ? fs.readFileSync(OUT) : Buffer.alloc(0);
  if (!on_disk.equals(bytes)) {
    console.error(`${OUT} differs from the drawing — run scripts/draw-smoke.sh`);
    process.exit(1);
  }
  console.log(`${OUT} matches the drawing`);
} else {
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, bytes);
  console.log(`wrote ${OUT} (${W}x${FH}, ${FRAMES} frames of ${FW}x${FH}, ${bytes.length} bytes)`);
}
