/**
 * The coarse working status the world displays, shared by the renderer (which
 * shows the glyph) and the server (which validates and syncs it).
 *
 * Deliberately much smaller than the TimeTracking API's own booking vocabulary:
 * this is a glyph over someone's head, not a time sheet. The booking types, the
 * rules about which booking may follow which, and everything else specific to
 * the vendor's API live in the Electron main process — it is the only part of
 * the system that ever talks to TimeTracking or holds a credential for it (see
 * desktop/src/timetracking/). Nothing here implies an API call.
 *
 * `''` means "nothing to show" — no desktop app, no account configured, or a
 * status that has gone stale — and renders nothing at all.
 */

export type WorkStatus = '' | 'working' | 'break' | 'homeoffice' | 'trip' | 'away';

export const WORK_STATUSES: readonly WorkStatus[] = ['', 'working', 'break', 'homeoffice', 'trip', 'away'];

/** Narrow an untrusted value (a client message) to a WorkStatus. */
export function isWorkStatus(v: unknown): v is WorkStatus {
  return typeof v === 'string' && (WORK_STATUSES as readonly string[]).includes(v);
}

/** The three buttons the time clock offers. */
export type WorkAction = 'start' | 'pause' | 'end';

/** Glyph shown in the hover overlay over a character. */
export const WORK_STATUS_ICON: Record<WorkStatus, string> = {
  '': '',
  working: '🟢',
  break: '⏸',
  homeoffice: '🏠',
  trip: '✈',
  away: '🔴',
};

/** Human-readable status, used on the clock's face and as the glyph's title. */
export const WORK_STATUS_LABEL: Record<WorkStatus, string> = {
  '': '',
  working: 'Working',
  break: 'On a break',
  homeoffice: 'Home office',
  trip: 'Business trip',
  away: 'Off the clock',
};

/** `3:07` / `0:42` — how a day total is written on the clock's face. Rounds
 *  down to the minute so a ticking clock never shows a minute not yet worked. */
export function formatWorkedTime(ms: number): string {
  const mins = Math.max(0, Math.floor(ms / 60000));
  return `${Math.floor(mins / 60)}:${String(mins % 60).padStart(2, '0')}`;
}
