/**
 * Asset pipeline types — shared between the extension host, Vite build
 * scripts, browser mock, and future standalone backends.
 */

import type { CharacterSpec } from '@pixel/shared/office/sprites/characterSpec.js';

export interface CharacterDirectionSprites {
  down: string[][][];
  up: string[][][];
  right: string[][][];
  /** Optional animation spec (frame size + per-pose tracks). Loaded from an
   *  optional per-character manifest; absent → the default 16×32 layout. */
  spec?: CharacterSpec;
}

/** Directional sprite frames for a pet (same row layout as characters, 16×16 cells). */
export interface PetDirectionSprites {
  down: string[][][];
  up: string[][][];
  right: string[][][];
}

export interface AssetIndex {
  floors: string[];
  walls: string[];
  characters: string[];
  pets: { dogs: string[]; cats: string[]; ducks: string[] };
  defaultLayout: string | null;
}

export interface CatalogEntry {
  id: string;
  name: string;
  label: string;
  category: string;
  file: string;
  furniturePath: string;
  width: number;
  height: number;
  footprintW: number;
  footprintH: number;
  isDesk: boolean;
  canPlaceOnWalls: boolean;
  appliance?: string; // interaction station kind ('coffee', …)
  canPlaceOnSurfaces?: boolean;
  backgroundTiles?: number;
  groupId?: string;
  orientation?: string;
  state?: string;
  mirrorSide?: boolean;
  rotationScheme?: string;
  animationGroup?: string;
  frame?: number;
}
