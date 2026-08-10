/**
 * The one place remote HTML becomes DOM: `formatted_body` from an
 * `org.matrix.custom.html` message, turned into a tree of nodes we built
 * ourselves.
 *
 * The rule this module exists to keep (AGENTS.md: never `innerHTML` with
 * remote content) is upheld in a specific way, and every part of it matters:
 *
 * 1. The remote string is parsed with `DOMParser` into a *detached, inert*
 *    document. Nothing in that document runs: scripts do not execute, `<img>`
 *    does not fetch, no handler fires. It is only a parse tree.
 * 2. That tree is then *rebuilt* node by node into fresh elements, keeping
 *    only allowlisted tags and — per tag — allowlisted attributes. Nothing is
 *    ever copied wholesale, so an attribute nobody thought about (`onerror`,
 *    `srcdoc`, `formaction`, whatever a future spec adds) cannot survive: it
 *    is not that it is stripped, it is that it is never read.
 * 3. Text arrives via `textContent` only.
 *
 * The tag/attribute lists follow the Matrix spec's own list for
 * `formatted_body`, minus what this client has no renderer for. Two
 * deliberate departures, both so that nothing is silently lost:
 *   - `<img>` (inline emotes, stickers) becomes its `alt` text in a marked
 *     span rather than vanishing.
 *   - `<mx-reply>` (a reply's quoted fallback) is dropped whole, which is what
 *     the spec tells clients to do — there is no reply UI here to put it in.
 *
 * Sending is the mirror of this file: markdown.ts produces HTML from the same
 * subset, so a message we send renders the same way in our own timeline as it
 * does in Element.
 */

/** Tags kept, mapped to the attributes allowed on each. An empty array means
 *  "keep the element, drop every attribute". Anything not listed here is
 *  unwrapped (children kept) or dropped whole — see `DROP_WHOLE`. */
const ALLOWED: Record<string, readonly string[]> = {
  p: [],
  br: [],
  div: [],
  span: [],
  b: [],
  strong: [],
  i: [],
  em: [],
  u: [],
  s: [],
  del: [],
  sup: [],
  sub: [],
  code: ['class'],
  pre: [],
  blockquote: [],
  ul: [],
  ol: ['start'],
  li: [],
  hr: [],
  h1: [],
  h2: [],
  h3: [],
  h4: [],
  h5: [],
  h6: [],
  a: ['href'],
  table: [],
  thead: [],
  tbody: [],
  tr: [],
  th: [],
  td: [],
  caption: [],
  details: [],
  summary: [],
};

/** Elements whose *contents* must not be shown either. Unwrapping these would
 *  turn a script body or a stylesheet into visible message text — harmless but
 *  absurd — and `mx-reply` is a fallback the spec says to remove. */
const DROP_WHOLE = new Set(['script', 'style', 'noscript', 'template', 'iframe', 'object', 'embed', 'svg', 'math', 'mx-reply', 'form', 'input', 'button', 'select', 'textarea', 'link', 'meta', 'base', 'title', 'head']);

/** URL schemes a link may use. `javascript:`, `data:`, `blob:`, `file:` and
 *  everything else are refused — the check is an allowlist against the scheme
 *  the URL parser reports, never a search for bad substrings. */
const SAFE_SCHEMES = new Set(['http:', 'https:', 'ftp:', 'mailto:', 'matrix:', 'magnet:', 'tel:', 'xmpp:']);

/** Bounds on a single message's markup. A `formatted_body` is remote input, so
 *  it gets an explicit budget rather than however much the parser will take:
 *  ~4k nested `<b>` is a layout/CPU problem even though it is not a security
 *  one. Exceeding either bound truncates; it never throws. */
const MAX_NODES = 4000;
const MAX_DEPTH = 32;

/** True when this content should be rendered through the HTML path at all. */
export function hasFormattedBody(content: Record<string, unknown>): boolean {
  return (
    content.format === 'org.matrix.custom.html' &&
    typeof content.formatted_body === 'string' &&
    content.formatted_body.length > 0
  );
}

export interface RichHtmlResult {
  fragment: DocumentFragment;
  /** True when the budget above cut the message short, so the caller can say
   *  so instead of quietly showing a partial message. */
  truncated: boolean;
}

/**
 * Sanitise `html` into a fragment of freshly built nodes. Returns null when
 * there is nothing renderable, so the caller can fall back to the plain-text
 * body rather than show an empty bubble.
 *
 * `linkifyText` is passed in (rather than imported) to keep this module free of
 * timeline concerns: it turns a bare URL inside a *text node* into a link, the
 * same way plain-text messages get one. It is not applied inside `<pre>`/
 * `<code>`, where a URL is part of the snippet and must stay literal.
 */
export function renderFormattedBody(
  html: string,
  linkifyText: (text: string) => DocumentFragment,
): RichHtmlResult | null {
  let parsed: Document;
  try {
    parsed = new DOMParser().parseFromString(html, 'text/html');
  } catch {
    return null;
  }
  const body = parsed.body;
  if (!body) return null;

  const budget = { nodes: MAX_NODES, truncated: false };
  const out = document.createDocumentFragment();
  copyChildren(body, out, 0, budget, false, linkifyText);
  if (!out.hasChildNodes()) return null;
  return { fragment: out, truncated: budget.truncated };
}

interface Budget {
  nodes: number;
  truncated: boolean;
}

function copyChildren(
  src: Node,
  dest: Node,
  depth: number,
  budget: Budget,
  literal: boolean,
  linkifyText: (text: string) => DocumentFragment,
): void {
  for (const child of Array.from(src.childNodes)) {
    if (budget.nodes <= 0) {
      budget.truncated = true;
      return;
    }
    budget.nodes--;

    if (child.nodeType === Node.TEXT_NODE) {
      const text = child.nodeValue ?? '';
      if (!text) continue;
      // Inside <pre>/<code> a URL is part of the snippet, not a link.
      dest.appendChild(literal ? document.createTextNode(text) : linkifyText(text));
      continue;
    }
    if (child.nodeType !== Node.ELEMENT_NODE) continue; // comments, CDATA, …

    const el = child as Element;
    const tag = el.tagName.toLowerCase();
    if (DROP_WHOLE.has(tag)) continue;

    if (tag === 'img') {
      const alt = el.getAttribute('alt') || el.getAttribute('title') || '';
      // Not rendered as a picture (this client has no inline-emote support),
      // but not dropped either — an emote-only message would otherwise be a
      // blank bubble.
      const span = document.createElement('span');
      span.className = 'mx-inline-img';
      span.textContent = alt ? `[${alt}]` : '[image]';
      dest.appendChild(span);
      continue;
    }

    const allowedAttrs = ALLOWED[tag];
    if (allowedAttrs === undefined) {
      // Unknown but harmless (font, article, section, a custom element…):
      // keep the text inside it rather than the box around it.
      if (depth < MAX_DEPTH) copyChildren(el, dest, depth + 1, budget, literal, linkifyText);
      continue;
    }
    if (depth >= MAX_DEPTH) {
      budget.truncated = true;
      continue;
    }

    const clean = document.createElement(tag);
    for (const name of allowedAttrs) {
      const value = el.getAttribute(name);
      if (value === null) continue;
      applyAttribute(clean, tag, name, value);
    }
    if (tag === 'a') {
      // No href survived validation — render the text, not a dead link.
      if (!clean.hasAttribute('href')) {
        copyChildren(el, dest, depth + 1, budget, literal, linkifyText);
        continue;
      }
      clean.className = 'mx-link';
      (clean as HTMLAnchorElement).target = '_blank';
      clean.setAttribute('rel', 'noopener noreferrer nofollow');
    }

    const nowLiteral = literal || tag === 'pre' || tag === 'code';
    copyChildren(el, clean, depth + 1, budget, nowLiteral, linkifyText);
    dest.appendChild(clean);
  }
}

function applyAttribute(clean: Element, tag: string, name: string, value: string): void {
  if (tag === 'a' && name === 'href') {
    const href = safeHref(value);
    if (href) clean.setAttribute('href', href);
    return;
  }
  if (tag === 'code' && name === 'class') {
    // Only the spec's `language-*` hint, and only its own characters — this
    // string reaches a class attribute, so it must not be able to add another.
    const lang = /^language-([A-Za-z0-9_+#.-]{1,32})$/.exec(value.trim());
    if (lang) clean.className = `language-${lang[1]}`;
    return;
  }
  if (tag === 'ol' && name === 'start') {
    const n = Number.parseInt(value, 10);
    if (Number.isFinite(n) && n > 0 && n < 1_000_000) clean.setAttribute('start', String(n));
    return;
  }
}

/** Resolve and scheme-check a link. Relative URLs are refused outright: there
 *  is no sensible base for them here, and resolving one against this app's own
 *  origin would turn someone else's message into a link into our UI. */
function safeHref(value: string): string | null {
  const raw = value.trim();
  if (!raw) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (!SAFE_SCHEMES.has(url.protocol)) return null;
  return url.toString();
}
