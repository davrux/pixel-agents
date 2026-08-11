import { Room, type AuthContext, type Client } from '@colyseus/core';
import { voiceRoomName, mintVoiceToken } from '../voice/livekit.js';

import {
  resolveZone,
  conferenceKey,
  cleanName,
  playerAvatarSkinId,
  findCommand,
  mayRunCommand,
  KICK_CLOSE_CODE,
  DEFAULT_ZONE,
  MAX_TEXT_LABEL_LEN,
  MAX_TEXT_LABELS,
  MAX_PLACED_IMAGES,
  MAX_IMAGE_ASSET_BYTES,
  TEXT_LABEL_DEFAULT_FONT_SIZE,
  clampTextLabelFontSize,
  sanitizeTextLabelFontFamily,
  type CommandSpec,
} from '@pixel/shared';
import type { AgentEvent, ZoneConfig } from '@pixel/shared';
import type { LoadedCharacterData } from '@pixel/shared/office/sprites/spriteData.js';
import { CharacterSync, EntitySync, FurnitureSync, PetSync, RoomState } from '@pixel/shared/schema';
import { OfficeState, getCharacterPose, isReadingTool } from '@pixel/shared/office/engine/index.js';
import { PET_DRINK_CHANCE, PET_SIT_CHANCE, PET_TALK_CHANCE } from '@pixel/shared/office/constants.js';
import { Direction, PetKind, type Action } from '@pixel/shared/office/types.js';
import { setProviderCapabilities } from '@pixel/shared/office/toolUtils.js';
import { setCharacterTemplates, setPetTemplates } from '@pixel/shared/office/sprites/spriteData.js';
import { buildDynamicCatalog, effectiveAction, getCatalogEntry, FURNITURE_CATEGORIES } from '@pixel/shared/office/layout/furnitureCatalog.js';
import { registerArcadeSaves } from '../arcadeSaveRoom.js';
import { registerArcadeLobby } from '../arcadeLobby.js';
import {
  createBlankZoneLayout,
  createPlazaLayout,
  migrateLayoutColors,
} from '@pixel/shared/office/layout/layoutSerializer.js';
import type { OfficeLayout } from '@pixel/shared/office/types.js';

import { READING_TOOLS, SUBAGENT_TOOL_NAMES } from '../constants.js';
import { director, type AgentInfo } from '../sim/director.js';
import { applyEvent } from '../sim/applyEvent.js';
import { LayoutStore } from '../layoutStore.js';
import { ZoneStore } from '../zoneStore.js';
import { appStore } from '../appStore.js';
import {
  ASSET_TYPES,
  getMergedBundle,
  invalidateMergedBundle,
  messageTypeForAsset,
  type AssetType,
} from '../assetOverrides.js';
import { hasValidSession, userIdFromCookie, hasValidBearerSession, userIdFromBearer } from '../auth.js';
import { userStore, UserStore, isValidPassword, normalizeLoginId, MAX_PASSWORD_LEN, type Role, type User } from '../userStore.js';
import { can, type Capability } from '../permissions.js';
import { presence } from '../presence.js';
import { timeTracking } from '../timetracking/service.js';
import { zoneInvites } from '../zoneInvites.js';
import {
  controlBus,
  KICK_EVENT,
  ZONE_INVITE_EVENT,
  ZONE_INVITE_RESULT_EVENT,
  ZONE_DELETED_EVENT,
  ASSET_CHANGED_EVENT,
} from '../controlBus.js';
import { runAccountCommand } from './accountCommands.js';
import { isThrottled, noteFail, clearFails } from '../throttle.js';
import { meetingRoomStore, MAX_ACTIVE_ROOMS_PER_OWNER, MIN_MEETING_ROOM_PASSWORD_LEN } from '../meetingRoomStore.js';
import { NpcBrain } from '../npc/npcBrain.js';
import type { AssetBundle } from '../assets.js';

const TICK_HZ = 20;

/**
 * Authoritative office room: the original OfficeState simulation runs here, in
 * the server's tick loop. Claude ingest events mutate it; every tick we write
 * the render-state into the Colyseus schema, so all viewers see one identical
 * world. Clients are pure renderers.
 */
/** Copy the shared entity transform (position + facing + coarse state) onto a
 *  synced EntitySync. Each kind's sync loop then sets its own fields on top. */
function writeEntityTransform(
  sync: EntitySync,
  e: { x: number; y: number; dir: number; state: string },
): void {
  sync.x = e.x;
  sync.y = e.y;
  sync.dir = e.dir;
  sync.state = e.state;
}

/** Deep copy of a skin's sprite data (plain arrays/strings), so an avatar and
 *  the template it was seeded from stay fully independent. */
function cloneCharacterData(data: LoadedCharacterData): LoadedCharacterData {
  return JSON.parse(JSON.stringify(data)) as LoadedCharacterData;
}

/** Per-connection identity resolved in onAuth: stable `userId` (the key for all
 *  per-user state), `username` (free display name), and `isAdmin`. */
interface AuthInfo {
  userId: string;
  username: string;
  isAdmin: boolean;
  role: Role;
}

function authOf(client: Client): AuthInfo {
  const a = client.auth as Partial<AuthInfo> | undefined;
  return {
    userId: a?.userId ?? '',
    username: a?.username ?? '',
    isAdmin: !!a?.isAdmin,
    role: a?.role ?? (a?.isAdmin ? 'admin' : 'user'),
  };
}

/** Cap a saved layout's free-text labels (OfficeLayout.texts) to a sane
 *  length/count before it's persisted — the only content check on a saved
 *  layout blob (furniture/tiles have none either; this mirrors the client's
 *  own cap, see LayoutEditor's Text tool, in case a client is patched or
 *  malicious). Mutates and returns the same object; other fields pass through
 *  untouched. */
function sanitizeLayoutTexts(layout: Record<string, unknown>): Record<string, unknown> {
  const texts = layout.texts;
  if (!Array.isArray(texts)) return layout;
  const clean: Array<{ uid: string; col: number; row: number; text: string; fontSize?: number; fontFamily?: string; angle?: number }> = [];
  for (const t of texts) {
    if (clean.length >= MAX_TEXT_LABELS) break;
    if (!t || typeof t !== 'object') continue;
    const rec = t as Record<string, unknown>;
    if (typeof rec.uid !== 'string' || typeof rec.col !== 'number' || typeof rec.row !== 'number') continue;
    const text = cleanName(rec.text, MAX_TEXT_LABEL_LEN);
    if (!text) continue;
    const entry: { uid: string; col: number; row: number; text: string; fontSize?: number; fontFamily?: string; angle?: number } = {
      uid: rec.uid,
      col: rec.col,
      row: rec.row,
      text,
    };
    if (rec.fontSize !== undefined) {
      const size = clampTextLabelFontSize(rec.fontSize);
      if (size !== TEXT_LABEL_DEFAULT_FONT_SIZE) entry.fontSize = size;
    }
    const fontFamily = sanitizeTextLabelFontFamily(rec.fontFamily);
    if (fontFamily) entry.fontFamily = fontFamily;
    if (typeof rec.angle === 'number' && Number.isFinite(rec.angle)) {
      const angle = ((rec.angle % 360) + 360) % 360;
      if (angle !== 0) entry.angle = angle;
    }
    clean.push(entry);
  }
  layout.texts = clean;
  return layout;
}

/** Cap a saved layout's placed background images (OfficeLayout.images) — same
 *  kind of save-time content check as sanitizeLayoutTexts. Doesn't check that
 *  imageId references an existing uploaded image (same as furniture types
 *  aren't checked against the catalog here either) — the renderer already
 *  has to tolerate a missing reference (a deleted image, a stale layout). */
function sanitizeLayoutImages(layout: Record<string, unknown>): Record<string, unknown> {
  const images = layout.images;
  if (!Array.isArray(images)) return layout;
  const clean: Array<{ uid: string; col: number; row: number; footprintW: number; footprintH: number; imageId: string; fit?: 'stretch' | 'center' }> = [];
  for (const img of images) {
    if (clean.length >= MAX_PLACED_IMAGES) break;
    if (!img || typeof img !== 'object') continue;
    const rec = img as Record<string, unknown>;
    if (typeof rec.uid !== 'string' || typeof rec.col !== 'number' || typeof rec.row !== 'number') continue;
    if (typeof rec.imageId !== 'string' || !rec.imageId) continue;
    const fw = Number(rec.footprintW);
    const fh = Number(rec.footprintH);
    if (!Number.isInteger(fw) || !Number.isInteger(fh) || fw < 1 || fh < 1 || fw > 16 || fh > 16) continue;
    const entry: (typeof clean)[number] = { uid: rec.uid, col: rec.col, row: rec.row, footprintW: fw, footprintH: fh, imageId: rec.imageId };
    if (rec.fit === 'center') entry.fit = 'center';
    clean.push(entry);
  }
  layout.images = clean;
  return layout;
}

const MAX_IFRAME_URL_LEN = 500;

/** Parse+validate one Action (from an untrusted save payload) — https://
 *  only for iframe, closed sets of literal kinds elsewhere. Returns null for
 *  anything malformed (dropped, not defaulted). */
function sanitizeAction(raw: unknown): Action | null {
  if (!raw || typeof raw !== 'object') return null;
  const rec = raw as Record<string, unknown>;
  switch (rec.kind) {
    case 'meetingRoom':
      return { kind: 'meetingRoom', video: rec.video !== false };
    case 'linkManager':
      return { kind: 'linkManager' };
    case 'iframe': {
      const url = typeof rec.url === 'string' ? rec.url.trim().slice(0, MAX_IFRAME_URL_LEN) : '';
      return url.startsWith('https://') ? { kind: 'iframe', url } : null;
    }
    case 'appliance':
      return rec.pose === 'coffee' ? { kind: 'appliance', pose: 'coffee' } : null;
    case 'arcade':
      return { kind: 'arcade' };
    case 'timeClock':
      return { kind: 'timeClock' };
    case 'toggle':
      return { kind: 'toggle' };
    default:
      return null;
  }
}

/** Validate/clamp a saved layout's tile actions (OfficeLayout.tileActions)
 *  and any per-instance furniture action overrides — the same kind of
 *  save-time content check as sanitizeLayoutTexts, for the same reason
 *  (furniture/tiles otherwise have none; this mirrors the client's own
 *  Action-tool validation in case a client is patched or malicious).
 *  Mutates and returns the same object; other fields pass through untouched. */
function sanitizeLayoutActions(layout: Record<string, unknown>): Record<string, unknown> {
  const cols = typeof layout.cols === 'number' ? layout.cols : 0;
  const rows = typeof layout.rows === 'number' ? layout.rows : 0;
  const tileActions = layout.tileActions;
  if (Array.isArray(tileActions)) {
    const total = cols * rows;
    const clean: Array<Action | null> = new Array(total).fill(null);
    for (let i = 0; i < Math.min(total, tileActions.length); i++) clean[i] = sanitizeAction(tileActions[i]);
    layout.tileActions = clean;
  }
  const furniture = layout.furniture;
  if (Array.isArray(furniture)) {
    const SIDES = new Set(['N', 'S', 'E', 'W']);
    for (const item of furniture) {
      if (!item || typeof item !== 'object') continue;
      const rec = item as Record<string, unknown>;
      if (rec.action !== undefined) {
        const action = sanitizeAction(rec.action);
        if (action) rec.action = action;
        else delete rec.action;
      }
      if (rec.approachSides !== undefined) {
        const sides = Array.isArray(rec.approachSides)
          ? [...new Set(rec.approachSides.filter((s): s is string => typeof s === 'string' && SIDES.has(s)))]
          : [];
        if (sides.length > 0) rec.approachSides = sides;
        else delete rec.approachSides;
      }
    }
  }
  return layout;
}

export class SimRoom extends Room<{ state: RoomState }> {
  /** File defaults merged with DB asset overrides — the process-wide cached
   *  bundle from assetOverrides.ts, not recomputed per room (see getMergedBundle). */
  private bundle!: AssetBundle;
  private os!: OfficeState;
  private store!: LayoutStore;
  private zones!: ZoneStore;
  private zone!: ZoneConfig;
  /** Player avatar id per connected client session. */
  private readonly players = new Map<string, number>();
  /** Owning account per player avatar id — the reverse of `players`, kept so the
   *  sync pass can look up per-user external state (TimeTracking status) without
   *  walking every client each tick. */
  private readonly playerUserIds = new Map<number, string>();
  /** Arcade IPX-multiplayer lobby (drops leavers from matches on disconnect). */
  private arcadeLobby?: { onLeave: (sessionId: string) => void };
  /** Owned-avatar sprite data currently needed in THIS zone (skin id → data),
   *  distributed only to clients here so a client loads just the avatars of
   *  players standing in its zone. Refcounted by concurrent sessions. */
  private readonly avatarData = new Map<string, LoadedCharacterData>();
  private readonly avatarRefs = new Map<string, number>();
  /** Recent zone-local chat (ring buffer), sent to joiners; + per-session rate limit. */
  private readonly chatLog: Array<{ from: string; text: string; at: number }> = [];
  private readonly lastChatAt = new Map<string, number>();
  /** Per-session rate limit for voice-chat announcements (join/mute/deafen). */
  private readonly lastVoiceEventAt = new Map<string, number>();
  /** Meeting-room membership (Action's 'meetingRoom' kind) — a
   *  "furniture:col,row" or "tile:col,row" key (disambiguates a furniture
   *  item's own anchor tile from a tile-action area's flood-fill anchor, in
   *  case they ever coincide — see meetingRoomKey) → set of player avatar
   *  ids. Furniture-sourced membership is explicit (click join/leave, via
   *  actionApproach/meetingRoomLeave); tile-sourced membership is automatic
   *  (walk in/out), maintained every tick by updateMeetingRoomMembership,
   *  called from syncCharacters. */
  private readonly meetingRooms = new Map<string, Set<number>>();
  /** Each player's current tile-sourced meeting-room key (a subset of the
   *  map above's keys — furniture-sourced membership doesn't use this), or
   *  absent — so updateMeetingRoomMembership can detect enter/exit without
   *  re-deriving "was I in one before" from the sets themselves. */
  private readonly lastMeetingRoomArea = new Map<number, string>();
  /** Per-deployment prefix for LiveKit room names (env override, else a stable
   *  random id from the DB) so dev + prod never share a voice room. */
  private readonly voiceNs = process.env.PIXEL_VOICE_PREFIX?.trim() || appStore.getVoiceNs();
  /** Whether login is enforced (an admin token is configured). When false the
   *  room runs in open dev mode with an anonymous viewer. */
  private authRequired = false;
  /** Server version (git describe / release file), surfaced to the client's
   *  connection status indicator. */
  private version = '';
  private readonly activity = new Map<number, string>();
  private lastFurnitureRef: unknown = null;
  /** Server-only NPC behaviour tree (decides pet activity; not in client bundle). */
  private readonly npcBrain = new NpcBrain();

  /** Agents currently materialised in this room → their owner (label). An agent
   *  lives only in the zone its owner is viewing, so it follows them on a switch. */
  private readonly hostedAgents = new Map<number, string>();

  /** True if this room is the zone that currently hosts `owner`'s agents. */
  private hostsOwner(owner: string): boolean {
    return director.zoneForOwner(owner) === this.zone.id;
  }

  /** Relay an ingest event, but only for agents this zone hosts: 'created' is
   *  taken on iff we host its owner; everything else passes only for already-
   *  hosted agents. Keeps each agent in exactly one zone (its owner's). */
  private readonly onEvent = (ev: AgentEvent): void => {
    if (ev.t === 'created') {
      const owner = ev.label ?? '';
      if (!this.hostsOwner(owner)) return;
      this.hostedAgents.set(ev.id, owner);
      applyEvent(this.os, ev, this.activity);
      return;
    }
    if (!this.hostedAgents.has(ev.id)) return;
    applyEvent(this.os, ev, this.activity);
    if (ev.t === 'removed') this.hostedAgents.delete(ev.id);
  };

  /** Hand an owner's agents over when they switch zones: the room they left
   *  drops them, the room they entered seeds them from the registry. */
  private readonly onReroute = (owner: string): void => {
    const mine = this.hostsOwner(owner);
    if (!mine) {
      for (const [id, o] of [...this.hostedAgents]) {
        if (o === owner) {
          this.hostedAgents.delete(id);
          applyEvent(this.os, { t: 'removed', id }, this.activity);
        }
      }
      return;
    }
    for (const a of director.snapshot()) {
      if (a.label === owner && !this.hostedAgents.has(a.id)) {
        this.hostedAgents.set(a.id, a.label);
        this.seedAgent(a);
      }
    }
  };

  /** Disconnect the target user's client(s) in this room (admin /kick). The
   *  custom close code tells the client not to auto-reconnect. */
  private readonly onKick = (userId: string): void => {
    for (const c of this.clients) {
      if (authOf(c).userId === userId) c.leave(KICK_CLOSE_CODE, 'kicked');
    }
  };

  /** Deliver a zone invite to its target, wherever they are — mirrors onKick's
   *  cross-room reach via controlBus (a no-op in every room but the one that
   *  actually holds the target's client). */
  private readonly onZoneInvite = (p: {
    targetUserId: string;
    fromUserId: string;
    fromName: string;
    zoneId: string;
    zoneLabel: string;
  }): void => {
    for (const c of this.clients) {
      if (authOf(c).userId === p.targetUserId) {
        c.send('m', {
          type: 'zoneInvitePrompt',
          fromUserId: p.fromUserId,
          fromName: p.fromName,
          zoneId: p.zoneId,
          zoneLabel: p.zoneLabel,
        });
      }
    }
  };

  /** Tell the inviter whether their invite was accepted/declined, wherever THEY
   *  are now (they may have moved to yet another zone since sending it). */
  private readonly onZoneInviteResult = (p: { toUserId: string | null; accepted: boolean; byName: string; zoneLabel: string }): void => {
    if (!p.toUserId) return;
    for (const c of this.clients) {
      if (authOf(c).userId === p.toUserId) {
        c.send('m', { type: 'zoneInviteResult', accepted: p.accepted, byName: p.byName, zoneLabel: p.zoneLabel });
      }
    }
  };

  /** Display name for a zone-ACL member id, falling back to the raw id if the
   *  account was since deleted (ACL rows for a deleted user are cleared, but
   *  this stays defensive). */
  private zoneMemberName(userId: string): string {
    return userStore.get(userId)?.username || userId;
  }

  /** Same, plus whether they're a global admin — so the client can badge them
   *  (a global admin always has access regardless of the ACL). */
  private zoneMemberView(userId: string): { userId: string; name: string; isAdmin: boolean } {
    return { userId, name: this.zoneMemberName(userId), isAdmin: !!userStore.get(userId)?.isAdmin };
  }

  /** A shared asset (character/pet/floor/wall/furniture) was saved or reset —
   *  possibly from a different zone's room. Assets are global, so every live
   *  room re-merges its own catalog + re-applies, not just the one the edit
   *  happened in (otherwise every OTHER already-running zone keeps serving
   *  its stale in-memory bundle indefinitely, until it empties out and the
   *  room recycles). */
  private readonly onAssetChanged = (type: AssetType): void => {
    this.reapplyAsset(type);
  };

  /** A zone was deleted (possibly from a client sitting in a completely
   *  different zone) — if it was THIS room's zone, everyone standing in it
   *  has nowhere left to be; reroute them all to the office via the same
   *  'zoneTransition' message a portal walk-in already sends (no new client
   *  handling needed). The now-empty room then auto-disposes as usual. */
  private readonly onZoneDeleted = (deletedZoneId: string): void => {
    if (this.zone.id !== deletedZoneId) return;
    this.broadcast('m', { type: 'zoneTransition', zone: DEFAULT_ZONE });
  };

  /** Replay the full current state of one registry agent into this room (used
   *  both when seeding a freshly-created room and when an owner switches in).
   *  Status 'waiting' is left implicit so seeding never fires a "done" chime. */
  private seedAgent(a: AgentInfo): void {
    applyEvent(this.os, { t: 'created', id: a.id, label: a.label }, this.activity);
    if (a.teamName || a.agentName || a.isTeamLead || a.leadId !== null) {
      applyEvent(
        this.os,
        { t: 'team', id: a.id, teamName: a.teamName, agentName: a.agentName, isTeamLead: a.isTeamLead, leadAgentId: a.leadId ?? undefined },
        this.activity,
      );
    }
    for (const [toolId, t] of a.activeTools) {
      applyEvent(this.os, { t: 'toolStart', id: a.id, toolId, status: t.status, toolName: t.toolName }, this.activity);
    }
    if (a.status === 'active') applyEvent(this.os, { t: 'status', id: a.id, status: 'active' }, this.activity);
    if (a.permission) applyEvent(this.os, { t: 'permission', id: a.id }, this.activity);
    if (a.inputTokens || a.outputTokens) {
      applyEvent(this.os, { t: 'tokens', id: a.id, inputTokens: a.inputTokens, outputTokens: a.outputTokens }, this.activity);
    }
  }

  /** Gate joins when login is enforced; resolve the viewer to {userId (identity
   *  key), username (display name), isAdmin}. Open dev mode (no admin token)
   *  yields an anonymous viewer. The cookie session (browser) is evaluated first
   *  and is unchanged; a valid `context.token` bearer session (desktop, carried
   *  by Colyseus from `Authorization: Bearer`) is an additive, equivalent path
   *  resolved through the SAME session store + identity resolution as the cookie. */
  onAuth(_client: Client, options: unknown, context: AuthContext): AuthInfo {
    if (!this.authRequired) return { userId: '', username: '', isAdmin: false, role: 'user' };
    // Colyseus 0.17 exposes a WHATWG `Headers` here (0.16 handed over a plain
    // object), so the cookie is read via .get() — which yields null, not
    // undefined, when absent.
    const cookie = context?.headers?.get('cookie') ?? undefined;
    // NB: only the zone password is read from client options. Identity and role
    // are resolved server-side (client is untrusted).
    const opts = (options ?? {}) as { zonePassword?: string };
    if (hasValidSession(cookie)) {
      const userId = userIdFromCookie(cookie) ?? '';
      const user = userId ? userStore.get(userId) : undefined;
      if (!user) throw new Error('unauthorized');
      return this.gateEntry(user, opts);
    }
    // Colyseus strips the `Bearer ` prefix into `context.token`; rebuild the
    // header form so the bearer helpers (same session store/TTL as the cookie)
    // resolve identically to the cookie path above.
    const authHeader = context?.token ? `Bearer ${context.token}` : undefined;
    if (hasValidBearerSession(authHeader)) {
      const userId = userIdFromBearer(authHeader) ?? '';
      const user = userId ? userStore.get(userId) : undefined;
      if (!user) throw new Error('unauthorized');
      return this.gateEntry(user, opts);
    }
    throw new Error('unauthorized');
  }

  /** Room-entry policy on top of a valid session. A private zone rejects anyone
   *  but the owner/zone-admins/ACL/global-admins, throwing 'forbidden' (no
   *  password can get you in — see zoneStore.ts canEnterPrivateZone). A
   *  password-locked zone requires the password (admins and the zone's admins
   *  bypass it), throwing 'zone-locked' so the client can prompt for it. */
  private gateEntry(user: User, opts: { zonePassword?: string }): AuthInfo {
    const zoneId = this.zone.id;
    const isZoneAdmin = this.zones.isZoneAdmin(zoneId, user.userId);
    // Private zones reject anyone but the owner, its zone-admins, an ACL
    // member, or a global admin — an identity-based gate, checked before the
    // password (a private zone doesn't need one; this is the stronger lock).
    if (!user.isAdmin && !this.zones.canEnterPrivateZone(zoneId, user.userId)) {
      throw new Error('forbidden');
    }
    if (this.zones.zoneHasPassword(zoneId) && !user.isAdmin && !isZoneAdmin) {
      // Throttle wrong guesses (each does a full scrypt) to bound brute-force + CPU-DoS.
      const tkey = `zone:${zoneId}:${user.userId}`;
      if (isThrottled(tkey)) throw new Error('zone-locked');
      if (!opts.zonePassword || !this.zones.checkZonePassword(zoneId, opts.zonePassword)) {
        noteFail(tkey);
        throw new Error('zone-locked');
      }
      clearFails(tkey);
    }
    return { userId: user.userId, username: UserStore.displayName(user), isAdmin: user.isAdmin, role: user.role };
  }

  onCreate(options: { authRequired?: boolean; zone?: string; version?: string }): void {
    this.bundle = getMergedBundle(); // file defaults + DB asset overrides (process-wide cache)
    this.authRequired = options.authRequired ?? false;
    this.version = options.version ?? '';
    // Resolve which space this room hosts from the persistent registry (user
    // zones included); fall back to the builtin config for safety.
    this.zones = new ZoneStore();
    this.zone = (options.zone && this.zones.get(options.zone)) || resolveZone(options.zone);
    this.setState(new RoomState());
    // Dispose the room when the last client leaves (Colyseus default; VoxelRoom does
    // the same). Frees this zone's per-room heap — the merged asset bundle, OfficeState,
    // SQLite handles (onDispose closes them) and director listeners — instead of keeping
    // one live copy per zone ever visited. Agents re-seed from director.snapshot() when a
    // viewer reopens the zone, so nothing is lost. (autoDispose defaults to true; set it
    // explicitly to document the intent.)
    this.autoDispose = true;
    registerArcadeSaves(this); // shared arcade-savegame handlers (same store as the voxel world)
    this.arcadeLobby = registerArcadeLobby(this); // shared arcade IPX-multiplayer lobby

    // Initialise the office engine from the decoded assets (templates + catalog
    // give it palette counts, seats, and furniture auto-on metadata).
    setProviderCapabilities({ readingTools: READING_TOOLS, subagentToolNames: SUBAGENT_TOOL_NAMES });
    setCharacterTemplates(this.bundle.raw.characters as never);
    setPetTemplates(this.bundle.raw.dogs as never, this.bundle.raw.cats as never, this.bundle.raw.ducks as never);
    buildDynamicCatalog({
      catalog: this.bundle.raw.furnitureCatalog as never,
      sprites: this.bundle.raw.furnitureSprites as never,
    });

    // The active layout (persisted per zone, falling back to the zone's builtin
    // default). The office Default is the bundled layout; generated zones (plaza)
    // register their builtin as their read-only Default below.
    this.store = new LayoutStore((this.bundle.raw.layout as Record<string, unknown>) ?? null);
    const builtin = this.zoneDefaultLayout();
    if (builtin) this.store.registerZoneDefault(this.zone.id, builtin as unknown as Record<string, unknown>);
    this.os = new OfficeState(this.zoneLayout()); // portals derive from placed furniture (P5 v2)
    // NPC decisions run through the server-only mistreevous brain (kept out of
    // the client bundle). The engine remains the movement actuator.
    this.os.setNpcDecider((_pet, aff) =>
      this.npcBrain.decide({
        wantsToRest: Math.random() < PET_SIT_CHANCE,
        wantsCoffee: Math.random() < PET_DRINK_CHANCE,
        wantsTalk: Math.random() < PET_TALK_CHANCE,
        canRest: aff.canRest,
        canChase: aff.canChase,
        threatened: aff.threatened,
        canDrink: aff.canDrink,
        canTalk: aff.canTalk,
      }),
    );
    this.applyZoneNpcFilter(); // which NPC variants spawn in this zone (per-zone)

    // Restore per-user pinned character skins (so a user's skin stays stable).
    for (const [name, skin] of Object.entries(appStore.getCharPrefs())) {
      this.os.setSkinPref(name, skin);
    }

    // Seed any agents that already exist (mock/feed started before this room),
    // but only those whose owner is currently viewing this zone.
    for (const a of director.snapshot()) {
      if (!this.hostsOwner(a.label)) continue;
      this.hostedAgents.set(a.id, a.label);
      this.seedAgent(a);
    }
    director.on('event', this.onEvent);
    director.on('reroute', this.onReroute);
    controlBus.on(KICK_EVENT, this.onKick);
    controlBus.on(ZONE_INVITE_EVENT, this.onZoneInvite);
    controlBus.on(ZONE_INVITE_RESULT_EVENT, this.onZoneInviteResult);
    controlBus.on(ZONE_DELETED_EVENT, this.onZoneDeleted);
    controlBus.on(ASSET_CHANGED_EVENT, this.onAssetChanged);

    this.registerLayoutHandlers();
    this.setSimulationInterval((dtMs) => this.tick(dtMs / 1000), 1000 / TICK_HZ);
  }

  onDispose(): void {
    director.off('event', this.onEvent);
    director.off('reroute', this.onReroute);
    controlBus.off(KICK_EVENT, this.onKick);
    controlBus.off(ZONE_INVITE_EVENT, this.onZoneInvite);
    controlBus.off(ZONE_INVITE_RESULT_EVENT, this.onZoneInviteResult);
    controlBus.off(ZONE_DELETED_EVENT, this.onZoneDeleted);
    controlBus.off(ASSET_CHANGED_EVENT, this.onAssetChanged);
    this.store?.close();
    this.zones?.close();
  }

  onJoin(client: Client, options?: { arrive?: boolean }): void {
    // Decoded assets so the client can render. The layoutLoaded from the static
    // bundle is replaced by the live active layout; agent state flows via schema.
    client.send('m', this.bundle.providerCapabilities);
    for (const m of this.bundle.messages) {
      if (m.type !== 'layoutLoaded') client.send('m', m);
    }
    client.send('m', this.activeLayoutMessage());
    client.send('m', this.layoutListMessage());
    client.send('m', this.zoneListMessage());
    client.send('m', { type: 'chatHistory', messages: this.chatLog });
    for (const key of this.meetingRooms.keys()) client.send('m', this.meetingRoomMembersMsg(key));

    // This viewer's identity: userId keys all per-user state; username is the
    // (free) display name shown on the avatar.
    const { userId, username, isAdmin, role } = authOf(client);
    // This user is now viewing this zone, so their agents should live here. The
    // reroute hands them over from whatever zone they were in (no-op if same).
    director.setOwnerZone(userId, this.zone.id);
    if (userId) presence.join(userId, this.zone.id, username || userId);
    const characterSkin = userId ? (appStore.getCharPrefs()[userId] ?? null) : null;

    // Zone-local avatar loading: give the joiner every owned avatar already
    // present in this zone, so it can render the players standing here without
    // pulling in avatars from other zones.
    for (const [sid, data] of this.avatarData) client.send('m', { type: 'playerAvatar', id: sid, data });

    // Logged-in viewers own a private, editable avatar (pa:<userId>); anonymous
    // viewers (open dev mode) fall back to a random gallery skin.
    let playerSkin: string | null = null;
    if (userId) {
      const data = this.ensurePlayerAvatar(userId);
      const sid = playerAvatarSkinId(userId);
      playerSkin = sid;
      this.avatarData.set(sid, data);
      this.avatarRefs.set(sid, (this.avatarRefs.get(sid) ?? 0) + 1);
      // Announce (or refresh) this avatar to everyone in the zone, incl. the joiner.
      this.broadcast('m', { type: 'playerAvatar', id: sid, data });
    }
    // Everyone who joins gets a player avatar. Active entry (menu switch or
    // portal) → land at the zone's arrival tile; a plain refresh resumes where
    // this user last stood (engine picks a free tile, else random).
    const saved = userId ? appStore.getPlayerPos(userId, this.zone.id) : null;
    const spawnAt = options?.arrive ? this.zone.arrive : (saved ?? undefined);
    // The avatar's name is always the player's display name (username or userId).
    const displayName = username || userId || undefined;
    const playerId = this.os.addPlayer(playerSkin ?? undefined, displayName, spawnAt ?? undefined);
    this.players.set(client.sessionId, playerId);
    if (userId) {
      this.playerUserIds.set(playerId, userId);
      // Warm this user's TimeTracking status now rather than waiting up to a
      // poll interval, so their symbol is over their head from the moment they
      // appear — including for someone who never opens the HUD. A no-op for the
      // majority who have no TimeTracking account.
      void timeTracking.refreshIfConfigured(userId);
    }
    // Announce a real user's arrival to everyone in the zone. Agents/NPCs are
    // engine entities, never Colyseus clients, so they never reach here. Deduped
    // so a second tab of the same user in this zone doesn't re-announce.
    if (userId && !this.hasOtherSession(client)) {
      this.broadcast('m', { type: 'system', text: `${this.chatNameFor(client)} entered the zone.` });
    }
    const agentToken = userId ? (userStore.get(userId)?.agentToken ?? '') : '';
    // Whether this viewer may layout the CURRENT zone (designated zone admin).
    const zoneAdmin = !!userId && this.zones.isZoneAdmin(this.zone.id, userId);
    client.send('m', {
      type: 'viewerIdentity',
      userId,
      username,
      isAdmin,
      role,
      zoneAdmin,
      agentToken,
      characterSkin,
      playerSkin,
      playerId,
      version: this.version,
    });
    // Personal viewer prefs (per user; anonymous viewers get the defaults).
    const vs = userId
      ? appStore.getViewerSettings(userId)
      : { soundEnabled: true, alwaysShowLabels: false, alertVolume: 1, cameraFollow: true };
    client.send('m', { type: 'settingsLoaded', ...vs });
  }

  onLeave(client: Client): void {
    this.arcadeLobby?.onLeave(client.sessionId); // drop from any arcade match
    const { userId } = authOf(client);
    if (userId) presence.leave(userId);
    const playerId = this.players.get(client.sessionId);
    if (playerId !== undefined) {
      // Persist the avatar's last tile (logged-in users respawn there next time).
      const ch = this.os.getCharacter(playerId);
      if (userId && ch) appStore.setPlayerPos(userId, this.zone.id, ch.tileCol, ch.tileRow);
      // Announce departure (before removePlayer so chatNameFor still resolves the
      // avatar name). Only for real users, and only when their last session in
      // this zone is leaving.
      if (userId && !this.hasOtherSession(client)) {
        this.broadcast('m', { type: 'system', text: `${this.chatNameFor(client)} left the zone.` });
      }
      this.leaveAllMeetingRooms(playerId);
      this.os.removePlayer(playerId);
      this.players.delete(client.sessionId);
      this.playerUserIds.delete(playerId);
    }
    // Release this user's owned avatar from the zone once their last session
    // here is gone, so other clients can drop the no-longer-needed sprite data.
    if (userId) {
      const sid = playerAvatarSkinId(userId);
      const n = (this.avatarRefs.get(sid) ?? 1) - 1;
      if (n > 0) {
        this.avatarRefs.set(sid, n);
      } else {
        this.avatarRefs.delete(sid);
        this.avatarData.delete(sid);
        this.broadcast('m', { type: 'playerAvatarGone', id: sid });
      }
    }
    this.lastChatAt.delete(client.sessionId);
    this.lastVoiceEventAt.delete(client.sessionId);
  }

  /** The effective action (see Action) of the furniture item anchored
   *  exactly at this tile, or null — mirrors effectiveAction: the placed
   *  item's own override if set, else the catalog's legacy conference/
   *  arcade/meetingRoom/appliance flags. Client approach messages always
   *  carry a furniture item's own anchor col/row (never just any tile its
   *  footprint covers), so an exact match is enough. */
  private actionAt(col: number, row: number): Action | null {
    const item = this.os.getLayout().furniture.find((f) => f.col === col && f.row === row);
    return item ? effectiveAction(item, getCatalogEntry(item.type)) : null;
  }

  /** A meeting-room membership key, namespaced by source so a furniture
   *  item's own anchor tile can never collide with a tile-action area's
   *  flood-fill anchor even if they happen to share a col/row. */
  private meetingRoomKey(source: 'furniture' | 'tile', col: number, row: number): string {
    return `${source}:${col},${row}`;
  }

  private parseMeetingRoomKey(key: string): { source: 'furniture' | 'tile'; col: number; row: number } | null {
    const m = /^(furniture|tile):(-?\d+),(-?\d+)$/.exec(key);
    return m ? { source: m[1] as 'furniture' | 'tile', col: Number(m[2]), row: Number(m[3]) } : null;
  }

  /** Whether a meeting room (by key) currently offers video — a furniture
   *  item's own action.video, or a tile-area's anchor action.video. */
  private videoForMeetingRoomKey(key: string): boolean {
    const parsed = this.parseMeetingRoomKey(key);
    if (!parsed) return true;
    if (parsed.source === 'furniture') {
      const action = this.actionAt(parsed.col, parsed.row);
      return action?.kind === 'meetingRoom' ? action.video : true;
    }
    const layout = this.os.getLayout();
    const a = layout.tileActions?.[parsed.row * layout.cols + parsed.col];
    return a?.kind === 'meetingRoom' ? a.video : true;
  }

  /** Current members of a meeting room (by its "source:col,row" key), for broadcast. */
  private meetingRoomMembersMsg(key: string): Record<string, unknown> {
    const parsed = this.parseMeetingRoomKey(key);
    const ids = this.meetingRooms.get(key) ?? new Set<number>();
    const members = [...ids].map((id) => ({ id, name: this.os.getCharacter(id)?.folderName || 'Guest' }));
    return {
      type: 'meetingRoomMembers',
      source: parsed?.source ?? 'furniture',
      col: parsed?.col ?? 0,
      row: parsed?.row ?? 0,
      video: this.videoForMeetingRoomKey(key),
      members,
    };
  }

  /** Recompute which meeting-room tile area (if any) a player's current
   *  tile belongs to and update membership + broadcast on any change.
   *  Called once per player per tick from syncCharacters — unlike a
   *  furniture-sourced meeting room, there's no explicit join/leave
   *  message; standing on the tile *is* the membership. */
  private updateMeetingRoomMembership(playerId: number, col: number, row: number): void {
    const areaId = this.os.areaIdAt(col, row);
    const anchor = areaId !== null ? this.os.areaAnchor(areaId) : null;
    const newKey = anchor ? this.meetingRoomKey('tile', anchor.col, anchor.row) : null;
    const oldKey = this.lastMeetingRoomArea.get(playerId) ?? null;
    if (newKey === oldKey) return;
    if (oldKey) this.leaveMeetingRoom(playerId, oldKey);
    if (newKey) {
      let set = this.meetingRooms.get(newKey);
      if (!set) this.meetingRooms.set(newKey, (set = new Set<number>()));
      set.add(playerId);
      this.lastMeetingRoomArea.set(playerId, newKey);
      this.broadcast('m', this.meetingRoomMembersMsg(newKey));
    } else {
      this.lastMeetingRoomArea.delete(playerId);
    }
  }

  /** Namespaced + sanitised LiveKit room name (prevents cross-deployment clashes). */
  private voiceRoom(suffix: string): string {
    return voiceRoomName(this.voiceNs, suffix);
  }

  /** Mint a LiveKit access token for player `id` in `room` (see the shared helper). */
  private async mintVoiceToken(id: number, room: string): Promise<string | null> {
    return mintVoiceToken(`p${id}`, this.os.getCharacter(id)?.folderName || `Guest-${id}`, room);
  }

  /** Remove a player from one meeting room (furniture- or tile-sourced) +
   *  broadcast the new roster. */
  private leaveMeetingRoom(playerId: number, key: string): void {
    const set = this.meetingRooms.get(key);
    if (!set || !set.delete(playerId)) return;
    if (set.size === 0) this.meetingRooms.delete(key);
    this.broadcast('m', this.meetingRoomMembersMsg(key));
  }

  /** Remove a player from every meeting room (furniture explicit-leave/
   *  disconnect/zone-change, or tile-based cleanup — updateMeetingRoomMembership
   *  only runs from a live character's tick, so a departing player needs this
   *  explicit cleanup either way). */
  private leaveAllMeetingRooms(playerId: number): void {
    for (const key of [...this.meetingRooms.keys()]) this.leaveMeetingRoom(playerId, key);
    this.lastMeetingRoomArea.delete(playerId);
  }

  /** Display name for a chatter: their avatar's name, else display name, else Guest. */
  private chatNameFor(client: Client): string {
    const { userId, username } = authOf(client);
    const id = this.players.get(client.sessionId);
    const ch = id !== undefined ? this.os.getCharacter(id) : null;
    return ch?.folderName || username || userId || 'Guest';
  }

  /** Whether another current client in this zone shares `client`'s userId (i.e.
   *  the same user has this zone open in another tab). Used to dedup the
   *  enter/leave announcements. Anonymous viewers (no userId) never dedup. */
  private hasOtherSession(client: Client): boolean {
    const { userId } = authOf(client);
    if (!userId) return false;
    return this.clients.some((c) => c.sessionId !== client.sessionId && authOf(c).userId === userId);
  }

  // ── Layout management (server-authoritative) ─────────────────────

  private migratedActiveLayout(): OfficeLayout | undefined {
    const raw = this.store.getActiveLayout(this.zone.id) as OfficeLayout | null;
    return raw && raw.version === 1 ? migrateLayoutColors(raw) : (raw ?? undefined);
  }

  /** This zone's builtin/read-only Default layout, for generated zones. The
   *  office's Default is the bundled layout (registered by the store itself), so
   *  it returns undefined here. The plaza keeps its beam pad; every other
   *  generated/user zone is a blank wall-bordered field of its size. */
  private zoneDefaultLayout(): OfficeLayout | undefined {
    if (this.zone.id === 'office') return undefined;
    if (this.zone.id === 'plaza') return createPlazaLayout();
    return createBlankZoneLayout(this.zone.cols ?? 20, this.zone.rows ?? 14);
  }

  /** Layout this room's zone simulates: its active layout, falling back to the
   *  zone's read-only builtin Default. Each zone is independent. */
  private zoneLayout(): OfficeLayout | undefined {
    return this.migratedActiveLayout();
  }

  /** Apply this zone's NPC spawn set to the engine. null/undefined = all active
   *  variants; an array = only those `"<kind>_<variant>"` keys. */
  private applyZoneNpcFilter(): void {
    const npc = this.zone.npc;
    if (npc == null) {
      this.os.setNpcSpawnFilter(() => true);
    } else {
      const set = new Set(npc);
      this.os.setNpcSpawnFilter((kind, variant) => set.has(`${kind}_${variant}`));
    }
  }

  private activeLayoutMessage(): Record<string, unknown> {
    return {
      type: 'layoutLoaded',
      // The layout this room actually simulates (the zone's), so the client
      // renders the right floor/walls — not always the store's active layout.
      layout: this.os.getLayout(),
      activeLayout: this.store.getActiveName(this.zone.id),
      force: true,
    };
  }

  private layoutListMessage(): Record<string, unknown> {
    return {
      type: 'layoutList',
      layouts: this.store.list(this.zone.id),
      active: this.store.getActiveName(this.zone.id),
    };
  }

  /** Zones a viewer may see/travel to — the full registry. */
  private zoneListMessage(): Record<string, unknown> {
    return { type: 'zoneList', zones: this.zones.list(), current: this.zone.id };
  }

  /** Re-read + push the (per-viewer filtered) zone registry to everyone here. */
  private broadcastZoneList(): void {
    for (const client of this.clients) client.send('m', this.zoneListMessage());
  }

  /** Rebuild the simulation from the (new) active layout and push it to all
   *  viewers (floor/walls via layoutLoaded; furniture re-syncs through schema). */
  private applyActiveLayout(): void {
    const layout = this.zoneLayout();
    if (layout) this.os.rebuildFromLayout(layout);
    this.lastFurnitureRef = null; // force furniture re-sync
    this.broadcast('m', this.activeLayoutMessage());
    this.broadcast('m', this.layoutListMessage());
  }

  private registerLayoutHandlers(): void {
    const zone = this.zone.id;
    this.onMessage('requestLayouts', (client) => client.send('m', this.layoutListMessage()));

    this.onMessage('loadLayout', (client, msg: { name?: string }) => {
      if (!this.may(client, 'zone.edit', zone)) return;
      if (typeof msg?.name === 'string' && this.store.setActive(zone, msg.name)) this.applyActiveLayout();
    });

    this.onMessage('saveLayout', (client, msg: { layout?: Record<string, unknown> }) => {
      if (!this.may(client, 'zone.edit', zone)) return;
      // Autosave this zone's active layout (no-op on its read-only Default).
      if (msg?.layout && this.store.saveActive(zone, sanitizeLayoutImages(sanitizeLayoutActions(sanitizeLayoutTexts(msg.layout))), Date.now())) {
        this.applyActiveLayout();
      }
    });

    this.onMessage('saveLayoutAs', (client, msg: { name?: string; layout?: Record<string, unknown> }) => {
      if (!this.may(client, 'zone.edit', zone)) return;
      const name = cleanName(msg?.name);
      if (name && msg?.layout && LayoutStore.isValidUserName(name)) {
        this.store.saveAs(zone, name, sanitizeLayoutImages(sanitizeLayoutActions(sanitizeLayoutTexts(msg.layout))), Date.now());
        this.applyActiveLayout();
      }
    });

    this.onMessage('deleteLayout', (client, msg: { name?: string }) => {
      if (!this.may(client, 'zone.edit', zone)) return;
      if (typeof msg?.name === 'string' && this.store.delete(zone, msg.name)) this.applyActiveLayout();
    });

    // Zone-local chat: validate + rate-limit, then broadcast (and keep recent
    // history for joiners). `id` lets clients show a bubble over the sender.
    this.onMessage('chat', (client, msg: { text?: string }) => {
      const now = Date.now();
      if (now - (this.lastChatAt.get(client.sessionId) ?? 0) < 700) return; // ~1.4/s
      const text = (typeof msg?.text === 'string' ? msg.text : '').replace(/\s+/g, ' ').trim().slice(0, 200);
      if (!text) return;
      this.lastChatAt.set(client.sessionId, now);
      const from = this.chatNameFor(client);
      const id = this.players.get(client.sessionId) ?? null;
      this.chatLog.push({ from, text, at: now });
      if (this.chatLog.length > 50) this.chatLog.shift();
      this.broadcast('m', { type: 'chat', from, text, id, at: now });
    });

    // ── Furniture actions (see Action): click → walk the avatar to a
    // (randomly picked, so simultaneous visitors spread out) approach tile,
    // then either add it to a 'meetingRoom's membership or tell just that
    // client to open its own local UI once arrived — see
    // handleActionArrivals / 'actionReady'. Covers today's conference
    // monitor, link-manager kiosk, arcade cabinet, and any iframe/
    // meetingRoom action attached to plain furniture. The item is
    // identified by its own anchor tile (stable, shared with the client).
    this.onMessage('actionApproach', (client, msg: { col?: number; row?: number }) => {
      const id = this.players.get(client.sessionId);
      if (id === undefined) return;
      const col = Math.floor(Number(msg?.col));
      const row = Math.floor(Number(msg?.row));
      if (!Number.isInteger(col) || !Number.isInteger(row)) return;
      if (!this.os.walkPlayerToAction(id, col, row)) {
        client.send('m', { type: 'system', text: "Can't reach that — walk up to it first." });
      }
    });

    // Appliances (coffee machine, …): click → walk the avatar to its stand
    // tile, then hold a cosmetic "using it" pose (☕ over the avatar) until the
    // player walks away or sits down (no game effect — see
    // officeState.useAppliance/stationId, the same mechanism NPCs use for
    // coffee breaks, minus their break timer). Kept separate from
    // actionApproach — appliances use the pre-built station/occupancy
    // system, not computeApproachTiles, and have no client notification.
    this.onMessage('applianceApproach', (client, msg: { col?: number; row?: number }) => {
      const id = this.players.get(client.sessionId);
      if (id === undefined) return;
      const col = Math.floor(Number(msg?.col));
      const row = Math.floor(Number(msg?.row));
      if (!Number.isInteger(col) || !Number.isInteger(row)) return;
      if (!this.os.useAppliance(id, col, row)) {
        client.send('m', { type: 'system', text: "Can't reach that — walk up to it first." });
      }
    });

    // Direct meeting-room join (no walking) — for non-spatial clients. Adds
    // the player to the furniture item's membership so meetingRoomToken
    // below admits them.
    this.onMessage('meetingRoomJoin', (client, msg: { col?: number; row?: number }) => {
      const id = this.players.get(client.sessionId);
      if (id === undefined) return;
      const col = Math.floor(Number(msg?.col));
      const row = Math.floor(Number(msg?.row));
      if (!Number.isInteger(col) || !Number.isInteger(row)) return;
      const action = this.actionAt(col, row);
      if (action?.kind !== 'meetingRoom') return;
      const key = this.meetingRoomKey('furniture', col, row);
      let set = this.meetingRooms.get(key);
      if (!set) this.meetingRooms.set(key, (set = new Set<number>()));
      set.add(id);
      this.broadcast('m', this.meetingRoomMembersMsg(key));
    });

    this.onMessage('meetingRoomLeave', (client, msg: { col?: number; row?: number }) => {
      const id = this.players.get(client.sessionId);
      if (id === undefined) return;
      const col = Math.floor(Number(msg?.col));
      const row = Math.floor(Number(msg?.row));
      this.leaveMeetingRoom(id, this.meetingRoomKey('furniture', col, row));
    });

    // Ad-hoc meeting room: clicking a "Meeting Room Kiosk" mints a fresh,
    // unguessable room (random slug, expiry, optional password) — see
    // meetingRoomStore.ts. Anyone with the link joins at /meet/<slug>, no
    // pixel-agents account needed (meetingRoomApi.ts). Only a real logged-in
    // account may create one (ties ownership to something); the clicked tile is
    // re-checked server-side so a compromised client can't mint one from thin air.
    this.onMessage(
      'meetingRoomCreate',
      (client, msg: { col?: number; row?: number; ttlDays?: number; password?: string }) => {
        const { userId } = authOf(client);
        if (!userId) {
          client.send('m', { type: 'meetingRoomCreated', error: 'sign-in required' });
          return;
        }
        const col = Math.floor(Number(msg?.col));
        const row = Math.floor(Number(msg?.row));
        if (this.actionAt(col, row)?.kind !== 'linkManager') return;
        // Bounds how many rooms one account can have outstanding at once — without
        // this a compromised/scripted account could flood meeting_rooms forever.
        if (meetingRoomStore.countActiveByOwner(userId) >= MAX_ACTIVE_ROOMS_PER_OWNER) {
          client.send('m', { type: 'meetingRoomCreated', error: 'too many active rooms — close one first' });
          return;
        }
        const password = typeof msg?.password === 'string' ? msg.password : '';
        // Higher floor than the generic account password (see MIN_MEETING_ROOM_PASSWORD_LEN
        // doc comment) — this link+password pair is typically handed out over email.
        if (password && (password.length < MIN_MEETING_ROOM_PASSWORD_LEN || password.length > MAX_PASSWORD_LEN)) {
          client.send('m', {
            type: 'meetingRoomCreated',
            error: `weak password (must be ${MIN_MEETING_ROOM_PASSWORD_LEN}-${MAX_PASSWORD_LEN} characters)`,
          });
          return;
        }
        // Client offers 1/7/14/30 days + 3/6 months (90/180 days) — 180 is the cap.
        const ttlDays = Math.min(180, Math.max(1, Math.floor(Number(msg?.ttlDays)) || 7));
        const room = meetingRoomStore.create(userId, ttlDays * 24 * 60 * 60 * 1000, {
          password: password || undefined,
        });
        client.send('m', { type: 'meetingRoomCreated', slug: room.slug, expiresAt: room.expiresAt });
      },
    );

    // Self-service: any signed-in user can see and end their OWN meeting rooms
    // (not just admins — see adminApi.ts for the admin-wide view). No kiosk tile
    // needed for this one; it's just "list/delete rooms I own".
    this.onMessage('meetingRoomList', (client) => {
      const { userId } = authOf(client);
      if (!userId) return;
      const rooms = meetingRoomStore.listByOwner(userId).map((r) => ({
        slug: r.slug,
        label: r.label,
        createdAt: r.createdAt,
        expiresAt: r.expiresAt,
        hasPassword: r.hasPassword,
        expired: meetingRoomStore.isExpired(r),
      }));
      client.send('m', { type: 'meetingRoomList', rooms });
    });

    this.onMessage('meetingRoomDelete', (client, msg: { slug?: string }) => {
      const { userId } = authOf(client);
      const slug = typeof msg?.slug === 'string' ? msg.slug : '';
      if (!userId || !slug) return;
      const room = meetingRoomStore.get(slug);
      // Ownership check — a user may only end their own rooms this way (admins
      // use the dedicated admin-only route in adminApi.ts, which can delete any).
      if (!room || room.ownerId !== userId) {
        client.send('m', { type: 'meetingRoomDeleted', slug, error: 'not found' });
        return;
      }
      meetingRoomStore.delete(slug);
      client.send('m', { type: 'meetingRoomDeleted', slug });
    });

    // Mint a LiveKit access token for a meeting room's call — only for a
    // player who is actually a member (server-authoritative gate; no
    // password gate of its own — a furniture item wanting one uses the
    // 'linkManager' kiosk action instead, which mints its own password-
    // protected /meet/<slug> room via meetingRoomStore.ts). The room name is
    // the source's own stable anchor: a furniture item's name-or-position
    // (conferenceKey) or a tile-area's flood-fill anchor
    // (OfficeState.areaAnchor) — either way it survives the item/area moving
    // or the layout rebuilding, as long as the shape/name doesn't change.
    this.onMessage(
      'meetingRoomToken',
      async (client, msg: { source?: string; col?: number; row?: number; password?: string }) => {
        const id = this.players.get(client.sessionId);
        if (id === undefined) return;
        const col = Math.floor(Number(msg?.col));
        const row = Math.floor(Number(msg?.row));
        const source = msg?.source === 'tile' ? 'tile' : 'furniture';
        const key = this.meetingRoomKey(source, col, row);
        if (!this.meetingRooms.get(key)?.has(id)) return; // not a member → no token

        const url = process.env.LIVEKIT_URL;
        const apiKey = process.env.LIVEKIT_API_KEY;
        const apiSecret = process.env.LIVEKIT_API_SECRET;
        if (!url || !apiKey || !apiSecret) {
          client.send('m', { type: 'meetingRoomToken', source, col, row, error: 'not-configured' });
          return;
        }
        // Stable room name: a furniture item's own name (survives moving it) or
        // position, else a tile-area's own anchor. Sanitised to LiveKit's
        // allowed room-name characters (voiceRoom).
        const roomName =
          source === 'furniture'
            ? this.voiceRoom(
                `${this.zone.id}-${conferenceKey(
                  this.os.getLayout().furniture.find((f) => f.col === col && f.row === row)?.name,
                  col,
                  row,
                )}`,
              )
            : this.voiceRoom(`${this.zone.id}-meet:${col},${row}`);
        const token = await this.mintVoiceToken(id, roomName);
        if (!token) return;
        client.send('m', {
          type: 'meetingRoomToken',
          source,
          col,
          row,
          url,
          token,
          room: roomName,
          video: this.videoForMeetingRoomKey(key),
        });
      },
    );

    // Zone voice: one LiveKit room per zone. Any player with a visible avatar can
    // join; entering a different zone is a different room (the client reconnects
    // on zone change). Proximity attenuation is applied client-side.
    this.onMessage('zoneVoiceToken', async (client) => {
      const id = this.players.get(client.sessionId);
      if (id === undefined) {
        client.send('m', { type: 'zoneVoiceToken', error: 'no-avatar' });
        return;
      }
      const url = process.env.LIVEKIT_URL;
      if (!url || !process.env.LIVEKIT_API_KEY || !process.env.LIVEKIT_API_SECRET) {
        client.send('m', { type: 'zoneVoiceToken', error: 'not-configured' });
        return;
      }
      const room = this.voiceRoom(`zv-${this.zone.id}`);
      const token = await this.mintVoiceToken(id, room);
      if (!token) return;
      client.send('m', { type: 'zoneVoiceToken', url, token, room });
    });

    // Voice state changes (join/leave/mute/deafen) happen peer-to-peer in
    // LiveKit, so the client tells us when one is worth announcing in the zone
    // chat. The allowlist doubles as validation; unknown events are ignored.
    this.onMessage('voiceEvent', (client, msg: { event?: string }) => {
      if (this.players.get(client.sessionId) === undefined) return; // must have an avatar
      const now = Date.now();
      // Rate-limit announcements per session so rapid join/mute toggling can't
      // spam the zone chat (mirrors the 'chat' handler's ~1.4/s throttle).
      if (now - (this.lastVoiceEventAt.get(client.sessionId) ?? 0) < 700) return;
      const name = this.chatNameFor(client);
      const texts: Record<string, string> = {
        join: `${name} joined the voice chat.`,
        leave: `${name} left the voice chat.`,
        'mic-off': `${name} muted their mic.`,
        'mic-on': `${name} unmuted their mic.`,
        'deaf-on': `${name} muted sound.`,
        'deaf-off': `${name} unmuted sound.`,
      };
      const text = texts[msg?.event ?? ''];
      if (!text) return;
      this.lastVoiceEventAt.set(client.sessionId, now);
      this.broadcast('m', { type: 'system', text });
    });

    // Lightweight user directory for autocomplete (ACL add / invite / owner
    // pickers) — any signed-in user, not just admins (they need to search for
    // *other* users to add to their own zone). Disabled accounts are excluded:
    // adding one to an ACL or inviting them would never do anything, since a
    // disabled account can't hold a session at all.
    this.onMessage('requestUserList', (client) => {
      const { userId } = authOf(client);
      if (!userId) return;
      const users = userStore
        .list()
        .filter((u) => !u.disabled)
        .map((u) => ({ userId: u.userId, name: UserStore.displayName(u), isAdmin: u.isAdmin }));
      client.send('m', { type: 'userList', users });
    });

    // ── Zone registry (any user may create/own one; edit/delete needs zone-admin
    // or global-admin; privacy/ACL/invite is owner-only; office is protected) ──
    this.onMessage('requestZones', (client) => client.send('m', this.zoneListMessage()));

    this.onMessage('createZone', (client, msg: { label?: string; cols?: number; rows?: number }) => {
      if (!this.may(client, 'zone.create')) return;
      if (typeof msg?.label !== 'string') return;
      const { userId } = authOf(client);
      // Owned by its creator (absent for an anonymous open-dev viewer, who has no
      // userId — those zones stay ownerless/public). Capped per owner (see
      // MAX_ZONES_PER_OWNER) so one account can't flood the registry.
      const id = this.zones.create(msg.label, Number(msg?.cols), Number(msg?.rows), Date.now(), userId || undefined);
      if (!id) {
        client.send('m', { type: 'zoneCreated', error: userId && this.zones.countByOwner(userId) > 0 ? 'too many zones' : 'invalid name' });
        return;
      }
      // The creator becomes the new zone's admin so a regular `user` can edit the
      // room they just made (global admins can edit any zone regardless).
      if (userId) this.zones.setZoneAdmin(id, userId, true);
      // Tell the creator the new id (so the client can offer to jump there) +
      // refresh everyone here.
      client.send('m', { type: 'zoneCreated', id });
      this.broadcastZoneList();
    });

    // Owner-only: toggle a zone private. Private rejects entry for anyone but
    // the owner/zone-admins/ACL/global-admins (see gateEntry) — stronger than a
    // password since there's no shared secret to leak, and access is revocable
    // per person.
    this.onMessage('zoneSetPrivate', (client, msg: { id?: string; private?: boolean }) => {
      const id = typeof msg?.id === 'string' ? msg.id : '';
      if (!id || !this.may(client, 'zone.managePrivacy', id)) return;
      if (this.zones.setPrivate(id, !!msg?.private)) {
        if (id === this.zone.id) this.zone = this.zones.get(id) ?? this.zone;
        this.broadcastZoneList();
      }
    });

    // Global-admin-only: take, transfer, or clear a zone's ownership — the
    // in-game equivalent of the admin site's owner control, for zones that
    // predate ownership or lost their owner when that account was deleted.
    // Even the current owner can't do this to themselves via this message —
    // that's deliberate (see permissions.ts zone.setOwner).
    this.onMessage('zoneSetOwner', (client, msg: { id?: string; ownerId?: string | null }) => {
      const id = typeof msg?.id === 'string' ? msg.id : '';
      if (!id || !this.may(client, 'zone.setOwner')) return;
      const targetId = msg?.ownerId == null || msg.ownerId === '' ? null : normalizeLoginId(msg.ownerId);
      if (targetId && !userStore.get(targetId)) return;
      if (this.zones.setOwner(id, targetId)) this.broadcastZoneList();
    });

    // Everyone with a stake in a zone's access, together: the owner, its
    // zone-admins (co-editors — read-only here, granted via setZoneAdmin which
    // stays admin-only), and the ACL. Lets the owner actually see who can do
    // what instead of just the ACL in isolation.
    const zoneMembersPayload = (id: string) => {
      const ownerId = this.zones.zoneOwner(id);
      return {
        owner: ownerId ? this.zoneMemberView(ownerId) : null,
        admins: this.zones.listZoneAdmins(id).map((uid) => this.zoneMemberView(uid)),
        acl: this.zones.listAcl(id).map((uid) => this.zoneMemberView(uid)),
      };
    };

    this.onMessage('zoneMembers', (client, msg: { id?: string }) => {
      const id = typeof msg?.id === 'string' ? msg.id : '';
      if (!id || !this.may(client, 'zone.managePrivacy', id)) return;
      client.send('m', { type: 'zoneMembers', id, ...zoneMembersPayload(id) });
    });

    this.onMessage('zoneAclAdd', (client, msg: { id?: string; userId?: string }) => {
      const id = typeof msg?.id === 'string' ? msg.id : '';
      const targetId = normalizeLoginId(msg?.userId);
      if (!id || !targetId || !this.may(client, 'zone.managePrivacy', id) || !userStore.get(targetId)) return;
      this.zones.aclAdd(id, targetId);
      client.send('m', { type: 'zoneMembers', id, ...zoneMembersPayload(id) });
    });

    this.onMessage('zoneAclRemove', (client, msg: { id?: string; userId?: string }) => {
      const id = typeof msg?.id === 'string' ? msg.id : '';
      const targetId = normalizeLoginId(msg?.userId);
      if (!id || !targetId || !this.may(client, 'zone.managePrivacy', id)) return;
      this.zones.aclRemove(id, targetId);
      client.send('m', { type: 'zoneMembers', id, ...zoneMembersPayload(id) });
    });

    // Real-time "pull someone in": reaches the target wherever they are (a
    // different zone's room instance) via the same cross-room controlBus /kick
    // already uses. They get a prompt and must accept (zoneInviteRespond) —
    // accepting adds them to the ACL and tells their client to travel here.
    this.onMessage('zoneInvite', (client, msg: { id?: string; userId?: string }) => {
      const id = typeof msg?.id === 'string' ? msg.id : '';
      const targetId = normalizeLoginId(msg?.userId);
      if (!id || !targetId || !this.may(client, 'zone.managePrivacy', id)) return;
      const { userId: fromUserId, username: fromUsername } = authOf(client);
      if (targetId === fromUserId) return;
      if (!presence.zoneOf(targetId)) {
        client.send('m', { type: 'zoneInviteSent', targetUserId: targetId, error: 'not online' });
        return;
      }
      const zone = this.zones.get(id);
      zoneInvites.record(targetId, id);
      controlBus.emit(ZONE_INVITE_EVENT, {
        targetUserId: targetId,
        fromUserId,
        fromName: fromUsername || fromUserId,
        zoneId: id,
        zoneLabel: zone?.label ?? id,
      });
      client.send('m', { type: 'zoneInviteSent', targetUserId: targetId });
    });

    // The invitee's answer — runs in WHATEVER room they're currently connected
    // to, which may not be the target zone's room, but ZoneStore reads/writes
    // the shared DB regardless of which room instance calls it. Zone ids
    // aren't secret (every client gets the full zone list, private zones
    // included), so accepting only actually adds the caller to the ACL if a
    // matching invite was really sent — see zoneInvites.ts.
    this.onMessage('zoneInviteRespond', (client, msg: { zoneId?: string; accept?: boolean }) => {
      const zoneId = typeof msg?.zoneId === 'string' ? msg.zoneId : '';
      const { userId, username } = authOf(client);
      if (!zoneId || !userId || !this.zones.get(zoneId)) return;
      const accept = !!msg?.accept && zoneInvites.consume(userId, zoneId);
      if (accept) this.zones.aclAdd(zoneId, userId);
      const zone = this.zones.get(zoneId);
      controlBus.emit(ZONE_INVITE_RESULT_EVENT, {
        toUserId: zone?.ownerId,
        accepted: accept,
        byName: username || userId,
        zoneLabel: zone?.label ?? zoneId,
      });
      if (accept) client.send('m', { type: 'zoneInviteAccepted', zoneId });
    });

    this.onMessage('editZone', (client, msg: { id?: string; label?: string; arrive?: { col: number; row: number } }) => {
      if (typeof msg?.id !== 'string' || !this.may(client, 'zone.edit', msg.id)) return;
      const patch: { label?: string; arrive?: { col: number; row: number } } = {};
      if (typeof msg.label === 'string') patch.label = msg.label;
      if (msg.arrive && Number.isInteger(msg.arrive.col) && Number.isInteger(msg.arrive.row)) patch.arrive = msg.arrive;
      if (this.zones.edit(msg.id, patch)) {
        if (msg.id === this.zone.id) this.zone = this.zones.get(msg.id) ?? this.zone;
        this.broadcastZoneList();
      }
    });

    this.onMessage('deleteZone', (client, msg: { id?: string }) => {
      if (typeof msg?.id !== 'string' || !this.may(client, 'zone.delete', msg.id)) return;
      // The office is read-only and can never be deleted (enforced in the store).
      if (this.zones.delete(msg.id)) {
        this.store.deleteZoneLayouts(msg.id); // drop the zone's saved layouts too
        this.broadcastZoneList();
        // The deleted zone might be a DIFFERENT room instance than this one
        // (deleting doesn't require being there) — reach it the same way
        // /kick reaches a user in any room.
        controlBus.emit(ZONE_DELETED_EVENT, msg.id);
      }
    });

    // Grant/revoke a per-zone admin is REST-only now (PUT/DELETE
    // /admin/zone/:id/admins, guarded by the same 'zone.grantAdmin' capability
    // — see adminApi.ts's zoneGrantAdminAuth), called directly from Pixels'
    // Zones panel via fetch instead of a room message — shared with the admin
    // website's identical control (client/src/shared/zoneAdminsWidget.ts). No
    // room-message path for this exists anymore.

    // Per-zone NPC spawn set: which variants appear in a zone (null = all).
    this.onMessage('setZoneNpc', (client, msg: { id?: string; npc?: string[] | null }) => {
      if (typeof msg?.id !== 'string' || !this.may(client, 'zone.edit', msg.id)) return;
      const npc =
        msg.npc === null || msg.npc === undefined
          ? null
          : Array.isArray(msg.npc)
            ? msg.npc.filter((x): x is string => typeof x === 'string').slice(0, 256)
            : undefined;
      if (npc === undefined) return; // malformed
      if (this.zones.setNpc(msg.id, npc)) {
        if (msg.id === this.zone.id) {
          this.zone = this.zones.get(msg.id) ?? this.zone;
          this.applyZoneNpcFilter(); // takes effect now (despawns disallowed pets)
        }
        this.broadcastZoneList();
      }
    });

    // Personal viewer prefs — keyed per user (never global). Anonymous viewers
    // (open dev) keep them client-side only. The client applies them locally on
    // toggle regardless; the server write is just cross-device persistence.
    this.onMessage('setSoundEnabled', (client, msg: { enabled?: boolean }) => {
      const { userId } = authOf(client);
      if (userId) appStore.setViewerSetting(userId, 'soundEnabled', !!msg?.enabled);
    });
    this.onMessage('setAlwaysShowLabels', (client, msg: { enabled?: boolean }) => {
      const { userId } = authOf(client);
      if (userId) appStore.setViewerSetting(userId, 'alwaysShowLabels', !!msg?.enabled);
    });
    this.onMessage('setCameraFollow', (client, msg: { enabled?: boolean }) => {
      const { userId } = authOf(client);
      if (userId) appStore.setViewerSetting(userId, 'cameraFollow', !!msg?.enabled);
    });
    this.onMessage('setAlertVolume', (client, msg: { volume?: number }) => {
      const { userId } = authOf(client);
      if (!userId) return;
      const v = Number(msg?.volume);
      appStore.setViewerSetting(userId, 'alertVolume', Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : 1);
    });

    // Pin the viewer's character skin (keyed by their identity). Applies to
    // their current/future agents and persists across restarts. '' = default.
    this.onMessage('setCharacter', (client, msg: { skin?: string; name?: string }) => {
      const skin = typeof msg?.skin === 'string' ? msg.skin : '';
      if (skin && !this.isKnownSkin(skin)) return;
      const { userId } = authOf(client);
      // Keyed by userId (matches the agent label) for logged-in users; an
      // anonymous viewer (open dev) may pass a name.
      const key = (userId || (typeof msg?.name === 'string' ? msg.name : '')).trim().slice(0, 32);
      if (!key) return;
      if (!skin) {
        // Default (random) → unpin and re-randomise the user's agents.
        appStore.clearCharPref(key);
        this.os.clearSkinPref(key);
      } else {
        appStore.setCharPref(key, skin);
        this.os.setSkinPref(key, skin);
      }
    });

    // ── Account (logged-in users) ──────────────────────────────────
    // Set/change password (scrypt; min length enforced).
    this.onMessage('setPassword', (client, msg: { password?: string }) => {
      const { userId } = authOf(client);
      const pw = String(msg?.password ?? '');
      if (!userId || !isValidPassword(pw)) return;
      userStore.setPassword(userId, pw);
      // Invalidate every session (including this one) so a stolen cookie/
      // bearer token stops working the moment the password changes, instead
      // of surviving up to its full TTL — the client re-prompts for login.
      appStore.deleteSessionsForUser(userId);
      controlBus.emit(KICK_EVENT, userId);
    });

    // Change the free display name; the avatar's name follows it live.
    this.onMessage('setUsername', (client, msg: { username?: string }) => {
      const { userId } = authOf(client);
      if (!userId) return;
      userStore.setUsername(userId, String(msg?.username ?? ''));
      const user = userStore.get(userId);
      const id = this.players.get(client.sessionId);
      if (user && id !== undefined) this.os.setCharacterName(id, UserStore.displayName(user));
    });

    // Rotate the per-user agent token (invalidates the old one immediately).
    this.onMessage('regenerateAgentToken', (client) => {
      const { userId } = authOf(client);
      if (!userId) return;
      client.send('m', { type: 'agentToken', token: userStore.regenerateAgentToken(userId) });
    });

    // Reset the viewer's owned avatar from a gallery template (a fresh copy —
    // the template stays independent; later edits/deletes never affect it).
    this.onMessage('avatarFromTemplate', (client, msg: { templateId?: string }) => {
      const { userId } = authOf(client);
      if (!userId) return;
      const id = typeof msg?.templateId === 'string' ? msg.templateId : '';
      if (!this.isKnownSkin(id)) return;
      const src = (this.bundle.raw.characters as Array<{ id: string; data: LoadedCharacterData }>).find(
        (c) => c.id === id,
      );
      if (src) this.setAvatar(userId, cloneCharacterData(src.data));
    });

    // Save edits to the viewer's own avatar (its private sprite data).
    this.onMessage('saveAvatar', (client, msg: { data?: unknown }) => {
      const { userId } = authOf(client);
      if (!userId || msg?.data === undefined || !this.validCharacterData(msg.data)) return;
      this.setAvatar(userId, msg.data as LoadedCharacterData);
    });

    // Copy the viewer's own avatar into the shared gallery as a new template
    // (a snapshot — the avatar stays the player's own, independent copy). Adding
    // to the shared gallery is an admin action.
    this.onMessage('avatarToTemplate', (client, msg: { name?: string }) => {
      const { userId, username } = authOf(client);
      // Adding to the shared gallery is a gallery-edit (global admin); you also
      // need an owned avatar to copy from.
      if (!userId || !this.may(client, 'gallery.edit')) return;
      const data = appStore.getPlayerAvatar<LoadedCharacterData>(userId);
      if (!data) return;
      const name = ((typeof msg?.name === 'string' ? msg.name : '').trim() || username || userId).slice(0, 16);
      const toSave = { ...cloneCharacterData(data), name };
      if (!this.validCharacterData(toSave)) return;
      appStore.saveAsset('character', this.nextCharTemplateId(), toSave);
      invalidateMergedBundle();
      controlBus.emit(ASSET_CHANGED_EVENT, 'character');
    });

    // Click-to-move: walk the viewer's own avatar to a tile (server validates).
    this.onMessage('playerMove', (client, msg: { col?: number; row?: number }) => {
      const id = this.players.get(client.sessionId);
      if (id === undefined) return;
      const col = Math.floor(Number(msg?.col));
      const row = Math.floor(Number(msg?.row));
      if (Number.isInteger(col) && Number.isInteger(row)) this.os.walkPlayer(id, col, row);
    });

    // Keyboard (WASD) walk: a held cardinal direction, or null to stop. The
    // server steps the avatar tile-by-tile while held (validated per step).
    this.onMessage('playerDir', (client, msg: { dir?: number | null }) => {
      const id = this.players.get(client.sessionId);
      if (id === undefined) return;
      const d = msg?.dir;
      const dir = Number.isInteger(d) && (d as number) >= 0 && (d as number) <= 3 ? (d as Direction) : null;
      this.os.setPlayerDir(id, dir);
    });

    // Sit-in-place toggle for the player's avatar (a rest emote).
    this.onMessage('playerSit', (client, msg: { sit?: boolean }) => {
      const id = this.players.get(client.sessionId);
      if (id !== undefined) this.os.setPlayerSit(id, !!msg?.sit);
    });

    // Slash commands (/afk, …). The shared registry gates by group; client-only
    // commands (/help) never reach here. Feedback is sent back as a 'system' line.
    this.onMessage('command', (client, msg: { name?: string; args?: string }) => {
      const spec = findCommand(typeof msg?.name === 'string' ? msg.name : '');
      if (!spec) return void client.send('m', { type: 'system', text: 'Unknown command. Try /help.' });
      if (!mayRunCommand(spec, authOf(client).isAdmin)) {
        return void client.send('m', { type: 'system', text: `/${spec.name} is for admins only.` });
      }
      this.runCommand(client, spec, typeof msg?.args === 'string' ? msg.args : '');
    });

    // Click-to-sit on a chair/bench: walk to the seat tile and sit facing it.
    this.onMessage('playerSitAt', (client, msg: { col?: number; row?: number }) => {
      const id = this.players.get(client.sessionId);
      if (id === undefined) return;
      const col = Math.floor(Number(msg?.col));
      const row = Math.floor(Number(msg?.row));
      if (Number.isInteger(col) && Number.isInteger(row)) this.os.sitPlayerAt(id, col, row);
    });

    // Destination picked at a portal → land at the target zone's arrival tile
    // (via P4 respawn) and tell the client to reconnect there.
    this.onMessage('portalGo', (client, msg: { zone?: string }) => {
      const target = typeof msg?.zone === 'string' ? this.zones.get(msg.zone) : null;
      if (!target || target.id === this.zone.id) return;
      const id = this.players.get(client.sessionId);
      if (id === undefined) return;
      // The client reloads into the target zone with the arrival flag set, so the
      // target room's onJoin lands the player at its arrival tile.
      this.leaveAllMeetingRooms(id);
      this.os.removePlayer(id);
      this.players.delete(client.sessionId);
      client.send('m', { type: 'zoneTransition', zone: target.id });
    });

    // The player avatar's name is always the user's display name (logged-in);
    // an anonymous viewer (open dev) may pass a chosen name.
    this.onMessage('setPlayerName', (client, msg: { name?: string }) => {
      const { userId, username } = authOf(client);
      const name = userId ? username || userId : cleanName(typeof msg?.name === 'string' ? msg.name : '', 16);
      const id = this.players.get(client.sessionId);
      if (id !== undefined) this.os.setCharacterName(id, name);
    });

    // Asset overrides (characters/furniture/floors/walls/pets). Persist + re-merge
    // + re-apply to the engine + broadcast the refreshed *Loaded message.
    this.onMessage('saveAsset', (client, msg: { assetType?: string; name?: string; data?: unknown }) => {
      if (!this.may(client, 'gallery.edit')) return;
      const type = this.validAssetType(msg?.assetType);
      if (!type || typeof msg?.name !== 'string' || msg.data === undefined) return;
      // Asset ids are safe identifiers (char_0, DESK_FRONT, PC_SIDE:left, …).
      if (!/^[A-Za-z0-9_:-]{1,40}$/.test(msg.name)) return;
      if (type === 'furniture' && !this.validFurnitureData(msg.data)) return;
      // Characters and NPCs (pets) share the LoadedCharacterData + spec shape.
      if ((type === 'character' || type === 'pet') && !this.validCharacterData(msg.data)) return;
      // A floor pattern is just one sprite grid — same light shape check
      // furniture's own sprite field gets (see validFurnitureData), plus a
      // sane size bound.
      if (type === 'floor' && !this.validFloorData(msg.data)) return;
      if (type === 'image' && !this.validImageData(msg.data)) return;
      appStore.saveAsset(type, msg.name, msg.data);
      invalidateMergedBundle();
      controlBus.emit(ASSET_CHANGED_EVENT, type);
    });
    this.onMessage('deleteAsset', (client, msg: { assetType?: string; name?: string }) => {
      if (!this.may(client, 'gallery.edit')) return;
      const type = this.validAssetType(msg?.assetType);
      if (!type || typeof msg?.name !== 'string') return;
      if (appStore.deleteAsset(type, msg.name)) {
        invalidateMergedBundle();
        controlBus.emit(ASSET_CHANGED_EVENT, type);
      }
    });
  }

  // ── Asset overrides ──────────────────────────────────────────────

  private validAssetType(t: unknown): AssetType | null {
    return (ASSET_TYPES as readonly string[]).includes(t as string) ? (t as AssetType) : null;
  }

  /** Is `id` a currently-loaded skin id (char_<n>)? Gates skin-pin messages. */
  private isKnownSkin(id: string): boolean {
    if (!/^char_\d+$/.test(id)) return false;
    return (this.bundle.raw.characters as Array<{ id: string }>).some((c) => c.id === id);
  }

  // ── Slash-command execution ──────────────────────────────────────

  /** Execute a (group-checked) slash command. Feedback goes back as 'system'
   *  chat lines. Admin commands handle user management. */
  private runCommand(client: Client, spec: CommandSpec, argStr: string): void {
    const sys = (text: string): void => void client.send('m', { type: 'system', text });
    const args = argStr.trim() ? argStr.trim().split(/\s+/) : [];
    const me = authOf(client);

    if (spec.name === 'afk') {
      const id = this.players.get(client.sessionId);
      if (id === undefined) return;
      const now = this.os.setPlayerAfk(id);
      return void sys(now ? 'You are now afk — move or run /afk to clear it.' : 'afk cleared.');
    }
    // Everything else is a global account/admin command — one shared backend, so
    // the chat behaves identically here and in the voxel world (see accountCommands.ts).
    runAccountCommand(spec, args, {
      me: { userId: me.userId, isAdmin: me.isAdmin },
      sys,
      hereLabel: this.zone.label,
      hereId: this.zone.id,
      afterDeleteUser: (loginId) => this.zones.removeUserFromAllZones(loginId),
    });
  }

  // ── Player-owned avatars ─────────────────────────────────────────

  /** This user's private avatar sprite data (keyed by userId), creating it on
   *  first use by copying their old gallery pin (migration) or the first template. */
  private ensurePlayerAvatar(userId: string): LoadedCharacterData {
    const existing = appStore.getPlayerAvatar<LoadedCharacterData>(userId);
    if (existing) return existing;
    const chars = this.bundle.raw.characters as Array<{ id: string; data: LoadedCharacterData }>;
    const oldPin = appStore.getPlayerPrefs()[userId];
    const src = (oldPin ? chars.find((c) => c.id === oldPin) : undefined) ?? chars[0];
    const data = cloneCharacterData(src.data);
    appStore.setPlayerAvatar(userId, data);
    return data;
  }

  /** Persist a user's avatar data and push it to everyone in this zone (live
   *  re-render). The skin id stays pa:<userId>; only the sprite data changes. */
  private setAvatar(userId: string, data: LoadedCharacterData): void {
    appStore.setPlayerAvatar(userId, data);
    const sid = playerAvatarSkinId(userId);
    if (this.avatarData.has(sid)) this.avatarData.set(sid, data);
    this.broadcast('m', { type: 'playerAvatar', id: sid, data });
  }

  /** Next free gallery template id (char_<n>) across bundled + DB skins. */
  private nextCharTemplateId(): string {
    let max = -1;
    for (const c of this.bundle.raw.characters as Array<{ id: string }>) {
      const m = /^char_(\d+)$/.exec(c.id);
      if (m) max = Math.max(max, Number(m[1]));
    }
    return `char_${max + 1}`;
  }

  /** Authorize a client action against the central policy (see permissions.ts).
   *  `zoneId` scopes zone.edit (defaults to this room's zone). */
  private may(client: Client, capability: Capability, zoneId: string = this.zone.id): boolean {
    return can(
      authOf(client),
      capability,
      {
        authRequired: this.authRequired,
        isZoneAdmin: (z, u) => this.zones.isZoneAdmin(z, u),
        zoneOwner: (z) => this.zones.zoneOwner(z),
      },
      { zoneId },
    );
  }

  /**
   * Authoritative validation of a character override — never trust the client.
   * Enforces a mandatory display name (printable ASCII, ≤16 chars), and that
   * down/up/right (and optional left) are non-empty frame lists of uniformly
   * sized hex-pixel grids within bounds. Mirrors (and is the real gate behind)
   * the editor's client-side checks.
   */
  private validCharacterData(data: unknown): boolean {
    const d = data as {
      name?: unknown;
      down?: unknown;
      up?: unknown;
      right?: unknown;
      left?: unknown;
      spec?: unknown;
      npc?: unknown;
    };
    if (!d || typeof d !== 'object') return false;
    if (typeof d.name !== 'string') return false;
    const name = cleanName(d.name); // trim + collapse whitespace + cap
    d.name = name; // persisted on save
    if (!/^[\x20-\x7e]{1,32}$/.test(name)) return false;
    const dims = { w: -1, h: -1 };
    const hex = /^#[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$/;
    // Frame dimensions are capped at 64×64 (Stufe A); frame *count* per direction
    // is bounded separately (base + frame-sets).
    const MAX_DIM = 64;
    const validFrames = (frames: unknown): boolean => {
      if (!Array.isArray(frames) || frames.length === 0 || frames.length > 64) return false;
      for (const frame of frames) {
        if (!Array.isArray(frame) || frame.length === 0 || frame.length > MAX_DIM) return false;
        if (dims.h === -1) dims.h = frame.length;
        else if (frame.length !== dims.h) return false;
        for (const row of frame as unknown[]) {
          if (!Array.isArray(row) || row.length === 0 || row.length > MAX_DIM) return false;
          if (dims.w === -1) dims.w = row.length;
          else if (row.length !== dims.w) return false;
          for (const cell of row as unknown[]) {
            if (typeof cell !== 'string') return false;
            if (cell !== '' && !hex.test(cell)) return false;
          }
        }
      }
      return true;
    };
    if (!validFrames(d.down) || !validFrames(d.up) || !validFrames(d.right)) return false;
    if (d.left !== undefined && !validFrames(d.left)) return false;
    // Optional animation spec: track frame counts must sum to the frame count.
    if (d.spec !== undefined) {
      const n = (d.down as unknown[]).length;
      if (!this.validCharacterSpec(d.spec, n)) return false;
    }
    // Optional NPC spawn config.
    if (d.npc !== undefined && !this.validNpcConfig(d.npc)) return false;
    return true;
  }

  /** Validate an optional CharacterSpec: sane frame size + non-empty tracks whose
   *  frame counts sum to `n` (the number of frames per direction). */
  private validCharacterSpec(spec: unknown, n: number): boolean {
    const s = spec as { frame?: unknown; tracks?: unknown };
    if (!s || typeof s !== 'object') return false;
    const fr = s.frame as { w?: unknown; h?: unknown } | undefined;
    const dim = (v: unknown): boolean => Number.isInteger(v) && (v as number) >= 1 && (v as number) <= 64;
    if (!fr || !dim(fr.w) || !dim(fr.h)) return false;
    if (!Array.isArray(s.tracks) || s.tracks.length === 0) return false;
    let sum = 0;
    for (const t of s.tracks) {
      const tt = t as { name?: unknown; frames?: unknown; play?: unknown };
      if (!tt || typeof tt !== 'object') return false;
      if (typeof tt.name !== 'string' || tt.name.length === 0 || tt.name.length > 32) return false;
      if (!Number.isInteger(tt.frames) || (tt.frames as number) < 1 || (tt.frames as number) > 64) return false;
      if (tt.play !== 'loop' && tt.play !== 'pingpong') return false;
      sum += tt.frames as number;
    }
    return sum === n;
  }

  /** Validate an optional NPC spawn config (active flag + sane interval/cap). */
  private validNpcConfig(c: unknown): boolean {
    const o = c as {
      active?: unknown;
      minSec?: unknown;
      maxSec?: unknown;
      maxConcurrent?: unknown;
      behaviors?: unknown;
    };
    if (!o || typeof o !== 'object') return false;
    if (typeof o.active !== 'boolean') return false;
    const int = (v: unknown, lo: number, hi: number): boolean =>
      Number.isInteger(v) && (v as number) >= lo && (v as number) <= hi;
    if (!int(o.minSec, 5, 3600) || !int(o.maxSec, 5, 3600)) return false;
    if ((o.minSec as number) > (o.maxSec as number)) return false;
    if (!int(o.maxConcurrent, 1, 8)) return false;
    // Optional behaviour switches: each, if present, must be a boolean. Missing
    // flags are back-filled (default true) by resolveNpcConfig downstream.
    if (o.behaviors !== undefined) {
      if (typeof o.behaviors !== 'object' || o.behaviors === null) return false;
      const b = o.behaviors as Record<string, unknown>;
      for (const k of ['rest', 'chaseCats', 'fleeDogs', 'drink', 'talk']) {
        if (b[k] !== undefined && typeof b[k] !== 'boolean') return false;
      }
    }
    return true;
  }

  /** Sanity-check a floor pattern override: just a sprite grid (see
   *  FurnitureAsset's own `sprite` check — same shallow shape check, no
   *  catalog metadata applies here), with a sane size bound. */
  private validFloorData(data: unknown): boolean {
    return Array.isArray(data) && data.length > 0 && data.length <= 64 && data.every((row) => Array.isArray(row) && row.length <= 64);
  }

  /** Sanity-check an uploaded background image: a PNG data URL under the byte
   *  cap, with sane label/dimensions. Only the data URL's *prefix* and
   *  *length* are checked here (cheap, no decoding) — a client-supplied
   *  width/height that doesn't match the actual image just makes for a
   *  stretched/squashed placement, not a security issue. */
  private validImageData(data: unknown): boolean {
    if (!data || typeof data !== 'object') return false;
    const d = data as { data?: unknown; width?: unknown; height?: unknown; label?: unknown };
    if (typeof d.data !== 'string' || !d.data.startsWith('data:image/png;base64,')) return false;
    if (d.data.length > MAX_IMAGE_ASSET_BYTES * 1.4) return false; // base64 ≈ 4/3 the decoded size
    if (!Number.isInteger(d.width) || !Number.isInteger(d.height) || (d.width as number) < 1 || (d.height as number) < 1) return false;
    if ((d.width as number) > 4096 || (d.height as number) > 4096) return false;
    if (d.label !== undefined && (typeof d.label !== 'string' || d.label.length > 64)) return false;
    return true;
  }

  /** Sanity-check a furniture override: a sprite grid and a sane catalog entry. */
  private validFurnitureData(data: unknown): boolean {
    const d = data as { sprite?: unknown; catalog?: Record<string, unknown> };
    if (!d || typeof d !== 'object') return false;
    if (d.sprite !== undefined && !Array.isArray(d.sprite)) return false;
    if (d.catalog) {
      const c = d.catalog;
      const fw = Number(c.footprintW);
      const fh = Number(c.footprintH);
      if (!Number.isInteger(fw) || !Number.isInteger(fh) || fw < 1 || fh < 1 || fw > 16 || fh > 16) {
        return false;
      }
      // A category outside the closed FurnitureCategory union would save fine
      // (nothing else here checks it) but getActiveCategories() only ever
      // shows the 8 known ones — an unlisted category is invisible,
      // unplaceable furniture, not a validation gap to let through silently.
      if (typeof c.category !== 'string' || !FURNITURE_CATEGORIES.some((fc) => fc.id === c.category)) return false;
      if (c.appliance !== undefined && (typeof c.appliance !== 'string' || c.appliance.length > 32)) {
        return false;
      }
      // This type's default Action (see FurnitureCatalogEntry.action) — same
      // shape/validation as a per-instance override, just one level up.
      if (c.action !== undefined && !sanitizeAction(c.action)) return false;
      // Animation membership (Tiled-style per-frame timing — see
      // furnitureCatalog.ts's animationFrameAt): a frame index and a bounded
      // per-frame duration, same range the Furniture editor itself clamps to.
      if (c.animationGroup !== undefined && (typeof c.animationGroup !== 'string' || c.animationGroup.length > 64)) {
        return false;
      }
      if (c.frame !== undefined && (!Number.isInteger(c.frame) || (c.frame as number) < 0 || (c.frame as number) > 64)) {
        return false;
      }
      if (
        c.durationMs !== undefined &&
        (!Number.isInteger(c.durationMs) || (c.durationMs as number) < 16 || (c.durationMs as number) > 10000)
      ) {
        return false;
      }
      // On/off trigger (see FurnitureCatalogEntry.onTrigger) — one of exactly
      // two known values, not an arbitrary string.
      if (c.onTrigger !== undefined && c.onTrigger !== 'autoFacing' && c.onTrigger !== 'click') return false;
      // Import provenance (see FurnitureCatalogEntry.source/sourceKey) — free
      // text, just bounded.
      if (c.source !== undefined && (typeof c.source !== 'string' || c.source.length > 64)) return false;
      if (c.sourceKey !== undefined && (typeof c.sourceKey !== 'string' || c.sourceKey.length > 64)) return false;
    }
    return true;
  }

  /** Re-read the (already re-merged — see invalidateMergedBundle) shared bundle,
   *  re-apply the affected type to this room's engine, and broadcast. */
  private reapplyAsset(type: AssetType): void {
    this.bundle = getMergedBundle();
    switch (type) {
      case 'character': {
        setCharacterTemplates(this.bundle.raw.characters as never);
        // A deleted custom skin invalidates anyone pinned to it → drop the pin
        // (persisted) and re-randomise affected live agents.
        const validIds = new Set((this.bundle.raw.characters as Array<{ id: string }>).map((c) => c.id));
        for (const name of this.os.dropInvalidSkins(validIds)) appStore.clearCharPref(name);
        break;
      }
      case 'pet':
        setPetTemplates(
          this.bundle.raw.dogs as never,
          this.bundle.raw.cats as never,
          this.bundle.raw.ducks as never,
        );
        break;
      case 'furniture':
        buildDynamicCatalog({
          catalog: this.bundle.raw.furnitureCatalog as never,
          sprites: this.bundle.raw.furnitureSprites as never,
        });
        // Footprints/seats may have changed → rebuild the office from the layout.
        this.os.rebuildFromLayout(this.migratedActiveLayout() ?? this.os.layout);
        this.lastFurnitureRef = null; // force furniture re-sync
        break;
      // floor/wall are client-render only — just rebroadcast below.
    }
    const msgType = messageTypeForAsset(type);
    const message = this.bundle.messages.find((m) => m.type === msgType);
    if (message) this.broadcast('m', message);
  }

  // ── Simulation → schema ──────────────────────────────────────────

  private tick(dt: number): void {
    // Don't simulate a zone no human is watching. The room disposes when empty
    // (autoDispose), so this normally won't fire with zero clients — but guard the
    // transient tick as the last client leaves so we never spawn/pathfind NPCs or
    // run syncs for nobody. Agents' *logical* state is driven by feed events
    // (applyEvent, via onEvent — independent of this tick), so skipping only drops
    // movement/animation + client syncs; a joining client gets the full state on
    // its first tick.
    if (this.clients.length === 0) return;
    this.os.update(Math.min(dt, 0.1));
    this.handlePortals();
    this.handleActionArrivals();
    this.syncCharacters();
    this.syncPets();
    this.syncFurniture();
  }

  /** Players that stepped on a portal this tick → offer them the other zones as
   *  destinations (the client shows a picker; choosing sends `portalGo`). */
  private handlePortals(): void {
    for (const id of this.os.takePendingPortals()) {
      const client = this.clientForPlayer(id);
      if (!client) continue;
      const zones = this.zones
        .list()
        .filter((z) => z.id !== this.zone.id)
        .map((z) => ({ id: z.id, label: z.label }));
      if (zones.length) client.send('m', { type: 'portalOptions', zones });
    }
  }

  /** Players who reached a furniture action's stand tile this tick — add
   *  'meetingRoom' arrivals to that room's membership; tell just that
   *  client to open its own local UI for everything else (game picker /
   *  room-manage dialog / iframe — this room has no state of its own to
   *  update for those, unlike a meeting-room join). */
  private handleActionArrivals(): void {
    for (const { id, action, col, row } of this.os.takePendingActionArrivals()) {
      if (action.kind === 'meetingRoom') {
        const key = this.meetingRoomKey('furniture', col, row);
        let set = this.meetingRooms.get(key);
        if (!set) this.meetingRooms.set(key, (set = new Set<number>()));
        set.add(id);
        this.broadcast('m', this.meetingRoomMembersMsg(key));
        continue;
      }
      if (action.kind === 'toggle') {
        // A light-switch: flip it server-side, no client notification — the
        // resulting type swap reaches everyone through the normal furniture
        // sync, same as auto-on-facing already does.
        this.os.toggleFurniture(col, row);
        continue;
      }
      const client = this.clientForPlayer(id);
      if (!client) continue;
      client.send('m', {
        type: 'actionReady',
        kind: action.kind,
        col,
        row,
        ...(action.kind === 'iframe' ? { url: action.url } : {}),
      });
    }
  }

  /** The connected client controlling player avatar `id`, or undefined. */
  private clientForPlayer(id: number): Client | undefined {
    let sessionId: string | undefined;
    for (const [sid, pid] of this.players) {
      if (pid === id) {
        sessionId = sid;
        break;
      }
    }
    if (!sessionId) return undefined;
    for (const c of this.clients) if (c.sessionId === sessionId) return c;
    return undefined;
  }

  private syncCharacters(): void {
    const live = new Set<string>();
    for (const ch of this.os.getCharacters()) {
      const key = String(ch.id);
      live.add(key);
      let cs = this.state.characters.get(key);
      if (!cs) {
        cs = new CharacterSync();
        cs.id = ch.id;
        this.state.characters.set(key, cs);
      }
      writeEntityTransform(cs, ch);
      cs.pose = getCharacterPose(ch);
      // cs.frame intentionally not synced — animation phase is client-timed.
      cs.skin = ch.skin;
      cs.hueShift = ch.hueShift;
      cs.isActive = ch.isActive;
      cs.reading = isReadingTool(ch.currentTool);
      cs.bubble = ch.bubbleType ?? '';
      cs.bubbleTimer = ch.bubbleTimer;
      cs.matrixEffect = ch.matrixEffect ?? '';
      cs.matrixEffectTimer = ch.matrixEffectTimer;
      cs.isSubagent = ch.isSubagent;
      cs.isPlayer = ch.isPlayer;
      cs.afk = ch.afk ?? false;
      // Working status comes from the player's own TimeTracking account (agents
      // and NPCs never have one, hence the isPlayer guard). Mirrored into the
      // synced schema rather than fetched by each client so the hover overlay
      // shows the same thing to everyone — and so nobody's client has to know
      // anything about anyone else's TimeTracking.
      cs.workStatus = ch.isPlayer ? timeTracking.statusOf(this.playerUserIds.get(ch.id) ?? '') : '';
      cs.folderName = ch.folderName ?? '';
      cs.teamName = ch.teamName ?? '';
      cs.agentName = ch.agentName ?? '';
      cs.isTeamLead = ch.isTeamLead ?? false;
      cs.activity = this.activity.get(ch.id) ?? '';
      cs.inputTokens = ch.inputTokens;
      cs.outputTokens = ch.outputTokens;
      if (ch.isPlayer) this.updateMeetingRoomMembership(ch.id, ch.tileCol, ch.tileRow);
    }
    for (const key of [...this.state.characters.keys()]) {
      if (!live.has(key)) this.state.characters.delete(key);
    }
  }

  private syncPets(): void {
    const live = new Set<string>();
    for (const pet of this.os.getPets()) {
      const key = String(pet.id);
      live.add(key);
      let ps = this.state.pets.get(key);
      if (!ps) {
        ps = new PetSync();
        ps.id = pet.id;
        this.state.pets.set(key, ps);
      }
      writeEntityTransform(ps, pet);
      ps.kind = pet.kind === PetKind.CAT ? 1 : pet.kind === PetKind.DUCK ? 2 : 0;
      ps.variant = pet.variant;
      ps.frame = pet.frame & 0xff;
      ps.effect = pet.effect ?? '';
      ps.effectTimer = pet.effectTimer;
      ps.restLift = pet.restLift;
    }
    for (const key of [...this.state.pets.keys()]) {
      if (!live.has(key)) this.state.pets.delete(key);
    }
  }

  private syncFurniture(): void {
    if (this.os.furniture === this.lastFurnitureRef) return;
    this.lastFurnitureRef = this.os.furniture;
    const placements = this.os.furniturePlacements;
    this.state.furniture.splice(0, this.state.furniture.length);
    for (const p of placements) {
      const fs = new FurnitureSync();
      fs.type = p.type;
      fs.col = p.col;
      fs.row = p.row;
      fs.name = p.name ?? '';
      const action = effectiveAction(p, getCatalogEntry(p.type));
      fs.action = action ? JSON.stringify(action) : '';
      this.state.furniture.push(fs);
    }
  }
}
