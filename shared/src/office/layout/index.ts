export type { CatalogEntryWithCategory, FurnitureCategory } from './furnitureCatalog.js';
export { FURNITURE_CATEGORIES, getCatalogByCategory, getCatalogEntry, effectiveAction } from './furnitureCatalog.js';
export {
  createDefaultLayout,
  deserializeLayout,
  getBlockedFloorTiles,
  getBlockedTiles,
  getSeatTiles,
  layoutToFurnitureInstances,
  layoutToSeats,
  layoutToTileMap,
  serializeLayout,
} from './layoutSerializer.js';
export { findPath, getWalkableTiles, isWalkable, nearestWalkableTile } from './tileMap.js';
export {
  buildActionByTile,
  actionAreaTileKeys,
  blockedAreaTiles,
  meetingAreaAt,
  blockedAreaAt,
  rectContains,
  rectsOverlap,
} from './actionAreas.js';
