#!/usr/bin/env node
/**
 * One-time migration: assets/furniture/<TYPE>/manifest.json (44 folders) →
 * assets/tiled/furniture-<category>.tsj (one Tiled "Collection of Images"
 * tileset per category), with PNGs copied into assets/tiled/png/furniture/.
 *
 * See docs/design/tiled-editor-integration.md. Not part of the runtime —
 * run once (`node scripts/migrate-furniture-to-tiled.mjs`), inspect the
 * result, then the old assets/furniture/ tree can be deleted once the new
 * server-side loader (loadFurnitureTilesets) is verified.
 *
 * Rotation groups are NOT reconstructed (dropped per task #150) — each
 * orientation member becomes its own independent tile. State pairs (on/off)
 * and animation groups ARE preserved: state pairs via a shared `stateGroup`
 * custom property, animations via Tiled's own native per-tile <animation>.
 */
import { readFileSync, readdirSync, existsSync, mkdirSync, writeFileSync, copyFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname;
const FURNITURE_DIR = join(ROOT, 'assets', 'furniture');
const OUT_TILED_DIR = join(ROOT, 'assets', 'tiled');
const OUT_PNG_DIR = join(OUT_TILED_DIR, 'png', 'furniture');
const TILE_SIZE = 16;

// Filenames deliberately differ from the raw category value for "wall" —
// avoids clashing with the wall-0.tsj/wall-1.tsj AUTOTILE tilesets task #156
// will add (those are wall TILES, this is wall-mounted FURNITURE).
const CATEGORY_FILE_SLUG = {
  desks: 'desks',
  chairs: 'chairs',
  storage: 'storage',
  electronics: 'electronics',
  decor: 'decor',
  wall: 'wallmount',
  kitchens: 'kitchens',
  misc: 'misc',
};

function footprintOf(px) {
  return Math.min(16, Math.max(1, Math.round(px / TILE_SIZE)));
}

/** Recursively walk a manifest node, collecting leaf assets with every
 *  inherited property resolved — mirrors server/src/core/assets/manifestUtils.ts's
 *  flattenManifest, but for tile descriptors instead of FurnitureAsset[], and
 *  tracks animation siblings (by shared parent) instead of a flat animationGroup id.
 *  Each group node contributes to `inherited` exactly ONCE (not per-member —
 *  an easy bug here would re-walk an animation group's members once per sibling). */
function walk(node, inherited, out) {
  if (node.type === 'asset') {
    out.push({
      id: node.id,
      label: inherited.name,
      category: inherited.category,
      file: node.file,
      width: node.width,
      height: node.height,
      backgroundTiles: inherited.backgroundTiles || 0,
      occupiesSurface: !!inherited.canPlaceOnSurfaces,
      appliance: inherited.appliance,
      mirrorSide: !!node.mirrorSide,
      orientation: node.orientation || inherited.orientation,
      stateGroup: inherited.stateGroup,
      state: node.state || inherited.state,
      onTrigger: inherited.onTrigger,
      // Frame position + sibling list within one animation group (undefined
      // outside a groupType:'animation' node) — resolved into a native Tiled
      // <animation> array once all tiles have numeric ids assigned.
      animFrame: inherited.animFrame,
      animSiblings: inherited.animSiblings,
      animDurationMs: node.duration,
    });
    return;
  }

  const groupInherited = { ...inherited };
  if (node.groupType === 'state') {
    if (node.orientation) groupInherited.orientation = node.orientation;
    if (node.onTrigger) groupInherited.onTrigger = node.onTrigger;
    // A stable id for this specific on/off pair — root manifest name + the
    // state group's own orientation tag (front/back/... or '' if none).
    groupInherited.stateGroup = `${inherited.name.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}_${node.orientation || inherited.orientation || 'STATE'}`;
  }
  if (node.groupType === 'animation') {
    if (node.state) groupInherited.state = node.state;
    // Sorted by declared `frame` index; each leaf gets its position + the
    // full sibling list so walk() can stamp animFrame/animSiblings.
    const leaves = node.members.filter((m) => m.type === 'asset').sort((a, b) => (a.frame ?? 0) - (b.frame ?? 0));
    for (const leaf of leaves) {
      walk(leaf, { ...groupInherited, animFrame: leaf.frame ?? 0, animSiblings: leaves }, out);
    }
    return;
  }
  for (const member of node.members) walk(member, groupInherited, out);
}

function collectManifestTiles() {
  const dirs = readdirSync(FURNITURE_DIR, { withFileTypes: true }).filter((e) => e.isDirectory());
  const tiles = [];
  for (const dir of dirs) {
    const manifestPath = join(FURNITURE_DIR, dir.name, 'manifest.json');
    if (!existsSync(manifestPath)) continue;
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8'));
    const inherited = {
      name: manifest.name,
      category: manifest.category,
      canPlaceOnSurfaces: manifest.canPlaceOnSurfaces,
      backgroundTiles: manifest.backgroundTiles,
      appliance: manifest.appliance,
    };
    const leaves = [];
    if (manifest.type === 'asset') {
      walk({ type: 'asset', id: manifest.id, file: manifest.file ?? `${manifest.id}.png`, width: manifest.width, height: manifest.height }, inherited, leaves);
    } else {
      walk({ type: 'group', groupType: manifest.groupType, members: manifest.members }, inherited, leaves);
    }
    for (const leaf of leaves) tiles.push({ ...leaf, sourceDir: dir.name });
  }
  return tiles;
}

function buildTileset(category, tiles, slug) {
  // Assign numeric local ids in stable (id-sorted) order first, so
  // animation-frame tileid references can resolve to real ids.
  const sorted = [...tiles].sort((a, b) => a.id.localeCompare(b.id));
  const idOf = new Map(sorted.map((t, i) => [t.id, i]));

  const tsjTiles = sorted.map((t, i) => {
    const props = [{ name: 'type', type: 'string', value: t.id }];
    if (t.label) props.push({ name: 'label', type: 'string', value: t.label });
    if (t.backgroundTiles) props.push({ name: 'backgroundTiles', type: 'int', value: t.backgroundTiles });
    if (t.occupiesSurface) props.push({ name: 'occupiesSurface', type: 'bool', value: true });
    if (t.mirrorSide) props.push({ name: 'mirrorSide', type: 'bool', value: true });
    if (t.orientation) props.push({ name: 'orientation', type: 'string', value: t.orientation });
    if (t.stateGroup) props.push({ name: 'stateGroup', type: 'string', value: t.stateGroup });
    if (t.state) props.push({ name: 'state', type: 'string', value: t.state });
    if (t.onTrigger) props.push({ name: 'onTrigger', type: 'string', value: t.onTrigger });
    if (t.appliance) props.push({ name: 'appliance', type: 'string', value: t.appliance });

    const tile = {
      id: i,
      image: `png/furniture/${slug}/${t.id}.png`,
      imagewidth: t.width,
      imageheight: t.height,
      properties: props,
    };
    // Only the first frame of an animation group carries the native
    // <animation> block — later frames are ordinary tiles, only reachable
    // through it (see shared/src/office/layout/furnitureCatalog.ts's
    // nonFirstFrameIds filtering, unchanged by this migration).
    if (t.animSiblings && t.animFrame === 0) {
      tile.animation = t.animSiblings.map((s) => ({
        tileid: idOf.get(s.id),
        duration: s.duration ?? 200,
      }));
    }
    return tile;
  });

  return {
    columns: 0,
    name: `furniture-${slug}`,
    tilecount: tsjTiles.length,
    tiledversion: '1.11.0',
    tileheight: TILE_SIZE,
    tilewidth: TILE_SIZE,
    tiles: tsjTiles,
    type: 'tileset',
    version: '1.10',
  };
}

function main() {
  const tiles = collectManifestTiles();
  const byCategory = new Map();
  for (const t of tiles) {
    if (!byCategory.has(t.category)) byCategory.set(t.category, []);
    byCategory.get(t.category).push(t);
  }

  mkdirSync(OUT_TILED_DIR, { recursive: true });
  let totalTiles = 0;
  let totalPngs = 0;
  for (const [category, catTiles] of byCategory) {
    const slug = CATEGORY_FILE_SLUG[category] ?? category;
    const tileset = buildTileset(category, catTiles, slug);
    const outFile = join(OUT_TILED_DIR, `furniture-${slug}.tsj`);
    writeFileSync(outFile, JSON.stringify(tileset, null, 2) + '\n');

    const pngDir = join(OUT_PNG_DIR, slug);
    mkdirSync(pngDir, { recursive: true });
    for (const t of catTiles) {
      const src = join(FURNITURE_DIR, t.sourceDir, t.file);
      const dest = join(pngDir, `${t.id}.png`);
      copyFileSync(src, dest);
      totalPngs++;
    }
    totalTiles += catTiles.length;
    console.log(`✓ ${outFile} (${catTiles.length} tiles) + ${pngDir}/`);
  }
  console.log(`\nDone: ${totalTiles} tiles, ${totalPngs} PNGs across ${byCategory.size} categories.`);
}

main();
