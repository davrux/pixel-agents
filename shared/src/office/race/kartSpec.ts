/**
 * What a kart is made of, as data — the seam tuning goes through.
 *
 * Every number the handling reads lives on a SPEC rather than in the model, so a second kind of
 * kart is a row in a table and not a branch in `updateKart`. Nothing about choosing one is built
 * yet (no UI, no persistence, no per-player choice); what exists is the shape that makes those
 * cheap to add, which is what "make it tunable later" asks for and all it asks for.
 *
 * Three rules keep the table honest:
 *
 *  - **The default is the balanced one and it holds the constants' own values.** So a world that
 *    never touches specs behaves exactly as before, and `constants.ts` stays the one place the
 *    baseline is written down rather than being copied into a table beside it.
 *  - **A spec trades, it does not upgrade.** `speed` gives up grip for pace and `grip` the other
 *    way round; a row that is better at everything is not tuning, it is a reward, and it makes
 *    every other row pointless the day somebody unlocks it.
 *  - **An unknown id resolves to the default, never to nothing.** Same rule as the warp styles
 *    (AGENTS.md): a kart with a spec this build does not know is still a drivable kart.
 */
import {
  KART_ACCEL_PX_PER_SEC2,
  KART_BRAKE_PX_PER_SEC2,
  KART_GRIP_PX_PER_SEC2,
  KART_MAX_SPEED_PX_PER_SEC,
  KART_TURN_RADIUS_PX,
} from '../constants.js';

export interface KartSpec {
  id: string;
  label: string;
  /** Top speed along the heading, px/s. */
  maxSpeed: number;
  accel: number;
  brake: number;
  /** The most sideways speed the tyres kill per second, px/s². Lower slides sooner. */
  grip: number;
  /** The tightest circle it can be steered round, px. Smaller turns harder — and asks more of
   *  the tyres, since a corner demands `v² / radius`. */
  turnRadius: number;
}

const BALANCED: KartSpec = {
  id: 'balanced',
  label: 'Balanced',
  maxSpeed: KART_MAX_SPEED_PX_PER_SEC,
  accel: KART_ACCEL_PX_PER_SEC2,
  brake: KART_BRAKE_PX_PER_SEC2,
  grip: KART_GRIP_PX_PER_SEC2,
  turnRadius: KART_TURN_RADIUS_PX,
};

export const KART_SPECS: readonly KartSpec[] = [
  BALANCED,
  // Faster in a straight line and it will not stay with the balanced kart through a corner.
  { ...BALANCED, id: 'sprinter', label: 'Sprinter', maxSpeed: 249, accel: 325, grip: 520, turnRadius: 98 },
  // Slower down the straight, holds a tighter line, and can be driven flat out where the other
  // two have to lift.
  { ...BALANCED, id: 'gripper', label: 'Gripper', maxSpeed: 184, accel: 260, grip: 700, turnRadius: 68 },
];

export const DEFAULT_KART_SPEC = BALANCED;

/** The spec for an id — the default for anything this build does not recognise. */
export function kartSpec(id: string | null | undefined): KartSpec {
  return KART_SPECS.find((s) => s.id === id) ?? DEFAULT_KART_SPEC;
}
