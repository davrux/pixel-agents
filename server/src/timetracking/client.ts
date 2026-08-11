/**
 * HTTP client for the TimeTracking REST API (Herrmann & Lenz, v2.29.8).
 *
 * Server-only by construction — it holds the user's credentials, so it must
 * never reach the client bundle. Everything the browser sees comes back through
 * timetrackingApi.ts as already-derived status.
 *
 * Only the "my" endpoints are used: they need nothing more than the
 * "Book my working time via app/desktop" + "Read my working time only"
 * permissions, so a normal employee account works without any admin rights
 * (the /information/* endpoints in the docs read someone *else's* state and
 * require administration permissions — deliberately not used here).
 *
 * Two date shapes, and they are not interchangeable:
 *   query params → the Java zoned form  `2017-01-08T17:00:00+01:00[Europe/Berlin]`
 *   request bodies → a plain offset timestamp `2017-01-08T17:00:00+01:00`
 */
import type { AllowedBooking, BookingType } from '@pixel/shared';

/** Per-request ceiling. A corporate TimeTracking box on a VPN can be slow, but
 *  the poller runs on a 60 s tick, so nothing may hang anywhere near that. */
const TIMEOUT_MS = 10_000;
/** A working-time entry is a few KB; refuse to buffer a hostile/broken body. */
const MAX_BODY_BYTES = 2 * 1024 * 1024;

/** Recorded as the origin of every booking we make, so it is distinguishable
 *  in TimeTracking from a booking made in the web UI or at a terminal. */
const BOOKING_SOURCE = 'APP';

export type TimeTrackingErrorKind = 'auth' | 'forbidden' | 'network' | 'http' | 'malformed';

export class TimeTrackingError extends Error {
  constructor(
    readonly kind: TimeTrackingErrorKind,
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'TimeTrackingError';
  }
}

export interface Tokens {
  accessToken: string;
  refreshToken: string;
  /** Epoch ms this access token stops being usable. */
  expiresAt: number;
}

/** The subset of a working-time entry this integration cares about. */
export interface WorkingTimeEntry {
  id: number;
  accountId: number | null;
  firstBookingType: BookingType | null;
  lastBookingType: BookingType | null;
  beginningDate: string | null;
  endingDate: string | null;
  /** An entry with a beginning but no ending is the one currently running. */
  running: boolean;
  allowedBookings: AllowedBooking[];
}

// ── Date helpers ──────────────────────────────────────────────────

const pad = (n: number): string => String(n).padStart(2, '0');

/** `2017-01-08T17:00:00+01:00` in the server's local zone — the body format. */
export function offsetTimestamp(d: Date): string {
  const offMin = -d.getTimezoneOffset();
  const sign = offMin >= 0 ? '+' : '-';
  const abs = Math.abs(offMin);
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    `T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}` +
    `${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`
  );
}

/** The same instant with the IANA zone appended — the query-param format. */
function zonedTimestamp(d: Date): string {
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  return `${offsetTimestamp(d)}[${zone}]`;
}

/** `2017-01-08` in local time — the `balanceDay` / balance-date format. */
export function localDay(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

// ── Transport ─────────────────────────────────────────────────────

interface RequestOpts {
  method?: 'GET' | 'POST' | 'PUT';
  token?: string;
  body?: unknown;
  query?: Record<string, string>;
}

async function request<T>(baseUrl: string, path: string, opts: RequestOpts = {}): Promise<T> {
  const url = new URL(`${baseUrl}${path}`);
  for (const [k, v] of Object.entries(opts.query ?? {})) url.searchParams.set(k, v);

  let res: Response;
  try {
    res = await fetch(url, {
      method: opts.method ?? 'GET',
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: {
        Accept: 'application/json',
        ...(opts.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...(opts.token ? { Authorization: `Bearer ${opts.token}` } : {}),
      },
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    });
  } catch (err) {
    throw new TimeTrackingError('network', err instanceof Error ? err.message : 'request failed');
  }

  if (res.status === 401) throw new TimeTrackingError('auth', 'not authorized', 401);
  if (res.status === 403) throw new TimeTrackingError('forbidden', 'missing permission', 403);
  if (!res.ok) throw new TimeTrackingError('http', `HTTP ${res.status}`, res.status);

  // 204 (and an empty 200) are legitimate answers to "is anything running?".
  const text = await readCapped(res);
  if (!text.trim()) return null as T;
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new TimeTrackingError('malformed', 'response was not JSON');
  }
}

/** Read a body but give up past MAX_BODY_BYTES rather than buffer it all. */
async function readCapped(res: Response): Promise<string> {
  const declared = Number(res.headers.get('content-length') ?? '0');
  if (declared > MAX_BODY_BYTES) throw new TimeTrackingError('malformed', 'response too large');
  const text = await res.text();
  if (text.length > MAX_BODY_BYTES) throw new TimeTrackingError('malformed', 'response too large');
  return text;
}

// ── Parsing ───────────────────────────────────────────────────────

const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

function parseEntry(raw: unknown): WorkingTimeEntry | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  const id = num(o.id);
  if (id === null) return null;
  const account = (o.account ?? null) as Record<string, unknown> | null;
  const beginningDate = str(o.beginningDate);
  const endingDate = str(o.endingDate);
  return {
    id,
    accountId: account ? num(account.id) : null,
    firstBookingType: str(o.firstBookingType) as BookingType | null,
    lastBookingType: str(o.lastBookingType) as BookingType | null,
    beginningDate,
    endingDate,
    running: beginningDate !== null && endingDate === null,
    allowedBookings: parseAllowed(o.allowedBookings),
  };
}

function parseAllowed(raw: unknown): AllowedBooking[] {
  if (!Array.isArray(raw)) return [];
  const out: AllowedBooking[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const o = item as Record<string, unknown>;
    const bookingType = str(o.bookingType) as BookingType | null;
    const bookingDirection = str(o.bookingDirection);
    if (!bookingType) continue;
    out.push({
      bookingType,
      bookingDirection: bookingDirection === 'ENDING' ? 'ENDING' : 'BEGINNING',
    });
  }
  return out;
}

// ── Endpoints ─────────────────────────────────────────────────────

interface TokenResponse {
  access_token?: unknown;
  refresh_token?: unknown;
  expires_in?: unknown;
}

function parseTokens(raw: TokenResponse | null): Tokens {
  const accessToken = str(raw?.access_token);
  if (!accessToken) throw new TimeTrackingError('malformed', 'no access token in response');
  // The documented lifetime is 300 s; renew a little early so a request can
  // never race the expiry it was issued against.
  const expiresIn = num(raw?.expires_in) ?? 300;
  return {
    accessToken,
    refreshToken: str(raw?.refresh_token) ?? '',
    expiresAt: Date.now() + Math.max(30, expiresIn - 30) * 1000,
  };
}

/** Log in with username + password. */
export async function authorize(baseUrl: string, username: string, password: string): Promise<Tokens> {
  return parseTokens(
    await request<TokenResponse>(baseUrl, '/api/auth/authorize', {
      method: 'POST',
      body: { grant_type: 'password', username, password },
    }),
  );
}

/** Exchange a refresh token for a fresh access token. */
export async function refresh(baseUrl: string, refreshToken: string): Promise<Tokens> {
  return parseTokens(
    await request<TokenResponse>(baseUrl, '/api/auth/authorize', {
      method: 'POST',
      body: { grant_type: 'refresh_token', refresh_token: refreshToken },
    }),
  );
}

/** The authenticated user — used to learn their account id (needed when
 *  opening an entry) and to prove the credentials work when they are saved. */
export async function getMyUser(baseUrl: string, token: string): Promise<{ id: number; displayName: string }> {
  const raw = await request<Record<string, unknown>>(baseUrl, '/api/users/my', { token });
  const id = num(raw?.id);
  if (id === null) throw new TimeTrackingError('malformed', 'no user id in response');
  return { id, displayName: str(raw?.displayName) ?? str(raw?.userName) ?? '' };
}

/** The current working time entry, or null when the user has none at all.
 *  This is also where `allowedBookings` comes from — the API's own answer to
 *  "what may this user book right now", which the HUD's buttons follow. */
export async function getCurrentEntry(baseUrl: string, token: string): Promise<WorkingTimeEntry | null> {
  return parseEntry(await request<unknown>(baseUrl, '/api/working_time/entries/current', { token }));
}

/** Every entry of the authenticated user that touches `day`. */
export async function getEntriesForDay(baseUrl: string, token: string, day: Date): Promise<WorkingTimeEntry[]> {
  const from = new Date(day);
  from.setHours(0, 0, 0, 0);
  const to = new Date(day);
  to.setHours(23, 59, 59, 0);
  const raw = await request<unknown>(baseUrl, '/api/working_time/entries', {
    token,
    query: {
      fromDate: zonedTimestamp(from),
      toDate: zonedTimestamp(to),
      fromBalanceDate: localDay(from),
      toBalanceDate: localDay(to),
    },
  });
  if (!Array.isArray(raw)) return [];
  return raw.map(parseEntry).filter((e): e is WorkingTimeEntry => e !== null);
}

/** Open a new working time entry (start work / resume after a break). */
export async function beginEntry(
  baseUrl: string,
  token: string,
  accountId: number,
  bookingType: BookingType,
  at: Date = new Date(),
): Promise<WorkingTimeEntry | null> {
  return parseEntry(
    await request<unknown>(baseUrl, '/api/working_time/entries/my', {
      method: 'POST',
      token,
      body: {
        accountId,
        beginningDate: offsetTimestamp(at),
        firstBookingType: bookingType,
        bookingSourceBegin: BOOKING_SOURCE,
        balanceDay: localDay(at),
        manualBooking: 'N',
      },
    }),
  );
}

/** Close the running entry (BREAK to pause, LEAVING to end the day). */
export async function completeEntry(
  baseUrl: string,
  token: string,
  entryId: number,
  bookingType: BookingType,
  at: Date = new Date(),
): Promise<WorkingTimeEntry | null> {
  return parseEntry(
    await request<unknown>(baseUrl, `/api/working_time/entries/complete/${entryId}/my`, {
      method: 'PUT',
      token,
      query: { adoptWorkingTime: 'false' },
      body: {
        endingDate: offsetTimestamp(at),
        lastBookingType: bookingType,
        bookingSourceEnd: BOOKING_SOURCE,
      },
    }),
  );
}
