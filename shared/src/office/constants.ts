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
// (There were two constants here describing a spawn rule — "target = min(PET_MAX, floor(agents /
// PET_AGENTS_PER_PET))". Nothing had read them for a long time: pets are placed, not spawned per
// connected agent. Removed with the comment, since a documented rule the code does not implement
// is worse than no comment.)
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
/**
 * How far a hunter may walk to reach its quarry, in STEPS — the counterpart of
 * `PET_FLEE_RANGE_TILES`, and for the same reason: an unbounded search is bounded by the map.
 *
 * The quarry is always within `PET_SHOO_RADIUS_TILES` in CHEBYSHEV distance, and on a 4-connected
 * grid a Chebyshev 5 is up to **10 steps** — five across and five down, when the two stand
 * diagonally. So 10 is the open-floor worst case, not slack: a bound of 10, or "twice the radius",
 * would silently refuse every diagonal chase that has to round a desk. Three times the radius
 * leaves five steps of detour, which is a pillar, a sofa or a desk — and not a wall.
 *
 * That is the case this exists for. A quarry five tiles away behind a wall used to make
 * `findPath` exhaust the whole walkable component before answering "no route" (2651 walkable tiles
 * on uponu), twice a second per hunter, because a search that CANNOT reach its target is the most
 * expensive kind. A search bounded to S steps visits at most 2S² + 2S + 1 tiles: 481 at 15.
 * Measured on uponu, interleaved, minimum of nine blocks: that case **1202 → 68 µs**, and the
 * open-floor case where the bound never bites 7.2 → 7.1 µs — the bound costs nothing when it does
 * not apply.
 *
 * And it is a behaviour improvement rather than only a saving. There is one speed for every pet
 * and geometry is what catches: 15 steps at `PET_WALK_SPEED_PX_PER_SEC` is about six seconds,
 * i.e. twelve re-aims, and the quarry is elsewhere long before. A dog that cannot possibly catch
 * a cat should not be chasing it — the same rule `catchable()` already applies to a quarry that
 * has just fought, applied to geometry instead of to a cooldown.
 *
 * Written as a multiple so that raising the radius cannot quietly make every diagonal chase
 * impossible; `petChase.int.test.ts` pins that it stays above twice the radius.
 */
export const PET_CHASE_RANGE_TILES = 3 * PET_SHOO_RADIUS_TILES; // 15
/**
 * How many candidates a pet's target search may PATH before giving up, per decision.
 *
 * `findFreePetTarget` used to run one full search per candidate and only then pick at random —
 * ~66 searches for one 'sit' decision on uponu (45 seat placements plus 21 perches), and one per
 * unclaimed agent for 'talk', which is up to 301 in the worlds this repo has measured. That is
 * O(candidates × area), the one term quadratic in map area, on the 20 Hz thread whose whole tick
 * budget is 0.062 ms.
 *
 * A map's walkable floor is one connected component in practice — uponu measures 2651 walkable
 * tiles in TWO components, of 2648 and 3 — so the first probe answers and the other hundred
 * searches only ever confirmed it. Three covers a candidate whose own tile is fenced in by other
 * furniture without reintroducing a search per candidate.
 *
 * Measured on uponu, interleaved, minimum of nine blocks (both sides on the current `bfsPath`, so
 * the old numbers were in fact slightly worse than this):
 *
 *   | decision            | candidates | pathing before | after    |
 *   |---------------------|-----------:|---------------:|---------:|
 *   | 'sit'               |        101 |       38.3 ms  | 0.29 ms  |
 *   | 'talk', 100 agents  |        100 |       42.7 ms  | 0.30 ms  |
 *   | 'talk', 300 agents  |        300 |      149.8 ms  | 0.38 ms  |
 *
 * Read the middle column against a tick budget of 50 ms and a whole tick that measures 0.066 ms:
 * one animal deciding to look for a chair spent most of a tick on it, and in a crowd it spent
 * three ticks' worth in one call. That is what "quadratic in map area" cost in practice.
 */
export const PET_TARGET_PATH_TRIES = 3;
/**
 * How many random tiles a spawn tries before it falls back to filtering the whole map.
 *
 * `findFreeSpawnTile` used to filter every walkable tile on every join — 2651 of them on uponu,
 * each one an `isWalkable`, a set lookup and an area lookup, after rebuilding the footprint set
 * of all 164 placements: 202 µs per join, on the room's thread. It only ever needed ONE free
 * tile, so it draws them at random and takes the first free one, which is rejection sampling and
 * therefore the same uniform choice over free tiles that filtering gave. Eight probes cover a
 * world where two thirds of the floor is taken; past that the filter still runs, so a genuinely
 * crowded zone is answered exactly as before rather than approximately.
 */
export const SPAWN_PROBE_TRIES = 8;
/**
 * The scuffle: how a chase ENDS.
 *
 * Before this, a chase had no ending at all — the hunter pathed once to where its quarry stood,
 * walked there, found nothing and idled for up to 8 seconds before deciding again, so it lost by
 * construction. Two numbers fix that without giving anybody a speed advantage, which was the
 * decision: a dog that outruns a cat is zoologically false, and being CORNERED is the honest reason
 * a cat gets caught.
 *
 * `PET_REACTION_REPATH_SEC` is how often a hunter re-aims at where its quarry actually is now — and
 * the quarry re-picks its escape on the SAME cadence, deliberately. An asymmetry there would be a
 * speed advantage wearing a different hat: whoever reacts twice as often closes distance twice as
 * fast. So geometry decides, and geometry means walls, furniture and dead ends.
 *
 * `PET_CATCH_RADIUS_TILES = 1` counts diagonals (Chebyshev), because two pets standing corner to
 * corner look adjacent and a cloud between them reads right.
 */
export const PET_REACTION_REPATH_SEC = 0.5;
export const PET_CATCH_RADIUS_TILES = 1;
/** How long the cloud lasts. Long enough to read as a scrap, short enough not to become the scene. */
export const PET_SCUFFLE_DURATION_SEC = 1.5;
/**
 * How long a pet that has just scuffled is out of the game — as a hunter AND as prey.
 *
 * It was 12 seconds and it gated only CHASING, which protected the wrong animal: a cat hunts no
 * dogs, so the cat had no protection at all. Measured on a world with two dogs and one cat:
 * **101 clouds in three minutes**, the partners alternating, because whenever one dog was cooling
 * down the other was free. That is the "fights that go on forever, somebody keeps joining" this
 * number now answers.
 *
 * 90 seconds against a ten-minute lifespan means an animal scraps a handful of times per life
 * instead of a hundred times per afternoon. And the protection is not only a refusal to be caught:
 * a protected quarry disappears from the hunter's affordance entirely (`chaseQuarryFor`), because a
 * dog running after a cat it cannot possibly catch looks broken, and rightly so.
 *
 * Fleeing is deliberately NOT gated. Being unavailable for a brawl is not the same as feeling safe,
 * and a cat that ignores a dog three tiles away would read as a bug.
 */
export const PET_SCUFFLE_COOLDOWN_SEC = 90;
/**
 * Who walks away from the cloud — the hunter, most of the time.
 *
 * Not 50:50, and not certainty either. A bird that sends the cat packing is funny exactly because
 * it is rare; at even odds it would be noise, and at 100 % the cloud would have no suspense at all
 * and the outcome would not be worth showing. The roll happens ONCE for the pair when the cloud
 * starts (`beginScuffle`), so the two animals can never both think they won.
 */
export const PET_HUNTER_WIN_CHANCE = 0.6;
/** The beat after the cloud: winner gloating, loser cowering, a badge over each. Then the loser runs. */
export const PET_AFTERMATH_DURATION_SEC = 1.2;
/** How fast the cloud's four frames cycle: brisk, because a scrap is not a walk cycle. */
export const SCUFFLE_FRAME_DURATION_SEC = 0.09;
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

/** How far the tiled rain dims on an off beat of the flicker clock (see matrixRainDim). */
export const MATRIX_RAIN_FLICKER_DIM = 0.72;
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

// (A `// ── Zoom ──` section with ZOOM_MIN = 1 and ZOOM_DEFAULT_DPR_FACTOR = 2 stood here until
// 2026-08-28. Nothing read either one — the camera's floor and ceiling are the literals in
// OfficeScene's wheel handler, `Phaser.Math.Clamp(cam.zoom * …, 1, 14)`, and the default is
// DEFAULT_ZOOM there. A second, unused copy of the number 1 is exactly the shape this codebase
// keeps getting caught by, so it is gone rather than wired up: a camera clamp is client
// presentation and has no business being a shared engine constant.)
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

// ── Karts ────────────────────────────────────────────────────────────────────
/**
 * A kart is KINEMATIC, not physical: position, heading and one scalar speed, integrated at the
 * tick and collided against tiles. AGENTS.md invariant 3 rules out a physics engine because it
 * would cost determinism and headless execution, and none of what a kart racer needs asks for
 * one — there is no stacking, no spin, no restitution to solve, just a body that goes where it
 * points and stops at walls.
 *
 * The numbers are in pixels and seconds, like every other speed here (`WALK_SPEED_PX_PER_SEC` is
 * 45 and a pet walks at 40), so a kart at 110 is about two and a half times a walking figure —
 * fast enough to feel like driving on a 16 px grid without crossing a tile per tick.
 */
/** Fifteen tiles a second. 110 (seven tiles) and then 190 (twelve) were both reported as too
 *  slow — a long straight has to feel like one. Every derived number below is set against this,
 *  so raising it is not a free knob: a corner demands `v² / radius`, which grows with the SQUARE.
 *  At 240 a full-lock corner asks 823 px/s² of tyres that have 600. */
export const KART_MAX_SPEED_PX_PER_SEC = 240;
/** Reverse is deliberately slow: it is for getting off a wall, not for racing backwards. */
export const KART_MAX_REVERSE_PX_PER_SEC = 55;
export const KART_ACCEL_PX_PER_SEC2 = 320;
export const KART_BRAKE_PX_PER_SEC2 = 500;
/**
 * Coasting loss per second, as a fraction — a kart slows when you let go, but does not stop dead.
 *
 * 0.9 was "does stop dead": a time constant of about a second, so four seconds off the throttle
 * took a kart from top speed to walking pace and lifting for a corner felt like stamping on the
 * brake. At 0.35 the same coast keeps most of its speed, which is what leaves room for the brake
 * to mean something. It does not set the top speed — the clamp does.
 */
export const KART_DRAG_PER_SEC = 0.35;
/**
 * **The tyres have a limit**, and it is in px/s² because it is an acceleration: this is the most
 * sideways speed the tyres can kill in a second, full stop, however hard the kart is sliding.
 *
 * That word — limit — is the whole difference from the first version, which bled sideways motion
 * away as a FRACTION per second (`side -= side * grip * dt`). A fraction is an unbounded force:
 * the harder you slide, the harder the tyres push back, so the kart always went exactly where it
 * pointed, nothing ever drifted, and carrying too much speed into a corner cost nothing. Reported
 * in those words — "es driftet nichts", "wer zu viel Gas gibt sollte rausfliegen".
 *
 * With a cap, a turn at speed generates sideways velocity faster than the tyres can shed it, and
 * everything asked for falls out of that one change rather than out of special cases: the kart
 * slides wide, the slide is a drift, and running wide on a track whose infield is a pit is
 * exactly "flying off". It is also still no physics engine (AGENTS.md invariant 3) — one
 * clamped subtraction per tick, deterministic and headless, not a solver.
 */
export const KART_GRIP_PX_PER_SEC2 = 600;
/**
 * How much of the tyres' grip is spent on GOING rather than turning, as a share of
 * `KART_GRIP_PX_PER_SEC2` at full throttle.
 *
 * The friction circle, and the direct answer to "too much gas in a corner should throw you off":
 * a tyre has one budget for both jobs, so what the engine asks of it is not available to the
 * corner. At 1 the tyres would have nothing left while accelerating and every exit would be a
 * spin; at 0 the throttle would not matter at all and the request would be unanswered. Braking
 * spends it too — which is what makes braking BEFORE the corner the right line rather than a
 * habit borrowed from other games.
 */
export const KART_POWER_GRIP_SHARE = 0.7;
/**
 * How quickly the nose follows a slide, per second.
 *
 * A self-aligning torque, and without it a sliding kart CRABS — it keeps pointing where you
 * steered while travelling somewhere else, forever, which reads as a bug rather than as a drift.
 * With it, steering adds yaw and sliding takes it away, so holding a turn settles at a steady
 * drift angle instead of spinning: the equilibrium is the feel.
 */
export const KART_SLIDE_ALIGN_PER_SEC = 1.6;
/** Past this slip angle a kart counts as SLIDING — the cue for skid marks, and a world fact
 *  rather than a drawing detail, so every viewer marks the same corner. About eleven degrees:
 *  below that the line just looks wide. */
export const KART_SLIDE_ANGLE_RAD = 0.2;
/**
 * The most a kart can yaw, in radians per second, and the share of that available at a standstill.
 * Not zero at rest, because a kart that cannot be aimed while parked is infuriating; not one
 * either, because spinning on the spot is not driving.
 */
export const KART_STEER_RAD_PER_SEC = 3.1;
export const KART_STEER_AT_REST = 0.35;
/**
 * The tightest circle a kart can be steered round, in pixels — about four and a half tiles.
 *
 * A kart turns on a RADIUS, so its yaw rate is `speed / radius` and the cap above only bites when
 * it is crawling. Writing it the other way round — a fixed yaw rate at every speed, which is what
 * the first version did — demands `v² / r` from the tyres and therefore asks for 592 px/s² at top
 * speed against the 560 they have, so every corner at speed was a spin and the slip angle ran to
 * 60°.
 *
 * This number is where the handling is actually decided, and it is set against the tyres
 * deliberately: at top speed a full-lock corner demands about 516 px/s², which is MORE than the
 * 428 left while the throttle is down and LESS than the 600 available off it. So the corner is
 * exactly the choice it should be — stay on the gas and run wide into the pit, or lift and make
 * it. That is the whole of "wer zu viel Gas gibt, sollte rausfliegen", as one relation between
 * three constants rather than as a rule about corners.
 */
export const KART_TURN_RADIUS_PX = 70;
/** Collision radius in pixels — a kart is 16 px of art, and bodies that touch at 9 read as
 *  touching before they overlap. */
export const KART_RADIUS_PX = 9;
/** What the RAMMER gives away, as a share of the closing speed. Under 1 so a collision costs
 *  both of them something, which is what makes ramming a trade rather than a free win. */
export const KART_BUMP_TRANSFER = 0.7;
/**
 * What the rammed kart RECEIVES, as a multiple of the closing speed — deliberately above 1, so a
 * bump is not momentum-conserving.
 *
 * This number was found by a test rather than chosen. Sideways velocity bleeds off against
 * `KART_GRIP_PX_PER_SEC2`, so a shove slides a kart about `shove² / (2 · grip)` pixels: at the
 * physical share (0.7 of a 60 px/s closing speed) that is a couple of pixels — and
 * "push somebody off the bridge" is then impossible however hard you hit them. At 1.8 the same
 * contact slides them about fifteen, which is a lane. Arcade racers all cheat here for the same
 * reason; what matters is that the cheat is one named number and not a special case.
 */
export const KART_BUMP_GAIN = 1.8;
/** The shove a bump always adds, in px/s, so touching at a crawl still nudges. */
export const KART_BUMP_MIN_PX_PER_SEC = 25;
/** How long a kart is out of the race after leaving the ground, before it reappears at its last
 *  gate. Long enough to read as a punishment, short enough not to end the race for them. */
/**
 * How close a body must be to a kart's CENTRE to get in.
 *
 * Three tiles rather than two, and the difference is not taste: the art is a tile and a half wide,
 * so two tiles from the centre leaves barely a quarter-tile of standing room around the bodywork —
 * reported as "I can't get in", with nothing on screen saying why. Generous is the right side to
 * err on for a key that does nothing when it misses.
 */
export const KART_BOARD_REACH_TILES = 3;

export const KART_FALL_SEC = 1.2;

/** Simulation rate for a zone whose map is a race track. Steering at 20 Hz feels like posting
 *  letters; the tick costs 19 µs (measured on uponu with 300 agents), so a race room can afford
 *  three times as many of them, and the PATCH rate stays 20 Hz either way — this buys input
 *  latency, not bandwidth. */
export const RACE_TICK_HZ = 60;

// ── A race, as opposed to a track ─────────────────────────────────────────────
/**
 * The lights, in milliseconds: three lamps a second apart and then a beat of green.
 *
 * Long enough to be a moment — everybody looks up, the karts are held still — and short enough
 * that starting another race is not a chore. Nothing is drivable until it runs out.
 */
export const RACE_COUNTDOWN_MS = 3700;
/**
 * The longest a race may run before it is called, in ms.
 *
 * Not a rule about racing: it is what stops one driver who parks in the pit from holding a zone
 * in `racing` forever, with nobody able to start the next one. Generous enough that a slow but
 * genuine three laps is never cut off — the autopilot needs about 40 s.
 */
export const RACE_MAX_MS = 6 * 60 * 1000;
/**
 * How long the field has once the WINNER is home, in ms.
 *
 * Every racing game has this and it is not really about racing: a driver who ends up in the pit
 * and stops trying would otherwise hold everybody else on the track until the six-minute cap.
 * Forty-five seconds is long enough to finish a lap you were most of the way round and short
 * enough that nobody sits waiting for somebody who has walked away.
 */
export const RACE_GRACE_MS = 45_000;

// ── Tyres ─────────────────────────────────────────────────────────────────────
/**
 * How much grip is left on completely worn tyres, as a share of the spec's.
 *
 * Dust Racing's signature mechanic, and the reason it is worth having: it turns a race from
 * "hold the throttle down" into a decision, because the fastest way round on lap one is not the
 * fastest way to the flag. Not zero — bald tyres still steer, they just slide — because a car
 * that becomes undrivable is a car whose driver has already lost, and there is nothing to play.
 */
export const TYRE_MIN_GRIP = 0.55;
/**
 * How fast tyres wear, per second, at full slide and at full speed.
 *
 * SLIDING is what costs them: a clean lap barely marks them and a lap spent sideways ruins them,
 * which is what makes the tidy line the fast one over three laps. At this rate a hard-driven
 * three-lap race arrives at the flag with about half a set left, so the pit is a choice on a long
 * race rather than a chore on every one.
 */
export const TYRE_WEAR_SLIDING_PER_SEC = 0.055;
export const TYRE_WEAR_ROLLING_PER_SEC = 0.006;
/** How fast a pit stop puts them back, per second. A full set takes about three seconds — long
 *  enough to be a decision, short enough that taking it is not giving up. */
export const TYRE_FIT_PER_SEC = 0.34;
/** Above this speed the pit crew will not work: you have to actually STOP. */
export const PIT_SPEED_PX_PER_SEC = 45;
/** Below this the HUD warns, and a computer driver starts looking for the pit lane. */
export const TYRE_WARN = 0.35;

// ── Off the road ──────────────────────────────────────────────────────────────
/**
 * What the tyres find on grass and sand, as a share of what they find on tarmac.
 *
 * Leaving the road SLOWS you rather than ending you, which is how Dust Racing treats it and what
 * lets a circuit sit in a landscape instead of a black square. Low enough that the racing line is
 * the fast one and a driver who runs wide loses real time; high enough that a car in the run-off
 * can be brought back, because a run-off you cannot drive out of is a wall with grass painted on
 * it.
 */
export const ROUGH_GRIP = 0.45;
/** What it does to the top speed, as a share. Grass is slower than tarmac even in a straight line. */
export const ROUGH_SPEED = 0.62;
/** And it eats tyres: a lap spent in the dirt costs a lap's wear several times over. */
export const ROUGH_WEAR_FACTOR = 2.5;
/** How long the result board stays up before the track is free again. */
export const RACE_RESULTS_MS = 9000;
