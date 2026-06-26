/**
 * In-game modal dialogs (confirm / prompt) styled to match the pixel UI, so we
 * never fall back to the browser's native window.confirm/prompt chrome (which
 * clashes with the office look). Promise-based: resolves to the user's choice.
 */

let stylesInjected = false;
function ensureStyles(): void {
  if (stylesInjected) return;
  stylesInjected = true;
  const style = document.createElement('style');
  style.textContent = `
    #pa-modal{position:fixed;inset:0;z-index:90;display:flex;align-items:center;justify-content:center;
      background:rgba(0,0,0,.55);font-family:'FS Pixel Sans',monospace;}
    #pa-modal .box{background:#1b1f2a;border:2px solid #3a4150;border-radius:0.5rem;padding:1.1rem 1.2rem;
      max-width:24rem;color:#eef1f6;box-shadow:0 4px 0 rgba(0,0,0,.4);}
    #pa-modal .msg{font-size:1.05rem;line-height:1.4;margin:0 0 1rem;white-space:pre-wrap;word-break:break-word;}
    #pa-modal input[type=text]{width:100%;box-sizing:border-box;background:#2a2f3a;border:1px solid #3a4150;
      color:#eef1f6;border-radius:0.3rem;font:1rem 'FS Pixel Sans',monospace;padding:0.5rem 0.6rem;margin-bottom:1rem;}
    #pa-modal .foot{display:flex;gap:0.6rem;justify-content:flex-end;}
    #pa-modal button{background:#2a2f3a;border:1px solid #3a4150;color:#eef1f6;border-radius:0.3rem;
      font:1rem 'FS Pixel Sans',monospace;padding:0.5rem 0.9rem;cursor:pointer;}
    #pa-modal button.ok{background:#3a6df0;border-color:#3a6df0;}
    #pa-modal button.danger{background:#6d3a4a;border-color:#6d3a4a;color:#ffd2dc;}
  `;
  document.head.appendChild(style);
}

interface ModalParts {
  overlay: HTMLDivElement;
  box: HTMLDivElement;
}

function buildModal(message: string): ModalParts {
  ensureStyles();
  const overlay = document.createElement('div');
  overlay.id = 'pa-modal';
  overlay.className = 'pa-ui';
  const box = document.createElement('div');
  box.className = 'box';
  const msg = document.createElement('p');
  msg.className = 'msg';
  msg.textContent = message;
  box.appendChild(msg);
  overlay.appendChild(box);
  return { overlay, box };
}

/**
 * Pixel-styled replacement for window.confirm. Resolves true on confirm, false
 * on cancel / Esc / backdrop click. `danger` styles the confirm button red
 * (for destructive actions like delete).
 */
export function confirmDialog(
  message: string,
  opts: { confirmLabel?: string; cancelLabel?: string; danger?: boolean } = {},
): Promise<boolean> {
  const { overlay, box } = buildModal(message);
  const foot = document.createElement('div');
  foot.className = 'foot';
  const cancel = document.createElement('button');
  cancel.textContent = opts.cancelLabel ?? 'Cancel';
  const ok = document.createElement('button');
  ok.textContent = opts.confirmLabel ?? 'OK';
  ok.className = opts.danger ? 'danger' : 'ok';
  foot.append(cancel, ok);
  box.appendChild(foot);

  return new Promise<boolean>((resolve) => {
    const done = (v: boolean) => {
      window.removeEventListener('keydown', onKey);
      overlay.remove();
      resolve(v);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') done(false);
      else if (e.key === 'Enter') done(true);
    };
    cancel.onclick = () => done(false);
    ok.onclick = () => done(true);
    overlay.onclick = (e) => {
      if (e.target === overlay) done(false);
    };
    window.addEventListener('keydown', onKey);
    document.body.appendChild(overlay);
    ok.focus();
  });
}

/**
 * Pixel-styled replacement for window.prompt. Resolves to the entered string,
 * or null on cancel / Esc / backdrop click.
 */
export function promptDialog(
  message: string,
  defaultValue = '',
  opts: { confirmLabel?: string; cancelLabel?: string; maxLength?: number } = {},
): Promise<string | null> {
  const { overlay, box } = buildModal(message);
  const input = document.createElement('input');
  input.type = 'text';
  input.value = defaultValue;
  if (opts.maxLength) input.maxLength = opts.maxLength;
  box.appendChild(input);
  const foot = document.createElement('div');
  foot.className = 'foot';
  const cancel = document.createElement('button');
  cancel.textContent = opts.cancelLabel ?? 'Cancel';
  const ok = document.createElement('button');
  ok.textContent = opts.confirmLabel ?? 'OK';
  ok.className = 'ok';
  foot.append(cancel, ok);
  box.appendChild(foot);

  return new Promise<string | null>((resolve) => {
    const done = (v: string | null) => {
      window.removeEventListener('keydown', onKey);
      overlay.remove();
      resolve(v);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') done(null);
      else if (e.key === 'Enter') done(input.value);
    };
    cancel.onclick = () => done(null);
    ok.onclick = () => done(input.value);
    overlay.onclick = (e) => {
      if (e.target === overlay) done(null);
    };
    window.addEventListener('keydown', onKey);
    document.body.appendChild(overlay);
    input.focus();
    input.select();
  });
}
