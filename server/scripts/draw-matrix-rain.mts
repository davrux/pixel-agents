#!/usr/bin/env -S node --import tsx
/**
 * Draw the Matrix rain as a TILING texture, so the effect stops painting itself pixel by pixel.
 *
 * The old effect drew every cell of the character's frame with `fillRect`, twice — the body at the
 * current opacity and the rain over it. Counted: 581 fills per frame for a 16×32 character and
 * **4 376 for a 64×64 one**, into a private canvas that was re-uploaded to the GPU every frame.
 * Measured in a browser with five 64×64 figures materialising at once: **7.10 ms per frame**, 43 %
 * of a 60 fps budget, against 0.008 ms for the same thing as two draws. That is the reason this
 * file exists.
 *
 * What makes a sheet possible here — and this is the part I had wrong when I first said it was not:
 * the rain is NOT masked to the character's silhouette. There is no `if (pixel)` guard on it in
 * `renderMatrixEffect`; it fills the whole frame rectangle. So one generic texture works for every
 * character, whatever its skin, pose, direction or frame size, and the body is just the normal
 * sprite at a lower opacity — which the atlas already draws.
 *
 * What it draws is one BAND of drops at the top of an otherwise empty tile — see
 * `MATRIX_RAIN_SHEET` for why the geometry is what it is. The band is the wavefront; scrolling it
 * across the figure is the whole animation.
 *
 * Deterministic (a seeded LCG, never Math.random): the sheet is committed, so a second run must
 * produce the same bytes or `--check` would report art nobody changed.
 *
 * Run: scripts/draw-matrix-rain.sh [--check] [--preview]
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

import { PNG } from 'pngjs';

import { MATRIX_RAIN_BAND_PX, MATRIX_RAIN_SHEET } from '@pixel/shared/office/effects.js';

/** The house write options — RLE costs 5× on pixel art (see pngEncoder). */
const WRITE_OPTIONS = { filterType: 0, deflateLevel: 9, deflateStrategy: 0 } as const;

const REPO = path.join(import.meta.dirname, '..', '..');
const OUT = path.join(REPO, 'assets', 'effects', `${MATRIX_RAIN_SHEET.id}.png`);
const CHECK = process.argv.includes('--check');
const PREVIEW = process.argv.includes('--preview');

const W = MATRIX_RAIN_SHEET.frameW;
const H = MATRIX_RAIN_SHEET.frameH;

// The effect's own colours, so the sheet cannot drift from the constants the old path used.
const HEAD: readonly number[] = [0xcc, 0xff, 0xcc, 0xff];
const BRIGHT = [0x00, 0xff, 0x41] as const;
const MID = [0x00, 0xcc, 0x33] as const;
const DIM = [0x00, 0x88, 0x22] as const;
/** How long a drop's tail is, in pixels — the same 12 the pixel path used. */
const TRAIL = 12;
/** Peak trail opacity, matching MATRIX_TRAIL_EMPTY_ALPHA. */
const TRAIL_ALPHA = 0.5;

/** Seeded LCG. Same numbers on every machine and every run, which is what --check needs. */
function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

const png = new PNG({ width: W, height: H });
png.data.fill(0);

const put = (x: number, y: number, rgb: readonly number[], alpha: number): void => {
  // Clipped, not wrapped: everything below the band must stay empty, or the sweep becomes a
  // downpour. A tail that would run off the top of the tile is simply cut there — the drop reads as
  // one already halfway past.
  if (y < 0 || y >= H) return;
  const i = (y * W + x) * 4;
  const a = Math.round(Math.max(0, Math.min(1, alpha)) * 255);
  if (a <= png.data[i + 3]) return; // keep the brighter of two overlapping drops
  png.data[i] = rgb[0];
  png.data[i + 1] = rgb[1];
  png.data[i + 2] = rgb[2];
  png.data[i + 3] = a;
};

const rand = lcg(0x4d4154);
for (let col = 0; col < W; col++) {
  // One or two drops per column, and the head's own height within the band is what replaces the
  // per-column stagger the pixel path computed at runtime: a straight row of heads would give the
  // band a hard leading edge, which reads as a wipe rather than as falling code.
  const drops = rand() < 0.4 ? 2 : 1;
  for (let d = 0; d < drops; d++) {
    const head = Math.floor(rand() * MATRIX_RAIN_BAND_PX);
    put(col, head, HEAD, 1);
    for (let t = 1; t < TRAIL; t++) {
      const pos = t / TRAIL;
      const alpha = (1 - pos) * TRAIL_ALPHA;
      // Same three-stop ramp as the pixel path: bright close to the head, then mid, then dim.
      const rgb = pos < 0.3 ? BRIGHT : pos < 0.6 ? MID : DIM;
      put(col, head - t, rgb, alpha);
    }
  }
}

const bytes = PNG.sync.write(png, WRITE_OPTIONS);

if (PREVIEW) {
  const SCALE = 6;
  // One whole tile: what has to be visible here is the band and the empty gap under it.
  const big = new PNG({ width: W * SCALE, height: H * SCALE });
  for (let y = 0; y < big.height; y++) {
    for (let x = 0; x < big.width; x++) {
      const sx = Math.floor(x / SCALE);
      const sy = Math.floor(y / SCALE) % H;
      const si = (sy * W + sx) * 4;
      const di = (y * big.width + x) * 4;
      const a = png.data[si + 3] / 255;
      for (let c = 0; c < 3; c++) big.data[di + c] = Math.round(png.data[si + c] * a + 0x14 * (1 - a));
      big.data[di + 3] = 0xff;
    }
  }
  const out = path.join(process.env.PREVIEW_DIR ?? REPO, 'matrix-rain-preview.png');
  fs.writeFileSync(out, PNG.sync.write(big, WRITE_OPTIONS));
  console.log(`preview (one whole tile: the band, then the empty gap it sweeps in front of): ${out}`);
}

if (CHECK) {
  const have = fs.existsSync(OUT) ? fs.readFileSync(OUT) : null;
  if (!have) {
    console.error(`✗ ${path.relative(REPO, OUT)} is missing — run scripts/draw-matrix-rain.sh`);
    process.exit(1);
  }
  if (!have.equals(bytes)) {
    console.error(`✗ ${path.relative(REPO, OUT)} differs from what this script draws (${have.length} vs ${bytes.length} bytes)`);
    process.exit(1);
  }
  console.log(`✓ ${path.relative(REPO, OUT)} matches the generator (${bytes.length} bytes)`);
} else {
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, bytes);
  console.log(`wrote ${path.relative(REPO, OUT)} — ${W}×${H} tiling, ${(bytes.length / 1024).toFixed(1)} KB`);
}
