/**
 * Full-screen overlay for a tile/sprite's 'iframe' action (see shared
 * Action) — opens an external page in a sandboxed iframe. https:// only
 * (enforced server-side too, see SimRoom's sanitizeLayoutActions — this is
 * just a defensive belt-and-suspenders check before ever creating the
 * iframe). Closes on the ✕ button or Escape.
 */
let root: HTMLDivElement | null = null;
let escHandler: ((e: KeyboardEvent) => void) | null = null;

function ensureStyles(): void {
  if (document.getElementById('pa-iframe-style')) return;
  const s = document.createElement('style');
  s.id = 'pa-iframe-style';
  s.textContent = `
    #pa-iframe-overlay{position:fixed;inset:0;z-index:130;display:flex;flex-direction:column;
      background:#1c1a19;font-family:'FS Pixel Sans',ui-monospace,monospace;}
    #pa-iframe-overlay .pa-iframe-bar{display:flex;align-items:center;gap:0.6rem;padding:0.5rem 0.7rem;
      background:#1c1a19;border-bottom:2px solid #0a0908;box-shadow:inset 0 -1px 0 #2c2a28;}
    #pa-iframe-overlay .pa-iframe-url{flex:1;color:#818586;font-size:0.85rem;overflow:hidden;
      text-overflow:ellipsis;white-space:nowrap;}
    #pa-iframe-overlay button{cursor:pointer;background:#242220;border:2px solid #0a0908;color:#f1efec;
      border-radius:0.4rem;font:0.95rem 'FS Pixel Sans',monospace;padding:0.4rem 0.7rem;
      box-shadow:inset 0 2px 0 #4a4744,inset 0 -3px 0 #050505;}
    #pa-iframe-overlay button:hover{background:#2e2b28;}
    #pa-iframe-overlay iframe{flex:1;border:0;background:#fff;}
  `;
  document.head.appendChild(s);
}

export function openActionIframe(url: string): void {
  if (typeof url !== 'string' || !url.startsWith('https://')) return;
  closeActionIframe();
  ensureStyles();
  root = document.createElement('div');
  root.id = 'pa-iframe-overlay';

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
  root?.remove();
  root = null;
}
