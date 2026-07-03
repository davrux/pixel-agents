/**
 * Travel map (M): a top-down minimap of everything you've explored (a persistent
 * colour cache the caller fills as chunks load), centred on the player with a heading
 * arrow. Scroll to zoom in/out; click a spot to travel there (server-authoritative
 * teleport). Unexplored area is dark.
 */
export interface MapDeps {
  /** Cached top-block colour (0xRRGGBB) at explored column (x,z), or null. */
  colorAt: (x: number, z: number) => number | null;
  player: () => { x: number; z: number; yaw: number };
  onTravel: (x: number, z: number) => void;
  onOpen?: () => void;
  onClose?: () => void;
}

const SIZE = 420; // canvas pixels (square)
const MIN_RANGE = 32; // most zoomed-in: blocks shown each way
const MAX_RANGE = 384; // most zoomed-out

export class TravelMap {
  private readonly root: HTMLDivElement;
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private open = false;
  private range = 72; // current half-extent in blocks (zoom)

  constructor(private readonly deps: MapDeps) {
    const style = document.createElement('style');
    style.textContent = `
      #vx-map{position:fixed;inset:0;z-index:150;display:none;align-items:center;justify-content:center;
        background:rgba(0,0,0,.55);font-family:'FS Pixel Sans',ui-monospace,monospace;color:#fff;}
      #vx-map.open{display:flex;}
      #vx-map .win{background:#2b2b2b;border:4px solid #1c1c1c;border-radius:6px;box-shadow:0 8px 0 rgba(0,0,0,.5);padding:.8rem;}
      #vx-map .hd{display:flex;align-items:center;gap:.6rem;margin-bottom:.6rem;}
      #vx-map .hd h3{margin:0;font-size:1.05rem;text-shadow:1px 1px 0 #000;}
      #vx-map .hd .x{margin-left:auto;cursor:pointer;width:1.6rem;height:1.6rem;display:flex;align-items:center;
        justify-content:center;background:#3a3a3a;border:3px solid #1c1c1c;border-radius:4px;}
      #vx-map canvas{display:block;image-rendering:pixelated;cursor:crosshair;border:3px solid #1c1c1c;background:#11151c;}
      #vx-map .tip{margin-top:.5rem;font-size:.72rem;color:#cfcfcf;text-align:center;}`;
    document.head.appendChild(style);
    this.root = document.createElement('div');
    this.root.id = 'vx-map';
    this.root.innerHTML = `<div class="win"><div class="hd"><h3>Map — click to travel</h3><div class="x" title="Close (M / Esc)">✕</div></div><div class="tip">Scroll to zoom · click a spot to travel · dark = unexplored</div></div>`;
    this.canvas = document.createElement('canvas');
    this.canvas.width = this.canvas.height = SIZE;
    this.root.querySelector('.win')!.insertBefore(this.canvas, this.root.querySelector('.tip'));
    (document.getElementById('game') ?? document.body).appendChild(this.root);
    this.ctx = this.canvas.getContext('2d')!;
    this.ctx.imageSmoothingEnabled = false;

    this.root.querySelector<HTMLElement>('.x')!.onclick = () => this.close();
    this.root.addEventListener('mousedown', (e) => {
      if (e.target === this.root) this.close();
    });
    this.canvas.addEventListener('click', (e) => this.onClick(e));
    this.canvas.addEventListener('wheel', (e) => {
      e.preventDefault();
      const f = e.deltaY > 0 ? 1.2 : 1 / 1.2; // out / in
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
    this.deps.onOpen?.();
    this.render();
  }
  close(): void {
    if (!this.open) return;
    this.open = false;
    this.root.classList.remove('open');
    this.deps.onClose?.();
  }

  /** Repaint the explored cache within the current zoom, centred on the player. */
  render(): void {
    if (!this.open) return;
    const { x: cxp, z: czp, yaw } = this.deps.player();
    const span = this.range * 2;
    const ox = Math.floor(cxp) - this.range;
    const oz = Math.floor(czp) - this.range;
    const img = this.ctx.createImageData(span, span);
    for (let iz = 0; iz < span; iz++) {
      for (let ix = 0; ix < span; ix++) {
        const c = this.deps.colorAt(ox + ix, oz + iz);
        const o = (iz * span + ix) * 4;
        img.data[o] = c == null ? 17 : (c >> 16) & 255;
        img.data[o + 1] = c == null ? 21 : (c >> 8) & 255;
        img.data[o + 2] = c == null ? 28 : c & 255;
        img.data[o + 3] = 255;
      }
    }
    const tmp = document.createElement('canvas');
    tmp.width = tmp.height = span;
    tmp.getContext('2d')!.putImageData(img, 0, 0);
    this.ctx.clearRect(0, 0, SIZE, SIZE);
    this.ctx.drawImage(tmp, 0, 0, SIZE, SIZE);
    // Player heading arrow at centre.
    this.ctx.save();
    this.ctx.translate(SIZE / 2, SIZE / 2);
    this.ctx.rotate(-yaw);
    this.ctx.fillStyle = '#fff';
    this.ctx.strokeStyle = '#000';
    this.ctx.lineWidth = 1.5;
    this.ctx.beginPath();
    this.ctx.moveTo(0, -7);
    this.ctx.lineTo(5, 6);
    this.ctx.lineTo(0, 3);
    this.ctx.lineTo(-5, 6);
    this.ctx.closePath();
    this.ctx.fill();
    this.ctx.stroke();
    this.ctx.restore();
  }

  private onClick(e: MouseEvent): void {
    const rect = this.canvas.getBoundingClientRect();
    const span = this.range * 2;
    const mx = ((e.clientX - rect.left) / rect.width) * span;
    const mz = ((e.clientY - rect.top) / rect.height) * span;
    const { x: cxp, z: czp } = this.deps.player();
    this.deps.onTravel(Math.floor(cxp) - this.range + Math.floor(mx), Math.floor(czp) - this.range + Math.floor(mz));
    this.close();
  }
}
