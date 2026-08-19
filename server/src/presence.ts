/**
 * Cross-zone online-user presence. Each SimRoom reports joins/leaves here so a
 * command like `/users all` can list every logged-in user and the zone they're
 * currently in (SimRooms otherwise only know their own clients). Refcounted by
 * session, so multiple tabs of one user collapse to a single entry.
 *
 * Every change also fires PRESENCE_EVENT on the control bus, because the online
 * list in the HUD is pushed, not polled: whoever is standing in zone A has to
 * see someone arriving in zone B, and only this module sees both.
 */
import { controlBus, PRESENCE_EVENT } from './controlBus.js';

interface Entry {
  zone: string;
  name: string; // display name
  sessions: number;
}

const online = new Map<string, Entry>();

export const presence = {
  /** Record a session joining `zone` (sets the user's current zone). */
  join(userId: string, zone: string, name: string): void {
    if (!userId) return;
    const e = online.get(userId);
    if (e) {
      e.zone = zone;
      e.name = name;
      e.sessions += 1;
    } else {
      online.set(userId, { zone, name, sessions: 1 });
    }
    controlBus.emit(PRESENCE_EVENT);
  },
  /** Record a session leaving; drops the user when their last session goes. */
  leave(userId: string): void {
    const e = online.get(userId);
    if (!e) return;
    if (--e.sessions <= 0) online.delete(userId);
    controlBus.emit(PRESENCE_EVENT);
  },
  /** Current zone of an online user, or null. */
  zoneOf(userId: string): string | null {
    return online.get(userId)?.zone ?? null;
  },
  /** All online users with their current zone + display name. */
  list(): Array<{ userId: string; zone: string; name: string }> {
    return [...online.entries()].map(([userId, e]) => ({ userId, zone: e.zone, name: e.name }));
  },
};
