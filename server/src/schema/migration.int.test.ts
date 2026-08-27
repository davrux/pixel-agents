/**
 * The two migrations that bring an EXISTING world to the new shape, driven against databases built
 * to look like the old one.
 *
 * Both are one-shot, both are destructive in a small way, and both run at boot with nobody
 * watching — which is the definition of code that has to be tested rather than tried. What they
 * must get right:
 *
 *  • `ensureUserForeignKeys` rebuilds a table to add its constraint. It has to KEEP the rows that
 *    belong to real accounts and drop only the ones whose account is gone (the constraint forbids
 *    those, so there is no third option), and it has to refuse the whole job when the evidence
 *    looks broken — an empty `users` table with child rows is a half-restored database, and
 *    "delete everything" is the wrong answer to it.
 *  • `migrateUserBlobs` moves five settings blobs into two tables. Old data has shapes the new
 *    tables do not: a numeric skin index (`3` for `char_3`), a bare `{col,row}` spot, an `{}` left
 *    behind by a write with undefined coordinates. Getting these wrong sends everybody who was in
 *    the world to a random tile once, silently.
 *
 * TEST BOUNDARIES:
 *   @real-dependency: SQLite -- Mock? NO. The subject is SQL: a table rebuild, a foreign key and a
 *       transaction. Each test builds its own throwaway database with `node:sqlite` directly, so
 *       there is no shared world and no import-order dependency on the app's own connection.
 */
import { strict as assert } from 'node:assert';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const dirs: string[] = [];
process.on('exit', () => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

/** A throwaway data dir, and the modules that resolve their paths from it. */
async function freshWorld(): Promise<{ dir: string; db: DatabaseSync }> {
  const dir = mkdtempSync(join(tmpdir(), 'pixel-migration-'));
  dirs.push(dir);
  process.env.PIXEL_STREAM_DATA_DIR = dir;
  return { dir, db: new DatabaseSync(join(dir, 'pixel.db')) };
}

/** The old schema: the same tables, without a single REFERENCES clause. */
function oldShape(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE users (user_id TEXT PRIMARY KEY, username TEXT, pw_hash TEXT, pw_algo TEXT,
      is_admin INTEGER NOT NULL DEFAULT 0, agent_token TEXT NOT NULL, created_at INTEGER NOT NULL);
    CREATE TABLE sessions (sid TEXT PRIMARY KEY, user_id TEXT NOT NULL, expires INTEGER NOT NULL);
    CREATE TABLE arcade_saves (user_id TEXT, game TEXT, data BLOB NOT NULL, updated INTEGER NOT NULL,
      PRIMARY KEY (user_id, game));
    CREATE TABLE zone_admins (zone_id TEXT NOT NULL, user_id TEXT NOT NULL, PRIMARY KEY (zone_id, user_id));
    CREATE TABLE zone_acl (zone_id TEXT NOT NULL, user_id TEXT NOT NULL, PRIMARY KEY (zone_id, user_id));
    CREATE TABLE meeting_rooms (slug TEXT PRIMARY KEY, owner_id TEXT NOT NULL, label TEXT NOT NULL DEFAULT '',
      created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, pw_hash TEXT);
    CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  `);
}

function addUser(db: DatabaseSync, id: string): void {
  db.prepare('INSERT INTO users(user_id, agent_token, created_at) VALUES(?, ?, ?)').run(id, `tok-${id}`, 0);
}

function count(db: DatabaseSync, sql: string): number {
  return Number((db.prepare(sql).get() as { n: number }).n);
}

test('the rebuild adds the constraint, keeps real rows and drops only the ownerless ones', async () => {
  const { dir, db } = await freshWorld();
  const { ensureUserForeignKeys } = await import('./userForeignKeys.js');
  oldShape(db);
  addUser(db, 'ann');
  // Ann's rows, and rows belonging to two accounts that are already gone.
  db.prepare('INSERT INTO sessions(sid, user_id, expires) VALUES(?, ?, ?)').run('sid-ann', 'ann', 9e12);
  db.prepare('INSERT INTO sessions(sid, user_id, expires) VALUES(?, ?, ?)').run('sid-ghost', 'ghost', 9e12);
  db.prepare('INSERT INTO arcade_saves(user_id, game, data, updated) VALUES(?, ?, ?, ?)').run('ghost', 'doom', new Uint8Array([1]), 0);
  db.prepare('INSERT INTO meeting_rooms(slug, owner_id, created_at, expires_at) VALUES(?, ?, ?, ?)').run('r1', 'gone', 0, 9e12);
  db.prepare('INSERT INTO zone_admins(zone_id, user_id) VALUES(?, ?)').run('uponu', 'ann');

  ensureUserForeignKeys(db);

  const fks = db.prepare('PRAGMA foreign_key_list(sessions)').all() as Array<{ table?: string; on_delete?: string }>;
  assert.equal(fks.length, 1, 'sessions should reference exactly one parent');
  assert.equal(fks[0].table, 'users');
  assert.equal((fks[0].on_delete ?? '').toUpperCase(), 'CASCADE');

  assert.equal(count(db, "SELECT COUNT(*) AS n FROM sessions WHERE user_id = 'ann'"), 1, "ann's session was collateral damage");
  assert.equal(count(db, 'SELECT COUNT(*) AS n FROM sessions'), 1, 'the ownerless session is still there');
  assert.equal(count(db, 'SELECT COUNT(*) AS n FROM arcade_saves'), 0);
  assert.equal(count(db, 'SELECT COUNT(*) AS n FROM meeting_rooms'), 0);
  assert.equal(count(db, 'SELECT COUNT(*) AS n FROM zone_admins'), 1, "ann's grant survived");

  // Indexes named in the DDL come back — dropping a table drops them with it.
  const idx = db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'meeting_rooms'").all() as Array<{ name: string }>;
  assert.ok(idx.some((i) => i.name === 'meeting_rooms_owner'), 'the owner index was not recreated');

  // A snapshot was written before anything was deleted, and the schema is sound afterwards.
  assert.ok(readdirSync(dir).some((f) => f.startsWith('pixel-before-fk-')), 'no backup was written');
  assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);

  // And the cascade works, which is the whole point.
  db.prepare('DELETE FROM users WHERE user_id = ?').run('ann');
  assert.equal(count(db, 'SELECT COUNT(*) AS n FROM sessions'), 0);
  assert.equal(count(db, 'SELECT COUNT(*) AS n FROM zone_admins'), 0);

  // Second run: nothing to do, and it must not write another backup.
  const backupsBefore = readdirSync(dir).filter((f) => f.startsWith('pixel-before-fk-')).length;
  ensureUserForeignKeys(db);
  assert.equal(readdirSync(dir).filter((f) => f.startsWith('pixel-before-fk-')).length, backupsBefore, 'it ran twice');
});

test('an empty users table with child rows is refused, not treated as "everything is an orphan"', async () => {
  const { dir, db } = await freshWorld();
  const { ensureUserForeignKeys } = await import('./userForeignKeys.js');
  oldShape(db);
  // No accounts at all, but rows that belong to some. A half-restored database looks exactly
  // like this, and deleting the lot would be the one unrecoverable answer.
  db.prepare('INSERT INTO sessions(sid, user_id, expires) VALUES(?, ?, ?)').run('sid', 'somebody', 9e12);
  db.prepare('INSERT INTO meeting_rooms(slug, owner_id, created_at, expires_at) VALUES(?, ?, ?, ?)').run('r', 'somebody', 0, 9e12);

  ensureUserForeignKeys(db);

  assert.equal(count(db, 'SELECT COUNT(*) AS n FROM sessions'), 1, 'rows were deleted on broken evidence');
  assert.equal(count(db, 'SELECT COUNT(*) AS n FROM meeting_rooms'), 1);
  assert.equal((db.prepare('PRAGMA foreign_key_list(sessions)').all() as unknown[]).length, 0, 'it should have stood down');
  // It stood down BEFORE the destructive part, so there is not even a snapshot: the evidence
  // check comes first on purpose. And nothing recorded the job as done — the check is stateless,
  // so a repaired deployment simply succeeds on the next boot.
  assert.deepEqual(readdirSync(dir).filter((f) => f.startsWith('pixel-before-fk-')), []);
});

test('the settings blobs move into the tables, old shapes and all', async () => {
  const { db } = await freshWorld();
  const { ensureUserForeignKeys } = await import('./userForeignKeys.js');
  const { migrateUserBlobs } = await import('./migrateUserBlobs.js');
  const { PREF_KINDS, userChildDdl } = await import('./tables.js');
  oldShape(db);
  for (const id of ['ann', 'bo', 'cy']) addUser(db, id);
  ensureUserForeignKeys(db);
  db.exec(userChildDdl('player_pos'));
  db.exec(userChildDdl('user_prefs'));

  const put = (key: string, value: unknown): void => {
    db.prepare('INSERT INTO settings(key, value) VALUES(?, ?)').run(key, JSON.stringify(value));
  };
  // A numeric skin index is what a pref written long ago holds; junk and negatives are dropped.
  put('charPrefs', { ann: 3, bo: 'char_5', cy: -1, ghost: 'char_2' });
  put('playerPrefs', { ann: 'char_1' });
  put('viewerSettings', { ann: { soundEnabled: false, alertVolume: 0.5 }, ghost: { soundEnabled: false } });
  put('playerPos', {
    'ann|uponu': { col: 4, row: 7, dir: 1, pointId: 'chair-1', sit: true },
    'bo|uponu': { col: 2, row: 2 }, // a bare tile: what the build before last wrote
    'cy|uponu': {}, // what a write with undefined coordinates left behind
    'ghost|uponu': { col: 1, row: 1 },
  });
  put('spectatorPrefs', { ann: true });
  put('voiceNs', 'v12345678');

  migrateUserBlobs(db);

  const pref = (user: string, kind: string): string | undefined =>
    (db.prepare('SELECT value FROM user_prefs WHERE user_id = ? AND kind = ?').get(user, kind) as { value: string } | undefined)?.value;
  assert.equal(pref('ann', PREF_KINDS.charSkin), 'char_3', 'a numeric index always meant char_N');
  assert.equal(pref('bo', PREF_KINDS.charSkin), 'char_5');
  assert.equal(pref('cy', PREF_KINDS.charSkin), undefined, 'the old "-1 = random" is not a skin');
  assert.equal(pref('ghost', PREF_KINDS.charSkin), undefined, 'an account that no longer exists brings nothing');
  assert.equal(pref('ann', PREF_KINDS.playerSkin), 'char_1');
  assert.deepEqual(JSON.parse(pref('ann', PREF_KINDS.viewer) ?? '{}'), { soundEnabled: false, alertVolume: 0.5 });

  // Spread into a plain object: node:sqlite hands back null-prototype rows, which deepEqual
  // compares as different from an object literal even when every value matches.
  const spot = (user: string): Record<string, unknown> | undefined => {
    const row = db
      .prepare('SELECT col, row, dir, point_id, sit FROM player_pos WHERE user_id = ? AND zone = ?')
      .get(user, 'uponu') as Record<string, unknown> | undefined;
    return row ? { ...row } : undefined;
  };
  assert.deepEqual(spot('ann'), { col: 4, row: 7, dir: 1, point_id: 'chair-1', sit: 1 });
  assert.deepEqual(spot('bo'), { col: 2, row: 2, dir: 0, point_id: null, sit: 0 }, 'a bare tile keeps its tile');
  assert.equal(spot('cy'), undefined, 'an empty object was never a position');
  assert.equal(spot('ghost'), undefined);

  // The blobs are gone; everything else in `settings` is untouched.
  assert.equal(
    count(db, `SELECT COUNT(*) AS n FROM settings WHERE key IN ('playerPos','charPrefs','playerPrefs','viewerSettings','spectatorPrefs')`),
    0,
    'a blob left behind would be read by nothing and confuse the next reader',
  );
  assert.equal((db.prepare("SELECT value FROM settings WHERE key = 'voiceNs'").get() as { value: string }).value, '"v12345678"');

  // Idempotent: a second run finds the marker and does nothing, even if a blob reappeared.
  put('charPrefs', { ann: 'char_9' });
  migrateUserBlobs(db);
  assert.equal(pref('ann', PREF_KINDS.charSkin), 'char_3', 'it ran a second time');
});

test('a table with the constraint but the wrong column type is still rebuilt', async () => {
  const { db } = await freshWorld();
  const { ensureUserForeignKeys } = await import('./userForeignKeys.js');
  oldShape(db);
  addUser(db, 'ann');
  // player_pos as an earlier build wrote it: the cascade is already there, but `dir` is TEXT.
  // SQLite would then store Direction.LEFT (1) as the string '1' and the reader would reject it,
  // so every resumed player faces DOWN — with the right number in the database. A check that only
  // asked about the foreign key would consider this table finished.
  db.exec(`
    CREATE TABLE player_pos (
      user_id TEXT NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
      zone TEXT NOT NULL, col INTEGER NOT NULL, row INTEGER NOT NULL, dir TEXT NOT NULL,
      point_id TEXT, sit INTEGER NOT NULL DEFAULT 0, afk INTEGER NOT NULL DEFAULT 0,
      updated_at INTEGER NOT NULL, PRIMARY KEY (user_id, zone))`);
  db.prepare(
    `INSERT INTO player_pos(user_id, zone, col, row, dir, sit, afk, updated_at)
       VALUES('ann', 'uponu', 3, 4, 1, 0, 0, 0)`,
  ).run();

  const dirType = (): string =>
    (db.prepare('PRAGMA table_info(player_pos)').all() as Array<{ name: string; type: string }>).find((c) => c.name === 'dir')
      ?.type ?? '';
  assert.equal(dirType(), 'TEXT', 'the fixture is meant to start out wrong');
  // And this is the damage, before the fix: the 1 that went in comes back as text.
  assert.equal(typeof (db.prepare("SELECT dir FROM player_pos WHERE user_id = 'ann'").get() as { dir: unknown }).dir, 'string');

  ensureUserForeignKeys(db);

  assert.equal(dirType(), 'INTEGER', 'the column type was left wrong');
  const row = db.prepare("SELECT col, row, dir FROM player_pos WHERE user_id = 'ann'").get() as Record<string, unknown>;
  assert.deepEqual({ ...row }, { col: 3, row: 4, dir: 1 }, 'the rebuild must carry the rows over, converted');
});

test('a fresh world needs no rebuild, and a second run is a no-op', async () => {
  const { db } = await freshWorld();
  const { ensureUserForeignKeys } = await import('./userForeignKeys.js');
  const { migrateUserBlobs } = await import('./migrateUserBlobs.js');
  const { USERS_DDL } = await import('./tables.js');
  db.exec(USERS_DDL);
  db.exec('CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)');

  ensureUserForeignKeys(db);
  migrateUserBlobs(db);

  // No child table exists yet (their stores create them, with the constraint already in the DDL),
  // so there was nothing to rebuild and nothing was written.
  assert.equal(count(db, "SELECT COUNT(*) AS n FROM sqlite_master WHERE name LIKE '%__fkmig'"), 0, 'a temp table was left behind');
  assert.ok(db.prepare("SELECT value FROM _migrations WHERE key = 'user_blobs_to_tables'").get(), 'the blob move is marker-guarded and was not recorded');
});
