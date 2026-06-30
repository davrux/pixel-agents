import { Room, type AuthContext, type Client } from '@colyseus/core';
import { AccessToken } from 'livekit-server-sdk';

import { resolveZone, conferenceKey, cleanName, playerAvatarSkinId } from '@pixel/shared';
import type { AgentEvent, ZoneConfig } from '@pixel/shared';
import type { LoadedCharacterData } from '@pixel/shared/office/sprites/spriteData.js';
import { CharacterSync, EntitySync, FurnitureSync, PetSync, RoomState } from '@pixel/shared/schema';
import { OfficeState, getCharacterPose, isReadingTool } from '@pixel/shared/office/engine/index.js';
import { PET_DRINK_CHANCE, PET_SIT_CHANCE, PET_TALK_CHANCE } from '@pixel/shared/office/constants.js';
import { Direction, PetKind } from '@pixel/shared/office/types.js';
import { setProviderCapabilities } from '@pixel/shared/office/toolUtils.js';
import { setCharacterTemplates, setPetTemplates } from '@pixel/shared/office/sprites/spriteData.js';
import { buildDynamicCatalog, getCatalogEntry } from '@pixel/shared/office/layout/furnitureCatalog.js';
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
import { ASSET_TYPES, buildMerged, messageTypeForAsset, type AssetType } from '../assetOverrides.js';
import { hasValidSession, userIdFromCookie } from '../auth.js';
import { userStore, UserStore, isValidPassword } from '../userStore.js';
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
}

function authOf(client: Client): AuthInfo {
  const a = client.auth as Partial<AuthInfo> | undefined;
  return { userId: a?.userId ?? '', username: a?.username ?? '', isAdmin: !!a?.isAdmin };
}

export class SimRoom extends Room<RoomState> {
  /** Read-only file defaults; `bundle` is these merged with DB asset overrides. */
  private defaults!: AssetBundle;
  private bundle!: AssetBundle;
  private os!: OfficeState;
  private store!: LayoutStore;
  private zones!: ZoneStore;
  private zone!: ZoneConfig;
  /** Player avatar id per connected client session. */
  private readonly players = new Map<string, number>();
  /** Owned-avatar sprite data currently needed in THIS zone (skin id → data),
   *  distributed only to clients here so a client loads just the avatars of
   *  players standing in its zone. Refcounted by concurrent sessions. */
  private readonly avatarData = new Map<string, LoadedCharacterData>();
  private readonly avatarRefs = new Map<string, number>();
  /** Recent zone-local chat (ring buffer), sent to joiners; + per-session rate limit. */
  private readonly chatLog: Array<{ from: string; text: string }> = [];
  private readonly lastChatAt = new Map<string, number>();
  /** Conference monitor membership: "col,row" anchor → set of player avatar ids. */
  private readonly conferences = new Map<string, Set<number>>();
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

  /** Gate joins on the cookie session when login is enforced; resolve the viewer
   *  to {userId (identity key), username (display name), isAdmin}. Open dev mode
   *  (no admin token) yields an anonymous viewer. */
  onAuth(_client: Client, _options: unknown, context: AuthContext): AuthInfo {
    if (!this.authRequired) return { userId: '', username: '', isAdmin: false };
    const cookie = (context?.headers as Record<string, string | undefined> | undefined)?.cookie;
    if (!hasValidSession(cookie)) throw new Error('unauthorized');
    const userId = userIdFromCookie(cookie) ?? '';
    const user = userId ? userStore.get(userId) : undefined;
    if (!user) throw new Error('unauthorized');
    return { userId: user.userId, username: UserStore.displayName(user), isAdmin: user.isAdmin };
  }

  onCreate(options: { bundle: AssetBundle; authRequired?: boolean; zone?: string; version?: string }): void {
    this.defaults = options.bundle;
    this.bundle = buildMerged(this.defaults); // file defaults + DB asset overrides
    this.authRequired = options.authRequired ?? false;
    this.version = options.version ?? '';
    // Resolve which space this room hosts from the persistent registry (user
    // zones included); fall back to the builtin config for safety.
    this.zones = new ZoneStore();
    this.zone = (options.zone && this.zones.get(options.zone)) || resolveZone(options.zone);
    this.setState(new RoomState());
    this.autoDispose = false;

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

    this.registerLayoutHandlers();
    this.setSimulationInterval((dtMs) => this.tick(dtMs / 1000), 1000 / TICK_HZ);
  }

  onDispose(): void {
    director.off('event', this.onEvent);
    director.off('reroute', this.onReroute);
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
    for (const key of this.conferences.keys()) client.send('m', this.conferenceMembersMsg(key));

    // This viewer's identity: userId keys all per-user state; username is the
    // (free) display name shown on the avatar.
    const { userId, username, isAdmin } = authOf(client);
    // This user is now viewing this zone, so their agents should live here. The
    // reroute hands them over from whatever zone they were in (no-op if same).
    director.setOwnerZone(userId, this.zone.id);
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
    // Everyone who joins gets a player avatar (no spectator mode). Active entry
    // (menu switch or portal) → land at the zone's arrival tile; a plain refresh
    // resumes where this user last stood (engine picks a free tile, else random).
    const saved = userId ? appStore.getPlayerPos(userId, this.zone.id) : null;
    const spawnAt = options?.arrive ? this.zone.arrive : (saved ?? undefined);
    // The avatar's name is always the player's display name (username or userId).
    const displayName = username || userId || undefined;
    const playerId = this.os.addPlayer(playerSkin ?? undefined, displayName, spawnAt ?? undefined);
    this.players.set(client.sessionId, playerId);
    const agentToken = userId ? (userStore.get(userId)?.agentToken ?? '') : '';
    client.send('m', {
      type: 'viewerIdentity',
      userId,
      username,
      isAdmin,
      agentToken,
      characterSkin,
      playerSkin,
      playerId,
      version: this.version,
    });
    client.send('m', {
      type: 'settingsLoaded',
      soundEnabled: appStore.getSetting('soundEnabled', true),
      alwaysShowLabels: appStore.getSetting('alwaysShowLabels', false),
      alertVolume: appStore.getSetting('alertVolume', 1),
    });
  }

  onLeave(client: Client): void {
    const { userId } = authOf(client);
    const playerId = this.players.get(client.sessionId);
    if (playerId !== undefined) {
      // Persist the avatar's last tile (logged-in users respawn there next time).
      const ch = this.os.getCharacter(playerId);
      if (userId && ch) appStore.setPlayerPos(userId, this.zone.id, ch.tileCol, ch.tileRow);
      this.leaveAllConferences(playerId);
      this.os.removePlayer(playerId);
      this.players.delete(client.sessionId);
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
  }

  /** Whether a conference monitor is placed with its anchor at this tile. */
  private hasConferenceAt(col: number, row: number): boolean {
    for (const item of this.os.getLayout().furniture) {
      if (item.col === col && item.row === row && getCatalogEntry(item.type)?.conference) return true;
    }
    return false;
  }

  /** Current members of a conference (by "col,row" key), for broadcast. */
  private conferenceMembersMsg(key: string): Record<string, unknown> {
    const [col, row] = key.split(',').map(Number);
    const ids = this.conferences.get(key) ?? new Set<number>();
    const members = [...ids].map((id) => ({ id, name: this.os.getCharacter(id)?.folderName || 'Guest' }));
    return { type: 'conferenceMembers', col, row, members };
  }

  /** Namespaced + sanitised LiveKit room name (prevents cross-deployment clashes). */
  private voiceRoom(suffix: string): string {
    return `${this.voiceNs}-${suffix}`.replace(/[^A-Za-z0-9_-]/g, '-');
  }

  /** Mint a LiveKit access token for player `id` in `room` (identity p<id>, so
   *  the client can map a participant back to its avatar for proximity audio).
   *  Returns null if LiveKit isn't configured. */
  private async mintVoiceToken(id: number, room: string): Promise<string | null> {
    const apiKey = process.env.LIVEKIT_API_KEY;
    const apiSecret = process.env.LIVEKIT_API_SECRET;
    if (!apiKey || !apiSecret) return null;
    const name = this.os.getCharacter(id)?.folderName || `Guest-${id}`;
    const at = new AccessToken(apiKey, apiSecret, { identity: `p${id}`, name });
    // canUpdateOwnMetadata lets a participant publish its own attributes (we use
    // a `deaf` attribute so others can see when someone has their sound off).
    at.addGrant({ roomJoin: true, room, canPublish: true, canSubscribe: true, canUpdateOwnMetadata: true });
    return at.toJwt();
  }

  /** Remove a player from one conference (by key) + broadcast the new roster. */
  private leaveConference(playerId: number, key: string): void {
    const set = this.conferences.get(key);
    if (!set || !set.delete(playerId)) return;
    if (set.size === 0) this.conferences.delete(key);
    this.broadcast('m', this.conferenceMembersMsg(key));
  }

  /** Remove a player from every conference (on leave / despawn / zone change). */
  private leaveAllConferences(playerId: number): void {
    for (const key of [...this.conferences.keys()]) this.leaveConference(playerId, key);
  }

  /** Display name for a chatter: their avatar's name, else display name, else Guest. */
  private chatNameFor(client: Client): string {
    const { userId, username } = authOf(client);
    const id = this.players.get(client.sessionId);
    const ch = id !== undefined ? this.os.getCharacter(id) : null;
    return ch?.folderName || username || userId || 'Guest';
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

  private zoneListMessage(): Record<string, unknown> {
    return { type: 'zoneList', zones: this.zones.list(), current: this.zone.id };
  }

  /** Re-read + push the zone registry to everyone in this room (after a CRUD). */
  private broadcastZoneList(): void {
    this.broadcast('m', this.zoneListMessage());
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
      if (!this.canEdit(client)) return;
      if (typeof msg?.name === 'string' && this.store.setActive(zone, msg.name)) this.applyActiveLayout();
    });

    this.onMessage('saveLayout', (client, msg: { layout?: Record<string, unknown> }) => {
      if (!this.canEdit(client)) return;
      // Autosave this zone's active layout (no-op on its read-only Default).
      if (msg?.layout && this.store.saveActive(zone, msg.layout, Date.now())) this.applyActiveLayout();
    });

    this.onMessage('saveLayoutAs', (client, msg: { name?: string; layout?: Record<string, unknown> }) => {
      if (!this.canEdit(client)) return;
      const name = cleanName(msg?.name);
      if (name && msg?.layout && LayoutStore.isValidUserName(name)) {
        this.store.saveAs(zone, name, msg.layout, Date.now());
        this.applyActiveLayout();
      }
    });

    this.onMessage('deleteLayout', (client, msg: { name?: string }) => {
      if (!this.canEdit(client)) return;
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
      this.chatLog.push({ from, text });
      if (this.chatLog.length > 50) this.chatLog.shift();
      this.broadcast('m', { type: 'chat', from, text, id });
    });

    // ── Conference monitors: click a monitor → join/leave its video call. The
    // monitor is identified by its anchor tile (stable, shared with the client). ──
    // Click a monitor → walk the avatar in front of it, then join on arrival.
    this.onMessage('conferenceApproach', (client, msg: { col?: number; row?: number }) => {
      const id = this.players.get(client.sessionId);
      if (id === undefined) return;
      const col = Math.floor(Number(msg?.col));
      const row = Math.floor(Number(msg?.row));
      if (!Number.isInteger(col) || !Number.isInteger(row) || !this.hasConferenceAt(col, row)) return;
      this.os.walkPlayerToConference(id, col, row);
    });

    this.onMessage('conferenceLeave', (client, msg: { col?: number; row?: number }) => {
      const id = this.players.get(client.sessionId);
      if (id === undefined) return;
      this.leaveConference(id, `${Math.floor(Number(msg?.col))},${Math.floor(Number(msg?.row))}`);
    });

    // Mint a LiveKit access token for a monitor's call — only for a player who
    // has actually joined that monitor (server-authoritative gate). The room name
    // is shared by everyone at the same monitor in this zone.
    this.onMessage('conferenceToken', async (client, msg: { col?: number; row?: number }) => {
      const id = this.players.get(client.sessionId);
      if (id === undefined) return;
      const col = Math.floor(Number(msg?.col));
      const row = Math.floor(Number(msg?.row));
      const key = `${col},${row}`;
      if (!this.conferences.get(key)?.has(id)) return; // not a member → no token
      const url = process.env.LIVEKIT_URL;
      const apiKey = process.env.LIVEKIT_API_KEY;
      const apiSecret = process.env.LIVEKIT_API_SECRET;
      if (!url || !apiKey || !apiSecret) {
        client.send('m', { type: 'conferenceToken', col, row, error: 'not-configured' });
        return;
      }
      // Stable room from the monitor's name when set (survives moving it), else
      // its position. Sanitised to LiveKit's allowed room-name characters.
      const monitor = this.os
        .getLayout()
        .furniture.find((f) => f.col === col && f.row === row && getCatalogEntry(f.type)?.conference);
      const room = this.voiceRoom(`${this.zone.id}-${conferenceKey(monitor?.name, col, row)}`);
      const token = await this.mintVoiceToken(id, room);
      if (!token) return;
      client.send('m', { type: 'conferenceToken', col, row, url, token, room });
    });

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

    // ── Zone registry (create / edit / delete; admins only, office protected) ──
    this.onMessage('requestZones', (client) => client.send('m', this.zoneListMessage()));

    this.onMessage('createZone', (client, msg: { label?: string; cols?: number; rows?: number }) => {
      if (!this.canEdit(client)) return;
      if (typeof msg?.label !== 'string') return;
      const id = this.zones.create(msg.label, Number(msg?.cols), Number(msg?.rows), Date.now());
      // Tell the creator the new id (so the client can offer to jump there) +
      // refresh everyone here.
      if (id) client.send('m', { type: 'zoneCreated', id });
      this.broadcastZoneList();
    });

    this.onMessage('editZone', (client, msg: { id?: string; label?: string; arrive?: { col: number; row: number } }) => {
      if (!this.canEdit(client)) return;
      if (typeof msg?.id !== 'string') return;
      const patch: { label?: string; arrive?: { col: number; row: number } } = {};
      if (typeof msg.label === 'string') patch.label = msg.label;
      if (msg.arrive && Number.isInteger(msg.arrive.col) && Number.isInteger(msg.arrive.row)) patch.arrive = msg.arrive;
      if (this.zones.edit(msg.id, patch)) {
        if (msg.id === this.zone.id) this.zone = this.zones.get(msg.id) ?? this.zone;
        this.broadcastZoneList();
      }
    });

    this.onMessage('deleteZone', (client, msg: { id?: string }) => {
      if (!this.canEdit(client)) return;
      // The office is read-only and can never be deleted (enforced in the store).
      if (typeof msg?.id === 'string' && this.zones.delete(msg.id)) {
        this.store.deleteZoneLayouts(msg.id); // drop the zone's saved layouts too
        this.broadcastZoneList();
      }
    });

    // Per-zone NPC spawn set: which variants appear in a zone (null = all).
    this.onMessage('setZoneNpc', (client, msg: { id?: string; npc?: string[] | null }) => {
      if (!this.canEdit(client)) return;
      if (typeof msg?.id !== 'string') return;
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

    // Settings (global, persisted in SQLite).
    this.onMessage('setSoundEnabled', (_c, msg: { enabled?: boolean }) =>
      appStore.setSetting('soundEnabled', !!msg?.enabled));
    this.onMessage('setAlwaysShowLabels', (_c, msg: { enabled?: boolean }) =>
      appStore.setSetting('alwaysShowLabels', !!msg?.enabled));
    this.onMessage('setAlertVolume', (_c, msg: { volume?: number }) => {
      const v = Number(msg?.volume);
      appStore.setSetting('alertVolume', Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : 1);
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
      const { userId, username, isAdmin } = authOf(client);
      if (!userId || !isAdmin) return;
      const data = appStore.getPlayerAvatar<LoadedCharacterData>(userId);
      if (!data) return;
      const name = ((typeof msg?.name === 'string' ? msg.name : '').trim() || username || userId).slice(0, 16);
      const toSave = { ...cloneCharacterData(data), name };
      if (!this.validCharacterData(toSave)) return;
      appStore.saveAsset('character', this.nextCharTemplateId(), toSave);
      this.reapplyAsset('character');
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
      this.leaveAllConferences(id);
      this.os.removePlayer(id);
      this.players.delete(client.sessionId);
      client.send('m', { type: 'zoneTransition', zone: target.id });
    });

    // The player avatar's name is always the user's display name (logged-in);
    // an anonymous viewer (open dev) may pass a chosen name.
    this.onMessage('setPlayerName', (client, msg: { name?: string }) => {
      const { userId, username } = authOf(client);
      const name = userId
        ? username || userId
        : (typeof msg?.name === 'string' ? msg.name : '').trim().slice(0, 16);
      const id = this.players.get(client.sessionId);
      if (id !== undefined) this.os.setCharacterName(id, name);
    });

    // Asset overrides (characters/furniture/floors/walls/pets). Persist + re-merge
    // + re-apply to the engine + broadcast the refreshed *Loaded message.
    this.onMessage('saveAsset', (client, msg: { assetType?: string; name?: string; data?: unknown }) => {
      if (!this.canEdit(client)) return;
      const type = this.validAssetType(msg?.assetType);
      if (!type || typeof msg?.name !== 'string' || msg.data === undefined) return;
      // Asset ids are safe identifiers (char_0, DESK_FRONT, PC_SIDE:left, …).
      if (!/^[A-Za-z0-9_:-]{1,40}$/.test(msg.name)) return;
      if (type === 'furniture' && !this.validFurnitureData(msg.data)) return;
      // Characters and NPCs (pets) share the LoadedCharacterData + spec shape.
      if ((type === 'character' || type === 'pet') && !this.validCharacterData(msg.data)) return;
      appStore.saveAsset(type, msg.name, msg.data);
      this.reapplyAsset(type);
    });
    this.onMessage('deleteAsset', (client, msg: { assetType?: string; name?: string }) => {
      if (!this.canEdit(client)) return;
      const type = this.validAssetType(msg?.assetType);
      if (!type || typeof msg?.name !== 'string') return;
      if (appStore.deleteAsset(type, msg.name)) this.reapplyAsset(type);
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

  /** Whether this client may edit shared world/assets: admins only when login is
   *  enforced; everyone in open dev mode (no auth, no admin concept). */
  private canEdit(client: Client): boolean {
    return !this.authRequired || authOf(client).isAdmin;
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
      if (typeof c.category !== 'string') return false;
      if (c.appliance !== undefined && (typeof c.appliance !== 'string' || c.appliance.length > 32)) {
        return false;
      }
    }
    return true;
  }

  /** Re-merge defaults+DB, re-apply the affected type to the engine, broadcast. */
  private reapplyAsset(type: AssetType): void {
    this.bundle = buildMerged(this.defaults);
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
    this.os.update(Math.min(dt, 0.1));
    this.handlePortals();
    this.handleConferenceArrivals();
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

  /** Players who reached a conference monitor this tick → add them to its call. */
  private handleConferenceArrivals(): void {
    for (const { id, key } of this.os.takePendingConferenceJoins()) {
      let set = this.conferences.get(key);
      if (!set) {
        set = new Set();
        this.conferences.set(key, set);
      }
      set.add(id);
      this.broadcast('m', this.conferenceMembersMsg(key));
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
      cs.folderName = ch.folderName ?? '';
      cs.teamName = ch.teamName ?? '';
      cs.agentName = ch.agentName ?? '';
      cs.isTeamLead = ch.isTeamLead ?? false;
      cs.activity = this.activity.get(ch.id) ?? '';
      cs.inputTokens = ch.inputTokens;
      cs.outputTokens = ch.outputTokens;
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
      this.state.furniture.push(fs);
    }
  }
}
