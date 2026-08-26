/**
 * Retiring the stored furniture overrides: the split it reports, and the copy it owes.
 *
 * This deletes rows that were REACHABLE until the build that removed the `furniture` asset
 * type — a row whose id a tileset still offers was overriding that art, and the prune this
 * replaced kept exactly those on purpose. So two properties matter, and neither is about the
 * SQL: that the boot can still say which rows had been doing something (a line reading
 * "retired 40 rows" tells an operator nothing about whether a map just changed), and that the
 * copy exists and can be read back before anything is deleted.
 *
 * TEST BOUNDARIES:
 *   @real-dependency: appStore + SQLite -- Mock? NO. The point is that rows leave the real
 *       table and that the dump reads what was actually stored. A throwaway
 *       PIXEL_STREAM_DATA_DIR keeps it away from a developer's world, which is why the
 *       store is imported dynamically (db.ts resolves that path at module load).
 */
import { strict as assert } from 'node:assert';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const dir = mkdtempSync(join(tmpdir(), 'pixel-retire-'));
process.env.PIXEL_STREAM_DATA_DIR = dir;
const { appStore } = await import('./appStore.js');
const { decideFurnitureRetire, dumpFurnitureAssets } = await import('./maintenance/retireFurniture.js');
const { deleteAssets, storedAssets } = await import('./maintenance/orphanAssets.js');
process.on('exit', () => rmSync(dir, { recursive: true, force: true }));

const row = (name: string, bytes = 10): { name: string; bytes: number; updatedAt: number } => ({
  name,
  bytes,
  updatedAt: Date.now(),
});

test('the split says which rows had been overriding tileset art', () => {
  const known = new Set(['SOFA_BACK', 'DESK_FRONT']);
  const d = decideFurnitureRetire([row('SOFA_BACK', 100), row('OLD_PACK_CRATE', 20), row('DESK_FRONT', 5)], known);
  assert.deepEqual(d.shadowing.map((r) => r.name), ['SOFA_BACK', 'DESK_FRONT']);
  assert.deepEqual(d.orphaned.map((r) => r.name), ['OLD_PACK_CRATE']);
  assert.equal(d.retire.length, 3, 'both groups go — the difference is only what is reported');
  assert.equal(d.bytes, 125);
});

test('with no tileset registry everything still goes, it just cannot be described', () => {
  // Refusing here would be the wrong instinct: the rows are inert whatever the registry says,
  // so waiting for a fixed deployment would keep dead weight around for nothing.
  const d = decideFurnitureRetire([row('SOFA_BACK'), row('OLD_PACK_CRATE')], new Set());
  assert.equal(d.retire.length, 2);
  assert.equal(d.shadowing.length, 0, 'nothing can be claimed as still-in-use');
  assert.equal(d.orphaned.length, 2);
});

test('nothing stored is not an event', () => {
  const d = decideFurnitureRetire([], new Set(['SOFA_BACK']));
  assert.deepEqual({ n: d.retire.length, bytes: d.bytes }, { n: 0, bytes: 0 });
});

test('the copy holds what was stored, and the rows really leave the table', () => {
  appStore.saveAsset('furniture', 'SOFA_BACK', { sprite: [['#ff0000']], catalog: { footprintW: 2, footprintH: 1 } });
  appStore.saveAsset('furniture', 'OLD_PACK_CRATE', { sprite: [['#00ff00']] });
  assert.equal(storedAssets('furniture').length, 2, 'the fixture must actually be in the table');

  const file = dumpFurnitureAssets(['SOFA_BACK', 'OLD_PACK_CRATE'], 'test-stamp');
  const dump = JSON.parse(readFileSync(file, 'utf-8')) as {
    type: string;
    rows: Array<{ name: string; encoding: string; data: string }>;
  };
  assert.equal(dump.type, 'furniture');
  assert.deepEqual(dump.rows.map((r) => r.name).sort(), ['OLD_PACK_CRATE', 'SOFA_BACK']);
  // Readable back, not just present: the whole point of the copy is that somebody can restore
  // a piece of art from it.
  const sofa = dump.rows.find((r) => r.name === 'SOFA_BACK')!;
  const restored = sofa.encoding === 'text' ? JSON.parse(sofa.data) : null;
  assert.deepEqual((restored as { sprite: string[][] }).sprite, [['#ff0000']], 'the art must survive the dump');
  assert.ok(readdirSync(dir).some((f) => f.startsWith('retired-furniture-')), 'the copy lands beside the database');

  const { deleted } = deleteAssets('furniture', ['SOFA_BACK', 'OLD_PACK_CRATE']);
  assert.equal(deleted, 2);
  assert.deepEqual(storedAssets('furniture'), [], 'and the table is clean afterwards');
});

test('a row that is not there produces an entry rather than a crash', () => {
  // The task hands over names it just read, but a concurrent delete is possible and a dump
  // that throws would take the copy — and with it the delete — down with it.
  const file = dumpFurnitureAssets(['NEVER_STORED'], 'missing-stamp');
  const dump = JSON.parse(readFileSync(file, 'utf-8')) as { rows: Array<{ name: string; data: string }> };
  assert.equal(dump.rows.length, 1);
  assert.equal(dump.rows[0].name, 'NEVER_STORED');
});
