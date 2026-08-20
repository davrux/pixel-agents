#!/usr/bin/env -S node --import tsx
/**
 * Write the fourth (left) row of a character or pet sheet: every cell of the right row,
 * mirrored IN PLACE.
 *
 * Per CELL, not per row — and that distinction is the whole bug this script once had.
 * Mirroring the row as one strip also reverses the ORDER of its cells, so the walk
 * columns end up holding the mirrored sit and idle frames: a cat walking left sat down,
 * and a dog's stand and walk look similar enough in profile that it went unnoticed until
 * somebody watched a cat. A check that compared the left row against the whole-row mirror
 * confirmed the same mistake — which is why `leftRow.int.test.ts` compares cell by cell.
 *
 * Idempotent by construction: the left row is always recomputed from the right row, so a
 * sheet with three rows gains one and a sheet with four gets its fourth repaired.
 *
 * Cell width has to be told, not guessed: a character cell is 16×32 and a pet cell 16×16,
 * and nothing in the file says which. The defaults follow the directory.
 *
 * Run: scripts/add-left-row.sh [--apply] [--frame-w N] [path…]
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

import { PNG } from 'pngjs';

import { ASSETS_ROOT } from '../src/assets.js';
import { CHAR_FRAME_W, PET_FRAME_W } from '../src/core/assets/constants.js';

const APPLY = process.argv.includes('--apply');
const wArg = process.argv.indexOf('--frame-w');
const FRAME_W_OVERRIDE = wArg >= 0 ? Number(process.argv[wArg + 1]) : 0;
const args = process.argv.slice(2).filter((a, i, all) => !a.startsWith('--') && all[i - 1] !== '--frame-w');

const charDir = path.join(ASSETS_ROOT, 'assets', 'characters');
const petDir = path.join(ASSETS_ROOT, 'assets', 'pets');
const files = args.length
  ? args
  : [
      ...fs.readdirSync(charDir).filter((f) => /^char_\d+\.png$/.test(f)).map((f) => path.join(charDir, f)),
      ...fs.readdirSync(petDir).filter((f) => f.endsWith('.png')).map((f) => path.join(petDir, f)),
    ].sort();

/** Same write options as the encoder — pngjs' defaults cost 5× on pixel art. */
const WRITE = { filterType: 0, deflateLevel: 9, deflateStrategy: 0 } as const;

/** A cell's width: told, or the directory's convention. */
function frameWidthFor(file: string): number {
  if (FRAME_W_OVERRIDE > 0) return FRAME_W_OVERRIDE;
  return file.includes(`${path.sep}pets${path.sep}`) ? PET_FRAME_W : CHAR_FRAME_W;
}

let changed = 0;
let before = 0;
let after = 0;
for (const file of files) {
  const src = PNG.sync.read(fs.readFileSync(file));
  // Three rows is a sheet from before left existed; four is one this already wrote.
  const rows = src.height % 4 === 0 ? 4 : src.height % 3 === 0 ? 3 : 0;
  const rowH = rows ? src.height / rows : 0;
  const frameW = frameWidthFor(file);
  if (!rowH || src.width % frameW !== 0) {
    console.log(`  ${path.basename(file)}: ${src.width}×${src.height} with ${frameW}px cells does not divide — skipped`);
    continue;
  }
  const cols = src.width / frameW;
  const out = new PNG({ width: src.width, height: rowH * 4 });
  out.data.fill(0);
  // Rows 0–2 verbatim; row 3 is (re)derived below.
  src.data.copy(out.data, 0, 0, src.width * rowH * 3 * 4);
  const rightTop = 2 * rowH;
  for (let col = 0; col < cols; col++) {
    const x0 = col * frameW;
    for (let y = 0; y < rowH; y++) {
      for (let dx = 0; dx < frameW; dx++) {
        const from = ((rightTop + y) * src.width + x0 + dx) * 4;
        // Mirrored WITHIN this cell: the cell keeps its column, its pixels turn around.
        const to = ((3 * rowH + y) * src.width + x0 + (frameW - 1 - dx)) * 4;
        out.data[to] = src.data[from];
        out.data[to + 1] = src.data[from + 1];
        out.data[to + 2] = src.data[from + 2];
        out.data[to + 3] = src.data[from + 3];
      }
    }
  }
  const buf = PNG.sync.write(out, WRITE as never);
  const wasBytes = fs.statSync(file).size;
  const identical = rows === 4 && Buffer.compare(buf, fs.readFileSync(file)) === 0;
  before += wasBytes;
  after += buf.length;
  if (identical) {
    console.log(`  ${path.basename(file)}: already correct (${cols}×4 cells of ${frameW}×${rowH})`);
    continue;
  }
  changed++;
  console.log(
    `  ${path.basename(file)}: ${src.width}×${src.height} → ${out.width}×${out.height}` +
      ` (${cols}×4 cells of ${frameW}×${rowH}), ${wasBytes} → ${buf.length} bytes`,
  );
  if (APPLY) fs.writeFileSync(file, buf);
}
console.log(`\n${changed} sheet(s)${APPLY ? ' written' : ' would change'}: ${before} → ${after} bytes`);
if (!APPLY && changed) console.log('(dry run) --apply writes them');
