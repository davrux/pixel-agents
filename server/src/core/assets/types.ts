/**
 * Character/pet sprite shapes, shared between the asset loader and the
 * office engine's character-spec resolver.
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
