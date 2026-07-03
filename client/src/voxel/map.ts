/**
 * Travel map (M): a top-down minimap of the current world built from the loaded
 * chunks — each column painted by its top block's colour, the player marked with a
 * heading arrow. Click a spot to travel there (server-authoritative teleport within
 * the current world/zone). Only loaded terrain (the AOI around you) is shown.
 */
export interface MapDeps {
  /** Top-block colour (0xRRGGBB) at column (x,z), or null if not loaded. */
  columnColor: (x: number, z: number) => number | null;
  player: () => { x: number; z: number; yaw: number };
  /** Travel to world (x,z) — the caller asks the server to teleport. */
  onTravel: (x: number, z: number) => void;
  onOpen?: () => void; // e.g. release pointer lock so the map is clickable
  onClose?: () => void; // e.g. re-capture the mouse in first person
}

const RANGE = 64; // blocks shown each way from the player
const PX = 3; // canvas pixels per block
const SIZE = RANGE * 2 * PX; // canvas is SIZE×SIZE

export class TravelMap {
  private readonly root: HTMLDivElement;
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private open = false;

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
    this.root.innerHTML = `<div class="win"><div class="hd"><h3>Map — click to travel</h3><div class="x" title="Close (M / Esc)">✕</div></div></div>`;
    this.canvas = document.createElement('canvas');
    this.canvas.width = this.canvas.height = SIZE;
    this.root.querySelector('.win')!.insertBefore(this.canvas, this.root.querySelector('.tip'));
    const tip = document.createElement('div');
    tip.className = 'tip';
    tip.textContent = 'Only explored (loaded) terrain is shown · click a spot to travel';
    this.root.querySelector('.win')!.appendChild(tip);
    (document.getElementById('game') ?? document.body).appendChild(this.root);
    this.ctx = this.canvas.getContext('2d')!;
    this.ctx.imageSmoothingEnabled = false;

    this.root.querySelector<HTMLElement>('.x')!.onclick = () => this.close();
    this.root.addEventListener('mousedown', (e) => {
      if (e.target === this.root) this.close();
    });
    this.canvas.addEventListener('click', (e) => this.onClick(e));
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

  /** Repaint from the currently loaded columns (called on open + periodically). */
  render(): void {
    if (!this.open) return;
    const { x: cxp, z: czp, yaw } = this.deps.player();
    const ox = Math.floor(cxp) - RANGE;
    const oz = Math.floor(czp) - RANGE;
    const img = this.ctx.createImageData(RANGE * 2, RANGE * 2);
    for (let iz = 0; iz < RANGE * 2; iz++) {
      for (let ix = 0; ix < RANGE * 2; ix++) {
        const c = this.deps.columnColor(ox + ix, oz + iz);
        const o = (iz * RANGE * 2 + ix) * 4;
        if (c == null) {
          img.data[o] = 17;
          img.data[o + 1] = 21;
          img.data[o + 2] = 28;
          img.data[o + 3] = 255; // unloaded → dark
        } else {
          img.data[o] = (c >> 16) & 255;
          img.data[o + 1] = (c >> 8) & 255;
          img.data[o + 2] = c & 255;
          img.data[o + 3] = 255;
        }
      }
    }
    // Scale the RANGE*2 image up to the PX-scaled canvas.
    const tmp = document.createElement('canvas');
    tmp.width = tmp.height = RANGE * 2;
    tmp.getContext('2d')!.putImageData(img, 0, 0);
    this.ctx.clearRect(0, 0, SIZE, SIZE);
    this.ctx.drawImage(tmp, 0, 0, SIZE, SIZE);
    // Player marker: a heading arrow at centre.
    const cx = RANGE * PX,
      cy = RANGE * PX;
    this.ctx.save();
    this.ctx.translate(cx, cy);
    this.ctx.rotate(-yaw); // yaw 0 faces -Z (up on the map)
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
    const mx = ((e.clientX - rect.left) / rect.width) * RANGE * 2;
    const mz = ((e.clientY - rect.top) / rect.height) * RANGE * 2;
    const { x: cxp, z: czp } = this.deps.player();
    const wx = Math.floor(cxp) - RANGE + Math.floor(mx);
    const wz = Math.floor(czp) - RANGE + Math.floor(mz);
    this.deps.onTravel(wx, wz);
    this.close();
  }
}
