/**
 * A reusable modal picker window (Minecraft-inventory style) — a scrollable grid
 * of thumbnails with labels. Used for the block palette ("b") and the skin
 * chooser. Esc or a click on the backdrop closes it.
 */
export interface PickerItem {
  thumb: string; // image URL (rendered pixelated)
  label: string;
  selected?: boolean;
  onPick: () => void;
}

let root: HTMLDivElement | null = null;

function ensure(): HTMLDivElement {
  if (root) return root;
  if (!document.getElementById('vx-picker-style')) {
    const s = document.createElement('style');
    s.id = 'vx-picker-style';
    s.textContent = `
      #vx-picker{position:fixed;inset:0;z-index:200;display:none;align-items:center;justify-content:center;
        background:rgba(0,0,0,.55);font-family:'FS Pixel Sans',ui-monospace,monospace;color:#fff;}
      #vx-picker.open{display:flex;}
      #vx-picker .win{width:min(92vw,44rem);max-height:80vh;display:flex;flex-direction:column;
        background:#2b2b2b;border:4px solid #1c1c1c;border-radius:6px;box-shadow:0 8px 0 rgba(0,0,0,.5);}
      #vx-picker .hd{display:flex;align-items:center;gap:.6rem;padding:.7rem .9rem;border-bottom:3px solid #1c1c1c;}
      #vx-picker .hd h3{margin:0;font-size:1.15rem;text-shadow:1px 1px 0 #000;}
      #vx-picker .hd .x{margin-left:auto;cursor:pointer;width:1.8rem;height:1.8rem;display:flex;
        align-items:center;justify-content:center;background:#3a3a3a;border:3px solid #1c1c1c;border-radius:4px;}
      #vx-picker .grid{overflow-y:auto;padding:.8rem;display:grid;gap:.5rem;
        grid-template-columns:repeat(auto-fill,minmax(4.4rem,1fr));}
      #vx-picker .cell{cursor:pointer;display:flex;flex-direction:column;align-items:center;gap:.25rem;
        padding:.35rem;background:#3a3a3a;border:3px solid #4a4a4a;border-radius:4px;}
      #vx-picker .cell:hover{border-color:#fff;}
      #vx-picker .cell.on{border-color:#7fd08a;box-shadow:0 0 0 2px #000 inset;}
      #vx-picker .cell img{width:3rem;height:3rem;image-rendering:pixelated;object-fit:contain;background:#222;}
      #vx-picker .cell span{font-size:.62rem;text-align:center;line-height:1.1;color:#dcdcdc;
        white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:4rem;}
    `;
    document.head.appendChild(s);
  }
  root = document.createElement('div');
  root.id = 'vx-picker';
  root.innerHTML = `<div class="win"><div class="hd"><h3></h3><div class="x" title="Close (Esc)">✕</div></div><div class="grid"></div></div>`;
  (document.getElementById('game') ?? document.body).appendChild(root);
  root.addEventListener('mousedown', (e) => {
    if (e.target === root) closePicker(); // backdrop click
  });
  root.querySelector<HTMLElement>('.x')!.onclick = () => closePicker();
  return root;
}

export function openPicker(title: string, items: PickerItem[]): void {
  const el = ensure();
  el.querySelector('h3')!.textContent = title;
  const grid = el.querySelector<HTMLDivElement>('.grid')!;
  grid.innerHTML = '';
  for (const it of items) {
    const c = document.createElement('div');
    c.className = 'cell' + (it.selected ? ' on' : '');
    c.title = it.label;
    c.innerHTML = `<img src="${it.thumb}" alt=""><span>${it.label}</span>`;
    c.onclick = () => it.onPick();
    grid.appendChild(c);
  }
  el.classList.add('open');
}

export function closePicker(): void {
  root?.classList.remove('open');
}

export function pickerOpen(): boolean {
  return !!root?.classList.contains('open');
}
