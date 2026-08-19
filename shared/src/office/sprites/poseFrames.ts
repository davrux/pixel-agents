/**
 * Which COLUMN of a sheet a pose draws — the same decision `spriteForPose` makes, with
 * an index as the answer instead of pixels.
 *
 * Why it exists: art reaches the client as a PNG sheet now, so the renderer can point at
 * a cell of a texture instead of having every frame decoded into hex strings and packed
 * pixel by pixel. The rule for WHICH cell must not be duplicated, though — a second
 * opinion about "which picture is the walk cycle's third step" is a bug that only shows
 * up as a subtly wrong animation. So this file states the rule once, as arithmetic, and
 * `poseFrames.int.test.ts` proves it picks the same picture as the pixel path for every
 * bundled sheet, pose, direction and frame counter.
 *
 * The rule, in the order it applies:
 *   1. the track named like the pose, its columns expanded for ping-pong playback;
 *   2. for `sit` with no sit track: the stand column, drawn lower (see `synthSit`) —
 *      the placeholder that lets anybody sit before a sit track is authored;
 *   3. the `idle` track;
 *   4. the bare stand column.
 */
import { DEFAULT_CHARACTER_SPEC, type CharacterSpec } from './characterSpec.js';

export interface PoseFrame {
  /** Column in the sheet, 0-based. */
  col: number;
  /** True when this is the synthesized seated pose: the stand column, to be drawn
   *  shifted down and clipped (no sit track was authored). */
  synthSit: boolean;
}

interface Slot {
  start: number;
  count: number;
  play: 'loop' | 'pingpong';
}

/** Column ranges per track, in spec order — a track claims the next `frames` columns. */
function slots(spec: CharacterSpec): Map<string, Slot> {
  const m = new Map<string, Slot>();
  let off = 0;
  for (const t of spec.tracks) {
    m.set(t.name, { start: off, count: t.frames, play: t.play });
    off += t.frames;
  }
  return m;
}

/** The neutral column: the middle of the walk cycle, or the first column. */
export function standColumn(spec: CharacterSpec): number {
  const walk = slots(spec).get('walk');
  return walk ? walk.start + Math.min(1, walk.count - 1) : 1;
}

/**
 * A track's columns in playback order, or null when the track is absent or its columns
 * are not in the sheet. Ping-pong with more than two frames plays 0 → 1 → 2 → 1, which
 * is why three drawn steps make a four-step cycle.
 */
function sequence(slot: Slot | undefined, available: number): number[] | null {
  if (!slot) return null;
  const cols: number[] = [];
  for (let i = 0; i < slot.count; i++) {
    const idx = slot.start + i;
    if (idx < available) cols.push(idx);
  }
  if (cols.length === 0) return null;
  if (slot.play === 'pingpong' && cols.length > 2) {
    for (let i = cols.length - 2; i >= 1; i--) cols.push(cols[i]);
  }
  return cols;
}

/**
 * Resolve a pose to a sheet column. `frame` is the animation counter (it wraps), and
 * `available` is how many columns the sheet actually has — a spec may claim more than
 * the art delivers, and a column that is not there falls back rather than drawing a gap.
 */
export function poseFrame(
  spec: CharacterSpec | undefined,
  pose: string,
  frame: number,
  available: number,
): PoseFrame {
  const s = spec ?? DEFAULT_CHARACTER_SPEC;
  const table = slots(s);
  const stand = standColumn(s);
  const wrap = (cols: number[]): number => cols[((frame % cols.length) + cols.length) % cols.length];

  const own = sequence(table.get(pose), available);
  if (own) return { col: wrap(own), synthSit: false };
  // `sit` is the one pose the engine fills in when it was never drawn.
  if (pose === 'sit') return { col: Math.min(stand, Math.max(0, available - 1)), synthSit: true };
  if (pose !== 'idle') {
    const idle = sequence(table.get('idle'), available);
    if (idle) return { col: wrap(idle), synthSit: false };
  }
  return { col: Math.min(stand, Math.max(0, available - 1)), synthSit: false };
}

/**
 * How many steps a pose's animation has — the length of the sequence `poseFrame` walks.
 *
 * The client times the animation with this (and the server advances NPC frames with it),
 * so it must agree with `poseFrame` exactly: one number too many and the last step
 * repeats, one too few and a step is skipped. Same arithmetic, same fallbacks, and no
 * pixels involved — which is the point, since the client no longer holds any.
 */
export function posePlaybackLength(spec: CharacterSpec | undefined, pose: string, available: number): number {
  const s = spec ?? DEFAULT_CHARACTER_SPEC;
  const table = slots(s);
  const own = sequence(table.get(pose), available);
  if (own) return own.length;
  if (pose === 'sit') return 1;
  if (pose !== 'idle') {
    const idle = sequence(table.get('idle'), available);
    if (idle) return idle.length;
  }
  return 1;
}
