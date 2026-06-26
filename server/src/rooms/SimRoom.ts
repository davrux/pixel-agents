import { Room, type AuthContext, type Client } from '@colyseus/core';

import type { AgentEvent } from '@pixel/shared';
import { CharacterSync, FurnitureSync, PetSync, RoomState } from '@pixel/shared/schema';
import { OfficeState, getCharacterPose, isReadingTool } from '@pixel/shared/office/engine/index.js';
import { PetKind } from '@pixel/shared/office/types.js';
import { setProviderCapabilities } from '@pixel/shared/office/toolUtils.js';
import { setCharacterTemplates, setPetTemplates } from '@pixel/shared/office/sprites/spriteData.js';
import { buildDynamicCatalog } from '@pixel/shared/office/layout/furnitureCatalog.js';
import { migrateLayoutColors } from '@pixel/shared/office/layout/layoutSerializer.js';
import type { OfficeLayout } from '@pixel/shared/office/types.js';

import { READING_TOOLS, SUBAGENT_TOOL_NAMES } from '../constants.js';
import { director } from '../sim/director.js';
import { applyEvent } from '../sim/applyEvent.js';
import { LayoutStore } from '../layoutStore.js';
import { appStore } from '../appStore.js';
import { ASSET_TYPES, buildMerged, messageTypeForAsset, type AssetType } from '../assetOverrides.js';
import { hasValidSession, usernameFromCookie } from '../auth.js';
import type { AssetBundle } from '../assets.js';

const TICK_HZ = 20;

/**
 * Authoritative office room: the original OfficeState simulation runs here, in
 * the server's tick loop. Claude ingest events mutate it; every tick we write
 * the render-state into the Colyseus schema, so all viewers see one identical
 * world. Clients are pure renderers.
 */
export class SimRoom extends Room<RoomState> {
  /** Read-only file defaults; `bundle` is these merged with DB asset overrides. */
  private defaults!: AssetBundle;
  private bundle!: AssetBundle;
  private os!: OfficeState;
  private store!: LayoutStore;
  private token = '';
  private readonly activity = new Map<number, string>();
  private lastFurnitureRef: unknown = null;

  private readonly onEvent = (ev: AgentEvent) => applyEvent(this.os, ev, this.activity);

  /** Gate joins on the cookie session when a token is configured; expose the
   *  viewer's username so the client can play sounds only for its own agents. */
  onAuth(_client: Client, _options: unknown, context: AuthContext): { username: string } {
    if (!this.token) return { username: '' };
    const cookie = (context?.headers as Record<string, string | undefined> | undefined)?.cookie;
    if (!hasValidSession(cookie)) throw new Error('unauthorized');
    return { username: usernameFromCookie(cookie) ?? '' };
  }

  onCreate(options: { bundle: AssetBundle; token?: string }): void {
    this.defaults = options.bundle;
    this.bundle = buildMerged(this.defaults); // file defaults + DB asset overrides
    this.token = options.token ?? '';
    this.setState(new RoomState());
    this.autoDispose = false;

    // Initialise the office engine from the decoded assets (templates + catalog
    // give it palette counts, seats, and furniture auto-on metadata).
    setProviderCapabilities({ readingTools: READING_TOOLS, subagentToolNames: SUBAGENT_TOOL_NAMES });
    setCharacterTemplates(this.bundle.raw.characters as never);
    setPetTemplates(this.bundle.raw.dogs as never, this.bundle.raw.cats as never);
    buildDynamicCatalog({
      catalog: this.bundle.raw.furnitureCatalog as never,
      sprites: this.bundle.raw.furnitureSprites as never,
    });

    // The active layout (persisted, falling back to the bundled default).
    this.store = new LayoutStore((this.bundle.raw.layout as Record<string, unknown>) ?? null);
    this.os = new OfficeState(this.migratedActiveLayout());
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

    // Who this viewer logged in as (for per-user sounds) + their pinned skin.
    const username = (client.auth as { username?: string } | undefined)?.username ?? '';
    const characterPalette = username ? (appStore.getCharPrefs()[username] ?? null) : null;
    client.send('m', { type: 'viewerIdentity', username, characterPalette });
    client.send('m', {
      type: 'settingsLoaded',
      soundEnabled: appStore.getSetting('soundEnabled', true),
      alwaysShowLabels: appStore.getSetting('alwaysShowLabels', false),
      alertVolume: appStore.getSetting('alertVolume', 1),
    });
  }

  onLeave(): void {}

  // ── Layout management (server-authoritative) ─────────────────────

  private migratedActiveLayout(): OfficeLayout | undefined {
    const raw = this.store.getActiveLayout() as OfficeLayout | null;
    return raw && raw.version === 1 ? migrateLayoutColors(raw) : (raw ?? undefined);
  }

  private activeLayoutMessage(): Record<string, unknown> {
    return {
      type: 'layoutLoaded',
      layout: this.store.getActiveLayout(),
      activeLayout: this.store.getActiveName(),
      force: true,
    };
  }

  private layoutListMessage(): Record<string, unknown> {
    return { type: 'layoutList', layouts: this.store.list(), active: this.store.getActiveName() };
  }

  /** Rebuild the simulation from the (new) active layout and push it to all
   *  viewers (floor/walls via layoutLoaded; furniture re-syncs through schema). */
  private applyActiveLayout(): void {
    const layout = this.migratedActiveLayout();
    if (layout) this.os.rebuildFromLayout(layout);
    this.lastFurnitureRef = null; // force furniture re-sync
    this.broadcast('m', this.activeLayoutMessage());
    this.broadcast('m', this.layoutListMessage());
  }

  private registerLayoutHandlers(): void {
    this.onMessage('requestLayouts', (client) => client.send('m', this.layoutListMessage()));

    this.onMessage('loadLayout', (_c, msg: { name?: string }) => {
      if (typeof msg?.name === 'string' && this.store.setActive(msg.name)) this.applyActiveLayout();
    });

    this.onMessage('saveLayout', (_c, msg: { layout?: Record<string, unknown> }) => {
      // Autosave the active layout (no-op on read-only Default).
      if (msg?.layout && this.store.saveActive(msg.layout, Date.now())) this.applyActiveLayout();
    });

    this.onMessage('saveLayoutAs', (_c, msg: { name?: string; layout?: Record<string, unknown> }) => {
      if (typeof msg?.name === 'string' && msg.layout && LayoutStore.isValidUserName(msg.name)) {
        this.store.saveAs(msg.name, msg.layout, Date.now());
        this.applyActiveLayout();
      }
    });

    this.onMessage('deleteLayout', (_c, msg: { name?: string }) => {
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
      if (!Number.isInteger(palette) || palette < 0 || palette > 999) return;
      const auth = (client.auth as { username?: string } | undefined)?.username;
      const name = (auth && auth.length ? auth : typeof msg?.name === 'string' ? msg.name : '')
        .trim()
        .slice(0, 16);
      if (!name) return;
      appStore.setCharPref(name, palette);
      this.os.setPalettePref(name, palette);
    });

    // Asset overrides (characters/furniture/floors/walls/pets). Persist + re-merge
    // + re-apply to the engine + broadcast the refreshed *Loaded message.
    this.onMessage('saveAsset', (_c, msg: { assetType?: string; name?: string; data?: unknown }) => {
      const type = this.validAssetType(msg?.assetType);
      if (!type || typeof msg?.name !== 'string' || msg.data === undefined) return;
      // Asset ids are safe identifiers (char_0, DESK_FRONT, PC_SIDE:left, …).
      if (!/^[A-Za-z0-9_:-]{1,40}$/.test(msg.name)) return;
      if (type === 'furniture' && !this.validFurnitureData(msg.data)) return;
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
    }
    return true;
  }

  /** Re-merge defaults+DB, re-apply the affected type to the engine, broadcast. */
  private reapplyAsset(type: AssetType): void {
    this.bundle = buildMerged(this.defaults);
    switch (type) {
      case 'character':
        setCharacterTemplates(this.bundle.raw.characters as never);
        break;
      case 'pet':
        setPetTemplates(this.bundle.raw.dogs as never, this.bundle.raw.cats as never);
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
      cs.x = ch.x;
      cs.y = ch.y;
      cs.dir = ch.dir;
      cs.state = ch.state;
      cs.pose = getCharacterPose(ch);
      cs.frame = ch.frame & 0xff;
      cs.palette = ch.palette;
      cs.hueShift = ch.hueShift;
      cs.isActive = ch.isActive;
      cs.reading = isReadingTool(ch.currentTool);
      cs.bubble = ch.bubbleType ?? '';
      cs.bubbleTimer = ch.bubbleTimer;
      cs.matrixEffect = ch.matrixEffect ?? '';
      cs.matrixEffectTimer = ch.matrixEffectTimer;
      cs.isSubagent = ch.isSubagent;
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
      ps.kind = pet.kind === PetKind.CAT ? 1 : 0;
      ps.variant = pet.variant;
      ps.x = pet.x;
      ps.y = pet.y;
      ps.dir = pet.dir;
      ps.state = pet.state;
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
