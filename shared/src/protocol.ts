/**
 * Protocol shared between server-side ingest (Claude transcript → events) and
 * the Colyseus room, plus appearance helpers and simulation tuning constants
 * the client needs to stay visually in sync with the authoritative server.
 */

export const WORLD_ROOM = 'world';

// ── Player avatar skins ───────────────────────────────────────────
// Each player owns a private, editable avatar (its own sprite data), distinct
// from the shared, deletable template gallery (`char_*`). Owned avatars use a
// `pa:` skin id so they're trivially separable: the gallery is every skin
// without this prefix; a player's renderable skin is `pa:<username>`.

export const PLAYER_AVATAR_SKIN_PREFIX = 'pa:';

/** Stable skin id for a user's owned avatar. */
export function playerAvatarSkinId(username: string): string {
  return PLAYER_AVATAR_SKIN_PREFIX + username;
}

/** Whether a skin id refers to a player-owned avatar (not a gallery template). */
export function isPlayerAvatarSkin(id: string): boolean {
  return id.startsWith(PLAYER_AVATAR_SKIN_PREFIX);
}

// ── Zones ─────────────────────────────────────────────────────────
// A zone is one explorable space (the office, later a plaza, a dungeon, …),
// hosted as its own Colyseus room instance of WORLD_ROOM (matchmade by `zone`).
// Each zone loads its own layout; assets are shared across zones for now.

export const DEFAULT_ZONE = 'office';

export interface ZoneConfig {
  id: string;
  label: string;
  /** Named layout to load for this zone. Absent → the room's active/default
   *  layout (keeps the office zone behaving exactly as before). */
  layoutName?: string;
  /** Where players arriving via a portal land (a walkable tile away from this
   *  zone's portal furniture, so they don't immediately re-trigger). */
  arrive?: { col: number; row: number };
  /** Initial blank-field size for generated zones (the read-only Default is
   *  regenerated from this; the active layout may be resized in the editor). */
  cols?: number;
  rows?: number;
  /** Protected zones can't be deleted (currently only the office). Hidden in the
   *  UI for now; the flag is here so it can be exposed/changed later. */
  readOnly?: boolean;
  /** Which NPC variants spawn here, as `"<kind>_<variant>"` keys (e.g. `cat_0`).
   *  Absent/null = all active variants (the office default); an array (possibly
   *  empty) = exactly those. New zones default to none. */
  npc?: string[] | null;
  /** True if the zone is password-protected (a hash is stored server-side). The
   *  actual password never leaves the server; clients only learn it's locked so
   *  they can prompt. */
  locked?: boolean;
}

/** Builtin zones, used to seed the persistent zone registry on first run. After
 *  that zones are user-managed (created/edited/deleted at runtime); the office is
 *  read-only so it can never be deleted. Portals are placed furniture (catalog
 *  `portal` flag) — walking up to one offers a picker of the other zones. */
export const ZONES: Record<string, ZoneConfig> = {
  office: { id: 'office', label: 'Office', arrive: { col: 9, row: 11 }, readOnly: true },
  plaza: { id: 'plaza', label: 'Plaza', arrive: { col: 10, row: 7 }, cols: 20, rows: 14, npc: [] },
};

/** Resolve a zone id to its config, falling back to the default zone. */
export function resolveZone(id: string | undefined): ZoneConfig {
  return (id && ZONES[id]) || ZONES[DEFAULT_ZONE];
}

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
  // 'waiting' = the turn genuinely finished (shows the done bubble + chime);
  // 'idle' = went quiet via the inactivity timeout (goes inactive silently, no
  // "done" notification — avoids chiming on every mid-task thinking pause).
  | { t: 'status'; id: number; status: 'active' | 'waiting' | 'idle' }
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

/** Max length for user-entered names (furniture/monitor, characters, zones,
 *  layouts, …). Login/agent identity names keep their own 16-char convention. */
export const MAX_NAME_LEN = 32;

/** Normalise a user-entered name: collapse runs of whitespace to one space, trim
 *  the ends, and cap at `max` chars. Use everywhere names are accepted. */
export function cleanName(input: unknown, max: number = MAX_NAME_LEN): string {
  return (typeof input === 'string' ? input : '').replace(/\s+/g, ' ').trim().slice(0, max);
}

/** Stable identity of a conference monitor's call: its name (slugged) when set —
 *  so the room survives the monitor being moved — else its tile position. Shared
 *  by client + server so both agree on the key. */
export function conferenceKey(name: string | undefined, col: number, row: number): string {
  const slug = (name ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32);
  return slug ? `n:${slug}` : `p:${col},${row}`;
}

/** Human-readable label for a conference monitor (its name, else its position). */
export function conferenceLabel(name: string | undefined, col: number, row: number): string {
  return (name ?? '').trim() || `Monitor (${col}, ${row})`;
}

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
