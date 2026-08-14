import Phaser from 'phaser';

/**
 * Status markers drawn over a character's head (☕, 💤 afk …).
 *
 * These used to be DOM overlays positioned from the scene's ~20 Hz overlay pass,
 * which made them lag and jitter against the canvas while panning or zooming.
 * They are world-space Phaser images now, so the camera moves them with the
 * avatar — the cost is that a glyph must be rasterized ourselves. Each marker is
 * drawn at `res`× its world size (see `markerResolution`) so it stays as crisp
 * on screen as the DOM text it replaced, at any zoom.
 */
export interface MarkerSpec {
  /** Glyph or short label to draw. Part of the texture cache key. */
  text: string;
  /** Em-box height in WORLD pixels — the marker scales with the camera. */
  size: number;
  /** Red ring + slash over the glyph — the "deactivated" mark. Nothing uses it
   *  since zone voice's mic/sound markers went; kept because it is the one
   *  drawing primitive here that is not tied to a particular glyph. */
  crossed?: boolean;
  /** Fill color; ignored by color emoji, used by the pixel-font labels. */
  color?: string;
  /** Coffee "sip": tilt-and-lift loop (see sipOffset in PhaserRenderer). */
  sip?: boolean;
}

/** A rasterized marker: texture key plus the size to display it at, in world px. */
export interface MarkerTexture {
  key: string;
  w: number;
  h: number;
}

const FONT_STACK =
  "'FS Pixel Sans','Apple Color Emoji','Segoe UI Emoji','Noto Color Emoji',monospace";
const CROSS_COLOR = '#f0696e';
const DEFAULT_COLOR = '#efeeea';
/** Cap on the raster scale — the camera itself never zooms past 14. */
const MAX_RES = 16;

const cache = new Map<string, MarkerTexture>();

/** Raster scale for a camera zoom, bucketed to whole steps so a slow wheel zoom
 *  reuses textures instead of re-rasterizing every notch. */
export function markerResolution(zoom: number): number {
  return Math.max(1, Math.min(MAX_RES, Math.ceil(zoom)));
}

/** Rasterize a marker into a canvas texture, once per (spec, res). */
export function markerTexture(scene: Phaser.Scene, spec: MarkerSpec, res: number): MarkerTexture {
  const key = `mk|${spec.text}|${spec.size}|${spec.crossed ? 'x' : ''}|${spec.color ?? ''}|${res}`;
  const hit = cache.get(key);
  if (hit && scene.textures.exists(key)) return hit;

  const px = spec.size * res;
  const font = `${px}px ${FONT_STACK}`;
  // Measure in a throwaway context so the texture is only as large as it needs
  // to be (emoji and the pixel font have very different advance widths).
  const measure = document.createElement('canvas').getContext('2d');
  let textW = px;
  if (measure) {
    measure.font = font;
    textW = Math.max(1, measure.measureText(spec.text).width);
  }
  // Room for the dark halo, plus the ring when crossed.
  const pad = Math.ceil(px * (spec.crossed ? 0.3 : 0.16));
  const w = Math.ceil(textW) + pad * 2;
  const h = Math.ceil(px) + pad * 2;
  const out: MarkerTexture = { key, w: w / res, h: h / res };

  const tex = scene.textures.createCanvas(key, w, h);
  if (!tex) return out;
  const ctx = tex.getContext();
  ctx.clearRect(0, 0, w, h);
  ctx.font = font;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  const cx = w / 2;
  const cy = h / 2;
  // Dark halo: the canvas stand-in for the old CSS text-shadow, so a light glyph
  // stays readable over a pale floor. Emoji ignore strokeText, hence a shadow.
  ctx.shadowColor = '#000';
  ctx.shadowBlur = Math.max(1, px * 0.2);
  ctx.fillStyle = spec.color ?? DEFAULT_COLOR;
  ctx.fillText(spec.text, cx, cy);
  ctx.fillText(spec.text, cx, cy); // twice: one pass of blur is too faint
  ctx.shadowBlur = 0;
  if (spec.crossed) {
    const line = Math.max(1, px * 0.1);
    const r = Math.min(w, h) / 2 - line;
    ctx.strokeStyle = CROSS_COLOR;
    ctx.lineWidth = line;
    ctx.shadowBlur = Math.max(1, res);
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.stroke();
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(-0.35); // ≈ −20°, the tilt the CSS slash had
    ctx.beginPath();
    ctx.moveTo(-r, 0);
    ctx.lineTo(r, 0);
    ctx.stroke();
    ctx.restore();
  }
  tex.refresh();
  // The game default is NEAREST (pixelArt), which is right for the hand-drawn
  // sprites but wrong here: the raster already matches the current zoom bucket,
  // so LINEAR just keeps the steps in between from crunching.
  tex.setFilter(Phaser.Textures.FilterMode.LINEAR);
  cache.set(key, out);
  return out;
}
