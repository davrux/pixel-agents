/**
 * Authoritative server-side voxel world for one world id. Chunks are generated
 * on demand from the seed, cached in memory, and (once edited) persisted to the
 * per-world SQLite chunk store. This is the single source of truth: the client
 * only renders streamed chunks and asks the server to place/break; the server
 * validates, mutates here, persists, and broadcasts.
 */
import { CHUNK, cellIndex, chunkKey, encodeCells, decodeCells, toChunk, toLocal } from '@pixel/shared';

import { ChunkStore } from './chunkStore.js';
import { generateChunk } from './gen.js';

export class VoxelServerWorld {
  readonly worldId: string;
  readonly seed: number;
  private readonly store: ChunkStore;
  private readonly cache = new Map<string, Uint8Array>(); // key → cells

  constructor(worldId: string) {
    this.worldId = worldId;
    this.store = new ChunkStore(worldId);
    this.seed = this.store.meta().seed;
  }

  /** A chunk's cells: from cache, else the persisted (edited) blob, else generated. */
  chunk(cx: number, cy: number, cz: number): Uint8Array {
    const key = chunkKey(cx, cy, cz);
    let cells = this.cache.get(key);
    if (cells) return cells;
    const saved = this.store.get(cx, cy, cz);
    cells = saved ? decodeCells(saved) : generateChunk(cx, cy, cz, this.seed);
    this.cache.set(key, cells);
    return cells;
  }

  getBlock(x: number, y: number, z: number): number {
    const cells = this.chunk(toChunk(x), toChunk(y), toChunk(z));
    return cells[cellIndex(toLocal(x), toLocal(y), toLocal(z))];
  }

  /** Set a block and persist the affected chunk. Returns false if unchanged. */
  setBlock(x: number, y: number, z: number, id: number): boolean {
    const cx = toChunk(x),
      cy = toChunk(y),
      cz = toChunk(z);
    const cells = this.chunk(cx, cy, cz);
    const i = cellIndex(toLocal(x), toLocal(y), toLocal(z));
    if (cells[i] === id) return false;
    cells[i] = id;
    this.store.set(cx, cy, cz, encodeCells(cells)); // durable immediately
    return true;
  }

  solid(x: number, y: number, z: number): boolean {
    return this.getBlock(x, y, z) !== 0;
  }

  /** Highest solid y at (x,z) within a sane scan range — a spawn helper. */
  columnTop(x: number, z: number): number {
    for (let y = CHUNK * 4; y >= -CHUNK; y--) if (this.solid(x, y, z)) return y;
    return 0;
  }

  close(): void {
    this.store.close();
  }
}
