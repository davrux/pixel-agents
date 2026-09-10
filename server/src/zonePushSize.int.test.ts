/**
 * A pushed map may not be bigger than a zone is allowed to be.
 *
 * `MAX_COLS`/`MAX_ROWS` = 100 is where "a zone stays at most about twice a screen" is written as a
 * number — 10 000 cells against the ~4350 tiles a 1400×813 canvas shows at minimum zoom. It was
 * applied to zone CREATION only (`ZoneStore.clampSize`), while a pushed `.tmj` took its size
 * straight from the file and the only limit was 32 MB of JSON. So the one path a real map arrives
 * by was the one path with no size limit on it, and the decision was a decision the code did not
 * hold anyone to.
 *
 * Why that matters beyond tidiness: nothing downstream scales sublinearly with area. The client
 * builds one GameObject per ground cell with no viewport culling anywhere (~3700 live for uponu),
 * and `layoutLoaded` is a per-JOIN payload of ~78 B/cell (245 KB for uponu, of which `walls` is
 * 46 %). A 300×300 push would be accepted, stored, and then served to every client that joins.
 *
 * The guard is a pure function on purpose, so most of this is about the RULE and not about
 * express. The last test drives the real route, because "the rule is right" and "the route asks
 * it, before the import" are two different claims and only the second one keeps an oversized map
 * from being parsed into a layout and stored.
 *
 * TEST BOUNDARIES:
 *   @real-dependency: MAX_COLS/MAX_ROWS from shared constants -- Mock? NO. The claim is that the
 *       push honours the same numbers a zone is created with; hardcoding 100 here would keep
 *       passing after somebody changed them.
 */
import { strict as assert } from 'node:assert';
import { mkdtempSync } from 'node:fs';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { after, before } from 'node:test';

import { MAX_COLS, MAX_ROWS } from '@pixel/shared/office/constants.js';

import { mapSizeRefusal } from './tiled/zonePushApi.js';

const ADMIN_TOKEN = 'push-size-test-token';
let server: Server;
let base: string;

before(async () => {
  process.env.PIXEL_STREAM_DATA_DIR = mkdtempSync(join(tmpdir(), 'pixel-pushsize-test-'));
  const express = (await import('express')).default;
  const { registerZonePushApi } = await import('./tiled/zonePushApi.js');
  const app = express();
  registerZonePushApi(app, ADMIN_TOKEN, process.cwd() + '/..');
  server = app.listen(0);
  await new Promise<void>((resolve) => server.once('listening', () => resolve()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(() => server?.close());

const push = async (tmj: unknown): Promise<{ status: number; error?: string }> => {
  const res = await fetch(`${base}/tiled/zone`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-pixel-admin-token': ADMIN_TOKEN },
    body: JSON.stringify({ zoneId: 'sizetest', tmj }),
  });
  return { status: res.status, ...((await res.json()) as { error?: string }) };
};

test('a map within the cap is accepted, including one exactly at it', () => {
  assert.equal(mapSizeRefusal({ width: 56, height: 57 }), null, 'uponu itself must be pushable');
  assert.equal(mapSizeRefusal({ width: MAX_COLS, height: MAX_ROWS }), null, 'the cap is inclusive');
  assert.equal(mapSizeRefusal({ width: 1, height: 1 }), null);
});

test('a map over the cap is refused in either dimension, and the reason says what to do', () => {
  const wide = mapSizeRefusal({ width: MAX_COLS + 1, height: 10 });
  assert.ok(wide, 'one column over the cap was accepted');
  assert.match(wide, new RegExp(`${MAX_COLS + 1}×10`), 'the refusal does not name the size that was pushed');
  assert.match(wide, /portal/i, 'the refusal does not say the map should be split into zones');

  assert.ok(mapSizeRefusal({ width: 10, height: MAX_ROWS + 1 }), 'height is not checked');
  assert.ok(mapSizeRefusal({ width: 300, height: 300 }), 'a map nine times the cap was accepted');
});

test('a size that is not a whole number of tiles is refused, not coerced', () => {
  // `importTmjToLayout` does `Number(tmj.width)` and builds arrays from it, so a missing or
  // fractional size must not get that far — and a clamp is the wrong answer to "what did you mean".
  for (const size of [
    { width: undefined, height: 10 },
    { width: 10, height: null },
    { width: 'lots', height: 10 },
    { width: 0, height: 10 },
    { width: -5, height: 10 },
    { width: 56.5, height: 10 },
  ]) {
    assert.ok(mapSizeRefusal(size), `accepted ${JSON.stringify(size)}`);
  }
});

test('the route refuses an oversized map before it imports anything', async () => {
  // 300x300 with nothing else in it: if the size gate is missing this gets as far as the importer,
  // and the error then comes from the layers rather than from the size.
  const big = await push({ width: 300, height: 300, tilewidth: 16, tileheight: 16, layers: [], tilesets: [] });
  assert.equal(big.status, 400);
  assert.equal(big.error, mapSizeRefusal({ width: 300, height: 300 }), 'the route answered with something other than the size refusal');

  // And the gate is not a blanket refusal: a legal size gets past it and fails, if at all, on the
  // map's own content.
  const small = await push({ width: 20, height: 20, tilewidth: 16, tileheight: 16, layers: [], tilesets: [] });
  assert.notEqual(small.error, mapSizeRefusal({ width: 300, height: 300 }));
  assert.ok(
    small.status === 200 || !/tiles, over the/.test(small.error ?? ''),
    `a 20x20 map was refused for its size: ${small.error}`,
  );
});
