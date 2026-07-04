/**
 * One "pixel-menu" skin for all voxel UI chrome, mirroring the project design tokens
 * (see AGENTS.md — the OfficeScene.ts stylesheet). The voxel page can't share that
 * stylesheet (separate entry point), so this injects an override sheet that restyles
 * the panels (map/inventory/craft/furnace/chest) built by the individual modules to
 * the same look. Call once, LAST (after the panels' own <style> blocks), so it wins by
 * cascade order. voxel.html's own chrome (settings/hotbar) uses the same tokens inline.
 */
export function injectPixelSkin(): void {
  const s = document.createElement('style');
  // Panels share class names across ids; list them so the override is scoped to chrome.
  const P = '#vx-inv, #vx-craft, #vx-map, #vx-chest';
  s.textContent = `
    /* backdrop */
    ${P} { background: rgba(6,8,14,.62); }
    /* window (panel) */
    ${P} .win {
      background:#0f1220; border:2px solid #05060b; border-radius:.6rem;
      box-shadow: inset 0 2px 0 #232a44, inset 0 -3px 0 #080a14, 0 12px 28px rgba(0,0,0,.55);
    }
    ${P} .hd h3 { color:#eef1fb; text-shadow:none; }
    #vx-inv h4, #vx-chest h4 { color:#9aa0b8; text-shadow:none; }
    ${P} .tip { color:#6f7590; }
    #vx-craft .sect { color:#9aa0b8; border-top:2px solid #05060b; text-shadow:none; }
    /* buttons: close (.x), map re-centre (.btn), craft/smelt (.mk) */
    ${P} .hd .x, #vx-map .hd .btn {
      background:#141826; border:2px solid #05060b; border-radius:.4rem; color:#e9ecf7;
      box-shadow: inset 0 2px 0 #2b3252, inset 0 -3px 0 #090b16;
    }
    ${P} .hd .x:hover, #vx-map .hd .btn:hover { background:#1a2036; }
    #vx-craft .mk {
      background:#2f66b0; border:2px solid #05060b; border-radius:.4rem; color:#fff;
      box-shadow: inset 0 2px 0 #5a92d6, inset 0 -3px 0 #163862;
    }
    #vx-craft .row.off .mk { background:#141826; box-shadow: inset 0 2px 0 #2b3252, inset 0 -3px 0 #090b16; }
    #vx-craft .row { background:#141826; border:2px solid #05060b; }
    /* cells (inventory / chest / craft icons) */
    #vx-inv .cell, #vx-chest .cell { background-color:#171b2b; border:2px solid #05060b; }
    #vx-inv .cell.slot { background-color:#0a0d16; }
    #vx-craft .ic { border:2px solid #05060b; }
    #vx-inv .cell.drop { border-color:#7fd08a; box-shadow:0 0 0 2px #7fd08a inset; }
    #vx-map canvas { border:2px solid #05060b; }
    /* count/label chips stay legible */
    #vx-inv .cell .num, #vx-chest .cell .num, #vx-craft .ic .c { background:rgba(5,6,11,.7); color:#eef1fb; }`;
  document.head.appendChild(s);
}
