import Phaser from 'phaser';
import { getStateCallbacks, type Room } from 'colyseus.js';

import { OfficeState } from '@pixel/shared/office/engine/index.js';
import {
  CHARACTER_BASELINE_HEIGHT,
  CHARACTER_HIT_HEIGHT,
  CHARACTER_SITTING_OFFSET_PX,
  FUEL_COLOR_CRITICAL,
  FUEL_COLOR_DANGER,
  FUEL_COLOR_OK,
  FUEL_COLOR_WARN,
  MATRIX_SPRITE_COLS,
  MAX_CONTEXT_TOKENS,
  TOKEN_CRITICAL_THRESHOLD,
  TOKEN_DANGER_THRESHOLD,
  TOKEN_WARN_THRESHOLD,
  TOOL_OVERLAY_VERTICAL_OFFSET,
  WALK_FRAME_DURATION_SEC,
  TYPE_FRAME_DURATION_SEC,
  COFFEE_FRAME_DURATION_SEC,
} from '@pixel/shared/office/constants.js';
import {
  CharacterState,
  Direction,
  TILE_SIZE,
  type Character,
  type FurnitureInstance,
  type OfficeLayout,
  type Pet,
} from '@pixel/shared/office/types.js';
import { layoutToFurnitureInstances } from '@pixel/shared/office/layout/layoutSerializer.js';
import { getCatalogEntry } from '@pixel/shared/office/layout/furnitureCatalog.js';
import { LiveKitConference, type ConferenceState, type ConferenceDevices } from '../conference/LiveKitConference.js';
import { ZoneVoiceUI } from '../voice/ZoneVoiceUI.js';
import { getCharacterSize, getCharacterTemplates, getNpcRoster, getPosePlaybackLength } from '@pixel/shared/office/sprites/spriteData.js';
import type { CharacterPose } from '@pixel/shared/office/types.js';
import { PhaserRenderer, type RenderSource } from '../render/PhaserRenderer.js';
import { LayoutEditor } from '../editor/LayoutEditor.js';
import { CharacterEditor, AGENT_TRACKS, NPC_TRACKS, skinLabel } from '../editor/CharacterEditor.js';
import { FurnitureEditor } from '../editor/FurnitureEditor.js';
import { confirmDialog, promptDialog, alertDialog } from '../ui/dialog.js';
import { createAssetBridge } from '../net/bridge.js';
import { connect, isAuthError, isServerUp, redirectToLogin, gotoLogout } from '../net/room.js';
import { DEFAULT_ZONE, ZONES, conferenceLabel, isPlayerAvatarSkin, type ZoneConfig } from '@pixel/shared/protocol';
import { playDoneSound, playPermissionSound, setAlertVolume, setSoundEnabled, unlockAudio } from '../sound.js';

/** A render-only character/pet: only the fields the renderer + tooltip read,
 *  plus interpolation targets (tx,ty). Cast to the engine types for the view. */
type RenderChar = Partial<Character> & {
  id: number;
  tx: number;
  ty: number;
  activity: string;
  /** Client-side animation clock (frame phase is cosmetic, not synced). */
  animTimer?: number;
  animPose?: string;
};
type RenderPet = Partial<Pet> & { id: number; tx: number; ty: number };

/** Per-pose animation frame duration (ms), mirroring the engine's constants.
 *  Poses not listed (idle) are static. Drives the client-side animation clock. */
const POSE_FRAME_MS: Record<string, number> = {
  walk: WALK_FRAME_DURATION_SEC * 1000,
  typing: TYPE_FRAME_DURATION_SEC * 1000,
  reading: TYPE_FRAME_DURATION_SEC * 1000,
  coffee: COFFEE_FRAME_DURATION_SEC * 1000,
  sit: TYPE_FRAME_DURATION_SEC * 1000, // static placeholder; animates if a sit track is authored
};

/** Deterministic per-column rain stagger seeds (0..1) for the Matrix effect,
 *  derived from the agent id so all viewers render an identical sweep. */
function matrixSeeds(id: number): number[] {
  const seeds: number[] = [];
  let s = (id * 2654435761) >>> 0; // Knuth multiplicative hash
  for (let i = 0; i < MATRIX_SPRITE_COLS; i++) {
    s = (s * 1664525 + 1013904223) >>> 0; // LCG step
    seeds.push(s / 0xffffffff);
  }
  return seeds;
}

/** A plausible zone id (slug). The server is authoritative and falls back to the
 *  office for unknown ids, so the client only sanitises the shape. */
function isZoneId(z: string | null | undefined): z is string {
  return !!z && /^[a-z0-9-]{1,32}$/.test(z);
}

/** Normalise a stored skin choice to a skin id, or null (default/random). An
 *  old numeric palette index N migrates to "char_N"; a char_* id passes through. */
function migrateSkin(raw: string | null): string | null {
  if (raw === null || raw === '') return null;
  if (/^char_\d+$/.test(raw)) return raw;
  if (/^\d+$/.test(raw)) return `char_${raw}`;
  return null;
}

/** The zone to connect to: the `?zone=` URL param if valid, else the last zone
 *  this browser visited (P4), else the office. User-created zones aren't in the
 *  bundled ZONES, so we accept any slug-shaped id and let the server resolve it. */
function currentZone(): string {
  const z = new URLSearchParams(window.location.search).get('zone') ?? '';
  if (isZoneId(z)) return z;
  try {
    const last = localStorage.getItem('pa-last-zone');
    if (isZoneId(last)) return last;
  } catch {
    /* localStorage unavailable */
  }
  return DEFAULT_ZONE;
}

export class OfficeScene extends Phaser.Scene {
  private os!: OfficeState;
  private view!: PhaserRenderer;
  private room?: Room;
  private readonly characters = new Map<number, RenderChar>();
  private readonly pets = new Map<number, RenderPet>();
  private furnitureArr: FurnitureInstance[] = [];
  /** Placed furniture (type + tile + optional name) from the room state, for click hit-testing. */
  private furniturePlacements: Array<{ uid: string; type: string; col: number; row: number; name?: string }> = [];
  private furnitureDirty = false;
  private hoveredId: number | null = null;
  private selectedId: number | null = null;
  private tip!: HTMLDivElement;
  private chatBox?: HTMLDivElement;
  private chatLogEl?: HTMLDivElement;
  private chatInputEl?: HTMLInputElement;
  /** Idle-fade clock for the chat (performance.now() ms); fades when idle. */
  private chatActiveUntil = 0;
  private chatFaded = false;
  /** The conference monitor (anchor tile + name) this viewer has joined, or null. */
  private myConference: { col: number; row: number; name?: string } | null = null;
  /** A monitor we clicked and are walking toward (join finalizes on arrival). */
  private pendingConference: { col: number; row: number; name?: string } | null = null;
  /** Conference rosters by "col,row" anchor key (from the server). */
  private readonly conferenceMembers = new Map<string, Array<{ id: number; name: string }>>();
  private confPanel?: HTMLDivElement;
  private confGrid?: HTMLDivElement;
  private confBar?: HTMLDivElement;
  /** Active LiveKit connection for the joined monitor, or undefined (C-RTC-2). */
  private conf?: LiveKitConference;
  private confState: ConferenceState = { connected: false, camOn: true, micOn: true, screenOn: false };
  /** Zone-wide voice chat (one LiveKit room per zone), with proximity audio. */
  private zoneVoice?: ZoneVoiceUI;
  private zoneVoiceStarted = false;
  private confDevices: ConferenceDevices = { cameras: [], mics: [], speakers: [] };
  /** Transient chat bubbles above avatars, keyed by entity id (expiry in ms,
   *  performance.now() clock). */
  private readonly chatBubbles = new Map<number, { el: HTMLDivElement; until: number }>();
  /** Player ids currently talking via zone voice (client-side, from LiveKit). */
  private voiceSpeakers = new Set<number>();
  /** Per-player zone-voice presence + mic-mute + sound-off (from LiveKit). */
  private voiceStatus = new Map<number, { muted: boolean; deaf: boolean }>();
  /** Small voice status icons over avatars (in-voice players), keyed by player id. */
  private readonly voiceBubbles = new Map<number, HTMLDivElement>();
  /** Per-speaker grace deadline (ms) so the talking icon stays on through gaps. */
  private readonly voiceSpeakUntil = new Map<number, number>();
  private editor!: LayoutEditor;
  private charEditor!: CharacterEditor;
  private furnEditor!: FurnitureEditor;
  /** Raw furniture catalog from the last furnitureAssetsLoaded (group fields). */
  private furnitureCatalogRaw: Array<Record<string, unknown> & { id: string }> = [];
  /** Bundled (file) skin ids — anything else is user-added (deletable). */
  private bundledSkinIds = new Set<string>();
  private topbar?: HTMLElement;
  private menubar?: HTMLElement;
  private settingsBtn?: HTMLButtonElement;
  private layoutsBtn?: HTMLButtonElement;
  private layoutsPanel!: HTMLDivElement;
  private zonesBtn?: HTMLButtonElement;
  private zonesPanel!: HTMLDivElement;
  private helpBtn?: HTMLButtonElement;
  private helpPanel!: HTMLDivElement;
  private zoneSel?: HTMLSelectElement;
  /** Set before our own navigation (zone switch / portal) so the resulting room
   *  leave isn't treated as a dropped connection. */
  private leavingIntentionally = false;
  /** True while waiting for the server to come back after a dropped connection. */
  private reconnecting = false;
  /** Dynamic zone registry from the server (seeded with the bundled builtins). */
  private zoneList: ZoneConfig[] = Object.values(ZONES);
  // Settings + viewer identity (sounds play only for the viewer's own agents;
  // an empty name means "all agents are mine"). A name set in Settings overrides
  // the login identity and is remembered per browser.
  private viewerUsername = '';
  private nameOverridden = false;
  /** This viewer's account: stable login id, admin flag, per-user agent token
   *  (empty in open dev mode / anonymous). */
  private myUserId = '';
  private isAdmin = false;
  /** Whether this viewer is a designated admin of the CURRENT zone (may layout
   *  it even without being a global admin). */
  private myZoneAdmin = false;
  private agentToken = '';
  /** Pinned character skin id for this viewer, or null (server diversifies). */
  private mySkin: string | null = null;
  /** This viewer's own player-avatar id (from viewerIdentity), or null. */
  private myPlayerId: number | null = null;
  /** The tile the portal picker opened on — close it once the avatar leaves. */
  private portalPickerTile: { col: number; row: number } | null = null;
  /** Armed "click a tile to set this zone's arrival point" mode. */
  private arrivePickActive = false;
  /** This viewer's owned-avatar skin id (pa:<user>), from the server. The avatar
   *  is the player's own editable copy — not a gallery template. */
  private myAvatarId: string | null = null;
  private alwaysShowLabels = false;
  private soundOn = true;
  private volume = 1;
  private settingsPanel!: HTMLDivElement;
  /** Previous (active,bubble) per agent — to detect transitions for sounds. */
  private readonly prevState = new Map<number, { active: boolean; bubble: string }>();
  private readonly nameLabels = new Map<number, HTMLDivElement>();
  private layoutListData: { layouts: Array<{ name: string; readOnly: boolean }>; active: string } = {
    layouts: [],
    active: 'Default',
  };
  // Live-edit autosave: edits broadcast to all viewers via debounced saveLayoutAs.
  private editTarget = '';
  private pendingLayout: OfficeLayout | null = null;
  private autosaveTimer?: ReturnType<typeof setTimeout>;
  /** Re-fit zoom/center only on the first layout — later (live-edit) broadcasts
   *  must not yank the camera of the editor or watchers. */
  private cameraInitialized = false;

  constructor() {
    super('office');
  }

  create(): void {
    const g = this.make.graphics({ x: 0, y: 0 });
    g.fillStyle(0xffffff, 1).fillRect(0, 0, 1, 1);
    g.generateTexture('__WHITE', 1, 1);
    g.destroy();

    this.cameras.main.setBackgroundColor('#14161c');
    this.os = new OfficeState();
    this.view = new PhaserRenderer(this, this.renderSource());
    this.editor = new LayoutEditor(this, {
      getLayout: () => this.os.getLayout(),
      onChange: () => (this.furnitureDirty = true),
      rebuildStatic: () => this.view.buildStatic(),
      onEdit: (layout, immediate) => this.autosaveLayout(layout, immediate),
      onEditingChange: (editing) => this.setEditMode(editing),
    });
    // A name/character chosen in Settings (remembered per browser).
    try {
      this.mySkin = migrateSkin(localStorage.getItem('pa-viewer-char'));
      const saved = localStorage.getItem('pa-viewer-name');
      if (saved) {
        this.viewerUsername = saved;
        this.nameOverridden = true;
      }
    } catch {
      /* localStorage unavailable */
    }
    // Browsers only allow audio after a user gesture; the in-canvas pointerdown
    // misses clicks on the DOM panels, so unlock on the first gesture anywhere.
    const unlock = (): void => unlockAudio();
    window.addEventListener('pointerdown', unlock, { once: true });
    window.addEventListener('keydown', unlock, { once: true });

    this.createTooltip();
    this.createLayoutsPanel();
    this.createSettingsPanel();
    this.createChat();
    this.createConferencePanel();
    this.charEditor = new CharacterEditor({
      categories: [
        {
          key: 'agent',
          label: 'Avatars',
          getTemplates: () => getCharacterTemplates(),
          // New skins get the next free char_<n> id (ids are stable, never reused).
          newId: (existing) => {
            let n = 0;
            const taken = new Set(existing);
            while (taken.has(`char_${n}`)) n++;
            return `char_${n}`;
          },
          save: (name, data) => this.room?.send('saveAsset', { assetType: 'character', name, data }),
          reset: (name) => this.room?.send('deleteAsset', { assetType: 'character', name }),
          isBundled: (id) => this.bundledSkinIds.has(id),
          tracks: AGENT_TRACKS,
          blankFrames: 7,
          canCreate: true,
        },
        {
          key: 'npc',
          label: 'NPCs',
          getTemplates: () => getNpcRoster().map((r) => ({ id: `${r.kind}_${r.variant}`, data: r.data })),
          newId: () => 'npc_0', // unused (canCreate=false)
          save: (name, data) => this.room?.send('saveAsset', { assetType: 'pet', name, data }),
          reset: (name) => this.room?.send('deleteAsset', { assetType: 'pet', name }),
          isBundled: () => true, // all NPCs are bundled (no new NPCs yet)
          tracks: NPC_TRACKS,
          blankFrames: 6,
          canCreate: false,
          spawnConfig: true,
          derivedName: true,
        },
        {
          // The viewer's own avatar (a single, private, editable skin).
          key: 'me',
          label: 'My Avatar',
          getTemplates: () => {
            const id = this.myAvatarId;
            const t = id ? (getCharacterTemplates() ?? []).find((c) => c.id === id) : undefined;
            return t ? [t] : [];
          },
          newId: () => this.myAvatarId ?? 'pa:me', // unused (canCreate=false)
          save: (_name, data) => this.room?.send('saveAvatar', { data }),
          reset: () => {
            /* an owned avatar has no bundled default to reset to */
          },
          isBundled: () => false,
          tracks: AGENT_TRACKS,
          blankFrames: 7,
          canCreate: false,
        },
      ],
      topbar: this.topbar,
      // Mutually exclusive with the other top-bar popovers.
      requestToggle: () => this.setMenu(this.charEditor.isOpen() ? null : 'chars'),
    });
    this.furnEditor = new FurnitureEditor({
      getRawCatalog: () => this.furnitureCatalogRaw,
      save: (name, data) => this.room?.send('saveAsset', { assetType: 'furniture', name, data }),
      reset: (name) => this.room?.send('deleteAsset', { assetType: 'furniture', name }),
      topbar: this.topbar,
      // Mutually exclusive with the other top-bar popovers.
      requestToggle: () => this.setMenu(this.furnEditor.isOpen() ? null : 'furniture'),
    });
    // Keep Help as the rightmost menu button (after the editor buttons appended
    // their own entries above), with Settings as its immediate left neighbour.
    if (this.helpBtn && this.topbar) {
      this.topbar.appendChild(this.helpBtn);
      if (this.settingsBtn) this.topbar.insertBefore(this.settingsBtn, this.helpBtn);
    }

    // Zone voice control — mounted in the always-visible menubar (NOT the
    // collapsible button row), so it's directly clickable. Positions for
    // proximity come from the synced avatars we render.
    if (this.menubar) {
      this.zoneVoice = new ZoneVoiceUI(this.menubar, {
        requestToken: () => this.room?.send('zoneVoiceToken'),
        myPosition: () => this.playerPosition(this.myPlayerId),
        positionOf: (id) => this.playerPosition(id),
        onSpeakers: (ids) => {
          this.voiceSpeakers = ids;
        },
        onVoiceStatus: (status) => {
          this.voiceStatus = status;
        },
      });
    }

    this.setupInput();
    void this.open();
  }

  /** Renderer reads layout/tiles from the (layout-only) OfficeState and the
   *  live entities from our synced maps. */
  private renderSource(): RenderSource {
    const scene = this;
    return {
      getLayout: () => (scene.editor?.isEditing() && scene.editor.layout ? scene.editor.layout : scene.os.getLayout()),
      get tileMap() {
        return scene.editor?.isEditing() ? scene.editor.tileMap : scene.os.tileMap;
      },
      get furniture() {
        return scene.editor?.isEditing() ? scene.editor.furnitureArr : scene.furnitureArr;
      },
      getCharacters: () => [...scene.characters.values()] as unknown as Character[],
      getPets: () => [...scene.pets.values()] as unknown as Pet[],
    };
  }

  private async open(): Promise<void> {
    const assetBridge = createAssetBridge(this.os, (layout) => this.onLayout(layout));
    try {
      const zone = currentZone();
      try {
        localStorage.setItem('pa-last-zone', zone); // remember for the next load (P4)
      } catch {
        /* localStorage unavailable */
      }
      // Did we get here by actively entering this zone (menu/portal)? goToZone
      // leaves a one-shot flag; consume it so a plain refresh keeps your spot.
      let arriving = false;
      try {
        arriving = sessionStorage.getItem('pa-arrive') === zone;
        sessionStorage.removeItem('pa-arrive');
      } catch {
        /* sessionStorage unavailable */
      }
      this.room = await connect(zone, arriving);
      // Auto-reconnect: if the connection drops (e.g. a server restart), wait for
      // the server to come back and reload — so the player is back in the game
      // without a manual refresh. A consented leave / our own navigation is skipped.
      this.room.onLeave((code) => {
        if (!this.leavingIntentionally && code !== 1000) this.handleDisconnect();
      });
      this.room.onMessage('m', (m: Record<string, unknown>) => {
        if (m.type === 'layoutList') this.updateLayoutsPanel(m);
        else if (m.type === 'zoneList') this.updateZoneList(m);
        else if (m.type === 'zoneCreated') void this.offerJumpToNewZone(m.id as string);
        else if (m.type === 'chat') this.onChat(m);
        else if (m.type === 'chatHistory') this.onChatHistory(m);
        else if (m.type === 'conferenceMembers') this.onConferenceMembers(m);
        else if (m.type === 'conferenceToken') this.onConferenceToken(m);
        else if (m.type === 'zoneVoiceToken') this.zoneVoice?.onToken(m);
        else if (m.type === 'playerSpawned') {
          // Visibility toggled at runtime: adopt (or clear) our avatar id without
          // a reload, then re-assert our name onto the fresh avatar (the owned
          // avatar's skin is assigned server-side).
          this.myPlayerId = typeof m.playerId === 'number' ? m.playerId : null;
          // Anonymous (open dev) viewers re-assert their chosen name; logged-in
          // users get their display name from the server.
          if (this.myPlayerId !== null && !this.myUserId && this.viewerUsername) {
            this.room?.send('setPlayerName', { name: this.viewerUsername });
          }
        }
        else if (m.type === 'viewerIdentity') {
          this.myUserId = (m.userId as string) ?? '';
          this.isAdmin = !!m.isAdmin;
          this.myZoneAdmin = !!m.zoneAdmin;
          this.agentToken = (m.agentToken as string) ?? '';
          // Logged-in users: display name is server-owned. Anonymous (open dev):
          // keep a locally chosen name if any.
          if (this.myUserId) this.viewerUsername = (m.username as string) ?? '';
          else if (!this.nameOverridden) this.viewerUsername = (m.username as string) ?? '';
          if (typeof m.playerId === 'number') this.myPlayerId = m.playerId; // this viewer's avatar
          // Show the server version next to the connection status (arrives just
          // after the bare "connected" set at connect time).
          if (typeof m.version === 'string' && m.version) setStatus(`connected · ${m.version}`);
          // Once we know our avatar + the room is live, (re)join zone voice if the
          // user left it enabled. Runs once; a zone change reloads the page.
          if (!this.zoneVoiceStarted) {
            this.zoneVoiceStarted = true;
            this.zoneVoice?.start();
          }
          // The server assigns this viewer's owned avatar (pa:<userId>) — remember
          // its id so "My avatar" edits/preview target the right skin.
          if (typeof m.playerSkin === 'string') this.myAvatarId = m.playerSkin;
          // Anonymous viewers carry their chosen name to the avatar; logged-in
          // users' avatar name is the server-set display name.
          if (!this.myUserId && this.viewerUsername) this.room?.send('setPlayerName', { name: this.viewerUsername });

          // Adopt the server-pinned skin only if the viewer hasn't picked one here.
          if (this.mySkin === null && typeof m.characterSkin === 'string') {
            this.mySkin = m.characterSkin;
          }
          // Logged-in → offer logout; hide editing entry points from non-admins.
          const logout = this.settingsPanel?.querySelector<HTMLButtonElement>('#pa-logout');
          if (logout) logout.style.display = this.myUserId ? '' : 'none';
          this.applyAdminVisibility();
          this.syncSettingsInputs();
          this.renderCharSwatches();
        }
        else if (m.type === 'agentToken') {
          this.agentToken = (m.token as string) ?? '';
          this.syncSettingsInputs();
        }
        else if (m.type === 'zoneAdmins') {
          const admins = (m.admins as string[]) ?? [];
          void alertDialog(`Zone admins for “${m.zoneId}”:\n${admins.length ? admins.join(', ') : '(none)'}`);
        }
        else if (m.type === 'settingsLoaded') this.applySettings(m);
        else if (m.type === 'portalOptions') this.showPortalPicker(m.zones as Array<{ id: string; label: string }>);
        else if (m.type === 'zoneTransition') this.goToZone(m.zone as string); // walked into a portal (P5)
        else {
          // Keep raw asset metadata the editors need (group fields, default count).
          if (m.type === 'furnitureAssetsLoaded' && Array.isArray(m.catalog)) {
            this.furnitureCatalogRaw = m.catalog as Array<Record<string, unknown> & { id: string }>;
          }
          if (m.type === 'characterSpritesLoaded' && Array.isArray(m.bundledIds)) {
            this.bundledSkinIds = new Set(m.bundledIds as string[]);
          }
          assetBridge(m);
          // Keep the Settings avatar preview honest after a live avatar change.
          if (m.type === 'playerAvatar' && m.id === this.myAvatarId) this.renderAvatarPreview();
        }
      });
      this.bindState(this.room);
      setStatus('connected');
    } catch (err) {
      // No / expired session → bounce to the server's login page (the auth gate
      // serves the form there). Other failures just surface as a status message.
      if (isAuthError(err)) {
        setStatus('session expired — redirecting to login…');
        redirectToLogin();
        return;
      }
      setStatus(`connection failed: ${(err as Error).message}`);
      console.error(err);
    }
  }

  // ── Colyseus schema → local render maps ──────────────────────────

  private bindState(room: Room): void {
    const $ = getStateCallbacks(room);
    const state = room.state as {
      characters: Map<string, Record<string, unknown>>;
      pets: Map<string, Record<string, unknown>>;
      furniture: unknown[];
    };

    $(state).characters.onAdd((cs: Record<string, unknown>, key: string) => {
      const id = Number(key);
      const rc: RenderChar = { id, tx: cs.x as number, ty: cs.y as number, activity: '' };
      this.applyChar(rc, cs);
      rc.x = rc.tx;
      rc.y = rc.ty;
      this.characters.set(id, rc);
      this.prevState.set(id, { active: !!cs.isActive, bubble: (cs.bubble as string) ?? '' });
      $(cs).onChange(() => {
        this.applyChar(rc, cs);
        this.checkSounds(id, cs);
      });
    });
    $(state).characters.onRemove((_cs: unknown, key: string) => {
      const id = Number(key);
      this.characters.delete(id);
      this.prevState.delete(id);
      this.nameLabels.get(id)?.remove();
      this.nameLabels.delete(id);
    });

    $(state).pets.onAdd((ps: Record<string, unknown>, key: string) => {
      const rp: RenderPet = { id: Number(key), tx: ps.x as number, ty: ps.y as number };
      this.applyPet(rp, ps);
      rp.x = rp.tx;
      rp.y = rp.ty;
      this.pets.set(rp.id, rp);
      $(ps).onChange(() => this.applyPet(rp, ps));
    });
    $(state).pets.onRemove((_ps: unknown, key: string) => this.pets.delete(Number(key)));

    const markFurniture = () => (this.furnitureDirty = true);
    $(state).furniture.onAdd(markFurniture);
    $(state).furniture.onChange(markFurniture);
    $(state).furniture.onRemove(markFurniture);
  }

  private applyChar(rc: RenderChar, cs: Record<string, unknown>): void {
    rc.tx = cs.x as number;
    rc.ty = cs.y as number;
    rc.dir = cs.dir as Character['dir'];
    rc.state = cs.state as Character['state'];
    rc.pose = cs.pose as Character['pose'];
    // rc.frame is not synced — the animation phase is timed locally (see update()).
    rc.skin = cs.skin as string;
    rc.hueShift = cs.hueShift as number;
    rc.isActive = cs.isActive as boolean;
    rc.currentTool = (cs.reading as boolean) ? 'Read' : null;
    rc.bubbleType = ((cs.bubble as string) || null) as Character['bubbleType'];
    rc.bubbleTimer = cs.bubbleTimer as number;
    // Matrix spawn/despawn: the server starts/ends it; the client runs the timer
    // locally (smooth 60fps) and derives the per-column stagger from the agent id
    // so all viewers see an identical sweep. Only (re)seed when it starts.
    const me = ((cs.matrixEffect as string) || null) as Character['matrixEffect'];
    if (me && !rc.matrixEffect) {
      rc.matrixEffectTimer = (cs.matrixEffectTimer as number) || 0;
      rc.matrixEffectSeeds = matrixSeeds(rc.id);
    } else if (!me) {
      rc.matrixEffectTimer = 0;
      rc.matrixEffectSeeds = undefined;
    }
    rc.matrixEffect = me;
    rc.isSubagent = cs.isSubagent as boolean;
    rc.isPlayer = cs.isPlayer as boolean;
    rc.folderName = cs.folderName as string;
    rc.teamName = cs.teamName as string;
    rc.agentName = cs.agentName as string;
    rc.isTeamLead = cs.isTeamLead as boolean;
    rc.inputTokens = cs.inputTokens as number;
    rc.outputTokens = cs.outputTokens as number;
    rc.activity = (cs.activity as string) ?? '';
  }

  private applyPet(rp: RenderPet, ps: Record<string, unknown>): void {
    rp.tx = ps.x as number;
    rp.ty = ps.y as number;
    const k = ps.kind as number;
    rp.kind = (k === 1 ? 'cat' : k === 2 ? 'duck' : 'dog') as never;
    rp.variant = ps.variant as number;
    rp.dir = ps.dir as Pet['dir'];
    rp.state = ps.state as Pet['state'];
    rp.frame = ps.frame as number;
    rp.effect = ((ps.effect as string) || null) as never;
    rp.effectTimer = ps.effectTimer as number;
    rp.restLift = ps.restLift as number;
  }

  private rebuildFurniture(): void {
    const arr = (this.room!.state as {
      furniture: Array<{ type: string; col: number; row: number; name?: string }>;
    }).furniture;
    this.furniturePlacements = arr.map((f, i) => ({ uid: `f${i}`, type: f.type, col: f.col, row: f.row, name: f.name }));
    this.furnitureArr = layoutToFurnitureInstances(this.furniturePlacements);
  }

  /** True if the tile is a sittable seat (a 'chairs'-category furniture tile,
   *  below any walk-through backrest rows) — click it to sit. */
  private isSeatTile(col: number, row: number): boolean {
    for (const f of this.furniturePlacements) {
      const entry = getCatalogEntry(f.type);
      if (!entry || entry.category !== 'chairs') continue;
      const bg = entry.backgroundTiles ?? 0;
      if (col >= f.col && col < f.col + entry.footprintW && row >= f.row + bg && row < f.row + entry.footprintH) {
        return true;
      }
    }
    return false;
  }

  /** If the tile is covered by a conference monitor, its anchor tile (used as the
   *  monitor's stable id), else null. */
  private conferenceAnchorAt(col: number, row: number): { col: number; row: number; name?: string } | null {
    for (const f of this.furniturePlacements) {
      const entry = getCatalogEntry(f.type);
      if (!entry?.conference) continue;
      if (col >= f.col && col < f.col + entry.footprintW && row >= f.row && row < f.row + entry.footprintH) {
        return { col: f.col, row: f.row, name: f.name };
      }
    }
    return null;
  }

  private onLayout(layout: OfficeLayout): void {
    this.view.buildStatic();
    this.fitCamera(layout.cols * TILE_SIZE, layout.rows * TILE_SIZE);
  }

  /** Always update bounds (cheap, harmless), but only set zoom/center on the
   *  first layout — so live-edit broadcasts don't jerk the editor's or watchers'
   *  view on every change (only the office bounds grow on expand). */
  private fitCamera(w: number, h: number): void {
    const cam = this.cameras.main;
    cam.setBounds(-256, -256, w + 512, h + 512);
    if (this.cameraInitialized) return;
    const z = Math.min(this.scale.width / w, this.scale.height / h) * 0.95;
    cam.setZoom(z > 0 ? z : 2);
    cam.centerOn(w / 2, h / 2);
    this.cameraInitialized = true;
  }

  // ── Input: pan / zoom / hover / select ───────────────────────────

  private setupInput(): void {
    const cam = this.cameras.main;
    this.input.mouse?.disableContextMenu();
    this.input.on('wheel', (_p: unknown, _o: unknown, _dx: number, dy: number) => {
      cam.setZoom(Phaser.Math.Clamp(cam.zoom * (dy > 0 ? 0.9 : 1.1), 1, 14));
    });
    let dragging = false;
    let moved = false;
    let lx = 0;
    let ly = 0;
    // While a paint tool (floor/wall) is active, left-drag paints and right-drag
    // erases (v1 behaviour) — the camera pans with the middle mouse instead.
    let paintMode: 'paint' | 'erase' | null = null;
    this.input.on('pointerdown', (p: Phaser.Input.Pointer) => {
      unlockAudio(); // browsers require a gesture before audio can play
      dragging = true;
      moved = false;
      lx = p.x;
      ly = p.y;
      paintMode = null;
      if (this.editor.isEditing()) {
        const paintTool = this.editor.isPaintTool();
        if (paintTool && p.leftButtonDown()) {
          paintMode = 'paint';
          this.editor.beginStroke();
          this.editor.strokePaint(p.worldX, p.worldY, false);
        } else if (p.rightButtonDown()) {
          if (paintTool) {
            paintMode = 'erase';
            this.editor.beginStroke();
            this.editor.strokePaint(p.worldX, p.worldY, true);
          } else {
            this.editor.handleRightClick(p.worldX, p.worldY);
          }
        } else if (p.leftButtonDown()) {
          // Select tool: grabbing a furniture piece starts a drag-to-move
          // (returns false on empty space → falls through to pan/select).
          this.editor.beginFurnitureDrag(p.worldX, p.worldY);
        }
      }
    });
    this.input.on('pointerup', (p: Phaser.Input.Pointer) => {
      dragging = false;
      const wasPainting = paintMode !== null;
      paintMode = null;
      if (this.editor.isEditing() && this.editor.isDraggingFurniture()) {
        this.editor.endFurnitureDrag(p.worldX, p.worldY); // commits move, or selects if not moved
        return;
      }
      if (wasPainting) {
        this.editor.endStroke(); // commit the paint stroke (one undo step + flush)
        return;
      }
      if (moved) return; // a pan drag isn't a click
      // Arming "set arrival point": the next floor click sets this zone's arrive
      // tile (server-side; new arrivals land here). Takes precedence over walking.
      if (this.arrivePickActive && p.leftButtonReleased()) {
        this.arrivePickActive = false;
        const col = Math.floor(p.worldX / TILE_SIZE);
        const row = Math.floor(p.worldY / TILE_SIZE);
        this.room?.send('editZone', { id: currentZone(), arrive: { col, row } });
        setStatus(`Arrival point set to (${col}, ${row}).`);
        return;
      }
      if (this.editor.isEditing()) {
        if (p.leftButtonReleased()) {
          this.editor.handleLeftClick(p.worldX, p.worldY);
        }
      } else {
        const hit = this.hitTest(p.worldX, p.worldY);
        if (hit !== null) {
          this.selectedId = hit === this.selectedId ? null : hit;
        } else {
          this.selectedId = null;
          // Click a chair/bench → sit there; click empty floor → walk there (P2).
          // Spectators have no avatar (myPlayerId null) → no-op. Server validates.
          if (this.myPlayerId !== null && p.leftButtonReleased()) {
            const col = Math.floor(p.worldX / TILE_SIZE);
            const row = Math.floor(p.worldY / TILE_SIZE);
            const conf = this.conferenceAnchorAt(col, row);
            if (conf) void this.toggleConference(conf);
            else {
              this.pendingConference = null; // clicking elsewhere abandons a walk-to-monitor
              this.room?.send(this.isSeatTile(col, row) ? 'playerSitAt' : 'playerMove', { col, row });
            }
          }
        }
      }
    });
    this.input.on('pointermove', (p: Phaser.Input.Pointer) => {
      if (this.editor.isEditing()) {
        if (this.editor.isDraggingFurniture()) {
          this.editor.dragFurnitureTo(p.worldX, p.worldY); // suppresses pan
          this.input.manager.canvas.style.cursor = 'grabbing';
          return;
        }
        this.editor.updateGhost(p.worldX, p.worldY);
        this.hoveredId = null;
        this.input.manager.canvas.style.cursor = 'crosshair';
      } else {
        this.hoveredId = this.hitTest(p.worldX, p.worldY);
        this.input.manager.canvas.style.cursor = this.hoveredId !== null ? 'pointer' : 'default';
      }
      if (paintMode) {
        // Continuous drag-paint/erase — never pans the camera.
        this.editor.strokePaint(p.worldX, p.worldY, paintMode === 'erase');
        return;
      }
      if (dragging) {
        if (Math.abs(p.x - lx) + Math.abs(p.y - ly) > 2) moved = true;
        cam.scrollX -= (p.x - lx) / cam.zoom;
        cam.scrollY -= (p.y - ly) / cam.zoom;
        lx = p.x;
        ly = p.y;
      }
    });
    this.setupKeyboardMovement();
  }

  /**
   * WASD / arrow-key walking (control scheme "A"). Sends the held cardinal
   * direction to the server, which steps the avatar tile-by-tile (server-
   * authoritative); null on release. The most recently pressed key wins, so
   * releasing it resumes the previously held one. Ignored while editing, while
   * typing in a field, or when this viewer has no avatar (spectator).
   */
  private setupKeyboardMovement(): void {
    const KEY_DIR: Record<string, Direction> = {
      KeyW: Direction.UP,
      ArrowUp: Direction.UP,
      KeyS: Direction.DOWN,
      ArrowDown: Direction.DOWN,
      KeyA: Direction.LEFT,
      ArrowLeft: Direction.LEFT,
      KeyD: Direction.RIGHT,
      ArrowRight: Direction.RIGHT,
    };
    const held: string[] = []; // pressed movement keys, oldest → newest
    let sent: Direction | null = null;

    const blocked = (): boolean => {
      if (this.myPlayerId === null || this.editor.isEditing()) return true;
      const el = document.activeElement;
      const tag = el?.tagName;
      return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || (el as HTMLElement)?.isContentEditable === true;
    };

    const flush = (): void => {
      const dir = held.length ? KEY_DIR[held[held.length - 1]] : null;
      if (dir === sent) return;
      sent = dir;
      this.room?.send('playerDir', { dir });
    };

    window.addEventListener('keydown', (e) => {
      if (!(e.code in KEY_DIR) || e.repeat) return;
      if (blocked()) return;
      e.preventDefault();
      if (!held.includes(e.code)) held.push(e.code);
      flush();
    });
    window.addEventListener('keyup', (e) => {
      const i = held.indexOf(e.code);
      if (i === -1) return;
      held.splice(i, 1);
      flush();
    });
    // Lost focus (tab/window switch) → release so the avatar doesn't run on.
    window.addEventListener('blur', () => {
      if (held.length) {
        held.length = 0;
        flush();
      }
    });
    // Sit toggle (C): rest in place; moving stands the avatar back up (server-side).
    window.addEventListener('keydown', (e) => {
      if (e.code !== 'KeyC' || e.repeat || blocked()) return;
      e.preventDefault();
      const me = this.myPlayerId !== null ? this.characters.get(this.myPlayerId) : undefined;
      const sitting = me?.state === CharacterState.SIT;
      this.room?.send('playerSit', { sit: !sitting });
    });
  }

  /** A name the server's LayoutStore.isValidUserName will accept. */
  private isValidLayoutName(name: string): boolean {
    return /^[\x20-\x7e]{1,40}$/.test(name) && name !== 'Default';
  }

  /**
   * Toggle edit mode. Entering on the read-only Default auto-forks it into a
   * named user copy (prompt once) so live autosave has a writable target.
   */
  private async toggleEditMode(): Promise<void> {
    if (this.editor.isEditing()) {
      this.editor.toggle(); // exit (setEditMode flushes the final autosave)
      return;
    }
    // Every zone is now independently editable (its own layouts + Default).
    let target = this.layoutListData.active;
    let fork = false;
    if (!this.isValidLayoutName(target)) {
      const name = await promptDialog('Editing makes your own live copy. Name it:', 'My Office', { maxLength: 32 });
      if (name === null) return; // cancelled → don't enter edit
      target = name.trim();
      if (!this.isValidLayoutName(target)) {
        setStatus('Invalid name — 1–40 characters, and not “Default”.');
        return;
      }
      fork = true;
    }
    this.editTarget = target;
    this.editor.toggle(); // enter (editor.layout is now the working copy)
    // Fork: persist the current layout under the new name + make it active for all.
    if (fork && this.editor.layout) {
      this.room?.send('saveLayoutAs', { name: target, layout: this.editor.layout });
      setStatus(`Editing “${target}” — changes are live`);
    } else {
      setStatus(`Editing “${target}” — changes are live`);
    }
  }

  /** Debounced live autosave: broadcasts the edit to all viewers (and persists)
   *  via the idempotent saveLayoutAs. `immediate` flushes now (gesture done). */
  private autosaveLayout(layout: OfficeLayout, immediate: boolean): void {
    this.pendingLayout = layout;
    if (this.autosaveTimer) clearTimeout(this.autosaveTimer);
    this.autosaveTimer = undefined;
    if (immediate) this.flushAutosave();
    else this.autosaveTimer = setTimeout(() => this.flushAutosave(), 500);
  }

  private flushAutosave(): void {
    if (this.autosaveTimer) {
      clearTimeout(this.autosaveTimer);
      this.autosaveTimer = undefined;
    }
    if (!this.pendingLayout || !this.editTarget) return;
    this.room?.send('saveLayoutAs', { name: this.editTarget, layout: this.pendingLayout });
    this.pendingLayout = null;
  }

  /** Hit-test characters (topmost / front-most wins). */
  private hitTest(wx: number, wy: number): number | null {
    let best: number | null = null;
    let bestY = -Infinity;
    for (const ch of this.characters.values()) {
      const sit = ch.state === CharacterState.TYPE ? CHARACTER_SITTING_OFFSET_PX : 0;
      const cx = ch.x ?? ch.tx;
      const cy = (ch.y ?? ch.ty) + sit;
      // Hit box tracks the character's actual sprite size (anchored bottom-centre).
      const { w, h } = getCharacterSize(ch.skin ?? "");
      const halfW = w / 2;
      const hitH = (CHARACTER_HIT_HEIGHT * h) / CHARACTER_BASELINE_HEIGHT;
      if (
        wx >= cx - halfW &&
        wx <= cx + halfW &&
        wy >= cy - hitH &&
        wy <= cy &&
        cy > bestY
      ) {
        best = ch.id;
        bestY = cy;
      }
    }
    return best;
  }

  update(_time: number, delta: number): void {
    if (!this.room) return;
    // Close the destination picker once the avatar moves off the portal tile.
    if (this.portalPickerTile) {
      const me = this.myPlayerId !== null ? this.characters.get(this.myPlayerId) : undefined;
      const onTile =
        me &&
        Math.floor(me.tx / TILE_SIZE) === this.portalPickerTile.col &&
        Math.floor(me.ty / TILE_SIZE) === this.portalPickerTile.row;
      if (!onTile) {
        document.getElementById('pa-portal')?.remove();
        this.portalPickerTile = null;
      }
    }
    // While editing, furniture comes from the editor's local working copy; the
    // server-synced furniture is rebuilt again once editing ends.
    if (this.furnitureDirty && !this.editor.isEditing()) {
      this.rebuildFurniture();
      this.furnitureDirty = false;
    }
    // Smooth interpolation toward the latest authoritative positions.
    const k = 1 - Math.exp(-18 * Math.min(delta / 1000, 0.1));
    const dt = delta / 1000;
    for (const ch of this.characters.values()) {
      ch.x = (ch.x ?? ch.tx) + (ch.tx - (ch.x ?? ch.tx)) * k;
      ch.y = (ch.y ?? ch.ty) + (ch.ty - (ch.y ?? ch.ty)) * k;
      // Advance the Matrix effect locally for a smooth 60fps sweep; the server
      // only syncs ~20Hz and starts/ends the effect.
      if (ch.matrixEffect) ch.matrixEffectTimer = (ch.matrixEffectTimer ?? 0) + dt;
      // Client-side animation clock: the server syncs pose/dir, the frame phase
      // is cosmetic and timed here. Reset on pose change, then cycle at the
      // pose's cadence over its (spec-derived) playback length.
      const pose = (ch.pose ?? 'idle') as CharacterPose;
      if (ch.animPose !== pose) {
        ch.animPose = pose;
        ch.frame = 0;
        ch.animTimer = 0;
      } else {
        const durMs = POSE_FRAME_MS[pose] ?? 0;
        if (durMs > 0) {
          ch.animTimer = (ch.animTimer ?? 0) + delta;
          if (ch.animTimer >= durMs) {
            const len = getPosePlaybackLength(ch.skin ?? "", pose);
            while (ch.animTimer >= durMs) {
              ch.animTimer -= durMs;
              ch.frame = ((ch.frame ?? 0) + 1) % len;
            }
          }
        }
      }
    }
    for (const p of this.pets.values()) {
      p.x = (p.x ?? p.tx) + (p.tx - (p.x ?? p.tx)) * k;
      p.y = (p.y ?? p.ty) + (p.ty - (p.y ?? p.ty)) * k;
    }
    // Hide live agents/pets while editing — they sit on the server's (un-edited)
    // layout, so they'd appear to jump when the grid expands left/up.
    this.view.hideEntities = this.editor.isEditing();
    this.view.update();
    this.editor.tickUI();
    this.updateTooltip();
    this.updateNameLabels();
    this.updateChatBubbles();
    this.updateVoiceBubbles();
    this.tickChatFade();
  }

  // ── Menus (mutually-exclusive popovers) ──────────────────────────

  /**
   * Show exactly one of the top-bar popovers (Settings / Layouts / Chars /
   * Furniture), or none — opening one closes the others. The layout editor is
   * intentionally not managed here — it's the exception that stays open.
   */
  private async setMenu(menu: 'settings' | 'layouts' | 'zones' | 'help' | 'chars' | 'furniture' | null): Promise<void> {
    // Leaving an open character editor with unsaved edits → confirm/discard first.
    if (this.charEditor?.isOpen() && menu !== 'chars' && !(await this.charEditor.confirmLeave())) return;
    if (this.settingsPanel) this.settingsPanel.style.display = menu === 'settings' ? 'block' : 'none';
    if (this.layoutsPanel) this.layoutsPanel.style.display = menu === 'layouts' ? 'block' : 'none';
    if (this.zonesPanel) this.zonesPanel.style.display = menu === 'zones' ? 'block' : 'none';
    if (this.helpPanel) this.helpPanel.style.display = menu === 'help' ? 'block' : 'none';
    if (this.charEditor) menu === 'chars' ? this.charEditor.show() : this.charEditor.close();
    if (this.furnEditor) menu === 'furniture' ? this.furnEditor.show() : this.furnEditor.close();
    if (menu === 'layouts') this.room?.send('requestLayouts');
    if (menu === 'zones') this.room?.send('requestZones');
  }

  /** Edit mode owns the screen: close + disable the other menus while editing. */
  private setEditMode(editing: boolean): void {
    this.setMenu(null);
    for (const b of [this.settingsBtn, this.layoutsBtn, this.zonesBtn, this.helpBtn]) {
      if (!b) continue;
      b.disabled = editing;
      b.style.opacity = editing ? '0.4' : '';
      b.style.pointerEvents = editing ? 'none' : '';
    }
    // On exit, make sure the last edit reaches the server.
    if (!editing) {
      this.flushAutosave();
      this.editTarget = '';
    }
  }

  /** Reveal/collapse the menu-button row behind the single ☰ toggle. Collapsing
   *  also closes any open popover. */
  private toggleMenu(): void {
    if (!this.topbar) return;
    const open = this.topbar.style.display !== 'none';
    this.topbar.style.display = open ? 'none' : 'flex';
    if (open) void this.setMenu(null);
  }

  // ── Layouts panel (DOM overlay) ──────────────────────────────────

  private createLayoutsPanel(): void {
    const style = document.createElement('style');
    style.textContent = `
      .pa-ui{font-family:'FS Pixel Sans',ui-monospace,monospace;}
      /* Top-right toolbar: a flex row so the buttons auto-space at any UI scale. */
      /* One ☰ toggle (always visible) + a collapsible row of menu buttons. */
      #pa-menubar{position:fixed;top:0.5rem;right:0.5rem;z-index:60;display:flex;gap:0.5rem;align-items:flex-start;}
      #pa-topbar{display:flex;gap:0.5rem;flex-wrap:wrap;justify-content:flex-end;max-width:78vw;}
      #pa-menubar button,#pa-menubar select{cursor:pointer;background:#1b1f2a;border:2px solid #3a4150;border-radius:0.4rem;
        color:#eef1f6;font:1.15rem 'FS Pixel Sans',monospace;padding:0.5rem 0.9rem;white-space:nowrap;}
      #pa-menu-toggle{flex:0 0 auto;}
      #pa-layouts{position:fixed;top:3.4rem;right:0.5rem;z-index:60;display:none;width:22rem;
        background:#1b1f2a;border:2px solid #3a4150;border-radius:0.5rem;color:#eef1f6;
        padding:0.75rem;box-shadow:0 4px 0 rgba(0,0,0,.4);}
      #pa-layouts h4{margin:0 0 0.6rem;font-size:1.25rem;color:#cdd3dd;}
      #pa-layouts .item{display:flex;align-items:center;gap:0.5rem;padding:0.3rem 0;font-size:1.1rem;}
      #pa-layouts .item .nm{flex:1;overflow:hidden;text-overflow:ellipsis;}
      #pa-layouts .item .active{color:#ffd24a;}
      #pa-layouts button{cursor:pointer;background:#2a2f3a;border:1px solid #3a4150;color:#eef1f6;
        border-radius:0.25rem;font:1rem 'FS Pixel Sans',monospace;padding:0.3rem 0.6rem;}
      #pa-layouts .foot{margin-top:0.75rem;display:flex;flex-direction:column;gap:0.5rem;}
      #pa-layouts .foot button{padding:0.55rem;}
      #pa-layouts .foot button.edit{background:#2f6f3a;border-color:#3f8f4a;font-size:1.15rem;}
      /* Zones manager — mirrors the layouts panel. */
      #pa-zones{position:fixed;top:3.4rem;right:0.5rem;z-index:60;display:none;width:22rem;
        background:#1b1f2a;border:2px solid #3a4150;border-radius:0.5rem;color:#eef1f6;
        padding:0.75rem;box-shadow:0 4px 0 rgba(0,0,0,.4);}
      #pa-zones h4{margin:0 0 0.6rem;font-size:1.25rem;color:#cdd3dd;}
      #pa-zones .item{display:flex;align-items:center;gap:0.5rem;padding:0.3rem 0;font-size:1.1rem;}
      #pa-zones .item .nm{flex:1;overflow:hidden;text-overflow:ellipsis;}
      #pa-zones .item .here{color:#ffd24a;}
      #pa-zones .item small{color:#7d8597;}
      #pa-zones button{cursor:pointer;background:#2a2f3a;border:1px solid #3a4150;color:#eef1f6;
        border-radius:0.25rem;font:1rem 'FS Pixel Sans',monospace;padding:0.3rem 0.6rem;}
      #pa-zones .foot{margin-top:0.75rem;border-top:1px solid #2c323e;padding-top:0.6rem;display:flex;
        flex-direction:column;gap:0.45rem;}
      #pa-zones .foot input{background:#11151d;border:1px solid #3a4150;color:#eef1f6;border-radius:0.25rem;
        padding:0.4rem 0.5rem;font:1rem 'FS Pixel Sans',monospace;}
      #pa-zones .foot .sz{display:flex;gap:0.4rem;}
      #pa-zones .foot .sz input{width:50%;}
      #pa-zones .foot button.new{background:#2f5f8f;border-color:#3f7fbf;padding:0.55rem;font-size:1.1rem;}
      /* Help / controls reference. */
      #pa-help{position:fixed;top:3.4rem;right:0.5rem;z-index:60;display:none;width:26rem;max-width:92vw;
        background:#1b1f2a;border:2px solid #3a4150;border-radius:0.5rem;color:#eef1f6;
        padding:0.75rem;box-shadow:0 4px 0 rgba(0,0,0,.4);}
      #pa-help h4{margin:0 0 0.6rem;font-size:1.25rem;color:#cdd3dd;}
      #pa-help .row{display:flex;align-items:baseline;gap:0.6rem;padding:0.28rem 0;font-size:1.05rem;}
      #pa-help kbd{flex:0 0 11rem;color:#9ad0ff;font-family:inherit;}
      #pa-help .row span{color:#dfe4ee;}
    `;
    document.head.appendChild(style);

    const host = document.getElementById('game') ?? document.body;
    // A single ☰ toggle (always visible) reveals the menu-button row.
    const menubar = document.createElement('div');
    menubar.id = 'pa-menubar';
    menubar.className = 'pa-ui';
    const topbar = document.createElement('div');
    topbar.id = 'pa-topbar';
    topbar.className = 'pa-ui';
    topbar.style.display = 'none'; // collapsed by default
    const toggle = document.createElement('button');
    toggle.id = 'pa-menu-toggle';
    toggle.textContent = '☰';
    toggle.title = 'Menu';
    toggle.onclick = () => this.toggleMenu();
    menubar.append(topbar, toggle); // buttons to the left, ☰ on the right
    host.appendChild(menubar);
    this.topbar = topbar;
    this.menubar = menubar;

    // Zone switcher: pick a zone → reconnect to its room (reload-based; a walk-in
    // portal lands with the player). Options come from the live registry.
    const zoneSel = document.createElement('select');
    zoneSel.id = 'pa-zone';
    zoneSel.title = 'Zone';
    zoneSel.onchange = () => this.goToZone(zoneSel.value);
    this.zoneSel = zoneSel;
    topbar.appendChild(zoneSel);
    this.renderZoneSwitcher();

    const btn = document.createElement('button');
    btn.id = 'pa-layouts-btn';
    btn.textContent = '⚙ Layouts';
    this.layoutsBtn = btn;
    const panel = document.createElement('div');
    panel.id = 'pa-layouts';
    panel.className = 'pa-ui';
    btn.onclick = () => this.setMenu(panel.style.display === 'block' ? null : 'layouts');

    // Zones manager (create / edit / delete).
    const zbtn = document.createElement('button');
    zbtn.id = 'pa-zones-btn';
    zbtn.textContent = '🌍 Zones';
    this.zonesBtn = zbtn;
    const zpanel = document.createElement('div');
    zpanel.id = 'pa-zones';
    zpanel.className = 'pa-ui';
    zbtn.onclick = () => this.setMenu(zpanel.style.display === 'block' ? null : 'zones');

    // Help (keyboard + mouse reference).
    const hbtn = document.createElement('button');
    hbtn.id = 'pa-help-btn';
    hbtn.textContent = '❓ Help';
    this.helpBtn = hbtn;
    const hpanel = document.createElement('div');
    hpanel.id = 'pa-help';
    hpanel.className = 'pa-ui';
    hbtn.onclick = () => this.setMenu(hpanel.style.display === 'block' ? null : 'help');

    topbar.append(btn, zbtn, hbtn);
    host.append(panel, zpanel, hpanel);
    this.layoutsPanel = panel;
    this.zonesPanel = zpanel;
    this.helpPanel = hpanel;
    this.renderLayoutsPanel();
    this.renderZonesPanel();
    this.renderHelpPanel();
  }

  private renderHelpPanel(): void {
    if (!this.helpPanel) return;
    const rows: Array<[string, string]> = [
      ['W A S D / Arrows', 'Move'],
      ['Left-click floor', 'Walk there'],
      ['Left-click chair / bench', 'Sit down'],
      ['C', 'Sit / stand (in place)'],
      ['Walk onto a door / beam pad', 'Choose a destination zone'],
      ['Enter', 'Chat — focus, then send (cursor stays)'],
      ['Esc', 'Leave the chat field'],
      ['Click an avatar', 'Select (show tooltip)'],
      ['Mouse wheel', 'Zoom'],
      ['Drag (empty space)', 'Pan the camera'],
      ['🌍 Zones', 'Create / edit / delete zones, set arrival, NPCs'],
      ['⚙ Layouts → ✏ Edit', 'Edit this zone’s layout'],
    ];
    this.helpPanel.innerHTML =
      `<h4>Controls</h4>` +
      rows.map(([k, v]) => `<div class="row"><kbd>${esc(k)}</kbd><span>${esc(v)}</span></div>`).join('');
  }

  /** (Re)populate the top-bar zone switcher from the live registry. */
  private renderZoneSwitcher(): void {
    const sel = this.zoneSel;
    if (!sel) return;
    const cur = currentZone();
    sel.innerHTML = '';
    for (const z of this.zoneList) {
      const o = document.createElement('option');
      o.value = z.id;
      o.textContent = `🚪 ${z.label}`;
      sel.appendChild(o);
    }
    // Keep the current zone selected even if it isn't in the list yet.
    if (!this.zoneList.some((z) => z.id === cur)) {
      const o = document.createElement('option');
      o.value = cur;
      o.textContent = `🚪 ${cur}`;
      sel.appendChild(o);
    }
    sel.value = cur;
  }

  private updateZoneList(msg: Record<string, unknown>): void {
    const zones = msg.zones as ZoneConfig[] | undefined;
    if (Array.isArray(zones) && zones.length) this.zoneList = zones;
    // The server may have resolved us into a different zone than requested
    // (e.g. an unknown id fell back to the office) — remember the real one.
    const cur = msg.current as string | undefined;
    if (isZoneId(cur)) {
      try {
        localStorage.setItem('pa-last-zone', cur);
      } catch {
        /* localStorage unavailable */
      }
    }
    this.renderZoneSwitcher();
    this.renderZonesPanel();
  }

  private updateLayoutsPanel(msg: Record<string, unknown>): void {
    this.layoutListData = {
      layouts: (msg.layouts as Array<{ name: string; readOnly: boolean }>) ?? [],
      active: (msg.active as string) ?? 'Default',
    };
    this.renderLayoutsPanel();
  }

  private renderLayoutsPanel(): void {
    if (!this.layoutsPanel) return;
    const { layouts, active } = this.layoutListData;
    const send = (type: string, payload?: Record<string, unknown>) => this.room?.send(type, payload);

    const rows = layouts
      .map((l) => {
        const isActive = l.name === active;
        const buttons =
          (isActive ? '<span class="active">● active</span>' : `<button data-load="${esc(l.name)}">Load</button>`) +
          (l.readOnly ? '' : ` <button data-del="${esc(l.name)}">✕</button>`);
        return `<div class="item"><span class="nm ${isActive ? 'active' : ''}">${esc(l.name)}</span>${buttons}</div>`;
      })
      .join('');

    const cur = currentZone();
    const zoneLabel = this.zoneList.find((z) => z.id === cur)?.label ?? 'Zone';
    this.layoutsPanel.innerHTML =
      `<h4>${esc(zoneLabel)} Layouts</h4>${rows}` +
      `<div class="foot">
         <button data-edit class="edit">✏ Edit layout</button>
         <button data-new>New from current…</button>
         <button data-default>Reset to Default</button>
       </div>`;

    // Enter the layout editor. Exclusive with the popovers: setEditMode closes
    // them; the editor's own ✓ Done button exits (so it needn't live up here).
    this.layoutsPanel.querySelector<HTMLButtonElement>('[data-edit]')!.onclick = () => {
      this.setMenu(null);
      void this.toggleEditMode();
    };

    this.layoutsPanel.querySelectorAll<HTMLButtonElement>('[data-load]').forEach((b) => {
      b.onclick = () => send('loadLayout', { name: b.dataset.load });
    });
    this.layoutsPanel.querySelectorAll<HTMLButtonElement>('[data-del]').forEach((b) => {
      b.onclick = async () => {
        if (await confirmDialog(`Delete layout "${b.dataset.del}"?`, { danger: true, confirmLabel: 'Delete' }))
          send('deleteLayout', { name: b.dataset.del });
      };
    });
    this.layoutsPanel.querySelector<HTMLButtonElement>('[data-new]')!.onclick = async () => {
      const name = await promptDialog('New layout name (saved from the current office):', '', { maxLength: 32 });
      if (name) send('saveLayoutAs', { name, layout: this.os.getLayout() });
    };
    this.layoutsPanel.querySelector<HTMLButtonElement>('[data-default]')!.onclick = () =>
      send('loadLayout', { name: 'Default' });
  }

  // ── Zones panel (create / edit / delete) ─────────────────────────

  private renderZonesPanel(): void {
    if (!this.zonesPanel) return;
    const cur = currentZone();
    const send = (type: string, payload?: Record<string, unknown>) => this.room?.send(type, payload);
    // Travelling is open to all. Creating/deleting zones + granting zone admins
    // is global-admin only; editing a zone (layout/rename/NPCs/arrival) is open
    // to that zone's admin too — but the client only knows its OWN zone-admin
    // status for the CURRENT zone, so per-row edit beyond the current zone needs
    // global admin. (open dev mode without accounts → everyone edits.)
    const assetsAdmin = this.assetsAdmin;

    const rows = this.zoneList
      .map((z) => {
        const here = z.id === cur;
        const rowEdit = assetsAdmin || (here && this.myZoneAdmin);
        const tag = here ? '<span class="here">● here</span>' : `<button data-go="${esc(z.id)}">Go</button>`;
        const lock = z.readOnly ? ' 🔒' : '';
        const npcN = z.npc == null ? 'all' : String(z.npc.length);
        let ctrls = '';
        if (rowEdit)
          ctrls += `<button data-npc="${esc(z.id)}" title="NPCs in this zone">🐾</button><button data-edit="${esc(z.id)}">✎</button>`;
        if (assetsAdmin && !z.readOnly) ctrls += `<button data-del="${esc(z.id)}">✕</button>`;
        if (assetsAdmin) ctrls += `<button data-admins="${esc(z.id)}" title="Zone admins">👤</button>`;
        return `<div class="item"><span class="nm ${here ? 'here' : ''}">${esc(z.label)}${lock}<br><small>${esc(z.id)} · 🐾${npcN}</small></span>${tag}${ctrls}</div>`;
      })
      .join('');

    const footParts: string[] = [];
    if (this.zoneEditAdmin) footParts.push(`<button data-arrive>📍 Set arrival point (this zone)</button>`);
    if (assetsAdmin)
      footParts.push(
        `<input id="pa-z-label" type="text" maxlength="32" placeholder="New zone name" />
         <div class="sz">
           <input id="pa-z-cols" type="number" min="6" max="64" value="20" title="Width (tiles)" />
           <input id="pa-z-rows" type="number" min="6" max="64" value="14" title="Height (tiles)" />
         </div>
         <button data-new class="new">＋ Create zone</button>`,
      );
    const foot = footParts.length ? `<div class="foot">${footParts.join('')}</div>` : '';
    this.zonesPanel.innerHTML = `<h4>Zones</h4>${rows}${foot}`;

    this.zonesPanel.querySelectorAll<HTMLButtonElement>('[data-go]').forEach((b) => {
      b.onclick = () => this.goToZone(b.dataset.go!);
    });
    this.zonesPanel.querySelectorAll<HTMLButtonElement>('[data-edit]').forEach((b) => {
      b.onclick = () => void this.editZoneDialog(b.dataset.edit!);
    });
    this.zonesPanel.querySelectorAll<HTMLButtonElement>('[data-npc]').forEach((b) => {
      b.onclick = () => this.showZoneNpcEditor(b.dataset.npc!);
    });
    this.zonesPanel.querySelectorAll<HTMLButtonElement>('[data-del]').forEach((b) => {
      b.onclick = async () => {
        const z = this.zoneList.find((x) => x.id === b.dataset.del);
        if (await confirmDialog(`Delete zone "${z?.label ?? b.dataset.del}" and its layouts?`, { danger: true, confirmLabel: 'Delete' }))
          send('deleteZone', { id: b.dataset.del });
      };
    });
    // Grant/revoke a per-zone admin (global admin): prompt for a login id; the
    // server toggles it and replies with the current admin list.
    this.zonesPanel.querySelectorAll<HTMLButtonElement>('[data-admins]').forEach((b) => {
      b.onclick = async () => {
        const id = b.dataset.admins!;
        const uid = await promptDialog(`Toggle a zone admin for “${id}” — enter a user login id:`, '', {
          maxLength: 32,
          confirmLabel: 'Toggle',
        });
        if (uid && uid.trim()) send('setZoneAdmin', { zoneId: id, userId: uid.trim() });
      };
    });
    const arrive = this.zonesPanel.querySelector<HTMLButtonElement>('[data-arrive]');
    if (arrive)
      arrive.onclick = () => {
        this.arrivePickActive = true;
        this.setMenu(null);
        setStatus('Click a floor tile to set where players arrive in this zone.');
      };
    const newBtn = this.zonesPanel.querySelector<HTMLButtonElement>('[data-new]');
    if (newBtn)
      newBtn.onclick = () => {
        const label = (this.zonesPanel.querySelector('#pa-z-label') as HTMLInputElement)?.value.trim() ?? '';
        const cols = Number((this.zonesPanel.querySelector('#pa-z-cols') as HTMLInputElement)?.value);
        const rows = Number((this.zonesPanel.querySelector('#pa-z-rows') as HTMLInputElement)?.value);
        if (!label) {
          setStatus('Enter a name for the new zone.');
          return;
        }
        send('createZone', { label, cols, rows });
      };
  }

  /** Edit a zone's label (and arrival tile via "col,row"). */
  private async editZoneDialog(id: string): Promise<void> {
    const z = this.zoneList.find((x) => x.id === id);
    if (!z) return;
    const label = await promptDialog(`Rename zone "${z.label}":`, z.label, { maxLength: 32 });
    if (label === null) return;
    const name = label.trim();
    if (!name) {
      setStatus('A zone name can’t be empty.');
      return;
    }
    this.room?.send('editZone', { id, label: name });
  }

  /** A zone was just created (by this viewer) → offer to jump straight to it. */
  private async offerJumpToNewZone(id: string): Promise<void> {
    if (!isZoneId(id)) return;
    if (await confirmDialog(`Zone created. Go there now?`, { confirmLabel: 'Go' })) this.goToZone(id);
  }

  // ── Conference monitors (C-RTC) ──────────────────────────────────

  /** Join (or leave, if already in it) a conference monitor by its anchor tile. */
  private async toggleConference(anchor: { col: number; row: number; name?: string }): Promise<void> {
    const key = `${anchor.col},${anchor.row}`;
    if (this.myConference && `${this.myConference.col},${this.myConference.row}` === key) {
      this.room?.send('conferenceLeave', { col: anchor.col, row: anchor.row });
      this.leaveConferenceLocal();
      return;
    }
    // Confirm before joining (it turns your camera/mic on).
    const label = conferenceLabel(anchor.name, anchor.col, anchor.row);
    if (!(await confirmDialog(`Join the conference “${label}”?`, { confirmLabel: 'Join' }))) return;
    // Walk to the monitor first; the server joins us on arrival (→ conferenceMembers),
    // then we connect the media. Leave any current call.
    if (this.myConference) {
      this.room?.send('conferenceLeave', this.myConference);
      this.leaveConferenceLocal();
    }
    this.pendingConference = { ...anchor };
    this.room?.send('conferenceApproach', { col: anchor.col, row: anchor.row });
  }

  /** Tear down the local call (disconnect LiveKit) and clear our membership. */
  private leaveConferenceLocal(): void {
    this.myConference = null;
    this.pendingConference = null;
    void this.conf?.disconnect();
    this.conf = undefined;
    this.confState = { connected: false, camOn: true, micOn: true, screenOn: false };
    this.confDevices = { cameras: [], mics: [], speakers: [] };
    this.renderConferencePanel();
    // Back out of the meeting → rejoin zone voice if the user had it on.
    this.zoneVoice?.voice.resume();
  }

  private onConferenceMembers(m: Record<string, unknown>): void {
    const key = `${m.col},${m.row}`;
    const members = (m.members as Array<{ id: number; name: string }>) ?? [];
    if (members.length) this.conferenceMembers.set(key, members);
    else this.conferenceMembers.delete(key);
    const iAmIn = this.myPlayerId !== null && members.some((p) => p.id === this.myPlayerId);
    // Arrived + joined by the server (walk-to-monitor) → connect our media now.
    if (
      iAmIn &&
      !this.myConference &&
      this.pendingConference &&
      `${this.pendingConference.col},${this.pendingConference.row}` === key
    ) {
      this.myConference = this.pendingConference;
      this.pendingConference = null;
      this.confState = { connected: false, camOn: true, micOn: true, screenOn: false };
      this.room?.send('conferenceToken', this.myConference); // → media
    }
    // If the server dropped us from our call (despawn, zone change, …), tear down.
    if (this.myConference && `${this.myConference.col},${this.myConference.row}` === key && !iAmIn) {
      this.leaveConferenceLocal();
      return;
    }
    this.renderConferencePanel();
  }

  /** Server minted a LiveKit token (or reported it's unconfigured). Connect the
   *  media for the call we're currently in. */
  /** Interpolated pixel position of a player avatar, for proximity audio. */
  private playerPosition(id: number | null): { x: number; y: number } | null {
    if (id === null) return null;
    const c = this.characters.get(id);
    if (!c) return null;
    const x = c.x ?? c.tx;
    const y = c.y ?? c.ty;
    return typeof x === 'number' && typeof y === 'number' ? { x, y } : null;
  }

  private onConferenceToken(m: Record<string, unknown>): void {
    if (!this.myConference || `${this.myConference.col},${this.myConference.row}` !== `${m.col},${m.row}`) return;
    if (m.error === 'not-configured' || typeof m.url !== 'string' || typeof m.token !== 'string') {
      this.confState = { ...this.confState, error: 'Video not configured on the server.' };
      this.renderConferencePanel();
      return;
    }
    if (!this.confGrid) return;
    this.conf = new LiveKitConference(
      this.confGrid,
      (s) => {
        this.confState = s;
        this.renderConferencePanel();
      },
      (d) => {
        this.confDevices = d;
        this.renderConferencePanel();
      },
    );
    // You can't be in two voice calls at once — pause zone voice while in the
    // meeting (resumed in leaveConferenceLocal).
    this.zoneVoice?.voice.suspend();
    void this.conf.connect(m.url as string, m.token as string).catch(() => {
      /* connect() reports via the state callback */
    });
  }

  private createConferencePanel(): void {
    const style = document.createElement('style');
    style.textContent = `
      #pa-conf{position:fixed;left:50%;bottom:0.5rem;transform:translateX(-50%);z-index:56;display:none;
        flex-direction:column;gap:0.4rem;max-width:92vw;background:rgba(20,24,33,.92);border:2px solid #3a4150;
        border-radius:0.5rem;color:#eef1f6;padding:0.5rem 0.6rem;font:1rem 'FS Pixel Sans',monospace;}
      #pa-conf-grid{display:flex;flex-wrap:wrap;gap:0.4rem;justify-content:center;max-height:42vh;overflow:auto;}
      #pa-conf-bar{display:flex;align-items:center;gap:0.6rem;justify-content:center;}
      #pa-conf-bar b{color:#9ad0ff;}
      #pa-conf-bar .err{color:#ff9a9a;}
      #pa-conf-bar button{cursor:pointer;background:#2a2f3a;border:1px solid #3a4150;color:#eef1f6;
        border-radius:0.35rem;font:0.95rem 'FS Pixel Sans',monospace;padding:0.35rem 0.7rem;}
      #pa-conf-bar button.leave{background:#7a2f2f;border-color:#a14a4a;color:#fff;}
      #pa-conf-bar button.off{opacity:0.55;}
      #pa-conf-bar button.active{background:#2f6f3a;border-color:#3f8f4a;color:#fff;}
      #pa-conf-bar select{max-width:11rem;background:#2a2f3a;border:1px solid #3a4150;color:#eef1f6;
        border-radius:0.35rem;font:0.9rem 'FS Pixel Sans',monospace;padding:0.3rem 0.4rem;}
    `;
    document.head.appendChild(style);
    const panel = document.createElement('div');
    panel.id = 'pa-conf';
    panel.className = 'pa-ui';
    const grid = document.createElement('div');
    grid.id = 'pa-conf-grid'; // LiveKitConference attaches video tiles here
    const bar = document.createElement('div');
    bar.id = 'pa-conf-bar';
    panel.append(grid, bar);
    (document.getElementById('game') ?? document.body).appendChild(panel);
    this.confPanel = panel;
    this.confGrid = grid;
    this.confBar = bar;
  }

  /** Update the conference bar (roster + cam/mic/leave) + panel visibility. The
   *  video grid is managed live by LiveKitConference and never rebuilt here. */
  private renderConferencePanel(): void {
    const panel = this.confPanel;
    const bar = this.confBar;
    if (!panel || !bar) return;
    if (!this.myConference) {
      panel.style.display = 'none';
      bar.innerHTML = '';
      return;
    }
    const key = `${this.myConference.col},${this.myConference.row}`;
    const members = this.conferenceMembers.get(key) ?? [];
    const names = members.map((p) => (p.id === this.myPlayerId ? 'You' : p.name)).join(', ') || 'just you';
    const clabel = conferenceLabel(this.myConference.name, this.myConference.col, this.myConference.row);
    const st = this.confState;
    const status = st.error ? `<span class="err">${esc(st.error)}</span>` : st.connected ? '🟢 live' : '… connecting';
    // Device pickers — only when there's a choice (more than one of that kind).
    const d = this.confDevices;
    const picker = (icon: string, attr: string, list: MediaDeviceInfo[], active?: string): string => {
      if (list.length < 2) return '';
      const opts = list
        .map((dev, i) => {
          const sel = dev.deviceId === active ? ' selected' : '';
          return `<option value="${esc(dev.deviceId)}"${sel}>${esc(dev.label || `${icon} ${i + 1}`)}</option>`;
        })
        .join('');
      return `<select ${attr} title="${icon}">${opts}</select>`;
    };
    bar.innerHTML =
      `<span>📹 <b>${esc(clabel)}</b> — ${esc(names)} · ${status}</span>` +
      (st.connected
        ? `<button data-cam class="${st.camOn ? '' : 'off'}">${st.camOn ? '📷 Cam' : '🚫 Cam'}</button>` +
          `<button data-mic class="${st.micOn ? '' : 'off'}">${st.micOn ? '🎙 Mic' : '🔇 Mic'}</button>` +
          `<button data-screen class="${st.screenOn ? 'active' : ''}">${st.screenOn ? '🖥 Stop' : '🖥 Share'}</button>` +
          picker('📷', 'data-camsel', d.cameras, d.camId) +
          picker('🎙', 'data-micsel', d.mics, d.micId) +
          picker('🔊', 'data-spksel', d.speakers, d.speakerId)
        : '') +
      `<button data-leave class="leave">Leave</button>`;
    bar.querySelector<HTMLButtonElement>('[data-leave]')!.onclick = () => {
      if (this.myConference) void this.toggleConference(this.myConference);
    };
    bar.querySelector<HTMLButtonElement>('[data-cam]')?.addEventListener('click', () => void this.conf?.toggleCam());
    bar.querySelector<HTMLButtonElement>('[data-mic]')?.addEventListener('click', () => void this.conf?.toggleMic());
    bar.querySelector<HTMLButtonElement>('[data-screen]')?.addEventListener('click', () => void this.conf?.toggleScreen());
    bar.querySelector<HTMLSelectElement>('[data-camsel]')?.addEventListener('change', (e) =>
      void this.conf?.switchCamera((e.target as HTMLSelectElement).value));
    bar.querySelector<HTMLSelectElement>('[data-micsel]')?.addEventListener('change', (e) =>
      void this.conf?.switchMic((e.target as HTMLSelectElement).value));
    bar.querySelector<HTMLSelectElement>('[data-spksel]')?.addEventListener('change', (e) =>
      void this.conf?.switchSpeaker((e.target as HTMLSelectElement).value));
    panel.style.display = 'flex';
  }

  /** Per-zone NPC editor: which pet variants spawn in this zone. Checkboxes come
   *  from the loaded roster; toggling one sends setZoneNpc immediately. Sends
   *  null ("all, incl. future variants") when every box is checked. */
  private showZoneNpcEditor(id: string): void {
    const zone = this.zoneList.find((z) => z.id === id);
    if (!zone) return;
    const roster = getNpcRoster().map((r) => ({ key: `${r.kind}_${r.variant}`, label: `${r.kind} ${r.variant}` }));
    const enabled = new Set(zone.npc == null ? roster.map((r) => r.key) : zone.npc);

    document.getElementById('pa-znpc')?.remove();
    const el = document.createElement('div');
    el.id = 'pa-znpc';
    el.className = 'pa-ui';
    el.style.cssText =
      'position:fixed;left:50%;top:50%;transform:translate(-50%,-50%);z-index:85;background:#1b1f2a;' +
      'border:2px solid #3a4150;border-radius:0.6rem;padding:1rem;color:#eef1f6;min-width:14rem;max-height:70vh;' +
      "overflow:auto;font:1rem 'FS Pixel Sans',monospace;box-shadow:0 6px 0 rgba(0,0,0,.4);";

    const send = (): void => {
      const keys = roster.map((r) => r.key).filter((k) => enabled.has(k));
      const npc = keys.length === roster.length ? null : keys; // all → null (future-proof)
      this.room?.send('setZoneNpc', { id, npc });
    };

    const head = document.createElement('div');
    head.textContent = `🐾 NPCs — ${zone.label}`;
    head.style.cssText = 'font-size:1.15rem;margin-bottom:0.6rem;color:#cdd3dd;';
    el.appendChild(head);

    if (!roster.length) {
      const none = document.createElement('div');
      none.textContent = 'No NPC variants loaded.';
      none.style.cssText = 'color:#9aa3b2;margin-bottom:0.6rem;';
      el.appendChild(none);
    }
    for (const r of roster) {
      const row = document.createElement('label');
      row.style.cssText = 'display:flex;align-items:center;gap:0.5rem;padding:0.25rem 0;cursor:pointer;';
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = enabled.has(r.key);
      cb.onchange = () => {
        cb.checked ? enabled.add(r.key) : enabled.delete(r.key);
        send();
      };
      const span = document.createElement('span');
      span.textContent = r.label;
      row.append(cb, span);
      el.appendChild(row);
    }

    const bar = document.createElement('div');
    bar.style.cssText = 'display:flex;gap:0.5rem;margin-top:0.7rem;';
    const mk = (txt: string, fn: () => void): HTMLButtonElement => {
      const b = document.createElement('button');
      b.textContent = txt;
      b.style.cssText =
        'flex:1;padding:0.4rem;cursor:pointer;background:#2a2f3a;border:1px solid #3a4150;border-radius:0.4rem;' +
        "color:#eef1f6;font:0.95rem 'FS Pixel Sans',monospace;";
      b.onclick = fn;
      return b;
    };
    bar.append(
      mk('All', () => {
        roster.forEach((r) => enabled.add(r.key));
        send();
        this.showZoneNpcEditor(id); // re-render checkboxes
      }),
      mk('None', () => {
        enabled.clear();
        send();
        this.showZoneNpcEditor(id);
      }),
      mk('Close', () => el.remove()),
    );
    el.appendChild(bar);
    (document.getElementById('game') ?? document.body).appendChild(el);
  }

  // ── Sounds + settings ────────────────────────────────────────────

  /** Play chimes on agent transitions — only for the viewer's own agents. */
  private checkSounds(id: number, cs: Record<string, unknown>): void {
    const p = this.prevState.get(id) ?? { active: false, bubble: '' };
    const folderName = (cs.folderName as string) ?? '';
    const mine = !this.viewerUsername || folderName === this.viewerUsername;
    const active = !!cs.isActive;
    const bubble = (cs.bubble as string) ?? '';
    // Chime once when the turn genuinely finishes — signalled by the "done"
    // (waiting) bubble appearing. Keying off this rather than every isActive drop
    // means mid-task pauses (which go 'idle' silently) no longer chime; only the
    // turn end does, like v1.
    if (mine && p.bubble !== 'waiting' && bubble === 'waiting') void playDoneSound();
    if (mine && p.bubble !== 'permission' && bubble === 'permission') void playPermissionSound();
    this.prevState.set(id, { active, bubble });
  }

  private applySettings(m: Record<string, unknown>): void {
    this.soundOn = m.soundEnabled !== false;
    this.volume = typeof m.alertVolume === 'number' ? (m.alertVolume as number) : 1;
    this.alwaysShowLabels = !!m.alwaysShowLabels;
    setSoundEnabled(this.soundOn);
    setAlertVolume(this.volume);
    this.syncSettingsInputs();
    if (!this.alwaysShowLabels) this.clearNameLabels();
  }

  private createSettingsPanel(): void {
    const style = document.createElement('style');
    style.textContent = `
      #pa-settings{position:fixed;top:3.4rem;right:0.5rem;z-index:60;display:none;width:19rem;
        max-height:calc(100vh - 4.4rem);overflow-y:auto;overscroll-behavior:contain;
        background:#1b1f2a;border:2px solid #3a4150;border-radius:0.5rem;color:#eef1f6;padding:0.9rem;
        font-family:'FS Pixel Sans',monospace;box-shadow:0 4px 0 rgba(0,0,0,.4);}
      #pa-settings h4{margin:0 0 0.75rem;font-size:1.25rem;color:#cdd3dd;}
      #pa-settings .row{display:flex;align-items:center;gap:0.5rem;margin:0.65rem 0;font-size:1rem;}
      #pa-settings .row input[type=range]{flex:1;}
      #pa-settings .row label{flex:1;}
      #pa-settings .row input[type=text]{flex:1;min-width:0;background:#14161c;color:#eef1f6;
        border:2px solid #3a4150;border-radius:0.3rem;padding:0.3rem 0.45rem;font:0.95rem 'FS Pixel Sans',monospace;}
      #pa-settings .hint{font-size:0.8rem;color:#8b93a3;margin:-0.25rem 0 0.65rem;}
      #pa-char,#pa-pchar{display:flex;gap:0.4rem;flex-wrap:wrap;margin:0.3rem 0 0.65rem;}
      #pa-char canvas,#pa-pchar canvas{width:2rem;height:4rem;image-rendering:pixelated;background:#14161c;
        border:2px solid #3a4150;border-radius:0.3rem;cursor:pointer;}
      #pa-char canvas.sel,#pa-pchar canvas.sel{border-color:#3a6df0;}
      #pa-char .rnd,#pa-pchar .rnd{width:2rem;height:4rem;display:flex;align-items:center;justify-content:center;
        background:#14161c;border:2px solid #3a4150;border-radius:0.3rem;cursor:pointer;font-size:1.1rem;}
      #pa-char .rnd.sel,#pa-pchar .rnd.sel{border-color:#3a6df0;}
      #pa-avatar{display:flex;gap:0.6rem;align-items:center;margin:0.3rem 0 0.2rem;}
      #pa-avatar canvas{width:2rem;height:4rem;image-rendering:pixelated;background:#14161c;
        border:2px solid #3a4150;border-radius:0.3rem;}
      #pa-avatar .pa-av-btns{display:flex;flex-direction:column;gap:0.35rem;flex:1;}
      #pa-avatar button,#pa-account button{background:#2a2f3a;border:1px solid #3a4150;color:#eef1f6;
        border-radius:0.3rem;font:0.9rem 'FS Pixel Sans',monospace;padding:0.4rem;cursor:pointer;}
      #pa-avatar button:disabled,#pa-account button:disabled{opacity:0.5;cursor:default;}
      /* Account buttons fill their row (single → full width; pair → split evenly). */
      #pa-account button{flex:1;}
      #pa-userinfo{font-size:0.85rem;color:#9aa3b2;margin:-0.35rem 0 0.7rem;display:flex;
        align-items:center;gap:0.4rem;flex-wrap:wrap;}
      #pa-userinfo code{color:#cdd3dd;background:#14161c;border:1px solid #3a4150;border-radius:0.25rem;padding:0.05rem 0.3rem;}
      #pa-userinfo .admin{background:#2d4a2f;border:1px solid #3f6d43;color:#cdeccf;border-radius:0.25rem;padding:0.05rem 0.35rem;}
      #pa-settings #pa-logout{width:100%;margin-top:0.5rem;background:#3a2230;border:1px solid #6d3a4a;
        color:#ffd2dc;border-radius:0.3rem;font:0.95rem 'FS Pixel Sans',monospace;padding:0.55rem;cursor:pointer;}
    `;
    document.head.appendChild(style);

    const btn = document.createElement('button');
    btn.id = 'pa-settings-btn';
    btn.textContent = '🔊 Settings';
    this.settingsBtn = btn;
    const panel = document.createElement('div');
    panel.id = 'pa-settings';
    panel.innerHTML = `<h4>Settings</h4>
      <div id="pa-userinfo"></div>
      <div class="row"><label for="pa-name">Display name</label><input id="pa-name" type="text" maxlength="32" placeholder="(your login id)"></div>
      <div class="hint">Shown on your avatar. Empty = your login id.</div>
      <div id="pa-account">
        <div class="row"><label for="pa-pw">New password</label><input id="pa-pw" type="password" maxlength="64" placeholder="min 6 chars" autocomplete="new-password"></div>
        <div class="row"><button id="pa-pw-set">Change password</button></div>
        <div class="row"><label for="pa-token">Agent token</label><input id="pa-token" type="text" readonly></div>
        <div class="row"><button id="pa-token-copy">Copy</button><button id="pa-token-new">Regenerate</button></div>
        <div class="hint">Your agents authenticate with this token (<code>--token</code>); keep it secret.</div>
      </div>
      <div class="row"><label>Your avatar</label></div>
      <div id="pa-avatar">
        <canvas id="pa-avatar-pic"></canvas>
        <div class="pa-av-btns">
          <button id="pa-av-edit">✏ Edit</button>
          <button id="pa-av-save">Save as template</button>
        </div>
      </div>
      <div class="hint">Your avatar is your own copy — editing or deleting a template never changes it.</div>
      <div class="row"><label>Start from a template</label></div>
      <div id="pa-pchar"></div>
      <div class="row"><label>Agents' avatar</label></div>
      <div id="pa-char"></div>
      <div class="hint">Pick a skin to keep your agents' look consistent.</div>
      <div class="row"><input id="pa-snd" type="checkbox"><label for="pa-snd">Sound notifications</label></div>
      <div class="row"><label for="pa-vol">Volume</label><input id="pa-vol" type="range" min="0" max="100"></div>
      <div class="row"><input id="pa-lbl" type="checkbox"><label for="pa-lbl">Always show labels</label></div>
      <button id="pa-logout">Log out</button>`;
    btn.onclick = () => {
      const opening = panel.style.display !== 'block';
      this.setMenu(opening ? 'settings' : null);
      if (opening) this.renderCharSwatches();
    };
    const host = document.getElementById('game') ?? document.body;
    // Add to the shared top-bar (created by the layouts panel); final position is
    // set in create() — Settings ends up as Help's immediate left neighbour.
    if (this.topbar) this.topbar.appendChild(btn);
    else host.appendChild(btn);
    host.appendChild(panel);
    this.settingsPanel = panel;

    // Only one popover open at a time: a click outside the toolbar/panels closes
    // them. The editor (the "layout menu") is exempt — you edit via the canvas.
    window.addEventListener('pointerdown', (e) => {
      const t = e.target as Node | null;
      if (!t) return;
      const charPanel = document.getElementById('pa-chars');
      const furnPanel = document.getElementById('pa-furn');
      // The char editor's PNG-import panel and the in-game confirm/prompt dialog
      // are separate top-level elements — clicks there must not close the menu.
      const importPanel = document.getElementById('pa-c-import');
      const modal = document.getElementById('pa-modal');
      const znpc = document.getElementById('pa-znpc');
      if (
        this.menubar?.contains(t) ||
        this.settingsPanel?.contains(t) ||
        this.layoutsPanel?.contains(t) ||
        this.zonesPanel?.contains(t) ||
        this.helpPanel?.contains(t) ||
        znpc?.contains(t) ||
        charPanel?.contains(t) ||
        furnPanel?.contains(t) ||
        importPanel?.contains(t) ||
        modal?.contains(t)
      )
        return;
      this.setMenu(null);
    });

    // "Your avatar" controls: edit the owned avatar, or snapshot it as a new
    // shared template.
    panel.querySelector<HTMLButtonElement>('#pa-av-edit')!.onclick = () => {
      if (!this.myAvatarId) return;
      void this.setMenu(null);
      this.charEditor.editEntity('me', this.myAvatarId);
    };
    panel.querySelector<HTMLButtonElement>('#pa-av-save')!.onclick = async () => {
      const nm = await promptDialog('Name for the new template:', this.viewerUsername || 'My Avatar', {
        maxLength: 16,
        confirmLabel: 'Save',
      });
      if (nm === null) return;
      this.room?.send('avatarToTemplate', { name: nm });
    };

    // Account controls (logged-in users): password + per-user agent token.
    panel.querySelector<HTMLButtonElement>('#pa-pw-set')!.onclick = async () => {
      const pw = panel.querySelector<HTMLInputElement>('#pa-pw')!;
      const v = pw.value;
      if (v.length < 6) {
        await alertDialog('Password must be at least 6 characters.');
        return;
      }
      this.room?.send('setPassword', { password: v });
      pw.value = '';
      await alertDialog('Password changed.');
    };
    panel.querySelector<HTMLButtonElement>('#pa-token-copy')!.onclick = () => {
      void navigator.clipboard?.writeText(this.agentToken);
    };
    panel.querySelector<HTMLButtonElement>('#pa-token-new')!.onclick = async () => {
      if (await confirmDialog('Regenerate your agent token? The old one stops working.', { danger: true, confirmLabel: 'Regenerate' })) {
        this.room?.send('regenerateAgentToken', {});
      }
    };

    const name = panel.querySelector<HTMLInputElement>('#pa-name')!;
    const snd = panel.querySelector<HTMLInputElement>('#pa-snd')!;
    const vol = panel.querySelector<HTMLInputElement>('#pa-vol')!;
    const lbl = panel.querySelector<HTMLInputElement>('#pa-lbl')!;
    name.onchange = () => {
      const v = name.value.trim().slice(0, 32);
      this.viewerUsername = v;
      unlockAudio();
      if (this.myUserId) {
        // Logged-in: persist the display name on the account (server renames the
        // live avatar).
        this.room?.send('setUsername', { username: v });
      } else {
        // Anonymous (open dev): a locally chosen name on the avatar.
        this.nameOverridden = true;
        try {
          if (v) localStorage.setItem('pa-viewer-name', v);
          else localStorage.removeItem('pa-viewer-name');
        } catch {
          /* localStorage unavailable */
        }
        this.room?.send('setPlayerName', { name: v });
      }
      this.clearNameLabels(); // labels re-render with the new name on next tick
    };
    snd.onchange = () => {
      this.soundOn = snd.checked;
      setSoundEnabled(this.soundOn);
      unlockAudio();
      this.room?.send('setSoundEnabled', { enabled: this.soundOn });
    };
    vol.oninput = () => {
      this.volume = Number(vol.value) / 100;
      setAlertVolume(this.volume);
    };
    vol.onchange = () => this.room?.send('setAlertVolume', { volume: this.volume });
    lbl.onchange = () => {
      this.alwaysShowLabels = lbl.checked;
      if (!this.alwaysShowLabels) this.clearNameLabels();
      this.room?.send('setAlwaysShowLabels', { enabled: this.alwaysShowLabels });
    };
    const logoutBtn = panel.querySelector<HTMLButtonElement>('#pa-logout')!;
    logoutBtn.style.display = 'none'; // shown only when a login session is active
    logoutBtn.onclick = () => gotoLogout();
    this.syncSettingsInputs();
  }

  /** Render both avatar swatch rows: the viewer's own player avatar + the skin
   *  pinned for their agents. */
  private renderCharSwatches(): void {
    this.renderAvatarPreview();
    // "Start from a template": copy a gallery skin into the owned avatar (a
    // fresh, independent copy — the template stays untouched). No random option.
    this.renderSwatchRow(
      '#pa-pchar',
      null,
      (skin) => {
        if (skin) this.room?.send('avatarFromTemplate', { templateId: skin });
      },
      { random: false },
    );
    this.renderSwatchRow('#pa-char', this.mySkin, (skin) => {
      this.mySkin = skin;
      this.persistPref('pa-viewer-char', skin);
      this.room?.send('setCharacter', { skin: skin ?? '', name: this.viewerUsername });
    });
  }

  /** Draw the viewer's owned avatar into the Settings preview + toggle its
   *  Edit/Save-as-template buttons by whether the avatar is loaded yet. */
  private renderAvatarPreview(): void {
    const cv = this.settingsPanel?.querySelector<HTMLCanvasElement>('#pa-avatar-pic');
    const mine = this.myAvatarId
      ? (getCharacterTemplates() ?? []).find((c) => c.id === this.myAvatarId)
      : undefined;
    if (cv) {
      const frame = mine?.data.down?.[1] ?? mine?.data.down?.[0];
      const w = frame?.[0]?.length ?? 16;
      const h = frame?.length ?? 32;
      cv.width = w;
      cv.height = h;
      const ctx = cv.getContext('2d')!;
      ctx.clearRect(0, 0, w, h);
      if (frame) {
        for (let y = 0; y < h; y++) {
          for (let x = 0; x < w; x++) {
            const px = frame[y]?.[x];
            if (px) {
              ctx.fillStyle = px;
              ctx.fillRect(x, y, 1, 1);
            }
          }
        }
      }
    }
    const editBtn = this.settingsPanel?.querySelector<HTMLButtonElement>('#pa-av-edit');
    const saveBtn = this.settingsPanel?.querySelector<HTMLButtonElement>('#pa-av-save');
    if (editBtn) editBtn.disabled = !mine;
    if (saveBtn) saveBtn.disabled = !mine;
  }

  private persistPref(key: string, i: string | null): void {
    try {
      if (i === null) localStorage.removeItem(key);
      else localStorage.setItem(key, String(i));
    } catch {
      /* localStorage unavailable */
    }
  }

  /** Destination picker shown when the player reaches a portal (P5 v2): a list of
   *  the other zones; choosing one sends `portalGo` (server transitions). */
  private showPortalPicker(zones: Array<{ id: string; label: string }>): void {
    if (!zones?.length) return;
    document.getElementById('pa-portal')?.remove(); // only one at a time
    // Remember the portal tile so update() can auto-close if the player walks off.
    const me = this.myPlayerId !== null ? this.characters.get(this.myPlayerId) : undefined;
    this.portalPickerTile = me
      ? { col: Math.floor(me.tx / TILE_SIZE), row: Math.floor(me.ty / TILE_SIZE) }
      : null;
    const el = document.createElement('div');
    el.id = 'pa-portal';
    el.className = 'pa-ui';
    el.style.cssText =
      'position:fixed;left:50%;top:50%;transform:translate(-50%,-50%);z-index:80;background:#1b1f2a;' +
      'border:2px solid #3a4150;border-radius:0.6rem;padding:1rem;color:#eef1f6;min-width:12rem;text-align:center;' +
      "font:1rem 'FS Pixel Sans',monospace;box-shadow:0 6px 0 rgba(0,0,0,.4);";
    const head = document.createElement('div');
    head.textContent = '🚪 Travel to…';
    head.style.cssText = 'font-size:1.2rem;margin-bottom:0.7rem;color:#cdd3dd;';
    el.appendChild(head);
    const close = (): void => {
      el.remove();
      this.portalPickerTile = null;
    };
    for (const z of zones) {
      const b = document.createElement('button');
      b.textContent = z.label;
      b.style.cssText =
        'display:block;width:100%;margin:0.3rem 0;padding:0.55rem;cursor:pointer;background:#2a2f3a;' +
        "border:1px solid #3a4150;border-radius:0.4rem;color:#eef1f6;font:1rem 'FS Pixel Sans',monospace;";
      b.onclick = () => {
        this.room?.send('portalGo', { zone: z.id });
        close();
      };
      el.appendChild(b);
    }
    const cancel = document.createElement('button');
    cancel.textContent = 'Cancel';
    cancel.style.cssText =
      'margin-top:0.5rem;padding:0.4rem 0.8rem;cursor:pointer;background:#222734;border:1px solid #3a4150;' +
      "border-radius:0.4rem;color:#9aa3b2;font:0.9rem 'FS Pixel Sans',monospace;";
    cancel.onclick = close;
    el.appendChild(cancel);
    (document.getElementById('game') ?? document.body).appendChild(el);
  }

  /** Switch to another zone (remember it, then reload at ?zone=). Used by the
   *  zone switcher and by walk-in portals (P5). */
  /** Connection dropped (likely a server restart): wait for /health, then reload
   *  so the player rejoins automatically. Shows a small "reconnecting" overlay. */
  private handleDisconnect(): void {
    if (this.reconnecting || this.leavingIntentionally) return;
    this.reconnecting = true;
    let overlay = document.getElementById('pa-reconnect');
    if (!overlay) {
      overlay = document.createElement('div');
      overlay.id = 'pa-reconnect';
      overlay.style.cssText =
        'position:fixed;inset:0;z-index:200;display:flex;align-items:center;justify-content:center;' +
        "background:rgba(10,12,18,.82);color:#eef1f6;font:1.1rem 'FS Pixel Sans',ui-monospace,monospace;text-align:center;";
      overlay.textContent = 'Connection lost — reconnecting…';
      (document.getElementById('game') ?? document.body).appendChild(overlay);
    }
    const poll = async (): Promise<void> => {
      if (await isServerUp()) {
        window.location.reload();
        return;
      }
      window.setTimeout(() => void poll(), 2000);
    };
    window.setTimeout(() => void poll(), 1500);
  }

  private goToZone(zone: string): void {
    if (!isZoneId(zone)) return;
    this.leavingIntentionally = true; // our own navigation — not a dropped connection
    try {
      localStorage.setItem('pa-last-zone', zone);
      // One-shot: tell the post-reload connect() to land at the zone's arrival
      // tile (this is an active entry, not a refresh).
      sessionStorage.setItem('pa-arrive', zone);
    } catch {
      /* storage unavailable */
    }
    const params = new URLSearchParams(window.location.search);
    params.set('zone', zone);
    window.location.search = params.toString();
  }

  /** Render one avatar swatch row (random + each palette's front standing frame),
   *  highlighting `selected`; clicking a swatch calls `onPick`. */
  private renderSwatchRow(
    hostSel: string,
    selected: string | null,
    onPick: (skin: string | null) => void,
    opts: { random?: boolean } = {},
  ): void {
    const host = this.settingsPanel?.querySelector<HTMLDivElement>(hostSel);
    if (!host) return;
    // Only gallery templates here — owned avatars (pa:<user>) aren't pickable.
    const tpl = (getCharacterTemplates() ?? []).filter((c) => !isPlayerAvatarSkin(c.id));
    host.innerHTML = '';
    // "Default (Random)" = no pin; the server diversifies the skin.
    if (opts.random !== false) {
      const rnd = document.createElement('div');
      rnd.className = 'rnd' + (selected === null ? ' sel' : '');
      rnd.textContent = '🎲';
      rnd.title = 'Default (random skin)';
      rnd.onclick = () => {
        onPick(null);
        this.renderCharSwatches();
      };
      host.appendChild(rnd);
    }
    tpl.forEach((c) => {
      const frame = c.data.down?.[1] ?? c.data.down?.[0];
      const w = frame?.[0]?.length ?? 16;
      const h = frame?.length ?? 32;
      const cv = document.createElement('canvas');
      cv.width = w;
      cv.height = h;
      const ctx = cv.getContext('2d')!;
      if (frame) {
        for (let y = 0; y < h; y++) {
          for (let x = 0; x < w; x++) {
            const px = frame[y]?.[x];
            if (px) {
              ctx.fillStyle = px;
              ctx.fillRect(x, y, 1, 1);
            }
          }
        }
      }
      if (selected === c.id) cv.classList.add('sel');
      cv.title = skinLabel(c, tpl);
      cv.onclick = () => {
        onPick(c.id);
        this.renderCharSwatches();
      };
      host.appendChild(cv);
    });
  }

  private syncSettingsInputs(): void {
    if (!this.settingsPanel) return;
    const nameEl = this.settingsPanel.querySelector<HTMLInputElement>('#pa-name');
    // Don't clobber the field while the user is editing it.
    if (nameEl && document.activeElement !== nameEl) nameEl.value = this.viewerUsername;
    this.settingsPanel.querySelector<HTMLInputElement>('#pa-snd')!.checked = this.soundOn;
    this.settingsPanel.querySelector<HTMLInputElement>('#pa-vol')!.value = String(Math.round(this.volume * 100));
    this.settingsPanel.querySelector<HTMLInputElement>('#pa-lbl')!.checked = this.alwaysShowLabels;
    // Account section: only for logged-in users; reflect the current agent token.
    const account = this.settingsPanel.querySelector<HTMLDivElement>('#pa-account');
    if (account) account.style.display = this.myUserId ? '' : 'none';
    const tok = this.settingsPanel.querySelector<HTMLInputElement>('#pa-token');
    if (tok) tok.value = this.agentToken;
    // Identity line: login id + admin badge (logged-in users only).
    const info = this.settingsPanel.querySelector<HTMLDivElement>('#pa-userinfo');
    if (info) {
      info.style.display = this.myUserId ? '' : 'none';
      info.innerHTML = this.myUserId
        ? `<span>User ID</span><code>${esc(this.myUserId)}</code>${this.isAdmin ? '<span class="admin">★ Admin</span>' : ''}`
        : '';
    }
  }

  /** Whether this viewer may edit the SHARED galleries / create zones (global
   *  admin, or open dev mode with no accounts). */
  private get assetsAdmin(): boolean {
    return !this.myUserId || this.isAdmin;
  }
  /** Whether this viewer may layout the CURRENT zone (global admin or its zone
   *  admin). */
  private get zoneEditAdmin(): boolean {
    return this.assetsAdmin || this.myZoneAdmin;
  }

  /** Show editing entry points by role: the shared galleries (chars/furniture)
   *  and save-as-template need global admin; the layout editor opens for the
   *  current zone's admin too. Server enforcement is authoritative — this is
   *  just UX. */
  private applyAdminVisibility(): void {
    this.charEditor?.setButtonVisible(this.assetsAdmin);
    this.furnEditor?.setButtonVisible(this.assetsAdmin);
    if (this.layoutsBtn) this.layoutsBtn.style.display = this.zoneEditAdmin ? '' : 'none';
    const save = this.settingsPanel?.querySelector<HTMLButtonElement>('#pa-av-save');
    if (save) save.style.display = this.assetsAdmin ? '' : 'none';
    // The zones panel stays available for travel; admin controls reflect the role.
    this.renderZonesPanel?.();
  }

  // ── Always-on name labels ────────────────────────────────────────

  private clearNameLabels(): void {
    for (const el of this.nameLabels.values()) el.remove();
    this.nameLabels.clear();
  }

  private updateNameLabels(): void {
    // Agents are hidden while editing, so drop their labels too.
    if (this.editor.isEditing()) {
      if (this.nameLabels.size) this.clearNameLabels();
      return;
    }
    if (!this.alwaysShowLabels) return;
    const cam = this.cameras.main;
    const wv = cam.worldView;
    const host = document.getElementById('game') ?? document.body;
    const live = new Set<number>();
    for (const ch of this.characters.values()) {
      // Players show their own name; agents are tagged "<owner>-Agent".
      let name: string;
      if (ch.isPlayer) {
        name = ch.folderName || ch.agentName || '';
      } else if (ch.isSubagent) {
        name = ch.agentName || ch.folderName || '';
      } else {
        const owner = ch.folderName || ch.agentName || '';
        name = owner ? `${owner}-Agent` : '';
      }
      if (!name) continue;
      live.add(ch.id);
      let el = this.nameLabels.get(ch.id);
      if (!el) {
        el = document.createElement('div');
        el.style.cssText =
          "position:absolute;z-index:45;transform:translate(-50%,-100%);pointer-events:none;" +
          "font:0.9rem 'FS Pixel Sans',monospace;color:#e6e9ef;text-shadow:0 0 3px #000,0 0 3px #000;white-space:nowrap;";
        host.appendChild(el);
        this.nameLabels.set(ch.id, el);
      }
      el.textContent = name;
      const sit = ch.state === CharacterState.TYPE ? CHARACTER_SITTING_OFFSET_PX : 0;
      // Lift the label above the head proportionally to the sprite height.
      const headOff = (20 * getCharacterSize(ch.skin ?? "").h) / CHARACTER_BASELINE_HEIGHT;
      el.style.left = `${Math.round(((ch.x ?? ch.tx) - wv.x) * cam.zoom)}px`;
      el.style.top = `${Math.round(((ch.y ?? ch.ty) + sit - headOff - wv.y) * cam.zoom)}px`;
    }
    for (const [id, el] of this.nameLabels) {
      if (!live.has(id)) {
        el.remove();
        this.nameLabels.delete(id);
      }
    }
  }

  // ── Chat (zone-local; log + input + bubbles over avatars) ────────

  private createChat(): void {
    if (!document.getElementById('pa-chat-style')) {
      const style = document.createElement('style');
      style.id = 'pa-chat-style';
      style.textContent = `
        #pa-chat{position:fixed;left:0.5rem;bottom:0.5rem;z-index:55;width:24rem;max-width:46vw;
          display:flex;flex-direction:column;gap:0.35rem;font-family:'FS Pixel Sans',ui-monospace,monospace;
          transition:opacity 0.8s ease;}
        /* Stay fully visible while hovered or while typing, even when idle. */
        #pa-chat:hover,#pa-chat:focus-within{opacity:1 !important;}
        #pa-chatlog{max-height:13rem;overflow-y:auto;background:rgba(20,24,33,.72);border:1px solid #2c323e;
          border-radius:0.4rem;padding:0.45rem 0.6rem;color:#dfe4ee;font-size:1rem;line-height:1.35;
          display:flex;flex-direction:column;gap:0.1rem;}
        #pa-chatlog .ln{white-space:pre-wrap;word-break:break-word;}
        #pa-chatlog .ln b{color:#9ad0ff;}
        #pa-chatinput{background:rgba(20,24,33,.85);border:2px solid #3a4150;border-radius:0.4rem;color:#eef1f6;
          font:1.05rem 'FS Pixel Sans',monospace;padding:0.5rem 0.7rem;}
        #pa-chatinput::placeholder{color:#7d8597;}
        .pa-chatbubble{position:absolute;z-index:46;transform:translate(-50%,-100%);pointer-events:none;
          max-width:14rem;background:#f2f4f8;color:#14171f;border-radius:0.5rem;padding:0.3rem 0.55rem;
          font:0.92rem 'FS Pixel Sans',monospace;line-height:1.2;white-space:pre-wrap;word-break:break-word;
          box-shadow:0 2px 0 rgba(0,0,0,.35);text-align:center;}
        /* Tiny zone-voice status icon over an avatar (very small, no bubble). */
        .pa-vstat{position:absolute;z-index:47;transform:translate(-50%,-100%);pointer-events:none;
          font-size:0.6rem;line-height:1;text-shadow:0 0 2px #000,0 0 2px #000;}
        /* crossed-out: a red diagonal slash over the icon (muted / sound off). */
        .pa-vstat.crossed::after{content:'';position:absolute;left:-12%;top:45%;width:124%;height:0.1rem;
          background:#f0696e;transform:rotate(-20deg);border-radius:1px;box-shadow:0 0 1px #000;}
        .pa-vstat.spk{animation:pa-voice 0.9s infinite ease-in-out;}
        @keyframes pa-voice{0%,100%{transform:translate(-50%,-100%) scale(0.92);opacity:.75;}50%{transform:translate(-50%,-100%) scale(1.1);opacity:1;}}
      `;
      document.head.appendChild(style);
    }
    const host = document.getElementById('game') ?? document.body;
    const box = document.createElement('div');
    box.id = 'pa-chat';
    box.className = 'pa-ui';
    const log = document.createElement('div');
    log.id = 'pa-chatlog';
    const input = document.createElement('input');
    input.id = 'pa-chatinput';
    input.type = 'text';
    input.maxLength = 200;
    input.placeholder = 'Press Enter to chat…';
    input.autocomplete = 'off';
    box.onmouseenter = () => this.bumpChat();
    input.onfocus = () => this.bumpChat();
    input.onkeydown = (e) => {
      this.bumpChat();
      if (e.key === 'Enter') {
        const text = input.value.trim();
        if (text) this.room?.send('chat', { text });
        input.value = '';
        // Keep the cursor in the field so you can keep typing; Escape returns
        // control to the game (movement keys).
        e.preventDefault();
      } else if (e.key === 'Escape') {
        input.value = '';
        input.blur();
      }
      e.stopPropagation(); // typing never reaches game-key handlers
    };
    box.append(log, input);
    host.appendChild(box);
    this.chatBox = box;
    this.chatLogEl = log;
    this.chatInputEl = input;
    this.bumpChat(); // visible briefly on load, then fades if idle

    // Enter focuses the chat (unless already typing or editing the layout).
    window.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter') return;
      const tag = document.activeElement?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || this.editor.isEditing()) return;
      input.focus();
    });
  }

  private onChatHistory(m: Record<string, unknown>): void {
    const msgs = (m.messages as Array<{ from?: string; text?: string }>) ?? [];
    for (const c of msgs) this.appendChatLine(c.from ?? '?', c.text ?? '');
  }

  private onChat(m: Record<string, unknown>): void {
    const from = (m.from as string) ?? '?';
    const text = (m.text as string) ?? '';
    this.appendChatLine(from, text);
    if (typeof m.id === 'number') this.showChatBubble(m.id, text);
  }

  private appendChatLine(from: string, text: string): void {
    const log = this.chatLogEl;
    if (!log) return;
    const atBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 24;
    const ln = document.createElement('div');
    ln.className = 'ln';
    ln.innerHTML = `<b>${esc(from)}:</b> ${esc(text)}`;
    log.appendChild(ln);
    while (log.childElementCount > 120) log.firstElementChild?.remove();
    if (atBottom) log.scrollTop = log.scrollHeight; // follow only if already at bottom
    this.bumpChat();
  }

  /** Mark the chat active (a message, focus, hover, or typing) → show it; it
   *  fades again after a quiet stretch (see tickChatFade). */
  private bumpChat(): void {
    this.chatActiveUntil = performance.now() + 8000;
    if (this.chatBox) this.chatBox.style.opacity = '1';
    this.chatFaded = false;
  }

  /** Fade the chat out once it's been idle (hover/focus override via CSS). */
  private tickChatFade(): void {
    if (!this.chatBox) return;
    const idle = performance.now() >= this.chatActiveUntil;
    if (idle !== this.chatFaded) {
      this.chatFaded = idle;
      this.chatBox.style.opacity = idle ? '0.1' : '1';
    }
  }

  private showChatBubble(id: number, text: string): void {
    let b = this.chatBubbles.get(id);
    if (!b) {
      const el = document.createElement('div');
      el.className = 'pa-chatbubble';
      (document.getElementById('game') ?? document.body).appendChild(el);
      b = { el, until: 0 };
      this.chatBubbles.set(id, b);
    }
    b.el.textContent = text.length > 120 ? `${text.slice(0, 119)}…` : text;
    b.until = performance.now() + 5000;
  }

  /** Position chat bubbles above their avatars; drop expired/gone ones. */
  private updateChatBubbles(): void {
    if (this.chatBubbles.size === 0) return;
    const now = performance.now();
    const cam = this.cameras.main;
    const wv = cam.worldView;
    for (const [id, b] of this.chatBubbles) {
      const ch = this.characters.get(id);
      if (!ch || now >= b.until || this.editor.isEditing()) {
        b.el.remove();
        this.chatBubbles.delete(id);
        continue;
      }
      const sit = ch.state === CharacterState.TYPE ? CHARACTER_SITTING_OFFSET_PX : 0;
      // Sit a little higher than the name label so both are readable.
      const headOff = (32 * getCharacterSize(ch.skin ?? "").h) / CHARACTER_BASELINE_HEIGHT;
      b.el.style.left = `${Math.round(((ch.x ?? ch.tx) - wv.x) * cam.zoom)}px`;
      b.el.style.top = `${Math.round(((ch.y ?? ch.ty) + sit - headOff - wv.y) * cam.zoom)}px`;
    }
  }

  /** Tiny zone-voice status icon over each in-voice avatar: 🎤 in voice,
   *  crossed 🎤 muted, crossed 🔊 sound off (deafened); the mic pulses while
   *  speaking. */
  private updateVoiceBubbles(): void {
    const now = performance.now();
    // Grace window so the speaking icon stays steady through gaps between words
    // (LiveKit's active-speaker flag toggles off in those pauses).
    const GRACE_MS = 800;
    for (const id of this.voiceSpeakers) this.voiceSpeakUntil.set(id, now + GRACE_MS);
    for (const [id, until] of this.voiceSpeakUntil) {
      if (now >= until) this.voiceSpeakUntil.delete(id);
    }

    if (this.voiceBubbles.size === 0 && this.voiceStatus.size === 0) return;
    const cam = this.cameras.main;
    const wv = cam.worldView;
    const editing = this.editor.isEditing();

    // Drop icons for players no longer in voice (or gone / editing).
    for (const [id, el] of this.voiceBubbles) {
      if (editing || !this.voiceStatus.has(id) || !this.characters.get(id)) {
        el.remove();
        this.voiceBubbles.delete(id);
      }
    }
    if (editing) return;

    for (const [id, st] of this.voiceStatus) {
      const ch = this.characters.get(id);
      if (!ch) continue;
      let el = this.voiceBubbles.get(id);
      if (!el) {
        el = document.createElement('div');
        el.className = 'pa-vstat';
        (document.getElementById('game') ?? document.body).appendChild(el);
        this.voiceBubbles.set(id, el);
      }
      // Sound off → crossed speaker; mic muted → crossed mic; speaking → pulsing
      // mic; otherwise (in voice, listening) → plain mic. Priority: deaf > muted
      // > speaking > listening.
      const speaking = this.voiceSpeakUntil.has(id);
      el.textContent = st.deaf ? '🔊' : '🎤';
      el.classList.toggle('crossed', st.deaf || st.muted);
      el.classList.toggle('spk', !st.deaf && !st.muted && speaking);
      const sit = ch.state === CharacterState.TYPE ? CHARACTER_SITTING_OFFSET_PX : 0;
      // Just above the head (a touch higher than the name label at 20).
      const headOff = (24 * getCharacterSize(ch.skin ?? '').h) / CHARACTER_BASELINE_HEIGHT;
      el.style.left = `${Math.round(((ch.x ?? ch.tx) - wv.x) * cam.zoom)}px`;
      el.style.top = `${Math.round(((ch.y ?? ch.ty) + sit - headOff - wv.y) * cam.zoom)}px`;
    }
  }

  // ── Hover / selection tooltip (DOM overlay, fixed readable size) ──

  private createTooltip(): void {
    if (!document.getElementById('pa-tip-style')) {
      const style = document.createElement('style');
      style.id = 'pa-tip-style';
      style.textContent = `
        .pa-tip{position:absolute;z-index:50;transform:translate(-50%,-100%);
          pointer-events:none;display:none;flex-direction:column;align-items:center;
          font-family:'FS Pixel Sans',ui-monospace,monospace;}
        .pa-tip .row{display:flex;align-items:center;gap:0.45rem;
          background:#1b1f2a;border:2px solid #3a4150;border-radius:0.3rem;
          padding:0.4rem 0.7rem;white-space:nowrap;box-shadow:0 2px 0 rgba(0,0,0,.4);}
        .pa-tip .dot{width:0.65rem;height:0.65rem;border-radius:50%;flex:0 0 auto;}
        .pa-tip .act{color:#eef1f6;font-size:1.2rem;line-height:1.15;}
        .pa-tip .name{color:#9aa4b2;font-size:0.9rem;line-height:1.15;}
        .pa-tip .fuel{width:3.25rem;height:0.32rem;background:#222;margin-top:0.2rem;}
        .pa-tip .fuel > div{height:100%;}
      `;
      document.head.appendChild(style);
    }
    this.tip = document.createElement('div');
    this.tip.className = 'pa-tip';
    (document.getElementById('game') ?? document.body).appendChild(this.tip);
  }

  private updateTooltip(): void {
    if (this.editor.isEditing()) {
      this.tip.style.display = 'none';
      return;
    }
    const id = this.hoveredId ?? this.selectedId;
    const ch = id !== null ? this.characters.get(id) : undefined;
    if (!ch || id === null) {
      this.tip.style.display = 'none';
      return;
    }
    const cam = this.cameras.main;
    const wv = cam.worldView;
    const sit = ch.state === CharacterState.TYPE ? CHARACTER_SITTING_OFFSET_PX : 0;
    // Place the tooltip above the head, scaled to the character's sprite height.
    const tipOff = (TOOL_OVERLAY_VERTICAL_OFFSET * getCharacterSize(ch.skin ?? "").h) / CHARACTER_BASELINE_HEIGHT;
    const sx = ((ch.x ?? ch.tx) - wv.x) * cam.zoom;
    const sy = ((ch.y ?? ch.ty) + sit - tipOff - wv.y) * cam.zoom;
    this.tip.style.left = `${Math.round(sx)}px`;
    this.tip.style.top = `${Math.round(sy)}px`;

    const act = ch.isPlayer
      ? 'Player'
      : ch.bubbleType === 'permission'
        ? 'Needs approval'
        : ch.activity || (ch.isActive ? 'Working…' : ch.isSubagent ? 'Subtask' : 'Idle');
    const name = ch.isPlayer
      ? ch.folderName || 'Player'
      : ch.agentName || ch.folderName || `agent ${id}`;
    const dot = ch.bubbleType === 'permission' ? '#ffcc00' : ch.isActive ? '#44cc44' : '';
    const total = (ch.inputTokens ?? 0) + (ch.outputTokens ?? 0);
    const ratio = total / MAX_CONTEXT_TOKENS;

    this.tip.innerHTML =
      `<div class="row">${dot ? `<span class="dot" style="background:${dot}"></span>` : ''}` +
      `<div><div class="act">${esc(act)}</div><div class="name">${esc(name)}</div></div></div>` +
      (total > 0
        ? `<div class="fuel"><div style="width:${Math.min(ratio * 100, 100)}%;background:${fuelColor(ratio)}"></div></div>`
        : '');
    this.tip.style.display = 'flex';
  }
}

function fuelColor(ratio: number): string {
  if (ratio >= TOKEN_CRITICAL_THRESHOLD) return FUEL_COLOR_CRITICAL;
  if (ratio >= TOKEN_DANGER_THRESHOLD) return FUEL_COLOR_DANGER;
  if (ratio >= TOKEN_WARN_THRESHOLD) return FUEL_COLOR_WARN;
  return FUEL_COLOR_OK;
}

function esc(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
}

function setStatus(text: string): void {
  const el = document.getElementById('status');
  if (el) el.textContent = text;
}
