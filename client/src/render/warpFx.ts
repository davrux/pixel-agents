/**
 * What a warp looks like — one place per style, client-side by contract.
 *
 * The server decides WHO warps, in which phase, in which style, and how long a phase lasts (the
 * body is repositioned at that boundary, so the duration is world state — see `WARP_STYLES`).
 * Everything here is what AGENTS.md invariant 2 calls presentation: which texture, which curve,
 * how the body is tinted or squeezed. Adding a style is a row in `WARP_STYLES` plus a case here.
 *
 * Two shapes cover the four styles, and the split is not arbitrary:
 *
 *  - **A tiling texture** (matrix, beam) for anything that SWEEPS. Figures run from 16x32 to
 *    64x64, and a sheet stretched to fit gives a tall character fat drops and a short one fine
 *    ones; tiling keeps the art at its authored pixel size and scrolling one band across the
 *    frame IS the sweep. Tiling is `GL_REPEAT` on a whole texture and cannot be asked of one
 *    frame inside a packed atlas page, which is why these two get a texture of their own — the
 *    deliberate exception AGENTS.md § Conventions allows, created once for the world rather than
 *    once per character.
 *  - **A frame sequence** (phoenix) for anything that SITS where the figure is and boils. A flame
 *    is not a wavefront: scrolling it would read as a passing light rather than as burning, so it
 *    plays from the atlas like any other sprite.
 *
 * And one style needs no art at all: `implode` squeezes the body to a point, which is a transform
 * on the frame the renderer already has.
 *
 * The per-pixel Matrix renderer this file used to fall back to is gone. It existed for a rain
 * sheet that failed to load and cost 7.10 ms per frame with five 64x64 figures (4 376 fills
 * each). A missing sheet now means no effect — the figure is drawn whole — which is the honest
 * answer for art that did not arrive, and cheaper than a second renderer nobody looks at.
 */
import { BEAM_BAND_PX, MATRIX_RAIN_BAND_PX, warpStyle, type WarpStyleId } from '@pixel/shared/office/effects.js';
import { warpProgress } from '@pixel/shared/office/engine/matrixEffect.js';
import type { Character } from '@pixel/shared/office/types';

import { effectSheetId } from '../art/effects.js';
import { sheetBitmap } from '../art/sheetStore.js';

/**
 * How a style is drawn over the figure.
 *
 * `anchor` is where the art belongs relative to the body: a sweep and a flame sit ON the figure
 * (feet), while an implosion's hole sits at the point the figure is drawn INTO, which is its
 * middle. Getting that wrong is the difference between a collapse and a figure sinking into the
 * floor.
 */
export type WarpOverlay =
  | { kind: 'tile'; key: string; bandPx: number; anchor: 'feet' }
  | { kind: 'frames'; sheetId: string; frames: number; anchor: 'feet' | 'centre' }
  | { kind: 'none' };

const NONE: WarpOverlay = { kind: 'none' };

/** Warned once per session per style, or a missing sheet prints per character per frame. */
const warned = new Set<string>();

/** The tiling texture for a sweep style, created on first use and kept for the session. */
function tileTexture(scene: Phaser.Scene, id: string): string | null {
  const key = `fx_${id}`;
  if (scene.textures.exists(key)) return key;
  const bitmap = sheetBitmap(effectSheetId(id));
  if (!bitmap) {
    if (!warned.has(id)) {
      warned.add(id);
      console.warn(`[warp] no ${id} sheet — that style draws no effect`);
    }
    return null;
  }
  const tex = scene.textures.createCanvas(key, bitmap.width, bitmap.height);
  if (!tex) return null;
  const ctx = tex.getContext();
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(bitmap, 0, 0);
  tex.refresh();
  return key;
}

/** The SWEEP styles, and how much of their tile carries art. A style in here tiles; one that is
 *  not plays its sheet as frames. */
const TILE_BANDS: Partial<Record<WarpStyleId, number>> = {
  matrix: MATRIX_RAIN_BAND_PX,
  beam: BEAM_BAND_PX,
};

/** Where a frame style's art belongs. Anything that covers the figure sits at its feet; anything
 *  that marks the POINT it went into sits at its middle. */
const FRAME_ANCHORS: Partial<Record<WarpStyleId, 'feet' | 'centre'>> = {
  phoenix: 'feet',
  smoke: 'feet',
  implode: 'centre',
  fold: 'centre',
};

/** What to draw over a character mid-warp — `none` when the style needs nothing, or when its art
 *  did not load. Adding a style is an entry in one of the two tables above. */
export function warpOverlay(scene: Phaser.Scene, id: WarpStyleId): WarpOverlay {
  const sheet = warpStyle(id).sheet;
  if (!sheet) return NONE;
  const bandPx = TILE_BANDS[id];
  if (bandPx !== undefined) {
    const key = tileTexture(scene, sheet.id);
    return key ? { kind: 'tile', key, bandPx, anchor: 'feet' } : NONE;
  }
  if (!sheetBitmap(effectSheetId(sheet.id))) return NONE;
  return { kind: 'frames', sheetId: sheet.id, frames: sheet.frames, anchor: FRAME_ANCHORS[id] ?? 'feet' };
}

/**
 * Where a sweep's band has to sit for a figure `frameH` tall at this progress.
 *
 * Phaser shows the texture starting at `tilePositionY`, so texture row `y` lands on sprite row
 * `y - tilePositionY`: the band (texture rows 0…band) is on screen at `-tilePositionY`. The sweep
 * therefore runs from just above the head to just below the feet — one pass, never a second, since
 * each sheet's empty gap is taller than the tallest legal figure.
 */
export function warpBandScrollY(progress: number, frameH: number, bandPx: number): number {
  return bandPx - progress * (frameH + bandPx);
}

/** A horizontal offset per character, so two figures side by side do not show identical art.
 *  Whole pixels (this is pixel art) and derived from the id rather than random, so it does not
 *  jump when the sprite is rebuilt. */
export function warpBandScrollX(id: number, frameW: number): number {
  return Math.abs(id * 11) % frameW;
}

/**
 * The body's opacity: solid a little before the sweep finishes on the way in, and not fully gone
 * until it has passed on the way out, so the figure never snaps at either end.
 *
 * `implode` is the exception and keeps its opacity — it vanishes by being squeezed to nothing,
 * and fading it as well would just make it disappear early.
 */
export function warpBodyAlpha(ch: Character): number {
  // The styles that hide the body by MOVING it keep their opacity: fading as well would make them
  // disappear early, before the collapse or the seam has finished the job.
  if (ch.warpStyle === 'implode' || ch.warpStyle === 'fold') return 1;
  const progress = warpProgress(ch);
  return ch.matrixEffect === 'spawn' ? Math.min(1, progress * 1.35) : Math.max(0, 1 - progress * 1.15);
}

/** What the body itself does — the identity for every style but `implode`. */
export interface WarpBodyTransform {
  scaleX: number;
  scaleY: number;
  /** Degrees. */
  angle: number;
  /** 0 = untouched, 1 = black. */
  darken: number;
}

const NO_TRANSFORM: WarpBodyTransform = { scaleX: 1, scaleY: 1, angle: 0, darken: 0 };

/**
 * How an imploding body is drawn INTO a point, rather than merely made smaller.
 *
 * The first version scaled both axes by `1 - p³` and left it at that, and it read as a figure
 * walking away from the camera. Three things were missing, and each is one line here:
 *
 *  - **The two axes are not the same.** X collapses early and Y holds on (exponents 1.2 against
 *    2.8), so the figure is pulled THIN before it is swallowed — which is what being sucked in
 *    looks like, and what a uniform scale can never show.
 *  - **It spins as it goes.** A quarter turn's worth, eased so it barely moves at first.
 *  - **It goes dark.** The point it vanishes into is a hole; a figure that keeps its colours to
 *    the last pixel looks lit from somewhere.
 *
 * The caller anchors this at the body's MIDDLE (see PhaserRenderer): with the sprite's own origin
 * at its feet, a shrink converges on the floor, which reads as sinking rather than as collapsing.
 * Never exactly 0 — Phaser treats a zero scale as a degenerate quad.
 */
export function warpBodyTransform(ch: Character): WarpBodyTransform {
  const style = ch.warpStyle;
  if (style !== 'implode' && style !== 'fold') return NO_TRANSFORM;
  const p = warpProgress(ch);
  // 0 = whole, 1 = gone. The arrival is the same curve played backwards.
  const pull = ch.matrixEffect === 'spawn' ? 1 - p : p;
  if (style === 'fold') {
    // Squeezed onto the seam: height goes, width swells a little as it is pressed. No spin and no
    // darkening — this one is a light effect, and a figure that dims on the way into a flash
    // fights the flash.
    return {
      scaleX: 1 + pull * 0.18,
      scaleY: Math.max(0.01, 1 - Math.pow(pull, 0.85)),
      angle: 0,
      darken: 0,
    };
  }
  return {
    scaleX: Math.max(0.01, 1 - Math.pow(pull, 1.2)),
    scaleY: Math.max(0.01, 1 - Math.pow(pull, 2.8)),
    angle: Math.pow(pull, 2) * 90,
    darken: Math.min(1, Math.pow(pull, 1.4)),
  };
}

/**
 * The shimmer, as one number for a whole band.
 *
 * The old pixel path flickered each trail CELL independently, which is free when you are already
 * visiting every cell and impossible when the band is one tiled draw. Dimming the whole band on
 * the same 30 Hz clock is the cheap equivalent: it reads as the code flickering rather than as
 * individual glyphs doing so. Only the matrix style flickers — a beam that stuttered would read
 * as a broken lamp.
 */
export function warpOverlayAlpha(ch: Character): number {
  if (ch.warpStyle !== 'matrix') return 1;
  const t = Math.floor(ch.matrixEffectTimer * FLICKER_FPS);
  const hash = (ch.id * 7 + t * 31) & 0xff;
  return hash < FLICKER_VISIBILITY_THRESHOLD ? 1 : FLICKER_DIM;
}

const FLICKER_FPS = 30;
const FLICKER_VISIBILITY_THRESHOLD = 205;
const FLICKER_DIM = 0.72;
