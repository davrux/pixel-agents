import {
  DEFAULT_ANIMATION_FRAME_MS,
  FURNITURE_CATEGORIES,
  getActiveCategories,
  getAnimationFrameData,
  getCatalogByCategory,
  getCatalogEntry,
  getOnStateType,
  getOnTrigger,
} from '@pixel/shared/office/layout/furnitureCatalog.js';
import type { Action, SpriteData } from '@pixel/shared/office/types.js';
import { confirmDialog } from '../ui/dialog.js';
import { openPaDialog } from '../ui/paDialog.js';
import { PixelPaintCanvas } from './pixelPaintCanvas.js';
import { spriteThumbCanvas } from './assetGrid.js';
import { actionChoiceLabel, TILE_ACTION_CHOICES } from './actionChoices.js';

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
  /** Inject the top-bar entry button? Default true. The scene sets this false
   *  when entry lives elsewhere (the Assets panel) and it opens via edit(id). */
  entryButton?: boolean;
  /** Where "← Back" (and post-save) goes (Assets panel). When set, the built-in
   *  gallery view is bypassed — Back closes the editor and hands control back. */
  onBack?: () => void;
}

const TILE = 16;

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
  /** Set for an on/off state variant (PC, laptop) — the "off" pose is always a
   *  single static frame; "on" may itself be a multi-frame animation, tagged
   *  on every frame that belongs to it. */
  state?: 'on' | 'off';
  /** Tiled-style per-frame duration (ms) — only meaningful for a frame that's
   *  actually part of an animation group (ambient, or the "on" side of a
   *  state pair). */
  durationMs?: number;
}

interface FurnWork {
  id: string;
  label: string;
  category: string;
  footprintW: number;
  footprintH: number;
  isDesk: boolean;
  /** See FurnitureCatalogEntry.occupiesSurface. */
  occupiesSurface: boolean;
  backgroundTiles: number;
  /** This type's default Action (see FurnitureCatalogEntry.action) — the same
   *  TILE_ACTION_CHOICES list LayoutEditor uses for a per-instance override. */
  action?: Action;
  /** Animation frames (length 1 for a static item). */
  frames: FurnFrame[];
  /** Selected frame index. */
  frameIdx: number;
  /** Animation group id when frames.length > 1, else null. */
  animGroup: string | null;
  /** What turns an on/off pair on (see FurnitureCatalogEntry.onTrigger) — only
   *  meaningful when frames carry a state. null = not yet chosen; Save is
   *  blocked until it is (no implicit default — auto-facing doesn't suit
   *  every kind of object, see addOnOffState). */
  onTrigger: 'autoFacing' | 'click' | null;
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
  private btn!: HTMLButtonElement;
  private galleryPane!: HTMLDivElement;
  private editPane!: HTMLDivElement;
  private cardsHost!: HTMLDivElement;
  private paint!: PixelPaintCanvas;
  private open = false;
  private view: 'gallery' | 'edit' = 'gallery';
  private dirty = false;
  private isNew = false;
  private playTimer: number | null = null;
  /** Catalog ids of frames removed since load — deleted (override-reset) on save. */
  private removedIds = new Set<string>();
  private work: FurnWork = this.blank();
  /** Per-open override for opts.onBack — set by edit()'s second argument when
   *  opened from somewhere other than the Assets panel (e.g. LayoutEditor's
   *  "edit this asset" button), so Back/Reset there don't reopen a panel the
   *  caller never had open in the first place. Cleared on every open. */
  private backOverride: (() => void) | undefined;

  constructor(private readonly opts: FurnitureEditorOpts) {
    this.build();
  }

  isOpen(): boolean {
    return this.open;
  }
  /** Show/hide the top-bar entry button (used to hide editing from non-admins). */
  setButtonVisible(visible: boolean): void {
    this.btn.style.display = visible ? '' : 'none';
    if (!visible && this.open) void this.close();
  }
  toggle(): void {
    this.open ? this.close() : this.show();
  }
  show(): void {
    this.open = true;
    this.backOverride = undefined;
    this.panel.style.display = 'block';
    this.showGallery();
  }
  /** Open straight into editing one catalog item (used by the Assets browser,
   *  and any other caller that wants a specific item pre-selected). `onBack`
   *  overrides opts.onBack for just this open — pass one when the caller
   *  didn't itself come from wherever opts.onBack normally returns to (e.g.
   *  LayoutEditor opening this mid-layout-edit, not from the Assets panel). */
  edit(id: string, onBack?: () => void): void {
    this.open = true;
    this.backOverride = onBack;
    this.panel.style.display = 'block';
    this.loadItem(id);
    this.showEdit();
  }
  /** Open straight into a new blank item (Assets "＋ New furniture"). */
  newItem(): void {
    this.open = true;
    this.backOverride = undefined;
    this.panel.style.display = 'block';
    this.loadNew();
    this.showEdit();
  }
  /** Open straight into a new item pre-filled with a composed sprite (see
   *  the Assets panel's "Compose from pieces…" tool) instead of a blank
   *  canvas — same save/metadata path as any other new item from here on. */
  newItemWithSprite(sprite: SpriteData, footprintW: number, footprintH: number): void {
    this.open = true;
    this.backOverride = undefined;
    this.panel.style.display = 'block';
    this.loadNew();
    this.work.footprintW = footprintW;
    this.work.footprintH = footprintH;
    this.work.frames = [{ id: '', sprite }];
    this.work.sprite = sprite;
    this.dirty = true;
    this.syncFields(true);
    this.render();
    this.showEdit();
  }
  async close(): Promise<void> {
    if (!(await this.confirmDiscard())) return;
    this.forceClose();
  }

  /** Scene hook: may this editor be closed now? (prompts on unsaved edits). */
  confirmLeave(): Promise<boolean> {
    return this.confirmDiscard();
  }

  /** Close without prompting — the caller already ran confirmLeave(). */
  forceClose(): void {
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
      occupiesSurface: false,
      backgroundTiles: 0,
      action: undefined,
      frames: [{ id: '', sprite }],
      frameIdx: 0,
      animGroup: null,
      onTrigger: null,
      sprite,
    };
  }

  // ── DOM ──────────────────────────────────────────────────────────
  private build(): void {
    const style = document.createElement('style');
    style.textContent = `
      #pa-furn{position:fixed;top:3.7rem;right:0.75rem;z-index:61;display:none;width:23rem;background:#1c1a19;
        border:2px solid #0a0908;border-radius:0.6rem;color:#f1efec;padding:0.9rem;font-family:'FS Pixel Sans',monospace;
        box-shadow:inset 0 2px 0 #292725,inset 0 -3px 0 #030303,0 12px 28px rgba(0,0,0,.55);max-height:92vh;overflow:auto;}
      #pa-furn h4{margin:0 0 0.6rem;font-size:1.25rem;color:#f5f3f0;}
      #pa-furn .row{display:flex;align-items:center;gap:0.5rem;margin:0.5rem 0;font-size:1rem;flex-wrap:wrap;}
      #pa-furn label.f{flex:0 0 7rem;color:#adb0b2;}
      #pa-furn select,#pa-furn button,#pa-furn input[type=text],#pa-furn input[type=number]{background:#262422;
        border:2px solid #0a0908;color:#f1efec;border-radius:0.35rem;font:1rem 'FS Pixel Sans',monospace;padding:0.4rem 0.6rem;cursor:pointer;box-shadow:inset 0 2px 0 #4a4744,inset 0 -3px 0 #050505;}
      #pa-furn input[type=text],#pa-furn input[type=number]{cursor:text;flex:1;min-width:0;}
      #pa-furn input[type=number]{flex:0 0 4rem;}
      #pa-furn button.on{background:#c51a1b;color:#fff;box-shadow:inset 0 2px 0 #e2585a,inset 0 -3px 0 #5c0f10;}
      #pa-furn button.danger{background:#7c2634;color:#fff;box-shadow:inset 0 2px 0 #a8434f,inset 0 -3px 0 #3c0f16;}
      #pa-furn button:disabled{opacity:0.4;cursor:not-allowed;}
      /* Which pose (Off/On) is being edited — a proper segmented tab (reuses
         paSkin's .pa-seg/.seg, the same "clearly one of these is active"
         pattern as the Category/Source and zoom controls elsewhere), not a
         pair of small buttons easy to miss. */
      #pa-furn #pa-f-stateseg{flex:0 0 auto;margin-bottom:0.4rem;}
      #pa-furn #pa-f-stateseg .seg{font-size:0.95rem;padding:0.5rem 1rem;}
      #pa-furn #pa-f-frames{display:flex;gap:0.35rem;flex-wrap:wrap;flex:1;align-items:flex-end;}
      #pa-furn #pa-f-frames .framecell{display:flex;flex-direction:column;align-items:center;gap:0.15rem;}
      /* Fixed box + object-fit:contain — not width/height alone, which would
         stretch a non-square sprite (e.g. PC's 16×32 on/off frames) to fill a
         square and distort it. This keeps every thumbnail the same visual
         size (a tidy grid) while letterboxing tall/wide sprites correctly. */
      #pa-furn #pa-f-frames canvas{width:2.4rem;height:2.4rem;object-fit:contain;
        image-rendering:pixelated;background:#141312;
        border:2px solid #0a0908;border-radius:0.25rem;cursor:pointer;}
      #pa-furn #pa-f-frames canvas.on{border-color:#e2585a;}
      #pa-furn #pa-f-frames .framecell input[type=number]{flex:0 0 auto;width:3.4rem;padding:0.1rem 0.25rem;
        font-size:0.7rem;text-align:center;}
      #pa-furn #pa-f-paintarea{display:flex;justify-content:center;margin:0.5rem 0;}
      #pa-furn #pa-f-paintarea canvas{image-rendering:pixelated;background:
        repeating-conic-gradient(#262422 0% 25%, #201e1c 0% 50%) 0/1rem 1rem;border:2px solid #0a0908;cursor:crosshair;touch-action:none;}
      #pa-furn input[type=color]{width:2.6rem;height:2rem;padding:0;border:2px solid #0a0908;background:none;cursor:pointer;}
      #pa-furn .foot{display:flex;gap:0.5rem;margin-top:0.6rem;}
      #pa-furn .foot button{flex:1;padding:0.6rem;}
      #pa-furn #pa-f-status{color:#7fbf6a;font-size:0.9rem;opacity:0;transition:opacity .4s;}
      #pa-furn .chk{flex:0 0 auto;}
      #pa-furn .cathead{margin:0.7rem 0 0.2rem;font-size:0.95rem;color:#818586;text-transform:uppercase;letter-spacing:0.04em;}
      /* Scroll the card list within a bounded area so the New button (above) and
         Close (below) stay on screen even with many items. */
      #pa-furn #pa-f-cards{max-height:68vh;overflow-y:auto;}
      #pa-furn #pa-f-cards .card{display:flex;align-items:center;gap:0.6rem;background:#242220;border:2px solid #0a0908;
        border-radius:0.45rem;padding:0.35rem 0.5rem;margin:0.3rem 0;box-shadow:inset 0 2px 0 #4a4744,inset 0 -3px 0 #050505;}
      #pa-furn #pa-f-cards .card canvas{width:2rem;height:2rem;object-fit:contain;image-rendering:pixelated;background:#141312;border:2px solid #0a0908;flex:0 0 auto;}
      #pa-furn #pa-f-cards .card .nm{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
      #pa-furn #pa-f-cards .card button{padding:0.3rem 0.55rem;font-size:0.9rem;flex:0 0 auto;}
      #pa-furn #pa-f-cards .card button.del{background:#7c2634;color:#f1d0d6;box-shadow:inset 0 2px 0 #b34a5a,inset 0 -3px 0 #45111a;}
    `;
    document.head.appendChild(style);

    const btn = document.createElement('button');
    btn.id = 'pa-furn-btn';
    btn.className = 'pa-ui';
    btn.textContent = '🪑 Furniture';
    btn.onclick = () => (this.opts.requestToggle ? this.opts.requestToggle() : this.toggle());

    const catOpts = FURNITURE_CATEGORIES.map((c) => `<option value="${c.id}">${c.label}</option>`).join('');
    // Same choices (and order) as LayoutEditor's Action tool/popup — this is
    // this TYPE's default, not a per-instance override, so 'iframe' is just
    // as valid here (every instance gets that default URL unless overridden).
    const actionOpts =
      '<option value="">None</option>' +
      TILE_ACTION_CHOICES.map((c, i) => `<option value="${i}">${c.label}</option>`).join('');
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
      <div class="row"><label class="f" for="pa-f-bg" title="How many footprint tile-rows counted from the TOP are walk-through — e.g. a tall shelf's overhang, or a plant's leafy top, that a character can walk behind/under. The remaining bottom rows still block movement normally. 0 = the whole footprint blocks, like a plain desk.">Walk-under rows ⓘ</label><input id="pa-f-bg" type="number" min="0" max="16" title="Top footprint tile-rows that do NOT block movement (0 = whole footprint blocks)"></div>
      <div class="row">
        <label class="chk"><input id="pa-f-desk" type="checkbox"> Seat</label>
        <label class="chk" title="This item sits on top of a desk/table surface (e.g. a monitor, a mug) — affects render order and pet behavior"><input id="pa-f-surf" type="checkbox"> On surfaces</label>
      </div>
      <div class="row"><label class="f" for="pa-f-appliance">Action</label>
        <select id="pa-f-appliance" style="flex:1;">${actionOpts}</select></div>
      <div class="row" id="pa-f-onoffrow">
        <label class="f" for="pa-f-trigger" id="pa-f-triggerlabel" style="display:none;">Trigger</label>
        <select id="pa-f-trigger" style="flex:1;display:none;">
          <option value="">— choose —</option>
          <option value="autoFacing">Auto (seated + facing)</option>
          <option value="click">Click to toggle</option>
        </select>
        <button id="pa-f-addonoff" title="Give this item a separate On/Off pose">＋ On/Off state…</button>
        <button id="pa-f-removeonoff" class="danger" title="Merge back into one static item, keeping the Off pose" style="display:none;">－ Remove On/Off state</button>
      </div>
      <div id="pa-f-stateseg" class="pa-seg" style="display:none;"></div>
      <div class="row" id="pa-f-framesrow">
        <span class="f" id="pa-f-frameslabel" style="flex:0 0 auto;">Frames</span>
        <div id="pa-f-frames"></div>
        <button id="pa-f-addframe" title="Add an animation frame">＋</button>
        <button id="pa-f-delframe" title="Remove the selected frame">－</button>
        <button id="pa-f-play" title="Play the animation">▶</button>
      </div>
      <div class="pa-f-toolbar-slot"></div>
      <div id="pa-f-paintarea"></div>
      <div class="row" style="justify-content:flex-end;min-height:1rem;margin:0;"><span id="pa-f-status">​</span></div>
      <div class="foot">
        <button id="pa-f-save" class="on">Save</button>
        <button id="pa-f-reset">Reset / delete</button>
      </div>
      </div>`;

    const host = document.getElementById('game') ?? document.body;
    if (this.opts.entryButton !== false) {
      if (this.opts.topbar) this.opts.topbar.appendChild(btn);
      else host.appendChild(btn);
    }
    this.btn = btn;
    host.appendChild(panel);
    this.panel = panel;
    this.galleryPane = panel.querySelector<HTMLDivElement>('#pa-f-gallery')!;
    this.editPane = panel.querySelector<HTMLDivElement>('#pa-f-edit')!;
    this.cardsHost = panel.querySelector<HTMLDivElement>('#pa-f-cards')!;

    // The toolbar (color + Paint/Erase/Pick/Select/Paste) sits directly above
    // the canvas — no frames/on-off row between them (see pixelPaintCanvas.ts).
    this.paint = new PixelPaintCanvas({
      enableSelect: true,
      initialColor: '#9b7653',
      onBeforePaint: () => this.stopPlay(), // don't fight the user while a frame is being painted
      onChange: () => {
        this.dirty = true;
        this.renderFrames(); // keep the frame-strip thumbnail live while painting
      },
      onStatus: (text) => this.showStatus(text),
    });
    panel.querySelector('.pa-f-toolbar-slot')!.replaceWith(this.paint.toolbar);
    panel.querySelector<HTMLDivElement>('#pa-f-paintarea')!.appendChild(this.paint.canvas);
    // Compose a bigger item (e.g. a table) from pieces already in the catalog,
    // or start a new frame from an existing sprite instead of a blank one —
    // right here instead of a separate one-off "compose" wizard (see
    // pickStampSource). Appended after Paste, same toolbar row.
    const stampBtn = document.createElement('button');
    stampBtn.type = 'button';
    stampBtn.textContent = '📋 Stamp…';
    stampBtn.title = "Copy an existing furniture piece's sprite onto this canvas";
    stampBtn.onclick = () => this.pickStampSource();
    this.paint.toolbar.appendChild(stampBtn);

    this.field('#pa-f-newbtn').onclick = () => {
      this.loadNew();
      this.showEdit();
    };
    this.field('#pa-f-galclose').onclick = () => this.close();
    this.field('#pa-f-back').onclick = async () => {
      const back = this.backOverride ?? this.opts.onBack;
      if (back) {
        back();
        return;
      }
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
      this.work.occupiesSurface = (e.target as HTMLInputElement).checked;
      this.dirty = true;
    };
    this.field<HTMLSelectElement>('#pa-f-appliance').onchange = async (e) => {
      const sel = e.target as HTMLSelectElement;
      if (sel.value === '') {
        this.work.action = undefined;
        this.dirty = true;
        return;
      }
      const choice = TILE_ACTION_CHOICES[Number(sel.value)];
      const action = await choice.make(); // 'iframe' prompts for a URL here
      if (!action) {
        sel.value = this.actionSelectValue(); // cancelled — revert the dropdown
        return;
      }
      this.work.action = action;
      this.dirty = true;
    };
    this.field('#pa-f-save').onclick = () => this.doSave();
    this.field('#pa-f-reset').onclick = () => this.doReset();
    this.field('#pa-f-play').onclick = () => this.togglePlay();
    this.field('#pa-f-addframe').onclick = () => this.addFrame();
    this.field('#pa-f-delframe').onclick = () => this.removeFrame();
    this.field('#pa-f-addonoff').onclick = () => {
      this.addOnOffState();
      this.syncOnOffRow();
    };
    this.field('#pa-f-removeonoff').onclick = async () => {
      if (!(await confirmDialog('Remove the On/Off split? The On pose is discarded, Off becomes the plain item again.', { danger: true, confirmLabel: 'Remove' }))) return;
      this.removeOnOffState();
      this.syncOnOffRow();
    };
    this.field<HTMLSelectElement>('#pa-f-trigger').onchange = (e) => {
      const v = (e.target as HTMLSelectElement).value;
      this.work.onTrigger = v === 'autoFacing' || v === 'click' ? v : null;
      this.dirty = true;
      this.syncOnOffRow();
    };
  }

  private field<T extends HTMLElement = HTMLInputElement>(sel: string): T {
    return this.panel.querySelector<T>(sel)!;
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

  /** Picker for the "📋 Stamp…" tool: every existing furniture piece (any
   *  footprint, filterable by size since the catalog can be large), sprite
   *  copied onto the canvas at wherever's clicked next (see
   *  PixelPaintCanvas.setStampSource) — the general "build from pieces I
   *  already have" tool, usable on any frame you're currently editing (so it
   *  doubles as "start a new frame from an existing sprite" too). Replaces
   *  the old standalone Furniture Composer dialog: same idea, but inside the
   *  editor you're already in instead of a separate one-off wizard. */
  private pickStampSource(): void {
    const entries = getActiveCategories().flatMap((c) => getCatalogByCategory(c.id));
    const sizes = Array.from(new Set(entries.map((e) => `${e.footprintW}×${e.footprintH}`))).sort();

    const body = document.createElement('div');
    const filterRow = document.createElement('div');
    filterRow.className = 'row';
    const filterLabel = document.createElement('span');
    filterLabel.className = 'f';
    filterLabel.textContent = 'Footprint';
    const filterSel = document.createElement('select');
    filterSel.innerHTML =
      '<option value="">All sizes</option>' + sizes.map((s) => `<option value="${s}">${s}</option>`).join('');
    filterRow.append(filterLabel, filterSel);

    const grid = document.createElement('div');
    grid.className = 'pa-assetgrid';
    grid.style.cssText = 'max-height:20rem;overflow-y:auto;';
    body.append(filterRow, grid);

    const close = openPaDialog({ title: 'Stamp from an existing piece', body, buttons: [] });

    const renderGrid = (): void => {
      grid.replaceChildren();
      const filter = filterSel.value;
      for (const e of entries) {
        const size = `${e.footprintW}×${e.footprintH}`;
        if (filter && size !== filter) continue;
        const item = document.createElement('div');
        item.className = 'pa-assetgrid-item';
        item.title = `${e.label} (${size})`;
        item.appendChild(spriteThumbCanvas(e.sprite, 2));
        const nm = document.createElement('span');
        nm.className = 'nm';
        nm.textContent = `${e.label} · ${size}`;
        item.appendChild(nm);
        item.onclick = () => {
          this.paint.setStampSource(e.sprite.map((row) => row.slice()));
          close();
        };
        grid.appendChild(item);
      }
    };
    filterSel.onchange = renderGrid;
    renderGrid();
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
    this.removedIds.clear();
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
    // Members to edit: an ambient animation, else on/off state variants (whose
    // "on" side may itself be animated — PC, laptop), else just this one sprite.
    const animMembers = getAnimationFrameData(type);
    const onType = getOnStateType(type);
    let frames: FurnFrame[];
    let animGroup: string | null;
    if (animMembers) {
      frames = animMembers.map((f) => ({
        id: f.id,
        sprite: cloneOf(f.id),
        base: rawOf(f.id),
        durationMs: f.durationMs,
      }));
      animGroup = (raw?.animationGroup as string | undefined) ?? type;
    } else if (onType !== type) {
      // Stateful item (PC/laptop): "off" is always a single static pose; "on"
      // is either a single pose too, or (like Tiled: a plain tile vs. one
      // carrying an <animation>) its own multi-frame animation.
      const onFrames = getAnimationFrameData(onType);
      if (onFrames) {
        frames = [
          { id: type, sprite: cloneOf(type), base: raw, state: 'off' },
          ...onFrames.map((f) => ({
            id: f.id,
            sprite: cloneOf(f.id),
            base: rawOf(f.id),
            state: 'on' as const,
            durationMs: f.durationMs,
          })),
        ];
        animGroup = (rawOf(onType)?.animationGroup as string | undefined) ?? onType;
      } else {
        frames = [
          { id: type, sprite: cloneOf(type), base: raw, state: 'off' },
          { id: onType, sprite: cloneOf(onType), base: rawOf(onType), state: 'on' },
        ];
        animGroup = null;
      }
    } else {
      frames = [{ id: type, sprite: cloneOf(type), base: raw }];
      animGroup = null;
    }
    this.work = {
      id: type,
      label: entry?.label ?? type,
      category: entry?.category ?? 'misc',
      footprintW: fw,
      footprintH: fh,
      isDesk: !!entry?.isDesk,
      occupiesSurface: !!entry?.occupiesSurface,
      backgroundTiles: entry?.backgroundTiles ?? 0,
      // Resolved entry already includes the bundled coffee-machine legacy default.
      action: entry?.action,
      frames,
      frameIdx: 0,
      animGroup,
      onTrigger: frames.some((f) => f.state) ? getOnTrigger(type) : null,
      sprite: frames[0].sprite,
      base: raw,
    };
    this.isNew = false;
    this.dirty = false;
    this.removedIds.clear();
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

  /** Append a blank animation frame to whichever track is currently selected
   *  (turning a static item into an animation on the first add, for a plain
   *  item; or growing the "on" side's animation, for a state pair — the "off"
   *  pose never animates, like a plain Tiled tile vs. one with an
   *  <animation>). Frame 0 keeps the item's id so existing placements
   *  survive; added frames get `${animGroup}_N` ids. */
  private addFrame(): void {
    this.stopPlay();
    const w = this.work;
    const curState = w.frames[w.frameIdx]?.state;
    if (curState === 'off') return; // the static pose never animates
    // Seed the animation group's name from the CURRENT track's own first
    // member — for a state pair that's the "on" frame, never the "off" one
    // (frames[0] is only the right seed for a plain, state-less item).
    const track = w.frames.filter((f) => f.state === curState);
    const trackFirst = track[0] ?? w.frames[0];
    if (!trackFirst.id) trackFirst.id = w.id; // a fresh blank item has no id yet
    if (!w.animGroup) w.animGroup = trackFirst.id || w.id || 'ANIM';
    const used = new Set(w.frames.map((f) => f.id));
    let n = track.length;
    let id = `${w.animGroup}_${n}`;
    while (used.has(id) || getCatalogEntry(id)) id = `${w.animGroup}_${++n}`;
    const cur = w.frames[w.frameIdx].sprite;
    const h = cur.length;
    const width = h > 0 ? cur[0].length : TILE;
    w.frames.push({ id, sprite: emptySprite(width, h), state: curState, durationMs: DEFAULT_ANIMATION_FRAME_MS });
    this.dirty = true;
    this.selectFrame(w.frames.length - 1);
  }

  /** Turn a plain static item into an on/off pair — Off keeps the current
   *  sprite/id, On starts as a copy to edit from. No default trigger is
   *  picked (see FurnWork.onTrigger): Save is blocked until one is, since
   *  auto-facing doesn't suit every kind of object (see #pa-f-trigger). */
  private addOnOffState(): void {
    const w = this.work;
    if (w.frames.some((f) => f.state) || w.animGroup) return;
    if (!w.frames[0].id) w.frames[0].id = w.id;
    w.frames[0].state = 'off';
    const offId = w.frames[0].id;
    let onId = `${offId}_ON`;
    let n = 2;
    while (getCatalogEntry(onId)) onId = `${offId}_ON${n++}`;
    w.frames.push({ id: onId, sprite: w.frames[0].sprite.map((r) => r.slice()), state: 'on' });
    w.onTrigger = null;
    this.dirty = true;
    this.selectFrame(0);
  }

  /** Undo addOnOffState(): the reverse merge — drop every "on" frame (queued
   *  for override-deletion on save, same as removeFrame does for a dropped
   *  frame) and keep the Off pose's sprite/id as a single plain static frame
   *  again. There was previously no way back from "+ On/Off state…" at all. */
  private removeOnOffState(): void {
    const w = this.work;
    const off = w.frames.find((f) => f.state === 'off');
    if (!off) return;
    for (const f of w.frames) {
      if (f.state === 'on' && (f.base || getCatalogEntry(f.id))) this.removedIds.add(f.id);
    }
    off.state = undefined;
    off.durationMs = undefined;
    w.frames = [off];
    w.animGroup = null;
    w.onTrigger = null;
    this.dirty = true;
    this.selectFrame(0);
  }

  /** Remove the selected frame (≥2 required in its track). A previously-saved
   *  member is queued for override-deletion on save; dropping an ambient
   *  animation to one frame reverts it to a static item. The "off" pose can
   *  never be removed — it's always exactly one static frame. (Removing a
   *  bundled frame can't fully delete it — the bundle re-asserts it; works
   *  for user-added/overridden frames.) */
  private removeFrame(): void {
    this.stopPlay();
    const w = this.work;
    const cur = w.frames[w.frameIdx];
    if (!cur || cur.state === 'off') return;
    const trackLen = w.frames.filter((f) => f.state === cur.state).length;
    if (trackLen <= 1) return;
    const [removed] = w.frames.splice(w.frameIdx, 1);
    if (removed.base || getCatalogEntry(removed.id)) this.removedIds.add(removed.id);
    if (!cur.state && w.frames.length === 1) w.animGroup = null; // ambient anim back to a static item
    this.dirty = true;
    const sameTrack = w.frames.findIndex((f) => f.state === cur.state);
    this.selectFrame(sameTrack >= 0 ? sameTrack : Math.min(w.frameIdx, w.frames.length - 1));
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
    (this.field('#pa-f-surf')).checked = this.work.occupiesSurface;
    this.field<HTMLSelectElement>('#pa-f-appliance').value = this.actionSelectValue();
  }

  /** The Action <select>'s value for the current work.action — its index into
   *  TILE_ACTION_CHOICES (matched by label, since two Actions of the same
   *  kind can differ only in a field the select doesn't itself encode, e.g.
   *  an iframe's url), or '' for "None". */
  private actionSelectValue(): string {
    if (!this.work.action) return '';
    const label = actionChoiceLabel(this.work.action);
    const idx = TILE_ACTION_CHOICES.findIndex((c) => c.label === label);
    return idx >= 0 ? String(idx) : '';
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
    const hasState = w.frames.some((f) => f.state);
    if (hasState && !w.onTrigger) {
      this.showStatus('Choose a Trigger (Auto/Click) first');
      return;
    }
    // A click-toggle pair's action IS the 'toggle' Action — not something to
    // pick separately (see syncOnOffRow, which disables that dropdown for it).
    const effectiveAction: Action | undefined =
      hasState && w.onTrigger === 'click' ? { kind: 'toggle' } : w.action;
    // Only the "on" track (or the whole thing, for a plain ambient animation
    // with no state split) is ever a Tiled-style multi-frame animation — the
    // "off" pose is always a single static frame and never gets
    // animationGroup/frame/durationMs, exactly like PC_FRONT_OFF's manifest.
    const animFrames = w.frames.filter((f) => f.state !== 'off');
    const animated = animFrames.length > 1;
    // Save every animation frame as its own catalog member; static items save one.
    w.frames.forEach((f) => {
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
        canPlaceOnSurfaces: w.occupiesSurface, // wire/manifest name kept as-is, see furnitureCatalog.ts
        backgroundTiles: w.backgroundTiles,
        action: effectiveAction, // undefined clears it — same for the legacy flags below,
        // in case `base` (spread above) still carries them from before this
        // type was migrated to the single `action` field.
        appliance: undefined,
        conference: undefined,
        arcade: undefined,
        meetingRoom: undefined,
        onTrigger: hasState ? w.onTrigger : undefined,
      };
      // state/groupId link an off/on pair together (buildDynamicCatalog's
      // Phase 3) — for an existing item `f.base` already carries them
      // (spread above), but a pair just created via addOnOffState has no
      // base to inherit from, so they must be set explicitly here too.
      if (f.state) {
        catalog.state = f.state;
        catalog.groupId = (f.base?.groupId as string | undefined) ?? w.id;
      }
      if (animated && w.animGroup && f.state !== 'off') {
        catalog.animationGroup = w.animGroup;
        catalog.frame = animFrames.indexOf(f);
        catalog.durationMs = f.durationMs ?? DEFAULT_ANIMATION_FRAME_MS;
      } else {
        catalog.animationGroup = undefined;
        catalog.frame = undefined;
        catalog.durationMs = undefined;
      }
      this.opts.save(id, { sprite: f.sprite, catalog });
    });
    // Delete overrides for frames the user removed (best-effort; a bundled frame
    // would re-assert from the bundle — only user/overridden frames truly drop).
    for (const id of this.removedIds) if (!w.frames.some((f) => (f.id || w.id) === id)) this.opts.reset(id);
    this.removedIds.clear();
    this.dirty = false;
    this.isNew = false;
    this.field('#pa-f-id').readOnly = true; // id is fixed once saved
    const unit = w.frames.some((f) => f.state) ? 'states' : 'frames';
    this.showStatus(`Saved ${w.id}${animated ? ` (${w.frames.length} ${unit})` : ''} ✓`);
  }

  private doReset(): void {
    if (!this.work.id) return;
    this.opts.reset(this.work.id);
    this.dirty = false;
    this.showStatus(`Reset ${this.work.id} ✓`);
    const back = this.backOverride ?? this.opts.onBack;
    window.setTimeout(() => (back ? back() : this.showGallery()), 250);
  }

  // ── Rendering ────────────────────────────────────────────────────
  private render(): void {
    this.paint.setSprite(this.work.sprite);
    this.renderFrames();
    this.syncOnOffRow();
  }

  /** Show/hide "＋ On/Off state…" (only for a plain, unanimated item) vs. the
   *  Trigger picker (only once an on/off pair exists) — and disable the
   *  generic Action dropdown for a click-toggle pair, since its action is
   *  implicitly the 'toggle' Action, not something to pick separately. */
  private syncOnOffRow(): void {
    const w = this.work;
    const hasState = w.frames.some((f) => f.state);
    const addBtn = this.field<HTMLButtonElement>('#pa-f-addonoff');
    const removeBtn = this.field<HTMLButtonElement>('#pa-f-removeonoff');
    const triggerSel = this.field<HTMLSelectElement>('#pa-f-trigger');
    const triggerLabel = this.field<HTMLLabelElement>('#pa-f-triggerlabel');
    addBtn.style.display = hasState ? 'none' : '';
    addBtn.disabled = !!w.animGroup; // an ambient animation can't also become a state pair here
    removeBtn.style.display = hasState ? '' : 'none';
    triggerSel.style.display = hasState ? '' : 'none';
    triggerLabel.style.display = hasState ? '' : 'none';
    triggerSel.value = w.onTrigger ?? '';
    this.field<HTMLSelectElement>('#pa-f-appliance').disabled = hasState && w.onTrigger === 'click';
  }

  /** Render the current track's frame strip (Tiled-style: one thumbnail per
   *  frame, a duration-ms input under each if it's actually an animation,
   *  selected frame highlighted; click a thumbnail to edit it). For a state
   *  pair (PC, laptop) — like Tiled modelling "off" as a plain tile and "on"
   *  as a tile carrying an <animation> — an Off/On toggle picks which track
   *  is shown; "off" is always a single, non-animated frame. */
  private renderFrames(): void {
    const host = this.field<HTMLDivElement>('#pa-f-frames');
    const stateHost = this.field<HTMLDivElement>('#pa-f-stateseg');
    const w = this.work;
    const hasState = w.frames.some((f) => f.state);
    const curState = w.frames[w.frameIdx]?.state ?? null;
    const track = hasState ? w.frames.filter((f) => f.state === curState) : w.frames;
    const isAnim = track.length > 1;

    stateHost.style.display = hasState ? '' : 'none'; // '' → CSS's .pa-seg default (flex)
    stateHost.innerHTML = '';
    if (hasState) {
      for (const s of ['off', 'on'] as const) {
        if (!w.frames.some((f) => f.state === s)) continue;
        const b = document.createElement('div');
        b.className = 'seg' + (s === curState ? ' on' : '');
        b.textContent = s === 'off' ? '◐ Editing: Off' : '◑ Editing: On';
        b.onclick = () => {
          const idx = w.frames.findIndex((f) => f.state === s);
          if (idx >= 0) {
            this.stopPlay();
            this.selectFrame(idx);
          }
        };
        stateHost.appendChild(b);
      }
    }

    host.innerHTML = '';
    for (const f of track) {
      const i = w.frames.indexOf(f);
      const cell = document.createElement('div');
      cell.className = 'framecell';
      const cv = document.createElement('canvas');
      this.drawThumb(cv, f.sprite);
      cv.classList.toggle('on', i === w.frameIdx);
      cv.title = f.state ? f.state.toUpperCase() : `Frame ${track.indexOf(f) + 1}`;
      cv.onclick = () => {
        this.stopPlay();
        this.selectFrame(i);
      };
      cell.appendChild(cv);
      if (isAnim) {
        const dur = document.createElement('input');
        dur.type = 'number';
        dur.min = '16';
        dur.max = '10000';
        dur.step = '10';
        dur.title = "Frame duration (ms) — like Tiled's tile animation editor";
        dur.value = String(f.durationMs ?? DEFAULT_ANIMATION_FRAME_MS);
        dur.onchange = () => {
          f.durationMs = Math.max(16, Math.min(10000, Math.floor(Number(dur.value)) || DEFAULT_ANIMATION_FRAME_MS));
          dur.value = String(f.durationMs);
          this.dirty = true;
        };
        cell.appendChild(dur);
      }
      host.appendChild(cell);
    }
    this.field<HTMLSpanElement>('#pa-f-frameslabel').textContent = hasState
      ? curState === 'off'
        ? 'Off'
        : 'On frames'
      : 'Frames';
    const lockedTrack = curState === 'off'; // the static pose never animates
    (this.field('#pa-f-addframe')).disabled = lockedTrack;
    (this.field('#pa-f-delframe')).disabled = lockedTrack || track.length <= 1;
    (this.field('#pa-f-play')).disabled = !isAnim; // only time-animations play
  }

  /** Play the current track's frames back-to-back using each frame's own
   *  duration — the same way Tiled's own animation editor previews it. */
  private togglePlay(): void {
    if (this.playTimer !== null) {
      this.stopPlay();
      return;
    }
    const w = this.work;
    const curState = w.frames[w.frameIdx]?.state ?? null;
    const track = curState !== null ? w.frames.filter((f) => f.state === curState) : w.frames;
    if (track.length < 2) return;
    this.field('#pa-f-play').textContent = '⏸';
    const step = (): void => {
      const i = track.indexOf(this.work.frames[this.work.frameIdx]);
      const next = track[(i + 1) % track.length];
      this.selectFrame(this.work.frames.indexOf(next));
      this.playTimer = window.setTimeout(step, next.durationMs ?? DEFAULT_ANIMATION_FRAME_MS);
    };
    const first = track[(track.indexOf(w.frames[w.frameIdx]) + 1) % track.length];
    this.playTimer = window.setTimeout(step, first?.durationMs ?? DEFAULT_ANIMATION_FRAME_MS);
  }

  private stopPlay(): void {
    if (this.playTimer === null) return;
    window.clearTimeout(this.playTimer);
    this.playTimer = null;
    this.field('#pa-f-play').textContent = '▶';
  }
}
