/**
 * Persistent chunk store — one SQLite file per world (world_<id>.sqlite in the
 * data dir), so worlds are independent files that can be created / loaded /
 * swapped (multiworld). Only chunks that differ from freshly-generated terrain
 * are stored: a chunk row exists once it's been edited (or explicitly saved).
 * Each row is the RLE-encoded cells blob (see shared encodeCells).
 */
import { DatabaseSync } from 'node:sqlite';
import { readdirSync, rmSync } from 'node:fs';

import { dataPath, dataDir } from '../paths.js';
import { MAP_LIMIT } from '@pixel/shared';

/** Ids of all persisted worlds (scans the data dir for world_<id>.sqlite). */
export function listWorlds(): string[] {
  try {
    return readdirSync(dataDir())
      .filter((f) => f.startsWith('world_') && f.endsWith('.sqlite'))
      .map((f) => f.slice('world_'.length, -'.sqlite'.length))
      .sort();
  } catch {
    return [];
  }
}

/** Delete a world's files (the .sqlite + its WAL/SHM sidecars). Returns true if the main
 *  file existed. Caller must ensure no room is currently serving that world (it would be
 *  re-persisted on the next edit). */
export function deleteWorld(id: string): boolean {
  const safe = id.replace(/[^a-z0-9_-]/gi, '_');
  let existed = false;
  for (const ext of ['.sqlite', '.sqlite-wal', '.sqlite-shm']) {
    try {
      rmSync(dataPath(`world_${safe}${ext}`));
      if (ext === '.sqlite') existed = true;
    } catch {
      /* not present */
    }
  }
  return existed;
}

export interface WorldMeta {
  seed: number;
  createdAt: number;
  gen?: number; // terrain-generation version this world was built with (see meta())
  size?: number; // square world edge in blocks (0/undefined = unbounded up to MAP_LIMIT)
}

export class ChunkStore {
  private readonly db: DatabaseSync;
  private readonly getStmt;
  private readonly setStmt;

  constructor(worldId: string) {
    const safe = worldId.replace(/[^a-z0-9_-]/gi, '_');
    this.db = new DatabaseSync(dataPath(`world_${safe}.sqlite`));
    this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec('CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
    this.db.exec(
      'CREATE TABLE IF NOT EXISTS chunks (cx INTEGER, cy INTEGER, cz INTEGER, data BLOB NOT NULL, PRIMARY KEY (cx, cy, cz))',
    );
    this.getStmt = this.db.prepare('SELECT data FROM chunks WHERE cx = ? AND cy = ? AND cz = ?');
    this.setStmt = this.db.prepare(
      'INSERT INTO chunks (cx, cy, cz, data) VALUES (?, ?, ?, ?) ON CONFLICT(cx, cy, cz) DO UPDATE SET data = excluded.data',
    );
  }

  /** World seed + creation time, created on first open. Uses `seed` if this call
   *  creates the world (else a random one); existing worlds keep their seed. If the
   *  world's stored gen version is older than `gen`, its edited chunks are wiped so the
   *  world regenerates with the current terrain (a fresh map, no manual deletion). */
  meta(seed?: number, gen = 0, size?: number): WorldMeta {
    const row = this.db.prepare("SELECT value FROM meta WHERE key = 'meta'").get() as { value: string } | undefined;
    if (row) {
      const m = JSON.parse(row.value) as WorldMeta;
      if ((m.gen ?? 0) !== gen) {
        this.db.exec('DELETE FROM chunks'); // generation changed → drop edits, regenerate fresh
        m.gen = gen;
        this.db.prepare("UPDATE meta SET value = ? WHERE key = 'meta'").run(JSON.stringify(m));
      }
      return m;
    }
    const chosen = Number.isFinite(seed) ? (seed as number) >>> 0 : (Math.random() * 0x7fffffff) | 0;
    // A brand-new world may fix a square size (edge in blocks); clamped to the map limit.
    const sz = Number.isFinite(size) && (size as number) > 0 ? Math.min(Math.floor(size as number), MAP_LIMIT * 2) : 0;
    const meta: WorldMeta = { seed: chosen, createdAt: Date.now(), gen, size: sz };
    this.db.prepare("INSERT INTO meta (key, value) VALUES ('meta', ?)").run(JSON.stringify(meta));
    return meta;
  }

  /** Stored (edited) chunk blob, or null if the chunk is still pristine terrain. */
  get(cx: number, cy: number, cz: number): Uint8Array | null {
    const row = this.getStmt.get(cx, cy, cz) as { data: Uint8Array } | undefined;
    return row ? new Uint8Array(row.data) : null;
  }

  set(cx: number, cy: number, cz: number, data: Uint8Array): void {
    this.setStmt.run(cx, cy, cz, data);
  }

  close(): void {
    this.db.close();
  }
}
