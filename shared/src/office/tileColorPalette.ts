import type { ColorValue } from './colorTypes.js';

/** Closed set of floor/wall tint choices (OfficeLayout.tileColorIndex) — a
 *  fixed palette instead of the free h/s/b/c sliders this replaced, so a
 *  tile's color is "which swatch" rather than an arbitrary continuous value.
 *  This is what makes tile coloring map cleanly onto a Tiled tileset (one
 *  pre-tinted tile per pattern×swatch, chosen like any other tile) instead of
 *  a per-cell property Tiled tile layers can't carry (see office/tiled-schema
 *  design notes). 16 hues, evenly spaced (360/16 = 22.5°), at one shared
 *  saturation/brightness/contrast — plenty to tell rooms/zones apart while
 *  staying a browsable click-grid in the editor. */
export const TILE_COLOR_PALETTE: readonly ColorValue[] = Array.from({ length: 16 }, (_, i) => ({
  h: i * 22.5,
  s: 35,
  b: 0,
  c: 0,
  colorize: true,
}));

/** Resolve a stored palette index (OfficeLayout.tileColorIndex entry) to its
 *  ColorValue — null/out-of-range (e.g. a stale index after a palette
 *  shrink) resolves to null, same as "no tint". */
export function resolveTileColor(index: number | null | undefined): ColorValue | null {
  if (index == null) return null;
  return TILE_COLOR_PALETTE[index] ?? null;
}
