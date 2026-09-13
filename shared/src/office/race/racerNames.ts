/**
 * Who you are racing: the names on the board, and how quick each one is.
 *
 * Names rather than "Bot 3", because the result board is read by a person and a list of numbers
 * is not a race. They are deliberately plain and a little daft — this is a kart in an office
 * world, not a licensed grid.
 */
export const RACER_NAMES: readonly string[] = [
  'Rocket',
  'Bolt',
  'Turbo',
  'Dash',
  'Comet',
  'Blaze',
  'Nitro',
  'Zip',
  'Ember',
  'Vortex',
  'Piston',
  'Quasar',
];

/**
 * Skill, 0…1, handed out in this order.
 *
 * A RANGE, not a difficulty setting: the first kart out of the pits is the quick one and the last
 * is beatable by anybody, so a grid is a field rather than a train of identical karts and a
 * beginner finishes ahead of somebody on their first try. Nobody is at 1.0 — a driver that never
 * makes a mistake is a wall, not an opponent.
 */
export const RACER_SKILLS: readonly number[] = [0.92, 0.78, 0.66, 0.55, 0.85, 0.72, 0.6, 0.48, 0.88, 0.69, 0.58, 0.5];

/**
 * How hard the field is, as a factor on every skill.
 *
 * Dust Racing offers Easy / Medium / Hard and so does this. It scales the whole GRID rather than
 * adding a faster rival, so the spread of pace survives at every level — there is somebody to beat
 * on hard and somebody to chase on easy, which a single "the AI is faster now" knob destroys.
 */
export type RaceDifficulty = 'easy' | 'medium' | 'hard';

export const DIFFICULTY: Record<RaceDifficulty, number> = {
  easy: 0.72,
  medium: 1,
  hard: 1.16,
};

/** Wire order, and therefore APPEND-ONLY: the setting travels as an index so it fits in a byte
 *  beside the other three, and reordering this would change what a stored or in-flight one means. */
export const RACE_DIFFICULTIES: readonly RaceDifficulty[] = ['easy', 'medium', 'hard'];

/** The one a `/race` with no argument runs. */
export const DEFAULT_DIFFICULTY: RaceDifficulty = 'medium';

/** Is this a difficulty this build knows? A typed argument from a client is checked, never cast. */
export function isDifficulty(value: unknown): value is RaceDifficulty {
  return value === 'easy' || value === 'medium' || value === 'hard';
}
