/**
 * Shared "zone entry password" widget — used by both the standalone admin
 * website (client/src/admin/main.ts) and Pixels' own in-game Zones panel
 * (client/src/scenes/OfficeScene.ts). Both call the same REST route
 * (adminApi.setZonePassword), which the server allows for that zone's owner
 * too, not just a global admin — see server/src/adminApi.ts's
 * zoneCapabilityAuth('zone.managePassword').
 */
import { adminApi } from '../admin/api.js';
import { generatePassword } from './generatePassword.js';

export interface ZonePasswordWidgetOptions {
  /** Surface a failed set/clear however this host shows errors. */
  onError: (action: string, error?: string) => void;
  /** Notified after a successful set/clear, so the host can refresh any
   *  summary badge (e.g. the admin site's zone-row lock icon). */
  onChange?: (locked: boolean) => void;
  /** Button/input classes so this widget matches the host's existing skin
   *  (the admin site's `.act` vs Pixels' `.pa-b`). */
  classNames?: {
    button?: string;
    primaryButton?: string;
    dangerButton?: string;
    input?: string;
  };
}

export interface ZonePasswordWidget {
  /** Force the view back to the locked/unlocked status (e.g. if the host
   *  detects a change elsewhere). */
  refresh: (locked: boolean) => void;
}

/** Builds the widget's DOM into `container` (cleared first), reflecting
 *  `locked` initially. Returns a handle to force a re-render later if needed. */
export function renderZonePasswordWidget(
  container: HTMLElement,
  zoneId: string,
  locked: boolean,
  opts: ZonePasswordWidgetOptions,
): ZonePasswordWidget {
  const cls = opts.classNames ?? {};
  container.innerHTML = '';

  const status = document.createElement('span');
  const actions = document.createElement('div');
  actions.style.cssText = 'display:flex;gap:.35rem;align-items:center;flex-wrap:wrap;';

  const renderView = (): void => {
    status.textContent = locked ? '🔒 locked' : '— not locked';
    actions.innerHTML = '';
    const setBtn = document.createElement('button');
    setBtn.type = 'button';
    setBtn.textContent = '🔑 Set new password…';
    if (cls.button) setBtn.className = cls.button;
    setBtn.onclick = renderEdit;
    const clearBtn = document.createElement('button');
    clearBtn.type = 'button';
    clearBtn.textContent = '✕ Clear lock';
    clearBtn.disabled = !locked;
    if (cls.dangerButton) clearBtn.className = cls.dangerButton;
    clearBtn.onclick = async () => {
      const res = await adminApi.setZonePassword(zoneId, '');
      if (!res.ok) { opts.onError('Clear password', res.error); return; }
      locked = !!res.data?.locked;
      opts.onChange?.(locked);
      renderView();
    };
    actions.append(setBtn, clearBtn);
  };

  const renderEdit = (): void => {
    actions.innerHTML = '';
    const pw = document.createElement('input');
    pw.type = 'password';
    pw.placeholder = 'new password';
    if (cls.input) pw.className = cls.input;
    const eyeBtn = document.createElement('button');
    eyeBtn.type = 'button';
    eyeBtn.textContent = '👁';
    eyeBtn.title = 'Show password';
    if (cls.button) eyeBtn.className = cls.button;
    eyeBtn.onclick = () => {
      const shown = pw.type === 'text';
      pw.type = shown ? 'password' : 'text';
      eyeBtn.textContent = shown ? '👁' : '🙈';
      eyeBtn.title = shown ? 'Show password' : 'Hide password';
    };
    const genBtn = document.createElement('button');
    genBtn.type = 'button';
    genBtn.textContent = '🎲 Generate';
    if (cls.button) genBtn.className = cls.button;
    genBtn.onclick = () => {
      pw.value = generatePassword();
      pw.type = 'text';
      eyeBtn.textContent = '🙈';
      eyeBtn.title = 'Hide password';
    };
    const setBtn = document.createElement('button');
    setBtn.type = 'button';
    setBtn.textContent = 'Set';
    if (cls.primaryButton) setBtn.className = cls.primaryButton;
    setBtn.onclick = async () => {
      const res = await adminApi.setZonePassword(zoneId, pw.value);
      if (!res.ok) { opts.onError('Set password', res.error); return; }
      locked = !!res.data?.locked;
      opts.onChange?.(locked);
      renderView();
    };
    const cancelBtn = document.createElement('button');
    cancelBtn.type = 'button';
    cancelBtn.textContent = 'Cancel';
    if (cls.button) cancelBtn.className = cls.button;
    cancelBtn.onclick = renderView;
    actions.append(pw, eyeBtn, genBtn, setBtn, cancelBtn);
    pw.focus();
  };

  renderView();
  container.append(status, actions);

  return {
    refresh: (l) => {
      locked = l;
      renderView();
    },
  };
}
