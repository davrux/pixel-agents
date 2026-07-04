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
  /** Collected block stacks (block id → count) from the survival inventory, count>0. */
  collected: () => { block: number; count: number }[];
  /** Non-block materials owned (lumps/ingots, item id ≥ MATERIAL_BASE → count), count>0. */
  materials: () => { id: number; count: number }[];
  /** Creative mode → show the whole block palette (unlimited); else only owned blocks. */
  creative: () => boolean;
  /** Always-available build tools (water/lava/portal): placeable + shown even in survival. */
  special: () => number[];
  /** Whether a palette item is owned (tools you've crafted; non-tools = always true). */
  owns: (item: Item) => boolean;
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
      #vx-inv .cell .num{position:absolute;right:0;bottom:0;font-size:.62rem;padding:0 2px;background:rgba(0,0,0,.62);color:#fff;text-shadow:1px 1px 0 #000;border-radius:2px 0 0 0;}
      #vx-inv .empty{font-size:.72rem;color:#9a9a9a;padding:.1rem 0 .3rem;}
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

  private cell(it: Item | null, opts: { slot?: boolean; label?: string; draggable?: boolean; count?: number | string }): HTMLDivElement {
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
    if (opts.count !== undefined) {
      const n = document.createElement('div');
      n.className = 'num';
      n.textContent = String(opts.count);
      el.appendChild(n);
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

    const grid = (title: string, items: Item[]): void => {
      heading(title);
      const g = document.createElement('div');
      g.className = 'grid';
      for (const it of items) g.appendChild(this.cell(it, {}));
      b.appendChild(g);
    };

    // Blocks — like the original: the stack count sits ON each block cell. In survival
    // you only see the blocks you actually hold (dug/crafted); in creative the whole
    // palette is shown (unlimited, no counts). Drag one onto the block hotbar track.
    const creative = this.deps.creative();
    const owned = new Map(this.deps.collected().map((c) => [c.block, c.count]));
    const special = new Set(this.deps.special()); // water/lava/portal — always placeable + shown
    heading('Blocks');
    const bg = document.createElement('div');
    bg.className = 'grid';
    // Survival: owned blocks (with counts) PLUS the always-available special build tools
    // (shown with ∞). Creative: the whole palette.
    const blockList = creative
      ? this.deps.palette.blocks
      : this.deps.palette.blocks.filter((it) => (owned.get(it.block ?? -1) ?? 0) > 0 || special.has(it.block ?? -1));
    for (const it of blockList) {
      const id = it.block ?? -1;
      const count = special.has(id) && !(owned.get(id) ?? 0) ? '∞' : owned.get(id) || undefined;
      bg.appendChild(this.cell(it, { count }));
    }
    b.appendChild(bg);

    // Materials — non-block items (lumps/ingots) you've mined/smelted. Display-only:
    // they can't go on the dig/build hotbar, they feed crafting + smelting (C panel).
    const mats = this.deps.materials();
    if (mats.length) {
      heading('Materials');
      const mg = document.createElement('div');
      mg.className = 'grid';
      for (const m of mats) mg.appendChild(this.cell(this.deps.item('mat:' + m.id), { count: m.count, draggable: false }));
      b.appendChild(mg);
    }

    // Tools — owned ones are bright + draggable to the tool hotbar; the rest are dimmed
    // with a 🔒 (craftable but not owned yet), so you can see what you actually have.
    heading('Tools');
    const tg = document.createElement('div');
    tg.className = 'grid';
    for (const it of this.deps.palette.tools) {
      const has = this.deps.owns(it);
      const c = this.cell(it, { draggable: has });
      if (!has) {
        c.style.opacity = '0.4';
        c.title = it.name + ' — not crafted yet';
        const lock = document.createElement('div');
        lock.className = 'num';
        lock.textContent = '🔒';
        c.appendChild(lock);
      }
      tg.appendChild(c);
    }
    b.appendChild(tg);
    grid('Armour', this.deps.palette.armor);
  }
}
