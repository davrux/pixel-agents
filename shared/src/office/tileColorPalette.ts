/** Closed set of floor/wall tint choices (OfficeLayout.tileColorIndex) — a
 *  fixed palette instead of the free h/s/b/c sliders this replaced, so a
 *  tile's color is "which swatch" rather than an arbitrary continuous value.
 *  This is what makes tile coloring map onto a real Tiled tileset later (one
 *  pre-baked tile per pattern×swatch, chosen like any other tile) instead of
 *  a per-cell property Tiled tile layers can't carry (see office/tiled-schema
 *  design notes).
 *
 *  DawnBringer's 32 Color Palette (DB32) — a widely-used, freely licensed
 *  pixel-art palette with a real hand-picked hue/light/dark spread, chosen
 *  over a mechanically-generated hue wheel: https://lospec.com/palette-list/dawnbringer-32
 *  These are genuine RGB colors, not h/s/b/c tint parameters — see
 *  colorize.ts's colorizeToPalette, which tints a tile toward one of these
 *  hues and then snaps every resulting pixel back onto the exact palette
 *  color closest to it, so the baked tile only ever contains real DB32
 *  colors (no in-between blend). */
export const TILE_COLOR_PALETTE: readonly string[] = [
  '#000000',
  '#222034',
  '#45283C',
  '#663931',
  '#8F563B',
  '#DF7126',
  '#D9A066',
  '#EEC39A',
  '#FBF236',
  '#99E550',
  '#6ABE30',
  '#37946E',
  '#4B692F',
  '#524B24',
  '#323C39',
  '#3F3F74',
  '#306082',
  '#5B6EE1',
  '#639BFF',
  '#5FCDE4',
  '#CBDBFC',
  '#FFFFFF',
  '#9BADB7',
  '#847E87',
  '#696A6A',
  '#595652',
  '#76428A',
  '#AC3232',
  '#D95763',
  '#D77BBA',
  '#8F974A',
  '#8A6F30',
];

/** Resolve a stored palette index (OfficeLayout.tileColorIndex entry) to its
 *  hex color — null/out-of-range (e.g. a stale index after a palette shrink)
 *  resolves to null, same as "no tint". */
export function resolveTileColor(index: number | null | undefined): string | null {
  if (index == null) return null;
  return TILE_COLOR_PALETTE[index] ?? null;
}
