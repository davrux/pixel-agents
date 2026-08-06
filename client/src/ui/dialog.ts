/**
 * In-game modal dialogs (confirm / prompt) styled to match the pixel UI, so we
 * never fall back to the browser's native window.confirm/prompt chrome (which
 * clashes with the office look). Promise-based: resolves to the user's choice.
 *
 * Plain DOM, no Phaser/Colyseus dependency — usable from the admin overlay
 * too, not just the 2D scene.
 */
import { generatePassword } from '../shared/generatePassword.js';
import {
  TEXT_LABEL_FONT_CHOICES,
  TEXT_LABEL_MIN_FONT_SIZE,
  TEXT_LABEL_MAX_FONT_SIZE,
  clampTextLabelFontSize,
} from '@pixel/shared/protocol';

let stylesInjected = false;
function ensureStyles(): void {
  if (stylesInjected) return;
  stylesInjected = true;
  const style = document.createElement('style');
  style.textContent = `
    /* z-index:1100 used to guarantee this renders above #pa-dialog-back
       (paDialog.ts, formerly z-index:1000) so confirm/alert/prompt could
       interrupt an already-open form dialog. paDialog.ts now uses a native
       <dialog> (browser top layer), which always wins over a regular z-index
       element regardless of value — so that guarantee no longer holds. In
       practice every current caller already avoids stacking one of these on
       top of an open paDialog (inline errors, click-to-arm delete, …); if a
       genuine need for it comes up, migrate this to <dialog> too rather than
       raising this z-index further (top layer isn't reachable via z-index at all). */
    #pa-modal{position:fixed;inset:0;z-index:1100;display:flex;align-items:center;justify-content:center;
      background:rgba(0,0,0,.55);font-family:'FS Pixel Sans',ui-monospace,monospace;}
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

export interface TextLabelDialogResult {
  text: string;
  fontSize: number;
  fontFamily: string;
}

/**
 * One dialog for a placed free-text label's content, size, and font —
 * replaces what used to be two sequential promptDialog calls (text, then
 * font size) with a single form. Resolves to null on cancel / Esc / backdrop
 * click, same as the other dialogs here.
 */
export function textLabelDialog(
  message: string,
  current: TextLabelDialogResult,
  opts: { confirmLabel?: string; cancelLabel?: string; maxLength?: number } = {},
): Promise<TextLabelDialogResult | null> {
  const { overlay, box } = buildModal(message);
  const input = document.createElement('input');
  input.type = 'text';
  input.value = current.text;
  if (opts.maxLength) input.maxLength = opts.maxLength;
  box.appendChild(input);

  const row = document.createElement('div');
  row.className = 'field-row';
  const sizeLabel = document.createElement('label');
  sizeLabel.textContent = 'Size';
  sizeLabel.htmlFor = 'pa-modal-size';
  const sizeInput = document.createElement('input');
  sizeInput.id = 'pa-modal-size';
  sizeInput.type = 'number';
  sizeInput.min = String(TEXT_LABEL_MIN_FONT_SIZE);
  sizeInput.max = String(TEXT_LABEL_MAX_FONT_SIZE);
  sizeInput.value = String(current.fontSize);
  const fontLabel = document.createElement('label');
  fontLabel.textContent = 'Font';
  fontLabel.htmlFor = 'pa-modal-font';
  const fontSelect = document.createElement('select');
  fontSelect.id = 'pa-modal-font';
  for (const choice of TEXT_LABEL_FONT_CHOICES) {
    const option = document.createElement('option');
    option.value = choice.value;
    option.textContent = choice.label;
    fontSelect.appendChild(option);
  }
  fontSelect.value = current.fontFamily;
  row.append(sizeLabel, sizeInput, fontLabel, fontSelect);
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

  return new Promise<TextLabelDialogResult | null>((resolve) => {
    const done = (v: TextLabelDialogResult | null) => {
      window.removeEventListener('keydown', onKey);
      overlay.remove();
      resolve(v);
    };
    const submit = (): void =>
      done({
        text: input.value,
        fontSize: clampTextLabelFontSize(sizeInput.value),
        fontFamily: fontSelect.value,
      });
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') done(null);
      else if (e.key === 'Enter') submit();
    };
    cancel.onclick = () => done(null);
    ok.onclick = submit;
    overlay.onclick = (e) => {
      if (e.target === overlay) done(null);
    };
    window.addEventListener('keydown', onKey);
    document.body.appendChild(overlay);
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
  });
}
