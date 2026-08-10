/**
 * Composer markdown -> the HTML subset `richHtml.ts` renders, for the
 * `formatted_body` half of an `org.matrix.custom.html` message.
 *
 * Deliberately a documented subset rather than CommonMark-via-a-library: the
 * grammar below is what a chat composer actually needs (code first, since
 * pasting a snippet is the whole point), it adds no dependency to a lazily
 * loaded chunk that already carries a 7.8 MB wasm, and — the part that matters
 * — every path from user text to HTML goes through one escaper here, which is
 * short enough to read in full. A markdown library would be the more capable
 * choice and the harder one to audit.
 *
 * Supported: fenced code (``` with an optional language), inline `code`,
 * **bold**, *italic*, ~~strikethrough~~, [text](url), bare URLs, > quotes,
 * `-`/`*`/`+` and `1.` lists, `#`..`######` headings, and `---` rules.
 *
 * Two invariants:
 *
 *  - `body` (the plain-text field) always stays the user's original text.
 *    That is what Element does, and it is what clients with no HTML renderer
 *    will show, so it must never become the generated HTML.
 *  - `toHtml` returns null when the text uses no formatting at all, so an
 *    ordinary message stays a plain `m.text` instead of carrying a redundant
 *    `formatted_body` copy of itself.
 */

/** Escape for HTML text content and quoted attribute values. The only escaper
 *  in this file; every interpolation below goes through it or through a value
 *  this module generated itself. */
function esc(s: string): string {
  return s.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  );
}

const URL_RE = /(https?:\/\/[^\s<>()[\]]+)/g;

/** Trailing punctuation that is far more likely to be the sentence's than the
 *  URL's. Mirrors timeline.ts's plain-text linkifier. */
function splitTrailingPunctuation(url: string): [string, string] {
  const m = url.match(/[.,!?;:]+$/);
  if (!m) return [url, ''];
  return [url.slice(0, -m[0].length), m[0]];
}

function linkifyEscaped(text: string): string {
  let out = '';
  let last = 0;
  let m: RegExpExecArray | null;
  URL_RE.lastIndex = 0;
  while ((m = URL_RE.exec(text)) !== null) {
    out += esc(text.slice(last, m.index));
    const [url, tail] = splitTrailingPunctuation(m[0]);
    const safe = esc(url);
    out += `<a href="${safe}">${safe}</a>${esc(tail)}`;
    last = m.index + m[0].length;
  }
  return out + esc(text.slice(last));
}

/** Inline markup for one line of text. Code spans and links are extracted
 *  *first*, replaced by sentinels, and spliced back in only after every other
 *  rule has run — so `**` inside a snippet stays literal, emphasis can never
 *  reach into a code span, and the generated HTML is never itself re-escaped
 *  or re-matched.
 *
 *  The sentinels are control characters (never legal in a chat line, and
 *  stripped from the input by `toHtml` before we get here) wrapping an index.
 *  Using anything printable — a digit run, say — would mean an innocent
 *  message about "3 apples" could collide with a placeholder. */
const CODE_SENTINEL = '\u0000';
const LINK_SENTINEL = '\u0001';

function inline(src: string): string {
  const spans: string[] = [];
  // `` … `` before ` … `, and the double form matches lazily *across* single
  // backticks — that is the whole reason the double form exists, so
  // ``a ` b`` has to keep the inner backtick as content.
  let text = src.replace(/``([^\n]*?)``|`([^`\n]+)`/g, (_all, double: string | undefined, single: string | undefined) => {
    const code = double ?? single ?? '';
    spans.push(`<code>${esc(code)}</code>`);
    return `${CODE_SENTINEL}${spans.length - 1}${CODE_SENTINEL}`;
  });

  // Explicit links before autolinking, so [text](url) doesn't get its own url
  // linkified a second time.
  const links: string[] = [];
  text = text.replace(/\[([^\]\n]*)\]\(([^\s)]+)\)/g, (all, label: string, href: string) => {
    const safe = safeUrl(href);
    if (!safe) return all;
    links.push(`<a href="${esc(safe)}">${esc(label) || esc(safe)}</a>`);
    return `${LINK_SENTINEL}${links.length - 1}${LINK_SENTINEL}`;
  });

  text = linkifyEscaped(text);

  // Emphasis, longest marker first. The surrounding character classes keep
  // `a_b_c` (an identifier) and `2 * 3 * 4` from turning into emphasis, which
  // is the most annoying false positive in a developer chat.
  text = text.replace(/~~(?=\S)([^\n]*?\S)~~/g, '<del>$1</del>');
  text = text.replace(/\*\*(?=\S)([^\n]*?\S)\*\*/g, '<strong>$1</strong>');
  text = text.replace(/(^|[\s(])__(?=\S)([^\n]*?\S)__(?=$|[\s.,!?;:)])/g, '$1<strong>$2</strong>');
  text = text.replace(/(^|[^\w*])\*(?=\S)([^\n*]*?\S)\*(?!\w)/g, '$1<em>$2</em>');
  text = text.replace(/(^|[\s(])_(?=\S)([^\n_]*?\S)_(?=$|[\s.,!?;:)])/g, '$1<em>$2</em>');

  // Splice the extracted HTML back in. These strings were built above and are
  // already escaped, which is exactly why this happens last.
  text = text.replace(new RegExp(`${LINK_SENTINEL}(\\d+)${LINK_SENTINEL}`, 'g'), (_a, i: string) => links[Number(i)] ?? '');
  return text.replace(new RegExp(`${CODE_SENTINEL}(\\d+)${CODE_SENTINEL}`, 'g'), (_a, i: string) => spans[Number(i)] ?? '');
}

function safeUrl(raw: string): string | null {
  try {
    const url = new URL(raw.trim());
    if (!['http:', 'https:', 'ftp:', 'mailto:', 'matrix:', 'magnet:', 'tel:', 'xmpp:'].includes(url.protocol)) {
      return null;
    }
    return url.toString();
  } catch {
    return null;
  }
}

/** Does this text use any construct we would translate? Used to decide whether
 *  the message needs a `formatted_body` at all. */
function hasMarkup(src: string): boolean {
  return (
    /```/.test(src) ||
    /`[^`\n]+`/.test(src) ||
    /\*\*[^\n]+\*\*|~~[^\n]+~~/.test(src) ||
    /(^|[^\w*])\*[^\s*][^\n*]*\*(?!\w)/.test(src) ||
    /(^|\s)_[^\s_][^\n_]*_(?=$|[\s.,!?;:)])/.test(src) ||
    /\[[^\]\n]*\]\([^\s)]+\)/.test(src) ||
    /^\s{0,3}(#{1,6}\s|>\s?|[-*+]\s|\d{1,9}[.)]\s|(-{3,}|\*{3,}|_{3,})\s*$)/m.test(src) ||
    URL_RE.test(src)
  );
}

/**
 * Translate composer text to `formatted_body` HTML, or null when it contains
 * nothing to format.
 */
export function toHtml(src: string): string | null {
  if (!hasMarkup(src)) return null;
  // Remove the sentinel characters `inline` relies on before they can be
  // confused with ones we inserted. They carry no meaning in a chat message.
  const clean = src.replace(/[\u0000-\u0002]/g, '');
  const lines = clean.replace(/\r\n?/g, '\n').split('\n');
  const out: string[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i]!;

    // ---- fenced code. Everything up to the closing fence is literal, which
    // is why this is handled before any other rule.
    const fence = /^\s{0,3}(`{3,}|~{3,})\s*([A-Za-z0-9_+#.-]{0,32})\s*$/.exec(line);
    if (fence) {
      const marker = fence[1]!;
      const lang = fence[2] ?? '';
      const closer = marker[0]!;
      const body: string[] = [];
      i++;
      while (i < lines.length) {
        const cur = lines[i]!;
        if (new RegExp(`^\\s{0,3}${closer === '`' ? '`' : '~'}{${marker.length},}\\s*$`).test(cur)) {
          i++;
          break;
        }
        body.push(cur);
        i++;
      }
      const cls = lang ? ` class="language-${esc(lang)}"` : '';
      out.push(`<pre><code${cls}>${esc(body.join('\n'))}</code></pre>`);
      continue;
    }

    // ---- horizontal rule
    if (/^\s{0,3}(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      out.push('<hr />');
      i++;
      continue;
    }

    // ---- heading
    const heading = /^\s{0,3}(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      const level = heading[1]!.length;
      out.push(`<h${level}>${inline(heading[2]!.trim())}</h${level}>`);
      i++;
      continue;
    }

    // ---- blockquote: consecutive '>' lines become one quote
    if (/^\s{0,3}>/.test(line)) {
      const quoted: string[] = [];
      while (i < lines.length && /^\s{0,3}>/.test(lines[i]!)) {
        quoted.push(lines[i]!.replace(/^\s{0,3}>\s?/, ''));
        i++;
      }
      out.push(`<blockquote>${quoted.map((q) => inline(q)).join('<br />')}</blockquote>`);
      continue;
    }

    // ---- lists. One level only: nesting in a chat composer is rare enough
    // that guessing wrong about indentation is worse than not supporting it.
    const bullet = /^\s{0,3}[-*+]\s+(.*)$/.exec(line);
    const numbered = /^\s{0,3}(\d{1,9})[.)]\s+(.*)$/.exec(line);
    if (bullet || numbered) {
      const ordered = !bullet;
      const items: string[] = [];
      let start = numbered ? Number.parseInt(numbered[1]!, 10) : 1;
      while (i < lines.length) {
        const b = /^\s{0,3}[-*+]\s+(.*)$/.exec(lines[i]!);
        const n = /^\s{0,3}(\d{1,9})[.)]\s+(.*)$/.exec(lines[i]!);
        if (ordered && n) items.push(inline(n[2]!));
        else if (!ordered && b) items.push(inline(b[1]!));
        else break;
        i++;
      }
      const startAttr = ordered && start !== 1 && start > 0 ? ` start="${start}"` : '';
      const tag = ordered ? 'ol' : 'ul';
      out.push(`<${tag}${startAttr}>${items.map((it) => `<li>${it}</li>`).join('')}</${tag}>`);
      continue;
    }

    // ---- a run of ordinary lines becomes one paragraph with <br /> between,
    // which is how chat messages read: a newline is a newline, not a new block.
    const para: string[] = [];
    while (i < lines.length && !isBlockStart(lines[i]!)) {
      para.push(lines[i]!);
      i++;
    }
    while (para.length && para[para.length - 1]!.trim() === '') para.pop();
    while (para.length && para[0]!.trim() === '') para.shift();
    if (para.length) out.push(`<p>${para.map((p) => inline(p)).join('<br />')}</p>`);
  }

  const html = out.join('');
  return html || null;
}

/** Lines that must not be swallowed into a paragraph. */
function isBlockStart(line: string): boolean {
  return (
    /^\s{0,3}(`{3,}|~{3,})/.test(line) ||
    /^\s{0,3}#{1,6}\s/.test(line) ||
    /^\s{0,3}>/.test(line) ||
    /^\s{0,3}[-*+]\s/.test(line) ||
    /^\s{0,3}\d{1,9}[.)]\s/.test(line) ||
    /^\s{0,3}(-{3,}|\*{3,}|_{3,})\s*$/.test(line)
  );
}
