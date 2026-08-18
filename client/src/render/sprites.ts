import Phaser from 'phaser';
import type { SheetCellRef, SpriteData } from '@pixel/shared/office/types.js';
import { serverHttpOrigin } from '../net/room.js';
import { FLOOR_TILE_H, FLOOR_TILE_W, WALL_TILE_H, WALL_TILE_W } from '@pixel/shared/office/tiledSheetLayout.js';

/**
 * SpriteData → something Phaser can draw, via a **runtime texture atlas**.
 *
 * ── Why an atlas ──
 *
 * This used to hand every distinct SpriteData its own canvas texture. Correct,
 * and it does not scale: the GPU batches draw calls only while the same texture
 * stays bound, so a field of a few hundred distinct 16×16 pieces — which is
 * exactly what a painted road or a decal ground costs (see PlacedDecal) — became
 * a few hundred texture binds per frame. Packing them into shared pages turns
 * that back into one batch, and it is the standard shape for 2D engines; the only
 * unusual thing here is doing it at runtime rather than from a baked file, which
 * is itself standard wherever the art is not known at build time (glyph atlases
 * work exactly this way). Our art qualifies: floors are colorized into 65
 * variants per pattern on demand, avatars come from accounts, and tilesets
 * reload while the server runs.
 *
 * ── What this does NOT change ──
 *
 * Nothing outside this file and its callers in PhaserRenderer. SpriteData stays
 * the interchange format, `spriteForPose` still decides which sprite a pose
 * shows, and the server neither knows nor cares that an atlas exists — it is a
 * graphics-card question, not a world-state one.
 *
 * ── The two rules that make it work ──
 *
 * 1. A canvas texture re-uploads WHOLE on refresh(). Refreshing per sprite would
 *    push megabytes per packed tile and end up slower than the thing it replaces,
 *    so pages are marked dirty and flushed once per frame, before rendering
 *    (Phaser.Core.Events.PRE_RENDER — after the update where sprites get packed,
 *    before anything draws them).
 * 2. A sprite that cannot be packed falls back to its own texture, the old path.
 *    Art must never become invisible because a packer said no.
 *
 * 3. Space is bounded, and bounded by CONTENT rather than by how often we are
 *    handed it. Identical pixels always resolve to the frame that already holds
 *    them (see `byContent`), because the events that hand us sprites again — a
 *    tileset saved in Tiled rebuilds the whole catalog, an avatar broadcast
 *    re-arrives — produce fresh arrays holding the very same art. Without that,
 *    every save would consume page space for a second copy of a picture already
 *    in there, which is the leak this would otherwise be.
 *
 * ── Why nothing is ever evicted ──
 *
 * A glyph atlas evicts least-recently-used entries, and it can, because text
 * re-requests every glyph it draws on every frame. Here, statics (floor, walls,
 * decals) are drawn once into GameObjects that keep their frame until the layout
 * changes, so reusing an evicted rectangle for other art would silently repaint
 * a wall as a chair, with nothing to notice it. So frames live for the session,
 * pages are capped (MAX_PAGES), and anything past the cap takes the own-texture
 * fallback — which is what the code did for everything before atlases existed.
 * Genuinely new content is what consumes space, and that set is finite: the art
 * of the world, plus one frame per avatar edit somebody performs while here.
 */

/** A packed sprite: the page's texture key plus the frame inside it. `frame`
 *  absent means the key IS the whole texture (the fallback path, and the Matrix
 *  effect's own per-character canvases). */
export interface SpriteTex {
  key: string;
  frame?: string;
}

/**
 * Page size. Roughly two pages hold every sprite the world currently has (~700k
 * pixels all told), and a page costs width×height×4 bytes of canvas plus the same
 * again on the GPU — so this trades a little slack for far fewer pages, rather
 * than sizing to the maximum a card would allow.
 */
const PAGE = 1024;
/** Transparent gutter between frames, so filtering at fractional zoom can never
 *  sample a neighbour. One pixel is enough at integer-ish zoom; art is pixel art
 *  and never mipmapped. */
const PAD = 1;

interface AtlasPage {
  key: string;
  tex: Phaser.Textures.CanvasTexture;
  ctx: CanvasRenderingContext2D;
  /** Shelf packer state: cursor and the current shelf's height. */
  x: number;
  y: number;
  rowH: number;
  dirty: boolean;
}

/** Hard ceiling on atlas pages. Four 1024² pages hold roughly 4000 tiles or 400
 *  character sheets — far past the art of a world — so reaching this means
 *  something is generating sprites in a loop, and falling back is safer than
 *  quietly growing. */
const MAX_PAGES = 4;

const pages: AtlasPage[] = [];
/** Stable per-SpriteData identity, so the same grid is packed exactly once. The
 *  engine hands back stable references (cached per pose/colorize), and a WeakMap
 *  means a sprite nobody holds any more can be collected. */
const packed = new WeakMap<SpriteData, SpriteTex>();
/**
 * The same pixels → the same frame, keyed by content.
 *
 * The identity WeakMap above is the fast path and catches the common case (the
 * engine hands back stable references). This is the one that keeps memory
 * bounded: a rebuilt catalog or a re-broadcast avatar arrives as NEW arrays
 * holding art that is already packed, and without this each of those would eat a
 * fresh rectangle. Keyed by a hash of the rows — cheap, since SpriteData is
 * already strings — with the full row text kept alongside so a hash collision
 * cannot hand back the wrong picture.
 */
const byContent = new Map<string, { rows: string; tex: SpriteTex }>();

/** Cheap, stable string hash (FNV-1a) over a sprite's rows. */
function contentKey(sprite: SpriteData, w: number, h: number): { hash: string; rows: string } {
  const rows = sprite.join('\u0001');
  let hash = 0x811c9dc5;
  for (let i = 0; i < rows.length; i++) {
    hash ^= rows.charCodeAt(i);
    hash = (hash * 0x01000193) >>> 0;
  }
  return { hash: `${w}x${h}:${hash.toString(36)}:${rows.length}`, rows };
}
let pageCounter = 0;
let frameCounter = 0;
let flushHooked = false;
let warnedFull = false;

/** Upload every page that changed this frame, once. See rule 1 in the header. */
function flushPages(): void {
  for (const page of pages) {
    if (!page.dirty) continue;
    page.tex.refresh();
    page.dirty = false;
  }
}

function hookFlush(scene: Phaser.Scene): void {
  if (flushHooked) return;
  flushHooked = true;
  scene.game.events.on(Phaser.Core.Events.PRE_RENDER, flushPages);
}

function newPage(scene: Phaser.Scene): AtlasPage | null {
  if (pages.length >= MAX_PAGES) {
    if (!warnedFull) {
      warnedFull = true;
      console.warn(
        `[sprites] atlas is full (${MAX_PAGES} pages of ${PAGE}²) — further sprites get their own texture. ` +
          'Expected only if something generates sprites continuously; the art of a world fits many times over.',
      );
    }
    return null;
  }
  const key = `atlas_${pageCounter++}`;
  const tex = scene.textures.createCanvas(key, PAGE, PAGE);
  if (!tex) return null;
  const page: AtlasPage = { key, tex, ctx: tex.getContext(), x: PAD, y: PAD, rowH: 0, dirty: false };
  pages.push(page);
  return page;
}

/** Reserve w×h on some page, opening a new one if nothing fits. Shelf packing:
 *  fill a row left to right, then start the next row below the tallest sprite in
 *  it. Good enough here because sprites are small and similar in height, and it
 *  needs no bookkeeping beyond three numbers. */
function reserve(scene: Phaser.Scene, w: number, h: number): { page: AtlasPage; x: number; y: number } | null {
  for (const page of pages) {
    if (page.x + w + PAD > PAGE) {
      // Next shelf.
      page.x = PAD;
      page.y += page.rowH + PAD;
      page.rowH = 0;
    }
    if (page.y + h + PAD > PAGE) continue; // page full
    const at = { page, x: page.x, y: page.y };
    page.x += w + PAD;
    if (h > page.rowH) page.rowH = h;
    return at;
  }
  const page = newPage(scene);
  if (!page) return null;
  const at = { page, x: page.x, y: page.y };
  page.x += w + PAD;
  page.rowH = h;
  return at;
}

/** SpriteData → ImageData, in one pass. One putImageData beats w×h fillRect calls
 *  by a wide margin: the whole catalog is ~700k pixels, i.e. ~700k canvas calls
 *  the old way, every one of them a separate state change. */
function toImageData(ctx: CanvasRenderingContext2D, sprite: SpriteData, w: number, h: number): ImageData {
  const img = ctx.createImageData(w, h);
  const data = img.data;
  for (let r = 0; r < h; r++) {
    const row = sprite[r];
    for (let c = 0; c < w; c++) {
      const hex = row?.[c];
      if (!hex) continue; // '' = transparent, and the buffer starts zeroed
      const i = (r * w + c) * 4;
      data[i] = parseInt(hex.slice(1, 3), 16);
      data[i + 1] = parseInt(hex.slice(3, 5), 16);
      data[i + 2] = parseInt(hex.slice(5, 7), 16);
      data[i + 3] = hex.length >= 9 ? parseInt(hex.slice(7, 9), 16) : 255;
    }
  }
  return img;
}

/** The fallback: this sprite gets a texture of its own, exactly as before atlases
 *  existed. Reached only by art too large for a page, or if a canvas cannot be
 *  created at all. */
function ownTexture(scene: Phaser.Scene, sprite: SpriteData, w: number, h: number): SpriteTex {
  const key = `spr_${frameCounter++}`;
  const tex = scene.textures.createCanvas(key, Math.max(1, w), Math.max(1, h));
  if (!tex) return { key };
  const ctx = tex.getContext();
  ctx.putImageData(toImageData(ctx, sprite, w, h), 0, 0);
  tex.refresh();
  return { key };
}

/**
 * Pack (or look up) `sprite` and return where to draw it from.
 *
 * Call it as often as you like with the same SpriteData — the second call is a
 * WeakMap hit. The returned frame is valid for the rest of the session.
 */
export function spriteTexture(scene: Phaser.Scene, sprite: SpriteData): SpriteTex {
  const hit = packed.get(sprite);
  if (hit && scene.textures.exists(hit.key)) return hit;

  const h = sprite.length;
  const w = h > 0 ? sprite[0].length : 0;
  if (w <= 0 || h <= 0) return { key: '__WHITE' };

  hookFlush(scene);

  // Same pixels as something already packed? Then reuse that frame instead of
  // spending a second rectangle on it — see byContent for why this is what keeps
  // memory bounded rather than merely tidy.
  const { hash, rows } = contentKey(sprite, w, h);
  const known = byContent.get(hash);
  if (known && known.rows === rows && scene.textures.exists(known.tex.key)) {
    packed.set(sprite, known.tex);
    return known.tex;
  }

  let out: SpriteTex;
  if (w > PAGE - 2 * PAD || h > PAGE - 2 * PAD) {
    out = ownTexture(scene, sprite, w, h);
  } else {
    const at = reserve(scene, w, h);
    if (!at) {
      out = ownTexture(scene, sprite, w, h);
    } else {
      const frame = `f${frameCounter++}`;
      at.page.ctx.putImageData(toImageData(at.page.ctx, sprite, w, h), at.x, at.y);
      at.page.tex.add(frame, 0, at.x, at.y, w, h);
      at.page.dirty = true;
      out = { key: at.page.key, frame };
    }
  }
  packed.set(sprite, out);
  // Only real atlas frames are worth remembering by content: a fallback texture
  // is per-sprite by definition, and handing the same one to a second sprite
  // would be sharing a texture nobody can reason about.
  if (out.frame) byContent.set(hash, { rows, tex: out });
  return out;
}

/** How many atlas pages exist — shown in the perf overlay (F8). */
export function spriteAtlasPageCount(): number {
  return pages.length;
}

/** How many distinct pictures are packed — the number that must stay flat when
 *  the same art arrives again (a tileset saved in Tiled, an avatar re-broadcast).
 *  Shown in the perf overlay next to the page count. */
export function spriteAtlasFrameCount(): number {
  return byContent.size;
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


// ── Pre-baked sheets ─────────────────────────────────────────
//
// A baked floor or wall sheet is already an atlas: one PNG whose cells are laid
// out on a fixed grid (see tiledSheetLayout.ts). So it is registered as ONE
// texture and drawn from by frame, instead of being sliced into SpriteData and
// packed cell by cell — which is what the client used to do, turning 533 KB of
// PNG into 3.79 million hex-string entries (~34 MB) on the way to the GPU.
//
// Frames are defined on first use rather than up front: the two wall sets alone
// hold 6230 cells, of which a map draws a handful.

interface Sheet {
  key: string;
  tex: Phaser.Textures.CanvasTexture;
  /** The gap this sheet was baked with, as read off its .tsj (see sets.json).
   *  Taken from the artifact rather than a constant, so a re-baked sheet and this
   *  reader cannot drift apart. */
  spacing: number;
}

const sheets = new Map<string, Sheet>();

/** Register a fetched sheet bitmap as one texture. Called once per set, after
 *  client/src/net/tiledSheets.ts has fetched it. */
export function registerSheetTexture(scene: Phaser.Scene, name: string, bitmap: ImageBitmap, spacing: number): void {
  const existing = sheets.get(name);
  if (existing && scene.textures.exists(existing.key)) return;
  const key = `sheet_${name}`;
  if (scene.textures.exists(key)) scene.textures.remove(key);
  const tex = scene.textures.createCanvas(key, bitmap.width, bitmap.height);
  if (!tex) {
    console.warn(`[sprites] could not create a texture for sheet "${name}"`);
    return;
  }
  const ctx = tex.getContext();
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(bitmap, 0, 0);
  tex.refresh();
  sheets.set(name, { key, tex, spacing });
}

/**
 * The texture frame for a sheet cell, defined on demand.
 *
 * The rect mirrors bake-floor-wall-tiled.mts's own layout exactly — cell
 * (row, col) at `col * (w + spacing)`, `row * (h + spacing)` — which is the one
 * thing that must not drift: an off-by-one here paints every wall as its
 * neighbouring piece, and it still looks like a wall.
 */
export function sheetFrame(ref: SheetCellRef): SpriteTex | null {
  const sheet = sheets.get(ref.sheet);
  if (!sheet) return null;
  const isWall = ref.kind === 'wall';
  const w = isWall ? WALL_TILE_W : FLOOR_TILE_W;
  const h = isWall ? WALL_TILE_H : FLOOR_TILE_H;
  const gap = sheet.spacing;
  const frame = `${ref.row}_${ref.col}`;
  if (!sheet.tex.has(frame)) {
    const x = ref.col * (w + gap);
    const y = ref.row * (h + gap);
    if (x + w > sheet.tex.width || y + h > sheet.tex.height) return null;
    sheet.tex.add(frame, 0, x, y, w, h);
  }
  return { key: sheet.key, frame };
}


// ── The baked collection-art atlas ───────────────────────────
//
// Same idea as a sheet above, but the cells are not on a grid: furniture and decal
// art has mixed sizes, so the bake writes down where each id landed
// (server/scripts/bake-furniture-atlas.mts) and this draws from those rects.
//
// It is a FASTER PATH, never the only one. An id the atlas does not carry — art
// added since the bake, an avatar, a pose frame — still goes through
// spriteTexture() and gets packed at runtime, which is what makes it safe to ship
// the atlas before the catalog message stops carrying pixels.

interface AtlasFrames {
  key: string;
  tex: Phaser.Textures.CanvasTexture;
  rects: Record<string, { x: number; y: number; w: number; h: number }>;
}

let furnitureAtlas: AtlasFrames | null = null;

/**
 * id → which image and rect its art is, as the server told us (spriteRefs).
 *
 * This is what replaced being sent the pixels. The images themselves are fetched
 * lazily — the first time an id is actually drawn — because a map draws a fraction
 * of the catalog: 1763 entries today, of which a zone uses dozens. Fetching all
 * of them up front would trade one oversized message for a burst of requests
 * nobody needs.
 */
const refs = new Map<string, { img: string; x: number; y: number; w: number; h: number }>();
/** img path → texture key once fetched; null while in flight or failed. */
const refTextures = new Map<string, string | null>();
/**
 * Told when a ref image has arrived, so whoever draws can draw again.
 *
 * Not optional plumbing: an image is fetched the first time an id is drawn, and by
 * then that draw has already happened with nothing to show. Furniture re-syncs on
 * its own eventually, but statics (decals, floor, walls) are drawn once per layout
 * — without this they keep the placeholder for the rest of the session, which is
 * exactly what a run without a baked atlas showed: every tree a black box.
 */
let refImageListener: (() => void) | null = null;
export function onRefImageLoaded(listener: () => void): void {
  refImageListener = listener;
}

/** Take the id → image+rect table from the catalog message. */
export function setSpriteRefs(
  table: Record<string, { img: string; x: number; y: number; w: number; h: number }> | undefined,
): void {
  refs.clear();
  for (const [id, r] of Object.entries(table ?? {})) refs.set(id, r);
}

/** The frame for a ref, fetching its image on first use. Returns null until the
 *  image is there, so the caller falls back to whatever it has meanwhile — one or
 *  two frames of the runtime-packed sprite, or nothing at all. */
function refFrame(scene: Phaser.Scene, id: string): SpriteTex | null {
  const ref = refs.get(id);
  if (!ref) return null;
  const known = refTextures.get(ref.img);
  if (known === undefined) {
    refTextures.set(ref.img, null);
    void (async () => {
      try {
        const url = `${serverHttpOrigin()}/assets/tiled/${ref.img}`;
        const res = await fetch(url);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const bitmap = await createImageBitmap(await res.blob());
        const key = `ref_${ref.img.replace(/[^a-zA-Z0-9]/g, '_')}`;
        if (!scene.textures.exists(key)) {
          const tex = scene.textures.createCanvas(key, bitmap.width, bitmap.height);
          if (!tex) throw new Error('no canvas texture');
          const ctx = tex.getContext();
          ctx.imageSmoothingEnabled = false;
          ctx.drawImage(bitmap, 0, 0);
          tex.refresh();
        }
        refTextures.set(ref.img, key);
        refImageListener?.();
      } catch (err) {
        console.warn(`[sprites] could not load ${ref.img}: ${err instanceof Error ? err.message : err}`);
        refTextures.set(ref.img, null);
      }
    })();
    return null;
  }
  if (known === null) return null;
  const tex = scene.textures.get(known) as Phaser.Textures.CanvasTexture;
  const frame = `${ref.x}_${ref.y}_${ref.w}_${ref.h}`;
  if (!tex.has(frame)) tex.add(frame, 0, ref.x, ref.y, ref.w, ref.h);
  return { key: known, frame };
}

/** Keep the fetched atlas as one texture. Frames are defined on first use, since
 *  a map draws a fraction of the catalog. */
export function registerFurnitureAtlas(
  scene: Phaser.Scene,
  bitmap: ImageBitmap,
  rects: Record<string, { x: number; y: number; w: number; h: number }>,
): void {
  const key = 'atlas_furniture';
  if (scene.textures.exists(key)) scene.textures.remove(key);
  const tex = scene.textures.createCanvas(key, bitmap.width, bitmap.height);
  if (!tex) {
    console.warn('[sprites] could not create the furniture atlas texture');
    return;
  }
  const ctx = tex.getContext();
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(bitmap, 0, 0);
  tex.refresh();
  furnitureAtlas = { key, tex, rects };
}

/** Where a catalog id is drawn from in the atlas, or null if it is not in it. */
export function atlasFrame(id: string | undefined): SpriteTex | null {
  if (!id || !furnitureAtlas) return null;
  const rect = furnitureAtlas.rects[id];
  if (!rect) return null;
  if (!furnitureAtlas.tex.has(id)) furnitureAtlas.tex.add(id, 0, rect.x, rect.y, rect.w, rect.h);
  return { key: furnitureAtlas.key, frame: id };
}

/** Ids whose atlas rect does not match the art the catalog has, so the atlas is
 *  stale for them — warned once each, then permanently ignored. */
const staleInAtlas = new Set<string>();

/**
 * The frame to draw a catalog item from: the baked atlas if it has this id and
 * agrees with it, else the runtime-packed SpriteData.
 *
 * One place decides that, so no caller has to remember the order — and once the
 * catalog message stops carrying pixels, the fallback is what keeps everything
 * that is not baked (avatars, live-edited art) working.
 *
 * The size comparison is the interesting part. A stale atlas whose OVERALL
 * dimensions still match the manifest (checked at load) would otherwise draw
 * yesterday's art with complete confidence — the failure this whole path is most
 * likely to produce and least likely to be noticed, since old furniture still
 * looks like furniture. While the message still carries the real pixels we can
 * simply ask them: a mismatch in size means this id was re-drawn since the bake,
 * so it goes through the runtime packer instead and says so once.
 */
export function spriteTextureFor(scene: Phaser.Scene, id: string | undefined, sprite?: SpriteData): SpriteTex {
  if (id && furnitureAtlas && !staleInAtlas.has(id)) {
    const rect = furnitureAtlas.rects[id];
    // Only comparable while the message still carries the pixels; once it stops,
    // there is nothing to compare against and the rect is simply trusted.
    const h = sprite?.length ?? 0;
    const w = h > 0 ? sprite![0].length : 0;
    if (rect && sprite && (rect.w !== w || rect.h !== h)) {
      staleInAtlas.add(id);
      console.warn(
        `[sprites] "${id}" is ${w}×${h} but the atlas has ${rect.w}×${rect.h} — re-run bake-furniture-atlas.mts; ` +
          'drawing it from the catalog for now',
      );
    } else if (rect) {
      return atlasFrame(id)!;
    }
  }
  const viaRef = refFrame(scene, id ?? '');
  if (viaRef) return viaRef;
  if (!sprite) {
    // No image for this id and no pixels either: draw nothing rather than a
    // placeholder, the same silence a missing image asset gets. Warned once so it
    // is findable — this means an id reached the renderer that no bake and no
    // message covers.
    if (id && !missingArt.has(id)) {
      missingArt.add(id);
      console.warn(`[sprites] no art for "${id}" — neither a fetched image nor pixels in the catalog`);
    }
    return { key: '__MISSING' };
  }
  return spriteTexture(scene, sprite);
}

/** Ids reported as having no art at all — warned once each. */
const missingArt = new Set<string>();
