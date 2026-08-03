/**
 * Shared "conference monitors" widget — used by both the standalone admin
 * website (client/src/admin/main.ts) and Pixels' own in-game Zones panel
 * (client/src/scenes/OfficeScene.ts). Both call the same REST routes
 * (adminApi.listMonitors/setMonitorPassword), which the server allows for
 * that zone's owner too, not just a global admin — see
 * server/src/adminApi.ts's zoneCapabilityAuth('zone.manageMonitors').
 *
 * Monitors come from the zone's active saved layout (where admins place them
 * in the editor) — a zone with none shows an explanatory empty state instead
 * of a bare table.
 */
import { adminApi } from '../admin/api.js';
import { generatePassword } from './generatePassword.js';

export interface ZoneMonitorsWidgetOptions {
  /** Surface a failed load/set/clear however this host shows errors. */
  onError: (action: string, error?: string) => void;
  /** Button/input classes so this widget matches the host's existing skin. */
  classNames?: {
    button?: string;
    primaryButton?: string;
    input?: string;
  };
}

export interface ZoneMonitorsWidget {
  /** Re-fetch and re-render the list (e.g. if the host detects a layout change). */
  refresh: () => Promise<void>;
}

/** Builds the widget's DOM into `container` (cleared first) and does the
 *  initial fetch. Returns a handle to force a re-fetch later if needed. */
export function renderZoneMonitorsWidget(container: HTMLElement, zoneId: string, opts: ZoneMonitorsWidgetOptions): ZoneMonitorsWidget {
  const cls = opts.classNames ?? {};

  const refresh = async (): Promise<void> => {
    const res = await adminApi.listMonitors(zoneId);
    if (!res.ok) {
      opts.onError('Load monitors', res.error);
      return;
    }
    const monitors = res.data?.monitors ?? [];
    container.innerHTML = '';
    if (!monitors.length) {
      const empty = document.createElement('div');
      empty.textContent = "No monitors in this zone's saved layout.";
      empty.style.cssText = 'font-size:.85rem;opacity:.7;';
      container.appendChild(empty);
      return;
    }
    const list = document.createElement('div');
    list.style.cssText = 'display:flex;flex-direction:column;gap:.5rem;';
    for (const m of monitors) {
      const label = m.name || `Screen ${m.key}`;
      const row = document.createElement('div');
      row.style.cssText = 'display:flex;align-items:center;gap:.5rem;flex-wrap:wrap;';

      const nm = document.createElement('span');
      nm.style.cssText = 'flex:1;min-width:8rem;font-size:.85rem;';
      nm.textContent = `📹 ${label}`;
      const status = document.createElement('span');
      status.style.cssText = 'font-size:.85rem;';
      status.textContent = m.locked ? '🔒 locked' : '—';

      const pw = document.createElement('input');
      pw.type = 'password';
      pw.placeholder = m.locked ? 'set new' : 'set password';
      pw.size = 14;
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
      };
      const genBtn = document.createElement('button');
      genBtn.type = 'button';
      genBtn.textContent = '🎲';
      genBtn.title = 'Generate a password';
      if (cls.button) genBtn.className = cls.button;
      genBtn.onclick = () => {
        pw.value = generatePassword();
        pw.type = 'text';
        eyeBtn.textContent = '🙈';
      };
      const setBtn = document.createElement('button');
      setBtn.type = 'button';
      setBtn.textContent = 'Set';
      if (cls.primaryButton) setBtn.className = cls.primaryButton;
      setBtn.onclick = async () => {
        const r = await adminApi.setMonitorPassword(zoneId, m.key, pw.value);
        if (!r.ok) { opts.onError('Set monitor password', r.error); return; }
        void refresh();
      };
      const clearBtn = document.createElement('button');
      clearBtn.type = 'button';
      clearBtn.textContent = 'Clear';
      clearBtn.disabled = !m.locked;
      if (cls.button) clearBtn.className = cls.button;
      clearBtn.onclick = async () => {
        const r = await adminApi.setMonitorPassword(zoneId, m.key, '');
        if (!r.ok) { opts.onError('Clear', r.error); return; }
        void refresh();
      };

      row.append(nm, status, pw, eyeBtn, genBtn, setBtn, clearBtn);
      list.appendChild(row);
    }
    container.appendChild(list);
  };

  void refresh();
  return { refresh };
}
