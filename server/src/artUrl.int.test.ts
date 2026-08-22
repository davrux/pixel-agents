/**
 * What an art URL's `v` — and the route's ETag, which is the same hash — must and must not
 * react to.
 *
 * The hash is the whole cache contract: a URL carrying it is served `immutable` for a year
 * (`artApi.ts`), so a hash that MISSES a change pins stale art in every browser until the
 * cache is cleared by hand, and one that changes for no reason re-downloads the roster for
 * nothing. The second half is not hypothetical — the hash covered the entry as it stood, so
 * giving the bundled skins and pets names changed every art URL while the images were
 * byte-identical.
 *
 * So both directions are pinned, because only one of them is visible when it breaks: art that
 * changed always LOOKS wrong eventually, while art that re-downloaded looks like nothing at
 * all. The reference for "does the image change" is `encodeDirectionalSheet`'s inputs — the
 * direction rows and the frame size it lays them out with, nothing else in the entry.
 */
import { strict as assert } from 'node:assert';
import test from 'node:test';

import { artHash, artUrl } from './art/artUrl.js';

/** A minimal entry in the shape the bundle holds: rows of frames of rows of hex. */
const entry = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  down: [[['#111111', '']]],
  up: [[['#222222', '']]],
  right: [[['#333333', '']]],
  left: [[['#444444', '']]],
  spec: { frame: { w: 16, h: 32 } },
  name: 'Nora',
  ...over,
});

test('a label is not art — renaming an entry keeps its URL', () => {
  const before = artUrl('character', 'char_0', entry());
  const after = artUrl('character', 'char_0', entry({ name: 'Ida' }));
  assert.equal(after, before, 'a rename must not invalidate a year-long immutable cache entry');
  // Same for anything else that never reaches the encoder.
  assert.equal(artUrl('character', 'char_0', entry({ npc: { wander: true } })), before);
});

test('changed pixels change the hash, in every direction row', () => {
  const base = artHash(entry());
  for (const row of ['down', 'up', 'right', 'left']) {
    assert.notEqual(
      artHash(entry({ [row]: [[['#ff0000', '']]] })),
      base,
      `a changed ${row} row must change the hash — it is a different image`,
    );
  }
  // A row that goes away is a different image too: rowsPresent then serves fewer rows.
  assert.notEqual(artHash(entry({ left: undefined })), base);
});

test('the same pixels at a different frame size are a different image', () => {
  // encodeDirectionalSheet is handed frameW/frameH, so the sheet's geometry comes from the
  // spec. Hashing the rows alone would serve a 23×32 character out of a 16×32 cache entry.
  assert.notEqual(artHash(entry({ spec: { frame: { w: 23, h: 32 } } })), artHash(entry()));
  assert.notEqual(artHash(entry({ spec: undefined })), artHash(entry()));
});

test('an entry with nothing to serve gets no URL, and the id is escaped', () => {
  assert.equal(artUrl('character', 'char_0', null), null);
  assert.equal(artUrl('pet', 'dog_0', undefined), null);
  // Ids reach the URL: a player avatar is `pa:<user>`, and a user id must not be able to
  // add a path segment or a query of its own.
  const url = artUrl('character', 'pa:a/b?c', entry());
  assert.ok(url?.startsWith('/art/character/pa%3Aa%2Fb%3Fc?v='), `unescaped id in ${url}`);
  assert.equal(url?.match(/\?/g)?.length, 1, 'only the v query may be there');
});

test('the hash is stable across calls and short enough for a URL', () => {
  assert.equal(artHash(entry()), artHash(entry()), 'same input, same hash');
  assert.match(artHash(entry()), /^[0-9a-f]{12}$/);
});
