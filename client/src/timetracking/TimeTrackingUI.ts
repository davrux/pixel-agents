/**
 * The TimeTracking UI: two views over one piece of state.
 *
 * - `settingsView` is a block appended into the office's Settings panel — the
 *   server address and login, which you set once. Credentials belong to the
 *   account, not to any one machine.
 * - `panelView` is the face of the time clock: today's total and the punch
 *   buttons, shown when you walk up to the TIME_CLOCK furniture.
 *
 * Both read the same snapshot. The clock ticks locally off `runningSince` so it
 * moves every second while the server is only polled once a minute; a booking
 * refreshes it immediately, since that is the moment the number visibly changes.
 * Polling and ticking only run while the panel is open — the status glyph over
 * everyone's head comes from the server's own poller, not from here.
 *
 * Which buttons are enabled is not decided here — TimeTracking installs
 * configure their own rules about what may follow what, and the server relays
 * that as `allowed` (see canBook).
 */
import { WORK_STATUS_ICON, WORK_STATUS_LABEL, formatWorkedTime, type WorkAction } from '@pixel/shared';

import { alertDialog, confirmDialog } from '../ui/dialog.js';
import { canBook, timeTrackingApi, workedMs, type TimeTrackingSettings, type WorkSnapshot } from './api.js';

const SECRET_PLACEHOLDER = '••••••••';
/** How often the server is asked for a fresh snapshot while the HUD is open. */
const POLL_MS = 60_000;
/** How often the local clock is repainted. */
const TICK_MS = 1000;

export class TimeTrackingUI {
  /** Block for the Settings panel (connection details). */
  readonly settingsView: HTMLElement;
  /** Body of the time clock's panel (today's total + the three buttons). */
  readonly panelView: HTMLElement;

  private settings: TimeTrackingSettings = { configured: false, baseUrl: '', username: '' };
  private snapshot: WorkSnapshot | null = null;
  private panelOpen = false;
  private busy = false;
  private tick?: ReturnType<typeof setInterval>;
  private lastPoll = 0;

  constructor() {
    this.injectStyles();
    this.settingsView = this.buildSettings();
    this.panelView = this.buildPanel();
  }

  /** Load what's configured, so the Settings block is populated before anyone
   *  opens it. No status is fetched here — that waits until someone actually
   *  walks up to a clock. */
  async start(): Promise<void> {
    const res = await timeTrackingApi.getSettings();
    if (res.data) this.settings = res.data;
    this.renderSettings();
  }

  /** The clock's panel opened or closed. Nothing polls or ticks while it is
   *  shut: a player who never uses a clock costs this integration nothing. */
  setPanelOpen(open: boolean): void {
    this.panelOpen = open;
    if (!open) {
      this.stopTicking();
      return;
    }
    this.renderPanel();
    if (!this.settings.configured) return;
    void this.poll();
    this.ensureTicking();
  }

  destroy(): void {
    this.stopTicking();
  }

  // ── Data ────────────────────────────────────────────────────────

  private async poll(): Promise<void> {
    this.lastPoll = Date.now();
    const res = await timeTrackingApi.getStatus();
    if (res.data) this.snapshot = res.data;
    this.paint();
  }

  /** One timer drives everything: repaint the clock each second, and let a
   *  minute's worth of ticks trigger the next poll. */
  private ensureTicking(): void {
    if (this.tick) return;
    this.tick = setInterval(() => {
      if (!this.settings.configured) return;
      if (Date.now() - this.lastPoll >= POLL_MS) void this.poll();
      else this.paint();
    }, TICK_MS);
  }

  private stopTicking(): void {
    if (this.tick) clearInterval(this.tick);
    this.tick = undefined;
  }

  private paint(): void {
    if (this.panelOpen) this.renderPanel();
  }

  // ── The clock's panel ───────────────────────────────────────────

  private buildPanel(): HTMLElement {
    const el = document.createElement('div');
    el.id = 'pa-tt-panel';
    el.innerHTML = `
      <div class="clock">
        <div class="total">0:00</div>
        <div class="state"><span class="glyph"></span><span class="lbl">Not connected</span></div>
      </div>
      <div class="err" hidden></div>
      <div class="acts">
        <button class="pa-b start">▶ Start</button>
        <button class="pa-b pause">⏸ Pause</button>
        <button class="pa-b end">⏹ End</button>
      </div>
      <div class="setup" hidden>This clock has no card for you yet. Connect your TimeTracking account in <b>Settings</b>, then punch in here.</div>`;

    const bind = (sel: string, action: WorkAction): void => {
      el.querySelector<HTMLButtonElement>(sel)!.onclick = () => void this.book(action);
    };
    bind('.start', 'start');
    bind('.pause', 'pause');
    bind('.end', 'end');
    return el;
  }

  private renderPanel(): void {
    const el = this.panelView;
    const configured = this.settings.configured;
    const snapshot = this.snapshot;

    el.querySelector<HTMLElement>('.setup')!.hidden = configured;
    el.querySelector<HTMLElement>('.clock')!.hidden = !configured;
    el.querySelector<HTMLElement>('.acts')!.hidden = !configured;

    const err = el.querySelector<HTMLElement>('.err')!;
    err.hidden = !snapshot?.error;
    err.textContent = snapshot?.error ?? '';

    if (!configured) return;
    el.querySelector<HTMLElement>('.total')!.textContent = formatWorkedTime(workedMs(snapshot));
    el.querySelector<HTMLElement>('.glyph')!.textContent = WORK_STATUS_ICON[snapshot?.status ?? ''] || '';
    el.querySelector<HTMLElement>('.lbl')!.textContent = snapshot
      ? WORK_STATUS_LABEL[snapshot.status] || 'Unknown'
      : 'Loading…';

    for (const action of ['start', 'pause', 'end'] as const) {
      const btn = el.querySelector<HTMLButtonElement>(`.${action}`)!;
      btn.disabled = this.busy || !canBook(snapshot, action);
      btn.title = btn.disabled && !this.busy ? `TimeTracking doesn't allow this right now` : '';
    }
  }

  private async book(action: WorkAction): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    this.renderPanel();
    const res = await timeTrackingApi.book(action);
    this.busy = false;
    if (res.data) this.snapshot = res.data;
    else await alertDialog(res.error ?? 'Could not book your working time.');
    this.lastPoll = Date.now();
    this.paint();
  }

  // ── The Settings block ──────────────────────────────────────────

  private buildSettings(): HTMLElement {
    const el = document.createElement('div');
    el.id = 'pa-tt-settings';
    el.innerHTML = `
      <div class="row"><label>TimeTracking</label></div>
      <div class="state"></div>
      <div class="row"><label for="pa-tt-url">Server</label><input id="pa-tt-url" type="text" maxlength="300" placeholder="https://timetracking.example.com"></div>
      <div class="row"><label for="pa-tt-user">Username</label><input id="pa-tt-user" type="text" maxlength="200" autocomplete="username"></div>
      <div class="row"><label for="pa-tt-pw">Password</label><input id="pa-tt-pw" type="password" maxlength="200" autocomplete="new-password"></div>
      <div class="hint">Used only to book your own working time. Stored encrypted on this server, and never shown to anyone — other players only ever see your status symbol.</div>
      <div class="err" hidden></div>
      <div class="row btns"><button id="pa-tt-save">Connect</button><button id="pa-tt-off" class="danger">Disconnect</button></div>`;

    el.querySelector<HTMLButtonElement>('#pa-tt-save')!.onclick = () => void this.save();
    el.querySelector<HTMLButtonElement>('#pa-tt-off')!.onclick = () => void this.disconnect();
    return el;
  }

  private renderSettings(): void {
    const el = this.settingsView;
    const url = el.querySelector<HTMLInputElement>('#pa-tt-url')!;
    const user = el.querySelector<HTMLInputElement>('#pa-tt-user')!;
    const pw = el.querySelector<HTMLInputElement>('#pa-tt-pw')!;

    url.value = this.settings.baseUrl || '';
    url.placeholder = this.settings.suggestedBaseUrl || 'https://timetracking.example.com';
    user.value = this.settings.username || '';
    pw.value = '';
    // A stored password is never read back; leaving the field blank on a re-save
    // is not an option, because the server has to prove the login still works.
    pw.placeholder = this.settings.configured ? SECRET_PLACEHOLDER : '';

    const state = el.querySelector<HTMLElement>('.state')!;
    state.className = `state ${this.settings.configured ? 'on' : ''}`;
    state.textContent = this.settings.configured
      ? `Connected as ${this.settings.username}`
      : 'Not connected.';
    el.querySelector<HTMLButtonElement>('#pa-tt-off')!.hidden = !this.settings.configured;
    el.querySelector<HTMLButtonElement>('#pa-tt-save')!.textContent = this.settings.configured
      ? 'Reconnect'
      : 'Connect';
  }

  private async save(): Promise<void> {
    const el = this.settingsView;
    const save = el.querySelector<HTMLButtonElement>('#pa-tt-save')!;
    const err = el.querySelector<HTMLElement>('.err')!;
    const baseUrl = el.querySelector<HTMLInputElement>('#pa-tt-url')!.value.trim();
    const username = el.querySelector<HTMLInputElement>('#pa-tt-user')!.value.trim();
    const password = el.querySelector<HTMLInputElement>('#pa-tt-pw')!.value;

    err.hidden = true;
    if (!baseUrl || !username || !password) {
      err.hidden = false;
      err.textContent = 'Server, username and password are all required.';
      return;
    }

    save.disabled = true;
    save.textContent = 'Connecting…';
    const res = await timeTrackingApi.saveSettings(baseUrl, username, password);
    save.disabled = false;

    if (!res.ok || !res.data) {
      err.hidden = false;
      err.textContent = res.error ?? 'Could not connect.';
      this.renderSettings();
      return;
    }
    this.settings = res.data;
    this.snapshot = res.data.status;
    this.lastPoll = Date.now();
    this.renderSettings();
    // Connecting from Settings with no clock panel open must not start a timer:
    // setPanelOpen owns that, so this only matters when both happen to be up.
    if (this.panelOpen) this.ensureTicking();
    this.paint();
  }

  private async disconnect(): Promise<void> {
    if (!(await confirmDialog('Disconnect TimeTracking? Your stored login is deleted from this server.'))) return;
    const res = await timeTrackingApi.disconnect();
    if (!res.ok) {
      await alertDialog(res.error ?? 'Could not disconnect.');
      return;
    }
    this.settings = { configured: false, baseUrl: '', username: '', suggestedBaseUrl: this.settings.suggestedBaseUrl };
    this.snapshot = null;
    this.renderSettings();
    this.paint();
  }

  // ── Styles ──────────────────────────────────────────────────────

  private injectStyles(): void {
    if (document.getElementById('pa-tt-style')) return;
    const style = document.createElement('style');
    style.id = 'pa-tt-style';
    style.textContent = `
      /* Settings block — inherits #pa-settings .row/.hint; only its own bits here. */
      #pa-tt-settings{border-top:2px solid #2c2a28;margin-top:0.9rem;padding-top:0.3rem;}
      #pa-tt-settings > .row:first-child label{font-size:0.72rem;letter-spacing:1px;color:#818586;text-transform:uppercase;}
      #pa-tt-settings .state{font-size:0.85rem;color:#818586;margin:-0.25rem 0 0.5rem;}
      #pa-tt-settings .state.on{color:#7fbf6a;}
      #pa-tt-settings .btns button{flex:1;background:#262422;border:2px solid #0a0908;color:#f1efec;
        border-radius:0.35rem;font:0.9rem 'FS Pixel Sans',monospace;padding:0.4rem;cursor:pointer;
        box-shadow:inset 0 2px 0 #4a4744,inset 0 -3px 0 #050505;}
      #pa-tt-settings .btns button:disabled{opacity:0.5;cursor:default;}
      #pa-tt-settings .btns button.danger{background:#7c2634;color:#f1d0d6;
        box-shadow:inset 0 2px 0 #b34a5a,inset 0 -3px 0 #45111a;}
      #pa-tt-settings .err,#pa-tt-panel .err{font-size:0.8rem;color:#f0696e;margin:0.3rem 0 0.5rem;line-height:1.45;}

      /* ⏱ popover — the day's total is the point, so it gets the size. */
      /* The flex rules below would otherwise out-specify the UA's [hidden] rule,
         leaving a "hidden" block on screen. */
      #pa-tt-panel [hidden]{display:none !important;}
      #pa-tt-panel .clock{display:flex;flex-direction:column;align-items:center;gap:0.2rem;margin:0.2rem 0 0.8rem;}
      #pa-tt-panel .total{font-size:2.6rem;line-height:1;color:#f5f3f0;letter-spacing:1px;}
      #pa-tt-panel .state{display:flex;align-items:center;gap:0.4rem;font-size:0.95rem;color:#adb0b2;}
      #pa-tt-panel .acts{display:flex;gap:0.4rem;}
      #pa-tt-panel .acts button{flex:1;}
      #pa-tt-panel .acts button:disabled{opacity:0.4;cursor:default;}
      #pa-tt-panel .setup{font-size:0.85rem;color:#818586;line-height:1.5;}
    `;
    document.head.appendChild(style);
  }
}
