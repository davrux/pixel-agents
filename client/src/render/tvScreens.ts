/**
 * What the televisions show, drawn over their glass.
 *
 * The server decides WHAT each television shows (`RoomState.tvScreens`, a URL plus frame size and
 * delays); this draws it and plays it. The frame phase is presentation timing and lives here
 * (invariant 2), exactly like the furniture's own animation — two viewers may be a frame apart,
 * and nothing depends on it.
 *
 * One texture per PICTURE, not per television and not packed into the runtime atlas. That is a
 * deliberate exception to the atlas rule (AGENTS.md, "Sprites reach the GPU through one runtime
 * atlas"), the same one uploaded background images take: a picture is a player's upload, up to
 * 2048×288, replaced whenever somebody walks up with another, and packing it into shared pages
 * would leave its old frames stranded there for the life of the tab. A texture is removed the
 * moment no television shows it any more, and two televisions showing the same picture share one.
 *
 * Drawn "contain": the whole picture, centred on the glass, with black around it where the aspect
 * differs — a television showing a letterboxed picture, rather than a picture cropped to fit.
 */
import Phaser from 'phaser';

import { tvFrameRect } from '@pixel/shared/office/tvScreen.js';

/** Where one television's glass is in the world, and the depth of the piece it belongs to. */
export interface TvTarget {
  key: string;
  x: number;
  y: number;
  w: number;
  h: number;
  depth: number;
}

/** What the server says one television shows (a copy of `TvScreenSync`). */
export interface TvShowing {
  src: string;
  frameW: number;
  frameH: number;
  delays: number[];
}

interface Picture {
  texKey: string;
  frames: number;
}

interface Shown {
  src: string;
  img: Phaser.GameObjects.Image;
  back: Phaser.GameObjects.Image;
  frame: number;
  startedAt: number;
  delays: number[];
  total: number;
}

export class TvScreenLayer {
  /** Loaded pictures by src. Bounded by what the zone shows: released in `reconcile`. */
  private readonly pictures = new Map<string, Picture>();
  /** Loads in flight, so a picture is fetched once however often reconcile runs meanwhile. */
  private readonly loading = new Set<string>();
  /** What is drawn, by television key. Deleted when a television stops showing anything. */
  private readonly shown = new Map<string, Shown>();
  private targets: TvTarget[] = [];
  private showing = new Map<string, TvShowing>();
  private nextTex = 0;

  constructor(
    private readonly scene: Phaser.Scene,
    /** Fetch a picture's bytes — through `serverFetch`, so the desktop app sends its bearer. */
    private readonly fetchPicture: (src: string) => Promise<Blob>,
    /** A picture finished loading while the loop may be asleep: something new to draw. */
    private readonly onReady: () => void,
  ) {}

  /** The televisions on the map and what the room says they show. Cheap to call; it diffs. */
  set(targets: TvTarget[], showing: Map<string, TvShowing>): void {
    this.targets = targets;
    this.showing = showing;
    this.reconcile();
  }

  /** Does any television play an animation? The scene keeps its loop awake for it. */
  animating(): boolean {
    for (const s of this.shown.values()) if (s.delays.length > 1) return true;
    return false;
  }

  /** Advance the animated pictures. A frame is set only when it changes. */
  update(nowMs: number): void {
    for (const s of this.shown.values()) {
      if (s.delays.length < 2 || s.total <= 0) continue;
      let t = (nowMs - s.startedAt) % s.total;
      let f = 0;
      while (f < s.delays.length - 1 && t >= s.delays[f]) t -= s.delays[f++];
      if (f === s.frame) continue;
      s.frame = f;
      s.img.setFrame(String(f), false, false);
    }
  }

  destroy(): void {
    for (const s of this.shown.values()) {
      s.img.destroy();
      s.back.destroy();
    }
    this.shown.clear();
    for (const p of this.pictures.values()) this.scene.textures.remove(p.texKey);
    this.pictures.clear();
  }

  private reconcile(): void {
    const wanted = new Set<string>();
    const live = new Set<string>();
    for (const t of this.targets) {
      const show = this.showing.get(t.key);
      if (!show) continue;
      wanted.add(show.src);
      const pic = this.pictures.get(show.src);
      if (!pic) {
        this.load(show);
        continue;
      }
      live.add(t.key);
      this.draw(t, show, pic);
    }
    for (const [key, s] of this.shown) {
      if (live.has(key)) continue;
      s.img.destroy();
      s.back.destroy();
      this.shown.delete(key);
    }
    for (const [src, p] of this.pictures) {
      if (wanted.has(src)) continue;
      this.scene.textures.remove(p.texKey);
      this.pictures.delete(src);
    }
  }

  private draw(t: TvTarget, show: TvShowing, pic: Picture): void {
    let s = this.shown.get(t.key);
    if (s && s.src !== show.src) {
      s.img.destroy();
      s.back.destroy();
      this.shown.delete(t.key);
      s = undefined;
    }
    if (!s) {
      const back = this.scene.add.image(0, 0, '__WHITE').setOrigin(0, 0).setTint(0x050505);
      const img = this.scene.add.image(0, 0, pic.texKey, '0').setOrigin(0.5, 0.5);
      const delays = show.delays.slice(0, pic.frames);
      s = { src: show.src, img, back, frame: 0, startedAt: this.scene.time.now, delays, total: delays.reduce((a, b) => a + b, 0) };
      this.shown.set(t.key, s);
    }
    // Contain: the largest size of the frame's aspect that fits the glass.
    const scale = Math.min(t.w / show.frameW, t.h / show.frameH);
    s.back.setPosition(t.x, t.y).setDisplaySize(t.w, t.h).setDepth(t.depth + 0.004);
    s.img
      .setPosition(t.x + t.w / 2, t.y + t.h / 2)
      .setDisplaySize(show.frameW * scale, show.frameH * scale)
      .setDepth(t.depth + 0.005);
  }

  private load(show: TvShowing): void {
    if (this.loading.has(show.src)) return;
    this.loading.add(show.src);
    void (async () => {
      try {
        const bitmap = await createImageBitmap(await this.fetchPicture(show.src));
        // Still wanted? A television can change its picture while the old one is downloading.
        const stillWanted = [...this.showing.values()].some((s) => s.src === show.src);
        if (!stillWanted || this.pictures.has(show.src)) {
          bitmap.close();
          return;
        }
        const key = `tv_${this.nextTex++}`;
        const tex = this.scene.textures.createCanvas(key, bitmap.width, bitmap.height);
        if (!tex) {
          bitmap.close();
          return;
        }
        tex.getContext().drawImage(bitmap, 0, 0);
        bitmap.close();
        // As many frames as the delays say AND the image actually holds — a picture is never
        // sliced past its own edge.
        const cols = Math.max(1, Math.floor(tex.width / show.frameW));
        const rows = Math.max(1, Math.floor(tex.height / show.frameH));
        const frames = Math.max(1, Math.min(show.delays.length, cols * rows));
        for (let i = 0; i < frames; i++) {
          const at = tvFrameRect(i, show.frameW, show.frameH, cols);
          tex.add(String(i), 0, at.x, at.y, show.frameW, show.frameH);
        }
        tex.refresh();
        // A photo scaled onto a few dozen pixels of glass: smooth it, unlike the pixel art around it.
        tex.setFilter(Phaser.Textures.FilterMode.LINEAR);
        this.pictures.set(show.src, { texKey: key, frames });
        this.reconcile();
        this.onReady();
      } catch (err) {
        console.warn('[tv] could not load a picture', err);
      } finally {
        this.loading.delete(show.src);
      }
    })();
  }
}
