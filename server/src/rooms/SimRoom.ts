import { Room, type AuthContext, type Client } from '@colyseus/core';
import { voiceRoomName, mintVoiceToken } from '../voice/livekit.js';
import { withArtUrl } from '../art/artUrl.js';
import { validCharacterData } from '../art/characterDataGuard.js';
import { avatarSeedFrom } from '../art/avatarSeed.js';

import {
  conferenceKey,
  PROTOCOL_VERSION,
  cleanName,
  MAX_NAME_LEN,
  playerAvatarSkinId,
  findCommand,
  mayRunCommand,
  KICK_CLOSE_CODE,
  DEFAULT_ZONE,
  type CommandSpec,
} from '@pixel/shared';
import type { AgentEvent, WorkStatus, ZoneConfig } from '@pixel/shared';
import { isWorkStatus } from '@pixel/shared';
import type { LoadedCharacterData } from '@pixel/shared/office/sprites/spriteData.js';
import { CharacterSync, FurnitureSync, PetSync, RoomState } from '@pixel/shared/schema';
import { OfficeState, getCharacterPose, isReadingTool } from '@pixel/shared/office/engine/index.js';
import { PET_DRINK_CHANCE, PET_SIT_CHANCE, PET_TALK_CHANCE } from '@pixel/shared/office/constants.js';
import { CHAR_FRAME_H, CHAR_FRAME_W } from '../core/assets/constants.js';
import { ControllerKind, Direction, PetKind, type Action } from '@pixel/shared/office/types.js';
import { setProviderCapabilities } from '@pixel/shared/office/toolUtils.js';
import { setCharacterTemplates, setPetTemplates } from '@pixel/shared/office/sprites/spriteData.js';
import { buildDynamicCatalog, effectiveAction,
  entryFor,
} from '@pixel/shared/office/layout/furnitureCatalog.js';
import { registerArcadeSaves } from '../arcadeSaveRoom.js';
import { registerArcadeLobby } from '../arcadeLobby.js';
import { emptyZoneMap } from '@pixel/shared/office/layout/layoutSerializer.js';
import { DEFAULT_COLS, DEFAULT_ROWS } from '@pixel/shared/office/constants.js';
import type { OfficeLayout } from '@pixel/shared/office/types.js';

import { READING_TOOLS, SUBAGENT_TOOL_NAMES } from '../constants.js';
import { director, type AgentInfo } from '../sim/director.js';
import { applyEvent } from '../sim/applyEvent.js';
import { ZoneMapStore } from '../zoneMapStore.js';
import { ZoneStore } from '../zoneStore.js';
import { appStore, defaultViewerSettings } from '../appStore.js';
import {
  ASSET_TYPES,
  getMergedBundle,
  invalidateMergedBundle,
  messageTypeForAsset,
  type AssetType,
  type ResyncTarget,
} from '../assetOverrides.js';
import { hasValidSession, userIdFromCookie, hasValidBearerSession, userIdFromBearer } from '../auth.js';
import { userStore, UserStore, isValidPassword, normalizeLoginId, MAX_PASSWORD_LEN, type Role, type User } from '../userStore.js';
import { can, type Capability } from '../permissions.js';
import { presence } from '../presence.js';
import { zoneInvites } from '../zoneInvites.js';
import {
  controlBus,
  KICK_EVENT,
  ZONE_INVITE_EVENT,
  ZONE_INVITE_RESULT_EVENT,
  ZONE_DELETED_EVENT,
  ASSET_CHANGED_EVENT,
  AVATAR_CHANGED_EVENT,
  ZONE_LAYOUT_CHANGED_EVENT,
  PRESENCE_EVENT,
} from '../controlBus.js';
import { runAccountCommand } from './accountCommands.js';
import { isThrottled, noteFail, clearFails } from '../throttle.js';
import { meetingRoomStore, MAX_ACTIVE_ROOMS_PER_OWNER, MIN_MEETING_ROOM_PASSWORD_LEN } from '../meetingRoomStore.js';
import { loadQuotes } from '../quotes.js';
import { PetBrain } from '../pet/petBrain.js';
import type { AssetBundle } from '../assets.js';

const TICK_HZ = 20;

/** How long a self-reported working status is trusted without a fresh report.
 *  The desktop app re-reports every 60 s, so this is several missed beats — long
 *  enough to ride out a slow poll, short enough that a closed laptop stops
 *  showing its owner as hard at work. */
const WORK_STATUS_TTL_MS = 5 * 60_000;

/** How often a player's spot is written down (see checkpointSpots). Short enough
 *  that a hard restart puts everyone back within a couple of steps of where they
 *  were, long enough that walking around is not a stream of database writes. */
const SPOT_CHECKPOINT_SEC = 5;

/**
 * Authoritative office room: the original OfficeState simulation runs here, in
 * the server's tick loop. Claude ingest events mutate it; every tick we write
 * the render-state into the Colyseus schema, so all viewers see one identical
 * world. Clients are pure renderers.
 */
/** Copy the shared entity transform (position + facing + coarse state) onto a
 *  synced PawnSync. Each kind's sync loop then sets its own fields on top.
 *
 *  The target is typed by the four fields this writes rather than as `PawnSync`:
 *  since @colyseus/schema 5, structurally comparing two Schema subclasses at a call
 *  site overruns the compiler's instantiation budget (TS2589) — CharacterSync alone
 *  is enough. Every caller still passes a real synced entity; this only stops the
 *  check from walking the whole class to prove what the four assignments need. */
function writeEntityTransform(
  sync: { x: number; y: number; dir: number; state: string },
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

/** A named tile call's key. Named areas carry no coordinates in their identity — the
 *  name and the video setting ARE the identity — so the key states both and nothing
 *  else. Coordinates would defeat the merge: that is the whole point. */
function namedMeetingKey(slug: string, video: boolean): string {
  return `tile:n:${slug}:v${video ? 1 : 0}`;
}

function parseNamedMeetingKey(key: string): { slug: string; video: boolean } | null {
  const m = /^tile:n:(.*):v([01])$/.exec(key);
  return m ? { slug: m[1], video: m[2] === '1' } : null;
}

export class SimRoom extends Room<{ state: RoomState }> {
  /** File defaults merged with DB asset overrides — the process-wide cached
   *  bundle from assetOverrides.ts, not recomputed per room (see getMergedBundle). */
  private bundle!: AssetBundle;
  private os!: OfficeState;
  private store!: ZoneMapStore;
  private zones!: ZoneStore;
  private zone!: ZoneConfig;
  /** Player avatar id per connected client session. */
  private readonly players = new Map<string, number>();
  /**
   * Self-reported TimeTracking status per player avatar id, with the epoch ms it
   * arrived. Only the desktop app can produce one — it holds the credential and
   * does the talking — so the server neither knows nor can verify what it means;
   * it stores a glyph value and syncs it. See the 'workStatus' handler.
   *
   * The timestamp is what makes it self-healing: the desktop app re-reports on
   * every poll, so a status that stops arriving (app quit, laptop asleep, the
   * TimeTracking server gone) ages out instead of leaving a stale glyph over an
   * empty chair.
   */
  private readonly workStatuses = new Map<number, { status: WorkStatus; at: number }>();
  /**
   * Self-reported Mumble channel name per player avatar id — the desktop app is
   * the only thing that knows it, since the Mumble connection lives there.
   *
   * No timestamp, unlike workStatuses above, and the difference is the report's
   * shape rather than an oversight: a working status is POLLED, so silence is
   * ambiguous and has to age out, while a channel is reported on the EDGE — the
   * client sends '' the moment it disconnects or moves, and the only way to stop
   * reporting without saying so is to lose the session, which deletes the entry
   * outright (onLeave, portalGo).
   */
  private readonly voiceChannels = new Map<number, string>();
  /** Seconds until the next player-spot checkpoint (see checkpointSpots). */
  private spotCheckpointIn = SPOT_CHECKPOINT_SEC;
  /** The spot last written per user, so a checkpoint only writes what changed —
   *  a world full of people standing still costs nothing. */
  private readonly savedSpots = new Map<string, string>();
  /** Arcade IPX-multiplayer lobby (drops leavers from matches on disconnect). */
  private arcadeLobby?: { onLeave: (sessionId: string) => void };
  /** Owned-avatar sprite data currently needed in THIS zone (skin id → data),
   *  distributed only to clients here so a client loads just the avatars of
   *  players standing in its zone. Refcounted by concurrent sessions. */
  /**
   * The avatars of the players in this zone, as they are STORED: a packed row (the sheet as
   * bytes plus its geometry) or, for a legacy row, SpriteData. Nothing here needs pixels —
   * every read feeds `avatarMessage`, which turns the entry into a URL and a frame size — so
   * the shape is deliberately whatever the store handed over, with no unpacking on the way.
   */
  private readonly avatarData = new Map<string, Record<string, unknown> | LoadedCharacterData>();
  private readonly avatarRefs = new Map<string, number>();
  /** Recent zone-local chat (ring buffer), sent to joiners; + per-session rate limit.
   *  `ambient` marks a line the WORLD said (a talking object) rather than a
   *  person: it reads the same in the log but must not light the unread dot, or
   *  a whale announcing the hour would leave it permanently lit — the same
   *  reasoning the enter/leave lines already carry (see chatUI.addChatLine). */
  private readonly chatLog: Array<{ from: string; text: string; at: number; ambient?: boolean }> = [];
  private readonly lastChatAt = new Map<string, number>();
  /** Meeting-room membership (Action's 'meetingRoom' kind) — a
   *  "furniture:col,row" or "tile:col,row" key (disambiguates a furniture
   *  item's own anchor tile from a tile-action area's flood-fill anchor, in
   *  case they ever coincide — see meetingRoomKey) → set of player avatar
   *  ids. Furniture-sourced membership is granted on ARRIVAL — the avatar has
   *  to walk to the item (actionApproach -> handleActionArrivals) and leaves
   *  with meetingRoomLeave. Being there is the gate, and it is the only way in:
   *  a 'meetingRoomJoin' message used to add membership from any distance,
   *  which let an account be in a call it was not standing at; nothing sent it
   *  and it is gone. Tile-sourced membership is automatic
   *  (walk in/out), maintained every tick by updateMeetingRoomMembership,
   *  called from syncCharacters. */
  private readonly meetingRooms = new Map<string, Set<number>>();
  /** Each player's current tile-sourced meeting-room key (a subset of the
   *  map above's keys — furniture-sourced membership doesn't use this), or
   *  absent — so updateMeetingRoomMembership can detect enter/exit without
   *  re-deriving "was I in one before" from the sets themselves. */
  private readonly lastMeetingRoomArea = new Map<number, string>();
  /** Each player's OWN area anchor, alongside the key above — with same-named areas
   *  sharing one call, the key no longer says where somebody stands, and the roster has
   *  to (see meetingRoomMembersMsg: each member carries their own anchor so a client can
   *  tell who is in another area). */
  private readonly lastMeetingAnchor = new Map<number, { col: number; row: number }>();
  /** identity → the canonical anchor of the areas sharing it, rebuilt when the layout
   *  object changes. The canonical one is the raster-first of them, so the call keeps one
   *  stable address even as areas are painted or removed elsewhere. */
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
  /** Server-only pet behaviour tree (decides pet activity; not in client bundle). */
  private readonly petBrain = new PetBrain();

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
  /**
   * One user's avatar was saved — over HTTP, so no room handled it (see artSaveApi.ts).
   *
   * Only the rooms this player is standing in have anything to do: re-read the stored row and
   * announce that one skin. Rooms elsewhere hold no copy of it, so the check is not an
   * optimisation but the whole condition.
   */
  private readonly onAvatarChanged = (userId: string): void => {
    const sid = playerAvatarSkinId(userId);
    if (!this.avatarData.has(sid)) return;
    const row = appStore.assetRow('playerAvatar', userId);
    if (row === undefined) return;
    this.avatarData.set(sid, row as Record<string, unknown>);
    this.broadcast('m', this.avatarMessage(sid, row));
  };

  private readonly onAssetChanged = (type: ResyncTarget): void => {
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

  /** Somebody anywhere in the world joined, switched zone or left (see
   *  presence.ts) — push the refreshed roster to this room's clients. Coalesced
   *  onto the next macrotask: a zone switch is a leave plus a join, and a server
   *  restart reconnects everyone at once, which would otherwise be one broadcast
   *  per user per room. */
  private presencePush: ReturnType<typeof setTimeout> | null = null;
  private readonly onPresenceChanged = (): void => {
    if (this.presencePush !== null) return;
    this.presencePush = setTimeout(() => {
      this.presencePush = null;
      this.broadcastOnlineUsers();
    }, 0);
  };

  /** This zone's saved layout changed on disk via Tiled (see
   *  tiled/zonePushApi.ts's push endpoint) — nothing else told this
   *  already-running room to pick it up, unlike a loadLayout/saveLayout(As)
   *  message which reloads the room that issued it as a side effect. Same
   *  reload as those: rebuild the engine from the (now different) active
   *  layout and rebroadcast to everyone standing here. */
  private readonly onZoneLayoutChanged = (zoneId: string): void => {
    if (this.zone.id !== zoneId) return;
    this.applyZoneMap();
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
    // The registry is the only source of zones now (no builtin table to fall back
    // on), and ZoneStore.seed guarantees the default one exists — so an unknown or
    // absent id lands there rather than in a synthesised config.
    this.zone = (options.zone && this.zones.get(options.zone)) || this.zones.get(DEFAULT_ZONE) || { id: DEFAULT_ZONE, label: DEFAULT_ZONE };
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

    // The zone's map — one per zone, pushed from Tiled (see zoneLayout).
    this.store = new ZoneMapStore();
    this.os = new OfficeState(this.zoneLayout()); // portals derive from placed furniture (P5 v2)
    // What the talking objects say between the hours — a file in the repo, read
    // and bounded on the server (see quotes.ts), never by the engine.
    this.os.setQuotes(loadQuotes());
    // Pet decisions run through the server-only mistreevous brain (kept out of
    // the client bundle). The engine remains the movement actuator.
    this.os.setPetDecider((_pet, aff) =>
      this.petBrain.decide({
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
    this.applyZonePetFilter(); // which pet variants spawn in this zone (per-zone)

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
    controlBus.on(AVATAR_CHANGED_EVENT, this.onAvatarChanged);
    controlBus.on(ZONE_LAYOUT_CHANGED_EVENT, this.onZoneLayoutChanged);
    controlBus.on(PRESENCE_EVENT, this.onPresenceChanged);

    this.registerRoomHandlers();
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
    controlBus.off(AVATAR_CHANGED_EVENT, this.onAvatarChanged);
    controlBus.off(ZONE_LAYOUT_CHANGED_EVENT, this.onZoneLayoutChanged);
    controlBus.off(PRESENCE_EVENT, this.onPresenceChanged);
    if (this.presencePush !== null) clearTimeout(this.presencePush);
    this.zones?.close();
  }

  onJoin(client: Client, options?: { arrive?: boolean }): void {
    // Decoded assets so the client can render. The layoutLoaded from the static
    // bundle is replaced by the live active layout; agent state flows via schema.
    client.send('m', this.bundle.providerCapabilities);
    for (const m of this.bundle.messages) {
      if (m.type !== 'layoutLoaded') client.send('m', m);
    }
    client.send('m', this.zoneMapMessage());
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
    // The roster this join just changed. Sent explicitly rather than left to the
    // coalesced PRESENCE_EVENT broadcast, so the list is populated even for a
    // viewer who joins while nothing else is moving.
    if (userId) client.send('m', this.onlineUsersMessage());
    const characterSkin = userId ? appStore.getCharPref(userId) : null;

    // Zone-local avatar loading: give the joiner every owned avatar already
    // present in this zone, so it can render the players standing here without
    // pulling in avatars from other zones.
    for (const [sid, data] of this.avatarData) client.send('m', this.avatarMessage(sid, data));

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
      this.broadcast('m', this.avatarMessage(sid, data));
    }
    // Everyone who joins gets a player avatar. Active entry (menu switch or
    // portal) → land at the zone's arrival tile; a plain refresh (or a reconnect
    // after the server restarted) resumes the spot this user left — tile, facing,
    // and the chair or appliance they were holding. Entering a zone on purpose
    // deliberately forgets it: you asked to arrive, not to come back.
    const resume = !options?.arrive && userId ? appStore.getPlayerSpot(userId, this.zone.id) : null;
    const spawnAt = options?.arrive ? this.zone.arrive : (resume ?? undefined);
    // The avatar's name is always the player's display name (username or userId).
    const displayName = username || userId || undefined;
    const playerId = this.os.addPlayer(playerSkin ?? undefined, displayName, spawnAt ?? undefined);
    // Placement first, then the resume: addPlayer answers "where does somebody go
    // when we have to choose" (never a furniture tile), which is not the same
    // question as "where were they" — a chair IS a furniture tile. See resumePlayer.
    if (resume) this.os.resumePlayer(playerId, resume);
    this.players.set(client.sessionId, playerId);
    // Announce a real user's arrival to everyone in the zone. Agents/pets are
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
      // Wire compatibility, checked by the client (see PROTOCOL_VERSION).
      protocol: PROTOCOL_VERSION,
    });
    // Personal viewer prefs (per user; anonymous viewers get the defaults).
    const vs = userId ? appStore.getViewerSettings(userId) : defaultViewerSettings();
    client.send('m', { type: 'settingsLoaded', ...vs });
  }

  onLeave(client: Client): void {
    this.arcadeLobby?.onLeave(client.sessionId); // drop from any arcade match
    const { userId } = authOf(client);
    if (userId) presence.leave(userId);
    const playerId = this.players.get(client.sessionId);
    if (playerId !== undefined) {
      // Persist the spot (logged-in users resume there next time). The periodic
      // checkpoint already has a recent one; this is the exact final word for a
      // leave we actually saw.
      if (userId) this.saveSpot(userId, playerId);
      // Announce departure (before removePlayer so chatNameFor still resolves the
      // avatar name). Only for real users, and only when their last session in
      // this zone is leaving.
      if (userId && !this.hasOtherSession(client)) {
        this.broadcast('m', { type: 'system', text: `${this.chatNameFor(client)} left the zone.` });
      }
      this.leaveAllMeetingRooms(playerId);
      this.os.removePlayer(playerId);
      this.players.delete(client.sessionId);
      this.workStatuses.delete(playerId);
      this.voiceChannels.delete(playerId);
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
    // The write-dedup entry for this user goes with them: it only exists to skip
    // rewriting an unchanged spot while they are here, and a room that outlives a
    // thousand visitors would otherwise keep a thousand of them.
    if (userId && !this.hasOtherSession(client)) this.savedSpots.delete(`${userId}|${this.zone.id}`);
  }

  /** The effective action (see Action) of the furniture item anchored
   *  exactly at this tile, or null — mirrors effectiveAction: the placed
   *  item's own override if set, else the catalog's legacy conference/
   *  arcade/meetingRoom/appliance flags. Client approach messages always
   *  carry a furniture item's own anchor col/row (never just any tile its
   *  footprint covers), so an exact match is enough. */
  private actionAt(col: number, row: number): Action | null {
    const item = this.os.getLayout().furniture.find((f) => f.col === col && f.row === row);
    return item ? effectiveAction(item, entryFor(item)) : null;
  }

  /** A meeting-room membership key, namespaced by source so a furniture
   *  item's own anchor tile can never collide with a tile-action area's
   *  flood-fill anchor even if they happen to share a col/row. */
  /**
   * The call a meeting-area tile belongs to: its key, its own area anchor, and the
   * canonical anchor the call is addressed by.
   *
   * Areas that agree about name AND video share one call even when they do not touch —
   * two floors, two buildings, the smoking corner outside. Adjacency already merges what
   * a mapper draws as one room (see computeActionAreas); this merges what they NAME as
   * one. Unnamed areas keep their own anchor as identity: there is nothing to tell them
   * apart by, so each stays its own call, exactly as before.
   *
   * `video` rides in the key on purpose. Two same-named areas that disagree about it
   * cannot be one call without one side silently losing its setting, so they stay apart —
   * the same reasoning meetingIdentity uses for adjacency.
   */
  private tileMeetingRoom(col: number, row: number): { key: string; anchor: { col: number; row: number }; canonical: { col: number; row: number }; video: boolean } | null {
    const found = this.os.meetingAreaAt(col, row);
    if (!found) return null;
    const key = found.slug ? namedMeetingKey(found.slug, found.video) : this.meetingRoomKey('tile', found.anchor.col, found.anchor.row);
    return { key, anchor: found.anchor, canonical: found.canonical, video: found.video };
  }

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
    // A named tile call carries the answer in its own key — it is part of the identity,
    // so areas that disagree never share a call in the first place.
    const named = parseNamedMeetingKey(key);
    if (named) return named.video;
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


  /**
   * An avatar announcement: its art as a URL, not as pixels.
   *
   * An avatar is 77 KB of sprite data and every viewer in the zone gets every
   * avatar standing there, so this was the largest repeated payload in the world.
   * As a PNG behind /art it is ~3.5 KB, and the browser caches it across joins.
   * The pixels stay as a fallback only when the art cannot be addressed at all.
   */
  private avatarMessage(sid: string, data: unknown): Record<string, unknown> {
    const entry = withArtUrl('character', sid, data, { w: CHAR_FRAME_W, h: CHAR_FRAME_H }) as Record<string, unknown>;
    // Same shape either way: with a url the pixels are behind it, without one they are
    // still in `data`. The spec rides along because a sheet cannot be sliced without it.
    return entry.url ? { type: 'playerAvatar', id: sid, ...entry } : { type: 'playerAvatar', id: sid, data };
  }

  /** Current members of a meeting room (by its "source:col,row" key), for broadcast. */
  private meetingRoomMembersMsg(key: string): Record<string, unknown> {
    const parsed = this.parseMeetingRoomKey(key);
    const ids = this.meetingRooms.get(key) ?? new Set<number>();
    // Each member's OWN area anchor rides along: with same-named areas sharing one call,
    // the message's address is the canonical anchor and no longer says where anybody
    // stands — the client compares these to tell who is somewhere else (see
    // onMeetingAreaMembers).
    const members = [...ids].map((id) => {
      const own = this.lastMeetingAnchor.get(id);
      return { id, name: this.os.getCharacter(id)?.folderName || 'Guest', ...(own ? { col: own.col, row: own.row } : {}) };
    });
    const address = parsed ?? this.addressForMeetingKey(key);
    return {
      type: 'meetingRoomMembers',
      source: address?.source ?? 'furniture',
      col: address?.col ?? 0,
      row: address?.row ?? 0,
      video: this.videoForMeetingRoomKey(key),
      members,
    };
  }

  /** The (col,row) a named tile call is addressed by — its canonical anchor. Named keys
   *  carry no coordinates, so this is where the roster and the token request get theirs. */
  private addressForMeetingKey(key: string): { source: 'furniture' | 'tile'; col: number; row: number } | null {
    const named = parseNamedMeetingKey(key);
    if (!named) return null;
    const canonical = this.os.meetingCanonicalAnchor(named.slug, named.video);
    return canonical ? { source: 'tile', col: canonical.col, row: canonical.row } : null;
  }

  /** Recompute which meeting-room tile area (if any) a player's current
   *  tile belongs to and update membership + broadcast on any change.
   *  Called once per player per tick from syncCharacters — unlike a
   *  furniture-sourced meeting room, there's no explicit join/leave
   *  message; standing on the tile *is* the membership. */
  private updateMeetingRoomMembership(playerId: number, col: number, row: number): void {
    const room = this.tileMeetingRoom(col, row);
    const newKey = room?.key ?? null;
    if (room) this.lastMeetingAnchor.set(playerId, room.anchor);
    else this.lastMeetingAnchor.delete(playerId);
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
    this.lastMeetingAnchor.delete(playerId);
  }

  /** Display name for a chatter: their avatar's name, else display name, else Guest. */
  /** Keep a line in the zone's recent-chat ring buffer (50, sent to joiners).
   *  Shared by the 'chat' handler and the talking objects so there is one cap
   *  and one place that trims it. */
  private logChat(from: string, text: string, at: number, ambient = false): void {
    this.chatLog.push(ambient ? { from, text, at, ambient } : { from, text, at });
    if (this.chatLog.length > 50) this.chatLog.shift();
  }

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

  // ── The zone's map (server-authoritative) ────────────────────────

  /**
   * The map this room simulates. A zone has exactly one, pushed from Tiled (see
   * tiled/zonePushApi.ts); zones are independent.
   *
   * The empty-field fallback is defensive, not a feature: a zone can exist in the
   * registry with no map yet (its first push failed, or someone deleted the row),
   * and OfficeState needs SOMETHING to build a tile grid from. Rendering an empty
   * field beats refusing to open the room, and one push fixes it. Nothing
   * generates content any more — the builtin layouts (bundled office, generated
   * plaza) are gone with the in-game editors that needed a fallback to edit.
   */
  private zoneLayout(): OfficeLayout | undefined {
    const stored = this.store.get(this.zone.id) as OfficeLayout | null;
    if (stored) return stored;
    return emptyZoneMap(this.zone.cols ?? DEFAULT_COLS, this.zone.rows ?? DEFAULT_ROWS);
  }

  /** Apply this zone's pet spawn set to the engine. null/undefined = all active
   *  variants; an array = only those `"<kind>_<variant>"` keys. */
  private applyZonePetFilter(): void {
    const pets = this.zone.pets;
    if (pets == null) {
      this.os.setPetSpawnFilter(() => true);
    } else {
      const set = new Set(pets);
      this.os.setPetSpawnFilter((kind, variant) => set.has(`${kind}_${variant}`));
    }
  }

  private zoneMapMessage(): Record<string, unknown> {
    return {
      type: 'layoutLoaded',
      // What this room actually simulates, so the client renders the right
      // floor/walls even when the zone has no stored map (see zoneLayout).
      layout: this.os.getLayout(),
      force: true,
    };
  }

  /** Zones a viewer may see/travel to — the full registry. */
  private zoneListMessage(): Record<string, unknown> {
    return { type: 'zoneList', zones: this.zones.list(), current: this.zone.id };
  }

  /**
   * Everyone logged in right now, world-wide — the HUD's online list. Only real
   * accounts appear: agents and pets are engine entities, never sessions, so
   * they never reach presence.ts in the first place.
   *
   * The same facts `/users online` prints (name, id, ★ admin, zone), plus the
   * zone's label so the list reads like the zone switcher rather than showing
   * raw ids, and the Mumble channel each one is in — the roster's version of
   * what a hover already says over a body in this room, and the only place it
   * can be said about somebody standing two zones away. Nothing here is secret
   * to a signed-in viewer — that command has always been in the `user` group —
   * but it IS account data, so it goes only to authenticated clients.
   */
  private onlineUsersMessage(): Record<string, unknown> {
    const users = presence
      .list()
      .map((u) => ({
        userId: u.userId,
        name: u.name,
        zone: u.zone,
        zoneLabel: this.zones.get(u.zone)?.label ?? u.zone,
        isAdmin: !!userStore.get(u.userId)?.isAdmin,
        voice: u.voice,
      }))
      .sort((a, b) => a.name.localeCompare(b.name) || a.userId.localeCompare(b.userId));
    return { type: 'onlineUsers', users };
  }

  private broadcastOnlineUsers(): void {
    const msg = this.onlineUsersMessage();
    for (const client of this.clients) {
      if (authOf(client).userId) client.send('m', msg);
    }
  }

  /** Re-read + push the zone registry to everyone here. Deliberately unfiltered:
   *  a private zone stays visible so its name isn't a secret, and entry — not
   *  listing — is what gateEntry refuses (see ZoneConfig.private). */
  private broadcastZoneList(): void {
    for (const client of this.clients) client.send('m', this.zoneListMessage());
  }

  /** Rebuild the simulation from the zone's (re-pushed) map and push it to all
   *  viewers (floor/walls via layoutLoaded; furniture re-syncs through schema). */
  private applyZoneMap(): void {
    const layout = this.zoneLayout();
    if (layout) this.os.rebuildFromLayout(layout);
    this.lastFurnitureRef = null; // force furniture re-sync
    this.broadcast('m', this.zoneMapMessage());
  }

  /** Everything a viewer may send that isn't asset/zone administration. (Was
   *  registerLayoutHandlers: the five layout messages it opened with —
   *  requestLayouts/loadLayout/saveLayout/saveLayoutAs/deleteLayout — went with
   *  the named-layouts model. A zone has one map and it arrives by being
   *  pushed.) */
  private registerRoomHandlers(): void {
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
      this.logChat(from, text, now);
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
    // officeState.useAppliance/stationId, the same mechanism pets use for
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
        if (this.actionAt(col, row)?.kind !== 'meetingManager') return;
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
    // 'meetingManager' kiosk action instead, which mints its own password-
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
        // For a tile call the key comes from the AREA at those coordinates, not from the
        // coordinates themselves: several areas share one named call, and a client asks
        // with the address it was given (the canonical anchor) or with its own.
        const key = source === 'tile' ? this.tileMeetingRoom(col, row)?.key ?? '' : this.meetingRoomKey(source, col, row);
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
            : this.voiceRoom(`${this.zone.id}-meet:${key.startsWith('tile:n:') ? key.slice('tile:'.length) : `${col},${row}`}`);
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

    // ── Zone registry (edit/delete needs zone-admin or global-admin;
    // privacy/ACL/invite is owner-only) ──
    //
    // No createZone: a zone comes into being by pushing a map for an id that has
    // none yet (see tiled/zoneImport.ts, which registers it with the defaults),
    // because a zone without a map is nothing to stand in. What used to be
    // created here was an empty wall-bordered field waiting for the in-game
    // editor — and that editor is gone.
    this.onMessage('requestZones', (client) => client.send('m', this.zoneListMessage()));

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
      // The default zone can never be deleted (enforced in the store).
      if (this.zones.delete(msg.id)) {
        this.store.delete(msg.id); // the zone's map goes with it
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

    // Per-zone pet spawn set: which variants appear in a zone (null = all).
    this.onMessage('setZonePets', (client, msg: { id?: string; pets?: string[] | null }) => {
      if (typeof msg?.id !== 'string' || !this.may(client, 'zone.edit', msg.id)) return;
      const pets =
        msg.pets === null || msg.pets === undefined
          ? null
          : Array.isArray(msg.pets)
            ? msg.pets.filter((x): x is string => typeof x === 'string').slice(0, 256)
            : undefined;
      if (pets === undefined) return; // malformed
      if (this.zones.setPet(msg.id, pets)) {
        if (msg.id === this.zone.id) {
          this.zone = this.zones.get(msg.id) ?? this.zone;
          this.applyZonePetFilter(); // takes effect now (despawns disallowed pets)
        }
        this.broadcastZoneList();
      }
    });

    // A player's desktop app reporting its TimeTracking status. Purely
    // cosmetic — it grants nothing and unlocks nothing — which is what makes it
    // safe to accept unverified: the server has no access to anyone's
    // TimeTracking and could not check it even in principle. Validated to the
    // closed WorkStatus set so the only thing a patched client can do is show a
    // glyph that isn't true of it, and keyed by the sender's OWN avatar so it
    // can never set anyone else's.
    this.onMessage('workStatus', (client, msg: { status?: unknown }) => {
      const id = this.players.get(client.sessionId);
      if (id === undefined) return;
      if (!isWorkStatus(msg?.status)) return;
      this.workStatuses.set(id, { status: msg.status, at: Date.now() });
    });

    // A player's desktop app reporting which Mumble channel it is sitting in, so
    // a hover says where to go to talk to them. Cosmetic and unverifiable for
    // exactly the same reason as workStatus above — the Mumble connection lives
    // in the Electron main process and this server holds none — so it is bounded
    // rather than checked, and keyed by the sender's OWN avatar so it can never
    // name anyone else's. `cleanName` is what bounds it, and it is doing real
    // work here: the name comes from a Mumble server nobody in this world
    // administers, and it lands in every other viewer's tooltip.
    this.onMessage('voiceChannel', (client, msg: { name?: unknown }) => {
      const id = this.players.get(client.sessionId);
      if (id === undefined) return;
      const name = cleanName(msg?.name, MAX_NAME_LEN);
      if (name) this.voiceChannels.set(id, name);
      else this.voiceChannels.delete(id);
      // The same fact reaches two surfaces that ask different questions, so it
      // is stored twice rather than derived: the map above is keyed by PAWN and
      // feeds this room's synced characters (the hover overlay), while presence
      // is keyed by ACCOUNT and feeds the cross-zone online list — which has to
      // answer for people no room here can see. One writer, so they cannot drift.
      const { userId } = authOf(client);
      if (userId) presence.setVoice(userId, name);
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
    // Whether an 'iframe' action floats over the game or docks beside it. Pure
    // presentation, and self-only: it decides nothing about what this viewer may
    // open — the action's URL comes from the map, already sanitized on save.
    this.onMessage('setIframeOverlay', (client, msg: { enabled?: boolean }) => {
      const { userId } = authOf(client);
      if (userId) appStore.setViewerSetting(userId, 'iframeOverlay', !!msg?.enabled);
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
      if (!validCharacterData(toSave)) return;
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

    // Right-click "warp": instantly teleport the viewer's own avatar to a
    // walkable tile (server validates walkability — see
    // OfficeState.warpPlayer; a non-walkable target is a silent no-op, same
    // as any other rejected movement).
    this.onMessage('playerWarp', (client, msg: { col?: number; row?: number }) => {
      const id = this.players.get(client.sessionId);
      if (id === undefined) return;
      const col = Math.floor(Number(msg?.col));
      const row = Math.floor(Number(msg?.row));
      if (Number.isInteger(col) && Number.isInteger(row)) this.os.warpPlayer(id, col, row);
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
      this.workStatuses.delete(id);
      this.voiceChannels.delete(id);
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

  /** The asset types a CLIENT may write — now exactly the types the database may override at
   *  all (ASSET_TYPES). It used to be narrower than that list, then wider than the callers: an
   *  `image` write only ever came from the zone importer, and a `furniture` write from nobody
   *  at all once art moved into Tiled tilesets. Both are gone from the union, because a write
   *  path with no caller is still a write path. */
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
      afterDeleteUser: (loginId) => this.zones.disownZonesOf(loginId),
    });
  }

  // ── Player-owned avatars ─────────────────────────────────────────

  /** This user's private avatar sprite data (keyed by userId), creating it on
   *  first use by copying their old gallery pin (migration) or the first template. */
  /**
   * The user's own avatar, seeded from a gallery skin the first time they arrive.
   *
   * Read as the STORED row (`assetRow`), not unpacked: this is announced, not drawn, so the
   * pixels are nobody's business here — and unpacking a sheet just to hand it back would decode
   * a PNG on every join.
   *
   * The seed is where a bundled skin and a stored one differ, and getting that wrong was a real
   * bug: a bundled entry carries its sheet as a Buffer (the FILE, see assetLoader), and
   * `cloneCharacterData` is a JSON round trip — which turned the Buffer into
   * `{"type":"Buffer","data":[137,80,...]}`, stored 10 KB of number array for a 2.8 KB sheet,
   * and put that array in the `playerAvatar` message of every viewer instead of a URL. So a
   * bundled source is packed properly here: the file's bytes plus the geometry, read
   * from the PNG header rather than by decoding it.
   */
  private ensurePlayerAvatar(userId: string): Record<string, unknown> | LoadedCharacterData {
    const existing = appStore.assetRow('playerAvatar', userId);
    if (existing !== undefined) return existing as Record<string, unknown>;
    const chars = this.bundle.raw.characters as Array<{ id: string; data: Record<string, unknown> }>;
    const oldPin = appStore.getPlayerPref(userId);
    const src = (oldPin ? chars.find((c) => c.id === oldPin) : undefined) ?? chars[0];
    const data = avatarSeedFrom(src.data);
    appStore.setPlayerAvatar(userId, data);
    return data;
  }


  /** Persist a user's avatar data and push it to everyone in this zone (live
   *  re-render). The skin id stays pa:<userId>; only the sprite data changes. */
  private setAvatar(userId: string, data: Record<string, unknown> | LoadedCharacterData): void {
    appStore.setPlayerAvatar(userId, data);
    const sid = playerAvatarSkinId(userId);
    if (this.avatarData.has(sid)) this.avatarData.set(sid, data);
    this.broadcast('m', this.avatarMessage(sid, data));
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

  /** Re-read the (already re-merged — see invalidateMergedBundle) shared bundle,
   *  re-apply the affected type to this room's engine, and broadcast. */
  private reapplyAsset(type: ResyncTarget): void {
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
        this.os.rebuildFromLayout(this.zoneLayout() ?? this.os.layout);
        this.lastFurnitureRef = null; // force furniture re-sync
        break;
    }
    const msgType = messageTypeForAsset(type);
    const message = this.bundle.messages.find((m) => m.type === msgType);
    if (message) this.broadcast('m', message);
  }

  // ── Simulation → schema ──────────────────────────────────────────

  private tick(dt: number): void {
    // Don't simulate a zone no human is watching. The room disposes when empty
    // (autoDispose), so this normally won't fire with zero clients — but guard the
    // transient tick as the last client leaves so we never spawn/pathfind pets or
    // run syncs for nobody. Agents' *logical* state is driven by feed events
    // (applyEvent, via onEvent — independent of this tick), so skipping only drops
    // movement/animation + client syncs; a joining client gets the full state on
    // its first tick.
    if (this.clients.length === 0) return;
    this.os.update(Math.min(dt, 0.1));
    this.handleActionArrivals();
    this.handleSpokenLines();
    this.syncCharacters();
    this.syncPets();
    this.syncFurniture();
    this.checkpointSpots(dt);
  }

  /**
   * Write every player's spot down every few seconds.
   *
   * `onLeave` is the exact record of a departure, but it only runs for departures
   * this process lives to see. A restart (a deploy, a crash, a `kill -9`, a dev
   * watcher) takes the whole world with it, and the position nobody had written
   * yet was the one everybody came back to: the client reconnects by reloading
   * (see OfficeScene.handleDisconnect), joins a fresh world with no stored spot,
   * and gets a random free tile. So the truth is checkpointed while it is still
   * true, and a restart costs at most the last few seconds of walking.
   *
   * Cheap by construction: one pass over the clients, and a write only for a
   * player whose spot actually differs from the last one stored.
   */
  private checkpointSpots(dt: number): void {
    this.spotCheckpointIn -= dt;
    if (this.spotCheckpointIn > 0) return;
    this.spotCheckpointIn = SPOT_CHECKPOINT_SEC;
    for (const client of this.clients) {
      const { userId } = authOf(client);
      const playerId = this.players.get(client.sessionId);
      if (userId && playerId !== undefined) this.saveSpot(userId, playerId);
    }
  }

  /** Persist one player's spot for this zone, skipping a write when nothing has
   *  changed since the last one. */
  private saveSpot(userId: string, playerId: number): void {
    const spot = this.os.playerSpot(playerId);
    if (!spot) return;
    const key = `${userId}|${this.zone.id}`;
    const encoded = JSON.stringify(spot);
    if (this.savedSpots.get(key) === encoded) return;
    this.savedSpots.set(key, encoded);
    appStore.setPlayerSpot(userId, this.zone.id, spot);
  }

  /** Players who reached a furniture action's stand tile this tick — add
   *  'meetingRoom' arrivals to that room's membership; tell just that
   *  client to open its own local UI for everything else (game picker /
   *  room-manage dialog / iframe / the other zones as destinations for a
   *  portal — this room has no state of its own to update for those, unlike
   *  a meeting-room join). */
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
      if (action.kind === 'portal') {
        const zones = this.zones
          .list()
          .filter((z) => z.id !== this.zone.id)
          .map((z) => ({ id: z.id, label: z.label }));
        if (zones.length) client.send('m', { type: 'portalOptions', zones });
        continue;
      }
      client.send('m', {
        type: 'actionReady',
        kind: action.kind,
        col,
        row,
        ...(action.kind === 'iframe' ? { url: action.url } : {}),
      });
    }
  }

  /**
   * What a talking object said this tick, to everyone in the zone.
   *
   * The engine decides WHEN and WHAT (the hour turning, see
   * talkingObjects.ts); this is only the delivery. It is a broadcast rather
   * than synced state on the furniture, and that is the one decision here: a
   * bubble is a moment, not a fact about the world. Syncing it would cost two
   * fields on every furniture placement every client decodes, forever, so that
   * somebody joining at 9:00:04 could see the tail of a bubble — while the
   * announcement itself is authoritative either way, because the server is what
   * says the hour has turned.
   *
   * Nothing here is client input: no handler, no payload, nothing to validate.
   * The text is the server's own — the hour (`H UHR, H UHR !!!`) or a line from
   * the repo's quote pool, capped at 120 characters when that file is read (see
   * quotes.ts) — so it is bounded before it ever gets here.
   */
  private handleSpokenLines(): void {
    const at = Date.now();
    for (const { col, row, text, from } of this.os.takeSpokenLines()) {
      // One message, two places: the bubble over the piece and a line in the
      // chat log. The client does both from this, so they cannot disagree about
      // what was said — and a viewer who was looking elsewhere still has it.
      this.broadcast('m', { type: 'furnitureSay', col, row, text, from });
      // Kept for joiners too, so the log a newcomer reads is the log everybody
      // else is reading. Bounded twice over: the ring buffer above, and a piece
      // that speaks at most twice an hour.
      this.logChat(from, text, at, true);
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

  /** A player's reported working status, or '' once it has gone stale. The
   *  desktop app re-reports every poll interval, so silence for several of them
   *  means it is no longer speaking for this player and the glyph should go. */
  private freshWorkStatus(id: number): WorkStatus {
    const entry = this.workStatuses.get(id);
    if (!entry) return '';
    if (Date.now() - entry.at > WORK_STATUS_TTL_MS) {
      this.workStatuses.delete(id);
      return '';
    }
    return entry.status;
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
      cs.isActive = ch.isActive;
      cs.reading = isReadingTool(ch.currentTool);
      cs.bubble = ch.bubbleType ?? '';
      cs.bubbleTimer = ch.bubbleTimer;
      cs.matrixEffect = ch.matrixEffect ?? '';
      cs.matrixEffectTimer = ch.matrixEffectTimer;
      cs.isSubagent = ch.isSubagent;
      cs.controller = ch.controller;
      cs.afk = ch.afk ?? false;
      // Working status, as last reported by this player's own desktop app (only a human-controlled
      // pawn has one). Synced from here rather than fetched per client so the hover overlay shows
      // everyone the same thing, and so nobody's client learns anything about anyone else's
      // TimeTracking beyond the glyph.
      cs.workStatus = ch.controller === ControllerKind.HUMAN ? this.freshWorkStatus(ch.id) : '';
      // Likewise the Mumble channel: a pawn nobody sits behind runs no voice client.
      cs.voiceChannel = ch.controller === ControllerKind.HUMAN ? this.voiceChannels.get(ch.id) ?? '' : '';
      cs.folderName = ch.folderName ?? '';
      cs.teamName = ch.teamName ?? '';
      cs.agentName = ch.agentName ?? '';
      cs.isTeamLead = ch.isTeamLead ?? false;
      cs.activity = this.activity.get(ch.id) ?? '';
      cs.inputTokens = ch.inputTokens;
      cs.outputTokens = ch.outputTokens;
      if (ch.controller === ControllerKind.HUMAN) this.updateMeetingRoomMembership(ch.id, ch.tileCol, ch.tileRow);
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
      // Every pawn says what drives it, pets included: a client can then ask one question of any
      // pawn instead of inferring the answer from which collection it came out of.
      ps.controller = ControllerKind.PET;
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
      fs.id = p.id;
      fs.col = p.col;
      fs.row = p.row;
      fs.name = p.name ?? '';
      const action = effectiveAction(p, entryFor(p));
      fs.action = action ? JSON.stringify(action) : '';
      fs.flippedHorizontally = !!p.flippedHorizontally;
      fs.flippedVertically = !!p.flippedVertically;
      // -1 = "not overridden" throughout (see FurnitureSync) — never coerce an
      // absent override to false, or every inherited seat arrives unsittable.
      fs.canSitOn = p.canSitOn === undefined ? -1 : p.canSitOn ? 1 : 0;
      fs.petCanSitOn = p.petCanSitOn === undefined ? -1 : p.petCanSitOn ? 1 : 0;
      fs.canWalkOver = p.canWalkOver === undefined ? -1 : p.canWalkOver ? 1 : 0;
      fs.opacity = p.opacity === undefined ? 255 : Math.max(0, Math.min(255, Math.round(p.opacity * 255)));
      fs.sitFacing = p.sitFacing ?? -1;
      fs.backgroundTiles = p.backgroundTiles ?? -1;
      fs.onState = p.onState ?? '';
      fs.zOffset = p.zOffset ?? 0;
      // 0 = the art's own size (see FurnitureSync.width).
      fs.width = p.width ?? 0;
      fs.height = p.height ?? 0;
      // 0 = upright. Only ever a quarter turn: the import refuses anything else.
      fs.angle = p.angle ?? 0;
      this.state.furniture.push(fs);
    }
  }
}
