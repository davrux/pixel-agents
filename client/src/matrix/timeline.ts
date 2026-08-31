/**
 * Matrix chat panel: the timeline renderer.
 *
 * A room's timeline is re-rendered from a full events array on every call to
 * `render()` — the caller (the sync store) owns ordering and windowing; this
 * module owns turning that array into grouped, keyed DOM without ever losing
 * scroll position, focus, or a pending/failed send.
 *
 * Message rows are the one thing that must survive across renders in place
 * (a `.mx-retry` click, text selection, focus): they live in a `Map` keyed by
 * `txnId ?? event_id` and are updated, never rebuilt, per the row-key
 * resolution order in the design doc (§5.6) — `unsigned.transaction_id`
 * first (a pending local echo resolving to its real event), then
 * `event_id`, then a fresh row. Day separators and sender-group headers hold
 * no interactive state, so they are rebuilt fresh each render and swapped in
 * with `applyOrder` (ported from `client/src/voice/MumbleUI.ts:545-559`) —
 * cheap, and it never disturbs a message row already inside them, because
 * those are moved in (not recreated) before the swap.
 *
 * There is no gap marker any more: the SDK stitches `/sync` gaps internally
 * via its own pagination, so a synthetic "messages may be missing" event can
 * never occur again.
 */
import { type MxDecryptAction, type MxEvent, type MxReader } from './types.js';
import { mkAvatar, type MxAvatarPicture } from './matrixSkin.js';
import { fileContentOf, imageContentOf, type MxFileContent, type MxImageContent } from './media.js';
import { hasFormattedBody, renderFormattedBody } from './richHtml.js';
import { copyText } from './clipboard.js';

/** Escape text to HTML. Copied verbatim from `client/src/ui/chatUI.ts` (module-
 *  private there) plus `'` -> `&#39;`, so the helper is also safe inside a
 *  single-quoted attribute — see the remote-content rule this module lives
 *  under (design doc §5.6). Do not otherwise change it: the escape-per-
 *  segment structure in `linkify` below is what keeps `javascript:`/`data:`
 *  unreachable. */
export function esc(s: string): string {
  return s.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  );
}

/** Escape text to HTML and turn http(s) URLs into links (per-segment escaping;
 *  only http/https match, so javascript:/data: can never slip in). */
export function linkify(text: string): string {
  const re = /(https?:\/\/[^\s<]+)/g;
  let out = '';
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    out += esc(text.slice(last, m.index));
    let url = m[0];
    const trail = url.match(/[.,!?;:]+$/);
    const tail = trail ? trail[0] : '';
    if (tail) url = url.slice(0, -tail.length);
    const safe = esc(url);
    out += `<a class="mx-link" href="${safe}" target="_blank" rel="noopener noreferrer nofollow">${safe}</a>${esc(tail)}`;
    last = m.index + m[0].length;
  }
  out += esc(text.slice(last));
  return out;
}

const MINUTE = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
];

/** `now` (<60s), `3m` (<1h), `2h` (<24h), `Mon 14:32` (<7 days), `12 Mar` otherwise. */
export function fmtRelative(ts: number, now: number = Date.now()): string {
  const diff = now - ts;
  if (diff < MINUTE) return 'now';
  if (diff < HOUR) return `${Math.floor(diff / MINUTE)}m`;
  if (diff < DAY) return `${Math.floor(diff / HOUR)}h`;
  const d = new Date(ts);
  if (diff < 7 * DAY) {
    const hh = String(d.getHours()).padStart(2, '0');
    const mm = String(d.getMinutes()).padStart(2, '0');
    return `${WEEKDAYS[d.getDay()]} ${hh}:${mm}`;
  }
  return `${d.getDate()} ${MONTHS[d.getMonth()]}`;
}

/** `340 B` / `12.4 KB` / `3.1 MB`. Decimal units, like every OS file manager
 *  the reader compares this against. */
export function fmtBytes(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '';
  if (n < 1000) return `${Math.round(n)} B`;
  const units = ['KB', 'MB', 'GB'];
  let v = n / 1000;
  let i = 0;
  // 999.5, not 1000: the rounding below happens after the unit is chosen, so a
  // 999 999-byte file would otherwise print as "1000 KB".
  while (v >= 999.5 && i < units.length - 1) {
    v /= 1000;
    i++;
  }
  return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${units[i]}`;
}

function sameCalendarDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate()
  );
}

/** `'Today'` / `'Yesterday'` / `'12 Mar'` for the `.mx-day` separators. */
function dayLabel(ts: number, now: number): string {
  const d = new Date(ts);
  const n = new Date(now);
  if (sameCalendarDay(d, n)) return 'Today';
  const yest = new Date(now - DAY);
  if (sameCalendarDay(d, yest)) return 'Yesterday';
  return `${d.getDate()} ${MONTHS[d.getMonth()]}`;
}

/** Makes `el`'s children exactly `nodes`, in that order, moving as little as
 *  possible. Ported from `client/src/voice/MumbleUI.ts:545-559`: a node
 *  already in the right place is never removed and re-inserted (which would
 *  drop focus and, for a live region, spuriously re-announce it). */
function applyOrder(el: HTMLElement, nodes: HTMLElement[]): void {
  let cur = el.firstChild;
  for (const want of nodes) {
    if (cur === want) {
      cur = cur.nextSibling;
      continue;
    }
    el.insertBefore(want, cur);
  }
  while (cur) {
    const next = cur.nextSibling;
    el.removeChild(cur);
    cur = next;
  }
}

/** DOM cap: never keep more than this many message rows alive at once. */
const MAX_ROWS = 400;
/**
 * How much of the capped window sits *above* the row the reader is looking at
 * when they are up in history. The rest sits below, so scrolling either way
 * has somewhere to go, and a backward page has room to land: the window slides
 * with the reader instead of being pinned to one end of the loaded events.
 */
const TRIM_KEEP_ABOVE = MAX_ROWS / 2;
/** Sender-grouping window. */
const GROUP_WINDOW_MS = 5 * MINUTE;
/** "Near the bottom" threshold for stick-to-bottom / trim-from-top decisions. */
const BOTTOM_EPS = 24;

const ATTACHMENT_TYPES = new Set(['m.image', 'm.file', 'm.audio', 'm.video']);

export interface TimelineHooks {
  /** Load older history — from the current oldest loaded event. Also the
   *  call used to retry a failed initial/backward load. */
  onPaginate(): void;
  /** Resend a message that failed to send, by its (still-pending) txn id. */
  onRetry(txnId: string): void;
  /** Resolve a sender's display name for a group header. */
  displayName(userId: string): string;
  /** A sender's profile picture for a group header: the mxc:// this room knows
   *  for them (null when they have none) plus the store's cached resolver. */
  avatarOf(userId: string): MxAvatarPicture;
  /** The `.act` link on an undecryptable row was activated — the caller
   *  routes to whatever can actually acquire a key (design doc §4.3). */
  onDecryptAction(action: MxDecryptAction): void;
  /** Resolve a displayable blob: URL for an `m.image` row (download +
   *  decrypt, cached per mxc URI by the store). Rejects with a display-ready
   *  message, which the row shows in place of the picture. */
  loadImage(content: MxImageContent): Promise<string>;
  /** The user clicked a loaded picture — open the full-size viewer. */
  onOpenImage(content: MxImageContent, url: string): void;
  /** Resolve an opaque blob: URL for an `m.file`/`m.audio`/`m.video` row.
   *  Called only when the reader clicks the row: unlike a picture, a file is
   *  not fetched to be looked at. Rejects with a display-ready message. */
  loadFile(content: MxFileContent): Promise<string>;
  /** The bytes for a file row are in hand — hand them to the browser to save
   *  under `content.body`. */
  onSaveFile(content: MxFileContent, url: string): void;
  /** The row's ⋯ button was activated: open the message menu (react / reply /
   *  edit / delete) for this event, anchored to `anchor`. */
  onOpenActions(ev: MxEvent, anchor: HTMLElement): void;
  /** A reaction chip was activated — add my reaction with that key, or take it
   *  away again if it is already mine. */
  onToggleReaction(eventId: string, key: string): void;
  /** The quote above a reply was activated — bring the quoted message into
   *  view (see `revealEvent`, which the caller routes back into). */
  onJumpToReply(eventId: string): void;
  /** The 🧵 summary under a thread root was activated — open that thread. */
  onOpenThread(rootId: string): void;
}

/** What the message menu may offer for one event. Lives here because the row's
 *  ⋯ button and the menu itself have to agree on it exactly: a button that
 *  opens an empty menu is worse than no button. */
export interface MsgActions {
  react: boolean;
  copy: boolean;
  copyImage: boolean;
  reply: boolean;
  /** Start (or join) a thread rooted at this message. */
  thread: boolean;
  edit: boolean;
  remove: boolean;
  any: boolean;
}

export function messageActionsFor(ev: MxEvent): MsgActions {
  // A local echo has no event id yet, so nothing can relate to it — and there
  // is nothing to delete server-side either. A deleted message is done.
  const settled = ev.event_id !== '' && ev.echo === undefined && !ev.redacted;
  const readable = settled && !ev.decrypting && !ev.decryptError;
  const msgtype = typeof ev.content.msgtype === 'string' ? ev.content.msgtype : 'm.text';
  const body = typeof ev.content.body === 'string' ? ev.content.body : '';
  const actions = {
    react: settled,
    // "Copy text" copies the plain `body` — for an attachment that is just the
    // filename, so those offer "Copy image" (or nothing, for a file) instead.
    copy: readable && !ATTACHMENT_TYPES.has(msgtype) && body.trim() !== '',
    copyImage: readable && imageContentOf(ev.content) !== null,
    reply: readable,
    // Matrix has no nested threads: a reply inside one relates to the thread's
    // root, never to another reply. `inThread` is set by the store on every row
    // it draws from a thread's timeline (the root included — you are already
    // there), so this offer cannot appear where it would be a lie.
    thread: readable && ev.inThread !== true,
    edit: ev.canEdit === true,
    remove: ev.canRedact === true,
    any: false,
  };
  actions.any =
    actions.react ||
    actions.copy ||
    actions.copyImage ||
    actions.reply ||
    actions.thread ||
    actions.edit ||
    actions.remove;
  return actions;
}

/** Row classes set from outside `update()` — the open-menu marker and the
 *  jump-to flash. A sync tick repainting the row must not drop them, so the
 *  class reset in `update()` puts these back. */
const STICKY_ROW_CLASSES = ['mx-menu-open', 'mx-flash'];

/** How much of a reaction key to draw. The key is remote text: usually one
 *  emoji, but nothing stops it being a paragraph, and a chip is not the place
 *  to find that out. Sliced by code point so an emoji is never cut in half. */
function reactionLabel(key: string): string {
  const points = Array.from(key);
  return points.length > 8 ? `${points.slice(0, 8).join('')}…` : key;
}

export interface TimelineRenderOpts {
  /** A generic top-of-timeline notice slot, or `null` for none. Filled by
   *  the caller — e.g. "Unlock encryption to read older messages." — never a
   *  hardcoded "this client can't read encrypted messages" (it can). */
  warning: string | null;
  atStart: boolean;
  loading: boolean;
  error: string;
  /** Read markers for this room, keyed by the event each member has read up to
   *  (see MatrixStore.readReceipts). Entries pointing outside the rendered
   *  window are simply never matched. */
  receipts: Map<string, MxReader[]>;
  /** Our own mxid — only our own messages carry a "sent" check. */
  selfUserId: string;
  /** These rows are one thread's, not a room's. Only the wording at the two
   *  ends changes — "the start of this thread" rather than "beginning of the
   *  room", and no "say hello" for a thread, whose root is always its first
   *  row. */
  inThread: boolean;
}

/** A single persisted `.mx-msg` row: built once per key, updated in place on
 *  every render that still includes it. */
interface MsgRow {
  el: HTMLDivElement;
  txt: HTMLDivElement;
  retry: HTMLSpanElement;
  /** The ⋯ button, so the view can mark the row while its menu is open. */
  menuBtn: HTMLButtonElement;
  /** The decrypt-failure action link ("Unlock"/"Verify"). Hidden except on a
   *  `decryptError` row whose `action` is set. */
  act: HTMLSpanElement;
  update(ev: MxEvent): void;
  /** Paint (or clear) this row's delivery gutter — see `setStatus` in
   *  `buildMsgRow` for why the two arguments are mutually exclusive. */
  setStatus(status: RowStatus): void;
}

/**
 * What the gutter at the end of a row shows. Element's model, and the one asked
 * for here: a check on your newest confirmed message, replaced by the pictures
 * of whoever has read up to that message.
 */
interface RowStatus {
  /** This is our own newest successfully-sent message. */
  sent: boolean;
  /** Members whose read marker sits on this event. Wins over `sent`. */
  readers: MxReader[];
}

/** How many reader pictures fit before the rest become "+N". A narrow column
 *  runs out of room long before a busy room runs out of readers. */
const MAX_RECEIPT_AVATARS = 3;

function textBodyOf(ev: MxEvent): { html: string; plain: string; isAttachment: boolean } {
  const content = ev.content;
  const msgtype = typeof content.msgtype === 'string' ? content.msgtype : 'm.text';
  const body = typeof content.body === 'string' ? content.body : '';
  if (ATTACHMENT_TYPES.has(msgtype)) {
    // Every attachment with an address is drawn by the picture or file path in
    // `update()` below and never reaches here. What is left is one that carries
    // neither `url` nor `file` — nothing to fetch, so say so rather than offer
    // a download that cannot work.
    return { html: '', plain: `📎 ${body} (this attachment has no address)`, isAttachment: true };
  }
  if (msgtype === 'm.emote') {
    return { html: '* ' + linkify(body), plain: '', isAttachment: false };
  }
  return { html: linkify(body), plain: '', isAttachment: false };
}

/** The sub-line under a file row's name: what the reader needs to decide
 *  whether to spend the download. `info.mimetype` is remote text, so only its
 *  subtype is shown and only when it looks like a type at all — it lands in a
 *  `textContent`, so this is about a row staying one line, not about escaping. */
export function describeFile(content: MxFileContent): string {
  const parts: string[] = [];
  const size = fmtBytes(content.info.size);
  if (size) parts.push(size);
  const subtype = /^[\w.+-]+\/([\w.+-]{1,24})$/.exec(content.info.mimetype)?.[1];
  if (subtype && subtype !== 'octet-stream') parts.push(subtype.toUpperCase());
  parts.push('click to save');
  return parts.join(' · ');
}

/** `linkify`, but producing nodes instead of a string — this is what
 *  `renderFormattedBody` calls for each text node it copies. It builds the
 *  anchors directly rather than reusing `linkify` and parsing its output,
 *  because feeding a generated string back through an HTML parser is the one
 *  round trip the sanitiser exists to avoid. */
function linkifyToNodes(text: string): DocumentFragment {
  const frag = document.createDocumentFragment();
  const re = /(https?:\/\/[^\s<]+)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) frag.appendChild(document.createTextNode(text.slice(last, m.index)));
    let url = m[0];
    const trail = url.match(/[.,!?;:]+$/);
    const tail = trail ? trail[0] : '';
    if (tail) url = url.slice(0, -tail.length);
    const a = document.createElement('a');
    a.className = 'mx-link';
    a.href = url;
    a.target = '_blank';
    a.rel = 'noopener noreferrer nofollow';
    a.textContent = url;
    frag.appendChild(a);
    if (tail) frag.appendChild(document.createTextNode(tail));
    last = m.index + m[0].length;
  }
  if (last < text.length) frag.appendChild(document.createTextNode(text.slice(last)));
  return frag;
}

/** Put a hover-revealed "copy" button on every code block in a sanitised
 *  fragment. The button sits *beside* the `<pre>` in a positioned wrapper, not
 *  inside it, so `pre.textContent` (what gets copied, and what a drag-select
 *  picks up) stays exactly the snippet. Called on the fragment before it is
 *  attached, so a repaint (every sync tick) rebuilds buttons along with the
 *  body it decorates. */
function addCodeCopyButtons(root: DocumentFragment): void {
  for (const pre of Array.from(root.querySelectorAll('pre'))) {
    const wrap = document.createElement('div');
    wrap.className = 'mx-codewrap';
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'mx-codecopy';
    btn.textContent = '⧉';
    btn.title = 'Copy code';
    btn.setAttribute('aria-label', 'Copy code');
    btn.addEventListener('click', () => {
      // Markdown fences always leave one trailing newline on the block; a
      // paste target rarely wants it.
      copyText((pre.textContent ?? '').replace(/\n$/, '')).then(
        () => flashCopy(btn, true),
        () => flashCopy(btn, false),
      );
    });
    pre.replaceWith(wrap);
    wrap.append(pre, btn);
  }
}

function flashCopy(btn: HTMLButtonElement, ok: boolean): void {
  btn.classList.toggle('ok', ok);
  btn.classList.toggle('failed', !ok);
  btn.textContent = ok ? '✓' : '✕';
  btn.title = ok ? 'Copied' : "Couldn't copy";
  window.setTimeout(() => {
    if (!btn.isConnected) return;
    btn.classList.remove('ok', 'failed');
    btn.textContent = '⧉';
    btn.title = 'Copy code';
  }, 1500);
}

/** Render an `org.matrix.custom.html` body into `txt`, returning false when
 *  there is nothing to render that way (so the caller falls back to plain
 *  text). The sanitised result is attached as nodes via `replaceChildren` —
 *  `txt.innerHTML` is never assigned anything derived from a remote string. */
function paintRichBody(txt: HTMLElement, ev: MxEvent, msgtype: string): boolean {
  if (!hasFormattedBody(ev.content)) return false;
  const result = renderFormattedBody(ev.content.formatted_body as string, linkifyToNodes);
  if (!result) return false;
  addCodeCopyButtons(result.fragment);

  const nodes: Node[] = [];
  // An emote is "* alice waves", including when it is formatted.
  if (msgtype === 'm.emote') nodes.push(document.createTextNode('* '));
  nodes.push(result.fragment);
  if (result.truncated) {
    const cut = document.createElement('div');
    cut.className = 'mx-rich-cut';
    cut.textContent = '(message shortened — it was too large to display in full)';
    nodes.push(cut);
  }
  txt.replaceChildren(...nodes);
  txt.classList.add('mx-rich');
  return true;
}

/** What a row needs beyond the public hooks: a way to tell the view that its
 *  own height just changed out-of-band (a picture finished decoding), so a
 *  reader who was pinned to the bottom stays there. */
interface RowDeps extends TimelineHooks {
  onMediaResize(): void;
}

function buildMsgRow(deps: RowDeps): MsgRow {
  const el = document.createElement('div');
  el.className = 'mx-msg';
  const txt = document.createElement('div');
  txt.className = 'mx-txt';
  txt.dir = 'auto';

  // ---- reply quote ------------------------------------------------------
  // A button, not a decorative block: it jumps to the quoted message, so it
  // has to be reachable and activatable from the keyboard like any other
  // control.
  const quote = document.createElement('button');
  quote.type = 'button';
  quote.className = 'mx-quote';
  quote.hidden = true;
  // The two lines are stacked by an inner element rather than by the button
  // itself: whether a <button> can be a flex container is exactly the kind of
  // thing Chrome and Firefox have disagreed about, and if the flexbox were
  // ignored these two spans would run onto one unclamped line and widen the
  // whole timeline (AGENTS rule 8 — it must work in both).
  const quoteIn = document.createElement('span');
  quoteIn.className = 'mx-quote-in';
  const quoteWho = document.createElement('span');
  quoteWho.className = 'who';
  quoteWho.dir = 'auto';
  const quoteWhat = document.createElement('span');
  quoteWhat.className = 'what';
  quoteWhat.dir = 'auto';
  quoteIn.append(quoteWho, quoteWhat);
  quote.appendChild(quoteIn);
  quote.addEventListener('click', () => {
    const id = lastEvent?.replyTo?.eventId;
    if (id) deps.onJumpToReply(id);
  });

  // ---- edited marker ----------------------------------------------------
  // Appended *inside* `.mx-txt` at the end of every update, because both body
  // paths (innerHTML for plain text, replaceChildren for a formatted body)
  // clear that element — so it cannot simply be added once.
  const edited = document.createElement('span');
  edited.className = 'mx-edited';
  edited.textContent = '(edited)';
  edited.title = 'This message was edited';

  // ---- reactions --------------------------------------------------------
  const reacts = document.createElement('div');
  reacts.className = 'mx-reacts';
  reacts.hidden = true;

  // ---- thread summary ---------------------------------------------------
  // A button for the same reason the reply quote is one: it navigates, so it
  // has to be reachable from the keyboard. Drawn only on a thread ROOT — the
  // one message a thread shares with the main timeline — and it is the only
  // route to a thread's replies from here, since the SDK keeps them out of this
  // timeline entirely.
  const threadBtn = document.createElement('button');
  threadBtn.type = 'button';
  threadBtn.className = 'mx-thread';
  threadBtn.hidden = true;
  const threadIcon = document.createElement('span');
  threadIcon.className = 'i';
  threadIcon.textContent = '🧵';
  const threadIn = document.createElement('span');
  threadIn.className = 'mx-thread-in';
  const threadCount = document.createElement('span');
  threadCount.className = 'n';
  const threadLast = document.createElement('span');
  threadLast.className = 'last';
  threadLast.dir = 'auto';
  threadIn.append(threadCount, threadLast);
  threadBtn.append(threadIcon, threadIn);
  threadBtn.addEventListener('click', () => {
    const id = lastEvent?.thread?.rootId;
    if (id) deps.onOpenThread(id);
  });

  // ---- the ⋯ menu button -----------------------------------------------
  // Kept in the tab order even while invisible (CSS reveals it on hover or
  // focus-within): hover-only actions are unreachable without a pointer, and
  // this is the only route to reply/edit/delete.
  const menuBtn = document.createElement('button');
  menuBtn.type = 'button';
  menuBtn.className = 'mx-msg-menu';
  menuBtn.textContent = '⋯';
  menuBtn.title = 'Message actions';
  menuBtn.setAttribute('aria-label', 'Message actions');
  menuBtn.setAttribute('aria-haspopup', 'menu');
  const actions = document.createElement('div');
  actions.className = 'mx-actions';
  actions.hidden = true;
  actions.appendChild(menuBtn);
  menuBtn.addEventListener('click', () => {
    if (lastEvent) deps.onOpenActions(lastEvent, menuBtn);
  });
  const retry = document.createElement('span');
  retry.className = 'mx-retry';
  retry.textContent = 'Failed — Retry';
  retry.hidden = true;
  retry.tabIndex = 0;
  retry.setAttribute('role', 'button');
  const act = document.createElement('span');
  act.className = 'act mx-link';
  act.hidden = true;
  act.tabIndex = 0;
  act.setAttribute('role', 'button');

  // ---- picture ----------------------------------------------------------
  // A real <button> rather than the delegated `.act`/`.mx-retry` spans: it is
  // keyboard-activatable for free, and the click handler needs the loaded
  // object URL, which is row state rather than something a delegate can look
  // up from the DOM.
  const figure = document.createElement('button');
  figure.type = 'button';
  figure.className = 'mx-img';
  figure.hidden = true;
  const img = document.createElement('img');
  img.decoding = 'async';
  // Never eager: a room can hold hundreds of rows and only a handful are on
  // screen. The src is a blob: URL, so this costs a decode, not a request.
  img.loading = 'lazy';
  figure.appendChild(img);

  // The download can succeed and the picture still not be displayable: an
  // `info.mimetype` outside media.ts's allowlist arrives as an opaque blob on
  // purpose (that is how `image/svg+xml` is kept out of an `<img>`), and a
  // truncated or corrupt file decodes to nothing. Either way this is the only
  // signal, so without it the reader gets a silent empty well.
  img.addEventListener('error', () => {
    if (mediaState !== 'ok') return;
    mediaState = 'error';
    mediaErr = "this client can't display that picture format";
    const content = imageContentOf(lastEvent?.content ?? {});
    if (content) paintMedia(content);
  });

  /** Per-row load bookkeeping. `key` is the mxc URI currently displayed, so a
   *  re-render (which happens on every sync tick) never restarts a download,
   *  and a row recycled onto a different event does. */
  let mediaKey = '';
  let mediaState: 'idle' | 'loading' | 'ok' | 'error' = 'idle';
  let mediaUrl = '';
  /** Kept so a plain repaint (any sync tick) doesn't downgrade a real failure
   *  message to a generic one. */
  let mediaErr = '';

  figure.addEventListener('click', () => {
    const content = imageContentOf(lastEvent?.content ?? {});
    if (mediaState === 'ok' && content) deps.onOpenImage(content, mediaUrl);
    else if (mediaState === 'error') startLoad(content, true);
  });

  let lastEvent: MxEvent | null = null;

  function startLoad(content: MxImageContent | null, force: boolean): void {
    if (!content) return;
    const key = content.file?.url ?? content.url ?? '';
    if (!force && key === mediaKey && mediaState !== 'idle') return;
    mediaKey = key;
    mediaState = 'loading';
    mediaUrl = '';
    img.removeAttribute('src');
    paintMedia(content);
    deps
      .loadImage(content)
      .then((url) => {
        // A slow download can land after this row was recycled onto another
        // event — drop it rather than paint the wrong picture.
        if (mediaKey !== key) return;
        mediaUrl = url;
        mediaState = 'ok';
        img.src = url;
        paintMedia(content);
      })
      .catch((err: unknown) => {
        if (mediaKey !== key) return;
        mediaState = 'error';
        mediaUrl = '';
        mediaErr = err instanceof Error && err.message ? err.message : "Couldn't load this picture.";
        paintMedia(content);
      });
  }

  /** Reflect the current media state into the row. Split out because three
   *  different callers (first paint, resolve, reject) need the same rules. */
  function paintMedia(content: MxImageContent): void {
    figure.hidden = false;
    el.classList.add('mx-has-img');
    img.alt = content.body;
    figure.title = content.body;
    // Reserving the real aspect ratio up front is what stops the timeline
    // from jumping under the reader when a picture pops in; `mx-img` clamps
    // the height, and unknown dimensions fall back to a fixed placeholder box.
    if (content.info.w && content.info.h) {
      figure.style.aspectRatio = `${content.info.w} / ${content.info.h}`;
      // Never blow a small picture up to the full column: cap the box at the
      // picture's own width, so a 48px sprite stays a 48px sprite and only a
      // large photo is scaled down to fit.
      figure.style.maxWidth = `min(18rem, ${content.info.w}px)`;
      figure.style.removeProperty('height');
    } else {
      figure.style.removeProperty('aspect-ratio');
      figure.style.removeProperty('max-width');
      if (mediaState !== 'ok') figure.style.height = '8rem';
      else figure.style.removeProperty('height');
    }
    figure.classList.toggle('loading', mediaState === 'loading');
    figure.classList.toggle('failed', mediaState === 'error');
    img.style.display = mediaState === 'ok' ? '' : 'none';

    if (mediaState === 'ok') {
      txt.hidden = true;
      txt.textContent = '';
    } else {
      txt.hidden = false;
      txt.textContent =
        mediaState === 'error' ? `📎 ${content.body} — ${mediaErr} (click to retry)` : `📎 ${content.body}`;
    }
    deps.onMediaResize();
  }

  function clearMedia(): void {
    if (mediaKey === '' && figure.hidden) return;
    mediaKey = '';
    mediaState = 'idle';
    mediaUrl = '';
    figure.hidden = true;
    img.removeAttribute('src');
    figure.style.removeProperty('aspect-ratio');
    figure.style.removeProperty('max-width');
    figure.style.removeProperty('height');
    el.classList.remove('mx-has-img');
  }

  // ---- file -------------------------------------------------------------
  // A file is a name, a size and a download — never bytes we fetch on the
  // reader's behalf (that is the whole difference from the picture path above:
  // a room full of files must not pull them all down to draw a row).
  const fileChip = document.createElement('button');
  fileChip.type = 'button';
  fileChip.className = 'mx-file';
  fileChip.hidden = true;
  const fileIcon = document.createElement('span');
  fileIcon.className = 'i';
  fileIcon.textContent = '📎';
  const fileText = document.createElement('span');
  fileText.className = 'mx-file-main';
  const fileName = document.createElement('span');
  fileName.className = 'nm';
  fileName.dir = 'auto';
  const fileMeta = document.createElement('span');
  fileMeta.className = 'sub';
  fileText.append(fileName, fileMeta);
  fileChip.append(fileIcon, fileText);

  /** Only 'loading' is real per-row state: a resolved download is handed
   *  straight to the browser and the chip goes back to offering itself, since
   *  the blob is cached and a second click is instant. */
  let fileState: 'idle' | 'loading' | 'error' = 'idle';
  let fileErr = '';
  /** The mxc a load is running for, so a row recycled mid-download drops it. */
  let fileKey = '';

  fileChip.addEventListener('click', () => {
    const content = fileContentOf(lastEvent?.content ?? {});
    if (!content || fileState === 'loading') return;
    const key = content.file?.url ?? content.url ?? '';
    fileKey = key;
    fileState = 'loading';
    paintFile(content);
    deps
      .loadFile(content)
      .then((url) => {
        if (fileKey !== key) return;
        fileState = 'idle';
        fileErr = '';
        paintFile(content);
        deps.onSaveFile(content, url);
      })
      .catch((err: unknown) => {
        if (fileKey !== key) return;
        fileState = 'error';
        fileErr = err instanceof Error && err.message ? err.message : "Couldn't download this file.";
        paintFile(content);
      });
  });

  function paintFile(content: MxFileContent): void {
    // Only *appearing* changes the row's height — both of the chip's lines are
    // single-line clamped, so a text swap ('Downloading…', an error) does not.
    // `update()` repaints every visible row on every sync tick, so telling the
    // view to re-pin on each of those would be 400 scrolls for no movement.
    const grew = fileChip.hidden;
    fileChip.hidden = false;
    fileName.textContent = content.body;
    fileMeta.textContent =
      fileState === 'loading'
        ? 'Downloading…'
        : fileState === 'error'
          ? `${fileErr} — click to retry`
          : describeFile(content);
    fileChip.classList.toggle('loading', fileState === 'loading');
    fileChip.classList.toggle('failed', fileState === 'error');
    fileChip.title = fileState === 'loading' ? content.body : `Save ${content.body}`;
    fileChip.setAttribute('aria-label', `Save ${content.body}`);
    // The chip carries the filename itself, so the caption row would say it
    // twice.
    txt.hidden = true;
    txt.textContent = '';
    if (grew) deps.onMediaResize();
  }

  function clearFile(): void {
    if (fileChip.hidden) return;
    fileKey = '';
    fileState = 'idle';
    fileErr = '';
    fileChip.hidden = true;
  }

  /** Neither kind of attachment: a text row, or a row that lost its content
   *  (deleted, undecryptable) while it was showing one. */
  function clearAttachments(): void {
    clearMedia();
    clearFile();
  }

  // ---- delivery gutter --------------------------------------------------
  const status = document.createElement('div');
  status.className = 'mx-status';
  status.hidden = true;

  /** Signature of what the gutter currently shows. Rebuilt only when this
   *  changes: `render()` runs on every sync tick, and rebuilding avatars each
   *  time would restart their image loads and flicker the row. */
  let statusKey = '';

  const setStatus = (next: RowStatus): void => {
    const key = next.readers.length
      ? `r:${next.readers.map((r) => `${r.userId}@${r.avatarMxc ?? ''}`).join(',')}`
      : next.sent
        ? 'sent'
        : '';
    if (key === statusKey) return;
    statusKey = key;

    if (key === '') {
      status.hidden = true;
      status.replaceChildren();
      return;
    }
    status.hidden = false;

    // Readers beat the check rather than joining it: once someone has read the
    // message, "it arrived" is no longer the interesting fact.
    if (next.readers.length) {
      const shown = next.readers.slice(0, MAX_RECEIPT_AVATARS);
      const nodes: Node[] = shown.map((r) =>
        mkAvatar(r.userId, r.displayName, deps.avatarOf(r.userId)),
      );
      if (next.readers.length > shown.length) {
        const more = document.createElement('span');
        more.className = 'mx-status-more';
        more.textContent = `+${next.readers.length - shown.length}`;
        // The names are on the avatars' own titles; this one carries the rest.
        more.title = next.readers
          .slice(shown.length)
          .map((r) => r.displayName)
          .join('\n');
        nodes.push(more);
      }
      status.replaceChildren(...nodes);
      status.title = `Read by ${next.readers.map((r) => r.displayName).join(', ')}`;
      return;
    }

    const check = document.createElement('span');
    check.className = 'mx-status-check';
    check.textContent = '✓';
    check.setAttribute('aria-label', 'Sent');
    status.replaceChildren(check);
    status.title = 'Sent';
  };

  // ---- reply quote / reactions / actions painting -----------------------

  const paintQuote = (ev: MxEvent): void => {
    const to = ev.replyTo;
    if (!to || ev.redacted) {
      quote.hidden = true;
      return;
    }
    quote.hidden = false;
    quote.classList.toggle('missing', to.missing);
    quoteWho.textContent = to.missing ? 'Quoted message' : to.senderName || to.sender;
    quoteWhat.textContent = to.missing ? 'not loaded — scroll up to find it' : to.text;
    quote.title = to.missing
      ? "That message isn't loaded yet"
      : `In reply to ${to.senderName || to.sender}${to.text ? `: ${to.text}` : ''}`;
  };

  /** A deleted root shows no summary — the store attaches no annotations at
   *  all to a redacted event, and a tombstone advertising replies reads as if
   *  the deletion had failed. The thread is still reachable from the room's
   *  threads list, which is where a deleted root is a row like any other. */
  const paintThread = (ev: MxEvent): void => {
    const info = ev.thread;
    if (!info || ev.redacted) {
      threadBtn.hidden = true;
      return;
    }
    threadBtn.hidden = false;
    threadBtn.classList.toggle('unread', info.unread > 0);
    threadBtn.classList.toggle('highlight', info.highlight > 0);
    threadBtn.classList.toggle('mine', info.participated);
    // "Thread" rather than "0 replies" for a root nobody has answered yet: a
    // thread can exist with no replies (somebody started one and left), and a
    // zero is a worse invitation to open it than the word itself.
    threadCount.textContent =
      info.count === 0 ? 'Thread' : info.count === 1 ? '1 reply' : `${info.count} replies`;
    // Remote text, so textContent only — same rule as every other row here.
    threadLast.textContent = info.lastPreview
      ? `${info.lastSenderName}: ${info.lastPreview}`
      : '';
    threadLast.hidden = !info.lastPreview;
    threadBtn.title = info.unread > 0
      ? `Open thread — ${info.unread} unread`
      : info.participated
        ? 'Open thread — you are in it'
        : 'Open thread';
    threadBtn.setAttribute(
      'aria-label',
      `${threadCount.textContent}${info.unread > 0 ? `, ${info.unread} unread` : ''}. Open thread.`,
    );
  };

  /** Signature of the chips currently drawn. Same reason as `statusKey`:
   *  `render()` runs on every sync tick, and rebuilding the chips each time
   *  would drop a focused one out from under the keyboard. */
  let reactKey = '';

  const paintReactions = (ev: MxEvent): void => {
    const list = ev.redacted ? [] : ev.reactions ?? [];
    const key = list.map((r) => `${r.key}\0${r.count}\0${r.mine ? 1 : 0}${r.myEventId ? '!' : ''}`).join('');
    if (key === reactKey) return;
    reactKey = key;
    // Clicking a chip changes its own count, so the rebuild below removes the
    // very element that was activated — and focus with it, all the way out to
    // <body>, where the panel stops owning the keyboard and WASD starts walking
    // the player's avatar. Remember which key had focus and hand it to whatever
    // replaces it; if that key is gone entirely (my own last reaction removed),
    // fall back to the row's ⋯ button, which is still inside the panel.
    const active = document.activeElement;
    const refocusKey =
      active instanceof HTMLElement && reacts.contains(active) ? active.dataset.mxKey ?? '' : null;
    if (list.length === 0) {
      reacts.hidden = true;
      reacts.replaceChildren();
      if (refocusKey !== null && !actions.hidden) menuBtn.focus();
      return;
    }
    reacts.replaceChildren(
      ...list.map((r) => {
        const chip = document.createElement('button');
        chip.type = 'button';
        chip.className = 'mx-react';
        // Only ever compared (see refocusKey), never rendered from.
        chip.dataset.mxKey = r.key;
        if (r.mine) chip.classList.add('mine');
        // Mine, but still in flight — there is no reaction event to redact yet,
        // so the chip says "wait" rather than silently ignoring a click.
        if (r.mine && !r.myEventId) chip.classList.add('pending');
        const label = document.createElement('span');
        label.className = 'k';
        label.textContent = reactionLabel(r.key);
        const count = document.createElement('span');
        count.className = 'n';
        count.textContent = String(r.count);
        chip.append(label, count);
        chip.title = `${r.senderNames.join(', ')} reacted with ${reactionLabel(r.key)}`;
        chip.setAttribute(
          'aria-label',
          `${r.mine ? 'Remove your reaction' : 'React'} ${reactionLabel(r.key)}, ${r.count}`,
        );
        chip.addEventListener('click', () => {
          const id = lastEvent?.event_id;
          if (id) deps.onToggleReaction(id, r.key);
        });
        return chip;
      }),
    );
    reacts.hidden = false;
    if (refocusKey !== null) {
      const again = Array.from(reacts.children).find(
        (c) => c instanceof HTMLElement && c.dataset.mxKey === refocusKey,
      );
      if (again instanceof HTMLElement) again.focus();
      else if (!actions.hidden) menuBtn.focus();
    }
  };

  el.append(quote, txt, figure, fileChip, retry, act, reacts, threadBtn, status, actions);

  const update = (ev: MxEvent): void => {
    lastEvent = ev;
    el.className = ['mx-msg', ...STICKY_ROW_CLASSES.filter((c) => el.classList.contains(c))].join(' ');
    // Reset here too: `.mx-rich` is added by the formatted-body path, and a row
    // recycled onto a plain message must not keep its block spacing.
    txt.className = 'mx-txt';
    el.removeAttribute('title');
    txt.hidden = false;
    retry.hidden = true;
    act.hidden = true;
    paintQuote(ev);
    paintReactions(ev);
    paintThread(ev);
    actions.hidden = !messageActionsFor(ev).any;

    if (ev.redacted) {
      el.classList.add('deleted');
      clearAttachments();
      txt.textContent = '(message deleted)';
      return;
    }
    // Dispatch on the SDK's own decryption-state predicates, never on
    // `getType()` — a UTD event's `getType()` returns the *clear* type the
    // SDK installs (`m.room.message`, with a raw `** Unable to decrypt: … **`
    // string as its body), and an in-flight decryption has no body at all.
    // Reading either as a normal message would render a lie or a blank row
    // (design doc §4.3/§4.7). Two hard rules: a row is never blank, and an
    // event is never silently dropped.
    if (ev.decrypting) {
      el.classList.add('mx-utd', 'working');
      clearAttachments();
      txt.textContent = '🔒 Decrypting…';
      return;
    }
    if (ev.decryptError) {
      el.classList.add('mx-utd');
      clearAttachments();
      txt.textContent = ev.decryptError.text;
      el.title = ev.decryptError.code;
      if (ev.decryptError.action) {
        act.textContent = ev.decryptError.action === 'unlock' ? 'Unlock' : 'Verify';
        act.hidden = false;
      }
      // Deliberately no "retry decryption" control here — a UTD is fixed by
      // acquiring a key, not by retrying, and the SDK repaints this row by
      // itself (via the store's re-emit on MatrixEventEvent.Decrypted) the
      // moment a key arrives.
      return;
    }

    const msgtype = typeof ev.content.msgtype === 'string' ? ev.content.msgtype : 'm.text';
    if (msgtype === 'm.notice') el.classList.add('notice');
    else if (msgtype === 'm.emote') el.classList.add('emote');

    const image = imageContentOf(ev.content);
    const file = image ? null : fileContentOf(ev.content);
    if (image) {
      clearFile();
      // `el.className` was reset above, so the marker class and the whole
      // media state have to be re-applied on every update, not just the one
      // that starts the download.
      if (mediaKey === (image.file?.url ?? image.url ?? '') && mediaState !== 'idle') paintMedia(image);
      else startLoad(image, false);
    } else if (file) {
      clearMedia();
      // Same reason as the picture path: the class reset above means the chip
      // has to be re-painted on every update, not only on a state change. A
      // load already in flight for this same mxc keeps its 'Downloading…'.
      if ((file.file?.url ?? file.url ?? '') !== fileKey) {
        fileState = 'idle';
        fileErr = '';
        fileKey = '';
      }
      paintFile(file);
    } else {
      clearAttachments();
      const body = textBodyOf(ev);
      if (body.isAttachment) {
        txt.textContent = body.plain;
      } else if (!paintRichBody(txt, ev, msgtype)) {
        // No usable formatted_body — the plain-text path, unchanged.
        txt.innerHTML = body.html;
      }
    }

    // Last, because both body paths above replace `.mx-txt`'s children. Not
    // shown on a picture row: its `.mx-txt` is the filename caption, and
    // pictures cannot be edited in the first place.
    if (ev.edited === true && !txt.hidden) txt.appendChild(edited);

    if (ev.echo === 'pending') el.classList.add('pending');
    else if (ev.echo === 'failed') {
      el.classList.add('failed');
      retry.hidden = false;
    }
  };

  return { el, txt, retry, act, menuBtn, update, setStatus };
}

/** One rendered top-level item: a day separator or a sender group. Only
 *  `.el` is placed in the DOM — everything else is bookkeeping used while
 *  building this render pass. */
type TopItem =
  | { kind: 'day'; el: HTMLDivElement }
  | { kind: 'group'; el: HTMLDivElement; body: HTMLDivElement; sender: string; lastTs: number };

/**
 * The row a render has to keep still, and where it was: the topmost row that
 * was on screen when the render started, plus its offset from the top of the
 * viewport.
 *
 * Putting *that row* back where it was is the general form of "don't move the
 * timeline under the reader" — it holds whether the render prepended a
 * backward page, appended a new message, or sliid the capped window (all
 * three at once, even), which is more than a before/after scrollHeight delta
 * can say.
 */
interface ScrollAnchor {
  el: HTMLElement;
  /** Row key, so the trim below can find the same event in the new array. */
  key: string;
  offset: number;
}

/** Does `ev` resolve to `key` under the same rules as `resolveRow`? */
function eventHasKey(ev: MxEvent, key: string): boolean {
  return ev.event_id === key || ev.txnId === key || ev.unsigned?.transaction_id === key;
}

export class TimelineView {
  readonly el: HTMLDivElement;

  private readonly hooks: TimelineHooks;
  private readonly rowDeps: RowDeps;
  private readonly rows = new Map<string, MsgRow>();
  private readonly moreEl: HTMLDivElement;
  private readonly noticeEl: HTMLDivElement;
  private readonly emptyEl: HTMLDivElement;
  private readonly retryTokens = new WeakMap<HTMLElement, string>();
  private readonly decryptActionTokens = new WeakMap<HTMLElement, MxDecryptAction>();
  private groupTimeEls: { el: HTMLElement; ts: number }[] = [];
  /** Row key whose message menu is currently open — see `setMenuOpenRow`. */
  private menuRowId: string | null = null;
  private moreInteractive = false;
  /**
   * Whether reaching the top should load more by itself. Distinct from
   * `moreInteractive`, which is also true in the error state — auto-retrying a
   * failed pagination on every intersection would hammer a homeserver that is
   * already refusing, so an error stays a deliberate click.
   */
  private autoPaginate = false;
  /** Set when we ask, cleared by the render that reflects the request. Guards
   *  the window before the store reports `loading`. */
  private paginateRequested = false;
  private topObserver: IntersectionObserver | null = null;
  /** Watches our own box, not our content: the composer beside us grows as the
   *  reader types (and the reply bar appears above it), which takes height away
   *  from this scroller and would otherwise slide the newest message out from
   *  under someone who is in the middle of answering it. */
  private sizeObserver: ResizeObserver | null = null;
  /** Set by `pinToBottom()`, consumed by the next `render()`. See there for why
   *  this outlives the call rather than just scrolling on the spot. */
  private forceBottom = false;
  /** Whether a reader is pinned to the newest message. Maintained from real
   *  scrolls and from each render, so `onMediaResize` can answer "should this
   *  picture push the view down?" without measuring after the fact. */
  private stickToBottom = true;

  private readonly onScroll = (): void => {
    this.stickToBottom = this.isAtBottom();
    // A pin that is still waiting for its render is an intent ("show me what I
    // just sent"), and scrolling away is the reader withdrawing it. Without
    // this it survives until *some* render happens — which, for a send that
    // never produces one (a picture whose upload fails), means an unrelated
    // message minutes later yanks the timeline to the bottom.
    if (!this.stickToBottom) this.forceBottom = false;
  };

  private readonly onClick = (e: MouseEvent): void => {
    const t = e.target as HTMLElement | null;
    if (!t) return;
    if (this.moreInteractive && t.closest('.mx-more') === this.moreEl) {
      this.hooks.onPaginate();
      return;
    }
    const retryEl = t.closest('.mx-retry') as HTMLElement | null;
    if (retryEl) {
      const txnId = this.retryTokens.get(retryEl);
      if (txnId) this.hooks.onRetry(txnId);
      return;
    }
    const actEl = t.closest('.act') as HTMLElement | null;
    if (actEl) {
      const action = this.decryptActionTokens.get(actEl);
      if (action) this.hooks.onDecryptAction(action);
      return;
    }
  };

  private readonly onKeydown = (e: KeyboardEvent): void => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    const t = e.target as HTMLElement | null;
    if (!t) return;
    if (t.closest('.mx-more, .mx-retry, .act')) {
      e.preventDefault();
      this.onClick({ target: t } as unknown as MouseEvent);
    }
  };

  constructor(hooks: TimelineHooks) {
    this.hooks = hooks;
    this.el = document.createElement('div');
    this.el.id = 'pa-mx-tl';
    this.el.setAttribute('role', 'log');
    this.el.setAttribute('aria-live', 'off');
    this.el.tabIndex = -1;

    this.moreEl = document.createElement('div');
    this.moreEl.className = 'mx-more';
    this.moreEl.tabIndex = 0;
    this.moreEl.setAttribute('role', 'button');

    this.noticeEl = document.createElement('div');
    this.noticeEl.className = 'mx-notice';

    this.emptyEl = document.createElement('div');
    this.emptyEl.className = 'mx-notice';
    this.emptyEl.textContent = 'No messages yet — say hello.';

    this.el.addEventListener('click', this.onClick);
    this.el.addEventListener('keydown', this.onKeydown);
    this.el.addEventListener('scroll', this.onScroll, { passive: true });

    // Infinite scrollback: the "load earlier" element doubles as the sentinel.
    // An observer rather than a scrollTop threshold in `onScroll`, because it
    // also fires when the loaded history is simply shorter than the panel — the
    // case a scroll handler never sees, since there is nothing to scroll. That
    // is what fills a tall window on open instead of leaving it half empty.
    //
    // It self-limits without a counter: each page is prepended and `render()`
    // restores the scroll position, which pushes the sentinel back out of view.
    // It only fires again once the reader scrolls up to it — and stops for good
    // at `atStart`.
    //
    // "Pushes it out of view" is what re-arms it, though, and a page does not
    // always manage that: 80 events that are all reactions, redactions or
    // membership changes render nothing at all, and a short page can leave a
    // tall panel still unfilled. An observer only reports *crossings*, so in
    // both cases the sentinel stays continuously intersecting and never fires
    // again — scrollback dies silently. `rearmTopObserver` below re-delivers
    // the current state after each render to cover exactly that.
    if (typeof IntersectionObserver === 'function') {
      this.topObserver = new IntersectionObserver(
        (entries) => {
          if (!entries.some((e) => e.isIntersecting)) return;
          if (!this.autoPaginate || this.paginateRequested) return;
          this.paginateRequested = true;
          this.hooks.onPaginate();
        },
        // Start fetching before the sentinel is actually on screen, so the reader
        // meets loaded messages rather than a spinner.
        { root: this.el, rootMargin: '300px 0px 0px 0px' },
      );
      this.topObserver.observe(this.moreEl);
    }

    // Same reasoning as `onMediaResize` below, for the other axis: by the time
    // the box has shrunk, "am I at the bottom" is already false for exactly the
    // reader we are trying to keep put, so this reads the remembered stickiness.
    if (typeof ResizeObserver === 'function') {
      this.sizeObserver = new ResizeObserver(() => {
        if (this.stickToBottom) this.scrollToBottom();
      });
      this.sizeObserver.observe(this.el);
    }

    this.rowDeps = {
      ...hooks,
      onMediaResize: () => {
        // Deliberately reads the *remembered* stickiness rather than
        // isAtBottom(): by the time a picture reports its size the row has
        // already grown, so "am I at the bottom" is answered after the shove
        // and would be false for exactly the reader we're trying to keep put.
        if (this.stickToBottom) this.scrollToBottom();
      },
    };
  }

  isAtBottom(): boolean {
    return this.el.scrollHeight - this.el.scrollTop - this.el.clientHeight < BOTTOM_EPS;
  }

  scrollToBottom(): void {
    this.el.scrollTop = this.el.scrollHeight;
  }

  /**
   * "I just sent something — show it to me." Jumps to the newest message even
   * if the reader had scrolled up into history, which the normal render path
   * deliberately does not do (it preserves your position so an arriving message
   * never yanks the timeline out from under you).
   *
   * Scrolls now *and* arms the next render, because at send time the message
   * usually isn't in the DOM yet: a text send's local echo arrives a microtask
   * later via `LocalEchoUpdated`, and a picture's only after the upload
   * finishes. Scrolling on the spot alone would land on the old bottom and stop
   * a row short; the flag is what carries the intent across to the render that
   * actually adds the row.
   */
  pinToBottom(): void {
    this.forceBottom = true;
    this.stickToBottom = true;
    this.scrollToBottom();
  }

  /**
   * "A different room is about to be drawn here." One TimelineView serves every
   * room (MatrixUI builds it once), so without this the next `render()` decides
   * where to land from the *previous* room's scroll offset: leave a room while
   * reading history, open another, and it opens somewhere in the middle of that
   * one's history with nothing to say so — and, because MatrixUI only marks a
   * room read when `isAtBottom()`, it does not clear its unread badge either.
   *
   * Rows are dropped rather than left for the next render to reconcile: they
   * belong to the room being left, and a key collision across rooms is not
   * worth reasoning about. `forceBottom` is what actually lands the new room on
   * its newest message — the same "show me" the composer's send uses.
   */
  reset(): void {
    for (const row of this.rows.values()) row.el.remove();
    this.rows.clear();
    this.groupTimeEls = [];
    this.menuRowId = null;
    this.paginateRequested = false;
    this.forceBottom = true;
    this.stickToBottom = true;
    this.el.scrollTop = 0;
  }

  render(events: MxEvent[], opts: TimelineRenderOpts): void {
    // Read once, up front: everything below decides from these, and the render
    // itself moves the layout they describe.
    //
    // A pin is consumed here rather than at the end, because it also decides
    // *which* messages get built — a send while scrolled up in a room past the
    // DOM cap would otherwise keep the history window and drop the very message
    // it is about to scroll to.
    const pinned = this.forceBottom;
    this.forceBottom = false;
    const keepBottom = this.isAtBottom() || pinned;
    const anchor = keepBottom ? null : this.captureAnchor();
    if (!keepBottom) this.el.setAttribute('aria-busy', 'true');

    this.renderMore(opts);

    const renderable = events.filter((ev) => ev.type === 'm.room.message' || ev.type === 'm.room.encrypted');

    // Enforce the 400-message DOM cap on the *input* before grouping, so a
    // trim never leaves an orphaned, now-empty group wrapper or day
    // separator behind — trimming here means those events are simply never
    // built for the dropped rows.
    //
    // The window slides with the reader rather than sticking to one end of the
    // loaded events. Pinning it to an end looks stable until the reader crosses
    // the cap, and then flips the whole window between "newest 400" and "oldest
    // 400" depending on where they happen to be standing — one arriving message
    // while they read history used to jump them ~60 messages backwards.
    let trimmed = renderable;
    if (renderable.length > MAX_ROWS) {
      const maxStart = renderable.length - MAX_ROWS;
      let start = maxStart;
      if (!keepBottom) {
        const at = anchor === null ? -1 : renderable.findIndex((ev) => eventHasKey(ev, anchor.key));
        // No anchor to find (it was redacted away, or there were no rows yet)
        // leaves the newest window, which is where a reader with nothing on
        // screen to keep still is best served anyway.
        if (at >= 0) start = Math.min(Math.max(0, at - TRIM_KEEP_ABOVE), maxStart);
      }
      trimmed = renderable.slice(start, start + MAX_ROWS);
    }

    const touchedKeys = new Set<string>();
    const topNodes: HTMLElement[] = [this.moreEl];
    const noticeShown = opts.warning !== null;
    this.noticeEl.hidden = !noticeShown;
    if (opts.warning !== null) {
      this.noticeEl.textContent = opts.warning;
      topNodes.push(this.noticeEl);
    }

    // The single "sent" check goes on our newest confirmed message, so it has
    // to be picked before any row paints — hence a pass over the window rather
    // than a flag set inside the loop below. `echo` set means the event is still
    // in flight or failed (the row already says so through .pending/.failed),
    // and a redacted message has nothing left to confirm.
    let sentCheckEventId: string | null = null;
    for (let i = trimmed.length - 1; i >= 0; i--) {
      const ev = trimmed[i]!;
      if (ev.sender !== opts.selfUserId) continue;
      if (ev.echo !== undefined) continue;
      if (ev.redacted) continue;
      sentCheckEventId = ev.event_id;
      break;
    }

    this.groupTimeEls = [];
    let currentGroup: (TopItem & { kind: 'group' }) | null = null;
    let lastDay: string | null = null;
    let newestGroup: HTMLDivElement | null = null;
    const now = Date.now();

    for (const ev of trimmed) {
      const day = dayLabel(ev.origin_server_ts, now);
      if (day !== lastDay) {
        lastDay = day;
        currentGroup = null;
        const dayEl = document.createElement('div');
        dayEl.className = 'mx-day';
        dayEl.textContent = day;
        topNodes.push(dayEl);
      }

      const withinGroup =
        currentGroup &&
        currentGroup.sender === ev.sender &&
        Math.abs(ev.origin_server_ts - currentGroup.lastTs) <= GROUP_WINDOW_MS;
      if (!withinGroup) {
        const group = this.buildGroup(ev);
        currentGroup = group;
        topNodes.push(group.el);
        newestGroup = group.el;
      } else if (currentGroup) {
        currentGroup.lastTs = ev.origin_server_ts;
      }

      const { row, key } = this.resolveRow(ev);
      touchedKeys.add(key);
      if (!row.retry.hidden && ev.txnId) {
        this.retryTokens.set(row.retry, ev.txnId);
      }
      if (!row.act.hidden && ev.decryptError?.action) {
        this.decryptActionTokens.set(row.act, ev.decryptError.action);
      }
      // Unconditional, including the empty case: a row recycled from a message
      // that had the check (or a reader on it) must lose it here, or the marker
      // stays behind on the wrong message.
      row.setStatus({
        sent: ev.event_id !== '' && ev.event_id === sentCheckEventId,
        readers: opts.receipts.get(ev.event_id) ?? [],
      });
      currentGroup!.body.appendChild(row.el);
    }

    // Drop rows that are no longer part of this render at all (e.g. trimmed,
    // or the event vanished from upstream state).
    for (const [key, row] of this.rows) {
      if (!touchedKeys.has(key)) {
        row.el.remove();
        this.rows.delete(key);
      }
    }

    const emptyShown = topNodes.length === (noticeShown ? 2 : 1) && !opts.loading && !opts.error;
    this.emptyEl.hidden = !emptyShown;
    // A thread always has at least its root, so an empty one means its history
    // has not arrived yet — never "say hello", which would be an invitation to
    // start something that already exists.
    this.emptyEl.textContent = opts.inThread
      ? 'Loading this thread…'
      : 'No messages yet — say hello.';
    if (emptyShown) topNodes.push(this.emptyEl);

    if (newestGroup) newestGroup.setAttribute('aria-live', 'polite');

    applyOrder(this.el, topNodes);

    // A pinned render lands at the bottom, which makes `isAtBottom()` true for
    // the render after it, so the pin carries itself forward until the reader
    // scrolls away again (`onScroll` also drops an unconsumed one).
    if (keepBottom) this.scrollToBottom();
    else if (anchor) this.restoreAnchor(anchor);
    this.stickToBottom = keepBottom;
    this.el.removeAttribute('aria-busy');
    this.rearmTopObserver();
  }

  /** The topmost row still on screen, and how far below the top of the viewport
   *  it sits — see ScrollAnchor. Null when nothing is rendered yet. */
  private captureAnchor(): ScrollAnchor | null {
    const viewTop = this.el.getBoundingClientRect().top;
    for (const el of this.el.querySelectorAll<HTMLElement>('.mx-msg')) {
      const rect = el.getBoundingClientRect();
      // The first row whose *bottom* has not yet passed the fold: the one the
      // reader is actually looking at, even when it is only half on screen.
      if (rect.bottom <= viewTop) continue;
      // An event with neither an id nor a txn id keys to '', which would match
      // the wrong event in the trim below — better no anchor than a wrong one.
      const key = el.dataset.rowKey;
      if (!key) continue;
      return { el, key, offset: rect.top - viewTop };
    }
    return null;
  }

  /** Put the anchor row back where it was. Nothing to do when this render
   *  dropped it (trimmed, redacted, or the room changed under us) — there is no
   *  honest position to restore in that case. */
  private restoreAnchor(anchor: ScrollAnchor): void {
    if (!this.el.contains(anchor.el)) return;
    const viewTop = this.el.getBoundingClientRect().top;
    this.el.scrollTop += anchor.el.getBoundingClientRect().top - viewTop - anchor.offset;
  }

  /**
   * Re-deliver the sentinel's current intersection state on the next frame.
   *
   * An IntersectionObserver reports crossings, not states, so a render that
   * left the sentinel where it already was — a page of events that render
   * nothing, or one too short to fill the panel — would never hear from it
   * again. Re-observing asks for one fresh report; when the sentinel really is
   * off screen (the ordinary case) that report is "not intersecting" and the
   * callback returns immediately.
   */
  private rearmTopObserver(): void {
    if (!this.topObserver || !this.autoPaginate || this.paginateRequested) return;
    this.topObserver.unobserve(this.moreEl);
    this.topObserver.observe(this.moreEl);
  }

  /**
   * Scroll the quoted message into view and flash it, for the reply quote's
   * "jump to this" click. Returns false when that message is not one of the
   * rows we hold — trimmed, or never paginated to — so the caller can say so
   * instead of leaving a dead control.
   *
   * Scrolls only our own scroller (rather than `scrollIntoView`, which walks
   * every scrollable ancestor and would move the docked panel or the page
   * under the reader).
   */
  revealEvent(eventId: string): boolean {
    const row = this.rows.get(eventId);
    if (!row) return false;
    const target = row.el.getBoundingClientRect();
    const view = this.el.getBoundingClientRect();
    this.el.scrollTop += target.top - view.top - Math.max(0, (view.height - target.height) / 2);
    // Restart the flash even if this row is already the flashing one: clicking
    // the same quote twice has to look like it did something.
    row.el.classList.remove('mx-flash');
    void row.el.offsetWidth;
    row.el.classList.add('mx-flash');
    this.stickToBottom = this.isAtBottom();
    return true;
  }

  /** Mark the row whose menu is open, so its ⋯ button stays visible while the
   *  pointer is over the menu rather than the row. */
  setMenuOpenRow(eventId: string | null): void {
    const mark = (id: string | null, on: boolean): void => {
      const row = id === null ? undefined : this.rows.get(id);
      if (!row) return;
      row.el.classList.toggle('mx-menu-open', on);
      row.menuBtn.setAttribute('aria-expanded', on ? 'true' : 'false');
    };
    if (this.menuRowId === eventId) return;
    mark(this.menuRowId, false);
    this.menuRowId = eventId;
    mark(eventId, true);
  }

  refreshTimes(): void {
    const now = Date.now();
    for (const { el, ts } of this.groupTimeEls) {
      el.textContent = fmtRelative(ts, now);
    }
  }

  destroy(): void {
    this.el.removeEventListener('click', this.onClick);
    this.el.removeEventListener('scroll', this.onScroll);
    this.topObserver?.disconnect();
    this.topObserver = null;
    this.sizeObserver?.disconnect();
    this.sizeObserver = null;
    this.rows.clear();
    this.groupTimeEls = [];
  }

  private renderMore(opts: TimelineRenderOpts): void {
    this.moreEl.replaceChildren();
    this.moreEl.removeAttribute('aria-disabled');
    // Auto-load only while there is more to fetch and nothing is wrong: never
    // during a load (the store is already working), never at the start of the
    // room, and never on an error (that stays a click — see `autoPaginate`).
    this.autoPaginate = !opts.error && !opts.loading && !opts.atStart;
    // Once the store reports it is loading, the request we made has landed and
    // the guard's job is done; `autoPaginate` holds the line from here.
    if (opts.loading || opts.error || opts.atStart) this.paginateRequested = false;
    if (opts.error) {
      this.moreEl.append('Could not load messages. ');
      const errSpan = document.createElement('span');
      errSpan.textContent = opts.error;
      this.moreEl.appendChild(errSpan);
      this.moreEl.append(' ');
      const retry = document.createElement('span');
      retry.className = 'mx-link';
      retry.textContent = 'Retry';
      this.moreEl.appendChild(retry);
      this.moreInteractive = true;
    } else if (opts.loading) {
      this.moreEl.textContent = 'Loading…';
      this.moreInteractive = false;
    } else if (opts.atStart) {
      this.moreEl.textContent = opts.inThread ? 'Start of this thread.' : 'Beginning of the room.';
      this.moreEl.setAttribute('aria-disabled', 'true');
      this.moreInteractive = false;
    } else {
      this.moreEl.textContent = 'Load earlier messages';
      this.moreInteractive = true;
    }
  }

  private buildGroup(ev: MxEvent): TopItem & { kind: 'group' } {
    const el = document.createElement('div');
    el.className = 'mx-grp';
    const head = document.createElement('div');
    head.className = 'mx-grp-head';
    head.appendChild(mkAvatar(ev.sender, this.hooks.displayName(ev.sender), this.hooks.avatarOf(ev.sender)));
    const nm = document.createElement('span');
    nm.className = 'nm';
    nm.dir = 'auto';
    nm.textContent = this.hooks.displayName(ev.sender);
    const time = document.createElement('span');
    time.className = 'mx-time';
    time.textContent = fmtRelative(ev.origin_server_ts);
    time.title = new Date(ev.origin_server_ts).toLocaleString();
    head.append(nm, time);
    const body = document.createElement('div');
    body.className = 'mx-grp-body';
    el.append(head, body);
    this.groupTimeEls.push({ el: time, ts: ev.origin_server_ts });
    return { kind: 'group', el, body, sender: ev.sender, lastTs: ev.origin_server_ts };
  }

  /** Row-key resolution order (design doc §5.6): a pending echo's
   *  `unsigned.transaction_id` first (Synapse can deliver the real event down
   *  `/sync` before the `PUT` response with its event_id returns, so at that
   *  moment only the txn id is known to have a row already); then
   *  `event_id`; otherwise a fresh row. */
  private resolveRow(ev: MxEvent): { row: MsgRow; key: string } {
    const txnId = ev.unsigned?.transaction_id ?? ev.txnId;
    let key: string | null = null;
    if (txnId && this.rows.has(txnId)) key = txnId;
    else if (this.rows.has(ev.event_id)) key = ev.event_id;

    if (key !== null) {
      const row = this.rows.get(key)!;
      // The pending echo (keyed by txnId) has resolved to its real event —
      // re-key so a later redaction/edit lookup by event_id still finds it.
      if (key !== ev.event_id && ev.event_id) {
        this.rows.delete(key);
        this.rows.set(ev.event_id, row);
        key = ev.event_id;
      }
      row.update(ev);
      // Kept on the element itself so `captureAnchor` can read the key off a
      // row it found by walking the DOM in timeline order — the `rows` map is
      // in insertion order, which re-keying above does not preserve.
      row.el.dataset.rowKey = key;
      return { row, key };
    }

    const row = buildMsgRow(this.rowDeps);
    row.update(ev);
    const newKey = ev.txnId ?? ev.event_id;
    row.el.dataset.rowKey = newKey;
    this.rows.set(newKey, row);
    return { row, key: newKey };
  }
}
