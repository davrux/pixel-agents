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

/** Load (or reuse) a Phaser texture from an uploaded background image's data
 *  URL (see shared/office/imageAssets.ts's ImageAsset) — a raster PNG, NOT a
 *  SpriteData grid, so this uses Phaser's own base64 image decoder instead of
 *  the manual per-pixel canvas fill above. Cached per asset id (stable across
 *  calls, unlike SpriteData's per-reference cache — an ImageAsset's `data`
 *  never changes without a new id). `addBase64` decodes asynchronously (an
 *  already-in-memory data URL, so normally a handful of ms) — the returned
 *  key may not have a real texture yet on the same tick; pass `onReady` to
 *  react once it does (e.g. re-set a GameObject's texture/size). Safe to
 *  call `onReady` synchronously when already loaded. */
const pendingImageKeys = new Set<string>();
export function ensureImageTexture(scene: Phaser.Scene, assetId: string, dataUrl: string, onReady?: (key: string) => void): string {
  const key = `img_${assetId}`;
  if (scene.textures.exists(key)) {
    onReady?.(key);
    return key;
  }
  if (onReady) scene.textures.once(Phaser.Textures.Events.ADD_KEY + key, () => onReady(key));
  // Multiple PlacedImage instances can share one imageId, and buildStatic()
  // may re-run before a prior load finished — only ever request the decode once.
  if (!pendingImageKeys.has(key)) {
    pendingImageKeys.add(key);
    scene.textures.once(Phaser.Textures.Events.ADD_KEY + key, () => pendingImageKeys.delete(key));
    scene.textures.addBase64(key, dataUrl);
  }
  return key;
}
