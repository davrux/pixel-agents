/**
 * Character animation spec — the declarative description of a character's frame
 * size and per-pose animation tracks. This is the foundation for variable frame
 * size (Stufe B / B1) and, later, variable frame counts per pose (B2/B3).
 *
 * A character PNG (or DB override) carries an optional spec; when absent the
 * DEFAULT_CHARACTER_SPEC reproduces the historical fixed layout exactly:
 *   16×32 frames · walk = 3 (ping-pong) · typing = 2 · reading = 2 · coffee = 2.
 *
 * The track *order* also defines where each track's frames sit in the flat
 * per-direction frame list (walk frames first, then typing, …) — consumed by
 * the renderer/engine in a later step; B1 only introduces and plumbs the data.
 */

import { COFFEE_FRAME_COUNT } from '../constants.js';

/** Max character frame dimension (px). Mirrors the editor + server validator. */
export const MAX_CHAR_DIM = 64;
/** Upper bound on stored frames per track (sanity cap). */
export const MAX_TRACK_FRAMES = 64;

/**
 * Upper bound on the pixels ONE sheet may carry, counted across all its direction rows.
 *
 * This exists because the other two caps do not bound the payload: 64 frames of 64×64 in four
 * rows is 1.05 M cells, which is 10.0 MB of JSON (measured), and the WebSocket transport refuses
 * a frame over MAX_WS_PAYLOAD_BYTES. A save that big was therefore ACCEPTED by the rules and
 * undeliverable in fact — and the failure was not a refusal but a dropped connection:
 * `RangeError: Max payload size exceeded` on the server, close code 1009, the editor's save
 * silently gone. Seen in production 2026-08-26 and reproduced exactly.
 *
 * 4 rows × 24 frames × 64×64 = 393 216 cells, about 3.8 MB of JSON, so the worst legal sheet
 * fits the ceiling several times over even uncompressed. What it restricts is only very large
 * frames: at 16×32 the 64-frame cap still binds first (131 072 cells), and every bundled sheet
 * is far below it (the widest, 23×32 over 11 columns, is 32 384). At the maximum 64×64 it allows
 * 24 frames per direction.
 *
 * Enforced in both places that can produce a sheet — the editor before it sends, so the user
 * sees a refusal, and the server's guard, because the client is not trusted.
 */
export const MAX_SHEET_CELLS = 4 * 24 * MAX_CHAR_DIM * MAX_CHAR_DIM;

/** How a track's stored frames are played back. */
export type TrackPlay = 'loop' | 'pingpong';

export interface CharacterTrack {
  /** Pose name this track animates (e.g. 'walk', 'typing', 'reading', 'coffee'). */
  name: string;
  /** Number of distinct stored frames for the pose. */
  frames: number;
  /** Playback order over the stored frames. 'loop' = 0..n-1; 'pingpong' =
   *  0..n-1..1 (the classic 3-frame walk cycle). */
  play: TrackPlay;
}

export interface CharacterSpec {
  /** Frame size in pixels. */
  frame: { w: number; h: number };
  /** Ordered animation tracks. */
  tracks: CharacterTrack[];
}

/** The historical fixed layout, used whenever a character has no explicit spec. */
export const DEFAULT_CHARACTER_SPEC: CharacterSpec = {
  frame: { w: 16, h: 32 },
  tracks: [
    { name: 'walk', frames: 3, play: 'pingpong' },
    { name: 'typing', frames: 2, play: 'loop' },
    { name: 'reading', frames: 2, play: 'loop' },
    { name: 'coffee', frames: COFFEE_FRAME_COUNT, play: 'loop' },
  ],
};

/** The bundled pet sheet layout (16×16, 3 direction rows × 6 frames):
 *  walk 0-2 (ping-pong), sit 3-4, idle 5. `sleep` is optional and added in the
 *  editor when art exists (the bundled sheets have none). */
/**
 * The bundled pet sheets' layout: columns claimed in track order, walk 0-2, sit 3-4, idle 5,
 * talk 6-7.
 *
 * **Append, never insert.** A track takes the next free columns, so adding one at the end leaves
 * every drawn frame where it is; inserting renumbers everything after it and every sheet already
 * drawn animates the wrong pictures (`poseFrames.int.test.ts` pins this). `talk` was appended
 * 2026-08-27, when the sheets went from 6 to 8 columns — before that a chatting pet resolved to
 * column 5 and stood still, since `petPose` asks for `talk` and no track answered.
 *
 * `drink` is still unanswered and deliberately so: the engine asks for it at a coffee station and
 * it falls back to the idle frame, which reads as a pet standing at the machine. Draw columns for
 * it and append it here the same way.
 */
export const PET_SPRITE_SPEC: CharacterSpec = {
  frame: { w: 16, h: 16 },
  tracks: [
    { name: 'walk', frames: 3, play: 'pingpong' },
    { name: 'sit', frames: 2, play: 'loop' },
    { name: 'idle', frames: 1, play: 'loop' },
    { name: 'talk', frames: 2, play: 'loop' },
  ],
};

// ── pet spawn config ────────────────────────────────────────────
/** Per-pet spawn behaviour: whether it spawns at all, and (when it does) a
 *  random interval between spawns + a concurrency cap. Real-time schedules
 *  (fixed clock times) come later; for now it's "every X seconds, randomised". */
export interface PetConfig {
  active: boolean;
  /** Random seconds between spawns: uniform in [minSec, maxSec]. */
  minSec: number;
  maxSec: number;
  /** Max simultaneous instances of this pet variant. */
  maxConcurrent: number;
  /** Per-variant behaviour switches (kind-gated by the engine; see PetBehaviors). */
  behaviors: PetBehaviors;
}

/**
 * Per-pet behaviour switches — permissions for THIS animal. All default true.
 *
 * A switch says whether a variant may act on something its species can do; what the species can do
 * is elsewhere and is not per-animal. So `chase` and `flee` name no quarry: which kinds this one
 * hunts, and which hunt it, comes from `CHASES`/`fleesFrom` (`office/types.ts`), and a flag with
 * nothing to apply to is simply inert — a duck's `chase` is on and hunts nothing. The editor shows
 * only the switches that can do something for the kind in hand, and labels them from that table.
 *
 * The two named for a species (`chaseCats`, `fleeDogs`) and the one named for coffee (`drink`) are
 * read as the current names by `resolvePetConfig`, so a pet saved before this keeps its settings.
 */
interface PetBehaviors {
  /** May rest (sit) at a seat / desk. */
  rest: boolean;
  /** May hunt the kinds its species hunts (`CHASES`). */
  chase: boolean;
  /** May run from the kinds that hunt it (`fleesFrom`, derived). */
  flee: boolean;
  /** May visit a free bowl or fountain — an appliance a PET may use — and stay a while. */
  feedDrink: boolean;
  /** May trot over to an agent and stand chatting a while. */
  talk: boolean;
}

const DEFAULT_PET_BEHAVIORS: PetBehaviors = {
  rest: true,
  chase: true,
  flee: true,
  feedDrink: true,
  talk: true,
};

export const DEFAULT_PET_CONFIG: PetConfig = {
  active: true,
  minSec: 60,
  maxSec: 180,
  maxConcurrent: 1,
  behaviors: { ...DEFAULT_PET_BEHAVIORS },
};

const PET_MIN_INTERVAL = 5; // floor (seconds) to avoid spawn storms
const PET_MAX_INTERVAL = 3600; // 1 hour ceiling
const PET_MAX_CONCURRENT = 8;

/** Validate/normalise a pet config, filling defaults and clamping. Never throws. */
export function resolvePetConfig(input: unknown): PetConfig {
  const o = input && typeof input === 'object' ? (input as Record<string, unknown>) : {};
  const clampSec = (v: unknown, d: number): number => {
    const n = Math.round(Number(v));
    return Number.isFinite(n) ? Math.max(PET_MIN_INTERVAL, Math.min(PET_MAX_INTERVAL, n)) : d;
  };
  let minSec = clampSec(o.minSec, DEFAULT_PET_CONFIG.minSec);
  let maxSec = clampSec(o.maxSec, DEFAULT_PET_CONFIG.maxSec);
  if (minSec > maxSec) [minSec, maxSec] = [maxSec, minSec];
  const mc = Math.round(Number(o.maxConcurrent));
  const b = o.behaviors && typeof o.behaviors === 'object' ? (o.behaviors as Record<string, unknown>) : {};
  const bool = (v: unknown, d: boolean): boolean => (typeof v === 'boolean' ? v : d);
  return {
    active: o.active !== false, // default true
    minSec,
    maxSec,
    maxConcurrent: Number.isFinite(mc) ? Math.max(1, Math.min(PET_MAX_CONCURRENT, mc)) : DEFAULT_PET_CONFIG.maxConcurrent,
    behaviors: {
      rest: bool(b.rest, true),
      // Each of the three renamed switches reads its own name first and the old one after, so a
      // stored pet keeps what its author set. Nothing writes the old names any more, so this is a
      // read path only — the same shape as the `npc` → `petConfig` rename.
      chase: bool(b.chase, bool(b.chaseCats, true)),
      flee: bool(b.flee, bool(b.fleeDogs, true)),
      feedDrink: bool(b.feedDrink, bool(b.drink, true)),
      talk: bool(b.talk, true),
    },
  };
}

/**
 * Validate/normalise an arbitrary (manifest or stored) value into a CharacterSpec,
 * filling in defaults and clamping to bounds. Never throws — bad input falls back
 * to the default layout so a malformed manifest can't break asset loading.
 */
export function resolveCharacterSpec(input: unknown): CharacterSpec {
  const obj = input && typeof input === 'object' ? (input as Record<string, unknown>) : {};
  const fr = obj.frame as { w?: unknown; h?: unknown } | undefined;
  const clampDim = (v: unknown, fallback: number): number => {
    const n = Math.round(Number(v));
    if (!Number.isFinite(n) || n < 1) return fallback; // nonsensical → default
    return Math.min(MAX_CHAR_DIM, n); // valid but too big → clamp to the cap
  };
  const frame = {
    w: clampDim(fr?.w, DEFAULT_CHARACTER_SPEC.frame.w),
    h: clampDim(fr?.h, DEFAULT_CHARACTER_SPEC.frame.h),
  };

  let tracks = DEFAULT_CHARACTER_SPEC.tracks;
  if (Array.isArray(obj.tracks)) {
    const parsed: CharacterTrack[] = [];
    for (const t of obj.tracks) {
      if (!t || typeof t !== 'object') continue;
      const tt = t as Record<string, unknown>;
      const name = typeof tt.name === 'string' ? tt.name.trim() : '';
      const frames = Math.round(Number(tt.frames));
      if (!name || !Number.isFinite(frames) || frames < 1 || frames > MAX_TRACK_FRAMES) continue;
      parsed.push({ name, frames, play: tt.play === 'pingpong' ? 'pingpong' : 'loop' });
    }
    if (parsed.length > 0) tracks = parsed;
  }

  return { frame, tracks };
}

/** Total stored frames implied by a spec's tracks (the canonical frame count). */
export function specFrameCount(spec: CharacterSpec): number {
  return spec.tracks.reduce((sum, t) => sum + t.frames, 0);
}
