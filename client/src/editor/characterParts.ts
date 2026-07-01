/**
 * Layered character generator built on the MetroCity part sheets
 * (`client/public/charparts/`, JIK-A-4 "Metro City" free pack — see README credits).
 *
 * The sheets are 24-frame rows of 32×32 cells, one row per variant:
 *   body.png    6 skin tones     hair.png  8 styles     outfits.png  6 outfits
 * The 24 frames per row are laid out down(0–5) · right(6–11) · up(12–17) · left(18–23,
 * an exact mirror of right — we omit it and let the engine mirror). We compose
 * body→outfit→hair per frame into our `SpriteData`, take the walk cycle straight
 * from the pack, and *synthesise* the tracks the pack lacks (typing/reading/coffee)
 * procedurally from the idle frame: a small lean/nod plus a drawn prop (book, cup).
 * It's an approximation — the creator is also an editor, so frames stay tweakable.
 */
import type { CharacterSpec, LoadedCharacterData } from '@pixel/shared/office/sprites/spriteData.js';
import type { SpriteData } from '@pixel/shared/office/types.js';

export const FRAME = 32;
export const SKIN_COUNT = 6;
export const HAIR_COUNT = 8;
export const OUTFIT_COUNT = 6;

/** Frame columns per facing in the 24-frame MetroCity row (left = mirrored right). */
const DIR_COLS: Record<'down' | 'right' | 'up', number[]> = {
  down: [0, 1, 2, 3, 4, 5],
  right: [6, 7, 8, 9, 10, 11],
  up: [12, 13, 14, 15, 16, 17],
};

/** A part choice. `hair`/`outfit` = -1 means "none"; `skin` always picks a body. */
export interface PartSelection {
  skin: number;
  hair: number;
  outfit: number;
}

export interface PartSheets {
  body: HTMLImageElement;
  hair: HTMLImageElement;
  outfit: HTMLImageElement;
}

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`failed to load ${url}`));
    img.src = url;
  });
}

/** Fetch + decode the three part sheets (served from client/public/charparts/). */
export async function loadPartSheets(): Promise<PartSheets> {
  // Resolve against the document base so it works under any deploy base path.
  const url = (p: string): string => new URL(`charparts/${p}`, document.baseURI).href;
  const [body, hair, outfit] = await Promise.all([
    loadImage(url('body.png')),
    loadImage(url('hair.png')),
    loadImage(url('outfits.png')),
  ]);
  return { body, hair, outfit };
}

// One reusable offscreen canvas for compositing.
let cv: HTMLCanvasElement | null = null;
let cx: CanvasRenderingContext2D | null = null;
function ctx(): CanvasRenderingContext2D {
  if (!cx) {
    cv = document.createElement('canvas');
    cv.width = cv.height = FRAME;
    cx = cv.getContext('2d', { willReadFrequently: true })!;
    cx.imageSmoothingEnabled = false;
  }
  return cx;
}

function drawCell(c: CanvasRenderingContext2D, img: HTMLImageElement, col: number, row: number): void {
  c.drawImage(img, col * FRAME, row * FRAME, FRAME, FRAME, 0, 0, FRAME, FRAME);
}

function hex2(n: number): string {
  return n.toString(16).padStart(2, '0');
}

/** Composite body→outfit→hair for one frame column into a SpriteData grid. */
export function composeFrame(sheets: PartSheets, sel: PartSelection, col: number): SpriteData {
  const c = ctx();
  c.clearRect(0, 0, FRAME, FRAME);
  drawCell(c, sheets.body, col, Math.max(0, Math.min(SKIN_COUNT - 1, sel.skin)));
  if (sel.outfit >= 0) drawCell(c, sheets.outfit, col, sel.outfit);
  if (sel.hair >= 0) drawCell(c, sheets.hair, col, sel.hair);
  const { data } = c.getImageData(0, 0, FRAME, FRAME);
  const out: SpriteData = [];
  for (let y = 0; y < FRAME; y++) {
    const row: string[] = [];
    for (let x = 0; x < FRAME; x++) {
      const i = (y * FRAME + x) * 4;
      const a = data[i + 3];
      if (a === 0) row.push('');
      else {
        const base = `#${hex2(data[i])}${hex2(data[i + 1])}${hex2(data[i + 2])}`;
        row.push(a === 255 ? base : base + hex2(a));
      }
    }
    out.push(row);
  }
  return out;
}

// ── Procedural animation synthesis (validated headless before porting) ──────────

function clone(s: SpriteData): SpriteData {
  return s.map((r) => r.slice());
}
function blankRow(w: number): string[] {
  return new Array(w).fill('');
}

/** Dip the upper body (rows above the waist) down by `dy` px — a small lean/nod. */
function lean(s: SpriteData, waistY = 21, dy = 1): SpriteData {
  const w = s[0]?.length ?? FRAME;
  const out: SpriteData = [];
  for (let y = 0; y < s.length; y++) {
    if (y < waistY) {
      const src = y - dy;
      out.push(src >= 0 ? s[src].slice() : blankRow(w));
    } else out.push(s[y].slice());
  }
  return out;
}

function px(s: SpriteData, x: number, y: number, color: string): void {
  if (y >= 0 && y < s.length && x >= 0 && x < (s[0]?.length ?? 0)) s[y][x] = color;
}
function fillRect(s: SpriteData, x0: number, y0: number, x1: number, y1: number, color: string): void {
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) px(s, x, y, color);
}

const BOOK_FRAME = '#2a2320';
const PAGE = '#f2efe6';
const SPINE = '#c9c2b2';
const TEXT = '#8f887c';
const PAGE_FLIP = '#d8d2c4';
const CUP = '#e8e8ee';
const CUP_EDGE = '#787882';
const COFFEE = '#4a2e1e';

/** A small held book on the chest — sized like the bundled chars' reading pose,
 *  narrow enough that the idle's side hands still show (so it reads as "held"). */
function drawBook(s: SpriteData, facingRight: boolean): void {
  const cxp = facingRight ? 17 : 16;
  const y = 21;
  const L = cxp - 4;
  const R = cxp + 4; // 9 px wide, 5 px tall
  fillRect(s, L, y, R, y + 4, BOOK_FRAME); // dark cover/frame
  fillRect(s, L + 1, y + 1, R - 1, y + 3, PAGE); // white pages
  for (let yy = y + 1; yy <= y + 3; yy++) px(s, cxp, yy, SPINE); // centre spine
  // a couple of short text lines on each page
  px(s, cxp - 3, y + 2, TEXT);
  px(s, cxp - 2, y + 2, TEXT);
  px(s, cxp + 2, y + 2, TEXT);
  px(s, cxp + 3, y + 2, TEXT);
}
function pageFlip(s: SpriteData, facingRight: boolean): void {
  const cxp = facingRight ? 17 : 16;
  px(s, cxp - 2, 22, PAGE_FLIP);
  px(s, cxp - 3, 23, PAGE_FLIP);
}

/** A small coffee cup held near the leading hand; `raise` lifts it for a sip. */
function drawCup(s: SpriteData, raise: number): void {
  const x = 20;
  const y = 18 - raise;
  fillRect(s, x, y, x + 3, y + 3, CUP);
  for (let xx = x; xx <= x + 3; xx++) {
    px(s, xx, y, CUP_EDGE);
    px(s, xx, y + 3, CUP_EDGE);
  }
  px(s, x, y + 1, CUP_EDGE);
  px(s, x + 3, y + 1, CUP_EDGE);
  px(s, x + 1, y, COFFEE);
  px(s, x + 2, y, COFFEE);
}

function genTyping(idle: SpriteData): SpriteData[] {
  return [clone(idle), lean(idle)];
}
function genReading(idle: SpriteData, dir: 'down' | 'right' | 'up'): SpriteData[] {
  const a = clone(idle);
  const b = lean(idle);
  if (dir !== 'up') {
    drawBook(a, dir === 'right');
    drawBook(b, dir === 'right');
    pageFlip(b, dir === 'right');
  }
  return [a, b];
}
function genCoffee(idle: SpriteData, dir: 'down' | 'right' | 'up'): SpriteData[] {
  const a = clone(idle);
  const b = lean(idle);
  if (dir !== 'up') {
    drawCup(a, 0);
    drawCup(b, 1);
  }
  return [a, b];
}

/** The spec every generated avatar uses: 32×32. Frame 0 of each MetroCity row is
 *  the standing pose → its own 1-frame `idle` track; frames 1–5 are the walk
 *  cycle; typing/reading/coffee are synthesised. Track order = flat-list order. */
export function generatedSpec(): CharacterSpec {
  return {
    frame: { w: FRAME, h: FRAME },
    tracks: [
      { name: 'walk', frames: 5, play: 'loop' },
      { name: 'idle', frames: 1, play: 'loop' },
      { name: 'typing', frames: 2, play: 'loop' },
      { name: 'reading', frames: 2, play: 'loop' },
      { name: 'coffee', frames: 2, play: 'loop' },
    ],
  };
}

/** Compose a full avatar (all directions, all tracks) from a part selection.
 *  Per direction the flat frame list matches generatedSpec()'s track order:
 *  [walk×5 (cols 1–5), idle×1 (col 0, standing), typing×2, reading×2, coffee×2]. */
export function composeAvatar(sheets: PartSheets, sel: PartSelection, name: string): LoadedCharacterData {
  const build = (dir: 'down' | 'right' | 'up'): SpriteData[] => {
    const cols = DIR_COLS[dir];
    const idle = composeFrame(sheets, sel, cols[0]); // frame 0 = standing
    const walk = cols.slice(1).map((col) => composeFrame(sheets, sel, col)); // frames 1–5
    return [...walk, idle, ...genTyping(idle), ...genReading(idle, dir), ...genCoffee(idle, dir)];
  };
  return {
    down: build('down'),
    right: build('right'),
    up: build('up'),
    name,
    spec: generatedSpec(),
  };
}
