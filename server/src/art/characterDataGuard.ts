/**
 * The gate on character, avatar and NPC art a client sends — the one place that decides
 * whether a save is allowed to reach the store.
 *
 * It lived as three private methods on `SimRoom`, where nothing could test it: it is the
 * authoritative check behind three message handlers (`saveAvatar`, `avatarToTemplate`,
 * `saveAsset`), one of which any authenticated user may call for their own avatar, and it had
 * no test at all. Pulled out here for the same reason the housekeeping guards are pure
 * functions: an untrusted-input validator that cannot be exercised is a claim, not a gate.
 *
 * What it does NOT need, measured rather than assumed: a cap on frames × width × height. The
 * rules allow at most 64 frames of 64×64 per direction, and four of those rows are 1.05 M
 * cells — 10.0 MB of JSON, which the transport's 8 MB `maxPayload` (`index.ts`) refuses before
 * this ever runs. The largest payload that CAN arrive validates in about 16 ms (measured
 * 2026-08-26: 1.7 MB in 3.3 ms, 5.0 MB in 10.0 ms, 10.0 MB in 20.5 ms), so verification is not
 * a CPU lever. A tighter cap here would only forbid legal art, so the bound stays where it is
 * and the numbers are written down instead.
 */
import { cleanName, MAX_NAME_LEN } from '@pixel/shared';

/** Frame size ceiling, matching `MAX_CHAR_DIM` in shared's characterSpec and the editor's
 *  own `MAX_DIM` — art bigger than this is refused, not scaled. */
const MAX_DIM = 64;
/** Frames per direction. A track may declare at most this many, and the spec's tracks must
 *  sum to exactly the frame count, so this bounds both. */
const MAX_FRAMES = 64;
const HEX = /^#[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$/;
/** Printable ASCII only, and no longer than `cleanName` would cut it to — built from the
 *  shared constant so the two cannot drift (the old comment claimed 16 while the pattern
 *  said 32). */
const NAME = new RegExp(`^[\\x20-\\x7e]{1,${MAX_NAME_LEN}}$`);

/** Validate an optional CharacterSpec: sane frame size + non-empty tracks whose frame
 *  counts sum to `n` (the number of frames per direction). */
export function validCharacterSpec(spec: unknown, n: number): boolean {
  const s = spec as { frame?: unknown; tracks?: unknown };
  if (!s || typeof s !== 'object') return false;
  const fr = s.frame as { w?: unknown; h?: unknown } | undefined;
  const dim = (v: unknown): boolean => Number.isInteger(v) && (v as number) >= 1 && (v as number) <= MAX_DIM;
  if (!fr || !dim(fr.w) || !dim(fr.h)) return false;
  if (!Array.isArray(s.tracks) || s.tracks.length === 0) return false;
  let sum = 0;
  for (const t of s.tracks) {
    const tt = t as { name?: unknown; frames?: unknown; play?: unknown };
    if (!tt || typeof tt !== 'object') return false;
    if (typeof tt.name !== 'string' || tt.name.length === 0 || tt.name.length > 32) return false;
    if (!Number.isInteger(tt.frames) || (tt.frames as number) < 1 || (tt.frames as number) > MAX_FRAMES) return false;
    if (tt.play !== 'loop' && tt.play !== 'pingpong') return false;
    sum += tt.frames as number;
  }
  return sum === n;
}

/** Validate an optional NPC spawn config (active flag + sane interval/cap). */
export function validNpcConfig(c: unknown): boolean {
  const o = c as {
    active?: unknown;
    minSec?: unknown;
    maxSec?: unknown;
    maxConcurrent?: unknown;
    behaviors?: unknown;
  };
  if (!o || typeof o !== 'object') return false;
  if (typeof o.active !== 'boolean') return false;
  const int = (v: unknown, lo: number, hi: number): boolean =>
    Number.isInteger(v) && (v as number) >= lo && (v as number) <= hi;
  if (!int(o.minSec, 5, 3600) || !int(o.maxSec, 5, 3600)) return false;
  if ((o.minSec as number) > (o.maxSec as number)) return false;
  if (!int(o.maxConcurrent, 1, 8)) return false;
  // Optional behaviour switches: each, if present, must be a boolean. Missing
  // flags are back-filled (default true) by resolveNpcConfig downstream.
  if (o.behaviors !== undefined) {
    if (typeof o.behaviors !== 'object' || o.behaviors === null) return false;
    const b = o.behaviors as Record<string, unknown>;
    for (const k of ['rest', 'chaseCats', 'fleeDogs', 'drink', 'talk']) {
      if (b[k] !== undefined && typeof b[k] !== 'boolean') return false;
    }
  }
  return true;
}

/**
 * Authoritative validation of a character override — never trust the client.
 *
 * Enforces a mandatory display name (printable ASCII, at most `MAX_NAME_LEN` = 32 chars after
 * cleaning) and that down/up/right (and optional left) are non-empty frame lists of uniformly
 * sized hex-pixel grids within bounds. Mirrors (and is the real gate behind) the editor's
 * client-side checks.
 *
 * NOTE: it REWRITES `data.name` in place with the cleaned name, and the callers persist that
 * — trimming and collapsing whitespace is part of accepting the save, not a separate step.
 */
export function validCharacterData(data: unknown): boolean {
  const d = data as {
    name?: unknown;
    down?: unknown;
    up?: unknown;
    right?: unknown;
    left?: unknown;
    spec?: unknown;
    npc?: unknown;
  };
  if (!d || typeof d !== 'object') return false;
  if (typeof d.name !== 'string') return false;
  const name = cleanName(d.name); // trim + collapse whitespace + cap
  d.name = name; // persisted on save
  if (!NAME.test(name)) return false;
  // One frame size for the whole sheet: `dims` is shared across the direction rows, so a
  // sheet whose `up` row is a different size than its `down` row is refused rather than
  // sliced on one row's numbers.
  const dims = { w: -1, h: -1 };
  const validFrames = (frames: unknown): boolean => {
    if (!Array.isArray(frames) || frames.length === 0 || frames.length > MAX_FRAMES) return false;
    for (const frame of frames) {
      if (!Array.isArray(frame) || frame.length === 0 || frame.length > MAX_DIM) return false;
      if (dims.h === -1) dims.h = frame.length;
      else if (frame.length !== dims.h) return false;
      for (const row of frame as unknown[]) {
        if (!Array.isArray(row) || row.length === 0 || row.length > MAX_DIM) return false;
        if (dims.w === -1) dims.w = row.length;
        else if (row.length !== dims.w) return false;
        for (const cell of row as unknown[]) {
          if (typeof cell !== 'string') return false;
          if (cell !== '' && !HEX.test(cell)) return false;
        }
      }
    }
    return true;
  };
  if (!validFrames(d.down) || !validFrames(d.up) || !validFrames(d.right)) return false;
  if (d.left !== undefined && !validFrames(d.left)) return false;
  // Optional animation spec: track frame counts must sum to the frame count.
  if (d.spec !== undefined && !validCharacterSpec(d.spec, (d.down as unknown[]).length)) return false;
  // Optional NPC spawn config.
  if (d.npc !== undefined && !validNpcConfig(d.npc)) return false;
  return true;
}
