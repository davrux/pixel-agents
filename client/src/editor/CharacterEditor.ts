import { COFFEE_FRAME_COUNT } from '@pixel/shared/office/constants.js';
import type { LoadedCharacterData } from '@pixel/shared/office/sprites/spriteData.js';
import type { SpriteData } from '@pixel/shared/office/types.js';
import { confirmDialog } from '../ui/dialog.js';

type Dir = 'down' | 'up' | 'right' | 'left';
type PreviewPose = 'idle' | 'walk' | 'typing' | 'reading' | 'coffee';

export interface CharacterEditorOpts {
  /** Current raw character frames (down/up/right per palette). */
  getTemplates: () => LoadedCharacterData[] | null;
  /** Persist an edited/new character (name `char_<i>`). */
  save: (name: string, data: LoadedCharacterData) => void;
  /** Revert/remove a character override. */
  reset: (name: string) => void;
  /** Count of bundled (file) characters; indices >= it are user-added (deletable). */
  getDefaultCount: () => number;
  /** Shared top-bar to host the button in (matches Edit/Layouts/Settings). */
  topbar?: HTMLElement;
  /** Toolbar button clicked — let the scene coordinate mutually-exclusive menus.
   *  Falls back to self-toggle when not provided. */
  requestToggle?: () => void;
}

/** Keep only printable ASCII, max 16 chars (for character display names). */
function sanitizeName(raw: string): string {
  return raw
    .replace(/[^\x20-\x7e]/g, '')
    .trim()
    .slice(0, 16);
}

const CELL = 13; // baseline on-screen pixels per sprite pixel (scaled down for large frames)
/** Max character frame dimension (px). Mirrored by the server-side validator. */
const MAX_DIM = 64;
const DIRS: Dir[] = ['down', 'up', 'right', 'left'];
const DIR_LABEL: Record<Dir, string> = { down: 'Front', up: 'Back', right: 'Right', left: 'Left' };
/** The 7 base frames (always present, may be empty): walk 0-2, type 3-4, read 5-6. */
const BASE_FRAMES = 7;
/** Defined optional frame-sets (index 7+). A set is added/removed as a whole;
 *  the renderer falls back to the idle pose when a set is absent. Add more here
 *  as new poses are defined. */
const EXT_FRAMESETS: Array<{ name: string; count: number }> = [
  { name: 'coffee', count: COFFEE_FRAME_COUNT },
];
const MAX_FRAMES = BASE_FRAMES + EXT_FRAMESETS.reduce((s, f) => s + f.count, 0);

/** How many extended frame-sets a frame array of the given length contains. */
function presentFramesets(len: number): number {
  let rest = len - BASE_FRAMES;
  let n = 0;
  for (const fs of EXT_FRAMESETS) {
    if (rest >= fs.count) {
      n++;
      rest -= fs.count;
    } else break;
  }
  return n;
}

/** Frame index → label (walk 0-2, typing 3-4, reading 5-6, then frame-sets). */
function frameLabel(i: number): string {
  if (i <= 2) return `walk ${i + 1}`;
  if (i <= 4) return `type ${i - 2}`;
  if (i <= 6) return `read ${i - 4}`;
  let idx = i - BASE_FRAMES;
  for (const fs of EXT_FRAMESETS) {
    if (idx < fs.count) return `${fs.name} ${idx + 1}`;
    idx -= fs.count;
  }
  return `frame ${i}`;
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
function cloneChar(c: LoadedCharacterData): LoadedCharacterData {
  const out: LoadedCharacterData = {
    down: c.down.map(cloneFrame),
    up: c.up.map(cloneFrame),
    right: c.right.map(cloneFrame),
  };
  if (c.left) out.left = c.left.map(cloneFrame);
  if (c.name) out.name = c.name;
  return out;
}

/**
 * In-browser pixel editor for character sprites. Edits the engine-native
 * SpriteData frames (16×32, down/up/right; left is auto-mirrored) and saves via
 * the asset-override protocol. The office re-renders live from the broadcast.
 */
export class CharacterEditor {
  private panel!: HTMLDivElement;
  private galleryPane!: HTMLDivElement;
  private editPane!: HTMLDivElement;
  private cardsHost!: HTMLDivElement;
  private canvas!: HTMLCanvasElement;
  private strip!: HTMLDivElement;
  private nameEl!: HTMLInputElement;

  private open = false;
  private view: 'gallery' | 'edit' = 'gallery';
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
  private isNew = false;
  private dir: Dir = 'down';
  private frame = 0;
  private color = '#e0b48c';
  private tool: 'paint' | 'erase' | 'pick' = 'paint';
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
  toggle(): void {
    if (this.open) void this.requestClose();
    else this.show();
  }
  show(): void {
    this.open = true;
    this.panel.style.display = 'block';
    this.showGallery();
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
      #pa-chars{position:fixed;top:3.4rem;right:0.5rem;z-index:61;display:none;width:26rem;background:#1b1f2a;
        border:2px solid #3a4150;border-radius:0.5rem;color:#eef1f6;padding:0.9rem;font-family:'FS Pixel Sans',monospace;
        box-shadow:0 4px 0 rgba(0,0,0,.4);max-height:92vh;overflow:auto;}
      #pa-chars h4{margin:0 0 0.6rem;font-size:1.25rem;color:#cdd3dd;}
      #pa-chars .row{display:flex;align-items:center;gap:0.5rem;margin:0.5rem 0;font-size:1rem;flex-wrap:wrap;}
      #pa-chars select,#pa-chars button,#pa-chars input[type=text]{background:#2a2f3a;border:1px solid #3a4150;color:#eef1f6;
        border-radius:0.3rem;font:1rem 'FS Pixel Sans',monospace;padding:0.4rem 0.6rem;cursor:pointer;}
      #pa-chars input[type=text]{cursor:text;}
      #pa-chars input[type=number]{width:3.2rem;background:#14161c;border:1px solid #3a4150;color:#eef1f6;
        border-radius:0.3rem;font:0.95rem 'FS Pixel Sans',monospace;padding:0.3rem 0.4rem;}
      #pa-chars .sizelabel{color:#9aa3b2;}
      #pa-chars .prevbox{height:5rem;min-width:3rem;padding:0.2rem;border:1px solid #3a4150;border-radius:0.3rem;
        display:flex;align-items:flex-end;justify-content:center;
        background:repeating-conic-gradient(#23262e 0% 25%, #1b1e25 0% 50%) 0/0.6rem 0.6rem;}
      #pa-chars #pa-c-preview{height:100%;width:auto;image-rendering:pixelated;}
      #pa-chars button.on{background:#3a6df0;border-color:#3a6df0;}
      #pa-chars .tab{padding:0.4rem 0.8rem;}
      #pa-chars .strip{display:flex;gap:0.35rem;flex-wrap:wrap;margin:0.5rem 0;}
      #pa-chars .strip .fr{display:flex;flex-direction:column;align-items:center;gap:0.15rem;font-size:0.75rem;color:#9aa3b2;cursor:pointer;}
      #pa-chars .strip .fr.sel canvas{outline:2px solid #3a6df0;}
      #pa-chars .strip canvas{background:#0d0f14;image-rendering:pixelated;border:1px solid #3a4150;}
      #pa-chars #pa-paint{image-rendering:pixelated;background:
        repeating-conic-gradient(#23262e 0% 25%, #1b1e25 0% 50%) 0/1rem 1rem;border:1px solid #3a4150;cursor:crosshair;touch-action:none;}
      #pa-chars .foot{display:flex;gap:0.5rem;margin-top:0.6rem;}
      #pa-chars .foot button{flex:1;padding:0.6rem;}
      #pa-chars input[type=color]{width:2.6rem;height:2rem;padding:0;border:1px solid #3a4150;background:none;cursor:pointer;}
      #pa-chars #pa-c-status{color:#7cfc9a;font-size:0.9rem;opacity:0;transition:opacity .4s;}
      #pa-chars button:disabled{opacity:0.4;cursor:not-allowed;}
      #pa-c-cards{display:flex;flex-direction:column;gap:0.5rem;}
      #pa-c-cards .card{display:flex;align-items:center;gap:0.6rem;background:#222734;border:1px solid #3a4150;
        border-radius:0.4rem;padding:0.4rem 0.6rem;}
      #pa-c-cards .card canvas{width:1.6rem;height:3.2rem;image-rendering:pixelated;background:#0d0f14;border:1px solid #3a4150;}
      #pa-c-cards .card .nm{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
      #pa-c-cards .card button{padding:0.3rem 0.55rem;font-size:0.9rem;}
      #pa-c-cards .card button.del{background:#3a2230;border-color:#6d3a4a;color:#ffd2dc;}
      #pa-c-newdlg{position:fixed;inset:0;z-index:70;display:none;background:rgba(0,0,0,.55);
        align-items:center;justify-content:center;}
      #pa-c-newdlg.show{display:flex;}
      #pa-c-newdlg .box{background:#1b1f2a;border:2px solid #3a4150;border-radius:0.5rem;padding:1rem;max-width:30rem;}
      #pa-c-newdlg h4{margin:0 0 0.7rem;font-size:1.2rem;color:#cdd3dd;}
      #pa-c-newdlg .grid{display:flex;gap:0.6rem;flex-wrap:wrap;max-width:28rem;}
      #pa-c-newdlg .grid .opt{display:flex;flex-direction:column;align-items:center;gap:0.2rem;font-size:0.8rem;
        color:#aab2c0;cursor:pointer;padding:0.3rem;border:2px solid transparent;border-radius:0.3rem;}
      #pa-c-newdlg .grid .opt:hover{border-color:#3a6df0;background:#222734;}
      #pa-c-newdlg .grid canvas{width:2.4rem;height:4.8rem;image-rendering:pixelated;background:#0d0f14;border:1px solid #3a4150;}
      #pa-c-newdlg .grid .blank{width:2.4rem;height:4.8rem;display:flex;align-items:center;justify-content:center;
        background:#0d0f14;border:1px dashed #3a4150;color:#6b7280;font-size:1.4rem;}
      #pa-c-import{position:fixed;top:3.4rem;left:0.5rem;z-index:61;display:none;max-width:30rem;background:#1b1f2a;
        border:2px solid #3a4150;border-radius:0.5rem;color:#eef1f6;padding:0.9rem;font-family:'FS Pixel Sans',monospace;
        box-shadow:0 4px 0 rgba(0,0,0,.4);max-height:92vh;overflow:auto;}
      #pa-c-import .row{display:flex;align-items:center;gap:0.4rem;margin:0.45rem 0;font-size:0.95rem;flex-wrap:wrap;}
      #pa-c-import strong{font-size:1.1rem;color:#cdd3dd;}
      #pa-c-import button{background:#2a2f3a;border:1px solid #3a4150;color:#eef1f6;border-radius:0.3rem;
        font:0.95rem 'FS Pixel Sans',monospace;padding:0.35rem 0.6rem;cursor:pointer;}
      #pa-c-import label{color:#9aa3b2;}
      #pa-c-import input[type=number]{width:3rem;background:#14161c;border:1px solid #3a4150;color:#eef1f6;
        border-radius:0.3rem;font:0.9rem 'FS Pixel Sans',monospace;padding:0.25rem 0.3rem;}
      #pa-c-import .tgt{margin-left:auto;color:#7cc4ff;font-size:0.9rem;}
      #pa-c-import .canvaswrap{overflow:auto;max-height:62vh;border:1px solid #3a4150;
        background:repeating-conic-gradient(#23262e 0% 25%, #1b1e25 0% 50%) 0/1rem 1rem;}
      #pa-c-import canvas{image-rendering:pixelated;display:block;cursor:crosshair;}
      #pa-c-import .hint{font-size:0.8rem;color:#8b93a3;margin-top:0.4rem;}
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
        <div id="pa-c-cards"></div>
        <div class="foot">
          <button id="pa-c-newbtn" class="on">＋ New character</button>
          <button id="pa-c-galclose">Close</button>
        </div>
      </div>
      <div id="pa-c-edit" style="display:none">
        <div class="row"><button id="pa-c-back">← Back</button>
          <input id="pa-c-name" type="text" maxlength="16" placeholder="char name" style="flex:1;min-width:0;"></div>
        <div class="row"><span class="sizelabel">Size</span>
          <input id="pa-c-w" type="number" min="1" max="64"><span class="sizelabel">×</span>
          <input id="pa-c-h" type="number" min="1" max="64">
          <span class="sizelabel" style="font-size:0.8rem">px · max 64×64</span></div>
        <div class="row" id="pa-c-dirs"></div>
        <div class="row">
          <div class="prevbox"><canvas id="pa-c-preview" width="16" height="32"></canvas></div>
          <span class="sizelabel">Preview</span>
          <select id="pa-c-pose" title="Animation shown in the preview">
            <option value="idle">Idle</option>
            <option value="walk" selected>Walk</option>
            <option value="typing">Typing</option>
            <option value="reading">Reading</option>
            <option value="coffee">Coffee</option>
          </select>
          <span class="sizelabel" style="font-size:0.8rem">· current direction</span>
        </div>
        <div class="strip" id="pa-c-strip"></div>
        <div class="row">
          <input id="pa-c-color" type="color" value="${this.color}">
          <button id="pa-c-paint" class="on">✏ Paint</button>
          <button id="pa-c-erase">⌫ Erase</button>
          <button id="pa-c-pick">⦿ Pick</button>
          <label style="margin-left:auto;font-size:14px;"><input id="pa-c-onion" type="checkbox" checked> Onion</label>
        </div>
        <div class="row"><canvas id="pa-paint"></canvas></div>
        <div class="row">
          <button id="pa-c-clear">Clear frame</button>
          <button id="pa-c-addframe">+ Coffee frame</button>
          <button id="pa-c-delframe">Delete frame</button>
        </div>
        <div class="row">
          <button id="pa-c-import-btn" title="Pick frames from a PNG sprite sheet">⇪ Import from PNG…</button>
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
    if (this.opts.topbar) this.opts.topbar.appendChild(btn);
    else host.appendChild(btn);
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

    // Edit wiring
    panel.querySelector<HTMLButtonElement>('#pa-c-back')!.onclick = async () => {
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
      this.resizeWork(w, h);
      this.dirty = true;
      this.render();
    };
    wEl.onchange = onSize;
    hEl.onchange = onSize;
    const colorEl = panel.querySelector<HTMLInputElement>('#pa-c-color')!;
    colorEl.oninput = () => {
      this.color = colorEl.value;
      this.setTool('paint');
    };
    panel.querySelector<HTMLButtonElement>('#pa-c-paint')!.onclick = () => this.setTool('paint');
    panel.querySelector<HTMLButtonElement>('#pa-c-erase')!.onclick = () => this.setTool('erase');
    panel.querySelector<HTMLButtonElement>('#pa-c-pick')!.onclick = () => this.setTool('pick');
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
    panel.querySelector<HTMLButtonElement>('#pa-c-addframe')!.onclick = () => this.addFrameset();
    panel.querySelector<HTMLButtonElement>('#pa-c-delframe')!.onclick = () => this.deleteFrameset();
    panel.querySelector<HTMLButtonElement>('#pa-c-save')!.onclick = () => this.doSave();
    panel.querySelector<HTMLButtonElement>('#pa-c-export')!.onclick = () => this.doExport();
    panel.querySelector<HTMLButtonElement>('#pa-c-import-btn')!.onclick = () => this.toggleImport();

    this.bindPaint();
  }

  private setTool(t: 'paint' | 'erase' | 'pick'): void {
    this.tool = t;
    for (const [id, name] of [
      ['#pa-c-paint', 'paint'],
      ['#pa-c-erase', 'erase'],
      ['#pa-c-pick', 'pick'],
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

  private renderGallery(): void {
    const tpl = this.opts.getTemplates() ?? [];
    const defaults = this.opts.getDefaultCount();
    this.cardsHost.innerHTML = '';
    tpl.forEach((c, i) => {
      const card = document.createElement('div');
      card.className = 'card';
      const cv = document.createElement('canvas');
      this.drawPreview(cv, c);
      const nm = document.createElement('div');
      nm.className = 'nm';
      nm.textContent = c.name ? `${c.name} (char_${i})` : `char_${i}`;
      const edit = document.createElement('button');
      edit.textContent = 'Edit';
      edit.onclick = () => {
        this.loadChar(i);
        this.showEdit();
      };
      const copy = document.createElement('button');
      copy.textContent = 'Copy';
      copy.onclick = () => {
        this.createNew(i);
        this.showEdit();
      };
      const third = document.createElement('button');
      const isUser = i >= defaults;
      third.textContent = isUser ? 'Delete' : 'Reset';
      if (isUser) third.className = 'del';
      third.title = isUser ? 'Delete this character' : 'Reset to bundled default';
      third.onclick = async () => {
        if (isUser && !(await confirmDialog(`Delete ${nm.textContent}?`, { danger: true, confirmLabel: 'Delete' })))
          return;
        this.opts.reset(`char_${i}`);
        window.setTimeout(() => this.renderGallery(), 250);
      };
      card.append(cv, nm, edit, copy, third);
      this.cardsHost.appendChild(card);
    });
  }

  // ── Editing ──────────────────────────────────────────────────────
  /** Load an existing character into the editor (clamped to range). */
  private loadChar(index: number): void {
    const tpl = this.opts.getTemplates() ?? [];
    if (tpl.length === 0) return;
    this.charIndex = Math.max(0, Math.min(index, tpl.length - 1));
    this.isNew = false;
    this.work = cloneChar(tpl[this.charIndex]);
    this.afterLoad();
  }

  /** Create a new character, copied from `srcIndex` or blank. */
  private createNew(srcIndex: number | null): void {
    const tpl = this.opts.getTemplates() ?? [];
    this.charIndex = tpl.length;
    this.isNew = true;
    if (srcIndex !== null && tpl[srcIndex]) {
      this.work = cloneChar(tpl[srcIndex]);
    } else {
      // Fresh blank characters start at the default 16×32 (resizable in-editor).
      this.W = 16;
      this.H = 32;
      const blank = (): SpriteData[] =>
        Array.from({ length: BASE_FRAMES }, () => emptyFrame(this.W, this.H));
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
    this.frame = Math.min(this.frame, this.dirFrames(this.dir).length - 1);
    if (this.nameEl) this.nameEl.value = this.work.name ?? '';
    this.syncSizeInputs();
    this.dirty = false;
    if (this.view === 'edit') this.render();
  }

  private syncSizeInputs(): void {
    const w = this.panel?.querySelector<HTMLInputElement>('#pa-c-w');
    const h = this.panel?.querySelector<HTMLInputElement>('#pa-c-h');
    if (w) w.value = String(this.W);
    if (h) h.value = String(this.H);
  }

  /** Resize every frame (all directions) to w×h, keeping the top-left pixels
   *  (crop on shrink, pad with transparent on grow). */
  private resizeWork(w: number, h: number): void {
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
    this.syncSizeInputs();
  }

  /** Canonical frame count (down/up/right stay equal length). */
  private baseLen(): number {
    return this.work.down.length;
  }

  /** Append the next undefined frame-set (e.g. coffee) as a whole. */
  private addFrameset(): void {
    const present = presentFramesets(this.baseLen());
    if (present >= EXT_FRAMESETS.length) return;
    const next = EXT_FRAMESETS[present];
    const firstNew = this.baseLen();
    for (let k = 0; k < next.count; k++) {
      for (const d of ['down', 'up', 'right'] as const) this.work[d].push(emptyFrame(this.W, this.H));
      if (this.work.left) this.work.left.push(emptyFrame(this.W, this.H));
    }
    this.frame = firstNew;
    this.dirty = true;
    this.render();
  }

  /** Remove the last present extended frame-set (base frames are permanent). */
  private deleteFrameset(): void {
    const present = presentFramesets(this.baseLen());
    if (present === 0) return;
    const last = EXT_FRAMESETS[present - 1];
    const start = this.baseLen() - last.count;
    for (const d of ['down', 'up', 'right'] as const) this.work[d].splice(start, last.count);
    if (this.work.left) this.work.left.splice(start, last.count);
    this.frame = Math.min(this.frame, this.baseLen() - 1);
    this.dirty = true;
    // Don't keep previewing a pose whose frames just went away.
    if (this.previewPose === 'coffee' && presentFramesets(this.baseLen()) === 0) {
      this.previewPose = 'walk';
      const sel = this.panel.querySelector<HTMLSelectElement>('#pa-c-pose');
      if (sel) sel.value = 'walk';
      this.startPreview();
    }
    this.render();
  }

  // ── New-character dialog (visual copy-from picker) ───────────────
  private openNewDialog(): void {
    const grid = this.panel.querySelector<HTMLDivElement>('#pa-c-newgrid')!;
    grid.innerHTML = '';
    const tpl = this.opts.getTemplates() ?? [];
    tpl.forEach((c, i) => {
      const opt = document.createElement('div');
      opt.className = 'opt';
      const frame = c.down?.[1] ?? c.down?.[0];
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
      lab.textContent = c.name || `char_${i}`;
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
    return `char_${this.charIndex}`;
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
    return this.work.name ? `${this.work.name} (${this.charName()})` : this.charName();
  }
  private doSave(): void {
    // A name is mandatory (also enforced server-side). Guard in case the button
    // is somehow reached while empty.
    if (!this.work.name?.trim()) {
      this.showStatus('Name required before saving');
      this.nameEl.focus();
      return;
    }
    const idx = this.charIndex;
    this.opts.save(this.charName(), this.work);
    this.dirty = false;
    this.showStatus(`Saved ${this.displayName()} ✓`);
    // After the broadcast lands, a new char becomes a normal (existing) entry.
    window.setTimeout(() => {
      this.isNew = false;
      this.loadChar(idx);
    }, 250);
  }

  /** Download a PNG sheet (down/up/right rows × frames, 16×32) for the repo.
   *  Left is mirrored from right on load, so it isn't part of the file. */
  private doExport(): void {
    const frames = this.baseLen();
    const cv = document.createElement('canvas');
    cv.width = frames * this.W;
    cv.height = 3 * this.H;
    const ctx = cv.getContext('2d')!;
    const rows: SpriteData[][] = [this.work.down, this.work.up, this.work.right];
    rows.forEach((arr, rowIdx) => {
      for (let f = 0; f < frames; f++) {
        const sprite = arr[f];
        if (!sprite) continue;
        for (let y = 0; y < this.H; y++) {
          for (let x = 0; x < this.W; x++) {
            const px = sprite[y]?.[x];
            if (px) {
              ctx.fillStyle = px;
              ctx.fillRect(f * this.W + x, rowIdx * this.H + y, 1, 1);
            }
          }
        }
      }
    });
    const a = document.createElement('a');
    a.href = cv.toDataURL('image/png');
    a.download = `${this.work.name || this.charName()}.png`;
    a.click();
    this.showStatus('Exported PNG (left mirrors right)');
  }

  // ── Rendering ────────────────────────────────────────────────────
  private render(): void {
    // Direction tab highlight
    this.panel.querySelectorAll<HTMLButtonElement>('#pa-c-dirs button').forEach((b) => {
      b.classList.toggle('on', b.dataset.dir === this.dir);
    });
    // Frame-set add/delete: a whole defined set (coffee, …) is added/removed at
    // once; base frames are permanent.
    const present = presentFramesets(this.baseLen());
    const addBtn = this.panel.querySelector<HTMLButtonElement>('#pa-c-addframe')!;
    const delBtn = this.panel.querySelector<HTMLButtonElement>('#pa-c-delframe')!;
    addBtn.disabled = present >= EXT_FRAMESETS.length || this.baseLen() >= MAX_FRAMES;
    addBtn.textContent = present < EXT_FRAMESETS.length ? `+ ${EXT_FRAMESETS[present].name} frames` : '+ frames';
    delBtn.disabled = present === 0;
    delBtn.textContent = present > 0 ? `Delete ${EXT_FRAMESETS[present - 1].name}` : 'Delete frames';
    // A name is mandatory to save (mirrors the server-side check).
    const saveBtn = this.panel.querySelector<HTMLButtonElement>('#pa-c-save')!;
    const hasName = !!this.work.name?.trim();
    saveBtn.disabled = !hasName;
    saveBtn.title = hasName ? '' : 'Enter a name first';
    // Coffee preview only makes sense once the coffee frame-set exists.
    const coffeeOpt = this.panel.querySelector<HTMLOptionElement>('#pa-c-pose option[value="coffee"]');
    if (coffeeOpt) coffeeOpt.disabled = presentFramesets(this.baseLen()) === 0;
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
      lab.textContent = frameLabel(i);
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
    this.renderPreview(); // reflect edits live in the preview
  }

  // ── Live preview ─────────────────────────────────────────────────
  /** Editor frame indices that make up an animation pose's loop. */
  private poseFrames(pose: PreviewPose): number[] {
    switch (pose) {
      case 'walk':
        return [0, 1, 2, 1];
      case 'typing':
        return [3, 4];
      case 'reading':
        return [5, 6];
      case 'coffee':
        if (presentFramesets(this.baseLen()) > 0) {
          return Array.from({ length: EXT_FRAMESETS[0].count }, (_, i) => BASE_FRAMES + i);
        }
        return [1];
      case 'idle':
      default:
        return [1];
    }
  }
  /** Per-frame duration (ms) matching the engine; 0 = static (no timer). */
  private poseDurationMs(pose: PreviewPose): number {
    switch (pose) {
      case 'walk':
        return 150;
      case 'typing':
      case 'reading':
        return 300;
      case 'coffee':
        return 500;
      default:
        return 0;
    }
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
    const url = URL.createObjectURL(f);
    const img = new Image();
    img.onload = () => {
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
      URL.revokeObjectURL(url);
    };
    img.onerror = () => {
      this.showStatus('Could not load image');
      URL.revokeObjectURL(url);
    };
    img.src = url;
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
      ctx.fillStyle = 'rgba(58,109,240,0.3)';
      ctx.fillRect(x, y, cw * s, ch * s);
      ctx.strokeStyle = '#3a6df0';
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
    const data = tctx.getImageData(0, 0, this.W, this.H).data;
    const hx = (n: number): string => n.toString(16).padStart(2, '0');
    const grid: SpriteData = [];
    for (let y = 0; y < this.H; y++) {
      const rowArr: string[] = [];
      for (let x = 0; x < this.W; x++) {
        const i = (y * this.W + x) * 4;
        const a = data[i + 3];
        rowArr.push(a === 0 ? '' : `#${hx(data[i])}${hx(data[i + 1])}${hx(data[i + 2])}${a < 255 ? hx(a) : ''}`);
      }
      grid.push(rowArr);
    }
    const frames = this.dir === 'left' ? this.ensureLeft() : this.work[this.dir];
    frames[this.frame] = grid;
    this.dirty = true;
    this.render();
    this.showStatus(`Imported into ${DIR_LABEL[this.dir]} · ${frameLabel(this.frame)} ✓`);
  }

  private updateImportTarget(): void {
    const el = this.importPanel?.querySelector<HTMLSpanElement>('#pa-imp-target');
    if (el) el.textContent = this.importOpen ? `→ ${DIR_LABEL[this.dir]} · ${frameLabel(this.frame)}` : '';
  }

  private bindPaint(): void {
    let painting = false;
    const at = (e: PointerEvent): { x: number; y: number } | null => {
      const r = this.canvas.getBoundingClientRect();
      const x = Math.floor(((e.clientX - r.left) / r.width) * this.W);
      const y = Math.floor(((e.clientY - r.top) / r.height) * this.H);
      if (x < 0 || y < 0 || x >= this.W || y >= this.H) return null;
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
      painting = true;
      this.canvas.setPointerCapture(e.pointerId);
      apply(e);
    });
    this.canvas.addEventListener('pointermove', (e) => {
      if (painting && this.tool !== 'pick') apply(e);
    });
    this.canvas.addEventListener('pointerup', () => {
      painting = false;
      this.renderStrip();
    });
  }
}
