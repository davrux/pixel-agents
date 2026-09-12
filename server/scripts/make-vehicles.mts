#!/usr/bin/env -S node --import tsx
/**
 * Turn Dust Racing 2D's car sprites into game-scale vehicles.
 *
 * The sources are CC BY-SA 3.0 and so is everything this writes — see
 * `assets/vehicles/dust/README.md`, which is the attribution and must stay beside them.
 *
 * Three things happen, and each one is a fact about the source rather than a preference:
 *
 *  - **The pure green is a MASK, not paint**, and it is taken as GEOMETRY rather than by colour.
 *    Every car has exactly 2864 pixels of (0,255,0) in the same places; Dust Racing composites
 *    its own glass over them. Matching the colour alone leaves a green fringe — the mask's edge
 *    is anti-aliased, so those pixels are nearly green and not exactly — and testing "greenish"
 *    instead would eat the green CAR. So the mask is read once from one file, grown by a pixel,
 *    and applied to all of them.
 *  - **They are eleven tiles long.** 175×93 in a world of 16 px tiles. Scaled by AREA AVERAGE
 *    rather than nearest-neighbour: these are smooth-shaded renders, not pixel art, so dropping
 *    pixels gives a speckled mess where averaging gives a small clean car.
 *  - **They point EAST**, which is heading 0 in the kart model — so the renderer rotates one
 *    image by the heading instead of picking from a strip of sixteen. That is smoother than
 *    sixteen steps AND less art, which is why the hand-drawn kart sheet is retired.
 *
 * Run: scripts/make-vehicles.sh [--check]
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

import { PNG } from 'pngjs';

import { VEHICLE_ART } from '@pixel/shared/office/race/kartArt.js';

const WRITE_OPTIONS = { filterType: 0, deflateLevel: 9, deflateStrategy: 0 } as const;
const REPO = path.join(import.meta.dirname, '..', '..');
const SRC = path.join(REPO, 'assets', 'vehicles', 'dust');
const OUT = path.join(REPO, 'assets', 'vehicles');
const CHECK = process.argv.includes('--check');

/** The mask colour, and what it becomes. */
const MASK = [0, 255, 0] as const;
const GLASS = [0x24, 0x28, 0x30] as const;

/** Where the glass is, read from one car and grown by a pixel to swallow the anti-aliased edge. */
function glassMask(file: string): { mask: boolean[]; width: number; height: number } {
  const src = PNG.sync.read(fs.readFileSync(path.join(SRC, file)));
  const exact = new Array<boolean>(src.width * src.height).fill(false);
  for (let i = 0; i < exact.length; i++) {
    const j = i * 4;
    exact[i] = src.data[j] === MASK[0] && src.data[j + 1] === MASK[1] && src.data[j + 2] === MASK[2];
  }
  const mask = exact.slice();
  for (let y = 0; y < src.height; y++) {
    for (let x = 0; x < src.width; x++) {
      if (!exact[y * src.width + x]) continue;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx;
          const ny = y + dy;
          if (nx >= 0 && ny >= 0 && nx < src.width && ny < src.height) mask[ny * src.width + nx] = true;
        }
      }
    }
  }
  return { mask, width: src.width, height: src.height };
}

const GLASS_MASK = glassMask(VEHICLE_ART[0].source);

function convert(file: string, w: number, h: number): Buffer {
  const src = PNG.sync.read(fs.readFileSync(path.join(SRC, file)));
  const out = new PNG({ width: w, height: h });
  out.data.fill(0);
  const sx = src.width / w;
  const sy = src.height / h;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      // Area average over the source rectangle this destination pixel covers. Alpha-weighted, so
      // the transparent surround does not wash the car's edge towards black.
      const x0 = Math.floor(x * sx);
      const x1 = Math.max(x0 + 1, Math.floor((x + 1) * sx));
      const y0 = Math.floor(y * sy);
      const y1 = Math.max(y0 + 1, Math.floor((y + 1) * sy));
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      let n = 0;
      for (let yy = y0; yy < y1 && yy < src.height; yy++) {
        for (let xx = x0; xx < x1 && xx < src.width; xx++) {
          const i = (yy * src.width + xx) * 4;
          let pr = src.data[i];
          let pg = src.data[i + 1];
          let pb = src.data[i + 2];
          const masked =
            src.width === GLASS_MASK.width && src.height === GLASS_MASK.height
              ? GLASS_MASK.mask[yy * src.width + xx]
              : pr === MASK[0] && pg === MASK[1] && pb === MASK[2];
          if (masked) {
            pr = GLASS[0];
            pg = GLASS[1];
            pb = GLASS[2];
          }
          const pa = src.data[i + 3] / 255;
          r += pr * pa;
          g += pg * pa;
          b += pb * pa;
          a += pa;
          n++;
        }
      }
      if (n === 0 || a === 0) continue;
      const i = (y * w + x) * 4;
      out.data[i] = Math.round(r / a);
      out.data[i + 1] = Math.round(g / a);
      out.data[i + 2] = Math.round(b / a);
      out.data[i + 3] = Math.round((a / n) * 255);
    }
  }
  return PNG.sync.write(out, WRITE_OPTIONS);
}

let differs = false;
for (const art of VEHICLE_ART) {
  const bytes = convert(art.source, art.w, art.h);
  const to = path.join(OUT, `${art.id}.png`);
  if (CHECK) {
    const have = fs.existsSync(to) ? fs.readFileSync(to) : null;
    if (!have?.equals(bytes)) {
      console.error(`✗ ${path.relative(REPO, to)} differs`);
      differs = true;
    }
    continue;
  }
  fs.writeFileSync(to, bytes);
  console.log(`wrote ${path.relative(REPO, to)} (${art.w}×${art.h}, ${bytes.length} bytes)`);
}
if (CHECK) {
  if (differs) {
    console.error('run scripts/make-vehicles.sh');
    process.exit(1);
  }
  console.log(`✓ all ${VEHICLE_ART.length} vehicle sprites are up to date`);
}
