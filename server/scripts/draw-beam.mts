#!/usr/bin/env -S node --import tsx
/**
 * Draw the transporter beam as a TILING texture, the same shape as the Matrix rain.
 *
 * Same reason, too: the sweep has to cross figures from 16x32 to 64x64, and a sheet stretched to
 * fit gives a tall character fat light and a short one fine light. A tile keeps the beam at its
 * authored pixel size on every figure, and scrolling its one band across the frame IS the sweep.
 *
 * What it draws is a column of light in the top `BEAM_BAND_PX` of an otherwise empty tile: a white
 * core, cyan shoulders, and a soft outer glow, brightest at the band's LEADING edge (its bottom,
 * since the band travels downwards) so the eye reads a direction rather than a glowing bar. A few
 * sparks sit inside the glow, which is what keeps it from looking like a gradient.
 *
 * Deterministic (a seeded LCG, never Math.random): the sheet is committed, so a second run must
 * produce the same bytes or `--check` would report art nobody changed.
 *
 * Run: scripts/draw-beam.sh [--check] [--preview]
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

import { PNG } from 'pngjs';

import { BEAM_BAND_PX, BEAM_SHEET } from '@pixel/shared/office/effects.js';

const WRITE_OPTIONS = { filterType: 0, deflateLevel: 9, deflateStrategy: 0 } as const;

const REPO = path.join(import.meta.dirname, '..', '..');
const OUT = path.join(REPO, 'assets', 'effects', `${BEAM_SHEET.id}.png`);
const CHECK = process.argv.includes('--check');
const PREVIEW = process.argv.includes('--preview');

const W = BEAM_SHEET.frameW;
const H = BEAM_SHEET.frameH;
const BAND = BEAM_BAND_PX;

/** Core white, then cyan, then a blue glow — light reads as light only if it has a hot centre. */
const CORE = [0xff, 0xff, 0xff] as const;
const SHOULDER = [0x9f, 0xf0, 0xff] as const;
const GLOW = [0x35, 0x9f, 0xd8] as const;
/** Half-widths, in pixels, measured from the tile's centre. */
const CORE_HALF = 2;
const SHOULDER_HALF = 8;

function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

const png = new PNG({ width: W, height: H });
png.data.fill(0);

const put = (x: number, y: number, rgb: readonly number[], a: number): void => {
  if (x < 0 || x >= W || y < 0 || y >= H || a <= 0) return;
  const i = (y * W + x) * 4;
  const alpha = Math.min(255, Math.round(a * 255));
  // Keep the brighter of the two, so a spark drawn over glow stays a spark.
  if (png.data[i + 3] > alpha) return;
  png.data[i] = rgb[0];
  png.data[i + 1] = rgb[1];
  png.data[i + 2] = rgb[2];
  png.data[i + 3] = alpha;
};

const centre = Math.floor(W / 2);
for (let y = 0; y < BAND; y++) {
  // Brightest at the leading (bottom) edge of the band and fading upwards, so the beam has a head
  // and a tail like the rain does. Squared, so the tail is long and thin rather than a ramp.
  const lead = (y + 1) / BAND;
  const intensity = lead * lead;
  for (let dx = -SHOULDER_HALF - 3; dx <= SHOULDER_HALF + 3; dx++) {
    const x = centre + dx;
    const d = Math.abs(dx);
    if (d <= CORE_HALF) put(x, y, CORE, intensity);
    else if (d <= SHOULDER_HALF) put(x, y, SHOULDER, intensity * (1 - (d - CORE_HALF) / (SHOULDER_HALF - CORE_HALF + 2)));
    else put(x, y, GLOW, intensity * 0.4 * (1 - (d - SHOULDER_HALF) / 4));
  }
}

// Sparks: a handful of bright pixels inside the beam, so it shimmers instead of being a gradient.
const rand = lcg(0x5ea3);
for (let i = 0; i < 26; i++) {
  const y = Math.floor(rand() * BAND);
  const x = centre + Math.floor((rand() * 2 - 1) * (SHOULDER_HALF + 2));
  put(x, y, CORE, 0.55 + rand() * 0.45);
}

const bytes = PNG.sync.write(png, WRITE_OPTIONS);

if (PREVIEW) {
  const ZOOM = 6;
  const big = new PNG({ width: W * ZOOM, height: H * 2 * ZOOM });
  // The canvas background from AGENTS.md, because a light effect on a transparent sheet looks
  // like nothing in an image viewer and like a beam in the game.
  for (let i = 0; i < big.data.length; i += 4) {
    big.data[i] = 0x14;
    big.data[i + 1] = 0x16;
    big.data[i + 2] = 0x1c;
    big.data[i + 3] = 0xff;
  }
  for (let y = 0; y < H * 2; y++) {
    for (let x = 0; x < W; x++) {
      const src = ((y % H) * W + x) * 4;
      for (let dy = 0; dy < ZOOM; dy++) {
        for (let dx = 0; dx < ZOOM; dx++) {
          const dst = ((y * ZOOM + dy) * W * ZOOM + x * ZOOM + dx) * 4;
          const a = png.data[src + 3] / 255;
          big.data[dst] = Math.round(png.data[src] * a + big.data[dst] * (1 - a));
          big.data[dst + 1] = Math.round(png.data[src + 1] * a + big.data[dst + 1] * (1 - a));
          big.data[dst + 2] = Math.round(png.data[src + 2] * a + big.data[dst + 2] * (1 - a));
          big.data[dst + 3] = 0xff;
        }
      }
    }
  }
  const preview = path.join(REPO, 'tmp', `${BEAM_SHEET.id}-preview.png`);
  fs.mkdirSync(path.dirname(preview), { recursive: true });
  fs.writeFileSync(preview, PNG.sync.write(big, WRITE_OPTIONS));
  console.log(`preview: ${preview} (${W * ZOOM}x${H * 2 * ZOOM}, two tiles stacked)`);
}

if (CHECK) {
  const on_disk = fs.existsSync(OUT) ? fs.readFileSync(OUT) : Buffer.alloc(0);
  if (!on_disk.equals(bytes)) {
    console.error(`${OUT} differs from the drawing — run scripts/draw-beam.sh`);
    process.exit(1);
  }
  console.log(`${OUT} matches the drawing`);
} else {
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, bytes);
  console.log(`wrote ${OUT} (${W}x${H}, band ${BAND}px, ${bytes.length} bytes)`);
}
