/**
 * Pet engine — lightweight wander/sit FSM for ambient dogs & cats.
 *
 * Parallels the character FSM (characters.ts) but is far simpler: pets only
 * wander, pause, and sit at claimed furniture (tail wagging). Furniture
 * targeting / occupancy lives in OfficeState and is provided via PetUpdateContext.
 */

import {
  PET_DRINK_FRAME_DURATION_SEC,
  PET_DRINK_MAX_SEC,
  PET_DRINK_MIN_SEC,
  PET_EFFECT_DURATION_SEC,
  PET_IDLE_FRAME_DURATION_SEC,
  PET_LIFESPAN_SEC,
  PET_SIT_CHANCE,
  PET_SIT_MAX_SEC,
  PET_SIT_MIN_SEC,
  PET_TAIL_WAG_DURATION_SEC,
  PET_TALK_FRAME_DURATION_SEC,
  PET_TALK_MAX_SEC,
  PET_TALK_MIN_SEC,
  PET_WALK_FRAME_DURATION_SEC,
  PET_REACTION_REPATH_SEC,
  PET_SCUFFLE_COOLDOWN_SEC,
  PET_SCUFFLE_DURATION_SEC,
  PET_WALK_SPEED_PX_PER_SEC,
  PET_WANDER_PAUSE_MAX_SEC,
  PET_WANDER_PAUSE_MIN_SEC,
} from '../constants.js';
import { snapToTile, stepAlongPath, tileCenter } from './entity.js';
import { findPath } from '../layout/tileMap.js';
import type { ApplianceKind, WallEdges, GroundMap } from '../types.js';
import type { Pet, PetKind } from '../types.js';
import { Direction, PetState } from '../types.js';

/**
 * The high-level activity a pet brain can choose and the actuator can execute.
 * This is the shared vocabulary between the server-only behaviour tree (which
 * decides) and the engine (which executes); the brain imports it rather than
 * defining its own. Extensible — N3.3 adds `drink` (coffee), `talk` (agent),
 * and `chase`/`flee` (shoo-cat) as new affordance-driven actions.
 */
export type PetAction = 'wander' | 'sit' | 'chase' | 'flee' | 'drink' | 'talk';

/** Kinds of interactable the world affords a pet: claimable seats, adjacent-to
 *  furniture (cat on a desk), appliance stations (coffee), and agents (talk). */
type AffordanceKind = 'seat' | 'furniture' | 'station' | 'agent';

/**
 * What's available in the world for a pet to interact with right now — a cheap
 * existence snapshot OfficeState hands the brain so it can pick a sensible
 * action (don't choose "rest" with no free seat). Reachability is confirmed
 * later by `findTarget`; this stays pathfinding-free so it's cheap per decision.
 */
export interface PetAffordances {
  /** A seat (or, for cats, a desk) the pet could go rest at exists. */
  canRest: boolean;
  /** A pet this one's species hunts is within shoo range (see CHASES). */
  canChase: boolean;
  /** A pet that hunts this one is within shoo range (fleesFrom, derived from CHASES). */
  threatened: boolean;
  /** A free bowl or fountain exists to go use — never a coffee machine (see APPLIANCES). */
  canDrink: boolean;
  /** An agent is around to go talk to. */
  canTalk: boolean;
}

/** A reachable, already-claimed interaction target (computed by OfficeState). */
export interface PetTarget {
  kind: AffordanceKind;
  /** What the pet does once it arrives (seat/desk → 'sit', station → 'drink'). */
  action: PetAction;
  seatId: string | null;
  furnitureUid: string | null;
  /** Claimed appliance station uid (for 'station' targets), else null. */
  stationId: string | null;
  /** For a 'station' target: which appliance it is, which decides what the pet DOES there —
   *  a fountain is drinking, a bowl is eating. Carried on the target rather than looked up on
   *  arrival, because the point is known where the target is chosen and the pet is not. */
  appliance?: ApplianceKind;
  /** Claimed agent id (for 'agent' targets), else null. */
  agentId: number | null;
  sitCol: number;
  sitRow: number;
  facing: Direction;
  /** Vertical render lift (px) for a desk-surface rest (0 for seats/floor). */
  restLift: number;
  /** Path from the pet's current tile to the sit tile (excludes start). */
  path: Array<{ col: number; row: number }>;
}

interface PetUpdateContext {
  walkableTiles: Array<{ col: number; row: number }>;
  tileMap: GroundMap;
  blockedTiles: Set<string>;
  /** Wall edges, so a pet can't wander through a wall — see wallEdges.ts. */
  walls?: WallEdges;
  /** Find + claim a free interaction target reachable from the pet for the given
   *  action ('sit' → seat/desk, 'drink' → appliance station), or null. */
  findTarget: (pet: Pet, action: PetAction) => PetTarget | null;
  /** Release the pet's current seat/furniture claim (no-op if none). */
  releaseClaim: (pet: Pet) => void;
  /** Decide the next idle activity for a pet (injected by the server's pet brain;
   *  absent → the built-in sit-chance roll). */
  decideAction?: (pet: Pet) => PetAction;
  /** Resolve a directed move path for a reactive action — toward the nearest cat
   *  ('chase') or away from the nearest dog ('flee'). OfficeState supplies it
   *  (it knows every pet's position); null when no path applies. */
  navigateReaction?: (pet: Pet, action: PetAction) => Array<{ col: number; row: number }> | null;
  /**
   * Is there something worth reacting to RIGHT NOW — a quarry to hunt, or a hunter to run from?
   * Asked while the pet is WALKING, so it notices what it passes instead of only looking at its
   * own decision points, which are 1.5-8 s apart. OfficeState answers it because the question
   * needs every pet's position, the per-variant switches and the chase cooldown; it returns the
   * action AND the path, so nothing has to be resolved twice.
   */
  noticeReaction?: (pet: Pet) => { action: NonNullable<Pet['reaction']>; path: Array<{ col: number; row: number }> } | null;
  /** Playback length (frame count) of the pet's *current* pose track, used to
   *  advance `frame` spec-driven instead of with hardcoded per-state moduli.
   *  Server resolves it from the pet's sheet; absent → a static single frame. */
  posePlaybackLength?: (pet: Pet) => number;
}

function randomRange(min: number, max: number): number {
  return min + Math.random() * (max - min);
}

/**
 * Advance the pet's animation frame for its current pose at `cadence` seconds
 * per step, cycling within the pose track's real length (spec-driven via
 * `ctx.posePlaybackLength`, so server and client agree). `fallbackLen` is used
 * only when no resolver is supplied (standalone/tests).
 */
function advancePetFrame(pet: Pet, ctx: PetUpdateContext, cadence: number, fallbackLen: number): void {
  if (pet.frameTimer < cadence) return;
  pet.frameTimer -= cadence;
  const len = ctx.posePlaybackLength?.(pet) ?? fallbackLen;
  pet.frame = (pet.frame + 1) % Math.max(1, len);
}

export function createPet(
  id: number,
  kind: PetKind,
  variant: number,
  spawnTile: { col: number; row: number },
): Pet {
  const center = tileCenter(spawnTile.col, spawnTile.row);
  return {
    id,
    kind,
    variant,
    state: PetState.SPAWN,
    dir: Direction.DOWN,
    x: center.x,
    y: center.y,
    tileCol: spawnTile.col,
    tileRow: spawnTile.row,
    path: [],
    moveProgress: 0,
    reaction: null,
    reactionTimer: 0,
    scufflePartnerId: null,
    scuffleTimer: 0,
    chaseCooldown: 0,
    frame: 0,
    frameTimer: 0,
    wanderTimer: randomRange(PET_WANDER_PAUSE_MIN_SEC, PET_WANDER_PAUSE_MAX_SEC),
    targetKind: null,
    targetAction: null,
    targetSeatId: null,
    targetStationId: null,
    targetAppliance: null,
    targetAgentId: null,
    targetFurnitureUid: null,
    sitTileCol: 0,
    sitTileRow: 0,
    sitFacingDir: Direction.DOWN,
    sitTimer: 0,
    restLift: 0,
    lifespanTimer: 0,
    effect: 'spawn',
    effectTimer: 0,
  };
}

/**
 * Put two pets in a cloud together. Symmetric by construction — one call sets both sides, so a
 * half-formed pair (one animal in a cloud, pointing at somebody who is not in one) cannot exist
 * because somebody forgot the second assignment.
 *
 * Called from OfficeState, which is the only place that can see both animals; the transition itself
 * lives here with the rest of the FSM.
 */
export function beginScuffle(a: Pet, b: Pet): void {
  for (const [pet, other] of [
    [a, b],
    [b, a],
  ] as const) {
    pet.path = [];
    snapToTile(pet);
    pet.reaction = null;
    pet.state = PetState.SCUFFLE;
    pet.scufflePartnerId = other.id;
    pet.scuffleTimer = PET_SCUFFLE_DURATION_SEC;
    pet.frame = 0;
    pet.frameTimer = 0;
    // Face each other, so the beat after the cloud clears reads as two animals sizing each other up
    // rather than as two animals who happen to stand nearby.
    const dx = other.tileCol - pet.tileCol;
    const dy = other.tileRow - pet.tileRow;
    pet.dir =
      Math.abs(dx) >= Math.abs(dy)
        ? dx >= 0
          ? Direction.RIGHT
          : Direction.LEFT
        : dy >= 0
          ? Direction.DOWN
          : Direction.UP;
  }
}

/**
 * End a scuffle for a pet whose partner is no longer in one — it despawned, aged out, or was
 * deleted. The cloud is a PAIR, so one animal left in it would stand invisible behind a picture
 * nobody draws (the renderer needs both to place a cloud between them) until its lifespan ran out.
 */
export function endScuffleAlone(pet: Pet): void {
  pet.scufflePartnerId = null;
  pet.scuffleTimer = 0;
  pet.state = PetState.IDLE;
  pet.wanderTimer = 0;
  pet.frame = 0;
  pet.frameTimer = 0;
}

/** Begin a pet's despawn: release any claim and start the fade-out. */
export function beginPetDespawn(pet: Pet, ctx: Pick<PetUpdateContext, 'releaseClaim'>): void {
  if (pet.state === PetState.DESPAWN) return;
  ctx.releaseClaim(pet);
  // Leave no dangling pair behind: the partner notices on the next tick (resolveScuffles) and gets
  // out of its cloud, but this side must stop claiming a partner it can no longer be one for.
  pet.scufflePartnerId = null;
  pet.scuffleTimer = 0;
  pet.reaction = null;
  pet.state = PetState.DESPAWN;
  pet.effect = 'despawn';
  pet.effectTimer = 0;
}

function clearTarget(pet: Pet): void {
  pet.targetKind = null;
  pet.targetAction = null;
  pet.targetSeatId = null;
  pet.targetStationId = null;
  pet.targetAgentId = null;
  pet.targetFurnitureUid = null;
  pet.restLift = 0;
}

export function updatePet(pet: Pet, dt: number, ctx: PetUpdateContext): void {
  pet.frameTimer += dt;

  // Lifecycle: spawn/despawn fade effects bypass the FSM
  if (pet.state === PetState.SPAWN) {
    pet.effectTimer += dt;
    if (pet.effectTimer >= PET_EFFECT_DURATION_SEC) {
      pet.effect = null;
      pet.effectTimer = 0;
      pet.state = PetState.IDLE;
    }
    return;
  }
  if (pet.state === PetState.DESPAWN) {
    pet.effectTimer += dt;
    return; // OfficeState deletes the pet when the fade completes
  }

  if (pet.chaseCooldown > 0) pet.chaseCooldown = Math.max(0, pet.chaseCooldown - dt);

  // Age the pet; trigger natural despawn at end of life
  pet.lifespanTimer += dt;
  if (pet.lifespanTimer >= PET_LIFESPAN_SEC) {
    beginPetDespawn(pet, ctx);
    return;
  }

  switch (pet.state) {
    case PetState.IDLE: {
      // Idle animates only if the sheet has a multi-frame idle track; otherwise
      // it stays on frame 0 (length 1 → modulo keeps it put).
      advancePetFrame(pet, ctx, PET_IDLE_FRAME_DURATION_SEC, 1);
      pet.wanderTimer -= dt;
      if (pet.wanderTimer > 0) break;

      // Decide: go sit at furniture, or wander to a random tile. The server's
      // pet brain decides when injected; otherwise fall back to the sit-chance
      // roll (keeps the engine self-contained for tests/standalone).
      const action = ctx.decideAction ? ctx.decideAction(pet) : Math.random() < PET_SIT_CHANCE ? 'sit' : 'wander';
      if (action === 'sit' || action === 'drink' || action === 'talk') {
        // Claim-based interactions: walk to a free seat/desk ('sit'), appliance
        // station ('drink') or up to an agent ('talk'), then act on arrival.
        const target = ctx.findTarget(pet, action);
        if (target) {
          pet.targetKind = target.kind;
          pet.targetAction = target.action;
          pet.targetSeatId = target.seatId;
          pet.targetStationId = target.stationId;
          pet.targetAppliance = target.appliance ?? null;
          pet.targetAgentId = target.agentId;
          pet.targetFurnitureUid = target.furnitureUid;
          pet.sitTileCol = target.sitCol;
          pet.sitTileRow = target.sitRow;
          pet.sitFacingDir = target.facing;
          pet.restLift = target.restLift;
          if (target.path.length > 0) {
            pet.path = target.path;
            pet.moveProgress = 0;
            pet.state = PetState.WANDER;
            pet.frame = 0;
            pet.frameTimer = 0;
          } else {
            // Already on the target tile
            beginTargetAction(pet);
          }
          break;
        }
      } else if (action === 'chase' || action === 'flee') {
        // Reactive directed movement: toward what this one hunts, away from what hunts it (CHASES /
        // fleesFrom decide which). No claim — but the reaction is REMEMBERED, so WANDER re-aims it
        // every PET_REACTION_REPATH_SEC. It used to be a single path to wherever the quarry stood
        // at this instant, walked to the end; the hunter then idled for up to 8 seconds and the
        // chase was lost by construction, with nothing to catch and no way to catch it.
        const path = ctx.navigateReaction?.(pet, action) ?? null;
        if (path && path.length > 0) {
          pet.reaction = action;
          pet.reactionTimer = PET_REACTION_REPATH_SEC;
          pet.path = path;
          pet.moveProgress = 0;
          pet.state = PetState.WANDER;
          pet.frame = 0;
          pet.frameTimer = 0;
          break;
        }
        // Nothing reachable — fall through to a random wander.
      }
      // Random wander
      const { walkableTiles, tileMap, blockedTiles, walls } = ctx;
      if (walkableTiles.length > 0) {
        const target = walkableTiles[Math.floor(Math.random() * walkableTiles.length)];
        const path = findPath(pet.tileCol, pet.tileRow, target.col, target.row, tileMap, blockedTiles, undefined, walls);
        if (path.length > 0) {
          pet.path = path;
          pet.moveProgress = 0;
          pet.state = PetState.WANDER;
          pet.frame = 0;
          pet.frameTimer = 0;
        }
      }
      pet.wanderTimer = randomRange(PET_WANDER_PAUSE_MIN_SEC, PET_WANDER_PAUSE_MAX_SEC);
      break;
    }

    case PetState.WANDER: {
      advancePetFrame(pet, ctx, PET_WALK_FRAME_DURATION_SEC, 4);

      // Not reacting yet: look up from the walk. A pet used to notice a quarry only at its own
      // decision points, and those are 1.5-8 s apart (a sit is 8-25 s) — so a dog crossing paths
      // with a cat walked straight past it, and by its next look the cat was long out of the
      // five-tile radius at 2.5 tiles per second. Both roles get this, for the same reason both
      // re-aim on one cadence: whoever notices sooner closes distance sooner, and only geometry
      // is supposed to decide a chase. A SITTING animal is deliberately left alone — a dog that
      // shoots out of a nap because a cat passed three tiles away is a different world.
      if (!pet.reaction) {
        pet.reactionTimer -= dt;
        if (pet.reactionTimer <= 0) {
          pet.reactionTimer = PET_REACTION_REPATH_SEC;
          const seen = ctx.noticeReaction?.(pet) ?? null;
          if (seen && seen.path.length > 0) {
            pet.reaction = seen.action;
            pet.path = seen.path;
            pet.moveProgress = 0;
          }
        }
      }

      // Re-aim a chase or an escape at what the other animal is doing NOW. Both sides do this on
      // the same cadence on purpose: whoever reacts more often closes distance faster, which would
      // be a speed advantage under another name, and the decision was that only geometry — walls,
      // furniture, dead ends — may end a chase.
      if (pet.reaction) {
        pet.reactionTimer -= dt;
        if (pet.reactionTimer <= 0) {
          pet.reactionTimer = PET_REACTION_REPATH_SEC;
          const next = ctx.navigateReaction?.(pet, pet.reaction) ?? null;
          if (next && next.length > 0) {
            pet.path = next;
            pet.moveProgress = 0;
          } else {
            // The other animal is gone, out of range, or unreachable: stop reacting and let the
            // next idle decision start something else.
            pet.reaction = null;
            pet.path = [];
          }
        }
      }

      if (pet.path.length === 0) {
        snapToTile(pet);
        // A reaction that ran out of path re-decides at once rather than standing around for up to
        // eight seconds, which is the pause a wander earns and a chase does not.
        if (pet.reaction) {
          pet.reaction = null;
          pet.state = PetState.IDLE;
          pet.wanderTimer = 0;
          pet.frame = 0;
          pet.frameTimer = 0;
          break;
        }
        // Arrived: if we were heading to a claimed target's sit tile, sit
        if (
          pet.targetKind &&
          pet.tileCol === pet.sitTileCol &&
          pet.tileRow === pet.sitTileRow
        ) {
          beginTargetAction(pet);
        } else {
          if (pet.targetKind) {
            // Couldn't reach the target tile — drop the claim
            ctx.releaseClaim(pet);
            clearTarget(pet);
          }
          pet.state = PetState.IDLE;
          pet.wanderTimer = randomRange(PET_WANDER_PAUSE_MIN_SEC, PET_WANDER_PAUSE_MAX_SEC);
          pet.frame = 0;
          pet.frameTimer = 0;
        }
        break;
      }

      // Move toward next tile in path (shared entity movement).
      stepAlongPath(pet, dt, PET_WALK_SPEED_PX_PER_SEC);
      break;
    }

    case PetState.SCUFFLE: {
      // The cloud's own frames are the CLIENT's business (presentation timing, AGENTS.md
      // invariant 2) — the pets are hidden behind it, so nothing here advances a pet frame. What
      // the server owns is how long it lasts and what it leaves behind.
      pet.scuffleTimer -= dt;
      if (pet.scuffleTimer <= 0) {
        pet.scufflePartnerId = null;
        pet.scuffleTimer = 0;
        pet.reaction = null;
        // Only the chase is held back. The quarry may flee immediately, and that asymmetry is what
        // lets it get away instead of being caught again two seconds later on the same tile.
        pet.chaseCooldown = PET_SCUFFLE_COOLDOWN_SEC;
        pet.state = PetState.IDLE;
        pet.wanderTimer = 0;
        pet.frame = 0;
        pet.frameTimer = 0;
      }
      break;
    }

    case PetState.SIT: {
      advancePetFrame(pet, ctx, PET_TAIL_WAG_DURATION_SEC, 2);
      pet.sitTimer -= dt;
      if (pet.sitTimer <= 0) {
        ctx.releaseClaim(pet);
        clearTarget(pet);
        pet.state = PetState.IDLE;
        pet.wanderTimer = randomRange(PET_WANDER_PAUSE_MIN_SEC, PET_WANDER_PAUSE_MAX_SEC);
        pet.frame = 0;
        pet.frameTimer = 0;
      }
      break;
    }

    case PetState.FEED:
    case PetState.DRINK: {
      // Stand at the appliance for the duration, reusing sitTimer as the stay
      // timer. Cycle the frame so an authored `drink` track animates; with no
      // such track it falls back to idle (length 1 → effectively static).
      advancePetFrame(pet, ctx, PET_DRINK_FRAME_DURATION_SEC, 1);
      pet.sitTimer -= dt;
      if (pet.sitTimer <= 0) {
        ctx.releaseClaim(pet);
        clearTarget(pet);
        pet.state = PetState.IDLE;
        pet.wanderTimer = randomRange(PET_WANDER_PAUSE_MIN_SEC, PET_WANDER_PAUSE_MAX_SEC);
        pet.frame = 0;
        pet.frameTimer = 0;
      }
      break;
    }

    case PetState.TALK: {
      // Stand next to the agent for the duration (reusing sitTimer). A drawn
      // `talk` track animates; otherwise it falls back to idle (static).
      advancePetFrame(pet, ctx, PET_TALK_FRAME_DURATION_SEC, 1);
      pet.sitTimer -= dt;
      if (pet.sitTimer <= 0) {
        ctx.releaseClaim(pet);
        clearTarget(pet);
        pet.state = PetState.IDLE;
        pet.wanderTimer = randomRange(PET_WANDER_PAUSE_MIN_SEC, PET_WANDER_PAUSE_MAX_SEC);
        pet.frame = 0;
        pet.frameTimer = 0;
      }
      break;
    }
  }
}

/** Dispatch the action a pet performs on reaching its claimed target. */
function beginTargetAction(pet: Pet): void {
  switch (pet.targetAction) {
    case 'drink':
      startDrinking(pet);
      break;
    case 'talk':
      startTalking(pet);
      break;
    case 'sit':
    default:
      startSitting(pet);
      break;
  }
}

/** Stand at a claimed appliance station for a while (coffee). Idle pose. */
/** Stand at the claimed appliance. WHICH state depends on what the appliance is: a bowl is a
 *  meal (`FEED`), anything else a drink. The state is what the client reads to pick the pose, so
 *  this one line is the whole difference between a pet lapping at a fountain and eating. */
function startDrinking(pet: Pet): void {
  const center = tileCenter(pet.sitTileCol, pet.sitTileRow);
  pet.tileCol = pet.sitTileCol;
  pet.tileRow = pet.sitTileRow;
  pet.x = center.x;
  pet.y = center.y;
  pet.dir = pet.sitFacingDir;
  pet.state = pet.targetAppliance === 'pet_feed' ? PetState.FEED : PetState.DRINK;
  pet.sitTimer = randomRange(PET_DRINK_MIN_SEC, PET_DRINK_MAX_SEC);
  pet.frame = 0;
  pet.frameTimer = 0;
}

/** Stand next to a claimed agent, facing it, for a while (talk). */
function startTalking(pet: Pet): void {
  const center = tileCenter(pet.sitTileCol, pet.sitTileRow);
  pet.tileCol = pet.sitTileCol;
  pet.tileRow = pet.sitTileRow;
  pet.x = center.x;
  pet.y = center.y;
  pet.dir = pet.sitFacingDir;
  pet.state = PetState.TALK;
  pet.sitTimer = randomRange(PET_TALK_MIN_SEC, PET_TALK_MAX_SEC);
  pet.frame = 0;
  pet.frameTimer = 0;
}

function startSitting(pet: Pet): void {
  const center = tileCenter(pet.sitTileCol, pet.sitTileRow);
  pet.tileCol = pet.sitTileCol;
  pet.tileRow = pet.sitTileRow;
  pet.x = center.x;
  pet.y = center.y;
  pet.dir = pet.sitFacingDir;
  pet.state = PetState.SIT;
  pet.sitTimer = randomRange(PET_SIT_MIN_SEC, PET_SIT_MAX_SEC);
  pet.frame = 0;
  pet.frameTimer = 0;
}

/** Map a pet's FSM state to an animation track name (the unified pet pipeline
 *  resolves the frame via spriteForPose). wander/chase/flee→walk, sit→sit,
 *  drink→drink, else idle. Tracks that aren't drawn fall back to idle in
 *  spriteForPose, so a pet without a `drink` sheet just stands there. */
export function petPose(pet: Pet): string {
  switch (pet.state) {
    case PetState.WANDER:
      return 'walk';
    case PetState.SIT:
      return 'sit';
    case PetState.DRINK:
      return 'drink';
    case PetState.FEED:
      return 'feed';

    case PetState.TALK:
      return 'talk';
    case PetState.SCUFFLE:
      // The cloud hides both animals, so this is only what shows if its sheet failed to load —
      // standing still is the right fallback, and better than an invisible pet.
      return 'idle';
    default:
      return 'idle';
  }
}
