/**
 * What the vehicles look like: one picture each, pointing EAST, rotated by the heading.
 *
 * This replaced a hand-drawn strip of sixteen headings. Two reasons, and the second is the one
 * that matters: rotating one image is SMOOTHER than sixteen discrete steps — a kart no longer
 * snaps between frames as it turns — and it is a fraction of the art, so a second vehicle is a
 * file rather than a redraw. The strip existed because a top-down kart drawn by hand has to be
 * drawn per angle; a rendered car does not.
 *
 * The art is a KART again, drawn by `scripts/draw-karts.sh` from a shape description rather than
 * cut from a pack. Dust Racing's cars were the right call for "make it look like the original" and
 * the wrong one for what this is: a race in this world is meant to be funny before it is meant to
 * be accurate, which was asked for in those words. What the cars DID get right is kept — one
 * picture per vehicle, rotated by the heading, instead of the sixteen hand-drawn headings the
 * first kart strip carried, because sixteen discrete angles is a kart that snaps as it turns.
 *
 * Order is the WIRE order: `KartSync.art` is an index into this list, so append only. A kart takes
 * the colour of its grid slot, which is what makes a field of eight tell itself apart.
 */

export interface VehicleArt {
  /** Served as `/art/vehicle/<id>` and the sheet-store key. */
  id: string;
  /** Game-scale size in pixels. */
  w: number;
  h: number;
}

/**
 * Two and a half tiles long, and that is a KART rather than a shrunken car.
 *
 * A go-kart is about half the length of a car, and drawing one at a car's size would be a car
 * with the roof off. Against the world it still reads correctly — a character is 16×32, so a kart
 * is a little over two of them long, which is what a kart is.
 *
 * It buys back the thing the big cars cost: the sense of speed is length per second, and 260 px/s
 * is four car-lengths but six and a half kart-lengths. Everything geometric follows the number —
 * the collision radius is half the width, and the roads did not have to change because a smaller
 * vehicle on the same road is more room, not less.
 */
const W = 40;
const H = 32;

export const VEHICLE_ART: readonly VehicleArt[] = [
  { id: 'car-red', w: W, h: H },
  { id: 'car-blue', w: W, h: H },
  { id: 'car-yellow', w: W, h: H },
  { id: 'car-green', w: W, h: H },
  { id: 'car-orange', w: W, h: H },
  { id: 'car-violet', w: W, h: H },
  { id: 'car-cyan', w: W, h: H },
  { id: 'car-pink', w: W, h: H },
];

/** The art for a wire index — anything this build does not know is the first car, never nothing. */
export function vehicleArt(index: number): VehicleArt {
  return VEHICLE_ART[index] ?? VEHICLE_ART[0];
}
