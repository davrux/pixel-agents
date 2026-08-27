/**
 * The gate on a sheet a client sends as a PNG — the first untrusted IMAGE this server accepts.
 *
 * Art used to travel up as SpriteData: one hex string per pixel, 95.3 KB for a sheet whose PNG
 * is 2.8 KB (measured on char_0), and 3.58 MB for the largest one the rules allow. Sending the
 * image instead is a factor of 34 on a real save. What it costs is this file: `artStore.ts` has
 * warned all along that "a client never sends a PNG; if it ever should, that path needs its own
 * bounds first — an image decoder is a fine place to hide a decompression bomb."
 *
 * So the bounds come BEFORE the decoder, cheapest first, and each one makes the next safe:
 *
 *   1. it is bytes, and not more than MAX_SHEET_PNG_BYTES;
 *   2. it starts with the PNG signature (a JPEG or a zip is refused without pngjs seeing it);
 *   3. its IHDR — 25 bytes, no decoding — is 8-bit and not interlaced;
 *   4. its DIMENSIONS, read from that header, match the frame size and stay inside
 *      MAX_SHEET_CELLS. This is the one that stops a bomb: the output size is known before a
 *      single pixel is inflated, so a 40-byte file claiming 30000×30000 never reaches pngjs.
 *
 * Only then is it decoded, and the result goes through `validCharacterData` like any other
 * save — the validator stays the single authority on what a sheet may be, and this file only
 * decides whether it is safe to look.
 *
 * Note what is NOT done: the client's bytes are never stored. The decoded pixels are re-encoded
 * by the store as usual, so what other viewers are served is a PNG this server wrote from
 * validated pixels — attacker-controlled bytes stop here.
 */
import { CHARACTER_DIRECTIONS } from '../core/assets/constants.js';
import { decodeCharacterPng } from '../core/assets/pngDecoder.js';
import { MAX_CHAR_DIM, MAX_SHEET_CELLS, MAX_TRACK_FRAMES } from '@pixel/shared/office/sprites/characterSpec.js';

/**
 * Byte ceiling for one sheet, derived rather than picked: the largest sheet the rules allow is
 * 393 216 pixels, which is 1.50 MB of RGBA — and measured 2026-08-27, a PNG of truly
 * incompressible noise at that size is also 1.50 MB. Two megabytes therefore admits every legal
 * sheet even when nothing about it compresses, while staying far under the transport's own
 * ceiling. A real sheet is 2.8 KB.
 */
export const MAX_SHEET_PNG_BYTES = 2 * 1024 * 1024;

/** The PNG signature, per the spec's first eight bytes. */
const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export interface PngHeader {
  width: number;
  height: number;
  bitDepth: number;
  colourType: number;
  interlace: number;
}

/**
 * The IHDR fields, without decoding anything.
 *
 * A PNG's first chunk must be IHDR, so the layout is fixed: 8 bytes of signature, a 4-byte
 * length, the type, then width, height, bit depth, colour type, compression, filter, interlace.
 * Reading it is how the output size becomes known before any inflation happens.
 */
export function readPngHeader(bytes: Buffer): PngHeader | null {
  if (bytes.length < 33) return null;
  if (!bytes.subarray(0, 8).equals(SIGNATURE)) return null;
  if (bytes.subarray(12, 16).toString('latin1') !== 'IHDR') return null;
  return {
    width: bytes.readUInt32BE(16),
    height: bytes.readUInt32BE(20),
    bitDepth: bytes[24],
    colourType: bytes[25],
    interlace: bytes[28],
  };
}

export type SheetFromPng =
  | { ok: true; rows: Record<string, string[][][]> }
  | { ok: false; reason: string };

/**
 * Turn a client's PNG into the direction rows a save is made of, or say why not.
 *
 * `frame` is the size the sheet claims (from the spec the client sent, or the kind's default).
 * A sheet whose dimensions do not divide by it exactly is refused rather than cropped: the
 * decoder floors, so a mismatch would silently drop a partial frame or read a row that is not
 * there — the failure mode this replaced, where art came back subtly wrong.
 */
export function sheetFromPng(input: unknown, frame: { w: number; h: number }): SheetFromPng {
  const bytes = input instanceof Uint8Array ? Buffer.from(input.buffer, input.byteOffset, input.byteLength) : null;
  if (!bytes) return { ok: false, reason: 'not bytes' };
  if (bytes.length > MAX_SHEET_PNG_BYTES) return { ok: false, reason: `over ${MAX_SHEET_PNG_BYTES} bytes` };

  const head = readPngHeader(bytes);
  if (!head) return { ok: false, reason: 'not a PNG' };
  // 8 bits per channel and no interlacing: what a browser canvas produces, and the narrowest
  // decoder path. 16-bit doubles the memory a decode needs for the same picture.
  if (head.bitDepth !== 8) return { ok: false, reason: `bit depth ${head.bitDepth}` };
  if (head.interlace !== 0) return { ok: false, reason: 'interlaced' };

  const { width, height } = head;
  if (width < 1 || height < 1) return { ok: false, reason: 'empty' };
  if (width * height > MAX_SHEET_CELLS) return { ok: false, reason: `${width}×${height} is over ${MAX_SHEET_CELLS} pixels` };
  if (frame.w < 1 || frame.w > MAX_CHAR_DIM || frame.h < 1 || frame.h > MAX_CHAR_DIM) {
    return { ok: false, reason: `frame ${frame.w}×${frame.h}` };
  }
  if (width % frame.w !== 0 || height % frame.h !== 0) {
    return { ok: false, reason: `${width}×${height} is not a whole number of ${frame.w}×${frame.h} cells` };
  }
  const frames = width / frame.w;
  const rows = height / frame.h;
  if (frames > MAX_TRACK_FRAMES) return { ok: false, reason: `${frames} frames per row` };
  if (rows > CHARACTER_DIRECTIONS.length) return { ok: false, reason: `${rows} direction rows` };

  try {
    return { ok: true, rows: decodeCharacterPng(bytes, frame.w, frame.h) as unknown as Record<string, string[][][]> };
  } catch (err) {
    // A file that passes every header check and still fails to inflate is corrupt or hostile;
    // either way the answer is the same and the reason is not worth guessing at.
    return { ok: false, reason: `undecodable (${err instanceof Error ? err.message : 'unknown'})` };
  }
}
