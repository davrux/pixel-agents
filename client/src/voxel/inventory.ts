/**
 * Inventory panel (I): a creative-style palette (tools · blocks · armour) you
 * drag onto the two hotbar tracks and the four armour slots. Drops are kind-checked
 * (tools → tool row, blocks → block row, armour → its matching slot). Clicking an
 * equipped slot clears it. All changes go back through the deps (which persist +
 * sync server-side). HTML5 drag&drop; styled to match the pixel menu.
 */
import type { Item, ArmorSlot } from './items.js';
import { iconUrl } from './items.js';

const SLOTS: ArmorSlot[] = ['head', 'torso', 'legs', 'feet'];

export interface InventoryDeps {
  toolSlots: () => string[];
  blockSlots: () => string[];
  armorSlots: () => Record<ArmorSlot, string | null>;
  setToolSlot: (i: number, id: string) => void;
  setBlockSlot: (i: number, id: string) => void;
  setArmor: (slot: ArmorSlot, id: string | null) => void;
  item: (id: string) => Item;
  palette: { tools: Item[]; blocks: Item[]; armor: Item[] };
  onOpen?: () => void; // e.g. raise the live hotbar above the panel so you can drop onto it
  onClose?: () => void;
}

export class Inventory {
  private readonly root: HTMLDivElement;
  private readonly body: HTMLDivElement;
  private open = false;
  private dragItem: string | null = null; // pointer-drag payload (item id)
  private ghost: HTMLDivElement | null = null;

  constructor(private readonly deps: InventoryDeps) {
    const style = document.createElement('style');
    style.textContent = `
      #vx-inv{position:fixed;inset:0;z-index:150;display:none;align-items:center;justify-content:center;
        background:rgba(0,0,0,.55);font-family:'FS Pixel Sans',ui-monospace,monospace;color:#fff;}
      #vx-inv.open{display:flex;}
      #vx-inv .win{width:min(94vw,40rem);max-height:86vh;overflow-y:auto;background:#2b2b2b;border:4px solid #1c1c1c;
        border-radius:6px;box-shadow:0 8px 0 rgba(0,0,0,.5);padding:.8rem;}
      #vx-inv .hd{display:flex;align-items:center;gap:.6rem;margin-bottom:.5rem;}
      #vx-inv .hd h3{margin:0;font-size:1.1rem;text-shadow:1px 1px 0 #000;}
      #vx-inv .hd .x{margin-left:auto;cursor:pointer;width:1.7rem;height:1.7rem;display:flex;align-items:center;
        justify-content:center;background:#3a3a3a;border:3px solid #1c1c1c;border-radius:4px;}
      #vx-inv h4{margin:.6rem 0 .3rem;font-size:.8rem;color:#cfcfcf;text-shadow:1px 1px 0 #000;}
      #vx-inv .row{display:flex;gap:5px;flex-wrap:wrap;}
      #vx-inv .grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(2.6rem,1fr));gap:5px;}
      #vx-inv .cell{width:2.4rem;height:2.4rem;border:3px solid #4a4a4a;border-radius:4px;background:#3a3a3a center/80% no-repeat;
        image-rendering:pixelated;cursor:grab;position:relative;}
      #vx-inv .cell.slot{border-color:#6a6a6a;background-color:#242424;}
      #vx-inv .cell.slot .lab{position:absolute;bottom:-1px;left:0;right:0;text-align:center;font-size:.5rem;color:#9a9a9a;}
      #vx-inv .cell.drop{border-color:#7fd08a;box-shadow:0 0 0 2px #7fd08a inset;}
      #vx-inv .tip{margin-top:.6rem;font-size:.7rem;color:#bdbdbd;}
      .vx-drag-ghost{position:fixed;width:2.2rem;height:2.2rem;margin:-1.1rem 0 0 -1.1rem;background:#3a3a3a center/80% no-repeat;
        border:3px solid #fff;border-radius:4px;image-rendering:pixelated;pointer-events:none;z-index:400;opacity:.9;}`;
    document.head.appendChild(style);
    this.root = document.createElement('div');
    this.root.id = 'vx-inv';
    this.root.innerHTML = `<div class="win"><div class="hd"><h3>Inventory</h3><div class="x" title="Close (I / Esc)">✕</div></div><div class="bd"></div><div class="tip">Drag items onto the hotbar rows or armour slots · click an equipped slot to clear</div></div>`;
    this.body = this.root.querySelector('.bd')!;
    (document.getElementById('game') ?? document.body).appendChild(this.root);
    this.root.querySelector<HTMLElement>('.x')!.onclick = () => this.close();
    this.root.addEventListener('mousedown', (e) => {
      if (e.target === this.root) this.close();
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
    this.deps.onClose?.();
    this.open = false;
    this.root.classList.remove('open');
  }

  private cell(it: Item | null, opts: { slot?: boolean; label?: string; draggable?: boolean }): HTMLDivElement {
    const el = document.createElement('div');
    el.className = 'cell' + (opts.slot ? ' slot' : '');
    if (it) {
      el.style.backgroundImage = `url(${iconUrl(it)})`;
      el.title = it.name;
      if (opts.draggable !== false) {
        const id = it.id;
        el.style.cursor = 'grab';
        el.addEventListener('mousedown', (e) => {
          e.preventDefault();
          this.startDrag(id, e);
        });
      }
    }
    if (opts.label) {
      const l = document.createElement('div');
      l.className = 'lab';
      l.textContent = opts.label;
      el.appendChild(l);
    }
    return el;
  }

  private dropTarget(el: HTMLElement, accept: (id: string) => void): void {
    (el as unknown as { __accept?: (id: string) => void }).__accept = accept;
  }

  /** Element under (x,y) that is a drop target (walks up ancestors), or null. */
  private targetAt(x: number, y: number): HTMLElement | null {
    let el = document.elementFromPoint(x, y) as HTMLElement | null;
    while (el && !(el as unknown as { __accept?: unknown }).__accept) el = el.parentElement;
    return el;
  }

  /** Pointer-based drag: a ghost follows the cursor; drop = target under release. */
  private startDrag(id: string, e: MouseEvent): void {
    this.dragItem = id;
    const g = document.createElement('div');
    g.className = 'vx-drag-ghost';
    g.style.backgroundImage = `url(${iconUrl(this.deps.item(id))})`;
    document.body.appendChild(g);
    this.ghost = g;
    const move = (ev: MouseEvent): void => {
      g.style.left = ev.clientX + 'px';
      g.style.top = ev.clientY + 'px';
      this.body.querySelectorAll('.drop').forEach((c) => c.classList.remove('drop'));
      this.targetAt(ev.clientX, ev.clientY)?.classList.add('drop');
    };
    const up = (ev: MouseEvent): void => {
      document.removeEventListener('mousemove', move);
      document.removeEventListener('mouseup', up);
      g.remove();
      this.ghost = null;
      const target = this.targetAt(ev.clientX, ev.clientY);
      const accept = target && (target as unknown as { __accept?: (id: string) => void }).__accept;
      const dragId = this.dragItem;
      this.dragItem = null;
      this.body.querySelectorAll('.drop').forEach((c) => c.classList.remove('drop'));
      if (accept && dragId) accept(dragId);
    };
    move(e);
    document.addEventListener('mousemove', move);
    document.addEventListener('mouseup', up);
  }

  render(): void {
    if (!this.open) return;
    const b = this.body;
    b.innerHTML = '';
    const heading = (t: string): void => {
      const h = document.createElement('h4');
      h.textContent = t;
      b.appendChild(h);
    };
    const rowEl = (): HTMLDivElement => {
      const r = document.createElement('div');
      r.className = 'row';
      b.appendChild(r);
      return r;
    };

    // Armour slots.
    heading('Armour');
    const armor = this.deps.armorSlots();
    const ar = rowEl();
    for (const slot of SLOTS) {
      const id = armor[slot];
      const cell = this.cell(id ? this.deps.item(id) : null, { slot: true, label: slot });
      cell.onclick = () => {
        this.deps.setArmor(slot, null);
        this.render();
      };
      this.dropTarget(cell, (dragId) => {
        const it = this.deps.item(dragId);
        if (it.armor && it.armor.slot === slot) {
          this.deps.setArmor(slot, dragId);
          this.render();
        }
      });
      ar.appendChild(cell);
    }

    // (The hotbar is no longer mirrored here — drag palette items straight onto the
    //  real bottom hotbar, which is a drop target while this panel is open.)

    // Palette grids.
    const grid = (title: string, items: Item[]): void => {
      heading(title);
      const g = document.createElement('div');
      g.className = 'grid';
      for (const it of items) g.appendChild(this.cell(it, {}));
      b.appendChild(g);
    };
    grid('Tools', this.deps.palette.tools);
    grid('Blocks', this.deps.palette.blocks);
    grid('Armour', this.deps.palette.armor);
  }
}
