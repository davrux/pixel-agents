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
    /* Above #pa-dialog-back (paDialog.ts, z-index 1000) — confirm/alert/prompt
       must be able to interrupt an already-open form dialog (e.g. a validation
       error while "Create a meeting room" is still up), not hide behind it. */
    #pa-modal{position:fixed;inset:0;z-index:1100;display:flex;align-items:center;justify-content:center;
      background:rgba(0,0,0,.55);font-family:'FS Pixel Sans',ui-monospace,monospace;}
    #pa-modal .box{background:#0f1220;border:2px solid #05060b;border-radius:0.6rem;padding:1.1rem 1.2rem;
      max-width:24rem;color:#e9ecf7;box-shadow:inset 0 2px 0 #232a44,inset 0 -3px 0 #080a14,0 12px 28px rgba(0,0,0,.55);}
    #pa-modal .msg{font-size:1.05rem;line-height:1.4;margin:0 0 1rem;white-space:pre-wrap;word-break:break-word;}
    #pa-modal input[type=text]{width:100%;box-sizing:border-box;background:#171b2b;border:2px solid #05060b;
      color:#e9ecf7;border-radius:0.35rem;font:1rem 'FS Pixel Sans',monospace;padding:0.5rem 0.6rem;margin-bottom:1rem;
      box-shadow:inset 0 2px 0 #2b3252,inset 0 -3px 0 #090b16;}
    #pa-modal .foot{display:flex;gap:0.6rem;justify-content:flex-end;}
    #pa-modal button{background:#171b2b;border:2px solid #05060b;color:#e9ecf7;border-radius:0.35rem;
      font:1rem 'FS Pixel Sans',monospace;padding:0.5rem 0.9rem;cursor:pointer;
      box-shadow:inset 0 2px 0 #2b3252,inset 0 -3px 0 #090b16;}
    #pa-modal button.ok{background:#2f66b0;color:#fff;box-shadow:inset 0 2px 0 #5a92d6,inset 0 -3px 0 #163862;}
    #pa-modal button.danger{background:#7c2634;color:#f1d0d6;box-shadow:inset 0 2px 0 #b34a5a,inset 0 -3px 0 #45111a;}
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
 * Pixel-styled replacement for window.alert: a single OK button (no Cancel).
 * Resolves when dismissed (OK / Enter / Esc / backdrop click).
 */
export function alertDialog(message: string, opts: { confirmLabel?: string } = {}): Promise<void> {
  const { overlay, box } = buildModal(message);
  const foot = document.createElement('div');
  foot.className = 'foot';
  const ok = document.createElement('button');
  ok.textContent = opts.confirmLabel ?? 'OK';
  ok.className = 'ok';
  foot.append(ok);
  box.appendChild(foot);

  return new Promise<void>((resolve) => {
    const done = (): void => {
      window.removeEventListener('keydown', onKey);
      overlay.remove();
      resolve();
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape' || e.key === 'Enter') done();
    };
    ok.onclick = () => done();
    overlay.onclick = (e) => {
      if (e.target === overlay) done();
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
