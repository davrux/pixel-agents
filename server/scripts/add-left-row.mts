#!/usr/bin/env -S node --import tsx
/**
 * Add the fourth (left) row to a character or pet sheet, mirroring the right row.
 *
 * Sheets used to carry three rows — down, up, right — and the client mirrored right at
 * load time to get left. That made "left" the one direction the engine had to invent,
 * and it is only correct for symmetric art: a bag on one shoulder, or a dog's saddle,
 * swaps sides when mirrored. So left becomes a row like any other, and the mirroring
 * happens ONCE, here (and in the editor's save/export), not on every load.
 *
 * Idempotent: a sheet that already has four rows is left alone, so this can be re-run
 * after new art arrives.
 *
 * Run: scripts/add-left-row.sh [--apply] [path…]   (default: the bundled sheets)
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

import { PNG } from 'pngjs';

import { ASSETS_ROOT } from '../src/assets.js';

const APPLY = process.argv.includes('--apply');
const args = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const files = args.length
  ? args
  : [
      ...fs.readdirSync(path.join(ASSETS_ROOT, 'assets', 'characters')).filter((f) => /^char_\d+\.png$/.test(f)).map((f) => path.join(ASSETS_ROOT, 'assets', 'characters', f)),
      ...fs.readdirSync(path.join(ASSETS_ROOT, 'assets', 'pets')).filter((f) => f.endsWith('.png')).map((f) => path.join(ASSETS_ROOT, 'assets', 'pets', f)),
    ].sort();

/** Same write options as the encoder — pngjs' defaults cost 5× on pixel art. */
const WRITE = { filterType: 0, deflateLevel: 9, deflateStrategy: 0 } as const;

let changed = 0;
let before = 0;
let after = 0;
for (const file of files) {
  const src = PNG.sync.read(fs.readFileSync(file));
  // Row height is the sheet's height divided by however many rows it has. Three rows is
  // the old format; four means somebody (or a previous run) already did this.
  const rowH = Math.round(src.height / 3);
  if (src.height % 3 !== 0 || src.height / rowH !== 3) {
    console.log(`  ${path.basename(file)}: ${src.width}×${src.height} is not a 3-row sheet — skipped`);
    continue;
  }
  const out = new PNG({ width: src.width, height: rowH * 4 });
  out.data.fill(0);
  src.data.copy(out.data); // the three existing rows, unchanged
  // Row 4 = row 3 (right) mirrored horizontally, pixel for pixel.
  const rightTop = 2 * rowH;
  for (let y = 0; y < rowH; y++) {
    for (let x = 0; x < src.width; x++) {
      const from = ((rightTop + y) * src.width + x) * 4;
      const to = ((3 * rowH + y) * src.width + (src.width - 1 - x)) * 4;
      out.data[to] = src.data[from];
      out.data[to + 1] = src.data[from + 1];
      out.data[to + 2] = src.data[from + 2];
      out.data[to + 3] = src.data[from + 3];
    }
  }
  const buf = PNG.sync.write(out, WRITE as never);
  const wasBytes = fs.statSync(file).size;
  before += wasBytes;
  after += buf.length;
  changed++;
  console.log(`  ${path.basename(file)}: ${src.width}×${src.height} → ${out.width}×${out.height}, ${wasBytes} → ${buf.length} bytes`);
  if (APPLY) fs.writeFileSync(file, buf);
}
console.log(`\n${changed} sheet(s)${APPLY ? ' rewritten' : ' would change'}: ${before} → ${after} bytes`);
if (!APPLY && changed) console.log('(dry run) --apply writes them');
