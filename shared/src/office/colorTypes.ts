/** Colour value the floor/wall bake recolours a grayscale pattern with (see colorize.ts).
 *  `colorize?: boolean` used to pick between two modes; the second one had no caller and is
 *  gone, so there is nothing left to choose. */
export interface ColorValue {
  h: number;
  s: number;
  b: number;
  c: number;
}
