/**
 * Mesh worker — moves the expensive per-chunk work (light BFS ≈ 68% + geometry ≈ 32%,
 * ~5ms/chunk) OFF the main thread, so streaming/flying never hitches the render loop.
 *
 * It owns its own VoxelWorld mirror, fed the same chunk/edit/unload stream the main
 * thread applies to its copy. On any change it re-meshes the affected chunk (+ its
 * neighbours, for seam-correct face culling) and posts the raw geometry buffers back
 * as transferables; the main thread only assembles a BufferGeometry and uploads it.
 *
 * Deliberately THREE-free and DOM-free (mesher/world/light are plain logic) — the atlas
 * is a lightweight rect-only stub built from the name→rect map the main thread sends.
 */
import { VoxelWorld } from './world.js';
import { computeChunkLight, invalidateLight, clearLightCache } from './light.js';
import { buildChunkBuffers, type ChunkBuffers } from './mesher.js';
import type { Atlas, AtlasRect } from './textures.js';
import { chunkKey, toChunk } from '@pixel/shared';

// Minimal dedicated-worker global typing (avoids pulling the "webworker" lib, which
// would clash with the DOM lib the rest of the client uses).
interface WorkerCtx {
  postMessage(message: unknown, transfer?: Transferable[]): void;
  onmessage: ((e: MessageEvent) => void) | null;
}
const ctx = self as unknown as WorkerCtx;

type InMsg =
  | { t: 'rects'; rects: Record<string, AtlasRect> }
  | { t: 'chunk'; cx: number; cy: number; cz: number; cells: Uint8Array }
  | { t: 'edit'; x: number; y: number; z: number; id: number }
  | { t: 'unload'; cx: number; cy: number; cz: number }
  | { t: 'clear' };

const world = new VoxelWorld();
const dirty = new Set<string>();
let atlas: Atlas | null = null;

const NEIGHBORS = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];
function markDirty(cx: number, cy: number, cz: number): void {
  dirty.add(chunkKey(cx, cy, cz));
  for (const [dx, dy, dz] of NEIGHBORS) if (world.hasChunk(cx + dx, cy + dy, cz + dz)) dirty.add(chunkKey(cx + dx, cy + dy, cz + dz));
}

let flushing = false;
function scheduleFlush(): void {
  if (!flushing) {
    flushing = true;
    setTimeout(flush, 0);
  }
}
/** Mesh dirty chunks, posting each result. Yields (re-schedules) every ~12ms so a big
 *  burst doesn't monopolise the worker and freeze incoming messages — results still
 *  stream to the main thread progressively. Blocking the WORKER is harmless to the UI. */
function flush(): void {
  flushing = false;
  if (!atlas) return; // rects not received yet — keep the dirty set, flush once they are
  const start = Date.now();
  for (const key of dirty) {
    dirty.delete(key);
    const [cx, cy, cz] = key.split(',').map(Number);
    if (!world.hasChunk(cx, cy, cz)) {
      ctx.postMessage({ t: 'mesh', cx, cy, cz, buffers: { opaque: null, water: null, lava: null } });
      continue;
    }
    const b = buildChunkBuffers(world, atlas, computeChunkLight(world, cx, cy, cz), cx, cy, cz);
    const transfer: Transferable[] = [];
    for (const L of [b.opaque, b.water, b.lava]) {
      if (!L) continue;
      transfer.push(L.pos.buffer, L.col.buffer, L.uv.buffer);
      if (L.sky) transfer.push(L.sky.buffer);
      if (L.blk) transfer.push(L.blk.buffer);
    }
    ctx.postMessage({ t: 'mesh', cx, cy, cz, buffers: b }, transfer);
    if (Date.now() - start > 12) {
      scheduleFlush();
      return;
    }
  }
}

ctx.onmessage = (e: MessageEvent): void => {
  const m = e.data as InMsg;
  switch (m.t) {
    case 'rects': {
      const fallback = Object.values(m.rects)[0];
      atlas = { rect: (n: string) => m.rects[n] ?? fallback, rects: m.rects } as unknown as Atlas;
      for (const k of world.keys()) {
        const [cx, cy, cz] = k.split(',').map(Number);
        markDirty(cx, cy, cz);
      }
      scheduleFlush();
      break;
    }
    case 'chunk':
      world.setChunk(m.cx, m.cy, m.cz, m.cells);
      invalidateLight(m.cx, m.cy, m.cz);
      markDirty(m.cx, m.cy, m.cz);
      scheduleFlush();
      break;
    case 'edit': {
      const cx = toChunk(m.x),
        cy = toChunk(m.y),
        cz = toChunk(m.z);
      world.set(m.x, m.y, m.z, m.id);
      invalidateLight(cx, cy, cz);
      markDirty(cx, cy, cz);
      scheduleFlush();
      break;
    }
    case 'unload':
      world.dropChunk(m.cx, m.cy, m.cz);
      dirty.delete(chunkKey(m.cx, m.cy, m.cz));
      break;
    case 'clear':
      world.clear();
      clearLightCache();
      dirty.clear();
      break;
  }
};

export type MeshResult = { t: 'mesh'; cx: number; cy: number; cz: number; buffers: ChunkBuffers };
