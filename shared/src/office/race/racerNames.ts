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
];

/**
 * Skill, 0…1, handed out in this order.
 *
 * A RANGE, not a difficulty setting: the first kart out of the pits is the quick one and the last
 * is beatable by anybody, so a grid is a field rather than a train of identical karts and a
 * beginner finishes ahead of somebody on their first try. Nobody is at 1.0 — a driver that never
 * makes a mistake is a wall, not an opponent.
 */
export const RACER_SKILLS: readonly number[] = [0.92, 0.78, 0.66, 0.55, 0.85, 0.72, 0.6, 0.48];
