/**
 * One-time conversion of stored art to four-row sheets.
 *
 * `left` is a sheet row like any other now (it used to be mirrored from `right` on every
 * load — see CHARACTER_DIRECTIONS), and the bundled files were converted by
 * `scripts/add-left-row.sh`. Rows in the database were written before that, so they are
 * converted here rather than being handled as a special case forever: the drawing path
 * should be able to assume four rows, and the way to make an assumption true is to make
 * the data true.
 *
 * Runs once, remembered in `_migrations` — the same mechanism as the split-database
 * merge in db.ts. Safe to run on a world that has nothing to do: it reads the rows,
 * finds four-row art (or no art), and writes the marker.
 *
 * A row that cannot be converted is LEFT ALONE and logged. That is the whole error
 * policy: a migration that cannot finish must not leave art half-rewritten (the layout
 * migration that once wrote 3192 holes over a real map is why this file says so out
 * loud), and a boot must not fail over housekeeping.
 */
import { db } from '../db.js';

import { PACKED_ART_TYPES, packArt, unpackArt, type PackedArtType } from './artStore.js';

const MARKER = 'art_left_row';

/** Mirror one frame horizontally — the seed for a left row nobody painted. */
function flip(frame: string[][]): string[][] {
  return frame.map((row) => row.slice().reverse());
}

/** Returns a summary line when something was converted, else null. */
export function migrateLeftRow(): string | null {
  db.exec('CREATE TABLE IF NOT EXISTS _migrations (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
  if (db.prepare('SELECT value FROM _migrations WHERE key = ?').get(MARKER)) return null;

  let converted = 0;
  const failed: string[] = [];
  // The sheet lives in its own BLOB column (see schema/movePngToBlob.ts), so both halves of a row
  // are read and both are written — repacking while writing only `data` would leave the OLD sheet
  // in the column and the row would read back as the art this migration just replaced.
  const update = db.prepare('UPDATE assets SET data = ?, png = ? WHERE type = ? AND name = ?');

  for (const type of PACKED_ART_TYPES) {
    const rows = db.prepare('SELECT name, data, png FROM assets WHERE type = ?').all(type) as Array<{
      name: string;
      data: string;
      png: Uint8Array | null;
    }>;
    for (const r of rows) {
      try {
        const stored = JSON.parse(r.data) as Record<string, unknown>;
        if (r.png) stored.png = Buffer.from(r.png.buffer, r.png.byteOffset, r.png.byteLength);
        const art = unpackArt(stored) as Record<string, unknown>;
        if (!Array.isArray(art.right) || art.right.length === 0) continue; // nothing to mirror
        if (Array.isArray(art.left) && art.left.length > 0) continue; // already four rows
        const withLeft = { ...art, left: (art.right as string[][][]).map(flip) };
        const packed = packArt(type as PackedArtType, withLeft) as Record<string, unknown>;
        const { png, ...meta } = packed;
        update.run(JSON.stringify(meta), Buffer.isBuffer(png) ? png : null, type, r.name);
        converted++;
      } catch (err) {
        failed.push(`${type}/${r.name}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  db.prepare('INSERT OR REPLACE INTO _migrations(key, value) VALUES(?, ?)').run(MARKER, String(Date.now()));
  for (const f of failed) console.warn(`[migrate] left row skipped — ${f}`);
  return converted > 0 ? `added a left row to ${converted} stored sheet(s)` : null;
}
