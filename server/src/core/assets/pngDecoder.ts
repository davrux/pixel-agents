/**
 * Pure PNG decoding utilities — shared between the extension host, Vite build
 * scripts, and future standalone backend.
 *
 * No VS Code dependency. Only uses pngjs and shared constants.
 */

import { PNG } from 'pngjs';

import { rgbaToHex } from './colorUtils.js';
import {
  CHAR_FRAME_H,
  CHAR_FRAME_W,
  CHARACTER_DIRECTIONS,
  FLOOR_TILE_SIZE,
  PET_FRAME_H,
  PET_FRAME_W,
  PET_FRAMES_PER_ROW,
  PET_DIRECTIONS,
  WALL_BITMASK_COUNT,
  WALL_GRID_COLS,
  WALL_PIECE_HEIGHT,
  WALL_PIECE_WIDTH,
} from './constants.js';
import type { CharacterDirectionSprites, PetDirectionSprites } from './types.js';

// ── Sprite decoding ──────────────────────────────────────────

/**
 * Convert a PNG buffer to SpriteData (2D array of hex color strings).
 * '' = transparent, '#RRGGBB' = opaque, '#RRGGBBAA' = semi-transparent.
 */
export function pngToSpriteData(pngBuffer: Buffer, width: number, height: number): string[][] {
  try {
    const png = PNG.sync.read(pngBuffer);

    if (png.width !== width || png.height !== height) {
      console.warn(
        `PNG dimensions mismatch: expected ${width}×${height}, got ${png.width}×${png.height}`,
      );
    }

    const sprite: string[][] = [];
    const data = png.data;

    for (let y = 0; y < height; y++) {
      const row: string[] = [];
      for (let x = 0; x < width; x++) {
        const pixelIndex = (y * png.width + x) * 4;
        const r = data[pixelIndex];
        const g = data[pixelIndex + 1];
        const b = data[pixelIndex + 2];
        const a = data[pixelIndex + 3];
        row.push(rgbaToHex(r, g, b, a));
      }
      sprite.push(row);
    }

    return sprite;
  } catch (err) {
    console.warn(`Failed to parse PNG: ${err instanceof Error ? err.message : err}`);
    const sprite: string[][] = [];
    for (let y = 0; y < height; y++) {
      sprite.push(new Array(width).fill(''));
    }
    return sprite;
  }
}

/**
 * Parse a wall PNG (a 4-wide grid of 16×32 pieces) into its wall sprites.
 * Piece at index I: col = I % 4, row = floor(I / 4).
 *
 * The piece COUNT comes from the image's own height rather than being fixed at
 * WALL_BITMASK_COUNT, because a set may carry extra hand-painted-only pieces
 * after the 16 adjacency ones — the metro set's north-wall faces, see
 * server/scripts/gen-metro-source-art.mts. Indices 0-15 are always the
 * bitmask pieces; anything past that is reachable only via an explicitly
 * authored OfficeLayout.tileWallMask.
 */
export function parseWallPng(pngBuffer: Buffer): string[][][] {
  const png = PNG.sync.read(pngBuffer);
  const sprites: string[][][] = [];
  const pieceCount = Math.floor(png.height / WALL_PIECE_HEIGHT) * WALL_GRID_COLS;
  if (pieceCount < WALL_BITMASK_COUNT) {
    throw new Error(`wall PNG is ${png.width}×${png.height} — too small for ${WALL_BITMASK_COUNT} bitmask pieces`);
  }
  for (let piece = 0; piece < pieceCount; piece++) {
    const ox = (piece % WALL_GRID_COLS) * WALL_PIECE_WIDTH;
    const oy = Math.floor(piece / WALL_GRID_COLS) * WALL_PIECE_HEIGHT;
    const sprite: string[][] = [];
    for (let r = 0; r < WALL_PIECE_HEIGHT; r++) {
      const row: string[] = [];
      for (let c = 0; c < WALL_PIECE_WIDTH; c++) {
        const idx = ((oy + r) * png.width + (ox + c)) * 4;
        const rv = png.data[idx];
        const gv = png.data[idx + 1];
        const bv = png.data[idx + 2];
        const av = png.data[idx + 3];
        row.push(rgbaToHex(rv, gv, bv, av));
      }
      sprite.push(row);
    }
    sprites.push(sprite);
  }
  return sprites;
}

/**
 * Decode a directional sprite sheet into direction-keyed frame arrays.
 * The sheet has one row per direction (in `dirs` order) and `framesPerRow`
 * frames of `frameW`×`frameH` per row. Shared by characters and pets.
 */
function decodeDirectionalSheet(
  pngBuffer: Buffer,
  frameW: number,
  frameH: number,
  framesPerRow: number,
  dirs: readonly string[],
): Record<string, string[][][]> {
  const png = PNG.sync.read(pngBuffer);
  const result: Record<string, string[][][]> = {};

  for (let dirIdx = 0; dirIdx < dirs.length; dirIdx++) {
    const rowOffsetY = dirIdx * frameH;
    const frames: string[][][] = [];

    for (let f = 0; f < framesPerRow; f++) {
      const sprite: string[][] = [];
      const frameOffsetX = f * frameW;
      for (let y = 0; y < frameH; y++) {
        const row: string[] = [];
        for (let x = 0; x < frameW; x++) {
          const idx = ((rowOffsetY + y) * png.width + (frameOffsetX + x)) * 4;
          row.push(rgbaToHex(png.data[idx], png.data[idx + 1], png.data[idx + 2], png.data[idx + 3]));
        }
        sprite.push(row);
      }
      frames.push(sprite);
    }
    result[dirs[dirIdx]] = frames;
  }

  return result;
}

/**
 * Decode a single character PNG (112×96) into direction-keyed frame arrays.
 * Each PNG has 3 direction rows (down, up, right) × 7 frames (16×32 each).
 */
export function decodeCharacterPng(
  pngBuffer: Buffer,
  frameW: number = CHAR_FRAME_W,
  frameH: number = CHAR_FRAME_H,
): CharacterDirectionSprites {
  // Frames per row are derived from the sheet width, so a character file can
  // carry the 7 base frames or extra frame-sets (e.g. coffee) without a fixed
  // constant — the default-character assets stay extensible. The frame size
  // defaults to 16×32 but can be overridden via a per-character manifest.
  const png = PNG.sync.read(pngBuffer);
  const framesPerRow = Math.max(1, Math.floor(png.width / frameW));
  return decodeDirectionalSheet(
    pngBuffer,
    frameW,
    frameH,
    framesPerRow,
    CHARACTER_DIRECTIONS,
  ) as unknown as CharacterDirectionSprites;
}

/**
 * Decode a single pet PNG (96×48) into direction-keyed frame arrays.
 * Each PNG has 3 direction rows (down, up, right) × 6 frames (16×16 each).
 */
export function decodePetPng(pngBuffer: Buffer): PetDirectionSprites {
  return decodeDirectionalSheet(
    pngBuffer,
    PET_FRAME_W,
    PET_FRAME_H,
    PET_FRAMES_PER_ROW,
    PET_DIRECTIONS,
  ) as unknown as PetDirectionSprites;
}

/**
 * Decode a single floor tile PNG (16×16 grayscale pattern).
 */
export function decodeFloorPng(pngBuffer: Buffer): string[][] {
  return pngToSpriteData(pngBuffer, FLOOR_TILE_SIZE, FLOOR_TILE_SIZE);
}
