/**
 * Every bundled sheet's left row is its right row mirrored CELL BY CELL.
 *
 * This exists because getting it wrong is invisible in the obvious check. The bake once
 * mirrored the whole 96-px row as one strip, which also reverses the ORDER of the cells:
 * the walk columns then hold the mirrored sit and idle frames, so a cat walking left sat
 * down. A dog's stand and walk look alike in profile, so it survived a screenshot; and
 * the check written at the time compared the left row against the whole-row mirror, i.e.
 * it asserted the same mistake and passed.
 *
 * So the property is stated per cell, and the two halves of the sheet are compared in the
 * place where the difference shows: column 3 of the left row must mirror column 3 of the
 * right row, not column 2.
 *
 * TEST BOUNDARIES:
 *   @real-dependency: the sheets in assets/ -- Mock? NO. The artifact is the thing that
 *       was wrong; a synthetic sheet would only re-test the mirroring code.
 */
import { strict as assert } from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';
import test from 'node:test';

import { PNG } from 'pngjs';

import { ASSETS_ROOT } from './assets.js';
import { CHAR_FRAME_W, PET_FRAME_W } from './core/assets/constants.js';

interface Sheet {
  name: string;
  png: PNG;
  frameW: number;
}

/**
 * A sheet's cell width is what its own manifest says, not one constant.
 *
 * Frame size is per character (`CharacterSpec`, up to 64×64, declared in a `char_N.json`), so
 * slicing every sheet at CHAR_FRAME_W would check the wrong columns the moment a character
 * declares its own size: the mirror comparison would pair cell 1 of the left row with a
 * point inside cell 0 of the right one and fail on art that is perfectly mirrored. The
 * constant stays the fallback, which is exactly what the loader does with a missing
 * manifest.
 */
function declaredFrameW(dir: string, file: string, fallback: number): number {
  if (dir !== 'characters') return fallback;
  const manifest = path.join(ASSETS_ROOT, 'assets', dir, file.replace(/\.png$/i, '.json'));
  if (!fs.existsSync(manifest)) return fallback;
  const w = (JSON.parse(fs.readFileSync(manifest, 'utf-8')) as { frame?: { w?: number } }).frame?.w;
  return typeof w === 'number' && Number.isInteger(w) && w > 0 && w <= 64 ? w : fallback;
}

function sheets(): Sheet[] {
  const out: Sheet[] = [];
  for (const [dir, frameW, filter] of [
    ['characters', CHAR_FRAME_W, (f: string) => /^char_\d+\.png$/.test(f)],
    ['pets', PET_FRAME_W, (f: string) => f.endsWith('.png')],
  ] as const) {
    const full = path.join(ASSETS_ROOT, 'assets', dir);
    for (const f of fs.readdirSync(full).filter(filter).sort()) {
      out.push({
        name: `${dir}/${f}`,
        png: PNG.sync.read(fs.readFileSync(path.join(full, f))),
        frameW: declaredFrameW(dir, f, frameW),
      });
    }
  }
  return out;
}

const pixel = (png: PNG, x: number, y: number): string =>
  [0, 1, 2, 3].map((o) => png.data[(y * png.width + x) * 4 + o]).join(',');

test('every bundled sheet has four rows', () => {
  const all = sheets();
  assert.ok(all.length >= 12, `expected the bundled roster, found ${all.length}`);
  for (const s of all) {
    assert.equal(s.png.height % 4, 0, `${s.name}: ${s.png.width}×${s.png.height} is not four rows`);
    assert.equal(s.png.width % s.frameW, 0, `${s.name}: width is not a whole number of ${s.frameW}px cells`);
  }
});

test('the left row mirrors the right row cell by cell, not row by row', () => {
  for (const { name, png, frameW } of sheets()) {
    const rowH = png.height / 4;
    const cols = png.width / frameW;
    for (let col = 0; col < cols; col++) {
      for (let y = 0; y < rowH; y++) {
        for (let dx = 0; dx < frameW; dx++) {
          const right = pixel(png, col * frameW + dx, 2 * rowH + y);
          const left = pixel(png, col * frameW + (frameW - 1 - dx), 3 * rowH + y);
          assert.equal(left, right, `${name}: left cell ${col} does not mirror right cell ${col} at (${dx},${y})`);
        }
      }
    }
  }
});

test('a whole-row mirror would FAIL this — the bug it replaces is detectable', () => {
  // Guard on the guard: the assertion above must be able to tell the two mirrors apart.
  // On a sheet whose cells differ (Daisy walks in columns 0–2 and sits in 3–5), a
  // whole-row mirror predicts different pixels than a per-cell one, so passing by
  // accident is impossible. Without this, "left mirrors right" could be asserted in a
  // way that both the fix and the bug satisfy — which is exactly what happened.
  const daisy = sheets().find((s) => s.name.endsWith('cat_1.png'));
  assert.ok(daisy, 'cat_1 is part of the bundled roster');
  const { png, frameW } = daisy;
  const rowH = png.height / 4;
  const cols = png.width / frameW;
  let differences = 0;
  for (let col = 0; col < cols; col++) {
    for (let y = 0; y < rowH; y++) {
      for (let dx = 0; dx < frameW; dx++) {
        const x = col * frameW + dx;
        const perCell = pixel(png, col * frameW + (frameW - 1 - dx), 2 * rowH + y);
        const wholeRow = pixel(png, png.width - 1 - x, 2 * rowH + y);
        if (perCell !== wholeRow) differences++;
      }
    }
  }
  assert.ok(differences > 100, `the two mirrors differ in only ${differences} pixels — this guard proves nothing`);
});
