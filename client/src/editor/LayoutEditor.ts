import Phaser from 'phaser';

import {
  effectiveAction,
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
  type Action,
  type FurnitureInstance,
  type OfficeLayout,
  type PlacedFurniture,
  type PlacedText,
  type TileType as TileTypeVal,
} from '@pixel/shared/office/types.js';
import { setTileActionAt } from '@pixel/shared/office/layout/tileActionMap.js';
import { getColorizedSprite } from '@pixel/shared/office/colorize.js';
import { MAX_COLS, MAX_ROWS } from '@pixel/shared/office/constants.js';
import type { ColorValue } from '@pixel/shared/office/colorTypes.js';
import { TILE_COLOR_PALETTE, resolveTileColor } from '@pixel/shared/office/tileColorPalette.js';

import { spriteTexture, spriteToDataURL } from '../render/sprites.js';
import { promptDialog, textLabelDialog } from '../ui/dialog.js';
import { actionChoiceLabel, actionTileColor, swatchHex, TILE_ACTION_CHOICES } from './actionChoices.js';
import {
  cleanName,
  MAX_NAME_LEN,
  MAX_TEXT_LABEL_LEN,
  TEXT_LABEL_DEFAULT_FONT_SIZE,
  TEXT_LABEL_DEFAULT_FONT_FAMILY,
} from '@pixel/shared/protocol';

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
  /** Jump to the Asset editor for a furniture type, scoped straight to that
   *  item — WITHOUT leaving layout-edit mode (the undo stack, unsaved paint
   *  strokes, etc. all survive). Optional: the action-bar button that uses
   *  this is hidden when omitted. */
  openAssetEditor?: (type: string) => void;
}

type Tool = 'select' | 'furniture' | 'floor' | 'wall' | 'block' | 'action' | 'text' | 'eyedropper';
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
const ACTION_TILE_STROKE = 0.95;
const ACTION_TILE_FILL = 0.42;
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
  /** The selected text label's uid, mutually exclusive with selectedUid
   *  (selecting one always clears the other) — see selectAt/endFurnitureDrag. */
  private selectedTextUid: string | null = null;
  private lastSelClick = { x: -999, y: -999 };
  private floorPattern = 1;
  private wallSet = 0;
  /** The action the Action tool paints next (picked once via palAction, then
   *  drag-paints many tiles with it — same pattern as floorPattern/wallSet). */
  private currentTileAction: Action = { kind: 'meetingRoom', video: true };
  /** The floor/wall tool's current tint — an index into TILE_COLOR_PALETTE,
   *  picked once via palTileColor, then drag-paints many tiles with it (same
   *  pattern as floorPattern/wallSet). Independent of `color` below, which is
   *  furniture's own continuous h/s/b/c picker. */
  private tileColorIdx = 0;
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
  /** Drag-to-move state: uid being dragged (furniture or a text label) +
   *  cursor→tile grab offset (text labels have no footprint, so their grab
   *  offset is always 0,0 — the drop tile IS the new position). */
  private dragUid: string | null = null;
  private dragKind: 'furniture' | 'text' | null = null;
  private dragGrab = { dc: 0, dr: 0 };
  private dragMoved = false;
  private readonly onKey = (e: KeyboardEvent) => this.handleKey(e);
  private rotateBtn!: HTMLButtonElement;
  private actionBar!: HTMLDivElement;
  private textActionBar!: HTMLDivElement;
  private rotateBtnInBar!: HTMLButtonElement;
  private nameBtnInBar!: HTMLButtonElement;
  private sidesBtnInBar!: HTMLButtonElement;
  private bringFrontBtnInBar!: HTMLButtonElement;
  private sendBackBtnInBar!: HTMLButtonElement;
  private editAssetBtnInBar!: HTMLButtonElement;
  private actionBtnInBar!: HTMLButtonElement;
  private undoBtn!: HTMLButtonElement;
  private redoBtn!: HTMLButtonElement;

  // DOM
  private root!: HTMLDivElement;
  private hint!: HTMLDivElement;
  private palFurn!: HTMLDivElement;
  private palFloor!: HTMLDivElement;
  private palWall!: HTMLDivElement;
  private palAction!: HTMLDivElement;
  private palTileColor!: HTMLDivElement;
  /** Furniture's h/s/b/c slider panel — shown for Select/Furniture, hidden for
   *  Floor/Wall (which use palTileColor instead, see selectTool). */
  private colorPanel!: HTMLDivElement;
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
    if (!this.layout.tileColorIndex) {
      this.layout.tileColorIndex = new Array(this.layout.cols * this.layout.rows).fill(null);
    }
    if (!this.layout.tileBlocked) {
      this.layout.tileBlocked = new Array(this.layout.cols * this.layout.rows).fill(false);
    }
    if (!this.layout.tileActions) this.layout.tileActions = [];
    if (!this.layout.texts) this.layout.texts = [];
    this.ensureUniqueUids();
    this.tileMap = layoutToTileMap(this.layout);
    this.undoStack = [];
    this.redoStack = [];
    this.colorGesture = false;
    this.dragUid = null;
    this.dragKind = null;
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
    this.dragKind = null;
    this.editing = false;
    this.layout = null;
    this.selectedUid = null;
    this.selectedTextUid = null;
    this.root.style.display = 'none';
    this.actionBar.style.display = 'none';
    this.textActionBar.style.display = 'none';
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
      const map: Record<string, Tool> = {
        '1': 'select',
        '2': 'furniture',
        '3': 'floor',
        '4': 'wall',
        '5': 'block',
        '6': 'action',
        '7': 'text',
        '8': 'eyedropper',
      };
      if (map[e.key]) this.selectTool(map[e.key]);
      else if ((e.key === 'Delete' || e.key === 'Backspace') && this.selectedUid) this.deleteSelected();
      else if ((e.key === 'Delete' || e.key === 'Backspace') && this.selectedTextUid) this.deleteSelectedText();
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
      case 'action':
        this.paintTileAction(col, row, this.currentTileAction);
        break;
      case 'text':
        void this.placeOrEditText(col, row);
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
    } else if (this.tool === 'action') {
      this.paintTileAction(Math.floor(wx / TILE_SIZE), Math.floor(wy / TILE_SIZE), null);
    } else if (this.tool === 'text') {
      this.deleteTextAt(Math.floor(wx / TILE_SIZE), Math.floor(wy / TILE_SIZE));
    }
  }

  /** Floor/Wall/Block/Action are paint tools — the scene lets you drag-paint
   *  with them (and pans with the middle mouse instead of the left button). */
  isPaintTool(): boolean {
    return this.tool === 'floor' || this.tool === 'wall' || this.tool === 'block' || this.tool === 'action';
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

  /** Shared offscreen 2d context for measuring a label's rendered width —
   *  same font the renderer actually draws with, so the hit box matches what
   *  you see rather than just the one anchor tile. */
  private static measureCtx: CanvasRenderingContext2D | null = null;
  private static measureTextWidth(text: string, fontSizePx: number): number {
    if (!LayoutEditor.measureCtx) LayoutEditor.measureCtx = document.createElement('canvas').getContext('2d');
    const ctx = LayoutEditor.measureCtx;
    if (!ctx) return text.length * fontSizePx * 0.6; // no canvas 2d — rough monospace fallback
    ctx.font = `${fontSizePx}px 'FS Pixel Sans', monospace`;
    return ctx.measureText(text).width;
  }

  /** The text label under (wx,wy), matched against its actual rendered extent
   *  (see PhaserRenderer's text positioning: origin 0.5,1 at ((col+0.5)*TILE,
   *  (row+1)*TILE)) — not just its one anchor tile, which is far smaller than
   *  most labels. Ignores a rotated label's angle (an axis-aligned box is a
   *  reasonable approximation for picking, not worth exact rotated math). */
  private textHitAt(wx: number, wy: number): PlacedText | null {
    if (!this.layout?.texts) return null;
    for (let i = this.layout.texts.length - 1; i >= 0; i--) {
      const t = this.layout.texts[i];
      const fontSize = t.fontSize ?? TEXT_LABEL_DEFAULT_FONT_SIZE;
      const width = LayoutEditor.measureTextWidth(t.text, fontSize);
      const cx = (t.col + 0.5) * TILE_SIZE;
      const bottom = (t.row + 1) * TILE_SIZE;
      const top = bottom - fontSize * 1.2;
      if (wx >= cx - width / 2 && wx <= cx + width / 2 && wy >= top && wy <= bottom) return t;
    }
    return null;
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
      // Preview the floor tile in the chosen swatch.
      const tex = spriteTexture(this.scene, getColorizedFloorSprite(this.floorPattern, resolveTileColor(this.tileColorIdx) ?? NEUTRAL));
      this.ghost.setTexture(tex).setDisplaySize(TILE_SIZE, TILE_SIZE)
        .setPosition(col * TILE_SIZE, row * TILE_SIZE).setTint(0xffffff).setVisible(true);
      return;
    }
    if (this.tool === 'wall') {
      // Preview the wall tile tinted with the chosen swatch.
      const tint = hexToTint(wallColorToHex(resolveTileColor(this.tileColorIdx) ?? NEUTRAL));
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
    this.layout.tileColorIndex![idx] = tile === TileType.VOID ? null : this.tileColorIdx;
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

  /** Paint (or clear, with null) the tile action on one tile (see
   *  OfficeLayout.tileActions) — for 'meetingRoom' actions, which area id a
   *  group of them becomes is derived by flood fill on the server, not
   *  decided here; painting just marks the tile with *an* action. No
   *  sprite/tileMap change, just the edit-mode overlay (drawGrid) and
   *  autosave. */
  private paintTileAction(col: number, row: number, action: Action | null): void {
    if (!this.layout) return;
    if (col < 0 || row < 0 || col >= this.layout.cols || row >= this.layout.rows) return;
    this.layout.tileActions = setTileActionAt(this.layout.tileActions, col, row, action);
    this.drawGrid();
    this.deps.onEdit(this.layout, false);
  }

  /** Place, edit, or (empty input) delete a free-text label on one tile — the
   *  Text tool's only interaction, one dialog per click, no drag-paint. */
  private async placeOrEditText(col: number, row: number): Promise<void> {
    if (!this.layout) return;
    if (col < 0 || row < 0 || col >= this.layout.cols || row >= this.layout.rows) return;
    const existing = this.layout.texts?.find((t) => t.col === col && t.row === row);
    const result = await textLabelDialog(
      'Text label:',
      {
        text: existing?.text ?? '',
        fontSize: existing?.fontSize ?? TEXT_LABEL_DEFAULT_FONT_SIZE,
        fontFamily: existing?.fontFamily ?? TEXT_LABEL_DEFAULT_FONT_FAMILY,
      },
      { maxLength: MAX_TEXT_LABEL_LEN },
    );
    if (result === null || !this.layout) return; // cancelled, or the editor closed meanwhile
    const text = cleanName(result.text, MAX_TEXT_LABEL_LEN);
    this.beginGesture();
    if (!this.layout.texts) this.layout.texts = [];
    if (!text) {
      if (existing) this.layout.texts = this.layout.texts.filter((t) => t !== existing);
    } else if (existing) {
      existing.text = text;
      if (result.fontSize === TEXT_LABEL_DEFAULT_FONT_SIZE) delete existing.fontSize;
      else existing.fontSize = result.fontSize;
      if (result.fontFamily === TEXT_LABEL_DEFAULT_FONT_FAMILY) delete existing.fontFamily;
      else existing.fontFamily = result.fontFamily;
    } else {
      const pt: PlacedText = { uid: this.nextUid(), col, row, text };
      if (result.fontSize !== TEXT_LABEL_DEFAULT_FONT_SIZE) pt.fontSize = result.fontSize;
      if (result.fontFamily !== TEXT_LABEL_DEFAULT_FONT_FAMILY) pt.fontFamily = result.fontFamily;
      this.layout.texts.push(pt);
    }
    this.deps.rebuildStatic();
    this.deps.onEdit(this.layout, true);
  }

  /** Right-click with the Text tool: delete the label at this tile directly. */
  private deleteTextAt(col: number, row: number): void {
    if (!this.layout?.texts) return;
    const i = this.layout.texts.findIndex((t) => t.col === col && t.row === row);
    if (i < 0) return;
    this.beginGesture();
    this.layout.texts.splice(i, 1);
    this.deps.rebuildStatic();
    this.deps.onEdit(this.layout, true);
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
    const ci = this.layout.tileColorIndex?.[idx];
    if (ci != null) {
      this.tileColorIdx = ci;
      this.highlightTileColorSwatch();
      this.refreshPalettePreviews();
    }
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
    this.selectedTextUid = null;
    this.colorGesture = false;
    this.actionBar.style.display = 'none';
    this.textActionBar.style.display = 'none';
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

  // ── Drag-to-move furniture / text labels (Select tool) ───────────

  /** Grab the furniture piece or text label under the cursor for dragging.
   *  Returns false if neither (or not in select tool) so the scene can pan/
   *  select instead. Furniture wins if both overlap (matches its existing
   *  pixel-perfect hit priority). */
  beginFurnitureDrag(wx: number, wy: number): boolean {
    if (!this.editing || this.tool !== 'select' || !this.layout) return false;
    const uid = this.furnitureHitAt(wx, wy);
    const f = uid ? this.layout.furniture.find((x) => x.uid === uid) : undefined;
    if (uid && f) {
      this.dragKind = 'furniture';
      this.dragUid = uid;
      this.dragGrab = { dc: Math.floor(wx / TILE_SIZE) - f.col, dr: Math.floor(wy / TILE_SIZE) - f.row };
      this.dragMoved = false;
      return true;
    }
    const t = this.textHitAt(wx, wy);
    if (t) {
      this.dragKind = 'text';
      this.dragUid = t.uid;
      this.dragGrab = { dc: 0, dr: 0 }; // a label has no footprint — the drop tile IS its new spot
      this.dragMoved = false;
      return true;
    }
    return false;
  }

  isDraggingFurniture(): boolean {
    return this.dragUid !== null;
  }

  /** Preview the dragged piece/label at the cursor's target tile. Furniture
   *  gets the sprite ghost (tinted by validity); a text label — no footprint
   *  rules to preview — just gets a plain highlight box on the target tile. */
  dragFurnitureTo(wx: number, wy: number): void {
    if (!this.dragUid || !this.layout) return;
    this.dragMoved = true;
    const col = Math.floor(wx / TILE_SIZE);
    const row = Math.floor(wy / TILE_SIZE);
    if (this.dragKind === 'text') {
      this.ghost?.setVisible(false);
      this.selRect?.setPosition(col * TILE_SIZE, row * TILE_SIZE).setVisible(true);
      return;
    }
    if (!this.ghost) return;
    const f = this.layout.furniture.find((x) => x.uid === this.dragUid);
    const e = f && getCatalogEntry(f.type);
    if (!f || !e) return;
    const dcol = col - this.dragGrab.dc;
    const drow = row - this.dragGrab.dr;
    const valid = this.canPlace(dcol, drow, e, this.dragUid);
    const ac = f.color;
    const sprite = ac
      ? getColorizedSprite(`drag-${f.type}-${ac.h}-${ac.s}-${ac.b}-${ac.c}-${ac.colorize ? 1 : 0}`, e.sprite, ac)
      : e.sprite;
    this.ghost.setTexture(spriteTexture(this.scene, sprite)).setDisplaySize(e.footprintW * TILE_SIZE, e.footprintH * TILE_SIZE)
      .setPosition(dcol * TILE_SIZE, drow * TILE_SIZE).setTint(valid ? 0xffffff : 0xff6666).setVisible(true);
    this.selRect?.setVisible(false);
  }

  /** Commit (or cancel) the move. A no-move drag falls back to click-select
   *  (a text label gets its own minimal action bar — edit/rotate/delete). */
  endFurnitureDrag(wx: number, wy: number): void {
    const uid = this.dragUid;
    const kind = this.dragKind;
    this.dragUid = null;
    this.dragKind = null;
    this.ghost?.setVisible(false);
    if (!uid || !this.layout) return;
    if (kind === 'text') {
      this.selRect?.setVisible(false);
      if (!this.dragMoved) {
        this.selectedUid = null;
        this.selectedTextUid = uid;
        return;
      }
      const t = this.layout.texts?.find((x) => x.uid === uid);
      const col = Math.floor(wx / TILE_SIZE);
      const row = Math.floor(wy / TILE_SIZE);
      if (!t || col < 0 || row < 0 || col >= this.layout.cols || row >= this.layout.rows) return;
      this.selectedUid = null;
      this.selectedTextUid = uid;
      if (col === t.col && row === t.row) return; // dropped back on itself — stays selected
      this.beginGesture();
      t.col = col;
      t.row = row;
      this.deps.rebuildStatic();
      this.deps.onEdit(this.layout, true);
      return;
    }
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
    const all = [...this.layout.furniture, ...(this.layout.texts ?? [])];
    let max = 0;
    for (const f of all) {
      const m = /^e(\d+)$/.exec(f.uid ?? '');
      if (m) max = Math.max(max, Number(m[1]));
    }
    this.uid = max;
    const seen = new Set<string>();
    for (const f of all) {
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

    // Tile actions (layout.tileActions) — a fill + border colour-coded by
    // kind (no diagonal cross, unlike Block's red hatch, so the two read as
    // distinct: "a zone/trigger" rather than "forbidden"). For 'meetingRoom'
    // tiles specifically, which area id a group ends up in is decided
    // server-side by flood fill, not shown here — the overlay just marks
    // "this tile has an action."
    if (this.layout.tileActions) {
      for (const t of this.layout.tileActions) {
        const x = t.col * s;
        const y = t.row * s;
        const color = actionTileColor(t.action);
        g.fillStyle(color, ACTION_TILE_FILL);
        g.fillRect(x, y, s, s);
        // A thicker border than the fill alone — the fill blends with
        // whatever's painted underneath (floor colour), but a bold, near-
        // opaque border stays true to the action's own colour either way.
        g.lineStyle(lw * 2, color, ACTION_TILE_STROKE);
        g.strokeRect(x, y, s, s);
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
    const tileColorIndex = this.layout.tileColorIndex ?? new Array(tiles.length).fill(null);
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
    const newColorIndex: Array<number | null> = new Array(newCols * newRows).fill(null);
    const newBlocked: boolean[] = new Array(newCols * newRows).fill(false);
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const oldIdx = r * cols + c;
        const newIdx = (r + shiftRow) * newCols + (c + shiftCol);
        newTiles[newIdx] = tiles[oldIdx];
        newColorIndex[newIdx] = tileColorIndex[oldIdx];
        newBlocked[newIdx] = tileBlocked[oldIdx];
      }
    }
    this.layout.cols = newCols;
    this.layout.rows = newRows;
    this.layout.tiles = newTiles;
    this.layout.tileColorIndex = newColorIndex;
    this.layout.tileBlocked = newBlocked;
    for (const f of this.layout.furniture) {
      f.col += shiftCol;
      f.row += shiftRow;
    }
    // Text labels and tile actions are absolute tile coordinates too — shift
    // them along with furniture so a left/up expand doesn't leave them behind.
    for (const t of this.layout.texts ?? []) {
      t.col += shiftCol;
      t.row += shiftRow;
    }
    for (const a of this.layout.tileActions ?? []) {
      a.col += shiftCol;
      a.row += shiftRow;
    }
    return { col: shiftCol, row: shiftRow };
  }

  // ── Select / floating actions (rotate + delete above the object) ──

  private selectAt(wx: number, wy: number): void {
    this.commitColorGesture(); // finalize any color edit on the previous selection
    this.selectedTextUid = null; // furniture and text selection are mutually exclusive
    const hits = this.furnitureHitsAt(wx, wy); // top-most first
    if (hits.length === 0) {
      this.selectedUid = null;
      this.lastSelClick = { x: wx, y: wy };
      this.actionBar.style.display = 'none';
      this.textActionBar.style.display = 'none';
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
    if (!f || effectiveAction(f, getCatalogEntry(f.type))?.kind !== 'meetingRoom') return;
    const input = await promptDialog('Monitor name (its conference room id):', f.name ?? '', { maxLength: MAX_NAME_LEN });
    if (input === null) return; // cancelled
    const name = cleanName(input);
    this.beginGesture();
    if (name) f.name = name;
    else delete f.name;
    this.rebuildFurniture();
    this.deps.onEdit(this.layout, true);
  }

  /** Set (or clear) the selected item's action override (see Action) — the
   *  furniture Action… button. Overrides the catalog's legacy conference/
   *  arcade/meetingRoom/appliance flags for this one instance only. */
  private async chooseFurnitureAction(): Promise<void> {
    if (!this.layout || !this.selectedUid) return;
    const f = this.layout.furniture.find((x) => x.uid === this.selectedUid);
    if (!f) return;
    const rect = this.actionBtnInBar.getBoundingClientRect();
    const current = effectiveAction(f, getCatalogEntry(f.type));
    const result = await this.chooseActionMenu(rect.left, rect.bottom + 4, current);
    if (result === undefined || !this.layout) return; // dismissed, or the editor closed meanwhile
    this.beginGesture();
    if (result) f.action = result;
    else delete f.action;
    this.rebuildFurniture();
    this.deps.onEdit(this.layout, true);
  }

  /** One-off floating menu (the same choices as the Action tool's palette,
   *  plus "No action") anchored near (x,y) in viewport coordinates — used by
   *  the furniture Action… button. `current` (the item's effective action, if
   *  any) is highlighted on open so it's visible which one is active before
   *  picking — otherwise there's no way to tell without trial and error.
   *  Resolves to the chosen Action, `null` for "No action" (clears the
   *  override), or `undefined` if dismissed without choosing. */
  private chooseActionMenu(x: number, y: number, current?: Action | null): Promise<Action | null | undefined> {
    return new Promise((resolve) => {
      const menu = document.createElement('div');
      menu.className = 'pa-pal pa-pal-action pa-action-menu';
      menu.style.cssText = `position:fixed;left:${x}px;top:${y}px;z-index:90;width:14rem;max-height:70vh;overflow:auto;display:grid;`;
      const currentLabel = current ? actionChoiceLabel(current) : null;
      // Retire the menu (listener + DOM) the instant a choice is picked —
      // BEFORE awaiting its (possibly async) maker. The iframe choice opens
      // promptDialog, whose own overlay lives outside .pa-action-menu; if the
      // menu stayed open and listening, clicking into that prompt would read
      // as an "outside click" and resolve this menu with `undefined` right
      // away, discarding the URL the moment the async maker finished.
      const retire = (): void => {
        document.removeEventListener('mousedown', onOutside, true);
        menu.remove();
      };
      const onOutside = (e: MouseEvent): void => {
        if (!menu.contains(e.target as Node)) {
          retire();
          resolve(undefined);
        }
      };
      const pick = (make: () => Action | Promise<Action | null>): void => {
        retire();
        void Promise.resolve(make()).then((action) => resolve(action ?? undefined));
      };
      for (const choice of TILE_ACTION_CHOICES) {
        const b = document.createElement('button');
        b.className = 'pa-pal-item pa-action-choice';
        if (choice.label === currentLabel) b.classList.add('sel');
        b.innerHTML = `<span class="pa-action-swatch" style="background:${swatchHex(choice.swatch)}"></span>${choice.label}`;
        b.onclick = () => pick(choice.make);
        menu.appendChild(b);
      }
      const clear = document.createElement('button');
      clear.className = 'pa-pal-item pa-action-choice';
      if (currentLabel === null) clear.classList.add('sel');
      clear.style.color = '#f2a1a1';
      clear.textContent = '✕ No action (remove)';
      clear.onclick = () => {
        retire();
        resolve(null);
      };
      menu.appendChild(clear);
      document.body.appendChild(menu);
      // Clamp on-screen: anchored near a selected item close to the window's
      // top/right edge would otherwise render partly off-screen — clipped
      // buttons are invisible AND unclickable (position:fixed doesn't scroll
      // into view), which silently "eats" clicks on whichever choices land
      // above y=0 or past the right edge.
      const margin = 4;
      const rect = menu.getBoundingClientRect();
      let left = x;
      let top = y;
      if (rect.right > window.innerWidth) left -= rect.right - window.innerWidth + margin;
      if (left < margin) left = margin;
      if (rect.bottom > window.innerHeight) top -= rect.bottom - window.innerHeight + margin;
      if (top < margin) top = margin;
      menu.style.left = `${left}px`;
      menu.style.top = `${top}px`;
      // Defer listening for outside clicks by one tick — otherwise the same
      // click that opened this menu (still bubbling) closes it immediately.
      setTimeout(() => document.addEventListener('mousedown', onOutside, true), 0);
    });
  }

  /** Toggle which side(s) the selected item may be approached from (see
   *  PlacedFurniture.approachSides) — a small floating checkbox menu
   *  anchored near the 🧭 button. Each checkbox applies immediately (no OK
   *  button); unlike chooseActionMenu there's nothing to "resolve" to. */
  private chooseApproachSides(): void {
    if (!this.layout || !this.selectedUid) return;
    const f = this.layout.furniture.find((x) => x.uid === this.selectedUid);
    if (!f) return;
    const rect = this.sidesBtnInBar.getBoundingClientRect();
    const menu = document.createElement('div');
    menu.className = 'pa-pal pa-pal-action pa-action-menu';
    menu.style.cssText = `position:fixed;left:${rect.left}px;top:${rect.bottom + 4}px;z-index:90;width:12rem;display:grid;`;
    const hint = document.createElement('div');
    hint.style.cssText = 'padding:0.3rem 0.7rem 0.5rem;font-size:0.72rem;opacity:.65;line-height:1.3;';
    hint.textContent = 'Empty = automatic (every open side works). Check one or more to restrict.';
    menu.appendChild(hint);
    const SIDES: Array<{ tag: 'N' | 'S' | 'E' | 'W'; label: string }> = [
      { tag: 'N', label: 'North' },
      { tag: 'S', label: 'South' },
      { tag: 'W', label: 'West' },
      { tag: 'E', label: 'East' },
    ];
    const renderRow = (b: HTMLButtonElement, tag: 'N' | 'S' | 'E' | 'W', label: string): void => {
      const on = !!f.approachSides?.includes(tag);
      b.textContent = `${on ? '☑' : '☐'} ${label}`;
      b.classList.toggle('sel', on);
    };
    for (const { tag, label } of SIDES) {
      const b = document.createElement('button');
      b.className = 'pa-pal-item pa-action-choice';
      renderRow(b, tag, label);
      b.onclick = () => {
        this.beginGesture();
        const cur = new Set(f.approachSides ?? []);
        cur.has(tag) ? cur.delete(tag) : cur.add(tag);
        if (cur.size === 0) delete f.approachSides;
        else f.approachSides = SIDES.map((s) => s.tag).filter((t) => cur.has(t));
        renderRow(b, tag, label);
        this.deps.onEdit(this.layout!, true);
      };
      menu.appendChild(b);
    }
    document.body.appendChild(menu);
    // Same on-screen clamp as chooseActionMenu — anchored near a selection
    // close to the window edge would otherwise render partly unclickable.
    const margin = 4;
    const mrect = menu.getBoundingClientRect();
    let left = rect.left;
    let top = rect.bottom + 4;
    if (mrect.right > window.innerWidth) left -= mrect.right - window.innerWidth + margin;
    if (left < margin) left = margin;
    if (mrect.bottom > window.innerHeight) top -= mrect.bottom - window.innerHeight + margin;
    if (top < margin) top = margin;
    menu.style.left = `${left}px`;
    menu.style.top = `${top}px`;
    const onOutside = (e: MouseEvent): void => {
      if (!menu.contains(e.target as Node)) {
        document.removeEventListener('mousedown', onOutside, true);
        menu.remove();
      }
    };
    setTimeout(() => document.addEventListener('mousedown', onOutside, true), 0);
  }

  /** Other placed furniture whose footprint overlaps `f`'s — the "stacked on
   *  the same tile(s)" set that bring-to-front/send-to-back reorder against. */
  private overlappingFurniture(f: PlacedFurniture): PlacedFurniture[] {
    if (!this.layout) return [];
    const e = getCatalogEntry(f.type);
    if (!e) return [];
    return this.layout.furniture.filter((other) => {
      if (other.uid === f.uid) return false;
      const oe = getCatalogEntry(other.type);
      if (!oe) return false;
      return (
        f.col < other.col + oe.footprintW &&
        f.col + e.footprintW > other.col &&
        f.row < other.row + oe.footprintH &&
        f.row + e.footprintH > other.row
      );
    });
  }

  /** Bring/send the selected item relative to whatever it overlaps —
   *  PlacedFurniture.zOffset, a layer index among just that overlapping
   *  group (see layoutToFurnitureInstances). No-op with nothing to reorder
   *  against (the action-bar buttons are hidden in that case anyway). */
  private restackSelected(toFront: boolean): void {
    if (!this.layout || !this.selectedUid) return;
    const f = this.layout.furniture.find((x) => x.uid === this.selectedUid);
    if (!f) return;
    const overlapping = this.overlappingFurniture(f);
    if (overlapping.length === 0) return;
    const offsets = overlapping.map((o) => o.zOffset ?? 0);
    this.beginGesture();
    f.zOffset = toFront ? Math.max(0, ...offsets) + 1 : Math.min(0, ...offsets) - 1;
    this.rebuildFurniture();
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

  /** Edit the selected text label's content/font size — same two prompts as
   *  placeOrEditText, but against the current Select-tool selection rather
   *  than a clicked tile. Clearing the text deletes the label, same as there. */
  private async editSelectedText(): Promise<void> {
    if (!this.layout || !this.selectedTextUid) return;
    const t = this.layout.texts?.find((x) => x.uid === this.selectedTextUid);
    if (!t) return;
    const result = await textLabelDialog(
      'Text label:',
      {
        text: t.text,
        fontSize: t.fontSize ?? TEXT_LABEL_DEFAULT_FONT_SIZE,
        fontFamily: t.fontFamily ?? TEXT_LABEL_DEFAULT_FONT_FAMILY,
      },
      { maxLength: MAX_TEXT_LABEL_LEN },
    );
    if (result === null || !this.layout) return; // cancelled, or the editor closed meanwhile
    const text = cleanName(result.text, MAX_TEXT_LABEL_LEN);
    if (!text) {
      this.deleteSelectedText();
      return;
    }
    this.beginGesture();
    t.text = text;
    if (result.fontSize === TEXT_LABEL_DEFAULT_FONT_SIZE) delete t.fontSize;
    else t.fontSize = result.fontSize;
    if (result.fontFamily === TEXT_LABEL_DEFAULT_FONT_FAMILY) delete t.fontFamily;
    else t.fontFamily = result.fontFamily;
    this.deps.rebuildStatic();
    this.deps.onEdit(this.layout, true);
  }

  /** Rotate the selected text label to a free angle in degrees — a label has
   *  no orientation sprites (unlike rotatable furniture's fixed 90°-step R
   *  key), so this is a numeric prompt rather than a cycle through variants. */
  private async rotateSelectedText(): Promise<void> {
    if (!this.layout || !this.selectedTextUid) return;
    const t = this.layout.texts?.find((x) => x.uid === this.selectedTextUid);
    if (!t) return;
    const input = await promptDialog('Angle (degrees, any value):', String(t.angle ?? 0));
    if (input === null || !this.layout) return; // cancelled, or the editor closed meanwhile
    const n = Number(input);
    this.beginGesture();
    const angle = Number.isFinite(n) ? ((n % 360) + 360) % 360 : 0;
    if (angle === 0) delete t.angle;
    else t.angle = angle;
    this.deps.rebuildStatic();
    this.deps.onEdit(this.layout, true);
  }

  private deleteSelectedText(): void {
    if (!this.layout || !this.selectedTextUid) return;
    const i = this.layout.texts?.findIndex((x) => x.uid === this.selectedTextUid) ?? -1;
    if (i < 0 || !this.layout.texts) return;
    this.beginGesture();
    this.layout.texts.splice(i, 1);
    this.selectedTextUid = null;
    this.textActionBar.style.display = 'none';
    this.selRect?.setVisible(false);
    this.deps.rebuildStatic();
    this.deps.onEdit(this.layout, true);
  }

  /** Position the floating action bar + selection outline above the selected
   *  furniture (or text label's own minimal bar) each frame (camera-correct).
   *  Called by the scene's update(). */
  tickUI(): void {
    // Keep grid lines ~1px on screen across zoom levels (redraw only on change).
    if (this.editing && this.grid && this.scene.cameras.main.zoom !== this.gridZoom) this.drawGrid();
    if (!this.editing || this.tool !== 'select' || !this.layout) {
      this.actionBar.style.display = 'none';
      this.textActionBar.style.display = 'none';
      this.selRect?.setVisible(false);
      return;
    }
    if (this.selectedTextUid) {
      this.actionBar.style.display = 'none';
      const t = this.layout.texts?.find((x) => x.uid === this.selectedTextUid);
      if (!t) {
        this.textActionBar.style.display = 'none';
        this.selRect?.setVisible(false);
        return;
      }
      const wpx = t.col * TILE_SIZE;
      const wpy = t.row * TILE_SIZE;
      this.selRect?.setPosition(wpx, wpy).setSize(TILE_SIZE, TILE_SIZE).setVisible(true);
      const cam = this.scene.cameras.main;
      const wv = cam.worldView;
      const sx = (wpx + TILE_SIZE / 2 - wv.x) * cam.zoom;
      const sy = (wpy - wv.y) * cam.zoom;
      this.textActionBar.style.left = `${Math.round(sx)}px`;
      this.textActionBar.style.top = `${Math.round(sy)}px`;
      this.textActionBar.style.display = 'flex';
      return;
    }
    this.textActionBar.style.display = 'none';
    if (!this.selectedUid) {
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
    const action = effectiveAction(f, e);
    this.nameBtnInBar.style.display = action?.kind === 'meetingRoom' ? 'inline-block' : 'none';
    // Approach sides only matter for items with SOME action (the ones that
    // compute an approach tile at all) — any item, not just wall-mountable
    // ones (see PlacedFurniture.approachSides).
    this.sidesBtnInBar.style.display = action ? 'inline-block' : 'none';
    if (action) {
      const n = f.approachSides?.length ?? 0;
      this.sidesBtnInBar.title = n > 0 ? `Approach sides… (restricted to ${f.approachSides!.join('/')})` : 'Approach sides… (currently automatic)';
      this.sidesBtnInBar.classList.toggle('pa-restricted', n > 0);
    }
    const overlapping = this.overlappingFurniture(f);
    this.bringFrontBtnInBar.style.display = overlapping.length > 0 ? 'inline-block' : 'none';
    this.sendBackBtnInBar.style.display = overlapping.length > 0 ? 'inline-block' : 'none';
    this.editAssetBtnInBar.style.display = this.deps.openAssetEditor ? 'inline-block' : 'none';
    this.actionBtnInBar.style.display = 'inline-block'; // any item can get an action override
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
    } else if (this.tool === 'furniture') {
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
    } else if (this.tool === 'furniture') {
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
    if (this.palAction) this.palAction.style.display = t === 'action' ? 'grid' : 'none';
    if (this.palTileColor) this.palTileColor.style.display = t === 'floor' || t === 'wall' ? 'grid' : 'none';
    if (this.colorPanel) this.colorPanel.style.display = t === 'floor' || t === 'wall' ? 'none' : '';
    if (this.rotateBtn) this.rotateBtn.style.display = t === 'furniture' ? 'block' : 'none';
    if (t !== 'select') {
      this.selectedUid = null;
      this.selectedTextUid = null;
      if (this.actionBar) this.actionBar.style.display = 'none';
      if (this.textActionBar) this.textActionBar.style.display = 'none';
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
      action: 'Action — pick a kind on the left, then left-click paints it onto tiles, right-click clears it',
      text: 'Text — left-click to place/edit a label (empty clears it), right-click removes it',
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

  private highlightTileColorSwatch(): void {
    this.palTileColor.querySelectorAll<HTMLElement>('.pa-pal-item').forEach((el) => el.classList.toggle('sel', Number(el.dataset.colorIdx) === this.tileColorIdx));
  }

  private highlightActionChoice(): void {
    const label = actionChoiceLabel(this.currentTileAction);
    this.palAction.querySelectorAll<HTMLButtonElement>('.pa-action-choice').forEach((b) => {
      b.classList.toggle('sel', b.textContent === label);
    });
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
      .pa-pal-action{grid-template-columns:1fr;}
      .pa-action-choice{height:auto;justify-content:flex-start;padding:0.5rem 0.7rem;
        font:0.85rem 'FS Pixel Sans',monospace;color:#f1efec;text-align:left;}
      .pa-action-choice.sel{border-color:#7fbf6a;box-shadow:0 0 0 2px #7fbf6a;}
      .pa-action-swatch{flex:0 0 auto;width:0.9rem;height:0.9rem;margin-right:0.5rem;
        border:1px solid rgba(0,0,0,.5);border-radius:0.2rem;box-shadow:0 0 0 1px rgba(255,255,255,.15) inset;}
      .pa-restricted{border-color:#e0a83a!important;box-shadow:0 0 0 2px #e0a83a,inset 0 2px 0 #4a4744,inset 0 -3px 0 #050505!important;}
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
    for (const [t, label] of [
      ['select', 'Select'],
      ['furniture', 'Furn'],
      ['floor', 'Floor'],
      ['wall', 'Wall'],
      ['block', 'Block'],
      ['action', 'Action'],
      ['text', 'Text'],
      ['eyedropper', 'Pick'],
    ] as const) {
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
    this.colorPanel = color;
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

    // Action-kind picker for the Action tool — plain labeled buttons (no
    // sprite preview; actions have no visual). Pick once, then drag-paint
    // many tiles with it, same as the floor/wall pattern pickers above.
    this.palAction = Object.assign(document.createElement('div'), { className: 'pa-pal pa-pal-action' });
    this.palAction.style.display = 'none';
    for (const choice of TILE_ACTION_CHOICES) {
      const b = document.createElement('button');
      b.className = 'pa-pal-item pa-action-choice';
      b.innerHTML = `<span class="pa-action-swatch" style="background:${swatchHex(choice.swatch)}"></span>${choice.label}`;
      b.onclick = async () => {
        const action = await choice.make();
        if (!action) return; // cancelled (iframe URL prompt)
        this.currentTileAction = action;
        this.highlightActionChoice();
      };
      this.palAction.appendChild(b);
    }
    this.highlightActionChoice();

    // Tile-tint picker for the Floor/Wall tools — a fixed 16-swatch palette
    // (TILE_COLOR_PALETTE) instead of the furniture sliders above, so a
    // tile's color is "which swatch" rather than a free h/s/b/c value (see
    // tileColorPalette.ts for why — Tiled-format compatibility).
    this.palTileColor = Object.assign(document.createElement('div'), { className: 'pa-pal pa-pal-tilecolor' });
    this.palTileColor.style.display = 'none';
    TILE_COLOR_PALETTE.forEach((swatch, i) => {
      const b = document.createElement('button');
      b.className = 'pa-pal-item pa-tilecolor-swatch';
      b.dataset.colorIdx = String(i);
      b.style.background = `hsl(${swatch.h} ${swatch.s}% ${55 + swatch.b / 2}%)`;
      b.onclick = () => {
        this.tileColorIdx = i;
        this.highlightTileColorSwatch();
        this.updateGhost(this.ghostWorld.x, this.ghostWorld.y);
        this.refreshPalettePreviews();
      };
      this.palTileColor.appendChild(b);
    });
    this.highlightTileColorSwatch();

    root.append(bar, tools, this.hint, this.rotateBtn, color, this.palFurn, this.palFloor, this.palWall, this.palAction, this.palTileColor);
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
    this.sidesBtnInBar = mkAct('🧭', 'Approach sides… (which side(s) a player may use this from)', () => this.chooseApproachSides());
    this.bringFrontBtnInBar = mkAct('🔼', 'Bring to front (of what it overlaps)', () => this.restackSelected(true));
    this.sendBackBtnInBar = mkAct('🔽', 'Send to back (of what it overlaps)', () => this.restackSelected(false));
    this.editAssetBtnInBar = mkAct('🎨', 'Edit this asset (stays in layout-edit mode)', () => {
      const f = this.layout?.furniture.find((x) => x.uid === this.selectedUid);
      if (f) this.deps.openAssetEditor?.(f.type);
    });
    this.actionBtnInBar = mkAct(
      '⚡',
      'Set this item’s action (meeting room, link kiosk, arcade, iframe, appliance) — overrides its catalog default',
      () => void this.chooseFurnitureAction(),
    );
    const delBtn = mkAct('✕', 'Delete (Del)', () => this.deleteSelected());
    delBtn.style.background = '#7c2634';
    delBtn.style.color = '#f6cdd4';
    delBtn.style.boxShadow = 'inset 0 2px 0 #b34a5a,inset 0 -3px 0 #45111a';
    this.actionBar.append(
      this.rotateBtnInBar,
      this.nameBtnInBar,
      this.sidesBtnInBar,
      this.bringFrontBtnInBar,
      this.sendBackBtnInBar,
      this.editAssetBtnInBar,
      this.actionBtnInBar,
      delBtn,
    );
    host.appendChild(this.actionBar);

    // A text label's own minimal floating bar (edit / rotate / delete) — no
    // rotate-90/name/facing/restack/asset-editor/action-override buttons,
    // none of those apply to a plain string.
    this.textActionBar = document.createElement('div');
    this.textActionBar.style.cssText = this.actionBar.style.cssText;
    const textEditBtn = mkAct('✎', 'Edit text / font size', () => void this.editSelectedText());
    const textRotateBtn = mkAct('⟳', 'Rotate (free angle)', () => void this.rotateSelectedText());
    const textDelBtn = mkAct('✕', 'Delete (Del)', () => this.deleteSelectedText());
    textDelBtn.style.background = '#7c2634';
    textDelBtn.style.color = '#f6cdd4';
    textDelBtn.style.boxShadow = 'inset 0 2px 0 #b34a5a,inset 0 -3px 0 #45111a';
    this.textActionBar.append(textEditBtn, textRotateBtn, textDelBtn);
    host.appendChild(this.textActionBar);

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
    const c = resolveTileColor(this.tileColorIdx) ?? NEUTRAL;
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
