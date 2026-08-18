/**
 * Matrix chat panel: the emoji picker popover.
 *
 * One popover for both of its callers — the composer's 😊 button (insert into
 * the message being written) and the message menu's ＋ reaction entry (react
 * with any emoji). Like `messageMenu.ts`, whose positioning and dismissal
 * behaviour this mirrors, it owns nothing but itself: the picked emoji goes
 * straight back out through `onPick` and the caller decides what it means.
 *
 * The set it offers is the curated list in ./emojiData.js plus a "Recent" row
 * (localStorage, shared across rooms). Anything outside the set is still
 * reachable: the search field accepts a pasted emoji verbatim — Enter with no
 * match picks the query itself when it doesn't look like an unfinished word —
 * so the OS emoji keyboard and plain pasting keep working as the escape hatch.
 */
import { EMOJI_CATEGORIES } from './emojiData.js';

export interface EmojiPickerSpec {
  /** The button the picker belongs to (the 😊 button, a row's ⋯ button). */
  anchor: HTMLElement;
  /** The panel root (`#pa-mx`) — positioned, and the bounds to stay inside. */
  container: HTMLElement;
  /** An emoji was picked. The picker has already closed itself. */
  onPick(emoji: string): void;
  /** The picker closed. Always called exactly once. */
  onClose(): void;
}

export interface EmojiPickerHandle {
  close(): void;
}

/** Same geometry constants as messageMenu.ts — the two popovers should sit
 *  against their buttons identically. */
const GAP = 4;
const EDGE = 6;

const RECENT_KEY = 'pa-mx-emoji-recent';
const RECENT_MAX = 16;

function readRecents(): string[] {
  try {
    const raw = localStorage.getItem(RECENT_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    // Own storage, but still bounded and typed — a corrupted value must not
    // become a row of garbage buttons.
    return parsed.filter((e): e is string => typeof e === 'string' && e.length > 0 && e.length <= 16).slice(0, RECENT_MAX);
  } catch {
    return [];
  }
}

function saveRecent(emoji: string): void {
  try {
    const next = [emoji, ...readRecents().filter((e) => e !== emoji)].slice(0, RECENT_MAX);
    localStorage.setItem(RECENT_KEY, JSON.stringify(next));
  } catch {
    /* private mode / quota — recents are a convenience, not state */
  }
}

/** Column count of the grid. Mirrored in `.mx-emoji-grid`'s CSS; the keyboard
 *  handler needs the number to make ↑/↓ move by visual row. */
const COLS = 8;

/** Does this query look like a pasted emoji rather than an unfinished search
 *  word? Anything short with no ASCII letters or digits qualifies. */
function looksLikeEmoji(q: string): boolean {
  return q.length > 0 && Array.from(q).length <= 8 && !/[a-z0-9]/i.test(q);
}

export function openEmojiPicker(spec: EmojiPickerSpec): EmojiPickerHandle {
  const pop = document.createElement('div');
  pop.className = 'mx-emoji';
  pop.setAttribute('role', 'dialog');
  pop.setAttribute('aria-label', 'Emoji picker');

  const search = document.createElement('input');
  search.type = 'text';
  search.className = 'pa-input mx-emoji-q';
  search.placeholder = 'Search — or paste any emoji';
  search.maxLength = 64;
  search.setAttribute('aria-label', 'Search emoji');

  const body = document.createElement('div');
  body.className = 'mx-emoji-body';

  pop.append(search, body);

  let closed = false;
  let chosen = false;

  const close = (): void => {
    if (closed) return;
    closed = true;
    document.removeEventListener('pointerdown', onOutside, true);
    document.removeEventListener('keydown', onKey, true);
    spec.container.removeEventListener('scroll', onMoved, true);
    window.removeEventListener('resize', onMoved);
    pop.remove();
    // Same rule as messageMenu.close(): focus must not fall to <body>, or the
    // panel stops owning the keyboard and WASD walks the avatar.
    if (!chosen && spec.anchor.isConnected) spec.anchor.focus();
    spec.onClose();
  };

  const pick = (emoji: string): void => {
    chosen = true;
    saveRecent(emoji);
    close();
    spec.onPick(emoji);
  };

  /** The visible emoji buttons in render order — the arrow-key grid walk. */
  let cells: HTMLButtonElement[] = [];

  const addCell = (grid: HTMLElement, emoji: string, name: string): void => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'mx-emoji-b';
    btn.textContent = emoji;
    btn.title = name;
    btn.setAttribute('aria-label', name || emoji);
    btn.addEventListener('click', () => pick(emoji));
    grid.appendChild(btn);
    cells.push(btn);
  };

  const addSection = (label: string, entries: readonly (readonly [string, string])[]): void => {
    if (entries.length === 0) return;
    const head = document.createElement('div');
    head.className = 'mx-emoji-h';
    head.textContent = label;
    const grid = document.createElement('div');
    grid.className = 'mx-emoji-grid';
    for (const [emoji, name] of entries) addCell(grid, emoji, name);
    body.append(head, grid);
  };

  const renderList = (): void => {
    const q = search.value.trim().toLowerCase();
    cells = [];
    body.replaceChildren();
    if (q === '') {
      const recents = readRecents();
      if (recents.length) addSection('Recent', recents.map((e) => [e, ''] as const));
      for (const cat of EMOJI_CATEGORIES) addSection(cat.label, cat.entries);
    } else {
      const hits = EMOJI_CATEGORIES.flatMap((cat) =>
        cat.entries.filter(([emoji, name]) => name.includes(q) || emoji === search.value.trim()),
      );
      if (hits.length) {
        addSection('Results', hits);
      } else {
        const none = document.createElement('div');
        none.className = 'mx-emoji-none';
        none.textContent = looksLikeEmoji(search.value.trim())
          ? `Press Enter to use “${search.value.trim()}”`
          : 'No matches — paste any emoji instead';
        body.appendChild(none);
      }
    }
    body.scrollTop = 0;
  };

  search.addEventListener('input', renderList);
  search.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      e.stopPropagation();
      const first = cells[0];
      if (first) {
        // With a query, Enter takes the top hit; without one there is no
        // "first" that means anything, so it does nothing.
        if (search.value.trim() !== '') first.click();
        return;
      }
      const raw = search.value.trim();
      if (looksLikeEmoji(raw)) pick(raw);
      return;
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      cells[0]?.focus();
    }
  });

  const onOutside = (e: Event): void => {
    const t = e.target as Node | null;
    if (t && (pop.contains(t) || spec.anchor.contains(t))) return;
    close();
  };

  const onKey = (e: KeyboardEvent): void => {
    if (e.key === 'Escape') {
      // Stopped so the panel's own Escape handler doesn't also navigate.
      e.preventDefault();
      e.stopPropagation();
      close();
      return;
    }
    const at = cells.indexOf(document.activeElement as HTMLButtonElement);
    if (at < 0) return;
    // Grid walk among the emoji cells: ←/→ one cell, ↑/↓ one visual row. ↑ off
    // the top hands focus back to the search field. Section breaks make the
    // row math approximate near headings, which is fine — it stays monotonic.
    let next = -1;
    if (e.key === 'ArrowRight') next = at + 1;
    else if (e.key === 'ArrowLeft') next = at - 1;
    else if (e.key === 'ArrowDown') next = Math.min(at + COLS, cells.length - 1);
    else if (e.key === 'ArrowUp') next = at - COLS;
    else return;
    e.preventDefault();
    if (next < 0) search.focus();
    else cells[Math.min(next, cells.length - 1)]?.focus();
  };

  spec.container.appendChild(pop);
  renderList();

  /** Same follow-the-anchor placement as messageMenu.ts, with the same "give
   *  up once the anchor scrolled out of the panel" rule. */
  const place = (): boolean => {
    const anchorBox = spec.anchor.getBoundingClientRect();
    const box = spec.container.getBoundingClientRect();
    if (anchorBox.bottom < box.top || anchorBox.top > box.bottom) return false;
    const w = pop.offsetWidth;
    const h = pop.offsetHeight;
    const below = anchorBox.bottom - box.top + GAP;
    const above = anchorBox.top - box.top - h - GAP;
    // Prefer above: both anchors (composer, a row's ⋯) live in the lower half
    // of the panel most of the time. Fall through to below when there's no room.
    const top = above >= EDGE || below + h + EDGE > box.height ? above : below;
    const right = anchorBox.right - box.left;
    pop.style.top = `${Math.max(EDGE, Math.min(top, box.height - h - EDGE))}px`;
    pop.style.left = `${Math.min(Math.max(EDGE, right - w), Math.max(EDGE, box.width - w - EDGE))}px`;
    return true;
  };

  const onMoved = (): void => {
    if (!place()) close();
  };

  place();

  document.addEventListener('pointerdown', onOutside, true);
  document.addEventListener('keydown', onKey, true);
  spec.container.addEventListener('scroll', onMoved, true);
  window.addEventListener('resize', onMoved);

  search.focus();

  return { close };
}
