/**
 * The furniture catalog's wire shape, produced by tiledFurniture.ts's
 * parseFurnitureTileset (reading assets/tiled/furniture-*.tsj) and consumed
 * by assetLoader.ts. Named manifestUtils for historical reasons — it used to
 * also hold the pre-Tiled assets/furniture/<TYPE>/manifest.json flattening
 * logic (ManifestAsset/ManifestGroup/flattenManifest etc.), retired once
 * that tree was fully migrated (see docs/design/tiled-editor-integration.md).
 */

export interface FurnitureAsset {
  id: string;
  name: string;
  label: string;
  category: string;
  file: string;
  width: number;
  height: number;
  footprintW: number;
  footprintH: number;
  isDesk: boolean;
  groupId?: string;
  canPlaceOnSurfaces?: boolean;
  backgroundTiles?: number;
  orientation?: string;
  state?: string;
  onTrigger?: 'autoFacing' | 'click';
  animationGroup?: string;
  frame?: number;
  durationMs?: number;
}
