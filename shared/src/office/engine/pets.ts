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
  PET_WALK_SPEED_PX_PER_SEC,
  PET_WANDER_PAUSE_MAX_SEC,
  PET_WANDER_PAUSE_MIN_SEC,
} from '../constants.js';
import { snapToTile, stepAlongPath, tileCenter } from './entity.js';
import { findPath } from '../layout/tileMap.js';
import { getNpcSprites, spriteForPose } from '../sprites/spriteData.js';
import type { Pet, PetKind, SpriteData, TileType as TileTypeVal } from '../types.js';
import { Direction, PetState } from '../types.js';

/**
 * The high-level activity an NPC brain can choose and the actuator can execute.
 * This is the shared vocabulary between the server-only behaviour tree (which
 * decides) and the engine (which executes); the brain imports it rather than
 * defining its own. Extensible — N3.3 adds `drink` (coffee), `talk` (agent),
 * and `chase`/`flee` (shoo-cat) as new affordance-driven actions.
 */
export type NpcAction = 'wander' | 'sit' | 'chase' | 'flee' | 'drink' | 'talk';

/** Kinds of interactable the world affords an NPC: claimable seats, adjacent-to
 *  furniture (cat on a desk), appliance stations (coffee), and agents (talk). */
export type AffordanceKind = 'seat' | 'furniture' | 'station' | 'agent';

/**
 * What's available in the world for an NPC to interact with right now — a cheap
 * existence snapshot OfficeState hands the brain so it can pick a sensible
 * action (don't choose "rest" with no free seat). Reachability is confirmed
 * later by `findTarget`; this stays pathfinding-free so it's cheap per decision.
 */
export interface NpcAffordances {
  /** A seat (or, for cats, a desk) the pet could go rest at exists. */
  canRest: boolean;
  /** A cat is within shoo range to chase (dogs only). */
  canChase: boolean;
  /** A dog is within shoo range — flee it (cats only). */
  threatened: boolean;
  /** A free appliance station (coffee) exists to go drink at. */
  canDrink: boolean;
  /** An agent is around to go talk to. */
  canTalk: boolean;
}

/** A reachable, already-claimed interaction target (computed by OfficeState). */
export interface PetTarget {
  kind: AffordanceKind;
  /** What the pet does once it arrives (seat/desk → 'sit', station → 'drink'). */
  action: NpcAction;
  seatId: string | null;
  furnitureUid: string | null;
  /** Claimed appliance station uid (for 'station' targets), else null. */
  stationId: string | null;
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

export interface PetUpdateContext {
  walkableTiles: Array<{ col: number; row: number }>;
  tileMap: TileTypeVal[][];
  blockedTiles: Set<string>;
  /** Find + claim a free interaction target reachable from the pet for the given
   *  action ('sit' → seat/desk, 'drink' → appliance station), or null. */
  findTarget: (pet: Pet, action: NpcAction) => PetTarget | null;
  /** Release the pet's current seat/furniture claim (no-op if none). */
  releaseClaim: (pet: Pet) => void;
  /** Decide the next idle activity for a pet (injected by the server's NPC brain;
   *  absent → the built-in sit-chance roll). */
  decideAction?: (pet: Pet) => NpcAction;
  /** Resolve a directed move path for a reactive action — toward the nearest cat
   *  ('chase') or away from the nearest dog ('flee'). OfficeState supplies it
   *  (it knows every pet's position); null when no path applies. */
  navigateReaction?: (pet: Pet, action: NpcAction) => Array<{ col: number; row: number }> | null;
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
    frame: 0,
    frameTimer: 0,
    wanderTimer: randomRange(PET_WANDER_PAUSE_MIN_SEC, PET_WANDER_PAUSE_MAX_SEC),
    targetKind: null,
    targetAction: null,
    targetSeatId: null,
    targetStationId: null,
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

/** Begin a pet's despawn: release any claim and start the fade-out. */
export function beginPetDespawn(pet: Pet, ctx: Pick<PetUpdateContext, 'releaseClaim'>): void {
  if (pet.state === PetState.DESPAWN) return;
  ctx.releaseClaim(pet);
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
      // NPC brain decides when injected; otherwise fall back to the sit-chance
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
        // Reactive directed movement (toward a cat / away from a dog). No claim;
        // on arrival the pet just returns to idle and may react again.
        const path = ctx.navigateReaction?.(pet, action) ?? null;
        if (path && path.length > 0) {
          pet.path = path;
          pet.moveProgress = 0;
          pet.state = PetState.WANDER;
          pet.frame = 0;
          pet.frameTimer = 0;
          break;
        }
        // No reachable target — fall through to a random wander.
      }
      // Random wander
      const { walkableTiles, tileMap, blockedTiles } = ctx;
      if (walkableTiles.length > 0) {
        const target = walkableTiles[Math.floor(Math.random() * walkableTiles.length)];
        const path = findPath(pet.tileCol, pet.tileRow, target.col, target.row, tileMap, blockedTiles);
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

      if (pet.path.length === 0) {
        snapToTile(pet);
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
function startDrinking(pet: Pet): void {
  const center = tileCenter(pet.sitTileCol, pet.sitTileRow);
  pet.tileCol = pet.sitTileCol;
  pet.tileRow = pet.sitTileRow;
  pet.x = center.x;
  pet.y = center.y;
  pet.dir = pet.sitFacingDir;
  pet.state = PetState.DRINK;
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

/** Map a pet's FSM state to an animation track name (the unified NPC pipeline
 *  resolves the frame via spriteForPose). wander/chase/flee→walk, sit→sit,
 *  drink→drink, else idle. Tracks that aren't drawn fall back to idle in
 *  spriteForPose, so an NPC without a `drink` sheet just stands there. */
export function petPose(pet: Pet): string {
  switch (pet.state) {
    case PetState.WANDER:
      return 'walk';
    case PetState.SIT:
      return 'sit';
    case PetState.DRINK:
      return 'drink';
    case PetState.TALK:
      return 'talk';
    default:
      return 'idle';
  }
}

/** Current sprite for a pet — the entity→sprite resolver, symmetric with
 *  getCharacterSprite. Each entity kind exposes one of these (built on the shared
 *  track pipeline), so the renderer treats every kind the same way. */
export function getPetSprite(pet: Pet): SpriteData {
  return spriteForPose(petPose(pet), pet.dir, pet.frame, getNpcSprites(pet.kind, pet.variant));
}
