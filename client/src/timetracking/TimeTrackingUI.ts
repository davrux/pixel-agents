/**
 * The time clock's face, and the settings view behind it.
 *
 * Desktop only, and built the way Mumble's window is (voice/MumbleSettingsUI.ts):
 * the connection details belong with the client that uses them, not in the
 * office's own Settings panel — so the clock owns both views and ◀/⚙ moves
 * between them. Everything about the account lives on the user's machine: the
 * server address and username in Electron's userData, the password in the OS
 * keychain. Neither this renderer nor the pixel-agents server ever sees it.
 *
 * The clock therefore has three distinct things to say, and says them
 * precisely — "it doesn't work here" and "you haven't set it up" are different
 * problems with different fixes:
 *   - browser build      → there is no main process, so no TimeTracking at all
 *   - desktop, unset     → connect an account, here, on this machine
 *   - desktop, connected → today's total and the punch buttons
 *
 * The face ticks locally off `runningSince` so it moves every second while main
 * only polls once a minute; a booking refreshes it immediately, that being the
 * moment the number visibly changes.
 */
import { WORK_STATUS_ICON, WORK_STATUS_LABEL, formatWorkedTime } from '@pixel/shared/timetracking';

import {
  desktop,
  isDesktop,
  timeTrackingApi,
  type TimeTrackingSettingsView,
  type WorkAction,
  type WorkSnapshot,
} from '../desktop/bridge.js';
import { alertDialog, confirmDialog } from '../ui/dialog.js';
import { serverHttpOrigin } from '../net/room.js';

const SECRET_PLACEHOLDER = '••••••••';
/** How often the face repaints its local clock. */
const TICK_MS = 1000;

type View = 'clock' | 'settings';

export interface TimeTrackingHooks {
  /** A new status to report to the pixel-agents server, so other players see
   *  the glyph over this character. Fires on every refresh, including the
   *  background poll in main — not only while the panel is open. */
  onStatus(snapshot: WorkSnapshot): void;
}

export class TimeTrackingUI {
  /** The panel body: both views live in here, one shown at a time. */
  readonly el: HTMLElement;

  private readonly api = timeTrackingApi();
  private settings: TimeTrackingSettingsView | null = null;
  private snapshot: WorkSnapshot | null = null;
  private view: View = 'clock';
  private open = false;
  private busy = false;
  private tick?: ReturnType<typeof setInterval>;

  constructor(private readonly hooks: TimeTrackingHooks) {
    this.el = document.createElement('div');
    this.el.id = 'pa-tt';
    this.injectStyles();
    this.build();
    if (!this.api) {
      this.render();
      return;
    }
    // Main pushes on every refresh, so the server's copy of the status stays
    // current whether or not anyone is standing at a clock.
    this.api.onStatus((snapshot) => {
      this.snapshot = snapshot;
      this.hooks.onStatus(snapshot);
      if (this.open) this.render();
    });
    void this.load();
  }

  /** Walked up to a clock (or walked away). */
  setOpen(open: boolean): void {
    this.open = open;
    if (!open) {
      this.stopTicking();
      return;
    }
    this.view = 'clock';
    this.render();
    if (!this.api) return;
    void this.refresh();
    this.startTicking();
  }

  destroy(): void {
    this.stopTicking();
  }

  // ── Data ────────────────────────────────────────────────────────

  private async load(): Promise<void> {
    this.settings = (await this.api?.getSettings().catch(() => null)) ?? null;
    if (this.settings?.configured) await this.refresh();
    this.render();
  }

  private async refresh(): Promise<void> {
    const snapshot = await this.api?.getStatus().catch(() => null);
    if (snapshot) {
      this.snapshot = snapshot;
      this.hooks.onStatus(snapshot);
    }
    this.render();
  }

  private startTicking(): void {
    if (this.tick) return;
    // Only a running entry makes the number move; a paused or finished day
    // needs no repaint at all.
    this.tick = setInterval(() => {
      if (this.view === 'clock' && this.snapshot?.runningSince != null) this.render();
    }, TICK_MS);
  }

  private stopTicking(): void {
    if (this.tick) clearInterval(this.tick);
    this.tick = undefined;
  }

  /** Today's total right now: what is already booked, plus the running entry. */
  private workedMs(): number {
    const s = this.snapshot;
    if (!s) return 0;
    const live = s.runningSince === null ? 0 : Math.max(0, Date.now() - s.runningSince);
    return s.completedMs + live;
  }

  // ── Markup ──────────────────────────────────────────────────────

  private build(): void {
    this.el.innerHTML = `
      <section class="v-clock">
        <div class="unavailable" hidden></div>
        <div class="clock" hidden>
          <div class="total">0:00</div>
          <div class="state"><span class="glyph"></span><span class="lbl"></span></div>
        </div>
        <div class="err" hidden></div>
        <div class="acts" hidden>
          <button class="pa-b start">▶ Start</button>
          <button class="pa-b pause">⏸ Pause</button>
          <button class="pa-b end">⏹ End</button>
        </div>
        <button class="cfg" hidden>⚙ Your TimeTracking account</button>
      </section>
      <section class="v-settings" hidden>
        <div class="subhead">
          <button class="back" title="Back to the clock" aria-label="Back to the clock">◀</button>
          <span class="ti">Your TimeTracking account</span>
        </div>
        <div class="fields">
          <label class="lbl" for="pa-tt-url">Server</label>
          <input id="pa-tt-url" class="pa-input" type="text" maxlength="300" placeholder="https://timetracking.example.com">
          <div class="suggest" hidden></div>
          <label class="lbl" for="pa-tt-user">Username</label>
          <input id="pa-tt-user" class="pa-input" type="text" maxlength="200" autocomplete="username">
          <label class="lbl" for="pa-tt-pw">Password</label>
          <input id="pa-tt-pw" class="pa-input" type="password" maxlength="200" autocomplete="new-password">
          <div class="hint">Stored on this computer only — the address and username in the app's own data, the password in your system keychain. The pixel-agents server never receives them; it only learns whether you are working, on a break or off the clock, so your character can show it.</div>
          <div class="warn" hidden>No system keychain — the password can't be saved on this machine.</div>
          <div class="err" hidden></div>
          <button class="save">Connect</button>
          <button class="off" hidden>Disconnect</button>
        </div>
      </section>`;

    const bind = (sel: string, action: WorkAction): void => {
      this.el.querySelector<HTMLButtonElement>(sel)!.onclick = () => void this.book(action);
    };
    bind('.start', 'start');
    bind('.pause', 'pause');
    bind('.end', 'end');
    this.el.querySelector<HTMLButtonElement>('.cfg')!.onclick = () => this.show('settings');
    this.el.querySelector<HTMLButtonElement>('.back')!.onclick = () => this.show('clock');
    this.el.querySelector<HTMLButtonElement>('.save')!.onclick = () => void this.save();
    this.el.querySelector<HTMLButtonElement>('.off')!.onclick = () => void this.disconnect();
  }

  private show(view: View): void {
    this.view = view;
    if (view === 'settings') this.fillSettingsForm();
    this.render();
  }

  // ── Rendering ───────────────────────────────────────────────────

  private render(): void {
    const clockView = this.el.querySelector<HTMLElement>('.v-clock')!;
    const settingsView = this.el.querySelector<HTMLElement>('.v-settings')!;
    clockView.hidden = this.view !== 'clock';
    settingsView.hidden = this.view !== 'settings';
    if (this.view === 'clock') this.renderClock();
  }

  private renderClock(): void {
    const unavailable = this.el.querySelector<HTMLElement>('.unavailable')!;
    const clock = this.el.querySelector<HTMLElement>('.clock')!;
    const acts = this.el.querySelector<HTMLElement>('.acts')!;
    const cfg = this.el.querySelector<HTMLButtonElement>('.cfg')!;
    const err = this.el.querySelector<HTMLElement>('.v-clock > .err')!;

    // 1. No desktop app: the feature cannot exist here, and no amount of
    //    configuring in this browser would change that. Say so plainly, and
    //    don't offer a settings view that could not store anything.
    if (!this.api) {
      unavailable.hidden = false;
      unavailable.innerHTML = isDesktop()
        ? 'This copy of the desktop app is too old to punch the clock — update it and try again.'
        : 'The time clock only works in the <b>pixel-agents desktop app</b>. Your TimeTracking password is kept in your computer\'s keychain, which a browser tab has no access to — so there is nothing here to punch with.';
      clock.hidden = true;
      acts.hidden = true;
      cfg.hidden = true;
      err.hidden = true;
      return;
    }

    // 2. Desktop, but no account connected yet: an actionable prompt, and the
    //    button that fixes it right here.
    if (!this.settings?.configured) {
      unavailable.hidden = false;
      unavailable.textContent = this.settings?.keychainAvailable === false
        ? 'This system has no keychain, so a TimeTracking password cannot be stored safely. The clock stays unavailable until one is available.'
        : 'No card in this clock yet. Connect your TimeTracking account to punch in and out from the world.';
      clock.hidden = true;
      acts.hidden = true;
      err.hidden = true;
      cfg.hidden = this.settings?.keychainAvailable === false;
      cfg.textContent = '⚙ Connect your TimeTracking account';
      return;
    }

    // 3. Connected: the clock proper.
    unavailable.hidden = true;
    clock.hidden = false;
    acts.hidden = false;
    cfg.hidden = false;
    cfg.textContent = '⚙ Your TimeTracking account';

    const snapshot = this.snapshot;
    err.hidden = !snapshot?.error;
    err.textContent = snapshot?.error ?? '';

    this.el.querySelector<HTMLElement>('.total')!.textContent = formatWorkedTime(this.workedMs());
    this.el.querySelector<HTMLElement>('.glyph')!.textContent = WORK_STATUS_ICON[snapshot?.status ?? ''] || '';
    this.el.querySelector<HTMLElement>('.lbl')!.textContent = snapshot
      ? WORK_STATUS_LABEL[snapshot.status] || 'Unknown'
      : 'Reading your card…';

    for (const action of ['start', 'pause', 'end'] as const) {
      const btn = this.el.querySelector<HTMLButtonElement>(`.${action}`)!;
      const allowed = snapshot?.can[action] === true;
      btn.disabled = this.busy || !allowed;
      btn.title = !this.busy && !allowed ? "TimeTracking doesn't allow this right now" : '';
    }
  }

  private fillSettingsForm(): void {
    const url = this.el.querySelector<HTMLInputElement>('#pa-tt-url')!;
    const user = this.el.querySelector<HTMLInputElement>('#pa-tt-user')!;
    const pw = this.el.querySelector<HTMLInputElement>('#pa-tt-pw')!;
    url.value = this.settings?.baseUrl ?? '';
    user.value = this.settings?.username ?? '';
    pw.value = '';
    // A stored password is never read back, only replaced.
    pw.placeholder = this.settings?.hasPassword ? SECRET_PLACEHOLDER : '';
    this.el.querySelector<HTMLElement>('.warn')!.hidden = this.settings?.keychainAvailable !== false;
    this.el.querySelector<HTMLElement>('.v-settings .err')!.hidden = true;
    this.el.querySelector<HTMLButtonElement>('.off')!.hidden = !this.settings?.hasPassword && !this.settings?.baseUrl;
    this.el.querySelector<HTMLButtonElement>('.save')!.textContent = this.settings?.configured ? 'Reconnect' : 'Connect';
    void this.offerSuggestion();
  }

  /** The pixel-agents server can suggest the company's TimeTracking address
   *  (env only, never a credential), so users don't type an address the
   *  operator already knows — the same courtesy Mumble's settings offer. */
  private async offerSuggestion(): Promise<void> {
    const el = this.el.querySelector<HTMLElement>('.suggest')!;
    const url = this.el.querySelector<HTMLInputElement>('#pa-tt-url')!;
    if (url.value.trim()) {
      el.hidden = true;
      return;
    }
    const suggestion = await fetchSuggestedUrl();
    if (!suggestion || url.value.trim()) return;
    el.hidden = false;
    el.replaceChildren('Suggested: ');
    const link = document.createElement('a');
    link.textContent = suggestion;
    link.onclick = () => {
      url.value = suggestion;
      el.hidden = true;
    };
    el.appendChild(link);
  }

  // ── Actions ─────────────────────────────────────────────────────

  private async book(action: WorkAction): Promise<void> {
    if (this.busy || !this.api) return;
    this.busy = true;
    this.render();
    const res = await this.api.book(action).catch(() => null);
    this.busy = false;
    if (res?.ok) this.snapshot = res.snapshot;
    else await alertDialog(res?.error ?? 'Could not book your working time.');
    if (this.snapshot) this.hooks.onStatus(this.snapshot);
    this.render();
  }

  private async save(): Promise<void> {
    if (!this.api) return;
    const save = this.el.querySelector<HTMLButtonElement>('.save')!;
    const err = this.el.querySelector<HTMLElement>('.v-settings .err')!;
    const baseUrl = this.el.querySelector<HTMLInputElement>('#pa-tt-url')!.value.trim();
    const username = this.el.querySelector<HTMLInputElement>('#pa-tt-user')!.value.trim();
    const password = this.el.querySelector<HTMLInputElement>('#pa-tt-pw')!.value;

    err.hidden = true;
    save.disabled = true;
    save.textContent = 'Connecting…';
    // A blank password field with one already stored means "keep it".
    const res = await this.api
      .setSettings({ baseUrl, username, ...(password ? { password } : {}) })
      .catch(() => null);
    save.disabled = false;

    if (!res?.ok) {
      err.hidden = false;
      err.textContent = res?.error ?? 'Could not connect.';
      save.textContent = this.settings?.configured ? 'Reconnect' : 'Connect';
      return;
    }
    this.settings = res.view;
    await this.refresh();
    this.show('clock');
  }

  private async disconnect(): Promise<void> {
    if (!this.api) return;
    if (!(await confirmDialog('Disconnect TimeTracking? The stored login is deleted from this computer.'))) return;
    this.settings = await this.api.disconnect().catch(() => this.settings);
    this.snapshot = null;
    // Tell the server the glyph is gone, or it would linger until the session ends.
    this.hooks.onStatus({
      configured: false,
      status: '',
      runningSince: null,
      completedMs: 0,
      can: { start: false, pause: false, end: false },
      asOf: Date.now(),
      error: null,
    });
    this.show('clock');
  }

  // ── Styles ──────────────────────────────────────────────────────

  private injectStyles(): void {
    if (document.getElementById('pa-tt-style')) return;
    const style = document.createElement('style');
    style.id = 'pa-tt-style';
    style.textContent = `
      /* The flex rules below would out-specify the UA's [hidden] rule, leaving
         a "hidden" block on screen. */
      #pa-tt [hidden]{display:none !important;}
      #pa-tt .unavailable{font-size:0.9rem;color:#adb0b2;line-height:1.55;margin:0.2rem 0 0.8rem;}
      #pa-tt .unavailable b{color:#f1efec;}
      /* The day's total is the point of walking over here, so it gets the size. */
      #pa-tt .clock{display:flex;flex-direction:column;align-items:center;gap:0.2rem;margin:0.2rem 0 0.8rem;}
      #pa-tt .total{font-size:2.6rem;line-height:1;color:#f5f3f0;letter-spacing:1px;}
      #pa-tt .state{display:flex;align-items:center;gap:0.4rem;font-size:0.95rem;color:#adb0b2;}
      #pa-tt .acts{display:flex;gap:0.4rem;margin-bottom:0.7rem;}
      #pa-tt .acts button{flex:1;}
      #pa-tt .acts button:disabled{opacity:0.4;cursor:default;}
      #pa-tt .err{font-size:0.8rem;color:#f0696e;margin:0.3rem 0 0.5rem;line-height:1.45;}
      #pa-tt .cfg{width:100%;background:#262422;border:2px solid #0a0908;color:#adb0b2;border-radius:0.35rem;
        font:0.85rem 'FS Pixel Sans',monospace;padding:0.45rem;cursor:pointer;
        box-shadow:inset 0 2px 0 #4a4744,inset 0 -3px 0 #050505;}
      /* Settings view: same shape as the Mumble window's own settings page. */
      #pa-tt .subhead{display:flex;align-items:center;gap:0.5rem;padding-bottom:0.5rem;
        border-bottom:2px solid #0a0908;box-shadow:inset 0 -1px 0 #2c2a28;margin-bottom:0.3rem;}
      #pa-tt .subhead .ti{flex:1;min-width:0;font-size:1rem;color:#f1efec;}
      #pa-tt .subhead .back{background:#262422;border:2px solid #0a0908;color:#f1efec;border-radius:0.35rem;
        font:0.9rem 'FS Pixel Sans',monospace;padding:0.2rem 0.5rem;cursor:pointer;}
      /* Label above field, not beside it: this column is ~24rem and a server
         address needs all of it. */
      #pa-tt label.lbl{display:block;color:#818586;font-size:0.85rem;margin:0.55rem 0 0.15rem;}
      #pa-tt .pa-input{width:100%;}
      #pa-tt .hint{font-size:0.8rem;color:#818586;margin:0.5rem 0 0.2rem;line-height:1.5;}
      #pa-tt .warn{font-size:0.8rem;color:#e0b062;margin:0.5rem 0 0;line-height:1.45;}
      #pa-tt .suggest{font-size:0.8rem;color:#818586;margin:0.25rem 0 0;}
      #pa-tt .suggest a{color:#4998c0;cursor:pointer;text-decoration:underline;}
      #pa-tt .save,#pa-tt .off{width:100%;margin-top:0.6rem;background:#292725;color:#ece9e4;border:2px solid #0a0908;
        border-radius:0.35rem;font:0.95rem 'FS Pixel Sans',monospace;padding:0.5rem;cursor:pointer;
        box-shadow:inset 0 2px 0 #4a4744,inset 0 -3px 0 #141210;}
      #pa-tt .off{background:#7c2634;color:#f1d0d6;box-shadow:inset 0 2px 0 #b34a5a,inset 0 -3px 0 #45111a;}
      #pa-tt .save:disabled{opacity:0.5;cursor:default;}
    `;
    document.head.appendChild(style);
  }
}

/** Ask the pixel-agents server for the TimeTracking address it suggests.
 *  Returns null when unset, unauthorized or absent — purely optional. */
async function fetchSuggestedUrl(): Promise<string | null> {
  try {
    const token = await desktop().getToken();
    const res = await fetch(`${serverHttpOrigin()}/timetracking/config`, {
      cache: 'no-store',
      // Desktop-only (see the header): always a genuine cross-origin request
      // (app://bundle -> the real server), and the server's CORS response never
      // sets Access-Control-Allow-Credentials, so 'include' would make the
      // browser reject the response outright. Auth here is bearer-only anyway.
      credentials: 'omit',
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { baseUrl?: unknown };
    return typeof body.baseUrl === 'string' && body.baseUrl ? body.baseUrl : null;
  } catch {
    return null;
  }
}
