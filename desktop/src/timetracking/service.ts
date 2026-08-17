/**
 * Main-process side of TimeTracking: tokens, the status cache, the poller, and
 * the bookings. Mirrors mumble/service.ts, including its trust stance — the
 * renderer is the less-trusted half even in a packaged app, so a `book` call
 * carries only an action name and everything else comes from stored settings,
 * which can only be changed through `setSettings`.
 *
 * This process is the whole integration. The renderer sees derived status; the
 * pixel-agents server sees only the coarse glyph value the renderer forwards.
 * Neither ever holds a credential.
 *
 * The poller runs whenever an account is configured, not only while the clock's
 * panel is open: the point of the status is that other players see it, so it
 * has to stay current even when its owner is looking elsewhere.
 */
import { BrowserWindow, ipcMain } from 'electron';

import {
  PIXEL_DESKTOP_CHANNELS,
  type TimeTrackingSettingsPatch,
  type TimeTrackingSettingsView,
  type WorkAction,
  type WorkSnapshot,
} from '../ipc.js';
import {
  TimeTrackingError,
  authorize,
  beginEntry,
  completeEntry,
  getCurrentEntry,
  getEntriesForDay,
  getMyUser,
  refresh,
  type Tokens,
  type WorkingTimeEntry,
} from './client.js';
import { bookingForAction, statusFromEntry } from './protocol.js';
import {
  clearTimeTracking,
  keychainAvailable,
  loadTimeTrackingPassword,
  loadTimeTrackingSettings,
  saveTimeTrackingPassword,
  saveTimeTrackingSettings,
} from './settings.js';

/** How often a configured account's status is re-read. */
const POLL_INTERVAL_MS = 60_000;

const ACTIONS: readonly WorkAction[] = ['start', 'pause', 'end'];

interface Session {
  tokens: Tokens;
  accountId: number;
}

interface Config {
  baseUrl: string;
  username: string;
  password: string;
}

const EMPTY: WorkSnapshot = {
  configured: false,
  status: '',
  runningSince: null,
  completedMs: 0,
  can: { start: false, pause: false, end: false },
  asOf: 0,
  error: null,
};

let session: Session | null = null;
let snapshot: WorkSnapshot = EMPTY;
let poller: ReturnType<typeof setInterval> | null = null;

// ── Configuration ─────────────────────────────────────────────────

/** Full credentials, or null when any part is missing. */
async function config(): Promise<Config | null> {
  const settings = await loadTimeTrackingSettings();
  if (!settings.baseUrl || !settings.username) return null;
  const password = await loadTimeTrackingPassword();
  return password ? { ...settings, password } : null;
}

async function settingsView(): Promise<TimeTrackingSettingsView> {
  const settings = await loadTimeTrackingSettings();
  const hasPassword = (await loadTimeTrackingPassword()).length > 0;
  return {
    ...settings,
    hasPassword,
    keychainAvailable: keychainAvailable(),
    configured: !!settings.baseUrl && !!settings.username && hasPassword,
  };
}

// ── Tokens ────────────────────────────────────────────────────────

/** A usable access token + the account id, logging in or refreshing as needed.
 *  Refresh is tried first and falls back to a full login, so a refresh token
 *  that expired overnight costs one extra request rather than an error. */
async function ensureSession(cfg: Config): Promise<Session> {
  if (session && Date.now() < session.tokens.expiresAt) return session;

  let tokens: Tokens | null = null;
  if (session?.tokens.refreshToken) {
    tokens = await refresh(cfg.baseUrl, session.tokens.refreshToken).catch(() => null);
  }
  if (!tokens) tokens = await authorize(cfg.baseUrl, cfg.username, cfg.password);

  // The account id is stable, so it is only fetched when we don't have it yet.
  const accountId = session?.accountId ?? (await getMyUser(cfg.baseUrl, tokens.accessToken)).id;
  session = { tokens, accountId };
  return session;
}

/** Run `fn` with a valid token, retrying once on a 401 with a fresh login —
 *  covers a token the server invalidated early (password change, logout). */
async function withSession<T>(cfg: Config, fn: (s: Session) => Promise<T>): Promise<T> {
  try {
    return await fn(await ensureSession(cfg));
  } catch (err) {
    if (!(err instanceof TimeTrackingError) || err.kind !== 'auth') throw err;
    session = null;
    return fn(await ensureSession(cfg));
  }
}

// ── Deriving the snapshot ─────────────────────────────────────────

const startOfToday = (): number => {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.getTime();
};

const parseTime = (iso: string | null): number | null => {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : null;
};

/**
 * Sum today's *closed* entries, clamped to today. The clamping is what makes a
 * night shift read correctly: an entry begun yesterday evening contributes only
 * the part after midnight.
 */
function completedMsToday(entries: WorkingTimeEntry[], dayStart: number): number {
  const dayEnd = dayStart + 24 * 60 * 60 * 1000;
  let total = 0;
  for (const e of entries) {
    const begin = parseTime(e.beginningDate);
    const end = parseTime(e.endingDate);
    if (begin === null || end === null) continue; // still running — counted live
    total += Math.max(0, Math.min(end, dayEnd) - Math.max(begin, dayStart));
  }
  return total;
}

function describe(err: unknown, rejected = 'TimeTracking rejected the stored login — re-enter your password.'): string {
  if (err instanceof TimeTrackingError) {
    switch (err.kind) {
      case 'auth':
        return rejected;
      case 'forbidden':
        return 'Your TimeTracking account lacks the permission to book its own working time.';
      case 'network':
        return 'Could not reach the TimeTracking server.';
      case 'malformed':
        return 'The TimeTracking server sent an unexpected response.';
      default:
        return `TimeTracking returned ${err.status ?? 'an error'}.`;
    }
  }
  return 'TimeTracking request failed.';
}

/** Re-read the account's state and cache it, notifying every renderer. */
async function refreshStatus(): Promise<WorkSnapshot> {
  const cfg = await config();
  if (!cfg) {
    session = null;
    return publish(EMPTY);
  }

  try {
    const next = await withSession(cfg, async (s) => {
      const [current, today] = await Promise.all([
        getCurrentEntry(cfg.baseUrl, s.tokens.accessToken),
        getEntriesForDay(cfg.baseUrl, s.tokens.accessToken, new Date()),
      ]);
      const dayStart = startOfToday();
      // `current` is the authority — it is the only view carrying allowedBookings.
      const running = current?.running ? current : (today.find((e) => e.running) ?? null);
      const runningBegin = running ? parseTime(running.beginningDate) : null;
      const allowed = current?.allowedBookings ?? [];
      return {
        configured: true,
        status: statusFromEntry(
          (running ?? current)?.firstBookingType ?? null,
          current?.lastBookingType ?? null,
          running !== null,
        ),
        runningSince: runningBegin === null ? null : Math.max(runningBegin, dayStart),
        completedMs: completedMsToday(today, dayStart),
        can: {
          start: bookingForAction('start', allowed) !== null,
          pause: bookingForAction('pause', allowed) !== null,
          end: bookingForAction('end', allowed) !== null,
        },
        asOf: Date.now(),
        error: null,
      } satisfies WorkSnapshot;
    });
    return publish(next);
  } catch (err) {
    // Keep the last good status but mark it: a VPN blip should stop the clock
    // being trusted, not blank the glyph over everyone's head.
    return publish({ ...snapshot, configured: true, error: describe(err) });
  }
}

/** Cache a snapshot and push it to every live window. Broadcasting beats
 *  tracking subscribers: there is normally exactly one window, a renderer that
 *  never subscribed simply ignores the message, and there is no stale-WebContents
 *  set to prune. */
function publish(next: WorkSnapshot): WorkSnapshot {
  snapshot = next;
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(PIXEL_DESKTOP_CHANNELS.ttStatusEvent, next);
  }
  return next;
}

/** Run the poller exactly while an account is configured. */
async function syncPoller(): Promise<void> {
  const configured = (await config()) !== null;
  if (configured && !poller) {
    poller = setInterval(() => void refreshStatus(), POLL_INTERVAL_MS);
    if (typeof poller.unref === 'function') poller.unref();
  } else if (!configured && poller) {
    clearInterval(poller);
    poller = null;
  }
}

/** Called on app quit. */
export function shutdownTimeTracking(): void {
  if (poller) clearInterval(poller);
  poller = null;
  session = null;
}

// ── IPC ───────────────────────────────────────────────────────────

export function registerTimeTrackingIpc(): void {
  const channels = PIXEL_DESKTOP_CHANNELS;

  ipcMain.handle(channels.ttGetSettings, () => settingsView());

  ipcMain.handle(channels.ttSetSettings, async (_event, patch: unknown) => {
    const p = (typeof patch === 'object' && patch !== null ? patch : {}) as TimeTrackingSettingsPatch;

    // Validate against the real server BEFORE storing anything, so a typo fails
    // here loudly instead of silently as a status that never appears.
    const merged = await loadTimeTrackingSettings();
    const baseUrl = p.baseUrl !== undefined ? String(p.baseUrl) : merged.baseUrl;
    const username = p.username !== undefined ? String(p.username).trim() : merged.username;
    const password = typeof p.password === 'string' ? p.password : await loadTimeTrackingPassword();
    if (!baseUrl) return { ok: false as const, error: 'Enter the TimeTracking server address as a full http(s) URL.' };
    if (!username) return { ok: false as const, error: 'Enter your TimeTracking username.' };
    if (!password) return { ok: false as const, error: 'Enter your TimeTracking password.' };
    if (typeof p.password === 'string' && p.password && !keychainAvailable()) {
      return { ok: false as const, error: 'This system has no keychain, so the password cannot be stored securely.' };
    }

    // saveTimeTrackingSettings normalises the URL; verify against that exact
    // value so what we test is what we store.
    const normalized = (await saveTimeTrackingSettings({ baseUrl, username })).baseUrl;
    if (!normalized) return { ok: false as const, error: 'Enter the TimeTracking server address as a full http(s) URL.' };

    let displayName = '';
    try {
      const tokens = await authorize(normalized, username, password);
      displayName = (await getMyUser(normalized, tokens.accessToken)).displayName;
    } catch (err) {
      return { ok: false as const, error: describe(err, 'TimeTracking rejected that username or password.') };
    }

    if (typeof p.password === 'string') await saveTimeTrackingPassword(p.password);
    session = null; // drop tokens minted for the previous credentials
    await syncPoller();
    await refreshStatus();
    return { ok: true as const, view: await settingsView(), displayName };
  });

  ipcMain.handle(channels.ttDisconnect, async () => {
    await clearTimeTracking();
    session = null;
    publish(EMPTY);
    await syncPoller();
    return settingsView();
  });

  ipcMain.handle(channels.ttGetStatus, async () => {
    if ((await config()) === null) return publish(EMPTY);
    // Serve the cache while it is fresh; the poller keeps it that way.
    if (snapshot.asOf > 0 && Date.now() - snapshot.asOf < POLL_INTERVAL_MS && !snapshot.error) return snapshot;
    return refreshStatus();
  });

  ipcMain.handle(channels.ttBook, async (_event, action: unknown) => {
    if (typeof action !== 'string' || !ACTIONS.includes(action as WorkAction)) {
      return { ok: false as const, error: 'Unknown action.' };
    }
    const cfg = await config();
    if (!cfg) return { ok: false as const, error: 'TimeTracking is not configured.' };

    // Re-read immediately beforehand: a stale cache must never send a booking
    // the install would reject, and this is also where entryId comes from.
    const before = await refreshStatus();
    if (before.error) return { ok: false as const, error: before.error };

    try {
      await withSession(cfg, async (s) => {
        const current = await getCurrentEntry(cfg.baseUrl, s.tokens.accessToken);
        const booking = bookingForAction(action as WorkAction, current?.allowedBookings ?? []);
        if (!booking) throw new TimeTrackingError('http', `TimeTracking does not allow "${action}" right now.`);
        if (booking.bookingDirection === 'BEGINNING') {
          return beginEntry(cfg.baseUrl, s.tokens.accessToken, s.accountId, booking.bookingType);
        }
        if (!current || !current.running) throw new TimeTrackingError('http', 'no open entry to complete');
        return completeEntry(cfg.baseUrl, s.tokens.accessToken, current.id, booking.bookingType);
      });
    } catch (err) {
      // A thrown TimeTrackingError with an explanatory message (the two above)
      // is worth showing verbatim; anything else goes through describe().
      const message = err instanceof TimeTrackingError && err.kind === 'http' ? err.message : describe(err);
      return { ok: false as const, error: message };
    }
    return { ok: true as const, snapshot: await refreshStatus() };
  });

  // Start polling at boot if an account is already configured, so the status is
  // live before anyone opens a clock.
  void syncPoller().then(() => (poller ? refreshStatus() : undefined));
}
