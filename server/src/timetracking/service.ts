/**
 * The TimeTracking integration's live layer: tokens, the per-user status cache,
 * the poller that keeps it fresh, and the booking actions.
 *
 * A module-global singleton in the shape of presence.ts. That is deliberate and
 * does not break the "no module-global mutable game state outside a room" rule
 * in AGENTS.md: nothing here is game state. It is a cache of an *external*
 * system, keyed by user rather than by room, and a user's status has to follow
 * them across zones (each zone is its own room instance) — exactly the reason
 * presence lives at this level too. Rooms only ever read `statusOf`.
 *
 * Polling is scoped to users who are both configured and currently online: an
 * account nobody is logged into does not need its status kept warm, and this
 * keeps the request rate against a corporate TimeTracking box proportional to
 * how many people are actually in the world.
 */
import type { AllowedBooking, WorkAction, WorkStatus } from '@pixel/shared';
import { bookingForAction, statusFromEntry } from '@pixel/shared';

import { presence } from '../presence.js';
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
import { timeTrackingStore, type TimeTrackingConfig } from './store.js';

/** How often an online, configured user's status is re-read. */
const POLL_INTERVAL_MS = 60_000;
/** A status older than this is stale — the HUD stops trusting the ticking clock. */
const STALE_AFTER_MS = 5 * 60_000;

interface Session {
  tokens: Tokens;
  accountId: number;
}

/** What the HUD and the hover overlay are built from. */
export interface StatusSnapshot {
  configured: boolean;
  status: WorkStatus;
  /** Id of the entry currently open, for the completing booking. */
  entryId: number | null;
  /** Epoch ms the running entry started, or null when nothing is running. The
   *  client adds `now - runningSince` so its clock ticks without polling. */
  runningSince: number | null;
  /** Today's already-closed working time, in ms. */
  completedMs: number;
  allowed: AllowedBooking[];
  /** Epoch ms this snapshot was taken. */
  asOf: number;
  /** Human-readable reason the last refresh failed, or null. */
  error: string | null;
}

const EMPTY: StatusSnapshot = {
  configured: false,
  status: '',
  entryId: null,
  runningSince: null,
  completedMs: 0,
  allowed: [],
  asOf: 0,
  error: null,
};

const sessions = new Map<string, Session>();
const statuses = new Map<string, StatusSnapshot>();

// ── Tokens ────────────────────────────────────────────────────────

/** A usable access token + the user's account id, logging in or refreshing as
 *  needed. Refresh is tried first and falls back to a full login, so a refresh
 *  token that expired while nobody was online just costs one extra request. */
async function session(userId: string, cfg: TimeTrackingConfig): Promise<Session> {
  const cached = sessions.get(userId);
  if (cached && Date.now() < cached.tokens.expiresAt) return cached;

  let tokens: Tokens | null = null;
  if (cached?.tokens.refreshToken) {
    tokens = await refresh(cfg.baseUrl, cached.tokens.refreshToken).catch(() => null);
  }
  if (!tokens) tokens = await authorize(cfg.baseUrl, cfg.username, cfg.password);

  // The account id is stable, so it is only fetched when we don't have it yet.
  const accountId = cached?.accountId ?? (await getMyUser(cfg.baseUrl, tokens.accessToken)).id;
  const next: Session = { tokens, accountId };
  sessions.set(userId, next);
  return next;
}

/** Run `fn` with a valid token, retrying once on a 401 with a fresh login —
 *  covers a token the server invalidated early (password change, logout). */
async function withSession<T>(
  userId: string,
  cfg: TimeTrackingConfig,
  fn: (s: Session) => Promise<T>,
): Promise<T> {
  try {
    return await fn(await session(userId, cfg));
  } catch (err) {
    if (!(err instanceof TimeTrackingError) || err.kind !== 'auth') throw err;
    sessions.delete(userId);
    return fn(await session(userId, cfg));
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
 * Sum today's *closed* entries, clamped to today. Clamping is what makes a
 * night shift read correctly: an entry that began yesterday evening only
 * contributes the part that falls after midnight.
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

/** Re-read one user's state from TimeTracking and cache it. */
async function refreshUser(userId: string): Promise<StatusSnapshot> {
  const cfg = timeTrackingStore.get(userId);
  if (!cfg) {
    sessions.delete(userId);
    statuses.delete(userId);
    return EMPTY;
  }

  let snapshot: StatusSnapshot;
  try {
    snapshot = await withSession(userId, cfg, async (s) => {
      const [current, today] = await Promise.all([
        getCurrentEntry(cfg.baseUrl, s.tokens.accessToken),
        getEntriesForDay(cfg.baseUrl, s.tokens.accessToken, new Date()),
      ]);
      const dayStart = startOfToday();
      // The running entry is whichever of the two views reports one; `current`
      // is the authority (it is the only one carrying allowedBookings).
      const running = current?.running ? current : (today.find((e) => e.running) ?? null);
      const runningBegin = running ? parseTime(running.beginningDate) : null;
      return {
        configured: true,
        status: statusFromEntry(
          (running ?? current)?.firstBookingType ?? null,
          current?.lastBookingType ?? null,
          running !== null,
        ),
        entryId: running?.id ?? current?.id ?? null,
        runningSince: runningBegin === null ? null : Math.max(runningBegin, dayStart),
        completedMs: completedMsToday(today, dayStart),
        allowed: current?.allowedBookings ?? [],
        asOf: Date.now(),
        error: null,
      } satisfies StatusSnapshot;
    });
  } catch (err) {
    // Keep the last good status but mark it — a VPN blip should not blank
    // everyone's overlay glyph, it should just stop the clock being trusted.
    const previous = statuses.get(userId);
    snapshot = {
      ...(previous ?? EMPTY),
      configured: true,
      asOf: previous?.asOf ?? 0,
      error: describe(err),
    };
  }

  statuses.set(userId, snapshot);
  return snapshot;
}

/** Turn a failure into something worth showing a user. `rejected` differs by
 *  caller: when they are typing credentials it is the credentials; when it is
 *  the background poller, it is the ones already stored. */
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

// ── Public surface ────────────────────────────────────────────────

export const timeTracking = {
  /** The status glyph's value for a user — a plain map read, safe to call from
   *  the room's per-tick sync path. */
  statusOf(userId: string): WorkStatus {
    if (!userId) return '';
    const s = statuses.get(userId);
    if (!s || !s.configured) return '';
    // A status nobody could refresh for minutes is not worth showing to others.
    if (s.asOf > 0 && Date.now() - s.asOf > STALE_AFTER_MS) return '';
    return s.status;
  },

  /** The cached snapshot, refreshing first when it is missing or stale. */
  async snapshot(userId: string): Promise<StatusSnapshot> {
    if (!timeTrackingStore.has(userId)) return EMPTY;
    const cached = statuses.get(userId);
    if (cached && Date.now() - cached.asOf < POLL_INTERVAL_MS && !cached.error) return cached;
    return refreshUser(userId);
  },

  /** Force a re-read (after saving settings, or a booking). */
  refresh(userId: string): Promise<StatusSnapshot> {
    return refreshUser(userId);
  },

  /** Fire-and-forget warm-up for a user who just joined a zone. Costs a DB read
   *  and nothing else for the many users with no TimeTracking account, and
   *  swallows failures — a join must never depend on a third-party server. */
  async refreshIfConfigured(userId: string): Promise<void> {
    if (!userId || !timeTrackingStore.has(userId)) return;
    await refreshUser(userId).catch(() => undefined);
  },

  /**
   * Perform a start / pause / end for a user and return the resulting status.
   * Which booking type that means is decided by what the API says is allowed
   * right now, re-read immediately beforehand so a stale cache can never send a
   * booking the server would reject.
   */
  async book(userId: string, action: WorkAction): Promise<{ ok: true; snapshot: StatusSnapshot } | { ok: false; error: string }> {
    const cfg = timeTrackingStore.get(userId);
    if (!cfg) return { ok: false, error: 'TimeTracking is not configured.' };

    const before = await refreshUser(userId);
    if (before.error) return { ok: false, error: before.error };

    const booking = bookingForAction(action, before.allowed);
    if (!booking) return { ok: false, error: `TimeTracking does not allow "${action}" right now.` };

    try {
      await withSession(userId, cfg, async (s) => {
        if (booking.bookingDirection === 'BEGINNING') {
          return beginEntry(cfg.baseUrl, s.tokens.accessToken, s.accountId, booking.bookingType);
        }
        if (before.entryId === null) throw new TimeTrackingError('http', 'no open entry to complete');
        return completeEntry(cfg.baseUrl, s.tokens.accessToken, before.entryId, booking.bookingType);
      });
    } catch (err) {
      return { ok: false, error: describe(err) };
    }
    return { ok: true, snapshot: await refreshUser(userId) };
  },

  /** Validate credentials by using them, and report who they belong to. Called
   *  before anything is stored, so a typo never becomes a saved setting. */
  async verify(cfg: TimeTrackingConfig): Promise<{ ok: true; displayName: string } | { ok: false; error: string }> {
    try {
      const tokens = await authorize(cfg.baseUrl, cfg.username, cfg.password);
      const user = await getMyUser(cfg.baseUrl, tokens.accessToken);
      return { ok: true, displayName: user.displayName };
    } catch (err) {
      return { ok: false, error: describe(err, 'TimeTracking rejected that username or password.') };
    }
  },

  /** Drop every cached token and status for a user — on settings change or
   *  disconnect, so nothing outlives the credentials it was fetched with. */
  forget(userId: string): void {
    sessions.delete(userId);
    statuses.delete(userId);
  },
};

// ── Poller ────────────────────────────────────────────────────────

const timer = setInterval(() => {
  const configured = new Set(timeTrackingStore.userIds());
  for (const { userId } of presence.list()) {
    if (configured.has(userId)) void refreshUser(userId);
  }
}, POLL_INTERVAL_MS);
if (typeof timer.unref === 'function') timer.unref();
