/**
 * A centred modal dialog in the shared "pixel-menu" skin (.pa-* — same look as the
 * 2D office), for prompts (portal target, …) instead of the raw browser
 * window.prompt/confirm. Backdrop-click or Esc cancels; one modal at a time.
 * Relies on injectPaSkin() having run (for .pa-panel / .pa-select / .pa-b / .pa-input).
 */
import { injectPaSkin } from './paSkin.js';

export interface PaDialogButton {
  label: string;
  kind?: 'primary' | 'green' | 'danger';
  /** Return false to keep the dialog open (e.g. validation failed); anything else closes it. */
  onClick: () => void | boolean;
}

function ensureStyle(): void {
  injectPaSkin();
  if (document.getElementById('pa-dialog-style')) return;
  const s = document.createElement('style');
  s.id = 'pa-dialog-style';
  // Full-screen backdrop centring a .pa-panel (which is normally a top-anchored popover).
  s.textContent = `
    #pa-dialog-back{position:fixed;inset:0;z-index:1000;display:none;align-items:center;justify-content:center;
      background:rgba(0,0,0,.55);}
    #pa-dialog-back.open{display:flex;}
    #pa-dialog-back .pa-panel{position:static;display:block;width:22rem;}
    #pa-dialog-back .pa-body .fld{margin-bottom:0.85rem;}
    #pa-dialog-back .pa-body .fld label{display:block;font-size:0.78rem;letter-spacing:.5px;color:#8a90a8;
      text-transform:uppercase;margin-bottom:0.3rem;}
    #pa-dialog-back .pa-body .fld .pa-select,#pa-dialog-back .pa-body .fld .pa-input{width:100%;}
    #pa-dialog-back .pa-foot{display:flex;justify-content:flex-end;gap:0.5rem;margin-top:0.4rem;}
  `;
  document.head.appendChild(s);
}

let back: HTMLDivElement | null = null;
let onCancel: (() => void) | null = null;
let onClose: (() => void) | null = null;

function closeDialog(): void {
  if (!back?.classList.contains('open')) return;
  back.classList.remove('open');
  const cb = onClose;
  onClose = null;
  cb?.(); // always fires once, on any close path (button / cancel / backdrop / Esc)
}

/**
 * Open a modal. `body` is your form content (built with .fld / .pa-select / .pa-input).
 * `buttons` render bottom-right; a Cancel button is added automatically.
 * Returns a close() you can call yourself.
 */
export function openPaDialog(opts: { title: string; body: HTMLElement; buttons: PaDialogButton[]; onCancel?: () => void; onClose?: () => void }): () => void {
  ensureStyle();
  onClose = opts.onClose ?? null;
  if (!back) {
    back = document.createElement('div');
    back.id = 'pa-dialog-back';
    back.className = 'pa-ui';
    (document.getElementById('game') ?? document.body).appendChild(back);
    back.addEventListener('mousedown', (e) => {
      if (e.target === back) {
        onCancel?.();
        closeDialog();
      }
    });
  }
  onCancel = opts.onCancel ?? null;
  back.innerHTML = '';
  const panel = document.createElement('div');
  panel.className = 'pa-panel';
  const head = document.createElement('div');
  head.className = 'pa-head';
  head.innerHTML = `<h4></h4><div class="pa-x" title="Cancel (Esc)">✕</div>`;
  head.querySelector('h4')!.textContent = opts.title;
  head.querySelector<HTMLElement>('.pa-x')!.onclick = () => {
    opts.onCancel?.();
    closeDialog();
  };
  const bodyEl = document.createElement('div');
  bodyEl.className = 'pa-body';
  bodyEl.appendChild(opts.body);
  const foot = document.createElement('div');
  foot.className = 'pa-foot';
  const cancel = document.createElement('button');
  cancel.className = 'pa-b';
  cancel.textContent = 'Cancel';
  cancel.onclick = () => {
    opts.onCancel?.();
    closeDialog();
  };
  foot.appendChild(cancel);
  for (const b of opts.buttons) {
    const btn = document.createElement('button');
    btn.className = 'pa-b' + (b.kind ? ' ' + b.kind : '');
    btn.textContent = b.label;
    btn.onclick = () => {
      if (b.onClick() !== false) closeDialog();
    };
    foot.appendChild(btn);
  }
  bodyEl.appendChild(foot);
  panel.appendChild(head);
  panel.appendChild(bodyEl);
  back.appendChild(panel);
  back.classList.add('open');
  // Focus the first control for keyboard use.
  setTimeout(() => bodyEl.querySelector<HTMLElement>('select,input,button')?.focus(), 0);
  return closeDialog;
}

export function paDialogOpen(): boolean {
  return !!back?.classList.contains('open');
}

/** Close the open modal (as if Cancel) — for a global Esc handler. */
export function closePaDialog(): void {
  if (paDialogOpen()) {
    onCancel?.();
    closeDialog();
  }
}
