/**
 * Presence is the online list's only source, and the list is PUSHED — so the
 * fact worth pinning down is not what `presence.list()` returns (a room could
 * always ask it) but that every change ANNOUNCES itself. A join in zone A has
 * to reach a viewer standing in zone B, and the only thing that carries it
 * there is PRESENCE_EVENT on the control bus (SimRoom subscribes and
 * re-broadcasts its roster).
 *
 * The refcount is asserted alongside it because it is what keeps a second tab
 * from appearing as a second person — and, more subtly, what decides WHEN the
 * "left" edge fires: on the last session, not the first.
 *
 * TEST BOUNDARIES:
 *   @real-dependency: controlBus -- Mock? NO. It is a plain EventEmitter, and
 *       the wiring between it and presence.ts is exactly what's under test.
 */
import { strict as assert } from 'node:assert';
import test from 'node:test';

import { controlBus, PRESENCE_EVENT } from './controlBus.js';
import { presence } from './presence.js';

/** Run `fn` while counting PRESENCE_EVENTs. */
function countingEvents(fn: () => void): number {
  let n = 0;
  const onChange = (): void => void (n += 1);
  controlBus.on(PRESENCE_EVENT, onChange);
  try {
    fn();
  } finally {
    controlBus.off(PRESENCE_EVENT, onChange);
  }
  return n;
}

test('every presence change announces itself on the control bus', () => {
  // A zone switch is what the rooms actually do: the new room joins, the old
  // one leaves (a reload overlaps them, which is why presence is refcounted).
  const events = countingEvents(() => {
    presence.join('ann', 'uponu', 'Ann'); // arrives
    presence.join('ann', 'foyer', 'Ann'); // switches zone: new room's onJoin…
    presence.leave('ann'); //                                …old room's onLeave
    presence.leave('ann'); // logs out
  });
  assert.equal(events, 4, 'arrival, zone switch and departure all have to reach the other zones');
  assert.equal(presence.zoneOf('ann'), null);
});

test('a second tab is one person, and only its last session ends the session', () => {
  presence.join('cy', 'uponu', 'Cy');
  presence.join('cy', 'uponu', 'Cy'); // second tab
  assert.equal(presence.list().filter((u) => u.userId === 'cy').length, 1);

  presence.leave('cy');
  assert.equal(presence.zoneOf('cy'), 'uponu', 'still online through the other tab');
  presence.leave('cy');
  assert.equal(presence.zoneOf('cy'), null);
});

test('an unauthenticated session is nobody: it neither lists nor announces', () => {
  const events = countingEvents(() => presence.join('', 'uponu', ''));
  assert.equal(events, 0);
  assert.equal(presence.list().some((u) => !u.userId), false);
});

test('a voice channel is pushed like everything else here, and only when it changes', () => {
  // The roster is PUSHED, so a channel that changes without emitting is a
  // channel nobody's list ever shows — the same failure the zone would have.
  presence.join('di', 'uponu', 'Di');
  assert.equal(countingEvents(() => presence.setVoice('di', 'General')), 1);
  assert.equal(presence.list().find((u) => u.userId === 'di')?.voice, 'General');
  // Re-reporting the same channel is what a reconnect does on every zone change;
  // it must not wake every room in the world.
  assert.equal(countingEvents(() => presence.setVoice('di', 'General')), 0);
  assert.equal(countingEvents(() => presence.setVoice('di', '')), 1);
  presence.leave('di');
});

test('a voice channel belongs to a session, so it goes when the last one does', () => {
  presence.join('eli', 'uponu', 'Eli');
  presence.setVoice('eli', 'Standup');
  // A zone switch is a join over a leave; the channel has to survive it, or
  // walking through a portal would blank the roster's answer for everyone.
  presence.join('eli', 'foyer', 'Eli');
  presence.leave('eli');
  assert.equal(presence.list().find((u) => u.userId === 'eli')?.voice, 'Standup');

  presence.leave('eli');
  assert.equal(presence.zoneOf('eli'), null);
  // Back online with nothing reported yet: the old channel must not come back.
  presence.join('eli', 'uponu', 'Eli');
  assert.equal(presence.list().find((u) => u.userId === 'eli')?.voice, '');
  presence.leave('eli');
});

test('a channel for somebody who is not online goes nowhere', () => {
  // The room resolves the account from the session, so this is the race where a
  // report and a disconnect cross — it must not resurrect an entry.
  const events = countingEvents(() => presence.setVoice('nobody-here', 'General'));
  assert.equal(events, 0);
  assert.equal(presence.zoneOf('nobody-here'), null);
});
