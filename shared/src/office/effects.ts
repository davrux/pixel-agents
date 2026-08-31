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

/** Every effect sheet, for the client's loading phase and the server's art registry. */
export const EFFECT_SHEETS: readonly EffectSheet[] = [SCUFFLE_SHEET];
