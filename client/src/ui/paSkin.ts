/**
 * Shared "pixel-menu" skin — the .pa-* menu/panel/button styles used across the
 * 2D office client (one source of truth, no duplicate CSS). Injected once
 * (idempotent). Adds a `.pa-select` for native <select> dropdowns.
 */
export function injectPaSkin(): void {
  if (document.getElementById('pa-skin')) return;
  const style = document.createElement('style');
  style.id = 'pa-skin';
  style.textContent = `
      .pa-ui{font-family:'FS Pixel Sans',ui-monospace,monospace;}
      /* Scrollbars, in the same tokens as everything else — the default ones are
         the last piece of host chrome visible inside our own panels.
         Both mechanisms on purpose, because neither covers both engines: the
         standard properties are what Firefox honours, the -webkit- pseudos are
         what Chromium/Electron honour and the only way to get the 2px border the
         rest of the skin has. Where a browser supports both it picks one; they
         are set from the same tokens, so it does not matter which.
         scrollbar-width/-color inherit, so declaring them on .pa-ui reaches every
         scroller inside it (panel bodies, the Matrix timeline and room list, the
         Mumble channel tree, the chat log, a code block) without listing them. */
      .pa-ui{scrollbar-width:thin;scrollbar-color:#37342f #141312;}
      .pa-ui::-webkit-scrollbar,.pa-ui ::-webkit-scrollbar{width:0.6rem;height:0.6rem;}
      .pa-ui::-webkit-scrollbar-track,.pa-ui ::-webkit-scrollbar-track{background:#141312;border-radius:0.3rem;}
      .pa-ui::-webkit-scrollbar-thumb,.pa-ui ::-webkit-scrollbar-thumb{background:#37342f;
        border:2px solid #0a0908;border-radius:0.3rem;}
      .pa-ui::-webkit-scrollbar-thumb:hover,.pa-ui ::-webkit-scrollbar-thumb:hover{background:#4a4744;}
      /* Where a horizontal and a vertical bar meet (a wide code block in a
         narrow column), so the gap is not the host's grey. */
      .pa-ui::-webkit-scrollbar-corner,.pa-ui ::-webkit-scrollbar-corner{background:#141312;}
      /* Grouped top bar: Audio · Zone · Space · Assets  … ☰ (design). */
      /* Spans the game only: the docked application windows (--pa-dock-l /
         --pa-dock-r, see ui/dockWindow.ts) and an open action iframe each take
         their width off an end rather than being covered by the bar. */
      #pa-menubar{position:fixed;top:0.6rem;left:calc(0.75rem + var(--pa-dock-l, 0px));
        right:calc(0.75rem + var(--pa-dock-r, 0px) + var(--pa-side-panel-w, 0px));
        z-index:60;display:flex;align-items:center;gap:0.55rem;}
      /* While a curtain covers the game column (GAME_COLUMN_CSS at z 200 — the
         reconnect overlay and the kicked notice, see OfficeScene), the top bar
         stays above it. It is not decoration during an outage: it is how you
         open Matrix and Mumble, which keep working while this world does not,
         and both are a click away in there.

         The bar and its popovers rise TOGETHER, deliberately. A bar you can
         click whose menus open behind the curtain is worse than one you cannot:
         every button reads as dead. Docked windows are .pa-panel too and are
         left out — they are outboard of the column, so nothing covers them
         anyway, and they own their layer (z 56, see dockWindow.ts).

         Set by whoever raises the curtain, on <html>, and never taken down:
         both curtains end in a reload. */
      html.pa-curtain #pa-menubar,
      html.pa-curtain .pa-panel:not(.pa-window){z-index:201;}
      .pa-btn{display:inline-flex;align-items:center;gap:0.45rem;cursor:pointer;position:relative;white-space:nowrap;
        background:#242220;border:2px solid #0a0908;border-radius:0.45rem;color:#f1efec;
        font:1.05rem 'FS Pixel Sans',monospace;padding:0.5rem 0.8rem;
        box-shadow:inset 0 2px 0 #4a4744,inset 0 -3px 0 #050505;}
      .pa-btn:hover{background:#2e2b28;}
      .pa-btn.active{color:#fff;}
      .pa-btn.active::after{content:'';position:absolute;left:8px;right:8px;bottom:-3px;height:3px;background:#7fbf6a;border-radius:2px;}
      .pa-btn.warn{background:#a86a2e;color:#ffe6c8;box-shadow:inset 0 2px 0 #d0954a,inset 0 -3px 0 #5a3410;}
      .pa-btn.danger{background:#7c2634;color:#f6cdd4;box-shadow:inset 0 2px 0 #b34a5a,inset 0 -3px 0 #45111a;}
      /* "A newer build is available" chip (ui/versionGate.ts): the primary red, so it
         reads as something to act on — deliberately NOT .warn/.danger, whose icon
         overlay is a crossed-out circle meaning "blocked". */
      .pa-btn.pa-update{background:#c51a1b;color:#fff;box-shadow:inset 0 2px 0 #e2585a,inset 0 -3px 0 #5c0f10;}
      .pa-btn.pa-update:hover{background:#d42021;}
      .pa-btn.pa-update:disabled{cursor:default;}
      /* Window close: a plain ✕ that only reddens on hover (no state overlay). */
      .pa-btn.pa-close:hover{background:#7c2634;color:#f6cdd4;box-shadow:inset 0 2px 0 #b34a5a,inset 0 -3px 0 #45111a;}
      .pa-btn .ico{position:relative;display:inline-block;line-height:1;}
      .pa-btn.warn .ico::before,.pa-btn.danger .ico::before{content:'';position:absolute;inset:-22%;border-radius:50%;
        border:0.12em solid #ff5b6b;box-shadow:0 0 0 1px rgba(0,0,0,.5);}
      .pa-btn.warn .ico::after,.pa-btn.danger .ico::after{content:'';position:absolute;left:-12%;top:44%;
        width:124%;height:0.16em;background:#ff5b6b;border-radius:1px;transform:rotate(-24deg);
        box-shadow:0 0 0 1px rgba(0,0,0,.55);}
      .pa-eq{display:flex;gap:2px;align-items:flex-end;height:1.1em;margin-left:0.12em;--l:0;}
      .pa-eq span{width:3px;background:#7fbf6a;border-radius:1px;transition:height 0.06s ease-out;}
      .pa-eq span:nth-child(5){height:calc(15% + var(--l) * 85%);}
      .pa-eq span:nth-child(4){height:max(15%,calc(15% + (var(--l) - 0.2) * 106%));}
      .pa-eq span:nth-child(3){height:max(15%,calc(15% + (var(--l) - 0.4) * 142%));}
      .pa-eq span:nth-child(2){height:max(15%,calc(15% + (var(--l) - 0.6) * 213%));}
      .pa-eq span:nth-child(1){height:max(15%,calc(15% + (var(--l) - 0.8) * 425%));}
      .pa-btn .caret{color:#7f859c;font-size:0.8rem;}
      #pa-menubar .pa-dot{width:0.5rem;height:0.5rem;border-radius:50%;background:#525556;}
      #pa-menubar .pa-dot.live{background:#5aa348;box-shadow:0 0 6px #5aa348;}
      #pa-menubar .pa-div{width:2px;height:1.9rem;background:#37342f;box-shadow:inset 1px 0 0 #0a0908;border-radius:1px;margin:0 0.1rem;}
      #pa-menubar .pa-spacer{flex:1;}
      #pa-menu-more{justify-content:center;min-width:2.9rem;padding:0.5rem 0.7rem;}
      /* One shared popover style — same width, style + position for every menu. */
      .pa-panel{position:fixed;top:3.7rem;z-index:60;display:none;width:24rem;max-width:94vw;
        max-height:calc(100vh - 4.7rem);overflow-y:auto;overscroll-behavior:contain;
        background:#1c1a19;border:2px solid #0a0908;border-radius:0.6rem;color:#f1efec;
        box-shadow:inset 0 2px 0 #292725,inset 0 -3px 0 #030303,0 12px 28px rgba(0,0,0,.55);}
      /* Popovers hang off the menubar, so they follow it inboard of whatever
         windows are docked (see #pa-menubar above). */
      .pa-panel.left{left:calc(0.75rem + var(--pa-dock-l, 0px));}
      .pa-panel.right{right:calc(0.75rem + var(--pa-dock-r, 0px) + var(--pa-side-panel-w, 0px));}
      /* Being inset from one side is not enough: a 24rem popover pinned to the
         left window's inner edge still reaches into the right window once both
         are open, which happens at about 1500px of window width. So the width
         is clamped to the room actually left between them (--pa-hud-gap, see
         index.html), less the popover's own two margins.

         The 20rem max() is the floor, and it is where this deliberately stops
         being polite: below that a menu would be too narrow to use, so it keeps
         20rem and overlaps the far window instead — which is fine, because a
         popover sits in the layer above both windows (z 60 vs 56, see
         dockWindow.ts) and is gone the moment you dismiss it. Shrink while
         shrinking still leaves something usable; overlap only when it doesn't.

         :not(.pa-window) because a docked window is also a .pa-panel and its
         width is the user's to drag — it sets max-width:none for that reason. */
      .pa-panel:not(.pa-window){max-width:max(20rem, min(94vw, calc(var(--pa-hud-gap, 100vw) - 1.5rem)));}
      .pa-panel .pa-head{display:flex;align-items:center;justify-content:space-between;gap:0.6rem;
        padding:0.75rem 0.85rem 0.65rem;border-bottom:2px solid #0a0908;box-shadow:inset 0 -1px 0 #2c2a28;
        position:sticky;top:0;background:#1c1a19;z-index:2;}
      .pa-panel .pa-head h4{margin:0;font-size:1.3rem;font-weight:600;color:#f5f3f0;letter-spacing:.3px;}
      /* The close chip, deliberately NOT scoped to .pa-panel: the corner widgets
         that are not panels (the chat box, the online list) close the same way and
         must look identical doing it, and one definition is what keeps that true.
         font:inherit because those two carry it on a <button>, which would
         otherwise take the UA's own font — the panels' own .pa-x is a <div>. */
      .pa-x{flex:none;width:1.7rem;height:1.7rem;display:flex;align-items:center;justify-content:center;
        background:#262422;border:2px solid #0a0908;border-radius:0.35rem;cursor:pointer;color:#d7d9da;
        font:inherit;padding:0;line-height:1;
        box-shadow:inset 0 2px 0 #4a4744,inset 0 -3px 0 #050505;}
      .pa-x:hover{background:#2e2b28;color:#f5f3f0;}
      .pa-panel .pa-body{padding:0.85rem 0.9rem 1rem;}
      /* Segmented tabs + chips. */
      .pa-seg{display:flex;gap:0.35rem;padding:0.25rem;background:#141312;border:2px solid #0a0908;border-radius:0.5rem;margin-bottom:0.85rem;}
      .pa-seg .seg{flex:1;text-align:center;padding:0.45rem 0.3rem;cursor:pointer;border-radius:0.35rem;color:#adb0b2;font-size:0.95rem;border:0;background:transparent;font-family:inherit;}
      .pa-seg .seg.on{color:#fff;background:#37342f;box-shadow:inset 0 2px 0 rgba(255,255,255,.14),inset 0 -2px 0 rgba(0,0,0,.35);}
      .pa-chips{display:flex;gap:0.4rem;margin-bottom:0.8rem;flex-wrap:wrap;}
      .pa-chip{padding:0.35rem 0.75rem;cursor:pointer;border-radius:0.4rem;border:2px solid #0a0908;font-size:0.85rem;
        color:#adb0b2;background:#262422;box-shadow:inset 0 2px 0 #4a4744,inset 0 -3px 0 #050505;}
      .pa-chip.on{color:#fff;background:#c51a1b;box-shadow:inset 0 2px 0 #e2585a,inset 0 -3px 0 #5c0f10;}
      /* Generic rows + buttons shared by every panel. */
      .pa-panel .grouplbl{font-size:0.72rem;letter-spacing:1px;color:#818586;margin:0.7rem 0.15rem 0.25rem;text-transform:uppercase;}
      .pa-list-row{display:flex;align-items:center;gap:0.55rem;padding:0.5rem 0.15rem;border-bottom:1px solid #2c2a28;}
      .pa-list-row .nm{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;font-size:1rem;color:#f0eeea;}
      .pa-list-row small{color:#818586;}
      /* Compact tile grid — an alternative to .pa-list-row for browsing many
         assets at once (e.g. after a big import): each item shown at its own
         native size (times the zoom control), not squeezed into a uniform box,
         so relative sizes stay honest. Click to select; act on the selection
         via .pa-asset-actionbar rather than per-tile buttons. */
      .pa-assetgrid{display:flex;flex-wrap:wrap;gap:0.5rem;align-items:flex-end;margin-bottom:0.6rem;}
      .pa-assetgrid-item{display:flex;flex-direction:column;align-items:center;gap:0.25rem;cursor:pointer;
        max-width:6rem;padding:0.3rem;border:2px solid #0a0908;border-radius:0.35rem;background:#141312;}
      .pa-assetgrid-item.sel{border-color:#7fbf6a;box-shadow:0 0 0 2px #7fbf6a;}
      .pa-assetgrid-item .nm{font-size:0.65rem;color:#818586;max-width:5.4rem;overflow:hidden;
        text-overflow:ellipsis;white-space:nowrap;}
      /* Sticks to the bottom of the scrolling panel (like .pa-head sticks to
         the top) so actions for the current selection stay reachable no
         matter how far the grid above has scrolled. */
      .pa-asset-actionbar{position:sticky;bottom:0;padding:0.6rem 0 0;margin-top:0.6rem;
        background:#1c1a19;border-top:2px solid #0a0908;box-shadow:0 -4px 10px rgba(0,0,0,.4);
        display:flex;align-items:center;gap:0.6rem;}
      .pa-asset-actionbar .nm{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;font-size:0.95rem;}
      .pa-b{padding:0.4rem 0.7rem;font-size:0.85rem;color:#f1efec;background:#262422;border:2px solid #0a0908;
        border-radius:0.35rem;cursor:pointer;box-shadow:inset 0 2px 0 #4a4744,inset 0 -3px 0 #050505;font-family:inherit;}
      .pa-b.primary{background:#c51a1b;color:#fff;box-shadow:inset 0 2px 0 #e2585a,inset 0 -3px 0 #5c0f10;}
      .pa-b.danger{background:#7c2634;color:#f1d0d6;box-shadow:inset 0 2px 0 #b34a5a,inset 0 -3px 0 #45111a;}
      .pa-b.wide{width:100%;padding:0.6rem;font-size:1rem;display:flex;align-items:center;justify-content:center;gap:0.4rem;}
      .pa-menurow{display:flex;align-items:center;gap:0.6rem;padding:0.65rem 0.75rem;font-size:1.05rem;color:#f1efec;
        background:#242220;border:2px solid #0a0908;border-radius:0.45rem;cursor:pointer;margin-bottom:0.5rem;
        box-shadow:inset 0 2px 0 #4a4744,inset 0 -3px 0 #050505;}
      .pa-menurow.here{color:#e7da00;}
      .pa-menurow.danger{background:#7c2634;color:#f1d0d6;box-shadow:inset 0 2px 0 #b34a5a,inset 0 -3px 0 #45111a;}
      .pa-menurow .sub{margin-left:auto;color:#818586;font-size:0.8rem;}
      /* Native dropdown / text input styled to match (the office uses custom ones).
         appearance:none strips the OS chrome so our pixel styling actually shows;
         a custom caret is drawn via background-image. max-width keeps them in-panel. */
      .pa-select,.pa-input{background:#262422;border:2px solid #0a0908;color:#f1efec;border-radius:0.35rem;
        padding:0.4rem 0.55rem;font:0.95rem 'FS Pixel Sans',monospace;box-shadow:inset 0 2px 0 #4a4744,inset 0 -3px 0 #050505;
        max-width:100%;box-sizing:border-box;}
      .pa-select{cursor:pointer;-webkit-appearance:none;-moz-appearance:none;appearance:none;
        padding-right:1.7rem;background-repeat:no-repeat;background-position:right 0.55rem center;
        background-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='7' viewBox='0 0 10 7'%3E%3Cpath fill='%239aa0b8' d='M0 0h10L5 7z'/%3E%3C/svg%3E");}
      .pa-select option{background:#262422;color:#f1efec;}
      /* Dimmed helper text — used across dialogs (meeting rooms, zone settings, …). */
      .muted{color:#818586;}
      /* Who-am-I profile header (☰ menu): display name + @user-id handle. */
      .pa-whoami{margin-bottom:0.7rem;padding-bottom:0.7rem;border-bottom:1px solid #2c2a28;}
      .pa-whoami .name{display:flex;align-items:center;gap:0.5rem;flex-wrap:wrap;font-size:1.15rem;font-weight:600;color:#f5f3f0;}
      .pa-whoami .handle{margin-top:0.15rem;font-size:0.85rem;color:#818586;}
      .pa-whoami .admin{background:#c51a1b;border:2px solid #0a0908;color:#fff;border-radius:0.3rem;padding:0.05rem 0.4rem;
        font-size:0.78rem;box-shadow:inset 0 2px 0 #e2585a,inset 0 -3px 0 #5c0f10;}
      /* Space (Layouts / Zones) — kept close to the originals, restyled. */
      #pa-layouts h4,#pa-zones h4{margin:0 0 0.5rem;font-size:0.95rem;color:#818586;font-weight:400;}
      #pa-zones .who-am-i{font-size:0.82rem;margin:0 0 0.6rem;padding-bottom:0.5rem;border-bottom:1px solid #2c2a28;}
      #pa-layouts .item,#pa-zones .item{display:flex;align-items:center;gap:0.5rem;padding:0.4rem 0.1rem;
        font-size:1rem;border-bottom:1px solid #2c2a28;}
      #pa-layouts .item .nm,#pa-zones .item .nm{flex:1;overflow:hidden;text-overflow:ellipsis;}
      #pa-layouts .item .active,#pa-zones .item .here{color:#e7da00;}
      #pa-zones .item small{color:#818586;font-size:0.78rem;}
      #pa-layouts button,#pa-zones button{cursor:pointer;background:#262422;border:2px solid #0a0908;color:#f1efec;
        border-radius:0.3rem;font:0.85rem 'FS Pixel Sans',monospace;padding:0.32rem 0.6rem;
        box-shadow:inset 0 2px 0 #4a4744,inset 0 -3px 0 #050505;}
      #pa-layouts .foot{margin-top:0.8rem;display:flex;flex-direction:column;gap:0.5rem;}
      #pa-layouts .foot button{padding:0.55rem;}
      #pa-zones .foot{margin-top:0.8rem;border-top:1px solid #2c2a28;padding-top:0.7rem;display:flex;flex-direction:column;gap:0.5rem;}
      #pa-zones .foot input{background:#262422;border:2px solid #0a0908;color:#f1efec;border-radius:0.3rem;
        padding:0.45rem 0.5rem;font:0.95rem 'FS Pixel Sans',monospace;box-shadow:inset 0 2px 0 #4a4744;}
      #pa-zones .foot .sz{display:flex;gap:0.4rem;}
      #pa-zones .foot .sz input{width:50%;}
      #pa-zones .foot button.new{background:#c51a1b;border-color:#0a0908;box-shadow:inset 0 2px 0 #e2585a,inset 0 -3px 0 #5c0f10;padding:0.55rem;font-size:1rem;}
      /* Help / controls reference. */
      #pa-help-body .row{display:grid;grid-template-columns:9.5rem 1fr;gap:0.6rem;padding:0.32rem 0.1rem;
        font-size:0.95rem;border-bottom:1px solid #2c2a28;}
      #pa-help-body kbd{color:#4998c0;font-family:inherit;}
      #pa-help-body .row span{color:#d7d9da;}
    `;
  document.head.appendChild(style);
}
