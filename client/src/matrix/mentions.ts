/**
 * @-mentions: finding the `@query` the caret is in, ranking who it could mean,
 * and turning the `@Name`s in a finished message into user ids.
 *
 * The composer is a plain textarea, so a mention cannot be a pill there — it is
 * the text `@` + the member's display name, which is also what `body` carries
 * for clients without an HTML renderer. Which user that text means is resolved
 * when the message is SENT, against the room's members, rather than remembered
 * from the moment it was picked. That is deliberate: drafts survive room
 * switches and reloads as plain text (`saveDraft`), an edit starts from the
 * plain body, and typing `@Alice` by hand means exactly what picking Alice from
 * the list means. Remembered picks would have to follow the text through all
 * three, and silently stop mentioning anyone the first time they did not.
 *
 * Pure functions only; the store feeds them members, the panel draws the list.
 */

/** Who a mention can name: the shape both the suggestion list and send-time
 *  resolution work from. */
export interface MentionCandidate {
  userId: string;
  /** The room's (disambiguated) display name for this member. */
  name: string;
  avatarMxc: string | null;
}

/** One person a message names, and the exact text that names them. */
export interface MxMention {
  userId: string;
  /** What the HTML link shows — the display name without the `@`. */
  name: string;
  /** What `body` contains: `@` + name, or the bare MXID. */
  token: string;
}

/** Longest query worth matching. A display name is capped at 256 by most
 *  servers; past this the "query" is a paragraph that happens to follow an @. */
const MAX_QUERY = 64;

/** Characters an `@` may follow and still start a mention — so an e-mail
 *  address (`bob@example.org`) never opens the list. */
const BEFORE_AT = /[\s([{"'“‘]/;

/**
 * The mention being typed at `caret`, if any: where its `@` is and what has
 * been typed after it. The query may contain spaces (display names do), but
 * not a newline, and it closes the moment it can no longer be the start of a
 * name — two spaces in a row, or longer than any sensible name.
 */
export function mentionQueryAt(text: string, caret: number): { start: number; query: string } | null {
  const head = text.slice(Math.max(0, caret - MAX_QUERY - 1), caret);
  const at = head.lastIndexOf('@');
  if (at < 0) return null;
  const start = caret - head.length + at;
  if (start > 0 && !BEFORE_AT.test(text[start - 1]!)) return null;
  const query = text.slice(start + 1, caret);
  if (/\n|\s\s|^\s/.test(query)) return null;
  return { start, query };
}

/** Lower-cased, accent-folded, for matching only. */
function fold(s: string): string {
  return s.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase();
}

/**
 * Up to `limit` candidates for `query`, best first. Ranking, in order: a match
 * at the start of the name, then at the start of any word of it or of the
 * MXID's localpart, then anywhere; within a rank, whoever spoke most recently
 * (`recent`, newest first), then alphabetically. An empty query lists the
 * recent speakers first, which is who a reply is usually addressed to.
 */
export function rankCandidates(
  members: readonly MentionCandidate[],
  query: string,
  recent: readonly string[],
  limit = 8,
): MentionCandidate[] {
  const q = fold(query.trim());
  const recency = new Map<string, number>();
  recent.forEach((id, i) => {
    if (!recency.has(id)) recency.set(id, i);
  });
  const scored: { m: MentionCandidate; rank: number; rec: number }[] = [];
  for (const m of members) {
    const name = fold(m.name);
    const local = fold(m.userId.slice(1));
    let rank: number;
    if (!q) rank = 0;
    else if (name.startsWith(q) || local.startsWith(q)) rank = 0;
    else if (name.split(/[\s._-]+/).some((w) => w.startsWith(q))) rank = 1;
    else if (name.includes(q) || local.includes(q)) rank = 2;
    else continue;
    scored.push({ m, rank, rec: recency.get(m.userId) ?? Number.MAX_SAFE_INTEGER });
  }
  scored.sort((a, b) => a.rank - b.rank || a.rec - b.rec || a.m.name.localeCompare(b.m.name));
  return scored.slice(0, limit).map((s) => s.m);
}

/** The text a pick inserts: `@Name` plus a space to keep typing after. */
export function mentionText(c: MentionCandidate): string {
  return `@${c.name} `;
}

function reEscape(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Where a mention token may end: the end of the text, whitespace, or
 *  punctuation that belongs to the sentence ("thanks @Alice!"). */
const AFTER_TOKEN = `(?=$|[\\s.,!?;:)\\]}"'”’])`;
const BEFORE_TOKEN = `(?<=^|[\\s([{"'“‘])`;

/** A regex matching any of `tokens` as a whole mention, longest first so
 *  `@Ann Lee` wins over `@Ann`. Null when there is nothing to match. */
export function mentionTokenRe(tokens: readonly string[]): RegExp | null {
  if (tokens.length === 0) return null;
  const alts = [...new Set(tokens)].sort((a, b) => b.length - a.length).map(reEscape);
  return new RegExp(`${BEFORE_TOKEN}(?:${alts.join('|')})${AFTER_TOKEN}`, 'g');
}

/** Code is quoted text, not address: a name inside a snippet mentions nobody. */
function withoutCode(body: string): string {
  const kept: string[] = [];
  let fence: string | null = null;
  for (const line of body.split('\n')) {
    const f = /^\s{0,3}(`{3,}|~{3,})/.exec(line)?.[1];
    if (fence) {
      if (f && f[0] === fence[0] && f.length >= fence.length) fence = null;
      kept.push('');
    } else if (f) {
      fence = f;
      kept.push('');
    } else {
      kept.push(line.replace(/`[^`\n]+`/g, ' '));
    }
  }
  return kept.join('\n');
}

/**
 * Everyone `body` mentions, resolved against `members`. A member is named by
 * `@` + their display name or by their full MXID. Each user appears once, with
 * every token that named them, so the HTML can link all of them.
 */
export function findMentions(body: string, members: readonly MentionCandidate[]): MxMention[] {
  if (!body.includes('@')) return [];
  const byToken = new Map<string, MentionCandidate>();
  for (const m of members) {
    if (m.name) byToken.set(`@${m.name}`, m);
    byToken.set(m.userId, m);
  }
  const re = mentionTokenRe([...byToken.keys()]);
  if (!re) return [];
  const text = withoutCode(body);
  const out: MxMention[] = [];
  const seen = new Set<string>();
  for (const match of text.matchAll(re)) {
    const token = match[0];
    const m = byToken.get(token);
    if (!m || seen.has(token)) continue;
    seen.add(token);
    out.push({ userId: m.userId, name: m.name || m.userId, token });
  }
  return out;
}

/** The permalink a mention links to, in the form every client turns into a
 *  pill (Element writes the MXID unencoded, and so do we). */
export function mentionHref(userId: string): string {
  return `https://matrix.to/#/${userId}`;
}

/** The user a matrix.to permalink names, or null when it names anything else
 *  (a room, an event) or is not one. Accepts the encoded form (`%40`) other
 *  clients write as well as our own. */
export function userIdFromPermalink(href: string): string | null {
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return null;
  }
  if (url.hostname !== 'matrix.to' || !url.hash.startsWith('#/')) return null;
  let id: string;
  try {
    id = decodeURIComponent(url.hash.slice(2).split('?')[0]!);
  } catch {
    return null;
  }
  return /^@[^:\s/]+:[^\s/]+$/.test(id) ? id : null;
}
