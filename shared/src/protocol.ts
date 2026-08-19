/**
 * Protocol shared between server-side ingest (Claude transcript → events) and
 * the Colyseus room, plus appearance helpers and simulation tuning constants
 * the client needs to stay visually in sync with the authoritative server.
 */

export const WORLD_ROOM = 'world';

/**
 * Wire-compatibility number. Bump it in the same change as anything that makes an
 * older client decode this server wrongly: adding, removing or REORDERING a synced
 * schema field, or changing what a message means.
 *
 * Why a number and not the build version: the displayed version (`git describe`)
 * differs after every commit, so gating on it would cry wolf in development and
 * teach everyone to ignore the panel. This changes only when compatibility does.
 *
 * 2 — CharacterSync.hueShift removed, which shifted the 17 fields after it.
 */
export const PROTOCOL_VERSION = 2;

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

/** The zone a client lands in when it names none, and the one zone the registry
 *  guarantees exists (see zoneStore.seed) and refuses to delete — there has to be
 *  somewhere to arrive. Was 'office' while that zone existed; it is a plain id, so
 *  moving it is a one-line change plus a pushed map for the new one. */
export const DEFAULT_ZONE = 'uponu';

/**
 * A zone as the registry stores it (see server/src/zoneStore.ts) — id, label and
 * the settings that are NOT part of its map. There is no builtin table of these
 * any more: a zone exists because someone pushed a map for it, and this shape is
 * what the DB row deserializes to.
 */
export interface ZoneConfig {
  id: string;
  label: string;
  /** Where players arriving via a portal land (a walkable tile away from this
   *  zone's portal furniture, so they don't immediately re-trigger). */
  arrive?: { col: number; row: number };
  /** Size the zone renders at while it has no pushed map yet (see emptyZoneMap).
   *  Once a map arrives, the map's own size is what counts. */
  cols?: number;
  rows?: number;
  /** Which NPC variants spawn here, as `"<kind>_<variant>"` keys (e.g. `cat_0`).
   *  Absent/null = all active variants (the office default); an array (possibly
   *  empty) = exactly those. New zones default to none. */
  npc?: string[] | null;
  /** True if the zone is password-protected (a hash is stored server-side). The
   *  actual password never leaves the server; clients only learn it's locked so
   *  they can prompt. */
  locked?: boolean;
  /** The user who created this zone (owns its privacy/ACL/invite controls) —
   *  absent for builtin zones and zones whose owner's account was later
   *  deleted (the zone stays, just ownerless — see zoneStore.ts). */
  ownerId?: string;
  /** Private zones stay visible in the zone list (so the name isn't a secret)
   *  but reject entry for anyone but the owner, its zone-admins, an ACL
   *  member, or a global admin. */
  private?: boolean;
}

// No builtin zone table: zones live only in the registry (server/src/zoneStore.ts)
// and come into being by pushing a map for a new id. What used to be here — an
// office with a bundled read-only layout and a code-generated plaza — was the last
// place content was defined outside Tiled. DEFAULT_ZONE above is all that survives
// of it: the id a client lands in when it asks for no zone in particular.

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
  const cut = (typeof input === 'string' ? input : '').replace(/\s+/g, ' ').trim().slice(0, max);
  // `slice` counts UTF-16 code units, so a cap landing inside a surrogate pair
  // (any emoji, and plenty of CJK extensions) would leave a lone surrogate —
  // which is not valid UTF-8 and serialises as a replacement character. Drop the
  // orphan rather than emit half a character.
  const last = cut.charCodeAt(cut.length - 1);
  return last >= 0xd800 && last <= 0xdbff ? cut.slice(0, -1) : cut;
}

/** Max length for a placed free-text label (OfficeLayout.texts) — a label/
 *  short sentence, not an essay. Shared so the client's editor prompt and the
 *  server's save-time sanitization agree. */
export const MAX_TEXT_LABEL_LEN = 48;

/** Max number of free-text labels one layout may have — a generous but
 *  bounded cap against an unbounded editor-side loop or a malformed save. */
export const MAX_TEXT_LABELS = 200;

/** Max number of placed background images (OfficeLayout.images) one layout
 *  may have — same purpose as MAX_TEXT_LABELS. */
export const MAX_PLACED_IMAGES = 100;

/** Max footprint (tiles, either axis) one placed image may have — a generous
 *  but bounded cap against a malformed save, not a design constraint: a
 *  banner/logo spanning most of a large room's width is a completely normal
 *  Tiled placement (confirmed against a live map whose logo was 27 tiles
 *  wide), well past what the old in-game Image tool's own UI ever produced. */
export const MAX_IMAGE_FOOTPRINT_TILES = 128;

/** Default/min/max font size (px) for a placed free-text label. */
export const TEXT_LABEL_DEFAULT_FONT_SIZE = 8;
export const TEXT_LABEL_MIN_FONT_SIZE = 6;
export const TEXT_LABEL_MAX_FONT_SIZE = 32;

/** Clamp a user-entered font size to the valid range, falling back to the
 *  default for anything non-numeric. */
export function clampTextLabelFontSize(input: unknown): number {
  const n = typeof input === 'number' ? input : Number(input);
  if (!Number.isFinite(n)) return TEXT_LABEL_DEFAULT_FONT_SIZE;
  return Math.min(TEXT_LABEL_MAX_FONT_SIZE, Math.max(TEXT_LABEL_MIN_FONT_SIZE, Math.round(n)));
}

/** Font-family choices for a placed free-text label — a closed set (not free
 *  text) so the client's picker and the server's save-time sanitization
 *  agree. Only one CUSTOM font is actually bundled today ('FS Pixel Sans',
 *  the game's pixel font); the rest are browser-generic families — real,
 *  always-available variety rather than a picker with just one option.
 *  Adding another *custom* font later means shipping its font file/@font-face
 *  and adding one more entry here, nothing else changes. */
export const TEXT_LABEL_FONT_CHOICES: Array<{ label: string; value: string }> = [
  { label: 'Pixel (default)', value: "'FS Pixel Sans', monospace" },
  { label: 'Monospace', value: 'monospace' },
  { label: 'Sans-serif', value: 'sans-serif' },
  { label: 'Serif', value: 'serif' },
];
export const TEXT_LABEL_DEFAULT_FONT_FAMILY = TEXT_LABEL_FONT_CHOICES[0].value;

/** Validate a saved fontFamily against the closed set above — anything else
 *  (including the default itself, kept unset to match fontSize's own
 *  unset-means-default convention) resolves to undefined. */
export function sanitizeTextLabelFontFamily(input: unknown): string | undefined {
  if (typeof input !== 'string') return undefined;
  const known = TEXT_LABEL_FONT_CHOICES.find((c) => c.value === input);
  return known && known.value !== TEXT_LABEL_DEFAULT_FONT_FAMILY ? known.value : undefined;
}

/** Stable identity of a conference monitor's call: its name (slugged) when set —
 *  so the room survives the monitor being moved — else its tile position. Shared
 *  by client + server so both agree on the key. */
/** A room name reduced to its identity: lowercase, punctuation collapsed to dashes,
 *  capped. Empty when the name says nothing. Shared by conference monitors and meeting
 *  AREAS so "Standup" means the same room in both — two spellings that differ only in
 *  case or spacing must not become two calls. */
export function meetingSlug(name: string | undefined): string {
  return (name ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32);
}

export function conferenceKey(name: string | undefined, col: number, row: number): string {
  const slug = meetingSlug(name);
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

