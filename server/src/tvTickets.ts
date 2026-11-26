/**
 * Permission to change ONE television, handed to the player who walked up to it.
 *
 * The picture is uploaded over HTTP (a PNG body does not belong in a room message — see
 * artSaveApi.ts for why), and an HTTP request knows who is signed in but not where they are
 * standing. So the room, which does know, issues a ticket when a player ARRIVES at a television
 * (the same walk-then-fire path every kiosk uses), and the route accepts an upload only with a live
 * ticket that belongs to the caller's own session. That makes the rule "you change a television by
 * standing in front of it" hold server-side: a client cannot name a zone and a tile it is not at.
 *
 * A ticket names the account, the zone and the television, and nothing else. It is spent by a
 * successful change, and lives `TV_TICKET_TTL_MS` otherwise — long enough to pick a file and let
 * the browser decode a GIF, short enough that walking away ends it soon after.
 *
 * In memory, with the three properties AGENTS.md § Memory asks of anything keyed by something that
 * comes and goes: a TTL, a cap, and a delete on use.
 */
import crypto from 'node:crypto';

export const TV_TICKET_TTL_MS = 10 * 60_000;
/** Hard bound. One ticket per arrival at a television; reaching this means a flood, and dropping
 *  the oldest is then the least-bad answer. */
const MAX_TICKETS = 10_000;

export interface TvTicket {
  userId: string;
  zoneId: string;
  /** The television's anchor tile, `tvScreenKey`. */
  screen: string;
  expires: number;
}

const tickets = new Map<string, TvTicket>();

function sweep(now: number): void {
  for (const [id, t] of tickets) if (t.expires <= now) tickets.delete(id);
}

export function issueTvTicket(userId: string, zoneId: string, screen: string, now = Date.now()): string {
  sweep(now);
  if (tickets.size >= MAX_TICKETS) {
    const oldest = tickets.keys().next().value;
    if (oldest !== undefined) tickets.delete(oldest);
  }
  const id = crypto.randomBytes(24).toString('base64url');
  tickets.set(id, { userId, zoneId, screen, expires: now + TV_TICKET_TTL_MS });
  return id;
}

/**
 * The live ticket `raw` names, if it belongs to `userId` — the caller resolved from the session,
 * never from the payload. Does not consume it: a refused upload (too big, wrong format) should be
 * retryable without walking away and back.
 */
export function tvTicketFor(raw: unknown, userId: string, now = Date.now()): TvTicket | undefined {
  const id = String(raw ?? '').slice(0, 64);
  const t = tickets.get(id);
  if (!t) return undefined;
  if (t.expires <= now) {
    tickets.delete(id);
    return undefined;
  }
  return t.userId === userId ? t : undefined;
}

export function consumeTvTicket(raw: unknown): void {
  tickets.delete(String(raw ?? '').slice(0, 64));
}
