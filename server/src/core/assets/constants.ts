/**
 * Shared constants — used by the extension host, Vite build scripts,
 * and future standalone backend.
 *
 * No VS Code dependency. Only asset parsing and layout-related values.
 */

// ── PNG / Asset Parsing ─────────────────────────────────────
export const PNG_ALPHA_THRESHOLD = 2;
export const WALL_PIECE_WIDTH = 16;
export const WALL_PIECE_HEIGHT = 32;
export const WALL_GRID_COLS = 4;
export const WALL_BITMASK_COUNT = 16;
export const FLOOR_TILE_SIZE = 16;
export const CHARACTER_DIRECTIONS = ['down', 'up', 'right'] as const;
export const CHAR_FRAME_W = 16;
export const CHAR_FRAME_H = 32;

// ── Pets ─────────────────────────────────────────────────────
// Pet sheets share the character row layout (down/up/right; left = flip),
// but use smaller 16×16 cells and 6 frames per row:
//   0,1,2 walk · 3 sit/tail-left · 4 sit/tail-right · 5 idle
export const PET_DIRECTIONS = ['down', 'up', 'right'] as const;
export const PET_FRAME_W = 16;
export const PET_FRAME_H = 16;
export const PET_FRAMES_PER_ROW = 6;
export const DOG_COUNT = 2;
export const CAT_COUNT = 2;
export const DUCK_COUNT = 2;
