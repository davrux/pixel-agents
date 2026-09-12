/**
 * What the vehicles look like: one picture each, pointing EAST, rotated by the heading.
 *
 * This replaced a hand-drawn strip of sixteen headings. Two reasons, and the second is the one
 * that matters: rotating one image is SMOOTHER than sixteen discrete steps — a kart no longer
 * snaps between frames as it turns — and it is a fraction of the art, so a second vehicle is a
 * file rather than a redraw. The strip existed because a top-down kart drawn by hand has to be
 * drawn per angle; a rendered car does not.
 *
 * The art is Dust Racing 2D's, under CC BY-SA 3.0 — see `assets/vehicles/dust/README.md`, which
 * carries the attribution and the share-alike obligation. It is the one part of this repository
 * that is not MIT, and it is confined to those image files.
 *
 * Order is the WIRE order: `KartSync.art` is an index into this list, so append only. A kart takes
 * the colour of its grid slot, which is what makes a field of eight tell itself apart.
 */

export interface VehicleArt {
  /** Served as `/art/vehicle/<id>` and the sheet-store key. */
  id: string;
  /** The file under `assets/vehicles/dust/` it is built from. */
  source: string;
  /** Game-scale size in pixels. Two tiles long, so it reads as a car on a five-tile road. */
  w: number;
  h: number;
}

/** Two tiles and a bit long. Bigger and it will not fit two abreast on the road. */
const W = 34;
const H = 18;

export const VEHICLE_ART: readonly VehicleArt[] = [
  { id: 'car-red', source: 'carRed.png', w: W, h: H },
  { id: 'car-blue', source: 'carBlue.png', w: W, h: H },
  { id: 'car-yellow', source: 'carYellow.png', w: W, h: H },
  { id: 'car-green', source: 'carGreen.png', w: W, h: H },
  { id: 'car-orange', source: 'carOrange.png', w: W, h: H },
  { id: 'car-violet', source: 'carViolet.png', w: W, h: H },
  { id: 'car-cyan', source: 'carCyan.png', w: W, h: H },
  { id: 'car-pink', source: 'carPink.png', w: W, h: H },
];

/** The art for a wire index — anything this build does not know is the first car, never nothing. */
export function vehicleArt(index: number): VehicleArt {
  return VEHICLE_ART[index] ?? VEHICLE_ART[0];
}
