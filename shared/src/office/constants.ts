// ── Grid & Layout ────────────────────────────────────────────
export const TILE_SIZE = 16;
export const DEFAULT_COLS = 20;
export const DEFAULT_ROWS = 11;
export const MAX_COLS = 100;
export const MAX_ROWS = 100;

// ── Character Animation ─────────────────────────────────────
// 2x the original pace (48 px/s, 0.15s/frame) — WorkAdventure-style brisker
// walking; frame duration halved alongside speed so the stride still reads
// as the same length, not a slide.
export const WALK_SPEED_PX_PER_SEC = 96;
export const WALK_FRAME_DURATION_SEC = 0.075;
export const TYPE_FRAME_DURATION_SEC = 0.3;
export const WANDER_PAUSE_MIN_SEC = 2.0;
export const WANDER_PAUSE_MAX_SEC = 20.0;
export const WANDER_MOVES_BEFORE_REST_MIN = 3;
export const WANDER_MOVES_BEFORE_REST_MAX = 6;
export const SEAT_REST_MIN_SEC = 120.0;
export const SEAT_REST_MAX_SEC = 240.0;

// ── Interaction stations (coffee machine, …) ────────────────
/** Chance, per idle wander decision, that an inactive agent heads for coffee. */
export const COFFEE_BREAK_CHANCE = 0.12;
/** How long an agent stands at a station before resuming. */
export const COFFEE_STAND_MIN_SEC = 4.0;
export const COFFEE_STAND_MAX_SEC = 9.0;
/** Coffee (standing) animation: frame duration + frame count the server cycles.
 *  Matches the dedicated art's frame count; the renderer also clamps to the
 *  actual number of frames, so the static-idle fallback stays still. */
export const COFFEE_FRAME_DURATION_SEC = 0.5;
export const COFFEE_FRAME_COUNT = 2;
/** Cooldown between coffee breaks (also the randomised initial delay). */
export const COFFEE_COOLDOWN_MIN_SEC = 30.0;
export const COFFEE_COOLDOWN_MAX_SEC = 90.0;

// ── Pets ─────────────────────────────────────────────────────
// Pets spawn based on connected agents: target = min(PET_MAX, floor(agents / PET_AGENTS_PER_PET))
const PET_AGENTS_PER_PET = 2;
const PET_MAX = 4;
export const PET_LIFESPAN_SEC = 600; // ~10 minutes
export const PET_WALK_SPEED_PX_PER_SEC = 40;
export const PET_WALK_FRAME_DURATION_SEC = 0.12;
export const PET_TAIL_WAG_DURATION_SEC = 0.35;
export const PET_WANDER_PAUSE_MIN_SEC = 1.5;
export const PET_WANDER_PAUSE_MAX_SEC = 8;
export const PET_SIT_MIN_SEC = 8;
export const PET_SIT_MAX_SEC = 25;
export const PET_SIT_CHANCE = 0.4; // chance a wander decision targets furniture
// Shoo-cat (N3.3b): a dog within this many tiles of a cat will chase it, and a
// cat flees a dog within this range. PET_FLEE_RANGE_TILES caps how far the cat
// bolts so it doesn't sprint across the whole office.
export const PET_SHOO_RADIUS_TILES = 5;
export const PET_FLEE_RANGE_TILES = 7;
// Coffee (N3.3c): chance an idle pet heads to a free appliance station, and how
// long it stands there once arrived.
export const PET_DRINK_CHANCE = 0.15;
export const PET_DRINK_MIN_SEC = 4;
export const PET_DRINK_MAX_SEC = 10;
export const PET_DRINK_FRAME_DURATION_SEC = 0.4; // cadence for an authored drink track
export const PET_IDLE_FRAME_DURATION_SEC = 0.4; // cadence for an authored multi-frame idle
// Talk-to-agent (N3.3d): chance an idle pet trots over to an agent, how long it
// stands chatting, and the cadence for an authored talk track.
export const PET_TALK_CHANCE = 0.12;
export const PET_TALK_MIN_SEC = 3;
export const PET_TALK_MAX_SEC = 8;
export const PET_TALK_FRAME_DURATION_SEC = 0.4;
export const PET_EFFECT_DURATION_SEC = 0.3;
export const PET_Z_SORT_OFFSET = 0.5;

// ── Matrix Effect ────────────────────────────────────────────
/** How long a character takes to materialise or dissolve. A warp plays both
 *  halves back to back, so it costs twice this. Long enough that the sweep
 *  reads as an animation rather than as a frame that failed to draw. */
export const MATRIX_EFFECT_DURATION_SEC = 0.7;
/** How many rows the rain trails behind its head. Sized against the sprite it
 *  sweeps: at 6 rows on a 32-row character the green was a thin band with a
 *  hard edge in front of it, which read as a wipe. */
export const MATRIX_TRAIL_LENGTH = 12;
/** How many per-column rain seeds to generate. NOT the sprite's width — the
 *  effect measures that off the sprite itself (see renderMatrixEffect), because
 *  frame size is per-character and a fixed 16×24 cut every 16×32 character off
 *  at the knees for the whole animation. This is just an upper bound, matching
 *  the largest frame the character editor allows; surplus seeds cost nothing. */
export const MATRIX_SEED_COUNT = 64;
export const MATRIX_FLICKER_FPS = 30;
export const MATRIX_FLICKER_VISIBILITY_THRESHOLD = 205;
export const MATRIX_COLUMN_STAGGER_RANGE = 0.3;
export const MATRIX_HEAD_COLOR = '#ccffcc';
export const matrixGreenBright = (a: number): string => `rgba(0, 255, 65, ${a})`;
export const matrixGreenMid = (a: number): string => `rgba(0, 170, 40, ${a})`;
export const matrixGreenDim = (a: number): string => `rgba(0, 85, 20, ${a})`;
export const MATRIX_TRAIL_EMPTY_ALPHA = 0.5;
export const MATRIX_TRAIL_MID_THRESHOLD = 0.33;
export const MATRIX_TRAIL_DIM_THRESHOLD = 0.66;

// ── Rendering ────────────────────────────────────────────────
/** Baseline character frame height (px) the tuned overlay offsets below were
 *  authored for. Characters may now be other sizes (≤64×64); "above-the-head"
 *  offsets (bubble/tooltip/name) scale by actual height ÷ this. */
export const CHARACTER_BASELINE_HEIGHT = 32;
export const CHARACTER_SITTING_OFFSET_PX = 6;
export const CHARACTER_Z_SORT_OFFSET = 0.5;
export const BUBBLE_FADE_DURATION_SEC = 0.5;
export const BUBBLE_SITTING_OFFSET_PX = 10;
export const BUBBLE_VERTICAL_OFFSET_PX = 24;

export const CANVAS_ERROR_TILE_COLOR = '#FF00FF';

// ── Zoom ─────────────────────────────────────────────────────
export const ZOOM_MIN = 1;
export const ZOOM_DEFAULT_DPR_FACTOR = 2;
// ── Game Logic ───────────────────────────────────────────────
export const MAX_DELTA_TIME_SEC = 0.1;
export const WAITING_BUBBLE_DURATION_SEC = 2.0;
export const DISMISS_BUBBLE_FAST_FADE_SEC = 0.3;
export const INACTIVE_SEAT_TIMER_MIN_SEC = 3.0;
export const INACTIVE_SEAT_TIMER_RANGE_SEC = 2.0;
/** Default/fallback palette count (bundled characters). Actual count comes from getLoadedCharacterCount(). */
export const PALETTE_COUNT = 6;
export const AUTO_ON_FACING_DEPTH = 3;
export const AUTO_ON_SIDE_DEPTH = 2;
export const CHARACTER_HIT_HALF_WIDTH = 8;
export const CHARACTER_HIT_HEIGHT = 24;
export const TOOL_OVERLAY_VERTICAL_OFFSET = 32;

// ── Agent Teams ─────────────────────────────────────────────
export const MAX_CONTEXT_TOKENS = 200_000;
export const TOKEN_WARN_THRESHOLD = 0.6;
export const TOKEN_DANGER_THRESHOLD = 0.8;
export const TOKEN_CRITICAL_THRESHOLD = 0.95;
export const FUEL_COLOR_OK = '#44cc44';
export const FUEL_COLOR_WARN = '#ffcc00';
export const FUEL_COLOR_DANGER = '#ff8800';
export const FUEL_COLOR_CRITICAL = '#ff2222';

/**
 * Render depth of a `canWalkOver` furniture item (see FurnitureCatalogEntry) —
 * a rug is scenery on the floor, not something to sort against.
 *
 * It has to be a fixed band rather than a position-derived value: ordinary
 * furniture and every entity sort by their world-pixel bottom edge (>= 0), so
 * ANY position-derived depth would put a multi-row rug over the feet of someone
 * standing on its upper row. The two bands directly below this one live in
 * client/src/render/PhaserRenderer.ts — FLOOR_DEPTH (-100000) and, one above it,
 * IMAGE_DEPTH for placed images. Keep that order: floor < image < decal <
 * walk-over < everything positional.
 */
export const WALK_OVER_DEPTH = -99998;

/**
 * Render depth of a flat decal (see PlacedDecal, FurnitureCatalogEntry.occludes)
 * — ground detail: paving, grass, a shadow, flowers.
 *
 * Fixed for the same reason WALK_OVER_DEPTH is, and placed just under it: a
 * decal is the ground itself, so a rug lies ON a patch of paving rather than
 * under it. Above IMAGE_DEPTH, because a placed image is a backdrop and ground
 * detail belongs on top of a backdrop.
 *
 * Every flat decal shares this one value, so ties are broken by draw order,
 * which is paint order (see OfficeLayout.decals) — that is what makes a second
 * DecalLayer stack over the first. A decal whose tile sets `occludes` does not
 * come here at all; it sorts positionally with the furniture.
 */
export const DECAL_DEPTH = -99998.5;
