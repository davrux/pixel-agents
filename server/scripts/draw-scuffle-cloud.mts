#!/usr/bin/env -S node --import tsx
/**
 * Draw the scuffle cloud — the comic puff two pets disappear into when a hunter catches its quarry.
 *
 * One sheet for every pairing, not a track per animal, and that is the whole reason it exists as
 * its own art: the cloud hangs BETWEEN two pets rather than on one, and a comic puff is funny
 * precisely because it hides both of them. A `scuffle` track on each pet sheet would be six times
 * the work for a worse picture, and it could never cover the gap between two tiles.
 *
 * Written by a script rather than by hand because a dust cloud is a SHAPE, not a drawing: seven
 * lobes wobbling around a centre, outlined, with a paw and a few sparks poking out. What a human
 * hand would add is charm this can approximate, and anybody who wants to redraw a frame can open
 * the PNG — nothing downstream knows this file was generated.
 *
 * Deterministic on purpose (a seeded LCG, never Math.random): the sheet is committed, so a second
 * run must produce the same bytes or `--check` would report art that nobody changed.
 *
 * Run: scripts/draw-scuffle-cloud.sh [--check] [--preview]
 *   (no flag)   write assets/effects/scuffle.png
 *   --check     compare against the file on disk, exit 1 if it differs (for CI / a pre-commit look)
 *   --preview   also write an 8× magnified sheet to inspect, path printed
 *
 * Frame size and count are NOT decided here: they come from SCUFFLE_SHEET in
 * shared/src/office/effects.ts, which is what the engine and the renderer read. This script draws
 * whatever that says.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

import { PNG } from 'pngjs';

import { SCUFFLE_SHEET } from '@pixel/shared/office/effects.js';

/** The house write options — RLE costs 5× on pixel art (see pngEncoder). */
const WRITE_OPTIONS = { filterType: 0, deflateLevel: 9, deflateStrategy: 0 } as const;

const REPO = path.join(import.meta.dirname, '..', '..');
const OUT = path.join(REPO, 'assets', 'effects', `${SCUFFLE_SHEET.id}.png`);
const CHECK = process.argv.includes('--check');
const PREVIEW = process.argv.includes('--preview');

const { frameW: W, frameH: H, frames: FRAMES } = SCUFFLE_SHEET;

// The UI palette (AGENTS.md § UI), so the cloud belongs to this world rather than to a stock
// effect: the outline is the same near-black every panel border uses, and the two greys are the
// text and muted tokens.
const OUTLINE = [0x0a, 0x09, 0x08, 0xff];
const LIGHT = [0xf1, 0xef, 0xec, 0xff];
const MID = [0xad, 0xb0, 0xb2, 0xff];
const SPARK = [0xe7, 0xda, 0x00, 0xff]; // the highlight token — the "impact" flecks
const CLEAR = [0, 0, 0, 0];

/** Seeded LCG. Same numbers on every machine and every run, which is what --check needs. */
function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

type Px = readonly number[];

/** One frame as a grid of colours, `null` = transparent. */
function drawFrame(frame: number): Array<Array<Px | null>> {
  const rand = lcg(0x5c0ff1e + frame * 7919);
  const grid: Array<Array<Px | null>> = Array.from({ length: H }, () => new Array<Px | null>(W).fill(null));
  const put = (x: number, y: number, c: Px): void => {
    const xi = Math.round(x);
    const yi = Math.round(y);
    if (xi >= 0 && xi < W && yi >= 0 && yi < H) grid[yi][xi] = c;
  };

  // ── the silhouette ──────────────────────────────────────────────────────
  // A comic brawl cloud is a STAR, not a puff: rounded valleys between pointed tips. In polar
  // coordinates that is one line — a base radius plus a cosine with as many periods as tips — and
  // it is why the first attempt failed. Seven overlapping circles give a potato, and a potato reads
  // as smoke; the tips are what say "impact".
  const cx = (W - 1) / 2;
  const cy = H * 0.47; // a little above centre: the cloud is drawn on the midpoint BETWEEN two pets
  const TIPS = 9;
  const spin = (frame / FRAMES) * Math.PI * 2 * 0.35; // the whole shape turns slowly
  const base = H * 0.29 * (1 + 0.05 * Math.sin((frame / FRAMES) * Math.PI * 2));
  const amp = H * 0.075;
  const jitter = Array.from({ length: TIPS }, () => 0.8 + rand() * 0.45);

  const radiusAt = (a: number): number => {
    // Which tip we are nearest decides how far this angle reaches, so no two tips are the same
    // length — a perfectly regular star looks like a gear.
    const i = ((Math.round(((a - spin) / (Math.PI * 2)) * TIPS) % TIPS) + TIPS) % TIPS;
    return base + amp * Math.cos(TIPS * (a - spin)) * jitter[i];
  };

  const mask: boolean[][] = Array.from({ length: H }, (_, y) =>
    Array.from({ length: W }, (_, x) => {
      const dx = x - cx;
      const dy = (y - cy) / 0.86; // slightly wider than tall — two pets stand side by side
      const r = Math.hypot(dx, dy);
      return r <= radiusAt(Math.atan2(dy, dx));
    }),
  );

  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      if (!mask[y][x]) continue;
      // Outline where the mass ends, orthogonally only: a diagonal test rounds every corner off
      // and the tips — the whole point of the shape — go with it.
      const edge =
        y === 0 || y === H - 1 || x === 0 || x === W - 1 ||
        !mask[y - 1][x] || !mask[y + 1][x] || !mask[y][x - 1] || !mask[y][x + 1];
      if (edge) {
        grid[y][x] = OUTLINE;
        continue;
      }
      // Shading follows the mass instead of cutting a straight line across it: the lower-right
      // inside gets the mid grey, so the cloud has a lit side.
      const dx = (x - cx) / base;
      const dy = (y - cy) / base;
      grid[y][x] = dx + dy > 0.55 ? MID : LIGHT;
    }
  }

  // ── what pokes out, and it must poke OUT ────────────────────────────────
  // Two failures to avoid, both found by looking at the sheet instead of trusting it. Inside the
  // mass a dark speck is invisible, so everything here sits at a radius BEYOND the silhouette. And
  // a DARK speck on a dark floor is invisible too — the first version drew the paw, the tail and
  // three motion strokes in the outline colour and none of them could be seen at all. So a poke
  // gets the cloud's own language: light fill, dark edge. It reads on any ground that way, which a
  // single-colour mark cannot.
  const at = (a: number, r: number): { x: number; y: number } => ({ x: cx + Math.cos(a) * r, y: cy + Math.sin(a) * r * 0.86 });
  const pokes: Array<{ x: number; y: number }> = [];
  const poke = (x: number, y: number): void => {
    const xi = Math.round(x);
    const yi = Math.round(y);
    if (xi >= 1 && xi < W - 1 && yi >= 1 && yi < H - 1) pokes.push({ x: xi, y: yi });
  };

  // A paw, alternating sides so the eye reads two animals in there rather than one puff.
  const side = frame % 2 === 0 ? -1 : 1;
  const pawA = side < 0 ? Math.PI * 0.88 : Math.PI * 0.12;
  // Starting INSIDE the mass, not beyond its tips: a poke that begins where the silhouette ends
  // leaves a one-pixel gap once both get their outline, and then it reads as debris flying past
  // rather than as a limb sticking out. Overlapping cells stay cloud-coloured, so the two merge.
  const pawR = base - 1;
  for (const [dr, da] of [[0, 0], [1.5, 0], [2.6, -0.12], [1.4, 0.16]] as const) {
    const q = at(pawA + da * side, pawR + dr);
    poke(q.x, q.y);
  }

  // A tail flicking out low on the other side: four pixels along a curve, so it reads as a line
  // and not as a second paw.
  const tailA = side < 0 ? Math.PI * 0.34 : Math.PI * 0.66;
  for (let i = 0; i < 5; i++) {
    const t = at(tailA + i * 0.09 * -side, base - 1 + i * 1.2);
    poke(t.x, t.y);
  }

  for (const p of pokes) grid[p.y][p.x] = LIGHT;
  // The dark edge, added after every poke exists, so two adjacent poke pixels never outline each
  // other into a dashed line.
  const isPoke = (x: number, y: number): boolean => pokes.some((p) => p.x === x && p.y === y);
  for (const p of pokes) {
    for (const [dx, dy] of [[0, -1], [0, 1], [-1, 0], [1, 0], [-1, -1], [1, -1], [-1, 1], [1, 1]] as const) {
      const x = p.x + dx;
      const y = p.y + dy;
      if (x < 0 || x >= W || y < 0 || y >= H) continue;
      if (grid[y][x] === null && !isPoke(x, y)) grid[y][x] = OUTLINE;
    }
  }

  // Two four-pixel stars in the highlight colour, the only colour on the sheet — they read on any
  // ground, which is why they carry the "impact" now that the dark motion strokes are gone.
  for (let i = 0; i < 2; i++) {
    const st = at(spin * 2 + i * Math.PI * 1.1 - Math.PI * 0.55, base + amp + 3);
    put(st.x, st.y - 1, SPARK);
    put(st.x, st.y + 1, SPARK);
    put(st.x - 1, st.y, SPARK);
    put(st.x + 1, st.y, SPARK);
  }

  return grid;
}

// ── assemble the sheet ────────────────────────────────────────────────────
const png = new PNG({ width: W * FRAMES, height: H });
png.data.fill(0);
for (let f = 0; f < FRAMES; f++) {
  const grid = drawFrame(f);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const c = grid[y][x] ?? CLEAR;
      const i = (y * png.width + f * W + x) * 4;
      png.data[i] = c[0];
      png.data[i + 1] = c[1];
      png.data[i + 2] = c[2];
      png.data[i + 3] = c[3];
    }
  }
}
const bytes = PNG.sync.write(png, WRITE_OPTIONS);

if (PREVIEW) {
  const SCALE = 8;
  const big = new PNG({ width: png.width * SCALE, height: png.height * SCALE });
  for (let y = 0; y < big.height; y++) {
    for (let x = 0; x < big.width; x++) {
      const si = (Math.floor(y / SCALE) * png.width + Math.floor(x / SCALE)) * 4;
      const di = (y * big.width + x) * 4;
      // A mid-grey ground behind it: on white, a white puff with a dark outline is unreadable.
      const a = png.data[si + 3];
      for (let c = 0; c < 3; c++) big.data[di + c] = a ? png.data[si + c] : 0x4a4744;
      big.data[di + 3] = 0xff;
    }
  }
  const out = path.join(process.env.PREVIEW_DIR ?? REPO, 'scuffle-preview.png');
  fs.writeFileSync(out, PNG.sync.write(big, WRITE_OPTIONS));
  console.log(`preview: ${out}`);
}

if (CHECK) {
  const have = fs.existsSync(OUT) ? fs.readFileSync(OUT) : null;
  if (!have) {
    console.error(`✗ ${path.relative(REPO, OUT)} is missing — run scripts/draw-scuffle-cloud.sh`);
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
  console.log(`wrote ${path.relative(REPO, OUT)} — ${FRAMES} frames of ${W}×${H}, ${(bytes.length / 1024).toFixed(1)} KB`);
}
