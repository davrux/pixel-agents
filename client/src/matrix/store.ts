/**
 * `MatrixStore` over the official SDK: projects `sdk.Room`/`MatrixEvent` into
 * the same `MxRoom`/`MxEvent` shapes `MatrixUI.ts` has always consumed, and
 * turns the SDK's many fine-grained events into the four/six coalesced
 * signals the panel listens for. No DOM here at all.
 *
 * Two SDK quirks shape this file:
 *
 * - `pendingEventOrdering: Detached` (set by `client.ts`'s boot) is what
 *   makes `Room.getPendingEvents()` legal at all, and is what keeps local
 *   echoes out of `getLiveTimeline()` — without it, `timeline()`'s
 *   concatenation of the two would double-render every outgoing message.
 * - On a decryption failure the SDK installs a synthetic *clear* event whose
 *   `getType()` reports `'m.room.message'` with the SDK's own
 *   `** Unable to decrypt: … **` string as `body` — reading that body would
 *   put a raw internal error in a chat bubble. `classify()` below dispatches
 *   on `isBeingDecrypted()`/`isDecryptionFailure()` *before* ever looking at
 *   type or content, and only reads `getContent()` once an event has
 *   cleared both checks. An event mid-decryption has no clear event at all,
 *   so skipping this order renders a blank row instead of "Decrypting…".
 *
 * Threads are the SDK's, not ours: `threadSupport: true` (client.ts) makes it
 * file every `m.thread` reply — and the relations, redactions and replies that
 * hang off one — into a `Thread` object instead of the room's live timeline,
 * where only the thread's ROOT still appears. Two consequences run through this
 * file. `timeline()` must filter `getPendingEvents()`, which stays room-wide
 * under `Detached` ordering and would otherwise draw a reply typed into a
 * thread in the main timeline until the server echoed it back. And a thread
 * carries its own read receipts, its own notification counts and its own
 * pagination token, so every one of those has a thread-scoped twin below
 * rather than a `roomId` argument that quietly means "the main timeline".
 *
 * Every method that can reject normalises the rejection through
 * `MatrixError.from()` — `MatrixUI`'s `errcode`-branching error text and the
 * join flow's `M_FORBIDDEN`/`M_NOT_FOUND` cases both depend on that shape
 * surviving the trip through the SDK's own error classes.
 */
import {
  ClientEvent,
  RoomEvent,
  RoomMemberEvent,
  RoomStateEvent,
  MatrixEventEvent,
  HttpApiEvent,
  SyncState,
  EventStatus,
  ThreadEvent,
  sdk,
} from './sdk.js';
import type {
  MatrixClient,
  Room,
  MatrixEvent,
  RoomMember,
  RoomMessageEventContent,
  SdkMatrixError,
  Thread,
} from './sdk.js';
import { MatrixError } from './types.js';
import type {
  MxCryptoState,
  MxDecryptError,
  MxDirectoryUser,
  MxEvent,
  MxEventUnsigned,
  MxMember,
  MxReaction,
  MxReader,
  MxMembership,
  MxReplyTo,
  MxRoom,
  MxSession,
  MxSecretRequest,
  MxStatus,
  MxThreadInfo,
} from './types.js';
import { bootMatrixClient, type MxBootState, type MxClientBoot } from './client.js';
import { cryptoDbPrefix, drainPendingWipes, readNotifyPrefs, startFresh, wipeNamespace } from './storage.js';
import { MatrixNotifier, type NotifyKind } from './notify.js';
import { notifyDesktop } from '../desktop/bridge.js';
import { createMatrixCrypto, type MatrixCrypto } from './crypto.js';
import { MatrixMedia, type MxAttachmentContent, type MxFileContent, type MxImageContent } from './media.js';
import { toHtml } from './markdown.js';

const READ_DEBOUNCE_MS = 1000;

/** How long one m.typing advertisement lives server-side, and (well before
 *  that) how often a still-typing composer refreshes it. The gap between the
 *  two is what keeps the reader's indicator from flickering off between
 *  refreshes; the timeout itself is the only "stop" an abandoned draft ever
 *  sends — walking away just lets it lapse, which is what it exists for. */
const TYPING_TIMEOUT_MS = 10_000;
const TYPING_REFRESH_MS = 6_000;

/**
 * Events per backward pagination. Was 30, which with infinite scrolling meant a
 * request every couple of flicks of the wheel; 80 fills a tall panel in one go
 * and still sits well under the timeline's 400-row DOM cap, so a few pages of
 * scrollback never trims what the reader is looking at.
 *
 * Bigger is not free in an encrypted room: every event in the batch is a megolm
 * decryption before it can be rendered.
 */
const PAGINATE_LIMIT = 80;
const LOGOUT_HTTP_TIMEOUT_MS = 5000;

/** The one reason a decrypt-failure event can reach the renderer with no
 *  crypto facade to explain it: `classify()` only ever runs while
 *  `this.client` is set, and the client and crypto facade are always
 *  created together in `runBoot()` — but a `?? fallback` here costs
 *  nothing and turns a "should never happen" into an honest generic row
 *  instead of a crash. */
const GENERIC_DECRYPT_ERROR: MxDecryptError = {
  code: 'UNKNOWN_ERROR',
  text: "Couldn't decrypt this message.",
  action: null,
};

export interface MatrixStoreEventMap {
  status: void;
  rooms: void;
  timeline: string;
  /** Someone's typing state changed in this room (payload: roomId). Read the
   *  current set back with `typingIn()` — the event itself carries no names. */
  typing: string;
  /** `soft` distinguishes a soft logout (session paused, this device id is still valid and the local
   *  crypto store is deliberately kept — see `onSessionLoggedOut`) from a hard one (session revoked, or
   *  a manual sign-out) where the local crypto store is always wiped. */
  loggedOut: { expired: boolean; soft: boolean };
  crypto: void;
  secretRequest: MxSecretRequest;
}
export interface MatrixStoreOpts {
  session: MxSession;
  paUserId: string;
  /**
   * What the reader is attending to, for notifications: whether the docked
   * window is open and whether the app has focus. The store supplies the third
   * part (which room is open) itself.
   *
   * Absent, it assumes you are watching the panel — the quieter of the two
   * guesses, since a wrong "you can't see this" only costs a notification while
   * a wrong "nobody is looking" interrupts for every message.
   */
  attention?: () => { panelOpen: boolean; appFocused: boolean };
}

/** Tiny typed emitter — no event-emitter package dependency, and it keeps
 *  the public surface to exactly the keys in MatrixStoreEventMap. */
class Emitter<M> {
  private readonly listeners = new Map<keyof M, Set<(payload: M[keyof M]) => void>>();
  on<K extends keyof M>(key: K, fn: (payload: M[K]) => void): () => void {
    let set = this.listeners.get(key);
    if (!set) {
      set = new Set();
      this.listeners.set(key, set);
    }
    set.add(fn as (payload: M[keyof M]) => void);
    return () => set?.delete(fn as (payload: M[keyof M]) => void);
  }
  emit<K extends keyof M>(key: K, payload: M[K]): void {
    const set = this.listeners.get(key);
    if (!set || set.size === 0) return;
    for (const fn of Array.from(set)) fn(payload);
  }
}

function toMxMembership(m: string): MxMembership {
  if (m === 'invite') return 'invite';
  if (m === 'join') return 'join';
  return 'leave';
}

/** Which "Alice sent a …" line an incoming message earns, from its msgtype
 *  alone — the notification never carries the body unless the user asked for it
 *  (see notify.ts), so this is usually all the reader gets. */
function notifyKindOf(msgtype: unknown): NotifyKind {
  if (msgtype === 'm.image') return 'picture';
  if (msgtype === 'm.file' || msgtype === 'm.audio' || msgtype === 'm.video') return 'file';
  return 'message';
}

/** Message kinds an edit is offered for. A picture is deliberately not one:
 *  `m.new_content` would have to carry a whole new upload, and "edit" for a
 *  file means "delete and send again" in every other client too. */
const EDITABLE_MSGTYPES = new Set(['m.text', 'm.emote', 'm.notice']);

/** The subset of `m.relates_to` this client acts on. */
interface MxRelatesTo {
  rel_type?: string;
  event_id?: string;
  key?: string;
  'm.in_reply_to'?: { event_id?: string };
}

/**
 * An event's relation, wire content first.
 *
 * Both halves are needed. In an encrypted room the sender lifts
 * `m.relates_to` out of the ciphertext into the cleartext content (the spec
 * requires it, so the *server* can aggregate) — that is the wire copy, and the
 * only one the SDK's own `getRelation()`/`replyEventId` ever look at. The
 * decrypted copy is the fallback for a sender that didn't lift it, which is
 * still common for replies specifically: without it, a reply from such a client
 * would render as an ordinary message with a stray `> quoted` prefix.
 */
function relationOf(ev: MatrixEvent): MxRelatesTo | undefined {
  const wire = ev.getRelation() as MxRelatesTo | null;
  if (wire) return wire;
  const clear = (ev.getOriginalContent() as { 'm.relates_to'?: MxRelatesTo })['m.relates_to'];
  return clear ?? undefined;
}

/** True for an edit event itself (`m.replace`). These are never rows: the SDK
 *  folds them into the event they replace, whose `getContent()` then returns the
 *  new text, so rendering them too would double every edited message. */
function isEditRelation(ev: MatrixEvent): boolean {
  return relationOf(ev)?.rel_type === 'm.replace';
}

/**
 * True for an event that belongs *inside* a thread rather than the main
 * timeline: a thread reply, or a relation hanging off one. A thread ROOT is
 * deliberately not one — `MatrixEvent.threadRootId` reports a root's own id, and
 * the root is exactly the message the main timeline still shows.
 *
 * Only needed where we look at events the SDK has not filed yet: pending local
 * echoes (`Room.getPendingEvents()` is room-wide under `Detached` ordering).
 * Everywhere else the SDK has already put the event in the right timeline.
 */
function isThreadReply(ev: MatrixEvent): boolean {
  const root = ev.threadRootId;
  return root !== undefined && root !== ev.getId();
}

/** The event this one replies to, or undefined when it isn't a reply. */
function replyTargetId(ev: MatrixEvent): string | undefined {
  const id = relationOf(ev)?.['m.in_reply_to']?.event_id;
  return typeof id === 'string' && id ? id : undefined;
}

/**
 * Drop a rich-reply fallback from a plain-text body: the `> <@alice> …` block
 * senders prepend so that a client with no reply support still shows the
 * context. We draw the quote ourselves from the relation, so the fallback would
 * be the same text twice.
 *
 * Only ever called for an event that *is* a reply, and it never returns an
 * empty string — a one-line reply consisting of nothing but a quote is far
 * likelier to be a fallback we misread than a message the sender meant to
 * be blank.
 *
 * (We don't send this fallback ourselves — see `send()` — but Element and most
 * other clients still do.)
 */
function stripReplyFallback(body: string): string {
  if (!body.startsWith('>')) return body;
  const lines = body.split('\n');
  let i = 0;
  while (i < lines.length && lines[i]!.startsWith('>')) i++;
  while (i < lines.length && lines[i]!.trim() === '') i++;
  const rest = lines.slice(i).join('\n');
  return rest || body;
}

export class MatrixStore {
  readonly userId: string;

  private readonly session: MxSession;
  private readonly paUserId: string;
  private readonly emitter = new Emitter<MatrixStoreEventMap>();

  private client: MatrixClient | null = null;
  private cryptoFacade: MatrixCrypto | null = null;
  private media_: MatrixMedia | null = null;
  private boot: MxClientBoot | null = null;

  private status_: MxStatus = 'connecting';
  private bootState_: MxBootState = 'ok';
  private bootMessage_ = '';
  private cryptoWarning_ = '';
  /** Non-empty after a logout/forced-signout whose IndexedDB delete(s) did not all succeed — the
   *  caller must turn this into a persistent, non-dismissable banner (design §2.4 step 9), never a
   *  silent success. Kept separate from `bootState` because that field describes a *boot*, not a
   *  sign-out outcome. */
  private lastWipeFailed_: string[] = [];
  /** Set by `setMyAvatar` so the strip repaints before /sync catches up. */
  private myAvatarOverride_: string | null = null;
  private bootPhase = '';
  private everPrepared = false;
  private knownDeadToken = false;
  private wiping = false;
  private started = false;

  private readonly unsubs: Array<() => void> = [];
  private readonly roomUnreadUnsubs = new Map<string, () => void>();
  private readonly loadingRooms = new Map<string, boolean>();
  private readonly roomErrors = new Map<string, string>();
  private readonly readTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly lastSentRead = new Map<string, string>();
  private searchGeneration = 0;
  private openRoomId: string | null = null;

  /**
   * The one open thread, and its load state.
   *
   * Single-slot rather than a `Map` keyed by thread id, and that is the point:
   * the panel shows exactly one thread at a time, so there is nothing here that
   * grows with how many threads a room has (§Memory — a per-thread map would
   * need a delete site on every path a thread can vanish down, and there are
   * several). `openThreadId` is also what `loadingThread`/`threadError` answer
   * against, so a stale flag can never be read for a thread nobody is looking
   * at.
   */
  private openThreadId: string | null = null;
  private threadLoading = false;
  private threadErrorText = '';
  /** Same again for the threads LIST, which is per room and likewise one at a
   *  time. `threadsFetchedRoom` is what stops every repaint re-asking the
   *  homeserver for the same page. */
  private threadsFetchedRoom: string | null = null;
  private threadsLoading = false;
  private threadsErrorText = '';

  private roomsFlushQueued = false;
  private readonly timelineDirty = new Set<string>();
  private timelineFlushQueued = false;

  /** The room our own m.typing advertisement currently stands in (and when it
   *  was sent), so `notifyTyping` can coalesce a keystroke stream into one
   *  request per TYPING_REFRESH_MS instead of one per key. */
  private typingSentRoom: string | null = null;
  private typingSentAt = 0;

  private readonly onOnline = (): void => this.retryNow();
  private readonly onOffline = (): void => this.setStatus('offline');

  /** Live events that arrived as ciphertext and have not been read yet (see
   *  `considerNotify` — sync starts their decryption only after the timeline
   *  event, so most of these are not even in flight when parked). Only an id in
   *  here may notify when `Decrypted` fires: that event also fires for history
   *  whose keys turn up much later, and backfilled messages from last week must
   *  not pop notifications. */
  private readonly awaitingDecrypt = new Set<string>();

  private readonly notifier: MatrixNotifier;

  constructor(o: MatrixStoreOpts) {
    this.session = o.session;
    this.paUserId = o.paUserId;
    this.userId = o.session.userId;
    this.notifier = new MatrixNotifier({
      prefs: () => readNotifyPrefs(),
      attention: () => ({
        ...(o.attention?.() ?? { panelOpen: true, appFocused: true }),
        openRoomId: this.openRoomId,
      }),
      // No-op in the browser build, which has no permission-free path to an OS
      // notification (see bridge.ts) — nothing else here needs to care.
      send: (title, body) => notifyDesktop(title, body),
    });
    if (typeof window !== 'undefined') {
      window.addEventListener('online', this.onOnline);
      window.addEventListener('offline', this.onOffline);
    }
  }

  on<K extends keyof MatrixStoreEventMap>(key: K, fn: (payload: MatrixStoreEventMap[K]) => void): () => void {
    return this.emitter.on(key, fn);
  }

  // ---- status / crypto / boot surface -----------------------------------

  get status(): MxStatus {
    return this.status_;
  }

  get statusLabel(): string {
    if ((this.status_ === 'connecting' || this.status_ === 'syncing') && this.bootPhase) {
      return this.bootPhase;
    }
    switch (this.status_) {
      case 'connected':
        return 'Connected';
      case 'syncing':
        return 'Syncing…';
      case 'connecting':
        return 'Connecting…';
      case 'reconnecting':
        return 'Reconnecting…';
      case 'offline':
        return 'Offline';
      case 'signedout':
        return 'Signed out';
      default:
        return '';
    }
  }

  get crypto(): MatrixCrypto | null {
    return this.cryptoFacade;
  }

  get cryptoState(): MxCryptoState {
    return this.cryptoFacade?.state ?? 'unavailable';
  }

  get cryptoWarning(): string {
    return this.cryptoWarning_;
  }

  get bootState(): MxBootState {
    return this.bootState_;
  }

  get bootMessage(): string {
    return this.bootMessage_;
  }

  /** Non-empty when the most recent logout/forced-signout could not fully delete this namespace's
   *  crypto databases. See `lastWipeFailed_`. */
  get lastWipeFailed(): string[] {
    return this.lastWipeFailed_;
  }

  private setStatus(s: MxStatus): void {
    if (this.status_ === s) return;
    this.status_ = s;
    this.emitter.emit('status', undefined);
  }

  // ---- lifecycle ----------------------------------------------------------

  startFresh(): void {
    startFresh(this.paUserId);
    this.teardownClient();
    this.started = false;
    this.everPrepared = false;
    this.knownDeadToken = false;
    this.bootState_ = 'ok';
    this.bootMessage_ = '';
    this.cryptoWarning_ = '';
    this.start();
  }

  /** Idempotent; kicks off the async boot and returns synchronously — the
   *  host does `new MatrixStore({...}); …; this.store.start();` and that
   *  shape must not change. */
  start(): void {
    if (this.started) return;
    this.started = true;
    void this.runBoot();
  }

  private async runBoot(): Promise<void> {
    this.bootPhase = '';
    this.setStatus('connecting');
    const crypto = createMatrixCrypto();
    const result = await bootMatrixClient({
      session: this.session,
      paUserId: this.paUserId,
      crypto,
      onPhase: (label) => {
        this.bootPhase = label;
        this.emitter.emit('status', undefined);
      },
    });
    this.bootPhase = '';
    this.bootState_ = result.state;
    this.bootMessage_ = result.message;
    this.cryptoWarning_ = result.warning;
    if (result.state !== 'ok' || !result.client) {
      this.setStatus('offline');
      this.emitter.emit('status', undefined);
      return;
    }
    this.boot = result;
    this.client = result.client;
    this.cryptoFacade = crypto;
    this.media_ = new MatrixMedia(result.client);
    this.wireClient(result.client);
    this.wireCrypto(crypto);
  }

  private wireClient(client: MatrixClient): void {
    const onSync = (state: SyncState, _prevState: SyncState | null, data?: { error?: unknown }): void => {
      this.applySyncState(state, data);
    };
    client.on(ClientEvent.Sync, onSync);
    this.unsubs.push(() => client.off(ClientEvent.Sync, onSync));

    const onRoom = (room: Room): void => {
      this.attachRoomUnreadListener(room);
      this.markRoomsDirty();
    };
    client.on(ClientEvent.Room, onRoom);
    this.unsubs.push(() => client.off(ClientEvent.Room, onRoom));

    const onDeleteRoom = (roomId: string): void => {
      this.roomUnreadUnsubs.get(roomId)?.();
      this.roomUnreadUnsubs.delete(roomId);
      this.loadingRooms.delete(roomId);
      this.roomErrors.delete(roomId);
      if (this.openRoomId === roomId) {
        this.openRoomId = null;
        this.openThreadId = null;
      }
      if (this.threadsFetchedRoom === roomId) this.threadsFetchedRoom = null;
      this.markRoomsDirty();
    };
    client.on(ClientEvent.DeleteRoom, onDeleteRoom);
    this.unsubs.push(() => client.off(ClientEvent.DeleteRoom, onDeleteRoom));

    const onRoomsDirty = (): void => this.markRoomsDirty();
    client.on(RoomEvent.Name, onRoomsDirty);
    this.unsubs.push(() => client.off(RoomEvent.Name, onRoomsDirty));
    client.on(RoomEvent.MyMembership, onRoomsDirty);
    this.unsubs.push(() => client.off(RoomEvent.MyMembership, onRoomsDirty));
    client.on(RoomStateEvent.Update, onRoomsDirty);
    this.unsubs.push(() => client.off(RoomStateEvent.Update, onRoomsDirty));

    const onAccountData = (event: MatrixEvent): void => {
      if (event.getType() === sdk.EventType.Direct) this.markRoomsDirty();
    };
    client.on(ClientEvent.AccountData, onAccountData);
    this.unsubs.push(() => client.off(ClientEvent.AccountData, onAccountData));

    // m.typing is ephemeral: the SDK keeps every member's `typing` flag
    // current (timeout expiry included) and fires this once per member whose
    // state flipped. The emit carries only the roomId — the panel reads the
    // set back through `typingIn()`, so a burst of flips coalesces to however
    // many repaints, not a growing payload.
    const onTyping = (_event: MatrixEvent, member: RoomMember): void => {
      this.emitter.emit('typing', member.roomId);
    };
    client.on(RoomMemberEvent.Typing, onTyping);
    this.unsubs.push(() => client.off(RoomMemberEvent.Typing, onTyping));

    const onTimeline = (
      event: MatrixEvent,
      room: Room | undefined,
      toStartOfTimeline: boolean | undefined,
      _removed: boolean,
      data?: { liveEvent?: boolean },
    ): void => {
      const roomId = room?.roomId ?? event.getRoomId();
      if (roomId) this.emitTimelineDirty(roomId);
      this.markRoomsDirty();
      // Notifications are for messages arriving *now*: not back-pagination
      // (toStartOfTimeline), not a timeline rewrite (liveEvent false), and not
      // the initial sync's backlog (everPrepared).
      if (toStartOfTimeline === true || data?.liveEvent !== true) return;
      this.considerNotify(event, room, false);
    };
    client.on(RoomEvent.Timeline, onTimeline);
    this.unsubs.push(() => client.off(RoomEvent.Timeline, onTimeline));

    const onTimelineReset = (room: Room | undefined): void => {
      if (room) this.emitTimelineDirty(room.roomId);
    };
    client.on(RoomEvent.TimelineReset, onTimelineReset);
    this.unsubs.push(() => client.off(RoomEvent.TimelineReset, onTimelineReset));

    const onLocalEcho = (_event: MatrixEvent, room: Room): void => this.emitTimelineDirty(room.roomId);
    client.on(RoomEvent.LocalEchoUpdated, onLocalEcho);
    this.unsubs.push(() => client.off(RoomEvent.LocalEchoUpdated, onLocalEcho));

    const onRedaction = (_event: MatrixEvent, room: Room): void => this.emitTimelineDirty(room.roomId);
    client.on(RoomEvent.Redaction, onRedaction);
    this.unsubs.push(() => client.off(RoomEvent.Redaction, onRedaction));

    // An edit landing on a message. The edit event's own arrival already dirties
    // the timeline, but the SDK aggregates it onto its target asynchronously
    // (the target may still be decrypting), so the render that follows the
    // arrival can still show the old text. This is the signal that the swap has
    // actually happened. Re-emitted for every mapped event by the SDK's own
    // event mapper, so one client-level listener covers every room.
    const onReplaced = (event: MatrixEvent): void => {
      const roomId = event.getRoomId();
      if (roomId) this.emitTimelineDirty(roomId);
      this.markRoomsDirty();
    };
    client.on(MatrixEventEvent.Replaced, onReplaced);
    this.unsubs.push(() => client.off(MatrixEventEvent.Replaced, onReplaced));

    // Somebody else read something: the only thing that moves a reader's
    // picture from one row to another (see readReceipts).
    const onReceipt = (_event: MatrixEvent, room: Room): void => this.emitTimelineDirty(room.roomId);
    client.on(RoomEvent.Receipt, onReceipt);
    this.unsubs.push(() => client.off(RoomEvent.Receipt, onReceipt));

    // The entire late-key path: when a key finally arrives the SDK retries
    // decryption on its own and fires this again — re-emitting 'timeline'
    // is all that's needed to turn a UTD row into a real message.
    const onDecrypted = (event: MatrixEvent): void => {
      const roomId = event.getRoomId();
      if (roomId) this.emitTimelineDirty(roomId);
      this.markRoomsDirty();
      // Only for an event we saw arrive live as ciphertext — otherwise this is a
      // late key unlocking old history, which is not news. Push actions are
      // recalculated because the ones computed over the ciphertext could not see
      // a body to match a mention against.
      const id = event.getId();
      if (id && this.awaitingDecrypt.delete(id)) {
        const room = roomId ? this.client?.getRoom(roomId) ?? undefined : undefined;
        this.considerNotify(event, room, true);
      }
    };
    client.on(MatrixEventEvent.Decrypted, onDecrypted);
    this.unsubs.push(() => client.off(MatrixEventEvent.Decrypted, onDecrypted));

    // `HttpApiEvent.SessionLoggedOut` fires for both a soft logout (session paused — this device id is
    // still good, the homeserver expects to see it again) and a hard M_UNKNOWN_TOKEN (session
    // revoked — this device is gone for good). `err.data.soft_logout` is the only field that tells
    // them apart; conflating the two would either force a needless full re-key on every soft logout
    // or, far worse, leave a revoked device's megolm keys sitting on disk after a remote sign-out
    // (requirement F: this is the commonest way a session actually dies on a shared/lost/compromised
    // machine). Only the hard case wipes.
    const onSessionLoggedOut = (err: SdkMatrixError | undefined): void => {
      const soft = err?.data?.soft_logout === true;
      if (err?.errcode === 'M_UNKNOWN_TOKEN') this.knownDeadToken = true;
      if (soft) {
        this.emitter.emit('loggedOut', { expired: true, soft: true });
        return;
      }
      if (this.wiping) return; // our own logout()'s /logout POST triggered this — already tearing down
      this.wiping = true;
      this.stop();
      void this.wipeAndTeardown().then(() => {
        this.emitter.emit('loggedOut', { expired: true, soft: false });
      });
    };
    client.on(HttpApiEvent.SessionLoggedOut, onSessionLoggedOut);
    this.unsubs.push(() => client.off(HttpApiEvent.SessionLoggedOut, onSessionLoggedOut));

    // RoomEvent.UnreadNotifications fires on the Room, not re-emitted to the
    // client (unlike Timeline/Name/etc — verified against sync.js's reEmit
    // list), so it needs a listener per room.
    for (const room of client.getRooms()) this.attachRoomUnreadListener(room);
  }

  private wireCrypto(crypto: MatrixCrypto): void {
    this.unsubs.push(crypto.on('state', () => this.emitter.emit('crypto', undefined)));
    this.unsubs.push(crypto.on('devices', () => this.emitter.emit('crypto', undefined)));
    this.unsubs.push(crypto.on('secretRequest', (req) => this.emitter.emit('secretRequest', req)));
  }

  /**
   * The per-room signals the client does not re-emit: unread counts, and the
   * thread lifecycle.
   *
   * `ThreadEvent.New` and `ThreadEvent.Update` are re-emitted by the Room but
   * NOT onward to the client (verified against sync.ts's reEmit list, which
   * carries Timeline/Name/Receipt and no thread event at all), so without this
   * a reply count on a root would only refresh when some unrelated timeline
   * event happened to repaint the row — and a brand-new thread would show no
   * summary until then. One entry per room, removed in `onDeleteRoom` and in
   * `detachListeners`, same as the unread listener it shares its slot with.
   */
  private attachRoomUnreadListener(room: Room): void {
    if (this.roomUnreadUnsubs.has(room.roomId)) return;
    const handler = (): void => this.markRoomsDirty();
    const threadHandler = (): void => {
      this.emitTimelineDirty(room.roomId);
      this.markRoomsDirty();
    };
    room.on(RoomEvent.UnreadNotifications, handler);
    room.on(ThreadEvent.New, threadHandler);
    room.on(ThreadEvent.Update, threadHandler);
    this.roomUnreadUnsubs.set(room.roomId, () => {
      room.off(RoomEvent.UnreadNotifications, handler);
      room.off(ThreadEvent.New, threadHandler);
      room.off(ThreadEvent.Update, threadHandler);
    });
  }

  /** Maps the whole SyncState enum. `Stopped` also fires on our own graceful
   *  stopClient() (logout/destroy), so it only means "signed out" when we
   *  set `wiping` ourselves — otherwise it must keep whatever status was
   *  showing, or a page-hide-triggered stop would flash a false "Signed
   *  out". "Before the first Prepared" is forced to 'syncing' regardless of
   *  the raw state so a transient hiccup during initial load never reads as
   *  "Reconnecting" for a connection that was never up. */
  private applySyncState(state: SyncState, data?: { error?: unknown }): void {
    let next: MxStatus;
    if (!this.everPrepared && state !== SyncState.Prepared) {
      next = 'syncing';
    } else if (state === SyncState.Prepared || state === SyncState.Syncing) {
      this.everPrepared = true;
      next = 'connected';
    } else if (state === SyncState.Reconnecting || state === SyncState.Catchup || state === SyncState.Error) {
      const errcode = (data?.error as { errcode?: string } | undefined)?.errcode;
      if (errcode === 'M_UNKNOWN_TOKEN') this.knownDeadToken = true;
      next = 'reconnecting';
    } else if (state === SyncState.Stopped) {
      next = this.wiping ? 'signedout' : this.status_;
    } else {
      next = this.status_;
    }
    this.setStatus(next);
    this.markRoomsDirty();
  }

  private detachListeners(): void {
    for (const unsub of this.unsubs) unsub();
    this.unsubs.length = 0;
    for (const unsub of this.roomUnreadUnsubs.values()) unsub();
    this.roomUnreadUnsubs.clear();
    for (const t of this.readTimers.values()) clearTimeout(t);
    this.readTimers.clear();
    this.lastSentRead.clear();
    this.loadingRooms.clear();
    this.roomErrors.clear();
    this.openRoomId = null;
    this.openThreadId = null;
    this.threadLoading = false;
    this.threadErrorText = '';
    this.threadsFetchedRoom = null;
    this.threadsLoading = false;
    this.threadsErrorText = '';
    // Drop, never flush: a stop is a sign-out, a page-hide or a disconnect, and
    // a notification arriving after the session it belongs to is gone would be
    // both confusing and (with message text on) a leak past the wipe.
    this.notifier.reset();
    this.awaitingDecrypt.clear();
  }

  /** client.stopClient() + listener/timer cleanup. Crypto store untouched,
   *  Web Lock held — the client/crypto instances themselves survive. */
  stop(): void {
    this.client?.stopClient();
    this.detachListeners();
  }

  private teardownClient(): void {
    this.stop();
    this.boot?.release();
    this.cryptoFacade?.destroy();
    // Revokes every blob: URL this session handed the timeline. Decrypted
    // picture bytes must not outlive the session that was allowed to read
    // them — a surviving blob: URL is readable by anything left on the page.
    this.media_?.destroy();
    this.boot = null;
    this.cryptoFacade = null;
    this.media_ = null;
    this.client = null;
  }

  /** Runs on page unload — must never delete storage. */
  destroy(): void {
    this.notifier.destroy();
    this.teardownClient();
    if (typeof window !== 'undefined') {
      window.removeEventListener('online', this.onOnline);
      window.removeEventListener('offline', this.onOffline);
    }
  }

  retryNow(): void {
    this.client?.retryImmediately();
  }

  // ---- rooms coalesced emit -----------------------------------------------

  private markRoomsDirty(): void {
    if (this.roomsFlushQueued) return;
    this.roomsFlushQueued = true;
    queueMicrotask(() => {
      this.roomsFlushQueued = false;
      this.emitter.emit('rooms', undefined);
    });
  }

  /** RoomEvent.Timeline fires once per event added, which during an initial
   *  sync of several rooms is a lot of individual events — coalesce per
   *  roomId into one 'timeline' emit per microtask, same as 'rooms'. */
  private emitTimelineDirty(roomId: string): void {
    this.timelineDirty.add(roomId);
    if (this.timelineFlushQueued) return;
    this.timelineFlushQueued = true;
    queueMicrotask(() => {
      this.timelineFlushQueued = false;
      const ids = Array.from(this.timelineDirty);
      this.timelineDirty.clear();
      for (const id of ids) this.emitter.emit('timeline', id);
    });
  }

  // ---- notifications -------------------------------------------------------

  /**
   * Turn one live event into a notification candidate, or drop it.
   *
   * The dispatch order at the top is the file header's rule, and it is
   * load-bearing for the same reason `classify()` needs it: on a decryption
   * failure the SDK installs a synthetic clear event that reports type
   * `m.room.message` with its own `** Unable to decrypt: … **` string as the
   * body. Reading `getType()`/`getContent()` first would notify "Alice sent a
   * message" for something nobody can read, and — with the message-text
   * preference on — would put the SDK's internal error text in an OS
   * notification.
   *
   * An event that is still ciphertext is parked in `awaitingDecrypt` instead,
   * and comes back through `MatrixEventEvent.Decrypted`. A permanent failure is
   * dropped: push rules cannot be evaluated against a body nobody can read, so
   * we cannot tell a muted room from a mention, and guessing in either
   * direction is worse than the unread badge the room list already shows.
   *
   * "Still ciphertext" is deliberately NOT `isBeingDecrypted()`: sync maps a
   * joined room's timeline events with `decrypt: false`
   * (`sync.ts` -> `mapSyncEventsFormat(joinObj.timeline, room, false)`) and only
   * kicks decryption off in `room.decryptCriticalEvents()`, which runs *after*
   * `injectRoomEvents` has already emitted `RoomEvent.Timeline`. A live message
   * in an encrypted room therefore arrives here with no decryption started at
   * all — not decrypted, not being decrypted, not a failure — and gating on
   * `isBeingDecrypted()` alone dropped it at the `m.room.message` check below
   * and never re-considered it on `Decrypted`, silencing every encrypted room.
   */
  private considerNotify(ev: MatrixEvent, room: Room | undefined, recalculate: boolean): void {
    const client = this.client;
    if (!client || !room) return;
    // The initial sync replays every room's recent history as live events.
    if (!this.everPrepared) return;

    // Dispatch order as in `classify()`: never on `getType()` first. `getType()`
    // reports the *clear* type once an event is decrypted, so it still reading
    // `m.room.encrypted` is what "nobody has read this yet" looks like —
    // whether decryption is in flight or has not been started. A permanent
    // failure never reaches it: the SDK's synthetic clear event reports
    // `m.room.message`, and the check below catches it.
    if (ev.isBeingDecrypted() || ev.getType() === sdk.EventType.RoomMessageEncrypted) {
      const id = ev.getId();
      // Bounded for the same reason the notifier's dedupe set is: an event that
      // never decrypts must not pin an entry here forever.
      if (id && this.awaitingDecrypt.size < 500) this.awaitingDecrypt.add(id);
      return;
    }
    if (ev.isDecryptionFailure()) return;

    const eventId = ev.getId();
    const sender = ev.getSender();
    if (!eventId || !sender) return;
    // Your own message, echoed back by /sync.
    if (sender === this.userId) return;
    if (ev.getType() !== sdk.EventType.RoomMessage) return;
    if (ev.isRedacted()) return;
    // A room you have left (or only been invited to) keeps its timeline; an
    // invite is the room list's business, not a notification's.
    if (room.getMyMembership() !== 'join') return;

    // The homeserver's own verdict, which already encodes mutes, keyword rules
    // and per-room overrides set in any client. We only ever narrow it.
    const actions = client.getPushActionsForEvent(ev, recalculate);
    if (actions?.notify !== true) return;

    const content = ev.getContent() as { msgtype?: unknown; body?: unknown };
    const kind: NotifyKind = notifyKindOf(content.msgtype);
    const ownEvent = room.currentState.getStateEvents(sdk.EventType.RoomMember, this.userId);
    const ownContent = (ownEvent?.getContent() as { is_direct?: boolean } | undefined) ?? undefined;

    this.notifier.consider({
      eventId,
      roomId: room.roomId,
      roomName: room.name,
      isDm: this.isDirectRoom(room, ownContent),
      senderName: room.getMember(sender)?.name ?? sender,
      pushNotify: true,
      isHighlight: actions.tweaks?.highlight === true,
      preview: typeof content.body === 'string' ? content.body : '',
      kind,
    });
  }

  // ---- decryption classification (see file header) -----------------------

  private decryptErrorFor(ev: MatrixEvent): MxDecryptError {
    return this.cryptoFacade?.decryptErrorFor(ev) ?? GENERIC_DECRYPT_ERROR;
  }

  /** Dispatch order is load-bearing — never reorder, never dispatch on
   *  getType() first. Returns null only for non-renderable *state* events
   *  (membership, topic, power levels, …); every m.room.message and every
   *  m.room.encrypted always produces a row. */
  private classify(ev: MatrixEvent): MxEvent | null {
    if (ev.isBeingDecrypted()) {
      return this.toMxEvent(ev, { type: 'm.room.encrypted', decrypting: true });
    }
    if (ev.isDecryptionFailure()) {
      return this.toMxEvent(ev, { type: 'm.room.encrypted', decryptError: this.decryptErrorFor(ev) });
    }
    const content = ev.getContent() as { msgtype?: unknown };
    if (content?.msgtype === 'm.bad.encrypted') {
      return this.toMxEvent(ev, { type: 'm.room.encrypted', decryptError: this.decryptErrorFor(ev) });
    }
    const type = ev.getType();
    if (type === 'm.room.message') return this.toMxEvent(ev, {});
    if (type === 'm.room.encrypted') {
      // Still-encrypted and none of the predicates above caught it — treat
      // as mid-decryption rather than ever render a blank row.
      return this.toMxEvent(ev, { type: 'm.room.encrypted', decrypting: true });
    }
    return null;
  }

  private toMxEvent(ev: MatrixEvent, extra: { type?: string; decrypting?: true; decryptError?: MxDecryptError }): MxEvent {
    const status = ev.status;
    let echo: 'pending' | 'failed' | undefined;
    let txnId: string | undefined;
    if (status !== null) {
      switch (status) {
        case EventStatus.QUEUED:
        case EventStatus.SENDING:
        case EventStatus.ENCRYPTING:
        case EventStatus.SENT:
          echo = 'pending';
          txnId = ev.getTxnId();
          break;
        case EventStatus.NOT_SENT:
          echo = 'failed';
          txnId = ev.getTxnId();
          break;
        case EventStatus.CANCELLED:
          // Callers (timeline()/toPublicRoom()) filter CANCELLED out before
          // it reaches classify(), so this case is unreachable in practice.
          break;
        default: {
          const exhaustive: never = status;
          void exhaustive;
        }
      }
    }
    const type = extra.type ?? 'm.room.message';
    const readable = type === 'm.room.message' && !extra.decrypting && !extra.decryptError;
    const unsigned = ev.getUnsigned();
    const mxUnsigned: MxEventUnsigned | undefined = unsigned
      ? { transaction_id: unsigned.transaction_id, redacted_because: unsigned.redacted_because, age: unsigned.age }
      : undefined;
    // A redaction of ours that hasn't been acknowledged yet counts: the SDK has
    // already emptied the event's content, so treating it as a normal message
    // would draw an empty row until the server echoes the redaction back.
    const redacted = ev.isRedacted() || ev.localRedactionEvent() !== null;
    let content = readable ? (ev.getContent() as Record<string, unknown>) : {};
    if (readable && replyTargetId(ev) !== undefined && typeof content.body === 'string') {
      // Copied, never mutated in place: this object is the SDK's own content.
      const body = stripReplyFallback(content.body);
      if (body !== content.body) content = { ...content, body };
    }
    return {
      event_id: ev.getId() ?? '',
      type,
      sender: ev.getSender() ?? '',
      origin_server_ts: ev.getTs(),
      content,
      unsigned: mxUnsigned,
      txnId,
      echo,
      decrypting: extra.decrypting,
      decryptError: extra.decryptError,
      redacted: redacted ? true : undefined,
    };
  }

  private previewText(ev: MxEvent): string {
    if (ev.redacted) return '(message deleted)';
    if (ev.decrypting || ev.decryptError) return '🔒 Encrypted message';
    const body = ev.content?.body;
    // An attachment's body is its filename, which on its own reads like someone
    // sent the word "screenshot.png".
    const msgtype = ev.content?.msgtype;
    if (msgtype === 'm.image') return typeof body === 'string' && body ? `🖼 ${body}` : '🖼 Picture';
    if (msgtype === 'm.file' || msgtype === 'm.audio' || msgtype === 'm.video') {
      return typeof body === 'string' && body ? `📎 ${body}` : '📎 File';
    }
    if (typeof body !== 'string' || !body) return '';
    const oneLine = body.replace(/\s+/g, ' ').trim();
    return oneLine.length > 80 ? `${oneLine.slice(0, 80)}…` : oneLine;
  }

  // ---- room model / projection --------------------------------------------

  private isDirectRoom(room: Room, ownContent: { is_direct?: boolean } | undefined): boolean {
    const client = this.client;
    if (client) {
      const directEvent = client.getAccountData(sdk.EventType.Direct);
      const map = (directEvent?.getContent() as Record<string, string[]> | undefined) ?? {};
      for (const ids of Object.values(map)) {
        if (Array.isArray(ids) && ids.includes(room.roomId)) return true;
      }
    }
    if (ownContent?.is_direct === true) return true;
    return room.getJoinedMemberCount() + room.getInvitedMemberCount() <= 2;
  }

  private toPublicRoom(room: Room): MxRoom {
    const membership = toMxMembership(room.getMyMembership() ?? 'leave');
    const ownEvent = room.currentState.getStateEvents(sdk.EventType.RoomMember, this.userId);
    const ownContent = (ownEvent?.getContent() as { is_direct?: boolean } | undefined) ?? undefined;
    const inviterId = membership === 'invite' ? ownEvent?.getSender() ?? '' : '';
    const inviteIsDirect = membership === 'invite' && ownContent?.is_direct === true;

    let lastTs = 0;
    let preview = '';
    const live = room.getLiveTimeline().getEvents();
    for (let i = live.length - 1; i >= 0; i--) {
      const ev = live[i];
      if (ev.status === EventStatus.CANCELLED) continue;
      // An edit is not the room's newest message — the message it rewrites is,
      // and that one already reads back as the edited text.
      if (isEditRelation(ev)) continue;
      const mapped = this.classify(ev);
      if (!mapped) continue;
      lastTs = mapped.origin_server_ts;
      preview = this.previewText(mapped);
      break;
    }

    // Threads are not in that window, and leaving them out is not neutral: a
    // room whose whole conversation has moved into a thread would sit at the
    // bottom of the list, previewing a message from yesterday, with no badge —
    // which is precisely the regression turning `threadSupport` on would
    // otherwise introduce, since every one of those replies used to render
    // inline. So the newest thread reply competes for the preview, marked as
    // one, and thread notification counts are added to the room's own. Reading
    // the room does not clear a thread's count, so the badge correctly stays up
    // until the thread itself has been read.
    const threadCounts = this.threadUnread(room);
    // Only the winner is classified: `rooms()` runs this for every room on every
    // sync tick, and mapping every thread's last reply just to throw all but one
    // away is work per thread per tick for a string nobody reads.
    let newestThreadReply: MatrixEvent | null = null;
    for (const thread of room.getThreads()) {
      const last = thread.replyToEvent;
      if (!last || last.getId() === thread.id || last.status === EventStatus.CANCELLED) continue;
      if (last.getTs() <= lastTs) continue;
      if (!newestThreadReply || last.getTs() > newestThreadReply.getTs()) newestThreadReply = last;
    }
    if (newestThreadReply) {
      const mapped = this.classify(newestThreadReply);
      if (mapped) {
        lastTs = mapped.origin_server_ts;
        preview = `🧵 ${this.previewText(mapped)}`;
      }
    }

    return {
      roomId: room.roomId,
      membership,
      name: room.name,
      isDirect: this.isDirectRoom(room, ownContent),
      encrypted: room.hasEncryptionStateEvent(),
      joinedCount: room.getJoinedMemberCount(),
      invitedCount: room.getInvitedMemberCount(),
      unread: room.getUnreadNotificationCount(sdk.NotificationCountType.Total) + threadCounts.unread,
      highlight:
        room.getUnreadNotificationCount(sdk.NotificationCountType.Highlight) + threadCounts.highlight,
      lastTs,
      preview,
      inviterId,
      inviteIsDirect,
      avatarMxc: this.roomAvatarMxc(room),
    };
  }

  /** A room's own picture, or for a two-person room without one, the other
   *  member's — which is what makes a DM list look like a list of people
   *  rather than a column of identical initials. `getAvatarFallbackMember()`
   *  is the SDK's own "the other person" resolution (it returns nothing once a
   *  room has more than two members, which is exactly when a per-person
   *  picture would be misleading). */
  private roomAvatarMxc(room: Room): string | null {
    const own = room.getMxcAvatarUrl();
    if (own) return own;
    return room.getAvatarFallbackMember()?.getMxcAvatarUrl() ?? null;
  }

  rooms(): MxRoom[] {
    if (!this.client) return [];
    const list = this.client
      .getRooms()
      .map((r) => this.toPublicRoom(r))
      // A left room stays in the SDK store until forgotten; the room list
      // has never shown these (matching the previous hand-rolled client).
      .filter((r) => r.membership !== 'leave');
    list.sort((a, b) => {
      const aUnread = a.unread > 0 ? 1 : 0;
      const bUnread = b.unread > 0 ? 1 : 0;
      if (aUnread !== bUnread) return bUnread - aUnread;
      if (a.lastTs === 0 && b.lastTs === 0) return a.roomId < b.roomId ? -1 : a.roomId > b.roomId ? 1 : 0;
      if (a.lastTs === 0) return 1;
      if (b.lastTs === 0) return -1;
      return b.lastTs - a.lastTs;
    });
    return list;
  }

  room(roomId: string): MxRoom | undefined {
    const room = this.client?.getRoom(roomId);
    return room ? this.toPublicRoom(room) : undefined;
  }

  totalUnread(): number {
    let n = 0;
    for (const r of this.rooms()) n += r.unread;
    return n;
  }

  /**
   * Who has read what, as `eventId -> readers`, for the timeline gutter.
   *
   * Matrix gives each user one read receipt per room, so `getEventReadUpTo`
   * already answers "the newest event this member has read" — grouping those by
   * event id puts each reader's picture on exactly one row, which is the
   * behaviour Element shows and what the feature is asking for. No per-message
   * state is kept anywhere.
   *
   * Ourselves excluded: our own read marker is always on the newest message we
   * can see (the store sends it — see markRead), so drawing it would put our
   * own face on every message we send the moment we look at it.
   *
   * A receipt can point at an event outside the loaded window (a member read
   * something we have since trimmed, or never paginated to). Those are returned
   * anyway and the view simply finds no row for them — better than this method
   * pretending to know what the view has on screen.
   */
  readReceipts(roomId: string): Map<string, MxReader[]> {
    const out = new Map<string, MxReader[]>();
    const room = this.client?.getRoom(roomId);
    if (!room) return out;
    for (const member of room.getJoinedMembers()) {
      if (member.userId === this.userId) continue;
      const eventId = room.getEventReadUpTo(member.userId);
      if (!eventId) continue;
      const reader: MxReader = {
        userId: member.userId,
        displayName: member.name,
        avatarMxc: member.getMxcAvatarUrl() ?? null,
      };
      const list = out.get(eventId);
      if (list) list.push(reader);
      else out.set(eventId, [reader]);
    }
    // Stable order, so a re-render never shuffles the pictures on a row.
    for (const list of out.values()) list.sort((a, b) => a.userId.localeCompare(b.userId));
    return out;
  }

  /** Display names of the *other* members typing in a room right now, for the
   *  strip under the timeline. Recomputed from the SDK's member flags on every
   *  call rather than cached, so an expiry the SDK applied silently (it fires
   *  RoomMemberEvent.Typing for those too) can never leave a stale name up. */
  typingIn(roomId: string): string[] {
    const room = this.client?.getRoom(roomId);
    if (!room) return [];
    return room
      .getMembers()
      .filter((m) => m.typing && m.userId !== this.userId)
      .map((m) => m.name);
  }

  displayName(roomId: string, userId: string): string {
    const room = this.client?.getRoom(roomId);
    return room?.getMember(userId)?.name ?? userId;
  }

  /** A sender's picture *as of this room's member state* — the per-room
   *  companion to `displayName`. Room-scoped on purpose: a user's avatar is
   *  part of their membership event, so someone who changed their picture
   *  since joining still shows the one this room knows about, which is what
   *  every other client shows too. */
  memberAvatarMxc(roomId: string, userId: string): string | null {
    const room = this.client?.getRoom(roomId);
    return room?.getMember(userId)?.getMxcAvatarUrl() ?? null;
  }

  /** Our own picture, for the panel's status strip. Three sources in order of
   *  freshness: what we just set ourselves (the profile round-trip through
   *  /sync takes a moment), the User object (populated from presence, which
   *  some homeservers never send), and finally our own membership in any
   *  joined room — the one place an avatar we set is guaranteed to appear. */
  get myAvatarMxc(): string | null {
    const client = this.client;
    if (!client) return null;
    if (this.myAvatarOverride_) return this.myAvatarOverride_;
    const id = client.getUserId();
    if (!id) return null;
    const fromUser = client.getUser(id)?.avatarUrl;
    if (fromUser) return fromUser;
    for (const room of client.getRooms()) {
      const mine = room.getMember(id)?.getMxcAvatarUrl();
      if (mine) return mine;
    }
    return null;
  }

  /** Upload a picture and make it this account's profile picture. Unencrypted
   *  by definition — a profile avatar is public state that every homeserver in
   *  a room has to be able to fetch, so there is no `EncryptedFile` path and
   *  no expectation of privacy here. Rejects with a display-ready message. */
  async setMyAvatar(file: File): Promise<void> {
    const client = this.client;
    const media = this.media_;
    if (!client || !media) throw new MatrixError(0, '', 'Not connected.');
    const content = await media.uploadImage({ file, encrypt: false });
    if (!content.url) throw new MatrixError(0, '', 'The homeserver did not return an address for that picture.');
    try {
      await client.setAvatarUrl(content.url);
    } catch (err) {
      throw MatrixError.from(err);
    }
    this.myAvatarOverride_ = content.url;
    this.emitter.emit('status', undefined);
    this.markRoomsDirty();
  }

  /** Resolve an mxc:// avatar to a displayable blob URL at `sizePx`, cached
   *  per (uri, size). Rejects rather than returning a placeholder — the UI
   *  keeps its initials square on failure. */
  avatarUrl(mxc: string, sizePx: number): Promise<string> {
    const media = this.media_;
    if (!media) return Promise.reject(new MatrixError(0, '', 'Not connected.'));
    return media.avatarUrl(mxc, sizePx);
  }

  /** The full-size original behind an avatar, for viewing a chat's picture
   *  large. Cached like every other download; refused unless the bytes sniff
   *  as a real raster image (see MatrixMedia.avatarOriginalUrl). */
  avatarOriginalUrl(mxc: string): Promise<string> {
    const media = this.media_;
    if (!media) return Promise.reject(new MatrixError(0, '', 'Not connected.'));
    return media.avatarOriginalUrl(mxc);
  }

  existingDmWith(mxid: string): string | undefined {
    const client = this.client;
    if (!client) return undefined;
    const directEvent = client.getAccountData(sdk.EventType.Direct);
    const map = (directEvent?.getContent() as Record<string, string[]> | undefined) ?? {};
    for (const roomId of map[mxid] ?? []) {
      if (client.getRoom(roomId)) return roomId;
    }
    return undefined;
  }

  // ---- timeline -------------------------------------------------------------

  timeline(roomId: string): MxEvent[] {
    const room = this.client?.getRoom(roomId);
    if (!room) return [];
    const live = room.getLiveTimeline().getEvents();
    // Pending echoes are room-wide (`pendingEventOrdering: Detached`), and the
    // SDK only files an event under its thread once the server echoes it back —
    // so without this filter a reply typed into a thread would appear in the
    // main timeline for as long as the round trip takes, and then jump out of
    // it. The confirmed half needs no filtering: `getLiveTimeline()` already
    // holds only what belongs here.
    const pending = room.getPendingEvents().filter((ev) => !isThreadReply(ev));
    // Reactions first: they are aggregated onto the messages built below, and a
    // reaction can sit anywhere in the window relative to its target.
    const reactions = this.collectReactions(room, [live, pending]);
    const out: MxEvent[] = [];
    for (const ev of live) this.pushClassified(out, room, ev, reactions, null);
    for (const ev of pending) this.pushClassified(out, room, ev, reactions, null);
    return out;
  }

  /**
   * One thread's rows: its replies, and its root once back-pagination has
   * reached it (the SDK appends the root itself when a thread's history runs
   * out — see `paginateEventTimeline`'s thread branch). A thread that has not
   * been paginated to its start therefore opens on its newest replies with
   * "Load earlier messages" above them, exactly like a room.
   *
   * Returns `[]` for a thread this session has never heard of rather than
   * inventing one: `openThread` is what creates it, and a view that renders
   * before that has nothing honest to draw.
   */
  threadTimeline(roomId: string, rootId: string): MxEvent[] {
    const room = this.client?.getRoom(roomId);
    const thread = room?.getThread(rootId);
    if (!room || !thread) return [];
    const events = thread.events;
    const pending = room.getPendingEvents().filter((ev) => ev.threadRootId === rootId);
    // The room's own window is walked too, and it is not belt-and-braces: a
    // reaction to the thread's ROOT is not a thread relation, so the SDK files
    // it in the main timeline (`eventShouldLiveIn`). Reading only the thread's
    // events would drop every chip off the root the moment the thread opened.
    const reactions = this.collectReactions(room, [events, room.getLiveTimeline().getEvents(), pending]);
    const out: MxEvent[] = [];
    for (const ev of events) this.pushClassified(out, room, ev, reactions, thread);
    for (const ev of pending) this.pushClassified(out, room, ev, reactions, thread);
    return out;
  }

  /** `thread` non-null means "this row is being drawn inside that thread", which
   *  is what suppresses the thread summary (you are already in it) and marks the
   *  row `inThread` for `messageActionsFor`. */
  private pushClassified(
    out: MxEvent[],
    room: Room,
    ev: MatrixEvent,
    reactions: Map<string, MxReaction[]>,
    thread: Thread | null,
  ): void {
    if (ev.status === EventStatus.CANCELLED) return;
    // Relations that are not rows of their own: an edit belongs to the message
    // it rewrites, a reaction to the chips under it. (A reaction is dropped by
    // `classify` too — its type isn't a message — but saying so here is what
    // makes the rule readable in one place.)
    if (ev.getType() === sdk.EventType.Reaction || isEditRelation(ev)) return;
    const mapped = this.classify(ev);
    if (!mapped) return;
    this.annotate(room, ev, mapped, reactions, thread);
    out.push(mapped);
  }

  /** Everything a *row* needs beyond the event itself: reactions, the quoted
   *  message, the edited marker and what this session may do to it. Kept out of
   *  `classify` because the room-list projection shares that and needs none of
   *  it. */
  private annotate(
    room: Room,
    ev: MatrixEvent,
    mapped: MxEvent,
    reactions: Map<string, MxReaction[]>,
    thread: Thread | null,
  ): void {
    if (thread) mapped.inThread = true;
    if (mapped.redacted) return; // nothing left to react to, quote, edit or re-delete
    const onThis = reactions.get(mapped.event_id);
    if (onThis) mapped.reactions = onThis;
    // A thread hangs off this message. Only in the main timeline: inside the
    // thread the root is simply its first message, and a "3 replies" summary
    // there would point at the very rows underneath it.
    if (!thread && mapped.event_id) {
      const own = room.getThread(mapped.event_id);
      if (own) mapped.thread = this.threadInfo(room, own);
    }
    const replyId = replyTargetId(ev);
    if (replyId !== undefined) mapped.replyTo = this.replyToOf(room, replyId);
    if (ev.replacingEventId() !== undefined) mapped.edited = true;
    // `maySendRedactionForEvent` covers all of it: membership, the
    // m.room.redaction power level, "mine or I outrank you", and refusing a
    // still-pending event. Hiding the control is UX — the homeserver is the gate.
    if (mapped.event_id && room.currentState.maySendRedactionForEvent(ev, this.userId)) {
      mapped.canRedact = true;
    }
    const msgtype = typeof mapped.content.msgtype === 'string' ? mapped.content.msgtype : 'm.text';
    if (
      mapped.event_id &&
      ev.status === null &&
      mapped.sender === this.userId &&
      !mapped.decrypting &&
      !mapped.decryptError &&
      EDITABLE_MSGTYPES.has(msgtype)
    ) {
      mapped.canEdit = true;
    }
  }

  /**
   * Fold every `m.reaction` in the loaded window onto its target, as
   * `eventId -> [{key, count, mine, …}]`.
   *
   * Aggregated from the events themselves rather than through the SDK's
   * `Relations` container: that one aggregates asynchronously (it awaits the
   * target event, and decryption), so a render triggered by the very sync tick
   * that delivered a reaction can miss it. Reading the window we are already
   * walking is synchronous, includes our own not-yet-sent reaction from
   * `getPendingEvents()`, and de-duplicates a local echo against its remote
   * copy for free, because senders are keyed.
   *
   * The cost of this choice: a reaction whose event has not been paginated to is
   * invisible, even if the homeserver bundled it into the message's unsigned
   * aggregations. In practice a reaction arrives within a page of the message it
   * is on, so back-pagination brings both — the same behaviour Element has.
   *
   * Takes the windows to walk rather than a room, because with threads there is
   * more than one: a thread's replies live in its own timeline while a reaction
   * to the thread's root lives in the room's. A sender appearing in two of the
   * lists is folded once — the map is keyed by (target, key, sender).
   */
  private collectReactions(room: Room, windows: Iterable<MatrixEvent[]>): Map<string, MxReaction[]> {
    // target -> key -> sender -> reaction event id ('' while a local echo)
    const bySender = new Map<string, Map<string, Map<string, string>>>();
    const visit = (ev: MatrixEvent): void => {
      if (ev.getType() !== sdk.EventType.Reaction) return;
      if (ev.status === EventStatus.CANCELLED || ev.isRedacted() || ev.localRedactionEvent() !== null) return;
      const rel = relationOf(ev);
      if (rel?.rel_type !== 'm.annotation') return;
      const target = rel.event_id;
      const key = rel.key;
      const sender = ev.getSender();
      if (!target || !key || !sender) return;
      let keys = bySender.get(target);
      if (!keys) {
        keys = new Map();
        bySender.set(target, keys);
      }
      let senders = keys.get(key);
      if (!senders) {
        senders = new Map();
        keys.set(key, senders);
      }
      // A confirmed reaction wins over a local echo of the same (sender, key).
      const id = ev.status === null ? ev.getId() ?? '' : '';
      if (id || !senders.has(sender)) senders.set(sender, id);
    };
    for (const window of windows) for (const ev of window) visit(ev);

    const out = new Map<string, MxReaction[]>();
    for (const [target, keys] of bySender) {
      const list: MxReaction[] = [];
      for (const [key, senders] of keys) {
        list.push({
          key,
          count: senders.size,
          mine: senders.has(this.userId),
          myEventId: senders.get(this.userId) ?? '',
          senderNames: Array.from(senders.keys()).map((id) => room.getMember(id)?.name ?? id),
        });
      }
      out.set(target, list);
    }
    return out;
  }

  /** The quote line above a reply. A target outside the loaded window is
   *  reported as `missing` rather than guessed at or fetched — the row says so,
   *  which is honest and costs no request per reply. */
  private replyToOf(room: Room, eventId: string): MxReplyTo {
    // `Room.findEventById` searches every timeline set the room owns, threads
    // included, so a reply *inside* a thread resolves its quote without this
    // method needing to know which timeline it is being called for.
    const target = room.findEventById(eventId);
    if (!target) return { eventId, sender: '', senderName: '', text: '', missing: true };
    const sender = target.getSender() ?? '';
    const mapped = this.classify(target);
    return {
      eventId,
      sender,
      senderName: room.getMember(sender)?.name ?? sender,
      text: mapped ? this.previewText(mapped) : '',
      missing: false,
    };
  }

  atStart(roomId: string): boolean {
    const room = this.client?.getRoom(roomId);
    if (!room) return false;
    return room.getLiveTimeline().getPaginationToken(sdk.EventTimeline.BACKWARDS) === null;
  }

  loadingTimeline(roomId: string): boolean {
    return this.loadingRooms.get(roomId) ?? false;
  }

  timelineError(roomId: string): string {
    return this.roomErrors.get(roomId) ?? '';
  }

  async openRoom(roomId: string): Promise<void> {
    // Switching rooms with a typing advertisement still standing in the old
    // one (rail click mid-draft) would otherwise leave it up for the full
    // server timeout.
    if (this.typingSentRoom && this.typingSentRoom !== roomId) {
      this.notifyTyping(this.typingSentRoom, false);
    }
    this.openRoomId = roomId;
    const room = this.client?.getRoom(roomId);
    if (!room) return;
    const live = room.getLiveTimeline();
    const hasMore = live.getPaginationToken(sdk.EventTimeline.BACKWARDS) !== null;
    if (hasMore && live.getEvents().length <= 1 && !this.loadingRooms.get(roomId)) {
      await this.paginate(roomId);
    }
  }

  closeRoom(): void {
    if (this.typingSentRoom) this.notifyTyping(this.typingSentRoom, false);
    this.openRoomId = null;
  }

  /**
   * Advertise (or withdraw) our own typing state in a room, fire-and-forget.
   *
   * Called from the composer on every keystroke and coalesced here rather
   * than there: `true` goes to the homeserver at most once per
   * TYPING_REFRESH_MS while the advertisement it refreshes is still standing,
   * `false` only when one stands to withdraw. Failures are swallowed — a lost
   * typing notice costs nothing, and the server-side timeout is the backstop
   * for a `false` that never arrives.
   */
  notifyTyping(roomId: string, typing: boolean): void {
    const client = this.client;
    if (!client) return;
    if (typing) {
      // Re-read per call rather than cached, so flipping the setting takes
      // effect on the next keystroke. An advertisement already standing when
      // it turns off is left to its server-side timeout — `false` below still
      // withdraws on send/close, which never reveals anything new.
      if (!readNotifyPrefs().sendTyping) return;
      const now = Date.now();
      if (this.typingSentRoom === roomId && now - this.typingSentAt < TYPING_REFRESH_MS) return;
      this.typingSentRoom = roomId;
      this.typingSentAt = now;
      void client.sendTyping(roomId, true, TYPING_TIMEOUT_MS).catch(() => {});
    } else {
      if (this.typingSentRoom !== roomId) return;
      this.typingSentRoom = null;
      this.typingSentAt = 0;
      void client.sendTyping(roomId, false, 0).catch(() => {});
    }
  }

  async paginate(roomId: string): Promise<void> {
    const client = this.client;
    const room = client?.getRoom(roomId);
    if (!client || !room || this.loadingRooms.get(roomId)) return;
    const live = room.getLiveTimeline();
    if (live.getPaginationToken(sdk.EventTimeline.BACKWARDS) === null) return;
    this.loadingRooms.set(roomId, true);
    this.roomErrors.set(roomId, '');
    this.emitter.emit('timeline', roomId);
    try {
      await client.paginateEventTimeline(live, { backwards: true, limit: PAGINATE_LIMIT });
    } catch (err) {
      this.roomErrors.set(roomId, MatrixError.from(err).message);
    } finally {
      this.loadingRooms.set(roomId, false);
      this.emitter.emit('timeline', roomId);
    }
  }

  markRead(roomId: string): void {
    const room = this.client?.getRoom(roomId);
    if (!room) return;
    const live = room.getLiveTimeline().getEvents();
    this.sendReadUpTo(roomId, roomId, live[live.length - 1]);
  }

  /**
   * The same for one thread. A thread carries its own read receipt and its own
   * notification count, so reading the room does not clear a thread and vice
   * versa — which is the whole reason a thread can sit unread under a room with
   * no badge on it.
   *
   * The receipt's `thread_id` is the SDK's to fill in (`sendReadReceipt` derives
   * it from the event), so this differs from `markRead` only in which event it
   * points at. The debounce is keyed by thread id, which cannot collide with a
   * room id: one starts `!`, the other `$`.
   */
  markThreadRead(roomId: string, rootId: string): void {
    const thread = this.client?.getRoom(roomId)?.getThread(rootId);
    if (!thread) return;
    const events = thread.events;
    this.sendReadUpTo(roomId, rootId, events[events.length - 1]);
  }

  /** Debounced "I have read up to this event". `key` is what the debounce and
   *  the dedupe are keyed by — a room id for the main timeline, a thread id for
   *  a thread — so the two can never cancel each other's timer. */
  private sendReadUpTo(roomId: string, key: string, last: MatrixEvent | undefined): void {
    const client = this.client;
    const lastEventId = last?.getId();
    if (!client || !last || !lastEventId) return;
    const existing = this.readTimers.get(key);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => {
      this.readTimers.delete(key);
      if (this.lastSentRead.get(key) === lastEventId) return;
      this.lastSentRead.set(key, lastEventId);
      void client.sendReadReceipt(last).catch(() => {});
      // The fully-read marker is a room-level concept only — there is no
      // per-thread m.fully_read — so a thread moves the receipt and nothing
      // else.
      if (key === roomId) void client.setRoomReadMarkers(roomId, lastEventId).catch(() => {});
    }, READ_DEBOUNCE_MS);
    this.readTimers.set(key, timer);
  }

  // ---- threads ---------------------------------------------------------------

  /**
   * A thread as the main timeline's summary chip and the threads list draw it.
   *
   * `count` comes from the SDK's own bookkeeping, which prefers the
   * homeserver's bundled `m.thread` aggregation over what we happen to have
   * loaded — so a root that arrived on the first sync already says "12 replies"
   * without a single one of them being fetched. The last-reply fields are the
   * opposite: they are only what we can see, so they stay empty until the
   * thread has been opened at least once. Saying "12 replies" with no preview is
   * honest; inventing a preview would not be.
   */
  private threadInfo(room: Room, thread: Thread): MxThreadInfo {
    const nameOf = (userId: string | undefined): string =>
      userId ? room.getMember(userId)?.name ?? userId : '';
    const rootEv = thread.rootEvent;
    const rootMapped = rootEv ? this.classify(rootEv) : null;
    // `replyToEvent` falls back to the root when a thread's every reply has been
    // redacted, which would otherwise print the root twice.
    const last = thread.replyToEvent;
    const lastMapped = last && last.getId() !== thread.id ? this.classify(last) : null;
    return {
      rootId: thread.id,
      count: thread.length,
      rootPreview: rootMapped ? this.previewText(rootMapped) : '',
      rootSenderName: nameOf(rootEv?.getSender()),
      lastTs: lastMapped ? lastMapped.origin_server_ts : 0,
      lastSenderName: lastMapped ? nameOf(lastMapped.sender) : '',
      lastPreview: lastMapped ? this.previewText(lastMapped) : '',
      participated: thread.hasCurrentUserParticipated,
      unread: room.getThreadUnreadNotificationCount(thread.id, sdk.NotificationCountType.Total),
      highlight: room.getThreadUnreadNotificationCount(thread.id, sdk.NotificationCountType.Highlight),
    };
  }

  /** Every thread this session knows about in a room, newest activity first.
   *  Unread ones come first for the same reason rooms do — a badge you have to
   *  scroll to find is a badge that gets missed. */
  threads(roomId: string): MxThreadInfo[] {
    const room = this.client?.getRoom(roomId);
    if (!room) return [];
    const list = room.getThreads().map((t) => this.threadInfo(room, t));
    list.sort((a, b) => {
      const au = a.unread > 0 ? 1 : 0;
      const bu = b.unread > 0 ? 1 : 0;
      if (au !== bu) return bu - au;
      return b.lastTs - a.lastTs;
    });
    return list;
  }

  /**
   * What every thread in a room adds up to, unread-wise.
   *
   * Counters only — no event mapping, no previews — because the room header
   * repaints on every sync tick and asks this each time. `threads()` is the one
   * that builds summaries, and only the threads LIST calls it.
   */
  threadUnread(roomOrId: Room | string): { unread: number; highlight: number } {
    const room = typeof roomOrId === 'string' ? this.client?.getRoom(roomOrId) : roomOrId;
    let unread = 0;
    let highlight = 0;
    if (!room) return { unread, highlight };
    for (const thread of room.getThreads()) {
      unread += room.getThreadUnreadNotificationCount(thread.id, sdk.NotificationCountType.Total);
      highlight += room.getThreadUnreadNotificationCount(
        thread.id,
        sdk.NotificationCountType.Highlight,
      );
    }
    return { unread, highlight };
  }

  /**
   * Ask the homeserver for this room's threads, so the list is not limited to
   * the threads that happen to have touched the loaded window.
   *
   * Once per room per session (`threadsFetchedRoom`): the list keeps itself
   * current from sync afterwards, and re-asking on every repaint would be a
   * request per keystroke in a room with an open list. A refusal is remembered
   * as text rather than retried — the list still shows what sync has delivered.
   */
  async loadThreads(roomId: string): Promise<void> {
    const room = this.client?.getRoom(roomId);
    if (!room || this.threadsLoading || this.threadsFetchedRoom === roomId) return;
    this.threadsLoading = true;
    this.threadsErrorText = '';
    this.emitter.emit('timeline', roomId);
    try {
      // The timeline sets have to exist before the fetch: with server-side list
      // support (MSC3856) `fetchRoomThreads` fills them, and with none it falls
      // back to a filtered /messages sweep that needs no sets at all.
      await room.createThreadsTimelineSets();
      await room.fetchRoomThreads();
      this.threadsFetchedRoom = roomId;
    } catch (err) {
      this.threadsErrorText = MatrixError.from(err).message;
    } finally {
      this.threadsLoading = false;
      this.emitter.emit('timeline', roomId);
    }
  }

  loadingThreads(): boolean {
    return this.threadsLoading;
  }

  threadsError(): string {
    return this.threadsErrorText;
  }

  /**
   * Open a thread: make sure the SDK has one for this root, and fill it.
   *
   * A thread the SDK has never built (its root is in the window but nothing has
   * replied within it yet, or we are starting one from the ⋯ menu) is created
   * here — that is what makes "Reply in thread" on any message work at all.
   * `Room.createThread` returns the existing thread when there is one, so this
   * is idempotent.
   */
  async openThread(roomId: string, rootId: string): Promise<void> {
    const client = this.client;
    const room = client?.getRoom(roomId);
    if (!client || !room) return;
    this.openThreadId = rootId;
    this.threadErrorText = '';
    let thread = room.getThread(rootId);
    if (!thread) {
      const rootEvent = room.findEventById(rootId);
      // Without the root event there is nothing to hang a thread on and no
      // first row to draw; the caller shows this text instead.
      if (!rootEvent) {
        this.threadErrorText = "That message isn't loaded any more.";
        this.emitter.emit('timeline', roomId);
        return;
      }
      thread = room.createThread(rootId, rootEvent, [], false);
    }
    const live = thread.liveTimeline;
    const hasMore = live.getPaginationToken(sdk.EventTimeline.BACKWARDS) !== null;
    if (hasMore && live.getEvents().length <= 1) await this.paginateThread(roomId, rootId);
    else this.emitter.emit('timeline', roomId);
  }

  closeThread(): void {
    this.openThreadId = null;
    this.threadLoading = false;
    this.threadErrorText = '';
  }

  /** Older replies in the open thread. Mirrors `paginate` exactly, down to the
   *  two emits that bracket the request, so the timeline's "Loading…" and its
   *  retry link behave identically in both. */
  async paginateThread(roomId: string, rootId: string): Promise<void> {
    const client = this.client;
    const thread = client?.getRoom(roomId)?.getThread(rootId);
    if (!client || !thread || this.threadLoading) return;
    const live = thread.liveTimeline;
    if (live.getPaginationToken(sdk.EventTimeline.BACKWARDS) === null) return;
    this.threadLoading = true;
    this.threadErrorText = '';
    this.emitter.emit('timeline', roomId);
    try {
      await client.paginateEventTimeline(live, { backwards: true, limit: PAGINATE_LIMIT });
    } catch (err) {
      this.threadErrorText = MatrixError.from(err).message;
    } finally {
      this.threadLoading = false;
      this.emitter.emit('timeline', roomId);
    }
  }

  atThreadStart(roomId: string, rootId: string): boolean {
    const thread = this.client?.getRoom(roomId)?.getThread(rootId);
    if (!thread) return false;
    return thread.liveTimeline.getPaginationToken(sdk.EventTimeline.BACKWARDS) === null;
  }

  loadingThread(rootId: string): boolean {
    return this.threadLoading && this.openThreadId === rootId;
  }

  threadError(rootId: string): string {
    return this.openThreadId === rootId ? this.threadErrorText : '';
  }

  /** Who has read what *within a thread* — the thread-scoped twin of
   *  `readReceipts`, and not derivable from it: a member reading the room says
   *  nothing about whether they have read this thread. */
  threadReadReceipts(roomId: string, rootId: string): Map<string, MxReader[]> {
    const out = new Map<string, MxReader[]>();
    const room = this.client?.getRoom(roomId);
    const thread = room?.getThread(rootId);
    if (!room || !thread) return out;
    for (const member of room.getJoinedMembers()) {
      if (member.userId === this.userId) continue;
      const eventId = thread.getEventReadUpTo(member.userId);
      if (!eventId) continue;
      const list = out.get(eventId);
      const reader: MxReader = {
        userId: member.userId,
        displayName: member.name,
        avatarMxc: member.getMxcAvatarUrl() ?? null,
      };
      if (list) list.push(reader);
      else out.set(eventId, [reader]);
    }
    for (const list of out.values()) list.sort((a, b) => a.userId.localeCompare(b.userId));
    return out;
  }

  // ---- send / echo ---------------------------------------------------------

  /**
   * Send a message, optionally as a reply to `replyToEventId`.
   *
   * No rich-reply *fallback* is generated (the `> <@alice> …` body prefix and
   * the `<mx-reply>` block): the spec deprecated it in favour of the relation
   * alone, and every reply-aware client — which is all of them — draws the
   * quote from `m.in_reply_to`. Incoming fallbacks are still stripped on the way
   * in (see `stripReplyFallback`), because plenty of clients still send them.
   */
  async send(roomId: string, body: string, replyToEventId?: string, threadId?: string): Promise<void> {
    const client = this.client;
    if (!client) return;
    // The message itself supersedes the advertisement; without this it would
    // sit there for the rest of its timeout after the bubble already landed.
    this.notifyTyping(roomId, false);
    // `body` stays the user's literal text — it is what every client without an
    // HTML renderer shows, so it must never become the generated markup.
    const content: Record<string, unknown> = { msgtype: 'm.text', body };
    const formatted = toHtml(body);
    if (formatted) {
      content.format = 'org.matrix.custom.html';
      content.formatted_body = formatted;
    }
    if (replyToEventId) {
      content['m.relates_to'] = { 'm.in_reply_to': { event_id: replyToEventId } };
    }
    try {
      // The thread relation itself is the SDK's to write (`sendMessage`'s
      // threadId overload → `addThreadRelationIfNeeded`), and deliberately so:
      // it is the half with the fiddly rules — `rel_type`/`event_id`, plus the
      // `m.in_reply_to` fallback pointing at the thread's newest reply with
      // `is_falling_back: true`, which is how a client with no thread support
      // still renders the message as a reply rather than as an orphan. Writing
      // it here as well would collide with that.
      await client.sendMessage(roomId, threadId ?? null, content as unknown as RoomMessageEventContent);
    } catch {
      // failure surfaces as the .failed local-echo row (EventStatus.NOT_SENT)
    }
  }

  /**
   * Replace an earlier message of ours with `body`.
   *
   * The top-level `body`/`formatted_body` carry the spec's `* new text`
   * fallback, for clients that don't aggregate edits; `m.new_content` is the
   * real new message and the only part our own timeline ever shows (the SDK
   * folds it onto the original, so `getContent()` returns it).
   *
   * `eventId` must be the *original* message, never a previous edit — which is
   * what the rows are keyed by, so the UI has nothing else to pass.
   */
  async editMessage(roomId: string, eventId: string, body: string, threadId?: string): Promise<void> {
    const client = this.client;
    const room = client?.getRoom(roomId);
    const target = room?.findEventById(eventId);
    if (!client || !target) throw new MatrixError(0, '', 'That message is no longer loaded.');
    // Same as send(): the saved edit supersedes any standing advertisement.
    this.notifyTyping(roomId, false);
    const msgtype = (target.getContent() as { msgtype?: unknown }).msgtype;
    const formatted = toHtml(body);
    const newContent: Record<string, unknown> = {
      msgtype: typeof msgtype === 'string' && EDITABLE_MSGTYPES.has(msgtype) ? msgtype : 'm.text',
      body,
    };
    if (formatted) {
      newContent.format = 'org.matrix.custom.html';
      newContent.formatted_body = formatted;
    }
    const content: Record<string, unknown> = {
      ...newContent,
      body: `* ${body}`,
      'm.new_content': newContent,
      'm.relates_to': { rel_type: 'm.replace', event_id: eventId },
    };
    if (formatted) content.formatted_body = `* ${formatted}`;
    try {
      // `threadId` routes the local echo into the right timeline; the relation
      // is already `m.replace`, so the SDK leaves it alone (an edit relates to
      // the message it rewrites, never to the thread).
      await client.sendMessage(roomId, threadId ?? null, content as unknown as RoomMessageEventContent);
    } catch (err) {
      throw MatrixError.from(err);
    }
  }

  /**
   * Add my reaction `key` to an event, or take it away again if it is already
   * mine. Rejects with a display-ready message — unlike a message send, a
   * reaction has no row of its own to fail into.
   */
  async toggleReaction(roomId: string, eventId: string, key: string, threadId?: string): Promise<void> {
    const client = this.client;
    const room = client?.getRoom(roomId);
    if (!client || !room) throw new MatrixError(0, '', 'Not connected.');
    // The same three windows `threadTimeline` folds, so "is this chip already
    // mine?" is answered from exactly what the row is drawing.
    const thread = threadId ? room.getThread(threadId) : null;
    const windows: MatrixEvent[][] = [room.getLiveTimeline().getEvents(), room.getPendingEvents()];
    if (thread) windows.push(thread.events);
    const mine = this.collectReactions(room, windows).get(eventId)?.find((r) => r.key === key);
    try {
      if (!mine?.mine) {
        await client.sendEvent(roomId, threadId ?? null, sdk.EventType.Reaction, {
          'm.relates_to': { rel_type: sdk.RelationType.Annotation, event_id: eventId, key },
        });
      } else if (mine.myEventId) {
        await client.redactEvent(roomId, threadId ?? null, mine.myEventId);
      }
      // else: my reaction is still a local echo, so there is no event to redact
      // yet. Doing nothing is right — the chip is already showing.
    } catch (err) {
      throw MatrixError.from(err);
    }
  }

  /** Delete a message (`m.room.redaction`). The SDK empties the event locally
   *  straight away, so the row reads "(message deleted)" before the server
   *  answers. Rejects with a display-ready message. */
  async redact(roomId: string, eventId: string, threadId?: string): Promise<void> {
    const client = this.client;
    if (!client) throw new MatrixError(0, '', 'Not connected.');
    try {
      await client.redactEvent(roomId, threadId ?? null, eventId);
    } catch (err) {
      throw MatrixError.from(err);
    }
  }

  /** Upload a file and send it — `m.image` when the bytes are a picture,
   *  `m.file` otherwise (media.ts decides). Unlike `send()`, the upload half
   *  has no local echo to fail into — nothing exists in the timeline until the
   *  bytes are on the server — so this one *rejects* and the caller shows the
   *  message. Once the event itself is sent, failure goes back to being a
   *  `.failed` echo row like any other message. */
  async sendAttachment(
    roomId: string,
    file: File,
    onProgress?: (fraction: number) => void,
    threadId?: string,
  ): Promise<void> {
    const client = this.client;
    const media = this.media_;
    if (!client || !media) throw new MatrixError(0, '', 'Not connected.');
    const room = client.getRoom(roomId);
    // hasEncryptionStateEvent() is the same predicate `toPublicRoom()` uses for
    // MxRoom.encrypted, so the padlock in the room header and the decision to
    // encrypt these bytes can never disagree.
    const encrypt = room?.hasEncryptionStateEvent() ?? false;
    const content: MxAttachmentContent = await media.uploadAttachment({ file, encrypt, onProgress });
    try {
      await client.sendMessage(roomId, threadId ?? null, content as unknown as RoomMessageEventContent);
    } catch {
      // failure surfaces as the .failed local-echo row (EventStatus.NOT_SENT)
    }
  }

  /** Resolve a displayable blob: URL for an `m.image` event's content,
   *  downloading (and decrypting) once per mxc URI. */
  imageUrl(content: MxImageContent): Promise<string> {
    const media = this.media_;
    if (!media) return Promise.reject(new MatrixError(0, '', 'Not connected.'));
    return media.objectUrl(content);
  }

  /** The same for a plain attachment: an opaque blob: URL the caller hands to a
   *  `download` link. Only ever called from a click — a file row shows a name
   *  and a size until the reader asks for the bytes. */
  attachmentUrl(content: MxFileContent): Promise<string> {
    const media = this.media_;
    if (!media) return Promise.reject(new MatrixError(0, '', 'Not connected.'));
    return media.attachmentUrl(content);
  }

  async retrySend(roomId: string, txnId: string): Promise<void> {
    const client = this.client;
    const room = client?.getRoom(roomId);
    if (!client || !room) return;
    const ev = room.getPendingEvents().find((e) => e.getTxnId() === txnId);
    if (!ev) return;
    try {
      await client.resendEvent(ev, room);
    } catch {
      // failure surfaces as the .failed row again
    }
  }

  // ---- room actions ---------------------------------------------------------

  async members(roomId: string): Promise<MxMember[]> {
    const room = this.client?.getRoom(roomId);
    if (!room) return [];
    try {
      await room.loadMembersIfNeeded();
    } catch (err) {
      throw MatrixError.from(err);
    }
    const joined = room.getMembersWithMembership('join');
    const invited = room.getMembersWithMembership('invite');
    const out: MxMember[] = [...joined, ...invited].map((m) => ({
      userId: m.userId,
      displayName: m.name,
      membership: m.membership === 'invite' ? 'invite' : 'join',
      avatarMxc: m.getMxcAvatarUrl() ?? null,
    }));
    out.sort((a, b) => {
      if (a.membership !== b.membership) return a.membership === 'join' ? -1 : 1;
      return a.displayName.localeCompare(b.displayName);
    });
    return out;
  }

  async invite(roomId: string, mxid: string): Promise<void> {
    try {
      await this.client?.invite(roomId, mxid);
    } catch (err) {
      throw MatrixError.from(err);
    }
  }

  async leave(roomId: string): Promise<void> {
    try {
      await this.client?.leave(roomId);
    } catch (err) {
      throw MatrixError.from(err);
    }
    if (this.openRoomId === roomId) this.openRoomId = null;
    this.markRoomsDirty();
  }

  async acceptInvite(roomId: string): Promise<void> {
    const client = this.client;
    const room = client?.getRoom(roomId);
    const ownEvent = room?.currentState.getStateEvents(sdk.EventType.RoomMember, this.userId);
    const ownContent = ownEvent?.getContent() as { is_direct?: boolean } | undefined;
    const isDirect = ownContent?.is_direct === true;
    const inviterId = ownEvent?.getSender();
    try {
      await client?.joinRoom(roomId);
    } catch (err) {
      throw MatrixError.from(err);
    }
    if (isDirect && inviterId) {
      await this.mergeDirect(inviterId, roomId).catch(() => {});
    }
  }

  async declineInvite(roomId: string): Promise<void> {
    await this.leave(roomId);
  }

  private async mergeDirect(mxid: string, roomId: string): Promise<void> {
    const client = this.client;
    if (!client) return;
    const directEvent = client.getAccountData(sdk.EventType.Direct);
    const map = { ...((directEvent?.getContent() as Record<string, string[]> | undefined) ?? {}) };
    const list = map[mxid] ?? [];
    if (!list.includes(roomId)) {
      map[mxid] = [...list, roomId];
      await client.setAccountData(sdk.EventType.Direct, map);
    }
  }

  async createDm(mxid: string): Promise<string> {
    const existing = this.existingDmWith(mxid);
    if (existing) return existing;
    const client = this.client;
    if (!client) throw new MatrixError(0, '', 'Not connected.');
    try {
      const res = await client.createRoom({
        is_direct: true,
        preset: sdk.Preset.TrustedPrivateChat,
        invite: [mxid],
      });
      await this.mergeDirect(mxid, res.room_id).catch(() => {});
      return res.room_id;
    } catch (err) {
      throw MatrixError.from(err);
    }
  }

  async createGroup(o: { name: string; isPublic: boolean; alias?: string }): Promise<string> {
    const client = this.client;
    if (!client) throw new MatrixError(0, '', 'Not connected.');
    try {
      const res = o.isPublic
        ? await client.createRoom({
            name: o.name,
            preset: sdk.Preset.PublicChat,
            visibility: sdk.Visibility.Public,
            ...(o.alias ? { room_alias_name: o.alias } : {}),
          })
        : await client.createRoom({ name: o.name, preset: sdk.Preset.PrivateChat, visibility: sdk.Visibility.Private });
      return res.room_id;
    } catch (err) {
      throw MatrixError.from(err);
    }
  }

  async joinRoom(input: string): Promise<string> {
    const client = this.client;
    if (!client) throw new MatrixError(0, '', 'Not connected.');
    const parts = input.trim().split(/\s+/).filter(Boolean);
    const first = parts[0] ?? '';
    try {
      if (first.startsWith('#')) {
        const room = await client.joinRoom(first, parts[1] ? { viaServers: [parts[1]] } : undefined);
        return room.roomId;
      }
      if (first.startsWith('!')) {
        const colon = first.indexOf(':');
        const domain = colon !== -1 ? first.slice(colon + 1) : '';
        const via = parts[1] || domain;
        const room = await client.joinRoom(first, via ? { viaServers: [via] } : undefined);
        return room.roomId;
      }
    } catch (err) {
      throw MatrixError.from(err);
    }
    throw new MatrixError(0, 'M_BAD_INPUT', 'Enter an address like #room:server.');
  }

  async searchUsers(term: string, signal?: AbortSignal): Promise<MxDirectoryUser[]> {
    const client = this.client;
    if (!client) return [];
    const generation = ++this.searchGeneration;
    try {
      const res = await client.searchUserDirectory({ term, limit: 20 });
      if (signal?.aborted || generation !== this.searchGeneration) return [];
      return res.results.map((r) => ({
        userId: r.user_id,
        displayName: r.display_name || r.user_id,
        // The directory hands back an mxc:// directly; it is not validated
        // here because resolving it goes through MatrixMedia, which refuses
        // anything that isn't an mxc:// URI.
        avatarMxc: r.avatar_url ?? null,
      }));
    } catch (err) {
      // Let every non-abort failure (directory disabled, rate limit, a
      // network/CORS error) propagate — swallowing it made "the directory
      // is off" look identical to "no such person".
      if (signal?.aborted) return [];
      throw MatrixError.from(err);
    }
  }

  // ---- logout ---------------------------------------------------------------

  /** docs/design.md.4, steps 4/6-9 (wipeNamespace) plus 5/10 (release/teardown).
   *  Captures the outcome in `lastWipeFailed_` rather than discarding it — never silently succeed on
   *  the one flow whose entire purpose is destroying key material (requirement F / design §2.4 step 9).
   *  Never rejects to the caller. Assumes `this.stop()` (or an equivalent `client.stopClient()`) has
   *  already run. */
  private async wipeAndTeardown(): Promise<void> {
    const client = this.client;
    const ns = this.boot?.ns ?? '';
    if (ns) {
      const wipe = await wipeNamespace({ ns, paUserId: this.paUserId }).catch(
        (): { ok: boolean; failed: string[] } => ({ ok: false, failed: [] }),
      );
      if (client) {
        try {
          await client.clearStores({ cryptoDatabasePrefix: cryptoDbPrefix(ns) });
        } catch {
          // best-effort — wipeNamespace already attempted the real deletes
        }
      }
      if (wipe.ok) {
        this.lastWipeFailed_ = [];
      } else {
        // clearStores() above may have succeeded where wipeNamespace's own delete attempt didn't
        // (e.g. it closed a connection that was blocking the delete) — re-check via the same
        // pending-wipe retry the next boot would otherwise run, so a false alarm never fires.
        const prefix = cryptoDbPrefix(ns);
        const stillFailing = await drainPendingWipes();
        this.lastWipeFailed_ = stillFailing.filter((name) => name.startsWith(prefix));
      }
    } else {
      this.lastWipeFailed_ = [];
    }
    this.boot?.release();
    this.cryptoFacade?.destroy();
    this.boot = null;
    this.cryptoFacade = null;
    this.client = null;
    this.setStatus('signedout');
  }

  /** docs/design.md.4, steps 1-3/5/10. Never rejects to the caller. */
  async logout(): Promise<void> {
    if (this.wiping) return;
    this.wiping = true;
    const client = this.client;
    this.stop();
    if (client && !this.knownDeadToken) {
      await new Promise<void>((resolve) => {
        let done = false;
        const finish = (): void => {
          if (done) return;
          done = true;
          resolve();
        };
        client.logout(true).then(finish, finish);
        setTimeout(finish, LOGOUT_HTTP_TIMEOUT_MS);
      });
    }
    await this.wipeAndTeardown();
    this.emitter.emit('loggedOut', { expired: false, soft: false });
  }
}
