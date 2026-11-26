/**
 * What a television may show, and where — the numbers both sides must agree on.
 *
 * A player picks ANY image or GIF on their own machine. The browser is what can decode all of
 * them (a JPEG, a WebP, a GIF's frames), so the CLIENT turns the file into one normalised thing: a
 * grid of equal frames packed into a single PNG, plus a delay per frame. The server never sees the
 * original file — it sees a PNG, which goes through the same bounded, header-checked,
 * re-encoding gate as every other image a client sends (`server/src/art/sheetPng.ts`). That is
 * why there is no GIF or JPEG decoder on the server, and why these bounds live in `shared`: the
 * client packs to them, the server refuses anything outside them.
 *
 * The frame bound is about the SCREEN, not the file. A television's glass is a few dozen world
 * pixels wide; 128×96 is that at four times the camera's usual zoom, so a picture is never drawn
 * with less detail than the screen can show and never shipped with much more. The frame count is
 * about bytes per viewer — every viewer in the zone downloads it — and a longer GIF is thinned
 * evenly rather than cut off (see the client's `packFrames`), so it still plays to its end.
 */
import type { TvScreenRect } from './types.js';

/** A frame is scaled to fit inside this, keeping its aspect, and never scaled UP. */
export const TV_MAX_FRAME_W = 128;
export const TV_MAX_FRAME_H = 96;
/** At most this many frames; 48 at 128×96 is 0.59 megapixels, about 1.5× the largest art sheet. */
export const TV_MAX_FRAMES = 48;
/** The packed sheet is never wider than this, so it fits every GPU's texture limit with room. */
export const TV_SHEET_MAX_W = 2048;

/**
 * A GIF frame's delay, as browsers play it: a delay of 10 ms or less is shown as 100 ms (every
 * engine does this, because a GIF saying "0" means "as fast as you can" and old encoders wrote it
 * everywhere). Clamped from above so one frame cannot hang the loop for minutes.
 */
export const TV_DEFAULT_DELAY_MS = 100;
export const TV_MAX_DELAY_MS = 10_000;

export function tvFrameDelay(ms: unknown): number {
  const n = Math.round(Number(ms));
  if (!Number.isFinite(n) || n <= 10) return TV_DEFAULT_DELAY_MS;
  return Math.min(n, TV_MAX_DELAY_MS);
}

/**
 * Which television this is: its anchor tile. Not the placement uid, which every import mints
 * afresh (see Action `tvScreen`) — the arcade cabinets key their per-cabinet settings the same way.
 */
export function tvScreenKey(col: number, row: number): string {
  return `${col},${row}`;
}

export const TV_SCREEN_KEY_RE = /^\d{1,4},\d{1,4}$/;

/** The header an upload carries its metadata in (the body is the PNG) — named once, because the
 *  server's cross-origin preflight must allow it or the desktop app is refused before it sends. */
export const TV_UPLOAD_HEADER = 'x-pixel-tv';

/**
 * How `frames` frames of `frameW` are laid out in the packed PNG: row-major, as many per row as
 * fit in `TV_SHEET_MAX_W`. A function rather than a convention, because the server checks the
 * PNG's dimensions against exactly this and the client slices by it.
 */
export function tvGrid(frameW: number, frameH: number, frames: number): { cols: number; rows: number; width: number; height: number } {
  const cols = Math.max(1, Math.min(frames, Math.floor(TV_SHEET_MAX_W / Math.max(1, frameW))));
  const rows = Math.max(1, Math.ceil(frames / cols));
  return { cols, rows, width: cols * frameW, height: rows * frameH };
}

/** Where frame `i` sits in the packed sheet. */
export function tvFrameRect(i: number, frameW: number, frameH: number, cols: number): { x: number; y: number } {
  return { x: (i % cols) * frameW, y: Math.floor(i / cols) * frameH };
}

/** Bound on a screen rect's numbers. Art is at most a few hundred pixels; this only exists so a
 *  crafted layout cannot carry nonsense into a renderer. */
const MAX_RECT = 4096;

/**
 * A screen rect from whatever a map or a stored layout says — the Tiled property is the string
 * `"x,y,w,h"`, a stored layout carries the object. Anything malformed, empty or degenerate is
 * `undefined`, which means "the whole piece": a television whose rect is wrong still shows the
 * picture, just over its frame, which is visibly wrong rather than silently absent.
 */
export function parseTvScreenRect(value: unknown): TvScreenRect | undefined {
  let parts: unknown[];
  if (typeof value === 'string') {
    if (!value.trim()) return undefined;
    parts = value.split(',').map((p) => p.trim());
  } else if (value && typeof value === 'object') {
    const r = value as Record<string, unknown>;
    parts = [r.x, r.y, r.w, r.h];
  } else {
    return undefined;
  }
  if (parts.length !== 4) return undefined;
  const nums = parts.map((p) => (typeof p === 'number' || (typeof p === 'string' && /^\d+$/.test(p)) ? Number(p) : NaN));
  if (nums.some((n) => !Number.isInteger(n) || n < 0 || n > MAX_RECT)) return undefined;
  const [x, y, w, h] = nums;
  if (w < 1 || h < 1) return undefined;
  return { x, y, w, h };
}

/**
 * The glass in WORLD pixels for a placement drawn at `drawW`×`drawH` from art of `artW`×`artH`.
 *
 * A resized placement scales its glass with it — the rect is stated in the art's own pixels so a
 * mapper who makes a television bigger in Tiled does not have to restate it.
 */
export function tvScreenWorldRect(
  at: { x: number; y: number },
  drawW: number,
  drawH: number,
  artW: number,
  artH: number,
  rect: TvScreenRect | undefined,
): { x: number; y: number; w: number; h: number } {
  if (!rect || artW <= 0 || artH <= 0) return { x: at.x, y: at.y, w: drawW, h: drawH };
  const sx = drawW / artW;
  const sy = drawH / artH;
  return { x: at.x + rect.x * sx, y: at.y + rect.y * sy, w: rect.w * sx, h: rect.h * sy };
}
