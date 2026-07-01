// Runner + isolation harness — proves the server `node:test` lane works and that
// each test owns a fresh temp SQLite (no shared rows, no run-order dependency).
// Design Doc: docs/design/desktop-application-design.md (§ Data Layer Testing
// Strategy — real temp SQLite; § Quality Assurance Mechanisms — minimal Node
// test runner). Real auth behavior is proven in T1.3–T1.6; this file only proves
// the runner and the per-test isolation harness.
//
// Run via the `server` "test" script:
//   node --import tsx --test "src/**/*.int.test.ts"
// Zero new dependencies: node:test + node:assert/strict, with tsx providing the
// existing TS execution path (matches dev/start), and node:sqlite already used by
// the server (server/src/db.ts, appStore.ts).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** Create a fresh, isolated SQLite in a unique temp dir with the real `sessions`
 *  schema, plus a disposer that removes it. Each test gets its own file, so no
 *  session rows are shared and no test depends on another's execution order. */
function freshSessionDb(): { db: DatabaseSync; dispose: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'pixel-server-test-'));
  const db = new DatabaseSync(join(dir, 'pixel.db'));
  db.exec(
    'CREATE TABLE sessions (sid TEXT PRIMARY KEY, user_id TEXT NOT NULL, expires INTEGER NOT NULL)',
  );
  return {
    db,
    dispose: () => {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

test('runner executes a node:test case (lane is live)', () => {
  assert.equal(1 + 1, 2);
});

test('a test owns a fresh temp SQLite: seed, read back, and clean up', () => {
  const { db, dispose } = freshSessionDb();
  try {
    db.prepare('INSERT INTO sessions(sid, user_id, expires) VALUES(?, ?, ?)').run(
      'sid-a',
      'user-1',
      Date.now() + 60_000,
    );

    const row = db.prepare('SELECT user_id FROM sessions WHERE sid = ?').get('sid-a') as
      | { user_id: string }
      | undefined;

    assert.equal(row?.user_id, 'user-1');
  } finally {
    dispose();
  }
});

test('isolation holds regardless of order: a second fresh DB starts empty', () => {
  // If any prior test leaked rows into a shared store, this count would be > 0.
  const { db, dispose } = freshSessionDb();
  try {
    const count = db.prepare('SELECT COUNT(*) AS n FROM sessions').get() as { n: number };
    assert.equal(count.n, 0);

    db.prepare('INSERT INTO sessions(sid, user_id, expires) VALUES(?, ?, ?)').run(
      'sid-b',
      'user-2',
      Date.now() + 60_000,
    );
    const after = db.prepare('SELECT COUNT(*) AS n FROM sessions').get() as { n: number };
    assert.equal(after.n, 1);
  } finally {
    dispose();
  }
});
