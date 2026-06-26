import type { LoadedCharacterData } from '@pixel/shared/office/sprites/spriteData.js';
import type { SpriteData } from '@pixel/shared/office/types.js';

type Dir = 'down' | 'up' | 'right' | 'left';

export interface CharacterEditorOpts {
  /** Current raw character frames (down/up/right per palette). */
  getTemplates: () => LoadedCharacterData[] | null;
  /** Persist an edited/new character (name `char_<i>`). */
  save: (name: string, data: LoadedCharacterData) => void;
  /** Revert a character to its bundled default. */
  reset: (name: string) => void;
  /** Shared top-bar to host the button in (matches Edit/Layouts/Settings). */
  topbar?: HTMLElement;
}

/** Keep only printable ASCII, max 16 chars (for character display names). */
function sanitizeName(raw: string): string {
  return raw
    .replace(/[^\x20-\x7e]/g, '')
    .trim()
    .slice(0, 16);
}

const CELL = 13; // on-screen pixels per sprite pixel
const DIRS: Dir[] = ['down', 'up', 'right', 'left'];
const DIR_LABEL: Record<Dir, string> = { down: 'Front', up: 'Back', right: 'Right', left: 'Left' };
/** Frame index → label (walk 0-2, typing 3-4, reading 5-6, coffee 7+). */
function frameLabel(i: number): string {
  if (i <= 2) return `walk ${i + 1}`;
  if (i <= 4) return `type ${i - 2}`;
  if (i <= 6) return `read ${i - 4}`;
  return `coffee ${i - 6}`;
}

function emptyFrame(w: number, h: number): SpriteData {
  return Array.from({ length: h }, () => new Array<string>(w).fill(''));
}
function cloneFrame(f: SpriteData): SpriteData {
  return f.map((row) => row.slice());
}
/** Mirror a frame horizontally (for deriving left from right). */
function flipH(f: SpriteData): SpriteData {
  return f.map((row) => row.slice().reverse());
}
function cloneChar(c: LoadedCharacterData): LoadedCharacterData {
  const out: LoadedCharacterData = {
    down: c.down.map(cloneFrame),
    up: c.up.map(cloneFrame),
    right: c.right.map(cloneFrame),
  };
  if (c.left) out.left = c.left.map(cloneFrame);
  if (c.name) out.name = c.name;
  return out;
}

/**
 * In-browser pixel editor for character sprites. Edits the engine-native
 * SpriteData frames (16×32, down/up/right; left is auto-mirrored) and saves via
 * the asset-override protocol. The office re-renders live from the broadcast.
 */
export class CharacterEditor {
  private panel!: HTMLDivElement;
  private canvas!: HTMLCanvasElement;
  private strip!: HTMLDivElement;
  private picker!: HTMLSelectElement;
  private nameEl!: HTMLInputElement;

  private open = false;
  private charIndex = 0;
  private isNew = false;
  private dir: Dir = 'down';
  private frame = 0;
  private color = '#e0b48c';
  private tool: 'paint' | 'erase' | 'pick' = 'paint';
  private onion = true;
  private work: LoadedCharacterData = { down: [], up: [], right: [] };
  private W = 16;
  private H = 32;

  constructor(private readonly opts: CharacterEditorOpts) {
    this.build();
  }

  toggle(): void {
    this.open ? this.close() : this.show();
  }
  private show(): void {
    this.open = true;
    this.panel.style.display = 'block';
    this.refreshCharList();
    this.loadChar(this.charIndex);
  }
  private close(): void {
    this.open = false;
    this.panel.style.display = 'none';
  }

  // ── DOM ──────────────────────────────────────────────────────────
  private build(): void {
    const style = document.createElement('style');
    // Sizing mirrors the Settings/Edit panels (rem-based, larger fonts/buttons).
    style.textContent = `
      #pa-chars{position:fixed;top:3.4rem;right:0.5rem;z-index:61;display:none;width:26rem;background:#1b1f2a;
        border:2px solid #3a4150;border-radius:0.5rem;color:#eef1f6;padding:0.9rem;font-family:'FS Pixel Sans',monospace;
        box-shadow:0 4px 0 rgba(0,0,0,.4);max-height:92vh;overflow:auto;}
      #pa-chars h4{margin:0 0 0.6rem;font-size:1.25rem;color:#cdd3dd;}
      #pa-chars .row{display:flex;align-items:center;gap:0.5rem;margin:0.5rem 0;font-size:1rem;flex-wrap:wrap;}
      #pa-chars select,#pa-chars button,#pa-chars input[type=text]{background:#2a2f3a;border:1px solid #3a4150;color:#eef1f6;
        border-radius:0.3rem;font:1rem 'FS Pixel Sans',monospace;padding:0.4rem 0.6rem;cursor:pointer;}
      #pa-chars input[type=text]{cursor:text;}
      #pa-chars button.on{background:#3a6df0;border-color:#3a6df0;}
      #pa-chars .tab{padding:0.4rem 0.8rem;}
      #pa-chars .strip{display:flex;gap:0.35rem;flex-wrap:wrap;margin:0.5rem 0;}
      #pa-chars .strip .fr{display:flex;flex-direction:column;align-items:center;gap:0.15rem;font-size:0.75rem;color:#9aa3b2;cursor:pointer;}
      #pa-chars .strip .fr.sel canvas{outline:2px solid #3a6df0;}
      #pa-chars .strip canvas{background:#0d0f14;image-rendering:pixelated;border:1px solid #3a4150;}
      #pa-chars #pa-paint{image-rendering:pixelated;background:
        repeating-conic-gradient(#23262e 0% 25%, #1b1e25 0% 50%) 0/1rem 1rem;border:1px solid #3a4150;cursor:crosshair;touch-action:none;}
      #pa-chars .foot{display:flex;gap:0.5rem;margin-top:0.6rem;}
      #pa-chars .foot button{flex:1;padding:0.6rem;}
      #pa-chars input[type=color]{width:2.6rem;height:2rem;padding:0;border:1px solid #3a4150;background:none;cursor:pointer;}
      #pa-chars #pa-c-status{color:#7cfc9a;font-size:0.9rem;opacity:0;transition:opacity .4s;}
    `;
    document.head.appendChild(style);

    const btn = document.createElement('button');
    btn.id = 'pa-chars-btn';
    btn.className = 'pa-ui'; // styled by #pa-topbar button (matches Edit/Layouts/Settings)
    btn.textContent = '🎨 Chars';
    btn.onclick = () => this.toggle();

    const panel = document.createElement('div');
    panel.id = 'pa-chars';
    panel.className = 'pa-ui';
    panel.innerHTML = `
      <h4>Character editor</h4>
      <div class="row">
        <button id="pa-c-prev">◀</button>
        <select id="pa-c-sel"></select>
        <button id="pa-c-next">▶</button>
      </div>
      <div class="row"><label for="pa-c-name">Name</label>
        <input id="pa-c-name" type="text" maxlength="16" placeholder="char name" style="flex:1;min-width:0;"></div>
      <div class="row" id="pa-c-dirs"></div>
      <div class="strip" id="pa-c-strip"></div>
      <div class="row">
        <input id="pa-c-color" type="color" value="${this.color}">
        <button id="pa-c-paint" class="on">✏ Paint</button>
        <button id="pa-c-erase">⌫ Erase</button>
        <button id="pa-c-pick">⦿ Pick</button>
        <label style="margin-left:auto;font-size:14px;"><input id="pa-c-onion" type="checkbox" checked> Onion</label>
      </div>
      <div class="row"><canvas id="pa-paint"></canvas></div>
      <div class="row"><button id="pa-c-clear">Clear frame</button><button id="pa-c-addframe">+ Frame (all dirs)</button></div>
      <div class="row" style="justify-content:flex-end;min-height:16px;margin:0;">
        <span id="pa-c-status">​</span>
      </div>
      <div class="foot">
        <button id="pa-c-save" class="on">Save</button>
        <button id="pa-c-reset">Reset default</button>
        <button id="pa-c-close">Close</button>
      </div>`;

    const host = document.getElementById('game') ?? document.body;
    if (this.opts.topbar) this.opts.topbar.appendChild(btn);
    else host.appendChild(btn);
    host.appendChild(panel);
    this.panel = panel;
    this.canvas = panel.querySelector<HTMLCanvasElement>('#pa-paint')!;
    this.strip = panel.querySelector<HTMLDivElement>('#pa-c-strip')!;
    this.picker = panel.querySelector<HTMLSelectElement>('#pa-c-sel')!;

    // Direction tabs
    const dirsRow = panel.querySelector<HTMLDivElement>('#pa-c-dirs')!;
    for (const d of DIRS) {
      const b = document.createElement('button');
      b.className = 'tab';
      b.textContent = DIR_LABEL[d];
      b.onclick = () => {
        this.dir = d;
        this.frame = Math.min(this.frame, this.dirFrames(d).length - 1);
        this.render();
      };
      b.dataset.dir = d;
      dirsRow.appendChild(b);
    }

    // Wiring
    this.nameEl = panel.querySelector<HTMLInputElement>('#pa-c-name')!;
    this.nameEl.oninput = () => {
      const clean = sanitizeName(this.nameEl.value);
      if (clean !== this.nameEl.value) this.nameEl.value = clean;
      this.work.name = clean || undefined;
    };
    this.picker.onchange = () => this.loadChar(Number(this.picker.value));
    panel.querySelector<HTMLButtonElement>('#pa-c-prev')!.onclick = () =>
      this.loadChar(Math.max(0, this.charIndex - 1));
    panel.querySelector<HTMLButtonElement>('#pa-c-next')!.onclick = () => this.loadChar(this.charIndex + 1);
    const colorEl = panel.querySelector<HTMLInputElement>('#pa-c-color')!;
    colorEl.oninput = () => {
      this.color = colorEl.value;
      this.setTool('paint');
    };
    panel.querySelector<HTMLButtonElement>('#pa-c-paint')!.onclick = () => this.setTool('paint');
    panel.querySelector<HTMLButtonElement>('#pa-c-erase')!.onclick = () => this.setTool('erase');
    panel.querySelector<HTMLButtonElement>('#pa-c-pick')!.onclick = () => this.setTool('pick');
    panel.querySelector<HTMLInputElement>('#pa-c-onion')!.onchange = (e) => {
      this.onion = (e.target as HTMLInputElement).checked;
      this.render();
    };
    panel.querySelector<HTMLButtonElement>('#pa-c-clear')!.onclick = () => {
      const frames = this.dir === 'left' ? this.ensureLeft() : this.work[this.dir];
      frames[this.frame] = emptyFrame(this.W, this.H);
      this.render();
    };
    panel.querySelector<HTMLButtonElement>('#pa-c-addframe')!.onclick = () => {
      for (const d of ['down', 'up', 'right'] as const) this.work[d].push(emptyFrame(this.W, this.H));
      if (this.work.left) this.work.left.push(emptyFrame(this.W, this.H));
      this.frame = this.dirFrames(this.dir).length - 1;
      this.render();
    };
    panel.querySelector<HTMLButtonElement>('#pa-c-save')!.onclick = () => this.doSave();
    panel.querySelector<HTMLButtonElement>('#pa-c-reset')!.onclick = () => this.doReset();
    panel.querySelector<HTMLButtonElement>('#pa-c-close')!.onclick = () => this.close();

    this.bindPaint();
  }

  private setTool(t: 'paint' | 'erase' | 'pick'): void {
    this.tool = t;
    for (const [id, name] of [
      ['#pa-c-paint', 'paint'],
      ['#pa-c-erase', 'erase'],
      ['#pa-c-pick', 'pick'],
    ] as const) {
      this.panel.querySelector<HTMLButtonElement>(id)!.classList.toggle('on', t === name);
    }
  }

  // ── Data ─────────────────────────────────────────────────────────
  private refreshCharList(): void {
    const tpl = this.opts.getTemplates() ?? [];
    const n = tpl.length;
    this.picker.innerHTML = '';
    for (let i = 0; i < n; i++) {
      const o = document.createElement('option');
      o.value = String(i);
      const nm = tpl[i]?.name;
      o.textContent = nm ? `${nm} (char_${i})` : `char_${i}`;
      this.picker.appendChild(o);
    }
    const o = document.createElement('option');
    o.value = String(n);
    o.textContent = `+ new (char_${n})`;
    this.picker.appendChild(o);
  }

  private loadChar(index: number): void {
    const tpl = this.opts.getTemplates() ?? [];
    this.charIndex = Math.max(0, Math.min(index, tpl.length));
    this.isNew = this.charIndex >= tpl.length;
    if (this.isNew) {
      // Seed a new character from a copy of char_0 (so it has sane dimensions).
      const base = tpl[0];
      if (base) {
        this.work = cloneChar(base);
      } else {
        const blank = () => Array.from({ length: 7 }, () => emptyFrame(this.W, this.H));
        this.work = { down: blank(), up: blank(), right: blank() };
      }
    } else {
      this.work = cloneChar(tpl[this.charIndex]);
    }
    if (this.isNew) this.work.name = undefined; // name it fresh
    const f0 = this.work.down[1] ?? this.work.down[0];
    if (f0) {
      this.H = f0.length;
      this.W = f0[0]?.length ?? 16;
    }
    this.frame = Math.min(this.frame, this.dirFrames(this.dir).length - 1);
    this.picker.value = String(this.charIndex);
    if (this.nameEl) this.nameEl.value = this.work.name ?? '';
    this.render();
  }

  private charName(): string {
    return `char_${this.charIndex}`;
  }

  /** Frames for a direction; `left` mirrors `right` until explicitly edited. */
  private dirFrames(d: Dir): SpriteData[] {
    if (d === 'left') return this.work.left ?? this.work.right.map(flipH);
    return this.work[d];
  }

  /** Materialise `left` (seeded from mirrored right) so edits persist + save. */
  private ensureLeft(): SpriteData[] {
    if (!this.work.left) this.work.left = this.work.right.map(flipH);
    return this.work.left;
  }

  private showStatus(text: string): void {
    const el = this.panel.querySelector<HTMLSpanElement>('#pa-c-status');
    if (!el) return;
    el.textContent = text;
    el.style.opacity = '1';
    window.setTimeout(() => (el.style.opacity = '0'), 1600);
  }

  private displayName(): string {
    return this.work.name ? `${this.work.name} (${this.charName()})` : this.charName();
  }
  private doSave(): void {
    this.opts.save(this.charName(), this.work);
    this.refreshCharList(); // a brand-new char now exists for the next index
    this.showStatus(`Saved ${this.displayName()} ✓`);
  }
  private doReset(): void {
    if (this.isNew) {
      this.showStatus('Nothing to reset (unsaved)');
      return;
    }
    this.opts.reset(this.charName());
    this.showStatus(`Reset ${this.charName()} to default ✓`);
    // Reload after the server broadcast lands.
    setTimeout(() => {
      this.refreshCharList();
      this.loadChar(this.charIndex);
    }, 200);
  }

  // ── Rendering ────────────────────────────────────────────────────
  private render(): void {
    // Direction tab highlight
    this.panel.querySelectorAll<HTMLButtonElement>('#pa-c-dirs button').forEach((b) => {
      b.classList.toggle('on', b.dataset.dir === this.dir);
    });
    this.renderStrip();
    this.renderPaint();
  }

  private drawFrameTo(ctx: CanvasRenderingContext2D, f: SpriteData, cell: number, alpha = 1): void {
    ctx.globalAlpha = alpha;
    for (let y = 0; y < f.length; y++) {
      for (let x = 0; x < f[y].length; x++) {
        const c = f[y][x];
        if (!c) continue;
        ctx.fillStyle = c;
        ctx.fillRect(x * cell, y * cell, cell, cell);
      }
    }
    ctx.globalAlpha = 1;
  }

  private renderStrip(): void {
    const frames = this.dirFrames(this.dir);
    this.strip.innerHTML = '';
    frames.forEach((f, i) => {
      const wrap = document.createElement('div');
      wrap.className = 'fr' + (i === this.frame ? ' sel' : '');
      const c = document.createElement('canvas');
      c.width = this.W * 2;
      c.height = this.H * 2;
      this.drawFrameTo(c.getContext('2d')!, f, 2);
      const lab = document.createElement('span');
      lab.textContent = frameLabel(i);
      wrap.appendChild(c);
      wrap.appendChild(lab);
      wrap.onclick = () => {
        this.frame = i;
        this.render();
      };
      this.strip.appendChild(wrap);
    });
  }

  private renderPaint(): void {
    this.canvas.width = this.W * CELL;
    this.canvas.height = this.H * CELL;
    const ctx = this.canvas.getContext('2d')!;
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    // Onion skin: previous frame faint.
    const frames = this.dirFrames(this.dir);
    if (this.onion && this.frame > 0) {
      this.drawFrameTo(ctx, frames[this.frame - 1], CELL, 0.25);
    }
    this.drawFrameTo(ctx, frames[this.frame], CELL, 1);
    // Grid
    ctx.strokeStyle = 'rgba(255,255,255,0.06)';
    for (let x = 0; x <= this.W; x++) {
      ctx.beginPath();
      ctx.moveTo(x * CELL, 0);
      ctx.lineTo(x * CELL, this.H * CELL);
      ctx.stroke();
    }
    for (let y = 0; y <= this.H; y++) {
      ctx.beginPath();
      ctx.moveTo(0, y * CELL);
      ctx.lineTo(this.W * CELL, y * CELL);
      ctx.stroke();
    }
  }

  private bindPaint(): void {
    let painting = false;
    const at = (e: PointerEvent): { x: number; y: number } | null => {
      const r = this.canvas.getBoundingClientRect();
      const x = Math.floor(((e.clientX - r.left) / r.width) * this.W);
      const y = Math.floor(((e.clientY - r.top) / r.height) * this.H);
      if (x < 0 || y < 0 || x >= this.W || y >= this.H) return null;
      return { x, y };
    };
    const apply = (e: PointerEvent): void => {
      const p = at(e);
      if (!p) return;
      if (this.tool === 'pick') {
        const c = this.dirFrames(this.dir)[this.frame][p.y][p.x];
        if (c) {
          this.color = c.slice(0, 7);
          this.panel.querySelector<HTMLInputElement>('#pa-c-color')!.value = this.color;
          this.setTool('paint');
        }
        return;
      }
      // Painting left materialises it (seeded from mirrored right) so edits persist.
      const frames = this.dir === 'left' ? this.ensureLeft() : this.work[this.dir];
      frames[this.frame][p.y][p.x] = this.tool === 'erase' ? '' : this.color;
      this.renderPaint();
    };
    this.canvas.addEventListener('pointerdown', (e) => {
      painting = true;
      this.canvas.setPointerCapture(e.pointerId);
      apply(e);
    });
    this.canvas.addEventListener('pointermove', (e) => {
      if (painting && this.tool !== 'pick') apply(e);
    });
    this.canvas.addEventListener('pointerup', () => {
      painting = false;
      this.renderStrip();
    });
  }
}
