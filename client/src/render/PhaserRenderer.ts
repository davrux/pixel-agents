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
  BUBBLE_SITTING_OFFSET_PX,
  BUBBLE_VERTICAL_OFFSET_PX,
  CHARACTER_BASELINE_HEIGHT,
  CHARACTER_SITTING_OFFSET_PX,
  CHARACTER_Z_SORT_OFFSET,
  PET_EFFECT_DURATION_SEC,
  PET_Z_SORT_OFFSET,
  WALL_COLOR,
} from '@pixel/shared/office/constants.js';
import { TEXT_LABEL_DEFAULT_FONT_SIZE } from '@pixel/shared/protocol';
import { getCharacterSprite } from '@pixel/shared/office/engine/index.js';
import { renderMatrixEffect } from '@pixel/shared/office/engine/matrixEffect.js';
import type {
  FurnitureInstance,
  OfficeLayout,
  SpriteData,
  TileType as TileTypeVal,
} from '@pixel/shared/office/types.js';

/** Everything the renderer reads — backed by synced state on the client and by
 *  OfficeState on the server-side authoring path. */
export interface RenderSource {
  getCharacters(): Character[];
  getPets(): Pet[];
  furniture: FurnitureInstance[];
  getLayout(): OfficeLayout;
  tileMap: TileTypeVal[][];
}
import { getColorizedFloorSprite, hasFloorSprites } from '@pixel/shared/office/floorTiles.js';
import { getWallInstances, hasWallSprites, wallColorToHex } from '@pixel/shared/office/wallTiles.js';
import {
  BUBBLE_PERMISSION_SPRITE,
  BUBBLE_WAITING_SPRITE,
  getCharacterSprites,
} from '@pixel/shared/office/sprites/spriteData.js';
import { getPetSprite } from '@pixel/shared/office/engine/pets.js';
import { spriteTexture } from './sprites.js';

const FLOOR_DEPTH = -100000;
const BUBBLE_DEPTH = 1_000_000;

// Voice "speaking" ring drawn under a character's feet while they talk. A single
// shared soft-ellipse texture (white, so it can be tinted) pulsed in alpha/scale.
const VOICE_RING_TEXTURE = '__voicering';
const VOICE_RING_COLOR = 0x7fbf6a; // app green accent (matches the active-tab underline)
const VOICE_RING_PULSE_HZ = 3; // pulses per second

interface CharGObjects {
  body: Phaser.GameObjects.Image;
  bubble: Phaser.GameObjects.Image;
  /** Pulsing halo shown while this character is speaking in voice chat. */
  ring: Phaser.GameObjects.Image;
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
  private readonly furniturePool: Phaser.GameObjects.Image[] = [];
  /** The furniture array reference last rendered — the engine swaps it on each
   *  rebuild (ambient animation every ~0.2s and PC auto-on/off), so an identity
   *  check tells us cheaply when to re-sync. */
  private lastFurnitureRef: unknown = null;
  private readonly chars = new Map<number, CharGObjects>();
  private readonly pets = new Map<number, Phaser.GameObjects.Image>();
  /** Per-character canvas texture key for the Matrix spawn/despawn effect. */
  private readonly matrixKeys = new Map<number, string>();
  /** Player ids currently speaking in voice chat — drives the per-character ring.
   *  Fed each frame by the scene from the voice active-speaker state. */
  private readonly speakingIds = new Set<number>();

  /** Replace the set of players shown with a speaking ring (called per frame). */
  setSpeakingIds(ids: Set<number>): void {
    this.speakingIds.clear();
    for (const id of ids) this.speakingIds.add(id);
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
    this.lastFurnitureRef = null; // force a furniture re-sync for the new layout

    const layout = this.state.getLayout();
    const tileMap = this.state.tileMap;
    const tileColors = layout.tileColors;
    const cols = layout.cols;
    const useFloors = hasFloorSprites();

    // Floor + wall base color.
    for (let r = 0; r < tileMap.length; r++) {
      for (let c = 0; c < tileMap[r].length; c++) {
        const tile = tileMap[r][c];
        if (tile === TileType.VOID) continue;
        const px = c * TILE_SIZE;
        const py = r * TILE_SIZE;
        if (tile === TileType.WALL || !useFloors) {
          const wallColor = tile === TileType.WALL ? tileColors?.[r * cols + c] : null;
          const hex = tile === TileType.WALL ? (wallColor ? wallColorToHex(wallColor) : WALL_COLOR) : '#808080';
          this.statics.push(this.solid(px, py, hex, FLOOR_DEPTH));
        } else {
          const color = tileColors?.[r * cols + c] ?? { h: 0, s: 0, b: 0, c: 0 };
          const tex = spriteTexture(this.scene, getColorizedFloorSprite(tile, color));
          this.statics.push(this.scene.add.image(px, py, tex).setOrigin(0, 0).setDepth(FLOOR_DEPTH));
        }
      }
    }

    // Wall sprite instances (auto-tiled) — participate in depth sort.
    if (hasWallSprites()) {
      for (const w of getWallInstances(tileMap, tileColors, cols)) {
        const tex = spriteTexture(this.scene, w.sprite);
        // −0.5 so a wall tile always sorts just BEHIND furniture sharing its zY
        // (e.g. a painting hung on it), independent of GameObject creation order.
        this.statics.push(this.scene.add.image(w.x, w.y, tex).setOrigin(0, 0).setDepth(w.zY - 0.5));
      }
    }

    // Free-text labels (OfficeLayout.texts) — a floating sign anchored to the
    // bottom-centre of their tile, sorted like a same-row character/furniture.
    for (const pt of layout.texts ?? []) {
      const x = (pt.col + 0.5) * TILE_SIZE;
      const y = (pt.row + 1) * TILE_SIZE;
      const txt = this.scene.add
        .text(x, y, pt.text, {
          fontFamily: "'FS Pixel Sans', monospace",
          fontSize: `${pt.fontSize ?? TEXT_LABEL_DEFAULT_FONT_SIZE}px`,
          color: '#ffffff',
          stroke: '#000000',
          strokeThickness: 2,
        })
        .setOrigin(0.5, 1)
        .setDepth(y);
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
      img.setTexture(spriteTexture(this.scene, f.sprite));
      img.setPosition(f.x, f.y).setDepth(f.zY).setFlipX(!!f.mirrored).setVisible(true);
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

  /** Lazily build the shared soft-ellipse "speaking ring" texture (white, tinted
   *  at draw time). A flattened radial gradient reads as a ground-plane halo. */
  private ensureRingTexture(): string {
    if (this.scene.textures.exists(VOICE_RING_TEXTURE)) return VOICE_RING_TEXTURE;
    const W = 48;
    const H = 24;
    this.scene.textures.createCanvas(VOICE_RING_TEXTURE, W, H);
    const canvasTex = this.scene.textures.get(VOICE_RING_TEXTURE) as Phaser.Textures.CanvasTexture;
    const ctx = canvasTex.getContext();
    ctx.clearRect(0, 0, W, H);
    ctx.save();
    ctx.translate(W / 2, H / 2);
    ctx.scale(1, H / W); // flatten the circle into a ground-plane ellipse
    const r = W / 2;
    const grad = ctx.createRadialGradient(0, 0, 0, 0, 0, r);
    grad.addColorStop(0, 'rgba(255,255,255,0.08)'); // faint fill inside the ring
    grad.addColorStop(0.6, 'rgba(255,255,255,0.12)');
    grad.addColorStop(0.82, 'rgba(255,255,255,0.9)'); // bright ring band
    grad.addColorStop(1, 'rgba(255,255,255,0)'); // fade to transparent at the edge
    ctx.fillStyle = grad;
    ctx.fillRect(-r, -r, W, W);
    ctx.restore();
    canvasTex.refresh();
    return VOICE_RING_TEXTURE;
  }

  /** When true, characters/pets are hidden (set during layout editing — they are
   *  server-positioned on the un-edited layout, so they can't track local edits
   *  like grid expansion; the server repositions them after the layout is saved). */
  hideEntities = false;

  /** Per-frame sync of furniture (when changed), characters, pets and bubbles. */
  update(): void {
    this.syncFurniture();
    if (this.hideEntities) {
      for (const g of this.chars.values()) {
        g.body.setVisible(false);
        g.bubble.setVisible(false);
        g.ring.setVisible(false);
      }
      for (const img of this.pets.values()) img.setVisible(false);
      return;
    }
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
          ring: this.scene.add.image(0, 0, this.ensureRingTexture()).setOrigin(0.5, 0.5).setVisible(false),
        };
        this.chars.set(ch.id, g);
      }
      this.drawCharacter(ch, g);
    }
    for (const [id, g] of this.chars) {
      if (!seen.has(id)) {
        g.body.destroy();
        g.bubble.destroy();
        g.ring.destroy();
        this.chars.delete(id);
        this.removeMatrixTexture(id);
      }
    }
  }

  private drawCharacter(ch: Character, g: CharGObjects): void {
    const sprites = getCharacterSprites(ch.skin, ch.hueShift);
    const sd = getCharacterSprite(ch, sprites);
    const sit = ch.state === CharacterState.TYPE ? CHARACTER_SITTING_OFFSET_PX : 0;

    // Matrix digital-rain spawn/despawn (per-pixel, 1:1 with the v1 renderer):
    // draw the effect into a per-character canvas texture instead of the sprite.
    const tex = ch.matrixEffect ? this.matrixTexture(ch, sd) : spriteTexture(this.scene, sd);
    g.body.setTexture(tex);
    g.body.setPosition(ch.x, ch.y + sit);
    g.body.setDepth(ch.y + TILE_SIZE / 2 + CHARACTER_Z_SORT_OFFSET);
    g.body.setAlpha(1);
    g.body.setVisible(true); // restore after edit-mode hiding (hideEntities)

    // Voice speaking ring: a pulsing green halo under the feet, sorted just
    // behind this character's body so they stand "inside" it. Hidden otherwise
    // and during the Matrix materialise/dissolve effect.
    if (this.speakingIds.has(ch.id) && !ch.matrixEffect) {
      const p = 0.5 + 0.5 * Math.sin((this.scene.time.now / 1000) * 2 * Math.PI * VOICE_RING_PULSE_HZ);
      // Scale the 48px-wide texture to sit a little wider than the avatar's feet.
      const spriteW = sd[0]?.length ?? TILE_SIZE;
      const baseScale = ((spriteW * 1.9) / 48) * (1 + 0.12 * p);
      g.ring.setPosition(Math.round(ch.x), Math.round(ch.y + sit));
      g.ring.setDepth(g.body.depth - 1);
      g.ring.setTint(VOICE_RING_COLOR);
      g.ring.setAlpha(0.4 + 0.35 * p);
      g.ring.setScale(baseScale);
      g.ring.setVisible(true);
    } else {
      g.ring.setVisible(false);
    }

    // Hide bubbles while the character is materialising/dissolving.
    if (ch.matrixEffect) {
      g.bubble.setVisible(false);
      return;
    }

    // Bubble.
    if (ch.bubbleType) {
      const bsd = ch.bubbleType === 'permission' ? BUBBLE_PERMISSION_SPRITE : BUBBLE_WAITING_SPRITE;
      g.bubble.setTexture(spriteTexture(this.scene, bsd)).setVisible(true);
      const bsit = ch.state === CharacterState.TYPE ? BUBBLE_SITTING_OFFSET_PX : 0;
      // Lift the bubble proportionally to the sprite height so it clears the head
      // of taller characters (baseline 32px → the original 24px offset).
      const vOff = (BUBBLE_VERTICAL_OFFSET_PX * sd.length) / CHARACTER_BASELINE_HEIGHT;
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

  /** Render the Matrix effect for a character into its own canvas texture
   *  (created once per character, refreshed each frame while active). */
  private matrixTexture(ch: Character, sd: SpriteData): string {
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
    return key;
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
      const tex = spriteTexture(this.scene, getPetSprite(pet));
      img.setTexture(tex);
      // Resting on a desk: lift the sprite onto the surface, but keep depth from
      // the (un-lifted) bottom-row anchor so the pet sorts in front of the desk.
      img.setPosition(pet.x, pet.y - (pet.restLift ?? 0));
      img.setDepth(pet.y + TILE_SIZE / 2 + PET_Z_SORT_OFFSET);
      img.setVisible(true); // restore after edit-mode hiding (hideEntities)
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
