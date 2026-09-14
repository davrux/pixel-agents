/**
 * The helmet a driver wears, drawn rather than fetched.
 *
 * A kart is a true overhead view, so what belongs in its seat is the top of a head: a disc, a
 * visor, and whatever the chosen pattern paints on the shell. Generated for the same reasons the
 * kart itself is — it works at any size, a new pattern is a branch rather than sixty files, and
 * nothing has to travel.
 *
 * Cached per (style, size) into the shared runtime atlas, because it is the same picture for
 * everybody wearing it: twelve karts in one helmet is one texture, not twelve (AGENTS.md § the
 * runtime atlas — a texture per entity is what breaks batching).
 */
import type Phaser from 'phaser';

import { helmetStyle, type HelmetStyle } from '@pixel/shared/office/race/helmets.js';

import { spriteTexture, type SpriteTex } from './sprites';

/** The default helmet: somebody's own colours, read off their sheet. */
export interface DerivedHelmet {
  shell: string;
  trim: string;
}

const cache = new Map<string, SpriteTex>();
/** Colours read off a sheet, per skin — the decode is the expensive part and the answer never
 *  changes for a given sheet. Cleared by nothing: it is keyed by CONTENT (a skin id names one
 *  sheet), which is the bound AGENTS.md § Memory asks a cache to state. */
const derivedCache = new Map<string, DerivedHelmet>();

/**
 * Somebody's own colours, for the helmet they never chose: the top of their head.
 *
 * Read off the DOWN frame, which every sheet has — the topmost opaque row is hair (or a hat, or
 * whatever is up there), and a row a third of the way down is the face or the band under it. That
 * is enough to tell twelve drivers apart without anybody opening a menu, and it costs one decode
 * per skin because the answer is a property of the sheet.
 */
export function derivedHelmet(skin: string, pixels: string[][] | null): DerivedHelmet {
  const hit = derivedCache.get(skin);
  if (hit) return hit;
  const fallback: DerivedHelmet = { shell: '#c51a1b', trim: '#f1efec' };
  if (!pixels || pixels.length === 0) return fallback;
  const pick = (row: number): string => {
    const line = pixels[Math.max(0, Math.min(pixels.length - 1, row))] ?? [];
    const seen = new Map<string, number>();
    for (const c of line) if (c) seen.set(c, (seen.get(c) ?? 0) + 1);
    let best = '';
    let most = 0;
    for (const [c, n] of seen) if (n > most) {
      most = n;
      best = c;
    }
    return best;
  };
  // The first row with anything on it, and one a third of the way down the figure.
  let top = 0;
  while (top < pixels.length && !pixels[top].some((c) => c)) top++;
  const shell = pick(top + 1) || fallback.shell;
  const trim = pick(top + Math.round(pixels.length * 0.28)) || fallback.trim;
  const out: DerivedHelmet = { shell, trim: trim === shell ? '#f1efec' : trim };
  derivedCache.set(skin, out);
  return out;
}

/** Hex for a canvas, from the '#rrggbb' the table stores. */
const hex = (c: string): string => (c.startsWith('#') ? c : `#${c}`);

/**
 * One helmet as pixels: a shell, a darker rim, the pattern, and a visor across the front.
 *
 * The visor is at the FRONT (+x), because the whole sprite is rotated by the kart's heading and
 * the art points east like everything else in the race. That is what tells a viewer which way a
 * stopped kart is facing when the driver is all they can see of it.
 */
function paint(style: HelmetStyle | DerivedHelmet, pattern: string, size: number): string[][] {
  const px: string[][] = Array.from({ length: size }, () => Array.from({ length: size }, () => ''));
  const c = (size - 1) / 2;
  const r = size / 2 - 0.5;
  const shell = hex(style.shell);
  const trim = hex(style.trim);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = x - c;
      const dy = y - c;
      const d = Math.hypot(dx, dy);
      if (d > r) continue;
      let colour = shell;
      // The pattern, in helmet space: x is forward, y is across.
      if (pattern === 'stripe' && Math.abs(dy) <= size * 0.11) colour = trim;
      else if (pattern === 'twin' && Math.abs(Math.abs(dy) - size * 0.22) <= size * 0.08) colour = trim;
      else if (pattern === 'halves' && dx < 0) colour = trim;
      else if (pattern === 'spots' && (Math.hypot(dx + r * 0.35, dy - r * 0.4) < size * 0.13 ||
        Math.hypot(dx + r * 0.35, dy + r * 0.4) < size * 0.13)) colour = trim;
      // The visor: a dark band across the front third, inset from the rim so the shell frames it.
      if (dx > r * 0.18 && d < r * 0.88) colour = '#141312';
      // A rim all the way round, so a pale helmet still has an edge on a pale kart.
      if (d > r - 1) colour = '#0a0908';
      px[y][x] = colour;
    }
  }
  return px;
}

/**
 * The atlas frame for a helmet. `id` is a table id; when it is empty the driver's own colours are
 * used instead, which is what somebody who never opened the menu gets.
 */
export function helmetTexture(
  scene: Phaser.Scene,
  id: string,
  derived: DerivedHelmet,
  size: number,
): SpriteTex | null {
  const style = helmetStyle(id);
  const pattern = style?.pattern ?? 'plain';
  const key = style ? `${style.id}:${size}` : `derived:${derived.shell}:${derived.trim}:${size}`;
  const hit = cache.get(key);
  if (hit && scene.textures.exists(hit.key)) return hit;
  const tex = spriteTexture(scene, paint(style ?? derived, pattern, size));
  if (tex) cache.set(key, tex);
  return tex;
}
