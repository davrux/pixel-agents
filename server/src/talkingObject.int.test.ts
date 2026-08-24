/**
 * Talking objects — the furniture that says the hour by itself.
 *
 * ============================================================================
 * SCOPE. Three separate things have to be true for the talking whale to say
 * `Es ist 9:00 UHR`, and each fails differently:
 *
 *   1. the ART is in a furniture tileset and carries the action, or a mapper
 *      cannot place a talking object at all (the same check the time clock
 *      gets, for the same reason: a tile that says the wrong size renders
 *      stretched, and a tile with no action is scenery);
 *   2. the CLOCK turns exactly once per hour and says the hour it turned to —
 *      the part nobody can watch, since the boundary comes once an hour and a
 *      test that waited for one would not be written. `update` takes the wall
 *      clock as a parameter precisely so this is a millisecond;
 *   3. the object is NOT walked up to. A talking object is the first action
 *      that fires without a player, so the click path has to leave it alone
 *      while still picking up every other kind — tested with a positive
 *      control beside it, or "returns false" would pass for a piece that is
 *      simply unreachable.
 *   4. the QUOTES: the pool the repo ships parses, every line of it fits the
 *      bubble, and the wait between two quotes really is 20-to-60 minutes.
 *      Nobody can watch that either — and it is the one part where "it seemed
 *      to work when I looked" is worthless, because a bug would be a quote
 *      thirty seconds or six hours later, both of which look like silence.
 *
 * NOT covered (honest absence): the bubble itself, which is DOM in
 * OfficeScene, and the broadcast, which is one `this.broadcast` line in
 * SimRoom.handleSpokenLines — both verified by looking at the running client.
 * ============================================================================
 */
import { strict as assert } from 'node:assert';
import test from 'node:test';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { PNG } from 'pngjs';

import { OfficeState } from '@pixel/shared/office/engine/index.js';
import {
  announceDue,
  hourStamp,
  hourText,
  speakerName,
  type SpokenLine,
  pickQuote,
  QuoteSchedule,
  quoteDelayMs,
  QUOTE_MAX_MS,
  QUOTE_MIN_MS,
} from '@pixel/shared/office/engine/talkingObjects.js';
import { buildDynamicCatalog, isClickAction } from '@pixel/shared/office/layout/furnitureCatalog.js';
import { emptyZoneMap } from '@pixel/shared/office/layout/layoutSerializer.js';
import type { OfficeLayout, PlacedFurniture } from '@pixel/shared/office/types.js';

import { parseFurnitureTileset, type TiledTilesetJson } from './core/assets/tiledFurniture.js';
import { MAX_QUOTE_LEN, parseQuotes, QUOTES_REL } from './quotes.js';
import { isFurnitureTileset } from './tiled/tiledRegistry.js';

const REPO_ROOT = new URL('../..', import.meta.url).pathname;
const TILED_DIR = path.join(REPO_ROOT, 'assets', 'tiled');

/** The TALKING_WHALE entry, found the way the loader finds it: by walking every
 *  furniture tileset, not by naming the file it happens to live in. */
function whale(): { asset: ReturnType<typeof parseFurnitureTileset>[number]['asset']; imagePath: string } {
  for (const file of fs.readdirSync(TILED_DIR).filter((f) => f.endsWith('.tsj'))) {
    const json = JSON.parse(fs.readFileSync(path.join(TILED_DIR, file), 'utf-8')) as TiledTilesetJson;
    if (!isFurnitureTileset(json)) continue;
    const found = parseFurnitureTileset(json).find((e) => e.asset.id === 'TALKING_WHALE');
    if (found) return found;
  }
  throw new Error('TALKING_WHALE is in no furniture tileset — there is nothing a mapper could place');
}

// ── 1. the art ──────────────────────────────────────────────────────────────

test('the whale carries the talkingObject action, so placing it is all a mapper does', () => {
  const { asset } = whale();
  assert.deepEqual(asset.action, { kind: 'talkingObject' });
  assert.equal(asset.label, 'Talking Whale');
  // The whale itself is the top two rows — air you walk behind — and only the
  // plinth's row blocks.
  assert.equal(asset.backgroundTiles, 2);
});

test('the whale declares the dimensions its PNG actually has', () => {
  // Drift here is the classic asset bug: the tileset says one size, the pixels
  // are another, and the thing renders stretched or clipped — and for furniture
  // the size is also the footprint, so it would block the wrong cells too.
  const { asset, imagePath } = whale();
  const png = PNG.sync.read(fs.readFileSync(path.join(TILED_DIR, imagePath)));
  assert.equal(png.width, asset.width, 'PNG width must equal the declared width');
  assert.equal(png.height, asset.height, 'PNG height must equal the declared height');
  assert.equal(asset.footprintW, 3);
  assert.equal(asset.footprintH, 3);
  assert.equal(asset.footprintW * 16, asset.width);
  assert.equal(asset.footprintH * 16, asset.height);
  let painted = 0;
  for (let i = 3; i < png.data.length; i += 4) if (png.data[i] > 0) painted++;
  assert.ok(painted > 500, `expected a drawn sprite, got ${painted} painted pixels`);
});

// ── 2. the clock ────────────────────────────────────────────────────────────

/** A local-time moment, so the assertions below read as the wall clock the
 *  server would show — the announcement is deliberately in the server's own
 *  zone (see hourText), which means UTC is the wrong thing to build these from. */
const at = (h: number, m = 0, s = 0): number => new Date(2026, 7, 21, h, m, s).getTime();

test('the hour is spoken in German, 24-hour, no leading zero', () => {
  assert.equal(hourText(at(9, 0)), 'Es ist 9:00 UHR');
  assert.equal(hourText(at(9, 59, 59)), 'Es ist 9:00 UHR', 'still the ninth hour at 9:59:59');
  assert.equal(hourText(at(14, 30)), 'Es ist 14:00 UHR');
  assert.equal(hourText(at(0, 5)), 'Es ist 0:00 UHR');
  // 21:00, never a second 9:00 — a statue has no am/pm to show, so the one
  // thing this must not be is ambiguous.
  assert.equal(hourText(at(21, 0)), 'Es ist 21:00 UHR');
  // One wording, for everybody: the line is a broadcast, so there is nothing
  // here that could vary per viewer (see hourText).
  assert.ok(hourText(at(7, 0)).startsWith('Es ist '));
  assert.ok(hourText(at(7, 0)).endsWith(' UHR'));
});

test('every moment inside one hour has one stamp, and the next hour has another', () => {
  assert.equal(hourStamp(at(9, 0, 0)), hourStamp(at(9, 59, 59)));
  assert.notEqual(hourStamp(at(9, 59, 59)), hourStamp(at(10, 0, 0)));
  assert.equal(hourStamp(at(9, 30)), at(9, 0, 0), 'the stamp IS the moment the hour began');
});

test('the first tick adopts the hour instead of announcing it', () => {
  // Arriving at 9:05 is not being present at 9:00, and a bubble saying it is
  // 9:00 five minutes late is not late, it is wrong.
  const first = announceDue(at(9, 5), null);
  assert.equal(first.due, false);
  assert.equal(first.stamp, at(9, 0, 0));
  // …and the hour that follows is announced normally.
  assert.equal(announceDue(at(10, 0, 1), first.stamp).due, true);
});

test('the hour is announced on the boundary and not again inside it', () => {
  let stamp: number | null = null;
  const fired: string[] = [];
  for (const t of [at(8, 59, 58), at(8, 59, 59), at(9, 0, 0), at(9, 0, 1), at(9, 30), at(10, 0, 0)]) {
    const { due, stamp: next } = announceDue(t, stamp);
    stamp = next;
    if (due) fired.push(hourText(t));
  }
  assert.deepEqual(fired, ['Es ist 9:00 UHR', 'Es ist 10:00 UHR']);
});

// ── 3. the engine, driven headlessly ────────────────────────────────────────

const COLS = 20;
const ROWS = 12;

/** A 1x1 placement carrying its action as a per-placement override — which is
 *  also the thing being checked: any piece of furniture can be made to talk,
 *  the whale is just the one drawn for it. */
function piece(uid: string, col: number, row: number, action: PlacedFurniture['action']): PlacedFurniture {
  return { uid, id: `TEST_${uid}`, col, row, action } as PlacedFurniture;
}

/** The line a test piece is expected to say. `from` is asserted rather than
 *  ignored because it is what the chat log shows — and for these placements it
 *  is the fallback: `piece` invents an id no catalog carries, so there is no
 *  label to read (see speakerName). */
const said = (col: number, row: number, text: string, from = 'Talking object'): SpokenLine => ({ col, row, text, from });

function world(furniture: PlacedFurniture[]): OfficeState {
  const layout: OfficeLayout = { ...emptyZoneMap(COLS, ROWS), furniture };
  return new OfficeState(layout);
}

test('a talking object says the hour, once, when the hour turns', () => {
  const os = world([piece('whale', 5, 5, { kind: 'talkingObject' })]);

  os.update(0.05, at(8, 59, 59));
  assert.deepEqual(os.takeSpokenLines(), [], 'the first tick adopts the hour, it does not announce it');

  os.update(0.05, at(9, 0, 0));
  assert.deepEqual(os.takeSpokenLines(), [said(5, 5, 'Es ist 9:00 UHR')]);

  // The rest of the hour is silent — 20 ticks a second for an hour would
  // otherwise be 72 000 bubbles.
  for (const t of [at(9, 0, 1), at(9, 15), at(9, 59, 59)]) os.update(0.05, t);
  assert.deepEqual(os.takeSpokenLines(), []);

  os.update(0.05, at(10, 0, 0));
  assert.deepEqual(os.takeSpokenLines(), [said(5, 5, 'Es ist 10:00 UHR')]);
});

test('every talking object in the zone says it, and nothing else says anything', () => {
  const os = world([
    piece('whale', 5, 5, { kind: 'talkingObject' }),
    piece('other', 12, 3, { kind: 'talkingObject' }),
    piece('kiosk', 8, 8, { kind: 'meetingManager' }),
    piece('bin', 2, 2, undefined),
  ]);
  os.update(0.05, at(8, 59, 59));
  os.update(0.05, at(9, 0, 0));
  assert.deepEqual(os.takeSpokenLines(), [
    said(5, 5, 'Es ist 9:00 UHR'),
    said(12, 3, 'Es ist 9:00 UHR'),
  ]);
});

test('reading the lines empties them, so the room cannot broadcast one twice', () => {
  const os = world([piece('whale', 5, 5, { kind: 'talkingObject' })]);
  os.update(0.05, at(8, 59, 59));
  os.update(0.05, at(9, 0, 0));
  assert.equal(os.takeSpokenLines().length, 1);
  assert.deepEqual(os.takeSpokenLines(), [], 'drained by the read');
});

test('a zone with nothing that talks never speaks, whatever the clock does', () => {
  const os = world([piece('kiosk', 8, 8, { kind: 'meetingManager' })]);
  for (const t of [at(8, 59, 59), at(9, 0, 0), at(10, 0, 0), at(11, 0, 0)]) os.update(0.05, t);
  assert.deepEqual(os.takeSpokenLines(), []);
});

// ── 4. clicking it does nothing ─────────────────────────────────────────────

test('a click reaches every action except the two that are not clicks', () => {
  assert.equal(isClickAction({ kind: 'meetingManager' }), true);
  assert.equal(isClickAction({ kind: 'arcade' }), true);
  assert.equal(isClickAction({ kind: 'iframe', url: 'https://example.com' }), true);
  // The appliance has its own approach path; the talking object has no approach
  // at all.
  assert.equal(isClickAction({ kind: 'appliance', pose: 'coffee' }), false);
  assert.equal(isClickAction({ kind: 'talkingObject' }), false);
  assert.equal(isClickAction(null), false);
});

test('walking up to a talking object is refused, while its neighbour still works', () => {
  // The positive control is the point: "returns false" would also be what an
  // unreachable piece of furniture returns, so the same player, in the same
  // world, one tile away, must succeed on a real click action.
  const os = world([
    piece('whale', 5, 5, { kind: 'talkingObject' }),
    piece('kiosk', 8, 5, { kind: 'meetingManager' }),
  ]);
  const id = os.addPlayer('char_0', 'Tester', { col: 6, row: 6 });

  assert.equal(os.walkPlayerToAction(id, 8, 5), true, 'the kiosk beside it is still a click action');
  assert.deepEqual(
    os.takePendingActionArrivals().map((a) => a.action.kind),
    [],
    'not standing at the kiosk yet — it walks there first',
  );

  assert.equal(os.walkPlayerToAction(id, 5, 5), false, 'the whale is not walked up to');
  assert.deepEqual(os.takePendingActionArrivals(), [], 'and nothing fired');
});

// ── 5. the quote pool the repo ships ────────────────────────────────────────

test('the shipped quote pool loads, and every line of it fits the bubble', () => {
  // The file is content, so this is the check that content cannot rot: a quote
  // longer than the bubble is refused at load, which means a well-meant edit
  // would silently make the whale say less than the author wrote.
  const text = fs.readFileSync(path.join(REPO_ROOT, QUOTES_REL), 'utf-8');
  const { quotes, rejected } = parseQuotes(text);
  assert.deepEqual(rejected, [], 'a line the loader would skip is a line nobody will ever hear');
  assert.ok(quotes.length >= 5, `expected a pool worth drawing from, got ${quotes.length}`);
  for (const q of quotes) {
    assert.ok(q.length > 0 && q.length <= MAX_QUOTE_LEN, `${q.length} characters: ${q}`);
    assert.equal(q, q.trim());
    assert.ok(!q.startsWith('#'), 'a comment must not reach the pool');
  }
  assert.equal(new Set(quotes).size, quotes.length, 'the same line twice is an editing accident');
});

test('the format is what the file says it is: comments, blanks, trimming, CRLF', () => {
  const { quotes, rejected } = parseQuotes(
    ['# a comment', '', '  A quote.  ', '\t# an indented comment', 'Another.', '   ', 'Third.'].join('\r\n'),
  );
  assert.deepEqual(quotes, ['A quote.', 'Another.', 'Third.']);
  assert.deepEqual(rejected, []);
  // A BOM in front of the first line would otherwise turn a comment into a quote
  // reading "﻿# a comment".
  assert.deepEqual(parseQuotes('﻿# only a comment\nHello.').quotes, ['Hello.']);
});

test('an over-long quote is refused by line number, not truncated', () => {
  const long = 'x'.repeat(MAX_QUOTE_LEN + 1);
  const { quotes, rejected } = parseQuotes(`Fine.\n${long}\nAlso fine.`);
  assert.deepEqual(quotes, ['Fine.', 'Also fine.']);
  assert.equal(rejected.length, 1);
  assert.equal(rejected[0].line, 2, 'the author has to be able to find it');
  assert.ok(rejected[0].why.includes(String(MAX_QUOTE_LEN)));
  // Exactly at the cap is fine — the bubble truncates ABOVE it.
  assert.equal(parseQuotes('y'.repeat(MAX_QUOTE_LEN)).quotes.length, 1);
});

// ── 6. the interval, and which line comes out ───────────────────────────────

test('every wait is between 20 and 60 minutes, at both ends of the roll', () => {
  assert.equal(QUOTE_MIN_MS, 20 * 60_000);
  assert.equal(QUOTE_MAX_MS, 60 * 60_000);
  assert.equal(quoteDelayMs(0), QUOTE_MIN_MS, 'the shortest possible wait is still 20 minutes');
  assert.equal(quoteDelayMs(1), QUOTE_MAX_MS);
  assert.equal(quoteDelayMs(0.5), 40 * 60_000);
  for (let i = 0; i <= 1000; i++) {
    const d = quoteDelayMs(i / 1000);
    assert.ok(d >= QUOTE_MIN_MS && d <= QUOTE_MAX_MS, `${d} out of range`);
  }
  // A generator that hands out a number outside [0, 1) cannot produce a wait
  // outside the window either — the alternative is a whale that never speaks.
  assert.equal(quoteDelayMs(-1), QUOTE_MIN_MS);
  assert.equal(quoteDelayMs(7), QUOTE_MAX_MS);
});

test('the pick reaches every quote in the pool and never falls off the end', () => {
  const pool = ['one', 'two', 'three'];
  assert.equal(pickQuote(pool, 0), 'one');
  assert.equal(pickQuote(pool, 0.5), 'two');
  assert.equal(pickQuote(pool, 0.99), 'three');
  assert.equal(pickQuote(pool, 1), 'three', 'rnd() === 1 must not index past the pool');
  assert.equal(pickQuote([], 0.4), null, 'nothing to say is not an empty bubble');
  const seen = new Set<string>();
  for (let i = 0; i < 300; i++) seen.add(pickQuote(pool, i / 300)!);
  assert.deepEqual([...seen].sort(), ['one', 'three', 'two'], 'every line is reachable');
});

// ── 7. quotes through the engine, on a pinned clock and a pinned die ────────

const POOL = ['First line.', 'Second line.', 'Third line.'];

/** A die that hands out the numbers a test names, then repeats the last one —
 *  so a test states only the rolls it cares about. */
function scripted(...values: number[]): () => number {
  let i = 0;
  return () => values[Math.min(i++, values.length - 1)];
}

function talkingWorld(pool = POOL, rnd = scripted(0)): { os: OfficeState; uid: string } {
  const os = world([piece('whale', 5, 5, { kind: 'talkingObject' })]);
  os.setQuotes(pool, rnd);
  return { os, uid: 'whale' };
}

test('a quote comes at the end of the wait, not before, and then the wait starts over', () => {
  // rnd 0 = the shortest wait (20 min) and the first line, so every moment
  // below is a stated fact rather than a range.
  const { os } = talkingWorld(POOL, scripted(0));

  os.update(0.05, at(9, 0, 30));
  assert.deepEqual(os.takeSpokenLines(), [], 'the first tick starts the wait; it says nothing');

  os.update(0.05, at(9, 20, 29));
  assert.deepEqual(os.takeSpokenLines(), [], 'one second short of 20 minutes');

  os.update(0.05, at(9, 20, 30));
  assert.deepEqual(os.takeSpokenLines(), [said(5, 5, 'First line.')]);

  os.update(0.05, at(9, 20, 31));
  assert.deepEqual(os.takeSpokenLines(), [], 'and not again on the very next tick');

  os.update(0.05, at(9, 40, 30));
  assert.deepEqual(os.takeSpokenLines(), [said(5, 5, 'First line.')], 'the next wait ran out');
});

test('a whale with no quotes still tells the time, and says nothing else ever', () => {
  const os = world([piece('whale', 5, 5, { kind: 'talkingObject' })]);
  // No setQuotes at all — the pool is empty until the server hands one over,
  // and a missing quotes file is a normal world (see loadQuotes).
  os.update(0.05, at(9, 0, 0));
  for (const t of [at(9, 20), at(9, 40), at(9, 59, 59)]) os.update(0.05, t);
  assert.deepEqual(os.takeSpokenLines(), []);
  os.update(0.05, at(10, 0, 0));
  assert.deepEqual(os.takeSpokenLines(), [said(5, 5, 'Es ist 10:00 UHR')], 'the hour is unaffected');
});

test('the hour wins a tie, and the quote it displaced waits its turn', () => {
  // One bubble per speaker on the client: two lines in one tick would mean the
  // second silently replaces the first, and the hour is the one that is only
  // true for a moment. The wait is 20 min from 9:40:00, i.e. exactly 10:00:00.
  const { os } = talkingWorld(POOL, scripted(0));
  os.update(0.05, at(9, 40, 0));
  assert.deepEqual(os.takeSpokenLines(), []);

  os.update(0.05, at(10, 0, 0));
  assert.deepEqual(os.takeSpokenLines(), [said(5, 5, 'Es ist 10:00 UHR')], 'the hour, alone');

  os.update(0.05, at(10, 0, 1));
  assert.deepEqual(os.takeSpokenLines(), [], 'the displaced quote did not arrive a tick later either');

  os.update(0.05, at(10, 20, 0));
  assert.deepEqual(os.takeSpokenLines(), [said(5, 5, 'First line.')], 'it rolled a fresh wait');
});

test('two talking objects drift apart instead of chanting in unison', () => {
  const os = world([
    piece('a', 5, 5, { kind: 'talkingObject' }),
    piece('b', 12, 3, { kind: 'talkingObject' }),
  ]);
  // Scheduling walks the talkers in map order: the first draws 0 (20 min), the
  // second 1 (60 min). Picking a line consumes a roll too, hence the 0s after.
  os.setQuotes(POOL, scripted(0, 1, 0, 0, 0, 0));
  os.update(0.05, at(9, 0, 0));

  os.update(0.05, at(9, 20, 0));
  assert.deepEqual(os.takeSpokenLines(), [said(5, 5, 'First line.')], 'only the first is due');

  os.update(0.05, at(10, 0, 0));
  const lines = os.takeSpokenLines();
  assert.ok(
    lines.some((l) => l.col === 12 && l.row === 3),
    'the second one speaks an hour in, on its own schedule',
  );
});

test('a whale that leaves the map is forgotten, and a new one starts a fresh wait', () => {
  // The memory rule (AGENTS.md § Memory) with an observable consequence: if the
  // schedule kept the uid, the re-placed whale would be instantly overdue and
  // greet the next tick with a quote it had been holding for hours.
  const { os } = talkingWorld(POOL, scripted(0));
  os.update(0.05, at(9, 0, 0));

  const empty: OfficeLayout = { ...emptyZoneMap(COLS, ROWS), furniture: [] };
  os.rebuildFromLayout(empty);
  os.update(0.05, at(12, 0, 0));
  assert.deepEqual(os.takeSpokenLines(), [], 'nothing left to speak');

  os.rebuildFromLayout({ ...emptyZoneMap(COLS, ROWS), furniture: [piece('whale', 5, 5, { kind: 'talkingObject' })] });
  os.update(0.05, at(12, 0, 1));
  assert.deepEqual(os.takeSpokenLines(), [], 'not overdue: the wait starts now, not in the world it left');
  os.update(0.05, at(12, 20, 1));
  assert.deepEqual(os.takeSpokenLines(), [said(5, 5, 'First line.')]);
});

test('with a real die, the wait is never shorter than 20 minutes and never longer than 60', () => {
  // The bounds hold whatever Math.random does, which is the claim the constants
  // make — and the one thing a scripted die cannot check.
  const s = new QuoteSchedule();
  s.setQuotes(POOL);
  const talkers = [piece('whale', 5, 5, { kind: 'talkingObject' })];
  let t = at(9, 0, 0);
  const gaps: number[] = [];
  for (let n = 0; n < 200; n++) {
    // Step a minute at a time so a fire is attributed to the minute it happened
    // in — the gap is then the interval, rounded down to the minute.
    let waited = 0;
    for (;;) {
      t += 60_000;
      waited += 60_000;
      if (s.chimes(talkers, t, false).length > 0) break;
      assert.ok(waited <= QUOTE_MAX_MS, 'a wait longer than an hour is a whale that went quiet');
    }
    if (n > 0) gaps.push(waited);
  }
  assert.equal(gaps.length, 199);
  for (const g of gaps) {
    assert.ok(g > QUOTE_MIN_MS - 60_001, `${g / 60_000} minutes is under the floor`);
    assert.ok(g <= QUOTE_MAX_MS, `${g / 60_000} minutes is over the ceiling`);
  }
  const spread = new Set(gaps).size;
  assert.ok(spread > 10, `expected a spread of waits, got ${spread} distinct values — is the die stuck?`);
});

// ── 8. who the line is from ─────────────────────────────────────────────────

test('a spoken line is attributed: the placement name first, then the label', () => {
  // Both lines land in the zone chat log as well as in a bubble, and a log entry
  // needs a name. The order is the point: naming an object in Tiled is a mapper
  // saying what THIS one is, so it beats the label the art carries.
  buildDynamicCatalog({
    catalog: [{ id: 'STATUE', label: 'Stone Whale', footprintW: 1, footprintH: 1, width: 16, height: 16 }],
  } as never);
  const at0 = { uid: 'u', col: 0, row: 0 } as PlacedFurniture;
  assert.equal(speakerName({ ...at0, id: 'STATUE' }), 'Stone Whale');
  assert.equal(speakerName({ ...at0, id: 'STATUE', name: '  Wally  ' }), 'Wally', 'trimmed, and it wins');
  // An id no catalog carries has no label to read — a real map cannot produce
  // this (every furniture tile has one), and it must still not say `undefined:`.
  assert.equal(speakerName({ ...at0, id: 'NO_SUCH_ART' }), 'Talking object');
});

test('the hour and the quote are attributed the same way, through the engine', () => {
  buildDynamicCatalog({
    catalog: [{ id: 'TEST_whale', label: 'Talking Whale', footprintW: 1, footprintH: 1, width: 16, height: 16 }],
  } as never);
  const os = world([piece('whale', 5, 5, { kind: 'talkingObject' })]);
  os.setQuotes(POOL, scripted(0));

  os.update(0.05, at(9, 40, 0));
  os.update(0.05, at(10, 0, 0));
  assert.deepEqual(os.takeSpokenLines(), [said(5, 5, 'Es ist 10:00 UHR', 'Talking Whale')]);

  os.update(0.05, at(10, 20, 0));
  assert.deepEqual(os.takeSpokenLines(), [said(5, 5, 'First line.', 'Talking Whale')]);
});
