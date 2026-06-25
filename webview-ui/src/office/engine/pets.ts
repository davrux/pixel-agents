/**
 * Pet engine — lightweight wander/sit FSM for ambient dogs & cats.
 *
 * Parallels the character FSM (characters.ts) but is far simpler: pets only
 * wander, pause, and sit at claimed furniture (tail wagging). Furniture
 * targeting / occupancy lives in OfficeState and is provided via PetUpdateContext.
 */

import {
  PET_EFFECT_DURATION_SEC,
  PET_LIFESPAN_SEC,
  PET_SIT_CHANCE,
  PET_SIT_MAX_SEC,
  PET_SIT_MIN_SEC,
  PET_TAIL_WAG_DURATION_SEC,
  PET_WALK_FRAME_DURATION_SEC,
  PET_WALK_SPEED_PX_PER_SEC,
  PET_WANDER_PAUSE_MAX_SEC,
  PET_WANDER_PAUSE_MIN_SEC,
} from '../../constants.js';
import { findPath } from '../layout/tileMap.js';
import type { PetSprites } from '../sprites/spriteData.js';
import type { Pet, PetKind, SpriteData, TileType as TileTypeVal } from '../types.js';
import { Direction, PetState, TILE_SIZE } from '../types.js';

/** A reachable, already-claimed interaction target (computed by OfficeState). */
export interface PetTarget {
  kind: 'seat' | 'furniture';
  seatId: string | null;
  furnitureUid: string | null;
  sitCol: number;
  sitRow: number;
  facing: Direction;
  /** Path from the pet's current tile to the sit tile (excludes start). */
  path: Array<{ col: number; row: number }>;
}

export interface PetUpdateContext {
  walkableTiles: Array<{ col: number; row: number }>;
  tileMap: TileTypeVal[][];
  blockedTiles: Set<string>;
  /** Find + claim a free interaction target reachable from the pet, or null. */
  findTarget: (pet: Pet) => PetTarget | null;
  /** Release the pet's current seat/furniture claim (no-op if none). */
  releaseClaim: (pet: Pet) => void;
}

function tileCenter(col: number, row: number): { x: number; y: number } {
  return { x: col * TILE_SIZE + TILE_SIZE / 2, y: row * TILE_SIZE + TILE_SIZE / 2 };
}

function directionBetween(fromCol: number, fromRow: number, toCol: number, toRow: number): Direction {
  const dc = toCol - fromCol;
  const dr = toRow - fromRow;
  if (dc > 0) return Direction.RIGHT;
  if (dc < 0) return Direction.LEFT;
  if (dr > 0) return Direction.DOWN;
  return Direction.UP;
}

function randomRange(min: number, max: number): number {
  return min + Math.random() * (max - min);
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
    targetSeatId: null,
    targetFurnitureUid: null,
    sitTileCol: 0,
    sitTileRow: 0,
    sitFacingDir: Direction.DOWN,
    sitTimer: 0,
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
  pet.targetSeatId = null;
  pet.targetFurnitureUid = null;
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
      pet.frame = 0;
      pet.wanderTimer -= dt;
      if (pet.wanderTimer > 0) break;

      // Decide: go sit at furniture, or wander to a random tile
      if (Math.random() < PET_SIT_CHANCE) {
        const target = ctx.findTarget(pet);
        if (target) {
          pet.targetKind = target.kind;
          pet.targetSeatId = target.seatId;
          pet.targetFurnitureUid = target.furnitureUid;
          pet.sitTileCol = target.sitCol;
          pet.sitTileRow = target.sitRow;
          pet.sitFacingDir = target.facing;
          if (target.path.length > 0) {
            pet.path = target.path;
            pet.moveProgress = 0;
            pet.state = PetState.WANDER;
            pet.frame = 0;
            pet.frameTimer = 0;
          } else {
            // Already on the sit tile
            startSitting(pet);
          }
          break;
        }
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
      if (pet.frameTimer >= PET_WALK_FRAME_DURATION_SEC) {
        pet.frameTimer -= PET_WALK_FRAME_DURATION_SEC;
        pet.frame = (pet.frame + 1) % 4;
      }

      if (pet.path.length === 0) {
        const center = tileCenter(pet.tileCol, pet.tileRow);
        pet.x = center.x;
        pet.y = center.y;
        // Arrived: if we were heading to a claimed target's sit tile, sit
        if (
          pet.targetKind &&
          pet.tileCol === pet.sitTileCol &&
          pet.tileRow === pet.sitTileRow
        ) {
          startSitting(pet);
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

      const nextTile = pet.path[0];
      pet.dir = directionBetween(pet.tileCol, pet.tileRow, nextTile.col, nextTile.row);
      pet.moveProgress += (PET_WALK_SPEED_PX_PER_SEC / TILE_SIZE) * dt;

      const fromCenter = tileCenter(pet.tileCol, pet.tileRow);
      const toCenter = tileCenter(nextTile.col, nextTile.row);
      const t = Math.min(pet.moveProgress, 1);
      pet.x = fromCenter.x + (toCenter.x - fromCenter.x) * t;
      pet.y = fromCenter.y + (toCenter.y - fromCenter.y) * t;

      if (pet.moveProgress >= 1) {
        pet.tileCol = nextTile.col;
        pet.tileRow = nextTile.row;
        pet.x = toCenter.x;
        pet.y = toCenter.y;
        pet.path.shift();
        pet.moveProgress = 0;
      }
      break;
    }

    case PetState.SIT: {
      if (pet.frameTimer >= PET_TAIL_WAG_DURATION_SEC) {
        pet.frameTimer -= PET_TAIL_WAG_DURATION_SEC;
        pet.frame = (pet.frame + 1) % 2;
      }
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

/** Resolve the sprite frame for a pet's current state & direction. */
export function getPetSprite(pet: Pet, sprites: PetSprites): SpriteData {
  switch (pet.state) {
    case PetState.WANDER:
      return sprites.walk[pet.dir][pet.frame % 4];
    case PetState.SIT:
      return sprites.sit[pet.dir][pet.frame % 2];
    default:
      return sprites.idle[pet.dir];
  }
}
