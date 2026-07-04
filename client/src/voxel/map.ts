/**
 * Travel map (M): a top-down view of the WHOLE world, painted from the seed
 * (`colorAt` returns a colour for any x,z — no "unexplored" gaps). Scroll to zoom,
 * drag to pan, click a spot to travel there (server-authoritative teleport), double-
 * click to re-centre on the player. The player heading arrow tracks its real position
 * even when the view is panned away.
 */
export interface MapDeps {
  /** Top-surface colour (0xRRGGBB) at column (x,z) — always defined (full world). */
  colorAt: (x: number, z: number) => number | null;
  player: () => { x: number; z: number; yaw: number };
  onTravel: (x: number, z: number) => void;
  onOpen?: () => void;
  onClose?: () => void;
}

const SIZE = 480; // displayed canvas pixels (square)
const RES = 256; // internal sample resolution (scaled up to SIZE — keeps render fast at any zoom)
const MIN_RANGE = 24; // most zoomed-in: blocks shown each way
const MAX_RANGE = 2400; // most zoomed-out

export class TravelMap {
  private readonly root: HTMLDivElement;
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly buf: HTMLCanvasElement; // offscreen RES×RES sample buffer
  private readonly bctx: CanvasRenderingContext2D;
  private open = false;
  private range = 96; // current half-extent in blocks (zoom)
  private cx = 0; // world coord at the map centre (pans away from the player)
  private cz = 0;
  private drag: { x: number; y: number; cx: number; cz: number; moved: boolean } | null = null;

  constructor(private readonly deps: MapDeps) {
    const style = document.createElement('style');
    style.textContent = `
      #vx-map{position:fixed;inset:0;z-index:150;display:none;align-items:center;justify-content:center;
        background:rgba(0,0,0,.55);font-family:'FS Pixel Sans',ui-monospace,monospace;color:#fff;}
      #vx-map.open{display:flex;}
      #vx-map .win{background:#2b2b2b;border:4px solid #1c1c1c;border-radius:6px;box-shadow:0 8px 0 rgba(0,0,0,.5);padding:.8rem;}
      #vx-map .hd{display:flex;align-items:center;gap:.6rem;margin-bottom:.6rem;}
      #vx-map .hd h3{margin:0;font-size:1.05rem;text-shadow:1px 1px 0 #000;}
      #vx-map .hd .btn{cursor:pointer;padding:.15rem .5rem;background:#3a3a3a;border:3px solid #1c1c1c;border-radius:4px;font-size:.72rem;}
      #vx-map .hd .x{margin-left:auto;cursor:pointer;width:1.6rem;height:1.6rem;display:flex;align-items:center;
        justify-content:center;background:#3a3a3a;border:3px solid #1c1c1c;border-radius:4px;}
      #vx-map canvas{display:block;image-rendering:pixelated;cursor:grab;border:3px solid #1c1c1c;background:#11151c;}
      #vx-map canvas.grabbing{cursor:grabbing;}
      #vx-map .tip{margin-top:.5rem;font-size:.72rem;color:#cfcfcf;text-align:center;}`;
    document.head.appendChild(style);
    this.root = document.createElement('div');
    this.root.id = 'vx-map';
    this.root.innerHTML = `<div class="win"><div class="hd"><h3>World map</h3><div class="btn center" title="Re-centre on you">⌖ You</div><div class="x" title="Close (M / Esc)">✕</div></div><div class="tip">Drag to pan · scroll to zoom · click to travel · double-click / ⌖ to re-centre</div></div>`;
    this.canvas = document.createElement('canvas');
    this.canvas.width = this.canvas.height = SIZE;
    this.root.querySelector('.win')!.insertBefore(this.canvas, this.root.querySelector('.tip'));
    (document.getElementById('game') ?? document.body).appendChild(this.root);
    this.ctx = this.canvas.getContext('2d')!;
    this.ctx.imageSmoothingEnabled = false;
    this.buf = document.createElement('canvas');
    this.buf.width = this.buf.height = RES;
    this.bctx = this.buf.getContext('2d')!;

    this.root.querySelector<HTMLElement>('.x')!.onclick = () => this.close();
    this.root.querySelector<HTMLElement>('.center')!.onclick = () => this.recenter();
    this.root.addEventListener('mousedown', (e) => {
      if (e.target === this.root) this.close();
    });
    this.canvas.addEventListener('mousedown', (e) => this.onDown(e));
    window.addEventListener('mousemove', (e) => this.onMove(e));
    window.addEventListener('mouseup', (e) => this.onUp(e));
    this.canvas.addEventListener('dblclick', () => this.recenter());
    this.canvas.addEventListener('wheel', (e) => {
      e.preventDefault();
      const f = e.deltaY > 0 ? 1.25 : 1 / 1.25; // out / in
      this.range = Math.max(MIN_RANGE, Math.min(MAX_RANGE, Math.round(this.range * f)));
      this.render();
    });
  }

  isOpen(): boolean {
    return this.open;
  }
  toggle(): void {
    this.open ? this.close() : this.show();
  }
  show(): void {
    this.open = true;
    this.root.classList.add('open');
    this.recenter(); // start centred on the player
    this.deps.onOpen?.();
  }
  close(): void {
    if (!this.open) return;
    this.open = false;
    this.drag = null;
    this.root.classList.remove('open');
    this.deps.onClose?.();
  }
  private recenter(): void {
    const p = this.deps.player();
    this.cx = p.x;
    this.cz = p.z;
    this.render();
  }

  /** Repaint the full-world view at the current centre + zoom. */
  render(): void {
    if (!this.open) return;
    const span = this.range * 2;
    const ox = this.cx - this.range;
    const oz = this.cz - this.range;
    const step = span / RES;
    const img = this.bctx.createImageData(RES, RES);
    for (let iz = 0; iz < RES; iz++) {
      const wz = Math.floor(oz + iz * step);
      for (let ix = 0; ix < RES; ix++) {
        const c = this.deps.colorAt(Math.floor(ox + ix * step), wz);
        const o = (iz * RES + ix) * 4;
        img.data[o] = c == null ? 17 : (c >> 16) & 255;
        img.data[o + 1] = c == null ? 21 : (c >> 8) & 255;
        img.data[o + 2] = c == null ? 28 : c & 255;
        img.data[o + 3] = 255;
      }
    }
    this.bctx.putImageData(img, 0, 0);
    this.ctx.clearRect(0, 0, SIZE, SIZE);
    this.ctx.drawImage(this.buf, 0, 0, SIZE, SIZE);
    // Player marker (its real position, mapped to screen — may sit off-centre when panned).
    const p = this.deps.player();
    const sx = ((p.x - ox) / span) * SIZE;
    const sy = ((p.z - oz) / span) * SIZE;
    if (sx >= -8 && sx <= SIZE + 8 && sy >= -8 && sy <= SIZE + 8) {
      this.ctx.save();
      this.ctx.translate(sx, sy);
      this.ctx.rotate(-p.yaw);
      this.ctx.fillStyle = '#fff';
      this.ctx.strokeStyle = '#000';
      this.ctx.lineWidth = 1.5;
      this.ctx.beginPath();
      this.ctx.moveTo(0, -8);
      this.ctx.lineTo(6, 7);
      this.ctx.lineTo(0, 3);
      this.ctx.lineTo(-6, 7);
      this.ctx.closePath();
      this.ctx.fill();
      this.ctx.stroke();
      this.ctx.restore();
    }
  }

  private onDown(e: MouseEvent): void {
    this.drag = { x: e.clientX, y: e.clientY, cx: this.cx, cz: this.cz, moved: false };
    this.canvas.classList.add('grabbing');
  }
  private onMove(e: MouseEvent): void {
    if (!this.drag) return;
    const dx = e.clientX - this.drag.x;
    const dy = e.clientY - this.drag.y;
    if (Math.abs(dx) + Math.abs(dy) > 3) this.drag.moved = true;
    const worldPerPx = (this.range * 2) / SIZE;
    this.cx = this.drag.cx - dx * worldPerPx; // drag right → view content moves right
    this.cz = this.drag.cz - dy * worldPerPx;
    this.render();
  }
  private onUp(e: MouseEvent): void {
    if (!this.drag) return;
    const wasDrag = this.drag.moved;
    this.canvas.classList.remove('grabbing');
    this.drag = null;
    if (wasDrag) return; // a pan, not a click
    const rect = this.canvas.getBoundingClientRect();
    if (e.clientX < rect.left || e.clientX > rect.right || e.clientY < rect.top || e.clientY > rect.bottom) return;
    const span = this.range * 2;
    const wx = Math.floor(this.cx - this.range + ((e.clientX - rect.left) / rect.width) * span);
    const wz = Math.floor(this.cz - this.range + ((e.clientY - rect.top) / rect.height) * span);
    this.deps.onTravel(wx, wz);
    this.close();
  }
}
