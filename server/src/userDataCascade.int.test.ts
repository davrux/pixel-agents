/**
 * Deleting an account deletes everything that belonged to it — and this test is the reason that
 * stays true.
 *
 * It used to be a list of DELETEs at each call site, and the two call sites had already drifted:
 * the `/delete` slash command forgot the user's meeting rooms where `DELETE /admin/users/:id`
 * removed them. Nothing failed; rows just stayed. Measured on this repo's own dev world
 * 2026-08-27, 22 rows belonged to accounts that no longer existed — arcade saves, voxel rows, a
 * zone_customers entry, a meeting room. Two of those tables hold personal data.
 *
 * So the rule moved into the schema (`ON DELETE CASCADE`, see schema/tables.ts), and what this
 * file asserts is the part a schema cannot assert about itself:
 *
 *  1. **Every account-owned table really carries the constraint.** Read back from SQLite, not from
 *     the DDL string — a fresh database gets it from the store, an upgraded one from a rebuild, and
 *     the two must agree.
 *  2. **No table has an unconstrained account column.** This is the one that catches the FUTURE:
 *     a table added later with a `user_id` fails here until it either cascades or is named below
 *     with the reason it does not. Without this, the next table repeats the whole story.
 *  3. **A delete really empties them.** End to end, through `userStore.deleteUser`, with a row in
 *     every table first — because a constraint that is declared but not enforced (SQLite needs
 *     `PRAGMA foreign_keys`, and it is per-connection) would satisfy 1 and 2 and delete nothing.
 *
 * TEST BOUNDARIES:
 *   @real-dependency: SQLite + every store -- Mock? NO. The claim is about what the database does
 *       when a row is deleted; there is nothing here to stub that would not just restate my
 *       assumption. A throwaway PIXEL_STREAM_DATA_DIR keeps it off a developer's world.
 */
import { strict as assert } from 'node:assert';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const dir = mkdtempSync(join(tmpdir(), 'pixel-cascade-'));
process.env.PIXEL_STREAM_DATA_DIR = dir;
process.on('exit', () => rmSync(dir, { recursive: true, force: true }));

const { db } = await import('./db.js');
const { appStore } = await import('./appStore.js');
const { userStore } = await import('./userStore.js');
const { ZoneStore } = await import('./zoneStore.js');
const { meetingRoomStore } = await import('./meetingRoomStore.js');
const { arcadeSaves } = await import('./arcadeSaveStore.js');
const { PREF_KINDS, USER_CHILD_TABLES } = await import('./schema/tables.js');
const { DEFAULT_ZONE } = await import('@pixel/shared');
const { Direction } = await import('@pixel/shared/office/types.js');

const zones = new ZoneStore();

/**
 * Columns that name an account. A table carrying one of these either cascades or is excused
 * below — the check is by NAME because that is what a table added next year will use.
 */
const ACCOUNT_COLUMNS = ['user_id', 'owner_id', 'from_user', 'uploaded_by'];

/** Tables allowed to hold an account column without a cascading foreign key, each with why. */
const NOT_CASCADED: Record<string, string> = {
  // The parent itself.
  users: 'is the account',
  // Deleting the owner must not delete the zone — it becomes ownerless. SET NULL semantics,
  // spelled out as an explicit UPDATE in zoneStore.disownZonesOf.
  zones: 'owner survives as NULL, see disownZonesOf',
};

function columnsOf(table: string): string[] {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((c) => c.name);
}

function cascadesFor(table: string): Set<string> {
  const fks = db.prepare(`PRAGMA foreign_key_list(${table})`).all() as Array<{
    table?: string;
    from?: string;
    on_delete?: string;
  }>;
  return new Set(
    fks
      .filter((fk) => fk.table === 'users' && (fk.on_delete ?? '').toUpperCase() === 'CASCADE')
      .map((fk) => fk.from ?? ''),
  );
}

test('the connection actually enforces foreign keys', () => {
  // node:sqlite's DatabaseSync switches this on by default. If that ever changes, every cascade
  // in this file becomes decoration and nothing else would notice.
  const r = db.prepare('PRAGMA foreign_keys').get() as { foreign_keys?: number };
  assert.equal(r?.foreign_keys, 1, 'foreign keys are off — declared cascades would do nothing');
});

test('every account-owned table declares ON DELETE CASCADE', () => {
  for (const spec of USER_CHILD_TABLES) {
    const cols = columnsOf(spec.table);
    assert.ok(cols.length > 0, `${spec.table} does not exist — a store should have created it`);
    assert.ok(cols.includes(spec.column), `${spec.table} has no ${spec.column} column`);
    assert.ok(
      cascadesFor(spec.table).has(spec.column),
      `${spec.table}.${spec.column} holds ${spec.holds} but does not cascade when the account goes`,
    );
  }
});

test('no other table keeps an account column without saying why', () => {
  const tables = (
    db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all() as Array<{
      name: string;
    }>
  ).map((r) => r.name);
  const owned = new Set(USER_CHILD_TABLES.map((s) => s.table));

  for (const table of tables) {
    if (owned.has(table) || table in NOT_CASCADED) continue;
    const account = columnsOf(table).filter((c) => ACCOUNT_COLUMNS.includes(c));
    assert.deepEqual(
      account,
      [],
      `${table} has account column(s) ${account.join(', ')} with no cascade. Add it to ` +
        `USER_CHILD_TABLES (schema/tables.ts) so deleting a user deletes its rows, or to ` +
        `NOT_CASCADED here with the reason it must survive.`,
    );
  }
});

test('deleting an account leaves nothing of it behind, in any table', () => {
  const id = 'cascade-victim';
  const other = 'cascade-bystander';
  userStore.createUser(id, 'password-123', {});
  userStore.createUser(other, 'password-123', {});

  // One row in every account-owned table, written the way the product writes it.
  const session = appStore.createSession(id);
  appStore.setCharPref(id, 'char_3');
  appStore.setViewerSetting(id, 'iframeOverlay', true);
  appStore.setPlayerSpot(id, DEFAULT_ZONE, { col: 3, row: 4, dir: Direction.LEFT });
  arcadeSaves.set(id, 'doom', new Uint8Array([1, 2, 3]));
  zones.setZoneAdmin(DEFAULT_ZONE, id, true);
  zones.aclAdd(DEFAULT_ZONE, id);
  meetingRoomStore.create(id, 60_000, { label: 'Mine' });
  // And one for the bystander, so this proves a DELETE aimed at one account, not a truncate.
  appStore.setCharPref(other, 'char_4');
  const bystanderSession = appStore.createSession(other);

  const rowsFor = (who: string): Record<string, number> => {
    const out: Record<string, number> = {};
    for (const spec of USER_CHILD_TABLES) {
      const r = db.prepare(`SELECT COUNT(*) AS n FROM ${spec.table} WHERE ${spec.column} = ?`).get(who) as { n: number };
      out[spec.table] = Number(r.n);
    }
    return out;
  };

  const before = rowsFor(id);
  for (const [table, n] of Object.entries(before)) {
    assert.ok(n > 0, `nothing was stored in ${table}, so its cascade would be untested`);
  }
  assert.equal(appStore.getSession(session)?.userId, id);

  assert.equal(userStore.deleteUser(id), true);

  assert.deepEqual(
    rowsFor(id),
    Object.fromEntries(USER_CHILD_TABLES.map((s) => [s.table, 0])),
    'rows survived the account they belong to',
  );
  // Reading through the stores agrees with reading the tables.
  assert.equal(appStore.getSession(session), undefined, 'a session outliving its account is a live credential');
  assert.equal(appStore.getPlayerSpot(id, DEFAULT_ZONE), null);
  assert.equal(appStore.getCharPref(id), null);
  assert.equal(zones.listZoneAdmins(DEFAULT_ZONE).includes(id), false);
  assert.equal(zones.listAcl(DEFAULT_ZONE).includes(id), false);
  assert.equal(meetingRoomStore.listByOwner(id).length, 0, 'the room outlived its owner');
  assert.equal(arcadeSaves.get(id, 'doom'), null);

  // The bystander is untouched.
  assert.equal(appStore.getCharPref(other), 'char_4');
  assert.equal(appStore.getSession(bystanderSession)?.userId, other);
});

test('a preference or position for an account that does not exist is refused, not stored', () => {
  // The other direction of the same constraint, and the reason both write paths swallow the
  // failure: they run from a message handler and from the tick, where an exception is a crash.
  appStore.setCharPref('never-existed', 'char_1');
  appStore.setPlayerSpot('never-existed', DEFAULT_ZONE, { col: 1, row: 1, dir: Direction.DOWN });
  assert.equal(appStore.getCharPref('never-existed'), null);
  assert.equal(appStore.getPlayerSpot('never-existed', DEFAULT_ZONE), null);
  const r = db.prepare('SELECT COUNT(*) AS n FROM user_prefs WHERE kind = ?').get(PREF_KINDS.charSkin) as { n: number };
  assert.ok(Number(r.n) >= 0);
});

test('a spot write touches one row, whatever the world has stored', () => {
  // The shape that made this a table rather than a blob. The old code parsed and rewrote every
  // stored position on every checkpoint — 5.3 ms per write at ten thousand of them, on the tick
  // thread. Asserted structurally rather than by timing, which under parallel test load measures
  // the machine and not the code.
  userStore.createUser('spot-writer', 'password-123', {});
  const insert = db.prepare(
    `INSERT INTO player_pos(user_id, zone, col, row, dir, point_id, sit, afk, updated_at)
       VALUES('spot-writer', ?, 1, 1, 0, NULL, 0, 0, 0)`,
  );
  for (let i = 0; i < 2000; i++) insert.run(`zone-${i}`);

  const count = (): number => Number((db.prepare('SELECT COUNT(*) AS n FROM player_pos').get() as { n: number }).n);
  const before = count();
  appStore.setPlayerSpot('spot-writer', 'a-new-zone', { col: 9, row: 9, dir: Direction.UP });
  assert.equal(count(), before + 1, 'one write must add one row');
  appStore.setPlayerSpot('spot-writer', 'a-new-zone', { col: 8, row: 8, dir: Direction.UP });
  assert.equal(count(), before + 1, 'a second write to the same zone must update, not append');
  assert.deepEqual(appStore.getPlayerSpot('spot-writer', 'a-new-zone'), { col: 8, row: 8, dir: Direction.UP });

  // And the blob it replaced is gone for good, not written alongside.
  const blobs = db
    .prepare(
      `SELECT COUNT(*) AS n FROM settings
        WHERE key IN ('playerPos','charPrefs','playerPrefs','viewerSettings','spectatorPrefs')`,
    )
    .get() as { n: number };
  assert.equal(Number(blobs.n), 0, 'a per-user settings blob is being written again');
});
