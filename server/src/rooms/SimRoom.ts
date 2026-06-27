import { Room, type AuthContext, type Client } from '@colyseus/core';

import { resolveZone } from '@pixel/shared';
import type { AgentEvent, ZoneConfig } from '@pixel/shared';
import { CharacterSync, EntitySync, FurnitureSync, PetSync, RoomState } from '@pixel/shared/schema';
import { OfficeState, getCharacterPose, isReadingTool } from '@pixel/shared/office/engine/index.js';
import { PET_DRINK_CHANCE, PET_SIT_CHANCE, PET_TALK_CHANCE } from '@pixel/shared/office/constants.js';
import { PetKind } from '@pixel/shared/office/types.js';
import { setProviderCapabilities } from '@pixel/shared/office/toolUtils.js';
import { setCharacterTemplates, setPetTemplates } from '@pixel/shared/office/sprites/spriteData.js';
import { buildDynamicCatalog } from '@pixel/shared/office/layout/furnitureCatalog.js';
import { createPlazaLayout, migrateLayoutColors } from '@pixel/shared/office/layout/layoutSerializer.js';
import type { OfficeLayout } from '@pixel/shared/office/types.js';

import { READING_TOOLS, SUBAGENT_TOOL_NAMES } from '../constants.js';
import { director } from '../sim/director.js';
import { applyEvent } from '../sim/applyEvent.js';
import { LayoutStore } from '../layoutStore.js';
import { appStore } from '../appStore.js';
import { ASSET_TYPES, buildMerged, messageTypeForAsset, type AssetType } from '../assetOverrides.js';
import { hasValidSession, usernameFromCookie } from '../auth.js';
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

export class SimRoom extends Room<RoomState> {
  /** Read-only file defaults; `bundle` is these merged with DB asset overrides. */
  private defaults!: AssetBundle;
  private bundle!: AssetBundle;
  private os!: OfficeState;
  private store!: LayoutStore;
  private zone!: ZoneConfig;
  /** Player avatar id per connected client session. */
  private readonly players = new Map<string, number>();
  private token = '';
  private readonly activity = new Map<number, string>();
  private lastFurnitureRef: unknown = null;
  /** Server-only NPC behaviour tree (decides pet activity; not in client bundle). */
  private readonly npcBrain = new NpcBrain();

  private readonly onEvent = (ev: AgentEvent) => applyEvent(this.os, ev, this.activity);

  /** Gate joins on the cookie session when a token is configured; expose the
   *  viewer's username so the client can play sounds only for its own agents. */
  onAuth(_client: Client, _options: unknown, context: AuthContext): { username: string } {
    if (!this.token) return { username: '' };
    const cookie = (context?.headers as Record<string, string | undefined> | undefined)?.cookie;
    if (!hasValidSession(cookie)) throw new Error('unauthorized');
    return { username: usernameFromCookie(cookie) ?? '' };
  }

  onCreate(options: { bundle: AssetBundle; token?: string; zone?: string }): void {
    this.defaults = options.bundle;
    this.bundle = buildMerged(this.defaults); // file defaults + DB asset overrides
    this.token = options.token ?? '';
    this.zone = resolveZone(options.zone); // which space this room instance hosts
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

    // The active layout (persisted, falling back to the bundled default).
    this.store = new LayoutStore((this.bundle.raw.layout as Record<string, unknown>) ?? null);
    this.os = new OfficeState(this.zoneLayout());
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
    // Restore per-user pinned character palettes (so a user's skin stays stable).
    for (const [name, palette] of Object.entries(appStore.getCharPrefs())) {
      this.os.setPalettePref(name, palette);
    }

    // Seed any agents that already exist (mock/feed started before this room).
    for (const a of director.snapshot()) {
      applyEvent(this.os, { t: 'created', id: a.id, label: a.label }, this.activity);
    }
    director.on('event', this.onEvent);

    this.registerLayoutHandlers();
    this.setSimulationInterval((dtMs) => this.tick(dtMs / 1000), 1000 / TICK_HZ);
  }

  onDispose(): void {
    director.off('event', this.onEvent);
    this.store?.close();
  }

  onJoin(client: Client): void {
    // Decoded assets so the client can render. The layoutLoaded from the static
    // bundle is replaced by the live active layout; agent state flows via schema.
    client.send('m', this.bundle.providerCapabilities);
    for (const m of this.bundle.messages) {
      if (m.type !== 'layoutLoaded') client.send('m', m);
    }
    client.send('m', this.activeLayoutMessage());
    client.send('m', this.layoutListMessage());

    // Who this viewer logged in as (for per-user sounds) + their pinned skins.
    const username = (client.auth as { username?: string } | undefined)?.username ?? '';
    const characterPalette = username ? (appStore.getCharPrefs()[username] ?? null) : null;
    const playerPalette = username ? (appStore.getPlayerPrefs()[username] ?? null) : null;
    const spectator = username ? !!appStore.getSpectatorPrefs()[username] : false;
    // Spawn this viewer's player avatar (their own controllable body) unless they
    // opted into spectator mode. Anonymous viewers re-assert their choice via
    // setPlayer* after join (localStorage-backed).
    let playerId: number | null = null;
    if (!spectator) {
      playerId = this.os.addPlayer(playerPalette ?? undefined, username || undefined);
      this.players.set(client.sessionId, playerId);
    }
    client.send('m', { type: 'viewerIdentity', username, characterPalette, playerPalette, playerId, spectator });
    client.send('m', {
      type: 'settingsLoaded',
      soundEnabled: appStore.getSetting('soundEnabled', true),
      alwaysShowLabels: appStore.getSetting('alwaysShowLabels', false),
      alertVolume: appStore.getSetting('alertVolume', 1),
    });
  }

  onLeave(client: Client): void {
    const playerId = this.players.get(client.sessionId);
    if (playerId !== undefined) {
      this.os.removePlayer(playerId);
      this.players.delete(client.sessionId);
    }
  }

  // ── Layout management (server-authoritative) ─────────────────────

  private migratedActiveLayout(): OfficeLayout | undefined {
    const raw = this.store.getActiveLayout() as OfficeLayout | null;
    return raw && raw.version === 1 ? migrateLayoutColors(raw) : (raw ?? undefined);
  }

  /** Layout for this room's zone: a builtin generated layout (plaza), else the
   *  zone's named layout when set + present, else the active/default layout (so
   *  the office zone is unchanged). */
  private zoneLayout(): OfficeLayout | undefined {
    if (this.zone.id === 'plaza') return createPlazaLayout();
    const name = this.zone.layoutName;
    if (name && this.store.has(name)) {
      const raw = this.store.resolve(name) as OfficeLayout | null;
      return raw && raw.version === 1 ? migrateLayoutColors(raw) : (raw ?? undefined);
    }
    return this.migratedActiveLayout();
  }

  private activeLayoutMessage(): Record<string, unknown> {
    return {
      type: 'layoutLoaded',
      // The layout this room actually simulates (the zone's), so the client
      // renders the right floor/walls — not always the store's active layout.
      layout: this.os.getLayout(),
      activeLayout: this.zone.id === 'office' ? this.store.getActiveName() : this.zone.id,
      force: true,
    };
  }

  private layoutListMessage(): Record<string, unknown> {
    return { type: 'layoutList', layouts: this.store.list(), active: this.store.getActiveName() };
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

  /** Whether this zone's layout is store-backed (editable). Generated zones
   *  (e.g. the plaza) are read-only — they share the office's LayoutStore/DB, so
   *  letting them save would overwrite the office layout. */
  private layoutEditable(): boolean {
    return this.zone.id === 'office';
  }

  private registerLayoutHandlers(): void {
    this.onMessage('requestLayouts', (client) => client.send('m', this.layoutListMessage()));

    this.onMessage('loadLayout', (_c, msg: { name?: string }) => {
      if (!this.layoutEditable()) return;
      if (typeof msg?.name === 'string' && this.store.setActive(msg.name)) this.applyActiveLayout();
    });

    this.onMessage('saveLayout', (_c, msg: { layout?: Record<string, unknown> }) => {
      if (!this.layoutEditable()) return; // a generated zone must not touch the store
      // Autosave the active layout (no-op on read-only Default).
      if (msg?.layout && this.store.saveActive(msg.layout, Date.now())) this.applyActiveLayout();
    });

    this.onMessage('saveLayoutAs', (_c, msg: { name?: string; layout?: Record<string, unknown> }) => {
      if (!this.layoutEditable()) return;
      if (typeof msg?.name === 'string' && msg.layout && LayoutStore.isValidUserName(msg.name)) {
        this.store.saveAs(msg.name, msg.layout, Date.now());
        this.applyActiveLayout();
      }
    });

    this.onMessage('deleteLayout', (_c, msg: { name?: string }) => {
      if (!this.layoutEditable()) return;
      if (typeof msg?.name === 'string' && this.store.delete(msg.name)) this.applyActiveLayout();
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

    // Pin the viewer's character palette (keyed by their identity). Applies to
    // their current/future agents and persists across restarts.
    this.onMessage('setCharacter', (client, msg: { palette?: number; name?: string }) => {
      const palette = Number(msg?.palette);
      if (!Number.isInteger(palette) || palette > 999) return;
      const auth = (client.auth as { username?: string } | undefined)?.username;
      const name = (auth && auth.length ? auth : typeof msg?.name === 'string' ? msg.name : '')
        .trim()
        .slice(0, 16);
      if (!name) return;
      if (palette < 0) {
        // Default (random) → unpin and re-randomise the user's agents.
        appStore.clearCharPref(name);
        this.os.clearPalettePref(name);
      } else {
        appStore.setCharPref(name, palette);
        this.os.setPalettePref(name, palette);
      }
    });

    // Pick the viewer's own player-avatar skin (recolors their live avatar +
    // persists per user; -1 = default/random on next spawn).
    this.onMessage('setPlayerCharacter', (client, msg: { palette?: number }) => {
      const palette = Number(msg?.palette);
      if (!Number.isInteger(palette) || palette > 999) return;
      const name = (client.auth as { username?: string } | undefined)?.username ?? '';
      if (name) {
        if (palette < 0) appStore.setPlayerPref(name, -1);
        else appStore.setPlayerPref(name, palette);
      }
      const id = this.players.get(client.sessionId);
      if (id !== undefined && palette >= 0) this.os.setCharacterPalette(id, palette);
    });

    // Toggle the viewer's visibility as a player (spectator mode): spawn/despawn
    // their avatar + persist the choice per user.
    this.onMessage('setPlayerVisible', (client, msg: { visible?: boolean }) => {
      const visible = !!msg?.visible;
      const name = (client.auth as { username?: string } | undefined)?.username ?? '';
      if (name) appStore.setSpectatorPref(name, !visible);
      const existing = this.players.get(client.sessionId);
      if (visible && existing === undefined) {
        const palette = name ? (appStore.getPlayerPrefs()[name] ?? null) : null;
        this.players.set(client.sessionId, this.os.addPlayer(palette ?? undefined, name || undefined));
      } else if (!visible && existing !== undefined) {
        this.os.removePlayer(existing);
        this.players.delete(client.sessionId);
      }
    });

    // The viewer's display name for their player avatar (auth username for
    // logged-in viewers; a chosen name for anonymous ones).
    this.onMessage('setPlayerName', (client, msg: { name?: string }) => {
      const auth = (client.auth as { username?: string } | undefined)?.username;
      const name = (auth && auth.length ? auth : typeof msg?.name === 'string' ? msg.name : '')
        .trim()
        .slice(0, 16);
      const id = this.players.get(client.sessionId);
      if (id !== undefined) this.os.setCharacterName(id, name);
    });

    // Asset overrides (characters/furniture/floors/walls/pets). Persist + re-merge
    // + re-apply to the engine + broadcast the refreshed *Loaded message.
    this.onMessage('saveAsset', (_c, msg: { assetType?: string; name?: string; data?: unknown }) => {
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
    this.onMessage('deleteAsset', (_c, msg: { assetType?: string; name?: string }) => {
      const type = this.validAssetType(msg?.assetType);
      if (!type || typeof msg?.name !== 'string') return;
      if (appStore.deleteAsset(type, msg.name)) this.reapplyAsset(type);
    });
  }

  // ── Asset overrides ──────────────────────────────────────────────

  private validAssetType(t: unknown): AssetType | null {
    return (ASSET_TYPES as readonly string[]).includes(t as string) ? (t as AssetType) : null;
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
    if (typeof d.name !== 'string' || !/^[\x20-\x7e]{1,16}$/.test(d.name)) return false;
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
        // A deleted custom character invalidates anyone pinned to it → drop the
        // pin (persisted) and re-randomise affected live agents.
        const count = (this.bundle.raw.characters as unknown[]).length;
        for (const name of this.os.dropInvalidPalettes(count)) appStore.clearCharPref(name);
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
    this.syncCharacters();
    this.syncPets();
    this.syncFurniture();
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
      cs.palette = ch.palette;
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
      this.state.furniture.push(fs);
    }
  }
}
