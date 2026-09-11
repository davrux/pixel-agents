/**
 * World effects that are their own art rather than a pose on a pawn.
 *
 * There is exactly one today, and the reason it is not a pose is worth keeping: the scuffle cloud
 * hangs BETWEEN two pets, so no single sheet could hold it — a pet's `scuffle` track would have to
 * cover the gap between two tiles, and a comic puff is funny because it hides BOTH animals. It is
 * also not a PAWN (AGENTS.md's expensive direction): nothing possesses it, it has no transform of
 * its own and no controller. It is a picture the client draws over state the server decided.
 *
 * The metadata lives here, in `shared`, because both sides need it and neither should guess: the
 * server serves the bytes at `/art/effect/<id>` and the renderer slices the sheet by these numbers.
 * That also means the sheet needs no message on the wire at all — the id is a constant of the
 * build, so the client simply fetches it during its loading phase.
 */

/** A sheet of equal cells in ONE row — an effect has no facing, unlike a pawn's art. */
export interface EffectSheet {
  /** Art id: `/art/effect/<id>`, and the key the client registers the sheet under. */
  id: string;
  frameW: number;
  frameH: number;
  frames: number;
}

/**
 * The puff two pets vanish into when a hunter catches its quarry.
 *
 * 32 px wide because it must cover two ADJACENT 16 px pets and the seam between them; 32 tall so
 * the paw and the flecks have room above the mass without being clipped. Four frames: enough for
 * the outline to boil, few enough that the whole sheet is one atlas row.
 */
export const SCUFFLE_SHEET: EffectSheet = {
  id: 'scuffle',
  frameW: 32,
  frameH: 32,
  frames: 4,
};

/**
 * The Matrix rain, as a TILING texture rather than a frame sequence.
 *
 * `frames: 1`, and that is not an oversight: this sheet is never played, it is SCROLLED. Three
 * things decided that shape, in this order.
 *
 * **Why a tile and not frames.** The sweep has to cross the whole figure, and figures run from
 * 16×32 to 64×64 (`CharacterSpec`). Frames authored for one height either stretch on a taller
 * character — fat drops on one figure and fine ones on the next — or crop. A tile keeps its pixel
 * size at every frame size and costs one draw call whatever the figure is.
 *
 * **Why the drops sit in a BAND at the top instead of filling the tile.** The effect is a
 * wavefront: a bright head with a fading tail passing down the body once, not rain everywhere for
 * the whole duration. Scrolling a tile that is empty except for one band reproduces exactly that,
 * with the band's position being the only thing the renderer computes.
 *
 * **Why 32×128 and a 28-pixel band.** Both dimensions are powers of two, because a tiling texture
 * is sampled with GL_REPEAT and non-power-of-two sizes are where that stops being portable. The
 * gap that follows the band is 100 px — more than the tallest legal figure — so a character can
 * never show two bands at once, which would read as continuous rain rather than one sweep.
 */
export const MATRIX_RAIN_SHEET: EffectSheet = {
  id: 'matrix-rain',
  frameW: 32,
  frameH: 128,
  frames: 1,
};

/** How much of `MATRIX_RAIN_SHEET` carries drops, measured from its top edge. */
export const MATRIX_RAIN_BAND_PX = 28;

/**
 * The beam: a column of light that sweeps the figure, as a TILING texture like the rain.
 *
 * Same shape and the same two draws, because the problem is the same one — the sweep has to cross
 * figures from 16x32 to 64x64, and frames authored for one height either stretch or crop. What
 * differs is only the picture in the tile: one bright column with soft edges instead of a band of
 * glyphs.
 */
export const BEAM_SHEET: EffectSheet = {
  id: 'beam',
  frameW: 32,
  frameH: 128,
  frames: 1,
};

/** How much of `BEAM_SHEET` carries the beam, measured from its top edge. */
export const BEAM_BAND_PX = 40;

/**
 * The phoenix flame, as a frame sequence over the figure — not a tile.
 *
 * A flame is not a wavefront: it sits where the figure is and boils, so scrolling one band across
 * it would read as a passing light rather than as burning. 24x32 covers a 16x32 figure with room
 * for the flame to lick above the head, and a taller figure gets it scaled to its frame, which is
 * honest for fire in a way it would not be for pixel rain.
 */
export const PHOENIX_SHEET: EffectSheet = {
  id: 'phoenix',
  frameW: 24,
  frameH: 32,
  frames: 6,
};

/** Every effect sheet, for the client's loading phase and the server's art registry. */
export const EFFECT_SHEETS: readonly EffectSheet[] = [SCUFFLE_SHEET, MATRIX_RAIN_SHEET, BEAM_SHEET, PHOENIX_SHEET];

/**
 * How a pawn leaves and arrives — the one table, and the only place a style is named.
 *
 * A warp is not decoration: between `despawn` and `spawn` the server MOVES the body
 * (`officeState.update`'s pendingWarp branch), so the effect is what hides a real teleport. Two
 * consequences that decide the shape of this table:
 *
 *  - **The duration belongs to the world, not to the renderer.** It is where the body is
 *    repositioned, so a style that took longer on one viewer's machine would show the jump on
 *    another. It lives here, per style, and the engine reads it.
 *  - **An unknown id resolves to the DEFAULT, never to "no effect".** That is the opposite of the
 *    `ControllerKind` rule, where the zero value is deliberately inert — and for the opposite
 *    reason: an unclaimed pawn should do nothing, while an unstyled warp still has to cover the
 *    teleport. A style that resolved to nothing would let the figure visibly pop.
 *
 * Everything else about a style — frames, curves, tinting, how the body is revealed — is
 * presentation and lives in the client (AGENTS.md invariant 2). What is here is what both sides
 * must agree on: the id, how long it takes, and which art it needs fetched.
 */
export type WarpStyleId = 'matrix' | 'beam' | 'phoenix' | 'implode';

export interface WarpStyle {
  id: WarpStyleId;
  /** Shown in the settings picker; the client never invents its own label for a style. */
  label: string;
  /** Seconds per PHASE — one for the dissolve, one for the materialise. */
  durationSec: number;
  /** The sheet this style draws with, or null when it needs no art of its own. */
  sheet: EffectSheet | null;
}

export const WARP_STYLES: readonly WarpStyle[] = [
  { id: 'matrix', label: 'Matrix', durationSec: 0.7, sheet: MATRIX_RAIN_SHEET },
  { id: 'beam', label: 'Beam', durationSec: 0.8, sheet: BEAM_SHEET },
  // Longer, because a flame has to catch, burn and die back to read as one; at 0.7 it looks like
  // a flicker rather than a cremation.
  { id: 'phoenix', label: 'Phoenix', durationSec: 1.0, sheet: PHOENIX_SHEET },
  // Shorter and art-free: the figure is squeezed to a point and flashes. A transform on the frame
  // the renderer already has, which is why this one needs no sheet at all.
  { id: 'implode', label: 'Implosion', durationSec: 0.5, sheet: null },
];

export const DEFAULT_WARP_STYLE: WarpStyleId = 'matrix';

/** The style for an id, falling back to the default for anything unknown or empty — see the note
 *  on the table about why the fallback is a real effect and not none. */
export function warpStyle(id: string | null | undefined): WarpStyle {
  return WARP_STYLES.find((s) => s.id === id) ?? WARP_STYLES.find((s) => s.id === DEFAULT_WARP_STYLE)!;
}

/** Whether an id is one this build knows — the gate for anything a client or a stored row says. */
export function isWarpStyleId(id: unknown): id is WarpStyleId {
  return typeof id === 'string' && WARP_STYLES.some((s) => s.id === id);
}

/**
 * Where the band has to sit in the texture for a sweep that has got `progress` of the way down a
 * figure `frameH` pixels tall.
 *
 * Phaser shows the texture starting at `tilePositionY`, so texture row `y` lands on sprite row
 * `y - tilePositionY`: the band (texture rows 0…BAND) is on screen at `-tilePositionY`. The sweep
 * therefore runs from just above the head (band bottom at the sprite's top edge) to just below the
 * feet, which is one pass and never a second one — the sheet's 100-pixel empty gap is taller than
 * the tallest legal figure, so the next copy of the band cannot come into view behind this one.
 */
export function matrixRainScrollY(progress: number, frameH: number): number {
  return MATRIX_RAIN_BAND_PX - progress * (frameH + MATRIX_RAIN_BAND_PX);
}

/**
 * A horizontal offset per character, so two figures materialising side by side do not show the
 * identical drops. Whole pixels only (the art is pixel art), and derived from the id rather than
 * randomised, so a figure's rain does not jump when the sprite is rebuilt.
 */
export function matrixRainScrollX(id: number): number {
  return Math.abs(id * 11) % MATRIX_RAIN_SHEET.frameW;
}
