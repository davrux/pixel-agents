/**
 * Two meeting areas with the same name are ONE call, however far apart they are.
 *
 * Adjacency (computeActionAreas) already merges what a mapper draws as one room. This
 * merges what they *name* as one: a lounge on two floors, a smoking corner outside the
 * building. The identity is the name plus the video setting, and the call is addressed
 * by the raster-first of the areas sharing it, so every member of a named lounge lands
 * in the same LiveKit room no matter which patch of floor they stand on.
 *
 * What each half is worth pinning:
 *   - the merge itself, since without it same-named areas are silently separate calls
 *     and the mapper's intent is lost with no error anywhere;
 *   - the per-area `anchor` staying distinct from the shared `canonical`, because that
 *     difference is the only thing that tells the client who is somewhere else (the
 *     hint line in the meeting window reads it);
 *   - video as part of the identity — two same-named areas that disagree must NOT merge,
 *     or one side loses its setting without saying so;
 *   - an unnamed area staying its own call, which is what every existing map relies on.
 *
 * TEST BOUNDARIES:
 *   @real-dependency: OfficeState -- Mock? NO. It owns the area map and the per-layout
 *       canonical cache; the rule is only correct if it survives a rebuildFromLayout,
 *       which a pure call to actionAreas.ts would not exercise.
 */
import { strict as assert } from 'node:assert';
import test from 'node:test';

import { OfficeState } from '@pixel/shared/office/engine/index.js';
import { emptyZoneMap } from '@pixel/shared/office/layout/layoutSerializer.js';
import type { OfficeLayout } from '@pixel/shared/office/types.js';

const COLS = 20;
const ROWS = 12;

/** A meeting area is a rectangle of tiles that each carry the same meetingRoom action —
 *  the shape Tiled's import produces for a painted MeetingLayer region. */
function area(layout: OfficeLayout, col: number, row: number, w: number, h: number, name: string | undefined, video = true): void {
  const acts = (layout.tileActions ??= new Array<null>(COLS * ROWS).fill(null));
  for (let r = row; r < row + h; r++) {
    for (let c = col; c < col + w; c++) {
      acts[r * COLS + c] = { kind: 'meetingRoom', ...(name === undefined ? {} : { meetingRoomName: name }), video } as never;
    }
  }
}

function world(build: (layout: OfficeLayout) => void): OfficeState {
  const layout = emptyZoneMap(COLS, ROWS);
  build(layout);
  return new OfficeState(layout);
}

test('two areas that never touch but share a name are one call', () => {
  const os = world((l) => {
    area(l, 2, 2, 2, 2, 'Lounge');
    area(l, 14, 8, 2, 2, 'Lounge');
  });

  const left = os.meetingAreaAt(2, 2);
  const right = os.meetingAreaAt(15, 9);
  assert.ok(left && right, 'both patches are meeting tiles');

  assert.deepEqual(left.canonical, right.canonical, 'same name, so both are addressed as the same call');
  assert.deepEqual(left.canonical, { col: 2, row: 2 }, 'the call is addressed by the raster-first area');
  assert.equal(left.slug, 'lounge');
  assert.equal(right.slug, 'lounge');

  // …and each still knows where it itself is. This is what the roster carries per member.
  assert.deepEqual(left.anchor, { col: 2, row: 2 });
  assert.deepEqual(right.anchor, { col: 14, row: 8 });
  assert.notDeepEqual(left.anchor, right.anchor, 'a member of the far patch must not look like it stands in the near one');
});

test('the name is matched by its slug, not character by character', () => {
  const os = world((l) => {
    area(l, 2, 2, 2, 2, 'Team Lounge');
    area(l, 14, 8, 2, 2, '  team   lounge  ');
  });
  const a = os.meetingAreaAt(3, 3);
  const b = os.meetingAreaAt(14, 8);
  assert.ok(a && b);
  assert.equal(a.slug, b.slug, 'whitespace and case are not identity');
  assert.deepEqual(a.canonical, b.canonical);
});

test('same name but a different video setting stays a separate call', () => {
  const os = world((l) => {
    area(l, 2, 2, 2, 2, 'Lounge', true);
    area(l, 14, 8, 2, 2, 'Lounge', false);
  });
  const withVideo = os.meetingAreaAt(2, 2);
  const without = os.meetingAreaAt(14, 8);
  assert.ok(withVideo && without);
  assert.equal(withVideo.video, true);
  assert.equal(without.video, false);
  assert.notDeepEqual(withVideo.canonical, without.canonical, 'merging these would silently overrule one of the two settings');
});

test('unnamed areas keep their own anchor as identity', () => {
  const os = world((l) => {
    area(l, 2, 2, 2, 2, undefined);
    area(l, 14, 8, 2, 2, '   ');
  });
  const a = os.meetingAreaAt(3, 2);
  const b = os.meetingAreaAt(15, 8);
  assert.ok(a && b);
  assert.equal(a.slug, '', 'nothing to merge on');
  assert.equal(b.slug, '', 'a blank name is no name');
  assert.deepEqual(a.canonical, a.anchor);
  assert.deepEqual(b.canonical, b.anchor);
  assert.notDeepEqual(a.canonical, b.canonical, 'two unnamed areas were always two calls and must stay that way');
});

test('a tile outside every area is not a meeting tile', () => {
  const os = world((l) => area(l, 2, 2, 2, 2, 'Lounge'));
  assert.equal(os.meetingAreaAt(9, 5), null);
});

test('the canonical anchor survives a layout swap', () => {
  const os = world((l) => area(l, 2, 2, 2, 2, 'Lounge'));
  assert.deepEqual(os.meetingAreaAt(2, 2)?.canonical, { col: 2, row: 2 });

  // The cache is per layout; a zone whose map is pushed must not answer with the old one.
  const next = emptyZoneMap(COLS, ROWS);
  area(next, 6, 4, 2, 2, 'Lounge');
  os.rebuildFromLayout(next);

  assert.equal(os.meetingAreaAt(2, 2), null, 'the old area is gone');
  assert.deepEqual(os.meetingAreaAt(7, 5)?.canonical, { col: 6, row: 4 }, 'stale canonical anchors after a map push');
});
