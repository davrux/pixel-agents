/**
 * The two lists that decide whether a table may be dropped, checked against the source.
 *
 * `dropRetiredTables` deletes a table only when its name is on the retired list AND not on the
 * live one. Both lists are hand-written — they have to be, because "nothing references this table"
 * is a fact about the whole repo that a boot cannot re-derive — and a hand-written list of table
 * names is exactly the kind of thing that quietly stops matching the code. So:
 *
 *  • LIVE_TABLES is compared against every `CREATE TABLE` this server actually issues, in both
 *    directions. A table that gains a creator becomes undroppable in the same change that creates
 *    it, and a name that lingers here after its table is gone is caught too.
 *  • The lists must be disjoint. An overlap is the one combination that could delete live data.
 *  • A table on NEITHER list must survive. That asymmetry is the whole safety property: the
 *    unknown case resolves to "leave it and say so", never to "delete".
 *
 * TEST BOUNDARIES:
 *   @real-dependency: the source tree + SQLite -- Mock? NO. One half of the claim is about what
 *       the source says, so it reads the source; the other is about what a DROP does, so it drops
 *       from a throwaway database. Stubbing either would leave the test asserting my own list
 *       against itself.
 */
import { strict as assert } from 'node:assert';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { LIVE_TABLES, RETIRED_TABLES, dropRetiredTables } from './dropRetiredTables.js';

const SRC = join(import.meta.dirname, '..');

/** Every .ts file under server/src, tests excluded — a test's fixture DDL is not the schema. */
function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) sourceFiles(p, out);
    else if (entry.name.endsWith('.ts') && !entry.name.includes('.test.')) out.push(p);
  }
  return out;
}

/**
 * Table names this server creates, read out of its own CREATE TABLE statements.
 *
 * Comments are stripped first and a column list is required after the name, because this codebase
 * talks ABOUT its DDL as much as it writes it: a first version of this scan reported tables called
 * `IF`, `is` and `main`, harvested from the sentence "a store's CREATE TABLE IF NOT EXISTS is a
 * no-op" and from the `'CREATE TABLE IF NOT EXISTS main.'` prefix that a rewrite prepends.
 */
function createdTables(): Set<string> {
  const found = new Set<string>();
  for (const file of sourceFiles(SRC)) {
    const text = readFileSync(file, 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, ' ')
      .replace(/^\s*\/\/.*$/gm, ' ')
      .replace(/--.*$/gm, ' ');
    for (const m of text.matchAll(
      /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?["`]?([A-Za-z_][A-Za-z0-9_]*)["`]?\s*\(/gi,
    )) {
      // The rebuild in userForeignKeys creates a temp table by rewriting a real name; that suffix
      // is its own, not a table anybody keeps.
      if (!m[1].endsWith('__fkmig')) found.add(m[1]);
    }
  }
  return found;
}

test('LIVE_TABLES is exactly what the server creates', () => {
  const created = createdTables();
  const listed = new Set(LIVE_TABLES);
  const missing = [...created].filter((t) => !listed.has(t)).sort();
  const extra = [...listed].filter((t) => !created.has(t)).sort();
  assert.deepEqual(
    missing,
    [],
    `these tables are created by the server but not in LIVE_TABLES: ${missing.join(', ')}. ` +
      `Add them, or dropRetiredTables could one day be told to drop a live table.`,
  );
  assert.deepEqual(extra, [], `these are in LIVE_TABLES but nothing creates them: ${extra.join(', ')}`);
  assert.equal(LIVE_TABLES.length, listed.size, 'LIVE_TABLES has a duplicate entry');
});

test('nothing is on both lists', () => {
  const live = new Set(LIVE_TABLES);
  const both = RETIRED_TABLES.filter((t) => live.has(t));
  assert.deepEqual(both, [], `on both lists — this is the combination that deletes live data: ${both.join(', ')}`);
  assert.equal(RETIRED_TABLES.length, new Set(RETIRED_TABLES).size, 'RETIRED_TABLES has a duplicate entry');
});

test('a retired table goes, a live one stays, and an unknown one is left alone', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pixel-droptables-'));
  try {
    const db = new DatabaseSync(join(dir, 'test.db'));
    // One of each: a retired table with rows in it, a live table, and a table on neither list.
    db.exec(`
      CREATE TABLE dm_messages (id INTEGER PRIMARY KEY, convo TEXT, ciphertext TEXT);
      CREATE TABLE voxel_boats (world TEXT PRIMARY KEY, boats TEXT);
      CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE somebody_elses_idea (id TEXT PRIMARY KEY);
    `);
    db.prepare("INSERT INTO dm_messages(convo, ciphertext) VALUES('a', 'x')").run();
    db.prepare("INSERT INTO settings(key, value) VALUES('voiceNs', '\"v1\"')").run();

    const said: string[] = [];
    const warn = console.warn;
    console.warn = (...a: unknown[]) => void said.push(a.map(String).join(' '));
    try {
      dropRetiredTables(db);
    } finally {
      console.warn = warn;
    }

    const now = new Set(
      (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>).map((r) => r.name),
    );
    assert.equal(now.has('dm_messages'), false, 'a retired table with rows in it must still go');
    assert.equal(now.has('voxel_boats'), false);
    assert.equal(now.has('settings'), true, 'a live table was dropped');
    assert.equal(now.has('somebody_elses_idea'), true, 'a table on neither list must survive');
    assert.equal((db.prepare("SELECT value FROM settings WHERE key = 'voiceNs'").get() as { value: string }).value, '"v1"');
    assert.equal(said.length, 1, 'the unknown table should be reported exactly once');
    assert.match(said[0], /somebody_elses_idea/);

    // Second run: nothing left to do, and nothing said about the live table.
    const before = now.size;
    dropRetiredTables(db);
    assert.equal(
      (db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table'").get() as { n: number }).n,
      before,
      'a second run changed something',
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
