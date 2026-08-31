/**
 * Cross-zone online-user presence. Each SimRoom reports joins/leaves here so a
 * command like `/users all` can list every logged-in user and the zone they're
 * currently in (SimRooms otherwise only know their own clients). Refcounted by
 * session, so multiple tabs of one user collapse to a single entry.
 *
 * Every change also fires PRESENCE_EVENT on the control bus, because the online
 * list in the HUD is pushed, not polled: whoever is standing in zone A has to
 * see someone arriving in zone B, and only this module sees both.
 *
 * It also carries the one fact about a user that is neither an account field nor
 * room state: the Mumble channel their desktop app says it is in (see setVoice).
 * That belongs to a user rather than to a pawn, which is why the roster can show
 * it for someone two zones away while `CharacterSync.voiceChannel` — the same
 * fact on a body you can see — only exists inside the room that body is in.
 */
import { controlBus, PRESENCE_EVENT } from './controlBus.js';

interface Entry {
  zone: string;
  name: string; // display name
  sessions: number;
  /** Mumble channel this user's desktop app last reported, or '' — see setVoice. */
  voice: string;
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
      online.set(userId, { zone, name, sessions: 1, voice: '' });
    }
    controlBus.emit(PRESENCE_EVENT);
  },
  /**
   * Record which Mumble channel this user is sitting in, '' for none. Lives
   * here rather than on the room because the online list is CROSS-ZONE: a room
   * only knows its own clients, and "who can I talk to right now" is exactly
   * the question you ask about someone standing somewhere else.
   *
   * Last report wins, which is the same rule `zone` and `name` above already
   * follow — a user with two sessions is one entry, and the imprecision it buys
   * is the same one: a second tab outliving the one that reported leaves the
   * last answer standing until its own session goes, which drops the entry
   * whole. In practice only the desktop build ever reports, since it is the
   * only build with a Mumble connection.
   */
  setVoice(userId: string, voice: string): void {
    const e = online.get(userId);
    if (!e || e.voice === voice) return;
    e.voice = voice;
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
  /** All online users with their current zone, display name and voice channel. */
  list(): Array<{ userId: string; zone: string; name: string; voice: string }> {
    return [...online.entries()].map(([userId, e]) => ({ userId, zone: e.zone, name: e.name, voice: e.voice }));
  },
};
