/**
 * Client voxel world — chunk-based. Chunks (CHUNK^3 block ids) are streamed from
 * the authoritative server and applied via setChunk/dropChunk; get/set/solid look
 * blocks up by chunk. Unloaded space reads as air. A small local fallback lets the
 * page still show terrain when run offline (no server) during dev.
 */
import { AIR } from './blocks.js';
import { CHUNK, CHUNK_VOL, cellIndex, chunkKey, toChunk, toLocal, isWaterId } from '@pixel/shared';

export class VoxelWorld {
  private readonly chunks = new Map<string, Uint8Array>();

  hasChunk(cx: number, cy: number, cz: number): boolean {
    return this.chunks.has(chunkKey(cx, cy, cz));
  }
  /** Keys of all loaded chunks ("cx,cy,cz") — used to (re)mesh once the atlas is ready. */
  keys(): string[] {
    return [...this.chunks.keys()];
  }
  setChunk(cx: number, cy: number, cz: number, cells: Uint8Array): void {
    this.chunks.set(chunkKey(cx, cy, cz), cells);
  }
  dropChunk(cx: number, cy: number, cz: number): void {
    this.chunks.delete(chunkKey(cx, cy, cz));
  }
  /** Forget all chunks (used when switching worlds). */
  clear(): void {
    this.chunks.clear();
  }

  get(x: number, y: number, z: number): number {
    const c = this.chunks.get(chunkKey(toChunk(x), toChunk(y), toChunk(z)));
    return c ? c[cellIndex(toLocal(x), toLocal(y), toLocal(z))] : AIR;
  }
  /** Set a block — only within a loaded chunk (edits target loaded space). */
  set(x: number, y: number, z: number, id: number): void {
    const c = this.chunks.get(chunkKey(toChunk(x), toChunk(y), toChunk(z)));
    if (c) c[cellIndex(toLocal(x), toLocal(y), toLocal(z))] = id;
  }
  /** Solid = blocks the player. Water (source or flowing) is NOT solid. */
  solid(x: number, y: number, z: number): boolean {
    const id = this.get(x, y, z);
    return id !== AIR && !isWaterId(id);
  }
  /** True where the cell is water (source or flowing) — swim physics + animation. */
  water(x: number, y: number, z: number): boolean {
    return isWaterId(this.get(x, y, z));
  }

  /** Highest solid y at (x,z) among loaded chunks — spawn / ground probe. Skips
   *  water so spawn lands on the lakebed/shore, not floating on the surface. */
  columnTop(x: number, z: number): number {
    for (let y = CHUNK * 4; y >= -CHUNK * 2; y--) if (this.solid(x, y, z)) return y;
    return 0;
  }

  /** Offline dev fallback: a small hand-generated region so the page isn't empty
   *  without a server. Mirrors the server's grass/dirt/stone layering roughly. */
  generateLocalFallback(): void {
    const hAt = (x: number, z: number): number =>
      Math.round(14 + Math.sin(x * 0.18) * 2.2 + Math.cos(z * 0.15) * 2 + Math.sin((x + z) * 0.07) * 3);
    for (let cx = -3; cx <= 3; cx++) {
      for (let cz = -3; cz <= 3; cz++) {
        for (let cy = -1; cy <= 1; cy++) {
          const cells = new Uint8Array(CHUNK_VOL);
          for (let lz = 0; lz < CHUNK; lz++) {
            for (let lx = 0; lx < CHUNK; lx++) {
              const h = hAt(cx * CHUNK + lx, cz * CHUNK + lz);
              for (let ly = 0; ly < CHUNK; ly++) {
                const wy = cy * CHUNK + ly;
                let id = AIR;
                if (wy < 0 || wy < h - 4) id = 3; // stone
                else if (wy < h) id = 2; // dirt
                else if (wy === h) id = 1; // grass
                if (id !== AIR) cells[cellIndex(lx, ly, lz)] = id;
              }
            }
          }
          this.setChunk(cx, cy, cz, cells);
        }
      }
    }
  }
}
