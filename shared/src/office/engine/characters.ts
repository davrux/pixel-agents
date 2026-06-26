import {
  COFFEE_COOLDOWN_MAX_SEC,
  COFFEE_COOLDOWN_MIN_SEC,
  COFFEE_FRAME_DURATION_SEC,
  COFFEE_STAND_MAX_SEC,
  COFFEE_STAND_MIN_SEC,
  SEAT_REST_MAX_SEC,
  SEAT_REST_MIN_SEC,
  TYPE_FRAME_DURATION_SEC,
  WALK_FRAME_DURATION_SEC,
  WALK_SPEED_PX_PER_SEC,
  WANDER_MOVES_BEFORE_REST_MAX,
  WANDER_MOVES_BEFORE_REST_MIN,
  WANDER_PAUSE_MAX_SEC,
  WANDER_PAUSE_MIN_SEC,
} from '../constants.js';
import { findPath } from '../layout/tileMap.js';
import type { CharacterSprites } from '../sprites/spriteData.js';
import { getPosePlaybackLength, spriteForPose } from '../sprites/spriteData.js';
import { isReadingToolName } from '../toolUtils.js';
import type {
  Character,
  CharacterPose,
  InteractionPoint,
  Seat,
  SpriteData,
  TileType as TileTypeVal,
} from '../types.js';
import { CharacterPose as Pose, CharacterState, Direction, TILE_SIZE } from '../types.js';

/** Whether a tool should show the reading animation (vs typing). Taxonomy comes
 *  from the active HookProvider via the `providerCapabilities` message. */
export function isReadingTool(tool: string | null): boolean {
  if (!tool) return false;
  return isReadingToolName(tool);
}

/** Pixel center of a tile */
function tileCenter(col: number, row: number): { x: number; y: number } {
  return {
    x: col * TILE_SIZE + TILE_SIZE / 2,
    y: row * TILE_SIZE + TILE_SIZE / 2,
  };
}

/** Direction from one tile to an adjacent tile */
function directionBetween(
  fromCol: number,
  fromRow: number,
  toCol: number,
  toRow: number,
): Direction {
  const dc = toCol - fromCol;
  const dr = toRow - fromRow;
  if (dc > 0) return Direction.RIGHT;
  if (dc < 0) return Direction.LEFT;
  if (dr > 0) return Direction.DOWN;
  return Direction.UP;
}

export function createCharacter(
  id: number,
  palette: number,
  seatId: string | null,
  seat: Seat | null,
  hueShift = 0,
): Character {
  const col = seat ? seat.seatCol : 1;
  const row = seat ? seat.seatRow : 1;
  const center = tileCenter(col, row);
  return {
    id,
    state: CharacterState.TYPE,
    dir: seat ? seat.facingDir : Direction.DOWN,
    x: center.x,
    y: center.y,
    tileCol: col,
    tileRow: row,
    path: [],
    moveProgress: 0,
    currentTool: null,
    palette,
    hueShift,
    frame: 0,
    frameTimer: 0,
    wanderTimer: 0,
    wanderCount: 0,
    wanderLimit: randomInt(WANDER_MOVES_BEFORE_REST_MIN, WANDER_MOVES_BEFORE_REST_MAX),
    isActive: true,
    seatId,
    stationId: null,
    stationTimer: 0,
    coffeeCooldown: randomRange(COFFEE_COOLDOWN_MIN_SEC, COFFEE_COOLDOWN_MAX_SEC),
    bubbleType: null,
    bubbleTimer: 0,
    seatTimer: 0,
    isSubagent: false,
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
  seats: Map<string, Seat>,
  stations: Map<string, InteractionPoint>,
  tileMap: TileTypeVal[][],
  blockedTiles: Set<string>,
): void {
  ch.frameTimer += dt;

  switch (ch.state) {
    case CharacterState.TYPE: {
      if (ch.frameTimer >= TYPE_FRAME_DURATION_SEC) {
        ch.frameTimer -= TYPE_FRAME_DURATION_SEC;
        // typing vs reading track length (derived from the current tool)
        ch.frame = (ch.frame + 1) % getPosePlaybackLength(ch.palette, getCharacterPose(ch));
      }
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
      if (ch.stationId) {
        const station = stations.get(ch.stationId);
        if (!station || ch.isActive) {
          // Work resumed or station vanished → end the break and continue below.
          releaseStation(ch, stations);
        } else {
          ch.dir = station.facingDir;
          // Animate the standing/coffee pose (renderer clamps to real frame
          // count, so the idle-stand fallback stays still).
          if (ch.frameTimer >= COFFEE_FRAME_DURATION_SEC) {
            ch.frameTimer -= COFFEE_FRAME_DURATION_SEC;
            ch.frame = (ch.frame + 1) % getPosePlaybackLength(ch.palette, Pose.COFFEE);
          }
          ch.stationTimer -= dt;
          if (ch.stationTimer <= 0) {
            releaseStation(ch, stations);
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
        if (!ch.seatId) {
          // No seat assigned — type in place
          ch.state = CharacterState.TYPE;
          ch.frame = 0;
          ch.frameTimer = 0;
          break;
        }
        const seat = seats.get(ch.seatId);
        if (seat) {
          const path = findPath(
            ch.tileCol,
            ch.tileRow,
            seat.seatCol,
            seat.seatRow,
            tileMap,
            blockedTiles,
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
            ch.dir = seat.facingDir;
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
        if (ch.wanderCount >= ch.wanderLimit && ch.seatId) {
          const seat = seats.get(ch.seatId);
          if (seat) {
            const path = findPath(
              ch.tileCol,
              ch.tileRow,
              seat.seatCol,
              seat.seatRow,
              tileMap,
              blockedTiles,
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
      // Walk animation (cycle length from the character's walk track)
      if (ch.frameTimer >= WALK_FRAME_DURATION_SEC) {
        ch.frameTimer -= WALK_FRAME_DURATION_SEC;
        ch.frame = (ch.frame + 1) % getPosePlaybackLength(ch.palette, Pose.WALK);
      }

      if (ch.path.length === 0) {
        // Path complete — snap to tile center and transition
        const center = tileCenter(ch.tileCol, ch.tileRow);
        ch.x = center.x;
        ch.y = center.y;

        // Arrived at an interaction station → stand facing the furniture.
        if (ch.stationId) {
          const station = stations.get(ch.stationId);
          if (
            station &&
            !ch.isActive &&
            ch.tileCol === station.col &&
            ch.tileRow === station.row
          ) {
            ch.state = CharacterState.IDLE;
            ch.dir = station.facingDir;
            ch.stationTimer = randomRange(COFFEE_STAND_MIN_SEC, COFFEE_STAND_MAX_SEC);
            ch.frame = 0;
            ch.frameTimer = 0;
            break;
          }
          // Not actually there, became active, or station gone → drop the claim.
          releaseStation(ch, stations);
        }

        if (ch.isActive) {
          if (!ch.seatId) {
            // No seat — type in place
            ch.state = CharacterState.TYPE;
          } else {
            const seat = seats.get(ch.seatId);
            if (seat && ch.tileCol === seat.seatCol && ch.tileRow === seat.seatRow) {
              ch.state = CharacterState.TYPE;
              ch.dir = seat.facingDir;
            } else {
              ch.state = CharacterState.IDLE;
            }
          }
        } else {
          // Check if arrived at assigned seat — sit down for a rest before wandering again
          if (ch.seatId) {
            const seat = seats.get(ch.seatId);
            if (seat && ch.tileCol === seat.seatCol && ch.tileRow === seat.seatRow) {
              ch.state = CharacterState.TYPE;
              ch.dir = seat.facingDir;
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

      // Move toward next tile in path
      const nextTile = ch.path[0];
      ch.dir = directionBetween(ch.tileCol, ch.tileRow, nextTile.col, nextTile.row);

      ch.moveProgress += (WALK_SPEED_PX_PER_SEC / TILE_SIZE) * dt;

      const fromCenter = tileCenter(ch.tileCol, ch.tileRow);
      const toCenter = tileCenter(nextTile.col, nextTile.row);
      const t = Math.min(ch.moveProgress, 1);
      ch.x = fromCenter.x + (toCenter.x - fromCenter.x) * t;
      ch.y = fromCenter.y + (toCenter.y - fromCenter.y) * t;

      if (ch.moveProgress >= 1) {
        // Arrived at next tile
        ch.tileCol = nextTile.col;
        ch.tileRow = nextTile.row;
        ch.x = toCenter.x;
        ch.y = toCenter.y;
        ch.path.shift();
        ch.moveProgress = 0;
      }

      // If work resumed while walking to a coffee break, abandon the claim.
      if (ch.isActive && ch.stationId) {
        releaseStation(ch, stations);
      }

      // If became active while wandering, repath to seat
      if (ch.isActive && ch.seatId) {
        const seat = seats.get(ch.seatId);
        if (seat) {
          const lastStep = ch.path[ch.path.length - 1];
          if (!lastStep || lastStep.col !== seat.seatCol || lastStep.row !== seat.seatRow) {
            const newPath = findPath(
              ch.tileCol,
              ch.tileRow,
              seat.seatCol,
              seat.seatRow,
              tileMap,
              blockedTiles,
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
    case CharacterState.TYPE:
      return isReadingTool(ch.currentTool) ? Pose.READING : Pose.TYPING;
    case CharacterState.IDLE:
    default:
      // Standing at an interaction station (coffee machine, …) vs plain idle.
      return ch.stationId ? Pose.COFFEE : Pose.IDLE;
  }
}

/** Get the sprite frame for a character. Uses the synced pose when present
 *  (client), else derives it (server / fallback). */
export function getCharacterSprite(ch: Character, sprites: CharacterSprites): SpriteData {
  const pose = ch.pose ?? getCharacterPose(ch);
  return spriteForPose(pose, ch.dir, ch.frame, sprites);
}

/** Release the agent's interaction-station claim (idempotent). */
function releaseStation(ch: Character, stations: Map<string, InteractionPoint>): void {
  if (!ch.stationId) return;
  const station = stations.get(ch.stationId);
  if (station && station.occupantId === ch.id) station.occupantId = null;
  ch.stationId = null;
  ch.stationTimer = 0;
}

function randomRange(min: number, max: number): number {
  return min + Math.random() * (max - min);
}

function randomInt(min: number, max: number): number {
  return min + Math.floor(Math.random() * (max - min + 1));
}
