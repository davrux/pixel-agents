/**
 * The two short-lived things an OIDC login needs to remember, and nothing else.
 *
 *  1. A **flow**, created when the browser is sent to the provider and consumed when it comes
 *     back: the PKCE verifier, the nonce, whether this belongs to a pairing, and — for connecting
 *     a provider identity to an account that already exists — WHICH account, resolved from the
 *     session that started it and never from anything a browser carries. Keyed by `state`, which
 *     is also what the callback proves it knows.
 *  2. A **pairing**, for a flow whose result cannot be delivered by setting a cookie on the
 *     callback: the desktop app (no cookie jar) and every link, which finishes in whatever tab the
 *     provider redirected. The client holds a one-time device code, the callback parks the outcome
 *     on the pairing, and the client's next poll collects it — exactly once.
 *  3. A **pending link**, the one thing between a finished exchange and a written link row: the
 *     claims are known, the account is known, and a human still has to say yes on a page that
 *     names both. See `routes.ts` for why that confirmation is not ceremony.
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
  /** The pairing this flow belongs to, for a desktop sign-in or any link; null for a browser
   *  sign-in, which is answered with a cookie instead. */
  deviceCode: string | null;
  /**
   * Connect-an-existing-account mode: the account the result must attach to, taken from the
   * session that started the flow. A link can therefore never be steered by the callback — the
   * only thing a browser carries is an opaque state.
   */
  linkUserId: string | null;
}

/** An unfinished flow a client polls for. Exactly one of `sid` / `linked` / `error` appears. */
export interface Pairing {
  deviceCode: string;
  createdAt: number;
  /** A sign-in that succeeded: the session id to hand over, once. */
  sid: string | null;
  /** A link that succeeded. Nothing is handed over — the caller already has a session. */
  linked: boolean;
  /** Set when it failed, so the client can say why instead of polling until it expires. */
  error: string | null;
  polls: number;
}

/**
 * A finished exchange waiting for its human. Holds what the confirmation page shows and what the
 * confirm POST needs, keyed by a token that only that page carries.
 */
export interface PendingLink {
  token: string;
  userId: string;
  subject: string;
  /** What to call the directory identity on the page — a username or an email, never an id. */
  providerName: string;
  deviceCode: string | null;
  createdAt: number;
}

const flows = new Map<string, PendingFlow>();
const pairings = new Map<string, Pairing>();
const pendingLinks = new Map<string, PendingLink>();

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
  for (const [k, l] of pendingLinks) if (now - l.createdAt > FLOW_TTL_MS) pendingLinks.delete(k);
  trim(flows, (v) => v.createdAt);
  trim(pairings, (v) => v.createdAt);
  trim(pendingLinks, (v) => v.createdAt);
}

function trim<V>(map: Map<string, V>, at: (v: V) => number): void {
  if (map.size <= MAX_PENDING) return;
  const oldest = [...map.entries()].sort((a, b) => at(a[1]) - at(b[1]));
  for (const [k] of oldest.slice(0, map.size - MAX_PENDING)) map.delete(k);
}

/** Start a flow. `deviceCode` attaches it to a pairing; `linkUserId` makes it a link. */
export function createFlow(deviceCode: string | null, linkUserId: string | null = null): PendingFlow {
  sweep();
  const flow: PendingFlow = {
    state: randomToken(),
    verifier: randomToken(),
    nonce: randomToken(),
    createdAt: Date.now(),
    deviceCode,
    linkUserId,
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
    linked: false,
    error: null,
    polls: 0,
  };
  pairings.set(pairing.deviceCode, pairing);
  return pairing;
}

/** Record the outcome on a pairing (no-op if it has expired). */
export function completePairing(deviceCode: string, outcome: { sid: string } | { linked: true } | { error: string }): void {
  const pairing = pairings.get(deviceCode);
  if (!pairing) return;
  if ('sid' in outcome) pairing.sid = outcome.sid;
  else if ('linked' in outcome) pairing.linked = true;
  else pairing.error = outcome.error;
}

/** Park a finished link exchange until its owner confirms it. */
export function createPendingLink(fields: Omit<PendingLink, 'token' | 'createdAt'>): PendingLink {
  sweep();
  const link: PendingLink = { ...fields, token: randomToken(), createdAt: Date.now() };
  pendingLinks.set(link.token, link);
  return link;
}

/** Consume a pending link by its token: returns it and forgets it, so a confirmation is one-shot. */
export function takePendingLink(token: string | undefined): PendingLink | undefined {
  if (!token) return undefined;
  const link = pendingLinks.get(token);
  if (!link) return undefined;
  pendingLinks.delete(token);
  return Date.now() - link.createdAt > FLOW_TTL_MS ? undefined : link;
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
  | { status: 'linked' }
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
  if (pairing.linked) {
    pairings.delete(deviceCode);
    return { status: 'linked' };
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
  pendingLinks.clear();
}

/** For tests: how much is in flight. */
export function pendingCounts(): { flows: number; pairings: number; links: number } {
  return { flows: flows.size, pairings: pairings.size, links: pendingLinks.size };
}
