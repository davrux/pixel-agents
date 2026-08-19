/**
 * The bottom-left HUD strip — the row of small square toggles that open the
 * corner panels (chat, online list, …), plus the two facts everything anchored
 * down there has to agree on:
 *
 *   - the strip owns the very bottom-left corner, so a panel sits ABOVE it
 *     (`bottom: var(--pa-hud-bottom)`) instead of covering it. That is what
 *     lets you switch panels with one click: the other panel's button stays
 *     reachable while one is open.
 *   - like the chat box it follows a docked window (`--pa-dock-l`, see
 *     ui/dockWindow.ts) rather than the screen edge.
 *
 * Buttons keep their registration order, so the chat toggle (created first)
 * stays leftmost wherever the HUD is assembled.
 */

/** Height reserved for the strip; panels anchored bottom-left start above it. */
const BAR_STYLE_ID = 'pa-hudbar-style';

/** The strip element, created on first use. */
export function hudBar(): HTMLDivElement {
  injectStyle();
  let bar = document.getElementById('pa-hudbar') as HTMLDivElement | null;
  if (!bar) {
    bar = document.createElement('div');
    bar.id = 'pa-hudbar';
    bar.className = 'pa-ui';
    (document.getElementById('game') ?? document.body).appendChild(bar);
  }
  return bar;
}

/** A HUD toggle: fixed square, chat-button surface, `.on` while its panel is open. */
export function hudButton(id: string, glyph: string, title: string): HTMLButtonElement {
  const b = document.createElement('button');
  b.id = id;
  b.className = 'pa-hudbtn';
  b.textContent = glyph;
  b.title = title;
  hudBar().appendChild(b);
  return b;
}

function injectStyle(): void {
  if (document.getElementById(BAR_STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = BAR_STYLE_ID;
  style.textContent = `
    /* 2.2rem button + 0.5rem bottom margin + 0.4rem gap — the offset a
       bottom-left panel uses so it clears the strip. Buttons are a fixed square
       for exactly this reason: the reserved height must be knowable in CSS. */
    :root{--pa-hud-bottom:3.1rem;}
    #pa-hudbar{position:fixed;left:calc(0.5rem + var(--pa-dock-l, 0px));bottom:0.5rem;z-index:55;
      display:flex;gap:0.4rem;align-items:center;}
    /* .pa-b in everything but name — the inset-control surface (#262422), the
       2px border and the signature bevel. Opaque: it is a small control, so it
       hides nothing, and a translucent button reads as disabled. */
    .pa-hudbtn{width:2.2rem;height:2.2rem;flex:0 0 auto;display:flex;align-items:center;justify-content:center;
      position:relative;background:#262422;border:2px solid #0a0908;border-radius:0.35rem;color:#f1efec;
      font:1.1rem 'FS Pixel Sans',ui-monospace,monospace;padding:0;cursor:pointer;
      box-shadow:inset 0 2px 0 #4a4744,inset 0 -3px 0 #050505;}
    .pa-hudbtn:hover{background:#2e2b28;}
    /* "On" = this button's panel is open, same segment-on token as .pa-seg .seg.on. */
    .pa-hudbtn.on{background:#37342f;color:#fff;}
    .pa-hudbtn.unread::after{content:'';position:absolute;top:-4px;right:-4px;width:0.5rem;height:0.5rem;
      border:2px solid #0a0908;border-radius:50%;background:#e7da00;}`;
  document.head.appendChild(style);
}
