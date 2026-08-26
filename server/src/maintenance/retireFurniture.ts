/**
 * Retiring the last stored furniture overrides — the data half of dropping the `furniture`
 * asset type.
 *
 * Furniture art comes from Tiled tilesets. Nothing in the client has sent a furniture save
 * since the editor was cut down to characters and NPCs, and the merge that let a stored row
 * replace a tileset's entry is gone with the type (`assetOverrides.ts`). So every remaining row
 * is inert: not "probably unused", but unreachable by construction, because no code path reads
 * that type any more.
 *
 * Two things make this different from `orphanAssets.ts`, whose delete deliberately takes no
 * backup:
 *
 *  • Some of these rows were REACHABLE until this build — a row whose id a tileset still offers
 *    was overriding that art, and the old boot prune kept exactly those on purpose. The change
 *    in what a map draws therefore happens when this build starts, not when the row is deleted;
 *    the boot line says so, because "the couch looks different" deserves a sentence somewhere.
 *  • Since it can be somebody's work rather than a leftover, a copy is written next to the
 *    database before the rows go. That replaces the orphan prune's grace period: waiting seven
 *    days would protect nothing (the rows already do nothing), while a file that can be read
 *    back protects everything.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

import { db } from '../db.js';
import { dataPath } from '../paths.js';
import type { StoredAsset } from './orphanAssets.js';

export interface FurnitureRetirement {
  /** Rows whose id a tileset still offers: until this build, these overrode that art. */
  shadowing: StoredAsset[];
  /** Rows no tileset offers any more — leftovers of art packages that came and went. */
  orphaned: StoredAsset[];
  /** Everything that goes, in the order it is reported. */
  retire: StoredAsset[];
  bytes: number;
}

/**
 * Split the stored rows into the two groups worth telling apart, and total their size.
 *
 * Both groups are deleted; the split exists because only one of them was doing anything, and a
 * boot line that cannot tell "20 KB of junk" from "the art of a piece somebody edited" is not
 * worth printing. Pure, so the guard is tested rather than hoped for (see the file header in
 * startupCleanup.ts).
 */
export function decideFurnitureRetire(rows: StoredAsset[], knownIds: Set<string>): FurnitureRetirement {
  const shadowing = rows.filter((r) => knownIds.has(r.name));
  const orphaned = rows.filter((r) => !knownIds.has(r.name));
  const retire = [...shadowing, ...orphaned];
  return { shadowing, orphaned, retire, bytes: retire.reduce((n, r) => n + r.bytes, 0) };
}

/**
 * Write the rows to a file beside the database and return its path.
 *
 * `data` is stored as text for furniture (a sprite grid and a catalog entry), but the column
 * holds a buffer for art that was packed as a PNG — so anything that is not a string is written
 * as base64 with a marker, and a reader can tell which it has.
 */
export function dumpFurnitureAssets(names: string[], stamp: string): string {
  const rows = names.map((name) => {
    const row = db.prepare('SELECT name, data, updatedAt FROM assets WHERE type = ? AND name = ?').get('furniture', name) as
      | { name: string; data: unknown; updatedAt?: unknown }
      | undefined;
    const data = row?.data;
    return {
      name,
      updatedAt: row?.updatedAt ?? null,
      encoding: typeof data === 'string' ? 'text' : 'base64',
      data: typeof data === 'string' ? data : Buffer.from((data as Buffer) ?? Buffer.alloc(0)).toString('base64'),
    };
  });
  const file = dataPath(`retired-furniture-${stamp}.json`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ type: 'furniture', retiredAt: stamp, rows }, null, 1));
  return file;
}
