/**
 * The quotes talking objects say — read from the repo, validated, cached.
 *
 * The pool lives in `assets/quotes/talking-objects.txt` as one quote per line
 * (see that file's own header for the format). Why a text file and not JSON: a
 * quote is prose, and prose in JSON means escaping every `"` that belongs to the
 * text, a diff that touches the neighbouring line's comma, and nowhere to write
 * a comment. One line per quote costs none of that, and the format has exactly
 * as much structure as the content has.
 *
 * Why the SERVER reads it: the engine that speaks (shared/office/engine/
 * talkingObjects.ts) is headless and has no file paths in it, so the pool is
 * handed in — `OfficeState.setQuotes`, the same shape as `setNpcDecider`. The
 * lines never come from a client, so this is not an untrusted path; it is still
 * bounded, because the failure mode of an unbounded one is a 4 KB speech bubble
 * that nobody can dismiss.
 */
import * as fs from 'node:fs';
import { join } from 'node:path';

import { ASSETS_ROOT } from './assets.js';

export const QUOTES_REL = join('assets', 'quotes', 'talking-objects.txt');

/**
 * The longest quote that is shown in full.
 *
 * The number is not free: it is where the speech bubble truncates with an
 * ellipsis (`showBubble` in client/src/scenes/OfficeScene.ts). A longer line is
 * therefore REFUSED here rather than trimmed — a quote is a sentence, and half a
 * sentence with a `…` is not a shorter quote, it is a broken one. The author sees
 * a warning naming the line instead of a bubble that stops mid-word.
 */
export const MAX_QUOTE_LEN = 120;

/** A line the file offered and this parser would not take, so the caller can
 *  say WHICH line rather than "some quotes were dropped". */
export interface RejectedQuote {
  line: number;
  text: string;
  why: string;
}

/**
 * Parse the pool. Pure, so the rules are testable without a file on disk.
 *
 * Blank lines and `#` comments are structure, not content: they are what lets an
 * author group the lines and explain them in place. Trimming is unconditional —
 * a trailing space is invisible in an editor and would otherwise be inside the
 * quote.
 */
export function parseQuotes(text: string): { quotes: string[]; rejected: RejectedQuote[] } {
  const quotes: string[] = [];
  const rejected: RejectedQuote[] = [];
  // The BOM is stripped rather than trimmed away with the rest, because it would
  // otherwise sit in front of the first `#` and turn a comment into a quote.
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/);
  lines.forEach((raw, i) => {
    const line = raw.trim();
    if (!line || line.startsWith('#')) return;
    if (line.length > MAX_QUOTE_LEN) {
      rejected.push({ line: i + 1, text: line, why: `${line.length} characters, the bubble shows ${MAX_QUOTE_LEN}` });
      return;
    }
    quotes.push(line);
  });
  return { quotes, rejected };
}

/** Read once and kept: one text file's worth of strings, replaced wholesale by
 *  the next read, so it neither grows nor goes stale within a run. */
let cached: readonly string[] | null = null;

/**
 * The world's quotes. Missing or unreadable file = no quotes, which is a
 * perfectly good world: the talking objects still tell the time. That is
 * deliberate — a boot must not fail over decoration (see AGENTS.md on
 * housekeeping never keeping the server from starting).
 */
export function loadQuotes(): readonly string[] {
  if (cached) return cached;
  const file = join(ASSETS_ROOT, QUOTES_REL);
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf-8');
  } catch (err) {
    console.warn(`[quotes] no quote pool at ${file} — talking objects will only say the hour (${(err as Error)?.message})`);
    cached = [];
    return cached;
  }
  const { quotes, rejected } = parseQuotes(text);
  for (const r of rejected) console.warn(`[quotes] ${QUOTES_REL}:${r.line} skipped — ${r.why}`);
  console.log(`[quotes] ${quotes.length} quote${quotes.length === 1 ? '' : 's'} loaded from ${QUOTES_REL}`);
  cached = quotes;
  return cached;
}
