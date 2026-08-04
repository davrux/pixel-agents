/**
 * Character Creator — a layered avatar generator + light editor, built on the
 * MetroCity part sheets (see characterParts.ts). Pick skin / hair / outfit, watch
 * a live animated preview (walk + the synthesised typing/reading/coffee tracks),
 * then save it as your own avatar (`pa:<user>`). A standalone overlay in the shared
 * pixel-menu look; the classic CharacterEditor is left untouched.
 */
import type { LoadedCharacterData } from '@pixel/shared/office/sprites/spriteData.js';
import type { SpriteData } from '@pixel/shared/office/types.js';
import {
  composeAvatar,
  composeFrame,
  loadPartSheets,
  FRAME,
  SKIN_COUNT,
  HAIR_COUNT,
  OUTFIT_COUNT,
  type PartSheets,
  type PartSelection,
} from './characterParts.js';

export interface CharacterCreatorOpts {
  /** Persist the composed avatar (OfficeScene → room.send('saveAvatar', {data})). */
  save: (data: LoadedCharacterData) => void;
  /** Hand the composed avatar to the classic pixel editor for fine-tuning
   *  (paint + copy/paste). OfficeScene saves it, then opens it as "me". */
  editPixels?: (data: LoadedCharacterData) => void;
}

/** Placeholder metadata name — the in-world name is always the display name. */
const AVATAR_NAME = 'Avatar';

type Facing = 'down' | 'right' | 'up' | 'left';
type Track = 'walk' | 'idle' | 'typing' | 'reading' | 'coffee';
// Track slots in the flat per-direction frame list (see generatedSpec()).
const SLOT: Record<Track, [number, number]> = {
  walk: [0, 5],
  idle: [5, 6],
  typing: [6, 8],
  reading: [8, 10],
  coffee: [10, 12],
};
const TRACKS: { key: Track; label: string }[] = [
  { key: 'walk', label: '🚶 Walk' },
  { key: 'idle', label: '🧍 Idle' },
  { key: 'typing', label: '⌨ Typing' },
  { key: 'reading', label: '📖 Reading' },
  { key: 'coffee', label: '☕ Coffee' },
];
const DIRS: { key: Facing; label: string }[] = [
  { key: 'down', label: '↓' },
  { key: 'right', label: '→' },
  { key: 'up', label: '↑' },
  { key: 'left', label: '←' },
];

const CSS = `
  #pa-cc{position:fixed;left:50%;top:50%;transform:translate(-50%,-50%);z-index:88;display:none;
    width:min(94vw,52rem);max-height:92vh;flex-direction:column;background:#1c1a19;border:2px solid #0a0908;
    border-radius:0.6rem;color:#f1efec;font-family:'FS Pixel Sans',ui-monospace,monospace;overflow:hidden;
    box-shadow:inset 0 2px 0 #292725,inset 0 -3px 0 #030303,0 12px 28px rgba(0,0,0,.55);}
  #pa-cc.open{display:flex;}
  #pa-cc .cc-head{display:flex;align-items:center;gap:0.6rem;padding:0.6rem 0.85rem;background:#1c1a19;
    border-bottom:2px solid #0a0908;box-shadow:inset 0 -1px 0 #2c2a28;}
  #pa-cc .cc-head h4{margin:0;font-size:1.25rem;color:#f5f3f0;font-weight:600;letter-spacing:.3px;}
  #pa-cc .cc-x{margin-left:auto;width:1.7rem;height:1.7rem;display:flex;align-items:center;justify-content:center;
    background:#262422;border:2px solid #0a0908;border-radius:0.35rem;cursor:pointer;color:#d7d9da;
    box-shadow:inset 0 2px 0 #4a4744,inset 0 -3px 0 #050505;}
  #pa-cc .cc-body{flex:1;display:flex;gap:0.9rem;padding:0.9rem;min-height:0;overflow:auto;flex-wrap:wrap;}
  #pa-cc .cc-preview{flex:0 0 auto;display:flex;flex-direction:column;align-items:center;gap:0.5rem;}
  #pa-cc .cc-stage{background:#141312;border:2px solid #0a0908;border-radius:0.45rem;
    box-shadow:inset 0 2px 0 #292725,inset 0 -3px 0 #030303;padding:0.4rem;}
  #pa-cc canvas.cc-view{image-rendering:pixelated;display:block;}
  #pa-cc .cc-seg{display:flex;gap:0.3rem;background:#141312;border:2px solid #0a0908;border-radius:0.5rem;padding:0.25rem;}
  #pa-cc .cc-seg button{background:transparent;border:0;color:#adb0b2;cursor:pointer;border-radius:0.35rem;
    font:0.95rem 'FS Pixel Sans',monospace;padding:0.35rem 0.55rem;}
  #pa-cc .cc-seg button.on{color:#fff;background:#37342f;box-shadow:inset 0 2px 0 rgba(255,255,255,.14),inset 0 -2px 0 rgba(0,0,0,.35);}
  #pa-cc .cc-controls{flex:1;min-width:15rem;display:flex;flex-direction:column;gap:0.5rem;}
  #pa-cc .grouplbl{font-size:0.72rem;letter-spacing:1px;color:#818586;margin:0.4rem 0.15rem 0.1rem;text-transform:uppercase;}
  #pa-cc .cc-swatches{display:flex;gap:0.4rem;flex-wrap:wrap;}
  #pa-cc .cc-sw{background:#141312;border:2px solid #0a0908;border-radius:0.35rem;cursor:pointer;padding:0.15rem;
    display:flex;align-items:flex-end;justify-content:center;box-shadow:inset 0 2px 0 #4a4744,inset 0 -3px 0 #050505;}
  #pa-cc .cc-sw.on{border-color:#e2585a;box-shadow:0 0 0 2px #e2585a inset;}
  #pa-cc .cc-sw canvas{image-rendering:pixelated;display:block;}
  #pa-cc .cc-sw.none{width:2.6rem;height:3.4rem;color:#818586;align-items:center;font-size:0.8rem;}
  #pa-cc .cc-foot{display:flex;align-items:center;gap:0.6rem;padding:0.7rem 0.9rem;background:#1c1a19;
    border-top:2px solid #0a0908;box-shadow:inset 0 1px 0 #2c2a28;}
  #pa-cc .cc-foot .cc-hint{flex:1;min-width:0;color:#818586;font-size:0.8rem;}
  #pa-cc .cc-b{padding:0.5rem 0.9rem;font:0.95rem 'FS Pixel Sans',monospace;color:#f1efec;background:#262422;
    border:2px solid #0a0908;border-radius:0.4rem;cursor:pointer;box-shadow:inset 0 2px 0 #4a4744,inset 0 -3px 0 #050505;}
  #pa-cc .cc-b.primary{background:#c51a1b;color:#fff;box-shadow:inset 0 2px 0 #e2585a,inset 0 -3px 0 #5c0f10;}
  #pa-cc .cc-loading{padding:2rem;color:#adb0b2;text-align:center;}
`;

const VIEW_SCALE = 7;
const SWATCH_SCALE = 2;

export class CharacterCreator {
  private readonly opts: CharacterCreatorOpts;
  private root!: HTMLDivElement;
  private sheets: PartSheets | null = null;
  private sel: PartSelection = { skin: 0, hair: 0, outfit: 0 };
  private avatar: LoadedCharacterData | null = null;
  private facing: Facing = 'down';
  private track: Track = 'walk';
  private anim = 0;
  private timer: number | null = null;
  private lastTick = 0;
  private built = false;

  constructor(opts: CharacterCreatorOpts) {
    this.opts = opts;
    if (!document.getElementById('pa-cc-style')) {
      const s = document.createElement('style');
      s.id = 'pa-cc-style';
      s.textContent = CSS;
      document.head.appendChild(s);
    }
    const root = document.createElement('div');
    root.id = 'pa-cc';
    root.className = 'pa-ui';
    root.innerHTML = `
      <div class="cc-head"><h4>✨ Create Character</h4><div class="cc-x" title="Close">✕</div></div>
      <div class="cc-loading">Loading parts…</div>`;
    (document.getElementById('game') ?? document.body).appendChild(root);
    this.root = root;
    root.querySelector<HTMLDivElement>('.cc-x')!.onclick = () => this.close();
  }

  async open(): Promise<void> {
    this.root.classList.add('open');
    if (!this.sheets) {
      try {
        this.sheets = await loadPartSheets();
      } catch {
        this.root.querySelector('.cc-loading')!.textContent = 'Could not load character parts.';
        return;
      }
    }
    if (!this.built) this.build();
    this.recompose();
    this.startAnim();
  }

  close(): void {
    this.root.classList.remove('open');
    this.stopAnim();
  }

  isOpen(): boolean {
    return this.root.classList.contains('open');
  }

  // ── build the UI once the sheets are ready ──────────────────────────────────
  private build(): void {
    this.built = true;
    this.root.querySelector('.cc-loading')?.remove();
    const body = document.createElement('div');
    body.className = 'cc-body';
    body.innerHTML = `
      <div class="cc-preview">
        <div class="cc-stage"><canvas class="cc-view"></canvas></div>
        <div class="cc-seg cc-dirs"></div>
        <div class="cc-seg cc-tracks"></div>
      </div>
      <div class="cc-controls">
        <div class="grouplbl">Skin</div><div class="cc-swatches" data-g="skin"></div>
        <div class="grouplbl">Hair</div><div class="cc-swatches" data-g="hair"></div>
        <div class="grouplbl">Outfit</div><div class="cc-swatches" data-g="outfit"></div>
      </div>`;
    this.root.appendChild(body);

    const foot = document.createElement('div');
    foot.className = 'cc-foot';
    // The in-world name is always the player's display name (server-enforced), so
    // the creator has no name field — this just picks the look.
    const hint = document.createElement('div');
    hint.className = 'cc-hint';
    hint.textContent = 'Saves as your avatar. Your display name is set in Settings.';
    const cancel = document.createElement('button');
    cancel.className = 'cc-b';
    cancel.textContent = 'Cancel';
    cancel.onclick = () => this.close();
    const btns: HTMLButtonElement[] = [cancel];
    if (this.opts.editPixels) {
      const edit = document.createElement('button');
      edit.className = 'cc-b';
      edit.textContent = '✎ Edit pixels';
      edit.title = 'Save, then fine-tune the frames (paint + copy/paste) in the editor';
      edit.onclick = () => this.editPixels();
      btns.push(edit);
    }
    const save = document.createElement('button');
    save.className = 'cc-b primary';
    save.textContent = '✔ Save as my avatar';
    save.onclick = () => this.save();
    btns.push(save);
    foot.append(hint, ...btns);
    this.root.appendChild(foot);

    const view = this.root.querySelector<HTMLCanvasElement>('.cc-view')!;
    view.width = FRAME * VIEW_SCALE;
    view.height = FRAME * VIEW_SCALE;

    const dirs = this.root.querySelector<HTMLDivElement>('.cc-dirs')!;
    for (const d of DIRS) {
      const b = document.createElement('button');
      b.textContent = d.label;
      b.classList.toggle('on', d.key === this.facing);
      b.onclick = () => {
        this.facing = d.key;
        this.anim = 0;
        dirs.querySelectorAll('button').forEach((x, i) => x.classList.toggle('on', DIRS[i].key === d.key));
      };
      dirs.appendChild(b);
    }
    const tracks = this.root.querySelector<HTMLDivElement>('.cc-tracks')!;
    for (const t of TRACKS) {
      const b = document.createElement('button');
      b.textContent = t.label;
      b.classList.toggle('on', t.key === this.track);
      b.onclick = () => {
        this.track = t.key;
        this.anim = 0;
        tracks.querySelectorAll('button').forEach((x, i) => x.classList.toggle('on', TRACKS[i].key === t.key));
      };
      tracks.appendChild(b);
    }
    this.renderSwatches();
  }

  // ── swatch pickers (thumbnails re-render when the skin changes) ──────────────
  private renderSwatches(): void {
    if (!this.sheets) return;
    this.buildSwatchRow('skin', SKIN_COUNT, false, (i) => ({ skin: i, hair: -1, outfit: -1 }));
    this.buildSwatchRow('hair', HAIR_COUNT, true, (i) => ({ skin: this.sel.skin, hair: i, outfit: -1 }));
    this.buildSwatchRow('outfit', OUTFIT_COUNT, true, (i) => ({ skin: this.sel.skin, hair: -1, outfit: i }));
  }

  private buildSwatchRow(
    group: 'skin' | 'hair' | 'outfit',
    count: number,
    hasNone: boolean,
    previewSel: (i: number) => PartSelection,
  ): void {
    const wrap = this.root.querySelector<HTMLDivElement>(`.cc-swatches[data-g="${group}"]`);
    if (!wrap || !this.sheets) return;
    wrap.innerHTML = '';
    // The index each swatch element selects (in DOM order): the leading "none"
    // tile is -1, the rest are 0..count-1.
    const indexAt = (k: number): number => (hasNone ? k - 1 : k);
    const highlight = (): void =>
      wrap.querySelectorAll('.cc-sw').forEach((x, k) => x.classList.toggle('on', indexAt(k) === this.sel[group]));
    const pick = (i: number): void => {
      this.sel[group] = i;
      // Changing the skin re-tints the hair/outfit thumbnails (which rebuild + rehighlight).
      if (group === 'skin') this.renderSwatches();
      else highlight();
      this.recompose();
    };
    if (hasNone) {
      const none = document.createElement('div');
      none.className = 'cc-sw none';
      none.textContent = '∅';
      none.onclick = () => pick(-1);
      wrap.appendChild(none);
    }
    for (let i = 0; i < count; i++) {
      const el = document.createElement('div');
      el.className = 'cc-sw';
      const cv = document.createElement('canvas');
      cv.width = FRAME * SWATCH_SCALE;
      cv.height = FRAME * SWATCH_SCALE;
      drawSprite(cv.getContext('2d')!, composeFrame(this.sheets, previewSel(i), 0), SWATCH_SCALE, false);
      el.appendChild(cv);
      el.onclick = () => pick(i);
      wrap.appendChild(el);
    }
    highlight();
  }

  private recompose(): void {
    if (!this.sheets) return;
    this.avatar = composeAvatar(this.sheets, this.sel, AVATAR_NAME);
  }

  // ── animated preview ────────────────────────────────────────────────────────
  private startAnim(): void {
    if (this.timer != null) return;
    const step = (t: number): void => {
      if (!this.isOpen()) {
        this.timer = null;
        return;
      }
      if (t - this.lastTick > 150) {
        this.lastTick = t;
        this.anim++;
        this.drawView();
      }
      this.timer = requestAnimationFrame(step);
    };
    this.timer = requestAnimationFrame(step);
  }
  private stopAnim(): void {
    if (this.timer != null) cancelAnimationFrame(this.timer);
    this.timer = null;
  }

  private drawView(): void {
    if (!this.avatar) return;
    const view = this.root.querySelector<HTMLCanvasElement>('.cc-view');
    if (!view) return;
    const mirror = this.facing === 'left';
    const dirData =
      mirror || this.facing === 'right'
        ? this.avatar.right
        : this.facing === 'up'
          ? this.avatar.up
          : this.avatar.down;
    const [start, end] = SLOT[this.track];
    const frames = dirData.slice(start, end);
    if (!frames.length) return;
    const frame = frames[this.anim % frames.length];
    const g = view.getContext('2d')!;
    g.clearRect(0, 0, view.width, view.height);
    drawSprite(g, frame, VIEW_SCALE, mirror);
  }

  private save(): void {
    if (!this.sheets) return;
    this.opts.save(composeAvatar(this.sheets, this.sel, AVATAR_NAME));
    this.close();
  }

  private editPixels(): void {
    if (!this.sheets || !this.opts.editPixels) return;
    this.opts.editPixels(composeAvatar(this.sheets, this.sel, AVATAR_NAME));
    this.close();
  }
}

/** Paint a SpriteData grid onto a 2D canvas at `scale`, optionally mirrored. */
function drawSprite(g: CanvasRenderingContext2D, sprite: SpriteData, scale: number, mirror: boolean): void {
  const w = sprite[0]?.length ?? 0;
  for (let y = 0; y < sprite.length; y++) {
    for (let x = 0; x < w; x++) {
      const c = sprite[y][x];
      if (!c) continue;
      g.fillStyle = c;
      const dx = mirror ? (w - 1 - x) : x;
      g.fillRect(dx * scale, y * scale, scale, scale);
    }
  }
}
