/**
 * Reads the three tileset files generateTiledTilesets.ts / generateTiledFurnitureTileset.ts
 * already baked (assets/tiled/floor-tileset.tsx, wall-0-tileset.tsx,
 * furniture-tileset.tsx) and works out the global-gid ranges + furniture
 * type<->local-id lookups a .tmj map needs to reference them.
 *
 * Deliberately re-parses the generated .tsx files rather than recomputing
 * from the live catalog/palette — they're the actual source of truth for
 * what's really in each tileset (tile count, furniture enumeration order),
 * so export/import never drifts from what a mapmaker's Tiled install sees.
 */
import fs from 'node:fs';
import path from 'node:path';

export interface TilesetInfo {
  /** Tiled's global gid space: [firstGid, firstGid+tileCount) for each tileset. */
  floor: { firstGid: number; tileCount: number; source: string };
  wall: { firstGid: number; tileCount: number; source: string };
  furniture: {
    firstGid: number;
    tileCount: number;
    source: string;
    typeToLocalId: Map<string, number>;
    localIdToType: Map<number, string>;
    /** Real pixel size of each tile's own image (varies per furniture item —
     *  see generateTiledFurnitureTileset.ts's "Collection of Images" tileset). */
    sizeByType: Map<string, { width: number; height: number }>;
  };
}

function readTileCount(tsxPath: string): number {
  const xml = fs.readFileSync(tsxPath, 'utf-8');
  const m = /tilecount="(\d+)"/.exec(xml);
  if (!m) throw new Error(`${tsxPath}: no tilecount attribute found`);
  return Number(m[1]);
}

/** Parse `<tile id="N"><image width=".." height=".."/>...<property name="type"
 *  type="string" value="X"/>` out of the furniture collection tileset (simple
 *  regex scan — this is our own generated, well-formed XML, not arbitrary
 *  user input). */
function readFurnitureTiles(tsxPath: string): { localIdToType: Map<number, string>; sizeByType: Map<string, { width: number; height: number }> } {
  const xml = fs.readFileSync(tsxPath, 'utf-8');
  const localIdToType = new Map<number, string>();
  const sizeByType = new Map<string, { width: number; height: number }>();
  const tileRe = /<tile id="(\d+)">([\s\S]*?)<\/tile>/g;
  let m: RegExpExecArray | null;
  while ((m = tileRe.exec(xml))) {
    const body = m[2];
    // Tiled omits type="..." for its default ("string") when it resaves a file
    // it opened — e.g. after previewing the generated tileset in the app —
    // so the attribute may or may not be present.
    const typeMatch = /<property name="type"(?:\s+type="string")?\s+value="([^"]*)"\/>/.exec(body);
    const imageMatch = /<image source="[^"]*" width="(\d+)" height="(\d+)"\/>/.exec(body);
    if (!typeMatch) continue;
    const type = typeMatch[1];
    localIdToType.set(Number(m[1]), type);
    if (imageMatch) sizeByType.set(type, { width: Number(imageMatch[1]), height: Number(imageMatch[2]) });
  }
  return { localIdToType, sizeByType };
}

/** @param tiledDir assets/tiled/ — where the three generated tilesets live. */
export function loadTilesetInfo(tiledDir: string): TilesetInfo {
  const floorPath = path.join(tiledDir, 'floor-tileset.tsx');
  const wallPath = path.join(tiledDir, 'wall-0-tileset.tsx');
  const furniturePath = path.join(tiledDir, 'furniture-tileset.tsx');
  for (const p of [floorPath, wallPath, furniturePath]) {
    if (!fs.existsSync(p)) {
      throw new Error(
        `${p} not found — run "pnpm --filter @pixel/server run generate:tiled" and ` +
          `"generate:tiled-furniture" first.`,
      );
    }
  }

  const floorTileCount = readTileCount(floorPath);
  const wallTileCount = readTileCount(wallPath);
  const furnitureTileCount = readTileCount(furniturePath);
  const { localIdToType, sizeByType } = readFurnitureTiles(furniturePath);
  const typeToLocalId = new Map<string, number>();
  for (const [id, type] of localIdToType) typeToLocalId.set(type, id);

  // Tiled gid 0 is always "empty" — real gids start at 1.
  const floorFirstGid = 1;
  const wallFirstGid = floorFirstGid + floorTileCount;
  const furnitureFirstGid = wallFirstGid + wallTileCount;

  return {
    floor: { firstGid: floorFirstGid, tileCount: floorTileCount, source: 'floor-tileset.tsx' },
    wall: { firstGid: wallFirstGid, tileCount: wallTileCount, source: 'wall-0-tileset.tsx' },
    furniture: {
      firstGid: furnitureFirstGid,
      tileCount: furnitureTileCount,
      source: 'furniture-tileset.tsx',
      typeToLocalId,
      localIdToType,
      sizeByType,
    },
  };
}
