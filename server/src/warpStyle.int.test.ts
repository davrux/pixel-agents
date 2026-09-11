/**
 * A warp's style is the owner's, and its duration is the world's.
 *
 * The Matrix effect used to be the only way in and out, so its duration was a constant and nobody
 * had to say where a style came from. With four of them, two things need pinning, and both are
 * about the fact that a warp is not decoration: between the two phases the server MOVES the body
 * (`officeState.update`'s pendingWarp branch), so the effect is what hides a real teleport.
 *
 *  1. **The duration comes from the style.** A 0.5 s implosion and a 1.0 s phoenix run on the same
 *     timer, and the body is repositioned when that timer passes the STYLE's duration. Read the
 *     wrong one and the figure moves while somebody is still dissolving.
 *  2. **The style comes from the account, never from a message.** Everyone sees it, so a client
 *     may say which it wants and nothing more; the id is validated against `WARP_STYLES` on the
 *     way in AND on the way out of the store, because that row is reachable by a restore.
 *
 * And one thing that is NOT a bug: an unknown id resolves to the DEFAULT, not to "no effect". That
 * is the opposite of the `ControllerKind` rule, where zero is deliberately inert, and for the
 * opposite reason — an unstyled warp still has to cover the teleport.
 *
 * TEST BOUNDARIES:
 *   @real-dependency: OfficeState, the real store, the committed art -- Mock? NO. "The duration
 *       decides when the body moves" is a claim about the engine's own loop, and "the client can
 *       fetch this style's art" is a claim about files that exist. A stub would test neither.
 */
import { strict as assert } from 'node:assert';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

import {
  DEFAULT_WARP_STYLE,
  EFFECT_SHEETS,
  isWarpStyleId,
  warpStyle,
  WARP_STYLES,
} from '@pixel/shared/office/effects.js';
import { OfficeState } from '@pixel/shared/office/engine/officeState.js';
import type { Character } from '@pixel/shared/office/types';

import { appStore } from './appStore.js';
import { userStore } from './userStore.js';

const world = (cols = 16, rows = 16): OfficeState =>
  new OfficeState({
    cols,
    rows,
    tiles: new Array(cols * rows).fill(1),
    walls: { horizontal: [], vertical: [] },
    furniture: [],
  } as never);

type Inner = {
  warpPlayer(id: number, col: number, row: number): boolean;
  characters: Map<number, Character>;
  setWarpStylePref(name: string, style: string): void;
  addPlayer(skin?: string, name?: string, at?: { col: number; row: number }, ownerId?: string): number;
};
const inner = (os: OfficeState): Inner => os as unknown as Inner;

const tick = (os: OfficeState, seconds: number): void => {
  for (let i = 0; i < Math.round(seconds / (1 / 20)); i++) os.update(1 / 20);
};

test('the table is well formed, and every style the client must fetch has its art', () => {
  const ids = WARP_STYLES.map((w) => w.id);
  assert.equal(new Set(ids).size, ids.length, 'a style id appears twice');
  assert.ok(ids.includes(DEFAULT_WARP_STYLE), 'the default is not in the table');
  for (const w of WARP_STYLES) {
    assert.ok(w.durationSec > 0, `${w.id} has no duration`);
    assert.ok(w.label.length > 0, `${w.id} has no label — the picker would show a blank button`);
    if (!w.sheet) continue;
    // In EFFECT_SHEETS, or the client's loading phase never fetches it and the style is silent.
    assert.ok(
      EFFECT_SHEETS.some((s) => s.id === w.sheet!.id),
      `${w.id} names a sheet that is not in EFFECT_SHEETS`,
    );
    // And the file the art route reads has to exist, or every warp in that style draws nothing.
    const file = join(import.meta.dirname, '..', '..', 'assets', 'effects', `${w.sheet.id}.png`);
    assert.ok(existsSync(file), `${w.id}: no art at ${file} — run its draw script`);
  }
});

test('an unknown or empty style resolves to the default, never to no effect', () => {
  assert.equal(warpStyle(undefined).id, DEFAULT_WARP_STYLE);
  assert.equal(warpStyle('').id, DEFAULT_WARP_STYLE);
  assert.equal(warpStyle('kaboom').id, DEFAULT_WARP_STYLE, 'an id this build does not know must still cover the teleport');
  assert.equal(warpStyle('implode').id, 'implode');
  assert.equal(isWarpStyleId('implode'), true);
  for (const junk of [null, undefined, 42, {}, '', 'IMPLODE', 'matrix ']) {
    assert.equal(isWarpStyleId(junk), false, `accepted ${JSON.stringify(junk)}`);
  }
});

test('the store refuses an id this build does not know, on the way in and on the way out', () => {
  // The account has to exist: user_prefs cascades from users, so a preference for a stranger is
  // refused rather than stored (see userDataCascade.int.test.ts).
  userStore.createUser('warpuser', 'password-123', {});
  assert.equal(appStore.setWarpStyle('warpuser', 'phoenix'), true);
  assert.equal(appStore.getWarpStyle('warpuser'), 'phoenix');
  assert.equal(appStore.setWarpStyle('warpuser', 'kaboom'), false, 'an unknown id was stored');
  assert.equal(appStore.getWarpStyle('warpuser'), 'phoenix', 'the refused write changed the stored style');
  assert.equal(appStore.setWarpStyle('warpuser', 42), false);
  assert.equal(appStore.getWarpStyle('never-picked-one'), null);
});

test('a warp plays the OWNER’s style, and the body moves when THAT style says so', () => {
  const os = world();
  const i = inner(os);
  i.setWarpStylePref('owner', 'implode'); // 0.5 s per phase
  const id = i.addPlayer('char_0', 'Owner McDisplayname', { col: 2, row: 2 }, 'owner');
  const ch = i.characters.get(id);
  assert.ok(ch);
  // Past the spawn effect it got on arrival.
  tick(os, 2);
  assert.equal(ch.matrixEffect, null);
  assert.equal(ch.warpStyle, null, 'the style outlived its phase');

  assert.equal(i.warpPlayer(id, 9, 9), true);
  assert.equal(ch.matrixEffect, 'despawn');
  assert.equal(ch.warpStyle, 'implode', 'the warp did not take the owner’s style');

  // Still on the old tile a third of the way through — the effect is covering the jump.
  tick(os, 0.15);
  assert.deepEqual([ch.tileCol, ch.tileRow], [2, 2], 'the body moved before the effect could hide it');

  // And moved once implode's own 0.5 s is up. A style-blind check against the old 0.7 s constant
  // would still be waiting here, which is exactly the bug this pins.
  tick(os, 0.45);
  assert.deepEqual([ch.tileCol, ch.tileRow], [9, 9], 'the body never arrived');
  assert.equal(ch.matrixEffect, 'spawn', 'the second half did not start');
  assert.equal(ch.warpStyle, 'implode', 'the style changed between the two halves');

  // The arrival finishes and takes the style with it.
  tick(os, 0.6);
  assert.equal(ch.matrixEffect, null);
  assert.equal(ch.warpStyle, null, 'the style is still set with no phase running');
});

test('a longer style keeps the body in place longer — the durations are actually read', () => {
  const os = world();
  const i = inner(os);
  i.setWarpStylePref('slowpoke', 'phoenix'); // 1.0 s per phase
  const id = i.addPlayer('char_0', 'Slow Poke', { col: 2, row: 2 }, 'slowpoke');
  const ch = i.characters.get(id)!;
  tick(os, 3);

  i.warpPlayer(id, 9, 9);
  tick(os, 0.6); // past implode's whole phase, well short of phoenix's
  assert.deepEqual([ch.tileCol, ch.tileRow], [2, 2], 'phoenix moved the body on implode’s schedule');
  tick(os, 0.5);
  assert.deepEqual([ch.tileCol, ch.tileRow], [9, 9]);
});

test('a pawn with no owner preference warps in the default style', () => {
  const os = world();
  const i = inner(os);
  const id = i.addPlayer('char_0', 'Nobody', { col: 2, row: 2 }, 'nobody-set-this');
  const ch = i.characters.get(id)!;
  assert.equal(ch.warpStyle, DEFAULT_WARP_STYLE, 'the spawn effect had no style at all');
});

test('the style follows the ACCOUNT, not the name shown on the avatar', () => {
  // The bug this pins, reported from the running world: the preference is stored under the
  // user id, and the lookup read `folderName` — which is the owner's user id for an AGENT but the
  // free DISPLAY NAME for a player avatar. So anybody whose display name differs from their login
  // id silently got the default, and the first version of every test above used one string for
  // both and therefore passed.
  const os = world();
  const i = inner(os);
  i.setWarpStylePref('u-42', 'beam');

  const mine = i.characters.get(i.addPlayer('char_0', 'Ada Lovelace', { col: 2, row: 2 }, 'u-42'))!;
  assert.equal(mine.warpStyle, 'beam', 'a display name that is not the account id lost the style');

  // And a pawn whose display name happens to collide with somebody else's account id must not
  // inherit that account's style.
  const other = i.characters.get(i.addPlayer('char_0', 'u-42', { col: 5, row: 5 }, 'someone-else'))!;
  assert.equal(other.warpStyle, DEFAULT_WARP_STYLE, 'a display name was used as an account key');
});
