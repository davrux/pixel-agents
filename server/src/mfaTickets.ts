/**
 * The half-finished sign-in between "the password was right" and "the code was right".
 *
 * A ticket is what the second step presents instead of the password, so the password never has to
 * be carried into a second form (a hidden field holding it would be a credential written into the
 * page). It names the account and nothing else; it is NOT a session and grants nothing on its own —
 * the only thing it can be exchanged for is a session, and only together with a valid code.
 *
 * In memory, with the three properties AGENTS.md § Memory asks of anything keyed by something that
 * comes and goes: a TTL, a cap, and a delete on use. A restart loses pending tickets, which costs a
 * user one retyped password and is the right failure.
 */
import crypto from 'node:crypto';

export const MFA_TICKET_TTL_MS = 5 * 60_000;
/** Wrong codes one ticket may see before it is spent. The per-account throttle in auth.ts is the
 *  real brake; this one stops a single ticket from being a free 10-guess budget each time. */
export const MFA_TICKET_MAX_TRIES = 5;
/** Hard bound. Every ticket needs a correct password first, so reaching it means a flood of real
 *  logins; dropping the oldest is then the least-bad answer. */
const MAX_TICKETS = 10_000;

interface Ticket {
  userId: string;
  expires: number;
  tries: number;
}

const tickets = new Map<string, Ticket>();

function sweep(now: number): void {
  for (const [id, t] of tickets) if (t.expires <= now) tickets.delete(id);
}

export function issueMfaTicket(userId: string, now = Date.now()): string {
  sweep(now);
  if (tickets.size >= MAX_TICKETS) {
    const oldest = tickets.keys().next().value;
    if (oldest !== undefined) tickets.delete(oldest);
  }
  const id = crypto.randomBytes(24).toString('base64url');
  tickets.set(id, { userId, expires: now + MFA_TICKET_TTL_MS, tries: 0 });
  return id;
}

/** The account a live ticket belongs to, or undefined. Does not consume it. */
export function mfaTicketUser(raw: unknown, now = Date.now()): string | undefined {
  const id = String(raw ?? '').slice(0, 64);
  const t = tickets.get(id);
  if (!t) return undefined;
  if (t.expires <= now) {
    tickets.delete(id);
    return undefined;
  }
  return t.userId;
}

/** Count a wrong code against the ticket; spends it once it has seen too many. */
export function noteMfaTicketFail(raw: unknown): void {
  const id = String(raw ?? '').slice(0, 64);
  const t = tickets.get(id);
  if (!t) return;
  t.tries += 1;
  if (t.tries >= MFA_TICKET_MAX_TRIES) tickets.delete(id);
}

export function consumeMfaTicket(raw: unknown): void {
  tickets.delete(String(raw ?? '').slice(0, 64));
}
