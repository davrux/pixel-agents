/**
 * Asset pipeline types — shared between the extension host, Vite build
 * scripts, browser mock, and future standalone backends.
 */

export interface CharacterDirectionSprites {
  down: string[][][];
  up: string[][][];
  right: string[][][];
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
