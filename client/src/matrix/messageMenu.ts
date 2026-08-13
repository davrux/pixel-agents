/**
 * Matrix chat panel: the per-message options menu (react / reply / edit /
 * delete).
 *
 * One small popover, opened from a row's ⋯ button and anchored to it. It owns
 * nothing but itself: what it may offer is decided by the caller (see
 * `messageActionsFor` in ./timeline.js), and every entry hands straight back
 * out through a callback — this module never touches the store, the timeline or
 * the composer.
 *
 * It is positioned inside the panel root rather than the document body, which
 * is what keeps it inside the docked window's column (and out of the Phaser
 * canvas) with no z-index games: `#pa-mx` is already `position:relative`. The
 * consequence is that it has to follow its row when the timeline scrolls under
 * it (an arriving message alone is enough to move it), and give up only once
 * that row has left the panel — hence the capturing scroll listener below,
 * which re-places rather than closes.
 */

/** The quick reactions offered at the top of the menu — GitHub's set, which is
 *  as close to a lingua franca as emoji reactions have. Anything else goes
 *  through the ＋ entry, which asks for one. */
const QUICK_REACTIONS: readonly string[] = ['👍', '👎', '😄', '🎉', '😕', '❤️', '🚀', '👀'];

export interface MessageMenuSpec {
  /** The ⋯ button the menu belongs to. */
  anchor: HTMLElement;
  /** The panel root (`#pa-mx`) — positioned, and the bounds to stay inside. */
  container: HTMLElement;
  /** Which entries to draw. An all-false spec would draw an empty menu, so
   *  callers must not open one (the ⋯ button is hidden in that case). */
  can: { react: boolean; reply: boolean; edit: boolean; remove: boolean };
  /** A quick reaction was picked. */
  onReact(key: string): void;
  /** "Any emoji…" was picked — the caller asks for one and reacts with it. */
  onReactOther(): void;
  onReply(): void;
  onEdit(): void;
  onDelete(): void;
  /** The menu closed. Always called exactly once, whether it was dismissed or
   *  an entry was chosen. */
  onClose(): void;
}

export interface MessageMenuHandle {
  close(): void;
}

/** Gap between the ⋯ button and the menu, and the margin kept to the panel's
 *  edges — in px, because this is arithmetic on `getBoundingClientRect`. */
const GAP = 4;
const EDGE = 6;

export function openMessageMenu(spec: MessageMenuSpec): MessageMenuHandle {
  const menu = document.createElement('div');
  menu.className = 'mx-menu';
  menu.setAttribute('role', 'menu');
  menu.setAttribute('aria-label', 'Message actions');

  let closed = false;
  /** Set by an entry so `close()` leaves focus wherever that entry's handler
   *  put it (the composer, a dialog) instead of pulling it back to the row. */
  let chosen = false;

  const close = (): void => {
    if (closed) return;
    closed = true;
    document.removeEventListener('pointerdown', onOutside, true);
    document.removeEventListener('keydown', onKey, true);
    spec.container.removeEventListener('scroll', onMoved, true);
    window.removeEventListener('resize', onMoved);
    menu.remove();
    // Focus must not be left on a removed element — that drops it to <body>,
    // which makes the panel's ownsFocus() false and lets the next keystroke
    // walk the player's avatar (see MatrixUI.openRoomView).
    if (!chosen && spec.anchor.isConnected) spec.anchor.focus();
    spec.onClose();
  };

  const pick = (run: () => void): void => {
    chosen = true;
    close();
    run();
  };

  const items: HTMLElement[] = [];

  if (spec.can.react) {
    const row = document.createElement('div');
    row.className = 'mx-menu-emoji';
    for (const key of QUICK_REACTIONS) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'mx-menu-e';
      btn.textContent = key;
      btn.title = `React ${key}`;
      btn.setAttribute('aria-label', `React ${key}`);
      btn.setAttribute('role', 'menuitem');
      btn.addEventListener('click', () => pick(() => spec.onReact(key)));
      row.appendChild(btn);
      items.push(btn);
    }
    const other = document.createElement('button');
    other.type = 'button';
    other.className = 'mx-menu-e other';
    other.textContent = '＋';
    other.title = 'React with any emoji';
    other.setAttribute('aria-label', 'React with any emoji');
    other.setAttribute('role', 'menuitem');
    other.addEventListener('click', () => pick(() => spec.onReactOther()));
    row.appendChild(other);
    items.push(other);
    menu.appendChild(row);
  }

  const addRow = (icon: string, label: string, run: () => void, danger = false): void => {
    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'mx-menu-row' + (danger ? ' danger' : '');
    row.setAttribute('role', 'menuitem');
    row.append(`${icon} ${label}`);
    row.addEventListener('click', () => pick(run));
    menu.appendChild(row);
    items.push(row);
  };

  if (spec.can.reply) addRow('↩', 'Reply', () => spec.onReply());
  if (spec.can.edit) addRow('✎', 'Edit', () => spec.onEdit());
  if (spec.can.remove) addRow('🗑', 'Delete', () => spec.onDelete(), true);

  const onOutside = (e: Event): void => {
    const t = e.target as Node | null;
    if (t && (menu.contains(t) || spec.anchor.contains(t))) return;
    close();
  };

  const onKey = (e: KeyboardEvent): void => {
    if (e.key === 'Escape') {
      // Stopped here so the panel's own Escape handler doesn't also fire and
      // navigate back out of the room.
      e.preventDefault();
      e.stopPropagation();
      close();
      return;
    }
    if (e.key === 'Tab') {
      close();
      return;
    }
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp' && e.key !== 'Home' && e.key !== 'End') return;
    const at = items.indexOf(document.activeElement as HTMLElement);
    e.preventDefault();
    const next =
      e.key === 'Home'
        ? 0
        : e.key === 'End'
          ? items.length - 1
          : at < 0
            ? 0
            : (at + (e.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length;
    items[next]?.focus();
  };

  spec.container.appendChild(menu);

  /**
   * Put the menu next to its button, measuring both. Below it by default,
   * flipped above when there is no room — a message near the bottom of the
   * timeline is the common case, not the exception.
   *
   * Returns false once the row has scrolled out of the panel, which is the one
   * situation where following it stops making sense.
   */
  const place = (): boolean => {
    const anchorBox = spec.anchor.getBoundingClientRect();
    const box = spec.container.getBoundingClientRect();
    if (anchorBox.bottom < box.top || anchorBox.top > box.bottom) return false;
    const w = menu.offsetWidth;
    const h = menu.offsetHeight;
    const below = anchorBox.bottom - box.top + GAP;
    const above = anchorBox.top - box.top - h - GAP;
    const top = below + h + EDGE <= box.height || above < EDGE ? below : above;
    // Right-aligned to the button, then clamped so a wide menu in a narrow panel
    // slides left instead of overflowing.
    const right = anchorBox.right - box.left;
    menu.style.top = `${Math.max(EDGE, Math.min(top, box.height - h - EDGE))}px`;
    menu.style.left = `${Math.min(Math.max(EDGE, right - w), Math.max(EDGE, box.width - w - EDGE))}px`;
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

  items[0]?.focus();

  return { close };
}
