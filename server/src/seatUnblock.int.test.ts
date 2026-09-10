/**
 * Unblocking a tile puts back what was there — including nothing.
 *
 * `withOwnSeatUnblocked` deleted a character's seat tile from `blockedTiles` so a path could reach
 * it, then re-added it UNCONDITIONALLY. For a seat that was not blocked in the first place that is
 * not a restore, it is an insertion: the tile becomes blocked, and it stays blocked for the life of
 * the zone, because `blockedTiles` is rebuilt only when a layout is set. Nothing else ever removes
 * a key from it.
 *
 * It was invisible because seat tiles normally ARE blocked — measured across all twelve sittable
 * pieces in the catalog, every one of them puts its seat on a blocked tile. What produces the other
 * case is a per-placement `canWalkOver` override, which a mapper can set on any of them, and that
 * is what this fixture uses rather than reaching in and deleting a key: the bug needs a seat that
 * is genuinely walkable, and asserting against a hand-made state would only test my belief that
 * such a seat can exist.
 *
 * So the helper delegates to `withTileUnblocked`, which remembers whether the key `had` been there
 * and restores through `finally` — the second half mattering because a throw inside the callback
 * would otherwise leave a real seat permanently walkable.
 *
 * TEST BOUNDARIES:
 *   @real-dependency: OfficeState + the real furniture catalog -- Mock? NO. Whether a placement's
 *       seat tile ends up in `blockedTiles` is a fact about the catalog, `resolveCanWalkOver` and
 *       `computeBlockedTiles`; that is the premise of the whole test, so it has to be real.
 */
import { strict as assert } from 'node:assert';
import test, { before } from 'node:test';

import { OfficeState } from '@pixel/shared/office/engine/officeState.js';
import { buildDynamicCatalog, getCatalogEntry } from '@pixel/shared/office/layout/furnitureCatalog';
import { TILE_SIZE, type Character } from '@pixel/shared/office/types';

import { buildFurnitureCatalogAndSprites } from './assets.js';

before(async () => {
  buildDynamicCatalog((await buildFurnitureCatalogAndSprites()) as never);
});

type Inner = {
  blockedTiles: Set<string>;
  points: Map<string, { posture: string; col: number; row: number }>;
  withOwnSeatUnblocked<T>(ch: Character, fn: () => T): T;
  addAgent(id: number, preferredSkin?: string, preferredSeatId?: string): void;
  characters: Map<number, Character>;
};

/** A chair, optionally overridden to be walked over — which is what unblocks its seat tile. */
function world(canWalkOver: boolean): Inner {
  const entry = getCatalogEntry('WOODEN_CHAIR_BACK');
  assert.ok(entry, 'WOODEN_CHAIR_BACK is not in the catalog');
  const os = new OfficeState({
    cols: 16,
    rows: 16,
    tiles: new Array(16 * 16).fill(1),
    walls: { horizontal: [], vertical: [] },
    furniture: [
      {
        uid: 'chair',
        id: 'WOODEN_CHAIR_BACK',
        col: 6,
        row: 6,
        x: 6 * TILE_SIZE,
        y: 6 * TILE_SIZE,
        width: entry.width,
        height: entry.height,
        ...(canWalkOver ? { canWalkOver: true } : {}),
      },
    ],
  } as never);
  return os as unknown as Inner;
}

/** An agent whose home point is the chair's seat. */
function seated(os: Inner): { ch: Character; key: string } {
  const seat = [...os.points.entries()].find(([, p]) => p.posture === 'sit');
  assert.ok(seat, 'the chair yielded no seat');
  os.addAgent(1, 'char_0');
  const ch = os.characters.get(1);
  assert.ok(ch, 'the agent was not added');
  ch.homePointId = seat[0];
  return { ch, key: `${seat[1].col},${seat[1].row}` };
}

test('a seat that was never blocked does not become blocked', () => {
  const os = world(true);
  const { ch, key } = seated(os);
  assert.equal(os.blockedTiles.has(key), false, 'the fixture no longer produces a walkable seat — this test proves nothing');

  const before = [...os.blockedTiles].sort();
  os.withOwnSeatUnblocked(ch, () => undefined);
  assert.equal(os.blockedTiles.has(key), false, 'the seat tile was blocked by the very code meant to unblock it — permanently');
  assert.deepEqual([...os.blockedTiles].sort(), before);
});

test('a seat that was blocked is blocked again afterwards', () => {
  const os = world(false);
  const { ch, key } = seated(os);
  assert.equal(os.blockedTiles.has(key), true, 'the fixture no longer produces a blocked seat');

  const before = [...os.blockedTiles].sort();
  const seen = os.withOwnSeatUnblocked(ch, () => os.blockedTiles.has(key));
  assert.equal(seen, false, 'the callback must run with the seat unblocked, or a path can never reach it');
  assert.deepEqual([...os.blockedTiles].sort(), before, 'the restore is what every caller depends on');
});

test('a throw does not leave the seat unblocked', () => {
  // Without the `finally` a caller that throws leaves a real seat walkable for the life of the
  // zone, which is the same class of bug in the other direction.
  const os = world(false);
  const { ch, key } = seated(os);
  assert.throws(() =>
    os.withOwnSeatUnblocked(ch, () => {
      throw new Error('boom');
    }),
  );
  assert.equal(os.blockedTiles.has(key), true, 'the seat stayed unblocked after a throw');
});
