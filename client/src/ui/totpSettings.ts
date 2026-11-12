/**
 * Settings → Account → Two-factor sign-in: the block in the profile panel and the dialogs behind
 * its buttons. Every decision is the server's (`server/src/totpApi.ts`); this file only renders its
 * answers and forwards what the user typed — invariant 2, and § Security: the client never decides
 * whether a code or a password was right.
 *
 * Goes through `serverFetch`, never a bare `fetch`, so the desktop app (app:// talking to a remote
 * server) sends its bearer — invariant 10.
 */
import { serverFetch } from '../net/room.js';
import { alertDialog, confirmDialog, formDialog, type FormField } from './dialog.js';

interface Status {
  enabled: boolean;
  pending: boolean;
  recoveryCodesLeft: number;
  hasPassword: boolean;
}

const PASSWORD: FormField = { name: 'password', label: 'Password', type: 'password', autocomplete: 'current-password', maxLength: 128 };
const CODE: FormField = {
  name: 'code',
  label: 'Code',
  autocomplete: 'one-time-code',
  inputMode: 'numeric',
  placeholder: '123456 or a recovery code',
  maxLength: 16,
};

/** The markup that goes inside the Settings account section. */
export const TOTP_SETTINGS_HTML = `
  <div id="pa-2fa" style="display:none">
    <div class="row"><label id="pa-2fa-state">Two-factor sign-in</label></div>
    <div class="row">
      <button id="pa-2fa-on">Set up</button>
      <button id="pa-2fa-codes">New recovery codes</button>
      <button id="pa-2fa-off">Turn off</button>
    </div>
    <div class="hint" id="pa-2fa-hint"></div>
  </div>`;

async function post(path: string, body: Record<string, unknown> = {}): Promise<{ ok: boolean; data: Record<string, unknown> }> {
  try {
    const res = await serverFetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      cache: 'no-store',
    });
    const data = ((await res.json().catch(() => null)) ?? {}) as Record<string, unknown>;
    return { ok: res.ok, data };
  } catch {
    return { ok: false, data: { error: 'Could not reach the server — try again.' } };
  }
}

const errorOf = (data: Record<string, unknown>, fallback: string): string =>
  typeof data.error === 'string' ? data.error : fallback;

/** Show freshly issued recovery codes. They exist in plaintext only in this one answer. */
async function showRecoveryCodes(codes: unknown): Promise<void> {
  const list = Array.isArray(codes) ? codes.filter((c): c is string => typeof c === 'string') : [];
  if (list.length === 0) return;
  const copy = await confirmDialog(
    `Your recovery codes — each one works once, if you lose your phone. Keep them somewhere safe; they will not be shown again.\n\n${list.join('\n')}`,
    { confirmLabel: 'Copy and close', cancelLabel: 'Close' },
  );
  if (copy) await navigator.clipboard?.writeText(list.join('\n')).catch(() => undefined);
}

export class TotpSettings {
  private status: Status | null = null;

  constructor(private readonly root: HTMLElement) {
    root.querySelector<HTMLButtonElement>('#pa-2fa-on')!.onclick = () => void this.setUp();
    root.querySelector<HTMLButtonElement>('#pa-2fa-off')!.onclick = () => void this.turnOff();
    root.querySelector<HTMLButtonElement>('#pa-2fa-codes')!.onclick = () => void this.newCodes();
  }

  /** Ask the server and redraw. A failure hides the block — Settings must not depend on it. */
  async refresh(): Promise<void> {
    try {
      const res = await serverFetch('/account/totp', { cache: 'no-store' });
      this.status = res.ok ? ((await res.json()) as Status) : null;
    } catch {
      this.status = null;
    }
    this.render();
  }

  private render(): void {
    const block = this.root.querySelector<HTMLDivElement>('#pa-2fa');
    if (!block) return;
    const s = this.status;
    block.style.display = s ? '' : 'none';
    if (!s) return;
    const q = <T extends HTMLElement>(sel: string): T => block.querySelector<T>(sel)!;
    // style.display rather than `hidden`: the panel's own button rules set a display.
    const show = (sel: string, on: boolean): void => void (q(sel).style.display = on ? '' : 'none');
    show('#pa-2fa-on', !s.enabled);
    show('#pa-2fa-off', s.enabled);
    show('#pa-2fa-codes', s.enabled);
    q<HTMLButtonElement>('#pa-2fa-on').disabled = !s.hasPassword;
    q('#pa-2fa-state').textContent = `Two-factor sign-in: ${s.enabled ? 'on' : 'off'}`;
    q('#pa-2fa-hint').textContent = !s.hasPassword
      ? 'Set a password first — two-factor protects signing in with it. Single sign-on uses your provider’s own.'
      : s.enabled
        ? `Signing in with your password also asks for a code from your authenticator app. ${s.recoveryCodesLeft} recovery code${s.recoveryCodesLeft === 1 ? '' : 's'} left.`
        : 'Ask for a code from an authenticator app (Aegis, Google Authenticator, 1Password, …) whenever you sign in with your password.';
  }

  private async setUp(): Promise<void> {
    const started = await post('/account/totp/setup');
    if (!started.ok || typeof started.data.secret !== 'string' || typeof started.data.qrSvg !== 'string') {
      await alertDialog(errorOf(started.data, 'Could not start the setup.'));
      return;
    }
    const secret = started.data.secret;
    // The QR as an <img> from a data URL rather than as markup: nothing the server sends is parsed
    // into this document.
    const extra = document.createElement('div');
    extra.style.cssText = 'text-align:center;margin:0 0 1rem;';
    const img = document.createElement('img');
    img.alt = 'QR code for your authenticator app';
    img.width = img.height = 200;
    img.style.cssText = 'background:#fff;border-radius:0.35rem;image-rendering:pixelated;';
    img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(started.data.qrSvg)}`;
    const key = document.createElement('div');
    key.style.cssText = 'font-size:0.8rem;color:#adb0b2;margin-top:0.5rem;word-break:break-all;user-select:all;';
    key.textContent = secret.replace(/(.{4})/g, '$1 ').trim();
    extra.append(img, key);

    let error: string | undefined;
    for (;;) {
      const values = await formDialog(
        'Scan this with your authenticator app (or type the key below it), then enter the 6-digit code it shows and your password.',
        [{ ...CODE, placeholder: '123456' }, PASSWORD],
        { confirmLabel: 'Turn on', error, extra },
      );
      if (!values) {
        await post('/account/totp/cancel');
        break;
      }
      const done = await post('/account/totp/enable', values);
      if (done.ok) {
        await showRecoveryCodes(done.data.recoveryCodes);
        break;
      }
      error = errorOf(done.data, 'That did not work — try again.');
    }
    await this.refresh();
  }

  private async turnOff(): Promise<void> {
    let error: string | undefined;
    for (;;) {
      const values = await formDialog('Turn off two-factor sign-in? Your password alone will sign you in again.', [CODE, PASSWORD], {
        confirmLabel: 'Turn off',
        danger: true,
        error,
      });
      if (!values) break;
      const done = await post('/account/totp/disable', values);
      if (done.ok) break;
      error = errorOf(done.data, 'That did not work — try again.');
    }
    await this.refresh();
  }

  private async newCodes(): Promise<void> {
    let error: string | undefined;
    for (;;) {
      const values = await formDialog('Replace your recovery codes? The old ones stop working.', [CODE, PASSWORD], {
        confirmLabel: 'Replace',
        error,
      });
      if (!values) break;
      const done = await post('/account/totp/recovery', values);
      if (done.ok) {
        await showRecoveryCodes(done.data.recoveryCodes);
        break;
      }
      error = errorOf(done.data, 'That did not work — try again.');
    }
    await this.refresh();
  }
}
