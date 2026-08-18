/**
 * Pack every collection-of-images tile — furniture and decals — into ONE atlas
 * PNG plus a manifest saying where each id sits, and keep that artifact current.
 *
 * Why an atlas at all: those pixels used to reach the client as SpriteData inside
 * the `furnitureAssetsLoaded` message, re-sent on every join. Art that never
 * changes belongs on HTTP, fetched once and revalidated with an ETag — the route
 * floor and wall sheets already take. One image also means one texture in the
 * client instead of hundreds, which is what keeps draw calls batched.
 *
 * Why this is a MODULE and not only a script: the atlas is derived from the
 * tilesets, and a derived artifact you have to remember to rebuild is one you
 * will eventually forget — it happened here, and the client then quietly fell
 * back to fetching single files, so the delivery format depended on whether
 * somebody had run a script. The server now bakes it itself when the sources have
 * changed (see ensureFurnitureAtlas), at startup and on a tileset save, so
 * "atlas or single files" is not a question anyone has to answer.
 *
 * Which tiles: whatever the loader would take, asked the same way — a tileset
 * holds furniture or decals if its TILES say so (isFurnitureTileset /
 * isDecalTileset), never because of its filename. A grid tileset (one image for
 * the whole set, e.g. decal-roads) is already an atlas and stays one.
 *
 * Layout: shelf packing, 2 px between cells, each cell's border extruded 1 px into
 * that gap. The extrusion is not optional — a decal can be full-bleed ground art,
 * and a frame whose neighbour touches it bleeds a stripe at fractional zoom, the
 * exact seam the floor sheets had to be re-baked for. Order is deterministic
 * (tallest first, then by id), so a re-run with unchanged art produces a
 * byte-identical file and no git churn.
 */
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { PNG } from 'pngjs';

import { isDecalTileset, isFurnitureTileset } from './tiledRegistry.js';

/** Both relative to assets/tiled, like a tileset's own `image`. They live under
 *  png/baked/ because that folder means "a script owns these files" — the source
 *  art is under png/src/ and is never written here. */
export const ATLAS_PNG_REL = 'png/baked/atlas-furniture.png';
export const ATLAS_MANIFEST_REL = 'png/baked/atlas-furniture.json';

/** Same numbers as the floor sheets, for the same reason — see FLOOR_TILE_SPACING. */
const GAP = 2;
const EXTRUDE = 1;
/** Atlas width. Height grows with the art; nothing here is close to a texture-size
 *  limit, and a fixed width keeps the packing (and therefore the file) stable. */
const WIDTH = 1024;
/** Bumped when the packing itself changes, so an atlas baked by an older version
 *  counts as stale even though its sources are untouched. */
const LAYOUT_VERSION = 1;

interface Source {
  id: string;
  /** Path relative to assets/tiled. */
  file: string;
}

/** Every collection tile that belongs in the atlas, in a deterministic order. */
function collectSources(tiledDir: string): Source[] {
  const out: Source[] = [];
  const seen = new Set<string>();
  for (const file of fs.readdirSync(tiledDir).filter((f) => f.endsWith('.tsj')).sort()) {
    const json = JSON.parse(fs.readFileSync(path.join(tiledDir, file), 'utf-8')) as {
      image?: string;
      tiles?: Array<{ type?: string; image?: string; properties?: Array<{ name: string; value: string | number | boolean }> }>;
    };
    if (!isFurnitureTileset(json) && !isDecalTileset(json)) continue;
    if (json.image) continue; // a grid set is already one image
    for (const tile of json.tiles ?? []) {
      const id = tile.properties?.find((p) => p.name === 'id')?.value;
      if (typeof id !== 'string' || !id || !tile.image) continue;
      if (seen.has(id)) continue; // an animation's frames are separate ids; duplicates are not
      seen.add(id);
      out.push({ id, file: tile.image });
    }
  }
  return out;
}

/**
 * A fingerprint of everything the bake reads: ids, paths and file CONTENT.
 *
 * Content and not mtime on purpose — a fresh checkout gives every file a new
 * mtime, so an mtime key would make each clone re-bake and rewrite the manifest,
 * which is git churn for no change at all. Hashing ~1.5 MB takes a few
 * milliseconds and is only done at startup or on a tileset save.
 */
function sourceKey(tiledDir: string, sources: Source[]): string {
  const h = crypto.createHash('sha256');
  h.update(`v${LAYOUT_VERSION}|${WIDTH}|${GAP}|${EXTRUDE}`);
  for (const s of sources) {
    h.update(`\0${s.id}\0${s.file}\0`);
    const abs = path.join(tiledDir, s.file);
    if (fs.existsSync(abs)) h.update(fs.readFileSync(abs));
    else h.update('missing');
  }
  return h.digest('hex').slice(0, 32);
}

export interface AtlasManifest {
  image: string;
  width: number;
  height: number;
  gap: number;
  extrude: number;
  /** What the art was when this was baked — see sourceKey. */
  sourceKey?: string;
  frames: Record<string, { x: number; y: number; w: number; h: number }>;
}

export interface BakeResult {
  frames: number;
  width: number;
  height: number;
  bytes: number;
  /** Sum of the source files, for the log line. */
  sourceBytes: number;
  wrote: boolean;
  skipped: string[];
}

/** Pack the atlas and (unless dryRun) write both files. */
export function bakeFurnitureAtlas(tiledDir: string, opts: { dryRun?: boolean } = {}): BakeResult {
  const sources = collectSources(tiledDir);
  const skipped: string[] = [];
  const items: Array<Source & { png: PNG }> = [];
  for (const s of sources) {
    const abs = path.join(tiledDir, s.file);
    if (!fs.existsSync(abs)) {
      skipped.push(`${s.id}: ${s.file} missing`);
      continue;
    }
    items.push({ ...s, png: PNG.sync.read(fs.readFileSync(abs)) });
  }
  if (items.length === 0) throw new Error('no collection tiles found — is assets/tiled populated?');

  // Tallest first packs shelves tightly; the id breaks ties so the order — and
  // thus the output bytes — never depend on directory order.
  items.sort((a, b) => b.png.height - a.png.height || a.id.localeCompare(b.id));

  const placed: Array<(typeof items)[number] & { x: number; y: number }> = [];
  let cx = EXTRUDE;
  let cy = EXTRUDE;
  let shelfH = 0;
  for (const item of items) {
    if (cx + item.png.width + EXTRUDE > WIDTH) {
      cx = EXTRUDE;
      cy += shelfH + GAP;
      shelfH = 0;
    }
    placed.push({ ...item, x: cx, y: cy });
    cx += item.png.width + GAP;
    if (item.png.height > shelfH) shelfH = item.png.height;
  }
  const height = cy + shelfH + EXTRUDE;

  const atlas = new PNG({ width: WIDTH, height });
  atlas.data.fill(0);
  for (const { png, x, y } of placed) {
    const w = png.width;
    const h = png.height;
    PNG.bitblt(png, atlas, 0, 0, w, h, x, y);
    // The one-pixel skirt: edges, then corners. Same as the sheet bake — a sample
    // one texel outside the frame has to land on this cell's own colour.
    PNG.bitblt(png, atlas, 0, 0, 1, h, x - 1, y);
    PNG.bitblt(png, atlas, w - 1, 0, 1, h, x + w, y);
    PNG.bitblt(png, atlas, 0, 0, w, 1, x, y - 1);
    PNG.bitblt(png, atlas, 0, h - 1, w, 1, x, y + h);
    PNG.bitblt(png, atlas, 0, 0, 1, 1, x - 1, y - 1);
    PNG.bitblt(png, atlas, w - 1, 0, 1, 1, x + w, y - 1);
    PNG.bitblt(png, atlas, 0, h - 1, 1, 1, x - 1, y + h);
    PNG.bitblt(png, atlas, w - 1, h - 1, 1, 1, x + w, y + h);
  }

  const manifest: AtlasManifest = {
    image: ATLAS_PNG_REL,
    width: WIDTH,
    height,
    // Recorded rather than assumed, so a reader never takes the layout on faith —
    // the same reason a sheet's `spacing` travels in sets.json.
    gap: GAP,
    extrude: EXTRUDE,
    sourceKey: sourceKey(tiledDir, sources),
    frames: Object.fromEntries(
      [...placed].sort((a, b) => a.id.localeCompare(b.id)).map((p) => [p.id, { x: p.x, y: p.y, w: p.png.width, h: p.png.height }]),
    ),
  };

  const bytes = PNG.sync.write(atlas);
  const sourceBytes = placed.reduce((n, p) => n + fs.statSync(path.join(tiledDir, p.file)).size, 0);
  if (!opts.dryRun) {
    fs.mkdirSync(path.dirname(path.join(tiledDir, ATLAS_PNG_REL)), { recursive: true });
    fs.writeFileSync(path.join(tiledDir, ATLAS_PNG_REL), bytes);
    fs.writeFileSync(path.join(tiledDir, ATLAS_MANIFEST_REL), `${JSON.stringify(manifest, null, 2)}\n`);
  }
  return { frames: placed.length, width: WIDTH, height, bytes: bytes.length, sourceBytes, wrote: !opts.dryRun, skipped };
}

/**
 * Bake only if the art has changed since the last bake — the call the server
 * makes at startup and whenever a tileset is saved.
 *
 * Never throws: a world with a stale atlas still runs (ids the manifest lacks
 * fall back to their own file), so a bake failure is a warning, not a boot
 * failure. Returns what happened, for the caller to log.
 */
export function ensureFurnitureAtlas(assetsRoot: string): { baked: boolean; reason: string } {
  const tiledDir = path.join(assetsRoot, 'assets', 'tiled');
  try {
    if (!fs.existsSync(tiledDir)) return { baked: false, reason: 'no assets/tiled directory' };
    const sources = collectSources(tiledDir);
    if (sources.length === 0) return { baked: false, reason: 'no collection tiles' };
    const key = sourceKey(tiledDir, sources);
    const manifestPath = path.join(tiledDir, ATLAS_MANIFEST_REL);
    if (fs.existsSync(manifestPath) && fs.existsSync(path.join(tiledDir, ATLAS_PNG_REL))) {
      const current = JSON.parse(fs.readFileSync(manifestPath, 'utf-8')) as AtlasManifest;
      if (current?.sourceKey === key) return { baked: false, reason: `current (${sources.length} tiles)` };
    }
    const r = bakeFurnitureAtlas(tiledDir);
    return {
      baked: true,
      reason: `${r.frames} tiles → ${r.width}×${r.height}, ${(r.bytes / 1024).toFixed(0)} KB` + (r.skipped.length ? `, ${r.skipped.length} skipped` : ''),
    };
  } catch (err) {
    return { baked: false, reason: `bake failed: ${(err as Error)?.message}` };
  }
}
