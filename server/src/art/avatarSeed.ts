/**
 * One gallery skin turned into a fresh player avatar.
 *
 * Its own little module because getting it wrong was a real bug and a silent one. A bundled
 * gallery entry carries its sheet as the FILE (a Buffer, see assetLoader's BundledCharacterSheet),
 * and the seed used to go through `JSON.parse(JSON.stringify(entry))` — which turns a Buffer into
 * `{"type":"Buffer","data":[137,80,78,71,...]}`. The result: 10 267 bytes of number array stored
 * for a 2.8 KB sheet, and that array sent to every viewer in the `playerAvatar` message instead
 * of a URL, because nothing recognised it as art any more. Measured on a fresh account, 2026-08-27.
 *
 * So a bundled source is packed properly here — the file's bytes plus the geometry,
 * which is read from the PNG HEADER rather than by decoding the image — and a stored override
 * (SpriteData) is cloned as before and packed by the store on write.
 */
import { CHARACTER_DIRECTIONS, CHAR_FRAME_H, CHAR_FRAME_W } from '../core/assets/constants.js';
import { artBytes } from './artUrl.js';
import { readPngHeader } from './sheetPng.js';

/** A deep copy for the SpriteData case — the same JSON round trip as before, which is safe
 *  precisely because there is no Buffer left in that shape. */
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

export function avatarSeedFrom(src: Record<string, unknown>): Record<string, unknown> {
  const bytes = artBytes(src);
  if (!bytes) return clone(src);
  const frame = (src.spec as { frame?: { w: number; h: number } } | undefined)?.frame ?? {
    w: CHAR_FRAME_W,
    h: CHAR_FRAME_H,
  };
  const head = readPngHeader(bytes);
  // The rows the sheet actually has. Without a readable header, assume the three that every
  // sheet has had since before `left` became a row — the sprite store completes the fourth.
  const rows = head
    ? Math.max(1, Math.min(CHARACTER_DIRECTIONS.length, Math.floor(head.height / frame.h)))
    : 3;
  const { png: _png, ...meta } = src;
  return { ...meta, png: bytes, frame, dirs: [...CHARACTER_DIRECTIONS.slice(0, rows)] };
}
