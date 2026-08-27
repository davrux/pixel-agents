/**
 * The gate on the first untrusted IMAGE this server accepts.
 *
 * Art now travels UP as a PNG (34× fewer bytes than one hex string per pixel), which means a
 * client hands the server a file to decode. `artStore.ts` has warned about that path since
 * before it existed: "an image decoder is a fine place to hide a decompression bomb." So the
 * property under test is not "does a good sheet load" but the ORDER of the refusals — each
 * bound has to hold before the next step could be expensive, and the decisive one is that the
 * output size is known from the 25-byte header, so a tiny file claiming 30000×30000 never
 * reaches pngjs at all.
 *
 * The bomb here is real, not a mock: a valid signature and IHDR that declare 30000×30000
 * followed by 40 bytes of nothing. Decoding it would ask for 3.6 GB.
 */
import { strict as assert } from 'node:assert';
import test from 'node:test';

import { PNG } from 'pngjs';

import { MAX_SHEET_CELLS } from '@pixel/shared/office/sprites/characterSpec.js';

import { MAX_SHEET_PNG_BYTES, readPngHeader, sheetFromPng } from './art/sheetPng.js';

const CHAR = { w: 16, h: 32 };

/** A real sheet: `frames × 4` cells of `w × h`, one opaque pixel per frame so rows are present. */
function sheetPng(frames: number, w = CHAR.w, h = CHAR.h, rows = 4): Buffer {
  const png = new PNG({ width: frames * w, height: rows * h });
  png.data.fill(0);
  for (let r = 0; r < rows; r++) {
    for (let f = 0; f < frames; f++) {
      const i = ((r * h) * png.width + f * w) * 4;
      png.data[i] = 200;
      png.data[i + 1] = 100;
      png.data[i + 2] = 50;
      png.data[i + 3] = 255;
    }
  }
  return PNG.sync.write(png, { filterType: 0 });
}

/** A PNG header claiming `w × h`, with nothing behind it — the decompression bomb. */
function bomb(w: number, h: number): Buffer {
  const b = Buffer.alloc(73);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0);
  b.writeUInt32BE(13, 8); // IHDR length
  b.write('IHDR', 12, 'latin1');
  b.writeUInt32BE(w, 16);
  b.writeUInt32BE(h, 20);
  b[24] = 8; // bit depth
  b[25] = 6; // RGBA
  return b;
}

test('a real sheet decodes into its four direction rows', () => {
  const out = sheetFromPng(sheetPng(7), CHAR);
  assert.equal(out.ok, true, out.ok ? '' : out.reason);
  if (!out.ok) return;
  assert.deepEqual(Object.keys(out.rows).sort(), ['down', 'left', 'right', 'up']);
  assert.equal(out.rows.down.length, 7, 'seven frames per row, derived from the width');
  assert.equal(out.rows.down[0].length, CHAR.h);
  assert.equal(out.rows.down[0][0].length, CHAR.w);
});

test('a three-row sheet keeps three rows — the fourth is not invented here', () => {
  const out = sheetFromPng(sheetPng(7, CHAR.w, CHAR.h, 3), CHAR);
  assert.equal(out.ok, true);
  if (!out.ok) return;
  assert.deepEqual(Object.keys(out.rows).sort(), ['down', 'right', 'up']);
});

test('a bomb is refused from its header, without decoding', () => {
  // 30000×30000 is 3.6 GB of RGBA. The file is 73 bytes, so nothing but the header check can
  // possibly stop it — and it must, or the decoder allocates.
  const out = sheetFromPng(bomb(30000, 30000), CHAR);
  assert.equal(out.ok, false);
  if (out.ok) return;
  assert.match(out.reason, /over \d+ pixels/, `expected a size refusal, got: ${out.reason}`);

  // Just over the cell cap is refused too, so the bound is the same one the SpriteData path
  // uses rather than a separate opinion.
  const overW = Math.ceil((MAX_SHEET_CELLS + 1) / (4 * CHAR.h)) * CHAR.w;
  assert.equal(sheetFromPng(bomb(overW, 4 * CHAR.h), CHAR).ok, false);
});

test('the refusals come in order, cheapest first', () => {
  const reason = (input: unknown, frame = CHAR): string => {
    const out = sheetFromPng(input, frame);
    return out.ok ? '(accepted)' : out.reason;
  };
  assert.equal(reason(null), 'not bytes');
  assert.equal(reason('a string'), 'not bytes');
  assert.equal(reason(Buffer.alloc(MAX_SHEET_PNG_BYTES + 1)), `over ${MAX_SHEET_PNG_BYTES} bytes`);
  assert.equal(reason(Buffer.from('this is not a PNG, it is a sentence long enough to pass the length check')), 'not a PNG');
  // A JPEG is a file a user could plausibly pick; it must not reach the PNG decoder.
  const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(60)]);
  assert.equal(reason(jpeg), 'not a PNG');
  // 16-bit and interlaced are refused: neither is anything a browser canvas produces, and both
  // widen what the decoder has to do.
  const deep = bomb(64, 128);
  deep[24] = 16;
  assert.equal(reason(deep), 'bit depth 16');
  const laced = bomb(64, 128);
  laced[28] = 1;
  assert.equal(reason(laced), 'interlaced');
});

test('a sheet whose size is not a whole number of cells is refused, not cropped', () => {
  // The decoder floors, so this used to mean a silently dropped partial frame or a row read
  // from outside the image — art that comes back subtly wrong rather than not at all.
  assert.match((sheetFromPng(bomb(100, 128), CHAR) as { reason: string }).reason, /not a whole number/);
  assert.match((sheetFromPng(bomb(112, 100), CHAR) as { reason: string }).reason, /not a whole number/);
  // More rows than there are directions, and more frames than a track may hold.
  assert.match((sheetFromPng(bomb(112, 5 * 32), CHAR) as { reason: string }).reason, /direction rows/);
  assert.match((sheetFromPng(bomb(65 * 16, 128), CHAR) as { reason: string }).reason, /frames per row/);
});

test('a frame size outside the bounds is refused before the image is looked at', () => {
  for (const frame of [{ w: 0, h: 32 }, { w: 16, h: 0 }, { w: 65, h: 32 }, { w: 16, h: 65 }]) {
    const out = sheetFromPng(sheetPng(7), frame);
    assert.equal(out.ok, false, `frame ${frame.w}×${frame.h} must be refused`);
  }
});

test('the header reader is exact about what it will parse', () => {
  const png = sheetPng(2);
  const head = readPngHeader(png);
  assert.ok(head);
  assert.deepEqual(
    { w: head.width, h: head.height, bits: head.bitDepth, interlace: head.interlace },
    { w: 32, h: 128, bits: 8, interlace: 0 },
  );
  assert.equal(readPngHeader(Buffer.alloc(10)), null, 'too short to hold a header');
  const noIhdr = Buffer.from(png);
  noIhdr.write('IDAT', 12, 'latin1');
  assert.equal(readPngHeader(noIhdr), null, 'a first chunk that is not IHDR is not a PNG we read');
});

test('a truncated but well-declared PNG fails in the decoder, and says so', () => {
  // Header fine, dimensions fine, body missing: the last line of defence, and it must be a
  // refusal rather than a throw that takes the message handler down.
  const png = sheetPng(7);
  const cut = png.subarray(0, 40);
  const out = sheetFromPng(cut, CHAR);
  assert.equal(out.ok, false);
  if (!out.ok) assert.match(out.reason, /undecodable/);
});
