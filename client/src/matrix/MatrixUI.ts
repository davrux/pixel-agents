/**
 * Matrix chat panel: the view router, all nine views (login, rooms, room,
 * members, media, threads, newdm, newgroup, join, encryption), the composer and
 * the pin/status strip.
 *
 * Rendered into whatever container the host gives it (the panel's `.pa-body`).
 * This module owns no network transport and no persistence beyond the small
 * view/draft breadcrumbs described below — that all lives in MatrixStore
 * (./store.js, a thin projection over matrix-js-sdk) and the session helpers
 * (./session.js). This file is purely "given a store, draw the panel; given
 * clicks, drive the store."
 *
 * The room view also carries the fast-switch rail (`renderRail`): a Discord-
 * style column of the most recently active chats down its left edge, avatars
 * only, so hopping between the handful of conversations that are actually live
 * costs one click instead of ◀ + a scroll through the room list.
 *
 * Navigation is a small explicit stack: `rooms` is the root, `room` pushes on
 * top of it, `members`/`media`/`threads` push on top of `room`, and
 * `newdm`/`newgroup`/`join`/`encryption` push directly on top of `rooms`.
 *
 * A THREAD is not a view of its own: it is a second `room` frame carrying a
 * `threadId`, drawn by the same section. That is deliberate rather than
 * economical — a thread needs the whole composer (drafts, reply, edit,
 * attachments, the emoji picker, typing notices) and the whole timeline, and a
 * second copy of both is a second place for them to drift. What the frame
 * changes is where the rows come from and where a send goes; `renderRoomView`
 * takes the thread id and everything downstream of it follows.
 *
 * Every view is rebuilt from
 * scratch on each render (`createElement` + `textContent` per row) rather
 * than incrementally diffed — the datasets are small (a room list, a member
 * list, search results) and a full rebuild is what keeps every row that
 * carries remote text (names, MXIDs, previews) safely out of `innerHTML`. The
 * timeline is the one exception: it is large and long-lived, so it is owned
 * by TimelineView (./timeline.js), which does its own keyed diffing. The
 * encryption/key-management view is likewise its own module
 * (./EncryptionUI.js) — this file only mounts it as an eighth section and
 * routes to it.
 */
import {
  MatrixError,
  type MxDirectoryUser,
  type MxEvent,
  type MxMember,
  type MxRoom,
  type MxSession,
  type MxThreadInfo,
} from './types.js';
import {
  clearSession,
  describeError,
  discoverHomeserver,
  lastDeviceId,
  loadSession,
  loginWithPassword,
  normaliseHomeserverUrl,
  probeLoginFlows,
  saveSession,
} from './session.js';
import { MatrixStore } from './store.js';
import {
  fileContentOf,
  imageContentOf,
  MAX_FILE_BYTES,
  type MxFileContent,
  type MxImageContent,
} from './media.js';
import { mkAvatar, type MxAvatarPicture } from './matrixSkin.js';
import { describeFile, fmtBytes, fmtRelative, messageActionsFor, TimelineView, type TimelineHooks } from './timeline.js';
import { openMessageMenu, type MessageMenuHandle } from './messageMenu.js';
import { openEmojiPicker, type EmojiPickerHandle } from './emojiPicker.js';
import { copyImage, copyText } from './clipboard.js';
import { confirmDialog, passwordPromptDialog } from '../ui/dialog.js';
import { readNotifyPrefs, writeNotifyPrefs } from './storage.js';
import { isDesktop } from '../desktop/bridge.js';
import { createEncryptionView, type EncryptionViewHandle, type EncryptionViewHooks } from './EncryptionUI.js';

export interface MatrixUIHooks {
  paUserId: string;
  onUnreadChange(unread: number): void;
  onRequestClose(): void;
}

type ViewName =
  | 'login'
  | 'rooms'
  | 'room'
  | 'members'
  | 'media'
  | 'threads'
  | 'newdm'
  | 'newgroup'
  | 'join'
  | 'encryption'
  | 'notifications';
type RoomsTab = 'people' | 'groups' | 'invites';

interface ViewFrame {
  view: ViewName;
  roomId?: string;
  /** `room` frames only: the thread whose replies this frame shows, rather
   *  than the room's main timeline. */
  threadId?: string;
}

const MXID_RE = /^@[^:\s]+:[^:\s]+$/;

export class MatrixUI {
  private readonly root: HTMLDivElement;
  private readonly hooks: MatrixUIHooks;

  private store: MatrixStore | null = null;
  private hsBaseUrl = '';
  private storeUnsubs: Array<() => void> = [];
  /** The signing-in device id, kept only across a soft-logout re-login (see
   *  handleLoggedOut) — a fresh login must never reuse a device id, because
   *  rebinding one to a new crypto identity after a wipe is exactly the
   *  "changed keys under a stable id" pattern other clients flag as a
   *  security warning. */
  private currentDeviceId = '';
  private pendingReloginDeviceId: string | undefined;

  /** Whether our window is currently docked open (the host tells us — see
   *  setDocked): a closed window has no reason to keep polling the timeline. */
  private docked = false;
  private stack: ViewFrame[] = [{ view: 'rooms' }];
  private openRoomId: string | null = null;
  /** The thread the room view is currently showing, or null for the room's own
   *  timeline. Kept beside `openRoomId` rather than read off the stack on every
   *  use, for the same reason that one is: the store callbacks fire from
   *  outside a render and need to know what is on screen without walking it. */
  private openThreadId: string | null = null;
  /** Set by openDm() when called signed-out (e.g. from `/matrix @user:server`
   *  before login finishes); replayed once a store exists. */
  private pendingDmMxid: string | null = null;
  /** Tracks whether the login view is currently standing in for a boot
   *  failure ('locked-out' / 'wipe-pending') so renderTopStrip can notice a
   *  transition without re-running the whole navigation stack every tick. */
  private bootGateActive = false;
  private lastEncryptedState = new Map<string, boolean>();

  // ---- status strip ----
  private topEl!: HTMLDivElement;
  private dotEl!: HTMLSpanElement;
  private statusLabelEl!: HTMLSpanElement;
  private retryLink!: HTMLAnchorElement;
  private meEl!: HTMLSpanElement;
  private meAvatarSlot!: HTMLButtonElement;
  private avatarInput!: HTMLInputElement;
  private roomAvatarSlot!: HTMLButtonElement;
  private avatarBusy = false;
  private encBtn!: HTMLButtonElement;
  /** Desktop builds only — the browser has no OS notification to configure. */
  private notifyBtn?: HTMLButtonElement;
  private notifyEnabledEl?: HTMLInputElement;
  private notifyBodyEl?: HTMLInputElement;
  private notifyTypingEl?: HTMLInputElement;
  private cryptoWarnEl!: HTMLDivElement;
  private wipeWarnEl!: HTMLDivElement;
  private encryptionView!: EncryptionViewHandle;

  // ---- sections ----
  private readonly sections = new Map<ViewName, HTMLElement>();

  // ---- login view ----
  private hsInput!: HTMLInputElement;
  private userInput!: HTMLInputElement;
  private pwInput!: HTMLInputElement;
  private signinBtn!: HTMLButtonElement;
  private loginErrEl!: HTMLDivElement;
  private loginHintEl!: HTMLDivElement;
  private loginFormEl!: HTMLDivElement;
  private loginSsoEl!: HTMLDivElement;
  private loginDiscoverTimer?: number;
  private loginDiscoverAbort?: AbortController;
  private loginBusy = false;
  private loginStartFreshBtn!: HTMLButtonElement;
  private loginStartFreshHintEl!: HTMLDivElement;

  // ---- rooms view ----
  private roomsSegEl!: HTMLDivElement;
  private roomsFilterInput!: HTMLInputElement;
  private roomsListEl!: HTMLDivElement;
  private roomsTab: RoomsTab = 'people';
  private roomsFilterText = '';
  private readonly inviteBusy = new Set<string>();
  private readonly inviteError = new Map<string, string>();

  // ---- room view ----
  /** The fast-switch rail down the left edge of the room view, and the
   *  signature of what it is currently showing. The room view re-renders on
   *  every timeline event, so the rail is rebuilt only when what it would draw
   *  actually changed — same trick as `paintAvatarSlot`, for the same reason:
   *  rebuilding it per event would recreate ten avatar squares (and their
   *  <img> elements) several times a second while a room is busy. */
  private railEl!: HTMLElement;
  private railKey = '';
  private roomNameEl!: HTMLSpanElement;
  private roomLockEl!: HTMLSpanElement;
  private roomMembersBtn!: HTMLButtonElement;
  private roomMediaBtn!: HTMLButtonElement;
  private roomThreadsBtn!: HTMLButtonElement;
  /** Shown instead of the room's picture while a thread is open, so the header
   *  says which of the two the composer below it is pointed at. */
  private roomThreadTagEl!: HTMLSpanElement;
  private roomNoticeEl!: HTMLDivElement;
  private timelineView!: TimelineView;
  private composerTextarea!: HTMLTextAreaElement;
  private composerSendBtn!: HTMLButtonElement;
  /** The "Alice is typing…" strip between timeline and composer. Always in
   *  the layout at a fixed one-line height (empty text when nobody types), so
   *  the timeline never jumps when it appears. */
  private typingEl!: HTMLDivElement;
  private composerDisabledEl!: HTMLDivElement;
  /** The "replying to …" / "editing …" bar above the composer controls. */
  private composerCtxEl!: HTMLDivElement;
  private composerCtxIconEl!: HTMLSpanElement;
  private composerCtxWhoEl!: HTMLSpanElement;
  private composerCtxWhatEl!: HTMLSpanElement;
  /** The message the composer is replying to, or null. Mutually exclusive with
   *  `editing` — both are cleared when a room is opened or left. */
  private replyingTo: { eventId: string; who: string; text: string } | null = null;
  /** The message the composer is rewriting: its id, plus the draft that was in
   *  the composer when editing started, restored when it is cancelled. */
  private editing: { eventId: string; stashedDraft: string } | null = null;
  /** The open message menu and the ⋯ button it belongs to, so pressing that
   *  same button again closes it (and pressing a different one moves it) rather
   *  than stacking a second menu. */
  private msgMenu: MessageMenuHandle | null = null;
  private msgMenuAnchor: HTMLElement | null = null;
  /** The open emoji picker (composer insert or react-with-any) — one at a
   *  time, same rule as the message menu. */
  private emojiPicker: EmojiPickerHandle | null = null;
  private emojiBtn!: HTMLButtonElement;
  private attachBtn!: HTMLButtonElement;
  private attachInput!: HTMLInputElement;
  private uploadStatusEl!: HTMLDivElement;
  /** One upload at a time: the status line has room for one, and a second
   *  concurrent encrypt+upload of a multi-megabyte file on a tab that is also
   *  rendering a game is not worth the complexity. */
  private uploading = false;
  private refreshTimer?: number;

  // ---- media view ----
  private mediaStatusEl!: HTMLDivElement;
  private mediaPicsLabel!: HTMLDivElement;
  private mediaPicsGridEl!: HTMLDivElement;
  private mediaFilesLabel!: HTMLDivElement;
  private mediaFilesListEl!: HTMLDivElement;
  private mediaOlderBtn!: HTMLButtonElement;
  private mediaFootEl!: HTMLDivElement;
  /** Signature of what the grid/list currently shows (the media events' ids),
   *  so the per-sync-tick re-render doesn't rebuild every tile — same trick as
   *  the rail and paintAvatarSlot, for the same reason: a rebuilt tile is a
   *  restarted <img> load and a visible flicker. null forces the next render
   *  to rebuild (set when the view is opened for a room). */
  private mediaListKey: string | null = null;

  // ---- threads view ----
  private threadsStatusEl!: HTMLDivElement;
  private threadsListEl!: HTMLDivElement;

  // ---- members view ----
  private membersJoinedLabel!: HTMLDivElement;
  private membersJoinedListEl!: HTMLDivElement;
  private membersInvitedLabel!: HTMLDivElement;
  private membersInvitedListEl!: HTMLDivElement;
  private membersInviteInput!: HTMLInputElement;
  private membersInviteBtn!: HTMLButtonElement;
  private membersInviteErrEl!: HTMLDivElement;
  private membersLeaveBtn!: HTMLButtonElement;
  private membersStatusEl!: HTMLDivElement;
  private readonly membersCache = new Map<string, MxMember[]>();
  private membersLoading = false;
  private membersError = '';

  // ---- newdm view ----
  private dmSearchInput!: HTMLInputElement;
  private dmResultsEl!: HTMLDivElement;
  private dmSearchTimer?: number;
  private dmSearchAbort?: AbortController;
  private dmResults: MxDirectoryUser[] = [];
  private dmSearchError = '';
  private dmSearchTerm = '';
  private dmSearching = false;
  private dmChoosing: string | null = null;

  // ---- newgroup view ----
  private groupNameInput!: HTMLInputElement;
  private groupSegEl!: HTMLDivElement;
  private groupAliasRow!: HTMLDivElement;
  private groupAliasInput!: HTMLInputElement;
  private groupCreateBtn!: HTMLButtonElement;
  private groupErrEl!: HTMLDivElement;
  private groupVisibility: 'private' | 'public' = 'private';

  // ---- join view ----
  private joinInput!: HTMLInputElement;
  private joinBtn!: HTMLButtonElement;
  private joinErrEl!: HTMLDivElement;

  // ---- toast ----
  private toastEl?: HTMLDivElement;
  private toastTimer?: number;

  /** Nothing to poll for while the tab is in the background or our window is
   *  closed — the store's own /sync keeps the unread badge live either way. */
  private readonly onVisibilityChange = (): void => {
    if (document.hidden || !this.docked) {
      this.stopTimelineRefresh();
    } else if (this.openRoomId) {
      this.startTimelineRefresh();
    }
  };

  constructor(mount: HTMLElement, hooks: MatrixUIHooks) {
    this.hooks = hooks;

    this.root = document.createElement('div');
    this.root.id = 'pa-mx';
    this.root.className = 'pa-ui';
    this.root.tabIndex = -1;
    this.root.addEventListener('keydown', (ev) => {
      if (ev.key === 'Escape') {
        ev.stopPropagation();
        this.handleEscape();
      }
    });

    this.buildTopStrip();
    this.buildLoginView();
    this.buildRoomsView();
    this.buildRoomView();
    this.buildMembersView();
    this.buildMediaView();
    this.buildThreadsView();
    this.buildNewDmView();
    this.buildNewGroupView();
    this.buildJoinView();
    this.buildEncryptionView();
    if (isDesktop()) this.buildNotificationsView();

    mount.appendChild(this.root);
    document.addEventListener('visibilitychange', this.onVisibilityChange);

    const session = loadSession(hooks.paUserId);
    if (session) {
      this.startStoreFromSession(session);
      this.restoreView();
    }
    this.renderCurrent();
  }

  // ==================================================================
  // Public API
  // ==================================================================

  /** The host's docked window opened or closed around us. Only the timeline
   *  poll cares: a window left open in a backgrounded tab keeps refreshing,
   *  a closed one stops. */
  setDocked(docked: boolean): void {
    this.docked = docked;
    this.onVisibilityChange();
  }

  ownsFocus(): boolean {
    return this.root.contains(document.activeElement);
  }

  openDm(mxid: string): void {
    if (!MXID_RE.test(mxid)) return;
    if (!this.store) {
      // Signed out (e.g. a session that never persisted, or one that just
      // expired) — remember the target and replay it once login succeeds,
      // rather than silently dropping it on the login screen.
      this.pendingDmMxid = mxid;
      return;
    }
    void this.chooseDmTarget(mxid);
  }

  destroy(): void {
    this.stopTimelineRefresh();
    this.closeMessageActions();
    document.removeEventListener('visibilitychange', this.onVisibilityChange);
    if (this.loginDiscoverTimer !== undefined) clearTimeout(this.loginDiscoverTimer);
    this.loginDiscoverAbort?.abort();
    if (this.dmSearchTimer !== undefined) clearTimeout(this.dmSearchTimer);
    this.dmSearchAbort?.abort();
    if (this.toastTimer !== undefined) clearTimeout(this.toastTimer);
    this.teardownStore();
    this.timelineView.destroy();
    this.encryptionView.destroy();
    this.root.remove();
  }

  // ==================================================================
  // Store lifecycle
  // ==================================================================

  private startStoreFromSession(session: MxSession): void {
    this.hsBaseUrl = session.hsBaseUrl;
    this.currentDeviceId = session.deviceId;
    this.store = new MatrixStore({
      session,
      paUserId: this.hooks.paUserId,
      // Whether the reader can actually see chat right now. `document.hasFocus()`
      // is the one that matters on the desktop: a docked window in an unfocused
      // Electron window is open but unwatched, and that is exactly when a
      // notification is worth having.
      attention: () => ({
        panelOpen: this.docked,
        appFocused: !document.hidden && document.hasFocus(),
      }),
    });
    this.storeUnsubs.push(
      this.store.on('status', () => {
        this.renderTopStrip();
        if (this.stack[this.stack.length - 1]?.view === 'rooms') this.renderRoomsView();
      }),
      this.store.on('rooms', () => {
        const invites = this.store?.rooms().filter((r) => r.membership === 'invite').length ?? 0;
        this.hooks.onUnreadChange((this.store?.totalUnread() ?? 0) + invites);
        const top = this.stack[this.stack.length - 1];
        if (top?.view === 'rooms') this.renderRoomsView();
        // Freshly created/joined rooms (handleCreateGroup/handleJoin) open the
        // room view before the room exists in the store — only the next
        // `rooms` event (not `timeline`, which won't fire for a room with no
        // messages yet) tells us its real name/member count arrived.
        if (this.openRoomId && (top?.view === 'room' || top?.view === 'members')) {
          this.renderRoomView(this.openRoomId, this.openThreadId);
        }
      }),
      this.store.on('timeline', (roomId) => {
        const top = this.stack[this.stack.length - 1];
        if (this.openRoomId !== roomId) return;
        // One emit per room covers its threads too: a thread's own timeline set
        // re-emits RoomEvent.Timeline through the room, and the store fires the
        // per-room thread events at it as well (see attachRoomUnreadListener).
        if (top?.view === 'room') this.renderRoomView(roomId, this.openThreadId);
        // The media overview is a projection of the same loaded window, so a
        // new attachment (or a finished paginate) repaints it the same way.
        else if (top?.view === 'media') this.renderMediaView(roomId);
        else if (top?.view === 'threads') this.renderThreadsView(roomId);
      }),
      // Deliberately NOT renderRoomView: someone typing repaints one strip,
      // not the rail, the timeline and the header.
      this.store.on('typing', (roomId) => {
        if (this.openRoomId === roomId && this.stack[this.stack.length - 1]?.view === 'room') {
          this.paintTyping(roomId);
        }
      }),
      this.store.on('loggedOut', ({ expired, soft }) => this.handleLoggedOut(expired, soft)),
      this.store.on('crypto', () => {
        this.renderTopStrip();
        const top = this.stack[this.stack.length - 1];
        if (top?.view === 'encryption') this.encryptionView.render();
        // A crypto-state change (unlock, wrong-key, backup connect, …) must repaint an open room
        // immediately — the 🔒 warn class, the "Unlock to read older messages" notice and the
        // composer's visibility are all derived from cryptoState, and otherwise go stale until an
        // unrelated timeline/rooms event or navigation forces a redraw (never true per requirement B).
        if (top?.view === 'room' && this.openRoomId) this.renderRoomView(this.openRoomId, this.openThreadId);
      }),
      this.store.on('secretRequest', (req) => {
        this.pushRootView('encryption');
        this.encryptionView.noteSecretRequest(req);
      }),
    );
    this.store.start();
  }

  private teardownStore(): void {
    for (const unsub of this.storeUnsubs) unsub();
    this.storeUnsubs = [];
    // The rail's squares hold blob: URLs from this store's media cache, which
    // `destroy()` below revokes — keeping them would paint broken avatars if
    // the same account signs back in and the rail's signature happens to match.
    this.railEl.replaceChildren();
    this.railKey = '';
    // Same for the media overview's tiles (openMediaView already forces a
    // rebuild on the next open; this just stops revoked URLs lingering in DOM).
    this.mediaPicsGridEl.replaceChildren();
    this.mediaFilesListEl.replaceChildren();
    this.mediaListKey = null;
    this.store?.destroy();
    this.store = null;
    this.hsBaseUrl = '';
    this.currentDeviceId = '';
  }

  private handleLoggedOut(expired: boolean, soft: boolean): void {
    // Only a SOFT logout means "this device id is still good, the homeserver expects to see it
    // again" — reuse it on the next login rather than mint a new crypto identity. A hard logout
    // (session revoked from elsewhere, or our own manual sign-out) must never reuse the device id:
    // the store has already wiped this device's local crypto store for exactly that device id, and
    // rebinding it would let the next login rebuild state the homeserver no longer trusts.
    this.pendingReloginDeviceId = soft ? this.currentDeviceId || lastDeviceId(this.hooks.paUserId) : undefined;
    try {
      clearSession(this.hooks.paUserId);
    } catch {
      /* ignore */
    }
    // Read the wipe outcome off the store before tearing it down — see handleSignOut for why this
    // must never be inferred from `this.store` after it may have gone null.
    const store = this.store;
    this.teardownStore();
    this.hooks.onUnreadChange(0);
    this.stack = [{ view: 'rooms' }];
    this.openRoomId = null;
    this.openThreadId = null;
    if (expired) {
      this.loginErrEl.textContent = 'Your Matrix session expired — sign in again.';
      this.loginErrEl.style.display = '';
    }
    // Once a sign-out reports databases it could not delete, the banner goes up and nothing
    // takes it down again for the rest of the session — it is explicitly non-dismissable
    // (design doc §2.4/9). A `wipeWarnShown` flag used to be set here as well and was read by
    // nothing; the element's own visibility is what makes it sticky.
    if (!soft && store && store.lastWipeFailed.length > 0) {
      this.wipeWarnEl.style.display = '';
    }
    this.renderCurrent();
  }

  // ==================================================================
  // Navigation
  // ==================================================================

  private persistView(): void {
    try {
      const top = this.stack[this.stack.length - 1];
      if (top) {
        sessionStorage.setItem(
          'pa-mx-view',
          JSON.stringify({ view: top.view, roomId: top.roomId, threadId: top.threadId }),
        );
      }
    } catch {
      /* ignore */
    }
  }

  private restoreView(): void {
    try {
      const raw = sessionStorage.getItem('pa-mx-view');
      if (!raw) return;
      const saved = JSON.parse(raw) as { view?: ViewName; roomId?: string; threadId?: string };
      if (saved.view === 'room' && saved.roomId) {
        this.openRoomView(saved.roomId);
        if (saved.threadId) this.openThreadView(saved.threadId);
      } else if (saved.view === 'members' && saved.roomId) {
        this.openRoomView(saved.roomId);
        this.openMembersView();
      } else if (saved.view === 'media' && saved.roomId) {
        this.openRoomView(saved.roomId);
        this.openMediaView();
      } else if (saved.view === 'threads' && saved.roomId) {
        this.openRoomView(saved.roomId);
        this.openThreadsView();
      } else {
        this.stack = [{ view: 'rooms' }];
      }
    } catch {
      this.stack = [{ view: 'rooms' }];
    }
  }

  private renderIfTop(view: ViewName, roomId?: string): void {
    const top = this.stack[this.stack.length - 1];
    if (top && top.view === view && top.roomId === roomId) this.renderCurrent();
  }

  /** A stored session whose crypto store cannot be opened ('locked-out' — a
   *  namespace with a pending wipe) or whose last wipe never finished
   *  ('wipe-pending') is not a usable signed-in state: stand in the login
   *  view (no new view, per design doc §5) so its error area and the
   *  Start-fresh escape hatch (§2.6) are reachable. */
  private bootBlocked(): boolean {
    if (!this.store) return false;
    const state = this.store.bootState;
    // 'failed' (both initRustCrypto attempts failed — wasm/IndexedDB unavailable) is just as gating
    // as the other two: `this.client` stays null, so the rooms view would otherwise render as a
    // permanently empty room list with no explanation and a dead "Retry now" link.
    return state === 'locked-out' || state === 'wipe-pending' || state === 'failed';
  }

  private renderCurrent(): void {
    this.persistView();
    this.bootGateActive = this.bootBlocked();
    const signedIn = this.store !== null && !this.bootGateActive;
    const frame: ViewFrame = signedIn ? this.stack[this.stack.length - 1] : { view: 'login' };
    this.topEl.style.display = signedIn ? '' : 'none';
    for (const [name, sec] of this.sections) {
      sec.style.display = frame.view === name ? '' : 'none';
    }
    if (!signedIn) {
      this.renderLoginBootState();
      if (!this.root.contains(document.activeElement)) this.hsInput.focus();
      return;
    }
    switch (frame.view) {
      case 'rooms':
        this.renderRoomsView();
        break;
      case 'room':
        if (frame.roomId) this.renderRoomView(frame.roomId, frame.threadId ?? null);
        break;
      case 'members':
        if (frame.roomId) this.renderMembersView(frame.roomId);
        break;
      case 'media':
        if (frame.roomId) this.renderMediaView(frame.roomId);
        break;
      case 'threads':
        if (frame.roomId) this.renderThreadsView(frame.roomId);
        break;
      case 'newdm':
        this.renderNewDmView();
        break;
      case 'newgroup':
        this.renderNewGroupView();
        break;
      case 'join':
        this.renderJoinView();
        break;
      case 'encryption':
        this.encryptionView.render();
        break;
      case 'notifications':
        this.renderNotificationsView();
        break;
    }
  }

  /** Shows a boot failure ('locked-out' / 'wipe-pending') in the login
   *  view's existing error area — no new view. Also a no-op guard: when
   *  signed fully out (no store at all) it must not clobber whatever
   *  handleLoginSubmit/handleLoggedOut already put there. */
  private renderLoginBootState(): void {
    this.loginStartFreshBtn.style.display = 'none';
    this.loginStartFreshHintEl.style.display = 'none';
    if (!this.store || !this.bootGateActive) return;
    this.loginErrEl.textContent = this.store.bootMessage;
    this.loginErrEl.style.display = '';
    if (this.store.bootState === 'wipe-pending') {
      this.loginStartFreshBtn.style.display = '';
      this.loginStartFreshHintEl.style.display = '';
    }
  }

  private openRoomView(roomId: string): void {
    this.stack = [{ view: 'rooms' }, { view: 'room', roomId }];
    this.openRoomId = roomId;
    this.openThreadId = null;
    this.store?.closeThread();
    // One TimelineView draws every room, so it has to be told the room changed
    // before the render below — otherwise it decides where to land from where
    // the *last* room was scrolled to (see TimelineView.reset). Unconditional,
    // including re-opening the room just left: "open a chat" means its newest
    // message, not wherever you happened to stop reading last time.
    this.timelineView.reset();
    this.hideUploadStatus();
    // A reply or an edit belongs to the room it was started in; the draft below
    // is restored per room, and these would otherwise be applied to the wrong
    // message entirely.
    this.closeMessageActions();
    this.replyingTo = null;
    this.editing = null;
    this.paintComposerContext();
    this.store?.openRoom(roomId).catch(() => {
      /* surfaced via store.timelineError() in the next render */
    });
    this.startTimelineRefresh();
    this.renderCurrent();
    this.loadDraft();
    // Without this, `ownsFocus()` stays false (focus is still wherever it was
    // before the room opened — often <body>), so OfficeScene's WASD-blocking
    // and ChatUI's Enter-to-focus guards both think the panel is inert and a
    // player typing their first message walks their avatar / opens zone chat.
    this.composerTextarea.focus();
  }

  private openMembersView(): void {
    const top = this.stack[this.stack.length - 1];
    if (!top || top.view !== 'room' || !top.roomId) return;
    this.stack.push({ view: 'members', roomId: top.roomId });
    void this.refreshMembers(top.roomId);
    this.renderCurrent();
  }

  private openMediaView(): void {
    const top = this.stack[this.stack.length - 1];
    if (!top || top.view !== 'room' || !top.roomId) return;
    this.stack.push({ view: 'media', roomId: top.roomId });
    // Force the next render to rebuild the grid: an empty room A and an empty
    // room B share the same (empty) signature, and stale tiles from the last
    // visit must never survive into a different room.
    this.mediaListKey = null;
    this.renderCurrent();
  }

  /**
   * Open one thread inside the room already on screen.
   *
   * A second `room` frame rather than a view of its own (see the file header),
   * so ◀ lands back in the room itself. Everything the room view holds per
   * target is reset here for the same reasons `openRoomView` resets it: the
   * timeline draws a different set of rows, and a reply or an edit half-started
   * in the room belongs to a message that is no longer on screen.
   */
  private openThreadView(rootId: string): void {
    const top = this.stack[this.stack.length - 1];
    const roomId = this.openRoomId;
    // The two places a thread can be opened from: a summary under its root in
    // the room, and a row in the threads list. Pushing on top of either is what
    // makes ◀ land back where the reader came from.
    if (!roomId || !top || (top.view !== 'room' && top.view !== 'threads')) return;
    if (top.view === 'room' && top.threadId === rootId) return; // already here
    this.saveDraft();
    // Replace rather than stack when hopping from one thread straight to
    // another: a chain of ◀ through three threads is not navigation anybody
    // asked for. (Only reachable from a room frame today, but the rule belongs
    // with the push, not with whoever happens to call it.)
    if (top.view === 'room' && top.threadId) this.stack.pop();
    this.stack.push({ view: 'room', roomId, threadId: rootId });
    this.openThreadId = rootId;
    this.timelineView.reset();
    this.hideUploadStatus();
    this.closeMessageActions();
    this.replyingTo = null;
    this.editing = null;
    this.paintComposerContext();
    this.store?.openThread(roomId, rootId).catch(() => {
      /* surfaced via store.threadError() in the next render */
    });
    this.renderCurrent();
    this.loadDraft();
    this.composerTextarea.focus();
  }

  /** Back out of a thread into the room it belongs to. The room itself stays
   *  open — only the thread closes. */
  private leaveThreadView(): void {
    this.saveDraft();
    this.openThreadId = null;
    this.store?.closeThread();
    this.timelineView.reset();
    this.dropComposerContext();
    this.hideUploadStatus();
    this.loadDraft();
  }

  private openThreadsView(): void {
    const top = this.stack[this.stack.length - 1];
    if (!top || top.view !== 'room' || !top.roomId || top.threadId) return;
    this.stack.push({ view: 'threads', roomId: top.roomId });
    this.store?.loadThreads(top.roomId).catch(() => {
      /* surfaced via store.threadsError() in the next render */
    });
    this.renderCurrent();
  }

  private pushRootView(view: 'newdm' | 'newgroup' | 'join' | 'encryption' | 'notifications'): void {
    this.stack = [{ view: 'rooms' }, { view }];
    this.renderCurrent();
    if (view === 'newdm') this.dmSearchInput.focus();
    else if (view === 'newgroup') this.groupNameInput.focus();
    else if (view === 'join') this.joinInput.focus();
    else if (view === 'encryption') {
      // Focus the unlock field when there is one to unlock; otherwise land focus on the section
      // itself so ownsFocus() is true and a keystroke never leaks into zone chat (see the tabIndex
      // comment in EncryptionView's constructor). A `.act` link's own <span> (e.g. from a timeline
      // decrypt-error row) is destroyed on the next render, so focus can otherwise end up on <body>.
      this.encryptionView.focusUnlock();
      if (!this.root.contains(document.activeElement)) this.encryptionView.el.focus();
    }
  }

  private goBack(): void {
    if (this.stack.length <= 1) return;
    const leaving = this.stack.pop();
    if (leaving?.view === 'room') {
      // A thread frame sits on top of its own room's frame, so leaving one is
      // not leaving the room — only the second half of that branch closes it.
      if (leaving.threadId) this.leaveThreadView();
      else this.closeOpenRoom();
    }
    this.renderCurrent();
  }

  private goRoot(): void {
    if (this.stack.some((f) => f.view === 'room')) this.closeOpenRoom();
    this.stack = [{ view: 'rooms' }];
    this.renderCurrent();
  }

  /** Everything that has to stop when the room view goes away, thread
   *  included. */
  private closeOpenRoom(): void {
    this.saveDraft();
    this.store?.closeThread();
    this.store?.closeRoom();
    this.openThreadId = null;
    this.openRoomId = null;
    this.stopTimelineRefresh();
    this.dropComposerContext();
  }

  /** Leaving the room view: an open message menu and a half-finished
   *  reply/edit both belong to a room that is no longer on screen. The edit's
   *  stashed draft is deliberately dropped rather than written back — the
   *  composer's own draft for this room was saved when it was typed. */
  private dropComposerContext(): void {
    this.closeMessageActions();
    this.replyingTo = null;
    this.editing = null;
    this.paintComposerContext();
  }

  private handleEscape(): void {
    const top = this.stack[this.stack.length - 1];
    if (!top || top.view === 'rooms' || !this.store) {
      this.hooks.onRequestClose();
      return;
    }
    this.goBack();
  }

  // ==================================================================
  // Status strip
  // ==================================================================

  private buildTopStrip(): void {
    const top = document.createElement('div');
    top.id = 'pa-mx-top';

    this.dotEl = document.createElement('span');
    this.dotEl.className = 'mx-dot';
    top.appendChild(this.dotEl);

    this.statusLabelEl = document.createElement('span');
    top.appendChild(this.statusLabelEl);

    this.retryLink = document.createElement('a');
    this.retryLink.href = '#';
    this.retryLink.textContent = 'Retry now';
    this.retryLink.className = 'mx-link';
    this.retryLink.style.display = 'none';
    this.retryLink.addEventListener('click', (ev) => {
      ev.preventDefault();
      this.store?.retryNow();
    });
    top.appendChild(this.retryLink);

    // Your own square doubles as the control for changing it — the panel has
    // no profile view to hang this off, and "click your own picture" is where
    // people look first. Uses its own <input type="file"> rather than the
    // composer's, so a half-finished message attachment can't be mistaken for
    // a new avatar.
    this.avatarInput = document.createElement('input');
    this.avatarInput.type = 'file';
    this.avatarInput.accept = 'image/png,image/jpeg,image/gif';
    this.avatarInput.hidden = true;
    this.avatarInput.addEventListener('change', () => {
      const file = this.avatarInput.files?.[0];
      this.avatarInput.value = '';
      if (file) void this.changeMyAvatar(file);
    });
    top.appendChild(this.avatarInput);

    this.meAvatarSlot = document.createElement('button');
    this.meAvatarSlot.className = 'mx-av-slot mx-me-av';
    this.meAvatarSlot.type = 'button';
    this.meAvatarSlot.title = 'Change your profile picture';
    this.meAvatarSlot.setAttribute('aria-label', 'Change your profile picture');
    this.meAvatarSlot.addEventListener('click', () => this.avatarInput.click());
    top.appendChild(this.meAvatarSlot);

    this.meEl = document.createElement('span');
    this.meEl.className = 'muted mx-me';
    top.appendChild(this.meEl);

    this.encBtn = document.createElement('button');
    this.encBtn.className = 'pa-b mx-encbtn';
    this.encBtn.textContent = '🔐';
    this.encBtn.setAttribute('aria-label', 'Encryption');
    this.encBtn.title = 'Encryption and keys';
    // Toggle, not push: this button is always visible, so pressing it a second time
    // has to be a way out of the view and not a no-op re-render.
    this.encBtn.addEventListener('click', () => {
      if (this.stack[this.stack.length - 1]?.view === 'encryption') this.goRoot();
      else this.pushRootView('encryption');
    });
    top.appendChild(this.encBtn);

    // In every build: the view behind it holds the typing-notification toggle,
    // which applies wherever the composer does. The DESKTOP-notification rows
    // inside it stay desktop-only (see buildNotificationsView) — there is no OS
    // notification to configure in the browser (bridge.ts's notifyDesktop is a
    // no-op), so those rows there would be a page of lies.
    this.notifyBtn = document.createElement('button');
    this.notifyBtn.className = 'pa-b mx-notifybtn';
    this.notifyBtn.textContent = '🔔';
    this.notifyBtn.setAttribute('aria-label', 'Notifications');
    this.notifyBtn.title = 'Notifications';
    // Same toggle behaviour as 🔐 — always visible, so a second press has to
    // be the way back out rather than a no-op re-render.
    this.notifyBtn.addEventListener('click', () => {
      if (this.stack[this.stack.length - 1]?.view === 'notifications') this.goRoot();
      else this.pushRootView('notifications');
    });
    top.appendChild(this.notifyBtn);

    const signOutBtn = document.createElement('button');
    signOutBtn.className = 'pa-b';
    signOutBtn.textContent = '⎋';
    signOutBtn.setAttribute('aria-label', 'Sign out');
    signOutBtn.title = 'Sign out — invalidates this session on the homeserver';
    signOutBtn.addEventListener('click', () => void this.handleSignOut());
    top.appendChild(signOutBtn);

    this.topEl = top;
    this.root.appendChild(top);

    this.cryptoWarnEl = document.createElement('div');
    this.cryptoWarnEl.className = 'mx-warn';
    this.cryptoWarnEl.style.display = 'none';
    this.cryptoWarnEl.style.margin = '0 0.6rem 0.5rem';
    this.root.appendChild(this.cryptoWarnEl);

    this.wipeWarnEl = document.createElement('div');
    this.wipeWarnEl.className = 'mx-warn';
    this.wipeWarnEl.style.display = 'none';
    this.wipeWarnEl.style.margin = '0 0.6rem 0.5rem';
    this.wipeWarnEl.textContent =
      'Some encryption data could not be deleted from this browser. Close other tabs of this app and reload.';
    this.root.appendChild(this.wipeWarnEl);
  }

  private renderTopStrip(): void {
    this.cryptoWarnEl.textContent = this.store?.cryptoWarning ?? '';
    this.cryptoWarnEl.style.display = this.store?.cryptoWarning ? '' : 'none';

    // Boot-gate transitions (a stored session that turns out to be
    // 'locked-out'/'wipe-pending', or a "Start fresh" that clears one) are
    // driven off the 'crypto' event, which is what renderTopStrip is called
    // from when that state changes — a full renderCurrent() picks up the new
    // section visibility; anything less would leave the wrong section shown.
    if (this.bootBlocked() !== this.bootGateActive) {
      this.renderCurrent();
      return;
    }

    if (!this.store) {
      this.topEl.style.display = 'none';
      return;
    }
    this.topEl.style.display = '';
    const status = this.store.status;
    let cls = 'mx-dot';
    if (status === 'connected') cls += ' live';
    else if (status === 'offline') cls += ' off';
    else if (status === 'syncing' || status === 'reconnecting' || status === 'connecting') cls += ' warn';
    this.dotEl.className = cls;
    this.statusLabelEl.textContent = this.store.statusLabel;
    this.retryLink.style.display = status === 'reconnecting' || status === 'offline' ? '' : 'none';
    this.meEl.textContent = this.store.userId;
    this.paintAvatarSlot(this.meAvatarSlot, this.store.userId, this.store.userId, this.store.myAvatarMxc);
    this.encBtn.classList.toggle('attn', this.store.cryptoState !== 'ready');
    // Painted here rather than only from the notifications view, so the bell
    // shows a muted app on first paint too — not just once you have opened it.
    this.paintNotifyBtn();
  }

  private paintNotifyBtn(): void {
    if (!this.notifyBtn) return;
    // The dimmed state means "this machine won't alert you" — a desktop-only
    // fact. In the browser `enabled` configures nothing, so the bell stays lit
    // whatever it says.
    const on = !isDesktop() || readNotifyPrefs().enabled;
    this.notifyBtn.classList.toggle('off', !on);
    this.notifyBtn.title = on ? 'Notifications' : 'Desktop notifications — off';
  }

  /** `store.logout()` ends by emitting 'loggedOut', which `handleLoggedOut` (subscribed in
   *  `startStoreFromSession`) handles synchronously — clearing the session, tearing the store down
   *  (nulling `this.store`), resetting the nav stack and, per requirement F, turning a failed wipe
   *  into the persistent `wipeWarnEl` banner off `store.lastWipeFailed`. This method therefore only
   *  owns the confirmation prompt; it must never read `this.store` after the `await` below, since
   *  that handler already ran by the time it resolves. */
  private async handleSignOut(): Promise<void> {
    if (!this.store) return;
    const ok = await confirmDialog(
      "Sign out of Matrix? This deletes this device's encryption keys from this browser. Without a recovery key or an exported key file you will not be able to read old encrypted messages here again.",
      { danger: true, confirmLabel: 'Sign out' },
    );
    if (!ok) return;
    try {
      await this.store.logout();
    } catch {
      /* best effort — the 'loggedOut' handler already ran regardless */
    }
  }

  // ==================================================================
  // login view
  // ==================================================================

  private buildLoginView(): void {
    const section = document.createElement('section');
    section.dataset.view = 'login';

    const form = document.createElement('div');
    this.loginFormEl = form;

    const hsLbl = document.createElement('div');
    hsLbl.className = 'grouplbl';
    hsLbl.textContent = 'HOMESERVER';
    form.appendChild(hsLbl);

    this.hsInput = document.createElement('input');
    this.hsInput.className = 'pa-input';
    this.hsInput.id = 'pa-mx-hs';
    this.hsInput.placeholder = 'https://matrix.org';
    this.hsInput.spellcheck = false;
    form.appendChild(this.hsInput);

    const hsHint = document.createElement('div');
    hsHint.className = 'muted';
    hsHint.textContent = "Enter your homeserver's address. HTTPS required.";
    form.appendChild(hsHint);

    this.loginHintEl = document.createElement('div');
    this.loginHintEl.className = 'muted';
    this.loginHintEl.style.display = 'none';
    form.appendChild(this.loginHintEl);

    const acctLbl = document.createElement('div');
    acctLbl.className = 'grouplbl';
    acctLbl.textContent = 'ACCOUNT';
    form.appendChild(acctLbl);

    this.userInput = document.createElement('input');
    this.userInput.className = 'pa-input';
    this.userInput.placeholder = 'user';
    this.userInput.autocomplete = 'username';
    form.appendChild(this.userInput);

    this.pwInput = document.createElement('input');
    this.pwInput.className = 'pa-input';
    this.pwInput.type = 'password';
    this.pwInput.placeholder = 'password';
    this.pwInput.autocomplete = 'current-password';
    form.appendChild(this.pwInput);

    this.signinBtn = document.createElement('button');
    this.signinBtn.className = 'pa-b primary wide';
    this.signinBtn.textContent = 'Sign in';
    this.signinBtn.addEventListener('click', () => void this.handleLoginSubmit());
    form.appendChild(this.signinBtn);

    section.appendChild(form);

    this.loginSsoEl = document.createElement('div');
    this.loginSsoEl.style.display = 'none';
    const ssoMsg = document.createElement('div');
    ssoMsg.className = 'muted';
    ssoMsg.textContent = 'This homeserver requires single sign-on, which this client does not support yet.';
    this.loginSsoEl.appendChild(ssoMsg);
    const ssoBack = document.createElement('button');
    ssoBack.className = 'pa-b';
    ssoBack.textContent = 'Try a different homeserver';
    ssoBack.addEventListener('click', () => {
      this.loginSsoEl.style.display = 'none';
      this.loginFormEl.style.display = '';
    });
    this.loginSsoEl.appendChild(ssoBack);
    section.appendChild(this.loginSsoEl);

    this.loginErrEl = document.createElement('div');
    this.loginErrEl.className = 'mx-err';
    this.loginErrEl.style.display = 'none';
    section.appendChild(this.loginErrEl);

    this.loginStartFreshBtn = document.createElement('button');
    this.loginStartFreshBtn.className = 'pa-b primary wide';
    this.loginStartFreshBtn.textContent = 'Start fresh';
    this.loginStartFreshBtn.style.display = 'none';
    this.loginStartFreshBtn.addEventListener('click', () => {
      this.store?.startFresh();
    });
    section.appendChild(this.loginStartFreshBtn);

    this.loginStartFreshHintEl = document.createElement('div');
    this.loginStartFreshHintEl.className = 'mx-hint';
    this.loginStartFreshHintEl.style.display = 'none';
    this.loginStartFreshHintEl.textContent =
      'Start fresh — this device gets new encryption keys. Old messages need your recovery key or an exported key file.';
    section.appendChild(this.loginStartFreshHintEl);

    const scheduleDiscover = () => {
      if (this.loginDiscoverTimer !== undefined) clearTimeout(this.loginDiscoverTimer);
      this.loginDiscoverTimer = window.setTimeout(() => void this.runLoginDiscover(), 300);
    };
    this.hsInput.addEventListener('blur', scheduleDiscover);
    this.hsInput.addEventListener('change', scheduleDiscover);
    const submitOnEnter = (ev: KeyboardEvent): void => {
      if (ev.key === 'Enter') {
        ev.preventDefault();
        void this.handleLoginSubmit();
      }
    };
    this.hsInput.addEventListener('keydown', submitOnEnter);
    this.userInput.addEventListener('keydown', submitOnEnter);
    this.pwInput.addEventListener('keydown', submitOnEnter);

    this.sections.set('login', section);
    this.root.appendChild(section);
  }

  private async runLoginDiscover(): Promise<void> {
    const raw = this.hsInput.value.trim();
    this.loginHintEl.style.display = 'none';
    if (!raw) return;
    this.loginDiscoverAbort?.abort();
    const ac = new AbortController();
    this.loginDiscoverAbort = ac;
    try {
      const result = await discoverHomeserver(raw, ac.signal);
      if (ac.signal.aborted) return;
      if (result.ok) {
        const typed = normaliseHomeserverUrl(raw);
        if (typed.ok && typed.origin !== result.origin) {
          this.loginHintEl.textContent = `Signing in to ${result.origin}`;
          this.loginHintEl.style.display = '';
        }
      }
    } catch {
      /* leave the typed value; used verbatim on submit */
    }
  }

  private hostFromInput(raw: string): string {
    const trimmed = raw.trim();
    try {
      const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
      return new URL(withScheme).host || trimmed;
    } catch {
      return trimmed;
    }
  }

  private setLoginBusy(busy: boolean): void {
    this.loginBusy = busy;
    this.hsInput.disabled = busy;
    this.userInput.disabled = busy;
    this.pwInput.disabled = busy;
    this.signinBtn.disabled = busy;
    this.signinBtn.textContent = busy ? 'Signing in…' : 'Sign in';
  }

  private async handleLoginSubmit(): Promise<void> {
    if (this.loginBusy) return;
    const raw = this.hsInput.value;
    const host = this.hostFromInput(raw);
    this.loginErrEl.style.display = 'none';
    this.setLoginBusy(true);
    try {
      const result = await discoverHomeserver(raw);
      if (!result.ok) {
        this.loginErrEl.textContent = result.error;
        this.loginErrEl.style.display = '';
        return;
      }
      const flows = await probeLoginFlows(result.baseUrl, result.origin);
      if (!flows.passwordSupported) {
        this.loginFormEl.style.display = 'none';
        this.loginSsoEl.style.display = '';
        return;
      }
      const session = await loginWithPassword({
        baseUrl: result.baseUrl,
        origin: result.origin,
        user: this.userInput.value,
        password: this.pwInput.value,
        // Only a soft-logout re-login reuses a device id (see
        // handleLoggedOut); a fresh login never does — rebinding a device id
        // to a new crypto identity after a wipe is exactly the "changed keys
        // under a stable id" pattern other clients flag as a security
        // warning.
        deviceId: this.pendingReloginDeviceId,
      });
      this.pendingReloginDeviceId = undefined;
      saveSession(this.hooks.paUserId, session);
      this.startStoreFromSession(session);
      this.pwInput.value = '';
      this.stack = [{ view: 'rooms' }];
      this.renderCurrent();
      if (this.pendingDmMxid) {
        const mxid = this.pendingDmMxid;
        this.pendingDmMxid = null;
        void this.chooseDmTarget(mxid);
      }
    } catch (e) {
      this.loginErrEl.textContent = describeError(e, host);
      this.loginErrEl.style.display = '';
    } finally {
      this.setLoginBusy(false);
    }
  }

  // ==================================================================
  // rooms view
  // ==================================================================

  private buildRoomsView(): void {
    const section = document.createElement('section');
    section.dataset.view = 'rooms';

    this.roomsSegEl = document.createElement('div');
    this.roomsSegEl.className = 'pa-seg';
    section.appendChild(this.roomsSegEl);

    this.roomsFilterInput = document.createElement('input');
    this.roomsFilterInput.className = 'pa-input mx-filter';
    this.roomsFilterInput.placeholder = 'Filter rooms…';
    this.roomsFilterInput.addEventListener('input', () => {
      this.roomsFilterText = this.roomsFilterInput.value;
      this.renderRoomsView();
    });
    section.appendChild(this.roomsFilterInput);

    this.roomsListEl = document.createElement('div');
    this.roomsListEl.id = 'pa-mx-list';
    section.appendChild(this.roomsListEl);

    const foot = document.createElement('div');
    foot.className = 'mx-rooms-foot';
    const newChatBtn = document.createElement('button');
    newChatBtn.className = 'pa-b wide primary';
    newChatBtn.textContent = '✚ New chat';
    newChatBtn.addEventListener('click', () => this.pushRootView('newdm'));
    const secondaryRow = document.createElement('div');
    secondaryRow.className = 'mx-rooms-foot-row';
    const newGroupBtn = document.createElement('button');
    newGroupBtn.className = 'pa-b';
    newGroupBtn.textContent = '⊞ New group';
    newGroupBtn.addEventListener('click', () => this.pushRootView('newgroup'));
    const joinBtn = document.createElement('button');
    joinBtn.className = 'pa-b';
    joinBtn.textContent = '⇥ Join room';
    joinBtn.addEventListener('click', () => this.pushRootView('join'));
    secondaryRow.append(newGroupBtn, joinBtn);
    foot.append(newChatBtn, secondaryRow);
    section.appendChild(foot);

    this.sections.set('rooms', section);
    this.root.appendChild(section);
  }

  private classify(rooms: MxRoom[]): { people: MxRoom[]; groups: MxRoom[]; invites: MxRoom[] } {
    const invites: MxRoom[] = [];
    const people: MxRoom[] = [];
    const groups: MxRoom[] = [];
    for (const r of rooms) {
      if (r.membership === 'invite') invites.push(r);
      else if (r.isDirect) people.push(r);
      else groups.push(r);
    }
    return { people, groups, invites };
  }

  /** True when an encrypted room's lock marker should read as a warning
   *  rather than the normal "this is protected" state — this device cannot
   *  currently decrypt (design doc §4.5). */
  private cryptoLockWarn(): boolean {
    const state = this.store?.cryptoState;
    return state === 'locked' || state === 'unavailable';
  }

  private matchesFilter(r: MxRoom, term: string): boolean {
    if (!term) return true;
    // room.name already folds in the SDK's own heroes calculation for
    // unnamed DMs/groups (design doc §3.2) — there is no separate heroes
    // list left to match against.
    return r.name.toLowerCase().includes(term.toLowerCase());
  }

  private sortRooms(list: MxRoom[]): MxRoom[] {
    return [...list].sort((a, b) => {
      const au = a.unread > 0 ? 1 : 0;
      const bu = b.unread > 0 ? 1 : 0;
      if (au !== bu) return bu - au;
      return b.lastTs - a.lastTs;
    });
  }

  private renderRoomsView(): void {
    if (!this.store) return;
    const all = this.store.rooms();
    const { people, groups, invites } = this.classify(all);
    if (invites.length === 0 && this.roomsTab === 'invites') this.roomsTab = 'people';

    this.roomsSegEl.innerHTML = '';
    const mkSeg = (tab: RoomsTab, label: string, count: number) => {
      const seg = document.createElement('button');
      seg.className = 'seg' + (this.roomsTab === tab ? ' on' : '');
      seg.textContent = `${label} (${count})`;
      seg.addEventListener('click', () => {
        this.roomsTab = tab;
        this.renderRoomsView();
      });
      return seg;
    };
    this.roomsSegEl.appendChild(mkSeg('people', 'People', people.length));
    this.roomsSegEl.appendChild(mkSeg('groups', 'Groups', groups.length));
    if (invites.length > 0) this.roomsSegEl.appendChild(mkSeg('invites', 'Invites', invites.length));

    const term = this.roomsFilterText;
    const pool = this.roomsTab === 'people' ? people : this.roomsTab === 'groups' ? groups : invites;
    const filtered = this.sortRooms(pool.filter((r) => this.matchesFilter(r, term)));

    this.roomsListEl.innerHTML = '';

    if (this.store.status === 'syncing' && all.length === 0) {
      for (let i = 0; i < 3; i++) {
        const skel = document.createElement('div');
        skel.className = 'pa-list-row mx-room';
        skel.style.opacity = '0.4';
        this.roomsListEl.appendChild(skel);
      }
      return;
    }

    if (filtered.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'mx-notice';
      if (term) {
        empty.textContent = `No rooms match "${term}".`;
      } else if (pool.length === 0 && this.roomsTab === 'people') {
        empty.textContent = 'No rooms yet.';
        const btn = document.createElement('button');
        btn.className = 'pa-b wide primary';
        btn.textContent = '✚ New chat';
        btn.addEventListener('click', () => this.pushRootView('newdm'));
        this.roomsListEl.append(empty, btn);
        return;
      } else {
        empty.textContent = 'No rooms yet.';
      }
      this.roomsListEl.appendChild(empty);
      return;
    }

    for (const room of filtered) {
      this.roomsListEl.appendChild(this.buildRoomRow(room));
      const err = this.inviteError.get(room.roomId);
      if (err) {
        const e = document.createElement('div');
        e.className = 'mx-err';
        e.textContent = err;
        this.roomsListEl.appendChild(e);
      }
    }
  }

  private buildRoomRow(room: MxRoom): HTMLElement {
    const row = document.createElement('div');
    row.className = 'pa-list-row mx-room';
    if (room.unread > 0) row.classList.add('unread');
    if (this.openRoomId === room.roomId) row.classList.add('here');

    row.appendChild(mkAvatar(room.roomId, room.name, this.picture(room.avatarMxc)));

    const main = document.createElement('div');
    main.className = 'mx-room-main';

    const nm = document.createElement('div');
    nm.className = 'nm';
    nm.textContent = room.name;
    nm.title = room.name;
    nm.dir = 'auto';
    main.appendChild(nm);

    const prev = document.createElement('div');
    prev.className = 'mx-prev';
    prev.textContent = room.preview;
    main.appendChild(prev);

    row.appendChild(main);

    const small = document.createElement('small');
    if (room.encrypted) {
      small.textContent = '🔒';
      small.className = this.cryptoLockWarn() ? 'mx-lock warn' : 'mx-lock';
      small.title = this.cryptoLockWarn()
        ? "End-to-end encrypted — this device can't read it yet"
        : 'End-to-end encrypted';
    } else {
      small.textContent = room.lastTs ? fmtRelative(room.lastTs) : '';
    }
    row.appendChild(small);

    if (room.membership === 'invite') {
      const busy = this.inviteBusy.has(room.roomId);
      const acceptBtn = document.createElement('button');
      acceptBtn.className = 'pa-b primary';
      acceptBtn.textContent = 'Accept';
      acceptBtn.disabled = busy;
      acceptBtn.addEventListener('click', (ev) => {
        ev.stopPropagation();
        void this.handleAcceptInvite(room.roomId);
      });
      const declineBtn = document.createElement('button');
      declineBtn.className = 'pa-b danger';
      declineBtn.textContent = 'Decline';
      declineBtn.disabled = busy;
      declineBtn.addEventListener('click', (ev) => {
        ev.stopPropagation();
        void this.handleDeclineInvite(room.roomId);
      });
      row.append(acceptBtn, declineBtn);
    } else {
      const badge = document.createElement('div');
      badge.className = 'mx-badge' + (room.highlight > 0 ? ' hl' : '');
      badge.textContent = String(room.unread);
      badge.style.display = room.unread > 0 ? '' : 'none';
      badge.setAttribute('aria-label', `${room.unread} unread`);
      row.appendChild(badge);
      row.tabIndex = 0;
      row.setAttribute('role', 'button');
      row.addEventListener('click', () => this.openRoomView(room.roomId));
      row.addEventListener('keydown', (ev) => {
        if (ev.key === 'Enter' || ev.key === ' ') {
          ev.preventDefault();
          this.openRoomView(room.roomId);
        }
      });
    }
    return row;
  }

  private async handleAcceptInvite(roomId: string): Promise<void> {
    if (!this.store) return;
    this.inviteBusy.add(roomId);
    this.inviteError.delete(roomId);
    this.renderRoomsView();
    try {
      await this.store.acceptInvite(roomId);
    } catch (e) {
      this.inviteError.set(roomId, this.errText(e));
    } finally {
      this.inviteBusy.delete(roomId);
      this.renderRoomsView();
    }
  }

  private async handleDeclineInvite(roomId: string): Promise<void> {
    if (!this.store) return;
    this.inviteBusy.add(roomId);
    this.inviteError.delete(roomId);
    this.renderRoomsView();
    try {
      await this.store.declineInvite(roomId);
    } catch (e) {
      this.inviteError.set(roomId, this.errText(e));
    } finally {
      this.inviteBusy.delete(roomId);
      this.renderRoomsView();
    }
  }

  // ==================================================================
  // room view
  // ==================================================================

  private buildRoomView(): void {
    const section = document.createElement('section');
    section.dataset.view = 'room';

    // The room view is the one section that lays out sideways: the rail down
    // the left edge, everything that was here before in a column beside it.
    this.railEl = document.createElement('nav');
    this.railEl.className = 'mx-rail';
    this.railEl.setAttribute('aria-label', 'Recent chats');
    section.appendChild(this.railEl);

    const col = document.createElement('div');
    col.className = 'mx-room-col';
    section.appendChild(col);

    const subhead = document.createElement('div');
    subhead.className = 'mx-subhead';
    const back = document.createElement('button');
    back.className = 'pa-b';
    back.textContent = '◀';
    back.addEventListener('click', () => this.goBack());
    subhead.appendChild(back);

    // A button, not a span: clicking the chat's picture opens it full-size in
    // the lightbox. Disabled (renderRoomView) when the chat has no picture —
    // an initials square has nothing larger to show.
    this.roomAvatarSlot = document.createElement('button');
    this.roomAvatarSlot.type = 'button';
    this.roomAvatarSlot.className = 'mx-av-slot mx-av-btn';
    this.roomAvatarSlot.addEventListener('click', () => void this.openRoomAvatar());
    subhead.appendChild(this.roomAvatarSlot);

    this.roomThreadTagEl = document.createElement('span');
    this.roomThreadTagEl.className = 'mx-thread-tag';
    this.roomThreadTagEl.textContent = '🧵';
    this.roomThreadTagEl.title = 'You are in a thread';
    this.roomThreadTagEl.setAttribute('aria-label', 'Thread');
    this.roomThreadTagEl.style.display = 'none';
    subhead.appendChild(this.roomThreadTagEl);

    this.roomNameEl = document.createElement('span');
    this.roomNameEl.className = 'mx-room-name';
    subhead.appendChild(this.roomNameEl);

    this.roomLockEl = document.createElement('span');
    this.roomLockEl.textContent = '🔒';
    this.roomLockEl.style.display = 'none';
    subhead.appendChild(this.roomLockEl);

    this.roomThreadsBtn = document.createElement('button');
    this.roomThreadsBtn.className = 'pa-b';
    this.roomThreadsBtn.textContent = '🧵';
    this.roomThreadsBtn.title = 'Threads in this chat';
    this.roomThreadsBtn.setAttribute('aria-label', 'Threads in this chat');
    this.roomThreadsBtn.addEventListener('click', () => this.openThreadsView());
    subhead.appendChild(this.roomThreadsBtn);

    this.roomMediaBtn = document.createElement('button');
    this.roomMediaBtn.className = 'pa-b';
    this.roomMediaBtn.textContent = '🖼';
    this.roomMediaBtn.title = 'Pictures & files shared in this chat';
    this.roomMediaBtn.setAttribute('aria-label', 'Pictures and files shared in this chat');
    this.roomMediaBtn.addEventListener('click', () => this.openMediaView());
    subhead.appendChild(this.roomMediaBtn);

    this.roomMembersBtn = document.createElement('button');
    this.roomMembersBtn.className = 'pa-b';
    this.roomMembersBtn.addEventListener('click', () => this.openMembersView());
    subhead.appendChild(this.roomMembersBtn);

    col.appendChild(subhead);

    this.roomNoticeEl = document.createElement('div');
    this.roomNoticeEl.className = 'mx-notice';
    this.roomNoticeEl.style.display = 'none';
    col.appendChild(this.roomNoticeEl);

    const hooks: TimelineHooks = {
      onPaginate: () => {
        const rid = this.openRoomId;
        if (!rid) return;
        const tid = this.openThreadId;
        const load = tid ? this.store?.paginateThread(rid, tid) : this.store?.paginate(rid);
        load?.catch(() => {
          /* surfaced via store.timelineError()/threadError() in the next render */
        });
      },
      onRetry: (txnId) => {
        if (this.openRoomId) {
          this.store?.retrySend(this.openRoomId, txnId).catch(() => {
            /* the retried echo row goes back to .failed via the store's own state */
          });
        }
      },
      displayName: (userId) => (this.openRoomId && this.store ? this.store.displayName(this.openRoomId, userId) : userId),
      avatarOf: (userId) =>
        this.picture(this.openRoomId && this.store ? this.store.memberAvatarMxc(this.openRoomId, userId) : null),
      // Both 'unlock' (no key yet) and 'verify' (sender only shares with
      // verified devices) point at the same place today — the Encryption
      // view is where both a 4S unlock and device verification live.
      onDecryptAction: () => {
        this.pushRootView('encryption');
        this.encryptionView.focusUnlock();
      },
      loadImage: (content) =>
        this.store ? this.store.imageUrl(content) : Promise.reject(new Error('Not connected.')),
      onOpenImage: (content, url) => openImageViewer(content.body, url),
      loadFile: (content) =>
        this.store ? this.store.attachmentUrl(content) : Promise.reject(new Error('Not connected.')),
      onSaveFile: (content, url) => saveBlobUrl(content.body, url),
      onOpenActions: (ev, anchor) => this.openMessageActions(ev, anchor),
      onToggleReaction: (eventId, key) => void this.handleToggleReaction(eventId, key),
      onJumpToReply: (eventId) => {
        if (!this.timelineView.revealEvent(eventId)) {
          this.toast("That message isn't loaded — load earlier messages to reach it.");
        }
      },
      onOpenThread: (rootId) => this.openThreadView(rootId),
    };
    this.timelineView = new TimelineView(hooks);
    col.appendChild(this.timelineView.el);

    this.typingEl = document.createElement('div');
    this.typingEl.className = 'mx-typing';
    col.appendChild(this.typingEl);

    const composer = document.createElement('div');
    composer.className = 'mx-composer';
    this.composerTextarea = document.createElement('textarea');
    this.composerTextarea.className = 'pa-input mx-input';
    this.composerTextarea.rows = 1;
    this.composerTextarea.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter' && !ev.shiftKey) {
        ev.preventDefault();
        ev.stopPropagation();
        this.sendComposer();
      } else if (ev.key === 'Escape') {
        ev.preventDefault();
        ev.stopPropagation();
        // Escape backs out of one thing at a time: first the reply/edit the
        // composer is in the middle of, and only then the composer itself.
        if (this.replyingTo || this.editing) this.cancelComposerContext();
        else this.composerTextarea.blur();
      }
    });
    this.composerTextarea.addEventListener('input', () => {
      this.autoGrow(this.composerTextarea);
      this.saveDraft();
      // Every keystroke reports, the store coalesces (see notifyTyping). An
      // emptied box withdraws right away; an abandoned draft is left to the
      // advertisement's own server-side timeout.
      const rid = this.openRoomId;
      if (rid) this.store?.notifyTyping(rid, this.composerTextarea.value.length > 0);
    });
    // A picture pasted into the composer is the fastest path there is for the
    // screenshot this feature exists for, so it gets the same treatment as the
    // 📎 button — see handlePickedFiles for the shared validation and the
    // confirmation step.
    this.composerTextarea.addEventListener('paste', (ev) => {
      const files = filesFromDataTransfer(ev.clipboardData);
      if (files.length === 0) return;
      ev.preventDefault();
      void this.handlePickedFiles(files);
    });

    // `<input type="file">` (not Mumble's Electron-only native dialog) so this
    // behaves identically in Chrome, Firefox and the desktop app — same call
    // this file's key-file import already makes.
    this.attachInput = document.createElement('input');
    this.attachInput.type = 'file';
    // No `accept`: any file can be sent. PNG/JPEG/GIF become a picture row,
    // everything else an `m.file` the reader downloads (media.ts decides from
    // the bytes, so the filter would only ever be a lie about what is allowed).
    this.attachInput.multiple = false;
    this.attachInput.hidden = true;
    this.attachInput.addEventListener('change', () => {
      const files = Array.from(this.attachInput.files ?? []);
      // Reset first: picking the same file twice in a row fires no 'change'
      // event otherwise, which reads to the user as the button being broken.
      this.attachInput.value = '';
      void this.handlePickedFiles(files);
    });

    this.attachBtn = document.createElement('button');
    this.attachBtn.className = 'pa-b';
    this.attachBtn.textContent = '📎';
    this.attachBtn.setAttribute('aria-label', 'Send a file');
    this.attachBtn.title = 'Send a file — or paste/drop one into the message box';
    this.attachBtn.addEventListener('click', () => this.attachInput.click());

    this.emojiBtn = document.createElement('button');
    this.emojiBtn.className = 'pa-b';
    this.emojiBtn.textContent = '😊';
    this.emojiBtn.setAttribute('aria-label', 'Insert an emoji');
    this.emojiBtn.title = 'Insert an emoji';
    this.emojiBtn.addEventListener('click', () => this.toggleComposerEmoji());

    this.composerSendBtn = document.createElement('button');
    this.composerSendBtn.className = 'pa-b primary';
    this.composerSendBtn.textContent = '➤';
    this.composerSendBtn.addEventListener('click', () => this.sendComposer());
    this.composerDisabledEl = document.createElement('div');
    this.composerDisabledEl.className = 'muted';
    this.composerDisabledEl.textContent = "Encryption isn't available in this browser session — reload to try again.";
    this.composerDisabledEl.style.display = 'none';
    this.uploadStatusEl = document.createElement('div');
    this.uploadStatusEl.className = 'mx-upload';
    this.uploadStatusEl.hidden = true;

    // "Replying to Alice: …" / "Editing your message". First child of the
    // composer so it sits above the text box (the composer wraps, and this row
    // takes the full basis).
    this.composerCtxEl = document.createElement('div');
    this.composerCtxEl.className = 'mx-ctx';
    this.composerCtxEl.hidden = true;
    this.composerCtxIconEl = document.createElement('span');
    this.composerCtxIconEl.className = 'mx-ctx-i';
    const ctxMain = document.createElement('div');
    ctxMain.className = 'mx-ctx-main';
    this.composerCtxWhoEl = document.createElement('span');
    this.composerCtxWhoEl.className = 'who';
    this.composerCtxWhatEl = document.createElement('span');
    this.composerCtxWhatEl.className = 'what';
    ctxMain.append(this.composerCtxWhoEl, this.composerCtxWhatEl);
    const ctxCancel = document.createElement('button');
    ctxCancel.className = 'pa-b';
    ctxCancel.textContent = '✕';
    ctxCancel.title = 'Cancel';
    ctxCancel.setAttribute('aria-label', 'Cancel');
    ctxCancel.addEventListener('click', () => this.cancelComposerContext());
    this.composerCtxEl.append(this.composerCtxIconEl, ctxMain, ctxCancel);

    // The action buttons stack vertically beside the input rather than lining
    // up after it, so the text box keeps the full remaining width.
    const composerBtns = document.createElement('div');
    composerBtns.className = 'mx-composer-btns';
    composerBtns.append(this.emojiBtn, this.attachBtn, this.composerSendBtn);
    composer.append(
      this.composerCtxEl,
      this.composerTextarea,
      composerBtns,
      this.attachInput,
      this.uploadStatusEl,
      this.composerDisabledEl,
    );
    col.appendChild(composer);

    // Drop anywhere in the room view, not just on the composer — a 26rem-wide
    // panel makes a composer-sized drop target genuinely fiddly.
    section.addEventListener('dragover', (ev) => {
      if (!hasFiles(ev.dataTransfer)) return;
      ev.preventDefault();
      if (ev.dataTransfer) ev.dataTransfer.dropEffect = 'copy';
      section.classList.add('mx-dropping');
    });
    section.addEventListener('dragleave', (ev) => {
      if (ev.relatedTarget instanceof Node && section.contains(ev.relatedTarget)) return;
      section.classList.remove('mx-dropping');
    });
    section.addEventListener('drop', (ev) => {
      // Unconditional: the browser's default action for a dropped file is to
      // navigate to it, which in the desktop shell means the app window
      // replaces itself with a picture and there is no back button.
      ev.preventDefault();
      section.classList.remove('mx-dropping');
      const files = filesFromDataTransfer(ev.dataTransfer);
      if (files.length > 0) void this.handlePickedFiles(files);
    });

    this.sections.set('room', section);
    this.root.appendChild(section);
  }

  /**
   * Draw the room view, for either a room's own timeline (`threadId` null) or
   * one thread inside it.
   *
   * The two differ in three places and nowhere else: what the header says, which
   * room-level side trips are offered (a thread is not the place to open the
   * member list — going back from one would land in the room and lose the
   * thread), and where the rows and their load state come from.
   */
  private renderRoomView(roomId: string, threadId: string | null): void {
    if (!this.store) return;
    const inThread = threadId !== null;
    const room = this.store.room(roomId);
    // The rail switches rooms, which from inside a thread would silently drop
    // the thread as well — so a thread gets the room's name in the header and no
    // rail at all.
    this.railEl.style.display = inThread ? 'none' : '';
    if (!inThread) this.renderRail(roomId);
    this.roomThreadTagEl.style.display = inThread ? '' : 'none';
    this.roomNameEl.textContent = room?.name ?? roomId;
    this.roomNameEl.title = inThread ? `Thread in ${room?.name ?? roomId}` : room?.name ?? roomId;
    this.paintAvatarSlot(this.roomAvatarSlot, roomId, room?.name ?? roomId, room?.avatarMxc ?? null);
    const hasAvatar = !!room?.avatarMxc;
    this.roomAvatarSlot.style.display = inThread ? 'none' : '';
    this.roomAvatarSlot.disabled = !hasAvatar;
    this.roomAvatarSlot.title = hasAvatar ? "View this chat's picture" : '';
    if (hasAvatar) this.roomAvatarSlot.setAttribute('aria-label', "View this chat's picture");
    else this.roomAvatarSlot.removeAttribute('aria-label');
    this.roomMediaBtn.style.display = inThread ? 'none' : '';
    this.roomMembersBtn.style.display = inThread ? 'none' : '';

    this.roomThreadsBtn.style.display = inThread ? 'none' : '';
    // A thread's unread count is its own and reading the room never clears it,
    // so without a mark here the only sign of one is a room badge that refuses
    // to go away for no visible reason.
    if (!inThread) {
      const { unread, highlight } = this.store.threadUnread(roomId);
      this.roomThreadsBtn.classList.toggle('mx-has-unread', unread > 0);
      this.roomThreadsBtn.classList.toggle('hl', highlight > 0);
      const label =
        unread > 0 ? `Threads in this chat — ${unread} unread` : 'Threads in this chat';
      this.roomThreadsBtn.title = label;
      this.roomThreadsBtn.setAttribute('aria-label', label);
    }

    const nowEncrypted = !!room?.encrypted;
    const warnActive = this.cryptoLockWarn();
    this.roomLockEl.style.display = nowEncrypted ? '' : 'none';
    this.roomLockEl.classList.toggle('warn', nowEncrypted && warnActive);
    this.roomLockEl.title = warnActive
      ? "End-to-end encrypted — this device can't read it yet"
      : 'End-to-end encrypted';
    this.roomMembersBtn.textContent = `👥 ${room?.joinedCount ?? 0}`;

    // A one-shot "this room is now encrypted" notice (design doc §4.6) takes
    // priority over the "something's wrong" states below — both only fire
    // when we have already seen this room with encrypted:false at least
    // once, so opening an already-encrypted room for the first time never
    // shows it.
    const wasEncrypted = this.lastEncryptedState.get(roomId) ?? false;
    const justEnabled = nowEncrypted && !wasEncrypted && this.lastEncryptedState.has(roomId);
    this.lastEncryptedState.set(roomId, nowEncrypted);

    let warning: string | null = null;
    this.roomNoticeEl.replaceChildren();
    if (justEnabled) {
      this.roomNoticeEl.textContent = 'This room is now end-to-end encrypted.';
      this.roomNoticeEl.style.display = '';
    } else if (nowEncrypted && this.store.cryptoState === 'locked') {
      warning = 'Unlock encryption to read older messages.';
      this.roomNoticeEl.append('Unlock encryption to read older messages. ');
      const link = document.createElement('span');
      link.className = 'mx-link';
      link.textContent = 'Unlock';
      link.tabIndex = 0;
      link.setAttribute('role', 'button');
      const openEnc = () => {
        this.pushRootView('encryption');
        this.encryptionView.focusUnlock();
      };
      link.addEventListener('click', openEnc);
      link.addEventListener('keydown', (ev) => {
        if (ev.key === 'Enter' || ev.key === ' ') {
          ev.preventDefault();
          openEnc();
        }
      });
      this.roomNoticeEl.appendChild(link);
      this.roomNoticeEl.style.display = '';
    } else if (nowEncrypted && this.store.cryptoState === 'unavailable') {
      warning = "Encryption isn't available in this browser session.";
      this.roomNoticeEl.textContent = warning;
      this.roomNoticeEl.style.display = '';
    } else {
      this.roomNoticeEl.style.display = 'none';
    }

    const composerDisabled = this.store.cryptoState === 'unavailable';
    // Nothing can be written in this session, so a pending reply/edit is a
    // promise the composer can't keep.
    if (composerDisabled && (this.replyingTo || this.editing)) this.dropComposerContext();
    this.paintComposerContext();
    this.composerCtxEl.style.display = composerDisabled ? 'none' : '';
    this.composerTextarea.style.display = composerDisabled ? 'none' : '';
    this.composerSendBtn.style.display = composerDisabled ? 'none' : '';
    // Attachments go out the same door as text: if this session can't send a
    // message it must not be able to send a file either — otherwise the
    // 📎 button is a live control sitting next to "sending is unavailable".
    this.attachBtn.style.display = composerDisabled ? 'none' : '';
    // Same for 😊 — it only writes into a composer that isn't there.
    this.emojiBtn.style.display = composerDisabled ? 'none' : '';
    this.composerDisabledEl.style.display = composerDisabled ? '' : 'none';

    // Typing is advertised per room, not per thread (Matrix has no thread-scoped
    // m.typing), so inside a thread the strip keeps reporting the whole room.
    this.paintTyping(roomId);

    const events = threadId ? this.store.threadTimeline(roomId, threadId) : this.store.timeline(roomId);
    this.timelineView.render(events, {
      warning,
      atStart: threadId ? this.store.atThreadStart(roomId, threadId) : this.store.atStart(roomId),
      loading: threadId ? this.store.loadingThread(threadId) : this.store.loadingTimeline(roomId),
      error: threadId ? this.store.threadError(threadId) : this.store.timelineError(roomId),
      receipts: threadId
        ? this.store.threadReadReceipts(roomId, threadId)
        : this.store.readReceipts(roomId),
      selfUserId: this.store.userId,
      inThread: threadId !== null,
    });

    if (!document.hidden && this.timelineView.isAtBottom()) {
      // A thread's receipt is its own: reading the room does not clear a thread,
      // and reading a thread does not clear the room.
      if (threadId) this.store.markThreadRead(roomId, threadId);
      else this.store.markRead(roomId);
    }
  }

  /** The "Alice is typing…" strip. Names come straight from the membership
   *  events (remote text), so `textContent` only — same rule as every other
   *  row here. Above two names the list stops being readable at this panel
   *  width, so it collapses to a count, same as Element. */
  private paintTyping(roomId: string): void {
    const names = this.store?.typingIn(roomId) ?? [];
    let text = '';
    if (names.length === 1) text = `${names[0]} is typing…`;
    else if (names.length === 2) text = `${names[0]} and ${names[1]} are typing…`;
    else if (names.length > 2) text = `${names.length} people are typing…`;
    this.typingEl.textContent = text;
  }

  /** How many chats the fast-switch rail keeps. A rail is a shortcut to the
   *  conversations that are live right now, not a second room list — past
   *  about a screenful of squares in a 26rem column, ◀ and the real list
   *  (which has names, previews and a filter) is the faster way to find one. */
  private static readonly RAIL_MAX = 10;

  /** The rail: joined chats — people and groups alike, invites excluded since
   *  there is nothing to switch *to* until one is accepted — newest message
   *  first, avatars only with the name on the tooltip.
   *
   *  The open room is always among them even when it has dropped past the cap,
   *  because a rail that doesn't show where you are reads as broken (and its
   *  ▍marker would be nowhere). */
  private renderRail(openRoomId: string): void {
    if (!this.store) return;
    const joined = this.store.rooms().filter((r) => r.membership === 'join');
    joined.sort((a, b) => b.lastTs - a.lastTs);
    const max = MatrixUI.RAIL_MAX;
    let shown = joined.slice(0, max);
    if (!shown.some((r) => r.roomId === openRoomId)) {
      const open = joined.find((r) => r.roomId === openRoomId);
      // Replaces the oldest square rather than growing the rail, so the cap
      // holds and the ones above keep their newest-first order.
      if (open) shown = [...shown.slice(0, max - 1), open];
    }
    // One square is the room you are already in — nothing to switch to, and in
    // a 20rem column the rail's width is worth more than that.
    this.railEl.hidden = shown.length < 2;

    const key = shown
      .map((r) => [r.roomId, r.name, r.avatarMxc ?? '', r.unread, r.highlight, r.roomId === openRoomId].join('\u0001'))
      .join('\n');
    if (this.railKey === key) return;
    this.railKey = key;
    this.railEl.replaceChildren(...shown.map((r) => this.buildRailButton(r, openRoomId)));
  }

  private buildRailButton(room: MxRoom, openRoomId: string): HTMLButtonElement {
    const here = room.roomId === openRoomId;
    const btn = document.createElement('button');
    btn.className = 'mx-rail-b';
    if (here) {
      btn.classList.add('on');
      btn.setAttribute('aria-current', 'true');
    }
    if (room.unread > 0) btn.classList.add('unread');

    // Remote text, so title/aria-label only — never interpolated into markup.
    // The count rides along on the tooltip because the square itself only has
    // room to say *that* something arrived, not how much.
    const label = room.unread > 0 ? `${room.name} — ${room.unread} unread` : room.name;
    btn.title = label;
    btn.setAttribute('aria-label', label);

    const av = mkAvatar(room.roomId, room.name, this.picture(room.avatarMxc));
    // mkAvatar titles the square itself; the button's own title would never
    // win under the pointer, so both carry the same text.
    av.title = label;
    btn.appendChild(av);

    if (room.unread > 0) {
      const dot = document.createElement('span');
      dot.className = 'mx-rail-dot' + (room.highlight > 0 ? ' hl' : '');
      btn.appendChild(dot);
    }

    btn.addEventListener('click', () => {
      if (!here) this.openRoomView(room.roomId);
    });
    return btn;
  }

  private autoGrow(ta: HTMLTextAreaElement): void {
    ta.rows = 1;
    ta.style.height = 'auto';
    const cs = getComputedStyle(ta);
    const lineHeight = parseFloat(cs.lineHeight) || 20;
    const rows = Math.min(5, Math.max(1, Math.round(ta.scrollHeight / lineHeight)));
    ta.rows = rows;
  }

  /** Where a draft is parked. A thread gets its own slot: half a sentence
   *  typed into a thread is not a draft for the room it hangs off, and pasting
   *  it into the wrong one is the sort of mistake a chat client does not get to
   *  take back. */
  private draftKey(roomId: string, threadId: string | null): string {
    return threadId ? `pa-mx-draft:${roomId}:${threadId}` : `pa-mx-draft:${roomId}`;
  }

  private saveDraft(): void {
    const rid = this.openRoomId;
    if (!rid) return;
    // While an edit has the box, what is in it is that message's text, not a
    // draft for this room — the real draft is parked in `editing.stashedDraft`
    // and must survive both cancelling and saving.
    if (this.editing) return;
    try {
      const key = this.draftKey(rid, this.openThreadId);
      const v = this.composerTextarea.value;
      if (v) sessionStorage.setItem(key, v);
      else sessionStorage.removeItem(key);
    } catch {
      /* ignore */
    }
  }

  /** Put whatever was last typed for the open room-or-thread back in the box.
   *  Called from every path that changes which of the two the composer is
   *  pointed at, so a switch can never leave the previous one's text behind. */
  private loadDraft(): void {
    const rid = this.openRoomId;
    try {
      this.composerTextarea.value = rid
        ? sessionStorage.getItem(this.draftKey(rid, this.openThreadId)) ?? ''
        : '';
    } catch {
      this.composerTextarea.value = '';
    }
    this.autoGrow(this.composerTextarea);
  }

  private clearDraft(rid: string, threadId: string | null): void {
    try {
      sessionStorage.removeItem(this.draftKey(rid, threadId));
    } catch {
      /* ignore */
    }
  }

  private sendComposer(): void {
    const rid = this.openRoomId;
    const tid = this.openThreadId;
    if (!rid || !this.store) return;
    // client.sendMessage consults the room's own encryption state and encrypts
    // automatically — there is nothing left to gate here.
    const body = this.composerTextarea.value.trim();
    const editing = this.editing;
    if (!body) {
      // An emptied edit box is a request to delete the message in most clients;
      // here it is simply refused, because "did that delete it?" is not a
      // question a chat client should leave open.
      if (editing) this.toast('An edited message cannot be empty — delete it instead.');
      return;
    }
    const replyTo = this.replyingTo?.eventId;
    // An edit borrowed the box, so saving it hands the box back to whatever
    // draft was in it; a normal send empties it (and its stored draft).
    this.composerTextarea.value = editing ? editing.stashedDraft : '';
    this.autoGrow(this.composerTextarea);
    if (!editing) this.clearDraft(rid, tid);
    this.replyingTo = null;
    this.editing = null;
    this.paintComposerContext();
    if (editing) {
      // No pinning: an edit lands in place, wherever that is, and yanking the
      // timeline to the bottom would take the reader away from what they just
      // rewrote.
      void this.store.editMessage(rid, editing.eventId, body, tid ?? undefined).catch((e: unknown) => {
        this.toast(this.errText(e));
      });
      return;
    }
    // Sending is the one action that overrides "keep the reader's position":
    // whatever you were reading up in history, you want to see what you just
    // wrote. Before the await, so it also applies if the send fails — the
    // `.failed` row with its Retry link is exactly what you need to see.
    this.timelineView.pinToBottom();
    void this.store.send(rid, body, replyTo, tid ?? undefined).catch(() => {
      /* the store surfaces the failure via the echo row itself */
    });
  }

  // ==================================================================
  // message actions (react / reply / edit / delete)
  // ==================================================================

  /** Open the ⋯ menu for one message. What it offers is `messageActionsFor`
   *  narrowed by what this session can actually do: reply and edit both need a
   *  working composer, which a session without encryption doesn't have. */
  private openMessageActions(ev: MxEvent, anchor: HTMLElement): void {
    const rid = this.openRoomId;
    if (!rid || !this.store) return;
    // Pressing the same ⋯ again closes the menu; pressing another row's moves
    // it there. (A pointer press outside already closes it before the click
    // lands — this is what makes keyboard activation behave the same way.)
    if (this.msgMenu) {
      const sameButton = this.msgMenuAnchor === anchor;
      this.closeMessageActions();
      if (sameButton) return;
    }
    const can = messageActionsFor(ev);
    const composerUsable = this.store.cryptoState !== 'unavailable';
    const spec = {
      react: can.react,
      copy: can.copy,
      copyImage: can.copyImage,
      reply: can.reply && composerUsable,
      thread: can.thread && composerUsable,
      edit: can.edit && composerUsable,
      remove: can.remove,
    };
    if (
      !spec.react &&
      !spec.copy &&
      !spec.copyImage &&
      !spec.reply &&
      !spec.thread &&
      !spec.edit &&
      !spec.remove
    ) {
      return;
    }
    this.timelineView.setMenuOpenRow(ev.event_id);
    this.msgMenuAnchor = anchor;
    this.msgMenu = openMessageMenu({
      anchor,
      container: this.root,
      can: spec,
      onReact: (key) => {
        void this.handleToggleReaction(ev.event_id, key);
        // The menu (and the button that was clicked in it) is already gone, so
        // without this focus sits on <body> — see refocusComposer. The chip
        // path keeps focus among the chips instead (timeline.ts).
        this.refocusComposer();
      },
      onReactOther: () => this.openReactionPicker(ev.event_id, anchor),
      onCopy: () => void this.handleCopyText(ev),
      onCopyImage: () => void this.handleCopyImage(ev),
      onReply: () => this.startReply(ev),
      onReplyInThread: () => this.openThreadView(ev.event_id),
      onEdit: () => this.startEdit(ev),
      onDelete: () => void this.handleDelete(ev.event_id),
      onClose: () => {
        this.msgMenu = null;
        this.msgMenuAnchor = null;
        this.timelineView.setMenuOpenRow(null);
      },
    });
  }

  private closeMessageActions(): void {
    this.msgMenu?.close();
    this.msgMenu = null;
    this.msgMenuAnchor = null;
    // The emoji picker lives and dies with the same view changes (leaving the
    // room, destroy) that close the message menu, so it rides along here.
    this.closeEmojiPicker();
  }

  private async handleToggleReaction(eventId: string, key: string): Promise<void> {
    const rid = this.openRoomId;
    if (!rid || !this.store || !eventId || !key) return;
    try {
      await this.store.toggleReaction(rid, eventId, key, this.openThreadId ?? undefined);
    } catch (e) {
      this.toast(this.errText(e));
    }
  }

  /** The ＋ entry: any emoji, not just the quick eight. The picker's search
   *  field still takes a pasted one, so the OS emoji keyboard keeps working
   *  as the escape hatch for anything outside the curated set. */
  private openReactionPicker(eventId: string, anchor: HTMLElement): void {
    this.closeEmojiPicker();
    // The message menu just closed and cleared the row marker — put it back so
    // the row's ⋯ button (our anchor) stays revealed under the picker.
    this.timelineView.setMenuOpenRow(eventId);
    this.emojiPicker = openEmojiPicker({
      anchor,
      container: this.root,
      onPick: (key) => {
        void this.handleToggleReaction(eventId, key);
        this.refocusComposer();
      },
      onClose: () => {
        this.emojiPicker = null;
        this.timelineView.setMenuOpenRow(null);
      },
    });
  }

  /** The composer's 😊 button: pick an emoji, insert it at the caret. */
  private toggleComposerEmoji(): void {
    if (this.emojiPicker) {
      this.closeEmojiPicker();
      return;
    }
    this.emojiPicker = openEmojiPicker({
      anchor: this.emojiBtn,
      container: this.root,
      onPick: (emoji) => this.insertIntoComposer(emoji),
      onClose: () => {
        this.emojiPicker = null;
      },
    });
  }

  private closeEmojiPicker(): void {
    this.emojiPicker?.close();
    this.emojiPicker = null;
  }

  private insertIntoComposer(text: string): void {
    const ta = this.composerTextarea;
    const start = ta.selectionStart ?? ta.value.length;
    const end = ta.selectionEnd ?? start;
    ta.setRangeText(text, start, end, 'end');
    this.autoGrow(ta);
    this.saveDraft();
    ta.focus();
  }

  private async handleCopyText(ev: MxEvent): Promise<void> {
    const body = typeof ev.content.body === 'string' ? ev.content.body : '';
    try {
      await copyText(body);
      this.toast('Copied to clipboard.');
    } catch (e) {
      this.toast(e instanceof Error ? e.message : "Couldn't copy.");
    }
    this.refocusComposer();
  }

  private async handleCopyImage(ev: MxEvent): Promise<void> {
    const content = imageContentOf(ev.content);
    const store = this.store;
    if (!content || !store) return;
    try {
      // The loader resolves through the store's per-mxc cache — for a picture
      // that is on screen (the only place this menu entry appears) the bytes
      // are already local, so this is a re-encode, not a download.
      await copyImage(async () => {
        const url = await store.imageUrl(content);
        return (await fetch(url)).blob();
      });
      this.toast('Picture copied to clipboard.');
    } catch (e) {
      this.toast(e instanceof Error ? e.message : "Couldn't copy the picture.");
    }
    this.refocusComposer();
  }

  /** Take focus back after a modal dialog. Those live in `document.body`, so
   *  dismissing one leaves focus on `<body>` — and with the panel no longer
   *  owning focus (`ownsFocus`), the next keystroke walks the player's avatar
   *  around the office instead of typing. */
  private refocusComposer(): void {
    if (this.stack[this.stack.length - 1]?.view !== 'room') return;
    if (this.composerTextarea.style.display === 'none') return;
    this.composerTextarea.focus();
  }

  private startReply(ev: MxEvent): void {
    const rid = this.openRoomId;
    if (!rid || !this.store) return;
    // An edit and a reply are the same box, so starting one ends the other —
    // including putting back the draft the edit had displaced.
    if (this.editing) this.cancelComposerContext();
    this.replyingTo = {
      eventId: ev.event_id,
      who: this.store.displayName(rid, ev.sender),
      text: typeof ev.content.body === 'string' ? ev.content.body.replace(/\s+/g, ' ').trim() : '',
    };
    this.paintComposerContext();
    this.composerTextarea.focus();
  }

  private startEdit(ev: MxEvent): void {
    if (!this.openRoomId) return;
    const body = typeof ev.content.body === 'string' ? ev.content.body : '';
    this.replyingTo = null;
    // The draft in the box is not lost, just parked: cancelling the edit puts
    // it back (and so does sending it).
    this.editing = { eventId: ev.event_id, stashedDraft: this.editing?.stashedDraft ?? this.composerTextarea.value };
    this.composerTextarea.value = body;
    this.autoGrow(this.composerTextarea);
    this.paintComposerContext();
    this.composerTextarea.focus();
    this.composerTextarea.setSelectionRange(body.length, body.length);
  }

  /** Leave reply/edit mode without sending. */
  private cancelComposerContext(): void {
    const editing = this.editing;
    this.replyingTo = null;
    this.editing = null;
    if (editing) {
      this.composerTextarea.value = editing.stashedDraft;
      this.autoGrow(this.composerTextarea);
      this.saveDraft();
    }
    this.paintComposerContext();
    this.composerTextarea.focus();
  }

  /** Reflect `replyingTo`/`editing` into the bar above the composer and the send
   *  button. Called from every place that changes either, and from
   *  renderRoomView so a repaint can't lose it. */
  private paintComposerContext(): void {
    if (this.editing) {
      this.composerCtxEl.hidden = false;
      this.composerCtxIconEl.textContent = '✎';
      this.composerCtxWhoEl.textContent = 'Editing your message';
      this.composerCtxWhatEl.textContent = 'Enter saves · Esc cancels';
    } else if (this.replyingTo) {
      this.composerCtxEl.hidden = false;
      this.composerCtxIconEl.textContent = '↩';
      this.composerCtxWhoEl.textContent = `Replying to ${this.replyingTo.who}`;
      this.composerCtxWhatEl.textContent = this.replyingTo.text;
    } else {
      this.composerCtxEl.hidden = true;
    }
    this.composerSendBtn.textContent = this.editing ? '✓' : '➤';
    this.composerSendBtn.title = this.editing ? 'Save the edit' : 'Send';
  }

  private async handleDelete(eventId: string): Promise<void> {
    const rid = this.openRoomId;
    if (!rid || !this.store) return;
    const ok = await confirmDialog('Delete this message for everyone?', {
      danger: true,
      confirmLabel: 'Delete',
    });
    this.refocusComposer();
    if (!ok) return;
    // Deleting the message being edited or replied to would leave the composer
    // pointing at nothing.
    if (this.editing?.eventId === eventId || this.replyingTo?.eventId === eventId) {
      this.cancelComposerContext();
    }
    try {
      await this.store.redact(rid, eventId, this.openThreadId ?? undefined);
    } catch (e) {
      this.toast(this.errText(e));
    }
  }

  private startTimelineRefresh(): void {
    this.stopTimelineRefresh();
    this.refreshTimer = window.setInterval(() => this.timelineView.refreshTimes(), 60_000);
  }

  private stopTimelineRefresh(): void {
    if (this.refreshTimer !== undefined) {
      clearInterval(this.refreshTimer);
      this.refreshTimer = undefined;
    }
  }

  /** The single entry point for every way a file can arrive (📎 button, paste,
   *  drop). Nothing is uploaded until the confirmation dialog is accepted — a
   *  paste is one keystroke away from every text message, and "Ctrl-V put my
   *  screenshot in a room before I could look at it" is not recoverable: a
   *  redaction removes the row, not the fact that everyone saw it.
   *
   *  Unlike a text send there is no local echo to fail into until the upload
   *  finishes, so failures land in the composer's own status line instead of a
   *  `.failed` row. */
  private async handlePickedFiles(files: File[]): Promise<void> {
    const rid = this.openRoomId;
    // Captured with the room, and for the same reason: the confirmation dialog
    // below is awaited, and a file must land where the reader was standing when
    // they picked it, not wherever they navigated to while it uploaded.
    const tid = this.openThreadId;
    if (!rid || !this.store) return;
    // Paste and drop reach here even though the button is hidden — same gate.
    if (this.store.cryptoState === 'unavailable') {
      this.showUploadStatus("Sending isn't available in this browser session.", 'err');
      return;
    }
    if (this.uploading) {
      this.showUploadStatus('Still sending the last file…', 'err');
      return;
    }
    const file = files[0];
    if (!file) return;
    // Checked here as well as in media.ts so the dialog never asks about a file
    // that cannot be sent in the first place.
    if (file.size > MAX_FILE_BYTES) {
      this.showUploadStatus(
        `That file is too big (limit ${Math.floor(MAX_FILE_BYTES / 1024 / 1024)} MB).`,
        'err',
      );
      return;
    }

    const room = this.store.room(rid);
    const confirmed = await confirmAttachment({
      file,
      roomName: room?.name ?? rid,
      encrypted: !!room?.encrypted,
      alsoPicked: files.length - 1,
    });
    if (!confirmed) return;
    // The dialog is modal, but the store keeps living behind it — a sign-out or
    // another send could have landed while it was open.
    if (!this.store || this.uploading) return;

    this.uploading = true;
    this.attachBtn.disabled = true;
    this.showUploadStatus(`Sending ${file.name}…`, '');
    // Same rule as a text send (see sendComposer): show me what I just sent.
    // Twice, deliberately — once now so the composer's progress line is on
    // screen while the upload runs, and once after, because an attachment has
    // no local echo until the bytes are up and the row can appear minutes later.
    if (this.openRoomId === rid && this.openThreadId === tid) this.timelineView.pinToBottom();
    try {
      // Deliberately `rid`, not the currently open room: this is the room the
      // dialog named, and that is what the user agreed to.
      await this.store.sendAttachment(
        rid,
        file,
        (fraction) => {
          if (this.openRoomId !== rid || this.openThreadId !== tid) return;
          this.showUploadStatus(`Sending ${file.name}… ${Math.round(fraction * 100)}%`, '');
        },
        tid ?? undefined,
      );
      // Only if the reader is still in the room (and thread) they sent it to —
      // otherwise this would yank a different timeline to the bottom.
      if (this.openRoomId === rid && this.openThreadId === tid) this.timelineView.pinToBottom();
      this.hideUploadStatus();
    } catch (err) {
      const msg = err instanceof Error && err.message ? err.message : "Couldn't send that file.";
      this.showUploadStatus(msg, 'err');
    } finally {
      this.uploading = false;
      this.attachBtn.disabled = false;
    }
  }

  private showUploadStatus(text: string, kind: 'err' | ''): void {
    this.uploadStatusEl.textContent = text;
    this.uploadStatusEl.classList.toggle('err', kind === 'err');
    this.uploadStatusEl.hidden = false;
  }

  private hideUploadStatus(): void {
    this.uploadStatusEl.hidden = true;
    this.uploadStatusEl.textContent = '';
  }

  // ==================================================================
  // members view
  // ==================================================================

  private buildMembersView(): void {
    const section = document.createElement('section');
    section.dataset.view = 'members';

    const back = document.createElement('button');
    back.className = 'pa-b';
    back.textContent = '◀';
    back.addEventListener('click', () => this.goBack());
    section.appendChild(back);

    this.membersStatusEl = document.createElement('div');
    this.membersStatusEl.className = 'muted';
    section.appendChild(this.membersStatusEl);

    this.membersJoinedLabel = document.createElement('div');
    this.membersJoinedLabel.className = 'grouplbl';
    section.appendChild(this.membersJoinedLabel);
    this.membersJoinedListEl = document.createElement('div');
    section.appendChild(this.membersJoinedListEl);

    this.membersInvitedLabel = document.createElement('div');
    this.membersInvitedLabel.className = 'grouplbl';
    this.membersInvitedLabel.style.opacity = '.7';
    this.membersInvitedLabel.style.display = 'none';
    section.appendChild(this.membersInvitedLabel);
    this.membersInvitedListEl = document.createElement('div');
    this.membersInvitedListEl.style.opacity = '.7';
    section.appendChild(this.membersInvitedListEl);

    const inviteLbl = document.createElement('div');
    inviteLbl.className = 'grouplbl';
    inviteLbl.textContent = 'INVITE';
    section.appendChild(inviteLbl);

    this.membersInviteInput = document.createElement('input');
    this.membersInviteInput.className = 'pa-input';
    this.membersInviteInput.placeholder = '@user:server';
    section.appendChild(this.membersInviteInput);

    this.membersInviteBtn = document.createElement('button');
    this.membersInviteBtn.className = 'pa-b primary';
    this.membersInviteBtn.textContent = 'Invite';
    this.membersInviteBtn.addEventListener('click', () => void this.handleMemberInvite());
    section.appendChild(this.membersInviteBtn);

    this.membersInviteErrEl = document.createElement('div');
    this.membersInviteErrEl.className = 'mx-err';
    this.membersInviteErrEl.style.display = 'none';
    section.appendChild(this.membersInviteErrEl);

    this.membersLeaveBtn = document.createElement('button');
    this.membersLeaveBtn.className = 'pa-b danger wide';
    this.membersLeaveBtn.textContent = 'Leave room';
    // The click handler is (re)assigned per-render in renderMembersView, where
    // the current room's id and display name are known.
    section.appendChild(this.membersLeaveBtn);

    this.sections.set('members', section);
    this.root.appendChild(section);
  }

  // ==================================================================
  // threads view
  // ==================================================================

  /**
   * Every thread in the open room, as a list.
   *
   * Threads need a home of their own because their roots do not: a thread whose
   * root is a fortnight up the timeline has no summary chip anywhere on screen,
   * and — unlike the room itself — it carries its own unread count that reading
   * the room will never clear. Without this list that count has nowhere to be
   * seen and no way to be cleared.
   */
  private buildThreadsView(): void {
    const section = document.createElement('section');
    section.dataset.view = 'threads';

    const head = document.createElement('div');
    head.className = 'mx-subhead';
    const back = document.createElement('button');
    back.className = 'pa-b';
    back.textContent = '◀';
    back.addEventListener('click', () => this.goBack());
    head.appendChild(back);
    const title = document.createElement('span');
    title.className = 'mx-room-name';
    title.textContent = '🧵 Threads';
    head.appendChild(title);
    section.appendChild(head);

    this.threadsStatusEl = document.createElement('div');
    this.threadsStatusEl.className = 'muted';
    this.threadsStatusEl.style.display = 'none';
    section.appendChild(this.threadsStatusEl);

    this.threadsListEl = document.createElement('div');
    section.appendChild(this.threadsListEl);

    this.sections.set('threads', section);
    this.root.appendChild(section);
  }

  private renderThreadsView(roomId: string): void {
    if (!this.store) return;
    const list = this.store.threads(roomId);
    const error = this.store.threadsError();
    const loading = this.store.loadingThreads();

    this.threadsStatusEl.replaceChildren();
    if (error) {
      // Not fatal: sync has still delivered whatever threads it has seen, so the
      // list below is drawn anyway and this only says it may be short.
      this.threadsStatusEl.textContent = `Couldn't load older threads — ${error}`;
      this.threadsStatusEl.style.display = '';
    } else if (loading && list.length === 0) {
      this.threadsStatusEl.textContent = 'Loading threads…';
      this.threadsStatusEl.style.display = '';
    } else if (list.length === 0) {
      this.threadsStatusEl.textContent =
        'No threads here yet. Pick ⋯ on a message and "Reply in thread" to start one.';
      this.threadsStatusEl.style.display = '';
    } else {
      this.threadsStatusEl.style.display = 'none';
    }

    this.threadsListEl.replaceChildren(...list.map((t) => this.buildThreadRow(t)));
  }

  /** One row of the threads list. Every string on it is remote text, so
   *  `textContent` throughout — the same rule the room list and the member list
   *  are built under. */
  private buildThreadRow(info: MxThreadInfo): HTMLElement {
    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'pa-list-row mx-thread-row';
    if (info.unread > 0) row.classList.add('unread');
    row.addEventListener('click', () => this.openThreadView(info.rootId));

    const main = document.createElement('div');
    main.className = 'mx-thread-row-main';

    const nm = document.createElement('div');
    nm.className = 'nm';
    nm.dir = 'auto';
    nm.textContent = info.rootPreview
      ? `${info.rootSenderName}: ${info.rootPreview}`
      : info.rootSenderName || 'Thread';
    main.appendChild(nm);

    const sub = document.createElement('div');
    sub.className = 'sub';
    sub.dir = 'auto';
    const count = info.count === 1 ? '1 reply' : `${info.count} replies`;
    sub.textContent = info.lastPreview
      ? `${count} · ${info.lastSenderName}: ${info.lastPreview}`
      : count;
    main.appendChild(sub);
    row.appendChild(main);

    const meta = document.createElement('div');
    meta.className = 'mx-thread-row-meta';
    if (info.lastTs > 0) {
      const time = document.createElement('small');
      time.textContent = fmtRelative(info.lastTs);
      time.title = new Date(info.lastTs).toLocaleString();
      meta.appendChild(time);
    }
    if (info.unread > 0) {
      const badge = document.createElement('div');
      badge.className = 'mx-badge' + (info.highlight > 0 ? ' hl' : '');
      badge.textContent = String(info.unread);
      meta.appendChild(badge);
    }
    row.appendChild(meta);

    row.title = info.participated ? 'You are in this thread' : 'Open thread';
    return row;
  }

  private async refreshMembers(roomId: string): Promise<void> {
    if (!this.store) return;
    this.membersLoading = true;
    this.membersError = '';
    this.renderIfTop('members', roomId);
    try {
      const members = await this.store.members(roomId);
      this.membersCache.set(roomId, members);
    } catch (e) {
      this.membersError = this.errText(e);
    } finally {
      this.membersLoading = false;
      this.renderIfTop('members', roomId);
    }
  }

  private buildMemberRow(m: MxMember, dim: boolean): HTMLElement {
    const row = document.createElement('div');
    row.className = 'pa-list-row';
    row.appendChild(mkAvatar(m.userId, m.displayName, this.picture(m.avatarMxc)));
    const nm = document.createElement('div');
    nm.className = 'nm';
    nm.textContent = m.displayName;
    nm.title = m.displayName;
    row.appendChild(nm);
    const small = document.createElement('small');
    small.textContent = dim ? 'invited' : m.userId;
    row.appendChild(small);
    return row;
  }

  private renderMembersView(roomId: string): void {
    if (!this.store) return;
    const room = this.store.room(roomId);
    this.membersJoinedListEl.innerHTML = '';
    this.membersInvitedListEl.innerHTML = '';
    const members = this.membersCache.get(roomId);

    if (this.membersLoading && !members) {
      this.membersStatusEl.textContent = 'Loading members…';
      this.membersStatusEl.style.display = '';
      this.membersJoinedLabel.textContent = 'MEMBERS';
      this.membersInvitedLabel.style.display = 'none';
      return;
    }
    if (this.membersError && !members) {
      this.membersStatusEl.textContent = `${this.membersError} `;
      const retry = document.createElement('span');
      retry.className = 'mx-link';
      retry.textContent = 'Retry';
      retry.tabIndex = 0;
      retry.setAttribute('role', 'button');
      retry.addEventListener('click', () => void this.refreshMembers(roomId));
      retry.addEventListener('keydown', (ev) => {
        if (ev.key === 'Enter' || ev.key === ' ') {
          ev.preventDefault();
          void this.refreshMembers(roomId);
        }
      });
      this.membersStatusEl.appendChild(retry);
      this.membersStatusEl.style.display = '';
      this.membersJoinedLabel.textContent = 'MEMBERS';
      this.membersInvitedLabel.style.display = 'none';
      return;
    }
    this.membersStatusEl.style.display = 'none';

    const joined = (members ?? []).filter((m) => m.membership === 'join');
    const invited = (members ?? []).filter((m) => m.membership === 'invite');
    this.membersJoinedLabel.textContent = `MEMBERS (${joined.length})`;
    for (const m of joined) this.membersJoinedListEl.appendChild(this.buildMemberRow(m, false));

    if (invited.length > 0) {
      this.membersInvitedLabel.textContent = `INVITED (${invited.length})`;
      this.membersInvitedLabel.style.display = '';
      for (const m of invited) this.membersInvitedListEl.appendChild(this.buildMemberRow(m, true));
    } else {
      this.membersInvitedLabel.style.display = 'none';
    }

    this.membersLeaveBtn.onclick = () => void this.handleLeaveRoom(roomId, room?.name ?? roomId);
  }

  private async handleMemberInvite(): Promise<void> {
    const top = this.stack[this.stack.length - 1];
    if (!top || top.view !== 'members' || !top.roomId || !this.store) return;
    const roomId = top.roomId;
    const mxid = this.membersInviteInput.value.trim();
    this.membersInviteErrEl.style.display = 'none';
    if (!MXID_RE.test(mxid)) {
      this.membersInviteErrEl.textContent = 'Enter an address like @user:server.';
      this.membersInviteErrEl.style.display = '';
      return;
    }
    this.membersInviteBtn.disabled = true;
    try {
      await this.store.invite(roomId, mxid);
      this.membersInviteInput.value = '';
      await this.refreshMembers(roomId);
    } catch (e) {
      this.membersInviteErrEl.textContent = this.errText(e);
      this.membersInviteErrEl.style.display = '';
    } finally {
      this.membersInviteBtn.disabled = false;
    }
  }

  private async handleLeaveRoom(roomId?: string, name?: string): Promise<void> {
    const top = this.stack[this.stack.length - 1];
    const rid = roomId ?? (top?.view === 'members' ? top.roomId : undefined);
    if (!rid || !this.store) return;
    const label = name ?? this.store.room(rid)?.name ?? rid;
    const ok = await confirmDialog(`Leave ${label}?`, { danger: true, confirmLabel: 'Leave' });
    if (!ok) return;
    try {
      await this.store.leave(rid);
      this.goRoot();
    } catch (e) {
      this.toast(this.errText(e));
    }
  }

  // ==================================================================
  // media view — every picture and file in the loaded window, in one place
  // ==================================================================

  private buildMediaView(): void {
    const section = document.createElement('section');
    section.dataset.view = 'media';

    const back = document.createElement('button');
    back.className = 'pa-b';
    back.textContent = '◀';
    back.addEventListener('click', () => this.goBack());
    section.appendChild(back);

    this.mediaStatusEl = document.createElement('div');
    this.mediaStatusEl.className = 'muted';
    section.appendChild(this.mediaStatusEl);

    this.mediaPicsLabel = document.createElement('div');
    this.mediaPicsLabel.className = 'grouplbl';
    section.appendChild(this.mediaPicsLabel);
    this.mediaPicsGridEl = document.createElement('div');
    this.mediaPicsGridEl.className = 'mx-media-grid';
    section.appendChild(this.mediaPicsGridEl);

    this.mediaFilesLabel = document.createElement('div');
    this.mediaFilesLabel.className = 'grouplbl';
    section.appendChild(this.mediaFilesLabel);
    this.mediaFilesListEl = document.createElement('div');
    this.mediaFilesListEl.className = 'mx-media-files';
    section.appendChild(this.mediaFilesListEl);

    // The overview covers what is *loaded*, same window as the timeline (the
    // same rule reactions follow — see MatrixStore.collectReactions). This is
    // the honest label for that plus the way to widen it.
    this.mediaFootEl = document.createElement('div');
    this.mediaFootEl.className = 'muted mx-media-foot';
    section.appendChild(this.mediaFootEl);

    this.mediaOlderBtn = document.createElement('button');
    this.mediaOlderBtn.className = 'pa-b wide';
    this.mediaOlderBtn.textContent = 'Load older messages';
    this.mediaOlderBtn.addEventListener('click', () => {
      const top = this.stack[this.stack.length - 1];
      if (top?.view !== 'media' || !top.roomId) return;
      // paginate() emits 'timeline' on start and finish, which re-renders us.
      this.store?.paginate(top.roomId).catch(() => {
        /* surfaced via store.timelineError() in the next render */
      });
    });
    section.appendChild(this.mediaOlderBtn);

    this.sections.set('media', section);
    this.root.appendChild(section);
  }

  /** Every attachment event in the loaded window, newest first. The same
   *  validated projections the timeline rows use (media.ts), so nothing here
   *  re-checks a remote-controlled shape — and a redacted or undecryptable
   *  event yields neither and simply isn't media any more. */
  /**
   * Every picture and file in the loaded window — the room's own, and each
   * thread's.
   *
   * The threads half is not optional: with `threadSupport` on, a picture posted
   * inside a thread is not in the room's timeline at all, so walking only that
   * would quietly drop it from an overview whose whole promise is "everything
   * shared here". A thread root appears in both windows once its thread has been
   * paginated to the start, hence the dedupe.
   *
   * Ordered newest-first across the lot rather than room-then-threads: a grid
   * split into two chronologies is not a chronology.
   */
  private collectMedia(roomId: string): Array<{ ev: MxEvent; image: MxImageContent | null; file: MxFileContent | null }> {
    if (!this.store) return [];
    const out: Array<{ ev: MxEvent; image: MxImageContent | null; file: MxFileContent | null }> = [];
    const seen = new Set<string>();
    const sweep = (events: MxEvent[]): void => {
      for (const ev of events) {
        if (ev.redacted) continue;
        const key = ev.event_id || ev.txnId || '';
        if (key && seen.has(key)) continue;
        if (key) seen.add(key);
        const image = imageContentOf(ev.content);
        const file = image ? null : fileContentOf(ev.content);
        if (image || file) out.push({ ev, image, file });
      }
    };
    sweep(this.store.timeline(roomId));
    for (const t of this.store.threads(roomId)) sweep(this.store.threadTimeline(roomId, t.rootId));
    out.sort((a, b) => b.ev.origin_server_ts - a.ev.origin_server_ts);
    return out;
  }

  private renderMediaView(roomId: string): void {
    if (!this.store) return;
    const items = this.collectMedia(roomId);
    const pics = items.filter((i) => i.image !== null);
    const files = items.filter((i) => i.file !== null);

    this.mediaPicsLabel.textContent = `PICTURES (${pics.length})`;
    this.mediaPicsLabel.style.display = pics.length > 0 ? '' : 'none';
    this.mediaFilesLabel.textContent = `FILES (${files.length})`;
    this.mediaFilesLabel.style.display = files.length > 0 ? '' : 'none';

    // Rebuild the tiles only when the set of media events changed — this
    // renders on every sync tick while a room is busy, and a rebuilt tile is a
    // restarted <img> and a flicker (same trick as the rail).
    const key = items.map((i) => i.ev.event_id || i.ev.txnId || '').join(' ');
    if (key !== this.mediaListKey) {
      this.mediaListKey = key;
      this.mediaPicsGridEl.replaceChildren(
        ...pics.map((i) => this.buildMediaTile(roomId, i.ev, i.image as MxImageContent)),
      );
      this.mediaFilesListEl.replaceChildren(
        ...files.map((i) => this.buildMediaFileRow(roomId, i.ev, i.file as MxFileContent)),
      );
    }

    this.mediaStatusEl.textContent =
      items.length === 0 ? 'No pictures or files in the loaded messages yet.' : '';
    this.mediaStatusEl.style.display = items.length === 0 ? '' : 'none';

    const atStart = this.store.atStart(roomId);
    const loading = this.store.loadingTimeline(roomId);
    const error = this.store.timelineError(roomId);
    this.mediaOlderBtn.style.display = atStart ? 'none' : '';
    this.mediaOlderBtn.disabled = loading;
    this.mediaOlderBtn.textContent = loading ? 'Loading…' : 'Load older messages';
    this.mediaFootEl.textContent = error
      ? error
      : atStart
        ? 'That covers this whole conversation.'
        : 'Showing what this session has loaded — older messages may hold more.';
  }

  /** Who + when for a tile/row tooltip. Both halves are remote-adjacent text
   *  and land in `title` property assignment only. */
  private mediaTooltip(roomId: string, ev: MxEvent, name: string): string {
    const who = this.store?.displayName(roomId, ev.sender) ?? ev.sender;
    return `${name} · ${who} · ${fmtRelative(ev.origin_server_ts)}`;
  }

  /** One square in the picture grid. The bytes are the same download the
   *  timeline row already made (shared cache in media.ts), so walking a room
   *  you have scrolled costs no new fetches. */
  private buildMediaTile(roomId: string, ev: MxEvent, content: MxImageContent): HTMLElement {
    const tile = document.createElement('button');
    tile.type = 'button';
    tile.className = 'mx-media-thumb loading';
    tile.title = this.mediaTooltip(roomId, ev, content.body);
    tile.setAttribute('aria-label', `Open ${content.body}`);
    const ph = document.createElement('span');
    ph.className = 'ph';
    ph.textContent = '🖼';
    tile.appendChild(ph);
    const img = document.createElement('img');
    img.alt = content.body;
    img.decoding = 'async';
    img.loading = 'lazy';
    tile.appendChild(img);

    let url = '';
    let state: 'loading' | 'ok' | 'error' = 'loading';
    const fail = (): void => {
      state = 'error';
      tile.classList.remove('loading', 'has-img');
      tile.classList.add('failed');
      img.removeAttribute('src');
      tile.title = `${content.body} — couldn't load (click to retry)`;
    };
    // The download can succeed and the picture still not decode (a mimetype
    // outside media.ts's allowlist arrives as an opaque blob on purpose) —
    // same signal the timeline row listens for.
    img.addEventListener('error', () => {
      if (state === 'ok') fail();
    });
    const load = (): void => {
      state = 'loading';
      tile.classList.add('loading');
      tile.classList.remove('failed');
      const store = this.store;
      if (!store) return fail();
      store
        .imageUrl(content)
        .then((u) => {
          url = u;
          state = 'ok';
          tile.classList.remove('loading');
          tile.classList.add('has-img');
          img.src = u;
        })
        .catch(() => fail());
    };
    tile.addEventListener('click', () => {
      if (state === 'ok') openImageViewer(content.body, url);
      else if (state === 'error') load();
    });
    load();
    return tile;
  }

  /** One file row: a name, a size and a download on click — never bytes
   *  fetched on the reader's behalf, exactly like the timeline's file chip. */
  private buildMediaFileRow(roomId: string, ev: MxEvent, content: MxFileContent): HTMLElement {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'mx-file mx-media-file';
    chip.title = this.mediaTooltip(roomId, ev, content.body);
    chip.setAttribute('aria-label', `Save ${content.body}`);
    const icon = document.createElement('span');
    icon.className = 'i';
    icon.textContent = '📎';
    const main = document.createElement('span');
    main.className = 'mx-file-main';
    const name = document.createElement('span');
    name.className = 'nm';
    name.dir = 'auto';
    name.textContent = content.body;
    const meta = document.createElement('span');
    meta.className = 'sub';
    meta.textContent = describeFile(content);
    main.append(name, meta);
    chip.append(icon, main);

    let state: 'idle' | 'loading' = 'idle';
    chip.addEventListener('click', () => {
      if (state === 'loading' || !this.store) return;
      state = 'loading';
      chip.classList.add('loading');
      chip.classList.remove('failed');
      meta.textContent = 'Downloading…';
      this.store
        .attachmentUrl(content)
        .then((u) => {
          state = 'idle';
          chip.classList.remove('loading');
          meta.textContent = describeFile(content);
          saveBlobUrl(content.body, u);
        })
        .catch((err: unknown) => {
          state = 'idle';
          chip.classList.remove('loading');
          chip.classList.add('failed');
          meta.textContent = `${err instanceof Error && err.message ? err.message : "Couldn't download this file."} — click to retry`;
        });
    });
    return chip;
  }

  /** The chat's picture, full size, in the lightbox. Only reachable when the
   *  room has one (the header button is disabled otherwise). */
  private async openRoomAvatar(): Promise<void> {
    const rid = this.openRoomId;
    const store = this.store;
    const room = rid && store ? store.room(rid) : null;
    const mxc = room?.avatarMxc;
    if (!room || !mxc || !store) return;
    try {
      openImageViewer(room.name, await store.avatarOriginalUrl(mxc));
    } catch (e) {
      this.toast(this.errText(e));
    }
  }

  // ==================================================================
  // newdm view
  // ==================================================================

  private buildNewDmView(): void {
    const section = document.createElement('section');
    section.dataset.view = 'newdm';

    const back = document.createElement('button');
    back.className = 'pa-b';
    back.textContent = '◀';
    back.addEventListener('click', () => this.goRoot());
    section.appendChild(back);

    this.dmSearchInput = document.createElement('input');
    this.dmSearchInput.className = 'pa-input';
    this.dmSearchInput.placeholder = 'Search people or paste @user:server';
    this.dmSearchInput.addEventListener('input', () => {
      this.dmSearchTerm = this.dmSearchInput.value.trim();
      this.dmSearching = !!this.dmSearchTerm;
      if (this.dmSearchTimer !== undefined) clearTimeout(this.dmSearchTimer);
      this.dmSearchTimer = window.setTimeout(() => void this.runDmSearch(), 300);
      this.renderNewDmView();
    });
    section.appendChild(this.dmSearchInput);

    this.dmResultsEl = document.createElement('div');
    section.appendChild(this.dmResultsEl);

    this.sections.set('newdm', section);
    this.root.appendChild(section);
  }

  private async runDmSearch(): Promise<void> {
    const term = this.dmSearchTerm;
    this.dmSearchAbort?.abort();
    if (!term || !this.store) {
      this.dmResults = [];
      this.dmSearchError = '';
      this.dmSearching = false;
      this.renderIfTop('newdm');
      return;
    }
    const ac = new AbortController();
    this.dmSearchAbort = ac;
    this.dmSearchError = '';
    this.dmSearching = true;
    this.renderIfTop('newdm');
    try {
      const results = await this.store.searchUsers(term, ac.signal);
      if (ac.signal.aborted) return;
      this.dmResults = results;
    } catch (e) {
      if (ac.signal.aborted) return;
      this.dmResults = [];
      this.dmSearchError = this.errText(e);
    } finally {
      if (!ac.signal.aborted) this.dmSearching = false;
    }
    this.renderIfTop('newdm');
  }

  private renderNewDmView(): void {
    this.dmResultsEl.innerHTML = '';
    const term = this.dmSearchTerm;
    if (!term) {
      const hint = document.createElement('div');
      hint.className = 'muted';
      hint.textContent = 'Search by name or paste an @user:server address.';
      this.dmResultsEl.appendChild(hint);
      return;
    }

    let rows = 0;
    if (MXID_RE.test(term)) {
      const row = document.createElement('div');
      row.className = 'pa-list-row';
      row.appendChild(mkAvatar(term, term));
      const nm = document.createElement('div');
      nm.className = 'nm';
      nm.textContent = `Start a chat with ${term}`;
      row.appendChild(nm);
      const btn = document.createElement('button');
      btn.className = 'pa-b';
      btn.disabled = this.dmChoosing === term;
      btn.textContent = this.dmChoosing === term ? 'Starting…' : 'Chat';
      btn.addEventListener('click', () => void this.chooseDmTarget(term));
      row.appendChild(btn);
      this.dmResultsEl.appendChild(row);
      rows++;
    }

    for (const u of this.dmResults) {
      if (u.userId === term) continue;
      const row = document.createElement('div');
      row.className = 'pa-list-row';
      row.appendChild(mkAvatar(u.userId, u.displayName, this.picture(u.avatarMxc)));
      const nm = document.createElement('div');
      nm.className = 'nm';
      nm.textContent = u.displayName;
      row.appendChild(nm);
      const small = document.createElement('small');
      small.textContent = u.userId;
      row.appendChild(small);
      const btn = document.createElement('button');
      btn.className = 'pa-b';
      btn.disabled = this.dmChoosing === u.userId;
      btn.textContent = this.dmChoosing === u.userId ? 'Starting…' : 'Chat';
      btn.addEventListener('click', () => void this.chooseDmTarget(u.userId));
      row.appendChild(btn);
      this.dmResultsEl.appendChild(row);
      rows++;
    }

    if (this.dmSearchError) {
      const err = document.createElement('div');
      err.className = 'mx-err';
      err.textContent = this.dmSearchError;
      this.dmResultsEl.appendChild(err);
    } else if (rows === 0 && this.dmSearching) {
      const searching = document.createElement('div');
      searching.className = 'mx-notice';
      searching.textContent = 'Searching…';
      this.dmResultsEl.appendChild(searching);
    } else if (rows === 0) {
      const empty = document.createElement('div');
      empty.className = 'mx-notice';
      empty.textContent = 'No matches.';
      this.dmResultsEl.appendChild(empty);
    }
  }

  private async chooseDmTarget(mxid: string): Promise<void> {
    if (!this.store || this.dmChoosing) return;
    const existing = this.store.existingDmWith(mxid);
    if (existing) {
      this.openRoomView(existing);
      return;
    }
    this.dmChoosing = mxid;
    this.renderIfTop('newdm');
    try {
      const roomId = await this.store.createDm(mxid);
      this.openRoomView(roomId);
    } catch (e) {
      this.toast(this.errText(e));
    } finally {
      this.dmChoosing = null;
      this.renderIfTop('newdm');
    }
  }

  // ==================================================================
  // newgroup view
  // ==================================================================

  private buildNewGroupView(): void {
    const section = document.createElement('section');
    section.dataset.view = 'newgroup';

    const back = document.createElement('button');
    back.className = 'pa-b';
    back.textContent = '◀';
    back.addEventListener('click', () => this.goRoot());
    section.appendChild(back);

    this.groupNameInput = document.createElement('input');
    this.groupNameInput.className = 'pa-input';
    this.groupNameInput.placeholder = 'Name';
    section.appendChild(this.groupNameInput);

    this.groupSegEl = document.createElement('div');
    this.groupSegEl.className = 'pa-seg';
    const privSeg = document.createElement('button');
    privSeg.className = 'seg on';
    privSeg.textContent = 'Private';
    const pubSeg = document.createElement('button');
    pubSeg.className = 'seg';
    pubSeg.textContent = 'Public';
    privSeg.addEventListener('click', () => {
      this.groupVisibility = 'private';
      privSeg.classList.add('on');
      pubSeg.classList.remove('on');
      this.groupAliasRow.style.display = 'none';
    });
    pubSeg.addEventListener('click', () => {
      this.groupVisibility = 'public';
      pubSeg.classList.add('on');
      privSeg.classList.remove('on');
      this.groupAliasRow.style.display = '';
    });
    this.groupSegEl.append(privSeg, pubSeg);
    section.appendChild(this.groupSegEl);

    const hint = document.createElement('div');
    hint.className = 'muted';
    hint.textContent = 'Private rooms are invite-only. Public rooms can be found and joined by anyone.';
    section.appendChild(hint);

    this.groupAliasRow = document.createElement('div');
    this.groupAliasRow.style.display = 'none';
    this.groupAliasInput = document.createElement('input');
    this.groupAliasInput.className = 'pa-input';
    this.groupAliasInput.id = 'pa-mx-alias';
    this.groupAliasInput.placeholder = 'Address (optional)';
    this.groupAliasRow.appendChild(this.groupAliasInput);
    section.appendChild(this.groupAliasRow);

    this.groupCreateBtn = document.createElement('button');
    this.groupCreateBtn.className = 'pa-b primary wide';
    this.groupCreateBtn.textContent = 'Create';
    this.groupCreateBtn.addEventListener('click', () => void this.handleCreateGroup());
    section.appendChild(this.groupCreateBtn);

    this.groupErrEl = document.createElement('div');
    this.groupErrEl.className = 'mx-err';
    this.groupErrEl.style.display = 'none';
    section.appendChild(this.groupErrEl);

    this.sections.set('newgroup', section);
    this.root.appendChild(section);
  }

  private renderNewGroupView(): void {
    this.groupNameInput.value = '';
    this.groupAliasInput.value = '';
    this.groupErrEl.style.display = 'none';
  }

  private async handleCreateGroup(): Promise<void> {
    if (!this.store) return;
    const name = this.groupNameInput.value.trim();
    this.groupErrEl.style.display = 'none';
    if (!name) {
      this.groupErrEl.textContent = 'Name is required.';
      this.groupErrEl.style.display = '';
      return;
    }
    this.groupCreateBtn.disabled = true;
    try {
      const isPublic = this.groupVisibility === 'public';
      const alias = isPublic ? this.groupAliasInput.value.trim() || undefined : undefined;
      const roomId = await this.store.createGroup({ name, isPublic, alias });
      this.openRoomView(roomId);
    } catch (e) {
      this.groupErrEl.textContent = this.errText(e);
      this.groupErrEl.style.display = '';
    } finally {
      this.groupCreateBtn.disabled = false;
    }
  }

  // ==================================================================
  // join view
  // ==================================================================

  private buildJoinView(): void {
    const section = document.createElement('section');
    section.dataset.view = 'join';

    const back = document.createElement('button');
    back.className = 'pa-b';
    back.textContent = '◀';
    back.addEventListener('click', () => this.goRoot());
    section.appendChild(back);

    this.joinInput = document.createElement('input');
    this.joinInput.className = 'pa-input';
    this.joinInput.placeholder = '#room:server (or !roomid:server via.example.org)';
    this.joinInput.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter') {
        ev.preventDefault();
        void this.handleJoin();
      }
    });
    section.appendChild(this.joinInput);

    const hint = document.createElement('div');
    hint.className = 'muted';
    hint.textContent =
      'An address like #room:server is enough. A raw room id also needs the server to route through, separated by a space.';
    section.appendChild(hint);

    this.joinBtn = document.createElement('button');
    this.joinBtn.className = 'pa-b primary wide';
    this.joinBtn.textContent = 'Join';
    this.joinBtn.addEventListener('click', () => void this.handleJoin());
    section.appendChild(this.joinBtn);

    this.joinErrEl = document.createElement('div');
    this.joinErrEl.className = 'mx-err';
    this.joinErrEl.style.display = 'none';
    section.appendChild(this.joinErrEl);

    this.sections.set('join', section);
    this.root.appendChild(section);
  }

  private renderJoinView(): void {
    this.joinErrEl.style.display = 'none';
  }

  // ==================================================================
  // notifications view (desktop-notification rows are desktop-only;
  // the typing-notification toggle shows in every build)
  // ==================================================================

  /** One checkbox row in the pixel style: a label wrapping its own input, so the
   *  text is part of the hit target. */
  private mkCheckRow(label: string, onChange: (on: boolean) => void): {
    row: HTMLLabelElement;
    input: HTMLInputElement;
  } {
    const row = document.createElement('label');
    row.className = 'mx-chk';
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.addEventListener('change', () => onChange(input.checked));
    row.append(input, document.createTextNode(label));
    return { row, input };
  }

  private buildNotificationsView(): void {
    const section = document.createElement('section');
    section.dataset.view = 'notifications';

    const subhead = document.createElement('div');
    subhead.className = 'mx-subhead';
    const back = document.createElement('button');
    back.className = 'pa-b';
    back.textContent = '◀';
    back.setAttribute('aria-label', 'Back to chats');
    back.title = 'Back to chats';
    back.addEventListener('click', () => this.goRoot());
    const title = document.createElement('span');
    title.className = 'mx-room-name';
    title.textContent = 'Notifications';
    subhead.append(back, title);
    section.appendChild(subhead);

    const body = document.createElement('div');
    body.className = 'mx-encbody';
    section.appendChild(body);

    if (isDesktop()) {
      const enabled = this.mkCheckRow('Notify me about new messages', (on) => {
        writeNotifyPrefs({ ...readNotifyPrefs(), enabled: on });
        this.renderNotificationsView();
      });
      this.notifyEnabledEl = enabled.input;
      body.appendChild(enabled.row);

      const hint = document.createElement('div');
      hint.className = 'mx-hint';
      hint.textContent =
        'Mentions and direct messages always notify. Other rooms only notify while this window is closed or the app is in the background — never for the room you are reading. Muted rooms stay muted: your homeserver’s notification rules are what decide, so anything you have silenced in another client is silent here too.';
      body.appendChild(hint);

      const showBody = this.mkCheckRow('Show the message text', (on) => {
        writeNotifyPrefs({ ...readNotifyPrefs(), showBody: on });
        this.renderNotificationsView();
      });
      this.notifyBodyEl = showBody.input;
      body.appendChild(showBody.row);

      // The one setting here with a real trade-off, so it gets said plainly rather
      // than left for the user to discover.
      const bodyHint = document.createElement('div');
      bodyHint.className = 'mx-hint';
      bodyHint.textContent =
        'Off by default. A notification is handed to your desktop’s notification service, which may keep it in a log or show it on a lock screen — so for an encrypted room this puts decrypted text somewhere outside the app. Left off, notifications say only who wrote and where.';
      body.appendChild(bodyHint);
    }

    const sendTyping = this.mkCheckRow('Let others see when I’m typing', (on) => {
      writeNotifyPrefs({ ...readNotifyPrefs(), sendTyping: on });
      this.renderNotificationsView();
    });
    this.notifyTypingEl = sendTyping.input;
    body.appendChild(sendTyping.row);

    const typingHint = document.createElement('div');
    typingHint.className = 'mx-hint';
    typingHint.textContent =
      'Shows a “…is typing” line to the people in the room while you write, the way you see theirs. Off, you still see everyone else’s — this only stops yours. A per-device choice, like the rest of this page.';
    body.appendChild(typingHint);

    this.sections.set('notifications', section);
    this.root.appendChild(section);
  }

  private renderNotificationsView(): void {
    const prefs = readNotifyPrefs();
    if (this.notifyEnabledEl) this.notifyEnabledEl.checked = prefs.enabled;
    if (this.notifyBodyEl) {
      this.notifyBodyEl.checked = prefs.showBody;
      // Nothing to say about a notification that never fires.
      this.notifyBodyEl.disabled = !prefs.enabled;
      this.notifyBodyEl.closest('.mx-chk')?.classList.toggle('off', !prefs.enabled);
    }
    // Independent of `enabled` — that switch governs what this machine shows,
    // this one what it broadcasts.
    if (this.notifyTypingEl) this.notifyTypingEl.checked = prefs.sendTyping;
    this.paintNotifyBtn();
  }

  private async handleJoin(): Promise<void> {
    if (!this.store) return;
    const input = this.joinInput.value.trim();
    if (!input) return;
    this.joinBtn.disabled = true;
    this.joinErrEl.style.display = 'none';
    try {
      const roomId = await this.store.joinRoom(input);
      this.joinInput.value = '';
      this.openRoomView(roomId);
    } catch (e) {
      this.joinErrEl.textContent = this.joinErrText(e);
      this.joinErrEl.style.display = '';
    } finally {
      this.joinBtn.disabled = false;
    }
  }

  private joinErrText(e: unknown): string {
    if (e instanceof MatrixError) {
      if (e.errcode === 'M_FORBIDDEN') return 'You are not invited to that room, and it is not public.';
      if (e.errcode === 'M_NOT_FOUND') {
        return 'No such room — a room id usually also needs the server to join through, e.g. !abc:example.org matrix.org.';
      }
    }
    return this.errText(e);
  }

  // ==================================================================
  // encryption view
  // ==================================================================

  private buildEncryptionView(): void {
    const hooks: EncryptionViewHooks = {
      crypto: () => this.store?.crypto ?? null,
      cryptoState: () => this.store?.cryptoState ?? 'unavailable',
      myUserId: () => this.store?.userId ?? '',
      paUserId: () => this.hooks.paUserId,
      askPassword: (message) => passwordPromptDialog(message),
      onBack: () => this.goRoot(),
      onSignOut: () => void this.handleSignOut(),
      onChanged: () => this.renderTopStrip(),
      toast: (message) => this.toast(message),
    };
    const handle = createEncryptionView(hooks);
    this.encryptionView = handle;
    handle.el.dataset.view = 'encryption';
    this.sections.set('encryption', handle.el);
    this.root.appendChild(handle.el);
  }

  // ==================================================================
  // shared helpers
  // ==================================================================

  /** Set the account's profile picture. Toasts rather than using the
   *  composer's status line: this is account-level and reachable from every
   *  view, including ones with no composer. */
  private async changeMyAvatar(file: File): Promise<void> {
    if (!this.store || this.avatarBusy) return;
    this.avatarBusy = true;
    this.meAvatarSlot.disabled = true;
    try {
      await this.store.setMyAvatar(file);
      this.toast('Profile picture updated.');
      this.renderTopStrip();
    } catch (err) {
      this.toast(this.errText(err));
    } finally {
      this.avatarBusy = false;
      this.meAvatarSlot.disabled = false;
    }
  }

  /** Fill a persistent avatar slot (the room header, the status strip) —
   *  places that are updated in place on every render rather than rebuilt from
   *  a list. Rebuilding the square unconditionally would be correct but would
   *  re-enter the loader on every sync tick, so the identity+picture pair is
   *  stamped on the slot and an unchanged pair is left alone. */
  private paintAvatarSlot(slot: HTMLElement, seed: string, label: string, mxc: string | null): void {
    const key = `${seed}\0${label}\0${mxc ?? ''}`;
    if (slot.dataset.avKey === key) return;
    slot.dataset.avKey = key;
    slot.replaceChildren(mkAvatar(seed, label, this.picture(mxc)));
  }

  /** Wrap an mxc:// (or null) into the shape `mkAvatar` wants. One place owns
   *  the "resolve through the store, which caches per (uri, size)" half, so no
   *  call site can accidentally fetch an avatar per render. */
  private picture(mxc: string | null): MxAvatarPicture {
    return { mxc, load: (uri, size) => (this.store ? this.store.avatarUrl(uri, size) : Promise.reject(new Error('no store'))) };
  }

  private hsHost(): string {
    if (!this.hsBaseUrl) return '';
    try {
      return new URL(this.hsBaseUrl).host;
    } catch {
      return this.hsBaseUrl;
    }
  }

  private errText(e: unknown): string {
    return describeError(e, this.hsHost());
  }

  private toast(msg: string): void {
    if (!this.toastEl) {
      this.toastEl = document.createElement('div');
      this.toastEl.className = 'mx-toast';
      this.toastEl.setAttribute('role', 'status');
      this.toastEl.addEventListener('click', () => this.hideToast());
      this.root.appendChild(this.toastEl);
    }
    this.toastEl.textContent = msg;
    this.toastEl.style.display = '';
    if (this.toastTimer !== undefined) clearTimeout(this.toastTimer);
    this.toastTimer = window.setTimeout(() => this.hideToast(), 4000);
  }

  private hideToast(): void {
    if (this.toastEl) this.toastEl.style.display = 'none';
    if (this.toastTimer !== undefined) {
      clearTimeout(this.toastTimer);
      this.toastTimer = undefined;
    }
  }
}


// ======================================================================
// attachment helpers (module-private)
// ======================================================================

/** The types that will end up as a *picture* rather than a plain file. Used
 *  only for presentation here — naming a nameless clipboard file, and deciding
 *  whether the confirmation dialog can show a thumbnail. media.ts sniffs the
 *  bytes and remains the authority on what is actually sent as what. */
const SENDABLE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif']);

/** True when a drag carries files at all — checked on `dragover` (where the
 *  items' contents are not readable yet, only their kind). */
function hasFiles(dt: DataTransfer | null): boolean {
  if (!dt) return false;
  return Array.from(dt.items ?? []).some((i) => i.kind === 'file') || (dt.files?.length ?? 0) > 0;
}

/** Files out of a paste or a drop. A screenshot pasted from the clipboard has
 *  no filename at all (Chrome calls it "image.png", Firefox sometimes ""), so
 *  a name is synthesised here rather than left to the server. */
function filesFromDataTransfer(dt: DataTransfer | null): File[] {
  if (!dt) return [];
  const out: File[] = [];
  for (const f of Array.from(dt.files ?? [])) out.push(named(f));
  if (out.length === 0) {
    for (const item of Array.from(dt.items ?? [])) {
      if (item.kind !== 'file') continue;
      const f = item.getAsFile();
      if (f) out.push(named(f));
    }
  }
  return out;
}

/** Give a nameless clipboard file a name whose extension matches what it
 *  actually is — the mimetype the event carries still comes from the bytes. */
function named(f: File): File {
  if (f.name) return f;
  if (SENDABLE_TYPES.has(f.type)) {
    const ext = f.type === 'image/jpeg' ? 'jpg' : f.type === 'image/gif' ? 'gif' : 'png';
    return new File([f], `pasted.${ext}`, { type: f.type });
  }
  // Anything else off the clipboard: a name is still required (it becomes the
  // event body and the reader's download name), but inventing an extension for
  // bytes we know nothing about would be a worse guess than none.
  return new File([f], 'pasted-file', { type: f.type });
}

/** Hand a resolved blob: URL to the browser as a download. An `<a download>` on
 *  the same blob is what the desktop shell turns into its normal save dialog —
 *  `window.open` and `target="_blank"` are both inert there (AGENTS rule 10,
 *  and see openImageViewer). Firefox only follows a programmatic click on an
 *  anchor that is in the document, so it is attached for the click. */
function saveBlobUrl(name: string, url: string): void {
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.rel = 'noopener';
  a.hidden = true;
  document.body.appendChild(a);
  a.click();
  a.remove();
}

/**
 * "Send this file?" — the gate in front of every upload (see
 * `handlePickedFiles`). Resolves true only on Send; Esc, the backdrop, Cancel
 * and closing all mean no.
 *
 * A native `<dialog>` + `showModal()`, like `openImageViewer`: the panel it
 * covers is itself layered UI, and the browser's top layer is the one thing
 * that always wins (see the note in ui/dialog.ts about z-index no longer being
 * able to beat it).
 */
function confirmAttachment(o: {
  file: File;
  roomName: string;
  encrypted: boolean;
  /** How many further files came with this one — only the first is sent. */
  alsoPicked: number;
}): Promise<boolean> {
  const isPicture = SENDABLE_TYPES.has(o.file.type);
  const dialog = document.createElement('dialog');
  dialog.className = 'pa-ui mx-confirm';
  const panel = document.createElement('div');
  panel.className = 'pa-panel';

  const head = document.createElement('div');
  head.className = 'pa-head';
  const title = document.createElement('h4');
  title.textContent = isPicture ? 'Send this picture?' : 'Send this file?';
  const close = document.createElement('div');
  close.className = 'pa-x';
  close.textContent = '✕';
  close.title = 'Cancel (Esc)';
  head.append(title, close);

  const body = document.createElement('div');
  body.className = 'pa-body';

  const row = document.createElement('div');
  row.className = 'mx-confirm-row';
  const preview = document.createElement('div');
  preview.className = 'mx-confirm-prev';
  let previewUrl = '';
  if (isPicture) {
    previewUrl = URL.createObjectURL(o.file);
    const img = document.createElement('img');
    img.src = previewUrl;
    img.alt = o.file.name;
    preview.appendChild(img);
  } else {
    preview.classList.add('generic');
    preview.textContent = '📎';
  }
  const meta = document.createElement('div');
  meta.className = 'mx-confirm-meta';
  const nameEl = document.createElement('div');
  nameEl.className = 'nm';
  nameEl.dir = 'auto';
  nameEl.textContent = o.file.name;
  nameEl.title = o.file.name;
  const sizeEl = document.createElement('div');
  sizeEl.className = 'sub';
  const typeLabel = /^[\w.+-]+\/([\w.+-]{1,24})$/.exec(o.file.type)?.[1]?.toUpperCase() ?? '';
  // `|| '0 B'` rather than hiding the line: a zero-byte pick is usually a
  // dropped *folder*, and seeing that here is the cheapest way to notice.
  sizeEl.textContent = [fmtBytes(o.file.size) || '0 B', typeLabel].filter(Boolean).join(' · ');
  const toEl = document.createElement('div');
  toEl.className = 'sub';
  toEl.textContent = `To ${o.roomName}`;
  toEl.title = o.roomName;
  const encEl = document.createElement('div');
  encEl.className = 'sub';
  // Worth a line: the same click means two rather different things depending on
  // the room, and this is the last moment it can still be taken back.
  encEl.textContent = o.encrypted ? '🔒 Encrypted before it leaves this device' : 'Sent unencrypted';
  meta.append(nameEl, sizeEl, toEl, encEl);
  if (o.alsoPicked > 0) {
    const extra = document.createElement('div');
    extra.className = 'sub warn';
    extra.textContent = `Only this one of ${o.alsoPicked + 1} files will be sent — one at a time for now.`;
    meta.appendChild(extra);
  }
  row.append(preview, meta);
  body.appendChild(row);

  const foot = document.createElement('div');
  foot.className = 'pa-foot';
  const cancel = document.createElement('button');
  cancel.type = 'button';
  cancel.className = 'pa-b';
  cancel.textContent = 'Cancel';
  const send = document.createElement('button');
  send.type = 'button';
  send.className = 'pa-b primary';
  send.textContent = 'Send';
  foot.append(cancel, send);
  body.appendChild(foot);

  panel.append(head, body);
  dialog.appendChild(panel);

  return new Promise<boolean>((resolve) => {
    let accepted = false;
    const accept = (): void => {
      accepted = true;
      dialog.close();
    };
    send.addEventListener('click', accept);
    cancel.addEventListener('click', () => dialog.close());
    close.addEventListener('click', () => dialog.close());
    // No Enter handler of our own: Send has focus when this opens, so Enter
    // already activates it, and a dialog-wide one would send even when the
    // reader had tabbed to Cancel and pressed Enter there.
    // Backdrop click, same convention as openImageViewer/openPaDialog.
    dialog.addEventListener('mousedown', (ev) => {
      if (ev.target === dialog) dialog.close();
    });
    // Fires once on every close path (button, Esc, backdrop) — the one place
    // the preview URL is revoked and the answer is handed back.
    dialog.addEventListener('close', () => {
      if (previewUrl) URL.revokeObjectURL(previewUrl);
      dialog.remove();
      resolve(accepted);
    });
    (document.getElementById('game') ?? document.body).appendChild(dialog);
    dialog.showModal();
    send.focus();
  });
}

/** Full-size viewer. A native <dialog> rather than a new tab: the desktop
 *  shell's setWindowOpenHandler (desktop/src/main.ts) denies every window.open
 *  and only forwards http(s) to the OS browser, so `window.open(blobUrl)` and
 *  `<a target="_blank">` both do nothing at all there (AGENTS rule 10).
 *  "Save" is an `<a download>` on the same blob URL, which Electron turns
 *  into its normal save dialog — the same mechanism the key-file export uses. */
function openImageViewer(name: string, url: string): void {
  const dialog = document.createElement('dialog');
  dialog.className = 'pa-ui mx-lightbox';

  const img = document.createElement('img');
  img.src = url;
  img.alt = name;

  const bar = document.createElement('div');
  bar.className = 'mx-lightbox-bar';
  const label = document.createElement('span');
  label.className = 'nm';
  label.textContent = name;
  // Feedback lives in the button itself: the panel's toast is below the
  // dialog's top layer, so it would be invisible from in here.
  const copy = document.createElement('button');
  copy.type = 'button';
  copy.className = 'pa-b';
  copy.textContent = 'Copy';
  let copyReset: number | undefined;
  copy.addEventListener('click', () => {
    if (copyReset !== undefined) clearTimeout(copyReset);
    copyImage(async () => (await fetch(url)).blob())
      .then(() => {
        copy.textContent = '✓ Copied';
        copy.removeAttribute('title');
      })
      .catch((e: unknown) => {
        copy.textContent = "Couldn't copy";
        copy.title = e instanceof Error ? e.message : '';
      })
      .finally(() => {
        copyReset = window.setTimeout(() => {
          copy.textContent = 'Copy';
          copy.removeAttribute('title');
        }, 1500);
      });
  });
  const save = document.createElement('a');
  save.className = 'pa-b';
  save.textContent = 'Save';
  save.href = url;
  save.download = name;
  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'pa-b';
  close.textContent = 'Close';
  close.addEventListener('click', () => dialog.close());
  bar.append(label, copy, save, close);

  dialog.append(bar, img);
  // Backdrop click (target is the <dialog> itself, not its contents) closes,
  // matching openPaDialog's convention.
  dialog.addEventListener('mousedown', (e) => {
    if (e.target === dialog) dialog.close();
  });
  dialog.addEventListener('close', () => dialog.remove());
  (document.getElementById('game') ?? document.body).appendChild(dialog);
  dialog.showModal();
  close.focus();
}
