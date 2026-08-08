/**
 * Two ways to bring in outside art without our own pipeline, NOT to paint
 * with arbitrary Tiled gids (we keep our own semantic floor/wall/furniture
 * model — see the office/custom-editor branch's own design notes):
 *
 * - parseTilesetFiles: an external Tiled tileset (.tsx + its image file(s),
 *   picked together from disk). Supports both shapes Tiled produces: a
 *   single shared sheet (tilewidth/tileheight/columns/tilecount + one
 *   <image>), and a "Collection of Images" set (one <image> per <tile>, our
 *   own furniture-tileset.tsx shape). Carries names, per-tile footprints, and
 *   Tiled <animation> data through.
 * - parseSpritesheetFile: a single plain PNG + a tile size, no Tiled
 *   involved at all — simpler, but no names/per-tile footprint/animation.
 *
 * Pure regex parsing for the Tiled path (browser has no XML-to-DOM need here
 * — this mirrors the same technique server/src/scripts/tiled/tilesetInfo.ts
 * already uses on Node, just client-side against File objects instead of fs).
 */
import { TILE_SIZE } from '@pixel/shared/office/constants.js';
import { DEFAULT_ANIMATION_FRAME_MS, getCatalogEntry } from '@pixel/shared/office/layout/furnitureCatalog.js';
import type { SpriteData } from '@pixel/shared/office/types.js';

export interface ImportedTile {
  /** Sanitized, but NOT yet disambiguated against the live catalog — the
   *  tile's stable identity within its own tileset (its Tiled "type"
   *  property, or a positional fallback). The caller (see OfficeScene's
   *  importTilesetFiles) decides whether this matches something already
   *  imported from the same source (→ replace in place, reusing that id) or
   *  is new (→ uniqueId() it before saving) — see findBySourceKey. */
  id: string;
  /** The tileset's own Tiled name (e.g. "Furniture") — every tile from one
   *  import shares this; stored on each saved entry as `source` so re-
   *  importing the same tileset can find its previous tiles again. */
  source: string;
  label: string;
  footprintW: number;
  footprintH: number;
  /** One frame for a static tile; 2+ for a tile carrying a Tiled
   *  `<animation>` — each with its own duration, exactly as Tiled stores it. */
  frames: Array<{ sprite: SpriteData; durationMs: number }>;
}

function sanitizeId(raw: string): string {
  const cleaned = raw.replace(/[^A-Za-z0-9_:-]/g, '_').slice(0, 40);
  return cleaned || 'IMPORTED';
}

/** Saving a furniture override for an id that already exists in the catalog is
 *  a full replace of that entry, not a merge (see server/src/assetOverrides.ts)
 *  — so importing a tileset whose tile "type" happens to reuse an existing id
 *  (e.g. re-importing an exported copy of our own furniture) would silently
 *  wipe that item's placement/rotation/state/action metadata down to just a
 *  sprite. Every FRESH imported id must be one the catalog doesn't already
 *  know (a deliberate replace of a matched previous import reuses its id on
 *  purpose — see findBySourceKey — and skips this). */
export function uniqueId(base: string): string {
  if (!getCatalogEntry(base)) return base;
  let n = 2;
  let id = `${base}_${n}`;
  while (getCatalogEntry(id)) id = `${base}_${++n}`;
  return id;
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

/** A tile's Tiled `<animation><frame tileid=".." duration=".."/>…</animation>`,
 *  or null if it has none. Each `tileid` names another tile in the SAME
 *  tileset (by numeric id) whose own image/slice supplies that frame. */
function animationFramesOf(body: string): Array<{ tileid: number; durationMs: number }> | null {
  const block = /<animation>([\s\S]*?)<\/animation>/.exec(body)?.[1];
  if (!block) return null;
  const frames = [...block.matchAll(/<frame\s+tileid="(\d+)"\s+duration="(\d+)"\s*\/>/g)].map((m) => ({
    tileid: Number(m[1]),
    durationMs: Number(m[2]),
  }));
  return frames.length > 0 ? frames : null;
}

/** @param files The .tsx plus every image it references, picked together in
 *  one file-input selection. */
export async function parseTilesetFiles(files: FileList | File[]): Promise<ImportedTile[]> {
  const fileArr = Array.from(files);
  const tsxFile = fileArr.find((f) => f.name.toLowerCase().endsWith('.tsx'));
  if (!tsxFile) throw new Error('Select a .tsx tileset file, plus its image file(s), together.');
  const xml = await tsxFile.text();

  const setTag = /<tileset\b([^>]*)>/.exec(xml)?.[1] ?? '';
  const source = attr(setTag, 'name') ?? 'Imported';
  const tilesetName = sanitizeId(source.toUpperCase());

  const imageFor = async (source: string): Promise<HTMLImageElement> => {
    const base = source.split('/').pop() ?? source;
    const file = fileArr.find((f) => f.name === base);
    if (!file) throw new Error(`Missing image file "${base}" — select it alongside the .tsx.`);
    return loadImage(file);
  };

  const tileBlocks = [...xml.matchAll(/<tile id="(\d+)">([\s\S]*?)<\/tile>/g)].map((m) => ({ id: Number(m[1]), body: m[2] }));
  const blockById = new Map(tileBlocks.map((t) => [t.id, t]));
  const isCollectionOfImages = tileBlocks.some((t) => /<image\b/.test(t.body));

  // A tile referenced only as a frame of another tile's <animation> is a
  // component, not a placeable item of its own — skip it at the top level
  // (mirrors how our own catalog hides non-first animation frames).
  const frameComponentIds = new Set<number>();
  for (const t of tileBlocks) {
    const anim = animationFramesOf(t.body);
    if (anim) for (const f of anim) frameComponentIds.add(f.tileid);
  }

  const tiles: ImportedTile[] = [];
  if (isCollectionOfImages) {
    const spriteOf = async (body: string): Promise<{ sprite: SpriteData; footprintW: number; footprintH: number } | null> => {
      const img = /<image source="([^"]*)" width="(\d+)" height="(\d+)"\/>/.exec(body);
      if (!img) return null;
      const [, source, wStr, hStr] = img;
      const w = Number(wStr);
      const h = Number(hStr);
      const bitmap = await imageFor(source);
      return { sprite: imageToSprite(bitmap, 0, 0, w, h), footprintW: footprintOf(w), footprintH: footprintOf(h) };
    };
    for (const { id, body } of tileBlocks) {
      const anim = animationFramesOf(body);
      if (!anim && frameComponentIds.has(id)) continue;
      const props = tilePropsOf(body);
      const baseId = sanitizeId(props.type || `${tilesetName}_${id}`);
      const label = props.label || props.type || `${tilesetName} ${id}`;
      if (anim) {
        const frames: ImportedTile['frames'] = [];
        let fw = 1;
        let fh = 1;
        for (const fr of anim) {
          const fb = blockById.get(fr.tileid);
          if (!fb) continue;
          const got = await spriteOf(fb.body);
          if (!got) continue;
          if (frames.length === 0) {
            fw = got.footprintW;
            fh = got.footprintH;
          }
          frames.push({ sprite: got.sprite, durationMs: fr.durationMs });
        }
        if (frames.length === 0) continue;
        tiles.push({ id: baseId, source, label, footprintW: fw, footprintH: fh, frames });
      } else {
        const got = await spriteOf(body);
        if (!got) continue;
        tiles.push({
          id: baseId,
          source,
          label,
          footprintW: got.footprintW,
          footprintH: got.footprintH,
          frames: [{ sprite: got.sprite, durationMs: DEFAULT_ANIMATION_FRAME_MS }],
        });
      }
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
    const spriteOf = (n: number): SpriteData => {
      const col = n % cols;
      const row = Math.floor(n / cols);
      return imageToSprite(bitmap, col * tw, row * th, tw, th);
    };
    for (let i = 0; i < count; i++) {
      const tb = blockById.get(i);
      const anim = tb ? animationFramesOf(tb.body) : null;
      if (!anim && frameComponentIds.has(i)) continue;
      const props = tb ? tilePropsOf(tb.body) : {};
      const baseId = sanitizeId(props.type || `${tilesetName}_${i}`);
      const label = props.label || props.type || `${tilesetName} ${i}`;
      const frames: ImportedTile['frames'] = anim
        ? anim.map((fr) => ({ sprite: spriteOf(fr.tileid), durationMs: fr.durationMs }))
        : [{ sprite: spriteOf(i), durationMs: DEFAULT_ANIMATION_FRAME_MS }];
      tiles.push({ id: baseId, source, label, footprintW: footprintOf(tw), footprintH: footprintOf(th), frames });
    }
  }
  if (tiles.length === 0) throw new Error('No tiles found in that tileset.');
  return tiles;
}

/** Import a plain PNG sprite sheet with no Tiled metadata at all — just a
 *  tile size, sliced left-to-right/top-to-bottom. A simpler, Tiled-
 *  independent alternative to parseTilesetFiles for anyone who'd rather not
 *  touch Tiled: no per-tile names or footprint overrides, and no animation
 *  (there's no metadata to carry any of that) — every cell becomes one
 *  static tile. Fully-transparent cells are skipped, so gaps in the sheet
 *  don't become empty, unplaceable items. */
export async function parseSpritesheetFile(file: File, tileW: number, tileH: number): Promise<ImportedTile[]> {
  const img = await loadImage(file);
  const cols = Math.max(1, Math.floor(img.width / tileW));
  const rows = Math.max(1, Math.floor(img.height / tileH));
  const source = file.name.replace(/\.[^.]+$/, '');
  const baseName = sanitizeId(source.toUpperCase());
  const footprintW = footprintOf(tileW);
  const footprintH = footprintOf(tileH);
  const tiles: ImportedTile[] = [];
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      const sprite = imageToSprite(img, col * tileW, row * tileH, tileW, tileH);
      if (sprite.every((r) => r.every((c) => !c))) continue; // fully transparent — skip
      const i = row * cols + col;
      tiles.push({
        id: `${baseName}_${i}`,
        source,
        label: `${source} ${i}`,
        footprintW,
        footprintH,
        frames: [{ sprite, durationMs: DEFAULT_ANIMATION_FRAME_MS }],
      });
    }
  }
  if (tiles.length === 0) throw new Error('No non-empty tiles found at that size.');
  return tiles;
}
