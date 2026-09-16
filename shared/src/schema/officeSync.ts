import { ArraySchema, MapSchema, Schema, type } from '@colyseus/schema';
import type { DefinitionType } from '@colyseus/schema';

/**
 * Authoritative, synced render-state. The server runs the office simulation and
 * writes these every tick; clients read them (via @colyseus/sdk reflection) and
 * render — so every viewer sees the exact same world. Field names/encodings are
 * chosen so the client can rebuild a render-only Character/Pet cheaply.
 */
/**
 * A PAWN: a body in the world, and what drives it.
 *
 * The word is Unreal's and the split is the same one, because it is the split this world already
 * had without naming it: a pawn is the body — identity, transform, facing, coarse state — and a
 * CONTROLLER is what decides where it goes. Kind-specific schemas extend this (`CharacterSync`,
 * `PetSync`), the way `ACharacter` and a vehicle both extend `APawn`; `FurnitureSync` deliberately
 * does not, because furniture is not possessable.
 *
 * `controller` is here rather than on the subclasses because EVERY pawn has one, and because it
 * makes the next one free: a fourth controller is a new enum value, not a schema change (which is
 * what a boolean `isPlayer` could never be — see PROTOCOL_VERSION 10).
 */
export class PawnSync extends Schema {
  @type('int32') id = 0;
  @type('number') x = 0;
  @type('number') y = 0;
  @type('uint8') dir = 0;
  /** Coarse FSM state string (CharacterState / PetState / …). */
  @type('string') state = 'idle';
  /** Which controller drives this pawn — a {@link ControllerKind}. */
  @type('uint8') controller = 0;
}


export class CharacterSync extends PawnSync {
  /** Animation pose (CharacterPose): idle|walk|typing|reading|coffee. The
   *  animation *frame phase* is cosmetic and timed client-side from this pose +
   *  dir, so it is intentionally NOT synced (see AGENTS.md). */
  @type('string') pose = 'idle';
  /** Stable skin id (e.g. char_3) — which character template this avatar uses. */
  @type('string') skin = 'char_0';
  @type('boolean') isActive = false;
  /** Current tool is a reading tool → reading vs typing animation. */
  @type('boolean') reading = false;
  /** '' | 'permission' | 'waiting'. */
  @type('string') bubble = '';
  @type('number') bubbleTimer = 0;
  /** '' | 'spawn' | 'despawn' — the warp PHASE. (Named for the Matrix effect, which was the only
   *  style when it was written; the style is beside it now.) */
  @type('string') matrixEffect = '';
  @type('number') matrixEffectTimer = 0;
  /**
   * Which warp style is playing — a `WarpStyleId`, set with the phase and cleared with it.
   *
   * Deliberately NOT a lasting property of the pawn, unlike `skin`: it is only ever read while a
   * phase is running, so carrying it between warps would be state that can go stale for nothing.
   * It is resolved server-side from the owner's account, never taken from the warp message, so
   * every viewer draws the same thing and a client cannot claim a style per warp.
   */
  @type('string') warpStyle = '';
  /**
   * The helmet this pawn wears while DRIVING — a `HELMETS` id, empty for "from my own head".
   *
   * Set when they get into a kart and cleared when they get out, exactly like `warpStyle` is set
   * with its phase: it is only ever read while somebody is driving, so a world of people on foot
   * carries an empty string. Synced rather than derived per client because it is a DECISION — two
   * viewers must not see the same driver in different helmets, or neither can point at a kart and
   * say whose it is.
   */
  @type('string') helmet = '';
  @type('boolean') isSubagent = false;
  // Identity + tooltip
  @type('string') folderName = '';
  @type('string') teamName = '';
  @type('string') agentName = '';
  @type('boolean') isTeamLead = false;
  /** Latest human-readable activity (tool status / 'Needs approval' / ''). */
  @type('string') activity = '';
  @type('uint32') inputTokens = 0;
  @type('uint32') outputTokens = 0;
  /** Player set themselves away (/afk) — shows an "afk" marker; clears on move.
   *  Appended last (schema-evolution safe: never shift existing field indices). */
  @type('boolean') afk = false;
  /** WorkStatus from the player's TimeTracking account ('' = none configured,
   *  or a status that has gone stale), mirrored here by the room so every
   *  viewer's hover overlay shows the same glyph. Appended last — see the afk
   *  comment above. */
  @type('string') workStatus = '';
  /** Name of the Mumble channel this player's desktop app is sitting in
   *  ('' = not connected, no Mumble, or the browser build), mirrored here so
   *  every viewer's hover overlay can say where to go to talk to them. Same
   *  shape and same trust model as `workStatus` above — self-reported by the
   *  one process that knows, cosmetic, and it grants nothing. Appended last. */
  @type('string') voiceChannel = '';
}

export class PetSync extends PawnSync {
  @type('uint8') kind = 0; // 0 dog, 1 cat, 2 bird
  @type('uint8') variant = 0;
  @type('uint8') frame = 0;
  /** '' | 'spawn' | 'despawn'. */
  @type('string') effect = '';
  @type('number') effectTimer = 0;
  /** Vertical render lift (px) while resting on a desk surface (0 otherwise). */
  @type('uint16') restLift = 0;
  /**
   * The pet this one is scuffling with while `state` is 'scuffle', else 0 (no pet has id 0).
   *
   * Synced rather than inferred, because who is paired with whom is the server's decision — the
   * client could guess it from "two adjacent pets are both scuffling", and that guess is wrong the
   * moment three animals stand in a row. It also decides where ONE cloud is drawn, so a wrong guess
   * is two clouds on top of each other.
   *
   * `int32`, the same type as `PawnSync.id`, because that is what it holds. It was `uint16` for one
   * afternoon and the live world caught it: pet ids start at 1 000 000, so the cat with id 1000007
   * arrived at the client as 16967 (1000007 mod 65536). Nothing crashed — the client verifies that
   * both ends name each other, so it simply drew no cloud, and every unit test passed because a
   * test builds pets with ids 1, 2 and 3. A field that holds an id gets the id's type.
   */
  @type('int32') scufflePartnerId = 0;
}

/**
 * A kart: a body somebody drives, and the fourth thing on this wire that extends `PawnSync`.
 *
 * It is a PAWN by AGENTS.md's own vocabulary — a body with a transform that something possesses —
 * and the expensive direction on purpose: a kart exists without a driver (parked, and bumpable),
 * which a "riding" flag on a character could not express.
 *
 * What is synced is what a client cannot derive: where it is, which way it points, and who is in
 * it. Its VELOCITY is deliberately absent — the client interpolates position like it does for
 * every other pawn, and a kart's speed only ever fed presentation.
 */
export class KartSync extends PawnSync {
  /**
   * Heading in hundredths of a radian, 0…628.
   *
   * A `uint16` rather than a float because it is read sixteen times per rotation by the renderer
   * (one sprite per 22.5°) and a hundredth of a radian is a fortieth of that step — below what any
   * number of headings can show, and two bytes instead of eight at 20 patches a second per kart.
   */
  @type('uint16') heading = 0;
  /** The character driving, or 0 for a parked kart. `int32`, the type an id has — the pet cloud's
   *  partner id was `uint16` for one afternoon and the live world caught it. */
  @type('int32') driverId = 0;
  @type('uint8') lap = 0;
  /** Last gate passed, as an index into the track's gates. */
  @type('uint8') gate = 0;
  @type('boolean') finished = false;
  /**
   * Is it sliding — tyres past their limit, pointing somewhere other than where it is going?
   *
   * Synced rather than derived per client: the wire carries a pose and not a velocity, so a
   * viewer has nothing to derive it FROM, and two viewers guessing from successive positions
   * would lay their skid marks in different places.
   */
  @type('boolean') sliding = false;
  /** 1-based place while a race runs, 0 otherwise. */
  @type('uint8') place = 0;
  /** Lap times in milliseconds, 0 until a lap is complete. */
  @type('uint32') lastLapMs = 0;
  @type('uint32') bestLapMs = 0;
  /** Total race time when it crossed the line for the last lap, 0 while still running. */
  @type('uint32') totalMs = 0;
  /** Which car it looks like — an index into VEHICLE_ART. A decision, not a local choice: two
   *  viewers must not see the same kart in different colours. */
  @type('uint8') art = 0;
  /**
   * How far round the whole race it is, in hundredths of a lap.
   *
   * Synced rather than derived: the gap between two cars is the thing a running order is FOR, and
   * a client has no track — it does not know how many gates a lap has, let alone where they are.
   * A `uint16` holds 655 laps at a hundredth each, which is finer than any gap anybody reads.
   */
  @type('uint16') progress = 0;
  /** Going the wrong way round. Synced rather than derived, so every viewer warns the same driver
   *  at the same moment — and because a client has no velocity to derive it from. */
  @type('boolean') wrongWay = false;
  /**
   * What this driver is holding — a `KartItem`, 0 for nothing.
   *
   * Synced for EVERY kart and not only for your own, because an item is something the rest of the
   * field can see coming: a car carrying a shield is one there is no point shoving, and that is
   * information a race is played on. One byte per kart.
   */
  @type('uint8') item = 0;
  /** Counts down while a shield is up, in tenths of a second — so the HUD can show it running out
   *  rather than blinking off. */
  @type('uint8') shieldTenths = 0;
  /** Spinning on somebody's oil: the renderer turns the art with the heading either way, so this
   *  is here for the sound and for the HUD, not for the picture. */
  @type('boolean') spinning = false;
  /** Which `KartSpec` this car is, as an id. What a car IS is decided when somebody gets in, so
   *  two viewers must not be able to disagree about it. */
  @type('string') spec = '';
}

/**
 * The race, or the absence of one.
 *
 * One record on the room rather than a field per kart, because every viewer asks the same three
 * questions — are we counting down, how long, how many laps — and the answers are the same for
 * all of them. A zone with no track leaves it at `phase = 0`, which costs four bytes once.
 */
export class RaceSync extends Schema {
  /** 0 idle, 1 countdown, 2 racing, 3 results. */
  @type('uint8') phase = 0;
  /** Counts DOWN in a countdown and in the results, UP while racing. Milliseconds. */
  @type('uint32') timerMs = 0;
  @type('uint8') laps = 0;
  /**
   * A point-to-point stage rather than N laps of a circuit.
   *
   * Synced rather than derived: the client has no track, so it cannot tell a one-lap circuit from
   * a stage — and the difference is everything the HUD says. "Lap 1/1" on a hill climb is not a
   * cosmetic slip, it is the overlay claiming the race is something it is not.
   */
  @type('boolean') sprint = false;
  /** How many karts are in it — the denominator for "P2 of 4". */
  @type('uint8') entries = 0;
  /** The leader is on the last lap and nearly home: the chequered flag is out. */
  @type('boolean') finalLap = false;
  /** The track's standing records, in ms — 0 for "nobody has set one". Shown beside your own
   *  times, which is what makes a lap worth repeating. */
  @type('uint32') recordLapMs = 0;
  @type('uint32') recordRaceMs = 0;
  /** Who holds them. Empty while unset. */
  @type('string') recordLapBy = '';
  @type('string') recordRaceBy = '';
  /**
   * What the NEXT race is set to, and how big the grid is — the five numbers the setup panel
   * shows and nothing else.
   *
   * Synced rather than kept per client, and that is the whole reason they are here: everyone
   * standing on the track is looking at the same pending race, so two people must not be able to
   * read different lap counts off the same panel and press start. The client may ASK to change
   * one (§ Security); the answer arrives back through these.
   */
  @type('uint8') setupLaps = 0;
  @type('uint8') setupBots = 0;
  @type('uint8') setupCountdown = 0;
  /** An index into RACE_DIFFICULTIES, which is append-only for exactly this reason. */
  @type('uint8') setupDifficulty = 0;
  /** How many starting slots this track has — the ceiling the panel counts up to. */
  @type('uint8') gridSlots = 0;
}

/**
 * Hands a collection definition to `@type` without the compiler type-checking the
 * argument. Purely type-level — `type` receives exactly the object literal written at
 * the call site, so the wire layout is still decided by the same code as before.
 *
 * Needed because @colyseus/schema 5 widened `DefinitionType` into a six-member union
 * whose collection members carry `default?: MapSchema<InferValueType<T>>`, and
 * resolving that for a Schema class walks the class's fields. Checking a collection of
 * something the size of `CharacterSync` against it overruns the compiler's
 * instantiation budget (TS2589, "excessively deep"). A plain `as DefinitionType` does
 * not help: the assertion still has to prove assignability, which is the expensive
 * part — the budget is shared across the file, so asserting one annotation only moved
 * the error to the next. Going through `unknown` is what actually stops the check.
 *
 * Primitive fields (every other annotation in this file) are unaffected and stay
 * plain. Drop this the moment the upstream typings stop recursing.
 */
const collection = (definition: unknown): DefinitionType => definition as DefinitionType;

export class RoomState extends Schema {
  @type(collection({ map: CharacterSync })) characters = new MapSchema<CharacterSync>();
  @type(collection({ map: PetSync })) pets = new MapSchema<PetSync>();
  /** The karts on this zone's track; empty in every zone whose map is not one (see `raceTrack`). */
  @type(collection({ map: KartSync })) karts = new MapSchema<KartSync>();
  @type(RaceSync) race = new RaceSync();
  /**
   * Which placed furniture is currently switched ON, by `PlacedFurniture.uid`.
   *
   * This replaced a `FurnitureSync` array that mirrored the whole map — 163 records of nineteen
   * fields on uponu — and it is the only thing about furniture a client cannot work out for
   * itself. The placements arrive once with the map (`layoutLoaded` carries the layout, uids and
   * all), and the animation frame is presentation timing the client resolves locally through
   * `animationFrameAt` (invariant 2). What is left is a decision: an active agent or a seated
   * player switches on the electronics they face, and a click-toggle piece stays on until it is
   * clicked again — neither of which a client could derive, since one comes from agent state and
   * the other from another viewer's click.
   *
   * The old shape cost 11 442 bytes per patch in a world where nothing moved, because the ambient
   * animation swapped the engine's placement array five times a second and the room rebuilt every
   * record from it. This one is empty on a still map, so a still map costs nothing.
   */
  @type(['string']) furnitureOn = new ArraySchema<string>();
  /**
   * Oil on the road, as packed `row * cols + col` cells.
   *
   * The one thing an item leaves in the WORLD, so it is the one thing about items that cannot be
   * derived from a kart. Packed into a number rather than a small schema per slick because a slick
   * is a cell and nothing else — no size, no owner, no clock a viewer needs: it is there or it is
   * not, and it is gone when the server says so. Empty in every zone that is not a race track, so
   * it costs nothing anywhere else.
   */
  @type(['uint32']) slicks = new ArraySchema<number>();
}
