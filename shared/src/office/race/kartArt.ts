/**
 * What a kart looks like: one committed sheet, sixteen headings, and the arithmetic that picks one.
 *
 * A kart is a PAWN (AGENTS.md, "Adding a pawn kind"), so its art belongs to the body and not to
 * whatever drives it — which is why this lives beside the model rather than in `effects.ts`. It is
 * still served the same way the effect sheets are, as a file that ships with the build: the id is a
 * constant, so no message carries it and the client fetches `/art/vehicle/<id>` in its loading
 * phase.
 *
 * SIXTEEN headings rather than the four a character has, asked for by name, and the number is the
 * whole reason this is a sheet and not a rotated sprite: a kart is seen from directly above, so a
 * turned picture of one is a different picture, not the same one at an angle — the wheels, the
 * nose and the seat all foreshorten differently. Sixteen puts 22.5° between frames, which at the
 * turn rate is about a seventh of a second of steering, so the wheel reads as continuous.
 */

/** One vehicle sheet: a strip of headings, frame 0 pointing EAST and going clockwise on screen. */
export interface VehicleSheet {
  id: string;
  frameW: number;
  frameH: number;
  /** How many headings the strip carries. */
  headings: number;
  /** Rows in the sheet — see `VEHICLE_LAYER`. */
  rows: number;
}

/**
 * The sheet's two rows, and the reason a kart is drawn twice.
 *
 * A driver is a separate sprite standing at the kart's seat, so with one layer they are simply
 * ON the bodywork — reported as "die Figur sitzt nicht wirklich drin, sondern wird dahinter
 * gerendert". Splitting the art at the seat fixes it with no new concept: what is BEHIND the
 * driver is drawn first, the body goes on top of that, and what is IN FRONT of them — the nose,
 * the steering wheel, the front wheels — is drawn last, over their legs. Three draws per kart,
 * and the figure is inside the tub instead of on it.
 */
export const VEHICLE_LAYER = { BEHIND: 0, FRONT: 1 } as const;

/**
 * 40 px, not 24: at a tile and a half the kart was narrower than the 16 px figure sitting in it,
 * which is what "die Carts sind zu klein" measured. The tub is 16 wide now and the track 22, so
 * the driver fits inside it.
 *
 * The frame is set by the DIAGONAL, not by the kart: every heading is the same body turned, so a
 * 30×22 kart sweeps a 37 px circle and anything smaller clips its own corners at 45°.
 */
export const KART_SHEET: VehicleSheet = { id: 'kart', frameW: 40, frameH: 40, headings: 16, rows: 2 };

/** Every sheet the art route will answer for. An id not in here can only 404. */
export const VEHICLE_SHEETS: readonly VehicleSheet[] = [KART_SHEET];

/**
 * Which frame of the strip draws a heading. Rounds to the NEAREST heading rather than flooring,
 * so a kart pointing a hair past east still draws east instead of jumping a frame early; the
 * modulo after rounding is what catches the wrap at the top of the circle.
 */
export function vehicleFrame(sheet: VehicleSheet, heading: number): number {
  const step = (Math.PI * 2) / sheet.headings;
  return ((Math.round(heading / step) % sheet.headings) + sheet.headings) % sheet.headings;
}
