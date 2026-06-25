import Phaser from 'phaser';
import type { SpriteData } from '@pixel/shared/office/types.js';

/**
 * Convert a SpriteData color grid (string[row][col], '' = transparent,
 * '#RRGGBB' / '#RRGGBBAA') into a Phaser texture, once per unique grid. The
 * engine hands back stable SpriteData references (cached per pose/colorize), so
 * a WeakMap keyed on identity gives us a stable texture key with no hashing.
 */
let counter = 0;
const keys = new WeakMap<SpriteData, string>();

/** Render a SpriteData to a data-URL PNG for DOM thumbnails (editor palette). */
export function spriteToDataURL(sprite: SpriteData): string {
  const h = sprite.length;
  const w = h > 0 ? sprite[0].length : 0;
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, w);
  canvas.height = Math.max(1, h);
  const ctx = canvas.getContext('2d')!;
  for (let r = 0; r < h; r++) {
    for (let c = 0; c < w; c++) {
      const col = sprite[r][c];
      if (!col) continue;
      ctx.fillStyle = col;
      ctx.fillRect(c, r, 1, 1);
    }
  }
  return canvas.toDataURL();
}

export function spriteTexture(scene: Phaser.Scene, sprite: SpriteData): string {
  let key = keys.get(sprite);
  if (key && scene.textures.exists(key)) return key;

  const h = sprite.length;
  const w = h > 0 ? sprite[0].length : 0;
  key = `spr_${counter++}`;
  const canvas = scene.textures.createCanvas(key, Math.max(1, w), Math.max(1, h));
  if (!canvas) return key;
  const ctx = canvas.getContext();
  for (let r = 0; r < h; r++) {
    const row = sprite[r];
    for (let c = 0; c < w; c++) {
      const col = row[c];
      if (!col) continue;
      ctx.fillStyle = col;
      ctx.fillRect(c, r, 1, 1);
    }
  }
  canvas.refresh();
  keys.set(sprite, key);
  return key;
}
