/**
 * A time with nothing to beat is a stopwatch.
 *
 * The records table is what makes a lap worth repeating, and it has two rules that are easy to
 * get wrong and impossible to spot by playing: a record is per LAP COUNT as well as per track (a
 * three-lap time says nothing about a five-lap one), and a slower time must never overwrite a
 * faster one even though both arrive as "somebody finished".
 *
 * TEST BOUNDARIES:
 *   @real-dependency: the SQLite store -- Mock? NO. The comparison is done in SQL on purpose, so
 *       testing it anywhere else would test a different implementation.
 */
import { strict as assert } from 'node:assert';
import test from 'node:test';

import { clearRaceRecords, offerRecord, raceRecords } from './raceRecordStore.js';

test('a record is kept per track AND per lap count', () => {
  clearRaceRecords('zoneA');
  clearRaceRecords('zoneB');
  assert.deepEqual(raceRecords('zoneA', 3), { lapMs: 0, lapBy: '', raceMs: 0, raceBy: '' });

  assert.equal(offerRecord('zoneA', 3, 'lap', 30_000, 'Ada'), true);
  assert.equal(raceRecords('zoneA', 3).lapMs, 30_000);
  assert.equal(raceRecords('zoneA', 3).lapBy, 'Ada');
  // Five laps is a different record entirely.
  assert.equal(raceRecords('zoneA', 5).lapMs, 0, 'a three-lap record leaked into five laps');
  // …and so is another track.
  assert.equal(raceRecords('zoneB', 3).lapMs, 0, 'a record leaked between zones');
});

test('only a faster time replaces one, whoever sends it', () => {
  clearRaceRecords('zoneC');
  assert.equal(offerRecord('zoneC', 3, 'race', 90_000, 'Ada'), true);
  assert.equal(offerRecord('zoneC', 3, 'race', 95_000, 'Bob'), false, 'a slower race took the record');
  assert.equal(raceRecords('zoneC', 3).raceBy, 'Ada', 'the holder changed on a slower time');
  assert.equal(offerRecord('zoneC', 3, 'race', 89_999, 'Bob'), true);
  assert.deepEqual(
    { ms: raceRecords('zoneC', 3).raceMs, by: raceRecords('zoneC', 3).raceBy },
    { ms: 89_999, by: 'Bob' },
  );
  // Lap and race are separate rows, not one number wearing two hats.
  assert.equal(raceRecords('zoneC', 3).lapMs, 0);
});

test('nonsense is refused rather than stored', () => {
  clearRaceRecords('zoneD');
  assert.equal(offerRecord('zoneD', 3, 'lap', 0, 'Ada'), false);
  assert.equal(offerRecord('zoneD', 3, 'lap', -5, 'Ada'), false);
  assert.equal(offerRecord('zoneD', 3, 'lap', Number.NaN, 'Ada'), false);
  assert.equal(raceRecords('zoneD', 3).lapMs, 0);
  // A name is bounded where it enters, like every other value from outside.
  assert.equal(offerRecord('zoneD', 3, 'lap', 1000, 'x'.repeat(500)), true);
  assert.equal(raceRecords('zoneD', 3).lapBy.length, 64);
});

test('clearing a zone takes its records with it', () => {
  clearRaceRecords('zoneE');
  offerRecord('zoneE', 3, 'lap', 1000, 'Ada');
  offerRecord('zoneE', 7, 'race', 2000, 'Ada');
  clearRaceRecords('zoneE');
  assert.equal(raceRecords('zoneE', 3).lapMs, 0);
  assert.equal(raceRecords('zoneE', 7).raceMs, 0);
});
