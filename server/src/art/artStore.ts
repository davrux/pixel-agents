/**
 * Stored art is a PNG, not pixels — the storage half of the same move as artApi.
 *
 * A character/pet/avatar row used to be SpriteData: one hex string per pixel, ~77 KB
 * for an avatar. As a PNG sheet the same art is ~2 KB (measured 24× across the bundled
 * roster). The rows travelled to clients as pixels too, which artApi.ts fixed; this
 * fixes what the database holds, so the table stops growing at 77 KB per account.
 *
 * Deliberately a STORAGE detail: `appStore` packs on write and unpacks on read, so
 * every caller keeps handing over and receiving SpriteData and nothing else in the
 * server had to learn about images. Two consequences worth knowing:
 *
 * - The validator stays the authority. Saves are still validated as SpriteData
 *   (`art/characterDataGuard.ts`: 64×64 cap, frame counts, hex format) BEFORE anything
 *   is encoded, so packing introduces no new untrusted-input surface. A client never
 *   sends a PNG; if it ever should, that path needs its own bounds first — an image
 *   decoder is a fine place to hide a decompression bomb.
 * - **Hex comes back upper-case.** A client writes `#ff0000`, the decoder canonicalises
 *   to `#FF0000`, so a packed row reads back equal in colour but not in string case.
 *   Harmless and checked: the runtime atlas keys sprites by object identity (a WeakMap),
 *   not by their text, and both canvas and CSS parse either case. Worth knowing anyway,
 *   because it means a save-with-no-edits still changes the row's content hash — and
 *   therefore its /art URL — once.
 * - Old rows stay readable forever. `unpackArt` passes SpriteData through untouched, so
 *   a database that was never migrated works; `scripts/repack-art.sh` is the front door
 *   for shrinking one on purpose.
 */
import {
  CHARACTER_DIRECTIONS,
  CHAR_FRAME_H,
  CHAR_FRAME_W,
  PET_DIRECTIONS,
  PET_FRAMES_PER_ROW,
  PET_FRAME_H,
  PET_FRAME_W,
} from '../core/assets/constants.js';
import { decodeDirectionalSheet } from '../core/assets/pngDecoder.js';
import { encodeDirectionalSheet } from '../core/assets/pngEncoder.js';

/** Asset types whose rows hold character-shaped art. */
export const PACKED_ART_TYPES = ['character', 'pet', 'playerAvatar'] as const;
export type PackedArtType = (typeof PACKED_ART_TYPES)[number];

export function isPackedArtType(type: string): type is PackedArtType {
  return (PACKED_ART_TYPES as readonly string[]).includes(type);
}

/** A row in the packed shape: the sheet as base64 plus what a sheet cannot carry. */
interface PackedRow {
  png: string;
  frame: { w: number; h: number };
  dirs: string[];
  [meta: string]: unknown;
}

const isPacked = (row: unknown): row is PackedRow =>
  !!row && typeof row === 'object' && typeof (row as PackedRow).png === 'string';

/**
 * The rows this art actually has, as the LONGEST PREFIX of the row order that is
 * present. Not a filter: rows are positional, so skipping a missing middle row would
 * shift every row after it and the art would read back as another direction.
 *
 * Writing a row that is not there is just as wrong in the other direction — an empty
 * fourth row is a character that is invisible when facing left, which is worse than one
 * with no left row at all (the store's door mirrors that case, see withLeftRow).
 */
export function rowsPresent(data: Record<string, unknown>, order: readonly string[]): string[] {
  const out: string[] = [];
  for (const d of order) {
    const frames = data[d];
    if (!Array.isArray(frames) || frames.length === 0) break;
    out.push(d);
  }
  return out.length > 0 ? out : [order[0]];
}

/** Frame size and row order for a type, when the art itself does not say. */
function geometry(type: PackedArtType, data: Record<string, unknown>): { w: number; h: number; dirs: string[] } {
  const frame = (data.spec as { frame?: { w?: number; h?: number } } | undefined)?.frame;
  const pet = type === 'pet';
  const dirs = rowsPresent(data, pet ? PET_DIRECTIONS : CHARACTER_DIRECTIONS);
  return {
    w: frame?.w ?? (pet ? PET_FRAME_W : CHAR_FRAME_W),
    h: frame?.h ?? (pet ? PET_FRAME_H : CHAR_FRAME_H),
    dirs,
  };
}

/**
 * Turn validated SpriteData into a packed row. Returns the input untouched when there
 * is nothing to pack (no pixels), so a caller cannot accidentally store an empty sheet.
 */
export function packArt(type: PackedArtType, data: unknown): unknown {
  const d = data as Record<string, unknown> | null;
  if (!d || !Array.isArray(d.down) || d.down.length === 0) return data;
  const { w, h, dirs } = geometry(type, d);
  const cols = type === 'pet' ? PET_FRAMES_PER_ROW : undefined;
  const png = encodeDirectionalSheet(d as never, dirs, w, h, cols);
  const { down: _d, up: _u, right: _r, left: _l, ...meta } = d;
  return { ...meta, png: png.toString('base64'), frame: { w, h }, dirs };
}

/** Turn a stored row back into SpriteData. A legacy (unpacked) row passes through. */
export function unpackArt(row: unknown): unknown {
  if (!isPacked(row)) return row;
  const { png, frame, dirs, ...meta } = row;
  // framesPerRow from the image width: the encoder wrote as many columns as the widest
  // direction needed, and the sheet is the only thing that knows how many that was.
  const buf = Buffer.from(png, 'base64');
  const width = buf.readUInt32BE(16); // IHDR width — cheaper than a full decode
  const sprites = decodeDirectionalSheet(buf, frame.w, frame.h, Math.max(1, Math.floor(width / frame.w)), dirs);
  return { ...meta, ...sprites };
}

/** The stored sheet's bytes, or null for a legacy row — lets artApi stream instead of
 *  re-encoding what it just decoded. */
export function packedPng(row: unknown): Buffer | null {
  return isPacked(row) ? Buffer.from(row.png, 'base64') : null;
}
