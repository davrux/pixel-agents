/**
 * The two short-lived things an OIDC login needs to remember, and nothing else.
 *
 *  1. A **flow**, created when the browser is sent to the provider and consumed when it comes
 *     back: the PKCE verifier, the nonce, and whether this login belongs to a desktop pairing.
 *     Keyed by `state`, which is also what the callback proves it knows.
 *  2. A **pairing**, for the desktop app, which has no cookie jar the callback could set: the
 *     app holds a one-time device code, the callback parks the issued session id on the pairing,
 *     and the app's next poll collects it — exactly once.
 *
 * Both live in memory on purpose. They are worthless a few minutes after they are made, they
 * must not survive a restart (a half-finished login should fail closed), and there is one server
 * process (AGENTS.md § Operations). What memory discipline that still needs is the discipline
 * AGENTS.md § Memory asks for, and it is the whole reason this file is separate: every entry has
 * a TTL, entries are deleted the moment they are used, the sweep runs on write (so no timer
 * keeps the process alive), and there is a hard cap so a flood of unfinished logins cannot grow
 * the heap without bound — the oldest are dropped rather than the newest refused, since a login
 * nobody completed is the one worth losing.
 */
import * as crypto from 'node:crypto';

/** How long a user has between clicking "sign in" and finishing at the provider. */
export const FLOW_TTL_MS = 10 * 60 * 1000;
/** How long the desktop app may take to complete a pairing, and to collect its token. */
export const PAIRING_TTL_MS = 10 * 60 * 1000;
/** Recommended poll interval, in seconds, handed to the desktop app. */
export const PAIRING_POLL_INTERVAL_S = 2;
/** Unfinished logins kept at once. Well above any real concurrency; a flood loses its oldest. */
const MAX_PENDING = 500;

export interface PendingFlow {
  state: string;
  verifier: string;
  nonce: string;
  createdAt: number;
  /** The pairing this login belongs to, for a desktop sign-in; null for a browser one. */
  deviceCode: string | null;
}

/** A desktop pairing: an unfinished login the app polls for. `sid` appears once it succeeds. */
export interface Pairing {
  deviceCode: string;
  createdAt: number;
  sid: string | null;
  /** Set when the login failed, so the app can say why instead of polling until it expires. */
  error: string | null;
  polls: number;
}

const flows = new Map<string, PendingFlow>();
const pairings = new Map<string, Pairing>();

/** 32 bytes of randomness, URL-safe: used for state, the PKCE verifier and device codes. */
export function randomToken(): string {
  return crypto.randomBytes(32).toString('base64url');
}

/** S256 code challenge for a verifier (RFC 7636). */
export function codeChallenge(verifier: string): string {
  return crypto.createHash('sha256').update(verifier).digest('base64url');
}

/** Drop what has expired, then trim to the cap oldest-first. Called on every insert. */
function sweep(): void {
  const now = Date.now();
  for (const [k, f] of flows) if (now - f.createdAt > FLOW_TTL_MS) flows.delete(k);
  for (const [k, p] of pairings) if (now - p.createdAt > PAIRING_TTL_MS) pairings.delete(k);
  trim(flows, (v) => v.createdAt);
  trim(pairings, (v) => v.createdAt);
}

function trim<V>(map: Map<string, V>, at: (v: V) => number): void {
  if (map.size <= MAX_PENDING) return;
  const oldest = [...map.entries()].sort((a, b) => at(a[1]) - at(b[1]));
  for (const [k] of oldest.slice(0, map.size - MAX_PENDING)) map.delete(k);
}

/** Start a login. `deviceCode` links it to a desktop pairing. */
export function createFlow(deviceCode: string | null): PendingFlow {
  sweep();
  const flow: PendingFlow = {
    state: randomToken(),
    verifier: randomToken(),
    nonce: randomToken(),
    createdAt: Date.now(),
    deviceCode,
  };
  flows.set(flow.state, flow);
  return flow;
}

/** Consume a flow by its state: returns it and forgets it, so a code cannot be replayed. */
export function takeFlow(state: string | undefined): PendingFlow | undefined {
  if (!state) return undefined;
  const flow = flows.get(state);
  if (!flow) return undefined;
  flows.delete(state);
  return Date.now() - flow.createdAt > FLOW_TTL_MS ? undefined : flow;
}

/** Start a desktop pairing. The returned device code is the app's only claim to the session. */
export function createPairing(): Pairing {
  sweep();
  const pairing: Pairing = {
    deviceCode: randomToken(),
    createdAt: Date.now(),
    sid: null,
    error: null,
    polls: 0,
  };
  pairings.set(pairing.deviceCode, pairing);
  return pairing;
}

/** Record the outcome of a desktop login on its pairing (no-op if it has expired). */
export function completePairing(deviceCode: string, outcome: { sid: string } | { error: string }): void {
  const pairing = pairings.get(deviceCode);
  if (!pairing) return;
  if ('sid' in outcome) pairing.sid = outcome.sid;
  else pairing.error = outcome.error;
}

/**
 * One poll from the desktop app.
 *
 * A finished pairing is consumed — the session id is handed out exactly once and the record
 * deleted, so a leaked device code is worth nothing after the app has used it. Polling is
 * counted and bounded: a client that keeps asking at the advertised interval cannot reach the
 * cap inside the TTL, so hitting it means something is spinning, and the pairing dies rather
 * than being polled forever.
 */
const MAX_POLLS = 600;
export type PollResult =
  | { status: 'pending' }
  | { status: 'ready'; sid: string }
  | { status: 'error'; error: string };

export function pollPairing(deviceCode: string | undefined): PollResult {
  if (!deviceCode) return { status: 'error', error: 'Unknown or expired sign-in request.' };
  const pairing = pairings.get(deviceCode);
  if (!pairing || Date.now() - pairing.createdAt > PAIRING_TTL_MS) {
    if (pairing) pairings.delete(deviceCode);
    return { status: 'error', error: 'This sign-in request has expired — try again.' };
  }
  if (pairing.error) {
    pairings.delete(deviceCode);
    return { status: 'error', error: pairing.error };
  }
  if (pairing.sid) {
    pairings.delete(deviceCode);
    return { status: 'ready', sid: pairing.sid };
  }
  if (++pairing.polls > MAX_POLLS) {
    pairings.delete(deviceCode);
    return { status: 'error', error: 'This sign-in request has expired — try again.' };
  }
  return { status: 'pending' };
}

/** Test seam / shutdown: forget everything in flight. */
export function clearPending(): void {
  flows.clear();
  pairings.clear();
}

/** For tests: how much is in flight. */
export function pendingCounts(): { flows: number; pairings: number } {
  return { flows: flows.size, pairings: pairings.size };
}
