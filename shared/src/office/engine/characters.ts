import {
  COFFEE_COOLDOWN_MAX_SEC,
  COFFEE_COOLDOWN_MIN_SEC,
  COFFEE_STAND_MAX_SEC,
  COFFEE_STAND_MIN_SEC,
  SEAT_REST_MAX_SEC,
  SEAT_REST_MIN_SEC,
  WALK_SPEED_PX_PER_SEC,
  WANDER_MOVES_BEFORE_REST_MAX,
  WANDER_MOVES_BEFORE_REST_MIN,
  WANDER_PAUSE_MAX_SEC,
  WANDER_PAUSE_MIN_SEC,
} from '../constants.js';
import { snapToTile, stepAlongPath, tileCenter } from './entity.js';
import { findPath } from '../layout/tileMap.js';
import type { WallEdges, GroundMap } from '../types.js';
import type { CharacterSprites } from '../sprites/spriteData.js';
import { spriteForPose } from '../sprites/spriteData.js';
import { isReadingToolName } from '../toolUtils.js';
import type {
  Character,
  CharacterPose,
  InteractionPoint,
  SpriteData,
  TileType as TileTypeVal,
} from '../types.js';
import { CharacterPose as Pose, CharacterState, Direction } from '../types.js';

/** Whether a tool should show the reading animation (vs typing). Taxonomy comes
 *  from the active HookProvider via the `providerCapabilities` message. */
export function isReadingTool(tool: string | null): boolean {
  if (!tool) return false;
  return isReadingToolName(tool);
}

export function createCharacter(
  id: number,
  skin: string,
  homePointId: string | null,
  home: InteractionPoint | null,
): Character {
  const col = home ? home.col : 1;
  const row = home ? home.row : 1;
  const center = tileCenter(col, row);
  return {
    id,
    state: CharacterState.TYPE,
    dir: home ? home.facingDir : Direction.DOWN,
    x: center.x,
    y: center.y,
    tileCol: col,
    tileRow: row,
    path: [],
    moveProgress: 0,
    currentTool: null,
    skin,
    frame: 0,
    frameTimer: 0,
    wanderTimer: 0,
    wanderCount: 0,
    wanderLimit: randomInt(WANDER_MOVES_BEFORE_REST_MIN, WANDER_MOVES_BEFORE_REST_MAX),
    isActive: true,
    homePointId,
    atPointId: null,
    atPointTimer: 0,
    coffeeCooldown: randomRange(COFFEE_COOLDOWN_MIN_SEC, COFFEE_COOLDOWN_MAX_SEC),
    bubbleType: null,
    bubbleTimer: 0,
    seatTimer: 0,
    isSubagent: false,
    isPlayer: false,
    afk: false,
    parentAgentId: null,
    matrixEffect: null,
    matrixEffectTimer: 0,
    matrixEffectSeeds: [],
    inputTokens: 0,
    outputTokens: 0,
  };
}

export function updateCharacter(
  ch: Character,
  dt: number,
  walkableTiles: Array<{ col: number; row: number }>,
  /** Every interaction point in the zone — chairs and appliance stand tiles
   *  alike (see InteractionPoint). One map, because "somebody is here" is one
   *  question; `posture` says which kind of here. */
  points: Map<string, InteractionPoint>,
  tileMap: GroundMap,
  blockedTiles: Set<string>,
  /** Wall edges, so wandering respects walls — see wallEdges.ts. */
  walls?: WallEdges,
): void {
  // Animation frame phase is cosmetic and timed client-side (the server syncs
  // pose/dir/state, not the frame index). The engine no longer advances frames.

  switch (ch.state) {
    case CharacterState.TYPE: {
      // If no longer active, stand up and start wandering (after seatTimer expires)
      if (!ch.isActive) {
        if (ch.seatTimer > 0) {
          ch.seatTimer -= dt;
          break;
        }
        ch.seatTimer = 0; // clear sentinel
        ch.state = CharacterState.IDLE;
        ch.frame = 0;
        ch.frameTimer = 0;
        ch.wanderTimer = randomRange(WANDER_PAUSE_MIN_SEC, WANDER_PAUSE_MAX_SEC);
        ch.wanderCount = 0;
        ch.wanderLimit = randomInt(WANDER_MOVES_BEFORE_REST_MIN, WANDER_MOVES_BEFORE_REST_MAX);
      }
      break;
    }

    case CharacterState.IDLE: {
      if (ch.seatTimer < 0) ch.seatTimer = 0; // clear turn-end sentinel

      // Standing at an interaction station (e.g. coffee machine)?
      if (ch.atPointId) {
        const at = points.get(ch.atPointId);
        if (!at || ch.isActive) {
          // Work resumed or station vanished → end the break and continue below.
          releasePoint(ch, points);
        } else {
          ch.dir = at.facingDir;
          ch.atPointTimer -= dt;
          if (ch.atPointTimer <= 0) {
            releasePoint(ch, points);
            ch.frame = 0;
            ch.wanderTimer = randomRange(WANDER_PAUSE_MIN_SEC, WANDER_PAUSE_MAX_SEC);
          }
          break; // stay at the station while on the break
        }
      }

      // No idle animation — static pose
      ch.frame = 0;

      // If became active, pathfind to seat
      if (ch.isActive) {
        if (!ch.homePointId) {
          // No seat assigned — type in place
          ch.state = CharacterState.TYPE;
          ch.frame = 0;
          ch.frameTimer = 0;
          break;
        }
        const home = points.get(ch.homePointId);
        if (home) {
          const path = findPath(
            ch.tileCol,
            ch.tileRow,
            home.col,
            home.row,
            tileMap,
            blockedTiles,
            undefined,
            walls,
          );
          if (path.length > 0) {
            ch.path = path;
            ch.moveProgress = 0;
            ch.state = CharacterState.WALK;
            ch.frame = 0;
            ch.frameTimer = 0;
          } else {
            // Already at seat or no path — sit down
            ch.state = CharacterState.TYPE;
            ch.dir = home.facingDir;
            ch.frame = 0;
            ch.frameTimer = 0;
          }
        }
        break;
      }
      // Countdown wander timer
      ch.wanderTimer -= dt;
      if (ch.wanderTimer <= 0) {
        // Check if we've wandered enough — return to seat for a rest
        if (ch.wanderCount >= ch.wanderLimit && ch.homePointId) {
          const home = points.get(ch.homePointId);
          if (home) {
            const path = findPath(
              ch.tileCol,
              ch.tileRow,
              home.col,
              home.row,
              tileMap,
              blockedTiles,
              undefined,
              walls,
            );
            if (path.length > 0) {
              ch.path = path;
              ch.moveProgress = 0;
              ch.state = CharacterState.WALK;
              ch.frame = 0;
              ch.frameTimer = 0;
              break;
            }
          }
        }
        if (walkableTiles.length > 0) {
          const target = walkableTiles[Math.floor(Math.random() * walkableTiles.length)];
          const path = findPath(
            ch.tileCol,
            ch.tileRow,
            target.col,
            target.row,
            tileMap,
            blockedTiles,
            undefined,
            walls,
          );
          if (path.length > 0) {
            ch.path = path;
            ch.moveProgress = 0;
            ch.state = CharacterState.WALK;
            ch.frame = 0;
            ch.frameTimer = 0;
            ch.wanderCount++;
          }
        }
        ch.wanderTimer = randomRange(WANDER_PAUSE_MIN_SEC, WANDER_PAUSE_MAX_SEC);
      }
      break;
    }

    case CharacterState.WALK: {
      if (ch.path.length === 0) {
        // Path complete — snap to tile center and transition
        snapToTile(ch);

        // Arrived at an interaction station → stand facing the furniture.
        if (ch.atPointId) {
          const at = points.get(ch.atPointId);
          if (at && !ch.isActive && ch.tileCol === at.col && ch.tileRow === at.row) {
            ch.state = CharacterState.IDLE;
            ch.dir = at.facingDir;
            ch.atPointTimer = randomRange(COFFEE_STAND_MIN_SEC, COFFEE_STAND_MAX_SEC);
            ch.frame = 0;
            ch.frameTimer = 0;
            break;
          }
          // Not actually there, became active, or station gone → drop the claim.
          releasePoint(ch, points);
        }

        if (ch.isActive) {
          if (!ch.homePointId) {
            // No seat — type in place
            ch.state = CharacterState.TYPE;
          } else {
            const home = points.get(ch.homePointId);
            if (home && ch.tileCol === home.col && ch.tileRow === home.row) {
              ch.state = CharacterState.TYPE;
              ch.dir = home.facingDir;
              // Sitting at your own point also OCCUPIES it — the same fact a
              // player's sit records, so "who is here" is one question for both
              // (see OfficeState.autoOnSitters).
              claimPoint(ch, points, ch.homePointId);
            } else {
              ch.state = CharacterState.IDLE;
            }
          }
        } else {
          // Check if arrived at assigned seat — sit down for a rest before wandering again
          if (ch.homePointId) {
            const home = points.get(ch.homePointId);
            if (home && ch.tileCol === home.col && ch.tileRow === home.row) {
              ch.state = CharacterState.TYPE;
              ch.dir = home.facingDir;
              claimPoint(ch, points, ch.homePointId);
              // seatTimer < 0 is a sentinel from setAgentActive(false) meaning
              // "turn just ended" — skip the long rest so idle transition is immediate
              if (ch.seatTimer < 0) {
                ch.seatTimer = 0;
              } else {
                ch.seatTimer = randomRange(SEAT_REST_MIN_SEC, SEAT_REST_MAX_SEC);
              }
              ch.wanderCount = 0;
              ch.wanderLimit = randomInt(
                WANDER_MOVES_BEFORE_REST_MIN,
                WANDER_MOVES_BEFORE_REST_MAX,
              );
              ch.frame = 0;
              ch.frameTimer = 0;
              break;
            }
          }
          ch.state = CharacterState.IDLE;
          ch.wanderTimer = randomRange(WANDER_PAUSE_MIN_SEC, WANDER_PAUSE_MAX_SEC);
        }
        ch.frame = 0;
        ch.frameTimer = 0;
        break;
      }

      // Move toward next tile in path (shared entity movement).
      stepAlongPath(ch, dt, WALK_SPEED_PX_PER_SEC);

      // If work resumed while walking to a coffee break, abandon the claim.
      if (ch.isActive && ch.atPointId) {
        releasePoint(ch, points);
      }

      // If became active while wandering, repath to seat
      if (ch.isActive && ch.homePointId) {
        const home = points.get(ch.homePointId);
        if (home) {
          const lastStep = ch.path[ch.path.length - 1];
          if (!lastStep || lastStep.col !== home.col || lastStep.row !== home.row) {
            const newPath = findPath(
              ch.tileCol,
              ch.tileRow,
              home.col,
              home.row,
              tileMap,
              blockedTiles,
              undefined,
              walls,
            );
            if (newPath.length > 0) {
              ch.path = newPath;
              ch.moveProgress = 0;
            }
          }
        }
      }
      break;
    }
  }
}

/** Derive a character's animation pose from its state. Server-side: this is the
 *  only place that reads stationId / tool, so the renderer can stay pose-only. */
export function getCharacterPose(ch: Character): CharacterPose {
  switch (ch.state) {
    case CharacterState.WALK:
      return Pose.WALK;
    case CharacterState.SIT:
      return Pose.SIT;
    case CharacterState.TYPE:
      return isReadingTool(ch.currentTool) ? Pose.READING : Pose.TYPING;
    case CharacterState.IDLE:
    default:
      // Standing at an interaction station (coffee machine, …) vs plain idle.
      return ch.atPointId ? Pose.COFFEE : Pose.IDLE;
  }
}

/** Get the sprite frame for a character. Uses the synced pose when present
 *  (client), else derives it (server / fallback). */
export function getCharacterSprite(ch: Character, sprites: CharacterSprites): SpriteData {
  const pose = ch.pose ?? getCharacterPose(ch);
  return spriteForPose(pose, ch.dir, ch.frame, sprites);
}

/** Let go of whatever point this character was occupying (idempotent). Exported
 *  because officeState's player-only movement path doesn't run the agent FSM
 *  above and has to release a player's own claim itself. */
export function releasePoint(ch: Character, points: Map<string, InteractionPoint>): void {
  if (!ch.atPointId) return;
  const at = points.get(ch.atPointId);
  if (at && at.occupantId === ch.id) at.occupantId = null;
  ch.atPointId = null;
  ch.atPointTimer = 0;
}

/**
 * Take a point, if it is free or already ours; false when somebody else holds it.
 *
 * This one rule is what makes occupancy symmetric. Both the agent FSM and a
 * player's click go through here, so an agent can no longer be sent to the chair
 * a player is sitting on — which is exactly what used to happen, since a player's
 * sit was recorded nowhere and the old `Seat.assigned` boolean stayed false.
 */
export function claimPoint(ch: Character, points: Map<string, InteractionPoint>, uid: string): boolean {
  const point = points.get(uid);
  if (!point || (point.occupantId !== null && point.occupantId !== ch.id)) return false;
  if (ch.atPointId && ch.atPointId !== uid) releasePoint(ch, points);
  point.occupantId = ch.id;
  ch.atPointId = uid;
  return true;
}

function randomRange(min: number, max: number): number {
  return min + Math.random() * (max - min);
}

function randomInt(min: number, max: number): number {
  return min + Math.floor(Math.random() * (max - min + 1));
}
