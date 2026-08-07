import Phaser from 'phaser';
import { getStateCallbacks, type Room } from '@colyseus/sdk';

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
  type Action,
  type Character,
  type FurnitureInstance,
  type OfficeLayout,
  type Pet,
  type SpriteData,
} from '@pixel/shared/office/types.js';
import { layoutToFurnitureInstances } from '@pixel/shared/office/layout/layoutSerializer.js';
import { getActiveCategories, getCatalogByCategory, getCatalogEntry, effectiveAction } from '@pixel/shared/office/layout/furnitureCatalog.js';
import { LiveKitConference } from '../conference/LiveKitConference.js';
import { ConferenceUI } from '../conference/ConferenceUI.js';
import { ArcadeUI } from '../arcade/ArcadeUI.js';
import { ZoneVoiceUI } from '../voice/ZoneVoiceUI.js';
import { MeetingAreaUI } from '../ui/meetingArea.js';
import { openActionIframe } from '../ui/actionIframe.js';
import { MumbleUI } from '../voice/MumbleUI.js';
import { MumbleVoice } from '../voice/MumbleVoice.js';
import { MumbleSettingsUI } from '../voice/MumbleSettingsUI.js';
import { getCharacterSize, getCharacterTemplates, getNpcRoster, getPosePlaybackLength, upsertCharacterTemplate } from '@pixel/shared/office/sprites/spriteData.js';
import type { CharacterPose } from '@pixel/shared/office/types.js';
import { PhaserRenderer, type RenderSource } from '../render/PhaserRenderer.js';
import { LayoutEditor } from '../editor/LayoutEditor.js';
import { CharacterEditor, AGENT_TRACKS, NPC_TRACKS, skinLabel } from '../editor/CharacterEditor.js';
import { CharacterCreator } from '../editor/CharacterCreator.js';
import { FurnitureEditor } from '../editor/FurnitureEditor.js';
import { confirmDialog, promptDialog, alertDialog } from '../ui/dialog.js';
import { openPaDialog } from '../ui/paDialog.js';
import { renderZoneAdminsWidget } from '../shared/zoneAdminsWidget.js';
import { renderZonePasswordWidget } from '../shared/zonePasswordWidget.js';
import { generatePassword } from '../shared/generatePassword.js';
import {
  filterUserDatalist as filterSharedUserDatalist,
  wireUserAutocomplete as wireSharedUserAutocomplete,
  type AutocompleteUser,
} from '../shared/userAutocomplete.js';
import { createAssetBridge } from '../net/bridge.js';
import { connect, isAuthError, isForbiddenError, isServerUp, redirectToLogin, gotoLogout, serverHttpOrigin } from '../net/room.js';
import { isDesktop, desktop, reloadApp } from '../desktop/bridge.js';
import { desktopReauth, desktopSignOut } from '../desktop/boot.js';
import { DEFAULT_ZONE, ZONES, cleanName, conferenceLabel, isPlayerAvatarSkin, type ZoneConfig } from '@pixel/shared/protocol';
import { KICK_CLOSE_CODE } from '@pixel/shared/commands';
import { ChatUI } from '../ui/chatUI.js';
import { injectPaSkin } from '../ui/paSkin.js';
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

/** Which grouped top-bar popover is open (null = none). */
type MenuId = 'audio' | 'mumble' | 'zone' | 'space' | 'assets' | 'more' | 'settings' | 'help' | null;

/** Per-pose animation frame duration (ms), mirroring the engine's constants.
 *  Poses not listed (idle) are static. Drives the client-side animation clock. */
const POSE_FRAME_MS: Record<string, number> = {
  walk: WALK_FRAME_DURATION_SEC * 1000,
  typing: TYPE_FRAME_DURATION_SEC * 1000,
  reading: TYPE_FRAME_DURATION_SEC * 1000,
  coffee: COFFEE_FRAME_DURATION_SEC * 1000,
  sit: TYPE_FRAME_DURATION_SEC * 1000, // static placeholder; animates if a sit track is authored
};

// Default camera zoom: a character sprite is CHARACTER_BASELINE_HEIGHT (32)
// world px tall, so at zoom 2.5 it renders ~80 CSS px tall — ~2.1cm at the
// standard 96-CSS-px-per-inch reference (96/2.54 ≈ 37.8 px/cm). Manual zoom
// (mouse wheel) still overrides this per session; it's just the starting point.
const DEFAULT_ZOOM = 2.5;

// Idle-throttle tuning (see update()): DOM overlays run at ~20 Hz; after a short
// grace with a fully static scene the per-frame work is skipped, and after ~2 s
// the whole render loop is put to sleep (woken by input/state/voice/tab focus).
const OVERLAY_INTERVAL_MS = 50;
const IDLE_GRACE_FRAMES = 6;
const SLEEP_AFTER_IDLE_FRAMES = 120;

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
  private furniturePlacements: Array<{ uid: string; type: string; col: number; row: number; name?: string; action?: Action }> = [];
  private furnitureDirty = false;
  private hoveredId: number | null = null;
  private selectedId: number | null = null;
  private tip!: HTMLDivElement;
  // Idle-throttle + perf-overlay bookkeeping (see update()/sceneBusy()).
  private idleFrames = 0;
  private wasBusy = true;
  private loopAsleep = false;
  private lastOverlayAt = 0;
  private perfEnabled = false;
  private perfEl: HTMLDivElement | null = null;
  private updateMsAvg = 0;
  /** Shared chat panel (client/src/ui/chatUI.ts). */
  private chat?: ChatUI;
  /** The conference monitor (anchor tile + name) this viewer has joined, or null. */
  private myConference: { col: number; row: number; name?: string } | null = null;
  /** A monitor we clicked and are walking toward (join finalizes on arrival). */
  private pendingConference: { col: number; row: number; name?: string } | null = null;
  /** The kiosk a "manage your meeting rooms" request (meetingRoomList) was sent
   *  for — remembered so the "+ New room" button in that dialog knows which
   *  kiosk tile to validate the create against once the list response arrives. */
  private pendingMeetingKioskForCreate: { col: number; row: number } | null = null;
  /** The zone a "Zone settings" request (zoneMembers) was sent for, so
   *  onZoneMembers knows which zone's dialog to (re)build once the response arrives. */
  private pendingZoneSettings: ZoneConfig | null = null;
  /** Every user, for the ACL-add / invite autocomplete — fetched once per zone
   *  settings dialog open (requestUserList → userList) and reused across its
   *  add/remove/invite round trips until the dialog is closed and reopened. */
  private userListCache: Array<{ userId: string; name: string; isAdmin: boolean }> | null = null;
  /** Conference rosters by "col,row" anchor key (from the server). */
  private readonly conferenceMembers = new Map<string, Array<{ id: number; name: string }>>();
  /** The WebEx-style conference window (stage + sidebar + control bar). */
  private confUI!: ConferenceUI;
  /** The shared arcade cabinet overlay (js-dos). */
  private arcadeUI!: ArcadeUI;
  /** Pending arcade savegame loads, keyed by game id → resolver (see wireArcade). */
  private readonly arcadePendingLoads = new Map<string, (data: Uint8Array | null) => void>();
  /** Active LiveKit connection for the joined monitor, or undefined (C-RTC-2). */
  private conf?: LiveKitConference;
  /** Zone-wide voice chat (one LiveKit room per zone), with proximity audio. */
  private zoneVoice?: ZoneVoiceUI;
  /** Walk-in meeting areas (a 'meetingRoom' tile action, see shared Action) —
   *  standing on the tile auto-connects (mirrors WorkAdventure's proximity
   *  bubble) into a small ambient popup with live camera tiles, reusing
   *  LiveKitConference's own tile rendering. One dedicated LiveKit room per
   *  area (see onMeetingAreaToken), exactly like a conference monitor. */
  private meetingArea?: MeetingAreaUI;
  /** The meeting area (anchor "col,row" key) our tile is currently in, or
   *  null — purely reactive to meetingRoomMembers broadcasts (no explicit
   *  join/leave message; standing on the tile *is* server-side membership,
   *  see SimRoom's updateMeetingRoomMembership). Drives auto-join. */
  private myMeetingAreaKey: string | null = null;
  /** The meeting area (anchor tile) whose video CALL we're connected to, or
   *  null — separate from membership above: you can hang up and keep
   *  standing in the area without being auto-rejoined. */
  private myMeetingArea: { col: number; row: number } | null = null;
  /** Whether that call is currently retargeted into the full monitor-style
   *  window (ConferenceUI) rather than the small ambient popup. */
  private meetingAreaExpanded = false;
  /** Active LiveKit connection for the joined meeting area, or undefined. */
  private meetingConf?: LiveKitConference;
  private mumble?: MumbleUI;
  private mumblePanel?: HTMLDivElement;
  private mumbleBtn?: HTMLButtonElement;
  private zoneVoiceStarted = false;
  /** Transient chat bubbles above avatars, keyed by entity id (expiry in ms,
   *  performance.now() clock). */
  private readonly chatBubbles = new Map<number, { el: HTMLDivElement; until: number }>();
  /** Player ids currently talking via zone voice (client-side, from LiveKit). */
  private voiceSpeakers = new Set<number>();
  /** Per-player zone-voice presence + mic-mute + sound-off (from LiveKit). Fed to
   *  the renderer, which draws the crossed 🎤 / 🔊 markers over the avatars. */
  private voiceStatus = new Map<number, { muted: boolean; deaf: boolean }>();
  /** Per-speaker grace deadline (ms) so the talking ring stays on through gaps. */
  private readonly voiceSpeakUntil = new Map<number, number>();
  private editor!: LayoutEditor;
  private charEditor!: CharacterEditor;
  private charCreator!: CharacterCreator;
  /** Where the character editor's "← Back" returns — set by whoever opens it
   *  (the Assets panel, or Settings for the viewer's own avatar). */
  private charEditorReturn: MenuId = 'assets';
  private furnEditor!: FurnitureEditor;
  /** Raw furniture catalog from the last furnitureAssetsLoaded (group fields). */
  private furnitureCatalogRaw: Array<Record<string, unknown> & { id: string }> = [];
  /** Bundled (file) skin ids — anything else is user-added (deletable). */
  private bundledSkinIds = new Set<string>();
  private menubar?: HTMLElement;
  /** Grouped top-bar buttons (design: Audio · Zone · Space · Assets · ☰). */
  private audioBtn?: HTMLButtonElement;
  private audioDot?: HTMLElement;
  /** Quick-access voice controls in the bar (shown only while connected). */
  private micBarBtn?: HTMLButtonElement;
  private deafBarBtn?: HTMLButtonElement;
  private micBarEqEl?: HTMLElement;
  private zoneBtn?: HTMLButtonElement;
  private zoneLabelEl?: HTMLElement;
  private spaceBtn?: HTMLButtonElement;
  private assetsBtn?: HTMLButtonElement;
  private moreBtn?: HTMLButtonElement;
  /** Grouped popover panels — all share the .pa-panel style; mutually exclusive. */
  private audioPanel?: HTMLDivElement;
  private zonePanel?: HTMLDivElement;
  private spacePanel?: HTMLDivElement;
  private assetsPanel?: HTMLDivElement;
  private morePanel?: HTMLDivElement;
  private layoutsPanel!: HTMLDivElement; // Layouts tab body, nested in spacePanel
  private zonesPanel!: HTMLDivElement; // Zones tab body, nested in spacePanel
  private layoutsSeg?: HTMLElement; // Layouts segment (hidden for non-editors)
  private assetsBody?: HTMLDivElement; // Characters/Furniture list host
  private helpPanel!: HTMLDivElement;
  /** Which top-bar popover is open (null = none). */
  private currentMenu: MenuId = null;
  /** Toolbar collapsed → Space + Assets tuck into the ☰ menu (design). */
  private collapsed = false;
  private spaceTab: 'layouts' | 'zones' = 'layouts';
  private assetsTab: 'chars' | 'furniture' = 'chars';
  private charTab: 'agent' | 'npc' = 'agent';
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
  /** Account role. */
  private myRole: 'admin' | 'user' = 'user';
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
  /** Settings: recenter the camera on the player as they move (see update()).
   *  Off = the old, pre-follow behavior — the camera stays wherever you leave it. */
  private cameraFollowEnabled = true;
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
  /** The current map's world size (cols/rows * TILE_SIZE) — stored so a window
   *  resize can recompute pan bounds (see applyCameraBounds) without needing
   *  the layout again. */
  private officeW = 0;
  private officeH = 0;
  /** Manual drag-panning "detaches" the camera from follow (see setupInput's
   *  pan handler + update()'s re-engage check below) so looking around doesn't
   *  fight the every-frame recenter; it snaps back to following the moment the
   *  player's own position changes again (walk, sit, portal, anything). Never
   *  active while editing — the editor keeps its existing free-camera feel. */
  private cameraFollowDetached = false;
  /** Player position at the moment of detaching, to detect "have I moved". */
  private cameraDetachAt: { x: number; y: number } | null = null;

  constructor() {
    super('office');
  }

  create(): void {
    const g = this.make.graphics({ x: 0, y: 0 });
    g.fillStyle(0xffffff, 1).fillRect(0, 0, 1, 1);
    g.generateTexture('__WHITE', 1, 1);
    g.destroy();

    this.cameras.main.setBackgroundColor('#171514');
    this.os = new OfficeState();
    this.view = new PhaserRenderer(this, this.renderSource());
    this.setupIdleWaking();
    this.editor = new LayoutEditor(this, {
      getLayout: () => this.os.getLayout(),
      onChange: () => (this.furnitureDirty = true),
      rebuildStatic: () => this.view.buildStatic(),
      onEdit: (layout, immediate) => this.autosaveLayout(layout, immediate),
      onEditingChange: (editing) => this.setEditMode(editing),
      // Opens the Asset editor without going through setMenu (which would
      // force-close layout-edit mode — see setEditMode/setMenu) — the two
      // editors don't share any state, so they can coexist. Still runs the
      // same unsaved-edit guard setMenu's flow would have. The onBack
      // override makes Back/Reset just close the panel instead of the
      // constructor's default (setMenu('assets')) — this open didn't come
      // from the Assets panel, so returning to it would pop open a panel the
      // user never had open, on top of the layout editor.
      openAssetEditor: (type) => {
        void this.furnEditor.confirmLeave().then((ok) => {
          if (ok) this.furnEditor.edit(type, () => this.furnEditor.forceClose());
        });
      },
      saveFurnitureAsset: (name, data) => this.room?.send('saveAsset', { assetType: 'furniture', name, data }),
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
    this.createHud();
    this.createSettingsPanel();
    this.createChat();
    this.confUI = new ConferenceUI();
    this.meetingArea = new MeetingAreaUI();
    this.arcadeUI = ArcadeUI.get();
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
      // Entry is via the Assets panel (shared gallery) or Settings (the viewer's
      // own avatar); the editor opens as an overlay on demand (editEntity/newEntity),
      // no top-bar button, and Back returns to whichever opened it.
      entryButton: false,
      onBack: () => void this.setMenu(this.charEditorReturn),
    });
    this.charCreator = new CharacterCreator({
      save: (data) => this.room?.send('saveAvatar', { data }),
      // Fine-tune the generated look: persist it, then open it in the classic
      // pixel editor (which has paint + copy/paste) as the viewer's own avatar.
      editPixels: (data) => {
        this.room?.send('saveAvatar', { data });
        if (this.myAvatarId) {
          upsertCharacterTemplate(this.myAvatarId, data);
          this.charEditorReturn = 'settings';
          this.charEditor.editEntity('me', this.myAvatarId);
        }
      },
    });
    this.furnEditor = new FurnitureEditor({
      getRawCatalog: () => this.furnitureCatalogRaw,
      save: (name, data) => this.room?.send('saveAsset', { assetType: 'furniture', name, data }),
      reset: (name) => this.room?.send('deleteAsset', { assetType: 'furniture', name }),
      entryButton: false,
      onBack: () => void this.setMenu('assets'),
    });

    // Zone voice: its controls render into the Audio panel body; the scene owns
    // the Audio top-bar button. Positions for proximity come from synced avatars.
    if (this.audioPanel) {
      const audioBody = this.audioPanel.querySelector<HTMLElement>('.pa-body')!;
      this.zoneVoice = new ZoneVoiceUI(audioBody, {
        requestToken: () => this.room?.send('zoneVoiceToken'),
        announceVoice: (event) => this.room?.send('voiceEvent', { event }),
        myPosition: () => this.playerPosition(this.myPlayerId),
        positionOf: (id) => this.playerPosition(id),
        // Both feed in-world indicators (ring / head markers), and a muted-but-
        // silent scene is otherwise perfectly idle, so these wake the loop like
        // user input: one active frame to pick the change up.
        onSpeakers: (ids) => {
          this.voiceSpeakers = ids;
          this.wake(true); // talking indicators changed → redraw
        },
        onVoiceStatus: (status) => {
          this.voiceStatus = status;
          this.wake(true);
        },
        // Reflect live voice state on the Audio dot + quick-access bar buttons.
        onStateChange: (s) => this.updateVoiceBarButtons(s),
        onMicLevel: (level) => {
          if (!this.micBarEqEl) return;
          const st = this.zoneVoice?.voice.state;
          this.micBarEqEl.style.setProperty('--l', (st?.connected && st.micOn) ? String(level) : '0');
        },
      });
    }
    // Mumble owns its own panel. Desktop-only: in the browser MumbleUI renders
    // nothing, so the panel and its bar button simply stay hidden.
    const mumbleBody = this.mumblePanel?.querySelector<HTMLElement>('.pa-body');
    if (mumbleBody) {
      this.mumble = new MumbleUI(mumbleBody, {
        onJoin: () => this.zoneVoice?.voice.suspend('mumble'),
        onLeave: () => this.zoneVoice?.voice.resume('mumble'),
        onOpenSettings: () => void this.setMenu('settings'),
        onPinChange: () => this.applyMumblePin(),
      });
      this.mumble.start();
      this.applyMumblePin();
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
      this.wireArcade(this.room); // server-backed arcade savegames over this room
      // Auto-reconnect: if the connection drops (e.g. a server restart), wait for
      // the server to come back and reload — so the player is back in the game
      // without a manual refresh. A consented leave / our own navigation is skipped.
      this.room.onLeave((code) => {
        if (code === KICK_CLOSE_CODE) {
          this.leavingIntentionally = true; // an admin kicked us — don't auto-reconnect
          this.showKicked();
          return;
        }
        if (!this.leavingIntentionally && code !== 1000) this.handleDisconnect();
      });
      // Any authoritative state change (someone moved, an agent updated, a bubble
      // appeared) must wake an idled/slept render loop so it redraws.
      this.room.onStateChange(() => this.wake());
      this.room.onMessage('m', (m: Record<string, unknown>) => {
        this.wake();
        if (m.type === 'layoutList') this.updateLayoutsPanel(m);
        else if (m.type === 'zoneList') this.updateZoneList(m);
        else if (m.type === 'zoneCreated') void this.onZoneCreated(m);
        else if (m.type === 'zoneMembers') this.onZoneMembers(m);
        else if (m.type === 'userList') this.onUserList(m);
        else if (m.type === 'zoneInviteSent') this.onZoneInviteSent(m);
        else if (m.type === 'zoneInvitePrompt') this.onZoneInvitePrompt(m);
        else if (m.type === 'zoneInviteAccepted') this.onZoneInviteAccepted(m);
        else if (m.type === 'zoneInviteResult') this.onZoneInviteResult(m);
        else if (m.type === 'chat') this.onChat(m);
        else if (m.type === 'chatHistory') this.onChatHistory(m);
        else if (m.type === 'system') this.chat?.addSystemLine((m.text as string) ?? '');
        else if (m.type === 'meetingRoomMembers') {
          if (m.source === 'tile') this.onMeetingAreaMembers(m);
          else this.onConferenceMembers(m);
        }
        else if (m.type === 'meetingRoomToken') {
          if (m.source === 'tile') this.onMeetingAreaToken(m);
          else this.onConferenceToken(m);
        }
        else if (m.type === 'zoneVoiceToken') this.zoneVoice?.onToken(m);
        else if (m.type === 'meetingRoomCreated') this.onMeetingRoomCreated(m);
        else if (m.type === 'meetingRoomList') this.onMeetingRoomList(m);
        else if (m.type === 'meetingRoomDeleted') this.onMeetingRoomDeleted(m);
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
          this.myRole = (m.role as typeof this.myRole) ?? 'user';
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
          // Logged-in → the ☰ menu offers logout; hide editing entry points from
          // non-admins. The ☰ menu (Admin site / Log out rows) may already be
          // open when this arrives (e.g. a reconnect) — refresh it too.
          this.applyAdminVisibility();
          if (this.currentMenu === 'more') this.renderMorePanel();
          this.syncSettingsInputs();
          this.renderCharSwatches();
        }
        else if (m.type === 'agentToken') {
          this.agentToken = (m.token as string) ?? '';
          this.syncSettingsInputs();
        }
        else if (m.type === 'settingsLoaded') this.applySettings(m);
        else if (m.type === 'portalOptions') this.showPortalPicker(m.zones as Array<{ id: string; label: string }>);
        else if (m.type === 'zoneTransition') this.goToZone(m.zone as string); // walked into a portal (P5)
        else if (m.type === 'actionReady') {
          // Arrived at a furniture action we clicked (server picked the
          // stand tile — see officeState.walkPlayerToAction). 'meetingRoom'
          // arrivals don't come through here — the room adds us straight to
          // its membership (see onMeetingRoomMembers).
          const col = m.col as number;
          const row = m.row as number;
          if (m.kind === 'arcade') this.openArcade({ col, row });
          else if (m.kind === 'linkManager') this.openMeetingRoomManageDialog({ col, row });
          else if (m.kind === 'iframe') openActionIframe(m.url as string);
        }
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
        if (isDesktop()) {
          // Desktop has no server login page to redirect to. Clear the rejected
          // token so it can never be reused (AC-009 / DD Error Handling), show the
          // in-app sign-in screen, then reload so the boot flow rehydrates the
          // freshly-stored token straight into the world — never a loop or blank.
          setStatus('session expired — signing in…');
          void desktopReauth();
          return;
        }
        setStatus('session expired — redirecting to login…');
        redirectToLogin();
        return;
      }
      // The requested zone is private and this viewer has no access (not the
      // owner/zone-admin/ACL member/global-admin) — bounce to the default zone
      // instead of getting stuck on a zone that will never let them in.
      if (isForbiddenError(err)) {
        const requested = currentZone();
        if (requested !== DEFAULT_ZONE) {
          setStatus('that zone is private — returning to the default zone…');
          try {
            localStorage.setItem('pa-last-zone', DEFAULT_ZONE);
          } catch {
            /* localStorage unavailable */
          }
          const url = new URL(window.location.href);
          url.searchParams.set('zone', DEFAULT_ZONE);
          history.replaceState(null, '', url.href);
          reloadApp();
          return;
        }
        setStatus('this zone is private');
        void alertDialog('This zone is private — ask its owner to add you to the access list or invite you in.');
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
    rc.afk = cs.afk as boolean;
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
      furniture: Array<{ type: string; col: number; row: number; name?: string; action?: string }>;
    }).furniture;
    this.furniturePlacements = arr.map((f, i) => {
      let action: Action | undefined;
      if (f.action) {
        try {
          action = JSON.parse(f.action) as Action;
        } catch {
          /* malformed — treat as no override */
        }
      }
      return { uid: `f${i}`, type: f.type, col: f.col, row: f.row, name: f.name, action };
    });
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

  /** If the tile is covered by a furniture item that has an action (see
   *  Action) — conference monitor, link-manager kiosk, arcade cabinet, or
   *  any iframe/meetingRoom override — its anchor tile + the action itself,
   *  else null. Mirrors the server's actionAt/effectiveAction. Appliances
   *  are NOT included (see applianceAt) — they go through their own
   *  applianceApproach, not the unified actionApproach. */
  private actionAt(col: number, row: number): { col: number; row: number; action: Action; name?: string } | null {
    for (const f of this.furniturePlacements) {
      const entry = getCatalogEntry(f.type);
      if (!entry) continue;
      if (col < f.col || col >= f.col + entry.footprintW || row < f.row || row >= f.row + entry.footprintH) continue;
      const action = effectiveAction(f, entry);
      if (action && action.kind !== 'appliance') return { col: f.col, row: f.row, action, name: f.name };
    }
    return null;
  }

  /** If the tile is covered by an appliance (e.g. coffee machine, or any item
   *  with an 'appliance' Action override — see effectiveAction), its anchor,
   *  else null. */
  private applianceAt(col: number, row: number): { col: number; row: number } | null {
    for (const f of this.furniturePlacements) {
      const entry = getCatalogEntry(f.type);
      if (!entry) continue;
      if (effectiveAction(f, entry)?.kind !== 'appliance') continue;
      if (col >= f.col && col < f.col + entry.footprintW && row >= f.row && row < f.row + entry.footprintH) {
        return { col: f.col, row: f.row };
      }
    }
    return null;
  }

  /** Open the administration overlay in-place — dynamically imported (its ~900
   *  lines of table/tab UI have no reason to sit in every player's initial
   *  bundle) so only an actual admin ever pays for loading it. Deliberately an
   *  overlay on THIS page, not a navigation to a separate admin.html: leaving
   *  the document would tear down the zone's WebRTC voice call and, on
   *  desktop, the Mumble connection, even though the player never left the
   *  zone. */
  private async openAdminSite(): Promise<void> {
    const { openAdminOverlay } = await import('../admin/main.js');
    openAdminOverlay();
  }

  /** Open the shared arcade overlay and boot the game. Phaser keyboard is disabled
   *  while it's up so the DOS game receives the keys (js-dos owns the mouse). */
  private openArcade(cab: { col: number; row: number }): void {
    if (this.arcadeUI.isOpen) return;
    // Free the keyboard for the game (Phaser + chat give up their keys); restored on close.
    if (this.input.keyboard) this.input.keyboard.enabled = false;
    void this.arcadeUI.openMenu({
      cabinet: `${cab.col},${cab.row}`, // brokers a multiplayer match at this cabinet
      zone: currentZone(), // resolves which games THIS cabinet offers (admin-curated)
      onClose: () => {
        if (this.input.keyboard) this.input.keyboard.enabled = true;
      },
    });
  }

  /** Meeting-room kiosk, clicked/arrived-at: fetch the caller's OWN rooms first
   *  (not just admins — every signed-in user manages their own) so they see
   *  what they already have before minting another one. The response arrives
   *  async via 'meetingRoomList' → onMeetingRoomList, which remembers `kiosk`
   *  here so its "+ New room" button can still validate against the right tile. */
  private openMeetingRoomManageDialog(kiosk: { col: number; row: number }): void {
    this.pendingMeetingKioskForCreate = kiosk;
    this.room?.send('meetingRoomList');
  }

  /** The server's answer to meetingRoomList — "Your meeting rooms": each owned
   *  room with copy-link + click-to-arm delete, plus a button to create a new
   *  one at the kiosk that triggered this. */
  private onMeetingRoomList(m: Record<string, unknown>): void {
    const kiosk = this.pendingMeetingKioskForCreate;
    this.pendingMeetingKioskForCreate = null;
    if (!kiosk) return; // stale response (e.g. the scene moved on) — nothing to attach it to
    const rooms = Array.isArray(m.rooms) ? (m.rooms as Array<Record<string, unknown>>) : [];

    const body = document.createElement('div');
    if (!rooms.length) {
      body.innerHTML = '<div class="muted" style="margin-bottom:.8rem;">You have no meeting rooms yet.</div>';
    } else {
      const list = document.createElement('div');
      list.style.cssText =
        'max-height:16rem;overflow-y:auto;margin-bottom:.8rem;display:flex;flex-direction:column;gap:.5rem;';
      for (const r of rooms) list.appendChild(this.meetingRoomManageRow(r));
      body.appendChild(list);
    }

    openPaDialog({
      title: `Your meeting rooms${rooms.length ? ` (${rooms.length})` : ''}`,
      body,
      // Explicit `return false` — this swaps in a second openPaDialog call
      // (the create form) from inside this dialog's own button handler, and
      // openPaDialog is a single shared modal instance: without `false` here,
      // the outer handler's own auto-close (see paDialog.ts) fires right after
      // and immediately hides the create dialog that was just opened.
      buttons: [{ label: '+ New room', kind: 'primary', onClick: () => { this.openMeetingRoomDialog(kiosk); return false; } }],
    });
  }

  /** One row in the manage-rooms list. Delete is click-to-arm (first click
   *  turns it into "Confirm?") instead of a second stacked confirm dialog — a
   *  dialog-over-dialog doesn't reliably render on top in this UI (same reason
   *  the create dialog's password error is shown inline, not in a second modal). */
  private meetingRoomManageRow(r: Record<string, unknown>): HTMLDivElement {
    const slug = typeof r.slug === 'string' ? r.slug : '';
    const label = typeof r.label === 'string' && r.label ? r.label : slug.slice(0, 8);
    const expiresAt = typeof r.expiresAt === 'number' ? r.expiresAt : 0;
    const hasPassword = !!r.hasPassword;
    const expired = !!r.expired;

    const row = document.createElement('div');
    row.dataset.slug = slug;
    row.style.cssText =
      'display:flex;align-items:center;gap:.5rem;padding:.4rem .5rem;background:#262422;border-radius:.4rem;';
    const info = document.createElement('div');
    info.style.cssText = 'flex:1;min-width:0;font-size:.85rem;';
    const expiryText = expired ? 'expired' : `expires ${new Date(expiresAt).toLocaleDateString()}`;
    info.innerHTML =
      `<div style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${esc(label)}${hasPassword ? ' 🔒' : ''}</div>` +
      `<div class="muted" style="font-size:.78rem;">${expiryText}</div>`;

    const copyBtn = document.createElement('button');
    copyBtn.type = 'button';
    copyBtn.className = 'pa-b';
    copyBtn.textContent = 'Copy link';
    copyBtn.onclick = () => {
      const link = `${location.origin}/meet/${encodeURIComponent(slug)}`;
      navigator.clipboard?.writeText(link).then(
        () => {
          copyBtn.textContent = '✓ Copied';
          setTimeout(() => { copyBtn.textContent = 'Copy link'; }, 1500);
        },
        () => {},
      );
    };

    const delBtn = document.createElement('button');
    delBtn.type = 'button';
    delBtn.className = 'pa-b';
    delBtn.textContent = 'Delete';
    delBtn.onclick = () => {
      if (delBtn.dataset.armed !== '1') {
        delBtn.dataset.armed = '1';
        delBtn.textContent = 'Confirm?';
        delBtn.classList.add('danger');
        return;
      }
      delBtn.disabled = true;
      this.room?.send('meetingRoomDelete', { slug });
    };

    row.append(info, copyBtn, delBtn);
    return row;
  }

  /** The server's answer to meetingRoomDelete — drop the row from the still-open
   *  manage dialog, or reset its armed state on failure. A no-op if the dialog
   *  isn't open anymore (e.g. the player closed it before the response arrived). */
  private onMeetingRoomDeleted(m: Record<string, unknown>): void {
    const slug = typeof m.slug === 'string' ? m.slug : '';
    if (!slug) return;
    const row = document.querySelector<HTMLDivElement>(`#pa-dialog-back [data-slug="${CSS.escape(slug)}"]`);
    if (!row) return;
    if (typeof m.error === 'string') {
      const delBtn = row.querySelector<HTMLButtonElement>('button:last-child')!;
      delBtn.disabled = false;
      delBtn.dataset.armed = '';
      delBtn.textContent = 'Delete';
      delBtn.classList.remove('danger');
      return;
    }
    row.remove();
  }

  /** Meeting-room kiosk, clicked/arrived-at: ask for an expiry + optional
   *  password, then ask the server to mint a fresh room (meetingRoomCreate).
   *  The result (link or error) arrives async via 'meetingRoomCreated'. */
  private openMeetingRoomDialog(kiosk: { col: number; row: number }): void {
    const body = document.createElement('div');
    body.innerHTML = `
      <div class="fld"><label>Expires after</label>
        <select class="pa-select">
          <option value="1">1 day</option>
          <option value="7" selected>7 days</option>
          <option value="14">14 days</option>
          <option value="30">30 days</option>
          <option value="90">3 months</option>
          <option value="180">6 months</option>
        </select>
      </div>
      <div class="fld"><label>Password (optional, min ${MIN_MEETING_ROOM_PASSWORD_LEN} chars)</label>
        <div style="display:flex;gap:.35rem;align-items:center">
          <input class="pa-input" type="password" placeholder="leave empty for no password" maxlength="128" style="flex:1;min-width:0">
          <button type="button" class="pa-b" data-showpw title="Show password">👁</button>
          <button type="button" class="pa-b" data-genpw title="Generate a password">🎲 Generate</button>
        </div>
        <div data-pwerr style="min-height:1.1rem;margin-top:.35rem;font-size:.85rem;color:#f1b0ba;"></div>
      </div>`;
    const ttlSel = body.querySelector<HTMLSelectElement>('select')!;
    const pwIn = body.querySelector<HTMLInputElement>('input')!;
    const pwErr = body.querySelector<HTMLDivElement>('[data-pwerr]')!;
    const showBtn = body.querySelector<HTMLButtonElement>('[data-showpw]')!;
    const genBtn = body.querySelector<HTMLButtonElement>('[data-genpw]')!;
    pwIn.oninput = () => { pwErr.textContent = ''; };
    const setShown = (shown: boolean): void => {
      pwIn.type = shown ? 'text' : 'password';
      showBtn.classList.toggle('primary', shown);
      showBtn.textContent = shown ? '🙈' : '👁';
      showBtn.title = shown ? 'Hide password' : 'Show password';
    };
    showBtn.onclick = () => setShown(pwIn.type === 'password');
    genBtn.onclick = () => {
      pwIn.value = generatePassword();
      pwErr.textContent = '';
      setShown(true); // just generated it — showing it masked would be pointless
    };
    openPaDialog({
      title: 'Create a meeting room',
      body,
      buttons: [
        {
          label: 'Create',
          kind: 'primary',
          onClick: () => {
            const pw = pwIn.value;
            if (pw && pw.length < MIN_MEETING_ROOM_PASSWORD_LEN) {
              // Inline, right under the field — a second modal on top of this one
              // would stack behind it (dialog-over-dialog isn't a supported layer).
              pwErr.textContent = `Password must be at least ${MIN_MEETING_ROOM_PASSWORD_LEN} characters (or leave it empty).`;
              pwIn.focus();
              return false; // keep the dialog open so they can fix it
            }
            this.room?.send('meetingRoomCreate', {
              col: kiosk.col,
              row: kiosk.row,
              ttlDays: Number(ttlSel.value) || 7,
              password: pw || undefined,
            });
          },
        },
      ],
    });
  }

  /** The server minted (or refused) a meeting room — show the shareable link
   *  (copy-to-clipboard) or the error. */
  private onMeetingRoomCreated(m: Record<string, unknown>): void {
    if (typeof m.error === 'string') {
      void alertDialog(`Could not create the meeting room: ${m.error}.`);
      return;
    }
    const slug = typeof m.slug === 'string' ? m.slug : '';
    if (!slug) return;
    const link = `${location.origin}/meet/${encodeURIComponent(slug)}`;
    const body = document.createElement('div');
    body.innerHTML = '<div class="fld"><label>Share this link</label><input class="pa-input" readonly></div><div></div>';
    const inp = body.querySelector<HTMLInputElement>('input')!;
    const feedback = body.querySelector<HTMLDivElement>('div:last-child')!;
    feedback.style.cssText = 'min-height:1.1rem;margin-top:.5rem;font-size:.85rem;';
    inp.value = link;
    openPaDialog({
      title: 'Meeting room ready',
      body,
      buttons: [
        {
          label: 'Copy link',
          kind: 'primary',
          onClick: () => {
            inp.select();
            navigator.clipboard?.writeText(link).then(
              () => { feedback.textContent = '✓ Copied to clipboard.'; feedback.style.color = '#7fbf6a'; },
              () => { feedback.textContent = 'Could not copy automatically — the text above is selected, copy it manually.'; feedback.style.color = '#f0a6a2'; },
            );
            return false; // keep the dialog open — they can copy again or read it
          },
        },
      ],
    });
    setTimeout(() => { inp.focus(); inp.select(); }, 0);
  }

  /** Wire server-backed arcade savegames over the office room (shared store).
   *  Called once the room is connected. */
  private wireArcade(room: Room): void {
    room.onMessage('arcadeSaveData', (m: { game: string; data: Uint8Array | ArrayBuffer | null }) => {
      this.arcadePendingLoads.get(m.game)?.(m.data ? new Uint8Array(m.data as ArrayBuffer) : null);
    });
    // Multiplayer lobby: relay commands to the room + feed its state/launch back.
    this.arcadeUI.setLobbyHooks({
      send: (type, payload) => room.send(type, payload),
    });
    room.onMessage('arcadeLobby', (m: Record<string, unknown>) => this.arcadeUI.onLobbyMsg(m));
    room.onMessage('arcadeLaunch', (m: Record<string, unknown>) => this.arcadeUI.onLaunchMsg(m));
    this.arcadeUI.setSaveHooks({
      load: (gameId) =>
        new Promise<Uint8Array | null>((resolve) => {
          this.arcadePendingLoads.get(gameId)?.(null); // supersede any prior pending load
          let timer = 0;
          const done = (d: Uint8Array | null): void => {
            window.clearTimeout(timer);
            if (this.arcadePendingLoads.get(gameId) === done) this.arcadePendingLoads.delete(gameId);
            resolve(d);
          };
          this.arcadePendingLoads.set(gameId, done);
          timer = window.setTimeout(() => done(null), 8000);
          room.send('arcadeSaveGet', { game: gameId });
        }),
      save: async (gameId, data) => {
        room.send('arcadeSavePut', { game: gameId, data });
      },
      reset: (gameId) => {
        room.send('arcadeSaveReset', { game: gameId });
      },
    });
  }

  private onLayout(layout: OfficeLayout): void {
    this.view.buildStatic();
    this.fitCamera(layout.cols * TILE_SIZE, layout.rows * TILE_SIZE);
    this.maybeAutoEnterEditMode();
  }

  /** The standalone editor page (editor.html) opens straight into edit mode —
   *  no avatar to walk around and open a menu with. Gated behind an explicit
   *  query param so this is a no-op for the normal game page; fires once,
   *  on the first layout load, same trigger point fitCamera uses for "the
   *  office is now known". */
  private autoEnteredEditMode = false;
  private maybeAutoEnterEditMode(): void {
    if (this.autoEnteredEditMode || this.editor.isEditing()) return;
    if (new URLSearchParams(location.search).get('edit') !== '1') return;
    this.autoEnteredEditMode = true;
    void this.toggleEditMode();
  }

  /** Always update bounds (cheap, harmless), but only set zoom/center on the
   *  first layout — so live-edit broadcasts don't jerk the editor's or watchers'
   *  view on every change (only the office bounds grow on expand). Centering
   *  on the map here is just a placeholder for the one frame or so before the
   *  player's own position is known — update()'s follow-camera takes over
   *  immediately once it is. */
  private fitCamera(w: number, h: number): void {
    const cam = this.cameras.main;
    this.officeW = w;
    this.officeH = h;
    if (!this.cameraInitialized) {
      cam.setZoom(DEFAULT_ZOOM);
      cam.centerOn(w / 2, h / 2);
      this.cameraInitialized = true;
    }
    this.applyCameraBounds();
  }

  /** Pan bounds: the map plus half the currently visible world area on each
   *  side — lets you push any map edge to roughly the middle of the screen
   *  instead of stopping a fixed, window-size-oblivious distance past it.
   *  Depends on the CURRENT zoom, so it must run after zoom is set; also
   *  re-run on window resize (see setupIdleWaking) — bounds only, zoom and
   *  centering are left alone so a resize doesn't yank anyone's view. */
  private applyCameraBounds(): void {
    const cam = this.cameras.main;
    const marginX = this.scale.width / cam.zoom / 2;
    const marginY = this.scale.height / cam.zoom / 2;
    cam.setBounds(-marginX, -marginY, this.officeW + marginX * 2, this.officeH + marginY * 2);
  }

  // ── Input: pan / zoom / hover / select ───────────────────────────

  private setupInput(): void {
    const cam = this.cameras.main;
    this.input.mouse?.disableContextMenu();
    // While editing, a plain two-finger trackpad scroll (no modifier) pans —
    // the same convention as Tiled/Figma/Photoshop — since building a map
    // means panning around it constantly; Ctrl/Cmd+scroll (also how a
    // trackpad pinch-zoom is reported) still zooms. Outside the editor,
    // gameplay keeps its original plain-scroll-zooms feel unchanged.
    this.input.on('wheel', (p: Phaser.Input.Pointer, _o: unknown, dx: number, dy: number) => {
      const ev = p.event as WheelEvent | undefined;
      if (this.editor.isEditing() && !(ev?.ctrlKey || ev?.metaKey)) {
        cam.scrollX += dx / cam.zoom;
        cam.scrollY += dy / cam.zoom;
        return;
      }
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
            const action = this.actionAt(col, row);
            const appliance = this.applianceAt(col, row);
            if (action && action.action.kind === 'meetingRoom') {
              // Click a monitor (or any other 'meetingRoom'-action sprite) →
              // toggle join/leave, same as before (see toggleConference).
              void this.toggleConference({ col: action.col, row: action.row, name: action.name });
            } else if (action) {
              // Server-authoritative walk-then-open (link-manager kiosk,
              // arcade cabinet, iframe sprite): it picks a (random, so
              // simultaneous visitors spread out) stand tile, walks the
              // avatar, then tells us to open the local UI once arrived —
              // see onActionReady / 'actionReady'.
              this.pendingConference = null;
              this.room?.send('actionApproach', { col: action.col, row: action.row });
            } else if (appliance) {
              // Same server-authoritative walk-then-use (see officeState's useAppliance).
              this.room?.send('applianceApproach', { col: appliance.col, row: appliance.row });
            } else {
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
        if (!moved && Math.abs(p.x - lx) + Math.abs(p.y - ly) > 2) {
          moved = true;
          // A real pan (not just a click) detaches the follow-camera — see
          // update()'s re-engage check.
          if (!this.cameraFollowDetached) {
            this.cameraFollowDetached = true;
            this.cameraDetachAt = this.playerPosition(this.myPlayerId);
          }
        }
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
      if (this.myPlayerId === null || this.editor.isEditing() || this.arcadeUI.isOpen) return true;
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
    // Mic mute toggle (M) for zone voice — only while voice is on (mirrors the
    // bar mic button), and never while typing (blocked() covers chat/inputs).
    window.addEventListener('keydown', (e) => {
      if (e.code !== 'KeyM' || e.repeat || blocked()) return;
      if (!this.zoneVoice?.voice.isEnabled) return;
      e.preventDefault();
      this.zoneVoice.voice.toggleMic();
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
    const t0 = this.perfEnabled ? performance.now() : 0;
    // Follow-camera: recenter on the local player every frame this runs at
    // all (ahead of the idle-throttle return below, so it isn't skipped and
    // catches up immediately once the player's own position is first known),
    // unless a manual drag has detached it — in which case check whether the
    // player has since moved (any cause: walk, sit, portal) and re-engage the
    // moment they have. Never while editing (its own free-camera feel stays),
    // nor when the user turned it off in Settings (the old, pre-follow feel).
    if (!this.editor.isEditing() && this.cameraFollowEnabled) {
      const pos = this.playerPosition(this.myPlayerId);
      if (pos) {
        if (this.cameraFollowDetached) {
          const at = this.cameraDetachAt;
          if (!at || Math.abs(pos.x - at.x) > 0.5 || Math.abs(pos.y - at.y) > 0.5) {
            this.cameraFollowDetached = false;
            this.cameraDetachAt = null;
          }
        }
        if (!this.cameraFollowDetached) this.cameras.main.centerOn(pos.x, pos.y);
      }
    }
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
    // Idle throttle: when nothing is moving/animating, skip the per-frame entity
    // sync + DOM overlays (the bulk of the CPU) and, after a short grace, sleep the
    // whole render loop — woken again by input, state patches, voice or tab focus.
    const busy = this.sceneBusy(_time);
    if (busy) this.idleFrames = 0;
    else this.idleFrames++;
    const justStopped = !busy && this.wasBusy;
    this.wasBusy = busy;
    if (!busy && this.idleFrames > IDLE_GRACE_FRAMES) {
      if (this.idleFrames >= SLEEP_AFTER_IDLE_FRAMES) this.sleepLoop();
      if (this.perfEnabled) this.recordPerf(performance.now() - t0);
      return; // static scene → nothing to redraw
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
    // DOM overlays (labels/bubbles/tooltip) don't need 60 Hz — cap to ~20 Hz, but
    // always run once when movement just stopped so labels settle at their final
    // position (avoids a 50 ms trailing lag freezing in the wrong spot).
    if (justStopped || _time - this.lastOverlayAt >= OVERLAY_INTERVAL_MS) {
      this.lastOverlayAt = _time;
      this.updateTooltip();
      this.updateNameLabels();
      this.updateChatBubbles();
      this.updateVoiceIndicators();
    }
    if (this.perfEnabled) this.recordPerf(performance.now() - t0);
  }

  /** Whether anything needs redrawing this frame: a moving/animating entity, an
   *  active bubble/tooltip, or an interactive mode. When false for a while the
   *  loop idles (skips work, then sleeps) until something wakes it. */
  private sceneBusy(now: number): boolean {
    if (this.editor.isEditing() || this.furnitureDirty) return true;
    if (this.portalPickerTile) return true;
    if (this.tip && this.tip.style.display !== 'none') return true; // hover tooltip
    if (this.voiceSpeakUntil.size > 0) return true; // pulsing in-world speaking ring
    for (const b of this.chatBubbles.values()) if (b.until > now) return true;
    for (const ch of this.characters.values()) {
      if (Math.abs((ch.x ?? ch.tx) - ch.tx) > 0.4 || Math.abs((ch.y ?? ch.ty) - ch.ty) > 0.4) return true;
      if (ch.matrixEffect || ch.bubbleType) return true;
      if ((POSE_FRAME_MS[(ch.pose ?? 'idle') as CharacterPose] ?? 0) > 0) return true; // animating pose
    }
    for (const p of this.pets.values()) {
      if (Math.abs((p.x ?? p.tx) - p.tx) > 0.4 || Math.abs((p.y ?? p.ty) - p.ty) > 0.4) return true;
    }
    return false;
  }

  /** Wire everything that must wake the idle/slept render loop: any input, tab
   *  focus, window resize. (State patches + voice wake it from their callbacks.)
   *  Also the perf-overlay toggle (F8, or `?perf=1` on load). */
  private setupIdleWaking(): void {
    const input = (): void => this.wake(true); // real user action → stay responsive
    // DOM-level listeners: a slept Phaser loop stops processing its own input, so
    // `this.input.*` can't wake it — native events must. Pointer-move only over the
    // canvas (so mousing over side panels doesn't keep the world spinning); keys,
    // clicks and wheel from anywhere.
    this.game.canvas?.addEventListener('pointermove', input, { passive: true });
    window.addEventListener('pointerdown', input, { passive: true });
    window.addEventListener('wheel', input, { passive: true });
    window.addEventListener('keydown', (e) => {
      if (e.key === 'F8') this.togglePerf();
      input();
    });
    window.addEventListener('resize', input);
    // Phaser's own resize event (not the raw DOM one above) — fires once the
    // Scale Manager has actually updated this.scale.width/height, so the
    // margin math in applyCameraBounds reads the new size, not a stale one.
    this.scale.on(Phaser.Scale.Events.RESIZE, () => this.applyCameraBounds());
    // Tab hidden → sleep the loop entirely; visible/focused → wake.
    document.addEventListener('visibilitychange', () => (document.hidden ? this.sleepLoop() : this.wake()));
    window.addEventListener('focus', () => this.wake());
    if (new URLSearchParams(window.location.search).get('perf')) this.togglePerf();
  }

  /** Re-run the render loop after it was idled/slept. `userInput` = a real user
   *  action (mouse/keys), or a discrete event whose result must show up now
   *  (voice mute/speaking) → keep the scene responsive (reset the idle counter).
   *  Bulk state patches pass false: they only wake a SLEPT loop; while already
   *  awake, whether to stay active is decided by sceneBusy() (actual on-screen
   *  motion), so idle bookkeeping patches don't peg the loop active. */
  private wake(userInput = false): void {
    if (this.loopAsleep) {
      this.loopAsleep = false;
      this.idleFrames = 0;
      this.game.loop.wake();
      return;
    }
    if (userInput) this.idleFrames = 0;
  }

  private sleepLoop(): void {
    if (this.loopAsleep) return;
    this.loopAsleep = true;
    this.game.loop.sleep();
  }

  /** Rolling average of the per-frame update() cost, shown in the perf overlay. */
  private recordPerf(frameMs: number): void {
    this.updateMsAvg += (frameMs - this.updateMsAvg) * 0.1;
    const el = this.perfEl;
    if (!el) return;
    // Fixed-width fields (padded + tabular-nums) so the centred box doesn't wobble.
    const fps = String(Math.round(this.game.loop.actualFps)).padStart(3);
    const ms = this.updateMsAvg.toFixed(2).padStart(5);
    const chars = String(this.characters.size).padStart(2);
    const stateTxt = (this.loopAsleep ? 'asleep' : this.idleFrames > IDLE_GRACE_FRAMES ? 'idle' : 'active').padEnd(6);
    el.textContent = `${fps} fps · ${ms} ms · ${chars} chars · ${stateTxt}`;
  }

  private togglePerf(): void {
    this.perfEnabled = !this.perfEnabled;
    if (this.perfEnabled && !this.perfEl) {
      const el = document.createElement('div');
      el.style.cssText =
        'position:fixed;left:50%;bottom:6px;transform:translateX(-50%);z-index:300;padding:.25rem .5rem;' +
        'border-radius:.35rem;pointer-events:none;background:rgba(10,12,18,.8);color:#8fe;' +
        "font:0.72rem ui-monospace,monospace;font-variant-numeric:tabular-nums;white-space:pre;";
      (document.getElementById('game') ?? document.body).appendChild(el);
      this.perfEl = el;
    }
    if (this.perfEl) this.perfEl.style.display = this.perfEnabled ? '' : 'none';
  }

  // ── Menus (grouped top bar + one shared popover style) ───────────

  /**
   * Show exactly one grouped popover (Audio / Zone / Space / Assets / Menu /
   * Settings / Help), or none — opening one closes the others and any open
   * asset editor. The layout editor is the exception (you edit via the canvas).
   */
  private async setMenu(menu: MenuId): Promise<void> {
    // The character/furniture editors open as overlays; leaving one with unsaved
    // edits confirms/discards first, then closes it.
    if (this.charEditor?.isOpen() && !(await this.charEditor.confirmLeave())) return;
    if (this.furnEditor?.isOpen() && !(await this.furnEditor.confirmLeave())) return;
    this.charEditor?.close();
    this.furnEditor?.forceClose();

    this.currentMenu = menu;
    const show = (el: HTMLElement | undefined, id: MenuId): void => {
      if (el) el.style.display = menu === id ? 'block' : 'none';
    };
    show(this.audioPanel, 'audio');
    // A pinned Mumble panel opts out of the one-panel-at-a-time rule.
    if (this.mumble?.isPinned) {
      if (this.mumblePanel) this.mumblePanel.style.display = 'block';
    } else {
      show(this.mumblePanel, 'mumble');
    }
    show(this.zonePanel, 'zone');
    show(this.spacePanel, 'space');
    show(this.assetsPanel, 'assets');
    show(this.morePanel, 'more');
    show(this.settingsPanel, 'settings');
    show(this.helpPanel, 'help');

    this.audioBtn?.classList.toggle('active', menu === 'audio');
    this.mumbleBtn?.classList.toggle('active', menu === 'mumble' || this.mumble?.isPinned === true);
    this.zoneBtn?.classList.toggle('active', menu === 'zone');
    this.spaceBtn?.classList.toggle('active', menu === 'space');
    this.assetsBtn?.classList.toggle('active', menu === 'assets');
    // The ☰ group owns Menu + its sub-panels (Settings / Help).
    this.moreBtn?.classList.toggle('active', menu === 'more' || menu === 'settings' || menu === 'help');

    if (menu === 'zone') this.renderZoneList();
    if (menu === 'space') {
      this.room?.send('requestLayouts');
      this.room?.send('requestZones');
      this.renderSpaceTabs();
    }
    if (menu === 'assets') this.renderAssetsPanel();
    if (menu === 'more') this.renderMorePanel();
    if (menu === 'settings') {
      this.renderCharSwatches();
      this.syncSettingsInputs();
    }
  }

  /**
   * Reflect the Mumble pin: a pinned panel stays visible regardless of the
   * current menu, and the body class shifts the other right-hand popovers left
   * so they don't land on top of it.
   */
  private applyMumblePin(): void {
    const pinned = this.mumble?.isPinned === true;
    document.body.classList.toggle('pa-mumble-pinned', pinned);
    if (this.mumblePanel && pinned) this.mumblePanel.style.display = 'block';
    else if (this.mumblePanel && this.currentMenu !== 'mumble') this.mumblePanel.style.display = 'none';
    this.mumbleBtn?.classList.toggle('active', pinned || this.currentMenu === 'mumble');
  }

  /** Edit mode owns the screen: close the menu + hide the whole top bar (it would
   *  otherwise cover the layout editor's Done/tool controls at the top). */
  private setEditMode(editing: boolean): void {
    void this.setMenu(null);
    if (this.menubar) this.menubar.style.display = editing ? 'none' : 'flex';
    // On exit, make sure the last edit reaches the server.
    if (!editing) {
      this.flushAutosave();
      this.editTarget = '';
    }
  }

  /** Collapse the toolbar: Space + Assets tuck into the ☰ menu (design). */
  private toggleCollapse(): void {
    this.collapsed = !this.collapsed;
    this.refreshBarButtons();
    if (this.currentMenu === 'more') this.renderMorePanel();
  }

  /** Space + Assets bar buttons: hidden when collapsed; Assets also needs the
   *  shared-gallery admin role (server enforcement is authoritative — UX only). */
  private refreshBarButtons(): void {
    if (this.spaceBtn) this.spaceBtn.style.display = this.collapsed ? 'none' : '';
    if (this.assetsBtn) this.assetsBtn.style.display = this.collapsed || !this.assetsAdmin ? 'none' : '';
  }

  /** Reflect zone-voice state on the bar: the Audio live dot + the quick-access
   *  mic/silence buttons (visible only while connected). */
  private updateVoiceBarButtons(s: { connected: boolean; micOn: boolean; deafened: boolean }): void {
    this.audioDot?.classList.toggle('live', s.connected);
    if (this.micBarBtn) {
      // Keep the mic glyph; a red ⊘ (CSS) marks the muted state.
      this.micBarBtn.style.display = s.connected ? '' : 'none';
      this.micBarBtn.classList.toggle('danger', !s.micOn);
      this.micBarBtn.title = s.micOn ? 'Mute your mic' : 'Unmute your mic';
      if (this.micBarEqEl && !s.connected) this.micBarEqEl.style.setProperty('--l', '0');
    }
    if (this.deafBarBtn) {
      // Keep the speaker glyph; a red slash (CSS) marks the silenced state.
      this.deafBarBtn.style.display = s.connected ? '' : 'none';
      this.deafBarBtn.classList.toggle('danger', s.deafened);
      this.deafBarBtn.title = s.deafened ? 'Un-silence everyone' : 'Silence everyone';
    }
  }

  // ── Top bar + shared popover shells ──────────────────────────────

  private createHud(): void {
    injectPaSkin(); // shared .pa-* menu skin (client/src/ui/paSkin.ts)

    const host = document.getElementById('game') ?? document.body;
    const bar = document.createElement('div');
    bar.id = 'pa-menubar';
    bar.className = 'pa-ui';

    // Audio (far left) — one control for Voice/Live/Sound, with a live dot.
    const audio = this.mkBarBtn('🔊', 'Audio');
    const dot = document.createElement('span');
    dot.className = 'pa-dot';
    audio.appendChild(dot);
    audio.onclick = () => void this.setMenu(this.currentMenu === 'audio' ? null : 'audio');
    this.audioBtn = audio;
    this.audioDot = dot;

    // Quick-access mic mute + silence-others (only shown once voice is connected).
    const mic = this.mkBarBtn('🎤', '');
    mic.title = 'Mute / unmute your mic';
    mic.style.display = 'none';
    mic.onclick = () => this.zoneVoice?.voice.toggleMic();
    this.micBarBtn = mic;
    const eq = document.createElement('span');
    eq.className = 'pa-eq';
    eq.innerHTML = '<span></span><span></span><span></span><span></span><span></span>';
    mic.appendChild(eq);
    this.micBarEqEl = eq;
    const deaf = this.mkBarBtn('🔊', '');
    deaf.title = 'Silence / un-silence everyone';
    deaf.style.display = 'none';
    deaf.onclick = () => this.zoneVoice?.voice.toggleDeafen();
    this.deafBarBtn = deaf;

    // Mumble — its own top-level entry, shown only on the desktop build.
    const mumbleBtn = this.mkBarBtn('🎧', 'Mumble');
    mumbleBtn.onclick = () => void this.setMenu(this.currentMenu === 'mumble' ? null : 'mumble');
    mumbleBtn.style.display = MumbleVoice.supported ? '' : 'none';
    this.mumbleBtn = mumbleBtn;

    const divider = document.createElement('span');
    divider.className = 'pa-div';

    // Zone switcher (quick travel) — always visible, even when collapsed.
    const zone = this.mkBarBtn('🚪', '');
    const zlabel = document.createElement('span');
    zlabel.textContent = 'Zone';
    const caret = document.createElement('span');
    caret.className = 'caret';
    caret.textContent = '▾';
    zone.append(zlabel, caret);
    zone.onclick = () => void this.setMenu(this.currentMenu === 'zone' ? null : 'zone');
    this.zoneBtn = zone;
    this.zoneLabelEl = zlabel;

    const space = this.mkBarBtn('🌐', 'Space');
    space.onclick = () => void this.setMenu(this.currentMenu === 'space' ? null : 'space');
    this.spaceBtn = space;

    const assets = this.mkBarBtn('🎨', 'Assets');
    assets.onclick = () => void this.setMenu(this.currentMenu === 'assets' ? null : 'assets');
    this.assetsBtn = assets;

    const spacer = document.createElement('span');
    spacer.className = 'pa-spacer';

    const more = document.createElement('button');
    more.id = 'pa-menu-more';
    more.className = 'pa-btn';
    const moreIco = document.createElement('span');
    moreIco.className = 'ico';
    moreIco.textContent = '☰';
    more.appendChild(moreIco);
    more.title = 'Menu';
    more.onclick = () =>
      void this.setMenu(
        this.currentMenu === 'more' || this.currentMenu === 'settings' || this.currentMenu === 'help' ? null : 'more',
      );
    this.moreBtn = more;

    bar.append(audio, mic, deaf, mumbleBtn, divider, zone, space, assets, spacer, more);

    // Desktop-only window controls. The Electron shell hides the native menu bar
    // and title-bar menus, so the HUD carries its own chrome: a DevTools toggle
    // and a close-app button, pinned to the far right after the ☰ menu.
    if (isDesktop()) {
      const devtools = this.mkBarBtn('🛠', '');
      devtools.title = 'Toggle developer tools';
      devtools.onclick = () => void desktop().toggleDevTools();

      // Plain ✕ — no `.danger`, whose red circle-and-slash overlay reads as a
      // "muted/blocked" state badge (mic, deafen) rather than a close control.
      const closeApp = this.mkBarBtn('✕', '');
      closeApp.title = 'Close app';
      closeApp.classList.add('pa-close');
      closeApp.onclick = () => void desktop().closeWindow();

      bar.append(devtools, closeApp);
    }

    host.appendChild(bar);
    this.menubar = bar;

    // Pull the connection/status line into the bar (just left of ☰) so the
    // full-width bar no longer covers it — and it reads as part of the HUD.
    const statusEl = document.getElementById('status');
    if (statusEl) {
      statusEl.style.cssText =
        'position:static;margin:0;padding:0.4rem 0.7rem;font-size:0.85rem;color:#adb0b2;' +
        'background:#242220;border:2px solid #0a0908;border-radius:0.45rem;' +
        'box-shadow:inset 0 2px 0 #4a4744,inset 0 -3px 0 #050505;max-width:16rem;' +
        'overflow:hidden;text-overflow:ellipsis;white-space:nowrap;';
      bar.insertBefore(statusEl, more);
    }

    // Audio panel — ZoneVoiceUI renders its controls into this body (in create()).
    this.audioPanel = this.mkPanel('Audio', 'left').panel;

    // Mumble gets its own panel rather than living under Audio: it is a whole
    // second client (channel tree, roster, its own devices) and it is the one
    // panel people want kept open while they play. Docked on the right so a
    // pinned roster doesn't sit on top of the left-hand menus.
    const mb = this.mkPanel('Mumble', 'right');
    this.mumblePanel = mb.panel;
    mb.panel.id = 'pa-mumble-panel';
    // ✕ on a pinned panel has to release the pin, or it would look broken:
    // setMenu(null) alone leaves a pinned panel on screen by design.
    const mbClose = mb.panel.querySelector<HTMLElement>('.pa-x');
    if (mbClose) {
      mbClose.onclick = () => {
        this.mumble?.unpin();
        void this.setMenu(null);
      };
    }

    // Zone travel panel.
    this.zonePanel = this.mkPanel('Travel', 'left').panel;

    // Space panel — Layouts / Zones behind a segmented control.
    const sp = this.mkPanel('Space', 'left');
    this.spacePanel = sp.panel;
    const seg = document.createElement('div');
    seg.className = 'pa-seg';
    const segLayouts = document.createElement('div');
    segLayouts.className = 'seg';
    segLayouts.textContent = 'Layouts';
    segLayouts.onclick = () => {
      this.spaceTab = 'layouts';
      this.renderSpaceTabs();
    };
    const segZones = document.createElement('div');
    segZones.className = 'seg';
    segZones.textContent = 'Zones';
    segZones.onclick = () => {
      this.spaceTab = 'zones';
      this.renderSpaceTabs();
    };
    seg.append(segLayouts, segZones);
    this.layoutsSeg = segLayouts;
    const lp = document.createElement('div');
    lp.id = 'pa-layouts';
    const zp = document.createElement('div');
    zp.id = 'pa-zones';
    sp.body.append(seg, lp, zp);
    this.layoutsPanel = lp;
    this.zonesPanel = zp;

    // Assets panel — Characters / Furniture browser (rendered on open).
    const ap = this.mkPanel('Assets', 'left');
    this.assetsPanel = ap.panel;
    this.assetsBody = ap.body;

    // ☰ menu panel (Settings / Help + collapse toggle, + Space/Assets when collapsed).
    this.morePanel = this.mkPanel('Menu', 'right').panel;

    // Help panel.
    const hp = this.mkPanel('Controls', 'right');
    hp.body.id = 'pa-help-body';
    this.helpPanel = hp.panel;
    this.renderHelpPanel();
    this.renderZoneSwitcher();
  }

  /** A grouped top-bar button: an icon glyph + optional text label. */
  private mkBarBtn(icon: string, label: string): HTMLButtonElement {
    const b = document.createElement('button');
    b.className = 'pa-btn';
    const ic = document.createElement('span');
    ic.className = 'ico';
    ic.textContent = icon;
    b.appendChild(ic);
    if (label) {
      const t = document.createElement('span');
      t.textContent = label;
      b.appendChild(t);
    }
    return b;
  }

  /** Build one shared popover shell (header title + ✕ + scrollable body). */
  private mkPanel(title: string, side: 'left' | 'right'): { panel: HTMLDivElement; body: HTMLDivElement } {
    const panel = document.createElement('div');
    panel.className = `pa-panel pa-ui ${side}`;
    const head = document.createElement('div');
    head.className = 'pa-head';
    const h = document.createElement('h4');
    h.textContent = title;
    const x = document.createElement('div');
    x.className = 'pa-x';
    x.textContent = '✕';
    x.onclick = () => void this.setMenu(null);
    head.append(h, x);
    const body = document.createElement('div');
    body.className = 'pa-body';
    panel.append(head, body);
    (document.getElementById('game') ?? document.body).appendChild(panel);
    return { panel, body };
  }

  /** Toggle the Space panel's Layouts/Zones tab + render the active one. */
  private renderSpaceTabs(): void {
    const showLayouts = this.spaceTab === 'layouts';
    this.layoutsSeg?.classList.toggle('on', showLayouts);
    (this.layoutsSeg?.nextElementSibling as HTMLElement | null)?.classList.toggle('on', !showLayouts);
    if (this.layoutsPanel) this.layoutsPanel.style.display = showLayouts ? 'block' : 'none';
    if (this.zonesPanel) this.zonesPanel.style.display = showLayouts ? 'none' : 'block';
    if (showLayouts) this.renderLayoutsPanel();
    else this.renderZonesPanel();
  }

  /** ☰ menu: Settings / Help, the collapse toggle, and (when collapsed) the
   *  Space + Assets entries that were tucked away from the bar. */
  private renderMorePanel(): void {
    const body = this.morePanel?.querySelector<HTMLElement>('.pa-body');
    if (!body) return;
    body.replaceChildren();
    if (this.myUserId) {
      const who = document.createElement('div');
      who.className = 'pa-whoami';
      who.innerHTML =
        `<div class="name">${esc(this.viewerUsername || this.myUserId)}${this.isAdmin ? '<span class="admin">★ Admin</span>' : ''}</div>` +
        `<div class="handle">@${esc(this.myUserId)}</div>`;
      body.appendChild(who);
    }
    const row = (icon: string, label: string, sub: string | null, onClick: () => void, opts: { danger?: boolean } = {}): void => {
      const r = document.createElement('div');
      r.className = 'pa-menurow' + (opts.danger ? ' danger' : '');
      r.append(document.createTextNode(`${icon} ${label}`));
      if (sub) {
        const s = document.createElement('span');
        s.className = 'sub';
        s.textContent = sub;
        r.appendChild(s);
      }
      r.onclick = onClick;
      body.appendChild(r);
    };
    if (this.collapsed) {
      row('🌐', 'Space', 'Zones · Layouts', () => void this.setMenu('space'));
      if (this.assetsAdmin) row('🎨', 'Assets', 'Chars · Furniture', () => void this.setMenu('assets'));
    }
    row('⚙', 'Settings', null, () => void this.setMenu('settings'));
    row('❓', 'Help', null, () => void this.setMenu('help'));
    // Same action as the /admin-site chat command — global admins only (the
    // admin API 403s anyone else, so hiding it otherwise isn't security, just
    // not offering a control that would just error out).
    if (this.isAdmin) row('🛡', 'Admin site', null, () => void this.openAdminSite());
    if (this.myUserId) {
      row(
        '🚪',
        'Log out',
        null,
        () => {
          if (isDesktop()) {
            void desktopSignOut();
            return;
          }
          gotoLogout();
        },
        { danger: true },
      );
    }
    const hr = document.createElement('div');
    hr.style.cssText = 'height:1px;background:#2c2a28;margin:0.3rem 0 0.6rem;';
    body.appendChild(hr);
    row(
      '▤',
      this.collapsed ? 'Expand toolbar' : 'Collapse toolbar',
      this.collapsed ? 'show all buttons' : 'tools into ☰',
      () => this.toggleCollapse(),
    );
  }

  /** Zone travel list (choose a zone → reconnect at its arrival tile). */
  private renderZoneList(): void {
    const body = this.zonePanel?.querySelector<HTMLElement>('.pa-body');
    if (!body) return;
    const cur = currentZone();
    body.replaceChildren();
    for (const z of this.zoneList) {
      const here = z.id === cur;
      const r = document.createElement('div');
      r.className = 'pa-menurow' + (here ? ' here' : '');
      r.append(document.createTextNode(`🚪 ${z.label}`));
      const s = document.createElement('span');
      s.className = 'sub';
      s.textContent = here ? '● here' : 'Go';
      r.appendChild(s);
      if (!here) r.onclick = () => this.goToZone(z.id);
      body.appendChild(r);
    }
  }

  private renderHelpPanel(): void {
    const body = this.helpPanel?.querySelector<HTMLElement>('.pa-body');
    if (!body) return;
    const sections: Array<{ title: string; rows: Array<[string, string]> }> = [
      {
        title: 'Move & camera',
        rows: [
          ['W A S D / Arrows', 'Move'],
          ['Left-click floor', 'Walk there'],
          ['Left-click chair / bench', 'Sit down'],
          ['C', 'Sit / stand (in place)'],
          ['Click an avatar', 'Select it (tooltip) — hover works too'],
          ['Mouse wheel', 'Zoom'],
          ['Drag (empty space)', 'Pan the camera'],
          ['F8', 'Toggle the performance overlay (FPS / frame time)'],
        ],
      },
      {
        title: 'Chat',
        rows: [
          ['Enter', 'Focus chat, then send (cursor stays)'],
          ['Esc', 'Leave the chat field'],
          ['↑ / ↓ (in chat)', 'Browse your last messages'],
          ['Tab (in chat)', 'Autocomplete a /command'],
          ['/help', 'List every chat command'],
        ],
      },
      {
        title: 'Zones & travel',
        rows: [
          ['Walk onto a door / beam pad', 'Choose a destination zone'],
          ['🚪 zone name (top bar)', 'Jump straight to any zone'],
          ['🌐 Space → Zones', 'Create a zone, or travel to any of them'],
          ['✎ / 🐾 / ✕ (zone admin)', 'Rename, pick which NPCs spawn, or delete a zone'],
          ['📍 Set arrival point', 'Where new arrivals land in this zone (zone admin)'],
          ['⚙ next to your zone', 'Privacy, access list, invites, entry password'],
          ['👤 next to your zone', 'Grant or revoke zone-admins (who may edit its layout)'],
        ],
      },
      {
        title: 'Editing a layout',
        rows: [
          ['🌐 Space → Layouts → ✏ Edit', 'Rearrange floor, walls, furniture (zone admin)'],
          ['First edit of a zone', 'Forks the shared "Default" into your own saved layout'],
          ['1 2 3 4 5 (while editing)', 'Select / furniture / floor / wall / eyedropper tool'],
          ['R / Shift+R', 'Rotate the selected piece'],
          ['Delete / Backspace', 'Remove the selected piece'],
          ['Ctrl+Z / Ctrl+Shift+Z', 'Undo / redo'],
          ['✓ Done', 'Exit — changes already autosaved live for everyone here'],
        ],
      },
      {
        title: 'Voice',
        rows: [
          ['🔊 Audio (top bar)', 'Proximity voice — louder the closer someone stands'],
          ['M', 'Mute / unmute your mic (while in voice)'],
          ['🎧 Mumble (desktop app)', 'A separate, persistent cross-zone voice channel'],
        ],
      },
      {
        title: 'Conferencing & meetings',
        rows: [
          ['Click a conference monitor', 'Join a video call (mic / cam / screen-share); click again to leave'],
          ['Click a meeting-room kiosk', 'Create your own room with a shareable link — works without an account'],
        ],
      },
      {
        title: 'Arcade',
        rows: [
          ['Click a cabinet', 'Pick a game to play; some support a multiplayer lobby'],
          ['Your progress', 'Saves automatically, per game'],
        ],
      },
      {
        title: 'Your account',
        rows: [
          ['☰ → Settings', 'Display name, password, agent token'],
          ['✨ Create / ✏ Edit', 'Your own avatar — or start from a shared template'],
          ['Sound / volume / labels', 'Notification and display preferences'],
        ],
      },
      {
        title: 'Menu (☰)',
        rows: [
          ['⚙ Settings · ❓ Help', 'This panel and your account settings'],
          ['🛡 Admin site', 'Global admins only'],
          ['🎨 Assets', 'Edit the shared character & furniture galleries (admins)'],
          ['🚪 Log out', ''],
          ['▤ Collapse toolbar', 'Tucks Space / Assets into ☰ on a small screen'],
        ],
      },
    ];
    body.innerHTML = sections
      .map(
        (sec) =>
          `<div class="grouplbl">${esc(sec.title)}</div>` +
          sec.rows.map(([k, v]) => `<div class="row"><kbd>${esc(k)}</kbd><span>${esc(v)}</span></div>`).join(''),
      )
      .join('');
  }

  // ── Assets browser (Characters / Furniture) ──────────────────────

  private renderAssetsPanel(): void {
    const body = this.assetsBody;
    if (!body) return;
    body.replaceChildren();
    const seg = document.createElement('div');
    seg.className = 'pa-seg';
    const mkSeg = (label: string, on: boolean, onClick: () => void): HTMLElement => {
      const s = document.createElement('div');
      s.className = 'seg' + (on ? ' on' : '');
      s.textContent = label;
      s.onclick = onClick;
      return s;
    };
    seg.append(
      mkSeg('Characters', this.assetsTab === 'chars', () => {
        this.assetsTab = 'chars';
        this.renderAssetsPanel();
      }),
      mkSeg('Furniture', this.assetsTab === 'furniture', () => {
        this.assetsTab = 'furniture';
        this.renderAssetsPanel();
      }),
    );
    body.appendChild(seg);
    if (this.assetsTab === 'chars') this.renderCharAssets(body);
    else this.renderFurnAssets(body);
  }

  /** Next free char_<n> id (ids are stable, never reused) — mirrors the editor. */
  private nextCharId(existing: string[]): string {
    const taken = new Set(existing);
    let n = 0;
    while (taken.has(`char_${n}`)) n++;
    return `char_${n}`;
  }

  private renderCharAssets(body: HTMLElement): void {
    const chips = document.createElement('div');
    chips.className = 'pa-chips';
    const mkChip = (label: string, tab: 'agent' | 'npc'): HTMLElement => {
      const c = document.createElement('div');
      c.className = 'pa-chip' + (this.charTab === tab ? ' on' : '');
      c.textContent = label;
      c.onclick = () => {
        this.charTab = tab;
        this.renderAssetsPanel();
      };
      return c;
    };
    // Assets manages only the shared (not-yet-user-specific) avatars + NPCs.
    // A player's own avatar is created/edited from Settings, not here.
    chips.append(mkChip('Avatars', 'agent'), mkChip('NPCs', 'npc'));
    body.appendChild(chips);

    type Item = { id: string; name: string; frame?: SpriteData; kind: 'agent' | 'npc' };
    let items: Item[] = [];
    if (this.charTab === 'agent') {
      items = (getCharacterTemplates() ?? [])
        .filter((c) => !isPlayerAvatarSkin(c.id))
        .map((c) => ({ id: c.id, name: c.id, frame: c.data.down?.[1] ?? c.data.down?.[0], kind: 'agent' as const }));
    } else {
      items = getNpcRoster().map((r) => ({
        id: `${r.kind}_${r.variant}`,
        name: `${r.kind} ${r.variant}`,
        frame: r.data.down?.[1] ?? r.data.down?.[0],
        kind: 'npc' as const,
      }));
    }

    if (this.charTab === 'agent') {
      const add = document.createElement('button');
      add.className = 'pa-b primary wide';
      add.textContent = '＋ New avatar';
      add.onclick = () => {
        void this.setMenu(null);
        this.charEditorReturn = 'assets';
        this.charEditor.newEntity('agent');
      };
      body.appendChild(add);
    }

    if (!items.length) {
      const empty = document.createElement('div');
      empty.className = 'grouplbl';
      empty.textContent = 'None yet.';
      body.appendChild(empty);
    }
    for (const it of items) {
      const row = document.createElement('div');
      row.className = 'pa-list-row';
      row.appendChild(this.mkThumb(it.frame));
      const nm = document.createElement('span');
      nm.className = 'nm';
      nm.textContent = it.name;
      row.appendChild(nm);
      const edit = document.createElement('button');
      edit.className = 'pa-b';
      edit.textContent = 'Edit';
      edit.onclick = () => {
        void this.setMenu(null);
        this.charEditorReturn = 'assets';
        this.charEditor.editEntity(it.kind, it.id);
      };
      row.appendChild(edit);
      if (it.kind === 'agent') {
        const copy = document.createElement('button');
        copy.className = 'pa-b';
        copy.textContent = 'Copy';
        copy.onclick = () => {
          const tpl = (getCharacterTemplates() ?? []).find((c) => c.id === it.id);
          if (!tpl) return;
          const id = this.nextCharId((getCharacterTemplates() ?? []).map((c) => c.id));
          this.room?.send('saveAsset', { assetType: 'character', name: id, data: tpl.data });
          window.setTimeout(() => this.renderAssetsPanel(), 250);
        };
        row.appendChild(copy);
      }
      {
        const isUser = it.kind === 'agent' && !this.bundledSkinIds.has(it.id);
        const del = document.createElement('button');
        del.className = 'pa-b' + (isUser ? ' danger' : '');
        del.textContent = isUser ? 'Delete' : 'Reset';
        del.title = isUser ? 'Delete this custom skin' : 'Revert to the bundled default';
        del.onclick = async () => {
          if (!(await confirmDialog(`${isUser ? 'Delete' : 'Reset'} “${it.name}”?`, { danger: isUser, confirmLabel: isUser ? 'Delete' : 'Reset' })))
            return;
          this.room?.send('deleteAsset', { assetType: it.kind === 'npc' ? 'pet' : 'character', name: it.id });
          window.setTimeout(() => this.renderAssetsPanel(), 250);
        };
        row.appendChild(del);
      }
      body.appendChild(row);
    }
  }

  private renderFurnAssets(body: HTMLElement): void {
    const add = document.createElement('button');
    add.className = 'pa-b primary wide';
    add.textContent = '＋ New furniture';
    add.onclick = () => {
      void this.setMenu(null);
      this.furnEditor.newItem();
    };
    body.appendChild(add);

    for (const cat of getActiveCategories()) {
      const entries = getCatalogByCategory(cat.id);
      if (!entries.length) continue;
      const head = document.createElement('div');
      head.className = 'grouplbl';
      head.textContent = cat.label;
      body.appendChild(head);
      for (const e of entries) {
        const row = document.createElement('div');
        row.className = 'pa-list-row';
        row.appendChild(this.mkThumb(e.sprite));
        const nm = document.createElement('span');
        nm.className = 'nm';
        nm.textContent = e.label;
        row.appendChild(nm);
        const edit = document.createElement('button');
        edit.className = 'pa-b';
        edit.textContent = 'Edit';
        edit.onclick = () => {
          void this.setMenu(null);
          this.furnEditor.edit(e.type);
        };
        const reset = document.createElement('button');
        reset.className = 'pa-b';
        reset.textContent = 'Reset';
        reset.title = 'Revert to the bundled default (or delete a custom item)';
        reset.onclick = async () => {
          if (!(await confirmDialog(`Reset ${e.type}?`, { danger: true, confirmLabel: 'Reset' }))) return;
          this.room?.send('deleteAsset', { assetType: 'furniture', name: e.type });
          window.setTimeout(() => this.renderAssetsPanel(), 250);
        };
        row.append(edit, reset);
        body.appendChild(row);
      }
    }
  }

  /** A small pixel-art thumbnail (a single sprite frame drawn 1:1, CSS-scaled). */
  private mkThumb(sprite?: SpriteData): HTMLElement {
    const wrap = document.createElement('div');
    wrap.className = 'pa-thumb';
    const cv = document.createElement('canvas');
    const h = sprite?.length ?? 0;
    const w = h > 0 ? (sprite![0]?.length ?? 0) : 0;
    cv.width = Math.max(1, w);
    cv.height = Math.max(1, h);
    const ctx = cv.getContext('2d');
    if (ctx && sprite) {
      for (let y = 0; y < h; y++) {
        const rowPx = sprite[y];
        for (let x = 0; x < rowPx.length; x++) {
          const c = rowPx[x];
          if (!c) continue;
          ctx.fillStyle = c;
          ctx.fillRect(x, y, 1, 1);
        }
      }
    }
    wrap.appendChild(cv);
    return wrap;
  }

  /** Refresh the top-bar Zone button label (and its open travel list) from the
   *  live registry. */
  private renderZoneSwitcher(): void {
    const cur = currentZone();
    const label = this.zoneList.find((z) => z.id === cur)?.label ?? cur;
    if (this.zoneLabelEl) this.zoneLabelEl.textContent = label;
    if (this.currentMenu === 'zone') this.renderZoneList();
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
    // Travelling is open to all. Creating a zone is open to any signed-in user
    // (they own what they create — see zoneStore.ts); granting zone admins is
    // that zone's owner's call (plus global admins, everywhere). Editing a zone
    // (layout/rename/NPCs/arrival) is open to that zone's admin too — but the
    // client only knows its OWN zone-admin status for the CURRENT zone, so
    // per-row edit beyond the current zone needs global admin. (open dev mode
    // without accounts → everyone edits.)
    const assetsAdmin = this.assetsAdmin;
    const canCreateZone = assetsAdmin || !!this.myUserId;

    const rows = this.zoneList
      .map((z) => {
        const here = z.id === cur;
        const rowEdit = assetsAdmin || (here && this.myZoneAdmin);
        const rowDelete = assetsAdmin || (here && this.myZoneAdmin);
        const isOwner = !!this.myUserId && z.ownerId === this.myUserId;
        const tag = here ? '<span class="here">● here</span>' : `<button data-go="${esc(z.id)}">Go</button>`;
        const lock = z.readOnly ? ' 🔒' : z.private ? ' 🔐' : '';
        const npcN = z.npc == null ? 'all' : String(z.npc.length);
        let ctrls = '';
        if (rowEdit)
          ctrls += `<button data-npc="${esc(z.id)}" title="NPCs in this zone">🐾</button><button data-edit="${esc(z.id)}">✎</button>`;
        if (rowDelete && !z.readOnly) ctrls += `<button data-del="${esc(z.id)}">✕</button>`;
        if (assetsAdmin || isOwner) ctrls += `<button data-admins="${esc(z.id)}" title="Zone admins">👤</button>`;
        if (isOwner) ctrls += `<button data-settings="${esc(z.id)}" title="Privacy &amp; access">⚙</button>`;
        // Global-admin quick action for an ownerless zone (predates ownership,
        // or lost its owner when that account was deleted) — no need to leave
        // the game for the admin site just to claim it.
        if (assetsAdmin && !z.ownerId) ctrls += `<button data-take="${esc(z.id)}" title="Take ownership">👑</button>`;
        return `<div class="item"><span class="nm ${here ? 'here' : ''}">${esc(z.label)}${lock}<br><small>${esc(z.id)} · 🐾${npcN}</small></span>${tag}${ctrls}</div>`;
      })
      .join('');

    const footParts: string[] = [];
    if (this.zoneEditAdmin) footParts.push(`<button data-arrive>📍 Set arrival point (this zone)</button>`);
    if (canCreateZone) footParts.push(`<button data-new class="new">＋ Create zone</button>`);
    const foot = footParts.length ? `<div class="foot">${footParts.join('')}</div>` : '';
    // "You are" line — who you're signed in as, and whether that's a global
    // admin (relevant here: admins bypass privacy/passwords and can take
    // ownership of any ownerless zone).
    const meLabel = this.myUserId
      ? `${this.isAdmin ? '★ ' : ''}${esc(this.viewerUsername || this.myUserId)}${this.isAdmin ? ' (admin)' : ''}`
      : 'anonymous viewer';
    const meLine = `<div class="who-am-i muted">You: ${meLabel}</div>`;
    this.zonesPanel.innerHTML = `${meLine}${rows}${foot}`;

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
    // Grant/revoke a per-zone admin (global admin only): a proper list + add,
    // not a blind login-id prompt.
    this.zonesPanel.querySelectorAll<HTMLButtonElement>('[data-admins]').forEach((b) => {
      b.onclick = () => this.openZoneAdminsDialog(b.dataset.admins!);
    });
    // Owner-only: privacy + access list + real-time invite for a zone they own.
    this.zonesPanel.querySelectorAll<HTMLButtonElement>('[data-settings]').forEach((b) => {
      b.onclick = () => {
        const z = this.zoneList.find((x) => x.id === b.dataset.settings);
        if (z) this.openZoneSettingsDialog(z);
      };
    });
    // Global-admin quick action: claim an ownerless zone as its owner.
    this.zonesPanel.querySelectorAll<HTMLButtonElement>('[data-take]').forEach((b) => {
      b.onclick = () => {
        if (this.myUserId) send('zoneSetOwner', { id: b.dataset.take, ownerId: this.myUserId });
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
    if (newBtn) newBtn.onclick = () => this.openCreateZoneDialog();
  }

  /** "+ Create zone" — a proper dialog (matching Rename's promptDialog), not
   *  inputs embedded in the popover: keeps focus/keyboard handling simple and
   *  gives room for the size fields too. */
  private openCreateZoneDialog(): void {
    const body = document.createElement('div');
    body.innerHTML = `
      <div class="fld"><label>Zone name</label>
        <input class="pa-input" type="text" maxlength="32" placeholder="e.g. Design Team">
      </div>
      <div class="fld"><label>Size (tiles)</label>
        <div style="display:flex;gap:.5rem;align-items:center;">
          <input class="pa-input" type="number" min="6" max="64" value="20" title="Width" style="flex:1;min-width:0;">
          <span class="muted">×</span>
          <input class="pa-input" type="number" min="6" max="64" value="14" title="Height" style="flex:1;min-width:0;">
        </div>
      </div>`;
    const nameIn = body.querySelector<HTMLInputElement>('input[type=text]')!;
    const [colsIn, rowsIn] = body.querySelectorAll<HTMLInputElement>('input[type=number]');
    openPaDialog({
      title: 'Create a zone',
      body,
      buttons: [
        {
          label: 'Create',
          kind: 'primary',
          onClick: () => {
            const label = cleanName(nameIn.value);
            if (!label) {
              nameIn.focus();
              return false;
            }
            this.room?.send('createZone', { label, cols: Number(colsIn.value), rows: Number(rowsIn.value) });
          },
        },
      ],
    });
    setTimeout(() => nameIn.focus(), 0);
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

  /** A zone was just created (by this viewer) → offer to jump straight to it, or
   *  show why it wasn't (invalid name, or the per-owner zone cap was hit). */
  private async onZoneCreated(m: Record<string, unknown>): Promise<void> {
    if (typeof m.error === 'string') {
      void alertDialog(`Could not create the zone: ${m.error}.`);
      return;
    }
    const id = typeof m.id === 'string' ? m.id : '';
    if (!isZoneId(id)) return;
    if (await confirmDialog(`Zone created. Go there now?`, { confirmLabel: 'Go' })) this.goToZone(id);
  }

  /** Zone owner: open "Zone settings" — privacy toggle, who-has-access (owner +
   *  zone-admins + ACL together), and inviting someone in right now. Fetches
   *  the member list + the user directory (for autocomplete) in parallel;
   *  onZoneMembers actually builds the dialog once the members arrive. */
  private openZoneSettingsDialog(zone: ZoneConfig): void {
    this.pendingZoneSettings = zone;
    this.room?.send('zoneMembers', { id: zone.id });
    this.room?.send('requestUserList');
  }

  private static readonly USER_LIST_ID = 'pa-user-list';

  private toAutocompleteUsers(): AutocompleteUser[] {
    return (this.userListCache ?? []).map((u) => ({ userId: u.userId, label: u.name, isAdmin: u.isAdmin }));
  }

  /** Rebuild the shared datalist for `query` (see shared/userAutocomplete.ts). */
  private filterUserDatalist(query: string): void {
    filterSharedUserDatalist(OfficeScene.USER_LIST_ID, this.toAutocompleteUsers(), query);
  }

  /** Wire a login-id input to the shared user autocomplete: filters as you
   *  type instead of relying on the browser to filter a giant static list. */
  private wireUserAutocomplete(input: HTMLInputElement): void {
    wireSharedUserAutocomplete(input, OfficeScene.USER_LIST_ID, () => this.toAutocompleteUsers());
  }

  /** The server's answer to requestUserList — caches the full list (used by
   *  filterUserDatalist) and refreshes the datalist for whichever input (if
   *  any) is currently focused, even while a dialog is already open. */
  private onUserList(m: Record<string, unknown>): void {
    if (!Array.isArray(m.users)) return;
    this.userListCache = m.users as Array<{ userId: string; name: string; isAdmin: boolean }>;
    const active = document.activeElement;
    this.filterUserDatalist(active instanceof HTMLInputElement && active.list?.id === OfficeScene.USER_LIST_ID ? active.value : '');
  }

  /** Owner (of this zone) or global admin: open "Zone admins" — who may edit
   *  this zone's layout. REST-backed (not a room message) via the shared
   *  widget — same route the admin website's Zones tab uses, guarded
   *  server-side by the same rule (see shared/zoneAdminsWidget.ts,
   *  adminApi.ts's zoneGrantAdminAuth). No zoneMembers round trip needed to
   *  open it, so there's no dialog-routing state to keep in sync here. */
  private openZoneAdminsDialog(zoneId: string): void {
    const label = this.zoneList.find((z) => z.id === zoneId)?.label ?? zoneId;
    this.room?.send('requestUserList');

    const body = document.createElement('div');
    body.innerHTML = `
      <div class="fld"><label>Zone admins may edit this zone's layout</label>
        <div data-admins-widget></div>
        <div data-admins-msg style="min-height:1.1rem;margin-top:.35rem;font-size:.85rem;"></div>
      </div>`;
    const widgetEl = body.querySelector<HTMLDivElement>('[data-admins-widget]')!;
    const msgEl = body.querySelector<HTMLDivElement>('[data-admins-msg]')!;
    renderZoneAdminsWidget(widgetEl, zoneId, {
      wireAutocomplete: (input) => this.wireUserAutocomplete(input),
      onError: (action, error) => {
        msgEl.textContent = `${action} failed${error ? `: ${error}` : ''}.`;
        msgEl.style.color = '#f0a6a2';
      },
      classNames: { revokeButton: 'pa-b', grantButton: 'pa-b primary' },
    });

    openPaDialog({ title: `Zone admins — ${label}`, body, buttons: [] });
  }

  /** The server's answer to zoneMembers — also arrives after zoneAclAdd/Remove,
   *  so this both opens a dialog the first time and refreshes it in place
   *  afterwards. (Zone-admins grant/revoke no longer goes through here — see
   *  openZoneAdminsDialog.) */
  private onZoneMembers(m: Record<string, unknown>): void {
    const id = typeof m.id === 'string' ? m.id : '';
    const zone = (this.pendingZoneSettings?.id === id ? this.pendingZoneSettings : this.zoneList.find((z) => z.id === id)) ?? null;
    this.pendingZoneSettings = null;
    if (!zone) return;
    type Member = { userId: string; name: string; isAdmin: boolean };
    const owner = (m.owner ?? null) as Member | null;
    const admins = Array.isArray(m.admins) ? (m.admins as Member[]) : [];
    const acl = Array.isArray(m.acl) ? (m.acl as Member[]) : [];
    this.filterUserDatalist('');

    const body = document.createElement('div');
    body.innerHTML = `
      <div class="fld"><label>Privacy</label>
        <div style="display:flex;align-items:center;gap:.6rem;">
          <button type="button" class="pa-b" data-priv></button>
          <span class="muted" data-priv-hint style="font-size:.82rem;"></span>
        </div>
      </div>
      <div class="fld"><label>Who has access</label>
        <div data-members style="max-height:11rem;overflow-y:auto;display:flex;flex-direction:column;gap:.35rem;"></div>
        <div style="display:flex;gap:.35rem;margin-top:.5rem;">
          <input class="pa-input" data-acl-add placeholder="login id" maxlength="32" style="flex:1;min-width:0;">
          <button type="button" class="pa-b" data-acl-add-btn>Add to access list</button>
        </div>
      </div>
      <div class="fld"><label>Invite someone now</label>
        <div style="display:flex;gap:.35rem;">
          <input class="pa-input" data-invite placeholder="login id" maxlength="32" style="flex:1;min-width:0;">
          <button type="button" class="pa-b primary" data-invite-btn>Invite</button>
        </div>
        <div data-invite-msg style="min-height:1.1rem;margin-top:.35rem;font-size:.85rem;"></div>
      </div>
      <div class="fld"><label>Entry password</label>
        <div data-password-widget></div>
        <div data-password-msg style="min-height:1.1rem;margin-top:.35rem;font-size:.85rem;"></div>
      </div>`;

    const membersEl = body.querySelector<HTMLDivElement>('[data-members]')!;
    if (!owner && !admins.length && !acl.length) {
      membersEl.innerHTML = '<div class="muted" style="font-size:.85rem;">No one has special access yet.</div>';
    }
    const memberRow = (m2: Member, sub: string, onRemove?: () => void): void => {
      const row = document.createElement('div');
      row.style.cssText = 'display:flex;align-items:center;gap:.5rem;';
      const nm = document.createElement('span');
      nm.style.flex = '1';
      nm.style.fontSize = '.85rem';
      nm.innerHTML = `${m2.isAdmin ? '★ ' : ''}${esc(m2.name)} <span class="muted" style="font-size:.76rem;">${esc(sub)}</span>`;
      row.appendChild(nm);
      if (onRemove) {
        const rm = document.createElement('button');
        rm.type = 'button';
        rm.className = 'pa-b';
        rm.textContent = 'Remove';
        rm.onclick = onRemove;
        row.appendChild(rm);
      }
      membersEl.appendChild(row);
    };
    if (owner) memberRow(owner, '👑 owner');
    for (const a of admins) memberRow(a, '🛠 zone-admin (edits the layout)');
    for (const a of acl) memberRow(a, '✓ access list', () => this.room?.send('zoneAclRemove', { id: zone.id, userId: a.userId }));

    // Optimistic local toggle — no need to wait on the server round trip for
    // something this simple (it still persists via zoneSetPrivate below).
    let priv = !!zone.private;
    const privBtn = body.querySelector<HTMLButtonElement>('[data-priv]')!;
    const privHint = body.querySelector<HTMLSpanElement>('[data-priv-hint]')!;
    const renderPriv = (): void => {
      privBtn.textContent = priv ? '🔐 Private' : '🔓 Public';
      privBtn.classList.toggle('primary', priv);
      privHint.textContent = priv
        ? 'Only the access list above (plus the owner, zone-admins and global admins) may enter.'
        : 'Anyone can enter.';
    };
    renderPriv();
    privBtn.onclick = () => {
      priv = !priv;
      renderPriv();
      this.room?.send('zoneSetPrivate', { id: zone.id, private: priv });
    };

    const addIn = body.querySelector<HTMLInputElement>('[data-acl-add]')!;
    this.wireUserAutocomplete(addIn);
    body.querySelector<HTMLButtonElement>('[data-acl-add-btn]')!.onclick = () => {
      const uid = cleanName(addIn.value);
      if (uid) this.room?.send('zoneAclAdd', { id: zone.id, userId: uid });
    };

    const inviteIn = body.querySelector<HTMLInputElement>('[data-invite]')!;
    this.wireUserAutocomplete(inviteIn);
    const inviteMsg = body.querySelector<HTMLDivElement>('[data-invite-msg]')!;
    body.querySelector<HTMLButtonElement>('[data-invite-btn]')!.onclick = () => {
      const uid = cleanName(inviteIn.value);
      if (!uid) return;
      this.room?.send('zoneInvite', { id: zone.id, userId: uid });
      inviteMsg.textContent = `Inviting ${uid}…`;
      inviteMsg.style.color = '';
    };

    // Entry password — owner's call too (see server's zoneCapabilityAuth),
    // REST-backed via the shared widget (same routes the admin website's
    // Zones tab uses; see shared/zonePasswordWidget.ts).
    const passwordEl = body.querySelector<HTMLDivElement>('[data-password-widget]')!;
    const passwordMsgEl = body.querySelector<HTMLDivElement>('[data-password-msg]')!;
    renderZonePasswordWidget(passwordEl, zone.id, !!zone.locked, {
      onError: (action, error) => {
        passwordMsgEl.textContent = `${action} failed${error ? `: ${error}` : ''}.`;
        passwordMsgEl.style.color = '#f0a6a2';
      },
      classNames: { button: 'pa-b', primaryButton: 'pa-b primary', dangerButton: 'pa-b danger' },
    });

    openPaDialog({ title: `Zone settings — ${zone.label}`, body, buttons: [] });
  }

  /** Feedback for the owner's zoneInvite — shown in the still-open settings
   *  dialog's invite area, if it's still up. */
  private onZoneInviteSent(m: Record<string, unknown>): void {
    const msgEl = document.querySelector<HTMLDivElement>('#pa-dialog-back [data-invite-msg]');
    if (!msgEl) return;
    if (typeof m.error === 'string') {
      msgEl.textContent = m.error === 'not online' ? 'That user is not online right now.' : `Could not invite: ${m.error}.`;
      msgEl.style.color = '#f0a6a2';
    } else {
      msgEl.textContent = `Invite sent to ${String(m.targetUserId ?? '')}.`;
      msgEl.style.color = '#7fbf6a';
    }
  }

  /** Someone invited us into their (possibly private) zone — must accept before
   *  anything happens (no silent pulls). */
  private onZoneInvitePrompt(m: Record<string, unknown>): void {
    const zoneId = typeof m.zoneId === 'string' ? m.zoneId : '';
    if (!isZoneId(zoneId)) return;
    const zoneLabel = typeof m.zoneLabel === 'string' ? m.zoneLabel : zoneId;
    const fromName = typeof m.fromName === 'string' ? m.fromName : 'Someone';
    void (async () => {
      const accept = await confirmDialog(`${fromName} invites you into their zone “${zoneLabel}”. Join now?`, {
        confirmLabel: 'Join',
      });
      this.room?.send('zoneInviteRespond', { zoneId, accept });
    })();
  }

  /** We accepted an invite — the server added us to the ACL; travel there. */
  private onZoneInviteAccepted(m: Record<string, unknown>): void {
    const zoneId = typeof m.zoneId === 'string' ? m.zoneId : '';
    if (isZoneId(zoneId)) this.goToZone(zoneId);
  }

  /** Tell the inviter what happened to their invite, wherever they are now — a
   *  passive system line rather than another dialog (they may be mid-something
   *  else entirely). */
  private onZoneInviteResult(m: Record<string, unknown>): void {
    const byName = typeof m.byName === 'string' ? m.byName : 'They';
    const zoneLabel = typeof m.zoneLabel === 'string' ? m.zoneLabel : 'your zone';
    const accepted = !!m.accepted;
    this.chat?.addSystemLine(`${byName} ${accepted ? `joined “${zoneLabel}”.` : `declined your invite to “${zoneLabel}”.`}`);
  }

  // ── Conference monitors (C-RTC) ──────────────────────────────────

  /** Join (or leave, if already in it) a conference monitor by its anchor tile. */
  private async toggleConference(anchor: { col: number; row: number; name?: string }): Promise<void> {
    const key = `${anchor.col},${anchor.row}`;
    if (this.myConference && `${this.myConference.col},${this.myConference.row}` === key) {
      this.room?.send('meetingRoomLeave', { col: anchor.col, row: anchor.row });
      this.leaveConferenceLocal();
      return;
    }
    // Confirm before joining (it turns your camera/mic on).
    const label = conferenceLabel(anchor.name, anchor.col, anchor.row);
    if (!(await confirmDialog(`Join the conference “${label}”?`, { confirmLabel: 'Join' }))) return;
    // Walk to the monitor first; the server joins us on arrival (→ meetingRoomMembers),
    // then we connect the media. Leave any current call (conference or meeting area —
    // they share the one ConferenceUI window/stage).
    if (this.myConference) {
      this.room?.send('meetingRoomLeave', this.myConference);
      this.leaveConferenceLocal();
    }
    if (this.myMeetingArea) this.leaveMeetingAreaLocal();
    this.pendingConference = { ...anchor };
    this.room?.send('actionApproach', { col: anchor.col, row: anchor.row });
  }

  /** Tear down the local call (disconnect LiveKit) and clear our membership. */
  private leaveConferenceLocal(): void {
    this.myConference = null;
    this.pendingConference = null;
    void this.conf?.disconnect();
    this.conf = undefined;
    this.confUI.close();
    // Back out of the meeting → rejoin zone voice if the user had it on.
    this.zoneVoice?.voice.resume('conference');
    this.mumble?.voice?.resume('conference');
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
      this.room?.send('meetingRoomToken', { ...this.myConference, source: 'furniture' }); // → media
    }
    // If the server dropped us from our call (despawn, zone change, …), tear down.
    if (this.myConference && `${this.myConference.col},${this.myConference.row}` === key && !iAmIn) {
      this.leaveConferenceLocal();
    }
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
    const c = this.myConference;
    if (!c || `${c.col},${c.row}` !== `${m.col},${m.row}`) return;
    const title = conferenceLabel(c.name, c.col, c.row);
    if (m.error === 'not-configured' || typeof m.url !== 'string' || typeof m.token !== 'string') {
      this.confUI.open(title, this.conferenceHandlers());
      this.confUI.setState({ connected: false, camOn: true, micOn: true, screenOn: false, error: 'Video not configured on the server.' });
      return;
    }
    // Open the window first (it owns the stage element the tiles render into),
    // then connect the media into it.
    this.confUI.open(title, this.conferenceHandlers());
    this.conf = new LiveKitConference(this.confUI.stage, this.confUI.stage, {
      onState: (s) => this.confUI.setState(s),
      onDevices: (d) => this.confUI.setDevices(d),
      onChat: (msg) => this.confUI.addChat(msg),
      onParticipants: (list) => this.confUI.setParticipants(list),
      onNotice: (text) => this.confUI.notice(text),
      onReaction: (reaction, from) => this.confUI.playReaction(reaction, from),
      onVideoFilter: (id) => this.confUI.setVideoFilter(id),
    });
    // You can't be in two voice calls at once — pause zone voice while in the
    // meeting (resumed in leaveConferenceLocal).
    this.zoneVoice?.voice.suspend('conference');
    this.mumble?.voice?.suspend('conference');
    void this.conf.connect(m.url as string, m.token as string, { video: m.video !== false }).catch(() => {
      /* connect() reports via the state callback */
    });
  }

  /** Control-bar handlers for the conference window (delegate to the live conf). */
  private conferenceHandlers(): import('../conference/ConferenceUI.js').ConferenceUIHandlers {
    return {
      toggleMic: () => void this.conf?.toggleMic(),
      toggleCam: () => void this.conf?.toggleCam(),
      toggleScreen: () => void this.conf?.toggleScreen(),
      switchCamera: (id) => void this.conf?.switchCamera(id),
      switchMic: (id) => void this.conf?.switchMic(id),
      switchSpeaker: (id) => void this.conf?.switchSpeaker(id),
      setVolume: (identity, v) => this.conf?.setParticipantVolume(identity, v),
      setMuted: (identity, muted) => this.conf?.setParticipantMuted(identity, muted),
      muteForAll: (identity) => this.conf?.requestMute(identity),
      sendChat: (text) => this.conf?.sendChat(text),
      sendReaction: (id) => this.conf?.sendReaction(id),
      setVideoFilter: (id) => void this.conf?.setVideoFilter(id),
      leave: () => {
        if (this.myConference) void this.toggleConference(this.myConference);
      },
    };
  }

  // ── Meeting areas (walk-in, automatic membership) ────────────────

  /** Server broadcast: current tile-membership of a meeting area (by its
   *  anchor "col,row" key). Drives auto-connect entirely — no explicit join
   *  message; walking onto the tile *is* membership, and the first time it
   *  appears for a key we weren't already in, that's the entry transition
   *  that starts the call. A later broadcast for the SAME key (someone else
   *  joining/leaving) does not re-trigger it. */
  private onMeetingAreaMembers(m: Record<string, unknown>): void {
    const key = `${m.col},${m.row}`;
    const members = (m.members as Array<{ id: number; name: string }>) ?? [];
    const iAmIn = this.myPlayerId !== null && members.some((p) => p.id === this.myPlayerId);
    if (iAmIn) {
      const entering = this.myMeetingAreaKey !== key;
      this.myMeetingAreaKey = key;
      if (entering) this.joinMeetingAreaVideo({ col: m.col as number, row: m.row as number });
    } else if (this.myMeetingAreaKey === key) {
      this.myMeetingAreaKey = null;
    }
    // If the server dropped us from our own call's area (walked out, despawn, …), tear down.
    if (this.myMeetingArea && `${this.myMeetingArea.col},${this.myMeetingArea.row}` === key && !iAmIn) {
      this.leaveMeetingAreaLocal();
    }
  }

  /** Auto-join on entering a meeting area's tile (mirrors WorkAdventure's
   *  proximity bubble — no explicit "Join" click): request a token for this
   *  area's own LiveKit room and open the small ambient popup. */
  private joinMeetingAreaVideo(anchor: { col: number; row: number }): void {
    if (this.myMeetingArea && `${this.myMeetingArea.col},${this.myMeetingArea.row}` === `${anchor.col},${anchor.row}`) return;
    if (this.myConference) {
      this.room?.send('meetingRoomLeave', this.myConference);
      this.leaveConferenceLocal();
    }
    this.myMeetingArea = { ...anchor };
    this.meetingAreaExpanded = false;
    this.meetingArea?.setVisible(true);
    this.meetingArea?.setHandlers(this.meetingAreaMiniHandlers());
    this.room?.send('meetingRoomToken', { ...anchor, source: 'tile' });
  }

  /** Tear down the local call (disconnect LiveKit) and clear our membership.
   *  Leaving the CALL is independent of tile membership (myMeetingAreaKey):
   *  you can hang up and keep standing in the area without being re-joined
   *  until you actually walk out and back in. */
  private leaveMeetingAreaLocal(): void {
    this.myMeetingArea = null;
    this.meetingAreaExpanded = false;
    void this.meetingConf?.disconnect();
    this.meetingConf = undefined;
    this.confUI.close();
    this.meetingArea?.setVisible(false);
    this.meetingArea?.setHandlers(null);
    this.zoneVoice?.voice.resume('meetingArea');
    this.mumble?.voice?.resume('meetingArea');
  }

  /** Retarget the live call from the small ambient popup into the full
   *  monitor-style window (device setup, chat, big screen-share spotlight) —
   *  same LiveKitConference instance, no reconnect. Also triggered
   *  automatically the moment someone starts sharing their screen (it should
   *  show big immediately, not cramped into the mini view). */
  private expandMeetingArea(): void {
    if (!this.meetingConf || !this.myMeetingArea || this.meetingAreaExpanded) return;
    this.meetingAreaExpanded = true;
    this.meetingConf.retarget(this.confUI.stage, this.confUI.stage);
    this.meetingArea?.setVisible(false);
    this.confUI.open('Meeting area', this.meetingAreaFullHandlers());
  }

  /** Retarget the live call back to the small ambient popup, without hanging
   *  up — the reverse of expandMeetingArea. */
  private minimizeMeetingArea(): void {
    if (!this.meetingConf || !this.myMeetingArea || !this.meetingAreaExpanded) return;
    this.meetingAreaExpanded = false;
    this.meetingConf.retarget(this.meetingArea!.stage, this.meetingArea!.screens);
    this.confUI.close();
    this.meetingArea?.setVisible(true);
  }

  /** Server minted a LiveKit token (or reported it's unconfigured) for our
   *  meeting area's call. State/devices/participants/chat are always
   *  forwarded to the full window too (even hidden behind the mini popup)
   *  so it's already current the moment expandMeetingArea opens it. */
  private onMeetingAreaToken(m: Record<string, unknown>): void {
    const c = this.myMeetingArea;
    if (!c || `${c.col},${c.row}` !== `${m.col},${m.row}`) return;
    if (m.error === 'not-configured' || typeof m.url !== 'string' || typeof m.token !== 'string') {
      this.meetingArea?.setState({ connected: false, micOn: true, camOn: true, error: 'Video not configured on the server.' });
      return;
    }
    this.meetingConf = new LiveKitConference(this.meetingArea!.stage, this.meetingArea!.screens, {
      onState: (s) => {
        this.meetingArea?.setState(s);
        this.confUI.setState(s);
      },
      onDevices: (d) => {
        this.meetingArea?.setDevices(d);
        this.confUI.setDevices(d);
      },
      onChat: (msg) => this.confUI.addChat(msg),
      onParticipants: (list) => this.confUI.setParticipants(list),
      onNotice: (text) => this.confUI.notice(text),
      onReaction: (reaction, from) => this.confUI.playReaction(reaction, from),
      onVideoFilter: (id) => this.confUI.setVideoFilter(id),
      onScreens: (n) => {
        // The mini popup has no room for a screen share (meetingArea's own
        // screens container stays hidden) — expand into the full window,
        // whose own focus-mode grid takes it from there.
        if (n > 0 && !this.meetingAreaExpanded) this.expandMeetingArea();
      },
    });
    // You can't be in two voice calls at once — pause zone voice while in the
    // meeting (resumed in leaveMeetingAreaLocal).
    this.zoneVoice?.voice.suspend('meetingArea');
    this.mumble?.voice?.suspend('meetingArea');
    void this.meetingConf.connect(m.url as string, m.token as string, { video: m.video !== false }).catch(() => {
      /* connect() reports via the state callback */
    });
  }

  /** Mini-popup handlers (mic/cam toggle, expand, leave) while the call
   *  renders into MeetingAreaUI's own small stage. */
  private meetingAreaMiniHandlers(): import('../ui/meetingArea.js').MeetingAreaHandlers {
    return {
      toggleMic: () => void this.meetingConf?.toggleMic(),
      toggleCam: () => void this.meetingConf?.toggleCam(),
      switchCamera: (id) => void this.meetingConf?.switchCamera(id),
      switchMic: (id) => void this.meetingConf?.switchMic(id),
      switchSpeaker: (id) => void this.meetingConf?.switchSpeaker(id),
      expand: () => this.expandMeetingArea(),
      leave: () => this.leaveMeetingAreaLocal(),
    };
  }

  /** Full-window handlers for the meeting-area call, once expanded — same
   *  shape as conferenceHandlers() plus minimize (shrink back to the mini
   *  popup instead of hanging up). */
  private meetingAreaFullHandlers(): import('../conference/ConferenceUI.js').ConferenceUIHandlers {
    return {
      toggleMic: () => void this.meetingConf?.toggleMic(),
      toggleCam: () => void this.meetingConf?.toggleCam(),
      toggleScreen: () => void this.meetingConf?.toggleScreen(),
      switchCamera: (id) => void this.meetingConf?.switchCamera(id),
      switchMic: (id) => void this.meetingConf?.switchMic(id),
      switchSpeaker: (id) => void this.meetingConf?.switchSpeaker(id),
      setVolume: (identity, v) => this.meetingConf?.setParticipantVolume(identity, v),
      setMuted: (identity, muted) => this.meetingConf?.setParticipantMuted(identity, muted),
      muteForAll: (identity) => this.meetingConf?.requestMute(identity),
      sendChat: (text) => this.meetingConf?.sendChat(text),
      sendReaction: (id) => this.meetingConf?.sendReaction(id),
      setVideoFilter: (id) => void this.meetingConf?.setVideoFilter(id),
      leave: () => this.leaveMeetingAreaLocal(),
      minimize: () => this.minimizeMeetingArea(),
    };
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
      'position:fixed;left:50%;top:50%;transform:translate(-50%,-50%);z-index:85;background:#1c1a19;' +
      'border:2px solid #0a0908;border-radius:0.6rem;padding:1rem;color:#f1efec;min-width:14rem;max-height:70vh;' +
      "overflow:auto;font:1rem 'FS Pixel Sans',monospace;box-shadow:inset 0 2px 0 #292725,inset 0 -3px 0 #030303,0 12px 28px rgba(0,0,0,.55);";

    const send = (): void => {
      const keys = roster.map((r) => r.key).filter((k) => enabled.has(k));
      const npc = keys.length === roster.length ? null : keys; // all → null (future-proof)
      this.room?.send('setZoneNpc', { id, npc });
    };

    const head = document.createElement('div');
    head.textContent = `🐾 NPCs — ${zone.label}`;
    head.style.cssText = 'font-size:1.15rem;margin-bottom:0.6rem;color:#f5f3f0;';
    el.appendChild(head);

    if (!roster.length) {
      const none = document.createElement('div');
      none.textContent = 'No NPC variants loaded.';
      none.style.cssText = 'color:#adb0b2;margin-bottom:0.6rem;';
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
        'flex:1;padding:0.4rem;cursor:pointer;background:#262422;border:2px solid #0a0908;border-radius:0.35rem;' +
        "color:#f1efec;font:0.95rem 'FS Pixel Sans',monospace;box-shadow:inset 0 2px 0 #4a4744,inset 0 -3px 0 #050505;";
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
    this.cameraFollowEnabled = m.cameraFollow !== false;
    setSoundEnabled(this.soundOn);
    setAlertVolume(this.volume);
    this.syncSettingsInputs();
    if (!this.alwaysShowLabels) this.clearNameLabels();
  }

  private createSettingsPanel(): void {
    const style = document.createElement('style');
    style.textContent = `
      /* Settings reuses the shared .pa-panel shell; only its inner fields need styling. */
      #pa-settings .row{display:flex;align-items:center;gap:0.5rem;margin:0.65rem 0;font-size:1rem;}
      #pa-settings .row input[type=range]{flex:1;}
      #pa-settings .row label{flex:1;}
      #pa-settings .row input[type=text],#pa-settings .row input[type=password]{flex:1;min-width:0;background:#262422;color:#f1efec;
        border:2px solid #0a0908;border-radius:0.35rem;padding:0.3rem 0.45rem;font:0.95rem 'FS Pixel Sans',monospace;
        box-shadow:inset 0 2px 0 #4a4744,inset 0 -3px 0 #050505;}
      #pa-settings .hint{font-size:0.8rem;color:#818586;margin:-0.25rem 0 0.65rem;}
      #pa-char,#pa-pchar{display:flex;gap:0.4rem;flex-wrap:wrap;margin:0.3rem 0 0.65rem;}
      #pa-char canvas,#pa-pchar canvas{width:2rem;height:4rem;image-rendering:pixelated;background:#141312;
        border:2px solid #0a0908;border-radius:0.35rem;cursor:pointer;}
      #pa-char canvas.sel,#pa-pchar canvas.sel{border-color:#e2585a;}
      #pa-char .rnd,#pa-pchar .rnd{width:2rem;height:4rem;display:flex;align-items:center;justify-content:center;
        background:#141312;border:2px solid #0a0908;border-radius:0.35rem;cursor:pointer;font-size:1.1rem;}
      #pa-char .rnd.sel,#pa-pchar .rnd.sel{border-color:#e2585a;}
      #pa-avatar{display:flex;gap:0.6rem;align-items:center;margin:0.3rem 0 0.2rem;}
      #pa-avatar canvas{width:2rem;height:4rem;image-rendering:pixelated;background:#141312;
        border:2px solid #0a0908;border-radius:0.35rem;}
      #pa-avatar .pa-av-btns{display:flex;flex-direction:column;gap:0.35rem;flex:1;}
      #pa-avatar button,#pa-account button{background:#262422;border:2px solid #0a0908;color:#f1efec;
        border-radius:0.35rem;font:0.9rem 'FS Pixel Sans',monospace;padding:0.4rem;cursor:pointer;box-shadow:inset 0 2px 0 #4a4744,inset 0 -3px 0 #050505;}
      #pa-avatar button:disabled,#pa-account button:disabled{opacity:0.5;cursor:default;}
      /* Account buttons fill their row (single → full width; pair → split evenly). */
      #pa-account button{flex:1;}
      #pa-userinfo{font-size:0.85rem;color:#adb0b2;margin:-0.35rem 0 0.7rem;display:flex;
        align-items:center;gap:0.4rem;flex-wrap:wrap;}
      #pa-userinfo code{color:#d7d9da;background:#141312;border:2px solid #0a0908;border-radius:0.25rem;padding:0.05rem 0.3rem;}
      #pa-userinfo .admin{background:#c51a1b;border:2px solid #0a0908;color:#fff;border-radius:0.3rem;padding:0.05rem 0.4rem;
        box-shadow:inset 0 2px 0 #e2585a,inset 0 -3px 0 #5c0f10;}
      #pa-settings #pa-change-server{width:100%;margin-top:0.5rem;background:#292725;border:2px solid #0a0908;
        color:#ece9e4;border-radius:0.35rem;font:0.95rem 'FS Pixel Sans',monospace;padding:0.55rem;cursor:pointer;
        box-shadow:inset 0 2px 0 #4a4744,inset 0 -3px 0 #141210;}
    `;
    document.head.appendChild(style);

    const { panel, body } = this.mkPanel('Settings', 'right');
    panel.id = 'pa-settings';
    body.innerHTML = `
      <div id="pa-userinfo"></div>
      <div class="row"><label for="pa-name">Display name</label><input id="pa-name" type="text" maxlength="32" placeholder="(your login id)"></div>
      <div class="hint">Shown on your avatar. Empty = your login id.</div>
      <div id="pa-account">
        <div class="row"><label for="pa-pw">New password</label><input id="pa-pw" type="password" maxlength="64" placeholder="min 6 chars" autocomplete="new-password"></div>
        <div class="row"><button id="pa-pw-set">Change password</button></div>
        <div id="pa-agent-token">
          <div class="row"><label for="pa-token">Agent token</label><input id="pa-token" type="text" readonly></div>
          <div class="row"><button id="pa-token-copy">Copy</button><button id="pa-token-new">Regenerate</button></div>
          <div class="hint">Your agents authenticate with this token (<code>--token</code>); keep it secret.</div>
        </div>
      </div>
      <div class="row"><label>Your avatar</label></div>
      <div id="pa-avatar">
        <canvas id="pa-avatar-pic"></canvas>
        <div class="pa-av-btns">
          <button id="pa-av-create">✨ Create</button>
          <button id="pa-av-edit">✏ Edit</button>
          <button id="pa-av-save">Save as template</button>
        </div>
      </div>
      <div class="hint">Your avatar is your own copy — editing or deleting a template never changes it.</div>
      <div class="row"><label>Start from a template</label></div>
      <div id="pa-pchar"></div>
      <div id="pa-agent-skin">
        <div class="row"><label>Agents' avatar</label></div>
        <div id="pa-char"></div>
        <div class="hint">Pick a skin to keep your agents' look consistent.</div>
      </div>
      <div class="row"><input id="pa-snd" type="checkbox"><label for="pa-snd">Sound notifications</label></div>
      <div class="row"><label for="pa-vol">Volume</label><input id="pa-vol" type="range" min="0" max="100"></div>
      <div class="row"><input id="pa-lbl" type="checkbox"><label for="pa-lbl">Always show labels</label></div>
      <div class="row"><input id="pa-camfollow" type="checkbox"><label for="pa-camfollow">Camera follows you</label></div>
      <button id="pa-change-server">Change server</button>`;
    // Settings is opened from the ☰ menu (no dedicated bar button).
    this.settingsPanel = panel;

    // Only one popover open at a time: a click outside the toolbar/panels closes
    // them. The editor (the "layout menu") is exempt — you edit via the canvas.
    window.addEventListener('pointerdown', (e) => {
      const t = e.target as Node | null;
      if (!t) return;
      // Clicks inside the bar, any grouped popover, an open asset editor, its
      // PNG-import panel, the zone-NPC editor, or an in-game dialog keep the menu.
      const panels = [
        this.audioPanel,
        this.mumblePanel,
        this.zonePanel,
        this.spacePanel,
        this.assetsPanel,
        this.morePanel,
        this.settingsPanel,
        this.helpPanel,
      ];
      const byId = ['pa-chars', 'pa-furn', 'pa-c-import', 'pa-modal', 'pa-znpc', 'pa-cc'];
      if (
        this.menubar?.contains(t) ||
        panels.some((p) => p?.contains(t)) ||
        byId.some((id) => document.getElementById(id)?.contains(t))
      )
        return;
      this.setMenu(null);
    });

    // "Your avatar" controls: edit the owned avatar, or snapshot it as a new
    // shared template.
    panel.querySelector<HTMLButtonElement>('#pa-av-create')!.onclick = () => {
      void this.setMenu(null);
      void this.charCreator.open();
    };
    panel.querySelector<HTMLButtonElement>('#pa-av-edit')!.onclick = () => {
      if (!this.myAvatarId) return;
      void this.setMenu(null);
      this.charEditorReturn = 'settings';
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
    const camFollow = panel.querySelector<HTMLInputElement>('#pa-camfollow')!;
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
    camFollow.onchange = () => {
      this.cameraFollowEnabled = camFollow.checked;
      // Re-engaging: drop any stale manual-pan detach so it recenters right away
      // instead of waiting for the next walk step.
      this.cameraFollowDetached = false;
      this.cameraDetachAt = null;
      this.room?.send('setCameraFollow', { enabled: this.cameraFollowEnabled });
    };
    // "Change server" is a desktop-only concern (the browser build's server is
    // its own origin, not user-configurable), so it is hidden in the browser.
    const changeServerBtn = panel.querySelector<HTMLButtonElement>('#pa-change-server')!;
    changeServerBtn.style.display = isDesktop() ? '' : 'none';
    changeServerBtn.onclick = () => void this.desktopChangeServer();

    // Mumble connection settings sit with the account controls. Desktop-only:
    // MumbleSettingsUI renders nothing in the browser.
    const account = panel.querySelector<HTMLElement>('#pa-account');
    if (account) {
      const mount = document.createElement('div');
      account.insertAdjacentElement('afterend', mount);
      new MumbleSettingsUI(mount, () => this.mumble?.settingsChanged());
    }

    this.syncSettingsInputs();
  }

  /** Desktop "Change server": forget the saved server URL (and the token, which
   *  is scoped to that server) then reload. With no saved URL the boot flow
   *  falls through to the Connection screen, then Sign-in — the same path a
   *  first launch takes. Best-effort revokes the current session first. */
  private async desktopChangeServer(): Promise<void> {
    if (
      !(await confirmDialog('Disconnect and connect to a different server? You will need to sign in again.', {
        confirmLabel: 'Change server',
      }))
    )
      return;
    try {
      const token = await desktop().getToken();
      if (token) {
        await fetch(`${serverHttpOrigin()}/desktop/signout`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}` },
          cache: 'no-store',
        });
      }
    } catch {
      // Best-effort revocation on the current server; proceed regardless so the
      // user is never stuck on an unreachable server. The token is never logged.
    }
    await desktop().clearToken();
    await desktop().clearServerUrl();
    reloadApp();
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
      // Display at the avatar's own aspect ratio (fixed height) so a square
      // 32×32 avatar isn't squished into the old 16×32 (1:2) box.
      cv.style.height = '4rem';
      cv.style.width = `${((4 * w) / h).toFixed(2)}rem`;
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
      'position:fixed;left:50%;top:50%;transform:translate(-50%,-50%);z-index:80;background:#1c1a19;' +
      'border:2px solid #0a0908;border-radius:0.6rem;padding:1rem;color:#f1efec;min-width:12rem;text-align:center;' +
      "font:1rem 'FS Pixel Sans',monospace;box-shadow:inset 0 2px 0 #292725,inset 0 -3px 0 #030303,0 12px 28px rgba(0,0,0,.55);";
    const head = document.createElement('div');
    head.textContent = '🚪 Travel to…';
    head.style.cssText = 'font-size:1.2rem;margin-bottom:0.7rem;color:#f5f3f0;';
    el.appendChild(head);
    const close = (): void => {
      el.remove();
      this.portalPickerTile = null;
    };
    for (const z of zones) {
      const b = document.createElement('button');
      b.textContent = z.label;
      b.style.cssText =
        'display:block;width:100%;margin:0.3rem 0;padding:0.55rem;cursor:pointer;background:#242220;' +
        "border:2px solid #0a0908;border-radius:0.45rem;color:#f1efec;font:1rem 'FS Pixel Sans',monospace;box-shadow:inset 0 2px 0 #4a4744,inset 0 -3px 0 #050505;";
      b.onclick = () => {
        this.room?.send('portalGo', { zone: z.id });
        close();
      };
      el.appendChild(b);
    }
    const cancel = document.createElement('button');
    cancel.textContent = 'Cancel';
    cancel.style.cssText =
      'margin-top:0.5rem;padding:0.4rem 0.8rem;cursor:pointer;background:#262422;border:2px solid #0a0908;' +
      "border-radius:0.35rem;color:#adb0b2;font:0.9rem 'FS Pixel Sans',monospace;box-shadow:inset 0 2px 0 #4a4744,inset 0 -3px 0 #050505;";
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
        "background:rgba(10,12,18,.82);color:#f4f2ee;font:1.1rem 'FS Pixel Sans',ui-monospace,monospace;text-align:center;";
      overlay.textContent = 'Connection lost — reconnecting…';
      (document.getElementById('game') ?? document.body).appendChild(overlay);
    }
    const poll = async (): Promise<void> => {
      if (await isServerUp()) {
        reloadApp();
        return;
      }
      window.setTimeout(() => void poll(), 2000);
    };
    window.setTimeout(() => void poll(), 1500);
  }

  /** An admin kicked us: show a notice and do NOT auto-reconnect (a manual
   *  reload / re-login is required). */
  private showKicked(): void {
    let overlay = document.getElementById('pa-reconnect'); // reuse the disconnect overlay if present
    if (!overlay) {
      overlay = document.createElement('div');
      overlay.id = 'pa-reconnect';
      overlay.style.cssText =
        'position:fixed;inset:0;z-index:200;display:flex;align-items:center;justify-content:center;' +
        "background:rgba(10,12,18,.9);color:#ffd2dc;font:1.15rem 'FS Pixel Sans',ui-monospace,monospace;text-align:center;padding:1rem;";
      (document.getElementById('game') ?? document.body).appendChild(overlay);
    }
    overlay.textContent = 'You were kicked by an admin. Reload the page to rejoin.';
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
    // Write the target zone into the URL, then reload to reconnect. Assigning
    // `window.location.search` directly is unreliable in the Electron (app://)
    // shell — the renderer-initiated navigation is silently dropped, so the zone
    // switch never happens. We set the URL via the history API (which does
    // stick), then reload via reloadApp() (main-process IPC on desktop, plain
    // location.reload() in the browser).
    const url = new URL(window.location.href);
    url.searchParams.set('zone', zone);
    history.replaceState(null, '', url.href);
    reloadApp();
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
    this.settingsPanel.querySelector<HTMLInputElement>('#pa-camfollow')!.checked = this.cameraFollowEnabled;
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
    // Assets (shared galleries) is admin-only; Space stays for travel. Reflect
    // both on the bar, and gate the Layouts tab for non-editors of this zone.
    this.refreshBarButtons();
    if (this.layoutsSeg) this.layoutsSeg.style.display = this.zoneEditAdmin ? '' : 'none';
    if (!this.zoneEditAdmin && this.spaceTab === 'layouts') this.spaceTab = 'zones';
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
          "font:0.9rem 'FS Pixel Sans',monospace;color:#efeeea;text-shadow:0 0 3px #000,0 0 3px #000;white-space:nowrap;";
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
    // Chat bubbles are a 2D-specific DOM overlay and stay here; the chat panel
    // itself is the shared ChatUI (client/src/ui/chatUI.ts). The status icons
    // that used to live alongside them (voice / afk / coffee) are drawn in-world
    // by PhaserRenderer now — see markerIcons.ts.
    if (!document.getElementById("pa-bubble-style")) {
      const s = document.createElement("style");
      s.id = "pa-bubble-style";
      s.textContent = `
        .pa-chatbubble{position:absolute;z-index:46;transform:translate(-50%,-100%);pointer-events:none;
          max-width:14rem;background:#f7f5f2;color:#181614;border-radius:0.5rem;padding:0.3rem 0.55rem;
          font:0.92rem 'FS Pixel Sans',monospace;line-height:1.2;white-space:pre-wrap;word-break:break-word;
          box-shadow:0 2px 0 rgba(0,0,0,.35);text-align:center;}
      `;
      document.head.appendChild(s);
    }
    this.chat = new ChatUI({
      sendChat: (text) => void this.room?.send("chat", { text }),
      sendCommand: (name, args) => void this.room?.send("command", { name, args }),
      isAdmin: () => this.isAdmin,
      canFocus: () => !this.editor.isEditing() && !this.arcadeUI.isOpen,
      clientCommand: (name, _args, sys) => {
        if (name === "admin-site") {
          if (!this.isAdmin) sys("/admin-site is for admins only.");
          else void this.openAdminSite();
          return true;
        }
        return false;
      },
    });
  }

  private onChatHistory(m: Record<string, unknown>): void {
    this.chat?.addHistory((m.messages as Array<{ from?: string; text?: string; at?: number }>) ?? []);
  }

  private onChat(m: Record<string, unknown>): void {
    const from = (m.from as string) ?? "?";
    const text = (m.text as string) ?? "";
    this.chat?.addChatLine(from, text, m.at as number | undefined);
    if (typeof m.id === "number") this.showChatBubble(m.id, text);
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

  /** Feed the in-world voice indicators (Phaser): the pulsing ring under whoever
   *  is talking, and the crossed 🎤 / 🔊 head markers for muted / sound-off. Both
   *  are drawn by the renderer so they pan and zoom with the avatar. */
  private updateVoiceIndicators(): void {
    const now = performance.now();
    // Grace window so the speaking ring stays steady through gaps between words
    // (LiveKit's active-speaker flag toggles off in those pauses).
    const GRACE_MS = 800;
    for (const id of this.voiceSpeakers) this.voiceSpeakUntil.set(id, now + GRACE_MS);
    for (const [id, until] of this.voiceSpeakUntil) {
      if (now >= until) this.voiceSpeakUntil.delete(id);
    }
    this.view.setSpeakingIds(new Set(this.voiceSpeakUntil.keys()));
    this.view.setVoiceStatus(this.voiceStatus);
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
          background:#1c1a19;border:2px solid #0a0908;border-radius:0.35rem;
          padding:0.4rem 0.7rem;white-space:nowrap;box-shadow:inset 0 2px 0 #4a4744,inset 0 -3px 0 #050505,0 2px 0 rgba(0,0,0,.4);}
        .pa-tip .dot{width:0.65rem;height:0.65rem;border-radius:50%;flex:0 0 auto;}
        .pa-tip .act{color:#f1efec;font-size:1.2rem;line-height:1.15;}
        .pa-tip .name{color:#adb0b2;font-size:0.9rem;line-height:1.15;}
        .pa-tip .fuel{width:3.25rem;height:0.32rem;background:#141312;margin-top:0.2rem;}
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

    // Players get just their nickname — the activity line ("Working…", "Idle",
    // …) only means something for an agent's task state.
    const act = ch.isPlayer
      ? null
      : ch.bubbleType === 'permission'
        ? 'Needs approval'
        : ch.activity || (ch.isActive ? 'Working…' : ch.isSubagent ? 'Subtask' : 'Idle');
    const name = ch.isPlayer
      ? ch.folderName || 'Player'
      : ch.agentName || ch.folderName || `agent ${id}`;
    const dot = ch.bubbleType === 'permission' ? '#ffcc00' : ch.isActive ? '#4caf3f' : '';
    const total = (ch.inputTokens ?? 0) + (ch.outputTokens ?? 0);
    const ratio = total / MAX_CONTEXT_TOKENS;

    this.tip.innerHTML =
      `<div class="row">${dot ? `<span class="dot" style="background:${dot}"></span>` : ''}` +
      `<div>${act ? `<div class="act">${esc(act)}</div>` : ''}<div class="name">${esc(name)}</div></div></div>` +
      (total > 0
        ? `<div class="fuel"><div style="width:${Math.min(ratio * 100, 100)}%;background:${fuelColor(ratio)}"></div></div>`
        : '');
    this.tip.style.display = 'flex';
  }
}

/** Meeting-room passwords get a higher floor than account passwords (server-enforced
 *  too, see MIN_MEETING_ROOM_PASSWORD_LEN in meetingRoomStore.ts) — the link+password
 *  pair is typically handed out over email, a less trusted channel than a login. */
const MIN_MEETING_ROOM_PASSWORD_LEN = 8;

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
