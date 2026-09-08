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
  /** '' | 'spawn' | 'despawn' (matrix effect). */
  @type('string') matrixEffect = '';
  @type('number') matrixEffectTimer = 0;
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
}
