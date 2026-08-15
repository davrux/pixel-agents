/**
 * Homeserver URL handling, login, and the per-pixel-user localStorage
 * credential store (docs/design.md.1, §8.2).
 *
 * `/.well-known/matrix/client` discovery is a security control, not a
 * nicety: it is a third-party document fetched from an origin the user only
 * typed, and its `base_url` is re-validated through the exact same
 * normaliser as manually-typed input so a hostile or typo'd well-known file
 * can never redirect the access token to an http:// or foreign origin.
 *
 * Login and discovery deliberately stay plain `fetch` rather than routing
 * through matrix-js-sdk: they are ~60 already-correct lines, carry no
 * crypto, and keeping them first-party keeps this token-bearing URL
 * validation auditable in one place (AGENTS rule 10). Nothing here derives a
 * URL from window.location, and nothing ever sends `credentials: 'include'`
 * or attaches the pixel-agents session cookie/bearer to a homeserver
 * request.
 */
import type { MxLoginFlows, MxSession } from './types.js';
import { MatrixError } from './types.js';
import { storageKey, hasMatrixSession } from './sessionProbe.js';

export interface HsUrlOk {
  ok: true;
  baseUrl: string;
  origin: string;
}
export interface HsUrlErr {
  ok: false;
  error: string;
}
export type HsUrlResult = HsUrlOk | HsUrlErr;

const LOCALHOST_NAMES = new Set(['localhost', '127.0.0.1', '[::1]']);

export function normaliseHomeserverUrl(raw: string): HsUrlResult {
  let s = raw.trim();
  if (!s) return { ok: false, error: "That doesn't look like a server address." };
  if (!s.includes('://')) s = `https://${s}`;

  let u: URL;
  try {
    u = new URL(s);
  } catch {
    return { ok: false, error: "That doesn't look like a server address." };
  }

  const isLocalHttp = u.protocol === 'http:' && LOCALHOST_NAMES.has(u.hostname.toLowerCase());
  if (u.protocol !== 'https:' && !isLocalHttp) {
    return {
      ok: false,
      error: 'HTTPS is required; this page is served over a secure connection.',
    };
  }

  u.search = '';
  u.hash = '';
  let path = u.pathname;
  if (path.endsWith('/')) path = path.slice(0, -1);
  const origin = u.origin.toLowerCase();

  return { ok: true, baseUrl: `${u.protocol}//${u.host}${path}`, origin };
}

const DISCOVER_TIMEOUT_MS = 10000;

export async function discoverHomeserver(raw: string, signal?: AbortSignal): Promise<HsUrlResult> {
  const typed = normaliseHomeserverUrl(raw);
  if (!typed.ok) return typed;

  // A host that completes the TCP/TLS handshake but never answers (a
  // misconfigured proxy, a filtered port, a typo'd hostname that blackholes)
  // must not hang this forever — every caller awaits it while showing a busy
  // state with no way to cancel by hand.
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), DISCOVER_TIMEOUT_MS);
  let onCallerAbort: (() => void) | undefined;
  if (signal) {
    if (signal.aborted) ac.abort();
    else {
      onCallerAbort = () => ac.abort();
      signal.addEventListener('abort', onCallerAbort);
    }
  }

  try {
    const res = await fetch(`${typed.origin}/.well-known/matrix/client`, { signal: ac.signal, redirect: 'error' });
    if (!res.ok) return typed;
    const json = (await res.json()) as { 'm.homeserver'?: { base_url?: string } };
    const discovered = json?.['m.homeserver']?.base_url;
    if (!discovered || typeof discovered !== 'string') return typed;
    // Re-validate the discovered value exactly like typed input — this is
    // the whole point of the well-known step, see file header.
    return normaliseHomeserverUrl(discovered);
  } catch {
    return typed;
  } finally {
    clearTimeout(timer);
    if (onCallerAbort && signal) signal.removeEventListener('abort', onCallerAbort);
  }
}

interface ErrorBody {
  errcode?: string;
  error?: string;
  retry_after_ms?: number;
  soft_logout?: boolean;
}

async function mxFetch<T>(url: string, init: RequestInit, signal?: AbortSignal): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, { ...init, signal, redirect: 'error' });
  } catch (e) {
    if (signal?.aborted) throw e;
    const msg = e instanceof Error ? e.message : 'Network request failed.';
    throw new MatrixError(0, 'M_NETWORK', msg);
  }

  const text = await res.text();
  if (res.ok) {
    if (!text) return undefined as T;
    return JSON.parse(text) as T;
  }

  let errBody: ErrorBody = {};
  try {
    errBody = text ? (JSON.parse(text) as ErrorBody) : {};
  } catch {
    // tolerate a non-JSON error body
  }
  throw new MatrixError(res.status, errBody.errcode ?? '', errBody.error ?? res.statusText, {
    retryAfterMs: errBody.retry_after_ms,
    softLogout: errBody.soft_logout,
  });
}

export async function probeLoginFlows(baseUrl: string, _origin: string, signal?: AbortSignal): Promise<MxLoginFlows> {
  const res = await mxFetch<{ flows?: Array<{ type?: string }> }>(
    `${baseUrl}/_matrix/client/v3/login`,
    { method: 'GET' },
    signal,
  );
  const flows = res.flows ?? [];
  return { passwordSupported: flows.some((f) => f.type === 'm.login.password') };
}

export async function loginWithPassword(o: {
  baseUrl: string;
  origin: string;
  user: string;
  password: string;
  deviceId?: string;
}): Promise<MxSession> {
  const body: Record<string, unknown> = {
    type: 'm.login.password',
    identifier: { type: 'm.id.user', user: o.user },
    password: o.password,
    initial_device_display_name: 'pixel-agents',
  };
  if (o.deviceId) body.device_id = o.deviceId;
  const res = await mxFetch<{ user_id: string; device_id: string; access_token: string }>(
    `${o.baseUrl}/_matrix/client/v3/login`,
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) },
  );
  return {
    hsBaseUrl: o.baseUrl,
    hsOrigin: o.origin,
    userId: res.user_id,
    deviceId: res.device_id,
    accessToken: res.access_token,
    savedAt: Date.now(),
  };
}

export function loadSession(paUserId: string): MxSession | null {
  try {
    const raw = localStorage.getItem(storageKey(paUserId));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<MxSession>;
    if (
      typeof parsed.hsBaseUrl !== 'string' ||
      typeof parsed.hsOrigin !== 'string' ||
      typeof parsed.userId !== 'string' ||
      typeof parsed.deviceId !== 'string' ||
      typeof parsed.accessToken !== 'string' ||
      typeof parsed.savedAt !== 'number'
    ) {
      return null;
    }
    return parsed as MxSession;
  } catch {
    return null;
  }
}

export function saveSession(paUserId: string, s: MxSession): void {
  try {
    localStorage.setItem(storageKey(paUserId), JSON.stringify(s));
  } catch {
    // Firefox private mode (or a full/blocked store) can throw; the session
    // simply won't survive reload, which is a degraded state, not a crash.
  }
}

export function clearSession(paUserId: string): void {
  try {
    localStorage.removeItem(storageKey(paUserId));
  } catch {
    // see saveSession
  }
}

/** ONLY used on the soft-logout re-login path (design §1.4): a fresh sign-in
 *  must NOT reuse a device id, because a device id is bound to a crypto
 *  identity and reusing one after a crypto wipe produces a device whose keys
 *  changed under a stable id — other clients render that as a security
 *  warning. Soft logout is the one case where the device (and its crypto
 *  store) is still valid and should be re-adopted. */
export function lastDeviceId(paUserId: string): string | undefined {
  return loadSession(paUserId)?.deviceId;
}

export function describeError(e: unknown, hsHost: string): string {
  const err = MatrixError.from(e);
  if (err.isNetwork) {
    return `Could not reach \`${hsHost}\`. Check the address — the homeserver may also be refusing requests from this app (CORS).`;
  }
  if (err.errcode === 'M_FORBIDDEN') return 'Wrong user name or password.';
  if (err.errcode === 'M_LIMIT_EXCEEDED') return 'Too many attempts — try again in a moment.';
  if (err.isUnknownToken) return 'Your Matrix session expired — sign in again.';
  return err.message || 'Something went wrong talking to the homeserver.';
}

export { storageKey, hasMatrixSession };
