import Phaser from 'phaser';

import {
  MATRIX_EFFECT_DURATION,
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
  CHARACTER_SITTING_OFFSET_PX,
  CHARACTER_Z_SORT_OFFSET,
  PET_EFFECT_DURATION_SEC,
  PET_Z_SORT_OFFSET,
  WALL_COLOR,
} from '@pixel/shared/office/constants.js';
import { getCharacterSprite } from '@pixel/shared/office/engine/index.js';
import type { FurnitureInstance, OfficeLayout, TileType as TileTypeVal } from '@pixel/shared/office/types.js';

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
  getPetSprites,
} from '@pixel/shared/office/sprites/spriteData.js';
import { getPetSprite } from '@pixel/shared/office/engine/pets.js';
import { spriteTexture } from './sprites.js';

const FLOOR_DEPTH = -100000;
const BUBBLE_DEPTH = 1_000_000;

interface CharGObjects {
  body: Phaser.GameObjects.Image;
  bubble: Phaser.GameObjects.Image;
}

/**
 * Renders an OfficeState with Phaser, 1:1 with the original canvas renderer:
 * floor + wall-base tiles, z-sorted furniture/walls, characters and pets, and
 * speech bubbles. Static layers (floor, walls, furniture) are built once per
 * layout; characters/pets/bubbles are pooled and updated every frame.
 */
export class PhaserRenderer {
  private readonly statics: Phaser.GameObjects.Image[] = [];
  private readonly furniturePool: Phaser.GameObjects.Image[] = [];
  /** The furniture array reference last rendered — the engine swaps it on each
   *  rebuild (ambient animation every ~0.2s and PC auto-on/off), so an identity
   *  check tells us cheaply when to re-sync. */
  private lastFurnitureRef: unknown = null;
  private readonly chars = new Map<number, CharGObjects>();
  private readonly pets = new Map<number, Phaser.GameObjects.Image>();

  constructor(
    private readonly scene: Phaser.Scene,
    private readonly state: RenderSource,
  ) {}

  /** (Re)build floor and walls for the current layout. Furniture is synced
   *  separately each time the engine replaces its furniture instances. */
  buildStatic(): void {
    for (const o of this.statics) o.destroy();
    this.statics.length = 0;
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
        };
        this.chars.set(ch.id, g);
      }
      this.drawCharacter(ch, g);
    }
    for (const [id, g] of this.chars) {
      if (!seen.has(id)) {
        g.body.destroy();
        g.bubble.destroy();
        this.chars.delete(id);
      }
    }
  }

  private drawCharacter(ch: Character, g: CharGObjects): void {
    const sprites = getCharacterSprites(ch.palette, ch.hueShift);
    const sd = getCharacterSprite(ch, sprites);
    const tex = spriteTexture(this.scene, sd);
    const sit = ch.state === CharacterState.TYPE ? CHARACTER_SITTING_OFFSET_PX : 0;

    g.body.setTexture(tex);
    g.body.setPosition(ch.x, ch.y + sit);
    g.body.setDepth(ch.y + TILE_SIZE / 2 + CHARACTER_Z_SORT_OFFSET);

    // Matrix spawn/despawn approximated as a fade.
    let alpha = 1;
    if (ch.matrixEffect === 'spawn') alpha = Math.min(1, ch.matrixEffectTimer / MATRIX_EFFECT_DURATION);
    else if (ch.matrixEffect === 'despawn') alpha = Math.max(0, 1 - ch.matrixEffectTimer / MATRIX_EFFECT_DURATION);
    g.body.setAlpha(alpha);

    // Bubble.
    if (ch.bubbleType) {
      const bsd = ch.bubbleType === 'permission' ? BUBBLE_PERMISSION_SPRITE : BUBBLE_WAITING_SPRITE;
      g.bubble.setTexture(spriteTexture(this.scene, bsd)).setVisible(true);
      const bsit = ch.state === CharacterState.TYPE ? BUBBLE_SITTING_OFFSET_PX : 0;
      g.bubble.setPosition(Math.round(ch.x), Math.round(ch.y + bsit - BUBBLE_VERTICAL_OFFSET_PX));
      let ba = 1;
      if (ch.bubbleType === 'waiting' && ch.bubbleTimer < BUBBLE_FADE_DURATION_SEC) {
        ba = ch.bubbleTimer / BUBBLE_FADE_DURATION_SEC;
      }
      g.bubble.setAlpha(ba);
    } else {
      g.bubble.setVisible(false);
    }
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
      const sprites = getPetSprites(pet.kind, pet.variant);
      const tex = spriteTexture(this.scene, getPetSprite(pet, sprites));
      img.setTexture(tex);
      img.setPosition(pet.x, pet.y);
      img.setDepth(pet.y + TILE_SIZE / 2 + PET_Z_SORT_OFFSET);
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
