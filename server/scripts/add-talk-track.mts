#!/usr/bin/env -S node --import tsx
/**
 * Give the bundled pet sheets a two-frame `talk` track, derived from the frame they already have.
 *
 * The engine asks for a `talk` pose whenever a pet stands beside an agent to chat
 * (`petPose`/`PetState.TALK`), and it asks for `drink` at a coffee station — but the sheets carry
 * three tracks (walk 0-2, sit 3-4, idle 5), so both resolved to column 5 and a chatting pet stood
 * perfectly still. Column 5 was doing five jobs: idle, spawn, despawn, drink and talk.
 *
 * What this writes is the cheapest honest animation and nothing more: **column 6 is that row's
 * stand frame, column 7 is the same pixels one row higher.** At 16×16 a 1 px whole-sprite lift is
 * the classic bounce, it cannot tear (a half-body shift would leave a seam at the waist), and it is
 * fully determined by the art already there — no hand-drawing, no scaling, so none of the failures
 * the sheet README warns about. Measured before choosing it: every stand frame of every sheet has
 * row 0 empty, so lifting never clips the head.
 *
 * A real drawn talk pose (head up, muzzle open) would be better and this does not stand in its way:
 * redraw columns 6 and 7 whenever somebody wants to.
 *
 * The spec half of the change is in `PET_SPRITE_SPEC` (append-only — a track claims the next free
 * columns, so walk/sit/idle keep 0-5; see poseFrames.int.test.ts). The two halves may land in
 * either order: a spec claiming art a file lacks falls back to the idle frame rather than drawing
 * a gap.
 *
 * Run: scripts/add-talk-track.sh [--apply] [path…]
 *
 * Idempotent: a sheet that is already 8 columns wide is skipped, so re-running is safe. Every
 * write is verified by reading the file back and comparing all eight columns against what was
 * intended; a sheet that does not match is left exactly as it was.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

import { PNG } from 'pngjs';

import { PET_FRAME_H, PET_FRAME_W, PET_FRAMES_PER_ROW } from '../src/core/assets/constants.js';

/** The house write options — RLE costs 5× on pixel art (see pngEncoder). */
const WRITE_OPTIONS = { filterType: 0, deflateLevel: 9, deflateStrategy: 0 } as const;

/** Columns after this runs: the six that exist plus the two talk frames. */
const TALK_FRAMES = 2;
const NEW_COLS = PET_FRAMES_PER_ROW + TALK_FRAMES;

/** The neutral standing column — the middle of the walk cycle (README: `standIdx = walk.start + 1`). */
const STAND_COL = 1;

const APPLY = process.argv.includes('--apply');
const args = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const REPO = path.join(import.meta.dirname, '..', '..');
const sheets =
  args.length > 0
    ? args
    : ['dog_0', 'dog_1', 'cat_0', 'cat_1', 'duck_0', 'duck_1'].map((n) => path.join(REPO, 'assets', 'pets', `${n}.png`));

/** Copy one 16×16 cell, optionally lifted by `lift` pixels. */
function copyCell(src: PNG, dst: PNG, srcCol: number, dstCol: number, row: number, lift: number): void {
  for (let y = 0; y < PET_FRAME_H; y++) {
    const from = y + lift; // the source row that lands on y
    if (from < 0 || from >= PET_FRAME_H) continue; // lifted off the cell: stays transparent
    for (let x = 0; x < PET_FRAME_W; x++) {
      const si = ((row * PET_FRAME_H + from) * src.width + srcCol * PET_FRAME_W + x) * 4;
      const di = ((row * PET_FRAME_H + y) * dst.width + dstCol * PET_FRAME_W + x) * 4;
      dst.data[di] = src.data[si];
      dst.data[di + 1] = src.data[si + 1];
      dst.data[di + 2] = src.data[si + 2];
      dst.data[di + 3] = src.data[si + 3];
    }
  }
}

/** Are two cells of two images pixel-identical? Used to verify a write, not to decide one. */
function sameCell(a: PNG, aCol: number, b: PNG, bCol: number, row: number, lift = 0): boolean {
  for (let y = 0; y < PET_FRAME_H; y++) {
    for (let x = 0; x < PET_FRAME_W; x++) {
      const ai = ((row * PET_FRAME_H + y) * a.width + aCol * PET_FRAME_W + x) * 4;
      const from = y + lift;
      const inCell = from >= 0 && from < PET_FRAME_H;
      const bi = ((row * PET_FRAME_H + (inCell ? from : y)) * b.width + bCol * PET_FRAME_W + x) * 4;
      for (let c = 0; c < 4; c++) {
        const want = inCell ? b.data[bi + c] : 0; // off-cell source means transparent
        if (a.data[ai + c] !== want) return false;
      }
    }
  }
  return true;
}

/** Highest empty pixel row in a cell — proof that a 1 px lift cannot clip the art. */
function topEmpty(png: PNG, col: number, row: number): boolean {
  for (let x = 0; x < PET_FRAME_W; x++) {
    if (png.data[((row * PET_FRAME_H) * png.width + col * PET_FRAME_W + x) * 4 + 3] >= 2) return false;
  }
  return true;
}

let written = 0;
let skipped = 0;
const refused: string[] = [];

for (const file of sheets) {
  const name = path.basename(file);
  if (!fs.existsSync(file)) {
    refused.push(`${name}: no such file`);
    continue;
  }
  const src = PNG.sync.read(fs.readFileSync(file));
  const cols = Math.floor(src.width / PET_FRAME_W);
  const rows = Math.floor(src.height / PET_FRAME_H);

  if (cols >= NEW_COLS) {
    skipped++;
    console.log(`  ${name}: already ${cols} columns — skipped`);
    continue;
  }
  if (cols !== PET_FRAMES_PER_ROW) {
    refused.push(`${name}: ${cols} columns, expected ${PET_FRAMES_PER_ROW} — not a sheet this knows how to widen`);
    continue;
  }

  const noHeadroom = Array.from({ length: rows }, (_, r) => r).filter((r) => !topEmpty(src, STAND_COL, r));
  const dst = new PNG({ width: NEW_COLS * PET_FRAME_W, height: src.height });
  dst.data.fill(0);
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) copyCell(src, dst, c, c, r, 0);
    // Talk: the stand frame, then the stand frame lifted 1 px — unless this row has no headroom,
    // in which case both frames are the stand and that row's talk is static (what it is today).
    const lift = noHeadroom.includes(r) ? 0 : 1;
    copyCell(src, dst, STAND_COL, PET_FRAMES_PER_ROW, r, 0);
    copyCell(src, dst, STAND_COL, PET_FRAMES_PER_ROW + 1, r, lift);
  }

  // Verify against the SOURCE before keeping anything: the six original columns byte for byte,
  // and the two new ones against the stand frame they were derived from.
  const out = PNG.sync.write(dst, WRITE_OPTIONS);
  const back = PNG.sync.read(out);
  let ok = back.width === NEW_COLS * PET_FRAME_W && back.height === src.height;
  for (let r = 0; ok && r < rows; r++) {
    for (let c = 0; ok && c < cols; c++) ok = sameCell(back, c, src, c, r);
    if (ok) ok = sameCell(back, PET_FRAMES_PER_ROW, src, STAND_COL, r);
    if (ok) ok = sameCell(back, PET_FRAMES_PER_ROW + 1, src, STAND_COL, r, noHeadroom.includes(r) ? 0 : 1);
  }
  if (!ok) {
    refused.push(`${name}: the widened sheet does not read back as intended — left as it was`);
    continue;
  }

  const note = noHeadroom.length > 0 ? ` (rows ${noHeadroom.join(',')} have no headroom: static talk)` : '';
  console.log(`  ${name}: ${cols} → ${NEW_COLS} columns, ${(fs.statSync(file).size / 1024).toFixed(1)} → ${(out.length / 1024).toFixed(1)} KB${note}`);
  if (APPLY) fs.writeFileSync(file, out);
  written++;
}

console.log(
  `\n${written} sheet(s) to widen` + (skipped ? `, ${skipped} already done` : '') + (refused.length ? `, ${refused.length} refused` : ''),
);
for (const r of refused) console.warn(`  ! ${r}`);
if (!APPLY && written > 0) console.log('(dry run) --apply writes them');
if (APPLY && written > 0) {
  console.log('Append { name: \'talk\', frames: 2, play: \'loop\' } to PET_SPRITE_SPEC if it is not there yet.');
  console.log('A saved NPC override shadows the file — reset that variant in the editor to see this art.');
}
