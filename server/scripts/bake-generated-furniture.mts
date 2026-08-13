#!/usr/bin/env -S node --import tsx
/**
 * Bake the server-generated, code-drawn furniture (portals, conference
 * monitor, arcade cabinet, meeting-room kiosk, wall logos — never backed by
 * a PNG on disk, see assets.ts's `generated` array) into real Tiled tiles,
 * appended to furniture-decor.tsj (one destination — these are a handful of
 * fixtures, not a browsable collection, and furniture tilesets carry no
 * taxonomy of their own since a tile's behaviour is stated on the tile).
 * Without this, these types have no Tiled GID at all and the map bridge
 * exports them as blank placeholder rectangles — correct but not a useful
 * reference for "how do I use the arcade cabinet / an ad-hoc meeting kiosk".
 *
 * Run (from server/): node --import tsx scripts/bake-generated-furniture.mts
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

import { FURNITURE_TILE_PROPS } from '../src/tiled/furnitureProps.js';
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
      // Assigns this tile to Pixels.tiled-project's FurnitureTile class —
      // without it, the properties below are just loose values with no
      // class membership (see docs/design/tiled-editor-integration.md).
      type: 'FurnitureTile',
      image: `png/furniture/${slug}/${item.id}.png`,
      imagewidth: item.width,
      imageheight: item.height,
      properties: [
        { name: 'id', type: 'string', value: item.id },
        // The whole behaviour set, defaults included — the same shape
        // sync-furniture-properties.mts keeps every other tile in, so a
        // re-bake doesn't produce the one tile that's missing half its
        // properties. Real values come from assets.ts's `generated` array,
        // which is the runtime catalog for these ids; these tiles exist so the
        // map bridge has a GID to draw.
        ...FURNITURE_TILE_PROPS.map((spec) => ({
          name: spec.name,
          type: typeof spec.default === 'boolean' ? 'bool' : typeof spec.default === 'number' ? 'int' : 'string',
          value: spec.name === 'label' ? item.label : spec.default,
          ...(spec.propertyType ? { propertytype: spec.propertyType } : {}),
        })),
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

appendToTileset('decor', collect());
