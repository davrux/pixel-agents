/**
 * A centred modal dialog in the shared "pixel-menu" skin (.pa-* — same look as the
 * 2D office), for prompts (portal target, …) instead of the raw browser
 * window.prompt/confirm. Backdrop-click or Esc cancels.
 *
 * Built on the native <dialog> element (showModal/close) rather than a single
 * hand-rolled backdrop div: each call gets its own real element with its own
 * browser-tracked open/closed state, so a button whose onClick opens a NEW
 * dialog (swapping the current one for another, e.g. a "+ New X" button
 * inside a list dialog) can't accidentally close the wrong one — closing an
 * already-closed <dialog> is a harmless no-op, whereas the old shared-div
 * version's closeDialog() would tear down whatever was *currently* showing,
 * new or old (see the "+ New room" bug this replaced). The browser also only
 * allows one <dialog> open via showModal() at a time, so opening a second one
 * here explicitly closes whatever's already open first — same "one modal at a
 * time" contract as before, just enforced by us instead of relying on it
 * happening to work.
 *
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
  s.textContent = `
    dialog#pa-dialog-back{position:fixed;inset:0;margin:auto;padding:0;border:0;background:transparent;
      max-width:calc(100vw - 2rem);max-height:calc(100vh - 2rem);color:inherit;}
    dialog#pa-dialog-back::backdrop{background:rgba(0,0,0,.55);}
    #pa-dialog-back .pa-panel{position:static;display:block;width:22rem;}
    #pa-dialog-back .pa-body .fld{margin-bottom:0.85rem;}
    #pa-dialog-back .pa-body .fld label{display:block;font-size:0.78rem;letter-spacing:.5px;color:#818586;
      text-transform:uppercase;margin-bottom:0.3rem;}
    #pa-dialog-back .pa-body .fld .pa-select,#pa-dialog-back .pa-body .fld .pa-input{width:100%;}
    #pa-dialog-back .pa-foot{display:flex;justify-content:flex-end;gap:0.5rem;margin-top:0.4rem;}
  `;
  document.head.appendChild(s);
}

/** The one <dialog> currently shown via openPaDialog, if any — tracked only so
 *  paDialogOpen()/closePaDialog() (used by ArcadeUI to coordinate with whatever
 *  dialog is up right now) have something to check/close without every caller
 *  needing to hold onto the close() this function returns. */
let current: HTMLDialogElement | null = null;

/** Fire the 'cancel' listener below, then close — the shared path for every
 *  cancel-flavoured dismissal (backdrop click, ✕, Cancel button, closePaDialog()).
 *  Esc is handled by the browser itself: it fires a real 'cancel' event followed
 *  by closing the dialog, which our listeners below already handle identically. */
function requestCancel(dialogEl: HTMLDialogElement): void {
  dialogEl.dispatchEvent(new Event('cancel'));
  dialogEl.close();
}

/**
 * Open a modal. `body` is your form content (built with .fld / .pa-select / .pa-input).
 * `buttons` render bottom-right; a Cancel button is added automatically.
 * Returns a close() you can call yourself.
 */
export function openPaDialog(opts: { title: string; body: HTMLElement; buttons: PaDialogButton[]; onCancel?: () => void; onClose?: () => void }): () => void {
  ensureStyle();
  // Only one <dialog> may be open via showModal() at a time — close whatever's
  // up before opening this one (matches the previous "one modal at a time").
  current?.close();

  const dialogEl = document.createElement('dialog');
  dialogEl.id = 'pa-dialog-back'; // kept stable — OfficeScene queries `#pa-dialog-back [data-…]` for the open dialog's own fields
  dialogEl.className = 'pa-ui';

  const panel = document.createElement('div');
  panel.className = 'pa-panel';
  const head = document.createElement('div');
  head.className = 'pa-head';
  head.innerHTML = `<h4></h4><div class="pa-x" title="Cancel (Esc)">✕</div>`;
  head.querySelector('h4')!.textContent = opts.title;
  head.querySelector<HTMLElement>('.pa-x')!.onclick = () => requestCancel(dialogEl);
  const bodyEl = document.createElement('div');
  bodyEl.className = 'pa-body';
  bodyEl.appendChild(opts.body);
  const foot = document.createElement('div');
  foot.className = 'pa-foot';
  const cancel = document.createElement('button');
  cancel.type = 'button';
  cancel.className = 'pa-b';
  cancel.textContent = 'Cancel';
  cancel.onclick = () => requestCancel(dialogEl);
  foot.appendChild(cancel);
  for (const b of opts.buttons) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'pa-b' + (b.kind ? ' ' + b.kind : '');
    btn.textContent = b.label;
    btn.onclick = () => {
      if (b.onClick() !== false) dialogEl.close();
    };
    foot.appendChild(btn);
  }
  bodyEl.appendChild(foot);
  panel.append(head, bodyEl);
  dialogEl.appendChild(panel);

  dialogEl.addEventListener('cancel', () => opts.onCancel?.());
  // Fires exactly once, on every close path (button / cancel-Esc / backdrop / .close()).
  dialogEl.addEventListener('close', () => {
    if (current === dialogEl) current = null;
    opts.onClose?.();
    dialogEl.remove();
  });
  // Backdrop click: with showModal(), a click whose target is the <dialog>
  // element itself (not something inside .pa-panel) landed in the ::backdrop.
  dialogEl.addEventListener('mousedown', (e) => {
    if (e.target === dialogEl) requestCancel(dialogEl);
  });

  (document.getElementById('game') ?? document.body).appendChild(dialogEl);
  current = dialogEl;
  dialogEl.showModal();
  // Focus the first control for keyboard use.
  setTimeout(() => bodyEl.querySelector<HTMLElement>('select,input,button')?.focus(), 0);
  return () => dialogEl.close();
}

export function paDialogOpen(): boolean {
  return !!current?.open;
}

/** Close the open modal (as if Cancel) — for callers that just want "whatever's
 *  open right now, gone" without holding onto their own close() reference. */
export function closePaDialog(): void {
  if (current) requestCancel(current);
}
