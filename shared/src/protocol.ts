/**
 * Protocol shared between server-side ingest (Claude transcript → events) and
 * the Colyseus room, plus appearance helpers and simulation tuning constants
 * the client needs to stay visually in sync with the authoritative server.
 */

export const WORLD_ROOM = 'world';

// ── Simulation tuning (ported from the original engine constants) ─

export const SIM = {
  /** Server simulation tick rate. */
  TICK_HZ: 20,
  /** Character walk speed. */
  WALK_SPEED_PX_PER_SEC: 48,
  /** Sub-agents are spawned with negative ids starting here. */
  SUBAGENT_ID_BASE: -1,

  // Idle / wander behaviour
  WANDER_PAUSE_MIN_SEC: 2,
  WANDER_PAUSE_MAX_SEC: 12,
  WANDER_MOVES_MIN: 2,
  WANDER_MOVES_MAX: 5,
  SEAT_REST_MIN_SEC: 30,
  SEAT_REST_MAX_SEC: 90,

  // Effects / bubbles
  SPAWN_EFFECT_SEC: 0.3,
  DESPAWN_EFFECT_SEC: 0.3,
  WAITING_BUBBLE_SEC: 2,
} as const;

// ── Client-side animation timing (matches original) ───────────────

export const ANIM = {
  WALK_FRAME_SEC: 0.15,
  WALK_FRAMES: 6, // MetroCity: 6 frames per direction
  TYPE_FRAME_SEC: 0.3,
} as const;

/** Context budget for the token fuel gauge. */
export const MAX_CONTEXT_TOKENS = 200_000;

// ── Ingest → room events ──────────────────────────────────────────

export type AgentEvent =
  | { t: 'created'; id: number; label?: string; isExternal?: boolean }
  | { t: 'removed'; id: number }
  | { t: 'status'; id: number; status: 'active' | 'waiting' }
  | { t: 'toolStart'; id: number; toolId: string; status: string; toolName?: string }
  | { t: 'toolDone'; id: number; toolId: string }
  | { t: 'toolsClear'; id: number }
  | { t: 'permission'; id: number }
  | { t: 'permissionClear'; id: number }
  | { t: 'subagentStart'; id: number; parentToolId: string; toolId: string; status: string }
  | { t: 'subagentDone'; id: number; parentToolId: string; toolId: string }
  | { t: 'subagentClear'; id: number; parentToolId: string }
  | {
      t: 'team';
      id: number;
      teamName?: string;
      agentName?: string;
      isTeamLead?: boolean;
      leadAgentId?: number;
    }
  | { t: 'tokens'; id: number; inputTokens: number; outputTokens: number };

// ── Appearance ────────────────────────────────────────────────────

/** The four Modern Interiors (free) characters, by index. */
export const CHARACTERS = ['adam', 'alex', 'amelia', 'bob'] as const;

/** Cheap deterministic string hash (FNV-1a). */
export function hashString(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Deterministically pick one of the four characters from a stable key. */
export function pickCharacter(key: string): number {
  return hashString(key) % CHARACTERS.length;
}
