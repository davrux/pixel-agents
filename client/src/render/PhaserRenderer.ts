import Phaser from 'phaser';

import {
  TILE_SIZE,
  TileType,
  CharacterState,
  PetState,
  type Character,
  type Pet,
} from '@pixel/shared/office/types.js';
import {
  BUBBLE_FADE_DURATION_SEC,
  CANVAS_ERROR_TILE_COLOR,
  BUBBLE_SITTING_OFFSET_PX,
  BUBBLE_VERTICAL_OFFSET_PX,
  CHARACTER_BASELINE_HEIGHT,
  CHARACTER_SITTING_OFFSET_PX,
  CHARACTER_Z_SORT_OFFSET,
  PET_EFFECT_DURATION_SEC,
  PET_Z_SORT_OFFSET,
} from '@pixel/shared/office/constants.js';
import { TEXT_LABEL_DEFAULT_FONT_SIZE, TEXT_LABEL_DEFAULT_FONT_FAMILY } from '@pixel/shared/protocol';
import { getCharacterPose } from '@pixel/shared/office/engine/index.js';
import { renderMatrixEffect } from '@pixel/shared/office/engine/matrixEffect.js';
import type {
  FurnitureInstance,
  OfficeLayout,
  SpriteData,
  GroundMap,
} from '@pixel/shared/office/types.js';

/** Everything the renderer reads — backed by synced state on the client and by
 *  OfficeState on the server-side authoring path. */
export interface RenderSource {
  getCharacters(): Character[];
  getPets(): Pet[];
  furniture: FurnitureInstance[];
  getLayout(): OfficeLayout;
  tileMap: GroundMap;
}
import { groundCellRef } from '@pixel/shared/office/floorTiles.js';
import { cellOrientation, orientationOf } from '@pixel/shared/office/tileOrientation.js';
import { hasSheets } from '@pixel/shared/office/tiledSheetLayout.js';
import { layoutToDecalInstances } from '@pixel/shared/office/layout/layoutSerializer.js';
import { getWallEdgeInstances, getWallFaceInstances } from '@pixel/shared/office/wallTiles.js';
import {
  BUBBLE_PERMISSION_SPRITE,
  BUBBLE_WAITING_SPRITE,
} from '@pixel/shared/office/sprites/spriteData.js';
import { petPose } from '@pixel/shared/office/engine/pets.js';
import { poseFrame } from '@pixel/shared/office/sprites/poseFrames.js';
import { getPetSpec, getSkinSpec } from '@pixel/shared/office/sprites/spriteData.js';
import { sheetCellFrame, sheetCellPixels, sheetColumns, sheetFrameSize } from '../art/sheetStore';
import {
  spriteTexture,
  spriteTextureFor,
  ensureImageTexture,
  registerFurnitureAtlas,
  registerSheetTexture,
  sheetFrame,
  type SpriteTex,
} from './sprites.js';
import { markerResolution, markerTexture, type MarkerSpec } from './markerIcons.js';

const FLOOR_DEPTH = -100000;
/** Placed background images (OfficeLayout.images) — a fixed layer just above
 *  the floor and comfortably below any real (row-based) furniture zY, so an
 *  image always reads as "on the floor", never "on the table" — see
 *  PlacedImage's doc comment in shared/office/types.ts. */
const IMAGE_DEPTH = FLOOR_DEPTH + 1;
const BUBBLE_DEPTH = 1_000_000;

// Head markers (☕ / 💤 afk — see markerIcons.ts). Sizes are WORLD
// pixels; being world-space, they keep that size relative to the avatar. They
// started out matching the DOM icons they replaced, which read too small next to
// a character, so the whole row is 1.5× that now.
const MARKER_DEPTH = BUBBLE_DEPTH + 1;
const MARKER_SIZE_COFFEE = 7.5;
const MARKER_SIZE_AFK = 6;
const MARKER_AFK_COLOR = '#ffd98a';
/** Bottom of the marker row: 34px above the feet of a baseline (32px) character,
 *  scaled for taller sprites — where the old DOM afk/coffee overlays sat. The row
 *  is bottom-anchored, so the bigger glyphs grow upwards from this line. */
const MARKER_ROW_OFFSET_PX = 34;
const MARKER_GAP_PX = 1.5;
/** Coffee sip loop length, matching the CSS keyframes this replaces. */
const SIP_PERIOD_MS = 2200;
/** Shared empty list — most characters carry no marker on any given frame. */
const NO_MARKERS: MarkerSpec[] = [];

/** Coffee "sip": tilt back, then straighten while lifted, on a 2.2 s loop.
 *  `lift` is in em (multiplied by the marker's world size by the caller). */
function sipOffset(nowMs: number): { rot: number; lift: number } {
  const p = (nowMs % SIP_PERIOD_MS) / SIP_PERIOD_MS;
  const ease = (t: number): number => t * t * (3 - 2 * t); // ≈ CSS ease-in-out
  const TILT = -0.28; // rad, ≈ −16°
  const LIFT = 0.066; // em per keyframe step (the old −1px at a 15px glyph)
  if (p < 0.3) {
    const t = ease(p / 0.3);
    return { rot: TILT * t, lift: LIFT * t };
  }
  if (p < 0.55) {
    const t = ease((p - 0.3) / 0.25);
    return { rot: TILT * (1 - t), lift: LIFT * (1 + t) };
  }
  const t = ease((p - 0.55) / 0.45);
  return { rot: 0, lift: LIFT * 2 * (1 - t) };
}

interface CharGObjects {
  body: Phaser.GameObjects.Image;
  bubble: Phaser.GameObjects.Image;
  /** Pooled head markers, laid out in a row above the sprite. */
  markers: Phaser.GameObjects.Image[];
}

/**
 * Renders an OfficeState with Phaser, 1:1 with the original canvas renderer:
 * floor + wall-base tiles, z-sorted furniture/walls, characters and pets, and
 * speech bubbles. Static layers (floor, walls, furniture) are built once per
 * layout; characters/pets/bubbles are pooled and updated every frame.
 */
export class PhaserRenderer {
  private readonly statics: Phaser.GameObjects.Image[] = [];
  /** Free-text labels (OfficeLayout.texts) — rebuilt wholesale alongside
   *  floor/walls in buildStatic() rather than pooled like furniture, since
   *  they're plain decorative strings with no animation/instance churn. */
  private readonly texts: Phaser.GameObjects.Text[] = [];
  /** Placed background images (OfficeLayout.images) — rebuilt wholesale
   *  alongside floor/walls/texts in buildStatic(), same reasoning as texts:
   *  plain decoration, no per-frame animation/instance churn. */
  private readonly images: Phaser.GameObjects.Image[] = [];
  private readonly furniturePool: Phaser.GameObjects.Image[] = [];
  /** The furniture array reference last rendered — the engine swaps it on each
   *  rebuild (ambient animation every ~0.2s and PC auto-on/off), so an identity
   *  check tells us cheaply when to re-sync. */
  private lastFurnitureRef: unknown = null;
  private readonly chars = new Map<number, CharGObjects>();
  private readonly pets = new Map<number, Phaser.GameObjects.Image>();
  /** Per-character canvas texture key for the Matrix spawn/despawn effect. */
  private readonly matrixKeys = new Map<number, string>();

  /** Keep the fetched floor/wall sheets as textures — one per sheet, drawn from
   *  by frame (see sprites.ts). Call once the sheets have loaded, before
   *  buildStatic(); without them floor and walls fall back to a flat fill. */
  registerSheets(sheets: Array<{ name: string; bitmap: ImageBitmap; spacing: number; tileW: number; tileH: number }>): void {
    for (const { name, bitmap, spacing, tileW, tileH } of sheets) registerSheetTexture(this.scene, name, bitmap, spacing, tileW, tileH);
  }

  /** Keep the baked collection-art atlas as one texture, so furniture and decals
   *  draw from it instead of from per-sprite pixels. Optional by design: without
   *  it they fall back to the sprites the catalog message carries. */
  registerAtlas(bitmap: ImageBitmap, frames: Record<string, { x: number; y: number; w: number; h: number }>): void {
    registerFurnitureAtlas(this.scene, bitmap, frames);
  }

  constructor(
    private readonly scene: Phaser.Scene,
    private readonly state: RenderSource,
  ) {}

  /** (Re)build floor and walls for the current layout. Furniture is synced
   *  separately each time the engine replaces its furniture instances. */
  buildStatic(): void {
    for (const o of this.statics) o.destroy();
    this.statics.length = 0;
    for (const t of this.texts) t.destroy();
    this.texts.length = 0;
    for (const img of this.images) img.destroy();
    this.images.length = 0;
    this.lastFurnitureRef = null; // force a furniture re-sync for the new layout

    const layout = this.state.getLayout();
    const tileMap = this.state.tileMap;
    const tileFloorSet = layout.tileFloorSet;
    const cols = layout.cols;
    const useFloors = hasSheets();

    // Floor, under every non-void cell. Every cell is floor now — a wall is an
    // edge between cells (see OfficeLayout.walls), drawn later as a z-sorted
    // instance, so there is no wall cell to special-case here.
    for (let r = 0; r < tileMap.length; r++) {
      for (let c = 0; c < tileMap[r].length; c++) {
        const tile = tileMap[r][c];
        if (tile === TileType.VOID) continue;
        const px = c * TILE_SIZE;
        const py = r * TILE_SIZE;
        if (!useFloors) {
          // Baked sheets haven't arrived yet — a flat fill is all there is to draw.
          this.statics.push(this.solid(px, py, '#808080', FLOOR_DEPTH));
          continue;
        }
        const idx = r * cols + c;
        // The number is a position in THIS layout's own set table, not a global
        // one — see OfficeLayout.floorSets.
        const setName = layout.floorSets?.[tileFloorSet?.[idx] ?? 0];
        // `tile` IS the local tile id in that set — no pattern/colour decomposition
        // any more, which is what lets ground come from any grid tileset.
        const ref = groundCellRef(setName, tile);
        const tex = ref ? sheetFrame(ref) : null;
        if (!tex) {
          // No cell for this pattern (a set that lost a pattern, or a sheet that
          // failed to register): the error tile, same signal the magenta grid was.
          this.statics.push(this.solid(px, py, CANVAS_ERROR_TILE_COLOR, FLOOR_DEPTH));
          continue;
        }
        const cell = this.scene.add.image(px, py, tex.key, tex.frame).setOrigin(0, 0).setDepth(FLOOR_DEPTH);
        // How the mapper turned this cell in Tiled (see OfficeLayout.tileFlip). The two
        // mirrors are free; only a diagonal flip needs the cell rotated, and then the
        // origin has to move to its centre first — rotating around the top-left corner
        // would swing the tile into its neighbour's place instead of turning it.
        const orient = cellOrientation(layout.tileFlip?.[idx]);
        if (orient.flipX) cell.setFlipX(true);
        if (orient.flipY) cell.setFlipY(true);
        if (orient.angle !== 0) {
          cell.setOrigin(0.5, 0.5).setPosition(px + TILE_SIZE / 2, py + TILE_SIZE / 2).setAngle(orient.angle);
        }
        this.statics.push(cell);
      }
    }

    // Painted map art (OfficeLayout.decals) — a static, because a decal never
    // changes: it is not a synced object, so unlike furniture there is nothing to
    // re-sync and no pool to keep. Added in paint order, which is what makes flat
    // decals (all sharing DECAL_DEPTH) stack the way the Layers panel shows them.
    for (const d of layoutToDecalInstances(layout.decals)) {
      const tex = spriteTextureFor(this.scene, d.spriteId, d.sprite);
      const img = this.scene.add
        .image(d.x, d.y, tex.key, tex.frame)
        .setOrigin(0, 0)
        .setDepth(d.zY)
        .setFlipX(!!d.mirrored)
        .setFlipY(!!d.flippedVertically);
      // Turned the same way a ground cell is (one table, see tileOrientation.ts). The
      // import only sets the diagonal bit on square art, so w === h here and the rotated
      // quad covers the same box — which is why the centre is the art's own, not a cell's.
      const orient = orientationOf(d.mirrored, d.flippedVertically, d.flippedDiagonally);
      if (orient.angle !== 0) {
        img.setOrigin(0.5, 0.5).setPosition(d.x + d.width / 2, d.y + d.height / 2).setAngle(orient.angle);
        img.setFlipX(orient.flipX).setFlipY(orient.flipY);
      }
      this.statics.push(img);
    }

    // Placed background images (OfficeLayout.images) — fixed depth, free
    // top-left pixel position/size (not tile-snapped, not bottom-center like
    // furniture/text — an image has no "standing point"), stretched to fill
    // exactly the box the mapper drew in Tiled.
    for (const pi of layout.images ?? []) {
      // The placement says where its file is (PlacedImage.src, under assets/tiled) —
      // the picture is a file in the repo, not a row that travels on every join.
      if (!pi.src) continue; // a layout older than version 3 that never migrated
      // Tiled turns an object around the point it stores as (x, y) — for a tile object
      // the BOTTOM-left corner of the box, which is what pi.x/pi.y + height is here. So
      // the pivot is that corner rather than the centre, and an unrotated image keeps the
      // top-left anchor it has always had.
      const iAngle = pi.angle ?? 0;
      const img = this.scene.add
        .image(0, 0, '__DEFAULT')
        .setOrigin(0, iAngle === 0 ? 0 : 1)
        .setPosition(pi.x, iAngle === 0 ? pi.y : pi.y + pi.height)
        .setDisplaySize(pi.width, pi.height)
        .setAngle(iAngle)
        .setDepth(IMAGE_DEPTH)
        .setFlipX(!!pi.flippedHorizontally)
        .setFlipY(!!pi.flippedVertically)
        .setAlpha(pi.opacity ?? 1);
      ensureImageTexture(this.scene, pi.imageId, `/assets/tiled/${pi.src}`, (key) => {
        // The decode finishes on a later tick, and buildStatic may have run again by
        // then (a pushed map, a catalog reload) — which destroyed this image. Touching
        // a destroyed GameObject throws inside Phaser ("this.scene is undefined"), and
        // it did: the loading phase made the two buildStatic calls line up that way in
        // Firefox. A destroyed object has no scene, which is the cheap way to ask.
        if (!img.scene) return;
        img.setTexture(key).setDisplaySize(pi.width, pi.height);
      });
      this.images.push(img);
    }

    // Wall sprite instances — participate in depth sort. One per lattice point
    // any wall edge touches (see OfficeLayout.walls).
    if (hasSheets() && layout.walls) {
      const wallParts = [
        ...getWallEdgeInstances(layout.walls, cols, layout.rows, layout.wallSets ?? []),
        ...(layout.walls.faces ? getWallFaceInstances(layout.walls.faces, cols, layout.rows, layout.wallSets ?? []) : []),
      ];
      for (const w of wallParts) {
        const tex = sheetFrame(w.ref);
        if (!tex) continue;
        // −0.5 so a wall tile always sorts just BEHIND furniture sharing its zY
        // (e.g. a painting hung on it), independent of GameObject creation order.
        this.statics.push(this.scene.add.image(w.x, w.y, tex.key, tex.frame).setOrigin(0, 0).setDepth(w.zY - 0.5));
      }
    }

    // Free-text labels (OfficeLayout.texts) — a floating sign anchored at its
    // own free (x,y) point (bottom-centre), sorted like a same-row character/furniture.
    for (const pt of layout.texts ?? []) {
      const txt = this.scene.add
        .text(pt.x, pt.y, pt.text, {
          fontFamily: pt.fontFamily ?? TEXT_LABEL_DEFAULT_FONT_FAMILY,
          fontSize: `${pt.fontSize ?? TEXT_LABEL_DEFAULT_FONT_SIZE}px`,
          color: pt.color ?? '#000000',
          stroke: '#000000',
          strokeThickness: 1,
        })
        .setOrigin(0.5, 1)
        .setAngle(pt.angle ?? 0)
        .setDepth(pt.y);
      this.texts.push(txt);
    }
  }

  /** Re-render furniture only when the engine swapped the instance array
   *  (ambient animation, PC auto-on/off). Pooled to avoid create/destroy churn. */
  private syncFurniture(): void {
    if (this.state.furniture === this.lastFurnitureRef) return;
    this.lastFurnitureRef = this.state.furniture;

    const items = this.state.furniture;
    for (let i = 0; i < items.length; i++) {
      const f = items[i];
      let img = this.furniturePool[i];
      if (!img) {
        img = this.scene.add.image(0, 0, '__WHITE').setOrigin(0, 0);
        this.furniturePool[i] = img;
      }
      const ftex = spriteTextureFor(this.scene, f.spriteId, f.sprite);
      img.setTexture(ftex.key, ftex.frame);
      // f.width/f.height is the box this piece OCCUPIES — for a turned piece the rectangle
      // around the turned art (entryFor resolved that, so the cells it blocks agree with the
      // picture). The art keeps its own size and is turned inside that box; drawing it at the
      // box size would squash a 32×16 couch into its own footprint, which looks like a
      // rotation bug and is really a scaling one.
      const angle = f.angle ?? 0;
      const drawW = angle === 0 ? f.width : (f.artWidth ?? f.width);
      const drawH = angle === 0 ? f.height : (f.artHeight ?? f.height);
      img
        // Origin only moves when there is something to turn: an unturned placement keeps
        // the top-left anchor it has always had, so every existing map draws exactly as
        // before — and these are POOLED, so both cases must be set every frame.
        .setOrigin(angle === 0 ? 0 : 0.5, angle === 0 ? 0 : 0.5)
        .setPosition(angle === 0 ? f.x : f.x + f.width / 2, angle === 0 ? f.y : f.y + f.height / 2)
        // Always, not only when resized: these images are pooled, so a sprite that
        // once drew a scaled placement would keep that scale for the next one.
        .setDisplaySize(drawW, drawH)
        .setAngle(angle)
        .setDepth(f.zY)
        .setFlipX(!!f.mirrored)
        .setFlipY(!!f.flippedVertically)
        .setAlpha(f.opacity ?? 1)
        .setVisible(true);
    }
    for (let i = items.length; i < this.furniturePool.length; i++) {
      this.furniturePool[i].setVisible(false);
    }
  }

  private solid(x: number, y: number, hex: string, depth: number): Phaser.GameObjects.Image {
    // 1×1 white texture tinted + scaled to a tile — cheap solid fill.
    const img = this.scene.add
      .image(x, y, '__WHITE')
      .setOrigin(0, 0)
      .setDisplaySize(TILE_SIZE, TILE_SIZE)
      .setTint(Phaser.Display.Color.HexStringToColor(hex).color)
      .setDepth(depth);
    return img;
  }

  /** Per-frame sync of furniture (when changed), characters, pets and bubbles. */
  update(): void {
    this.syncFurniture();
    this.syncCharacters();
    this.syncPets();
  }

  private syncCharacters(): void {
    const seen = new Set<number>();
    for (const ch of this.state.getCharacters()) {
      seen.add(ch.id);
      let g = this.chars.get(ch.id);
      if (!g) {
        g = {
          body: this.scene.add.image(0, 0, '__WHITE').setOrigin(0.5, 1),
          bubble: this.scene.add.image(0, 0, '__WHITE').setOrigin(0.5, 1).setDepth(BUBBLE_DEPTH).setVisible(false),
          markers: [],
        };
        this.chars.set(ch.id, g);
      }
      this.drawCharacter(ch, g);
    }
    for (const [id, g] of this.chars) {
      if (!seen.has(id)) {
        g.body.destroy();
        g.bubble.destroy();
        for (const m of g.markers) m.destroy();
        this.chars.delete(id);
        this.removeMatrixTexture(id);
      }
    }
  }

  private drawCharacter(ch: Character, g: CharGObjects): void {
    // Which CELL of the skin's sheet this pose draws (poseFrames.ts), not which pixels:
    // the art is a PNG and the atlas holds cells of it, so nothing here decodes anything.
    const size = sheetFrameSize(ch.skin);
    // No art for this skin yet, or at all: the sheets arrive over their own channel,
    // and a viewer can also carry a skin id this build does not have. Skip the frame
    // rather than draw a texture that is not there — reaching into undefined pixels
    // used to throw inside the Matrix effect and take the whole render loop with it.
    if (!size) {
      g.body.setVisible(false);
      return;
    }
    const pose = ch.pose ?? getCharacterPose(ch);
    const cell = poseFrame(getSkinSpec(ch.skin), pose, ch.frame, sheetColumns(ch.skin));
    const frameH = size.h;
    const sit = ch.state === CharacterState.TYPE ? CHARACTER_SITTING_OFFSET_PX : 0;

    // Matrix digital-rain spawn/despawn (per-pixel, 1:1 with the v1 renderer): the one
    // caller that genuinely needs pixels, and it generates its own every frame — so it
    // asks the sheet store for the cell it is dissolving.
    const tex = ch.matrixEffect
      ? this.matrixTexture(ch, sheetCellPixels(ch.skin, ch.dir, cell.col) ?? [])
      : sheetCellFrame(this.scene, ch.skin, ch.dir, cell.col, cell.synthSit);
    if (!tex) {
      g.body.setVisible(false);
      return;
    }
    g.body.setTexture(tex.key, tex.frame);
    g.body.setPosition(ch.x, ch.y + sit);
    g.body.setDepth(ch.y + TILE_SIZE / 2 + CHARACTER_Z_SORT_OFFSET);
    g.body.setAlpha(1);
    g.body.setVisible(true);

    // Status markers over the head (☕ / 💤 afk / muted mic).
    this.drawMarkers(ch, g, frameH, sit);

    // Hide bubbles while the character is materialising/dissolving.
    if (ch.matrixEffect) {
      g.bubble.setVisible(false);
      return;
    }

    // Bubble.
    if (ch.bubbleType) {
      const bsd = ch.bubbleType === 'permission' ? BUBBLE_PERMISSION_SPRITE : BUBBLE_WAITING_SPRITE;
      const btex = spriteTexture(this.scene, bsd);
      g.bubble.setTexture(btex.key, btex.frame).setVisible(true);
      const bsit = ch.state === CharacterState.TYPE ? BUBBLE_SITTING_OFFSET_PX : 0;
      // Lift the bubble proportionally to the sprite height so it clears the head
      // of taller characters (baseline 32px → the original 24px offset).
      const vOff = (BUBBLE_VERTICAL_OFFSET_PX * frameH) / CHARACTER_BASELINE_HEIGHT;
      g.bubble.setPosition(Math.round(ch.x), Math.round(ch.y + bsit - vOff));
      let ba = 1;
      if (ch.bubbleType === 'waiting' && ch.bubbleTimer < BUBBLE_FADE_DURATION_SEC) {
        ba = ch.bubbleTimer / BUBBLE_FADE_DURATION_SEC;
      }
      g.bubble.setAlpha(ba);
    } else {
      g.bubble.setVisible(false);
    }
  }

  /** The markers a character currently carries, left to right. Nothing to show
   *  is the common case, hence the shared empty list (this runs per character
   *  per frame). The crossed 🎤/🔊 pair went with zone voice: mic state is a
   *  property of a call you are in, and a meeting shows it in its own window,
   *  on the tile of the person it belongs to. */
  private markerSpecs(ch: Character): MarkerSpec[] {
    if (!ch.afk && ch.pose !== 'coffee') return NO_MARKERS;
    const specs: MarkerSpec[] = [];
    if (ch.pose === 'coffee') specs.push({ text: '☕', size: MARKER_SIZE_COFFEE, sip: true });
    if (ch.afk) specs.push({ text: '💤 afk', size: MARKER_SIZE_AFK, color: MARKER_AFK_COLOR });
    return specs;
  }

  /** Lay the head markers out in a centred row just above the sprite. Hidden
   *  while the character materialises/dissolves (like the speech bubble). */
  private drawMarkers(ch: Character, g: CharGObjects, spriteH: number, sit: number): void {
    const specs = ch.matrixEffect ? NO_MARKERS : this.markerSpecs(ch);
    if (specs.length === 0) {
      for (const m of g.markers) m.setVisible(false);
      return;
    }
    // Rasterize at the current zoom so the glyphs stay crisp, not upscaled.
    const res = markerResolution(this.scene.cameras.main.zoom);
    const texs = specs.map((s) => markerTexture(this.scene, s, res));
    let rowW = MARKER_GAP_PX * Math.max(0, texs.length - 1);
    for (const t of texs) rowW += t.w;

    const baseY = ch.y + sit - (MARKER_ROW_OFFSET_PX * spriteH) / CHARACTER_BASELINE_HEIGHT;
    let x = ch.x - rowW / 2;
    for (let i = 0; i < texs.length; i++) {
      const t = texs[i];
      let img = g.markers[i];
      if (!img) {
        img = this.scene.add.image(0, 0, t.key).setOrigin(0.5, 1).setDepth(MARKER_DEPTH);
        g.markers[i] = img;
      }
      if (img.texture.key !== t.key) img.setTexture(t.key);
      img.setDisplaySize(t.w, t.h);
      let y = baseY;
      let rot = 0;
      if (specs[i].sip) {
        const s = sipOffset(this.scene.time.now);
        rot = s.rot;
        y -= s.lift * specs[i].size;
      }
      img.setRotation(rot);
      img.setPosition(x + t.w / 2, y).setVisible(true);
      x += t.w + MARKER_GAP_PX;
    }
    for (let i = texs.length; i < g.markers.length; i++) g.markers[i].setVisible(false);
  }

  /** Render the Matrix effect for a character into its own canvas texture
   *  (created once per character, refreshed each frame while active). */
  /** The Matrix materialise/dissolve effect draws fresh pixels every frame, so it
   *  keeps its own per-character canvas: packing it would fill the atlas with one
   *  dead frame per frame. Returns the same shape as spriteTexture so the caller
   *  needs no branch — a bare key, no frame. */
  private matrixTexture(ch: Character, sd: SpriteData): SpriteTex {
    const h = sd.length;
    const w = h > 0 ? sd[0].length : 0;
    let key = this.matrixKeys.get(ch.id);
    if (!key || !this.scene.textures.exists(key)) {
      key = `matrix_${ch.id}`;
      if (this.scene.textures.exists(key)) this.scene.textures.remove(key);
      this.scene.textures.createCanvas(key, Math.max(1, w), Math.max(1, h));
      this.matrixKeys.set(ch.id, key);
    }
    const canvasTex = this.scene.textures.get(key) as Phaser.Textures.CanvasTexture;
    const ctx = canvasTex.getContext();
    ctx.clearRect(0, 0, w, h);
    renderMatrixEffect(ctx, ch, sd, 0, 0, 1);
    canvasTex.refresh();
    return { key };
  }

  private removeMatrixTexture(id: number): void {
    const key = this.matrixKeys.get(id);
    if (key && this.scene.textures.exists(key)) this.scene.textures.remove(key);
    this.matrixKeys.delete(id);
  }

  private syncPets(): void {
    const seen = new Set<number>();
    for (const pet of this.state.getPets()) {
      seen.add(pet.id);
      let img = this.pets.get(pet.id);
      if (!img) {
        img = this.scene.add.image(0, 0, '__WHITE').setOrigin(0.5, 1);
        this.pets.set(pet.id, img);
      }
      // Same as characters: a cell of the pet's sheet, resolved by pose (petPose) and
      // direction, never decoded into pixels here.
      const sheetId = `${pet.kind}_${pet.variant}`;
      const cell = poseFrame(getPetSpec(pet.kind, pet.variant), petPose(pet), pet.frame, sheetColumns(sheetId));
      const tex = sheetCellFrame(this.scene, sheetId, pet.dir, cell.col, cell.synthSit);
      if (!tex) {
        img.setVisible(false);
        continue;
      }
      img.setTexture(tex.key, tex.frame);
      // Resting on a desk: lift the sprite onto the surface, but keep depth from
      // the (un-lifted) bottom-row anchor so the pet sorts in front of the desk.
      img.setPosition(pet.x, pet.y - (pet.restLift ?? 0));
      img.setDepth(pet.y + TILE_SIZE / 2 + PET_Z_SORT_OFFSET);
      img.setVisible(true);
      let alpha = 1;
      if (pet.effect === 'spawn') alpha = Math.min(1, pet.effectTimer / PET_EFFECT_DURATION_SEC);
      else if (pet.effect === 'despawn' || pet.state === PetState.DESPAWN) {
        alpha = Math.max(0, 1 - pet.effectTimer / PET_EFFECT_DURATION_SEC);
      }
      img.setAlpha(alpha);
    }
    for (const [id, img] of this.pets) {
      if (!seen.has(id)) {
        img.destroy();
        this.pets.delete(id);
      }
    }
  }
}
