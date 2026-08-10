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
 * Every method that can reject normalises the rejection through
 * `MatrixError.from()` — `MatrixUI`'s `errcode`-branching error text and the
 * join flow's `M_FORBIDDEN`/`M_NOT_FOUND` cases both depend on that shape
 * surviving the trip through the SDK's own error classes.
 */
import {
  ClientEvent,
  RoomEvent,
  RoomStateEvent,
  MatrixEventEvent,
  HttpApiEvent,
  SyncState,
  EventStatus,
  sdk,
} from './sdk.js';
import type { MatrixClient, Room, MatrixEvent, RoomMessageEventContent, SdkMatrixError } from './sdk.js';
import { MatrixError } from './types.js';
import type {
  MxCryptoState,
  MxDecryptError,
  MxDirectoryUser,
  MxEvent,
  MxEventUnsigned,
  MxMember,
  MxReader,
  MxMembership,
  MxRoom,
  MxSession,
  MxSecretRequest,
  MxStatus,
} from './types.js';
import { bootMatrixClient, type MxBootState, type MxClientBoot } from './client.js';
import { cryptoDbPrefix, drainPendingWipes, readNotifyPrefs, startFresh, wipeNamespace } from './storage.js';
import { MatrixNotifier, type NotifyKind } from './notify.js';
import { notifyDesktop } from '../desktop/bridge.js';
import { createMatrixCrypto, type MatrixCrypto } from './crypto.js';
import { MatrixMedia, type MxImageContent } from './media.js';
import { toHtml } from './markdown.js';

const READ_DEBOUNCE_MS = 1000;

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

  private roomsFlushQueued = false;
  private readonly timelineDirty = new Set<string>();
  private timelineFlushQueued = false;

  private readonly onOnline = (): void => this.retryNow();
  private readonly onOffline = (): void => this.setStatus('offline');

  /** Live events that arrived as ciphertext and are still being decrypted. Only
   *  an id in here may notify when `Decrypted` fires: that event also fires for
   *  history whose keys turn up much later, and backfilled messages from last
   *  week must not pop notifications. */
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
      if (this.openRoomId === roomId) this.openRoomId = null;
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

  private attachRoomUnreadListener(room: Room): void {
    if (this.roomUnreadUnsubs.has(room.roomId)) return;
    const handler = (): void => this.markRoomsDirty();
    room.on(RoomEvent.UnreadNotifications, handler);
    this.roomUnreadUnsubs.set(room.roomId, () => room.off(RoomEvent.UnreadNotifications, handler));
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
   * A still-decrypting event is parked in `awaitingDecrypt` instead, and comes
   * back through `MatrixEventEvent.Decrypted`. A permanent failure is dropped:
   * push rules cannot be evaluated against a body nobody can read, so we cannot
   * tell a muted room from a mention, and guessing in either direction is worse
   * than the unread badge the room list already shows.
   */
  private considerNotify(ev: MatrixEvent, room: Room | undefined, recalculate: boolean): void {
    const client = this.client;
    if (!client || !room) return;
    // The initial sync replays every room's recent history as live events.
    if (!this.everPrepared) return;

    if (ev.isBeingDecrypted()) {
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
    const kind: NotifyKind = content.msgtype === 'm.image' ? 'picture' : 'message';
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
    return {
      event_id: ev.getId() ?? '',
      type,
      sender: ev.getSender() ?? '',
      origin_server_ts: ev.getTs(),
      content: readable ? (ev.getContent() as Record<string, unknown>) : {},
      unsigned: mxUnsigned,
      txnId,
      echo,
      decrypting: extra.decrypting,
      decryptError: extra.decryptError,
    };
  }

  private previewText(ev: MxEvent): string {
    if (ev.decrypting || ev.decryptError) return '🔒 Encrypted message';
    const body = ev.content?.body;
    // An m.image's body is its filename, which on its own reads like someone
    // sent the word "screenshot.png".
    if (ev.content?.msgtype === 'm.image') return typeof body === 'string' && body ? `🖼 ${body}` : '🖼 Picture';
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
      const mapped = this.classify(ev);
      if (!mapped) continue;
      lastTs = mapped.origin_server_ts;
      preview = this.previewText(mapped);
      break;
    }

    return {
      roomId: room.roomId,
      membership,
      name: room.name,
      isDirect: this.isDirectRoom(room, ownContent),
      encrypted: room.hasEncryptionStateEvent(),
      joinedCount: room.getJoinedMemberCount(),
      invitedCount: room.getInvitedMemberCount(),
      unread: room.getUnreadNotificationCount(sdk.NotificationCountType.Total),
      highlight: room.getUnreadNotificationCount(sdk.NotificationCountType.Highlight),
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
    const out: MxEvent[] = [];
    for (const ev of room.getLiveTimeline().getEvents()) this.pushClassified(out, ev);
    for (const ev of room.getPendingEvents()) this.pushClassified(out, ev);
    return out;
  }

  private pushClassified(out: MxEvent[], ev: MatrixEvent): void {
    if (ev.status === EventStatus.CANCELLED) return;
    const mapped = this.classify(ev);
    if (mapped) out.push(mapped);
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
    this.openRoomId = null;
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
    const client = this.client;
    const room = client?.getRoom(roomId);
    if (!client || !room) return;
    const live = room.getLiveTimeline().getEvents();
    const last = live[live.length - 1];
    const lastEventId = last?.getId();
    if (!last || !lastEventId) return;
    const existing = this.readTimers.get(roomId);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => {
      this.readTimers.delete(roomId);
      if (this.lastSentRead.get(roomId) === lastEventId) return;
      this.lastSentRead.set(roomId, lastEventId);
      void client.sendReadReceipt(last).catch(() => {});
      void client.setRoomReadMarkers(roomId, lastEventId).catch(() => {});
    }, READ_DEBOUNCE_MS);
    this.readTimers.set(roomId, timer);
  }

  // ---- send / echo ---------------------------------------------------------

  async send(roomId: string, body: string): Promise<void> {
    const client = this.client;
    if (!client) return;
    // `body` stays the user's literal text in both branches — it is the
    // fallback every client without an HTML renderer shows, so it must never
    // become the generated markup.
    const formatted = toHtml(body);
    try {
      if (formatted) {
        await client.sendMessage(roomId, {
          msgtype: 'm.text',
          body,
          format: 'org.matrix.custom.html',
          formatted_body: formatted,
        } as unknown as RoomMessageEventContent);
      } else {
        await client.sendTextMessage(roomId, body);
      }
    } catch {
      // failure surfaces as the .failed local-echo row (EventStatus.NOT_SENT)
    }
  }

  /** Upload a PNG and send it as `m.image`. Unlike `send()`, the upload half
   *  has no local echo to fail into — nothing exists in the timeline until the
   *  bytes are on the server — so this one *rejects* and the caller shows the
   *  message. Once the event itself is sent, failure goes back to being a
   *  `.failed` echo row like any other message. */
  async sendImage(roomId: string, file: File, onProgress?: (fraction: number) => void): Promise<void> {
    const client = this.client;
    const media = this.media_;
    if (!client || !media) throw new MatrixError(0, '', 'Not connected.');
    const room = client.getRoom(roomId);
    // hasEncryptionStateEvent() is the same predicate `toPublicRoom()` uses for
    // MxRoom.encrypted, so the padlock in the room header and the decision to
    // encrypt these bytes can never disagree.
    const encrypt = room?.hasEncryptionStateEvent() ?? false;
    const content: MxImageContent = await media.uploadImage({ file, encrypt, onProgress });
    try {
      await client.sendMessage(roomId, content as unknown as RoomMessageEventContent);
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

  /** docs/design/matrix-e2ee-design.md §2.4, steps 4/6-9 (wipeNamespace) plus 5/10 (release/teardown).
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

  /** docs/design/matrix-e2ee-design.md §2.4, steps 1-3/5/10. Never rejects to the caller. */
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
