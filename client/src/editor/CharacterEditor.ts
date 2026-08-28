import {
  DEFAULT_CHARACTER_SPEC,
  MAX_SHEET_CELLS,
  resolveCharacterSpec,
  resolvePetConfig,
  specFrameCount,
  type CharacterSpec,
  type CharacterTemplate,
  type CharacterTrack,
  type LoadedCharacterData,
  type PetConfig,
  type TrackPlay,
} from '@pixel/shared/office/sprites/spriteData.js';
import type { SpriteData } from '@pixel/shared/office/types.js';
import { previewFrameMs } from '@pixel/shared/office/poseCadence.js';
import { gridFromImageData, imagePixels } from '../art/sheet';
import { encodeSheetPng } from '../art/sheetEncode';
import { confirmDialog } from '../ui/dialog.js';
import { copyRegion, hasClipboard, pasteRegion, rectFromCorners, type PixelRect } from './pixelSelection.js';

type Dir = 'down' | 'up' | 'right' | 'left';
/** A pose previewed in the editor: a track name, or 'idle' (neutral stand). */
type PreviewPose = string;

export interface CharacterEditorOpts {
  /** Editable categories (Agents, pets); the gallery toggles between them. */
  categories: EditorCategory[];
  /** Shared top-bar to host the button in (matches Edit/Layouts/Settings). */
  topbar?: HTMLElement;
  /** Toolbar button clicked — let the scene coordinate mutually-exclusive menus.
   *  Falls back to self-toggle when not provided. */
  requestToggle?: () => void;
  /** Inject the top-bar entry button? Default true. The scene sets this false
   *  when entry lives elsewhere (the Assets panel) and it opens via editEntity. */
  entryButton?: boolean;
  /** Where "← Back" goes (Assets panel). When set, the built-in gallery view is
   *  bypassed entirely — Back closes the editor and hands control back here. */
  onBack?: () => void;
}

/** Keep only printable ASCII, max 16 chars (for character display names). */
function sanitizeName(raw: string): string {
  return raw
    .replace(/[^\x20-\x7e]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 32);
}

const CELL = 13; // baseline on-screen pixels per sprite pixel (scaled down for large frames)
/** Max character frame dimension (px). Mirrored by the server-side validator. */
const MAX_DIM = 64;
/** UI cap on frames per track (the server allows up to 64). */
const MAX_TRACK_FRAMES = 12;
/** Server-side cap on stored frames per direction (mirrors the save validator). */
const MAX_FRAMES = 64;
/** Direction rows in an exported sheet, in order (left is mirrored from right). */
const SHEET_ROWS: Dir[] = ['down', 'up', 'right'];
const DIRS: Dir[] = ['down', 'up', 'right', 'left'];
const DIR_LABEL: Record<Dir, string> = { down: 'Front', up: 'Back', right: 'Right', left: 'Left' };

/** A track the editor exposes for a category. `min` 0 = optional (removable, the
 *  last such track), `def` = frames used when deriving/creating. Track order
 *  defines the frame layout in the flat per-direction list. */
export interface TrackDef {
  name: string;
  label: string;
  min: number;
  play: TrackPlay;
  def: number;
}

/** An editable entity category (Agents, pets). Provides its roster, naming,
 *  persistence and animation-track preset. */
/**
 * What one save sends: the art as a PNG, plus the metadata an image cannot carry.
 *
 * The server bounds and decodes the PNG (art/sheetPng.ts) and then validates the result like
 * any other sheet, so this shape is the whole wire contract for saving art.
 */
/** What a save answers — the server can refuse now, so the editor can say why. */
export type SaveResult = { ok: true } | { ok: false; error: string };

export interface SheetSave {
  png: Uint8Array<ArrayBuffer>;
  name: string;
  spec?: CharacterSpec;
  petConfig?: PetConfig;
}

export interface EditorCategory {
  key: string;
  label: string;
  getTemplates: () => CharacterTemplate[] | null;
  /** Allocate an id for a new entity (e.g. `char_7`), given the existing ids. */
  newId: (existing: string[]) => string;
  save: (name: string, sheet: SheetSave) => Promise<SaveResult>;
  reset: (name: string) => void;
  /** Bundled (file-default) ids → Reset; everything else is user-added → Delete. */
  isBundled: (id: string) => boolean;
  /** Animation-track preset for this category. */
  tracks: TrackDef[];
  /** Frames in a fresh blank entity (sum of the mandatory tracks' `def`). */
  blankFrames: number;
  /** Whether the user may create new entities (New / Copy). */
  canCreate: boolean;
  /** Whether entities carry a pet spawn config (shows the config row). */
  spawnConfig?: boolean;
  /** Name is derived from the roster slot (e.g. `dog_0`) rather than typed by
   *  the user: hide the name field and auto-fill it so the server-mandatory
   *  name is always present and Save stays enabled. */
  derivedName?: boolean;
}

/** Agent animation tracks (walk/typing/reading + optional coffee/idle). Idle is
 *  the universal fallback pose: any action without its own sequence renders idle
 *  (and idle itself falls back to the neutral stand frame when undrawn). */
export const AGENT_TRACKS: TrackDef[] = [
  { name: 'walk', label: 'Walk', min: 1, play: 'pingpong', def: 3 },
  { name: 'typing', label: 'Typing', min: 1, play: 'loop', def: 2 },
  { name: 'reading', label: 'Reading', min: 1, play: 'loop', def: 2 },
  { name: 'coffee', label: 'Coffee', min: 0, play: 'loop', def: 2 },
  { name: 'idle', label: 'Idle', min: 0, play: 'loop', def: 1 },
  { name: 'sit', label: 'Sit', min: 0, play: 'loop', def: 2 },
];
/**
 * Pet animation tracks. Idle is the universal fallback (see AGENT_TRACKS).
 *
 * **The ORDER is the sheet's column layout**, not a menu order: `deriveSpecTracks` hands each
 * track the next columns in this sequence, so this list has to read like the art —
 * walk 0-2, sit 3-4, idle 5, talk 6-7 (`PET_SPRITE_SPEC`). It did not, and the consequence was
 * waiting to happen: `sleep` sat fourth with a default of 2 frames, so deriving a spec for an
 * 8-column sheet gave columns 6-7 to SLEEP and nothing to talk. Nothing had noticed because the
 * sheets were six columns wide until the talk track was drawn.
 *
 * `sleep` is gone from this list on purpose: there is no sleep state anywhere in
 * `engine/pets.ts`, so frames drawn into it could never appear in the world — the editor was
 * inviting work that had no effect. `TOLERATED_TRACK_NAMES` still recognises the name so art
 * saved before this is not re-derived underneath its author.
 */
export const PET_TRACKS: TrackDef[] = [
  { name: 'walk', label: 'Walk', min: 1, play: 'pingpong', def: 3 },
  { name: 'sit', label: 'Sit', min: 1, play: 'loop', def: 2 },
  { name: 'idle', label: 'Idle', min: 1, play: 'loop', def: 1 },
  { name: 'talk', label: 'Talk', min: 0, play: 'loop', def: 2 },
  { name: 'drink', label: 'Drink', min: 0, play: 'loop', def: 2 },
];

/**
 * Track names the editor no longer offers but stored art may still carry.
 *
 * `ensureSpec` replaces a spec wholesale when it names a track it does not know, which re-derives
 * every column meaning — so simply dropping a name would silently renumber the frames of any sheet
 * that used it, and saving would persist that. Recognising the name costs nothing and keeps such a
 * sheet readable; it just cannot be added any more, and the world never animated it anyway.
 */
const TOLERATED_TRACK_NAMES = new Set(['sleep']);

interface EditorTrackSlot {
  name: string;
  label: string;
  start: number;
  count: number;
  play: TrackPlay;
}

/** Per-track slot offsets from a spec, in the spec's track order. */
function specSlots(spec: CharacterSpec, defs: TrackDef[]): EditorTrackSlot[] {
  const slots: EditorTrackSlot[] = [];
  let off = 0;
  for (const t of spec.tracks) {
    const def = defs.find((d) => d.name === t.name);
    slots.push({ name: t.name, label: def?.label ?? t.name, start: off, count: t.frames, play: t.play });
    off += t.frames;
  }
  return slots;
}

/** Frame index → "Track N" label using the spec's track layout. */
function frameLabelFor(spec: CharacterSpec, i: number, defs: TrackDef[]): string {
  for (const s of specSlots(spec, defs)) {
    if (i >= s.start && i < s.start + s.count) return `${s.label} ${i - s.start + 1}`;
  }
  return `frame ${i + 1}`;
}

/** Best-effort track split for a flat frame list lacking a usable spec: assign
 *  each track its `def` in order; the last (optional) track absorbs any
 *  remainder. Category-specific (agent walk/type/read/coffee, pet walk/sit/…). */
function deriveSpecTracks(frameCount: number, defs: TrackDef[]): CharacterTrack[] {
  const tracks: CharacterTrack[] = [];
  let rest = frameCount;
  defs.forEach((d, i) => {
    const isLast = i === defs.length - 1;
    const want = isLast ? rest : Math.max(0, Math.min(d.def, rest));
    if (want > 0) {
      tracks.push({ name: d.name, frames: want, play: d.play });
      rest -= want;
    }
  });
  if (tracks.length === 0) {
    const first = defs[0];
    tracks.push({ name: first?.name ?? 'walk', frames: Math.max(1, frameCount), play: first?.play ?? 'pingpong' });
  }
  return tracks;
}

function emptyFrame(w: number, h: number): SpriteData {
  return Array.from({ length: h }, () => new Array<string>(w).fill(''));
}
function cloneFrame(f: SpriteData): SpriteData {
  return f.map((row) => row.slice());
}
/** Mirror a frame horizontally (for deriving left from right). */
function flipH(f: SpriteData): SpriteData {
  return f.map((row) => row.slice().reverse());
}

/** Decode a picked image file. Rejects on anything the browser can't decode. */
function loadImage(file: File): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve(img);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('decode failed'));
    };
    img.src = url;
  });
}

/** Display label for a skin: its name, or the stable id when unnamed. The id is
 *  appended in parens ONLY when another skin shares the same name, so duplicate
 *  names stay distinguishable without otherwise exposing the technical id. */
export function skinLabel(c: CharacterTemplate, all: CharacterTemplate[]): string {
  const name = c.data.name;
  if (!name) return c.id;
  const duplicate = all.some((o) => o !== c && o.data.name === name);
  return duplicate ? `${name} (${c.id})` : name;
}
function cloneChar(c: LoadedCharacterData): LoadedCharacterData {
  const out: LoadedCharacterData = {
    down: c.down.map(cloneFrame),
    up: c.up.map(cloneFrame),
    right: c.right.map(cloneFrame),
  };
  if (c.left) out.left = c.left.map(cloneFrame);
  if (c.name) out.name = c.name;
  if (c.spec) out.spec = { frame: { ...c.spec.frame }, tracks: c.spec.tracks.map((t) => ({ ...t })) };
  if (c.petConfig) out.petConfig = { ...c.petConfig, behaviors: { ...c.petConfig.behaviors } };
  return out;
}

/**
 * In-browser pixel editor for character sprites. Edits the engine-native SpriteData frames and
 * saves via the asset-override protocol; the office re-renders live from the broadcast.
 *
 * Two things this used to say and no longer does. The frame size is NOT fixed at 16×32 — it is
 * per character up to 64×64 (`resizeWork` writes `spec.frame`, and the sheet carries it in a
 * `char_N.json` manifest). And `left` is not auto-mirrored any more: a mirrored right row is
 * only the SEED, `doSave` writes all four rows, because an asymmetric detail — a bag on one
 * shoulder — is exactly what a mirror gets wrong.
 */
export class CharacterEditor {
  private panel!: HTMLDivElement;
  private btn!: HTMLButtonElement;
  private galleryPane!: HTMLDivElement;
  private editPane!: HTMLDivElement;
  private cardsHost!: HTMLDivElement;
  private canvas!: HTMLCanvasElement;
  private strip!: HTMLDivElement;
  private nameEl!: HTMLInputElement;

  private open = false;
  private view: 'gallery' | 'edit' = 'gallery';
  /** Active editable category (index into opts.categories). */
  private catIndex = 0;
  /** Unsaved-edit flag for the current edit session (prompts before leaving). */
  private dirty = false;
  // ── Live preview ──
  private previewCanvas!: HTMLCanvasElement;
  private previewPose: PreviewPose = 'walk';
  private previewFrameIdx = 0;
  private previewTimer?: number;
  // ── PNG sheet import ──
  private importPanel!: HTMLDivElement;
  private importCanvas!: HTMLCanvasElement;
  private importImg: HTMLImageElement | null = null;
  private importOpen = false;
  /** Cell grid over the loaded sheet (source pixels). cell defaults to char W×H. */
  private imp = { cw: 16, ch: 32, ox: 0, oy: 0, gx: 0, gy: 0, scale: 3 };
  private impHover: { col: number; row: number } | null = null;
  private charIndex = 0;
  /** Stable id of the entity being edited (e.g. `char_3`); the asset name on save. */
  private charId = 'char_0';
  private dir: Dir = 'down';
  private frame = 0;
  private color = '#e0b48c';
  private tool: 'paint' | 'erase' | 'pick' | 'select' = 'paint';
  /** Active marquee selection (sprite-pixel coords), or null. */
  private selection: PixelRect | null = null;
  private onion = true;
  private work: LoadedCharacterData = { down: [], up: [], right: [] };
  private W = 16;
  private H = 32;

  constructor(private readonly opts: CharacterEditorOpts) {
    this.build();
  }

  isOpen(): boolean {
    return this.open;
  }
  /** Show/hide the top-bar entry button (used to hide editing from non-admins). */
  setButtonVisible(visible: boolean): void {
    this.btn.style.display = visible ? '' : 'none';
    if (!visible && this.open) this.close();
  }
  /** The active editable category. */
  private cat(): EditorCategory {
    return this.opts.categories[this.catIndex];
  }
  private trackDefs(): TrackDef[] {
    return this.cat().tracks;
  }
  toggle(): void {
    if (this.open) void this.requestClose();
    else this.show();
  }
  show(): void {
    this.open = true;
    this.panel.style.display = 'block';
    this.showGallery();
  }
  /** Open straight into editing one entity (e.g. the player's own avatar),
   *  selecting its category first. Falls back to the gallery if not found. */
  editEntity(catKey: string, id: string): void {
    const ci = this.opts.categories.findIndex((c) => c.key === catKey);
    if (ci < 0) return;
    this.open = true;
    this.panel.style.display = 'block';
    this.catIndex = ci;
    const tpl = this.cat().getTemplates() ?? [];
    const i = tpl.findIndex((t) => t.id === id);
    if (i < 0) {
      if (this.opts.onBack) this.opts.onBack();
      else this.showGallery();
      return;
    }
    this.loadChar(i);
    this.showEdit();
  }

  /** Open straight into a new blank entity of a category (Assets "＋ New"). */
  newEntity(catKey: string): void {
    const ci = this.opts.categories.findIndex((c) => c.key === catKey);
    if (ci < 0) return;
    this.open = true;
    this.panel.style.display = 'block';
    this.catIndex = ci;
    this.createNew(null);
    this.showEdit();
  }
  /** Close, prompting first if there are unsaved edits in the edit view. */
  private async requestClose(): Promise<void> {
    if (!(await this.confirmDiscard())) return;
    this.close();
  }
  close(): void {
    this.open = false;
    this.panel.style.display = 'none';
    this.stopPreview();
    this.closeImport();
  }

  /** True if it's safe to leave the current edit (no unsaved edits, or the user
   *  confirmed discarding them). Always true outside the edit view. */
  private async confirmDiscard(): Promise<boolean> {
    if (this.view !== 'edit' || !this.dirty) return true;
    return confirmDialog('Discard unsaved changes?', { danger: true, confirmLabel: 'Discard' });
  }

  /** Scene hook: called before the panel is closed by the menu coordinator.
   *  Returns whether closing may proceed (prompts on unsaved edits). */
  confirmLeave(): Promise<boolean> {
    return this.confirmDiscard();
  }

  private showGallery(): void {
    this.view = 'gallery';
    this.editPane.style.display = 'none';
    this.galleryPane.style.display = 'block';
    this.stopPreview();
    this.closeImport();
    this.renderGallery();
  }
  private showEdit(): void {
    this.view = 'edit';
    this.galleryPane.style.display = 'none';
    this.editPane.style.display = 'block';
    this.render();
    this.startPreview();
  }

  // ── DOM ──────────────────────────────────────────────────────────
  private build(): void {
    const style = document.createElement('style');
    // Sizing mirrors the Settings/Edit panels (rem-based, larger fonts/buttons).
    style.textContent = `
      #pa-chars{position:fixed;top:3.7rem;right:calc(0.75rem + var(--pa-dock-r, 0px) + var(--pa-side-panel-w, 0px));z-index:61;display:none;width:26rem;background:#1c1a19;
        border:2px solid #0a0908;border-radius:0.6rem;color:#f1efec;padding:0.9rem;font-family:'FS Pixel Sans',monospace;
        box-shadow:inset 0 2px 0 #292725,inset 0 -3px 0 #030303,0 12px 28px rgba(0,0,0,.55);box-sizing:border-box;max-height:calc(100vh - 4.7rem);overflow:auto;}
      #pa-chars h4{margin:0 0 0.6rem;font-size:1.25rem;color:#f5f3f0;}
      #pa-chars .row{display:flex;align-items:center;gap:0.5rem;margin:0.5rem 0;font-size:1rem;flex-wrap:wrap;}
      #pa-chars select,#pa-chars button,#pa-chars input[type=text]{background:#262422;border:2px solid #0a0908;color:#f1efec;
        border-radius:0.35rem;font:1rem 'FS Pixel Sans',monospace;padding:0.4rem 0.6rem;cursor:pointer;box-shadow:inset 0 2px 0 #4a4744,inset 0 -3px 0 #050505;}
      #pa-chars input[type=text]{cursor:text;}
      #pa-chars input[type=number]{width:3.2rem;background:#262422;border:2px solid #0a0908;color:#f1efec;
        border-radius:0.35rem;font:0.95rem 'FS Pixel Sans',monospace;padding:0.3rem 0.4rem;box-shadow:inset 0 2px 0 #4a4744,inset 0 -3px 0 #050505;}
      #pa-chars .sizelabel{color:#adb0b2;}
      #pa-c-tracks{display:flex;flex-direction:column;gap:0.3rem;margin:0.5rem 0;}
      #pa-c-tracks .trackrow{display:flex;align-items:center;gap:0.4rem;font-size:0.95rem;}
      #pa-c-tracks .tname{width:5rem;color:#d7d9da;}
      #pa-c-tracks .tcount{min-width:1.6rem;text-align:center;color:#adb0b2;}
      #pa-c-tracks button{padding:0.25rem 0.5rem;font-size:0.9rem;}
      #pa-c-tracks .play{margin-left:auto;}
      #pa-chars .prevbox{height:5rem;min-width:3rem;padding:0.2rem;border:2px solid #0a0908;border-radius:0.35rem;
        display:flex;align-items:flex-end;justify-content:center;
        background:repeating-conic-gradient(#262422 0% 25%, #201e1c 0% 50%) 0/0.6rem 0.6rem;}
      #pa-chars #pa-c-preview{height:100%;width:auto;image-rendering:pixelated;}
      #pa-chars button.on{background:#c51a1b;color:#fff;box-shadow:inset 0 2px 0 #e2585a,inset 0 -3px 0 #5c0f10;}
      #pa-chars .tab{padding:0.4rem 0.8rem;}
      #pa-chars .strip{display:flex;gap:0.35rem;flex-wrap:wrap;margin:0.5rem 0;}
      #pa-chars .strip .fr{display:flex;flex-direction:column;align-items:center;gap:0.15rem;font-size:0.75rem;color:#adb0b2;cursor:pointer;}
      #pa-chars .strip .fr.sel canvas{outline:2px solid #e2585a;}
      #pa-chars .strip canvas{background:#141312;image-rendering:pixelated;border:2px solid #0a0908;}
      #pa-chars #pa-paint{image-rendering:pixelated;background:
        repeating-conic-gradient(#262422 0% 25%, #201e1c 0% 50%) 0/1rem 1rem;border:2px solid #0a0908;cursor:crosshair;touch-action:none;}
      #pa-chars .foot{display:flex;gap:0.5rem;margin-top:0.6rem;}
      #pa-chars .foot button{flex:1;padding:0.6rem;}
      #pa-chars input[type=color]{width:2.6rem;height:2rem;padding:0;border:2px solid #0a0908;background:none;cursor:pointer;}
      #pa-chars #pa-c-status{color:#7fbf6a;font-size:0.9rem;opacity:0;transition:opacity .4s;}
      #pa-chars button:disabled{opacity:0.4;cursor:not-allowed;}
      #pa-c-cards{display:flex;flex-direction:column;gap:0.5rem;}
      #pa-c-cards .card{display:flex;align-items:center;gap:0.6rem;background:#242220;border:2px solid #0a0908;
        border-radius:0.45rem;padding:0.4rem 0.6rem;box-shadow:inset 0 2px 0 #4a4744,inset 0 -3px 0 #050505;}
      #pa-c-cards .card canvas{width:1.6rem;height:3.2rem;image-rendering:pixelated;background:#141312;border:2px solid #0a0908;}
      #pa-c-cards .card .nm{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
      #pa-c-cards .card button{padding:0.3rem 0.55rem;font-size:0.9rem;}
      #pa-c-cards .card button.del{background:#7c2634;color:#f1d0d6;box-shadow:inset 0 2px 0 #b34a5a,inset 0 -3px 0 #45111a;}
      #pa-c-newdlg{position:fixed;inset:0;z-index:70;display:none;background:rgba(0,0,0,.55);
        align-items:center;justify-content:center;}
      #pa-c-newdlg.show{display:flex;}
      #pa-c-newdlg .box{background:#1c1a19;border:2px solid #0a0908;border-radius:0.6rem;padding:1rem;max-width:30rem;
        box-shadow:inset 0 2px 0 #292725,inset 0 -3px 0 #030303,0 12px 28px rgba(0,0,0,.55);}
      #pa-c-newdlg h4{margin:0 0 0.7rem;font-size:1.2rem;color:#f5f3f0;}
      #pa-c-newdlg .grid{display:flex;gap:0.6rem;flex-wrap:wrap;max-width:28rem;}
      #pa-c-newdlg .grid .opt{display:flex;flex-direction:column;align-items:center;gap:0.2rem;font-size:0.8rem;
        color:#adb0b2;cursor:pointer;padding:0.3rem;border:2px solid transparent;border-radius:0.35rem;}
      #pa-c-newdlg .grid .opt:hover{border-color:#c51a1b;background:#262422;}
      #pa-c-newdlg .grid canvas{width:2.4rem;height:4.8rem;image-rendering:pixelated;background:#141312;border:2px solid #0a0908;}
      #pa-c-newdlg .grid .blank{width:2.4rem;height:4.8rem;display:flex;align-items:center;justify-content:center;
        background:#141312;border:2px dashed #4a4744;color:#818586;font-size:1.4rem;}
      #pa-c-import{position:fixed;top:3.4rem;left:calc(0.5rem + var(--pa-dock-l, 0px));z-index:61;display:none;max-width:30rem;background:#1c1a19;
        border:2px solid #0a0908;border-radius:0.6rem;color:#f1efec;padding:0.9rem;font-family:'FS Pixel Sans',monospace;
        box-shadow:inset 0 2px 0 #292725,inset 0 -3px 0 #030303,0 12px 28px rgba(0,0,0,.55);box-sizing:border-box;max-height:calc(100vh - 4rem);overflow:auto;}
      #pa-c-import .row{display:flex;align-items:center;gap:0.4rem;margin:0.45rem 0;font-size:0.95rem;flex-wrap:wrap;}
      #pa-c-import strong{font-size:1.1rem;color:#f5f3f0;}
      #pa-c-import button{background:#262422;border:2px solid #0a0908;color:#f1efec;border-radius:0.35rem;
        font:0.95rem 'FS Pixel Sans',monospace;padding:0.35rem 0.6rem;cursor:pointer;box-shadow:inset 0 2px 0 #4a4744,inset 0 -3px 0 #050505;}
      #pa-c-import label{color:#adb0b2;}
      #pa-c-import input[type=number]{width:3rem;background:#262422;border:2px solid #0a0908;color:#f1efec;
        border-radius:0.35rem;font:0.9rem 'FS Pixel Sans',monospace;padding:0.25rem 0.3rem;box-shadow:inset 0 2px 0 #4a4744,inset 0 -3px 0 #050505;}
      #pa-c-import .tgt{margin-left:auto;color:#4998c0;font-size:0.9rem;}
      #pa-c-import .canvaswrap{overflow:auto;max-height:62vh;border:2px solid #0a0908;
        background:repeating-conic-gradient(#262422 0% 25%, #201e1c 0% 50%) 0/1rem 1rem;}
      #pa-c-import canvas{image-rendering:pixelated;display:block;cursor:crosshair;}
      #pa-c-import .hint{font-size:0.8rem;color:#818586;margin-top:0.4rem;}
    `;
    document.head.appendChild(style);

    const btn = document.createElement('button');
    btn.id = 'pa-chars-btn';
    btn.className = 'pa-ui'; // styled by #pa-topbar button (matches Edit/Layouts/Settings)
    btn.textContent = '🎨 Chars';
    btn.onclick = () => (this.opts.requestToggle ? this.opts.requestToggle() : this.toggle());

    const panel = document.createElement('div');
    panel.id = 'pa-chars';
    panel.className = 'pa-ui';
    panel.innerHTML = `
      <div id="pa-c-gallery">
        <h4>Characters</h4>
        <div class="row" id="pa-c-cats"></div>
        <div id="pa-c-cards"></div>
        <div class="foot">
          <button id="pa-c-newbtn" class="on">＋ New</button>
          <button id="pa-c-galclose">Close</button>
        </div>
      </div>
      <div id="pa-c-edit" style="display:none">
        <div class="row"><button id="pa-c-back">← Back</button>
          <input id="pa-c-name" type="text" maxlength="32" placeholder="char name" style="flex:1;min-width:0;"></div>
        <div class="row"><span class="sizelabel">Size</span>
          <input id="pa-c-w" type="number" min="1" max="64"><span class="sizelabel">×</span>
          <input id="pa-c-h" type="number" min="1" max="64">
          <span class="sizelabel" style="font-size:0.8rem">px · max 64×64</span></div>
        <div class="row" id="pa-c-petcfg" style="display:none">
          <label class="sizelabel"><input id="pa-c-active" type="checkbox"> Active</label>
          <span class="sizelabel">every</span>
          <input id="pa-c-spmin" type="number" min="5" max="3600"><span class="sizelabel">–</span>
          <input id="pa-c-spmax" type="number" min="5" max="3600"><span class="sizelabel">s · max</span>
          <input id="pa-c-spconc" type="number" min="1" max="8"></div>
        <div class="row" id="pa-c-petbehav" style="display:none">
          <span class="sizelabel">Behavior</span>
          <label class="sizelabel" id="pa-c-brest-l"><input id="pa-c-brest" type="checkbox"> Rest</label>
          <label class="sizelabel" id="pa-c-bdrink-l"><input id="pa-c-bdrink" type="checkbox"> Coffee</label>
          <label class="sizelabel" id="pa-c-btalk-l"><input id="pa-c-btalk" type="checkbox"> Talk</label>
          <label class="sizelabel" id="pa-c-bchase-l"><input id="pa-c-bchase" type="checkbox"> Chase cats</label>
          <label class="sizelabel" id="pa-c-bflee-l"><input id="pa-c-bflee" type="checkbox"> Flee dogs</label></div>
        <div class="row" id="pa-c-dirs"></div>
        <div class="row">
          <div class="prevbox"><canvas id="pa-c-preview" width="16" height="32"></canvas></div>
          <span class="sizelabel">Preview</span>
          <select id="pa-c-pose" title="Animation shown in the preview"></select>
          <span class="sizelabel" style="font-size:0.8rem">· current direction</span>
        </div>
        <div class="strip" id="pa-c-strip"></div>
        <div class="row">
          <input id="pa-c-color" type="color" value="${this.color}">
          <button id="pa-c-paint" class="on">✏ Paint</button>
          <button id="pa-c-erase">⌫ Erase</button>
          <button id="pa-c-pick">⦿ Pick</button>
          <button id="pa-c-select" title="Select a region to copy">⬚</button>
          <button id="pa-c-paste" title="Paste the copied region here">⎘</button>
          <label style="margin-left:auto;font-size:14px;"><input id="pa-c-onion" type="checkbox" checked> Onion</label>
        </div>
        <div class="row"><canvas id="pa-paint"></canvas></div>
        <div id="pa-c-tracks"></div>
        <div class="row"><button id="pa-c-clear">Clear current frame</button></div>
        <div class="row">
          <button id="pa-c-import-btn" title="Pick individual frames out of a PNG sprite sheet">⇪ Import frames…</button>
          <button id="pa-c-importchar"
            title="Replace this character from an Export: select the .png and its .json manifest together">⇩ Import character…</button>
          <input id="pa-c-impchar-file" type="file" accept=".png,.json,image/png,application/json" multiple hidden>
        </div>
        <div class="row" style="justify-content:flex-end;min-height:16px;margin:0;"><span id="pa-c-status">​</span></div>
        <div class="foot">
          <button id="pa-c-save" class="on">Save</button>
          <button id="pa-c-export" title="Download a PNG sheet to add to the repo">Export</button>
        </div>
      </div>
      <div id="pa-c-newdlg"><div class="box"><h4>New character — copy from</h4><div class="grid" id="pa-c-newgrid"></div>
        <div class="row" style="justify-content:flex-end;"><button id="pa-c-newcancel">Cancel</button></div></div></div>`;

    const importPanel = document.createElement('div');
    importPanel.id = 'pa-c-import';
    importPanel.className = 'pa-ui';
    importPanel.innerHTML = `
      <div class="row"><strong>Import from PNG</strong>
        <span class="tgt" id="pa-imp-target"></span>
        <button id="pa-imp-close" style="margin-left:0.4rem">✕</button></div>
      <div class="row"><button id="pa-imp-load">Load PNG…</button>
        <label>zoom</label><button id="pa-imp-zo">−</button><button id="pa-imp-zi">＋</button></div>
      <div class="row">
        <label>cell</label><input id="pa-imp-cw" type="number" min="1" max="128">×<input id="pa-imp-ch" type="number" min="1" max="128">
        <label>off</label><input id="pa-imp-ox" type="number" min="0" max="4096"><input id="pa-imp-oy" type="number" min="0" max="4096">
        <label>gap</label><input id="pa-imp-gx" type="number" min="0" max="256"><input id="pa-imp-gy" type="number" min="0" max="256">
      </div>
      <div class="canvaswrap"><canvas id="pa-imp-canvas" width="0" height="0"></canvas></div>
      <div class="hint">Pick a frame on the right, then click a cell here to drop it in (scaled to the frame size if it differs).</div>
      <input id="pa-imp-file" type="file" accept="image/png,image/*" hidden>`;

    const host = document.getElementById('game') ?? document.body;
    if (this.opts.entryButton !== false) {
      if (this.opts.topbar) this.opts.topbar.appendChild(btn);
      else host.appendChild(btn);
    }
    this.btn = btn;
    host.appendChild(panel);
    host.appendChild(importPanel);
    this.importPanel = importPanel;
    this.importCanvas = importPanel.querySelector<HTMLCanvasElement>('#pa-imp-canvas')!;
    this.wireImport();
    this.panel = panel;
    this.galleryPane = panel.querySelector<HTMLDivElement>('#pa-c-gallery')!;
    this.editPane = panel.querySelector<HTMLDivElement>('#pa-c-edit')!;
    this.cardsHost = panel.querySelector<HTMLDivElement>('#pa-c-cards')!;
    this.canvas = panel.querySelector<HTMLCanvasElement>('#pa-paint')!;
    this.strip = panel.querySelector<HTMLDivElement>('#pa-c-strip')!;
    this.previewCanvas = panel.querySelector<HTMLCanvasElement>('#pa-c-preview')!;
    panel.querySelector<HTMLSelectElement>('#pa-c-pose')!.onchange = (e) => {
      this.previewPose = (e.target as HTMLSelectElement).value as PreviewPose;
      this.startPreview();
    };

    // Direction tabs
    const dirsRow = panel.querySelector<HTMLDivElement>('#pa-c-dirs')!;
    for (const d of DIRS) {
      const b = document.createElement('button');
      b.className = 'tab';
      b.textContent = DIR_LABEL[d];
      b.onclick = () => {
        this.dir = d;
        this.frame = Math.min(this.frame, this.dirFrames(d).length - 1);
        this.render();
      };
      b.dataset.dir = d;
      dirsRow.appendChild(b);
    }

    // Gallery wiring
    panel.querySelector<HTMLButtonElement>('#pa-c-newbtn')!.onclick = () => this.openNewDialog();
    panel.querySelector<HTMLButtonElement>('#pa-c-galclose')!.onclick = () => this.close();
    panel.querySelector<HTMLButtonElement>('#pa-c-newcancel')!.onclick = () => this.closeNewDialog();

    // Edit wiring. Back returns to the Assets panel (onBack, which prompts on
    // unsaved edits via setMenu); without a host it falls back to the gallery.
    panel.querySelector<HTMLButtonElement>('#pa-c-back')!.onclick = async () => {
      if (this.opts.onBack) {
        this.opts.onBack();
        return;
      }
      if (await this.confirmDiscard()) this.showGallery();
    };
    this.nameEl = panel.querySelector<HTMLInputElement>('#pa-c-name')!;
    this.nameEl.oninput = () => {
      const clean = sanitizeName(this.nameEl.value);
      if (clean !== this.nameEl.value) this.nameEl.value = clean;
      this.work.name = clean || undefined;
      this.dirty = true;
      this.render(); // Save button enables/disables with the name.
    };
    const wEl = panel.querySelector<HTMLInputElement>('#pa-c-w')!;
    const hEl = panel.querySelector<HTMLInputElement>('#pa-c-h')!;
    const onSize = (): void => {
      const w = Math.max(1, Math.min(MAX_DIM, Math.round(Number(wEl.value) || this.W)));
      const h = Math.max(1, Math.min(MAX_DIM, Math.round(Number(hEl.value) || this.H)));
      if (w === this.W && h === this.H) return;
      // A refused resize leaves the sheet as it was, so nothing is dirty and nothing changed;
      // resizeWork has already put the input boxes back and said why.
      if (!this.resizeWork(w, h)) return;
      this.dirty = true;
      this.render();
    };
    wEl.onchange = onSize;
    hEl.onchange = onSize;
    // Pet spawn config inputs (active / interval / max concurrent).
    const activeEl = panel.querySelector<HTMLInputElement>('#pa-c-active')!;
    const spMin = panel.querySelector<HTMLInputElement>('#pa-c-spmin')!;
    const spMax = panel.querySelector<HTMLInputElement>('#pa-c-spmax')!;
    const spConc = panel.querySelector<HTMLInputElement>('#pa-c-spconc')!;
    // Behaviour switches. All three checkboxes always hold the current value
    // (renderConfigRow syncs them); only their labels are hidden per kind, so
    // reading them back here preserves the inert (kind-irrelevant) flags.
    const bRest = panel.querySelector<HTMLInputElement>('#pa-c-brest')!;
    const bDrink = panel.querySelector<HTMLInputElement>('#pa-c-bdrink')!;
    const bTalk = panel.querySelector<HTMLInputElement>('#pa-c-btalk')!;
    const bChase = panel.querySelector<HTMLInputElement>('#pa-c-bchase')!;
    const bFlee = panel.querySelector<HTMLInputElement>('#pa-c-bflee')!;
    const onConfig = (): void => {
      if (!this.work.petConfig) return;
      const clamp = (v: string, lo: number, hi: number, d: number): number => {
        const n = Math.round(Number(v));
        return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : d;
      };
      let min = clamp(spMin.value, 5, 3600, this.work.petConfig.minSec);
      let max = clamp(spMax.value, 5, 3600, this.work.petConfig.maxSec);
      if (min > max) [min, max] = [max, min];
      this.work.petConfig = {
        active: activeEl.checked,
        minSec: min,
        maxSec: max,
        maxConcurrent: clamp(spConc.value, 1, 8, this.work.petConfig.maxConcurrent),
        behaviors: {
          rest: bRest.checked,
          chaseCats: bChase.checked,
          fleeDogs: bFlee.checked,
          drink: bDrink.checked,
          talk: bTalk.checked,
        },
      };
      this.dirty = true;
    };
    activeEl.onchange = onConfig;
    for (const el of [spMin, spMax, spConc, bRest, bDrink, bTalk, bChase, bFlee]) el.onchange = onConfig;
    const colorEl = panel.querySelector<HTMLInputElement>('#pa-c-color')!;
    colorEl.oninput = () => {
      this.color = colorEl.value;
      this.setTool('paint');
    };
    panel.querySelector<HTMLButtonElement>('#pa-c-paint')!.onclick = () => this.setTool('paint');
    panel.querySelector<HTMLButtonElement>('#pa-c-erase')!.onclick = () => this.setTool('erase');
    panel.querySelector<HTMLButtonElement>('#pa-c-pick')!.onclick = () => this.setTool('pick');
    panel.querySelector<HTMLButtonElement>('#pa-c-select')!.onclick = () => this.setTool('select');
    panel.querySelector<HTMLButtonElement>('#pa-c-paste')!.onclick = () => this.doPaste();
    panel.querySelector<HTMLInputElement>('#pa-c-onion')!.onchange = (e) => {
      this.onion = (e.target as HTMLInputElement).checked;
      this.render();
    };
    panel.querySelector<HTMLButtonElement>('#pa-c-clear')!.onclick = () => {
      const frames = this.dir === 'left' ? this.ensureLeft() : this.work[this.dir];
      frames[this.frame] = emptyFrame(this.W, this.H);
      this.dirty = true;
      this.render();
    };
    panel.querySelector<HTMLButtonElement>('#pa-c-save')!.onclick = () => this.doSave();
    panel.querySelector<HTMLButtonElement>('#pa-c-export')!.onclick = () => this.doExport();
    panel.querySelector<HTMLButtonElement>('#pa-c-import-btn')!.onclick = () => this.toggleImport();
    const charFile = panel.querySelector<HTMLInputElement>('#pa-c-impchar-file')!;
    panel.querySelector<HTMLButtonElement>('#pa-c-importchar')!.onclick = () => charFile.click();
    charFile.onchange = () => {
      const picked = Array.from(charFile.files ?? []);
      charFile.value = ''; // allow re-picking the same files
      if (picked.length) void this.importCharacterFiles(picked);
    };

    this.bindPaint();
  }

  private setTool(t: 'paint' | 'erase' | 'pick' | 'select'): void {
    this.tool = t;
    for (const [id, name] of [
      ['#pa-c-paint', 'paint'],
      ['#pa-c-erase', 'erase'],
      ['#pa-c-pick', 'pick'],
      ['#pa-c-select', 'select'],
    ] as const) {
      this.panel.querySelector<HTMLButtonElement>(id)!.classList.toggle('on', t === name);
    }
  }

  // ── Gallery (character management) ───────────────────────────────
  private drawPreview(cv: HTMLCanvasElement, c: LoadedCharacterData): void {
    const frame = c.down?.[1] ?? c.down?.[0];
    const w = frame?.[0]?.length ?? 16;
    const h = frame?.length ?? 32;
    cv.width = w;
    cv.height = h;
    const ctx = cv.getContext('2d')!;
    if (!frame) return;
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

  private renderCategoryTabs(): void {
    const host = this.panel.querySelector<HTMLDivElement>('#pa-c-cats');
    if (!host) return;
    host.innerHTML = '';
    if (this.opts.categories.length < 2) return; // no toggle needed for a single category
    this.opts.categories.forEach((c, i) => {
      const b = document.createElement('button');
      b.className = 'tab' + (i === this.catIndex ? ' on' : '');
      b.textContent = c.label;
      b.onclick = () => {
        if (i === this.catIndex) return;
        this.catIndex = i;
        this.renderGallery();
      };
      host.appendChild(b);
    });
  }

  private renderGallery(): void {
    this.renderCategoryTabs();
    const cat = this.cat();
    const tpl = cat.getTemplates() ?? [];
    // New is only offered for categories that allow creating entities.
    this.panel.querySelector<HTMLButtonElement>('#pa-c-newbtn')!.style.display = cat.canCreate ? '' : 'none';
    this.cardsHost.innerHTML = '';
    tpl.forEach((c, i) => {
      const id = c.id;
      const card = document.createElement('div');
      card.className = 'card';
      const cv = document.createElement('canvas');
      this.drawPreview(cv, c.data);
      const nm = document.createElement('div');
      nm.className = 'nm';
      nm.textContent = skinLabel(c, tpl);
      const edit = document.createElement('button');
      edit.textContent = 'Edit';
      edit.onclick = () => {
        this.loadChar(i);
        this.showEdit();
      };
      const buttons: HTMLButtonElement[] = [edit];
      if (cat.canCreate) {
        const copy = document.createElement('button');
        copy.textContent = 'Copy';
        copy.onclick = () => {
          this.createNew(i);
          this.showEdit();
        };
        buttons.push(copy);
      }
      const third = document.createElement('button');
      const isUser = cat.canCreate && !cat.isBundled(id);
      third.textContent = isUser ? 'Delete' : 'Reset';
      if (isUser) third.className = 'del';
      third.title = isUser ? 'Delete this entry' : 'Reset to bundled default';
      third.onclick = async () => {
        if (isUser && !(await confirmDialog(`Delete ${nm.textContent}?`, { danger: true, confirmLabel: 'Delete' })))
          return;
        cat.reset(id);
        window.setTimeout(() => this.renderGallery(), 250);
      };
      buttons.push(third);
      card.append(cv, nm, ...buttons);
      this.cardsHost.appendChild(card);
    });
  }

  // ── Editing ──────────────────────────────────────────────────────
  /** Load an existing character into the editor (clamped to range). */
  private loadChar(index: number): void {
    const tpl = this.cat().getTemplates() ?? [];
    if (tpl.length === 0) return;
    this.charIndex = Math.max(0, Math.min(index, tpl.length - 1));
    this.charId = tpl[this.charIndex].id;
    this.work = cloneChar(tpl[this.charIndex].data);
    this.afterLoad();
  }

  /** Reload the entity with id `id` after a save/broadcast (keeps it selected). */
  private loadCharById(id: string): void {
    const tpl = this.cat().getTemplates() ?? [];
    const i = tpl.findIndex((t) => t.id === id);
    if (i >= 0) this.loadChar(i);
  }

  /** Create a new character, copied from `srcIndex` or blank. */
  private createNew(srcIndex: number | null): void {
    const tpl = this.cat().getTemplates() ?? [];
    this.charIndex = tpl.length;
    this.charId = this.cat().newId(tpl.map((t) => t.id));
    if (srcIndex !== null && tpl[srcIndex]) {
      this.work = cloneChar(tpl[srcIndex].data);
    } else {
      // Fresh blank characters start at the default 16×32 (resizable in-editor).
      this.W = 16;
      this.H = 32;
      const blank = (): SpriteData[] =>
        Array.from({ length: this.cat().blankFrames }, () => emptyFrame(this.W, this.H));
      this.work = { down: blank(), up: blank(), right: blank() };
    }
    this.work.name = undefined;
    this.afterLoad();
  }

  private afterLoad(): void {
    const f0 = this.work.down[1] ?? this.work.down[0];
    if (f0) {
      this.H = f0.length;
      this.W = f0[0]?.length ?? 16;
    }
    this.ensureSpec(); // normalise work.spec against the frame arrays
    // Pet categories carry a spawn config; others must not. Normalise so every
    // field (incl. behaviours back-filled for older saves) is present + clamped.
    if (this.cat().spawnConfig) this.work.petConfig = resolvePetConfig(this.work.petConfig);
    else this.work.petConfig = undefined;
    // Pets have no typed display name — derive it from the roster slot so the
    // server-mandatory name is present and Save isn't wrongly disabled.
    if (this.cat().derivedName) this.work.name = this.work.name?.trim() || this.charName();
    this.frame = Math.min(this.frame, this.dirFrames(this.dir).length - 1);
    if (this.nameEl) this.nameEl.value = this.work.name ?? '';
    this.selection = null;
    this.syncSizeInputs();
    this.dirty = false;
    if (this.view === 'edit') this.render();
  }

  /** pet kind ('dog'/'cat'/'duck') parsed from the roster slot (`dog_0`), or
   *  null for non-pet categories. Used to show only kind-relevant behaviours. */
  private petKind(): string | null {
    if (!this.cat().spawnConfig) return null;
    return this.charName().split('_')[0] || null;
  }

  /** Show + populate the pet spawn-config + behaviour rows (hidden for agents). */
  private renderConfigRow(): void {
    const row = this.panel.querySelector<HTMLDivElement>('#pa-c-petcfg');
    const behavRow = this.panel.querySelector<HTMLDivElement>('#pa-c-petbehav');
    if (!row) return;
    const cfg = this.work.petConfig;
    row.style.display = cfg ? 'flex' : 'none';
    if (behavRow) behavRow.style.display = cfg ? 'flex' : 'none';
    if (!cfg) return;
    const set = (id: string, v: string | boolean): void => {
      const el = this.panel.querySelector<HTMLInputElement>(id);
      if (!el) return;
      if (typeof v === 'boolean') el.checked = v;
      else el.value = v;
    };
    set('#pa-c-active', cfg.active);
    set('#pa-c-spmin', String(cfg.minSec));
    set('#pa-c-spmax', String(cfg.maxSec));
    set('#pa-c-spconc', String(cfg.maxConcurrent));
    // All checkboxes carry the live value; only kind-relevant labels are shown.
    set('#pa-c-brest', cfg.behaviors.rest);
    set('#pa-c-bdrink', cfg.behaviors.drink);
    set('#pa-c-btalk', cfg.behaviors.talk);
    set('#pa-c-bchase', cfg.behaviors.chaseCats);
    set('#pa-c-bflee', cfg.behaviors.fleeDogs);
    const kind = this.petKind();
    const showLabel = (id: string, show: boolean): void => {
      const el = this.panel.querySelector<HTMLLabelElement>(id);
      if (el) el.style.display = show ? '' : 'none';
    };
    showLabel('#pa-c-bchase-l', kind === 'dog');
    showLabel('#pa-c-bflee-l', kind === 'cat');
  }

  private syncSizeInputs(): void {
    const w = this.panel?.querySelector<HTMLInputElement>('#pa-c-w');
    const h = this.panel?.querySelector<HTMLInputElement>('#pa-c-h');
    if (w) w.value = String(this.W);
    if (h) h.value = String(this.H);
  }

  /** Resize every frame (all directions) to w×h, keeping the top-left pixels
   *  (crop on shrink, pad with transparent on grow). */
  private resizeWork(w: number, h: number): boolean {
    if (this.sheetCells(this.baseLen(), w, h) > MAX_SHEET_CELLS) {
      this.showStatus(`${w}×${h} across ${this.baseLen()} frames is more pixels than one sheet may hold`);
      this.syncSizeInputs(); // put the boxes back to the size that is still in force
      return false;
    }
    const resizeFrame = (f: SpriteData): SpriteData => {
      const out = emptyFrame(w, h);
      for (let y = 0; y < Math.min(h, f.length); y++) {
        for (let x = 0; x < Math.min(w, f[y]?.length ?? 0); x++) out[y][x] = f[y][x];
      }
      return out;
    };
    const resizeFrames = (frames: SpriteData[]): SpriteData[] => frames.map(resizeFrame);
    this.work.down = resizeFrames(this.work.down);
    this.work.up = resizeFrames(this.work.up);
    this.work.right = resizeFrames(this.work.right);
    if (this.work.left) this.work.left = resizeFrames(this.work.left);
    this.W = w;
    this.H = h;
    if (this.work.spec) this.work.spec.frame = { w, h };
    this.selection = null; // coords no longer valid after a resize
    this.syncSizeInputs();
    return true;
  }

  /**
   * How many pixel cells the sheet holds across every direction row — the number the payload
   * bound is on (`MAX_SHEET_CELLS`).
   *
   * Checked here, before anything is sent, because the server's ceiling is enforced by the
   * TRANSPORT: an oversized save does not come back as a refusal, it closes the connection
   * (`RangeError: Max payload size exceeded`, close code 1009) and the work is gone. A message
   * the user can read beats that, so the editor refuses first and the guard is the backstop.
   */
  private sheetCells(frames = this.baseLen(), w = this.W, h = this.H): number {
    const rows = 3 + (this.work.left ? 1 : 0); // left is written on save, so count it either way
    return frames * w * h * Math.max(4, rows);
  }

  /** Canonical frame count (down/up/right stay equal length). */
  private baseLen(): number {
    return this.work.down.length;
  }

  private spec(): CharacterSpec {
    return this.work.spec!;
  }

  /** Ensure work.spec is present and consistent with the frame arrays. Uses the
   *  loaded spec verbatim when its tracks sum to the frame count and only name
   *  known tracks; otherwise derives the historical layout. Keeps frame size. */
  private ensureSpec(): void {
    const fc = this.work.down.length;
    const sp = this.work.spec;
    const knownNames = (t: CharacterTrack): boolean =>
      this.trackDefs().some((d) => d.name === t.name) || TOLERATED_TRACK_NAMES.has(t.name);
    const usable = sp && specFrameCount(sp) === fc && sp.tracks.every(knownNames) && sp.tracks.length > 0;
    const tracks = usable ? sp!.tracks.map((t) => ({ ...t })) : deriveSpecTracks(fc, this.trackDefs());
    this.work.spec = { frame: { w: this.W, h: this.H }, tracks };
  }

  private insertFrameAt(i: number): void {
    for (const d of ['down', 'up', 'right'] as const) this.work[d].splice(i, 0, emptyFrame(this.W, this.H));
    if (this.work.left) this.work.left.splice(i, 0, emptyFrame(this.W, this.H));
  }
  private removeFrameAt(i: number): void {
    for (const d of ['down', 'up', 'right'] as const) this.work[d].splice(i, 1);
    if (this.work.left) this.work.left.splice(i, 1);
  }

  /** Add a frame to a track (creating an optional track if currently absent). */
  private addTrackFrame(name: string): void {
    if (this.work.down.length >= this.trackDefs().length * MAX_TRACK_FRAMES) return;
    if (this.sheetCells(this.baseLen() + 1) > MAX_SHEET_CELLS) {
      this.showStatus(`Too many pixels for one sheet at ${this.W}×${this.H} — remove a frame or use a smaller size`);
      return;
    }
    const slots = specSlots(this.spec(), this.trackDefs());
    const slot = slots.find((s) => s.name === name);
    if (slot) {
      if (slot.count >= MAX_TRACK_FRAMES) return;
      this.insertFrameAt(slot.start + slot.count);
      this.spec().tracks.find((t) => t.name === name)!.frames += 1;
      this.frame = slot.start + slot.count; // select the new frame
    } else {
      const def = this.trackDefs().find((d) => d.name === name);
      if (!def) return;
      this.insertFrameAt(this.work.down.length); // optional tracks live at the end
      this.spec().tracks.push({ name, frames: 1, play: def.play });
      this.frame = this.work.down.length - 1;
    }
    this.dirty = true;
    this.render();
  }

  /** Remove a frame from a track; drops the track when an optional one hits 0. */
  private removeTrackFrame(name: string): void {
    const def = this.trackDefs().find((d) => d.name === name);
    const slot = specSlots(this.spec(), this.trackDefs()).find((s) => s.name === name);
    if (!def || !slot || slot.count <= def.min) return;
    this.removeFrameAt(slot.start + slot.count - 1);
    const t = this.spec().tracks.find((x) => x.name === name)!;
    t.frames -= 1;
    if (t.frames === 0) this.spec().tracks = this.spec().tracks.filter((x) => x.name !== name);
    this.frame = Math.min(this.frame, this.work.down.length - 1);
    this.dirty = true;
    // Don't keep previewing a pose whose frames just went away.
    if (this.previewPose === name && !this.spec().tracks.some((x) => x.name === name)) {
      this.setPreviewPose('walk');
    }
    this.render();
  }

  private toggleTrackPlay(name: string): void {
    const t = this.spec().tracks.find((x) => x.name === name);
    if (!t) return;
    t.play = t.play === 'pingpong' ? 'loop' : 'pingpong';
    this.dirty = true;
    if (this.previewPose === name) this.startPreview();
    this.render();
  }

  private setPreviewPose(pose: PreviewPose): void {
    this.previewPose = pose;
    const sel = this.panel.querySelector<HTMLSelectElement>('#pa-c-pose');
    if (sel) sel.value = pose;
    this.startPreview();
  }

  /** Render the per-track frame controls (count, +/-, play mode). */
  private renderTracks(): void {
    const host = this.panel.querySelector<HTMLDivElement>('#pa-c-tracks');
    if (!host) return;
    host.innerHTML = '';
    const slots = specSlots(this.spec(), this.trackDefs());
    for (const def of this.trackDefs()) {
      const slot = slots.find((s) => s.name === def.name);
      const row = document.createElement('div');
      row.className = 'trackrow';
      if (!slot) {
        const add = document.createElement('button');
        add.textContent = `＋ ${def.label} track`;
        add.onclick = () => this.addTrackFrame(def.name);
        row.appendChild(add);
      } else {
        const nm = document.createElement('span');
        nm.className = 'tname';
        nm.textContent = def.label;
        const minus = document.createElement('button');
        minus.textContent = '−';
        minus.disabled = slot.count <= def.min;
        minus.onclick = () => this.removeTrackFrame(def.name);
        const cnt = document.createElement('span');
        cnt.className = 'tcount';
        cnt.textContent = `${slot.count}f`;
        const plus = document.createElement('button');
        plus.textContent = '+';
        plus.disabled = slot.count >= MAX_TRACK_FRAMES;
        plus.onclick = () => this.addTrackFrame(def.name);
        const play = document.createElement('button');
        play.className = 'play';
        play.textContent = slot.play === 'pingpong' ? '⇄ ping-pong' : '→ loop';
        play.title = 'Toggle playback order';
        play.onclick = () => this.toggleTrackPlay(def.name);
        row.append(nm, minus, cnt, plus, play);
      }
      host.appendChild(row);
    }
  }

  // ── New-character dialog (visual copy-from picker) ───────────────
  private openNewDialog(): void {
    const grid = this.panel.querySelector<HTMLDivElement>('#pa-c-newgrid')!;
    grid.innerHTML = '';
    const tpl = this.cat().getTemplates() ?? [];
    tpl.forEach((c, i) => {
      const opt = document.createElement('div');
      opt.className = 'opt';
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
      const lab = document.createElement('span');
      lab.textContent = skinLabel(c, tpl);
      opt.append(cv, lab);
      opt.onclick = () => {
        this.createNew(i);
        this.closeNewDialog();
        this.showEdit();
      };
      grid.appendChild(opt);
    });
    const blank = document.createElement('div');
    blank.className = 'opt';
    const bx = document.createElement('div');
    bx.className = 'blank';
    bx.textContent = '∅';
    const blab = document.createElement('span');
    blab.textContent = 'Blank';
    blank.append(bx, blab);
    blank.onclick = () => {
      this.createNew(null);
      this.closeNewDialog();
      this.showEdit();
    };
    grid.appendChild(blank);
    this.panel.querySelector<HTMLDivElement>('#pa-c-newdlg')!.classList.add('show');
  }
  private closeNewDialog(): void {
    this.panel.querySelector<HTMLDivElement>('#pa-c-newdlg')!.classList.remove('show');
  }

  private charName(): string {
    return this.charId;
  }

  /** Frames for a direction; `left` mirrors `right` until explicitly edited. */
  private dirFrames(d: Dir): SpriteData[] {
    if (d === 'left') return this.work.left ?? this.work.right.map(flipH);
    return this.work[d];
  }

  /** Materialise `left` (seeded from mirrored right) so edits persist + save. */
  private ensureLeft(): SpriteData[] {
    if (!this.work.left) this.work.left = this.work.right.map(flipH);
    return this.work.left;
  }

  private showStatus(text: string): void {
    const el = this.panel.querySelector<HTMLSpanElement>('#pa-c-status');
    if (!el) return;
    el.textContent = text;
    el.style.opacity = '1';
    window.setTimeout(() => (el.style.opacity = '0'), 1600);
  }

  private displayName(): string {
    return this.work.name || this.charName();
  }
  private doSave(): void {
    // A name is mandatory (also enforced server-side). Guard in case the button
    // is somehow reached while empty.
    if (!this.work.name?.trim()) {
      this.showStatus('Name required before saving');
      this.nameEl.focus();
      return;
    }
    // Last check before it goes out: the server would refuse this too, but its ceiling is the
    // transport's, and that one answers with a closed socket rather than a message.
    if (this.sheetCells() > MAX_SHEET_CELLS) {
      this.showStatus('Sheet too large to save — fewer frames or a smaller frame size');
      return;
    }
    // Persist the current frame size + track layout with the sprite data.
    if (this.work.spec) this.work.spec.frame = { w: this.W, h: this.H };
    // Left is a row like any other, so it is saved even when nobody painted it: the
    // mirror is the SEED for one (see ensureLeft), and materialising it here is what
    // keeps three-row data from being written ever again. Draw over it any time — an
    // asymmetric detail is exactly what a mirror gets wrong.
    this.ensureLeft();
    const id = this.charId;
    // Encoding is asynchronous (a canvas has no synchronous way to hand over PNG bytes), so
    // the status line says "saved" only once the message is actually on its way.
    void (async () => {
      let png: Uint8Array<ArrayBuffer>;
      try {
        png = await encodeSheetPng(
          { down: this.work.down, up: this.work.up, right: this.work.right, left: this.work.left! },
          this.W,
          this.H,
        );
      } catch (err) {
        this.showStatus(`Could not encode the sheet: ${err instanceof Error ? err.message : 'unknown error'}`);
        return;
      }
      const out = await this.cat().save(this.charName(), {
        png,
        name: this.work.name!,
        ...(this.work.spec ? { spec: this.work.spec } : {}),
        ...(this.work.petConfig ? { petConfig: this.work.petConfig } : {}),
      });
      if (!out.ok) {
        // The whole point of saving over HTTP: a refusal has a reason and it belongs on screen.
        this.showStatus(`Not saved: ${out.error}`);
        return;
      }
      this.dirty = false;
      this.showStatus(`Saved ${this.displayName()} ✓`);
      // After the broadcast lands, reload the entry as a normal (existing) one.
      window.setTimeout(() => this.loadCharById(id), 250);
    })();
  }

  /** Download a PNG sheet (down/up/right rows × frames, 16×32) for the repo.
   *  Left is mirrored from right on load, so it isn't part of the file. */
  private doExport(): void {
    // Four rows: the sheet IS the art, so it carries every side. Left is filled from a
    // mirrored right when it was never painted, once, here — not on every load.
    this.ensureLeft();
    const base = this.work.name || this.charName();
    void (async () => {
      // The same encoder the save uses: an exported sheet is meant to be droppable into
      // assets/characters, so the two must not be able to differ.
      const png = await encodeSheetPng(
        { down: this.work.down, up: this.work.up, right: this.work.right, left: this.work.left! },
        this.W,
        this.H,
      );
      const a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob([png], { type: 'image/png' }));
      a.download = `${base}.png`;
      a.click();
      URL.revokeObjectURL(a.href);
    })();

    // For non-default layouts (custom size or track counts), also emit the
    // sibling manifest so the bundled PNG re-imports 1:1 (drop both next to each
    // other as char_N.png + char_N.json). Default-layout chars need no manifest.
    if (this.isDefaultLayout()) {
      this.showStatus('Exported PNG (4 rows: front, back, right, left)');
      return;
    }
    const spec: CharacterSpec = { frame: { w: this.W, h: this.H }, tracks: this.spec().tracks.map((t) => ({ ...t })) };
    const blob = new Blob([JSON.stringify(spec, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const m = document.createElement('a');
    m.href = url;
    m.download = `${base}.json`;
    m.click();
    URL.revokeObjectURL(url);
    this.showStatus('Exported PNG + manifest (rename both to char_N.*)');
  }

  /** Inverse of doExport: rebuild this character from an exported sheet
   *  (`<name>.png`) plus its optional sibling manifest (`<name>.json`). The
   *  manifest supplies the frame size + track layout; without one the export
   *  contract implies the default layout, which is all a bare PNG can encode.
   *  `left` is dropped so it re-mirrors from `right`, matching what export wrote. */
  private async importCharacterFiles(files: File[]): Promise<void> {
    const isJson = (f: File): boolean => /\.json$/i.test(f.name) || f.type === 'application/json';
    const png = files.find((f) => !isJson(f));
    const manifest = files.find(isJson);
    if (!png) {
      this.showStatus('Pick the exported .png (plus its .json)');
      return;
    }
    let spec: CharacterSpec | null = null;
    if (manifest) {
      try {
        spec = resolveCharacterSpec(JSON.parse(await manifest.text()));
      } catch {
        this.showStatus(`${manifest.name} is not valid JSON`);
        return;
      }
    }
    let img: HTMLImageElement;
    try {
      img = await loadImage(png);
    } catch {
      this.showStatus('Could not load image');
      return;
    }
    if (!spec) {
      // No manifest ⇒ the default 16×32 layout; only the frame count is free,
      // and it follows from the sheet width. Any other geometry is ambiguous.
      const { w, h } = DEFAULT_CHARACTER_SPEC.frame;
      const rowsInFile = h > 0 ? img.naturalHeight / h : 0;
      if (!(rowsInFile === DIRS.length || rowsInFile === SHEET_ROWS.length) || img.naturalWidth % w !== 0 || img.naturalWidth === 0) {
        this.showStatus('Frame size unknown — include the exported .json');
        return;
      }
      spec = { frame: { w, h }, tracks: deriveSpecTracks(img.naturalWidth / w, this.trackDefs()) };
    }
    const { w, h } = spec.frame;
    const frames = specFrameCount(spec);
    if (frames > MAX_FRAMES) {
      this.showStatus(`Too many frames (${frames}, max ${MAX_FRAMES})`);
      return;
    }
    if (img.naturalWidth < frames * w || img.naturalHeight < SHEET_ROWS.length * h) {
      this.showStatus(`Sheet too small — need ${frames * w}×${SHEET_ROWS.length * h}px`);
      return;
    }
    if (
      !(await confirmDialog(`Replace ${this.displayName()} with ${png.name}?`, {
        danger: true,
        confirmLabel: 'Replace',
      }))
    )
      return;

    const px = imagePixels(img);
    this.W = w;
    this.H = h;
    // Take every row the sheet has: a four-row sheet carries authored left art, and
    // throwing it away (which this used to do) loses work on a round trip through an
    // external editor — the very thing export/import exists for.
    const rowsPresent = Math.min(DIRS.length, Math.max(1, Math.floor(img.naturalHeight / h)));
    DIRS.slice(0, rowsPresent).forEach((dir, row) => {
      this.work[dir] = Array.from({ length: frames }, (_, f) => gridFromImageData(px, f * w, row * h, w, h));
    });
    if (rowsPresent < DIRS.length) delete this.work.left;
    this.work.spec = spec;
    this.ensureSpec(); // re-derives if the manifest names tracks this category doesn't know
    this.frame = Math.min(this.frame, frames - 1);
    this.selection = null;
    this.syncSizeInputs();
    this.dirty = true;
    this.render();
    this.startPreview();
    this.showStatus(
      manifest ? `Imported ${frames} frames · ${w}×${h} ✓` : `Imported ${frames} frames · default layout ✓`,
    );
  }

  /** True when the spec equals the historical default (16×32, walk3/type2/read2,
   *  no coffee) — such a character needs no sibling manifest. */
  private isDefaultLayout(): boolean {
    if (this.W !== 16 || this.H !== 32) return false;
    const t = this.spec().tracks;
    return (
      t.length === 3 &&
      t[0].name === 'walk' && t[0].frames === 3 && t[0].play === 'pingpong' &&
      t[1].name === 'typing' && t[1].frames === 2 && t[1].play === 'loop' &&
      t[2].name === 'reading' && t[2].frames === 2 && t[2].play === 'loop'
    );
  }

  // ── Rendering ────────────────────────────────────────────────────
  private render(): void {
    // Direction tab highlight
    this.panel.querySelectorAll<HTMLButtonElement>('#pa-c-dirs button').forEach((b) => {
      b.classList.toggle('on', b.dataset.dir === this.dir);
    });
    // Per-track frame controls (add/remove frames, play mode).
    this.renderTracks();
    // A name is mandatory to save (mirrors the server-side check). Pets derive
    // theirs from the roster slot, so their name field is hidden and the gate
    // always passes.
    const derivedName = !!this.cat().derivedName;
    this.nameEl.style.display = derivedName ? 'none' : '';
    const saveBtn = this.panel.querySelector<HTMLButtonElement>('#pa-c-save')!;
    const hasName = !!this.work.name?.trim();
    saveBtn.disabled = !hasName;
    saveBtn.title = hasName ? '' : 'Enter a name first';
    this.renderConfigRow();
    this.renderPoseOptions();
    this.renderStrip();
    this.renderPaint();
    this.updateImportTarget();
  }

  private drawFrameTo(ctx: CanvasRenderingContext2D, f: SpriteData, cell: number, alpha = 1): void {
    ctx.globalAlpha = alpha;
    for (let y = 0; y < f.length; y++) {
      for (let x = 0; x < f[y].length; x++) {
        const c = f[y][x];
        if (!c) continue;
        ctx.fillStyle = c;
        ctx.fillRect(x * cell, y * cell, cell, cell);
      }
    }
    ctx.globalAlpha = 1;
  }

  /** On-screen pixels per sprite pixel for the paint canvas, shrunk so large
   *  frames still fit the panel (≈340px wide / ≈460px tall budget). */
  private paintCell(): number {
    return Math.max(2, Math.min(CELL, Math.floor(340 / this.W), Math.floor(460 / this.H)));
  }
  /** Scale for the frame-strip thumbnails (keeps them ≈56px tall). */
  private stripCell(): number {
    return Math.max(1, Math.min(3, Math.round(56 / this.H)));
  }

  private renderStrip(): void {
    const frames = this.dirFrames(this.dir);
    const sc = this.stripCell();
    this.strip.innerHTML = '';
    frames.forEach((f, i) => {
      const wrap = document.createElement('div');
      wrap.className = 'fr' + (i === this.frame ? ' sel' : '');
      const c = document.createElement('canvas');
      c.width = this.W * sc;
      c.height = this.H * sc;
      this.drawFrameTo(c.getContext('2d')!, f, sc);
      const lab = document.createElement('span');
      lab.textContent = frameLabelFor(this.spec(), i, this.trackDefs());
      wrap.appendChild(c);
      wrap.appendChild(lab);
      wrap.onclick = () => {
        this.frame = i;
        this.render();
      };
      this.strip.appendChild(wrap);
    });
  }

  private renderPaint(): void {
    const cell = this.paintCell();
    this.canvas.width = this.W * cell;
    this.canvas.height = this.H * cell;
    const ctx = this.canvas.getContext('2d')!;
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    // Onion skin: previous frame faint.
    const frames = this.dirFrames(this.dir);
    if (this.onion && this.frame > 0) {
      this.drawFrameTo(ctx, frames[this.frame - 1], cell, 0.25);
    }
    this.drawFrameTo(ctx, frames[this.frame], cell, 1);
    // Grid
    ctx.strokeStyle = 'rgba(255,255,255,0.06)';
    for (let x = 0; x <= this.W; x++) {
      ctx.beginPath();
      ctx.moveTo(x * cell, 0);
      ctx.lineTo(x * cell, this.H * cell);
      ctx.stroke();
    }
    for (let y = 0; y <= this.H; y++) {
      ctx.beginPath();
      ctx.moveTo(0, y * cell);
      ctx.lineTo(this.W * cell, y * cell);
      ctx.stroke();
    }
    if (this.selection) {
      const s = this.selection;
      ctx.strokeStyle = '#ffd34d';
      ctx.lineWidth = 2;
      ctx.setLineDash([4, 3]);
      ctx.strokeRect(s.x * cell, s.y * cell, s.w * cell, s.h * cell);
      ctx.setLineDash([]);
      ctx.lineWidth = 1;
    }
    this.renderPreview(); // reflect edits live in the preview
  }

  /** Paste the shared clipboard into the current frame at the selection's
   *  top-left (or 0,0). 'left' is materialised first so edits persist. */
  private doPaste(): void {
    if (!hasClipboard()) {
      this.showStatus('Nothing copied yet');
      return;
    }
    const frames = this.dir === 'left' ? this.ensureLeft() : this.work[this.dir];
    const at = this.selection ?? { x: 0, y: 0, w: 0, h: 0 };
    pasteRegion(frames[this.frame], at.x, at.y);
    this.dirty = true;
    this.renderPaint();
    this.renderStrip();
    this.showStatus('Pasted ✓');
  }

  // ── Live preview ─────────────────────────────────────────────────
  /** Frame indices that make up a pose's playback loop, derived from the spec
   *  tracks (mirrors the engine's buildTrackSeq). Idle / missing track → stand. */
  private poseFrames(pose: PreviewPose): number[] {
    const slots = specSlots(this.spec(), this.trackDefs());
    const walk = slots.find((s) => s.name === 'walk');
    const stand = walk ? walk.start + Math.min(1, walk.count - 1) : 0;
    // A pose uses its same-named track if present (incl. pet `idle`), else the
    // neutral stand frame (e.g. an agent's idle has no track).
    const slot = slots.find((s) => s.name === pose);
    if (!slot) return [stand];
    const seq: number[] = [];
    for (let i = 0; i < slot.count; i++) seq.push(slot.start + i);
    if (slot.play === 'pingpong' && seq.length > 2) {
      for (let i = slot.count - 2; i >= 1; i--) seq.push(slot.start + i);
    }
    return seq;
  }
  /** Per-frame duration (ms) for the preview; 0 = static. Other tracks (sit,
   *  sleep, …) animate at a default cadence. */
  /**
   * How fast the preview cycles: exactly what the world does.
   *
   * This used to be a hand-written table, and it disagreed — walk ran at 150 ms against the game's
   * 75, so every author judged their walk cycle at half speed. The numbers come from the engine's
   * constants now (`shared/office/poseCadence.ts`), per kind, because a pet is animated on the
   * server at its own cadence (120 ms for walk, not 75).
   *
   * A pose the world never animates — a character's idle, a pet's sleep — still needs to cycle
   * here or authored frames could not be seen at all; `previewFrameMs` is where that fallback is
   * named and kept out of the renderer.
   */
  private poseDurationMs(pose: PreviewPose): number {
    return previewFrameMs(pose, this.cat().spawnConfig ? 'pet' : 'character');
  }

  /** Populate the preview pose dropdown from the present tracks (+ idle),
   *  repairing the selection when the current pose no longer exists. */
  private renderPoseOptions(): void {
    const sel = this.panel.querySelector<HTMLSelectElement>('#pa-c-pose');
    if (!sel) return;
    const present = this.spec().tracks.map((t) => t.name);
    const names: string[] = [];
    for (const d of this.trackDefs()) if (present.includes(d.name)) names.push(d.name);
    if (!names.includes('idle')) names.push('idle');
    const label = (n: string): string =>
      this.trackDefs().find((d) => d.name === n)?.label ?? n.charAt(0).toUpperCase() + n.slice(1);
    sel.innerHTML = names.map((n) => `<option value="${n}">${label(n)}</option>`).join('');
    if (!names.includes(this.previewPose)) {
      this.previewPose = names.includes('walk') ? 'walk' : names[0];
      this.startPreview();
    }
    sel.value = this.previewPose;
  }

  private startPreview(): void {
    this.stopPreview();
    this.previewFrameIdx = 0;
    this.renderPreview();
    const ms = this.poseDurationMs(this.previewPose);
    if (ms > 0 && this.poseFrames(this.previewPose).length > 1) {
      this.previewTimer = window.setInterval(() => {
        this.previewFrameIdx++;
        this.renderPreview();
      }, ms);
    }
  }
  private stopPreview(): void {
    if (this.previewTimer !== undefined) {
      window.clearInterval(this.previewTimer);
      this.previewTimer = undefined;
    }
  }

  /** Draw the current pose/direction frame into the preview canvas (native size;
   *  CSS scales it up crisply, bottom-anchored like the in-game sprite). */
  private renderPreview(): void {
    const cv = this.previewCanvas;
    if (!cv) return;
    const frames = this.dirFrames(this.dir);
    const seq = this.poseFrames(this.previewPose);
    const idx = seq[this.previewFrameIdx % seq.length];
    const sprite = frames[idx] ?? frames[frames.length - 1];
    cv.width = this.W;
    cv.height = this.H;
    const ctx = cv.getContext('2d')!;
    ctx.clearRect(0, 0, this.W, this.H);
    if (sprite) this.drawFrameTo(ctx, sprite, 1);
  }

  // ── PNG sheet import ─────────────────────────────────────────────
  /** Wire the (left-docked) import panel: file load, grid inputs, zoom and the
   *  hover/click cell picker. The picked cell drops into the selected frame. */
  private wireImport(): void {
    const p = this.importPanel;
    const file = p.querySelector<HTMLInputElement>('#pa-imp-file')!;
    p.querySelector<HTMLButtonElement>('#pa-imp-close')!.onclick = () => this.closeImport();
    p.querySelector<HTMLButtonElement>('#pa-imp-load')!.onclick = () => file.click();
    file.onchange = () => {
      const f = file.files?.[0];
      if (f) this.loadImportFile(f);
      file.value = '';
    };
    p.querySelector<HTMLButtonElement>('#pa-imp-zi')!.onclick = () => {
      this.imp.scale = Math.min(16, this.imp.scale + 1);
      this.renderImportCanvas();
    };
    p.querySelector<HTMLButtonElement>('#pa-imp-zo')!.onclick = () => {
      this.imp.scale = Math.max(1, this.imp.scale - 1);
      this.renderImportCanvas();
    };
    const num = (id: string, key: 'cw' | 'ch' | 'ox' | 'oy' | 'gx' | 'gy', min: number, max: number): void => {
      const el = p.querySelector<HTMLInputElement>(id)!;
      el.oninput = () => {
        this.imp[key] = Math.max(min, Math.min(max, Math.round(Number(el.value) || min)));
        this.impHover = null;
        this.renderImportCanvas();
      };
    };
    num('#pa-imp-cw', 'cw', 1, 128);
    num('#pa-imp-ch', 'ch', 1, 128);
    num('#pa-imp-ox', 'ox', 0, 4096);
    num('#pa-imp-oy', 'oy', 0, 4096);
    num('#pa-imp-gx', 'gx', 0, 256);
    num('#pa-imp-gy', 'gy', 0, 256);
    this.importCanvas.addEventListener('pointermove', (e) => {
      const c = this.cellFromPointer(e);
      if (c?.col !== this.impHover?.col || c?.row !== this.impHover?.row) {
        this.impHover = c;
        this.renderImportCanvas();
      }
    });
    this.importCanvas.addEventListener('pointerleave', () => {
      this.impHover = null;
      this.renderImportCanvas();
    });
    this.importCanvas.addEventListener('click', (e) => {
      const c = this.cellFromPointer(e);
      if (c) this.importCell(c.col, c.row);
    });
  }

  private toggleImport(): void {
    this.importOpen ? this.closeImport() : this.openImport();
  }
  private openImport(): void {
    this.importOpen = true;
    this.importPanel.style.display = 'block';
    this.updateImportTarget();
  }
  private closeImport(): void {
    this.importOpen = false;
    if (this.importPanel) this.importPanel.style.display = 'none';
  }

  private loadImportFile(f: File): void {
    loadImage(f)
      .then((img) => {
        this.importImg = img;
        // Default the cell to the character frame size; reset offset/gap so a
        // grid-aligned sheet at the same size grabs 1:1.
        this.imp.cw = this.W;
        this.imp.ch = this.H;
        this.imp.ox = 0;
        this.imp.oy = 0;
        this.imp.gx = 0;
        this.imp.gy = 0;
        this.imp.scale = Math.max(1, Math.min(8, Math.floor(360 / img.naturalWidth) || 1));
        this.impHover = null;
        this.syncImportInputs();
        this.renderImportCanvas();
      })
      .catch(() => this.showStatus('Could not load image'));
  }

  private syncImportInputs(): void {
    const set = (id: string, v: number): void => {
      const el = this.importPanel.querySelector<HTMLInputElement>(id);
      if (el) el.value = String(v);
    };
    set('#pa-imp-cw', this.imp.cw);
    set('#pa-imp-ch', this.imp.ch);
    set('#pa-imp-ox', this.imp.ox);
    set('#pa-imp-oy', this.imp.oy);
    set('#pa-imp-gx', this.imp.gx);
    set('#pa-imp-gy', this.imp.gy);
  }

  private impCols(): number {
    if (!this.importImg) return 0;
    return Math.max(0, Math.floor((this.importImg.naturalWidth - this.imp.ox + this.imp.gx) / (this.imp.cw + this.imp.gx)));
  }
  private impRows(): number {
    if (!this.importImg) return 0;
    return Math.max(0, Math.floor((this.importImg.naturalHeight - this.imp.oy + this.imp.gy) / (this.imp.ch + this.imp.gy)));
  }

  private renderImportCanvas(): void {
    const cv = this.importCanvas;
    const img = this.importImg;
    if (!img) {
      cv.width = 0;
      cv.height = 0;
      return;
    }
    const { cw, ch, ox, oy, gx, gy, scale: s } = this.imp;
    cv.width = img.naturalWidth * s;
    cv.height = img.naturalHeight * s;
    const ctx = cv.getContext('2d')!;
    ctx.imageSmoothingEnabled = false;
    ctx.clearRect(0, 0, cv.width, cv.height);
    ctx.drawImage(img, 0, 0, cv.width, cv.height);
    // Cell grid overlay.
    const cols = this.impCols();
    const rows = this.impRows();
    ctx.strokeStyle = 'rgba(122,196,255,0.5)';
    ctx.lineWidth = 1;
    for (let c = 0; c < cols; c++) {
      for (let r = 0; r < rows; r++) {
        ctx.strokeRect((ox + c * (cw + gx)) * s + 0.5, (oy + r * (ch + gy)) * s + 0.5, cw * s - 1, ch * s - 1);
      }
    }
    // Hover highlight.
    if (this.impHover) {
      const x = (ox + this.impHover.col * (cw + gx)) * s;
      const y = (oy + this.impHover.row * (ch + gy)) * s;
      ctx.fillStyle = 'rgba(47,102,176,0.35)';
      ctx.fillRect(x, y, cw * s, ch * s);
      ctx.strokeStyle = '#e2585a';
      ctx.lineWidth = 2;
      ctx.strokeRect(x + 1, y + 1, cw * s - 2, ch * s - 2);
    }
  }

  private cellFromPointer(e: PointerEvent): { col: number; row: number } | null {
    if (!this.importImg) return null;
    const r = this.importCanvas.getBoundingClientRect();
    const s = this.imp.scale;
    const px = (e.clientX - r.left) / s;
    const py = (e.clientY - r.top) / s;
    const { cw, ch, ox, oy, gx, gy } = this.imp;
    if (px < ox || py < oy) return null;
    const col = Math.floor((px - ox) / (cw + gx));
    const row = Math.floor((py - oy) / (ch + gy));
    if (col < 0 || row < 0 || col >= this.impCols() || row >= this.impRows()) return null;
    // Reject clicks that land in the gap between cells.
    if ((px - ox) - col * (cw + gx) > cw || (py - oy) - row * (ch + gy) > ch) return null;
    return { col, row };
  }

  /** Drop the chosen sheet cell into the selected frame, scaled (nearest-
   *  neighbor) to the character frame size so any cell size fits. */
  private importCell(col: number, row: number): void {
    const img = this.importImg;
    if (!img) return;
    const { cw, ch, ox, oy, gx, gy } = this.imp;
    const sx = ox + col * (cw + gx);
    const sy = oy + row * (ch + gy);
    const tmp = document.createElement('canvas');
    tmp.width = this.W;
    tmp.height = this.H;
    const tctx = tmp.getContext('2d')!;
    tctx.imageSmoothingEnabled = false;
    tctx.clearRect(0, 0, this.W, this.H);
    tctx.drawImage(img, sx, sy, cw, ch, 0, 0, this.W, this.H);
    const grid = gridFromImageData(tctx.getImageData(0, 0, this.W, this.H), 0, 0, this.W, this.H);
    const frames = this.dir === 'left' ? this.ensureLeft() : this.work[this.dir];
    frames[this.frame] = grid;
    this.dirty = true;
    this.render();
    this.showStatus(`Imported into ${DIR_LABEL[this.dir]} · ${frameLabelFor(this.spec(), this.frame, this.trackDefs())} ✓`);
  }

  private updateImportTarget(): void {
    const el = this.importPanel?.querySelector<HTMLSpanElement>('#pa-imp-target');
    if (el) el.textContent = this.importOpen ? `→ ${DIR_LABEL[this.dir]} · ${frameLabelFor(this.spec(), this.frame, this.trackDefs())}` : '';
  }

  private bindPaint(): void {
    let painting = false;
    let selStart: { x: number; y: number } | null = null;
    const at = (e: PointerEvent): { x: number; y: number } | null => {
      const r = this.canvas.getBoundingClientRect();
      const x = Math.floor(((e.clientX - r.left) / r.width) * this.W);
      const y = Math.floor(((e.clientY - r.top) / r.height) * this.H);
      if (x < 0 || y < 0 || x >= this.W || y >= this.H) return null;
      return { x, y };
    };
    const cell = (e: PointerEvent): { x: number; y: number } => {
      const r = this.canvas.getBoundingClientRect();
      const x = Math.max(0, Math.min(this.W - 1, Math.floor(((e.clientX - r.left) / r.width) * this.W)));
      const y = Math.max(0, Math.min(this.H - 1, Math.floor(((e.clientY - r.top) / r.height) * this.H)));
      return { x, y };
    };
    const apply = (e: PointerEvent): void => {
      const p = at(e);
      if (!p) return;
      if (this.tool === 'pick') {
        const c = this.dirFrames(this.dir)[this.frame][p.y][p.x];
        if (c) {
          this.color = c.slice(0, 7);
          this.panel.querySelector<HTMLInputElement>('#pa-c-color')!.value = this.color;
          this.setTool('paint');
        }
        return;
      }
      // Painting left materialises it (seeded from mirrored right) so edits persist.
      const frames = this.dir === 'left' ? this.ensureLeft() : this.work[this.dir];
      frames[this.frame][p.y][p.x] = this.tool === 'erase' ? '' : this.color;
      this.dirty = true;
      this.renderPaint();
    };
    this.canvas.addEventListener('pointerdown', (e) => {
      this.canvas.setPointerCapture(e.pointerId);
      if (this.tool === 'select') {
        selStart = cell(e);
        this.selection = rectFromCorners(selStart.x, selStart.y, selStart.x, selStart.y);
        this.renderPaint();
        return;
      }
      painting = true;
      apply(e);
    });
    this.canvas.addEventListener('pointermove', (e) => {
      if (selStart) {
        const p = cell(e);
        this.selection = rectFromCorners(selStart.x, selStart.y, p.x, p.y);
        this.renderPaint();
        return;
      }
      if (painting && this.tool !== 'pick') apply(e);
    });
    this.canvas.addEventListener('pointerup', () => {
      if (selStart) {
        selStart = null;
        if (this.selection) {
          copyRegion(this.dirFrames(this.dir)[this.frame], this.selection);
          this.showStatus(`Copied ${this.selection.w}×${this.selection.h}`);
        }
        return;
      }
      painting = false;
      this.renderStrip();
    });
  }
}
