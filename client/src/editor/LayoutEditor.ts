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
import { getWallSetCount, getWallSetPreviewSprite, wallColorToHex } from '@pixel/shared/office/wallTiles.js';
import {
  Direction,
  TILE_SIZE,
  TileType,
  type FurnitureInstance,
  type OfficeLayout,
  type TileType as TileTypeVal,
} from '@pixel/shared/office/types.js';
import { getColorizedSprite } from '@pixel/shared/office/colorize.js';
import { MAX_COLS, MAX_ROWS } from '@pixel/shared/office/constants.js';
import type { ColorValue } from '@pixel/shared/office/colorTypes.js';

import { spriteTexture, spriteToDataURL } from '../render/sprites.js';
import { promptDialog } from '../ui/dialog.js';
import { cleanName, MAX_NAME_LEN } from '@pixel/shared/protocol';

export interface EditorDeps {
  getLayout: () => OfficeLayout;
  /** Re-render furniture from the editor's working copy. */
  onChange: () => void;
  /** Re-render floor/walls from the editor's working copy. */
  rebuildStatic: () => void;
  /**
   * An edit happened — the scene autosaves it (debounced, broadcast to all
   * viewers). `immediate` flushes the debounce now (gesture committed).
   */
  onEdit: (layout: OfficeLayout, immediate: boolean) => void;
  /** Notify the scene when edit mode starts/stops (e.g. to disable other menus). */
  onEditingChange: (editing: boolean) => void;
}

type Tool = 'select' | 'furniture' | 'floor' | 'wall' | 'block' | 'eyedropper';
const GHOST_DEPTH = 2_000_000;
const GRID_DEPTH = GHOST_DEPTH - 1;
const NEUTRAL: ColorValue = { h: 0, s: 0, b: 0, c: 0 };

// Edit-mode grid overlay colours (ported 1:1 from the pre-Phaser renderer —
// see shared GRID_LINE_COLOR / VOID_TILE_OUTLINE_COLOR / GHOST_BORDER_* ).
const GRID_LINE = { color: 0xffffff, alpha: 0.12 };
const VOID_OUTLINE = { color: 0xffffff, alpha: 0.08 };
const GHOST_RING = { color: 0xffffff, alpha: 0.06 };
const GHOST_HOVER = { color: 0x3c82dc, stroke: 0.5, fill: 0.25 };
const BLOCKED_TILE = { color: 0xe0342a, stroke: 0.6, fill: 0.22 };
const DASH = 2;
const DASH_GAP = 2;
const MAX_HISTORY = 50;
type ExpandDirection = 'left' | 'right' | 'up' | 'down';

/** '#rrggbb' → 0xRRGGBB for Phaser tints. */
function hexToTint(hex: string): number {
  return parseInt(hex.replace('#', ''), 16) || 0xffffff;
}

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
  /** Edit-mode tile grid + void/expansion outlines (redrawn on edit/hover/zoom). */
  private grid?: Phaser.GameObjects.Graphics;
  private gridZoom = 0;
  private ghostHover = { col: -999, row: -999 };
  /** Last tile painted in the current drag-paint stroke (per-tile dedup). */
  private lastPaint = { col: NaN, row: NaN };
  private ghostWorld = { x: 0, y: 0 };
  private uid = 0;
  /** Undo/redo are full-layout snapshots (v1 model); capped at MAX_HISTORY. */
  private undoStack: OfficeLayout[] = [];
  private redoStack: OfficeLayout[] = [];
  /** True while a color-slider drag is the active gesture (one undo per drag). */
  private colorGesture = false;
  /** Drag-to-move state: uid being dragged + cursor→tile grab offset. */
  private dragUid: string | null = null;
  private dragGrab = { dc: 0, dr: 0 };
  private dragMoved = false;
  private readonly onKey = (e: KeyboardEvent) => this.handleKey(e);
  private rotateBtn!: HTMLButtonElement;
  private actionBar!: HTMLDivElement;
  private rotateBtnInBar!: HTMLButtonElement;
  private nameBtnInBar!: HTMLButtonElement;
  private flipFacingBtnInBar!: HTMLButtonElement;
  private undoBtn!: HTMLButtonElement;
  private redoBtn!: HTMLButtonElement;

  // DOM
  private root!: HTMLDivElement;
  private hint!: HTMLDivElement;
  private palFurn!: HTMLDivElement;
  private palFloor!: HTMLDivElement;
  private palWall!: HTMLDivElement;
  private palBuilt = false;
  /** Floor/wall palette previews, kept so they can re-render in the picked color. */
  private floorItems: Array<{ img: HTMLImageElement; pattern: number }> = [];
  private wallItems: Array<{ img: HTMLImageElement; set: number }> = [];
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
    if (!this.layout.tileBlocked) {
      this.layout.tileBlocked = new Array(this.layout.cols * this.layout.rows).fill(false);
    }
    this.ensureUniqueUids();
    this.tileMap = layoutToTileMap(this.layout);
    this.undoStack = [];
    this.redoStack = [];
    this.colorGesture = false;
    this.dragUid = null;
    this.editing = true;
    this.root.style.display = 'flex';
    this.refreshHistoryButtons();
    this.ghost = this.scene.add.image(0, 0, '__WHITE').setOrigin(0, 0).setAlpha(0.55).setDepth(GHOST_DEPTH).setVisible(false);
    this.selRect = this.scene.add.rectangle(0, 0, TILE_SIZE, TILE_SIZE).setOrigin(0, 0)
      .setStrokeStyle(1, 0xffd24a, 1).setDepth(GHOST_DEPTH).setVisible(false);
    this.grid = this.scene.add.graphics().setDepth(GRID_DEPTH);
    this.ghostHover = { col: -999, row: -999 };
    window.addEventListener('keydown', this.onKey);
    this.rebuildFurniture();
    this.deps.rebuildStatic();
    this.drawGrid();
    this.deps.onEditingChange(true);
  }

  private exit(): void {
    // Finalize any in-flight gesture so its last state is flushed by the scene.
    if (this.colorGesture && this.layout) this.deps.onEdit(this.layout, true);
    this.colorGesture = false;
    this.dragUid = null;
    this.editing = false;
    this.layout = null;
    this.selectedUid = null;
    this.root.style.display = 'none';
    this.actionBar.style.display = 'none';
    this.ghost?.destroy();
    this.ghost = undefined;
    this.selRect?.destroy();
    this.selRect = undefined;
    this.grid?.destroy();
    this.grid = undefined;
    window.removeEventListener('keydown', this.onKey);
    this.deps.onChange();
    this.deps.rebuildStatic();
    this.deps.onEditingChange(false);
  }

  private handleKey(e: KeyboardEvent): void {
    if (!this.editing) return;
    // Don't steal keystrokes while the user is typing in a field (e.g. a name
    // input or prompt) — otherwise shortcuts like R (rotate) eat letters.
    const el = document.activeElement;
    const typing =
      el instanceof HTMLInputElement ||
      el instanceof HTMLTextAreaElement ||
      el instanceof HTMLSelectElement ||
      (el instanceof HTMLElement && el.isContentEditable);
    const mod = e.ctrlKey || e.metaKey;
    if (mod && (e.key === 'z' || e.key === 'Z')) {
      e.preventDefault();
      e.shiftKey ? this.redo() : this.undo();
      return;
    }
    if (mod && (e.key === 'y' || e.key === 'Y')) {
      e.preventDefault();
      this.redo();
      return;
    }
    // Shortcuts that must never fire mid-typing are all gated behind !typing.
    if (e.key === 'Escape') {
      this.exit();
    } else if (!typing && (e.key === 'r' || e.key === 'R')) {
      this.rotate(e.shiftKey ? 'ccw' : 'cw');
      e.preventDefault();
    } else if (!typing) {
      const map: Record<string, Tool> = { '1': 'select', '2': 'furniture', '3': 'floor', '4': 'wall', '5': 'block', '6': 'eyedropper' };
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
      case 'floor': {
        // Painting on the ghost-border ring grows the office by one tile.
        const adj = this.maybeExpand(col, row);
        this.paintTile(adj?.col ?? col, adj?.row ?? row, this.floorPattern);
        break;
      }
      case 'wall': {
        const adj = this.maybeExpand(col, row);
        this.paintTile(adj?.col ?? col, adj?.row ?? row, TileType.WALL);
        break;
      }
      case 'block':
        this.paintBlocked(col, row, true);
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
    } else if (this.tool === 'block') {
      this.paintBlocked(Math.floor(wx / TILE_SIZE), Math.floor(wy / TILE_SIZE), false);
    }
  }

  /** Floor/Wall/Block are paint tools — the scene lets you drag-paint with them
   *  (and pans with the middle mouse instead of the left button). */
  isPaintTool(): boolean {
    return this.tool === 'floor' || this.tool === 'wall' || this.tool === 'block';
  }

  /** Begin a drag-paint stroke: reset the per-tile dedup and snapshot for undo
   *  (the whole stroke is one undo step). */
  beginStroke(): void {
    this.lastPaint = { col: NaN, row: NaN };
    this.beginGesture();
  }

  /** End a paint stroke — flush the autosave for the completed stroke. */
  endStroke(): void {
    if (this.layout) this.deps.onEdit(this.layout, true);
  }

  /** Paint (or erase) the tile under the cursor during a drag, skipping tiles
   *  already painted this stroke so a stroke maps to one edit per tile. */
  strokePaint(wx: number, wy: number, erase: boolean): void {
    if (!this.editing || !this.layout) return;
    const col = Math.floor(wx / TILE_SIZE);
    const row = Math.floor(wy / TILE_SIZE);
    if (col === this.lastPaint.col && row === this.lastPaint.row) return;
    this.lastPaint = { col, row };
    if (erase) this.handleRightClick(wx, wy);
    else this.handleLeftClick(wx, wy);
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
    // Highlight the hovered expansion tile on the ghost-border ring.
    const hover = this.tool === 'floor' || this.tool === 'wall' ? { col, row } : { col: -999, row: -999 };
    if (hover.col !== this.ghostHover.col || hover.row !== this.ghostHover.row) {
      this.ghostHover = hover;
      this.drawGrid();
    }
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
    if (this.tool === 'floor') {
      // Preview the floor tile in the chosen colour (live as sliders move).
      const tex = spriteTexture(this.scene, getColorizedFloorSprite(this.floorPattern, this.activeColor() ?? NEUTRAL));
      this.ghost.setTexture(tex).setDisplaySize(TILE_SIZE, TILE_SIZE)
        .setPosition(col * TILE_SIZE, row * TILE_SIZE).setTint(0xffffff).setVisible(true);
      return;
    }
    if (this.tool === 'wall') {
      // Preview the wall tile tinted with the chosen wall colour.
      const tint = hexToTint(wallColorToHex(this.color));
      this.ghost.setTexture('__WHITE').setDisplaySize(TILE_SIZE, TILE_SIZE)
        .setPosition(col * TILE_SIZE, row * TILE_SIZE).setTint(tint).setVisible(true);
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
    this.beginGesture();
    this.layout.furniture.push({ uid: this.nextUid(), type: this.selectedType, col, row, color });
    this.rebuildFurniture();
    this.deps.onEdit(this.layout, true);
  }

  /**
   * Validate a furniture footprint: in-bounds, tile rules, no overlap with other
   * items (unless it sits on surfaces). Wall-mounted items (canPlaceOnWalls)
   * follow v1's rule — only the BOTTOM row must sit on a wall; the upper rows
   * hang above it (over VOID, or even above the map), so e.g. a 2-tall bookshelf
   * mounts on the wall row with its body hanging over the void above it.
   *
   * canPlaceOnFloor lets a wall-mountable item ALSO go on ordinary floor tiles
   * (e.g. a monitor that can stand on the floor/a desk or hang on a wall) — the
   * spot is valid if EITHER the wall rule or the floor rule passes.
   */
  private canPlace(
    col: number,
    row: number,
    e: {
      footprintW: number;
      footprintH: number;
      canPlaceOnWalls?: boolean;
      canPlaceOnFloor?: boolean;
      canPlaceOnSurfaces?: boolean;
      backgroundTiles?: number;
    },
    excludeUid?: string,
  ): boolean {
    if (!this.layout) return false;
    const { footprintW: w, footprintH: h } = e;
    const bg = e.backgroundTiles ?? 0;
    const wallCapable = !!e.canPlaceOnWalls;
    const floorCapable = !wallCapable || !!e.canPlaceOnFloor;

    if (col < 0 || col + w > this.layout.cols) return false;
    const wallOk = wallCapable && this.wallFootprintOk(col, row, w, h);
    const floorOk = floorCapable && this.floorFootprintOk(col, row, w, h, bg);
    if (!wallOk && !floorOk) return false;

    if (!e.canPlaceOnSurfaces) {
      // Surface items (e.g. a PC on a desk) sit ON TOP of base furniture, so they
      // must not block a base item — otherwise a table can't be moved back under
      // the PC that was on it. Also exclude the piece being moved (self-collision).
      const others = this.layout.furniture.filter((f) => {
        if (f.uid === excludeUid) return false;
        return !getCatalogEntry(f.type)?.canPlaceOnSurfaces;
      });
      const blocked = getPlacementBlockedTiles(others);
      for (let dr = bg; dr < h; dr++) {
        if (row + dr < 0) continue;
        for (let dc = 0; dc < w; dc++) {
          if (blocked.has(`${col + dc},${row + dr}`)) return false;
        }
      }
    }
    return true;
  }

  /** Wall-mounted footprint rule (v1): only the bottom row must sit on a WALL
   *  tile; upper rows may hang over void (or above the map entirely). */
  private wallFootprintOk(col: number, row: number, w: number, h: number): boolean {
    if (!this.layout) return false;
    const bottom = row + h - 1;
    if (bottom < 0 || bottom >= this.layout.rows) return false;
    for (let dc = 0; dc < w; dc++) {
      if (this.tileMap[bottom]?.[col + dc] !== TileType.WALL) return false;
    }
    return true;
  }

  /** Ordinary floor footprint rule: the whole footprint (minus background rows)
   *  must sit on real floor tiles — not void, not a wall. */
  private floorFootprintOk(col: number, row: number, w: number, h: number, bg: number): boolean {
    if (!this.layout) return false;
    if (row < 0 || row + h > this.layout.rows) return false;
    for (let dr = bg; dr < h; dr++) {
      for (let dc = 0; dc < w; dc++) {
        const t = this.tileMap[row + dr]?.[col + dc];
        if (t === TileType.VOID || t === undefined || t === TileType.WALL) return false;
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
      this.beginGesture();
      this.layout.furniture.splice(i, 1);
      this.rebuildFurniture();
      this.deps.onEdit(this.layout, true);
    }
  }

  /** Paint one tile. Called within a paint stroke (the stroke owns the undo
   *  snapshot via beginStroke/endStroke); autosave is scheduled debounced. */
  private paintTile(col: number, row: number, tile: number): void {
    if (!this.layout) return;
    if (col < 0 || row < 0 || col >= this.layout.cols || row >= this.layout.rows) return;
    const idx = row * this.layout.cols + col;
    this.layout.tiles[idx] = tile as TileTypeVal;
    this.layout.tileColors![idx] = tile === TileType.VOID ? null : { ...this.color };
    this.tileMap = layoutToTileMap(this.layout);
    this.deps.rebuildStatic();
    this.drawGrid();
    this.deps.onEdit(this.layout, false);
  }

  /** Paint (or clear) the "blocks movement" flag on one tile — independent of
   *  floor pattern (see OfficeLayout.tileBlocked). No sprite/tileMap change,
   *  just the edit-mode overlay (drawGrid) and autosave. */
  private paintBlocked(col: number, row: number, blocked: boolean): void {
    if (!this.layout) return;
    if (col < 0 || row < 0 || col >= this.layout.cols || row >= this.layout.rows) return;
    if (!this.layout.tileBlocked) this.layout.tileBlocked = new Array(this.layout.cols * this.layout.rows).fill(false);
    this.layout.tileBlocked[row * this.layout.cols + col] = blocked;
    this.drawGrid();
    this.deps.onEdit(this.layout, false);
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

  /** A fresh `e<n>` uid that can't collide with anything already in the layout. */
  private nextUid(): string {
    return `e${++this.uid}`;
  }

  // ── Undo / redo (full-layout snapshots, v1 model) ────────────────

  /** Snapshot the current layout for undo. Call BEFORE mutating, once per
   *  gesture (single op, paint stroke, color drag, or drag-move). */
  private beginGesture(): void {
    if (!this.layout) return;
    this.undoStack.push(structuredClone(this.layout));
    if (this.undoStack.length > MAX_HISTORY) this.undoStack.shift();
    this.redoStack = [];
    this.refreshHistoryButtons();
  }

  undo(): void {
    if (!this.editing || !this.layout || this.undoStack.length === 0) return;
    this.redoStack.push(structuredClone(this.layout));
    this.restore(this.undoStack.pop()!);
  }

  redo(): void {
    if (!this.editing || !this.layout || this.redoStack.length === 0) return;
    this.undoStack.push(structuredClone(this.layout));
    this.restore(this.redoStack.pop()!);
  }

  /** Replace the working layout with a snapshot, re-render, and broadcast it. */
  private restore(layout: OfficeLayout): void {
    this.layout = layout;
    this.tileMap = layoutToTileMap(layout);
    this.selectedUid = null;
    this.colorGesture = false;
    this.actionBar.style.display = 'none';
    this.selRect?.setVisible(false);
    this.rebuildFurniture();
    this.deps.rebuildStatic();
    this.drawGrid();
    this.deps.onEdit(layout, true);
    this.refreshHistoryButtons();
  }

  private refreshHistoryButtons(): void {
    const set = (b: HTMLButtonElement | undefined, enabled: boolean) => {
      if (!b) return;
      b.disabled = !enabled;
      b.style.opacity = enabled ? '1' : '0.4';
    };
    set(this.undoBtn, this.undoStack.length > 0);
    set(this.redoBtn, this.redoStack.length > 0);
  }

  // ── Drag-to-move furniture (Select tool) ─────────────────────────

  /** Grab the furniture under the cursor for dragging. Returns false if none
   *  (or not in select tool) so the scene can pan/select instead. */
  beginFurnitureDrag(wx: number, wy: number): boolean {
    if (!this.editing || this.tool !== 'select' || !this.layout) return false;
    const uid = this.furnitureHitAt(wx, wy);
    const f = uid ? this.layout.furniture.find((x) => x.uid === uid) : undefined;
    if (!uid || !f) return false;
    this.dragUid = uid;
    this.dragGrab = { dc: Math.floor(wx / TILE_SIZE) - f.col, dr: Math.floor(wy / TILE_SIZE) - f.row };
    this.dragMoved = false;
    return true;
  }

  isDraggingFurniture(): boolean {
    return this.dragUid !== null;
  }

  /** Preview the dragged piece at the cursor's target tile (tinted by validity). */
  dragFurnitureTo(wx: number, wy: number): void {
    if (!this.dragUid || !this.layout || !this.ghost) return;
    this.dragMoved = true;
    const f = this.layout.furniture.find((x) => x.uid === this.dragUid);
    const e = f && getCatalogEntry(f.type);
    if (!f || !e) return;
    const col = Math.floor(wx / TILE_SIZE) - this.dragGrab.dc;
    const row = Math.floor(wy / TILE_SIZE) - this.dragGrab.dr;
    const valid = this.canPlace(col, row, e, this.dragUid);
    const ac = f.color;
    const sprite = ac
      ? getColorizedSprite(`drag-${f.type}-${ac.h}-${ac.s}-${ac.b}-${ac.c}-${ac.colorize ? 1 : 0}`, e.sprite, ac)
      : e.sprite;
    this.ghost.setTexture(spriteTexture(this.scene, sprite)).setDisplaySize(e.footprintW * TILE_SIZE, e.footprintH * TILE_SIZE)
      .setPosition(col * TILE_SIZE, row * TILE_SIZE).setTint(valid ? 0xffffff : 0xff6666).setVisible(true);
    this.selRect?.setVisible(false);
  }

  /** Commit (or cancel) the move. A no-move drag falls back to click-select. */
  endFurnitureDrag(wx: number, wy: number): void {
    const uid = this.dragUid;
    this.dragUid = null;
    this.ghost?.setVisible(false);
    if (!uid || !this.layout) return;
    if (!this.dragMoved) {
      this.selectAt(wx, wy);
      return;
    }
    const f = this.layout.furniture.find((x) => x.uid === uid);
    const e = f && getCatalogEntry(f.type);
    if (!f || !e) return;
    const col = Math.floor(wx / TILE_SIZE) - this.dragGrab.dc;
    const row = Math.floor(wy / TILE_SIZE) - this.dragGrab.dr;
    if ((col === f.col && row === f.row) || !this.canPlace(col, row, e, uid)) {
      this.selectedUid = uid; // invalid/no-op drop → keep it selected, snap back
      return;
    }
    this.beginGesture();
    f.col = col;
    f.row = row;
    this.selectedUid = uid;
    this.rebuildFurniture();
    this.deps.onEdit(this.layout, true);
  }

  /**
   * Guarantee every furniture item has a unique uid. The `e<n>` counter resets
   * each edit session, so a freshly placed item could otherwise reuse an `e<n>`
   * saved earlier — making `furniture.find(uid)` resolve to the wrong piece
   * (e.g. selecting a desk would pick the goldfish bowl that shared its uid).
   * Seeds the counter past existing ids and reassigns any duplicate/blank ones.
   */
  private ensureUniqueUids(): void {
    if (!this.layout) return;
    let max = 0;
    for (const f of this.layout.furniture) {
      const m = /^e(\d+)$/.exec(f.uid ?? '');
      if (m) max = Math.max(max, Number(m[1]));
    }
    this.uid = max;
    const seen = new Set<string>();
    for (const f of this.layout.furniture) {
      if (!f.uid || seen.has(f.uid)) f.uid = this.nextUid();
      seen.add(f.uid);
    }
  }

  // ── Grid + expansion (ported from the pre-Phaser editor) ─────────

  /**
   * Draw the edit-mode overlay: a tile grid across the current bounds, dashed
   * outlines on VOID tiles, and — for floor/wall tools — a dashed "ghost border"
   * ring one tile outside the bounds. Painting on that ring grows the office,
   * so the grid only ever hugs the set tiles and expands as you place them.
   */
  private drawGrid(): void {
    if (!this.grid || !this.layout) return;
    const g = this.grid;
    const s = TILE_SIZE;
    const { cols, rows } = this.layout;
    // Camera-zoom-independent ~1px lines.
    const lw = 1 / (this.scene.cameras.main.zoom || 1);
    this.gridZoom = this.scene.cameras.main.zoom;
    g.clear();

    // Grid lines over the set-tile bounds.
    g.lineStyle(lw, GRID_LINE.color, GRID_LINE.alpha);
    g.beginPath();
    for (let c = 0; c <= cols; c++) {
      g.moveTo(c * s, 0);
      g.lineTo(c * s, rows * s);
    }
    for (let r = 0; r <= rows; r++) {
      g.moveTo(0, r * s);
      g.lineTo(cols * s, r * s);
    }
    g.strokePath();

    // Dashed outlines on VOID tiles inside the bounds.
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        if (this.tileMap[r]?.[c] === TileType.VOID) {
          this.dashedRect(g, c * s, r * s, s, s, VOID_OUTLINE.color, VOID_OUTLINE.alpha, lw);
        }
      }
    }

    // Tiles marked non-walkable (layout.tileBlocked, independent of floor
    // pattern) — a red hatch so it's visible while editing no matter which
    // tool is active, same as the VOID outline above.
    if (this.layout.tileBlocked) {
      for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
          if (!this.layout.tileBlocked[r * cols + c]) continue;
          const x = c * s;
          const y = r * s;
          g.fillStyle(BLOCKED_TILE.color, BLOCKED_TILE.fill);
          g.fillRect(x, y, s, s);
          g.lineStyle(lw, BLOCKED_TILE.color, BLOCKED_TILE.stroke);
          g.beginPath();
          g.moveTo(x, y);
          g.lineTo(x + s, y + s);
          g.moveTo(x + s, y);
          g.lineTo(x, y + s);
          g.strokePath();
        }
      }
    }

    // Ghost-border expansion ring (one tile around the bounds) for floor/wall.
    if (this.tool === 'floor' || this.tool === 'wall') {
      const ring: Array<{ c: number; r: number }> = [];
      for (let c = -1; c <= cols; c++) {
        ring.push({ c, r: -1 });
        ring.push({ c, r: rows });
      }
      for (let r = 0; r < rows; r++) {
        ring.push({ c: -1, r });
        ring.push({ c: cols, r });
      }
      for (const { c, r } of ring) {
        const x = c * s;
        const y = r * s;
        const hovered = c === this.ghostHover.col && r === this.ghostHover.row;
        if (hovered) {
          g.fillStyle(GHOST_HOVER.color, GHOST_HOVER.fill);
          g.fillRect(x, y, s, s);
        }
        this.dashedRect(g, x, y, s, s, hovered ? GHOST_HOVER.color : GHOST_RING.color, hovered ? GHOST_HOVER.stroke : GHOST_RING.alpha, lw);
      }
    }
  }

  /** A dashed rectangle outline ([2,2] pattern) in world units. */
  private dashedRect(g: Phaser.GameObjects.Graphics, x: number, y: number, w: number, h: number, color: number, alpha: number, lw: number): void {
    g.lineStyle(lw, color, alpha);
    this.dashLine(g, x, y, x + w, y);
    this.dashLine(g, x + w, y, x + w, y + h);
    this.dashLine(g, x + w, y + h, x, y + h);
    this.dashLine(g, x, y + h, x, y);
  }

  private dashLine(g: Phaser.GameObjects.Graphics, x1: number, y1: number, x2: number, y2: number): void {
    const dx = x2 - x1;
    const dy = y2 - y1;
    const len = Math.hypot(dx, dy) || 1;
    const ux = dx / len;
    const uy = dy / len;
    g.beginPath();
    for (let d = 0; d < len; d += DASH + DASH_GAP) {
      const e = Math.min(d + DASH, len);
      g.moveTo(x1 + ux * d, y1 + uy * d);
      g.lineTo(x1 + ux * e, y1 + uy * e);
    }
    g.strokePath();
  }

  /** If (col,row) lies on the ghost-border ring, grow the layout to include it.
   *  Returns the bounds-shifted (col,row), or null when no expansion happened. */
  private maybeExpand(col: number, row: number): { col: number; row: number } | null {
    if (!this.layout) return null;
    if (col >= 0 && col < this.layout.cols && row >= 0 && row < this.layout.rows) return null;
    const dirs: ExpandDirection[] = [];
    if (col < 0) dirs.push('left');
    if (col >= this.layout.cols) dirs.push('right');
    if (row < 0) dirs.push('up');
    if (row >= this.layout.rows) dirs.push('down');

    let shiftCol = 0;
    let shiftRow = 0;
    for (const dir of dirs) {
      const shift = this.expand(dir);
      if (!shift) return null; // hit MAX_COLS / MAX_ROWS
      shiftCol += shift.col;
      shiftRow += shift.row;
    }
    if (shiftCol === 0 && shiftRow === 0) return null;

    // Existing content shifts by +shift when growing left/up — scroll the camera
    // so the office stays visually anchored.
    const cam = this.scene.cameras.main;
    cam.scrollX += shiftCol * TILE_SIZE;
    cam.scrollY += shiftRow * TILE_SIZE;
    this.tileMap = layoutToTileMap(this.layout);
    this.rebuildFurniture();
    this.deps.rebuildStatic();
    return { col: col + shiftCol, row: row + shiftRow };
  }

  /** Grow the working layout by one tile in `direction` (new tiles are VOID).
   *  Returns the index shift applied to existing content, or null at the max. */
  private expand(direction: ExpandDirection): { col: number; row: number } | null {
    if (!this.layout) return null;
    const { cols, rows, tiles } = this.layout;
    const tileColors = this.layout.tileColors ?? new Array(tiles.length).fill(null);
    const tileBlocked = this.layout.tileBlocked ?? new Array(tiles.length).fill(false);
    let newCols = cols;
    let newRows = rows;
    let shiftCol = 0;
    let shiftRow = 0;
    if (direction === 'right') newCols = cols + 1;
    else if (direction === 'left') {
      newCols = cols + 1;
      shiftCol = 1;
    } else if (direction === 'down') newRows = rows + 1;
    else {
      newRows = rows + 1;
      shiftRow = 1;
    }
    if (newCols > MAX_COLS || newRows > MAX_ROWS) return null;

    const newTiles: TileTypeVal[] = new Array(newCols * newRows).fill(TileType.VOID as TileTypeVal);
    const newColors: Array<ColorValue | null> = new Array(newCols * newRows).fill(null);
    const newBlocked: boolean[] = new Array(newCols * newRows).fill(false);
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const oldIdx = r * cols + c;
        const newIdx = (r + shiftRow) * newCols + (c + shiftCol);
        newTiles[newIdx] = tiles[oldIdx];
        newColors[newIdx] = tileColors[oldIdx];
        newBlocked[newIdx] = tileBlocked[oldIdx];
      }
    }
    this.layout.cols = newCols;
    this.layout.rows = newRows;
    this.layout.tiles = newTiles;
    this.layout.tileColors = newColors;
    this.layout.tileBlocked = newBlocked;
    for (const f of this.layout.furniture) {
      f.col += shiftCol;
      f.row += shiftRow;
    }
    return { col: shiftCol, row: shiftRow };
  }

  // ── Select / floating actions (rotate + delete above the object) ──

  private selectAt(wx: number, wy: number): void {
    this.commitColorGesture(); // finalize any color edit on the previous selection
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
    this.beginGesture();
    f.type = getRotatedType(f.type, 'cw') ?? f.type;
    this.rebuildFurniture();
    this.deps.onEdit(this.layout!, true);
  }

  /** Name the selected conference monitor — its name becomes the stable call/room
   *  id (so it survives the monitor being moved). Empty clears it. */
  private async nameSelected(): Promise<void> {
    if (!this.layout || !this.selectedUid) return;
    const f = this.layout.furniture.find((x) => x.uid === this.selectedUid);
    if (!f || !getCatalogEntry(f.type)?.conference) return;
    const input = await promptDialog('Monitor name (its conference room id):', f.name ?? '', { maxLength: MAX_NAME_LEN });
    if (input === null) return; // cancelled
    const name = cleanName(input);
    this.beginGesture();
    if (name) f.name = name;
    else delete f.name;
    this.rebuildFurniture();
    this.deps.onEdit(this.layout, true);
  }

  /** Flip which side of a wall-mounted item's wall a player approaches from
   *  (PlacedFurniture.facing) — only has any effect when the wall has
   *  walkable floor on both sides (see officeState's computeApproachTiles);
   *  otherwise the tile map already resolves the correct side on its own and
   *  this is a harmless no-op. No sprite/tileMap change, so no rebuild. */
  private flipFacingSelected(): void {
    if (!this.layout || !this.selectedUid) return;
    const f = this.layout.furniture.find((x) => x.uid === this.selectedUid);
    if (!f) return;
    this.beginGesture();
    f.facing = f.facing === Direction.DOWN ? Direction.UP : Direction.DOWN;
    this.deps.onEdit(this.layout, true);
  }

  private deleteSelected(): void {
    if (!this.layout || !this.selectedUid) return;
    const i = this.layout.furniture.findIndex((x) => x.uid === this.selectedUid);
    if (i < 0) return;
    this.beginGesture();
    this.layout.furniture.splice(i, 1);
    this.selectedUid = null;
    this.actionBar.style.display = 'none';
    this.selRect?.setVisible(false);
    this.rebuildFurniture();
    this.deps.onEdit(this.layout, true);
  }

  /** Position the floating action bar + selection outline above the selected
   *  furniture each frame (camera-correct). Called by the scene's update(). */
  tickUI(): void {
    // Keep grid lines ~1px on screen across zoom levels (redraw only on change).
    if (this.editing && this.grid && this.scene.cameras.main.zoom !== this.gridZoom) this.drawGrid();
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
    this.nameBtnInBar.style.display = e.conference ? 'inline-block' : 'none';
    // Facing only matters for wall-mounted interactive items (the ones that
    // compute an approach tile) — and only when the wall is genuinely
    // ambiguous (floor on both sides); showing it unconditionally for every
    // wall-mountable item would just be a dead control most of the time, but
    // wall/furniture edits elsewhere can turn an unambiguous wall ambiguous
    // later, so it's shown whenever the item COULD need it rather than
    // trying to recompute ambiguity here too.
    const canFace = !!e.canPlaceOnWalls && !!(e.appliance || e.conference || e.arcade || e.meetingRoom);
    this.flipFacingBtnInBar.style.display = canFace ? 'inline-block' : 'none';
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
        if (!this.colorGesture) {
          this.beginGesture(); // one undo step per slider drag
          this.colorGesture = true;
        }
        const ac = this.activeColor();
        if (ac) f.color = ac;
        else delete f.color;
        this.rebuildFurniture();
        this.deps.onEdit(this.layout, false);
      }
    } else if (this.tool === 'furniture' || this.tool === 'floor' || this.tool === 'wall') {
      // Live-preview the chosen colour on the placement/paint ghost + palette.
      this.updateGhost(this.ghostWorld.x, this.ghostWorld.y);
      this.refreshPalettePreviews();
    }
  }

  /** Slider released — finalize the color-edit gesture (flush autosave). */
  private commitColorGesture(): void {
    if (this.colorGesture && this.layout) {
      this.colorGesture = false;
      this.deps.onEdit(this.layout, true);
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
    this.refreshPalettePreviews();
  }
  /** "Reset" button next to the sliders — back to neutral (h/s/b/c 0, no
   *  colorize). Mirrors readColor()'s live-apply so it behaves the same as
   *  dragging every slider back to 0: recolors the current selection, or just
   *  updates the placement ghost/palette preview for the paint tools. Needed
   *  because the eyedropper (Pick) copies a picked object's color into these
   *  same sliders, which then keeps applying to everything placed afterward
   *  until manually cleared. */
  private resetColor(): void {
    this.applyColor({ h: 0, s: 0, b: 0, c: 0, colorize: false });
    if (this.tool === 'select' && this.selectedUid && this.layout) {
      const f = this.layout.furniture.find((x) => x.uid === this.selectedUid);
      if (f) {
        this.beginGesture();
        delete f.color;
        this.rebuildFurniture();
        this.deps.onEdit(this.layout, true);
      }
    } else if (this.tool === 'furniture' || this.tool === 'floor' || this.tool === 'wall') {
      this.updateGhost(this.ghostWorld.x, this.ghostWorld.y);
      this.refreshPalettePreviews();
    }
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
    // The expansion ring only shows for floor/wall tools — redraw to reflect it.
    if (this.editing) this.drawGrid();
    // Show the floor/wall palette swatches in the currently-picked colour.
    if (t === 'floor' || t === 'wall') this.refreshPalettePreviews();
    const labels: Record<Tool, string> = {
      select: 'Select — click an object for rotate / delete buttons',
      furniture: 'Furniture — left-click place, right-click remove',
      floor: 'Floor — left-click paint, right-click erase',
      wall: 'Wall — left-click paint, right-click erase',
      block: 'Block — left-click marks a tile as not walkable (independent of floor pattern), right-click clears it',
      eyedropper: 'Eyedropper — click a tile/object to copy its type + colour, then paint',
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
      /* Matches the grouped-menu pixel style (#1c1a19 panels, chunky #0a0908
         borders + inset bevels, red primary, red sliders, green selection). */
      #pa-editor{position:fixed;top:0;left:0;bottom:0;z-index:55;display:none;flex-direction:column;
        width:20rem;background:#1c1a19;border-right:2px solid #0a0908;color:#f1efec;
        box-shadow:inset -3px 0 0 #030303,4px 0 18px rgba(0,0,0,.45);
        font-family:'FS Pixel Sans',ui-monospace,monospace;font-size:0.9rem;}
      #pa-editor .bar{display:flex;gap:0.5rem;padding:0.7rem;border-bottom:2px solid #0a0908;box-shadow:inset 0 -1px 0 #2c2a28;}
      #pa-editor .bar button{flex:1;cursor:pointer;background:#262422;border:2px solid #0a0908;color:#f1efec;
        border-radius:0.4rem;font:1rem 'FS Pixel Sans',monospace;padding:0.5rem;
        box-shadow:inset 0 2px 0 #4a4744,inset 0 -3px 0 #050505;}
      #pa-editor .bar button:hover{background:#2e2b28;}
      #pa-editor .bar button.save{background:#c51a1b;color:#fff;box-shadow:inset 0 2px 0 #e2585a,inset 0 -3px 0 #5c0f10;}
      #pa-editor .tools{display:flex;gap:0.4rem;padding:0.6rem 0.7rem 0.4rem;}
      #pa-editor .tools .pa-tool{flex:1;cursor:pointer;background:#262422;border:2px solid #0a0908;color:#adb0b2;
        border-radius:0.4rem;font:0.9rem 'FS Pixel Sans',monospace;padding:0.5rem 0.25rem;
        box-shadow:inset 0 2px 0 #4a4744,inset 0 -3px 0 #050505;}
      #pa-editor .tools .pa-tool.sel{color:#fff;background:#37342f;
        box-shadow:inset 0 2px 0 rgba(255,255,255,.14),inset 0 -2px 0 rgba(0,0,0,.35),0 0 0 2px #7fbf6a;}
      #pa-editor .hint{padding:0.15rem 0.75rem 0.55rem;font-size:0.8rem;color:#818586;line-height:1.5;}
      #pa-editor .color{display:flex;flex-direction:column;gap:0.4rem;padding:0.6rem 0.75rem;border-top:1px solid #2c2a28;border-bottom:1px solid #2c2a28;}
      #pa-editor .color .rowc{display:flex;align-items:center;gap:0.5rem;font-size:0.8rem;}
      #pa-editor .color .rowc span{width:2.1rem;color:#adb0b2;}
      #pa-editor .color input[type=range]{flex:1;accent-color:#c51a1b;}
      #pa-editor .sw{width:1.6rem;height:1.1rem;border:2px solid #0a0908;border-radius:0.2rem;}
      #pa-editor .pa-color-reset{cursor:pointer;background:#262422;border:2px solid #0a0908;color:#f1efec;
        border-radius:0.3rem;font:0.75rem 'FS Pixel Sans',monospace;padding:0.25rem 0.5rem;
        box-shadow:inset 0 2px 0 #4a4744,inset 0 -3px 0 #050505;}
      #pa-editor .pa-color-reset:hover{background:#2e2b28;}
      .pa-pal{flex:1;overflow-y:auto;display:grid;grid-template-columns:repeat(4,1fr);gap:0.4rem;padding:0.7rem;align-content:start;}
      .pa-pal-item{display:flex;align-items:center;justify-content:center;height:3.4rem;cursor:pointer;
        background:#141312;border:2px solid #0a0908;border-radius:0.4rem;padding:0.25rem;
        box-shadow:inset 0 2px 0 #4a4744,inset 0 -3px 0 #050505;}
      .pa-pal-item.sel{border-color:#7fbf6a;box-shadow:0 0 0 2px #7fbf6a;}
      .pa-pal-item img{max-width:2.75rem;max-height:2.75rem;image-rendering:pixelated;}
    `;
    document.head.appendChild(style);

    const root = document.createElement('div');
    root.id = 'pa-editor';

    const bar = document.createElement('div');
    bar.className = 'bar';
    // Autosave model (no Save): Done exits; edits already persisted + broadcast.
    this.undoBtn = Object.assign(document.createElement('button'), { textContent: '↶ Undo', title: 'Undo (Ctrl+Z)' });
    this.undoBtn.onclick = () => this.undo();
    this.redoBtn = Object.assign(document.createElement('button'), { textContent: '↷ Redo', title: 'Redo (Ctrl+Y)' });
    this.redoBtn.onclick = () => this.redo();
    const doneBtn = Object.assign(document.createElement('button'), { className: 'save', textContent: '✓ Done' });
    doneBtn.onclick = () => this.exit();
    bar.append(this.undoBtn, this.redoBtn, doneBtn);

    const tools = document.createElement('div');
    tools.className = 'tools';
    for (const [t, label] of [['select', 'Select'], ['furniture', 'Furn'], ['floor', 'Floor'], ['wall', 'Wall'], ['block', 'Block'], ['eyedropper', 'Pick']] as const) {
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
    this.rotateBtn.style.cssText =
      'margin:0 0.7rem 0.5rem;cursor:pointer;background:#262422;border:2px solid #0a0908;color:#f1efec;' +
      'border-radius:0.4rem;font:0.9rem "FS Pixel Sans",monospace;padding:0.5rem;' +
      'box-shadow:inset 0 2px 0 #4a4744,inset 0 -3px 0 #050505;';
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
      input.onchange = () => this.commitColorGesture();
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
    this.colorizeEl.onchange = () => {
      this.readColor();
      this.commitColorGesture();
    };
    const clab = Object.assign(document.createElement('label'), { textContent: 'Colorize', htmlFor: 'pa-colorize' });
    clab.style.flex = '1';
    this.swatchEl = Object.assign(document.createElement('div'), { className: 'sw' });
    const resetBtn = document.createElement('button');
    resetBtn.type = 'button';
    resetBtn.className = 'pa-color-reset';
    resetBtn.textContent = 'Reset';
    resetBtn.title = 'Back to default colour (no hue/sat/bright/contrast, not colorized)';
    resetBtn.onclick = () => this.resetColor();
    crow.append(this.colorizeEl, clab, this.swatchEl, resetBtn);
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
      'position:absolute;z-index:58;transform:translate(-50%,-100%);display:none;gap:0.4rem;' +
      'margin-top:-0.4rem;pointer-events:auto;';
    const mkAct = (txt: string, title: string, onClick: () => void) => {
      const b = document.createElement('button');
      b.textContent = txt;
      b.title = title;
      b.style.cssText =
        "cursor:pointer;width:2.2rem;height:2.2rem;background:#242220;border:2px solid #0a0908;" +
        "border-radius:0.4rem;color:#f1efec;font:1.15rem 'FS Pixel Sans',monospace;" +
        "box-shadow:inset 0 2px 0 #4a4744,inset 0 -3px 0 #050505;";
      b.onclick = onClick;
      return b;
    };
    this.rotateBtnInBar = mkAct('⟳', 'Rotate (R)', () => this.rotateSelected());
    this.nameBtnInBar = mkAct('🏷', 'Name this monitor (conference room)', () => void this.nameSelected());
    this.flipFacingBtnInBar = mkAct(
      '⇅',
      "Flip which side to approach from (only matters on a wall with floor on both sides)",
      () => this.flipFacingSelected(),
    );
    const delBtn = mkAct('✕', 'Delete (Del)', () => this.deleteSelected());
    delBtn.style.background = '#7c2634';
    delBtn.style.color = '#f6cdd4';
    delBtn.style.boxShadow = 'inset 0 2px 0 #b34a5a,inset 0 -3px 0 #45111a';
    this.actionBar.append(this.rotateBtnInBar, this.nameBtnInBar, this.flipFacingBtnInBar, delBtn);
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
      this.floorItems.push({ img, pattern: p });
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
      this.wallItems.push({ img, set: s });
    }
    if (count > 0) this.palBuilt = true;
    this.refreshPalettePreviews();
  }

  /**
   * Re-render the floor/wall palette previews in the currently-picked colour so
   * each swatch shows how that tile would look when painted. Only the visible
   * palette is refreshed (floor or wall tool).
   */
  private refreshPalettePreviews(): void {
    const c = this.color;
    if (this.tool === 'floor') {
      for (const { img, pattern } of this.floorItems) {
        img.src = spriteToDataURL(getColorizedFloorSprite(pattern, c));
      }
    } else if (this.tool === 'wall') {
      for (const { img, set } of this.wallItems) {
        const base = getWallSetPreviewSprite(set);
        if (!base) continue;
        const key = `wallprev-${set}-${c.h}-${c.s}-${c.b}-${c.c}`;
        img.src = spriteToDataURL(getColorizedSprite(key, base, { ...c, colorize: true }));
      }
    }
  }
}
