/**
 * Desktop notifications for chat: decides whether an arriving message deserves
 * one, and words it.
 *
 * Deliberately knows nothing about the SDK, the DOM, or Electron — `store.ts`
 * extracts a `NotifyCandidate` from a `MatrixEvent` (it is the only place
 * allowed to touch the decryption-order rules in that file's header) and passes
 * the OS sink in as a hook. That seam is what makes every rule below testable
 * without a homeserver, and it keeps the one module that decides "should this
 * interrupt the user" small enough to read in full.
 *
 * The four rules, in order:
 *
 *  1. Push rules decide first. `pushNotify` is the homeserver's own verdict for
 *     this event (`getPushActionsForEvent`), so a muted room, a per-room
 *     override or a keyword rule set in Element is already respected here — we
 *     never re-implement that policy, we only ever narrow it.
 *  2. Never notify about the room you are looking at. "Looking at" means the
 *     docked window is open, the app has OS focus, and that room's timeline is
 *     the one on screen.
 *  3. Mentions and DMs always get through otherwise. Ordinary room chatter does
 *     not while you are in the panel with the app focused — you will see it.
 *  4. One notification per room per burst, not per message: a reconnect after
 *     an hour offline replays everything you missed as live events, and 200
 *     notifications is not 200 times as useful as "200 new messages".
 *
 * On message text: the body is *off* by default (see `readNotifyPrefs`). A
 * notification leaves the app for the OS notification service — on Linux that
 * is a daemon that may well log it — so decrypted content only goes there when
 * the user has asked for it. Everything else in this file assumes the strings
 * it is handed are remote and hostile; see `clean()`.
 */

export type NotifyKind = 'message' | 'picture' | 'file';

export interface NotifyPrefs {
  /** Master switch. */
  enabled: boolean;
  /** Put the message text in the notification body. Off by default. */
  showBody: boolean;
}

/** What the reader is currently attending to. Assembled by the store from the
 *  panel's own state (`MatrixUI` reports the window and focus; the store knows
 *  which room is open). */
export interface NotifyAttention {
  /** The docked window is open. */
  panelOpen: boolean;
  /** The app window has OS focus and the document is not hidden. */
  appFocused: boolean;
  /** The room whose timeline is on screen, if any. */
  openRoomId: string | null;
}

/** One message worth considering. Every string here is remote. */
export interface NotifyCandidate {
  /** Dedupe key: an encrypted message reaches us twice (once from the timeline
   *  while still ciphertext, once on decryption) and a re-requested key can
   *  fire the second path more than once. */
  eventId: string;
  roomId: string;
  roomName: string;
  /** A direct chat — notifies even while you are reading another room. */
  isDm: boolean;
  senderName: string;
  /** The homeserver's push rules said to notify for this event. */
  pushNotify: boolean;
  /** Push rules set the `highlight` tweak: a mention, or a keyword you watch. */
  isHighlight: boolean;
  /** The message text, used only when the `showBody` preference is on. */
  preview: string;
  kind: NotifyKind;
}

export interface NotifierHooks {
  /** Read at fire time, so toggling a preference takes effect immediately. */
  prefs(): NotifyPrefs;
  attention(): NotifyAttention;
  /** The OS sink. `store.ts` passes `notifyDesktop`, which is a no-op in the
   *  browser build — nothing here needs to know that. */
  send(title: string, body: string): void;
}

export interface NotifierOptions {
  /** How long to gather messages before firing one notification per room. */
  coalesceMs?: number;
  /** Injected timer, so tests are deterministic instead of slow. Returns its
   *  own canceller. */
  schedule?(fn: () => void, ms: number): () => void;
}

const COALESCE_MS = 1200;

/** Notification bodies are one line in every OS that shows them; a long one is
 *  truncated by the platform anyway, and an untruncated hostile one is a way to
 *  push the rest of the text off screen. */
const MAX_BODY_CHARS = 140;
const MAX_TITLE_CHARS = 64;

/** Bound on the dedupe set. Well past any real burst, and it only has to
 *  outlive the coalescing window plus the SDK's late-decryption retries. */
const SEEN_CAP = 500;

/**
 * Sanitise one remote string for an OS notification.
 *
 * The angle brackets are not paranoia about our own rendering — a notification
 * body never touches our DOM. They are about the platform: several Linux
 * notification daemons render a limited HTML subset in the body, so a display
 * name of `<b>admin</b>` (or worse, one carrying an `<img>`) would be markup
 * rather than text on those desktops, and we cannot escape for a daemon we
 * cannot identify. Stripping them costs a literal `<` in a display name and
 * can produce markup nowhere.
 *
 * Also collapses whitespace: a body is a single line, and a message of 400
 * newlines must not become a 400-line notification.
 */
function clean(s: string, max: number): string {
  const flat = s
    .replace(/[<>]/g, '')
    // C0/C1 controls plus the bidi and zero-width format characters a display
    // name may legally carry: invisible in our own UI, but able to reorder or
    // blank a line in a notification popup.
    .replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

interface Pending {
  roomName: string;
  isDm: boolean;
  count: number;
  /** Distinct senders, to decide between "3 new messages" and "3 from Alice". */
  senders: Set<string>;
  lastSender: string;
  lastPreview: string;
  lastKind: NotifyKind;
  anyHighlight: boolean;
}

export class MatrixNotifier {
  private readonly seen = new Set<string>();
  private readonly pending = new Map<string, Pending>();
  private cancelTimer: (() => void) | null = null;
  private readonly coalesceMs: number;
  private readonly schedule: (fn: () => void, ms: number) => () => void;

  constructor(
    private readonly hooks: NotifierHooks,
    opts: NotifierOptions = {},
  ) {
    this.coalesceMs = opts.coalesceMs ?? COALESCE_MS;
    this.schedule =
      opts.schedule ??
      ((fn, ms) => {
        const handle = setTimeout(fn, ms);
        return () => clearTimeout(handle);
      });
  }

  /**
   * Offer one message. Cheap and safe to call for every arriving event — the
   * gates below are the whole point of the class.
   */
  consider(c: NotifyCandidate): void {
    // Dedupe before anything else, so an event that reaches us twice can never
    // be notified twice regardless of which gate it passes.
    if (this.seen.has(c.eventId)) return;
    this.remember(c.eventId);

    if (!this.hooks.prefs().enabled) return;
    // Rule 1: the homeserver's push rules already decided. We only narrow.
    if (!c.pushNotify) return;

    const at = this.hooks.attention();
    const engaged = at.panelOpen && at.appFocused;
    // Rule 2: you are reading this room right now.
    if (engaged && at.openRoomId === c.roomId) return;
    // Rule 3: ordinary chatter, and you are already in the panel.
    if (engaged && !c.isHighlight && !c.isDm) return;

    // Rule 4: gather, then fire once per room.
    const p = this.pending.get(c.roomId);
    if (p) {
      p.count++;
      p.roomName = c.roomName;
      p.senders.add(c.senderName);
      p.lastSender = c.senderName;
      p.lastPreview = c.preview;
      p.lastKind = c.kind;
      p.anyHighlight = p.anyHighlight || c.isHighlight;
    } else {
      this.pending.set(c.roomId, {
        roomName: c.roomName,
        isDm: c.isDm,
        count: 1,
        senders: new Set([c.senderName]),
        lastSender: c.senderName,
        lastPreview: c.preview,
        lastKind: c.kind,
        anyHighlight: c.isHighlight,
      });
    }
    this.arm();
  }

  /** Fire everything gathered so far. */
  flush(): void {
    this.cancelTimer?.();
    this.cancelTimer = null;
    if (this.pending.size === 0) return;
    const rooms = Array.from(this.pending.values());
    this.pending.clear();
    const { showBody } = this.hooks.prefs();
    for (const p of rooms) {
      this.hooks.send(clean(p.roomName, MAX_TITLE_CHARS) || 'Matrix', bodyFor(p, showBody));
    }
  }

  /** Drop anything gathered without firing it — a sign-out or a disconnect must
   *  not pop a notification for a session that is already gone. */
  reset(): void {
    this.cancelTimer?.();
    this.cancelTimer = null;
    this.pending.clear();
  }

  destroy(): void {
    this.reset();
    this.seen.clear();
  }

  /** Trailing timer: the first message of a burst starts the clock, later ones
   *  join the same notification rather than pushing it back. */
  private arm(): void {
    if (this.cancelTimer) return;
    this.cancelTimer = this.schedule(() => {
      this.cancelTimer = null;
      this.flush();
    }, this.coalesceMs);
  }

  private remember(eventId: string): void {
    this.seen.add(eventId);
    while (this.seen.size > SEEN_CAP) {
      const oldest = this.seen.values().next();
      if (oldest.done) break;
      this.seen.delete(oldest.value);
    }
  }
}

/**
 * Word one room's pending messages.
 *
 * A DM's room name *is* the other person, so their name is dropped from the
 * body there — "Alice / Alice sent a message" reads like a bug.
 */
function bodyFor(p: Pending, showBody: boolean): string {
  const who = clean(p.lastSender, MAX_TITLE_CHARS);
  const oneSender = p.senders.size === 1;

  if (p.count === 1) {
    if (showBody && p.lastPreview.trim()) {
      const text = clean(p.lastPreview, MAX_BODY_CHARS);
      return p.isDm ? text : clean(`${who}: ${text}`, MAX_BODY_CHARS);
    }
    if (p.anyHighlight) return p.isDm ? 'Mentioned you' : `${who} mentioned you`;
    if (p.lastKind === 'picture') return p.isDm ? 'Sent a picture' : `${who} sent a picture`;
    if (p.lastKind === 'file') return p.isDm ? 'Sent a file' : `${who} sent a file`;
    return p.isDm ? 'New message' : `${who} sent a message`;
  }

  const base =
    oneSender && !p.isDm ? `${p.count} new messages from ${who}` : `${p.count} new messages`;
  return p.anyHighlight ? `${base}, including a mention` : base;
}
