/**
 * A season: what makes a second race matter.
 *
 * Two rules here are decisions rather than mechanics, and both are the kind that look like bugs
 * from the outside if they go the other way: points are for a FINISH and not for a start, and a
 * retirement must not wipe the best finish somebody already has.
 *
 * TEST BOUNDARIES:
 *   @real-dependency: the SQLite store -- Mock? NO. The best-finish rule is expressed in SQL,
 *       precisely so two races in one process cannot lose an update; testing it elsewhere would
 *       test a different implementation.
 */
import { strict as assert } from 'node:assert';
import test, { before } from 'node:test';

import { POINTS, bySeason, pointsFor } from '@pixel/shared/office/race/championship.js';

import { clearSeason, scoreFinish, seasonTable } from './championshipStore.js';
import { userStore } from './userStore.js';

const ZONE = 'champzone';

/**
 * A real account, because `race_points.user_id` has a foreign key to `users`.
 *
 * That constraint is the point rather than an obstacle: a season entry is PERSONAL data, so
 * deleting the account has to take it — which is the rule in AGENTS.md § Memory and what
 * `userDataCascade.int.test.ts` enforces. A store that accepted a row for a user who does not
 * exist would be a store whose rows outlive their owners.
 */
const user = (id: string): string => {
  if (!userStore.get(id)) userStore.createUser(id, `${id}-pw12345`);
  return id;
};

before(() => {
  for (const id of ['ada', 'bob', 'cid']) user(id);
});

test('points reward finishing, and finishing well', () => {
  assert.equal(pointsFor(1), 25);
  assert.equal(pointsFor(10), 1);
  assert.equal(pointsFor(11), 0, 'eleventh scored');
  // A start is not a result: somebody who leaves after the lights scores nothing.
  assert.equal(pointsFor(0), 0);
  assert.equal(pointsFor(-3), 0);
  // The gap at the FRONT is worth more than the gap at the back, so a win is worth chasing.
  assert.ok(POINTS[0] - POINTS[1] > POINTS[7] - POINTS[8]);
});

test('a season adds up, and a retirement does not erase a best finish', () => {
  clearSeason(ZONE);
  scoreFinish(ZONE, 'ada', 1, pointsFor(1));
  scoreFinish(ZONE, 'ada', 4, pointsFor(4));
  // Retired: a start, no points, and — the rule that matters — the best finish stays 1.
  scoreFinish(ZONE, 'ada', 0, pointsFor(0));
  const [ada] = seasonTable(ZONE);
  assert.equal(ada.points, 25 + 12);
  assert.equal(ada.starts, 3, 'a retirement was not a start');
  assert.equal(ada.wins, 1);
  assert.equal(ada.bestPlace, 1, 'a retirement wiped the best finish');
});

test('the table is ordered by points, then wins, then best finish', () => {
  clearSeason(ZONE);
  // Same points, different stories: two seconds against one win and a retirement.
  scoreFinish(ZONE, 'bob', 2, pointsFor(2));
  scoreFinish(ZONE, 'bob', 4, pointsFor(4));
  scoreFinish(ZONE, 'cid', 1, pointsFor(1));
  scoreFinish(ZONE, 'cid', 9, pointsFor(9));
  const table = seasonTable(ZONE);
  assert.equal(table.length, 2);
  assert.equal(table[0].userId, 'bob', `bob ${table[0].points} vs cid: ${JSON.stringify(table)}`);

  // …and on equal points the win breaks it.
  const a = { userId: 'a', name: 'a', points: 10, starts: 1, wins: 1, bestPlace: 1 };
  const b = { userId: 'b', name: 'b', points: 10, starts: 5, wins: 0, bestPlace: 2 };
  assert.ok(bySeason(a, b) < 0, 'a win did not break a tie');
});

test('a zone keeps its own season', () => {
  clearSeason(ZONE);
  clearSeason('otherzone');
  scoreFinish(ZONE, 'ada', 1, pointsFor(1));
  assert.equal(seasonTable('otherzone').length, 0, 'points leaked between zones');
  assert.equal(seasonTable(ZONE).length, 1);
  clearSeason(ZONE);
  assert.equal(seasonTable(ZONE).length, 0);
});

test('a computer driver has no account, so it scores nothing', () => {
  clearSeason(ZONE);
  // The room passes '' for a driver with no account behind it; the store refuses it rather than
  // writing a row keyed on nothing.
  scoreFinish(ZONE, '', 1, pointsFor(1));
  assert.equal(seasonTable(ZONE).length, 0, 'a nameless finisher got into the season table');
});
