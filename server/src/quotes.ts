/**
 * The quotes talking objects say — stored in the database, edited in the admin
 * panel (Quotes tab, `GET`/`PUT /admin/talking-quotes`), validated, cached.
 *
 * The pool used to be `assets/quotes/talking-objects.txt`, committed to git and
 * read once at startup: changing a line took a commit, a deploy and a restart,
 * and the lines — which are about the people in this world — sat in a repository
 * whose desktop build is published. It is one `settings` row now, holding the
 * TEXT an admin typed rather than the parsed list, because the format is the one
 * the file had and its comments and blank lines are what let an author group the
 * lines and leave a note for the next one:
 *
 *   - one quote per line; blank lines are ignored;
 *   - a line whose first non-blank character is `#` is a comment;
 *   - leading and trailing spaces are trimmed;
 *   - a quote is at most {@link MAX_QUOTE_LEN} characters.
 *
 * Why the SERVER parses it: the engine that speaks (shared/office/engine/
 * talkingObjects.ts) is headless and has no storage in it, so the pool is handed
 * in — `OfficeState.setQuotes`, the same shape as `setPetDecider`. A save reaches
 * the running rooms through the control bus (`QUOTES_CHANGED_EVENT`), so an edit
 * takes effect without a restart.
 *
 * The text comes from an admin, i.e. from a client: § Security applies even
 * though the caller is trusted with the whole world, because what is validated
 * here ends up in a speech bubble and a chat line for every viewer. So a save is
 * refused WHOLE if any line is — never partly stored — and a stored row is
 * parsed with the same rules again on read, since a restore or a hand-edit can
 * reach it.
 */
import { appStore } from './appStore.js';

/** The `settings` key. The value is the raw text (a JSON string). */
export const QUOTES_SETTING = 'talkingQuotes';

/**
 * The longest quote that is shown in full.
 *
 * The number is not free: it is where the speech bubble truncates with an
 * ellipsis (`showBubble` in client/src/scenes/OfficeScene.ts). A longer line is
 * therefore REFUSED here rather than trimmed — a quote is a sentence, and half a
 * sentence with a `…` is not a shorter quote, it is a broken one. The author is
 * told which line instead of getting a bubble that stops mid-word.
 */
export const MAX_QUOTE_LEN = 120;

/** The whole text, comments included. About five hundred full-length quotes —
 *  far more than a pool that is drawn from twice an hour needs, and small enough
 *  that parsing it is nothing. Checked before parsing, so the parse is bounded. */
export const MAX_QUOTES_TEXT = 64 * 1024;

/** A line the text offered and this parser would not take, so the caller can
 *  say WHICH line rather than "some quotes were dropped". */
export interface RejectedQuote {
  line: number;
  text: string;
  why: string;
}

// C0 and C1 controls (a tab included — trimming removes the ones at the ends,
// and one in the middle of a bubble is a rendering accident, not content).
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;

/** One stored form: no BOM, `\n` line ends. The BOM is stripped rather than
 *  trimmed away with the rest, because it would otherwise sit in front of the
 *  first `#` and turn a comment into a quote. */
export function normalizeQuotesText(text: string): string {
  return text.replace(/^﻿/, '').replace(/\r\n?/g, '\n');
}

/**
 * Parse the pool. Pure, so the rules are testable without a database.
 *
 * Blank lines and `#` comments are structure, not content. Trimming is
 * unconditional — a trailing space is invisible in an editor and would
 * otherwise be inside the quote. The same line twice is refused, because it is
 * an editing accident and would make the deck deal it twice per pass.
 */
export function parseQuotes(text: string): { quotes: string[]; rejected: RejectedQuote[] } {
  const quotes: string[] = [];
  const rejected: RejectedQuote[] = [];
  const firstLine = new Map<string, number>();
  normalizeQuotesText(text)
    .split('\n')
    .forEach((raw, i) => {
      const line = raw.trim();
      if (!line || line.startsWith('#')) return;
      const n = i + 1;
      if (line.length > MAX_QUOTE_LEN) {
        rejected.push({ line: n, text: line, why: `${line.length} characters, the bubble shows ${MAX_QUOTE_LEN}` });
        return;
      }
      if (CONTROL.test(line)) {
        rejected.push({ line: n, text: line, why: 'contains a control character' });
        return;
      }
      const dup = firstLine.get(line);
      if (dup !== undefined) {
        rejected.push({ line: n, text: line, why: `the same quote as line ${dup}` });
        return;
      }
      firstLine.set(line, n);
      quotes.push(line);
    });
  return { quotes, rejected };
}

/** The stored text, exactly as it was saved; empty when no admin ever saved
 *  one. Anything but a string in the row (a hand-edit) reads as empty. */
export function getQuotesText(): string {
  const v = appStore.getSetting<unknown>(QUOTES_SETTING, '');
  return typeof v === 'string' ? v : '';
}

/** Parsed once per saved text and kept: replaced wholesale by the next save,
 *  so it neither grows nor goes stale within a run. */
let cached: readonly string[] | null = null;

/**
 * The world's quotes. No row, or nothing usable in it, is no quotes — which is
 * a perfectly good world: the talking objects still tell the time.
 *
 * A stored line the rules refuse is skipped with a warning rather than taking
 * the whole pool with it: `setQuotesText` never stores such a line, so one here
 * came from a restore or a hand-edit, and the other lines are still good.
 */
export function loadQuotes(): readonly string[] {
  if (cached) return cached;
  const text = getQuotesText();
  if (text.length > MAX_QUOTES_TEXT) {
    console.warn(`[quotes] stored quote text is ${text.length} characters (cap ${MAX_QUOTES_TEXT}) — ignored`);
    cached = [];
    return cached;
  }
  const { quotes, rejected } = parseQuotes(text);
  for (const r of rejected) console.warn(`[quotes] stored line ${r.line} skipped — ${r.why}`);
  cached = quotes;
  return cached;
}

export type SetQuotesResult =
  | { ok: true; text: string; quotes: readonly string[] }
  | { ok: false; error: string; rejected: RejectedQuote[] };

/**
 * Validate and store a new pool. Refused whole on any bad line: a save that
 * quietly dropped one would tell the admin "saved" about a quote nobody will
 * ever hear. The caller announces the change (`QUOTES_CHANGED_EVENT`).
 */
export function setQuotesText(raw: unknown): SetQuotesResult {
  if (typeof raw !== 'string') return { ok: false, error: 'text must be a string', rejected: [] };
  const text = normalizeQuotesText(raw);
  if (text.length > MAX_QUOTES_TEXT) {
    return { ok: false, error: `the text is ${text.length} characters, at most ${MAX_QUOTES_TEXT} are kept`, rejected: [] };
  }
  const { quotes, rejected } = parseQuotes(text);
  if (rejected.length) {
    const n = rejected.length;
    return { ok: false, error: `${n} line${n === 1 ? '' : 's'} refused — nothing was saved`, rejected };
  }
  appStore.setSetting(QUOTES_SETTING, text);
  cached = quotes;
  return { ok: true, text, quotes };
}
