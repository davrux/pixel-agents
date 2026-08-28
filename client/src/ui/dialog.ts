/**
 * In-game modal dialogs (confirm / prompt) styled to match the pixel UI, so we
 * never fall back to the browser's native window.confirm/prompt chrome (which
 * clashes with the office look). Promise-based: resolves to the user's choice.
 *
 * Plain DOM, no Phaser/Colyseus dependency — usable from the admin overlay
 * too, not just the 2D scene.
 */
import { generatePassword } from '../shared/generatePassword.js';

let stylesInjected = false;
function ensureStyles(): void {
  if (stylesInjected) return;
  stylesInjected = true;
  const style = document.createElement('style');
  style.textContent = `
    /* A native <dialog>, opened with showModal(), because a z-index cannot reach the browser's
       TOP LAYER. This used to be a plain div at z-index:1100, and the comment here already
       predicted how that would end: the admin overlay and paDialog are both <dialog>+showModal(),
       and a modal dialog always paints above every ordinary element whatever its z-index. So the
       "Delete this user?" confirm opened BEHIND the admin panel — visible only as a dimmed
       backdrop, with the panel inert and nothing to click. Being in the top layer too fixes it by
       construction: dialogs stack in the order they were opened, so a confirm raised from an open
       panel is above that panel, and the one below goes inert while it is up.
       The element is the full-screen flex container (the .box inside is the panel), which keeps
       every selector below unchanged and keeps the backdrop-click test (e.target === overlay)
       meaning "clicked outside the box". */
    #pa-modal{position:fixed;inset:0;margin:0;padding:0;border:0;width:100vw;height:100vh;
      max-width:100vw;max-height:100vh;background:transparent;overflow:hidden;
      font-family:'FS Pixel Sans',ui-monospace,monospace;}
    /* Only when open: a <dialog> is display:none until then, and a bare display:flex here would
       show every one of these the moment it is appended. */
    #pa-modal[open]{display:flex;align-items:center;justify-content:center;}
    #pa-modal::backdrop{background:rgba(0,0,0,.55);}
    #pa-modal .box{background:#1c1a19;border:2px solid #0a0908;border-radius:0.6rem;padding:1.1rem 1.2rem;
      max-width:24rem;color:#f1efec;box-shadow:inset 0 2px 0 #292725,inset 0 -3px 0 #030303,0 12px 28px rgba(0,0,0,.55);}
    #pa-modal .msg{font-size:1.05rem;line-height:1.4;margin:0 0 1rem;white-space:pre-wrap;word-break:break-word;}
    #pa-modal input[type=text]{width:100%;box-sizing:border-box;background:#262422;border:2px solid #0a0908;
      color:#f1efec;border-radius:0.35rem;font:1rem 'FS Pixel Sans',monospace;padding:0.5rem 0.6rem;margin-bottom:1rem;
      box-shadow:inset 0 2px 0 #4a4744,inset 0 -3px 0 #050505;}
    #pa-modal .foot{display:flex;gap:0.6rem;justify-content:flex-end;}
    #pa-modal button{background:#262422;border:2px solid #0a0908;color:#f1efec;border-radius:0.35rem;
      font:1rem 'FS Pixel Sans',monospace;padding:0.5rem 0.9rem;cursor:pointer;
      box-shadow:inset 0 2px 0 #4a4744,inset 0 -3px 0 #050505;}
    #pa-modal button.ok{background:#c51a1b;color:#fff;box-shadow:inset 0 2px 0 #e2585a,inset 0 -3px 0 #5c0f10;}
    #pa-modal button.danger{background:#7c2634;color:#f1d0d6;box-shadow:inset 0 2px 0 #b34a5a,inset 0 -3px 0 #45111a;}
    #pa-modal .pw-row{display:flex;gap:0.4rem;margin-bottom:1rem;}
    #pa-modal .pw-row input[type=password],#pa-modal .pw-row input[type=text]{flex:1;min-width:0;margin-bottom:0;}
    #pa-modal .pw-row button{padding:0.5rem 0.6rem;}
    #pa-modal .field-row{display:flex;align-items:center;gap:0.4rem;margin-bottom:1rem;font-size:0.9rem;}
    #pa-modal .field-row label{color:#adb0b2;flex:0 0 auto;}
    #pa-modal .field-row input[type=number]{width:3.6rem;flex:0 0 auto;margin-bottom:0;}
    #pa-modal .field-row select{flex:1;min-width:0;background:#262422;border:2px solid #0a0908;color:#f1efec;
      border-radius:0.35rem;font:0.95rem 'FS Pixel Sans',monospace;padding:0.4rem 0.5rem;cursor:pointer;
      box-shadow:inset 0 2px 0 #4a4744,inset 0 -3px 0 #050505;}
  `;
  document.head.appendChild(style);
}

interface ModalParts {
  overlay: HTMLDialogElement;
  box: HTMLDivElement;
}

function buildModal(message: string): ModalParts {
  ensureStyles();
  const overlay = document.createElement('dialog');
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
 * Show one of these, and route every dismissal through one `done`.
 *
 * Esc is deliberately NOT handled by the keydown listener any more: a modal <dialog> fires a
 * `cancel` event and closes itself, so handling it here as well would race the browser. Enter
 * stays on keydown, since the element has no default action for it.
 */
function openModal(overlay: HTMLDialogElement, onDismiss: () => void, onEnter?: () => void): () => void {
  const onKey = (e: KeyboardEvent): void => {
    if (e.key === 'Enter' && onEnter) onEnter();
  };
  const close = (): void => {
    window.removeEventListener('keydown', onKey);
    overlay.close();
    overlay.remove();
  };
  overlay.addEventListener('cancel', (e) => {
    // Let `done` do the closing, so the promise is always settled on this path too.
    e.preventDefault();
    onDismiss();
  });
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) onDismiss(); // the click landed on the backdrop, not in the box
  });
  window.addEventListener('keydown', onKey);
  document.body.appendChild(overlay);
  // Not `show()`: a modal is what puts this in the top layer, above the panel that raised it, and
  // what makes that panel inert while the question is unanswered.
  overlay.showModal();
  return close;
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
    const done = (v: boolean): void => {
      close();
      resolve(v);
    };
    const close = openModal(
      overlay,
      () => done(false),
      () => done(true),
    );
    cancel.onclick = () => done(false);
    ok.onclick = () => done(true);
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
      close();
      resolve();
    };
    const close = openModal(overlay, done, done);
    ok.onclick = () => done();
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
    const done = (v: string | null): void => {
      close();
      resolve(v);
    };
    const close = openModal(
      overlay,
      () => done(null),
      () => done(input.value),
    );
    cancel.onclick = () => done(null);
    ok.onclick = () => done(input.value);
    input.focus();
    input.select();
  });
}

/**
 * Pixel-styled password prompt — like promptDialog but masked, with a
 * show/hide toggle and a "generate" button (same pattern as the zone/monitor
 * password widgets' inline forms — see shared/zonePasswordWidget.ts). Resolves
 * to the entered password, or null on cancel / Esc / backdrop click.
 */
export function passwordPromptDialog(
  message: string,
  opts: { confirmLabel?: string; cancelLabel?: string; maxLength?: number } = {},
): Promise<string | null> {
  const { overlay, box } = buildModal(message);
  const row = document.createElement('div');
  row.className = 'pw-row';
  const input = document.createElement('input');
  input.type = 'password';
  input.autocomplete = 'new-password';
  if (opts.maxLength) input.maxLength = opts.maxLength;
  const eyeBtn = document.createElement('button');
  eyeBtn.type = 'button';
  eyeBtn.textContent = '👁';
  eyeBtn.title = 'Show password';
  eyeBtn.onclick = () => {
    const shown = input.type === 'text';
    input.type = shown ? 'password' : 'text';
    eyeBtn.textContent = shown ? '👁' : '🙈';
    eyeBtn.title = shown ? 'Show password' : 'Hide password';
  };
  const genBtn = document.createElement('button');
  genBtn.type = 'button';
  genBtn.textContent = '🎲';
  genBtn.title = 'Generate a password';
  genBtn.onclick = () => {
    input.value = generatePassword();
    input.type = 'text';
    eyeBtn.textContent = '🙈';
    eyeBtn.title = 'Hide password';
  };
  row.append(input, eyeBtn, genBtn);
  box.appendChild(row);
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
    const done = (v: string | null): void => {
      close();
      resolve(v);
    };
    const close = openModal(
      overlay,
      () => done(null),
      () => done(input.value),
    );
    cancel.onclick = () => done(null);
    ok.onclick = () => done(input.value);
    input.focus();
  });
}
