/**
 * Docked application windows — the full-height columns the office runs *beside*
 * the game rather than floating on top of it: Matrix chat on the left, Mumble
 * on the right, the pixel world in the middle.
 *
 * The whole layout hangs off two custom properties on <html>:
 * `--pa-dock-l` / `--pa-dock-r`, each holding the width of the open window on
 * that side (unset when it is closed). `#game` (index.html) is inset by both,
 * so Phaser's Scale.RESIZE mode picks the change up through its ResizeObserver
 * and resizes the canvas + camera on its own — no manual game.scale call. Every
 * other viewport-anchored piece of HUD reads the same two variables (the
 * menubar and its popovers in paSkin.ts, the chat box, the meeting-area widget)
 * so nothing ever slides underneath a window.
 *
 * A window is a `.pa-panel` built by OfficeScene's mkPanel — same head/body
 * chrome as the popovers — plus this class, which turns it into a column, adds
 * the drag-to-resize grip on its inner edge, and remembers both its width and
 * whether it was left open across reloads.
 */
export type DockSide = 'left' | 'right';

/**
 * Declarations that make a fixed element span exactly the game column — the same
 * three variables `#game` (index.html) is inset by, so a curtain lines up with
 * the canvas whatever is docked beside it. Ends in a semicolon, so it
 * concatenates into a `cssText` or drops into a rule body.
 *
 * For anything that covers the WORLD rather than the screen. Neither application
 * window depends on this server: Matrix and Mumble each talk to their own, so
 * they are neither down while the world reconnects, nor gone when an admin kicks
 * you out of it, nor unusable while the world's art is still arriving. A curtain
 * drawn across them says something untrue about a chat you can still read and a
 * call you are still in.
 */
export const GAME_COLUMN_CSS =
  'position:fixed;top:0;bottom:0;left:var(--pa-dock-l, 0px);' +
  'right:calc(var(--pa-dock-r, 0px) + var(--pa-side-panel-w, 0px));';

/** The `transition` VALUE that matches `#game`'s own slide — a curtain without it
 *  jumps to its new column while the canvas underneath glides to it. Kept apart
 *  from the geometry because a user of both may be transitioning something else
 *  as well, and a second `transition` declaration would silently drop this one. */
export const GAME_COLUMN_SLIDE = 'left 0.18s ease, right 0.18s ease';

export interface DockWindowOptions {
  side: DockSide;
  /** localStorage prefix: `${key}-w` (dragged width), `${key}-open`. */
  key: string;
  /** Width the window opens at before the user has ever dragged it. */
  defaultRem: number;
  /** Narrowest the grip may drag it — below this the content stops working. */
  minRem?: number;
  /**
   * Below this width the window gets `.pa-compact`, and its panel is expected to
   * lay itself out for a narrow column. What compact means is entirely CSS: the
   * shared chrome loses padding here, and each panel's own stylesheet drops its
   * secondary rows (matrixSkin.ts, MumbleUI.injectStyles).
   *
   * It never changes a font-size or an icon box. Text that resizes as you drag a
   * window is the thing this replaced — see index.html's fixed --pa-ui-px — so a
   * compact column shows *less*, at the same size, rather than the same content
   * shrunk to fit.
   */
  compactBelowRem?: number;
  /**
   * Opt out of the body being the scroller, for a panel that manages its own
   * scrolling regions: the body becomes a non-scrolling flex column and the
   * panel's own content decides what moves. Both application windows want this
   * (Matrix pins a status strip and a composer around its timeline; Mumble pins
   * its settings above the channel tree) — a whole-body scroller would take
   * those fixed parts with it.
   */
  fill?: boolean;
}

const WIDTH_VAR: Record<DockSide, string> = { left: '--pa-dock-l', right: '--pa-dock-r' };

/** Widest a single window may get. Two maxed-out windows still leave the game
 *  the middle third of the screen, which is the whole point of the layout. */
const MAX_VIEWPORT_FRACTION = 0.34;

function rootFontPx(): number {
  return parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
}

function readStored(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null; // private mode
  }
}

function writeStored(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* private mode — the window still works, it just won't be remembered */
  }
}

function injectDockStyles(): void {
  if (document.getElementById('pa-dock-style')) return;
  const style = document.createElement('style');
  style.id = 'pa-dock-style';
  style.textContent = `
    /* A window is a .pa-panel that stopped being a popover: full height, no
       rounded corners, flush against its edge of the screen.

       z-index 56 is load-bearing, not decoration. A window inherits .pa-panel's
       z-index:60 otherwise — the same layer as the ☰ menubar's popovers — so
       which one covered which came down to construction order in
       OfficeScene.buildPanels, where Audio happens to be created before both
       windows and every other menu after them. That made Audio the one menu
       that opened *underneath* a window while the rest opened on top of one.
       56 puts both windows in their own layer: above the game and the chat box
       (55), below the popover layer (60) and the editors' panels (61), leaving
       57-59 to the in-game HUD that already uses them. A menu covering a window
       is intended — it is transient and you dismiss it. */
    .pa-panel.pa-window{top:0;bottom:0;height:auto;max-height:none;max-width:none;z-index:56;
      border-radius:0;border-top:0;border-bottom:0;overflow:hidden;
      flex-direction:column;box-shadow:0 0 20px rgba(0,0,0,.5);}
    .pa-panel.pa-window.left{left:0;right:auto;border-left:0;}
    /* Right-hand windows sit inboard of an open action iframe (z 130, right:0)
       so the two stack instead of covering each other. */
    .pa-panel.pa-window.right{right:var(--pa-side-panel-w, 0px);left:auto;border-right:0;}
    /* The head is the title bar; only the body scrolls (a popover scrolls as a
       whole, which in a full-height column would take the title bar with it). */
    .pa-panel.pa-window > .pa-body{flex:1;min-height:0;overflow-y:auto;overscroll-behavior:contain;}
    /* The fill option: the body stops being the scroller and becomes a plain
       column, for a panel that pins its own chrome around an inner scroller. */
    .pa-panel.pa-window.pa-fill > .pa-body{display:flex;flex-direction:column;overflow:hidden;}
    /* Compact (below opts.compactBelowRem): buy the column back from padding,
       not from type size. Only the shared chrome is here — the panels drop their
       own secondary rows in their own stylesheets. */
    .pa-panel.pa-window.pa-compact > .pa-head{padding:0.4rem 0.5rem;}
    .pa-panel.pa-window.pa-compact > .pa-body{padding:0.5rem 0.5rem 0.6rem;}
    .pa-panel.pa-window.pa-compact .pa-list-row{padding:0.35rem 0.1rem;gap:0.4rem;}
    /* Resize grip on the inner edge — the one facing the game. */
    .pa-win-grip{position:absolute;top:0;bottom:0;width:0.45rem;z-index:3;cursor:col-resize;}
    .pa-panel.pa-window.left > .pa-win-grip{right:0;}
    .pa-panel.pa-window.right > .pa-win-grip{left:0;}
    .pa-win-grip:hover,.pa-win-grip.on{background:#c51a1b;}
    /* While dragging, #game must follow the pointer instead of easing behind it. */
    body.pa-dock-dragging{cursor:col-resize;user-select:none;}
    body.pa-dock-dragging #game{transition:none;}
  `;
  document.head.appendChild(style);
}

export class DockWindow {
  /** Whether this window was left open when the app last closed — the caller
   *  decides what to do about it (Matrix, for one, has a chunk to load first). */
  readonly wasOpen: boolean;

  /** The width the user actually asked for — dragged, restored from a previous
   *  session, or the default. Kept apart from `widthPx` because the ceiling is a
   *  fraction of the viewport: fold the two together and a window narrowed by a
   *  temporarily small viewport can never grow back, since the clamped value
   *  becomes the new request. Un-maximising and re-maximising the desktop window
   *  would shrink the column for good (and, with a compact threshold, strand it
   *  in its compact layout at full width). */
  private desiredPx = 0;
  /** What is on screen right now: `desiredPx` clamped to what fits. */
  private widthPx = 0;
  private open = false;

  constructor(
    private readonly el: HTMLElement,
    private readonly opts: DockWindowOptions,
  ) {
    injectDockStyles();
    this.wasOpen = readStored(`${opts.key}-open`) === '1';

    el.classList.add('pa-window', opts.side);
    if (opts.fill) el.classList.add('pa-fill');
    el.style.display = 'none';

    const grip = document.createElement('div');
    grip.className = 'pa-win-grip';
    grip.title = 'Drag to resize';
    grip.addEventListener('pointerdown', (ev) => this.startDrag(ev, grip));
    el.appendChild(grip);

    const stored = Number(readStored(`${opts.key}-w`));
    this.requestWidth(Number.isFinite(stored) && stored > 0 ? stored : opts.defaultRem * rootFontPx());

    // A viewport that shrank (window resize, or the desktop shell leaving
    // fullscreen) must not leave a window wider than its own ceiling — and one
    // that grew again has to give the width back, hence reflow rather than a
    // fresh request.
    window.addEventListener('resize', () => this.reflow());
  }

  get isOpen(): boolean {
    return this.open;
  }

  setOpen(open: boolean): void {
    if (this.open === open) return;
    this.open = open;
    this.el.style.display = open ? 'flex' : 'none';
    const root = document.documentElement.style;
    if (open) root.setProperty(WIDTH_VAR[this.opts.side], `${this.widthPx}px`);
    else root.removeProperty(WIDTH_VAR[this.opts.side]);
    writeStored(`${this.opts.key}-open`, open ? '1' : '0');
  }

  toggle(): boolean {
    this.setOpen(!this.open);
    return this.open;
  }

  /** The user wants this width. Remembered as asked, then fitted. */
  private requestWidth(px: number): void {
    this.desiredPx = px;
    this.reflow();
  }

  /** Fit the requested width to the viewport as it is now, and paint it. */
  private reflow(): void {
    const min = (this.opts.minRem ?? 18) * rootFontPx();
    const max = Math.max(min, window.innerWidth * MAX_VIEWPORT_FRACTION);
    this.widthPx = Math.round(Math.min(max, Math.max(min, this.desiredPx)));
    this.el.style.width = `${this.widthPx}px`;
    // Every width change ends up here (constructor, grip drag, viewport resize),
    // so this is the one place compact has to be decided.
    const compactAt = this.opts.compactBelowRem;
    if (compactAt !== undefined) {
      this.el.classList.toggle('pa-compact', this.widthPx < compactAt * rootFontPx());
    }
    if (this.open) document.documentElement.style.setProperty(WIDTH_VAR[this.opts.side], `${this.widthPx}px`);
  }

  private startDrag(ev: PointerEvent, grip: HTMLElement): void {
    ev.preventDefault();
    grip.setPointerCapture(ev.pointerId);
    grip.classList.add('on');
    document.body.classList.add('pa-dock-dragging');
    const startX = ev.clientX;
    const startW = this.widthPx;
    // Dragging the left window's grip right widens it; the right window's grip
    // is on its other edge, so the same gesture there is a narrowing.
    const dir = this.opts.side === 'left' ? 1 : -1;

    const move = (e: PointerEvent): void => this.requestWidth(startW + dir * (e.clientX - startX));
    const end = (e: PointerEvent): void => {
      grip.releasePointerCapture(e.pointerId);
      grip.classList.remove('on');
      document.body.classList.remove('pa-dock-dragging');
      grip.removeEventListener('pointermove', move);
      writeStored(`${this.opts.key}-w`, String(this.widthPx));
    };
    grip.addEventListener('pointermove', move);
    grip.addEventListener('pointerup', end, { once: true });
    grip.addEventListener('pointercancel', end, { once: true });
  }
}
