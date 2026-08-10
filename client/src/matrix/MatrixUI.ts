/**
 * Matrix chat panel: the view router, all eight views (login, rooms, room,
 * members, newdm, newgroup, join, encryption), the composer and the
 * pin/status strip.
 *
 * Rendered into whatever container the host gives it (the panel's `.pa-body`).
 * This module owns no network transport and no persistence beyond the small
 * view/draft breadcrumbs described below — that all lives in MatrixStore
 * (./store.js, a thin projection over matrix-js-sdk) and the session helpers
 * (./session.js). This file is purely "given a store, draw the panel; given
 * clicks, drive the store."
 *
 * Navigation is a small explicit stack: `rooms` is the root, `room` pushes on
 * top of it, `members` pushes on top of `room`, and `newdm`/`newgroup`/`join`/
 * `encryption` push directly on top of `rooms`. Every view is rebuilt from
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
import { MatrixError, type MxDirectoryUser, type MxMember, type MxRoom, type MxSession } from './types.js';
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
import { mkAvatar, type MxAvatarPicture } from './matrixSkin.js';
import { fmtRelative, TimelineView, type TimelineHooks } from './timeline.js';
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
  | 'newdm'
  | 'newgroup'
  | 'join'
  | 'encryption'
  | 'notifications';
type RoomsTab = 'people' | 'groups' | 'invites';

interface ViewFrame {
  view: ViewName;
  roomId?: string;
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
  /** Set by openDm() when called signed-out (e.g. from `/matrix @user:server`
   *  before login finishes); replayed once a store exists. */
  private pendingDmMxid: string | null = null;
  /** Tracks whether the login view is currently standing in for a boot
   *  failure ('locked-out' / 'wipe-pending') so renderTopStrip can notice a
   *  transition without re-running the whole navigation stack every tick. */
  private bootGateActive = false;
  /** Once a sign-out reports databases it could not delete, the warning
   *  banner stays up for the rest of this session — it is explicitly
   *  non-dismissable (design doc §2.4/9). */
  private wipeWarnShown = false;
  private lastEncryptedState = new Map<string, boolean>();

  // ---- status strip ----
  private topEl!: HTMLDivElement;
  private dotEl!: HTMLSpanElement;
  private statusLabelEl!: HTMLSpanElement;
  private retryLink!: HTMLAnchorElement;
  private meEl!: HTMLSpanElement;
  private meAvatarSlot!: HTMLButtonElement;
  private avatarInput!: HTMLInputElement;
  private roomAvatarSlot!: HTMLSpanElement;
  private avatarBusy = false;
  private encBtn!: HTMLButtonElement;
  /** Desktop builds only — the browser has no OS notification to configure. */
  private notifyBtn?: HTMLButtonElement;
  private notifyEnabledEl?: HTMLInputElement;
  private notifyBodyEl?: HTMLInputElement;
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
  private roomNameEl!: HTMLSpanElement;
  private roomLockEl!: HTMLSpanElement;
  private roomMembersBtn!: HTMLButtonElement;
  private roomNoticeEl!: HTMLDivElement;
  private timelineView!: TimelineView;
  private composerTextarea!: HTMLTextAreaElement;
  private composerSendBtn!: HTMLButtonElement;
  private composerDisabledEl!: HTMLDivElement;
  private attachBtn!: HTMLButtonElement;
  private attachInput!: HTMLInputElement;
  private uploadStatusEl!: HTMLDivElement;
  /** One upload at a time: the status line has room for one, and a second
   *  concurrent encrypt+upload of a multi-megabyte file on a tab that is also
   *  rendering a game is not worth the complexity. */
  private uploading = false;
  private refreshTimer?: number;

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
          this.renderRoomView(this.openRoomId);
        }
      }),
      this.store.on('timeline', (roomId) => {
        if (this.openRoomId === roomId && this.stack[this.stack.length - 1]?.view === 'room') {
          this.renderRoomView(roomId);
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
        if (top?.view === 'room' && this.openRoomId) this.renderRoomView(this.openRoomId);
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
    if (expired) {
      this.loginErrEl.textContent = 'Your Matrix session expired — sign in again.';
      this.loginErrEl.style.display = '';
    }
    if (!soft && store && store.lastWipeFailed.length > 0) {
      this.wipeWarnShown = true;
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
      if (top) sessionStorage.setItem('pa-mx-view', JSON.stringify({ view: top.view, roomId: top.roomId }));
    } catch {
      /* ignore */
    }
  }

  private restoreView(): void {
    try {
      const raw = sessionStorage.getItem('pa-mx-view');
      if (!raw) return;
      const saved = JSON.parse(raw) as { view?: ViewName; roomId?: string };
      if (saved.view === 'room' && saved.roomId) {
        this.openRoomView(saved.roomId);
      } else if (saved.view === 'members' && saved.roomId) {
        this.openRoomView(saved.roomId);
        this.openMembersView();
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
        if (frame.roomId) this.renderRoomView(frame.roomId);
        break;
      case 'members':
        if (frame.roomId) this.renderMembersView(frame.roomId);
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
    this.hideUploadStatus();
    this.store?.openRoom(roomId).catch(() => {
      /* surfaced via store.timelineError() in the next render */
    });
    this.startTimelineRefresh();
    this.renderCurrent();
    try {
      this.composerTextarea.value = sessionStorage.getItem(`pa-mx-draft:${roomId}`) ?? '';
    } catch {
      this.composerTextarea.value = '';
    }
    this.autoGrow(this.composerTextarea);
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
      this.store?.closeRoom();
      this.openRoomId = null;
      this.stopTimelineRefresh();
    }
    this.renderCurrent();
  }

  private goRoot(): void {
    if (this.stack.some((f) => f.view === 'room')) {
      this.store?.closeRoom();
      this.openRoomId = null;
      this.stopTimelineRefresh();
    }
    this.stack = [{ view: 'rooms' }];
    this.renderCurrent();
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

    // Desktop only, and hidden rather than disabled in the browser: there is no
    // OS notification to configure there (bridge.ts's notifyDesktop is a no-op),
    // so a settings page for it would be a page of lies.
    if (isDesktop()) {
      this.notifyBtn = document.createElement('button');
      this.notifyBtn.className = 'pa-b mx-notifybtn';
      this.notifyBtn.textContent = '🔔';
      this.notifyBtn.setAttribute('aria-label', 'Notifications');
      this.notifyBtn.title = 'Desktop notifications';
      // Same toggle behaviour as 🔐 — always visible, so a second press has to
      // be the way back out rather than a no-op re-render.
      this.notifyBtn.addEventListener('click', () => {
        if (this.stack[this.stack.length - 1]?.view === 'notifications') this.goRoot();
        else this.pushRootView('notifications');
      });
      top.appendChild(this.notifyBtn);
    }

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
    const on = readNotifyPrefs().enabled;
    this.notifyBtn.classList.toggle('off', !on);
    this.notifyBtn.title = on ? 'Desktop notifications' : 'Desktop notifications — off';
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

    const subhead = document.createElement('div');
    subhead.className = 'mx-subhead';
    const back = document.createElement('button');
    back.className = 'pa-b';
    back.textContent = '◀';
    back.addEventListener('click', () => this.goBack());
    subhead.appendChild(back);

    this.roomAvatarSlot = document.createElement('span');
    this.roomAvatarSlot.className = 'mx-av-slot';
    subhead.appendChild(this.roomAvatarSlot);

    this.roomNameEl = document.createElement('span');
    this.roomNameEl.className = 'mx-room-name';
    subhead.appendChild(this.roomNameEl);

    this.roomLockEl = document.createElement('span');
    this.roomLockEl.textContent = '🔒';
    this.roomLockEl.style.display = 'none';
    subhead.appendChild(this.roomLockEl);

    this.roomMembersBtn = document.createElement('button');
    this.roomMembersBtn.className = 'pa-b';
    this.roomMembersBtn.addEventListener('click', () => this.openMembersView());
    subhead.appendChild(this.roomMembersBtn);

    section.appendChild(subhead);

    this.roomNoticeEl = document.createElement('div');
    this.roomNoticeEl.className = 'mx-notice';
    this.roomNoticeEl.style.display = 'none';
    section.appendChild(this.roomNoticeEl);

    const hooks: TimelineHooks = {
      onPaginate: () => {
        if (this.openRoomId) {
          this.store?.paginate(this.openRoomId).catch(() => {
            /* surfaced via store.timelineError() in the next render */
          });
        }
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
    };
    this.timelineView = new TimelineView(hooks);
    section.appendChild(this.timelineView.el);

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
        this.composerTextarea.blur();
      }
    });
    this.composerTextarea.addEventListener('input', () => {
      this.autoGrow(this.composerTextarea);
      this.saveDraft();
    });
    // A picture pasted into the composer is the fastest path there is for the
    // screenshot this feature exists for, so it gets the same treatment as the
    // 🖼 button — see handlePickedFiles for the shared validation.
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
    this.attachInput.accept = 'image/png,image/jpeg,image/gif';
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
    this.attachBtn.textContent = '🖼';
    this.attachBtn.setAttribute('aria-label', 'Send a picture');
    this.attachBtn.title = 'Send a picture (PNG, JPEG, GIF) — or paste/drop one into the message box';
    this.attachBtn.addEventListener('click', () => this.attachInput.click());

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
    composer.append(
      this.composerTextarea,
      this.attachBtn,
      this.composerSendBtn,
      this.attachInput,
      this.uploadStatusEl,
      this.composerDisabledEl,
    );
    section.appendChild(composer);

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

  private renderRoomView(roomId: string): void {
    if (!this.store) return;
    const room = this.store.room(roomId);
    this.roomNameEl.textContent = room?.name ?? roomId;
    this.roomNameEl.title = room?.name ?? roomId;
    this.paintAvatarSlot(this.roomAvatarSlot, roomId, room?.name ?? roomId, room?.avatarMxc ?? null);

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
    this.composerTextarea.style.display = composerDisabled ? 'none' : '';
    this.composerSendBtn.style.display = composerDisabled ? 'none' : '';
    // Pictures go out the same door as text: if this session can't send a
    // message it must not be able to send a picture either — otherwise the
    // 🖼 button is a live control sitting next to "sending is unavailable".
    this.attachBtn.style.display = composerDisabled ? 'none' : '';
    this.composerDisabledEl.style.display = composerDisabled ? '' : 'none';

    const events = this.store.timeline(roomId);
    this.timelineView.render(events, {
      warning,
      atStart: this.store.atStart(roomId),
      loading: this.store.loadingTimeline(roomId),
      error: this.store.timelineError(roomId),
    });

    if (!document.hidden && this.timelineView.isAtBottom()) {
      this.store.markRead(roomId);
    }
  }

  private autoGrow(ta: HTMLTextAreaElement): void {
    ta.rows = 1;
    ta.style.height = 'auto';
    const cs = getComputedStyle(ta);
    const lineHeight = parseFloat(cs.lineHeight) || 20;
    const rows = Math.min(5, Math.max(1, Math.round(ta.scrollHeight / lineHeight)));
    ta.rows = rows;
  }

  private saveDraft(): void {
    const rid = this.openRoomId;
    if (!rid) return;
    try {
      const v = this.composerTextarea.value;
      if (v) sessionStorage.setItem(`pa-mx-draft:${rid}`, v);
      else sessionStorage.removeItem(`pa-mx-draft:${rid}`);
    } catch {
      /* ignore */
    }
  }

  private clearDraft(rid: string): void {
    try {
      sessionStorage.removeItem(`pa-mx-draft:${rid}`);
    } catch {
      /* ignore */
    }
  }

  private sendComposer(): void {
    const rid = this.openRoomId;
    if (!rid || !this.store) return;
    // client.sendTextMessage consults the room's own encryption state and
    // encrypts automatically — there is nothing left to gate here.
    const body = this.composerTextarea.value.trim();
    if (!body) return;
    this.composerTextarea.value = '';
    this.autoGrow(this.composerTextarea);
    this.clearDraft(rid);
    void this.store.send(rid, body).catch(() => {
      /* the store surfaces the failure via the echo row itself */
    });
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

  /** The single entry point for every way a picture can arrive (🖼 button,
   *  paste, drop). Unlike a text send there is no local echo to fail into
   *  until the upload finishes, so failures land in the composer's own status
   *  line instead of a `.failed` row. */
  private async handlePickedFiles(files: File[]): Promise<void> {
    const rid = this.openRoomId;
    if (!rid || !this.store) return;
    // Paste and drop reach here even though the button is hidden — same gate.
    if (this.store.cryptoState === 'unavailable') {
      this.showUploadStatus("Sending isn't available in this browser session.", 'err');
      return;
    }
    if (this.uploading) {
      this.showUploadStatus('Still sending the last picture…', 'err');
      return;
    }
    const file = files[0];
    if (!file) return;
    if (files.length > 1) {
      this.showUploadStatus(`Sending the first of ${files.length} files — one at a time for now.`, '');
    }
    // A courtesy check only — File.type is whatever the OS guessed from the
    // extension. The real gate is the magic-byte sniff in media.ts, which runs
    // on the bytes and also decides the mimetype the event will claim.
    if (file.type && !SENDABLE_TYPES.has(file.type)) {
      this.showUploadStatus('Pictures can be PNG, JPEG or GIF.', 'err');
      return;
    }

    this.uploading = true;
    this.attachBtn.disabled = true;
    this.showUploadStatus(`Sending ${file.name}…`, '');
    try {
      await this.store.sendImage(rid, file, (fraction) => {
        if (this.openRoomId !== rid) return;
        this.showUploadStatus(`Sending ${file.name}… ${Math.round(fraction * 100)}%`, '');
      });
      this.hideUploadStatus();
    } catch (err) {
      const msg = err instanceof Error && err.message ? err.message : "Couldn't send that picture.";
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
  // notifications view (desktop only)
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
    const key = `${seed} ${label} ${mxc ?? ''}`;
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
// picture helpers (module-private)
// ======================================================================

/** Mirrors media.ts's `sniffImage` — kept here only so an obviously wrong
 *  pick is refused before the file is read. media.ts remains the authority. */
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
  const type = SENDABLE_TYPES.has(f.type) ? f.type : 'image/png';
  const ext = type === 'image/jpeg' ? 'jpg' : type === 'image/gif' ? 'gif' : 'png';
  return new File([f], `pasted.${ext}`, { type });
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
  bar.append(label, save, close);

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
