/**
 * Mumble panel: the small anchored popover a channel row opens — its ⋯, or a
 * right-click on it — offering to join the channel or place an ear in it.
 *
 * Deliberately the same shape as the chat panel's message menu
 * (matrix/messageMenu.ts), down to the placement arithmetic: two floating menus
 * in the same window that behaved differently would be the odd thing.
 *
 * It owns nothing but itself: the caller decides what may be offered (see
 * `canListen` in ./MumbleVoice.js, and `channelMenuItems` in ./MumbleUI.js,
 * which is also what decides whether the ⋯ exists at all) and every entry hands
 * straight back out through its own callback. Nothing here is ever drawn
 * disabled — an entry that cannot be picked is simply not on the list.
 *
 * It is positioned inside `#pa-mb` rather than the document body, which keeps it
 * inside the docked column and out of the Phaser canvas with no z-index games,
 * and means it has to follow its row when the tree scrolls under it — hence the
 * capturing scroll listener below, which re-places rather than closes.
 */

export interface PanelMenuItem {
  label: string;
  title?: string;
  onPick(): void;
}

export interface PanelMenuSpec {
  /** The button the menu belongs to, and the box it is placed against. */
  anchor: HTMLElement;
  /** The panel root (`#pa-mb`) — positioned, and the bounds to stay inside. */
  container: HTMLElement;
  /** Heading above the list: what this menu is about. */
  head: string;
  /** Accessible name for the popover itself. */
  label: string;
  items: PanelMenuItem[];
  /** Always called exactly once, whether dismissed or chosen. */
  onClose(): void;
}

export interface PanelMenuHandle {
  close(): void;
}

/** Gap between the button and the menu, and the margin kept to the panel's
 *  edges — in px, because this is arithmetic on `getBoundingClientRect`. */
const GAP = 4;
const EDGE = 6;

export function openPanelMenu(spec: PanelMenuSpec): PanelMenuHandle {
  const menu = document.createElement('div');
  menu.className = 'mb-menu';
  menu.setAttribute('role', 'menu');
  menu.setAttribute('aria-label', spec.label);

  let closed = false;
  /** Set by a pick so `close()` leaves focus where that handler put it. */
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
    // and the office reads that as nobody owning the keyboard, which sends the
    // next keystroke to the player's avatar.
    if (!chosen && spec.anchor.isConnected) spec.anchor.focus();
    spec.onClose();
  };

  const head = document.createElement('div');
  head.className = 'hd';
  head.textContent = spec.head;
  head.title = spec.head;
  menu.appendChild(head);

  const list = document.createElement('div');
  list.className = 'ls';
  menu.appendChild(list);

  const pickable: HTMLElement[] = [];
  for (const item of spec.items) {
    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'mb-menu-row';
    row.setAttribute('role', 'menuitem');
    row.textContent = item.label;
    if (item.title) row.title = item.title;
    const run = item.onPick;
    row.addEventListener('click', () => {
      chosen = true;
      close();
      run();
    });
    pickable.push(row);
    list.appendChild(row);
  }

  const onOutside = (e: Event): void => {
    const t = e.target as Node | null;
    if (t && (menu.contains(t) || spec.anchor.contains(t))) return;
    close();
  };

  const onKey = (e: KeyboardEvent): void => {
    if (e.key === 'Escape') {
      // Stopped here so the panel's own Escape handler doesn't also fire.
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
    if (pickable.length === 0) return;
    const at = pickable.indexOf(document.activeElement as HTMLElement);
    e.preventDefault();
    const next =
      e.key === 'Home'
        ? 0
        : e.key === 'End'
          ? pickable.length - 1
          : at < 0
            ? 0
            : (at + (e.key === 'ArrowDown' ? 1 : pickable.length - 1)) % pickable.length;
    pickable[next]?.focus();
  };

  spec.container.appendChild(menu);

  /**
   * Put the menu next to its button, measuring both. Below it by default,
   * flipped above when there is no room.
   *
   * Returns false once the row has left the panel — either scrolled out of the
   * tree, or removed outright because that channel is gone — which is the one
   * situation where following it stops making sense.
   */
  const place = (): boolean => {
    if (!spec.anchor.isConnected) return false;
    const anchorBox = spec.anchor.getBoundingClientRect();
    const box = spec.container.getBoundingClientRect();
    if (anchorBox.bottom < box.top || anchorBox.top > box.bottom) return false;
    const w = menu.offsetWidth;
    const h = menu.offsetHeight;
    const below = anchorBox.bottom - box.top + GAP;
    const above = anchorBox.top - box.top - h - GAP;
    const top = below + h + EDGE <= box.height || above < EDGE ? below : above;
    // Right-aligned to the button, then clamped so a wide menu in a narrow
    // panel slides left instead of overflowing.
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

  pickable[0]?.focus();

  return { close };
}
