/**
 * Bakes a Tiled "Collection of Images" tileset (assets/tiled/furniture-tileset.tsx
 * + assets/tiled/furniture/<id>.png) from the live furniture catalog — the same
 * catalog SimRoom builds at boot (buildDynamicCatalog), so every rotation-group
 * orientation, on/off state pair, and animation frame that's a real placeable
 * type gets its own tile, pixel-identical to what's placed in-game.
 *
 * Unlike floor/wall tiles (uniform 16x16 / 16x32, packed into one sprite
 * sheet), furniture sprites vary in size (footprintW/H × 16px, no two items
 * necessarily alike) — a "collection" tileset is Tiled's own answer to that:
 * each tile is its own separate image file instead of a slice of one sheet.
 *
 * Mirrored ("left") variants are deliberately NOT baked as separate tiles —
 * Tiled's own per-object horizontal-flip flag covers that for free; baking a
 * second image for every mirrorSide asset would only double the tile count
 * for zero benefit.
 *
 * Regenerate whenever furniture assets or manifests change:
 *   pnpm --filter @pixel/server run generate:tiled-furniture
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PNG } from 'pngjs';

import { loadAssetBundle } from '../assets.js';
import { buildDynamicCatalog, getCatalogEntry } from '@pixel/shared/office/layout/furnitureCatalog.js';
import type { SpriteData } from '@pixel/shared/office/types.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '../../..');
const ASSETS_DIR = path.join(REPO_ROOT, 'assets');
const OUT_DIR = path.join(ASSETS_DIR, 'tiled');
const IMAGES_DIR = path.join(OUT_DIR, 'furniture');

/** Write one sprite as its own PNG file, sized to its actual pixel dimensions
 *  (not assumed from footprint — see office/tiled-schema notes: nothing
 *  enforces sprite === footprint*16, even though every current asset happens
 *  to match). */
function writeSpritePng(filePath: string, sprite: SpriteData): { width: number; height: number } {
  const height = sprite.length;
  const width = sprite[0]?.length ?? 0;
  const png = new PNG({ width: Math.max(width, 1), height: Math.max(height, 1) });
  for (let y = 0; y < height; y++) {
    const row = sprite[y];
    for (let x = 0; x < width; x++) {
      const pixel = row[x] ?? '';
      const di = (y * width + x) * 4;
      if (!pixel) {
        png.data[di + 3] = 0;
        continue;
      }
      png.data[di] = parseInt(pixel.slice(1, 3), 16);
      png.data[di + 1] = parseInt(pixel.slice(3, 5), 16);
      png.data[di + 2] = parseInt(pixel.slice(5, 7), 16);
      png.data[di + 3] = pixel.length > 7 ? parseInt(pixel.slice(7, 9), 16) : 255;
    }
  }
  fs.writeFileSync(filePath, PNG.sync.write(png));
  return { width, height };
}

function escapeXmlAttr(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

async function main(): Promise<void> {
  const bundle = await loadAssetBundle();
  buildDynamicCatalog({
    catalog: bundle.raw.furnitureCatalog as never,
    sprites: bundle.raw.furnitureSprites as never,
  });

  const ids = [...new Set((bundle.raw.furnitureCatalog as Array<{ id: string }>).map((a) => a.id))];

  fs.mkdirSync(IMAGES_DIR, { recursive: true });
  const tileEntries: string[] = [];
  let gid = 0;
  let skipped = 0;

  for (const id of ids) {
    const entry = getCatalogEntry(id);
    if (!entry || entry.sprite.length === 0 || (entry.sprite[0]?.length ?? 0) === 0) {
      skipped++;
      continue;
    }
    const fileName = `${id}.png`;
    const { width, height } = writeSpritePng(path.join(IMAGES_DIR, fileName), entry.sprite);
    const props = [
      `      <property name="type" type="string" value="${escapeXmlAttr(id)}"/>`,
      `      <property name="label" type="string" value="${escapeXmlAttr(entry.label)}"/>`,
      `      <property name="footprintW" type="int" value="${entry.footprintW}"/>`,
      `      <property name="footprintH" type="int" value="${entry.footprintH}"/>`,
    ].join('\n');
    tileEntries.push(
      `  <tile id="${gid}">\n` +
        `    <image source="furniture/${fileName}" width="${width}" height="${height}"/>\n` +
        `    <properties>\n${props}\n    </properties>\n` +
        `  </tile>`,
    );
    gid++;
  }

  const tsx = `<?xml version="1.0" encoding="UTF-8"?>
<tileset version="1.10" tiledversion="1.11.0" name="Furniture" tilewidth="16" tileheight="16" tilecount="${gid}" columns="0">
${tileEntries.join('\n')}
</tileset>
`;
  fs.writeFileSync(path.join(OUT_DIR, 'furniture-tileset.tsx'), tsx);
  console.log(`[tiled] furniture-tileset.tsx: ${gid} tiles (${skipped} skipped — bad id or empty sprite)`);
  console.log(`[tiled] done -> ${path.relative(REPO_ROOT, OUT_DIR)}`);
}

void main();
