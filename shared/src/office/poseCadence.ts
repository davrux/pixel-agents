/**
 * How fast a pose's frames advance, in one place.
 *
 * There were three answers to this question and they disagreed. The engine animates pets on the
 * server (`advancePetFrame`, the cadence synced as `PetSync.frame`); the client animates CHARACTERS
 * itself, because a frame's phase within a synced pose is presentation timing (see AGENTS.md
 * invariant 2), from a table in `OfficeScene` whose own comment admitted it was "mirroring the
 * engine's constants"; and the character editor had a third, hand-written table. The editor's walk
 * ran at 150 ms against the game's 75 — half speed, which is what an author actually noticed.
 *
 * So the numbers are derived from the engine's constants here and nowhere else. A pose the engine
 * really animates has an entry; anything else falls back to {@link PREVIEW_FALLBACK_FRAME_MS},
 * which exists only so an editor can show authored frames cycling at all.
 *
 * Milliseconds rather than seconds because every consumer is a clock in ms (`delta`,
 * `setInterval`), and doing the ×1000 once is one place for it to be wrong.
 */
import {
  COFFEE_FRAME_DURATION_SEC,
  PET_DRINK_FRAME_DURATION_SEC,
  PET_IDLE_FRAME_DURATION_SEC,
  PET_TAIL_WAG_DURATION_SEC,
  PET_TALK_FRAME_DURATION_SEC,
  PET_WALK_FRAME_DURATION_SEC,
  TYPE_FRAME_DURATION_SEC,
  WALK_FRAME_DURATION_SEC,
} from './constants.js';

/** What the two kinds of art are animated as. The pet one is server-driven. */
export type PoseKind = 'character' | 'pet';

/**
 * Character poses, as the client's animation clock advances them.
 *
 * A pose that is NOT here is static, and `idle` is deliberately absent: a character's idle is the
 * neutral standing frame. `sit` carries the typing cadence as a placeholder — it only animates when
 * a sit track is actually authored.
 */
export const CHARACTER_POSE_FRAME_MS: Readonly<Record<string, number>> = {
  walk: WALK_FRAME_DURATION_SEC * 1000,
  typing: TYPE_FRAME_DURATION_SEC * 1000,
  reading: TYPE_FRAME_DURATION_SEC * 1000,
  coffee: COFFEE_FRAME_DURATION_SEC * 1000,
  sit: TYPE_FRAME_DURATION_SEC * 1000,
};

/**
 * Pet poses, as `engine/pets.ts` advances them — one entry per `advancePetFrame` call site.
 *
 * `sit` is the tail wag, which is what a sitting pet does. `sleep` is absent on purpose: there is
 * no sleep state in the engine, so an authored sleep track is never animated in the world.
 */
export const PET_POSE_FRAME_MS: Readonly<Record<string, number>> = {
  walk: PET_WALK_FRAME_DURATION_SEC * 1000,
  idle: PET_IDLE_FRAME_DURATION_SEC * 1000,
  sit: PET_TAIL_WAG_DURATION_SEC * 1000,
  drink: PET_DRINK_FRAME_DURATION_SEC * 1000,
  talk: PET_TALK_FRAME_DURATION_SEC * 1000,
};

/**
 * Cadence for a pose an EDITOR wants to preview but the world never animates (a character's idle,
 * a pet's sleep). Not a game value and must never be used as one — the game's answer for those
 * poses is "static", and a renderer that picked this up would animate something that stands still
 * everywhere else.
 */
export const PREVIEW_FALLBACK_FRAME_MS = 250;

/** The world's cadence for a pose, or 0 when the world holds that pose still. */
export function poseFrameMs(pose: string, kind: PoseKind): number {
  const table = kind === 'pet' ? PET_POSE_FRAME_MS : CHARACTER_POSE_FRAME_MS;
  return table[pose] ?? 0;
}

/**
 * The cadence a preview should use: the world's, and only where the world has none, something
 * visible. Keep the two apart at the call site — a renderer wants {@link poseFrameMs}.
 */
export function previewFrameMs(pose: string, kind: PoseKind): number {
  return poseFrameMs(pose, kind) || PREVIEW_FALLBACK_FRAME_MS;
}
