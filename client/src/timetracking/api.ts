/**
 * Transport for the TimeTracking routes (server/src/timetrackingApi.ts). Same
 * cookie/bearer convention as the admin client (admin/api.ts).
 *
 * The client never talks to the TimeTracking server itself: it has no
 * credentials, would be blocked by CORS against a corporate host anyway, and
 * anything other players can see has to be authoritative server state. So this
 * is a thin shim over our own server, which does the real work.
 */
import { bookingForAction, type AllowedBooking, type WorkAction, type WorkStatus } from '@pixel/shared';

import { desktop, isDesktop } from '../desktop/bridge.js';
import { serverHttpOrigin } from '../net/room.js';

export interface TimeTrackingSettings {
  configured: boolean;
  baseUrl: string;
  username: string;
  /** Server address the deployment suggests (TIMETRACKING_URL), or ''. */
  suggestedBaseUrl?: string;
}

export interface WorkSnapshot {
  configured: boolean;
  status: WorkStatus;
  entryId: number | null;
  /** Epoch ms the running entry began, or null. The clock below ticks from it. */
  runningSince: number | null;
  completedMs: number;
  allowed: AllowedBooking[];
  asOf: number;
  error: string | null;
}

export interface Result<T> {
  ok: boolean;
  data?: T;
  error?: string;
}

async function req<T>(method: string, path: string, body?: unknown): Promise<Result<T>> {
  try {
    const headers: Record<string, string> = {};
    if (isDesktop()) {
      const token = await desktop().getToken();
      if (token) headers.Authorization = `Bearer ${token}`;
    }
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const res = await fetch(`${serverHttpOrigin()}${path}`, {
      method,
      // See admin/api.ts: cookies only work same-origin; desktop is bearer-only
      // and 'include' would make the browser reject the response outright.
      credentials: isDesktop() ? 'omit' : 'include',
      cache: 'no-store',
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const data = (await res.json().catch(() => ({}))) as T & { error?: string };
    return res.ok ? { ok: true, data } : { ok: false, error: data.error || `Request failed (${res.status}).` };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

export const timeTrackingApi = {
  getSettings: () => req<TimeTrackingSettings>('GET', '/timetracking/settings'),
  saveSettings: (baseUrl: string, username: string, password: string) =>
    req<TimeTrackingSettings & { displayName: string; status: WorkSnapshot }>('PUT', '/timetracking/settings', {
      baseUrl,
      username,
      password,
    }),
  disconnect: () => req<TimeTrackingSettings>('DELETE', '/timetracking/settings'),
  getStatus: () => req<WorkSnapshot>('GET', '/timetracking/status'),
  book: (action: WorkAction) => req<WorkSnapshot>('POST', '/timetracking/book', { action }),
};

/**
 * Today's total at this instant: what the server has already booked, plus the
 * entry still running. Computing it here is what lets the HUD clock tick every
 * second off a snapshot the server only refreshes once a minute.
 */
export function workedMs(snapshot: WorkSnapshot | null, now: number = Date.now()): number {
  if (!snapshot) return 0;
  const live = snapshot.runningSince === null ? 0 : Math.max(0, now - snapshot.runningSince);
  return snapshot.completedMs + live;
}

/** Whether a start / pause / end button should be offered right now. Uses the
 *  same shared rule the server books by, so a button is enabled exactly when
 *  the booking behind it would succeed. */
export function canBook(snapshot: WorkSnapshot | null, action: WorkAction): boolean {
  if (!snapshot?.configured) return false;
  return bookingForAction(action, snapshot.allowed) !== null;
}
