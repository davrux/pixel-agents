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
}

export const KART_SHEET: VehicleSheet = { id: 'kart', frameW: 24, frameH: 24, headings: 16 };

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
