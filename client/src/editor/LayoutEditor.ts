import Phaser from 'phaser';

import {
  getActiveCategories,
  getCatalogByCategory,
  getCatalogEntry,
  getOrientationInGroup,
  getRotatedType,
  isRotatable,
} from '@pixel/shared/office/layout/furnitureCatalog.js';
import {
  getPlacementBlockedTiles,
  layoutToFurnitureInstances,
  layoutToTileMap,
} from '@pixel/shared/office/layout/layoutSerializer.js';
import { getColorizedFloorSprite, getFloorPatternCount } from '@pixel/shared/office/floorTiles.js';
import { getWallSetCount, getWallSetPreviewSprite } from '@pixel/shared/office/wallTiles.js';
import {
  TILE_SIZE,
  TileType,
  type FurnitureInstance,
  type OfficeLayout,
  type TileType as TileTypeVal,
} from '@pixel/shared/office/types.js';
import { getColorizedSprite } from '@pixel/shared/office/colorize.js';
import type { ColorValue } from '@pixel/shared/office/colorTypes.js';

import { spriteTexture, spriteToDataURL } from '../render/sprites.js';

export interface EditorDeps {
  getLayout: () => OfficeLayout;
  /** Re-render furniture from the editor's working copy. */
  onChange: () => void;
  /** Re-render floor/walls from the editor's working copy. */
  rebuildStatic: () => void;
  /** Persist the edited layout (scene picks saveLayout vs saveLayoutAs). */
  save: (layout: OfficeLayout) => void;
}

type Tool = 'select' | 'furniture' | 'floor' | 'wall' | 'eyedropper';
const GHOST_DEPTH = 2_000_000;
const NEUTRAL: ColorValue = { h: 0, s: 0, b: 0, c: 0 };

/**
 * Office layout editor (stages 1+2). Furniture place/delete, floor & wall
 * painting with colorize, and an eyedropper — all on a local working copy with
 * instant preview; Save sends it to the server (authoritative persist + sync).
 */
export class LayoutEditor {
  editing = false;
  furnitureArr: FurnitureInstance[] = [];
  layout: OfficeLayout | null = null;
  tileMap: TileTypeVal[][] = [];

  private tool: Tool = 'select';
  private selectedType: string | null = null;
  private selectedUid: string | null = null;
  private lastSelClick = { x: -999, y: -999 };
  private floorPattern = 1;
  private wallSet = 0;
  private color: ColorValue = { ...NEUTRAL };
  private ghost?: Phaser.GameObjects.Image;
  private selRect?: Phaser.GameObjects.Rectangle;
  private ghostWorld = { x: 0, y: 0 };
  private uid = 0;
  private readonly onKey = (e: KeyboardEvent) => this.handleKey(e);
  private rotateBtn!: HTMLButtonElement;
  private actionBar!: HTMLDivElement;
  private rotateBtnInBar!: HTMLButtonElement;

  // DOM
  private root!: HTMLDivElement;
  private hint!: HTMLDivElement;
  private palFurn!: HTMLDivElement;
  private palFloor!: HTMLDivElement;
  private palWall!: HTMLDivElement;
  private palBuilt = false;
  private hueEl!: HTMLInputElement;
  private satEl!: HTMLInputElement;
  private briEl!: HTMLInputElement;
  private conEl!: HTMLInputElement;
  private colorizeEl!: HTMLInputElement;
  private swatchEl!: HTMLDivElement;

  constructor(
    private readonly scene: Phaser.Scene,
    private readonly deps: EditorDeps,
  ) {
    this.buildDom();
  }

  isEditing(): boolean {
    return this.editing;
  }
  toggle(): void {
    this.editing ? this.exit() : this.enter();
  }

  private enter(): void {
    this.populatePalettes();
    this.layout = structuredClone(this.deps.getLayout());
    if (!this.layout.tileColors) {
      this.layout.tileColors = new Array(this.layout.cols * this.layout.rows).fill(null);
    }
    this.tileMap = layoutToTileMap(this.layout);
    this.editing = true;
    this.root.style.display = 'flex';
    this.ghost = this.scene.add.image(0, 0, '__WHITE').setOrigin(0, 0).setAlpha(0.55).setDepth(GHOST_DEPTH).setVisible(false);
    this.selRect = this.scene.add.rectangle(0, 0, TILE_SIZE, TILE_SIZE).setOrigin(0, 0)
      .setStrokeStyle(1, 0xffd24a, 1).setDepth(GHOST_DEPTH).setVisible(false);
    window.addEventListener('keydown', this.onKey);
    this.rebuildFurniture();
    this.deps.rebuildStatic();
  }

  private exit(): void {
    this.editing = false;
    this.layout = null;
    this.selectedUid = null;
    this.root.style.display = 'none';
    this.actionBar.style.display = 'none';
    this.ghost?.destroy();
    this.ghost = undefined;
    this.selRect?.destroy();
    this.selRect = undefined;
    window.removeEventListener('keydown', this.onKey);
    this.deps.onChange();
    this.deps.rebuildStatic();
  }

  private handleKey(e: KeyboardEvent): void {
    if (!this.editing) return;
    const typing = document.activeElement instanceof HTMLInputElement;
    if (e.key === 'Escape') {
      this.exit();
    } else if (e.key === 'r' || e.key === 'R') {
      this.rotate(e.shiftKey ? 'ccw' : 'cw');
      e.preventDefault();
    } else if (!typing) {
      const map: Record<string, Tool> = { '1': 'select', '2': 'furniture', '3': 'floor', '4': 'wall', '5': 'eyedropper' };
      if (map[e.key]) this.selectTool(map[e.key]);
      else if ((e.key === 'Delete' || e.key === 'Backspace') && this.selectedUid) this.deleteSelected();
    }
  }

  /** Rotate the selected furniture through its orientation group (R / Shift+R). */
  private rotate(dir: 'cw' | 'ccw'): void {
    if (this.tool !== 'furniture' || !this.selectedType || !isRotatable(this.selectedType)) return;
    const next = getRotatedType(this.selectedType, dir);
    if (next) {
      this.selectedType = next;
      const orient = getOrientationInGroup(next);
      this.hint.textContent = `Furniture — ${getCatalogEntry(next)?.label ?? next}${orient ? ` (${orient})` : ''} · R to rotate`;
    }
  }

  // ── Pointer dispatch (called by the scene) ───────────────────────

  handleLeftClick(wx: number, wy: number): void {
    if (!this.editing || !this.layout) return;
    const col = Math.floor(wx / TILE_SIZE);
    const row = Math.floor(wy / TILE_SIZE);
    switch (this.tool) {
      case 'select':
        this.selectAt(wx, wy);
        break;
      case 'furniture':
        this.placeFurniture(col, row);
        break;
      case 'floor':
        this.paintTile(col, row, this.floorPattern);
        break;
      case 'wall':
        this.paintTile(col, row, TileType.WALL);
        break;
      case 'eyedropper':
        this.eyedrop(wx, wy);
        break;
    }
  }

  handleRightClick(wx: number, wy: number): void {
    if (!this.editing || !this.layout) return;
    if (this.tool === 'furniture') this.deleteFurnitureAt(wx, wy);
    else if (this.tool === 'floor' || this.tool === 'wall') {
      this.paintTile(Math.floor(wx / TILE_SIZE), Math.floor(wy / TILE_SIZE), TileType.VOID);
    }
  }

  /** Pixel-accurate furniture pick: the visually top-most item whose (un-
   *  mirrored) sprite has a non-transparent pixel under the cursor. Handles
   *  overlapping pieces and sprites that extend beyond their tile footprint. */
  /** All furniture under the cursor, ordered top-most first (by render depth). */
  private furnitureHitsAt(wx: number, wy: number): string[] {
    if (!this.layout) return [];
    const hits: Array<{ uid: string; z: number }> = [];
    for (const f of this.layout.furniture) {
      const e = getCatalogEntry(f.type);
      if (!e) continue;
      const w = e.sprite[0]?.length ?? e.footprintW * TILE_SIZE;
      const h = e.sprite.length || e.footprintH * TILE_SIZE;
      const x = f.col * TILE_SIZE;
      const y = f.row * TILE_SIZE;
      if (wx < x || wy < y || wx >= x + w || wy >= y + h) continue;
      let px = Math.floor(wx - x);
      const py = Math.floor(wy - y);
      if (e.mirrorSide && getOrientationInGroup(f.type) === 'left') px = w - 1 - px;
      if (!e.sprite[py]?.[px]) continue; // transparent pixel → not a hit
      hits.push({ uid: f.uid, z: y + h });
    }
    return hits.sort((a, b) => b.z - a.z).map((hit) => hit.uid);
  }

  private furnitureHitAt(wx: number, wy: number): string | null {
    return this.furnitureHitsAt(wx, wy)[0] ?? null;
  }

  updateGhost(worldX: number, worldY: number): void {
    if (!this.editing || !this.ghost) return;
    this.ghostWorld = { x: worldX, y: worldY };
    const col = Math.floor(worldX / TILE_SIZE);
    const row = Math.floor(worldY / TILE_SIZE);
    if (this.tool === 'furniture' && this.selectedType) {
      const e = getCatalogEntry(this.selectedType);
      if (e) {
        const valid = this.canPlace(col, row, e);
        // Preview the chosen colour live on the ghost (same colour new objects
        // will be placed with).
        const ac = this.activeColor();
        const sprite = ac
          ? getColorizedSprite(`ghost-${this.selectedType}-${ac.h}-${ac.s}-${ac.b}-${ac.c}-${ac.colorize ? 1 : 0}`, e.sprite, ac)
          : e.sprite;
        this.ghost.setTexture(spriteTexture(this.scene, sprite)).setDisplaySize(e.footprintW * TILE_SIZE, e.footprintH * TILE_SIZE)
          .setPosition(col * TILE_SIZE, row * TILE_SIZE).setTint(valid ? 0xffffff : 0xff6666).setVisible(true);
        return;
      }
    }
    if (this.tool === 'floor' || this.tool === 'wall') {
      this.ghost.setTexture('__WHITE').setDisplaySize(TILE_SIZE, TILE_SIZE)
        .setPosition(col * TILE_SIZE, row * TILE_SIZE).setTint(this.tool === 'wall' ? 0x8899aa : 0x66ccff).setVisible(true);
      return;
    }
    this.ghost.setVisible(false);
  }

  // ── Edits ────────────────────────────────────────────────────────

  /** The current colour to apply, or null when fully neutral (= original look). */
  private activeColor(): ColorValue | null {
    const c = this.color;
    const neutral = c.h === 0 && c.s === 0 && c.b === 0 && c.c === 0 && !c.colorize;
    return neutral ? null : { ...c };
  }

  private placeFurniture(col: number, row: number): void {
    if (!this.selectedType || !this.layout) return;
    const e = getCatalogEntry(this.selectedType);
    if (!e || !this.canPlace(col, row, e)) return;
    const color = this.activeColor() ?? undefined;
    this.layout.furniture.push({ uid: `e${++this.uid}`, type: this.selectedType, col, row, color });
    this.rebuildFurniture();
  }

  /** Validate a furniture footprint: in-bounds, tile rules (walls), no overlap
   *  with existing items (unless it can sit on surfaces). */
  private canPlace(col: number, row: number, e: { footprintW: number; footprintH: number; canPlaceOnWalls?: boolean; canPlaceOnSurfaces?: boolean; backgroundTiles?: number }): boolean {
    if (!this.layout) return false;
    const { footprintW: w, footprintH: h } = e;
    if (col < 0 || row < 0 || col + w > this.layout.cols || row + h > this.layout.rows) return false;
    for (let dr = 0; dr < h; dr++) {
      for (let dc = 0; dc < w; dc++) {
        const t = this.tileMap[row + dr]?.[col + dc];
        if (t === TileType.VOID || t === undefined) return false;
        if (t === TileType.WALL && !e.canPlaceOnWalls) return false;
      }
    }
    if (!e.canPlaceOnSurfaces) {
      const blocked = getPlacementBlockedTiles(this.layout.furniture);
      const bg = e.backgroundTiles ?? 0;
      for (let dr = bg; dr < h; dr++) {
        for (let dc = 0; dc < w; dc++) {
          if (blocked.has(`${col + dc},${row + dr}`)) return false;
        }
      }
    }
    return true;
  }

  private deleteFurnitureAt(wx: number, wy: number): void {
    if (!this.layout) return;
    const uid = this.furnitureHitAt(wx, wy);
    if (!uid) return;
    const i = this.layout.furniture.findIndex((f) => f.uid === uid);
    if (i >= 0) {
      this.layout.furniture.splice(i, 1);
      this.rebuildFurniture();
    }
  }

  private paintTile(col: number, row: number, tile: number): void {
    if (!this.layout) return;
    if (col < 0 || row < 0 || col >= this.layout.cols || row >= this.layout.rows) return;
    const idx = row * this.layout.cols + col;
    this.layout.tiles[idx] = tile as TileTypeVal;
    this.layout.tileColors![idx] = tile === TileType.VOID ? null : { ...this.color };
    this.tileMap = layoutToTileMap(this.layout);
    this.deps.rebuildStatic();
  }

  private eyedrop(wx: number, wy: number): void {
    if (!this.layout) return;
    // Furniture first (top-most under the cursor), else the tile.
    const uid = this.furnitureHitAt(wx, wy);
    const f = uid ? this.layout.furniture.find((x) => x.uid === uid) : undefined;
    if (f) {
      this.selectTool('furniture');
      this.setSelected(f.type);
      this.applyColor(f.color ?? { h: 0, s: 0, b: 0, c: 0, colorize: false });
      return;
    }
    const col = Math.floor(wx / TILE_SIZE);
    const row = Math.floor(wy / TILE_SIZE);
    const idx = row * this.layout.cols + col;
    const t = this.layout.tiles[idx];
    if (t === TileType.WALL) this.selectTool('wall');
    else if (t !== TileType.VOID) {
      this.floorPattern = t;
      this.selectTool('floor');
      this.highlightFloorSwatch();
    }
    const c = this.layout.tileColors?.[idx];
    if (c) this.applyColor(c);
  }

  private rebuildFurniture(): void {
    if (!this.layout) return;
    this.furnitureArr = layoutToFurnitureInstances(this.layout.furniture);
    this.deps.onChange();
  }

  // ── Select / floating actions (rotate + delete above the object) ──

  private selectAt(wx: number, wy: number): void {
    const hits = this.furnitureHitsAt(wx, wy); // top-most first
    if (hits.length === 0) {
      this.selectedUid = null;
      this.lastSelClick = { x: wx, y: wy };
      this.actionBar.style.display = 'none';
      this.selRect?.setVisible(false);
      return;
    }
    // Clicking the same spot again cycles down to the object beneath — so an
    // item on a surface (e.g. a goldfish bowl on a table) doesn't trap the click.
    const samePlace = Math.abs(wx - this.lastSelClick.x) < 3 && Math.abs(wy - this.lastSelClick.y) < 3;
    this.lastSelClick = { x: wx, y: wy };
    let idx = 0;
    if (samePlace && this.selectedUid) {
      const cur = hits.indexOf(this.selectedUid);
      idx = cur >= 0 ? (cur + 1) % hits.length : 0;
    }
    this.selectedUid = hits[idx];
    // Load the object's current colour into the sliders so they reflect — and
    // then live-edit — it.
    const f = this.layout?.furniture.find((x) => x.uid === this.selectedUid);
    this.applyColor(f?.color ?? { h: 0, s: 0, b: 0, c: 0, colorize: false });
  }

  private rotateSelected(): void {
    const f = this.layout?.furniture.find((x) => x.uid === this.selectedUid);
    if (!f || !isRotatable(f.type)) return;
    f.type = getRotatedType(f.type, 'cw') ?? f.type;
    this.rebuildFurniture();
  }

  private deleteSelected(): void {
    if (!this.layout || !this.selectedUid) return;
    const i = this.layout.furniture.findIndex((x) => x.uid === this.selectedUid);
    if (i >= 0) this.layout.furniture.splice(i, 1);
    this.selectedUid = null;
    this.actionBar.style.display = 'none';
    this.selRect?.setVisible(false);
    this.rebuildFurniture();
  }

  /** Position the floating action bar + selection outline above the selected
   *  furniture each frame (camera-correct). Called by the scene's update(). */
  tickUI(): void {
    if (!this.editing || this.tool !== 'select' || !this.selectedUid || !this.layout) {
      this.actionBar.style.display = 'none';
      this.selRect?.setVisible(false);
      return;
    }
    const f = this.layout.furniture.find((x) => x.uid === this.selectedUid);
    const e = f && getCatalogEntry(f.type);
    if (!f || !e) {
      this.actionBar.style.display = 'none';
      this.selRect?.setVisible(false);
      return;
    }
    const wpx = f.col * TILE_SIZE;
    const wpy = f.row * TILE_SIZE;
    const ww = e.footprintW * TILE_SIZE;
    const wh = e.footprintH * TILE_SIZE;
    this.selRect?.setPosition(wpx, wpy).setSize(ww, wh).setVisible(true);

    const cam = this.scene.cameras.main;
    const wv = cam.worldView;
    const sx = (wpx + ww / 2 - wv.x) * cam.zoom;
    const sy = (wpy - wv.y) * cam.zoom;
    this.actionBar.style.left = `${Math.round(sx)}px`;
    this.actionBar.style.top = `${Math.round(sy)}px`;
    this.actionBar.style.display = 'flex';
    this.rotateBtnInBar.style.display = isRotatable(f.type) ? 'inline-block' : 'none';
  }

  // ── Color ────────────────────────────────────────────────────────

  private readColor(): void {
    this.color = {
      h: Number(this.hueEl.value),
      s: Number(this.satEl.value),
      b: Number(this.briEl.value),
      c: Number(this.conEl.value),
      colorize: this.colorizeEl.checked,
    };
    this.updateSwatch();
    // Live-recolor the currently selected object as the sliders move.
    if (this.tool === 'select' && this.selectedUid && this.layout) {
      const f = this.layout.furniture.find((x) => x.uid === this.selectedUid);
      if (f) {
        const ac = this.activeColor();
        if (ac) f.color = ac;
        else delete f.color;
        this.rebuildFurniture();
      }
    } else if (this.tool === 'furniture') {
      // Live-preview the colour on the placement ghost.
      this.updateGhost(this.ghostWorld.x, this.ghostWorld.y);
    }
  }
  private applyColor(c: ColorValue): void {
    this.color = { ...c };
    this.hueEl.value = String(c.h ?? 0);
    this.satEl.value = String(c.s ?? 0);
    this.briEl.value = String(c.b ?? 0);
    this.conEl.value = String(c.c ?? 0);
    this.colorizeEl.checked = !!c.colorize;
    this.updateSwatch();
  }
  private updateSwatch(): void {
    // Truthful preview of the colorize result: saturation 0 → grey (matches the
    // engine's s/100), lightness from brightness.
    const h = this.color.h ?? 0;
    const s = Math.max(0, Math.min(100, this.color.s ?? 0));
    const l = Math.max(8, Math.min(92, 55 + (this.color.b ?? 0) / 2));
    this.swatchEl.style.background = `hsl(${h} ${s}% ${l}%)`;
  }

  // ── Tool / selection UI ──────────────────────────────────────────

  private selectTool(t: Tool): void {
    this.tool = t;
    this.palFurn.style.display = t === 'furniture' ? 'grid' : 'none';
    this.palFloor.style.display = t === 'floor' ? 'grid' : 'none';
    if (this.palWall) this.palWall.style.display = t === 'wall' ? 'grid' : 'none';
    if (this.rotateBtn) this.rotateBtn.style.display = t === 'furniture' ? 'block' : 'none';
    if (t !== 'select') {
      this.selectedUid = null;
      if (this.actionBar) this.actionBar.style.display = 'none';
      this.selRect?.setVisible(false);
    }
    this.root.querySelectorAll<HTMLElement>('.pa-tool').forEach((el) => el.classList.toggle('sel', el.dataset.tool === t));
    const labels: Record<Tool, string> = {
      select: 'Select — click an object for rotate / delete buttons',
      furniture: 'Furniture — left-click place, right-click remove',
      floor: 'Floor — left-click paint, right-click erase',
      wall: 'Wall — left-click paint, right-click erase',
      eyedropper: 'Eyedropper — click to pick a tile/furniture',
    };
    this.hint.textContent = labels[t];
  }

  private setSelected(type: string): void {
    this.selectedType = type;
    this.palFurn.querySelectorAll<HTMLElement>('.pa-pal-item').forEach((el) => el.classList.toggle('sel', el.dataset.type === type));
  }

  private highlightFloorSwatch(): void {
    this.palFloor.querySelectorAll<HTMLElement>('.pa-pal-item').forEach((el) => el.classList.toggle('sel', Number(el.dataset.pattern) === this.floorPattern));
  }

  // ── DOM ──────────────────────────────────────────────────────────

  private buildDom(): void {
    const style = document.createElement('style');
    style.textContent = `
      #pa-editor{position:fixed;top:0;left:0;bottom:0;z-index:55;display:none;flex-direction:column;
        width:300px;background:#161a22;border-right:2px solid #3a4150;color:#eef1f6;
        font-family:'FS Pixel Sans',ui-monospace,monospace;font-size:14px;}
      #pa-editor .bar{display:flex;gap:8px;padding:10px;border-bottom:2px solid #3a4150;}
      #pa-editor .bar button{flex:1;cursor:pointer;background:#2a2f3a;border:1px solid #3a4150;
        color:#eef1f6;border-radius:5px;font:16px 'FS Pixel Sans',monospace;padding:8px;}
      #pa-editor .bar button.save{background:#2f6d3a;border-color:#3c8a4c;}
      #pa-editor .tools{display:flex;gap:6px;padding:8px 10px;}
      #pa-editor .tools .pa-tool{flex:1;cursor:pointer;background:#1b1f2a;border:2px solid #2a2f3a;
        color:#eef1f6;border-radius:5px;font:14px 'FS Pixel Sans',monospace;padding:7px 4px;}
      #pa-editor .tools .pa-tool.sel{border-color:#ffd24a;}
      #pa-editor .hint{padding:4px 10px 8px;font-size:13px;color:#9aa4b2;}
      #pa-editor .color{display:flex;flex-direction:column;gap:5px;padding:8px 10px;border-top:1px solid #2a2f3a;border-bottom:1px solid #2a2f3a;}
      #pa-editor .color .rowc{display:flex;align-items:center;gap:8px;font-size:13px;}
      #pa-editor .color .rowc span{width:34px;color:#9aa4b2;}
      #pa-editor .color input[type=range]{flex:1;}
      #pa-editor .sw{width:26px;height:18px;border:1px solid #3a4150;border-radius:3px;}
      .pa-pal{flex:1;overflow-y:auto;display:grid;grid-template-columns:repeat(4,1fr);gap:6px;padding:10px;align-content:start;}
      .pa-pal-item{display:flex;align-items:center;justify-content:center;height:54px;cursor:pointer;
        background:#1b1f2a;border:2px solid #2a2f3a;border-radius:6px;padding:4px;}
      .pa-pal-item.sel{border-color:#ffd24a;}
      .pa-pal-item img{max-width:44px;max-height:44px;image-rendering:pixelated;}
    `;
    document.head.appendChild(style);

    const root = document.createElement('div');
    root.id = 'pa-editor';

    const bar = document.createElement('div');
    bar.className = 'bar';
    const saveBtn = Object.assign(document.createElement('button'), { className: 'save', textContent: '✓ Save' });
    saveBtn.onclick = () => this.layout && this.deps.save(this.layout);
    const cancelBtn = Object.assign(document.createElement('button'), { textContent: '✕ Cancel' });
    cancelBtn.onclick = () => this.exit();
    bar.append(saveBtn, cancelBtn);

    const tools = document.createElement('div');
    tools.className = 'tools';
    for (const [t, label] of [['select', 'Select'], ['furniture', 'Furn'], ['floor', 'Floor'], ['wall', 'Wall'], ['eyedropper', 'Pick']] as const) {
      const b = document.createElement('button');
      b.className = 'pa-tool';
      b.dataset.tool = t;
      b.textContent = label;
      b.onclick = () => this.selectTool(t);
      tools.appendChild(b);
    }

    this.hint = Object.assign(document.createElement('div'), { className: 'hint' });

    this.rotateBtn = document.createElement('button');
    this.rotateBtn.className = 'pa-tool';
    this.rotateBtn.textContent = '⟳ Rotate (R)';
    this.rotateBtn.style.cssText = 'margin:0 10px 8px;cursor:pointer;background:#1b1f2a;border:2px solid #2a2f3a;color:#eef1f6;border-radius:5px;font:14px "FS Pixel Sans",monospace;padding:7px;';
    this.rotateBtn.onclick = () => this.rotate('cw');

    // Color controls
    const color = document.createElement('div');
    color.className = 'color';
    const mkRange = (label: string, min: number, max: number, val: number) => {
      const row = document.createElement('div');
      row.className = 'rowc';
      const span = Object.assign(document.createElement('span'), { textContent: label });
      const input = document.createElement('input');
      input.type = 'range';
      input.min = String(min);
      input.max = String(max);
      input.value = String(val);
      input.oninput = () => this.readColor();
      row.append(span, input);
      color.appendChild(row);
      return input;
    };
    this.hueEl = mkRange('Hue', 0, 360, 0);
    this.satEl = mkRange('Sat', 0, 100, 0); // 0 = neutral/no tint, 100 = full colour
    this.briEl = mkRange('Bright', -100, 100, 0);
    this.conEl = mkRange('Contrast', -100, 100, 0);
    const crow = document.createElement('div');
    crow.className = 'rowc';
    this.colorizeEl = document.createElement('input');
    this.colorizeEl.type = 'checkbox';
    this.colorizeEl.id = 'pa-colorize';
    this.colorizeEl.onchange = () => this.readColor();
    const clab = Object.assign(document.createElement('label'), { textContent: 'Colorize', htmlFor: 'pa-colorize' });
    clab.style.flex = '1';
    this.swatchEl = Object.assign(document.createElement('div'), { className: 'sw' });
    crow.append(this.colorizeEl, clab, this.swatchEl);
    color.appendChild(crow);

    this.palFurn = Object.assign(document.createElement('div'), { className: 'pa-pal' });
    this.palFloor = Object.assign(document.createElement('div'), { className: 'pa-pal' });
    this.palWall = Object.assign(document.createElement('div'), { className: 'pa-pal' });
    this.palFloor.style.display = 'none';
    this.palWall.style.display = 'none';

    root.append(bar, tools, this.hint, this.rotateBtn, color, this.palFurn, this.palFloor, this.palWall);
    const host = document.getElementById('game') ?? document.body;
    host.appendChild(root);
    this.root = root;

    // Floating action bar that hovers above the selected furniture.
    this.actionBar = document.createElement('div');
    this.actionBar.style.cssText =
      'position:absolute;z-index:58;transform:translate(-50%,-100%);display:none;gap:6px;' +
      'margin-top:-6px;pointer-events:auto;';
    const mkAct = (txt: string, title: string, onClick: () => void) => {
      const b = document.createElement('button');
      b.textContent = txt;
      b.title = title;
      b.style.cssText =
        "cursor:pointer;width:34px;height:34px;background:#1b1f2a;border:2px solid #3a4150;" +
        "border-radius:6px;color:#eef1f6;font:18px 'FS Pixel Sans',monospace;box-shadow:0 2px 0 rgba(0,0,0,.4);";
      b.onclick = onClick;
      return b;
    };
    this.rotateBtnInBar = mkAct('⟳', 'Rotate (R)', () => this.rotateSelected());
    const delBtn = mkAct('✕', 'Delete (Del)', () => this.deleteSelected());
    delBtn.style.borderColor = '#7a3a3a';
    this.actionBar.append(this.rotateBtnInBar, delBtn);
    host.appendChild(this.actionBar);

    this.selectTool('select');
    this.updateSwatch();
  }

  private populatePalettes(): void {
    if (this.palBuilt) return;
    let count = 0;
    for (const cat of getActiveCategories()) {
      for (const entry of getCatalogByCategory(cat.id)) {
        const item = document.createElement('div');
        item.className = 'pa-pal-item';
        item.dataset.type = entry.type;
        item.title = entry.label;
        const img = Object.assign(document.createElement('img'), { src: spriteToDataURL(entry.sprite) });
        item.appendChild(img);
        item.onclick = () => this.setSelected(entry.type);
        this.palFurn.appendChild(item);
        count++;
      }
    }
    const patterns = Math.max(getFloorPatternCount(), 1);
    for (let p = 1; p <= patterns; p++) {
      const item = document.createElement('div');
      item.className = 'pa-pal-item';
      item.dataset.pattern = String(p);
      const img = Object.assign(document.createElement('img'), { src: spriteToDataURL(getColorizedFloorSprite(p, NEUTRAL)) });
      item.appendChild(img);
      item.onclick = () => {
        this.floorPattern = p;
        this.highlightFloorSwatch();
      };
      this.palFloor.appendChild(item);
    }
    // Wall sets (the "wall symbol" — paint with the chosen wall style).
    const wallCount = Math.max(getWallSetCount(), 1);
    for (let s = 0; s < wallCount; s++) {
      const sprite = getWallSetPreviewSprite(s);
      if (!sprite) continue;
      const item = document.createElement('div');
      item.className = 'pa-pal-item';
      item.dataset.wall = String(s);
      if (s === this.wallSet) item.classList.add('sel');
      const img = Object.assign(document.createElement('img'), { src: spriteToDataURL(sprite) });
      item.appendChild(img);
      item.onclick = () => {
        this.wallSet = s;
        this.palWall.querySelectorAll<HTMLElement>('.pa-pal-item').forEach((el) => el.classList.toggle('sel', Number(el.dataset.wall) === s));
      };
      this.palWall.appendChild(item);
    }
    if (count > 0) this.palBuilt = true;
  }
}
