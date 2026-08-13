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
import { imageContentOf, type MxImageContent } from './media.js';
import { hasFormattedBody, renderFormattedBody } from './richHtml.js';

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
  /** The row's ⋯ button was activated: open the message menu (react / reply /
   *  edit / delete) for this event, anchored to `anchor`. */
  onOpenActions(ev: MxEvent, anchor: HTMLElement): void;
  /** A reaction chip was activated — add my reaction with that key, or take it
   *  away again if it is already mine. */
  onToggleReaction(eventId: string, key: string): void;
  /** The quote above a reply was activated — bring the quoted message into
   *  view (see `revealEvent`, which the caller routes back into). */
  onJumpToReply(eventId: string): void;
}

/** What the message menu may offer for one event. Lives here because the row's
 *  ⋯ button and the menu itself have to agree on it exactly: a button that
 *  opens an empty menu is worse than no button. */
export interface MsgActions {
  react: boolean;
  reply: boolean;
  edit: boolean;
  remove: boolean;
  any: boolean;
}

export function messageActionsFor(ev: MxEvent): MsgActions {
  // A local echo has no event id yet, so nothing can relate to it — and there
  // is nothing to delete server-side either. A deleted message is done.
  const settled = ev.event_id !== '' && ev.echo === undefined && !ev.redacted;
  const readable = settled && !ev.decrypting && !ev.decryptError;
  const actions = {
    react: settled,
    reply: readable,
    edit: ev.canEdit === true,
    remove: ev.canRedact === true,
    any: false,
  };
  actions.any = actions.react || actions.reply || actions.edit || actions.remove;
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
    // m.image is handled by the picture path in `update()` below and never
    // reaches here; the rest genuinely aren't supported yet.
    return { html: '', plain: `📎 ${body} (not supported in this client)`, isAttachment: true };
  }
  if (msgtype === 'm.emote') {
    return { html: '* ' + linkify(body), plain: '', isAttachment: false };
  }
  return { html: linkify(body), plain: '', isAttachment: false };
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

/** Render an `org.matrix.custom.html` body into `txt`, returning false when
 *  there is nothing to render that way (so the caller falls back to plain
 *  text). The sanitised result is attached as nodes via `replaceChildren` —
 *  `txt.innerHTML` is never assigned anything derived from a remote string. */
function paintRichBody(txt: HTMLElement, ev: MxEvent, msgtype: string): boolean {
  if (!hasFormattedBody(ev.content)) return false;
  const result = renderFormattedBody(ev.content.formatted_body as string, linkifyToNodes);
  if (!result) return false;

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

  /** Signature of the chips currently drawn. Same reason as `statusKey`:
   *  `render()` runs on every sync tick, and rebuilding the chips each time
   *  would drop a focused one out from under the keyboard. */
  let reactKey = '';

  const paintReactions = (ev: MxEvent): void => {
    const list = ev.redacted ? [] : ev.reactions ?? [];
    const key = list.map((r) => `${r.key} ${r.count} ${r.mine ? 1 : 0}${r.myEventId ? '!' : ''}`).join('');
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

  el.append(quote, txt, figure, retry, act, reacts, status, actions);

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
    actions.hidden = !messageActionsFor(ev).any;

    if (ev.redacted) {
      el.classList.add('deleted');
      clearMedia();
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
      clearMedia();
      txt.textContent = '🔒 Decrypting…';
      return;
    }
    if (ev.decryptError) {
      el.classList.add('mx-utd');
      clearMedia();
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
    if (image) {
      // `el.className` was reset above, so the marker class and the whole
      // media state have to be re-applied on every update, not just the one
      // that starts the download.
      if (mediaKey === (image.file?.url ?? image.url ?? '') && mediaState !== 'idle') paintMedia(image);
      else startLoad(image, false);
    } else {
      clearMedia();
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
  private lastFirstKey: string | null = null;
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
  /** Set by `pinToBottom()`, consumed by the next `render()`. See there for why
   *  this outlives the call rather than just scrolling on the spot. */
  private forceBottom = false;
  /** Whether a reader is pinned to the newest message. Maintained from real
   *  scrolls and from each render, so `onMediaResize` can answer "should this
   *  picture push the view down?" without measuring after the fact. */
  private stickToBottom = true;

  private readonly onScroll = (): void => {
    this.stickToBottom = this.isAtBottom();
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
    // It only fires again once the reader scrolls up to it, or if the viewport
    // still isn't full — and stops for good at `atStart`.
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

  render(events: MxEvent[], opts: TimelineRenderOpts): void {
    const before = {
      scrollTop: this.el.scrollTop,
      scrollHeight: this.el.scrollHeight,
      atBottom: this.isAtBottom(),
    };
    if (!before.atBottom) this.el.setAttribute('aria-busy', 'true');

    this.renderMore(opts);

    const renderable = events.filter((ev) => ev.type === 'm.room.message' || ev.type === 'm.room.encrypted');

    // Enforce the 400-message DOM cap on the *input* before grouping, so a
    // trim never leaves an orphaned, now-empty group wrapper or day
    // separator behind — trimming here means those events are simply never
    // built for the dropped rows.
    let trimmed = renderable;
    if (renderable.length > MAX_ROWS) {
      const over = renderable.length - MAX_ROWS;
      trimmed = before.atBottom
        // Drop from the front (oldest) — a reader at the bottom never sees it.
        ? renderable.slice(over)
        // Scrolled up reading history — drop from the back (newest) instead,
        // keeping the reader's current position stable.
        : renderable.slice(0, renderable.length - over);
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
    let firstMsgKey: string | null = null;
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
      if (firstMsgKey === null) firstMsgKey = key;
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
    if (emptyShown) topNodes.push(this.emptyEl);

    if (newestGroup) newestGroup.setAttribute('aria-live', 'polite');

    applyOrder(this.el, topNodes);

    const prepended =
      this.lastFirstKey !== null && this.lastFirstKey !== firstMsgKey && this.rows.has(this.lastFirstKey);
    // One-shot: a pinned render lands at the bottom, which makes `atBottom` true
    // for the render after it, so the pin carries itself forward until the
    // reader scrolls away again.
    const pinned = this.forceBottom;
    this.forceBottom = false;
    if (before.atBottom || pinned) {
      this.scrollToBottom();
    } else if (prepended) {
      this.el.scrollTop = before.scrollTop + (this.el.scrollHeight - before.scrollHeight);
    }
    this.stickToBottom = before.atBottom || pinned;
    this.lastFirstKey = firstMsgKey;
    this.el.removeAttribute('aria-busy');
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
      this.moreEl.textContent = 'Beginning of the room.';
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
      return { row, key };
    }

    const row = buildMsgRow(this.rowDeps);
    row.update(ev);
    const newKey = ev.txnId ?? ev.event_id;
    this.rows.set(newKey, row);
    return { row, key: newKey };
  }
}
