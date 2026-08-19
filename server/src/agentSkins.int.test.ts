/**
 * More agents than skins is allowed to look repetitive — and must cost nothing.
 *
 * Agents used to be told apart by a random hue rotation once the skins ran out:
 * `pickDiverseSkin` handed the seventh-or-later agent a shift of ≥45°, and the
 * renderer then built a full recoloured copy of every frame of that skin, cached
 * per `skin:hue`. So the mechanism only ever engaged in the situation where the
 * world was busiest, and each engagement added a sprite set (and atlas pages) for
 * one avatar. That trade was rejected: two agents may look alike, and variety comes
 * from drawing more skins.
 *
 * These pin what that leaves behind. The first test is the behaviour: with three
 * skins and nine agents, every skin is used and nobody is left without one — the
 * "diverse" part still works, it just wraps. The second is the reason the field
 * could go at all: two agents on the same skin must resolve to the SAME sprite
 * object, because identity is what proves no per-character copy exists. A hue
 * shift, or any other per-character recolour, would fail it.
 *
 * TEST BOUNDARIES:
 *   @real-dependency: OfficeState -- Mock? NO. Skin assignment lives in it
 *       (pickDiverseSkin), and the balancing counts live characters, so nothing
 *       short of the real thing answers the question.
 *   @real-dependency: spriteData's cache -- Mock? NO. The identity assertion IS
 *       the cache's contract; a stub would assert my own assumption instead.
 */
import { strict as assert } from 'node:assert';
import test from 'node:test';

import { OfficeState } from '@pixel/shared/office/engine/index.js';
import { emptyZoneMap } from '@pixel/shared/office/layout/layoutSerializer.js';
import { getCharacterSprites, getSkinIds, setCharacterTemplates } from '@pixel/shared/office/sprites/spriteData.js';

/** Three tiny skins, so "more agents than skins" needs nine agents, not ten.
 *  Seven frames per direction because that is what the default character spec's
 *  tracks add up to — a thinner fixture makes buildCharacterSprites read past the
 *  end of a row, which is a broken fixture and not a finding. */
function threeSkins(): void {
  const frame = () => Array.from({ length: 4 }, () => Array.from({ length: 4 }, () => '#ff0000'));
  const row = () => Array.from({ length: 7 }, frame);
  const data = () => ({ down: row(), up: row(), right: row() });
  setCharacterTemplates([
    { id: 'char_0', data: data() },
    { id: 'char_1', data: data() },
    { id: 'char_2', data: data() },
  ] as never);
}

test('agents keep spreading across the skins, and simply repeat once they run out', () => {
  threeSkins();
  const os = new OfficeState(emptyZoneMap(20, 20));
  const skins: string[] = [];
  for (let i = 0; i < 9; i++) {
    os.addAgent(1000 + i, undefined, undefined, true, `agent_${i}`);
    const ch = os.getCharacter(1000 + i);
    assert.ok(ch, `agent ${i} was not created`);
    skins.push(ch.skin);
  }
  assert.equal(skins.length, 9);
  assert.equal(new Set(skins).size, getSkinIds().length, 'every skin should be in use before any repeats');
  // Balanced: three skins, nine agents → three each. This is the "diverse" part.
  for (const id of getSkinIds()) {
    assert.equal(skins.filter((s) => s === id).length, 3, `skin ${id} is not evenly used`);
  }
});

test('two agents on one skin share the sprite set — no per-character copy', () => {
  threeSkins();
  const os = new OfficeState(emptyZoneMap(20, 20));
  for (let i = 0; i < 6; i++) os.addAgent(2000 + i, undefined, undefined, true, `agent_${i}`);
  const chars = [...Array(6)].map((_, i) => os.getCharacter(2000 + i)!);
  const pairs = chars.filter((c, i) => chars.findIndex((o) => o.skin === c.skin) !== i);
  assert.ok(pairs.length > 0, 'six agents on three skins must share');
  for (const dup of pairs) {
    const first = chars.find((c) => c.skin === dup.skin)!;
    assert.equal(
      getCharacterSprites(first.skin),
      getCharacterSprites(dup.skin),
      'same skin must resolve to the same object — a recolour per character is what this forbids',
    );
  }
});
