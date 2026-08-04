/**
 * Shared "Zone admins" list + grant/revoke widget — used by both the
 * standalone admin website (client/src/admin/main.ts) and Pixels' own
 * in-game Zones panel (client/src/scenes/OfficeScene.ts). Both call the same
 * REST route (adminApi.listZoneAdmins/grantZoneAdmin/revokeZoneAdmin), which
 * the server allows for that zone's owner too, not just a global admin — see
 * server/src/adminApi.ts's zoneGrantAdminAuth. Keeping the DOM-building and
 * wiring in one place means the two surfaces can't drift apart as more of
 * this kind of per-zone admin UI gets added later.
 */
import { adminApi } from '../admin/api.js';

export interface ZoneAdminsWidgetOptions {
  /** Wire a login-id input to whichever autocomplete each host already has
   *  (the admin site and Pixels each maintain their own user-list source). */
  wireAutocomplete: (input: HTMLInputElement) => void;
  /** Surface a failed grant/revoke/load however this host shows errors. */
  onError: (action: string, error?: string) => void;
  /** Button/input classes so this widget matches the host's existing skin
   *  (the admin site's `.act`/`.act.primary` vs Pixels' `.pa-b`/`.pa-b.primary`). */
  classNames?: {
    revokeButton?: string;
    grantButton?: string;
    input?: string;
  };
}

export interface ZoneAdminsWidget {
  /** Re-fetch and re-render the list (e.g. if the host detects a change elsewhere). */
  refresh: () => Promise<void>;
}

/** Builds the widget's DOM into `container` (cleared first) and does the
 *  initial fetch. Returns a handle to force a re-fetch later if needed. */
export function renderZoneAdminsWidget(container: HTMLElement, zoneId: string, opts: ZoneAdminsWidgetOptions): ZoneAdminsWidget {
  const cls = opts.classNames ?? {};
  container.innerHTML = '';

  const list = document.createElement('div');
  list.style.cssText = 'display:flex;flex-direction:column;gap:.35rem;';
  const toolbar = document.createElement('div');
  toolbar.style.cssText = 'display:flex;gap:.35rem;margin-top:.5rem;';
  const input = document.createElement('input');
  input.placeholder = 'login id';
  input.maxLength = 32;
  if (cls.input) input.className = cls.input;
  input.style.cssText = 'flex:1;min-width:0;';
  const grantBtn = document.createElement('button');
  grantBtn.type = 'button';
  grantBtn.textContent = 'Grant';
  if (cls.grantButton) grantBtn.className = cls.grantButton;

  const refresh = async (): Promise<void> => {
    const res = await adminApi.listZoneAdmins(zoneId);
    if (!res.ok) {
      opts.onError('Load zone admins', res.error);
      return;
    }
    const admins = res.data?.admins ?? [];
    list.innerHTML = '';
    if (!admins.length) {
      const empty = document.createElement('div');
      empty.textContent = 'No zone-admins yet.';
      empty.style.cssText = 'font-size:.85rem;opacity:.7;';
      list.appendChild(empty);
    }
    for (const a of admins) {
      const row = document.createElement('div');
      row.style.cssText = 'display:flex;align-items:center;gap:.5rem;';
      const nm = document.createElement('span');
      nm.style.cssText = 'flex:1;font-size:.85rem;';
      nm.textContent = `${a.isAdmin ? '★ ' : ''}${a.name}`;
      const rm = document.createElement('button');
      rm.type = 'button';
      rm.textContent = 'Revoke';
      if (cls.revokeButton) rm.className = cls.revokeButton;
      rm.onclick = async () => {
        const r = await adminApi.revokeZoneAdmin(zoneId, a.userId);
        if (!r.ok) opts.onError('Revoke', r.error);
        else void refresh();
      };
      row.append(nm, rm);
      list.appendChild(row);
    }
  };

  grantBtn.onclick = async () => {
    const uid = input.value.trim();
    if (!uid) return;
    const res = await adminApi.grantZoneAdmin(zoneId, uid);
    if (!res.ok) {
      opts.onError('Grant', res.error);
      return;
    }
    input.value = '';
    void refresh();
  };

  toolbar.append(input, grantBtn);
  container.append(list, toolbar);
  opts.wireAutocomplete(input);
  void refresh();

  return { refresh };
}
