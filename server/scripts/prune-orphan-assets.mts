#!/usr/bin/env -S node --import tsx
/**
 * Delete stored asset rows whose id no tileset carries any more.
 *
 * Where these come from: furniture used to be uploaded and kept in the database as
 * pixels. Art moved into Tiled tilesets, packages came and went, and the rows of a
 * removed package stayed behind — ids nothing can place, since a mapper only ever
 * paints what a tileset offers. They are not free: every one of them travels to every
 * client in the `furnitureAssetsLoaded` message on every join, because a row without
 * a file has no image to point at and must be sent as SpriteData. In this repo's dev
 * database that was 695 rows and 1.33 MB of a 1.76 MB message.
 *
 * Deletion is destructive, so this refuses to guess:
 *   • an id that is PLACED anywhere is never deleted, and reported instead —
 *     every stored zone layout and every committed .tmj is checked;
 *   • an id any tileset carries is not an orphan, whatever its age;
 *   • nothing is written without --apply, and --apply takes a VACUUM INTO backup
 *     first (the same consistent-snapshot route worldReset uses).
 *
 * Run: scripts/prune-orphan-assets.sh [--apply] [--type furniture]
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

import { db } from '../src/db.js';
import { dataPath } from '../src/paths.js';
import { loadTiledRegistry } from '../src/tiled/tiledRegistry.js';

const ROOT = new URL('../..', import.meta.url).pathname;
const APPLY = process.argv.includes('--apply');
const typeArg = process.argv.indexOf('--type');
const TYPE = typeArg >= 0 ? process.argv[typeArg + 1] : 'furniture';

/** Every id any tileset offers — the definition of "not an orphan". */
function knownIds(): Set<string> {
  const out = new Set<string>();
  for (const ts of loadTiledRegistry(ROOT).tilesets) {
    for (const tile of ts.tiles) {
      const id = tile?.props?.id;
      if (typeof id === 'string' && id) out.add(id);
    }
  }
  return out;
}

/** Where each id is placed: stored layouts first, then the committed maps. An id
 *  found here is in use even if no tileset offers it any more — that is a broken
 *  map to repair, not a row to delete. */
function placements(): Map<string, string[]> {
  const out = new Map<string, string[]>();
  const note = (id: string, where: string) => {
    const list = out.get(id) ?? [];
    if (!list.includes(where)) list.push(where);
    out.set(id, list);
  };
  for (const row of db.prepare('SELECT name, data FROM layouts').all() as Array<{ name: string; data: string }>) {
    let layout: { furniture?: Array<{ id?: string }>; decals?: Array<{ id?: string }> };
    try {
      layout = JSON.parse(row.data);
    } catch {
      continue;
    }
    for (const f of layout.furniture ?? []) if (f.id) note(f.id, `zone ${row.name}`);
    for (const d of layout.decals ?? []) if (d.id) note(d.id, `zone ${row.name}`);
  }
  const zonesDir = path.join(ROOT, 'assets', 'tiled', 'zones');
  if (fs.existsSync(zonesDir)) {
    for (const file of fs.readdirSync(zonesDir)) {
      if (!file.endsWith('.tmj') || file.endsWith('-noimport.tmj')) continue;
      const raw = fs.readFileSync(path.join(zonesDir, file), 'utf-8');
      // A .tmj refers to art by gid, not by id — but an object may carry an `id`
      // property, and a scan of the text is the cheap conservative answer: a false
      // positive keeps a row, which is the harmless direction.
      for (const m of raw.matchAll(/"value"\s*:\s*"([A-Z0-9_-]{2,})"/g)) note(m[1], file);
    }
  }
  return out;
}

const known = knownIds();
const placed = placements();
const rows = db.prepare('SELECT name, length(data) AS bytes FROM assets WHERE type = ?').all(TYPE) as Array<{
  name: string;
  bytes: number;
}>;

const orphans = rows.filter((r) => !known.has(r.name) && !placed.has(r.name));
const inUse = rows.filter((r) => !known.has(r.name) && placed.has(r.name));
const total = rows.reduce((n, r) => n + r.bytes, 0);
const freed = orphans.reduce((n, r) => n + r.bytes, 0);

console.log(`${rows.length} stored '${TYPE}' asset(s), ${(total / 1024 / 1024).toFixed(2)} MB`);
console.log(`  ${rows.length - orphans.length - inUse.length} carried by a tileset — kept`);
console.log(`  ${orphans.length} orphaned — ${(freed / 1024 / 1024).toFixed(2)} MB`);
if (inUse.length > 0) {
  console.log(`  ${inUse.length} orphaned but PLACED — kept, and worth repairing:`);
  for (const r of inUse.slice(0, 10)) console.log(`      ${r.name} in ${placed.get(r.name)!.join(', ')}`);
}
if (orphans.length === 0) {
  console.log('nothing to prune');
  process.exit(0);
}
if (!APPLY) {
  console.log(`\nexamples: ${orphans.slice(0, 8).map((r) => r.name).join(', ')}`);
  console.log('(dry run) pass --apply to delete them, which takes a database backup first');
  process.exit(0);
}

const backup = dataPath(`pixel.before-prune-${Date.now()}.db`);
db.exec(`VACUUM INTO '${backup.replace(/'/g, "''")}'`);
console.log(`\nbackup: ${backup} (${(fs.statSync(backup).size / 1024 / 1024).toFixed(1)} MB)`);
const del = db.prepare('DELETE FROM assets WHERE type = ? AND name = ?');
let n = 0;
for (const r of orphans) n += del.run(TYPE, r.name).changes as number;
console.log(`deleted ${n} row(s), ${(freed / 1024 / 1024).toFixed(2)} MB of asset data`);
console.log('Restart the server (or wait for the next asset reload) for the smaller catalog to reach clients.');
