import {
  FURNITURE_CATEGORIES,
  getActiveCategories,
  getCatalogByCategory,
  getCatalogEntry,
} from '@pixel/shared/office/layout/furnitureCatalog.js';
import type { SpriteData } from '@pixel/shared/office/types.js';

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
  private canvas!: HTMLCanvasElement;
  private picker!: HTMLSelectElement;
  private open = false;
  private color = '#9b7653';
  private tool: 'paint' | 'erase' | 'pick' = 'paint';
  private cell = 12;
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
    this.refreshList();
    this.loadFromPicker();
  }
  close(): void {
    this.open = false;
    this.panel.style.display = 'none';
  }

  private blank(): FurnWork {
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
      sprite: emptySprite(TILE, TILE),
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
      #pa-furn #pa-f-paintarea{display:flex;justify-content:center;margin:0.5rem 0;}
      #pa-furn #pa-f-canvas{image-rendering:pixelated;background:
        repeating-conic-gradient(#23262e 0% 25%, #1b1e25 0% 50%) 0/1rem 1rem;border:1px solid #3a4150;cursor:crosshair;touch-action:none;}
      #pa-furn input[type=color]{width:2.6rem;height:2rem;padding:0;border:1px solid #3a4150;background:none;cursor:pointer;}
      #pa-furn .foot{display:flex;gap:0.5rem;margin-top:0.6rem;}
      #pa-furn .foot button{flex:1;padding:0.6rem;}
      #pa-furn #pa-f-status{color:#7cfc9a;font-size:0.9rem;opacity:0;transition:opacity .4s;}
      #pa-furn .chk{flex:0 0 auto;}
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
      <div class="row"><select id="pa-f-sel" style="flex:1;"></select></div>
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
      <div id="pa-f-paintarea"><canvas id="pa-f-canvas"></canvas></div>
      <div class="row" style="justify-content:flex-end;min-height:1rem;margin:0;"><span id="pa-f-status">​</span></div>
      <div class="foot">
        <button id="pa-f-save" class="on">Save</button>
        <button id="pa-f-reset">Reset / delete</button>
        <button id="pa-f-close">Close</button>
      </div>`;

    const host = document.getElementById('game') ?? document.body;
    if (this.opts.topbar) this.opts.topbar.appendChild(btn);
    else host.appendChild(btn);
    host.appendChild(panel);
    this.panel = panel;
    this.canvas = panel.querySelector<HTMLCanvasElement>('#pa-f-canvas')!;
    this.picker = panel.querySelector<HTMLSelectElement>('#pa-f-sel')!;

    this.picker.onchange = () => this.loadFromPicker();
    this.field('#pa-f-id').oninput = (e) => {
      const el = e.target as HTMLInputElement;
      const v = sanitizeId(el.value);
      if (v !== el.value) el.value = v;
      this.work.id = v;
    };
    this.field('#pa-f-label').oninput = (e) => {
      const el = e.target as HTMLInputElement;
      const v = sanitizeLabel(el.value);
      if (v !== el.value) el.value = v;
      this.work.label = v;
    };
    this.field('#pa-f-cat').onchange = (e) => {
      this.work.category = (e.target as HTMLSelectElement).value;
    };
    this.field('#pa-f-fw').onchange = () => this.onFootprintChange();
    this.field('#pa-f-fh').onchange = () => this.onFootprintChange();
    this.field('#pa-f-bg').onchange = (e) => {
      this.work.backgroundTiles = Math.max(0, Math.floor(Number((e.target as HTMLInputElement).value) || 0));
    };
    this.field('#pa-f-desk').onchange = (e) => (this.work.isDesk = (e.target as HTMLInputElement).checked);
    this.field('#pa-f-surf').onchange = (e) =>
      (this.work.canPlaceOnSurfaces = (e.target as HTMLInputElement).checked);
    this.field('#pa-f-wall').onchange = (e) => (this.work.canPlaceOnWalls = (e.target as HTMLInputElement).checked);
    this.field('#pa-f-appliance').onchange = (e) => (this.work.appliance = (e.target as HTMLSelectElement).value);
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
    this.field('#pa-f-close').onclick = () => this.close();

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
  private refreshList(): void {
    this.picker.innerHTML = '';
    for (const cat of getActiveCategories()) {
      const group = document.createElement('optgroup');
      group.label = cat.label;
      for (const e of getCatalogByCategory(cat.id)) {
        const o = document.createElement('option');
        o.value = e.type;
        o.textContent = `${e.label} (${e.type})`;
        group.appendChild(o);
      }
      if (group.children.length) this.picker.appendChild(group);
    }
    const o = document.createElement('option');
    o.value = ' new';
    o.textContent = '+ New furniture';
    this.picker.appendChild(o);
  }

  private loadFromPicker(): void {
    const v = this.picker.value;
    if (v === ' new' || !v) this.loadNew();
    else this.loadItem(v);
  }

  private loadNew(): void {
    this.work = this.blank();
    this.syncFields(true);
    this.render();
  }

  private loadItem(type: string): void {
    const entry = getCatalogEntry(type);
    const raw = (this.opts.getRawCatalog() ?? []).find((c) => c.id === type);
    const fw = entry?.footprintW ?? 1;
    const fh = entry?.footprintH ?? 1;
    const sprite = entry?.sprite ? entry.sprite.map((r) => r.slice()) : emptySprite(fw * TILE, fh * TILE);
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
      sprite,
      base: raw,
    };
    this.syncFields(false);
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
    this.work.sprite = resizeSprite(this.work.sprite, fw * TILE, fh * TILE);
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
    const h = w.sprite.length;
    const width = h > 0 ? w.sprite[0].length : 0;
    // Preserve original group/meta fields on edit; new items are standalone.
    const catalog: Record<string, unknown> = {
      ...(w.base ?? {}),
      id: w.id,
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
    this.opts.save(w.id, { sprite: w.sprite, catalog });
    this.showStatus(`Saved ${w.id} ✓`);
    window.setTimeout(() => this.refreshList(), 250);
  }

  private doReset(): void {
    if (!this.work.id) return;
    this.opts.reset(this.work.id);
    this.showStatus(`Reset ${this.work.id} ✓`);
    window.setTimeout(() => {
      this.refreshList();
      this.loadNew();
    }, 250);
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
      this.render();
    };
    this.canvas.addEventListener('pointerdown', (e) => {
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
