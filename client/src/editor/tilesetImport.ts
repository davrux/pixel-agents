/**
 * Read an external Tiled tileset (.tsx + its image file(s), picked together
 * from disk) into new furniture catalog entries — a way to bring in outside
 * art without needing our own pipeline, NOT a way to paint with arbitrary
 * Tiled gids (we keep our own semantic floor/wall/furniture model — see the
 * office/custom-editor branch's own design notes). Supports both tileset
 * shapes Tiled produces: a single shared sheet (tilewidth/tileheight/columns/
 * tilecount + one <image>), and a "Collection of Images" set (one <image>
 * per <tile>, our own furniture-tileset.tsx shape).
 *
 * Pure regex parsing (browser has no XML-to-DOM need here — this mirrors the
 * same technique server/src/scripts/tiled/tilesetInfo.ts already uses on
 * Node, just client-side against File objects instead of fs).
 */
import { TILE_SIZE } from '@pixel/shared/office/constants.js';
import type { SpriteData } from '@pixel/shared/office/types.js';

export interface ImportedTile {
  /** Sanitized to the server's asset-id pattern (see SimRoom's saveAsset). */
  id: string;
  label: string;
  footprintW: number;
  footprintH: number;
  sprite: SpriteData;
}

function sanitizeId(raw: string): string {
  const cleaned = raw.replace(/[^A-Za-z0-9_:-]/g, '_').slice(0, 40);
  return cleaned || 'IMPORTED';
}

function attr(tag: string, name: string): string | undefined {
  return new RegExp(`\\b${name}="([^"]*)"`).exec(tag)?.[1];
}

async function loadImage(file: File): Promise<HTMLImageElement> {
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    await new Promise<void>((resolve, reject) => {
      img.onload = () => resolve();
      img.onerror = () => reject(new Error(`Could not decode image "${file.name}"`));
      img.src = url;
    });
    return img;
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** One shared canvas/context, reused across slices (only ever one import in
 *  flight at a time — no need for a pool). */
let sliceCanvas: HTMLCanvasElement | null = null;
function imageToSprite(img: HTMLImageElement, sx: number, sy: number, w: number, h: number): SpriteData {
  if (!sliceCanvas) sliceCanvas = document.createElement('canvas');
  sliceCanvas.width = w;
  sliceCanvas.height = h;
  const ctx = sliceCanvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('Canvas 2D not available');
  ctx.clearRect(0, 0, w, h);
  ctx.drawImage(img, sx, sy, w, h, 0, 0, w, h);
  const { data } = ctx.getImageData(0, 0, w, h);
  const sprite: SpriteData = [];
  for (let y = 0; y < h; y++) {
    const row: string[] = [];
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const a = data[i + 3];
      if (a === 0) {
        row.push('');
        continue;
      }
      const hex = (n: number) => n.toString(16).padStart(2, '0');
      row.push(a === 255 ? `#${hex(data[i])}${hex(data[i + 1])}${hex(data[i + 2])}` : `#${hex(data[i])}${hex(data[i + 1])}${hex(data[i + 2])}${hex(a)}`);
    }
    sprite.push(row);
  }
  return sprite;
}

function footprintOf(px: number): number {
  return Math.min(16, Math.max(1, Math.round(px / TILE_SIZE)));
}

function tilePropsOf(body: string): { type?: string; label?: string } {
  const type = /<property name="type"(?:\s+type="string")?\s+value="([^"]*)"\/>/.exec(body)?.[1];
  const label = /<property name="label"(?:\s+type="string")?\s+value="([^"]*)"\/>/.exec(body)?.[1];
  return { type, label };
}

/** @param files The .tsx plus every image it references, picked together in
 *  one file-input selection. */
export async function parseTilesetFiles(files: FileList | File[]): Promise<ImportedTile[]> {
  const fileArr = Array.from(files);
  const tsxFile = fileArr.find((f) => f.name.toLowerCase().endsWith('.tsx'));
  if (!tsxFile) throw new Error('Select a .tsx tileset file, plus its image file(s), together.');
  const xml = await tsxFile.text();

  const setTag = /<tileset\b([^>]*)>/.exec(xml)?.[1] ?? '';
  const tilesetName = sanitizeId((attr(setTag, 'name') ?? 'IMPORTED').toUpperCase());

  const imageFor = async (source: string): Promise<HTMLImageElement> => {
    const base = source.split('/').pop() ?? source;
    const file = fileArr.find((f) => f.name === base);
    if (!file) throw new Error(`Missing image file "${base}" — select it alongside the .tsx.`);
    return loadImage(file);
  };

  const tileBlocks = [...xml.matchAll(/<tile id="(\d+)">([\s\S]*?)<\/tile>/g)].map((m) => ({ id: Number(m[1]), body: m[2] }));
  const isCollectionOfImages = tileBlocks.some((t) => /<image\b/.test(t.body));

  const tiles: ImportedTile[] = [];
  if (isCollectionOfImages) {
    for (const { id, body } of tileBlocks) {
      const img = /<image source="([^"]*)" width="(\d+)" height="(\d+)"\/>/.exec(body);
      if (!img) continue;
      const [, source, wStr, hStr] = img;
      const w = Number(wStr);
      const h = Number(hStr);
      const bitmap = await imageFor(source);
      const props = tilePropsOf(body);
      tiles.push({
        id: sanitizeId(props.type || `${tilesetName}_${id}`),
        label: props.label || props.type || `${tilesetName} ${id}`,
        footprintW: footprintOf(w),
        footprintH: footprintOf(h),
        sprite: imageToSprite(bitmap, 0, 0, w, h),
      });
    }
  } else {
    const tw = Number(attr(setTag, 'tilewidth'));
    const th = Number(attr(setTag, 'tileheight'));
    const count = Number(attr(setTag, 'tilecount'));
    const cols = Number(attr(setTag, 'columns'));
    const imgTag = /<image source="([^"]*)"[^>]*\/>/.exec(xml);
    if (!tw || !th || !count || !cols || !imgTag) {
      throw new Error('Could not read tile size/count/columns/image from the .tsx.');
    }
    const bitmap = await imageFor(imgTag[1]);
    const propsById = new Map(tileBlocks.map((t) => [t.id, tilePropsOf(t.body)]));
    for (let i = 0; i < count; i++) {
      const col = i % cols;
      const row = Math.floor(i / cols);
      const props = propsById.get(i) ?? {};
      tiles.push({
        id: sanitizeId(props.type || `${tilesetName}_${i}`),
        label: props.label || props.type || `${tilesetName} ${i}`,
        footprintW: footprintOf(tw),
        footprintH: footprintOf(th),
        sprite: imageToSprite(bitmap, col * tw, row * th, tw, th),
      });
    }
  }
  if (tiles.length === 0) throw new Error('No tiles found in that tileset.');
  return tiles;
}
