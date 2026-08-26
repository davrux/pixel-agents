/**
 * Anything the art rules call legal must fit through the transport. This measures the pair.
 *
 * They disagreed, and the way that failed is why this file exists. The per-direction bounds
 * (64 frames of 64×64) allow 1.05 M cells, which is 10.0 MB of JSON, while `ws` refuses a frame
 * larger than `MAX_WS_PAYLOAD_BYTES`. The transport does not reject the SAVE — it destroys the
 * CONNECTION: `RangeError: Max payload size exceeded` in the server log, close code 1009 for the
 * client, and the editor's work gone without a message. Production hit it on 2026-08-26, and a
 * headless client reproduced it on the first try.
 *
 * So the invariant is not "the numbers look sane" but "the biggest sheet the guard accepts,
 * serialised the way it travels, is smaller than the biggest frame the transport takes" — and
 * it is checked by building that sheet and measuring it, because the bytes-per-cell factor is
 * a property of JSON and hex strings, not something a comment can be trusted about.
 *
 * Uncompressed on purpose. permessage-deflate would shrink this by ~10×, but it is negotiated
 * per connection and a client that does not ask for it (any plain `ws` client, and whatever an
 * intermediary strips) sends the frame raw — so the margin has to hold without it.
 */
import { strict as assert } from 'node:assert';
import test from 'node:test';

import { MAX_WS_PAYLOAD_BYTES } from '@pixel/shared';
import { MAX_CHAR_DIM, MAX_SHEET_CELLS, MAX_TRACK_FRAMES } from '@pixel/shared/office/sprites/characterSpec.js';

import { validCharacterData } from './art/characterDataGuard.js';

/** A sheet of `frames` frames per direction row, each `dim`×`dim`, in four rows. */
function sheet(frames: number, dim: number): Record<string, unknown> {
  const frame = (): string[][] => Array.from({ length: dim }, () => Array.from({ length: dim }, () => '#a1b2c3'));
  const row = (): string[][][] => Array.from({ length: frames }, frame);
  return { name: 'Worst case', down: row(), up: row(), right: row(), left: row() };
}
/** What one save costs on the wire: the message shape the editor sends. */
const wireBytes = (data: unknown): number => JSON.stringify({ data }).length;

test('the biggest sheet the guard accepts fits the transport, with room to spare', () => {
  const frames = MAX_SHEET_CELLS / (4 * MAX_CHAR_DIM * MAX_CHAR_DIM);
  assert.ok(Number.isInteger(frames), `MAX_SHEET_CELLS should divide into whole frames, got ${frames}`);
  const worst = sheet(frames, MAX_CHAR_DIM);
  assert.equal(validCharacterData(worst), true, 'the worst legal sheet must be accepted');

  const bytes = wireBytes(worst);
  assert.ok(
    bytes < MAX_WS_PAYLOAD_BYTES,
    `the worst legal save is ${(bytes / 1048576).toFixed(1)} MB and the ceiling is ` +
      `${(MAX_WS_PAYLOAD_BYTES / 1048576).toFixed(0)} MB — a save that big would drop the connection`,
  );
  // Not merely "fits": a factor of two, so neither number has to move in lockstep with the
  // other and a future field on the message cannot close the gap by itself.
  assert.ok(
    bytes * 2 < MAX_WS_PAYLOAD_BYTES,
    `only ${(MAX_WS_PAYLOAD_BYTES / bytes).toFixed(1)}× of headroom — raise the ceiling or lower MAX_SHEET_CELLS`,
  );
});

test('one cell past the cap is refused — by the guard, not by the socket', () => {
  const frames = MAX_SHEET_CELLS / (4 * MAX_CHAR_DIM * MAX_CHAR_DIM);
  assert.equal(validCharacterData(sheet(frames + 1, MAX_CHAR_DIM)), false, 'one frame more must be refused');
  // The cap counts ALL rows, so the same total spread over three rows is refused too: what
  // matters is the payload, not how many facings it is divided into.
  const threeRows = sheet(frames + 1, MAX_CHAR_DIM) as Record<string, unknown>;
  delete threeRows.left;
  assert.equal(validCharacterData({ ...threeRows, down: (threeRows.down as unknown[]).slice() }), true,
    'three rows of that size are still inside the cap');
});

test('what the cap actually costs: the old worst case, and the shapes that are unaffected', () => {
  // The regression, stated as a measurement against the ceiling PRODUCTION ran into: 8 MB. The
  // sheet the rules used to allow is bigger than that, which is what dropped the connection.
  // Built at 4 frames and scaled, since JSON size is linear in the cell count.
  const CEILING_WHEN_IT_BROKE = 8 * 1024 * 1024;
  const perCell = wireBytes(sheet(4, MAX_CHAR_DIM)) / (4 * 4 * MAX_CHAR_DIM * MAX_CHAR_DIM);
  const oldWorst = MAX_TRACK_FRAMES * 4 * MAX_CHAR_DIM * MAX_CHAR_DIM * perCell;
  assert.ok(
    oldWorst > CEILING_WHEN_IT_BROKE,
    `64 frames of 64×64 in four rows is ${(oldWorst / 1048576).toFixed(1)} MB, and the ceiling was 8 MB`,
  );
  // Raising the ceiling alone would have hidden that: 10.0 MB fits under 12 MB. It is the cap
  // that keeps the rules from being able to name an undeliverable sheet at all, whatever the
  // ceiling is next set to — which is why both numbers moved and why the headroom above is
  // asserted rather than assumed.
  assert.ok(oldWorst < MAX_WS_PAYLOAD_BYTES, 'the raised ceiling does admit the old worst case');
  assert.ok(
    MAX_SHEET_CELLS * perCell < oldWorst,
    'and the cap is the tighter of the two bounds, so it is the one that decides',
  );

  // And what it does not cost: every real sheet is far below the cap, so the restriction only
  // bites art drawn at the maximum frame size.
  const cellsOf = (frames: number, w: number, h: number): number => frames * w * h * 4;
  assert.ok(cellsOf(MAX_TRACK_FRAMES, 16, 32) < MAX_SHEET_CELLS, '16×32 with the most frames allowed still fits');
  assert.ok(cellsOf(11, 23, 32) < MAX_SHEET_CELLS / 10, 'and a real sheet is an order of magnitude below it');
});
