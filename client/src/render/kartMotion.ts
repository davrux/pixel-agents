/**
 * How a car is drawn BETWEEN patches — the one piece of presentation timing a race needs.
 *
 * The server states a kart's position twenty times a second and the screen draws sixty; at twelve
 * tiles a second the car covers 16 px between two patches, so what happens in the gap is not a
 * detail. Easing towards the last known position — which is what every other pawn does, and what
 * this did until protocol 30 — is a lag filter being fed a staircase, and it pulses: measured over
 * a perfectly steady 47 fps, the drawn step varied between **4.1 px and 9.2 px where a constant
 * 320 px/s wants 6.8** (a 75 % ripple; 106 % with 8 ms of frame jitter). Reported as "ich habe
 * zwar 47 fps aber irgendwie ruckelt es", which is the right way round: the frame rate was never
 * what was wrong.
 *
 * So the target is where the car WILL be, and the drawing is eased towards THAT. Against a
 * constant speed the step comes out dead constant, because the target now moves at the same rate
 * the drawing does instead of standing still between patches.
 *
 * Three decisions rather than details:
 *
 *  - **The velocity is synced, not differentiated.** The server has the number; a client
 *    reconstructing it from two positions is recomputing a decision from partial data, which
 *    AGENTS.md' invariant 2 refuses by name — and it is worse, being one patch stale on a corner.
 *  - **The carry is capped at one patch.** A patch that is late may never come (a paused tab, a
 *    dropped socket, a car that has just been put somewhere), and predicting on into the distance
 *    turns a stall into a car driving into the scenery and snapping back. Past the cap the target
 *    stops advancing and the ease closes the gap.
 *  - **Rendering one patch in the PAST was the alternative, and it is exactly as smooth** (ripple
 *    0 % in the same measurement) with no velocity on the wire at all. It costs 50 ms of latency
 *    on the car you are steering, on top of the network. Two rules for one collection — the past
 *    for other people's cars, the future for yours — is worse than those 50 ms are bad.
 */

/** How far past its last snapshot a kart may be carried. One patch at the 20 Hz patch rate. */
export const KART_CARRY_MS = 50;

/**
 * How fast the drawn position closes on the carried one, per second.
 *
 * Faster than the 18/s the old ease used, and it can afford to be: what it has to absorb is the
 * prediction's error rather than the whole 16 px of a patch. Quick is also what keeps a wall from
 * rubber-banding — the one moment the prediction is certain to be wrong.
 */
export const KART_CATCH_UP_PER_SEC = 30;

/**
 * Where a kart is now: its last synced position carried along its synced velocity.
 *
 * `ageMs` is how long ago that snapshot arrived, and it is clamped into [0, `KART_CARRY_MS`] here
 * rather than by the caller — a negative age is what two clocks disagreeing looks like, and it
 * would drag the car backwards.
 */
export function carriedPoint(
  tx: number,
  ty: number,
  vx: number,
  vy: number,
  ageMs: number,
): { x: number; y: number } {
  const age = Math.min(KART_CARRY_MS, Math.max(0, ageMs)) / 1000;
  return { x: tx + vx * age, y: ty + vy * age };
}
