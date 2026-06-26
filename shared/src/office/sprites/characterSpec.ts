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

/** The bundled pet/NPC sheet layout (16×16, 3 direction rows × 6 frames):
 *  walk 0-2 (ping-pong), sit 3-4, idle 5. `sleep` is optional and added in the
 *  editor when art exists (the bundled sheets have none). */
export const PET_SPRITE_SPEC: CharacterSpec = {
  frame: { w: 16, h: 16 },
  tracks: [
    { name: 'walk', frames: 3, play: 'pingpong' },
    { name: 'sit', frames: 2, play: 'loop' },
    { name: 'idle', frames: 1, play: 'loop' },
  ],
};

/** Track names the NPC editor offers (`sleep`/`drink` optional, like coffee for agents). */
export const NPC_TRACK_NAMES = ['walk', 'sit', 'idle', 'sleep', 'drink'] as const;

// ── NPC spawn config ────────────────────────────────────────────
/** Per-NPC spawn behaviour: whether it spawns at all, and (when it does) a
 *  random interval between spawns + a concurrency cap. Real-time schedules
 *  (fixed clock times) come later; for now it's "every X seconds, randomised". */
export interface NpcConfig {
  active: boolean;
  /** Random seconds between spawns: uniform in [minSec, maxSec]. */
  minSec: number;
  maxSec: number;
  /** Max simultaneous instances of this NPC variant. */
  maxConcurrent: number;
  /** Per-variant behaviour switches (kind-gated by the engine; see NpcBehaviors). */
  behaviors: NpcBehaviors;
}

/** Per-NPC behaviour switches. All default true; the engine kind-gates them
 *  (only dogs chase, only cats flee), so a flag that doesn't apply to a kind is
 *  simply inert. The editor shows only the kind-relevant switches. */
export interface NpcBehaviors {
  /** May rest (sit) at a seat / desk. */
  rest: boolean;
  /** Dogs: chase a nearby cat (shoo-cat). */
  chaseCats: boolean;
  /** Cats: flee a nearby dog (shoo-cat). */
  fleeDogs: boolean;
  /** May visit a free appliance station (coffee) and stand there a while. */
  drink: boolean;
}

export const DEFAULT_NPC_BEHAVIORS: NpcBehaviors = { rest: true, chaseCats: true, fleeDogs: true, drink: true };

export const DEFAULT_NPC_CONFIG: NpcConfig = {
  active: true,
  minSec: 60,
  maxSec: 180,
  maxConcurrent: 1,
  behaviors: { ...DEFAULT_NPC_BEHAVIORS },
};

const NPC_MIN_INTERVAL = 5; // floor (seconds) to avoid spawn storms
const NPC_MAX_INTERVAL = 3600; // 1 hour ceiling
const NPC_MAX_CONCURRENT = 8;

/** Validate/normalise an NPC config, filling defaults and clamping. Never throws. */
export function resolveNpcConfig(input: unknown): NpcConfig {
  const o = input && typeof input === 'object' ? (input as Record<string, unknown>) : {};
  const clampSec = (v: unknown, d: number): number => {
    const n = Math.round(Number(v));
    return Number.isFinite(n) ? Math.max(NPC_MIN_INTERVAL, Math.min(NPC_MAX_INTERVAL, n)) : d;
  };
  let minSec = clampSec(o.minSec, DEFAULT_NPC_CONFIG.minSec);
  let maxSec = clampSec(o.maxSec, DEFAULT_NPC_CONFIG.maxSec);
  if (minSec > maxSec) [minSec, maxSec] = [maxSec, minSec];
  const mc = Math.round(Number(o.maxConcurrent));
  const b = o.behaviors && typeof o.behaviors === 'object' ? (o.behaviors as Record<string, unknown>) : {};
  const bool = (v: unknown, d: boolean): boolean => (typeof v === 'boolean' ? v : d);
  return {
    active: o.active !== false, // default true
    minSec,
    maxSec,
    maxConcurrent: Number.isFinite(mc) ? Math.max(1, Math.min(NPC_MAX_CONCURRENT, mc)) : DEFAULT_NPC_CONFIG.maxConcurrent,
    behaviors: {
      rest: bool(b.rest, true),
      chaseCats: bool(b.chaseCats, true),
      fleeDogs: bool(b.fleeDogs, true),
      drink: bool(b.drink, true),
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
