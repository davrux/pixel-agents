import { TILE_SIZE } from '@pixel/shared/office/constants.js';
import type { SpriteData } from '@pixel/shared/office/types.js';
import { confirmDialog } from '../ui/dialog.js';
import { PixelPaintCanvas } from './pixelPaintCanvas.js';

export interface FloorEditorOpts {
  /** Read the current raw (uncolorized) sprite for a pattern, or null if it
   *  doesn't exist yet. */
  load: (pattern: number) => SpriteData | null;
  /** Persist an edited floor pattern (assetType 'floor', name floor_<i>). */
  save: (pattern: number, data: SpriteData) => void;
  /** Where "← Back" (and post-save) goes — the Assets panel's Floor tab. */
  onBack: () => void;
}

/**
 * In-browser floor pattern editor: paint/erase/pick on a single fixed-size
 * (TILE_SIZE×TILE_SIZE) sprite — no footprint/category/animation/select-
 * paste, since a floor pattern is just one plain tile (see
 * shared/src/office/floorTiles.ts) with nothing worth marquee-copying.
 * Shares its actual paint canvas with FurnitureEditor (see
 * pixelPaintCanvas.ts) — only the surrounding chrome differs.
 */
export class FloorEditor {
  private panel!: HTMLDivElement;
  private paint!: PixelPaintCanvas;
  private open = false;
  private dirty = false;
  private pattern = 1;
  private sprite: SpriteData = this.blank();
  /** Per-open override for opts.onBack — set by edit()'s second argument when
   *  opened from somewhere other than the Assets panel (e.g. LayoutEditor's
   *  palette), so Back there closes the panel instead of reopening Assets.
   *  Cleared on every open. */
  private backOverride: (() => void) | undefined;

  constructor(private readonly opts: FloorEditorOpts) {
    this.build();
  }

  isOpen(): boolean {
    return this.open;
  }

  edit(pattern: number, onBack?: () => void): void {
    this.open = true;
    this.backOverride = onBack;
    this.pattern = pattern;
    this.sprite = (this.opts.load(pattern) ?? this.blank()).map((r) => r.slice());
    this.dirty = false;
    this.panel.style.display = 'block';
    this.field<HTMLSpanElement>('#pa-fl-title').textContent = `Floor ${pattern}`;
    this.paint.setSprite(this.sprite);
  }

  /** Scene hook: may this editor be closed now? (prompts on unsaved edits). */
  confirmLeave(): Promise<boolean> {
    if (!this.dirty) return Promise.resolve(true);
    return confirmDialog('Discard unsaved changes?', { danger: true, confirmLabel: 'Discard' });
  }

  /** Close without prompting — the caller already ran confirmLeave(). */
  forceClose(): void {
    this.open = false;
    this.panel.style.display = 'none';
  }

  private blank(): SpriteData {
    return Array.from({ length: TILE_SIZE }, () => new Array<string>(TILE_SIZE).fill(''));
  }

  private build(): void {
    const style = document.createElement('style');
    style.textContent = `
      #pa-floor-ed{position:fixed;top:3.7rem;right:0.75rem;z-index:61;display:none;width:16rem;background:#1c1a19;
        border:2px solid #0a0908;border-radius:0.6rem;color:#f1efec;padding:0.9rem;font-family:'FS Pixel Sans',monospace;
        box-shadow:inset 0 2px 0 #292725,inset 0 -3px 0 #030303,0 12px 28px rgba(0,0,0,.55);}
      #pa-floor-ed h4{margin:0 0 0.6rem;font-size:1.25rem;color:#f5f3f0;}
      #pa-floor-ed .row{display:flex;align-items:center;gap:0.5rem;margin:0.5rem 0;font-size:1rem;flex-wrap:wrap;}
      #pa-floor-ed button{background:#262422;border:2px solid #0a0908;color:#f1efec;border-radius:0.35rem;
        font:1rem 'FS Pixel Sans',monospace;padding:0.4rem 0.6rem;cursor:pointer;
        box-shadow:inset 0 2px 0 #4a4744,inset 0 -3px 0 #050505;}
      #pa-floor-ed button.on{background:#c51a1b;color:#fff;box-shadow:inset 0 2px 0 #e2585a,inset 0 -3px 0 #5c0f10;}
      #pa-floor-ed #pa-fl-paintarea{display:flex;justify-content:center;margin:0.5rem 0;}
      #pa-floor-ed #pa-fl-paintarea canvas{image-rendering:pixelated;background:
        repeating-conic-gradient(#262422 0% 25%, #201e1c 0% 50%) 0/1rem 1rem;border:2px solid #0a0908;cursor:crosshair;touch-action:none;}
      #pa-floor-ed input[type=color]{width:2.6rem;height:2rem;padding:0;border:2px solid #0a0908;background:none;cursor:pointer;}
      #pa-floor-ed .foot{display:flex;gap:0.5rem;margin-top:0.6rem;}
      #pa-floor-ed .foot button{flex:1;padding:0.6rem;}
      #pa-floor-ed #pa-fl-status{color:#7fbf6a;font-size:0.9rem;opacity:0;transition:opacity .4s;}
    `;
    document.head.appendChild(style);

    const panel = document.createElement('div');
    panel.id = 'pa-floor-ed';
    panel.className = 'pa-ui';
    panel.innerHTML = `
      <h4>Floor editor — <span id="pa-fl-title"></span></h4>
      <div class="row"><button id="pa-fl-back">← Back</button></div>
      <div class="pa-fl-toolbar-slot"></div>
      <div id="pa-fl-paintarea"></div>
      <div class="row" style="justify-content:flex-end;min-height:1rem;margin:0;"><span id="pa-fl-status">​</span></div>
      <div class="foot"><button id="pa-fl-save" class="on">Save</button></div>`;

    const host = document.getElementById('game') ?? document.body;
    host.appendChild(panel);
    this.panel = panel;

    // The toolbar (color + Paint/Erase/Pick) sits directly above the canvas —
    // no other content between them (see pixelPaintCanvas.ts).
    this.paint = new PixelPaintCanvas({
      initialColor: '#9b9b9b',
      onChange: () => {
        this.dirty = true;
      },
      onStatus: (text) => this.showStatus(text),
    });
    this.field<HTMLDivElement>('.pa-fl-toolbar-slot').replaceWith(this.paint.toolbar);
    this.field<HTMLDivElement>('#pa-fl-paintarea').appendChild(this.paint.canvas);

    this.field('#pa-fl-back').onclick = async () => {
      if (!(await this.confirmLeave())) return;
      this.forceClose();
      (this.backOverride ?? this.opts.onBack)();
    };
    this.field('#pa-fl-save').onclick = () => this.doSave();
  }

  private field<T extends HTMLElement = HTMLButtonElement>(sel: string): T {
    return this.panel.querySelector<T>(sel)!;
  }

  private showStatus(text: string): void {
    const el = this.field<HTMLSpanElement>('#pa-fl-status');
    el.textContent = text;
    el.style.opacity = '1';
    window.setTimeout(() => (el.style.opacity = '0'), 1600);
  }

  private doSave(): void {
    this.opts.save(this.pattern, this.sprite);
    this.dirty = false;
    this.showStatus(`Saved floor ${this.pattern} ✓`);
  }
}
