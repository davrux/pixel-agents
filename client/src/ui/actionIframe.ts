/**
 * A tile/sprite's 'iframe' action (see shared Action) — an external page opened
 * in a sandboxed iframe, in one of two shapes the viewer chooses in Settings:
 *
 *   'dock'    — pinned to the right, the game shrinks to make room, the way
 *               WorkAdventure's `openWebsite`/`WA.nav.openCoWebSite` does.
 *               #game (index.html) is inset by `--pa-side-panel-w`, and Phaser's
 *               Scale.RESIZE mode watches its size via ResizeObserver and
 *               resizes the canvas + camera to match on its own — no manual
 *               game.scale call. Nothing covers the world, so you can still see
 *               where you are standing.
 *   'overlay' — a centred window floating ON the game, the same shape and chrome
 *               as the arcade cabinet (ArcadeUI). The page gets far more room on
 *               a narrow screen, at the cost of hiding the world behind it. The
 *               game is not resized at all, so nothing re-lays-out when it opens.
 *
 * Which one is a personal preference, stored per user (`iframeOverlay`, see
 * appStore.getViewerSettings) rather than decided here or by the map: the same
 * page is a reference panel beside the world on a wide monitor and a full window
 * on a laptop, and only the viewer knows which they are looking at.
 *
 * https:// only (enforced server-side too, see SimRoom's sanitizeLayoutActions —
 * this is just a defensive belt-and-suspenders check before ever creating the
 * iframe). Closes on the ✕ button or Escape, in both shapes.
 */
/** Percentage of the viewport the DOCKED panel takes — #game gets the rest.
 *  Matches WorkAdventure's openWebsiteWidth default range (they cap around 70%);
 *  a reference panel doesn't need to dominate the screen, so default smaller.
 *  The overlay has no equivalent: it is sized like the arcade, in CSS. */
const DEFAULT_WIDTH_PERCENT = 35;

export interface ActionIframeOptions {
  /** Float a centred window over the game instead of pinning a column to the
   *  right. The viewer's own setting — the caller passes it in. */
  overlay?: boolean;
  widthPercent?: number;
}

let root: HTMLDivElement | null = null;
let escHandler: ((e: KeyboardEvent) => void) | null = null;
/** The page currently open, so a viewer who flips the preference while looking
 *  at one gets it moved rather than closed (see reopenActionIframe). */
let openUrl: string | null = null;

function ensureStyles(): void {
  if (document.getElementById('pa-iframe-style')) return;
  const s = document.createElement('style');
  s.id = 'pa-iframe-style';
  s.textContent = `
    #pa-iframe-panel{position:fixed;top:0;right:0;bottom:0;z-index:130;display:flex;flex-direction:column;
      background:#1c1a19;border-left:2px solid #0a0908;box-shadow:-4px 0 18px rgba(0,0,0,.4);
      font-family:'FS Pixel Sans',ui-monospace,monospace;}
    /* Overlay: the arcade cabinet's own box, so the two floating windows in this
       app are the same window (see ArcadeUI's #pa-arc). */
    #pa-iframe-panel.overlay{top:50%;right:auto;bottom:auto;left:50%;transform:translate(-50%,-50%);
      width:min(94vw,64rem);height:min(90vh,44rem);border:2px solid #0a0908;border-radius:0.6rem;
      overflow:hidden;box-shadow:inset 0 2px 0 #292725,inset 0 -3px 0 #030303,0 12px 28px rgba(0,0,0,.55);}
    #pa-iframe-panel .pa-iframe-bar{display:flex;align-items:center;gap:0.6rem;padding:0.5rem 0.7rem;
      background:#1c1a19;border-bottom:2px solid #0a0908;box-shadow:inset 0 -1px 0 #2c2a28;}
    #pa-iframe-panel .pa-iframe-url{flex:1;color:#818586;font-size:0.85rem;overflow:hidden;
      text-overflow:ellipsis;white-space:nowrap;}
    #pa-iframe-panel button{cursor:pointer;background:#242220;border:2px solid #0a0908;color:#f1efec;
      border-radius:0.4rem;font:0.95rem 'FS Pixel Sans',monospace;padding:0.4rem 0.7rem;
      box-shadow:inset 0 2px 0 #4a4744,inset 0 -3px 0 #050505;}
    #pa-iframe-panel button:hover{background:#2e2b28;}
    #pa-iframe-panel iframe{flex:1;min-height:0;border:0;background:#fff;}
  `;
  document.head.appendChild(s);
}

export function openActionIframe(url: string, opts: ActionIframeOptions = {}): void {
  if (typeof url !== 'string' || !url.startsWith('https://')) return;
  closeActionIframe();
  ensureStyles();
  const overlay = opts.overlay === true;

  root = document.createElement('div');
  root.id = 'pa-iframe-panel';
  if (overlay) {
    root.classList.add('overlay');
  } else {
    const pct = Math.min(70, Math.max(15, opts.widthPercent ?? DEFAULT_WIDTH_PERCENT)); // WorkAdventure's practical ceiling
    // Drives #game's own width (index.html) AND every other fixed, right-
    // anchored piece of UI (paSkin.ts's menubar/popovers, meetingArea.ts) —
    // one variable, so nothing needs its own bespoke JS to step aside. Left
    // unset for the overlay: it covers the game rather than displacing it, so
    // nothing should move out of its way.
    document.documentElement.style.setProperty('--pa-side-panel-w', `${pct}vw`);
    root.style.width = `${pct}vw`;
  }

  const bar = document.createElement('div');
  bar.className = 'pa-iframe-bar';
  const label = document.createElement('span');
  label.className = 'pa-iframe-url';
  label.textContent = url;
  const close = document.createElement('button');
  close.textContent = '✕ Close';
  close.onclick = () => closeActionIframe();
  bar.append(label, close);

  const frame = document.createElement('iframe');
  frame.src = url;
  frame.sandbox.add('allow-scripts', 'allow-same-origin', 'allow-forms', 'allow-popups');

  root.append(bar, frame);
  document.body.appendChild(root);
  openUrl = url;

  escHandler = (e) => {
    if (e.key === 'Escape') closeActionIframe();
  };
  window.addEventListener('keydown', escHandler);
}

export function closeActionIframe(): void {
  if (escHandler) {
    window.removeEventListener('keydown', escHandler);
    escHandler = null;
  }
  document.documentElement.style.removeProperty('--pa-side-panel-w');
  root?.remove();
  root = null;
  openUrl = null;
}

/**
 * Move an already-open page into the other shape — what the Settings toggle
 * calls, so flipping the preference acts on what the viewer is looking at
 * instead of only on the next page they open. A no-op when nothing is open.
 *
 * It reloads the page (a new iframe from the same URL), which is why the toggle
 * does it rather than the renderer doing it on every settings message: moving a
 * live iframe between two parents is what would preserve the document, and no
 * browser guarantees that — reparenting an iframe reloads it anyway.
 */
export function reopenActionIframe(opts: ActionIframeOptions = {}): void {
  const url = openUrl;
  if (url === null) return;
  openActionIframe(url, opts);
}
