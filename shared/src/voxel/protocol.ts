/**
 * Shared voxel protocol — used by BOTH the server (authoritative world + chunk
 * store) and the client (rendering + edit intents). Keeps the chunk size, the
 * in-chunk indexing, the AOI radius, and the wire codec identical on both ends.
 *
 * Wire model:
 *  - Chunks are streamed as BINARY messages (type 'c'): a 12-byte header
 *    (cx,cy,cz as int32 LE) + an RLE payload of CHUNK_VOL block ids. Chunks are
 *    far too big for Colyseus schema state, so they never live in the room state.
 *  - Chunk unloads (out of AOI) are a small JSON message (type 'u': {cx,cy,cz}).
 *  - Block edits are small JSON: client→server 'edit' {x,y,z,id}; the server
 *    validates + persists + broadcasts 'edit' {x,y,z,id} to nearby clients.
 *  - Players live in Colyseus schema state (VoxelPlayerSync) with position sent
 *    via 'move'. Chat reuses the existing 'chat' pattern.
 */

export const VOXEL_ROOM = 'voxel';

// ── Water / fluid ids (shared so server sim + client render agree) ───────────
// A full "source" block (id 27, lakes/seas) plus 7 "flowing" levels (ids 40..46,
// level 1 = highest/near source .. level 7 = thinnest/farthest). The server's
// fluid sim spreads flowing water from sources; the client renders each level at a
// lower surface height. Level 0 = source/falling (full height).
export const WATER_SOURCE = 27;
export const WATER_FLOW_MIN = 40; // level 1
export const WATER_FLOW_MAX = 46; // level 7
export const WATER_MAX_LEVEL = 7;

export const isWaterId = (id: number): boolean => id === WATER_SOURCE || (id >= WATER_FLOW_MIN && id <= WATER_FLOW_MAX);
/** 0 for a source/full block, 1..7 for flowing levels. */
export const waterLevel = (id: number): number => (id === WATER_SOURCE ? 0 : id >= WATER_FLOW_MIN && id <= WATER_FLOW_MAX ? id - WATER_FLOW_MIN + 1 : 0);
/** Block id for a flowing-water level (1..7); level ≤0 → source. */
export const flowId = (level: number): number => (level <= 0 ? WATER_SOURCE : WATER_FLOW_MIN + Math.min(WATER_MAX_LEVEL, level) - 1);

// ── Lava — a second finite liquid ────────────────────────────────────────────
// Source id 29 + 4 flowing levels (ids 47..50). Spreads less far than water (4 vs
// 7 levels), is rendered emissive/opaque, and burns players standing in it. The
// server fluid sim + client mesher are generalised over any FluidDef so both
// liquids share one implementation.
export const LAVA_SOURCE = 29;
export const LAVA_FLOW_MIN = 47; // level 1
export const LAVA_FLOW_MAX = 50; // level 4
export const LAVA_MAX_LEVEL = 4;

export const isLavaId = (id: number): boolean => id === LAVA_SOURCE || (id >= LAVA_FLOW_MIN && id <= LAVA_FLOW_MAX);

/** A finite liquid: an infinite source id + a contiguous run of flowing-level ids. */
export interface FluidDef {
  source: number;
  flowMin: number;
  flowMax: number;
  maxLevel: number;
}
export const WATER_FLUID: FluidDef = { source: WATER_SOURCE, flowMin: WATER_FLOW_MIN, flowMax: WATER_FLOW_MAX, maxLevel: WATER_MAX_LEVEL };
export const LAVA_FLUID: FluidDef = { source: LAVA_SOURCE, flowMin: LAVA_FLOW_MIN, flowMax: LAVA_FLOW_MAX, maxLevel: LAVA_MAX_LEVEL };
export const FLUIDS: FluidDef[] = [WATER_FLUID, LAVA_FLUID];

/** The fluid an id belongs to, or null if it is not a liquid. */
export const fluidOf = (id: number): FluidDef | null => {
  for (const f of FLUIDS) if (id === f.source || (id >= f.flowMin && id <= f.flowMax)) return f;
  return null;
};
export const isFluidId = (id: number): boolean => fluidOf(id) !== null;
/** 0 for a source/full block, 1..maxLevel for flowing levels of THIS fluid. */
export const fluidLevel = (f: FluidDef, id: number): number => (id === f.source ? 0 : id - f.flowMin + 1);
/** Block id for a flowing level of THIS fluid (level ≤0 → source). */
export const fluidFlowId = (f: FluidDef, level: number): number => (level <= 0 ? f.source : f.flowMin + Math.min(f.maxLevel, level) - 1);

export const CHUNK = 16; // chunk edge; a chunk is CHUNK^3 block ids
export const CHUNK_VOL = CHUNK * CHUNK * CHUNK; // 4096

/** AOI: how many chunks around the player's chunk are streamed (radius). */
export const VIEW_CHUNKS = 4; // horizontal (x/z)
export const VIEW_CHUNKS_Y = 2; // vertical (y)

/** In-chunk cell index (x,y,z each 0..CHUNK-1). Order: y outer, z, x inner. */
export const cellIndex = (x: number, y: number, z: number): number => x + CHUNK * (z + CHUNK * y);

/** Floor-divide a world coord by CHUNK → chunk coord (handles negatives). */
export const toChunk = (v: number): number => Math.floor(v / CHUNK);
/** Local coord within a chunk (0..CHUNK-1), correct for negatives. */
export const toLocal = (v: number): number => ((v % CHUNK) + CHUNK) % CHUNK;

export const chunkKey = (cx: number, cy: number, cz: number): string => `${cx},${cy},${cz}`;

/** RLE-encode CHUNK_VOL block ids → compact bytes (runs of count:uint16 LE, value). */
export function encodeCells(cells: Uint8Array): Uint8Array {
  const out: number[] = [];
  let i = 0;
  while (i < cells.length) {
    const v = cells[i];
    let n = 1;
    while (i + n < cells.length && cells[i + n] === v && n < 0xffff) n++;
    out.push(n & 0xff, (n >> 8) & 0xff, v);
    i += n;
  }
  return Uint8Array.from(out);
}

/** Decode an RLE payload back to CHUNK_VOL block ids. */
export function decodeCells(buf: Uint8Array): Uint8Array {
  const cells = new Uint8Array(CHUNK_VOL);
  let o = 0;
  for (let i = 0; i + 2 < buf.length; i += 3) {
    const n = buf[i] | (buf[i + 1] << 8);
    const v = buf[i + 2];
    cells.fill(v, o, o + n);
    o += n;
  }
  return cells;
}

/** Pack a chunk for the wire: [cx,cy,cz int32 LE][RLE cells]. */
export function packChunk(cx: number, cy: number, cz: number, cells: Uint8Array): Uint8Array {
  const payload = encodeCells(cells);
  const out = new Uint8Array(12 + payload.length);
  const dv = new DataView(out.buffer);
  dv.setInt32(0, cx, true);
  dv.setInt32(4, cy, true);
  dv.setInt32(8, cz, true);
  out.set(payload, 12);
  return out;
}

export interface UnpackedChunk {
  cx: number;
  cy: number;
  cz: number;
  cells: Uint8Array;
}

/** Unpack a wire chunk (accepts ArrayBuffer or a byte view). */
export function unpackChunk(buf: ArrayBuffer | Uint8Array): UnpackedChunk {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return {
    cx: dv.getInt32(0, true),
    cy: dv.getInt32(4, true),
    cz: dv.getInt32(8, true),
    cells: decodeCells(bytes.subarray(12)),
  };
}
