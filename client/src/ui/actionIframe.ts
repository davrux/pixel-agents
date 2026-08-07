/**
 * Docked side panel for a tile/sprite's 'iframe' action (see shared Action) —
 * opens an external page in a sandboxed iframe alongside the game, the same
 * way WorkAdventure's `openWebsite`/`WA.nav.openCoWebSite` does: #game
 * shrinks to make room (Phaser's Scale.RESIZE mode watches its size via
 * ResizeObserver and resizes the canvas + camera to match on its own, no
 * manual game.scale call needed) rather than the panel covering the game.
 * https:// only (enforced server-side too, see SimRoom's
 * sanitizeLayoutActions — this is just a defensive belt-and-suspenders check
 * before ever creating the iframe). Closes on the ✕ button or Escape.
 */
/** Percentage of the viewport the panel takes — #game gets the rest. Matches
 *  WorkAdventure's openWebsiteWidth default range (they cap around 70%); a
 *  reference panel doesn't need to dominate the screen, so default smaller. */
const DEFAULT_WIDTH_PERCENT = 35;

let root: HTMLDivElement | null = null;
let escHandler: ((e: KeyboardEvent) => void) | null = null;

function ensureStyles(): void {
  if (document.getElementById('pa-iframe-style')) return;
  const s = document.createElement('style');
  s.id = 'pa-iframe-style';
  s.textContent = `
    #pa-iframe-panel{position:fixed;top:0;right:0;bottom:0;z-index:130;display:flex;flex-direction:column;
      background:#1c1a19;border-left:2px solid #0a0908;box-shadow:-4px 0 18px rgba(0,0,0,.4);
      font-family:'FS Pixel Sans',ui-monospace,monospace;}
    #pa-iframe-panel .pa-iframe-bar{display:flex;align-items:center;gap:0.6rem;padding:0.5rem 0.7rem;
      background:#1c1a19;border-bottom:2px solid #0a0908;box-shadow:inset 0 -1px 0 #2c2a28;}
    #pa-iframe-panel .pa-iframe-url{flex:1;color:#818586;font-size:0.85rem;overflow:hidden;
      text-overflow:ellipsis;white-space:nowrap;}
    #pa-iframe-panel button{cursor:pointer;background:#242220;border:2px solid #0a0908;color:#f1efec;
      border-radius:0.4rem;font:0.95rem 'FS Pixel Sans',monospace;padding:0.4rem 0.7rem;
      box-shadow:inset 0 2px 0 #4a4744,inset 0 -3px 0 #050505;}
    #pa-iframe-panel button:hover{background:#2e2b28;}
    #pa-iframe-panel iframe{flex:1;border:0;background:#fff;}
  `;
  document.head.appendChild(s);
}

export function openActionIframe(url: string, widthPercent: number = DEFAULT_WIDTH_PERCENT): void {
  if (typeof url !== 'string' || !url.startsWith('https://')) return;
  closeActionIframe();
  ensureStyles();
  const pct = Math.min(70, Math.max(15, widthPercent)); // same practical ceiling as WorkAdventure's

  // Drives #game's own width (index.html) AND every other fixed, right-
  // anchored piece of UI (paSkin.ts's menubar/popovers, meetingArea.ts) —
  // one variable, so nothing needs its own bespoke JS to step aside.
  document.documentElement.style.setProperty('--pa-side-panel-w', `${pct}vw`);

  root = document.createElement('div');
  root.id = 'pa-iframe-panel';
  root.style.width = `${pct}vw`;

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
}
