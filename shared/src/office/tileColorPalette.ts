import type { ColorValue } from './colorTypes.js';

/** Closed set of floor/wall tint choices (OfficeLayout.tileColorIndex) — a
 *  fixed palette instead of the free h/s/b/c sliders this replaced, so a
 *  tile's color is "which swatch" rather than an arbitrary continuous value.
 *  This is what makes tile coloring map cleanly onto a Tiled tileset (one
 *  pre-tinted tile per pattern×swatch, chosen like any other tile) instead of
 *  a per-cell property Tiled tile layers can't carry (see office/tiled-schema
 *  design notes).
 *
 *  16 hues, evenly spaced (360/16 = 22.5°), each in two brightness levels —
 *  indices 0-15 are the normal tone, 16-31 the dark tone of the *same* hue
 *  (index i and i+16 always share a hue), so there's a proper dark option for
 *  every hue, not just more hue resolution. */
const HUE_COUNT = 16;
const HUE_STEP = 360 / HUE_COUNT;
const BRIGHTNESS_LEVELS = [0, -45] as const; // normal, dark
export const TILE_COLOR_PALETTE: readonly ColorValue[] = BRIGHTNESS_LEVELS.flatMap((b) =>
  Array.from({ length: HUE_COUNT }, (_, i) => ({ h: i * HUE_STEP, s: 35, b, c: 0, colorize: true })),
);

/** Resolve a stored palette index (OfficeLayout.tileColorIndex entry) to its
 *  ColorValue — null/out-of-range (e.g. a stale index after a palette
 *  shrink) resolves to null, same as "no tint". */
export function resolveTileColor(index: number | null | undefined): ColorValue | null {
  if (index == null) return null;
  return TILE_COLOR_PALETTE[index] ?? null;
}
