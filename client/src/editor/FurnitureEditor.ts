import {
  FURNITURE_CATEGORIES,
  getActiveCategories,
  getAnimationFrames,
  getCatalogByCategory,
  getCatalogEntry,
} from '@pixel/shared/office/layout/furnitureCatalog.js';
import type { SpriteData } from '@pixel/shared/office/types.js';
import { confirmDialog } from '../ui/dialog.js';

/** A raw catalog item (the buildDynamicCatalog INPUT shape, keyed by `id`). It
 *  carries group fields (groupId/orientation/state/…) we must preserve on edit. */
type RawCatalogItem = Record<string, unknown> & { id: string };

export interface FurnitureEditorOpts {
  /** The raw furniture catalog (input items with group metadata), or null. */
  getRawCatalog: () => RawCatalogItem[] | null;
  /** Persist an edited/new furniture asset (data: { sprite, catalog }). */
  save: (name: string, data: { sprite: SpriteData; catalog: Record<string, unknown> }) => void;
  /** Revert/remove a furniture override. */
  reset: (name: string) => void;
  topbar?: HTMLElement;
  /** Toolbar button clicked — let the scene coordinate mutually-exclusive menus.
   *  Falls back to self-toggle when not provided. */
  requestToggle?: () => void;
}

const TILE = 16;
const MAX_CANVAS_PX = 256;

function sanitizeId(raw: string): string {
  return raw.replace(/[^A-Za-z0-9_:-]/g, '').slice(0, 40);
}
function sanitizeLabel(raw: string): string {
  return raw.replace(/[^\x20-\x7e]/g, '').slice(0, 32);
}
function emptySprite(w: number, h: number): SpriteData {
  return Array.from({ length: h }, () => new Array<string>(w).fill(''));
}
function resizeSprite(src: SpriteData, w: number, h: number): SpriteData {
  const out = emptySprite(w, h);
  for (let y = 0; y < Math.min(h, src.length); y++) {
    for (let x = 0; x < Math.min(w, src[y].length); x++) out[y][x] = src[y][x];
  }
  return out;
}

/** One animation frame of a furniture item: its catalog id, sprite, and the
 *  original raw item (group metadata preserved on save). Static items have one. */
interface FurnFrame {
  id: string;
  sprite: SpriteData;
  base?: RawCatalogItem;
}

interface FurnWork {
  id: string;
  label: string;
  category: string;
  footprintW: number;
  footprintH: number;
  isDesk: boolean;
  canPlaceOnSurfaces: boolean;
  canPlaceOnWalls: boolean;
  backgroundTiles: number;
  /** Interaction station this furniture provides ('' = none, 'coffee', …). */
  appliance: string;
  /** Animation frames (length 1 for a static item). */
  frames: FurnFrame[];
  /** Selected frame index. */
  frameIdx: number;
  /** Animation group id when frames.length > 1, else null. */
  animGroup: string | null;
  /** The selected frame's sprite — always === frames[frameIdx].sprite (same
   *  array ref), so paint/render keep using `work.sprite` unchanged. */
  sprite: SpriteData;
  /** Original raw item (group fields preserved on save), or undefined for new. */
  base?: RawCatalogItem;
}

/**
 * In-browser furniture editor: edit an existing item's sprite + metadata (group
 * fields are preserved) or add a new single-sprite item. Saves via the asset
 * protocol; the office and the layout palette update live from the broadcast.
 */
export class FurnitureEditor {
  private panel!: HTMLDivElement;
  private galleryPane!: HTMLDivElement;
  private editPane!: HTMLDivElement;
  private cardsHost!: HTMLDivElement;
  private canvas!: HTMLCanvasElement;
  private open = false;
  private view: 'gallery' | 'edit' = 'gallery';
  private dirty = false;
  private isNew = false;
  private color = '#9b7653';
  private tool: 'paint' | 'erase' | 'pick' = 'paint';
  private cell = 12;
  private playTimer: number | null = null;
  private work: FurnWork = this.blank();

  constructor(private readonly opts: FurnitureEditorOpts) {
    this.build();
  }

  isOpen(): boolean {
    return this.open;
  }
  toggle(): void {
    this.open ? this.close() : this.show();
  }
  show(): void {
    this.open = true;
    this.panel.style.display = 'block';
    this.showGallery();
  }
  async close(): Promise<void> {
    if (!(await this.confirmDiscard())) return;
    this.stopPlay();
    this.open = false;
    this.panel.style.display = 'none';
  }

  /** Guard navigation away from unsaved edits. */
  private async confirmDiscard(): Promise<boolean> {
    if (this.view !== 'edit' || !this.dirty) return true;
    return confirmDialog('Discard unsaved changes?', { danger: true, confirmLabel: 'Discard' });
  }

  private showGallery(): void {
    this.stopPlay();
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

  private blank(): FurnWork {
    const sprite = emptySprite(TILE, TILE);
    return {
      id: '',
      label: '',
      category: 'misc',
      footprintW: 1,
      footprintH: 1,
      isDesk: false,
      canPlaceOnSurfaces: false,
      canPlaceOnWalls: false,
      backgroundTiles: 0,
      appliance: '',
      frames: [{ id: '', sprite }],
      frameIdx: 0,
      animGroup: null,
      sprite,
    };
  }

  // ── DOM ──────────────────────────────────────────────────────────
  private build(): void {
    const style = document.createElement('style');
    style.textContent = `
      #pa-furn{position:fixed;top:3.4rem;right:0.5rem;z-index:61;display:none;width:23rem;background:#1b1f2a;
        border:2px solid #3a4150;border-radius:0.5rem;color:#eef1f6;padding:0.9rem;font-family:'FS Pixel Sans',monospace;
        box-shadow:0 4px 0 rgba(0,0,0,.4);max-height:92vh;overflow:auto;}
      #pa-furn h4{margin:0 0 0.6rem;font-size:1.25rem;color:#cdd3dd;}
      #pa-furn .row{display:flex;align-items:center;gap:0.5rem;margin:0.5rem 0;font-size:1rem;flex-wrap:wrap;}
      #pa-furn label.f{flex:0 0 7rem;color:#aab2c0;}
      #pa-furn select,#pa-furn button,#pa-furn input[type=text],#pa-furn input[type=number]{background:#2a2f3a;
        border:1px solid #3a4150;color:#eef1f6;border-radius:0.3rem;font:1rem 'FS Pixel Sans',monospace;padding:0.4rem 0.6rem;cursor:pointer;}
      #pa-furn input[type=text],#pa-furn input[type=number]{cursor:text;flex:1;min-width:0;}
      #pa-furn input[type=number]{flex:0 0 4rem;}
      #pa-furn button.on{background:#3a6df0;border-color:#3a6df0;}
      #pa-furn #pa-f-frames{display:flex;gap:0.35rem;flex-wrap:wrap;flex:1;}
      #pa-furn #pa-f-frames canvas{width:2rem;height:2rem;image-rendering:pixelated;background:#0d0f14;
        border:2px solid #3a4150;border-radius:0.25rem;cursor:pointer;}
      #pa-furn #pa-f-frames canvas.on{border-color:#3a6df0;}
      #pa-furn #pa-f-paintarea{display:flex;justify-content:center;margin:0.5rem 0;}
      #pa-furn #pa-f-canvas{image-rendering:pixelated;background:
        repeating-conic-gradient(#23262e 0% 25%, #1b1e25 0% 50%) 0/1rem 1rem;border:1px solid #3a4150;cursor:crosshair;touch-action:none;}
      #pa-furn input[type=color]{width:2.6rem;height:2rem;padding:0;border:1px solid #3a4150;background:none;cursor:pointer;}
      #pa-furn .foot{display:flex;gap:0.5rem;margin-top:0.6rem;}
      #pa-furn .foot button{flex:1;padding:0.6rem;}
      #pa-furn #pa-f-status{color:#7cfc9a;font-size:0.9rem;opacity:0;transition:opacity .4s;}
      #pa-furn .chk{flex:0 0 auto;}
      #pa-furn .cathead{margin:0.7rem 0 0.2rem;font-size:0.95rem;color:#8b94a6;text-transform:uppercase;letter-spacing:0.04em;}
      /* Scroll the card list within a bounded area so the New button (above) and
         Close (below) stay on screen even with many items. */
      #pa-furn #pa-f-cards{max-height:68vh;overflow-y:auto;}
      #pa-furn #pa-f-cards .card{display:flex;align-items:center;gap:0.6rem;background:#222734;border:1px solid #3a4150;
        border-radius:0.4rem;padding:0.35rem 0.5rem;margin:0.3rem 0;}
      #pa-furn #pa-f-cards .card canvas{width:2rem;height:2rem;image-rendering:pixelated;background:#0d0f14;border:1px solid #3a4150;flex:0 0 auto;}
      #pa-furn #pa-f-cards .card .nm{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
      #pa-furn #pa-f-cards .card button{padding:0.3rem 0.55rem;font-size:0.9rem;flex:0 0 auto;}
      #pa-furn #pa-f-cards .card button.del{background:#3a2230;border-color:#6d3a4a;color:#ffd2dc;}
    `;
    document.head.appendChild(style);

    const btn = document.createElement('button');
    btn.id = 'pa-furn-btn';
    btn.className = 'pa-ui';
    btn.textContent = '🪑 Furniture';
    btn.onclick = () => (this.opts.requestToggle ? this.opts.requestToggle() : this.toggle());

    const catOpts = FURNITURE_CATEGORIES.map((c) => `<option value="${c.id}">${c.label}</option>`).join('');
    const panel = document.createElement('div');
    panel.id = 'pa-furn';
    panel.className = 'pa-ui';
    panel.innerHTML = `
      <h4>Furniture editor</h4>
      <div id="pa-f-gallery">
        <div class="row"><button id="pa-f-newbtn" class="on">＋ New furniture</button></div>
        <div id="pa-f-cards"></div>
        <div class="foot"><button id="pa-f-galclose">Close</button></div>
      </div>
      <div id="pa-f-edit" style="display:none">
      <div class="row"><button id="pa-f-back">← Back</button></div>
      <div class="row"><label class="f" for="pa-f-id">ID</label><input id="pa-f-id" type="text" maxlength="40" placeholder="MY_ITEM"></div>
      <div class="row"><label class="f" for="pa-f-label">Label</label><input id="pa-f-label" type="text" maxlength="32"></div>
      <div class="row"><label class="f" for="pa-f-cat">Category</label><select id="pa-f-cat" style="flex:1;">${catOpts}</select></div>
      <div class="row"><label class="f">Footprint</label>
        <input id="pa-f-fw" type="number" min="1" max="16" title="width (tiles)"> ×
        <input id="pa-f-fh" type="number" min="1" max="16" title="height (tiles)"> tiles</div>
      <div class="row"><label class="f" for="pa-f-bg">Bg rows</label><input id="pa-f-bg" type="number" min="0" max="16" title="non-blocking top rows"></div>
      <div class="row">
        <label class="chk"><input id="pa-f-desk" type="checkbox"> Seat</label>
        <label class="chk"><input id="pa-f-surf" type="checkbox"> On surfaces</label>
        <label class="chk"><input id="pa-f-wall" type="checkbox"> On walls</label>
      </div>
      <div class="row"><label class="f" for="pa-f-appliance">Action</label>
        <select id="pa-f-appliance" style="flex:1;">
          <option value="">None</option>
          <option value="coffee">Coffee (NPCs visit)</option>
        </select></div>
      <div class="row">
        <input id="pa-f-color" type="color" value="${this.color}">
        <button id="pa-f-paint" class="on">✏ Paint</button>
        <button id="pa-f-erase">⌫ Erase</button>
        <button id="pa-f-pick">⦿ Pick</button>
      </div>
      <div class="row" id="pa-f-framesrow" style="display:none">
        <span class="f" style="flex:0 0 auto;">Frames</span>
        <div id="pa-f-frames"></div>
        <button id="pa-f-play" title="Play the animation">▶</button>
      </div>
      <div id="pa-f-paintarea"><canvas id="pa-f-canvas"></canvas></div>
      <div class="row" style="justify-content:flex-end;min-height:1rem;margin:0;"><span id="pa-f-status">​</span></div>
      <div class="foot">
        <button id="pa-f-save" class="on">Save</button>
        <button id="pa-f-reset">Reset / delete</button>
      </div>
      </div>`;

    const host = document.getElementById('game') ?? document.body;
    if (this.opts.topbar) this.opts.topbar.appendChild(btn);
    else host.appendChild(btn);
    host.appendChild(panel);
    this.panel = panel;
    this.canvas = panel.querySelector<HTMLCanvasElement>('#pa-f-canvas')!;
    this.galleryPane = panel.querySelector<HTMLDivElement>('#pa-f-gallery')!;
    this.editPane = panel.querySelector<HTMLDivElement>('#pa-f-edit')!;
    this.cardsHost = panel.querySelector<HTMLDivElement>('#pa-f-cards')!;

    this.field('#pa-f-newbtn').onclick = () => {
      this.loadNew();
      this.showEdit();
    };
    this.field('#pa-f-galclose').onclick = () => this.close();
    this.field('#pa-f-back').onclick = async () => {
      if (await this.confirmDiscard()) this.showGallery();
    };
    this.field('#pa-f-id').oninput = (e) => {
      const el = e.target as HTMLInputElement;
      const v = sanitizeId(el.value);
      if (v !== el.value) el.value = v;
      this.work.id = v;
      this.dirty = true;
    };
    this.field('#pa-f-label').oninput = (e) => {
      const el = e.target as HTMLInputElement;
      const v = sanitizeLabel(el.value);
      if (v !== el.value) el.value = v;
      this.work.label = v;
      this.dirty = true;
    };
    this.field('#pa-f-cat').onchange = (e) => {
      this.work.category = (e.target as HTMLSelectElement).value;
      this.dirty = true;
    };
    this.field('#pa-f-fw').onchange = () => this.onFootprintChange();
    this.field('#pa-f-fh').onchange = () => this.onFootprintChange();
    this.field('#pa-f-bg').onchange = (e) => {
      this.work.backgroundTiles = Math.max(0, Math.floor(Number((e.target as HTMLInputElement).value) || 0));
      this.dirty = true;
    };
    this.field('#pa-f-desk').onchange = (e) => {
      this.work.isDesk = (e.target as HTMLInputElement).checked;
      this.dirty = true;
    };
    this.field('#pa-f-surf').onchange = (e) => {
      this.work.canPlaceOnSurfaces = (e.target as HTMLInputElement).checked;
      this.dirty = true;
    };
    this.field('#pa-f-wall').onchange = (e) => {
      this.work.canPlaceOnWalls = (e.target as HTMLInputElement).checked;
      this.dirty = true;
    };
    this.field('#pa-f-appliance').onchange = (e) => {
      this.work.appliance = (e.target as HTMLSelectElement).value;
      this.dirty = true;
    };
    const colorEl = this.field('#pa-f-color');
    colorEl.oninput = () => {
      this.color = colorEl.value;
      this.setTool('paint');
    };
    this.field('#pa-f-paint').onclick = () => this.setTool('paint');
    this.field('#pa-f-erase').onclick = () => this.setTool('erase');
    this.field('#pa-f-pick').onclick = () => this.setTool('pick');
    this.field('#pa-f-save').onclick = () => this.doSave();
    this.field('#pa-f-reset').onclick = () => this.doReset();
    this.field('#pa-f-play').onclick = () => this.togglePlay();

    this.bindPaint();
  }

  private field<T extends HTMLElement = HTMLInputElement>(sel: string): T {
    return this.panel.querySelector<T>(sel)!;
  }

  private setTool(t: 'paint' | 'erase' | 'pick'): void {
    this.tool = t;
    for (const [id, name] of [['#pa-f-paint', 'paint'], ['#pa-f-erase', 'erase'], ['#pa-f-pick', 'pick']] as const) {
      this.field(id).classList.toggle('on', t === name);
    }
  }

  // ── Data ─────────────────────────────────────────────────────────

  /** Render the browsable card grid, grouped by furniture category. */
  private renderGallery(): void {
    this.cardsHost.innerHTML = '';
    for (const cat of getActiveCategories()) {
      const entries = getCatalogByCategory(cat.id);
      if (!entries.length) continue;
      const head = document.createElement('div');
      head.className = 'cathead';
      head.textContent = cat.label;
      this.cardsHost.appendChild(head);
      for (const e of entries) {
        const card = document.createElement('div');
        card.className = 'card';
        const cv = document.createElement('canvas');
        this.drawThumb(cv, e.sprite);
        const nm = document.createElement('div');
        nm.className = 'nm';
        nm.textContent = `${e.label} (${e.type})`;
        const edit = document.createElement('button');
        edit.textContent = 'Edit';
        edit.onclick = () => {
          this.loadItem(e.type);
          this.showEdit();
        };
        const reset = document.createElement('button');
        reset.textContent = 'Reset';
        reset.className = 'del';
        reset.title = 'Revert to the bundled default (or delete a custom item)';
        reset.onclick = async () => {
          if (!(await confirmDialog(`Reset ${e.type}?`, { danger: true, confirmLabel: 'Reset' }))) return;
          this.opts.reset(e.type);
          window.setTimeout(() => this.renderGallery(), 250);
        };
        card.append(cv, nm, edit, reset);
        this.cardsHost.appendChild(card);
      }
    }
  }

  /** Draw a furniture sprite 1:1 into a tiny canvas (CSS scales it, pixelated). */
  private drawThumb(cv: HTMLCanvasElement, sprite: SpriteData): void {
    const h = sprite.length;
    const w = h > 0 ? sprite[0].length : 0;
    cv.width = Math.max(1, w);
    cv.height = Math.max(1, h);
    const ctx = cv.getContext('2d')!;
    ctx.clearRect(0, 0, cv.width, cv.height);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < sprite[y].length; x++) {
        const c = sprite[y][x];
        if (!c) continue;
        ctx.fillStyle = c;
        ctx.fillRect(x, y, 1, 1);
      }
    }
  }

  private loadNew(): void {
    this.work = this.blank();
    this.isNew = true;
    this.dirty = false;
    this.syncFields(true);
    this.render();
  }

  private loadItem(type: string): void {
    const entry = getCatalogEntry(type);
    const rawCatalog = this.opts.getRawCatalog() ?? [];
    const rawOf = (id: string): RawCatalogItem | undefined => rawCatalog.find((c) => c.id === id);
    const raw = rawOf(type);
    const fw = entry?.footprintW ?? 1;
    const fh = entry?.footprintH ?? 1;
    const cloneOf = (id: string): SpriteData => {
      const e = getCatalogEntry(id);
      return e?.sprite ? e.sprite.map((r) => r.slice()) : emptySprite(fw * TILE, fh * TILE);
    };
    // Animation members (ordered frame ids), or just this item as a single frame.
    const memberIds = getAnimationFrames(type) ?? [type];
    const frames: FurnFrame[] = memberIds.map((id) => ({ id, sprite: cloneOf(id), base: rawOf(id) }));
    const animGroup = frames.length > 1 ? ((raw?.animationGroup as string | undefined) ?? type) : null;
    this.work = {
      id: type,
      label: entry?.label ?? type,
      category: entry?.category ?? 'misc',
      footprintW: fw,
      footprintH: fh,
      isDesk: !!entry?.isDesk,
      canPlaceOnSurfaces: !!entry?.canPlaceOnSurfaces,
      canPlaceOnWalls: !!entry?.canPlaceOnWalls,
      backgroundTiles: entry?.backgroundTiles ?? 0,
      // Resolved entry includes the bundled coffee-machine legacy default.
      appliance: entry?.appliance ?? '',
      frames,
      frameIdx: 0,
      animGroup,
      sprite: frames[0].sprite,
      base: raw,
    };
    this.isNew = false;
    this.dirty = false;
    this.syncFields(false);
    this.render();
  }

  /** Switch the selected animation frame (paint canvas + strip follow). */
  private selectFrame(i: number): void {
    if (i < 0 || i >= this.work.frames.length) return;
    this.work.frameIdx = i;
    this.work.sprite = this.work.frames[i].sprite; // re-point the alias
    this.render();
  }

  private syncFields(isNew: boolean): void {
    this.field('#pa-f-id').value = this.work.id;
    (this.field('#pa-f-id')).readOnly = !isNew; // ids are stable for existing items
    this.field('#pa-f-label').value = this.work.label;
    this.field<HTMLSelectElement>('#pa-f-cat').value = this.work.category;
    this.field('#pa-f-fw').value = String(this.work.footprintW);
    this.field('#pa-f-fh').value = String(this.work.footprintH);
    this.field('#pa-f-bg').value = String(this.work.backgroundTiles);
    (this.field('#pa-f-desk')).checked = this.work.isDesk;
    (this.field('#pa-f-surf')).checked = this.work.canPlaceOnSurfaces;
    (this.field('#pa-f-wall')).checked = this.work.canPlaceOnWalls;
    this.field<HTMLSelectElement>('#pa-f-appliance').value = this.work.appliance;
  }

  private onFootprintChange(): void {
    const fw = Math.max(1, Math.min(16, Math.floor(Number(this.field('#pa-f-fw').value) || 1)));
    const fh = Math.max(1, Math.min(16, Math.floor(Number(this.field('#pa-f-fh').value) || 1)));
    this.work.footprintW = fw;
    this.work.footprintH = fh;
    this.field('#pa-f-fw').value = String(fw);
    this.field('#pa-f-fh').value = String(fh);
    // Footprint applies to the whole item → resize every frame, then re-point.
    for (const f of this.work.frames) f.sprite = resizeSprite(f.sprite, fw * TILE, fh * TILE);
    this.work.sprite = this.work.frames[this.work.frameIdx].sprite;
    this.dirty = true;
    this.render();
  }

  private showStatus(text: string): void {
    const el = this.field<HTMLSpanElement>('#pa-f-status');
    el.textContent = text;
    el.style.opacity = '1';
    window.setTimeout(() => (el.style.opacity = '0'), 1600);
  }

  private doSave(): void {
    if (!this.work.id) {
      this.showStatus('Give it an ID first');
      return;
    }
    const w = this.work;
    const animated = w.frames.length > 1;
    // Save every animation frame as its own catalog member; static items save one.
    w.frames.forEach((f, i) => {
      const id = f.id || w.id; // a fresh blank item has no per-frame id yet
      const h = f.sprite.length;
      const width = h > 0 ? f.sprite[0].length : 0;
      const catalog: Record<string, unknown> = {
        ...(f.base ?? w.base ?? {}), // preserve group/meta fields on edit
        id,
        label: w.label || w.id,
        category: w.category,
        width,
        height: h,
        footprintW: w.footprintW,
        footprintH: w.footprintH,
        isDesk: w.isDesk,
        canPlaceOnSurfaces: w.canPlaceOnSurfaces,
        canPlaceOnWalls: w.canPlaceOnWalls,
        backgroundTiles: w.backgroundTiles,
        appliance: w.appliance, // '' clears any station; 'coffee' = NPCs visit
      };
      if (animated && w.animGroup) {
        catalog.animationGroup = w.animGroup;
        catalog.frame = i;
      }
      this.opts.save(id, { sprite: f.sprite, catalog });
    });
    this.dirty = false;
    this.isNew = false;
    this.field('#pa-f-id').readOnly = true; // id is fixed once saved
    this.showStatus(`Saved ${w.id}${animated ? ` (${w.frames.length} frames)` : ''} ✓`);
  }

  private doReset(): void {
    if (!this.work.id) return;
    this.opts.reset(this.work.id);
    this.dirty = false;
    this.showStatus(`Reset ${this.work.id} ✓`);
    window.setTimeout(() => this.showGallery(), 250);
  }

  // ── Rendering ────────────────────────────────────────────────────
  private render(): void {
    const w = this.work.sprite[0]?.length ?? TILE;
    const h = this.work.sprite.length;
    this.cell = Math.max(3, Math.min(16, Math.floor(MAX_CANVAS_PX / Math.max(w, h))));
    this.canvas.width = w * this.cell;
    this.canvas.height = h * this.cell;
    const ctx = this.canvas.getContext('2d')!;
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const c = this.work.sprite[y][x];
        if (!c) continue;
        ctx.fillStyle = c;
        ctx.fillRect(x * this.cell, y * this.cell, this.cell, this.cell);
      }
    }
    // Tile grid (heavier line every 16px = one tile).
    for (let x = 0; x <= w; x++) {
      ctx.strokeStyle = x % TILE === 0 ? 'rgba(120,160,255,0.4)' : 'rgba(255,255,255,0.06)';
      ctx.beginPath();
      ctx.moveTo(x * this.cell, 0);
      ctx.lineTo(x * this.cell, h * this.cell);
      ctx.stroke();
    }
    for (let y = 0; y <= h; y++) {
      ctx.strokeStyle = y % TILE === 0 ? 'rgba(120,160,255,0.4)' : 'rgba(255,255,255,0.06)';
      ctx.beginPath();
      ctx.moveTo(0, y * this.cell);
      ctx.lineTo(w * this.cell, y * this.cell);
      ctx.stroke();
    }
    this.renderFrames();
  }

  /** Render the animation frame strip (one thumbnail per frame, selected one
   *  highlighted; click to edit). Hidden for single-frame static items. */
  private renderFrames(): void {
    const row = this.field<HTMLDivElement>('#pa-f-framesrow');
    const host = this.field<HTMLDivElement>('#pa-f-frames');
    const multi = this.work.frames.length > 1;
    row.style.display = multi ? 'flex' : 'none';
    if (!multi) return;
    host.innerHTML = '';
    this.work.frames.forEach((f, i) => {
      const cv = document.createElement('canvas');
      this.drawThumb(cv, f.sprite);
      cv.classList.toggle('on', i === this.work.frameIdx);
      cv.title = `Frame ${i + 1}`;
      cv.onclick = () => {
        this.stopPlay();
        this.selectFrame(i);
      };
      host.appendChild(cv);
    });
  }

  private togglePlay(): void {
    if (this.playTimer !== null) {
      this.stopPlay();
      return;
    }
    if (this.work.frames.length < 2) return;
    this.field('#pa-f-play').textContent = '⏸';
    this.playTimer = window.setInterval(() => {
      this.selectFrame((this.work.frameIdx + 1) % this.work.frames.length);
    }, 250);
  }

  private stopPlay(): void {
    if (this.playTimer === null) return;
    window.clearInterval(this.playTimer);
    this.playTimer = null;
    this.field('#pa-f-play').textContent = '▶';
  }

  private bindPaint(): void {
    let painting = false;
    const at = (e: PointerEvent): { x: number; y: number } | null => {
      const r = this.canvas.getBoundingClientRect();
      const w = this.work.sprite[0]?.length ?? TILE;
      const h = this.work.sprite.length;
      const x = Math.floor(((e.clientX - r.left) / r.width) * w);
      const y = Math.floor(((e.clientY - r.top) / r.height) * h);
      if (x < 0 || y < 0 || x >= w || y >= h) return null;
      return { x, y };
    };
    const apply = (e: PointerEvent): void => {
      const p = at(e);
      if (!p) return;
      if (this.tool === 'pick') {
        const c = this.work.sprite[p.y][p.x];
        if (c) {
          this.color = c.slice(0, 7);
          this.field('#pa-f-color').value = this.color;
          this.setTool('paint');
        }
        return;
      }
      this.work.sprite[p.y][p.x] = this.tool === 'erase' ? '' : this.color;
      this.dirty = true;
      this.render();
    };
    this.canvas.addEventListener('pointerdown', (e) => {
      this.stopPlay(); // don't fight the user while a frame is being painted
      painting = true;
      this.canvas.setPointerCapture(e.pointerId);
      apply(e);
    });
    this.canvas.addEventListener('pointermove', (e) => {
      if (painting && this.tool !== 'pick') apply(e);
    });
    this.canvas.addEventListener('pointerup', () => (painting = false));
  }
}
