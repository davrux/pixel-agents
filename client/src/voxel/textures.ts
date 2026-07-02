/**
 * Runtime block-texture atlas. Loads the real PNG tiles from
 * `client/public/textures/blocks/` (baunilha, CC-BY-SA 4.0 — see CREDITS.md) and
 * packs them into one canvas → a NearestFilter texture, with a name→UV-rect map
 * the mesher uses. Resolution-agnostic: the tile size is read from the images, so
 * a 32× pack later is a pure asset swap (no code change).
 */
import * as THREE from 'three';

export interface AtlasRect {
  u0: number;
  u1: number;
  vBot: number;
  vTop: number;
}
export interface Atlas {
  texture: THREE.CanvasTexture;
  rect(name: string): AtlasRect;
  tileSize: number;
}

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`failed to load ${url}`));
    img.src = url;
  });
}

export async function loadBlockAtlas(names: string[]): Promise<Atlas> {
  const base = new URL('textures/blocks/', document.baseURI).href;
  const imgs = await Promise.all(names.map((n) => loadImage(`${base}${n}.png`)));
  const ts = imgs[0]?.width || 16; // native tile size (assumed square + uniform)
  const cols = Math.ceil(Math.sqrt(names.length));
  const rows = Math.ceil(names.length / cols);
  const cv = document.createElement('canvas');
  cv.width = cols * ts;
  cv.height = rows * ts;
  const ctx = cv.getContext('2d')!;
  ctx.imageSmoothingEnabled = false;
  const index = new Map<string, number>();
  names.forEach((n, i) => {
    index.set(n, i);
    ctx.drawImage(imgs[i], (i % cols) * ts, ((i / cols) | 0) * ts, ts, ts);
  });
  const texture = new THREE.CanvasTexture(cv);
  texture.magFilter = THREE.NearestFilter;
  texture.minFilter = THREE.NearestFilter;
  texture.generateMipmaps = false;
  texture.colorSpace = THREE.SRGBColorSpace;

  const inset = 0.5 / (cols * ts); // guard against neighbour bleed
  const rect = (name: string): AtlasRect => {
    const i = index.get(name) ?? 0;
    const col = i % cols;
    const row = (i / cols) | 0;
    return {
      u0: col / cols + inset,
      u1: (col + 1) / cols - inset,
      vTop: 1 - row / rows - inset,
      vBot: 1 - (row + 1) / rows + inset,
    };
  };
  return { texture, rect, tileSize: ts };
}
