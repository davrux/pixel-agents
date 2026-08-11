/**
 * The full, flat Tiled-bridge category list: the two structural tile kinds
 * (floor/walls — each their own Tiled class, FloorTile/WallTile, baked with
 * a fixed `category` value since every tile in that class is trivially the
 * same kind) plus every furniture category (the mapper-facing browsing
 * label on FurnitureTile — see FURNITURE_CATEGORIES, the actual source of
 * truth for those 7).
 *
 * Single source of truth for both directions: bake-floor-wall-tiled.mts
 * WRITES these two constants into every floor.tsj/wall-*.tsj tile's
 * `category` property; mapBridge.ts READS them back to classify a resolved
 * Ground-layer tile (replacing the old implicit "does it have a `bitmask`
 * property" heuristic). Keep assets/tiled/Pixels.tiled-project's
 * `Category` enum values in sync with ALL_CATEGORIES by hand — it's a JSON
 * file, it can't import this.
 */
import { FURNITURE_CATEGORIES } from '@pixel/shared/office/layout/furnitureCatalog.js';

export const FLOOR_CATEGORY = 'floor';
export const WALL_CATEGORY = 'walls';

export const ALL_CATEGORIES = [FLOOR_CATEGORY, WALL_CATEGORY, ...FURNITURE_CATEGORIES.map((c) => c.id)] as const;
