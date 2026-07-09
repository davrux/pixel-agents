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
  rects: Record<string, AtlasRect>; // full name→rect map (for the mesh worker's atlas stub)
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

/** Conference monitor icon: a dark bezel around a blue screen with two person glyphs
 *  (a video-call look) — matches the 2D office monitor. Drawn at runtime (no PNG). */
function drawMonitor(ctx: CanvasRenderingContext2D, s: number): void {
  const p = s / 16;
  const bar = (x: number, y: number, w: number, h: number): void => ctx.fillRect(x * p, y * p, w * p, h * p);
  ctx.fillStyle = '#181b22'; // dark bezel
  bar(1, 1, 14, 11);
  ctx.fillStyle = '#3a6ea5'; // blue screen
  bar(2, 2, 12, 9);
  ctx.fillStyle = '#dfe8f5'; // two head+shoulder silhouettes (call)
  bar(5, 4, 2, 2);
  bar(4, 6, 4, 3);
  bar(10, 4, 2, 2);
  bar(9, 6, 4, 3);
  ctx.fillStyle = '#20242e'; // stand + base
  bar(7, 12, 2, 2);
  bar(4, 14, 8, 1);
}

/** Bedrock: dark stone with a coarse speckle so the unbreakable world floor reads distinctly. */
function drawBedrock(ctx: CanvasRenderingContext2D, s: number): void {
  const p = s / 16;
  ctx.fillStyle = '#3a3a40';
  ctx.fillRect(0, 0, s, s);
  const spots: [number, number, string][] = [
    [1, 2, '#222'], [4, 1, '#555'], [7, 3, '#222'], [11, 1, '#555'], [13, 4, '#222'],
    [2, 6, '#555'], [6, 7, '#222'], [9, 6, '#555'], [12, 8, '#222'], [3, 10, '#222'],
    [7, 11, '#555'], [10, 12, '#222'], [14, 11, '#555'], [1, 13, '#555'], [5, 14, '#222'], [11, 14, '#555'],
  ];
  for (const [x, y, c] of spots) {
    ctx.fillStyle = c;
    ctx.fillRect(x * p, y * p, 2 * p, 2 * p);
  }
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
  { name: 'copper_ore', render: drawOre('mineral_copper') },
  { name: 'tin_ore', render: drawOre('mineral_tin') },
  { name: 'gold_ore', render: drawOre('mineral_gold') },
  { name: 'diamond_ore', render: drawOre('mineral_diamond') },
  { name: 'mese_ore', render: drawOre('mineral_mese') },
  { name: 'monitor', render: (ctx, s) => drawMonitor(ctx, s) },
  { name: 'bedrock', render: (ctx, s) => drawBedrock(ctx, s) },
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
  // Full name→rect map, so the mesher can run in a Web Worker with a lightweight
  // rect-only atlas stub (no GPU texture, no canvas). See meshWorker.ts.
  const rects: Record<string, AtlasRect> = {};
  for (const name of index.keys()) rects[name] = rect(name);
  return { texture, rect, tileSize: ts, rects };
}
