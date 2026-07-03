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

/** A tile drawn at runtime (no PNG): water, the portal P overlay, … */
export interface SyntheticTile {
  name: string;
  render: (ctx: CanvasRenderingContext2D, size: number, img: Map<string, HTMLImageElement>) => void;
}

function drawWater(ctx: CanvasRenderingContext2D, s: number): void {
  ctx.fillStyle = '#2f6bd8';
  ctx.fillRect(0, 0, s, s);
  const p = s / 16;
  ctx.fillStyle = 'rgba(120,180,255,0.35)';
  ctx.fillRect(2 * p, 4 * p, 5 * p, p);
  ctx.fillRect(9 * p, 9 * p, 5 * p, p);
  ctx.fillStyle = 'rgba(20,50,120,0.35)';
  ctx.fillRect(4 * p, 11 * p, 4 * p, p);
}
function drawLava(ctx: CanvasRenderingContext2D, s: number): void {
  ctx.fillStyle = '#e2521a';
  ctx.fillRect(0, 0, s, s);
  const p = s / 16;
  ctx.fillStyle = '#ffcc33'; // bright molten highlights
  ctx.fillRect(2 * p, 3 * p, 5 * p, p);
  ctx.fillRect(9 * p, 10 * p, 4 * p, p);
  ctx.fillRect(5 * p, 7 * p, 3 * p, p);
  ctx.fillStyle = '#8a1f06'; // dark crust blotches
  ctx.fillRect(3 * p, 12 * p, 4 * p, 2 * p);
  ctx.fillRect(11 * p, 4 * p, 3 * p, 2 * p);
}
function drawPortal(ctx: CanvasRenderingContext2D, s: number, img: Map<string, HTMLImageElement>): void {
  const glass = img.get('glass');
  if (glass) ctx.drawImage(glass, 0, 0, s, s);
  else {
    ctx.fillStyle = 'rgba(180,220,255,0.55)';
    ctx.fillRect(0, 0, s, s);
  }
  const p = s / 16;
  const bar = (x: number, y: number, w: number, h: number): void => ctx.fillRect(x * p, y * p, w * p, h * p);
  ctx.fillStyle = 'rgba(255,255,255,0.85)'; // halo for contrast
  bar(2, 1, 10, 14);
  ctx.fillStyle = '#14161c'; // thick blocky "P"
  bar(4, 2, 3, 12);
  bar(4, 2, 7, 3);
  bar(8, 2, 3, 6);
  bar(4, 6, 7, 3);
}

/** Ore tile = stone base with a mineral overlay drawn on top (Luanti `stone^mineral`). */
function drawOre(overlay: string) {
  return (ctx: CanvasRenderingContext2D, s: number, img: Map<string, HTMLImageElement>): void => {
    const st = img.get('stone');
    if (st) ctx.drawImage(st, 0, 0, s, s);
    else {
      ctx.fillStyle = '#8f8f8f';
      ctx.fillRect(0, 0, s, s);
    }
    const o = img.get(overlay);
    if (o) ctx.drawImage(o, 0, 0, s, s);
  };
}

/** Built-in synthetic tiles (passed to loadBlockAtlas as `extra`). */
export const SYNTHETIC: SyntheticTile[] = [
  { name: 'water', render: (ctx, s) => drawWater(ctx, s) },
  { name: 'portal', render: drawPortal },
  { name: 'lava', render: (ctx, s) => drawLava(ctx, s) },
  { name: 'coal_ore', render: drawOre('mineral_coal') },
  { name: 'iron_ore', render: drawOre('mineral_iron') },
];

export async function loadBlockAtlas(names: string[], extra: SyntheticTile[] = []): Promise<Atlas> {
  const base = new URL('textures/blocks/', document.baseURI).href;
  const imgs = await Promise.all(names.map((n) => loadImage(`${base}${n}.png`)));
  const imgByName = new Map<string, HTMLImageElement>();
  names.forEach((n, i) => imgByName.set(n, imgs[i]));
  const ts = imgs[0]?.width || 16; // native tile size (assumed square + uniform)
  const allNames = [...names, ...extra.map((e) => e.name)];
  const cols = Math.ceil(Math.sqrt(allNames.length));
  const rows = Math.ceil(allNames.length / cols);
  const cv = document.createElement('canvas');
  cv.width = cols * ts;
  cv.height = rows * ts;
  const ctx = cv.getContext('2d')!;
  ctx.imageSmoothingEnabled = false;
  const index = new Map<string, number>();
  allNames.forEach((n, i) => index.set(n, i));
  // Some tiles are transparent overlays (e.g. grass_side is a grass fringe with a
  // see-through lower half); draw their opaque base underneath first so the block
  // isn't transparent below the grass. Bases must be block textures we also load.
  const OVERLAY_BASE: Record<string, string> = { grass_side: 'dirt' };
  names.forEach((n, i) => {
    const x = (i % cols) * ts,
      y = ((i / cols) | 0) * ts;
    const base = OVERLAY_BASE[n] ? imgByName.get(OVERLAY_BASE[n]) : undefined;
    if (base) ctx.drawImage(base, x, y, ts, ts);
    ctx.drawImage(imgs[i], x, y, ts, ts);
  });
  extra.forEach((e, k) => {
    const i = names.length + k;
    ctx.save();
    ctx.translate((i % cols) * ts, ((i / cols) | 0) * ts);
    e.render(ctx, ts, imgByName);
    ctx.restore();
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
