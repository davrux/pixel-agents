/**
 * The gate on character, avatar and pet art a client sends — the one place that decides
 * whether a save is allowed to reach the store.
 *
 * It lived as three private methods on `SimRoom`, where nothing could test it: it is the
 * authoritative check behind three message handlers (`saveAvatar`, `avatarToTemplate`,
 * `saveAsset`), one of which any authenticated user may call for their own avatar, and it had
 * no test at all. Pulled out here for the same reason the housekeeping guards are pure
 * functions: an untrusted-input validator that cannot be exercised is a claim, not a gate.
 *
 * It DOES cap the total pixel count, and the reason is a correction of what this comment used
 * to claim. The per-direction bounds (64 frames of 64×64) allow 1.05 M cells across four rows,
 * i.e. 10.0 MB of JSON — and the transport refuses a frame over `MAX_WS_PAYLOAD_BYTES`. This
 * file previously said that made a cap unnecessary, "so a tighter bound would only forbid legal
 * art". That was wrong about the consequence: the transport does not refuse the SAVE, it kills
 * the CONNECTION — `RangeError: Max payload size exceeded`, close code 1009, and the editor's
 * work is simply gone with no message. Production hit exactly that on 2026-08-26 and it
 * reproduces on demand. So legal now implies deliverable: `MAX_SHEET_CELLS` keeps the worst
 * legal sheet at about 3.8 MB, several times inside the ceiling even with no compression, and
 * `artPayload.int.test.ts` measures the pair rather than trusting the arithmetic.
 *
 * Cost of verification is not a concern at that size: measured 2026-08-26, 1.7 MB validates in
 * 3.3 ms and 5.0 MB in 10.0 ms.
 */
import { cleanName, MAX_NAME_LEN } from '@pixel/shared';
import { MAX_SHEET_CELLS } from '@pixel/shared/office/sprites/characterSpec.js';

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

/** Validate an optional pet spawn config (active flag + sane interval/cap). */
export function validPetConfig(c: unknown): boolean {
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
  // flags are back-filled (default true) by resolvePetConfig downstream.
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
 * The metadata half of a save, for the path where the art arrives as an IMAGE.
 *
 * `validCharacterData` below checks pixels because it was written for saves that carried them.
 * A PNG save has none to check — every pixel out of a decoder is a valid colour, and the
 * geometry was decided from the header (`art/sheetPng.ts`) — so what is left is exactly this:
 * a name that survives cleaning, and, if a spec came along, that it describes the sheet that
 * actually arrived. Same rules, same cleaning, same rewrite of `name` in place.
 */
export function validSheetMeta(meta: unknown, frames: number): boolean {
  const m = meta as { name?: unknown; spec?: unknown; petConfig?: unknown };
  if (!m || typeof m !== 'object') return false;
  if (typeof m.name !== 'string') return false;
  const name = cleanName(m.name);
  m.name = name; // persisted on save, exactly as in validCharacterData
  if (!NAME.test(name)) return false;
  // The sum rule is the load-bearing one: a track list that claims more or fewer frames than
  // the sheet has makes the renderer read a column that is not there.
  if (m.spec !== undefined && !validCharacterSpec(m.spec, frames)) return false;
  if (m.petConfig !== undefined && !validPetConfig(m.petConfig)) return false;
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
    petConfig?: unknown;
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
  // Total pixels across every direction row, so the bound is on what actually travels rather
  // than on one row of it. Counted as the rows are walked and checked at once, so an oversized
  // payload is refused early instead of being fully verified first.
  let cells = 0;
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
        cells += row.length;
        if (cells > MAX_SHEET_CELLS) return false;
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
  // Optional pet spawn config.
  if (d.petConfig !== undefined && !validPetConfig(d.petConfig)) return false;
  return true;
}
