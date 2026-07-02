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
