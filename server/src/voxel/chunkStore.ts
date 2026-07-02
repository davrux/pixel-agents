/**
 * Persistent chunk store — one SQLite file per world (world_<id>.sqlite in the
 * data dir), so worlds are independent files that can be created / loaded /
 * swapped (multiworld). Only chunks that differ from freshly-generated terrain
 * are stored: a chunk row exists once it's been edited (or explicitly saved).
 * Each row is the RLE-encoded cells blob (see shared encodeCells).
 */
import { DatabaseSync } from 'node:sqlite';

import { dataPath } from '../paths.js';

export interface WorldMeta {
  seed: number;
  createdAt: number;
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
   *  creates the world (else a random one); existing worlds keep their seed. */
  meta(seed?: number): WorldMeta {
    const row = this.db.prepare("SELECT value FROM meta WHERE key = 'meta'").get() as { value: string } | undefined;
    if (row) return JSON.parse(row.value) as WorldMeta;
    const chosen = Number.isFinite(seed) ? (seed as number) >>> 0 : (Math.random() * 0x7fffffff) | 0;
    const meta: WorldMeta = { seed: chosen, createdAt: Date.now() };
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
