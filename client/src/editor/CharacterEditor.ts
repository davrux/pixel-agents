import { COFFEE_FRAME_COUNT } from '@pixel/shared/office/constants.js';
import type { LoadedCharacterData } from '@pixel/shared/office/sprites/spriteData.js';
import type { SpriteData } from '@pixel/shared/office/types.js';
import { confirmDialog } from '../ui/dialog.js';

type Dir = 'down' | 'up' | 'right' | 'left';

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

const CELL = 13; // on-screen pixels per sprite pixel
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
  }

  /** True if it's safe to leave the current edit (no unsaved edits, or the user
   *  confirmed discarding them). Always true outside the edit view. */
  private async confirmDiscard(): Promise<boolean> {
    if (this.view !== 'edit' || !this.dirty) return true;
    return confirmDialog('Discard unsaved changes?', { danger: true, confirmLabel: 'Discard' });
  }

  private showGallery(): void {
    this.view = 'gallery';
    this.editPane.style.display = 'none';
    this.galleryPane.style.display = 'block';
    this.renderGallery();
  }
  private showEdit(): void {
    this.view = 'edit';
    this.galleryPane.style.display = 'none';
    this.editPane.style.display = 'block';
    this.render();
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
        <div class="row" id="pa-c-dirs"></div>
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
        <div class="row" style="justify-content:flex-end;min-height:16px;margin:0;"><span id="pa-c-status">​</span></div>
        <div class="foot">
          <button id="pa-c-save" class="on">Save</button>
          <button id="pa-c-export" title="Download a PNG sheet to add to the repo">Export</button>
        </div>
      </div>
      <div id="pa-c-newdlg"><div class="box"><h4>New character — copy from</h4><div class="grid" id="pa-c-newgrid"></div>
        <div class="row" style="justify-content:flex-end;"><button id="pa-c-newcancel">Cancel</button></div></div></div>`;

    const host = document.getElementById('game') ?? document.body;
    if (this.opts.topbar) this.opts.topbar.appendChild(btn);
    else host.appendChild(btn);
    host.appendChild(panel);
    this.panel = panel;
    this.galleryPane = panel.querySelector<HTMLDivElement>('#pa-c-gallery')!;
    this.editPane = panel.querySelector<HTMLDivElement>('#pa-c-edit')!;
    this.cardsHost = panel.querySelector<HTMLDivElement>('#pa-c-cards')!;
    this.canvas = panel.querySelector<HTMLCanvasElement>('#pa-paint')!;
    this.strip = panel.querySelector<HTMLDivElement>('#pa-c-strip')!;

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
    this.dirty = false;
    if (this.view === 'edit') this.render();
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
    this.renderStrip();
    this.renderPaint();
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

  private renderStrip(): void {
    const frames = this.dirFrames(this.dir);
    this.strip.innerHTML = '';
    frames.forEach((f, i) => {
      const wrap = document.createElement('div');
      wrap.className = 'fr' + (i === this.frame ? ' sel' : '');
      const c = document.createElement('canvas');
      c.width = this.W * 2;
      c.height = this.H * 2;
      this.drawFrameTo(c.getContext('2d')!, f, 2);
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
    this.canvas.width = this.W * CELL;
    this.canvas.height = this.H * CELL;
    const ctx = this.canvas.getContext('2d')!;
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    // Onion skin: previous frame faint.
    const frames = this.dirFrames(this.dir);
    if (this.onion && this.frame > 0) {
      this.drawFrameTo(ctx, frames[this.frame - 1], CELL, 0.25);
    }
    this.drawFrameTo(ctx, frames[this.frame], CELL, 1);
    // Grid
    ctx.strokeStyle = 'rgba(255,255,255,0.06)';
    for (let x = 0; x <= this.W; x++) {
      ctx.beginPath();
      ctx.moveTo(x * CELL, 0);
      ctx.lineTo(x * CELL, this.H * CELL);
      ctx.stroke();
    }
    for (let y = 0; y <= this.H; y++) {
      ctx.beginPath();
      ctx.moveTo(0, y * CELL);
      ctx.lineTo(this.W * CELL, y * CELL);
      ctx.stroke();
    }
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
