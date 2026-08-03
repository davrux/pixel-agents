/**
 * Pending zone invites (SimRoom's real-time "pull someone in": zoneInvite /
 * zoneInviteRespond). zoneInviteRespond runs in whatever room the invitee is
 * currently connected to, which may not be the target zone's room, so this
 * needs to be shared across room instances the same way presence.ts is — a
 * plain module-level store, not per-room state (a single Node process serves
 * every room).
 *
 * Without this, zoneInviteRespond had to trust a client-supplied zoneId +
 * accept:true outright, letting ANY authenticated user add themselves to
 * ANY zone's ACL — zone ids aren't secret (every client receives the full
 * zone list on join/requestZones, private zones included) — whether or not
 * they were ever actually invited. zoneInvite now records one here; only a
 * matching, unexpired record lets zoneInviteRespond's accept go through.
 */
interface PendingInvite {
  expiresAt: number;
}

const TTL_MS = 5 * 60_000; // long enough to read the prompt and click Accept

const pending = new Map<string, Map<string, PendingInvite>>(); // targetUserId -> zoneId -> invite

export const zoneInvites = {
  /** Record that `targetUserId` was just invited to `zoneId`. */
  record(targetUserId: string, zoneId: string): void {
    if (!targetUserId || !zoneId) return;
    let byZone = pending.get(targetUserId);
    if (!byZone) {
      byZone = new Map();
      pending.set(targetUserId, byZone);
    }
    byZone.set(zoneId, { expiresAt: Date.now() + TTL_MS });
  },

  /** True (and consumes the record) only if `targetUserId` has an unexpired
   *  pending invite to `zoneId`. Expired/missing records are dropped either
   *  way, so a stale invite can't be replayed later. */
  consume(targetUserId: string, zoneId: string): boolean {
    const byZone = pending.get(targetUserId);
    const invite = byZone?.get(zoneId);
    if (!invite) return false;
    byZone!.delete(zoneId);
    if (byZone!.size === 0) pending.delete(targetUserId);
    return invite.expiresAt >= Date.now();
  },
};
