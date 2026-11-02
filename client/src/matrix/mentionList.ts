/**
 * The @-mention suggestion list that floats above the composer.
 *
 * Only the drawing and the selection cursor live here; what to list and when
 * is MatrixUI's (`refreshMentions`), which re-asks on every keystroke, caret
 * move and member/timeline update, so the list is never older than the last
 * thing that could have changed it. Rows are rebuilt from scratch with
 * `textContent`, like every other list in this panel — the names are remote
 * text.
 *
 * Focus never leaves the textarea: rows take the pick on `mousedown` with the
 * default prevented, so clicking one does not blur the composer (which would
 * close the list before the click landed).
 */
import type { MentionCandidate } from './mentions.js';

export class MentionList {
  readonly el: HTMLDivElement;
  private items: MentionCandidate[] = [];
  private active = 0;

  constructor(
    private readonly avatar: (c: MentionCandidate) => HTMLElement,
    private readonly onPick: (c: MentionCandidate) => void,
  ) {
    this.el = document.createElement('div');
    this.el.className = 'mx-mentions';
    this.el.setAttribute('role', 'listbox');
    this.el.setAttribute('aria-label', 'People to mention');
    this.el.hidden = true;
  }

  get open(): boolean {
    return !this.el.hidden;
  }

  /** Show `items`, keeping the highlighted person highlighted if they are
   *  still in the list — a list that refreshes under the cursor must not jump. */
  show(items: MentionCandidate[]): void {
    const keep = this.items[this.active]?.userId;
    const same =
      !this.el.hidden && items.length === this.items.length && items.every((c, i) => c.userId === this.items[i]!.userId && c.name === this.items[i]!.name);
    this.items = items;
    // A refresh that changed nothing (most keystrokes past the first few)
    // keeps the rows, and with them the avatars already painted.
    if (same) return;
    const idx = keep ? items.findIndex((c) => c.userId === keep) : -1;
    this.active = idx >= 0 ? idx : 0;
    this.paint();
    this.el.hidden = false;
  }

  hide(): void {
    if (this.el.hidden) return;
    this.el.hidden = true;
    this.items = [];
    this.el.replaceChildren();
  }

  move(delta: number): void {
    if (this.items.length === 0) return;
    this.select((this.active + delta + this.items.length) % this.items.length);
  }

  /** Pick the highlighted person. False when there was nobody to pick. */
  pickActive(): boolean {
    const c = this.items[this.active];
    if (!c) return false;
    this.onPick(c);
    return true;
  }

  private paint(): void {
    const rows = this.items.map((c, i) => {
      const row = document.createElement('div');
      row.className = 'mx-mention-row';
      row.setAttribute('role', 'option');
      row.appendChild(this.avatar(c));
      const nm = document.createElement('span');
      nm.className = 'nm';
      nm.textContent = c.name;
      const id = document.createElement('small');
      id.textContent = c.userId;
      row.append(nm, id);
      row.addEventListener('mousedown', (ev) => {
        ev.preventDefault();
        this.onPick(c);
      });
      row.addEventListener('mousemove', () => {
        if (this.active !== i) this.select(i);
      });
      return row;
    });
    this.el.replaceChildren(...rows);
    this.select(this.active);
  }

  private select(i: number): void {
    this.active = i;
    const rows = this.el.children;
    for (let r = 0; r < rows.length; r++) rows[r]!.setAttribute('aria-selected', String(r === i));
    rows[i]?.scrollIntoView({ block: 'nearest' });
  }
}
