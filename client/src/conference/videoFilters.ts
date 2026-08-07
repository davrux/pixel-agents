/**
 * Camera background filters for the conference — the same thing every other video
 * chat app calls "blur your background" / "virtual background": a person-shaped
 * mask is computed per frame and everything outside it is blurred or replaced.
 *
 * The segmentation is LiveKit's `BackgroundProcessor` (MediaPipe selfie
 * segmenter, WebGL compositing), attached to the **local camera track** — so what
 * gets published is already filtered and every other participant sees it, exactly
 * like Meet/Teams/Jitsi. Nothing about this touches the game's authoritative
 * state: it is a local presentation choice, remembered in localStorage.
 *
 * **Self-hosted, no CDN.** LiveKit's defaults fetch the WASM fileset from jsdelivr
 * and the model from Google's model store; both are pointed at `/mediapipe/…`
 * instead, vendored by `pnpm vendor:mediapipe` (see scripts/vendor-mediapipe.mjs).
 * A server that skipped that step has no assets — `probeAssets()` notices and the
 * picker says so rather than hanging on a request that will never succeed.
 *
 * **Cross-browser (AGENTS.md rule 8).** Chromium runs the fast
 * MediaStreamTrackProcessor path, Firefox the canvas.captureStream fallback in
 * @livekit/track-processors. Where neither exists (older Firefox: no WebCodecs
 * `VideoFrame`), `browserSupportsFilters()` is false, the picker is disabled with
 * a reason, and the rest of the meeting is untouched.
 *
 * The heavy dependency (MediaPipe WASM, ~10 MB) is behind a dynamic `import()`,
 * so it is a separate chunk that is only fetched when somebody picks a filter.
 */
import type { LocalVideoTrack } from 'livekit-client';
import type { BackgroundProcessorWrapper, SwitchBackgroundProcessorOptions } from '@livekit/track-processors';

export type VideoFilterId = 'none' | 'blur' | 'blur-strong' | 'bg-blue' | 'bg-office' | 'bg-space' | 'bg-custom';

export interface VideoFilterPreset {
  id: VideoFilterId;
  label: string;
  /** Emoji shown in the picker (kept to one glyph so the buttons stay uniform). */
  icon: string;
  kind: 'none' | 'blur' | 'image';
  /** kind === 'blur' — MediaPipe blur radius in px. */
  blurRadius?: number;
  /** kind === 'image' — paints the generated background (see backgroundUrl). */
  paint?: (c: CanvasRenderingContext2D, w: number, h: number) => void;
}

/** Where vendor-mediapipe.mjs puts the segmenter (client/public → served at /). */
const ASSET_PATHS = {
  tasksVisionFileSet: '/mediapipe/wasm',
  modelAssetPath: '/mediapipe/selfie_segmenter.tflite',
};

/** Backgrounds are generated at this size — 16:9, the tile aspect. */
const BG_W = 1280;
const BG_H = 720;

const STORE_KEY = 'pa-conf-filter';
const CUSTOM_KEY = 'pa-conf-filter-image';
/** Cap on the stored custom background (data URL chars) — localStorage is small. */
const CUSTOM_MAX_CHARS = 1_400_000;

export const VIDEO_FILTERS: readonly VideoFilterPreset[] = [
  { id: 'none', label: 'No filter', icon: '🚫', kind: 'none' },
  { id: 'blur', label: 'Blur', icon: '🌫️', kind: 'blur', blurRadius: 10 },
  { id: 'blur-strong', label: 'Strong blur', icon: '💨', kind: 'blur', blurRadius: 25 },
  { id: 'bg-blue', label: 'Blue', icon: '🟦', kind: 'image', paint: paintBlue },
  { id: 'bg-office', label: 'Office', icon: '🏢', kind: 'image', paint: paintOffice },
  { id: 'bg-space', label: 'Space', icon: '🌌', kind: 'image', paint: paintSpace },
  // Enabled once an image has been picked; the UI opens a file dialog for it.
  { id: 'bg-custom', label: 'Your image', icon: '🖼️', kind: 'image' },
];

export function filterPreset(id: VideoFilterId): VideoFilterPreset {
  return VIDEO_FILTERS.find((f) => f.id === id) ?? VIDEO_FILTERS[0];
}

// ── Availability ─────────────────────────────────────────────────────

/** Everything @livekit/track-processors needs, checked without loading it (the
 *  module pulls in ~10 MB of MediaPipe; the picker must not do that just to grey
 *  a button out). Mirrors BackgroundTransformer.isSupported + ProcessorWrapper.isSupported. */
export function browserSupportsFilters(): boolean {
  if (typeof OffscreenCanvas === 'undefined' || typeof VideoFrame === 'undefined') return false;
  if (typeof createImageBitmap === 'undefined') return false;
  // Either the WebCodecs pipeline (Chromium) or the canvas fallback (Firefox) —
  // which drives itself off requestVideoFrameCallback, so that has to be there too.
  const modern = 'MediaStreamTrackGenerator' in globalThis && 'MediaStreamTrackProcessor' in globalThis;
  const fallback =
    typeof HTMLCanvasElement !== 'undefined' &&
    'captureStream' in HTMLCanvasElement.prototype &&
    'requestVideoFrameCallback' in HTMLVideoElement.prototype;
  if (!modern && !fallback) return false;
  try {
    return !!document.createElement('canvas').getContext('webgl2');
  } catch {
    return false;
  }
}

let assetProbe: Promise<boolean> | null = null;

/** Are the vendored segmentation assets actually being served? Cached: one HEAD
 *  per page, and a negative answer is what turns the picker into a hint. */
export function probeAssets(): Promise<boolean> {
  assetProbe ??= (async () => {
    try {
      const r = await fetch(ASSET_PATHS.modelAssetPath, { method: 'HEAD', cache: 'no-store' });
      return r.ok;
    } catch {
      return false;
    }
  })();
  return assetProbe;
}

export const MISSING_ASSETS_HINT =
  'Background filters need the segmentation model — run `pnpm vendor:mediapipe` on the server and rebuild the client.';
export const UNSUPPORTED_HINT =
  'This browser cannot run background filters (needs WebCodecs + WebGL2). Try current Chrome, or Firefox 133+.';

// ── The remembered choice + the custom image ─────────────────────────

export function savedFilter(): VideoFilterId {
  try {
    const id = localStorage.getItem(STORE_KEY) as VideoFilterId | null;
    if (id && VIDEO_FILTERS.some((f) => f.id === id)) {
      // A remembered "your image" is only usable while that image is still stored.
      return id === 'bg-custom' && !customBackground() ? 'none' : id;
    }
  } catch {
    /* localStorage unavailable */
  }
  return 'none';
}

function rememberFilter(id: VideoFilterId): void {
  try {
    localStorage.setItem(STORE_KEY, id);
  } catch {
    /* localStorage unavailable — the choice just won't survive a reload */
  }
}

/** The custom background, if one was picked (data URL). Kept in memory too, so an
 *  image too big for localStorage still works for this session. */
let customImage: string | null = null;

export function customBackground(): string | null {
  if (customImage) return customImage;
  try {
    customImage = localStorage.getItem(CUSTOM_KEY);
  } catch {
    customImage = null;
  }
  return customImage;
}

/** Take an uploaded image, scale/crop it to a 16:9 background and remember it. */
export async function setCustomBackgroundFromFile(file: File): Promise<string> {
  const bitmap = await createImageBitmap(file);
  const canvas = document.createElement('canvas');
  canvas.width = BG_W;
  canvas.height = BG_H;
  const c = canvas.getContext('2d');
  if (!c) throw new Error('no 2d canvas');
  // Cover-fit: fill the frame, crop the overflow (letterboxing would key in bars).
  const scale = Math.max(BG_W / bitmap.width, BG_H / bitmap.height);
  const w = bitmap.width * scale;
  const h = bitmap.height * scale;
  c.drawImage(bitmap, (BG_W - w) / 2, (BG_H - h) / 2, w, h);
  bitmap.close();
  const url = canvas.toDataURL('image/jpeg', 0.82);
  customImage = url;
  try {
    if (url.length <= CUSTOM_MAX_CHARS) localStorage.setItem(CUSTOM_KEY, url);
  } catch {
    /* quota / unavailable — session-only, which is better than failing the pick */
  }
  return url;
}

const generated = new Map<VideoFilterId, string>();

/** The image a preset keys in behind you (generated once, cached as a data URL). */
export function backgroundUrl(preset: VideoFilterPreset): string | null {
  if (preset.id === 'bg-custom') return customBackground();
  if (!preset.paint) return null;
  const cached = generated.get(preset.id);
  if (cached) return cached;
  const canvas = document.createElement('canvas');
  canvas.width = BG_W;
  canvas.height = BG_H;
  const c = canvas.getContext('2d');
  if (!c) return null;
  preset.paint(c, BG_W, BG_H);
  const url = canvas.toDataURL('image/jpeg', 0.86);
  generated.set(preset.id, url);
  return url;
}

// ── The generated backgrounds (no image files to ship) ───────────────

/** Deterministic pseudo-random, so a background looks the same every session. */
function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
}

/** Darken the edges — keeps a keyed-in person from looking pasted on. */
function vignette(c: CanvasRenderingContext2D, w: number, h: number, strength = 0.45): void {
  const g = c.createRadialGradient(w / 2, h / 2, Math.min(w, h) * 0.2, w / 2, h / 2, Math.max(w, h) * 0.72);
  g.addColorStop(0, 'rgba(0,0,0,0)');
  g.addColorStop(1, `rgba(0,0,0,${strength})`);
  c.fillStyle = g;
  c.fillRect(0, 0, w, h);
}

function paintBlue(c: CanvasRenderingContext2D, w: number, h: number): void {
  const g = c.createLinearGradient(0, 0, w * 0.3, h);
  g.addColorStop(0, '#2f66b0');
  g.addColorStop(0.55, '#1d3f74');
  g.addColorStop(1, '#0d1b33');
  c.fillStyle = g;
  c.fillRect(0, 0, w, h);
  // Soft highlight behind the head, like a studio backdrop.
  const spot = c.createRadialGradient(w / 2, h * 0.42, 0, w / 2, h * 0.42, h * 0.7);
  spot.addColorStop(0, 'rgba(120,175,235,0.35)');
  spot.addColorStop(1, 'rgba(120,175,235,0)');
  c.fillStyle = spot;
  c.fillRect(0, 0, w, h);
  vignette(c, w, h, 0.35);
}

/** The pixel-office palette: warm dark wall, a desk band, and a pixel grid. */
function paintOffice(c: CanvasRenderingContext2D, w: number, h: number): void {
  const g = c.createLinearGradient(0, 0, 0, h);
  g.addColorStop(0, '#3a3531');
  g.addColorStop(0.62, '#262422');
  g.addColorStop(0.62001, '#1b1917');
  g.addColorStop(1, '#141312');
  c.fillStyle = g;
  c.fillRect(0, 0, w, h);
  // Pixel grid on the wall (16 px cells, like the tiles in the world).
  c.strokeStyle = 'rgba(255,255,255,0.025)';
  c.lineWidth = 1;
  for (let x = 0; x <= w; x += 32) {
    c.beginPath();
    c.moveTo(x + 0.5, 0);
    c.lineTo(x + 0.5, h * 0.62);
    c.stroke();
  }
  for (let y = 0; y <= h * 0.62; y += 32) {
    c.beginPath();
    c.moveTo(0, y + 0.5);
    c.lineTo(w, y + 0.5);
    c.stroke();
  }
  // A framed poster and a plant silhouette, far enough out to stay behind you.
  c.fillStyle = '#c51a1b';
  c.fillRect(w * 0.08, h * 0.16, w * 0.11, h * 0.22);
  c.strokeStyle = '#0a0908';
  c.lineWidth = 6;
  c.strokeRect(w * 0.08, h * 0.16, w * 0.11, h * 0.22);
  c.fillStyle = '#2f5d3a';
  for (let i = 0; i < 7; i++) {
    const a = -Math.PI / 2 + (i - 3) * 0.32;
    c.beginPath();
    c.ellipse(w * 0.88, h * 0.52, w * 0.012, h * 0.13, a, 0, Math.PI * 2);
    c.fill();
  }
  c.fillStyle = '#6b4a2f';
  c.fillRect(w * 0.86, h * 0.55, w * 0.04, h * 0.09);
  vignette(c, w, h, 0.5);
}

function paintSpace(c: CanvasRenderingContext2D, w: number, h: number): void {
  c.fillStyle = '#05060b';
  c.fillRect(0, 0, w, h);
  const neb = c.createRadialGradient(w * 0.72, h * 0.28, 0, w * 0.72, h * 0.28, w * 0.6);
  neb.addColorStop(0, 'rgba(90,60,160,0.5)');
  neb.addColorStop(0.5, 'rgba(40,30,90,0.25)');
  neb.addColorStop(1, 'rgba(5,6,11,0)');
  c.fillStyle = neb;
  c.fillRect(0, 0, w, h);
  const rnd = lcg(0x51a5e);
  for (let i = 0; i < 420; i++) {
    const size = rnd() < 0.9 ? 2 : 3; // square stars — pixel-art, not anti-aliased dots
    c.fillStyle = `rgba(255,255,255,${(0.25 + rnd() * 0.75).toFixed(2)})`;
    c.fillRect(Math.floor(rnd() * w), Math.floor(rnd() * h), size, size);
  }
  vignette(c, w, h, 0.35);
}

// ── Applying a filter to the camera track ────────────────────────────

/**
 * Owns the one background processor for a call: which filter is chosen, and
 * keeping it attached to whatever camera track is currently published (the track
 * is replaced whenever the camera is toggled off/on or the device is switched).
 *
 * `select`/`attach` never throw — a failure falls back to "no filter" and reports
 * the reason through `onNotice`, because a broken filter must not cost you the
 * camera, let alone the meeting.
 */
export class CameraFilters {
  private id: VideoFilterId = savedFilter();
  private processor: BackgroundProcessorWrapper | null = null;
  /** The track the processor is attached to (LiveKit replaces it on re-publish). */
  private attached: LocalVideoTrack | null = null;
  /** Serialises select/attach — MediaPipe init is slow and re-entry corrupts it. */
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly onNotice?: (text: string) => void) {}

  get current(): VideoFilterId {
    return this.id;
  }

  /** Pick a filter and apply it to the current camera track (if any). Returns the
   *  filter actually in force, which is 'none' when applying failed. */
  async select(id: VideoFilterId, track: LocalVideoTrack | undefined): Promise<VideoFilterId> {
    this.id = filterPreset(id).id;
    rememberFilter(this.id);
    await this.attach(track);
    return this.id;
  }

  /** (Re-)apply the chosen filter to a camera track — call this after publishing,
   *  re-enabling or switching the camera. No track yet → remembered for later. */
  attach(track: LocalVideoTrack | undefined): Promise<void> {
    const run = this.queue.then(() => this.applyNow(track ?? null)).catch(() => undefined);
    this.queue = run;
    return run;
  }

  private async applyNow(track: LocalVideoTrack | null): Promise<void> {
    const preset = filterPreset(this.id);
    if (preset.kind === 'none') {
      await this.detach();
      return;
    }
    if (!track) return; // nothing published — attach() runs again on the next publish
    if (this.attached && this.attached !== track) await this.detach();
    const reason = !browserSupportsFilters()
      ? UNSUPPORTED_HINT
      : (await probeAssets())
        ? null
        : MISSING_ASSETS_HINT;
    if (reason) {
      this.fail(reason);
      return;
    }
    const options = this.optionsFor(preset);
    if (!options) {
      this.fail('That background image could not be loaded.');
      return;
    }
    try {
      if (this.processor) {
        await this.processor.switchTo(options);
      } else {
        const { BackgroundProcessor } = await import('@livekit/track-processors');
        this.processor = BackgroundProcessor({ ...options, assetPaths: ASSET_PATHS });
      }
      if (track.getProcessor() !== this.processor) {
        await track.setProcessor(this.processor);
        this.attached = track;
      }
    } catch (e) {
      this.fail(`Background filter failed: ${(e as Error)?.message || 'unknown error'}`);
    }
  }

  private optionsFor(preset: VideoFilterPreset): SwitchBackgroundProcessorOptions | null {
    if (preset.kind === 'blur') return { mode: 'background-blur', blurRadius: preset.blurRadius ?? 10 };
    const imagePath = backgroundUrl(preset);
    return imagePath ? { mode: 'virtual-background', imagePath } : null;
  }

  /** Give up on the filter: back to a plain camera, and say why. */
  private fail(text: string): void {
    this.id = 'none';
    rememberFilter('none');
    this.onNotice?.(text);
    void this.detach();
  }

  /** Detach + destroy the processor. A destroyed wrapper can't be reused, so the
   *  next filter builds a fresh one (a second of MediaPipe init, once). */
  private async detach(): Promise<void> {
    const track = this.attached;
    this.attached = null;
    const processor = this.processor;
    this.processor = null;
    try {
      if (track && processor && track.getProcessor() === processor) await track.stopProcessor();
      else await processor?.destroy();
    } catch {
      /* already gone */
    }
  }

  /** Called when the call ends — free the WASM/WebGL resources. */
  async destroy(): Promise<void> {
    this.queue = this.queue.then(() => this.detach()).catch(() => undefined);
    await this.queue;
  }
}
