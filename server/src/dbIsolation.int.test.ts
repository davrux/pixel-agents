/**
 * Two facts about the database that a test suite has no way to notice going wrong.
 *
 * The first is isolation. A test file that imports anything reaching `db.ts` opens whatever
 * `PIXEL_STREAM_DATA_DIR` points at — and the default is the repo's own `tmp/data`, i.e. the
 * world the developer is standing in. `db.ts` runs a migration on import, and `PIXEL_RESET_WORLD`
 * is honoured there too, so "the tests only read" was never actually true. Each test child now
 * gets a temp directory from `test-data-dir.mjs` (loaded with `--import`, before any module can
 * open anything), and this asserts it — because the failure mode is invisible: everything passes,
 * and somebody else's world is what was touched.
 *
 * The second is the reason the isolation was found at all. Opening this module takes SQLite's
 * write lock, so a dozen test children racing for one file meant about one run in eight died with
 * `SQLITE_BUSY` while still importing — exit code 1, no failing assertion, a different file every
 * time, and node printing nothing but 'test failed'. It took the TAP reporter to see the stack.
 * `busy_timeout` makes a collision a pause instead of a crash, which matters outside tests too:
 * `prune-orphan-assets`, `repack-art` and a zone push all open this database while a server may
 * be running.
 */
import { strict as assert } from 'node:assert';
import * as path from 'node:path';
import test from 'node:test';

import { db } from './db.js';
import { dataDir } from './paths.js';

test('a test run never opens the developer world', () => {
  const dir = process.env.PIXEL_STREAM_DATA_DIR;
  assert.ok(dir, 'PIXEL_STREAM_DATA_DIR must be set for every test child (see test-data-dir.mjs)');
  // The repo default, spelled the way paths.ts builds it, so this keeps working if that moves.
  const repoDefault = path.resolve(path.join(import.meta.dirname, '..', '..', 'tmp', 'data'));
  assert.notEqual(path.resolve(dataDir()), repoDefault, 'the tests are running against the repo tmp/data world');
});

test('the connection waits for a lock instead of failing, and readers do not block the writer', () => {
  const timeout = db.prepare('PRAGMA busy_timeout').get() as { timeout?: number };
  assert.ok((timeout?.timeout ?? 0) >= 1000, `busy_timeout is ${timeout?.timeout} — a second process would get SQLITE_BUSY`);
  const journal = db.prepare('PRAGMA journal_mode').get() as { journal_mode?: string };
  assert.equal(journal?.journal_mode, 'wal');
});
