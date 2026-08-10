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
import { type MxDecryptAction, type MxEvent } from './types.js';
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
}

export interface TimelineRenderOpts {
  /** A generic top-of-timeline notice slot, or `null` for none. Filled by
   *  the caller — e.g. "Unlock encryption to read older messages." — never a
   *  hardcoded "this client can't read encrypted messages" (it can). */
  warning: string | null;
  atStart: boolean;
  loading: boolean;
  error: string;
}

/** A single persisted `.mx-msg` row: built once per key, updated in place on
 *  every render that still includes it. */
interface MsgRow {
  el: HTMLDivElement;
  txt: HTMLDivElement;
  retry: HTMLSpanElement;
  /** The decrypt-failure action link ("Unlock"/"Verify"). Hidden except on a
   *  `decryptError` row whose `action` is set. */
  act: HTMLSpanElement;
  update(ev: MxEvent): void;
}

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

  el.append(txt, figure, retry, act);

  const update = (ev: MxEvent): void => {
    lastEvent = ev;
    el.className = 'mx-msg';
    // Reset here too: `.mx-rich` is added by the formatted-body path, and a row
    // recycled onto a plain message must not keep its block spacing.
    txt.className = 'mx-txt';
    el.removeAttribute('title');
    txt.hidden = false;
    retry.hidden = true;
    act.hidden = true;

    if (ev.unsigned?.redacted_because !== undefined) {
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

    if (ev.echo === 'pending') el.classList.add('pending');
    else if (ev.echo === 'failed') {
      el.classList.add('failed');
      retry.hidden = false;
    }
  };

  return { el, txt, retry, act, update };
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
  private moreInteractive = false;
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
    if (before.atBottom) {
      this.scrollToBottom();
    } else if (prepended) {
      this.el.scrollTop = before.scrollTop + (this.el.scrollHeight - before.scrollHeight);
    }
    this.stickToBottom = before.atBottom;
    this.lastFirstKey = firstMsgKey;
    this.el.removeAttribute('aria-busy');
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
    this.rows.clear();
    this.groupTimeEls = [];
  }

  private renderMore(opts: TimelineRenderOpts): void {
    this.moreEl.replaceChildren();
    this.moreEl.removeAttribute('aria-disabled');
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
