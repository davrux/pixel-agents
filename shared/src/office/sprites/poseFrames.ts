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
import { Direction } from '../types.js';

import { DEFAULT_CHARACTER_SPEC, type CharacterSpec } from './characterSpec.js';


/** Sheet rows, top to bottom — the layout every sheet has (see CHARACTER_DIRECTIONS). */
export const SHEET_ROWS = ['down', 'up', 'right', 'left'] as const;

/**
 * The sheet ROW for a facing. Not the same number as the direction: `Direction` is
 * DOWN 0, LEFT 1, RIGHT 2, UP 3, while a sheet is ordered down, up, right, left. Passing
 * a direction where a row was wanted drew the back when walking left and the left-facing
 * frames when walking north — which is exactly what happened, because two of the four
 * happen to coincide and the bug hides until somebody turns.
 */
export function sheetRowForDir(dir: Direction): number {
  switch (dir) {
    case Direction.UP:
      return 1;
    case Direction.RIGHT:
      return 2;
    case Direction.LEFT:
      return 3;
    default:
      return 0; // DOWN
  }
}

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
 * Which pose a pose borrows its art from when it was never drawn.
 *
 * The point is that a NEW pose costs no art: `drink` looks enough like `coffee` (stand there,
 * hold something) that a sheet with coffee frames animates a drink pose for free, and a sheet
 * with neither still lands on `idle` and then the stand column. So a pose can be added to the
 * engine without touching a single sheet, and any sheet that later gains the art inherits it
 * everywhere it is borrowed.
 *
 * Linked rather than spelled out per pose: `feed → drink → coffee` falls out of two entries, and
 * changing what `drink` borrows from does not require remembering that `feed` borrows from it.
 * That is also why `poseChain` carries a visited set — a link back would otherwise loop, and
 * `poseFrames.int.test.ts` walks every chain to prove none does.
 *
 * What is borrowed is only the ART. The CADENCE stays the pose's own (`poseCadence.ts`), because
 * the action decides the tempo: a drink played at the coffee cadence would be indistinguishable
 * from a coffee break, which is the opposite of what the borrow is for.
 */
const POSE_FALLBACK: Readonly<Record<string, string>> = {
  drink: 'coffee',
  feed: 'drink',
};

/**
 * The track names to try, in order: the pose itself, whatever it borrows from, then `idle`.
 *
 * Every resolver walks THIS — the column (`poseFrame`), the playback length
 * (`posePlaybackLength`) and the reference pixel path (`spriteForPose`). It used to be three
 * hand-mirrored `if` chains, and the third had already drifted: it did not know about `sit` at
 * all. A resolver that walked a different chain than the one the length came from would put the
 * server's frame counter and the drawn column out of step, which is invisible until an animation
 * plays the wrong pictures.
 */
export function poseChain(pose: string): string[] {
  const chain: string[] = [];
  const seen = new Set<string>();
  let name: string | undefined = pose;
  while (name && !seen.has(name)) {
    seen.add(name);
    chain.push(name);
    name = POSE_FALLBACK[name];
  }
  if (!seen.has('idle')) chain.push('idle');
  return chain;
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
  // `sit` is the one pose the engine fills in when it was never drawn, and it comes BEFORE the
  // borrow chain on purpose: a sheet with an idle track would otherwise hand a seated character
  // its standing idle frames instead of the lowered stand column. A transform, not a track, which
  // is why it is not in POSE_FALLBACK.
  if (pose === 'sit') return { col: Math.min(stand, Math.max(0, available - 1)), synthSit: true };
  // Then whatever this pose borrows from, in order (see poseChain). The first entry is the pose
  // itself, already tried above.
  for (const name of poseChain(pose).slice(1)) {
    const borrowed = sequence(table.get(name), available);
    if (borrowed) return { col: wrap(borrowed), synthSit: false };
  }
  return { col: Math.min(stand, Math.max(0, available - 1)), synthSit: false };
}

/**
 * How many steps a pose's animation has — the length of the sequence `poseFrame` walks.
 *
 * The client times the animation with this (and the server advances pet frames with it),
 * so it must agree with `poseFrame` exactly: one number too many and the last step
 * repeats, one too few and a step is skipped. Same arithmetic, same fallbacks, and no
 * pixels involved — which is the point, since the client no longer holds any.
 */
export function posePlaybackLength(spec: CharacterSpec | undefined, pose: string, available: number): number {
  const s = spec ?? DEFAULT_CHARACTER_SPEC;
  const table = slots(s);
  const own = sequence(table.get(pose), available);
  if (own) return own.length;
  if (pose === 'sit') return 1; // the synthesized seated frame is one frame
  // The SAME chain poseFrame walks. If these two ever disagree, the frame counter advances over
  // one track's length while the renderer draws out of another — an animation playing the wrong
  // pictures, with nothing to point at.
  for (const name of poseChain(pose).slice(1)) {
    const borrowed = sequence(table.get(name), available);
    if (borrowed) return borrowed.length;
  }
  return 1;
}
