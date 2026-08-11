/**
 * Shared pixel-paint canvas: the Paint/Erase/Pick(/Select/Paste) tool row +
 * the checkerboard canvas + a tile-boundary grid overlay. Used by
 * FurnitureEditor (the in-game floor pattern editor this was also shared
 * with has since been retired in favor of the Tiled asset pipeline — see
 * docs/design/tiled-editor-integration.md).
 */
import type { SpriteData } from '@pixel/shared/office/types.js';
import { TILE_SIZE } from '@pixel/shared/office/constants.js';
import { copyRegion, hasClipboard, pasteRegion, rectFromCorners, type PixelRect } from './pixelSelection.js';

export type PaintTool = 'paint' | 'erase' | 'pick' | 'select' | 'stamp';

export interface PixelPaintCanvasOpts {
  /** Marquee-select + copy/paste — FurnitureEditor wants this (copying a
   *  detail between frames/on-off poses). */
  enableSelect?: boolean;
  /** Called after any paint/erase/paste mutation (the caller owns the
   *  sprite array — mutated in place — and reacts, e.g. marking itself dirty). */
  onChange: () => void;
  /** Called right before a paint/erase gesture starts — e.g. to stop an
   *  animation preview that would otherwise fight the edit. */
  onBeforePaint?: () => void;
  /** Transient status text (e.g. "Copied 4×4", "Pasted ✓"). */
  onStatus?: (text: string) => void;
  initialColor?: string;
}

const MAX_CANVAS_PX = 256;

export class PixelPaintCanvas {
  /** Color input + tool buttons, in one row — append wherever the caller
   *  wants it positioned (directly by the canvas, see FurnitureEditor's
   *  layout). */
  readonly toolbar: HTMLDivElement;
  readonly canvas: HTMLCanvasElement;
  readonly colorInput: HTMLInputElement;
  private tool: PaintTool = 'paint';
  private sprite: SpriteData = [[]];
  private cell = 12;
  private selection: PixelRect | null = null;
  /** Sprite armed by an external "stamp from X" picker (see setStampSource) —
   *  not something this generic canvas knows how to pick, just how to place. */
  private stampSource: SpriteData | null = null;
  /** Tile-snapped top-left the stamp would land at if clicked right now — the
   *  cursor-follow preview (see bindPaint's pointermove), null when the mouse
   *  isn't over the canvas or the stamp tool isn't armed. */
  private stampHover: { x: number; y: number } | null = null;
  private readonly toolBtns: Array<{ tool: PaintTool; btn: HTMLButtonElement }> = [];

  constructor(private readonly opts: PixelPaintCanvasOpts) {
    this.toolbar = document.createElement('div');
    this.toolbar.className = 'row';

    this.colorInput = document.createElement('input');
    this.colorInput.type = 'color';
    this.colorInput.value = opts.initialColor ?? '#9b7653';
    this.colorInput.oninput = () => this.setTool('paint');
    this.toolbar.appendChild(this.colorInput);

    const mkBtn = (label: string, tool: PaintTool, title?: string): void => {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = label;
      if (title) b.title = title;
      b.onclick = () => this.setTool(tool);
      this.toolbar.appendChild(b);
      this.toolBtns.push({ tool, btn: b });
    };
    mkBtn('✏ Paint', 'paint');
    mkBtn('⌫ Erase', 'erase');
    mkBtn('⦿ Pick', 'pick');
    if (opts.enableSelect) {
      mkBtn('⬚ Select', 'select', 'Select a region to copy');
      const paste = document.createElement('button');
      paste.type = 'button';
      paste.textContent = '⎘ Paste';
      paste.title = 'Paste the copied region here';
      paste.onclick = () => this.doPaste();
      this.toolbar.appendChild(paste);
    }
    this.setTool('paint');

    this.canvas = document.createElement('canvas');
    this.canvas.style.touchAction = 'none';
    this.bindPaint();
  }

  /** Point the canvas at a (possibly resized) sprite — the caller keeps
   *  ownership; this only reads it for rendering and mutates it in place
   *  while painting. Clears any in-progress marquee selection (its
   *  coordinates no longer necessarily make sense against new dimensions). */
  setSprite(sprite: SpriteData): void {
    this.sprite = sprite;
    this.selection = null;
    this.render();
  }

  getColor(): string {
    return this.colorInput.value;
  }
  setColor(hex: string): void {
    this.colorInput.value = hex;
  }

  render(): void {
    const w = this.sprite[0]?.length ?? TILE_SIZE;
    const h = this.sprite.length;
    this.cell = Math.max(3, Math.min(16, Math.floor(MAX_CANVAS_PX / Math.max(w, h))));
    this.canvas.width = w * this.cell;
    this.canvas.height = h * this.cell;
    const ctx = this.canvas.getContext('2d');
    if (!ctx) return;
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const c = this.sprite[y][x];
        if (!c) continue;
        ctx.fillStyle = c;
        ctx.fillRect(x * this.cell, y * this.cell, this.cell, this.cell);
      }
    }
    // Tile grid (heavier line every TILE_SIZE px = one tile).
    for (let x = 0; x <= w; x++) {
      ctx.strokeStyle = x % TILE_SIZE === 0 ? 'rgba(120,160,255,0.4)' : 'rgba(255,255,255,0.06)';
      ctx.beginPath();
      ctx.moveTo(x * this.cell, 0);
      ctx.lineTo(x * this.cell, h * this.cell);
      ctx.stroke();
    }
    for (let y = 0; y <= h; y++) {
      ctx.strokeStyle = y % TILE_SIZE === 0 ? 'rgba(120,160,255,0.4)' : 'rgba(255,255,255,0.06)';
      ctx.beginPath();
      ctx.moveTo(0, y * this.cell);
      ctx.lineTo(w * this.cell, y * this.cell);
      ctx.stroke();
    }
    if (this.selection) {
      const s = this.selection;
      ctx.strokeStyle = '#ffd34d';
      ctx.lineWidth = 2;
      ctx.setLineDash([4, 3]);
      ctx.strokeRect(s.x * this.cell, s.y * this.cell, s.w * this.cell, s.h * this.cell);
      ctx.setLineDash([]);
      ctx.lineWidth = 1;
    }
    if (this.tool === 'stamp' && this.stampSource && this.stampHover) {
      const { x: ox, y: oy } = this.stampHover;
      ctx.globalAlpha = 0.6;
      for (let y = 0; y < this.stampSource.length; y++) {
        const ty = oy + y;
        if (ty < 0 || ty >= h) continue;
        const row = this.stampSource[y];
        for (let x = 0; x < (row?.length ?? 0); x++) {
          const tx = ox + x;
          if (tx < 0 || tx >= w) continue;
          const c = row[x];
          if (!c) continue;
          ctx.fillStyle = c;
          ctx.fillRect(tx * this.cell, ty * this.cell, this.cell, this.cell);
        }
      }
      ctx.globalAlpha = 1;
      ctx.strokeStyle = '#7fbf6a';
      ctx.lineWidth = 2;
      ctx.strokeRect(ox * this.cell, oy * this.cell, (this.stampSource[0]?.length ?? 0) * this.cell, this.stampSource.length * this.cell);
      ctx.lineWidth = 1;
    }
  }

  private setTool(t: PaintTool): void {
    this.tool = t;
    for (const { tool, btn } of this.toolBtns) btn.classList.toggle('on', tool === t);
    if (t !== 'stamp') this.stampHover = null;
  }

  /** Arm the Stamp tool: the next canvas click copies `sprite` in, top-left
   *  snapped to the nearest tile boundary so pieces line up cleanly (see
   *  bindPaint's stamp branch). One-shot, like Pick — reverts to Paint right
   *  after, so stamping the same piece again means picking it again. */
  setStampSource(sprite: SpriteData): void {
    this.stampSource = sprite;
    this.setTool('stamp');
  }

  /** Paste the shared clipboard at the current selection's top-left (or 0,0). */
  doPaste(): void {
    if (!hasClipboard()) {
      this.opts.onStatus?.('Nothing copied yet');
      return;
    }
    const at = this.selection ?? { x: 0, y: 0, w: 0, h: 0 };
    pasteRegion(this.sprite, at.x, at.y);
    this.render();
    this.opts.onChange();
    this.opts.onStatus?.('Pasted ✓');
  }

  private bindPaint(): void {
    let painting = false;
    let selStart: { x: number; y: number } | null = null;
    const dims = (): { w: number; h: number } => ({
      w: this.sprite[0]?.length ?? TILE_SIZE,
      h: this.sprite.length,
    });
    const at = (e: PointerEvent): { x: number; y: number } | null => {
      const r = this.canvas.getBoundingClientRect();
      const { w, h } = dims();
      const x = Math.floor(((e.clientX - r.left) / r.width) * w);
      const y = Math.floor(((e.clientY - r.top) / r.height) * h);
      if (x < 0 || y < 0 || x >= w || y >= h) return null;
      return { x, y };
    };
    // Clamped cell (never null) — for marquee dragging past the canvas edge.
    const cell = (e: PointerEvent): { x: number; y: number } => {
      const r = this.canvas.getBoundingClientRect();
      const { w, h } = dims();
      const x = Math.max(0, Math.min(w - 1, Math.floor(((e.clientX - r.left) / r.width) * w)));
      const y = Math.max(0, Math.min(h - 1, Math.floor(((e.clientY - r.top) / r.height) * h)));
      return { x, y };
    };
    const apply = (e: PointerEvent): void => {
      const p = at(e);
      if (!p) return;
      if (this.tool === 'pick') {
        const c = this.sprite[p.y][p.x];
        if (c) {
          this.colorInput.value = c.slice(0, 7);
          this.setTool('paint');
        }
        return;
      }
      this.sprite[p.y][p.x] = this.tool === 'erase' ? '' : this.colorInput.value;
      this.render();
      this.opts.onChange();
    };
    // One-shot blit of the armed stamp sprite, top-left snapped to the nearest
    // tile so a stamped piece lines up with its neighbors — not a drag-paint
    // like paint/erase, one click places it once (see setStampSource).
    const applyStamp = (p: { x: number; y: number }): void => {
      const src = this.stampSource;
      if (!src) return;
      const { w, h } = dims();
      const ox = Math.floor(p.x / TILE_SIZE) * TILE_SIZE;
      const oy = Math.floor(p.y / TILE_SIZE) * TILE_SIZE;
      for (let y = 0; y < src.length; y++) {
        const ty = oy + y;
        if (ty < 0 || ty >= h) continue;
        for (let x = 0; x < (src[y]?.length ?? 0); x++) {
          const tx = ox + x;
          if (tx < 0 || tx >= w) continue;
          const c = src[y][x];
          if (c) this.sprite[ty][tx] = c;
        }
      }
      this.opts.onChange();
      this.opts.onStatus?.('Stamped ✓');
      this.setTool('paint'); // clears stampHover before the final render below
      this.render();
    };
    this.canvas.addEventListener('pointerdown', (e) => {
      this.opts.onBeforePaint?.();
      this.canvas.setPointerCapture(e.pointerId);
      if (this.tool === 'select') {
        selStart = cell(e);
        this.selection = rectFromCorners(selStart.x, selStart.y, selStart.x, selStart.y);
        this.render();
        return;
      }
      if (this.tool === 'stamp') {
        const p = at(e);
        if (p) applyStamp(p);
        return;
      }
      painting = true;
      apply(e);
    });
    this.canvas.addEventListener('pointermove', (e) => {
      if (selStart) {
        const p = cell(e);
        this.selection = rectFromCorners(selStart.x, selStart.y, p.x, p.y);
        this.render();
        return;
      }
      if (this.tool === 'stamp' && this.stampSource) {
        const p = at(e);
        const next = p ? { x: Math.floor(p.x / TILE_SIZE) * TILE_SIZE, y: Math.floor(p.y / TILE_SIZE) * TILE_SIZE } : null;
        if (next?.x !== this.stampHover?.x || next?.y !== this.stampHover?.y) {
          this.stampHover = next;
          this.render();
        }
        return;
      }
      if (painting && this.tool !== 'pick') apply(e);
    });
    this.canvas.addEventListener('pointerleave', () => {
      if (this.stampHover) {
        this.stampHover = null;
        this.render();
      }
    });
    this.canvas.addEventListener('pointerup', () => {
      if (selStart) {
        selStart = null;
        if (this.selection) {
          copyRegion(this.sprite, this.selection);
          this.opts.onStatus?.(`Copied ${this.selection.w}×${this.selection.h}`);
        }
      }
      painting = false;
    });
  }
}
