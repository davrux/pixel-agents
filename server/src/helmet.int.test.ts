/**
 * Helmets: what a driver looks like from above, and who decides.
 *
 * A kart is a true overhead view and a character sprite faces the camera, so sitting one in the
 * other showed a standing figure from the front inside a vehicle seen from above. Redrawing every
 * skin from above is not available (skins are drawn by whoever owns them, including in the editor)
 * and giving the kart discrete headings would undo the smooth steering. A helmet is the third
 * answer: it IS the top of a head, correct from above by construction and the same for every skin
 * ever drawn.
 *
 * What is pinned here is the part that can go wrong quietly: it is a value arriving from a client
 * that everybody else then sees, so it is checked against the table on the way in AND on the way
 * out, and it lives on the pawn only while its owner is actually driving.
 *
 * TEST BOUNDARIES:
 *   @real-dependency: the real store and the real engine -- Mock? NO. Both halves of the claim are
 *       about those two agreeing: the store refuses an id the table does not have, and the engine
 *       publishes only what the store kept.
 */
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test, { before } from 'node:test';

import { OfficeState } from '@pixel/shared/office/engine/officeState.js';
import { buildDynamicCatalog } from '@pixel/shared/office/layout/furnitureCatalog';
import { DEFAULT_HELMET, HELMETS, helmetStyle, isHelmetId } from '@pixel/shared/office/race/helmets.js';
import type { OfficeLayout } from '@pixel/shared/office/types';

import { appStore } from './appStore.js';
import { buildFurnitureCatalogAndSprites } from './assets.js';
import { importTmjToLayout } from './tiled/mapBridge.js';
import { loadTiledRegistry } from './tiled/tiledRegistry.js';
import { userStore } from './userStore.js';

const ROOT = join(import.meta.dirname, '..', '..');
let circuit: OfficeLayout;

before(async () => {
  buildDynamicCatalog((await buildFurnitureCatalogAndSprites()) as never);
  const reg = loadTiledRegistry(ROOT);
  circuit = importTmjToLayout(
    JSON.parse(readFileSync(join(ROOT, 'assets', 'tiled', 'zones', 'raceway.tmj'), 'utf8')),
    reg,
    () => null,
  ).layout;
  for (const id of ['helm', 'helm2']) if (!userStore.get(id)) userStore.createUser(id, `${id}-pw12345`);
});

test('the choice is a grid, so it is large without being hand-maintained', () => {
  // Twelve shells in five patterns. The point of the shape is that adding a colour adds a row of
  // helmets rather than five entries somebody has to keep consistent.
  assert.ok(HELMETS.length >= 40, `only ${HELMETS.length} helmets to choose from`);
  assert.equal(new Set(HELMETS.map((h) => h.id)).size, HELMETS.length, 'two helmets share an id');
  for (const h of HELMETS) {
    assert.match(h.id, /^[a-z]+-[a-z]+$/, `${h.id} is not <shell>-<pattern>`);
    assert.ok(h.label.length > 0);
    assert.notEqual(h.shell, h.trim, `${h.id} paints its pattern in its own colour`);
  }
});

test('the empty id means "my own colours" and is not a helmet', () => {
  // Somebody who never opens the menu still has to be tellable from eleven others, so the default
  // is derived from their sheet rather than being one more entry in the table.
  assert.equal(isHelmetId(DEFAULT_HELMET), true, 'the default was refused');
  assert.equal(helmetStyle(DEFAULT_HELMET), null, 'the default resolved to a fixed helmet');
  assert.equal(helmetStyle('no-such-helmet'), null);
});

test('the store refuses an id the table does not have, in both directions', () => {
  assert.equal(appStore.setHelmet('helm', HELMETS[3].id), true);
  assert.equal(appStore.helmet('helm'), HELMETS[3].id);
  assert.equal(appStore.setHelmet('helm', 'cherry-flames'), false, 'an unknown id was stored');
  assert.equal(appStore.setHelmet('helm', 42), false, 'a number was stored');
  assert.equal(appStore.helmet('helm'), HELMETS[3].id, 'a refused write changed the stored value');
  // Clearing back to the derived default is a legal choice, not a refusal.
  assert.equal(appStore.setHelmet('helm', DEFAULT_HELMET), true);
  assert.equal(appStore.helmet('helm'), DEFAULT_HELMET);
  // Never chosen at all reads as the default rather than as nothing.
  assert.equal(appStore.helmet('nobody-at-all'), DEFAULT_HELMET);
});

test('a helmet is worn only while driving, and comes from the ACCOUNT', () => {
  const os = new OfficeState(circuit as never) as never as {
    karts: Map<number, { x: number; y: number; ownerId: number | null }>;
    characters: Map<number, { x: number; y: number; helmet: string }>;
    addPlayer: (skin: string, name: string, a: undefined, owner: string) => number;
    boardKart: (id: number) => boolean;
    setHelmetPref: (owner: string, id: string) => void;
  };
  const id = os.addPlayer('char_0', 'Helm', undefined, 'helm');
  const ch = os.characters.get(id);
  // Their own car: a kart is spawned for whoever is on the track and belongs to them.
  const kart = [...os.karts.values()].find((k) => k.ownerId === id)!;
  assert.ok(ch);
  assert.equal(ch.helmet, '', 'a pawn on foot is wearing a helmet');

  os.setHelmetPref('helm', HELMETS[7].id);
  ch.x = kart.x;
  ch.y = kart.y;
  assert.equal(os.boardKart(id), true);
  assert.equal(ch.helmet, HELMETS[7].id, 'getting in did not put the helmet on');

  // …and taking it off again: `helmet` is only ever read while somebody drives, so a world of
  // people on foot carries empty strings rather than sixty ids.
  assert.equal(os.boardKart(id), true, 'boarding again is how you get out');
  assert.equal(ch.helmet, '', 'getting out left the helmet on');
});

test('somebody else’s preference is never worn by mistake', () => {
  const os = new OfficeState(circuit as never) as never as {
    karts: Map<number, { x: number; y: number; ownerId: number | null }>;
    characters: Map<number, { x: number; y: number; helmet: string }>;
    addPlayer: (skin: string, name: string, a: undefined, owner: string) => number;
    boardKart: (id: number) => boolean;
    setHelmetPref: (owner: string, id: string) => void;
  };
  os.setHelmetPref('helm', HELMETS[2].id);
  const other = os.addPlayer('char_0', 'Other', undefined, 'helm2');
  const ch = os.characters.get(other);
  assert.ok(ch);
  // Their own car — one is spawned per person, so the other account's preference has no seat here
  // to leak through in the first place.
  const theirs = [...os.karts.values()].find((k) => k.ownerId === other);
  assert.ok(theirs);
  ch.x = theirs.x;
  ch.y = theirs.y;
  assert.equal(os.boardKart(other), true);
  assert.equal(ch.helmet, '', 'a driver wore an account that is not theirs');
});
