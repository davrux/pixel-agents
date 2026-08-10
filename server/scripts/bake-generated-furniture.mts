#!/usr/bin/env -S node --import tsx
/**
 * Bake the server-generated, code-drawn furniture (portals, conference
 * monitor, arcade cabinet, meeting-room kiosk, wall logos — never backed by
 * a PNG on disk, see assets.ts's `generated` array) into real Tiled tiles,
 * appended to the existing category tilesets (furniture-decor.tsj /
 * furniture-wallmount.tsj, matching each item's own catalog `category`).
 * Without this, these types have no Tiled GID at all and the map bridge
 * exports them as blank placeholder rectangles — correct but not a useful
 * reference for "how do I use the arcade cabinet / an ad-hoc meeting kiosk".
 *
 * Run (from server/): node --import tsx scripts/bake-generated-furniture.mts
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { PNG } from 'pngjs';

import { portalAssets } from '../src/portalAssets.js';
import { conferenceAssets } from '../src/conferenceAssets.js';
import { arcadeAssets } from '../src/arcadeAssets.js';
import { meetingRoomAssets } from '../src/meetingRoomAssets.js';
import { logoAssets } from '../src/logoAssets.js';
import type { SpriteData } from '../../shared/src/office/types.js';

const ROOT = path.resolve(import.meta.dirname, '..', '..');
const TILED_DIR = path.join(ROOT, 'assets', 'tiled');
const TILE_SIZE = 16;

function spriteToPngBuffer(sprite: SpriteData, w: number, h: number): Buffer {
  const png = new PNG({ width: w, height: h });
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const px = sprite[y]?.[x] ?? '';
      const i = (y * w + x) * 4;
      if (!px) {
        png.data[i] = png.data[i + 1] = png.data[i + 2] = png.data[i + 3] = 0;
        continue;
      }
      png.data[i] = parseInt(px.slice(1, 3), 16);
      png.data[i + 1] = parseInt(px.slice(3, 5), 16);
      png.data[i + 2] = parseInt(px.slice(5, 7), 16);
      png.data[i + 3] = px.length > 7 ? parseInt(px.slice(7, 9), 16) : 255;
    }
  }
  return PNG.sync.write(png);
}

interface GeneratedItem {
  id: string;
  label: string;
  category: string;
  width: number;
  height: number;
  sprite: SpriteData;
}

function collect(): GeneratedItem[] {
  const groups = [...portalAssets(), ...conferenceAssets(), ...arcadeAssets(), ...meetingRoomAssets(), ...logoAssets()];
  return groups.map((g) => {
    const e = g.entry as Record<string, unknown>;
    return {
      id: e.id as string,
      label: (e.label as string) ?? (e.id as string),
      category: e.category as string,
      width: e.width as number,
      height: e.height as number,
      sprite: g.sprite,
    };
  });
}

function appendToTileset(slug: string, items: GeneratedItem[]): void {
  const tsjPath = path.join(TILED_DIR, `furniture-${slug}.tsj`);
  const json = JSON.parse(fs.readFileSync(tsjPath, 'utf-8'));
  const pngDir = path.join(TILED_DIR, 'png', 'furniture', slug);
  fs.mkdirSync(pngDir, { recursive: true });

  for (const item of items) {
    const localId = json.tilecount;
    fs.writeFileSync(path.join(pngDir, `${item.id}.png`), spriteToPngBuffer(item.sprite, item.width, item.height));
    json.tiles.push({
      id: localId,
      image: `png/furniture/${slug}/${item.id}.png`,
      imagewidth: item.width,
      imageheight: item.height,
      properties: [
        { name: 'type', type: 'string', value: item.id },
        { name: 'label', type: 'string', value: item.label },
        { name: 'backgroundTiles', type: 'int', value: 0 },
        { name: 'occupiesSurface', type: 'bool', value: false },
        { name: 'mirrorSide', type: 'bool', value: false },
        { name: 'orientation', type: 'string', value: '' },
        { name: 'stateGroup', type: 'string', value: '' },
        { name: 'state', type: 'string', value: '' },
        { name: 'onTrigger', type: 'string', value: '' },
        { name: 'appliance', type: 'string', value: '' },
        // Not authored by hand like the migrated 44 — flags this tile as
        // server-generated code (see assets.ts's `generated` array), so a
        // future re-bake knows it can safely overwrite/regenerate these
        // specific ids rather than treating them as hand-edited content.
        { name: 'generated', type: 'bool', value: true },
      ],
    });
    json.tilecount++;
  }
  fs.writeFileSync(tsjPath, JSON.stringify(json, null, 2) + '\n');
  console.log(`✓ ${tsjPath} +${items.length} tiles (tilecount now ${json.tilecount})`);
}

const all = collect();
const byCategory = new Map<string, GeneratedItem[]>();
for (const item of all) {
  if (!byCategory.has(item.category)) byCategory.set(item.category, []);
  byCategory.get(item.category)!.push(item);
}

const CATEGORY_SLUG: Record<string, string> = { decor: 'decor', wall: 'wallmount' };
for (const [category, items] of byCategory) {
  const slug = CATEGORY_SLUG[category];
  if (!slug) {
    console.warn(`No tileset slug for category "${category}" — skipping ${items.map((i) => i.id).join(', ')}`);
    continue;
  }
  appendToTileset(slug, items);
}
