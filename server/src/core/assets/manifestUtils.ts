/**
 * The furniture catalog's wire shape, produced by tiledFurniture.ts's
 * parseFurnitureTileset (reading assets/tiled/furniture-*.tsj) and consumed
 * by assetLoader.ts. Named manifestUtils for historical reasons — it used to
 * also hold the pre-Tiled assets/furniture/<TYPE>/manifest.json flattening
 * logic (ManifestAsset/ManifestGroup/flattenManifest etc.), retired once
 * that tree was fully migrated (see docs/design.md).
 */
import type { Action, Direction } from '@pixel/shared/office/types.js';

export interface FurnitureAsset {
  id: string;
  name: string;
  label: string;
  file: string;
  width: number;
  height: number;
  footprintW: number;
  footprintH: number;
  /** Behaviour defaults for this type — see FurnitureCatalogEntry, and
   *  server/src/tiled/furnitureProps.ts for the Tiled properties they come
   *  from. */
  canSitOn?: boolean;
  sitFacing?: Direction;
  petCanSitOn?: boolean;
  backgroundTiles?: number;
  onState?: string;
  animationGroup?: string;
  frame?: number;
  durationMs?: number;
  /** This type's default Action (see FurnitureCatalogEntry.action) — set via
   *  the tile's own actionKind/actionVideo/actionUrl/actionPose properties
   *  (see Pixels.tiled-project's FurnitureTile class). */
  action?: Action;
}
