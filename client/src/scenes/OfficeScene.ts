import Phaser from 'phaser';
import { getStateCallbacks, type Room } from 'colyseus.js';

import { OfficeState } from '@pixel/shared/office/engine/index.js';
import {
  CHARACTER_HIT_HALF_WIDTH,
  CHARACTER_HIT_HEIGHT,
  CHARACTER_SITTING_OFFSET_PX,
  FUEL_COLOR_CRITICAL,
  FUEL_COLOR_DANGER,
  FUEL_COLOR_OK,
  FUEL_COLOR_WARN,
  MATRIX_SPRITE_COLS,
  MAX_CONTEXT_TOKENS,
  TOKEN_CRITICAL_THRESHOLD,
  TOKEN_DANGER_THRESHOLD,
  TOKEN_WARN_THRESHOLD,
  TOOL_OVERLAY_VERTICAL_OFFSET,
} from '@pixel/shared/office/constants.js';
import {
  CharacterState,
  TILE_SIZE,
  type Character,
  type FurnitureInstance,
  type OfficeLayout,
  type Pet,
} from '@pixel/shared/office/types.js';
import { layoutToFurnitureInstances } from '@pixel/shared/office/layout/layoutSerializer.js';
import { PhaserRenderer, type RenderSource } from '../render/PhaserRenderer.js';
import { LayoutEditor } from '../editor/LayoutEditor.js';
import { createAssetBridge } from '../net/bridge.js';
import { connect, isAuthError, redirectToLogin } from '../net/room.js';
import { playDoneSound, playPermissionSound, setAlertVolume, setSoundEnabled, unlockAudio } from '../sound.js';

/** A render-only character/pet: only the fields the renderer + tooltip read,
 *  plus interpolation targets (tx,ty). Cast to the engine types for the view. */
type RenderChar = Partial<Character> & { id: number; tx: number; ty: number; activity: string };
type RenderPet = Partial<Pet> & { id: number; tx: number; ty: number };

/** Deterministic per-column rain stagger seeds (0..1) for the Matrix effect,
 *  derived from the agent id so all viewers render an identical sweep. */
function matrixSeeds(id: number): number[] {
  const seeds: number[] = [];
  let s = (id * 2654435761) >>> 0; // Knuth multiplicative hash
  for (let i = 0; i < MATRIX_SPRITE_COLS; i++) {
    s = (s * 1664525 + 1013904223) >>> 0; // LCG step
    seeds.push(s / 0xffffffff);
  }
  return seeds;
}

export class OfficeScene extends Phaser.Scene {
  private os!: OfficeState;
  private view!: PhaserRenderer;
  private room?: Room;
  private readonly characters = new Map<number, RenderChar>();
  private readonly pets = new Map<number, RenderPet>();
  private furnitureArr: FurnitureInstance[] = [];
  private furnitureDirty = false;
  private hoveredId: number | null = null;
  private selectedId: number | null = null;
  private tip!: HTMLDivElement;
  private editor!: LayoutEditor;
  private layoutsPanel!: HTMLDivElement;
  // Settings + viewer identity (sounds play only for the viewer's own agents;
  // an empty name means "all agents are mine"). A name set in Settings overrides
  // the login identity and is remembered per browser.
  private viewerUsername = '';
  private nameOverridden = false;
  private alwaysShowLabels = false;
  private soundOn = true;
  private volume = 1;
  private settingsPanel!: HTMLDivElement;
  /** Previous (active,bubble) per agent — to detect transitions for sounds. */
  private readonly prevState = new Map<number, { active: boolean; bubble: string }>();
  private readonly nameLabels = new Map<number, HTMLDivElement>();
  private layoutListData: { layouts: Array<{ name: string; readOnly: boolean }>; active: string } = {
    layouts: [],
    active: 'Default',
  };

  constructor() {
    super('office');
  }

  create(): void {
    const g = this.make.graphics({ x: 0, y: 0 });
    g.fillStyle(0xffffff, 1).fillRect(0, 0, 1, 1);
    g.generateTexture('__WHITE', 1, 1);
    g.destroy();

    this.cameras.main.setBackgroundColor('#14161c');
    this.os = new OfficeState();
    this.view = new PhaserRenderer(this, this.renderSource());
    this.editor = new LayoutEditor(this, {
      getLayout: () => this.os.getLayout(),
      onChange: () => (this.furnitureDirty = true),
      rebuildStatic: () => this.view.buildStatic(),
      save: (layout) => this.saveEditedLayout(layout),
    });
    // A name chosen in Settings (remembered per browser) wins over the login id.
    try {
      const saved = localStorage.getItem('pa-viewer-name');
      if (saved) {
        this.viewerUsername = saved;
        this.nameOverridden = true;
      }
    } catch {
      /* localStorage unavailable */
    }
    // Browsers only allow audio after a user gesture; the in-canvas pointerdown
    // misses clicks on the DOM panels, so unlock on the first gesture anywhere.
    const unlock = (): void => unlockAudio();
    window.addEventListener('pointerdown', unlock, { once: true });
    window.addEventListener('keydown', unlock, { once: true });

    this.createTooltip();
    this.createLayoutsPanel();
    this.createSettingsPanel();
    this.setupInput();
    void this.open();
  }

  /** Renderer reads layout/tiles from the (layout-only) OfficeState and the
   *  live entities from our synced maps. */
  private renderSource(): RenderSource {
    const scene = this;
    return {
      getLayout: () => (scene.editor?.isEditing() && scene.editor.layout ? scene.editor.layout : scene.os.getLayout()),
      get tileMap() {
        return scene.editor?.isEditing() ? scene.editor.tileMap : scene.os.tileMap;
      },
      get furniture() {
        return scene.editor?.isEditing() ? scene.editor.furnitureArr : scene.furnitureArr;
      },
      getCharacters: () => [...scene.characters.values()] as unknown as Character[],
      getPets: () => [...scene.pets.values()] as unknown as Pet[],
    };
  }

  private async open(): Promise<void> {
    const assetBridge = createAssetBridge(this.os, (layout) => this.onLayout(layout));
    try {
      this.room = await connect();
      this.room.onMessage('m', (m: Record<string, unknown>) => {
        if (m.type === 'layoutList') this.updateLayoutsPanel(m);
        else if (m.type === 'viewerIdentity') {
          if (!this.nameOverridden) this.viewerUsername = (m.username as string) ?? '';
          this.syncSettingsInputs();
        }
        else if (m.type === 'settingsLoaded') this.applySettings(m);
        else assetBridge(m);
      });
      this.bindState(this.room);
      setStatus('connected');
    } catch (err) {
      // No / expired session → bounce to the server's login page (the auth gate
      // serves the form there). Other failures just surface as a status message.
      if (isAuthError(err)) {
        setStatus('session expired — redirecting to login…');
        redirectToLogin();
        return;
      }
      setStatus(`connection failed: ${(err as Error).message}`);
      console.error(err);
    }
  }

  // ── Colyseus schema → local render maps ──────────────────────────

  private bindState(room: Room): void {
    const $ = getStateCallbacks(room);
    const state = room.state as {
      characters: Map<string, Record<string, unknown>>;
      pets: Map<string, Record<string, unknown>>;
      furniture: unknown[];
    };

    $(state).characters.onAdd((cs: Record<string, unknown>, key: string) => {
      const id = Number(key);
      const rc: RenderChar = { id, tx: cs.x as number, ty: cs.y as number, activity: '' };
      this.applyChar(rc, cs);
      rc.x = rc.tx;
      rc.y = rc.ty;
      this.characters.set(id, rc);
      this.prevState.set(id, { active: !!cs.isActive, bubble: (cs.bubble as string) ?? '' });
      $(cs).onChange(() => {
        this.applyChar(rc, cs);
        this.checkSounds(id, cs);
      });
    });
    $(state).characters.onRemove((_cs: unknown, key: string) => {
      const id = Number(key);
      this.characters.delete(id);
      this.prevState.delete(id);
      this.nameLabels.get(id)?.remove();
      this.nameLabels.delete(id);
    });

    $(state).pets.onAdd((ps: Record<string, unknown>, key: string) => {
      const rp: RenderPet = { id: Number(key), tx: ps.x as number, ty: ps.y as number };
      this.applyPet(rp, ps);
      rp.x = rp.tx;
      rp.y = rp.ty;
      this.pets.set(rp.id, rp);
      $(ps).onChange(() => this.applyPet(rp, ps));
    });
    $(state).pets.onRemove((_ps: unknown, key: string) => this.pets.delete(Number(key)));

    const markFurniture = () => (this.furnitureDirty = true);
    $(state).furniture.onAdd(markFurniture);
    $(state).furniture.onChange(markFurniture);
    $(state).furniture.onRemove(markFurniture);
  }

  private applyChar(rc: RenderChar, cs: Record<string, unknown>): void {
    rc.tx = cs.x as number;
    rc.ty = cs.y as number;
    rc.dir = cs.dir as Character['dir'];
    rc.state = cs.state as Character['state'];
    rc.pose = cs.pose as Character['pose'];
    rc.frame = cs.frame as number;
    rc.palette = cs.palette as number;
    rc.hueShift = cs.hueShift as number;
    rc.isActive = cs.isActive as boolean;
    rc.currentTool = (cs.reading as boolean) ? 'Read' : null;
    rc.bubbleType = ((cs.bubble as string) || null) as Character['bubbleType'];
    rc.bubbleTimer = cs.bubbleTimer as number;
    // Matrix spawn/despawn: the server starts/ends it; the client runs the timer
    // locally (smooth 60fps) and derives the per-column stagger from the agent id
    // so all viewers see an identical sweep. Only (re)seed when it starts.
    const me = ((cs.matrixEffect as string) || null) as Character['matrixEffect'];
    if (me && !rc.matrixEffect) {
      rc.matrixEffectTimer = (cs.matrixEffectTimer as number) || 0;
      rc.matrixEffectSeeds = matrixSeeds(rc.id);
    } else if (!me) {
      rc.matrixEffectTimer = 0;
      rc.matrixEffectSeeds = undefined;
    }
    rc.matrixEffect = me;
    rc.isSubagent = cs.isSubagent as boolean;
    rc.folderName = cs.folderName as string;
    rc.teamName = cs.teamName as string;
    rc.agentName = cs.agentName as string;
    rc.isTeamLead = cs.isTeamLead as boolean;
    rc.inputTokens = cs.inputTokens as number;
    rc.outputTokens = cs.outputTokens as number;
    rc.activity = (cs.activity as string) ?? '';
  }

  private applyPet(rp: RenderPet, ps: Record<string, unknown>): void {
    rp.tx = ps.x as number;
    rp.ty = ps.y as number;
    rp.kind = (ps.kind as number) === 1 ? ('cat' as never) : ('dog' as never);
    rp.variant = ps.variant as number;
    rp.dir = ps.dir as Pet['dir'];
    rp.state = ps.state as Pet['state'];
    rp.frame = ps.frame as number;
    rp.effect = ((ps.effect as string) || null) as never;
    rp.effectTimer = ps.effectTimer as number;
  }

  private rebuildFurniture(): void {
    const arr = (this.room!.state as { furniture: Array<{ type: string; col: number; row: number }> })
      .furniture;
    const placements = arr.map((f, i) => ({ uid: `f${i}`, type: f.type, col: f.col, row: f.row }));
    this.furnitureArr = layoutToFurnitureInstances(placements);
  }

  private onLayout(layout: OfficeLayout): void {
    this.view.buildStatic();
    this.fitCamera(layout.cols * TILE_SIZE, layout.rows * TILE_SIZE);
  }

  private fitCamera(w: number, h: number): void {
    const cam = this.cameras.main;
    cam.setBounds(-256, -256, w + 512, h + 512);
    const z = Math.min(this.scale.width / w, this.scale.height / h) * 0.95;
    cam.setZoom(z > 0 ? z : 2);
    cam.centerOn(w / 2, h / 2);
  }

  // ── Input: pan / zoom / hover / select ───────────────────────────

  private setupInput(): void {
    const cam = this.cameras.main;
    this.input.mouse?.disableContextMenu();
    this.input.on('wheel', (_p: unknown, _o: unknown, _dx: number, dy: number) => {
      cam.setZoom(Phaser.Math.Clamp(cam.zoom * (dy > 0 ? 0.9 : 1.1), 1, 14));
    });
    let dragging = false;
    let moved = false;
    let lx = 0;
    let ly = 0;
    this.input.on('pointerdown', (p: Phaser.Input.Pointer) => {
      unlockAudio(); // browsers require a gesture before audio can play
      dragging = true;
      moved = false;
      lx = p.x;
      ly = p.y;
      if (this.editor.isEditing() && p.rightButtonDown()) {
        this.editor.handleRightClick(p.worldX, p.worldY);
      }
    });
    this.input.on('pointerup', (p: Phaser.Input.Pointer) => {
      dragging = false;
      if (moved) return;
      if (this.editor.isEditing()) {
        if (p.leftButtonReleased()) {
          this.editor.handleLeftClick(p.worldX, p.worldY);
        }
      } else {
        const hit = this.hitTest(p.worldX, p.worldY);
        this.selectedId = hit !== null && hit === this.selectedId ? null : hit;
      }
    });
    this.input.on('pointermove', (p: Phaser.Input.Pointer) => {
      if (this.editor.isEditing()) {
        this.editor.updateGhost(p.worldX, p.worldY);
        this.hoveredId = null;
        this.input.manager.canvas.style.cursor = 'crosshair';
      } else {
        this.hoveredId = this.hitTest(p.worldX, p.worldY);
        this.input.manager.canvas.style.cursor = this.hoveredId !== null ? 'pointer' : 'default';
      }
      if (dragging) {
        if (Math.abs(p.x - lx) + Math.abs(p.y - ly) > 2) moved = true;
        cam.scrollX -= (p.x - lx) / cam.zoom;
        cam.scrollY -= (p.y - ly) / cam.zoom;
        lx = p.x;
        ly = p.y;
      }
    });
  }

  private saveEditedLayout(layout: OfficeLayout): void {
    if (this.layoutListData.active === 'Default') {
      const name = prompt('Default is read-only — save your edits as a new layout named:');
      if (!name) return;
      this.room?.send('saveLayoutAs', { name, layout });
    } else {
      this.room?.send('saveLayout', { layout });
    }
    this.editor.toggle(); // leave edit mode; the server broadcast becomes the source of truth
  }

  /** Hit-test characters (topmost / front-most wins). */
  private hitTest(wx: number, wy: number): number | null {
    let best: number | null = null;
    let bestY = -Infinity;
    for (const ch of this.characters.values()) {
      const sit = ch.state === CharacterState.TYPE ? CHARACTER_SITTING_OFFSET_PX : 0;
      const cx = ch.x ?? ch.tx;
      const cy = (ch.y ?? ch.ty) + sit;
      if (
        wx >= cx - CHARACTER_HIT_HALF_WIDTH &&
        wx <= cx + CHARACTER_HIT_HALF_WIDTH &&
        wy >= cy - CHARACTER_HIT_HEIGHT &&
        wy <= cy &&
        cy > bestY
      ) {
        best = ch.id;
        bestY = cy;
      }
    }
    return best;
  }

  update(_time: number, delta: number): void {
    if (!this.room) return;
    // While editing, furniture comes from the editor's local working copy; the
    // server-synced furniture is rebuilt again once editing ends.
    if (this.furnitureDirty && !this.editor.isEditing()) {
      this.rebuildFurniture();
      this.furnitureDirty = false;
    }
    // Smooth interpolation toward the latest authoritative positions.
    const k = 1 - Math.exp(-18 * Math.min(delta / 1000, 0.1));
    const dt = delta / 1000;
    for (const ch of this.characters.values()) {
      ch.x = (ch.x ?? ch.tx) + (ch.tx - (ch.x ?? ch.tx)) * k;
      ch.y = (ch.y ?? ch.ty) + (ch.ty - (ch.y ?? ch.ty)) * k;
      // Advance the Matrix effect locally for a smooth 60fps sweep; the server
      // only syncs ~20Hz and starts/ends the effect.
      if (ch.matrixEffect) ch.matrixEffectTimer = (ch.matrixEffectTimer ?? 0) + dt;
    }
    for (const p of this.pets.values()) {
      p.x = (p.x ?? p.tx) + (p.tx - (p.x ?? p.tx)) * k;
      p.y = (p.y ?? p.ty) + (p.ty - (p.y ?? p.ty)) * k;
    }
    this.view.update();
    this.editor.tickUI();
    this.updateTooltip();
    this.updateNameLabels();
  }

  // ── Layouts panel (DOM overlay) ──────────────────────────────────

  private createLayoutsPanel(): void {
    const style = document.createElement('style');
    style.textContent = `
      .pa-ui{font-family:'FS Pixel Sans',ui-monospace,monospace;}
      #pa-layouts-btn,#pa-edit-btn{position:fixed;top:8px;z-index:60;cursor:pointer;
        background:#1b1f2a;border:2px solid #3a4150;border-radius:6px;color:#eef1f6;
        font:19px 'FS Pixel Sans',monospace;padding:8px 14px;}
      #pa-layouts-btn{right:8px;}
      #pa-edit-btn{right:150px;}
      #pa-layouts{position:fixed;top:52px;right:8px;z-index:60;display:none;width:330px;
        background:#1b1f2a;border:2px solid #3a4150;border-radius:8px;color:#eef1f6;
        padding:12px;box-shadow:0 4px 0 rgba(0,0,0,.4);}
      #pa-layouts h4{margin:0 0 10px;font-size:20px;color:#cdd3dd;}
      #pa-layouts .item{display:flex;align-items:center;gap:8px;padding:5px 0;font-size:18px;}
      #pa-layouts .item .nm{flex:1;overflow:hidden;text-overflow:ellipsis;}
      #pa-layouts .item .active{color:#ffd24a;}
      #pa-layouts button{cursor:pointer;background:#2a2f3a;border:1px solid #3a4150;color:#eef1f6;
        border-radius:4px;font:16px 'FS Pixel Sans',monospace;padding:5px 10px;}
      #pa-layouts .foot{margin-top:12px;display:flex;flex-direction:column;gap:8px;}
      #pa-layouts .foot button{padding:9px;}
    `;
    document.head.appendChild(style);

    const btn = document.createElement('button');
    btn.id = 'pa-layouts-btn';
    btn.className = 'pa-ui';
    btn.textContent = '⚙ Layouts';
    const panel = document.createElement('div');
    panel.id = 'pa-layouts';
    panel.className = 'pa-ui';
    btn.onclick = () => {
      const open = panel.style.display !== 'block';
      panel.style.display = open ? 'block' : 'none';
      if (open) this.room?.send('requestLayouts');
    };
    const editBtn = document.createElement('button');
    editBtn.id = 'pa-edit-btn';
    editBtn.className = 'pa-ui';
    editBtn.textContent = '✏ Edit';
    editBtn.onclick = () => this.editor.toggle();

    const host = document.getElementById('game') ?? document.body;
    host.appendChild(btn);
    host.appendChild(editBtn);
    host.appendChild(panel);
    this.layoutsPanel = panel;
    this.renderLayoutsPanel();
  }

  private updateLayoutsPanel(msg: Record<string, unknown>): void {
    this.layoutListData = {
      layouts: (msg.layouts as Array<{ name: string; readOnly: boolean }>) ?? [],
      active: (msg.active as string) ?? 'Default',
    };
    this.renderLayoutsPanel();
  }

  private renderLayoutsPanel(): void {
    if (!this.layoutsPanel) return;
    const { layouts, active } = this.layoutListData;
    const send = (type: string, payload?: Record<string, unknown>) => this.room?.send(type, payload);

    const rows = layouts
      .map((l) => {
        const isActive = l.name === active;
        const buttons =
          (isActive ? '<span class="active">● active</span>' : `<button data-load="${esc(l.name)}">Load</button>`) +
          (l.readOnly ? '' : ` <button data-del="${esc(l.name)}">✕</button>`);
        return `<div class="item"><span class="nm ${isActive ? 'active' : ''}">${esc(l.name)}</span>${buttons}</div>`;
      })
      .join('');

    this.layoutsPanel.innerHTML =
      `<h4>Office Layouts</h4>${rows}` +
      `<div class="foot">
         <button data-new>New from current…</button>
         <button data-default>Reset to Default</button>
       </div>`;

    this.layoutsPanel.querySelectorAll<HTMLButtonElement>('[data-load]').forEach((b) => {
      b.onclick = () => send('loadLayout', { name: b.dataset.load });
    });
    this.layoutsPanel.querySelectorAll<HTMLButtonElement>('[data-del]').forEach((b) => {
      b.onclick = () => {
        if (confirm(`Delete layout "${b.dataset.del}"?`)) send('deleteLayout', { name: b.dataset.del });
      };
    });
    this.layoutsPanel.querySelector<HTMLButtonElement>('[data-new]')!.onclick = () => {
      const name = prompt('New layout name (saved from the current office):');
      if (name) send('saveLayoutAs', { name, layout: this.os.getLayout() });
    };
    this.layoutsPanel.querySelector<HTMLButtonElement>('[data-default]')!.onclick = () =>
      send('loadLayout', { name: 'Default' });
  }

  // ── Sounds + settings ────────────────────────────────────────────

  /** Play chimes on agent transitions — only for the viewer's own agents. */
  private checkSounds(id: number, cs: Record<string, unknown>): void {
    const p = this.prevState.get(id) ?? { active: false, bubble: '' };
    const folderName = (cs.folderName as string) ?? '';
    const mine = !this.viewerUsername || folderName === this.viewerUsername;
    const active = !!cs.isActive;
    const bubble = (cs.bubble as string) ?? '';
    if (mine && p.active && !active) void playDoneSound(); // turn finished
    if (mine && p.bubble !== 'permission' && bubble === 'permission') void playPermissionSound();
    this.prevState.set(id, { active, bubble });
  }

  private applySettings(m: Record<string, unknown>): void {
    this.soundOn = m.soundEnabled !== false;
    this.volume = typeof m.alertVolume === 'number' ? (m.alertVolume as number) : 1;
    this.alwaysShowLabels = !!m.alwaysShowLabels;
    setSoundEnabled(this.soundOn);
    setAlertVolume(this.volume);
    this.syncSettingsInputs();
    if (!this.alwaysShowLabels) this.clearNameLabels();
  }

  private createSettingsPanel(): void {
    const style = document.createElement('style');
    style.textContent = `
      #pa-settings-btn{position:fixed;top:8px;right:290px;z-index:60;cursor:pointer;
        background:#1b1f2a;border:2px solid #3a4150;border-radius:6px;color:#eef1f6;
        font:19px 'FS Pixel Sans',monospace;padding:8px 14px;}
      #pa-settings{position:fixed;top:52px;right:8px;z-index:60;display:none;width:280px;
        background:#1b1f2a;border:2px solid #3a4150;border-radius:8px;color:#eef1f6;padding:14px;
        font-family:'FS Pixel Sans',monospace;box-shadow:0 4px 0 rgba(0,0,0,.4);}
      #pa-settings h4{margin:0 0 12px;font-size:20px;color:#cdd3dd;}
      #pa-settings .row{display:flex;align-items:center;gap:8px;margin:10px 0;font-size:16px;}
      #pa-settings .row input[type=range]{flex:1;}
      #pa-settings .row label{flex:1;}
      #pa-settings .row input[type=text]{flex:1;min-width:0;background:#14161c;color:#eef1f6;
        border:2px solid #3a4150;border-radius:5px;padding:5px 7px;font:15px 'FS Pixel Sans',monospace;}
      #pa-settings .hint{font-size:13px;color:#8b93a3;margin:-4px 0 10px;}
    `;
    document.head.appendChild(style);

    const btn = document.createElement('button');
    btn.id = 'pa-settings-btn';
    btn.className = 'pa-ui';
    btn.textContent = '🔊 Settings';
    const panel = document.createElement('div');
    panel.id = 'pa-settings';
    panel.innerHTML = `<h4>Settings</h4>
      <div class="row"><label for="pa-name">Your name</label><input id="pa-name" type="text" maxlength="16" placeholder="(all agents)"></div>
      <div class="hint">Matches your agent's <code>--user</code>; sounds play for your agents. Empty = all.</div>
      <div class="row"><input id="pa-snd" type="checkbox"><label for="pa-snd">Sound notifications</label></div>
      <div class="row"><label for="pa-vol">Volume</label><input id="pa-vol" type="range" min="0" max="100"></div>
      <div class="row"><input id="pa-lbl" type="checkbox"><label for="pa-lbl">Always show labels</label></div>`;
    btn.onclick = () => {
      panel.style.display = panel.style.display === 'block' ? 'none' : 'block';
    };
    const host = document.getElementById('game') ?? document.body;
    host.appendChild(btn);
    host.appendChild(panel);
    this.settingsPanel = panel;

    const name = panel.querySelector<HTMLInputElement>('#pa-name')!;
    const snd = panel.querySelector<HTMLInputElement>('#pa-snd')!;
    const vol = panel.querySelector<HTMLInputElement>('#pa-vol')!;
    const lbl = panel.querySelector<HTMLInputElement>('#pa-lbl')!;
    name.onchange = () => {
      const v = name.value.trim().slice(0, 16);
      this.viewerUsername = v;
      this.nameOverridden = true;
      try {
        if (v) localStorage.setItem('pa-viewer-name', v);
        else localStorage.removeItem('pa-viewer-name');
      } catch {
        /* localStorage unavailable */
      }
      unlockAudio();
      this.clearNameLabels(); // labels re-render with the new name on next tick
    };
    snd.onchange = () => {
      this.soundOn = snd.checked;
      setSoundEnabled(this.soundOn);
      unlockAudio();
      this.room?.send('setSoundEnabled', { enabled: this.soundOn });
    };
    vol.oninput = () => {
      this.volume = Number(vol.value) / 100;
      setAlertVolume(this.volume);
    };
    vol.onchange = () => this.room?.send('setAlertVolume', { volume: this.volume });
    lbl.onchange = () => {
      this.alwaysShowLabels = lbl.checked;
      if (!this.alwaysShowLabels) this.clearNameLabels();
      this.room?.send('setAlwaysShowLabels', { enabled: this.alwaysShowLabels });
    };
    this.syncSettingsInputs();
  }

  private syncSettingsInputs(): void {
    if (!this.settingsPanel) return;
    const nameEl = this.settingsPanel.querySelector<HTMLInputElement>('#pa-name');
    // Don't clobber the field while the user is editing it.
    if (nameEl && document.activeElement !== nameEl) nameEl.value = this.viewerUsername;
    this.settingsPanel.querySelector<HTMLInputElement>('#pa-snd')!.checked = this.soundOn;
    this.settingsPanel.querySelector<HTMLInputElement>('#pa-vol')!.value = String(Math.round(this.volume * 100));
    this.settingsPanel.querySelector<HTMLInputElement>('#pa-lbl')!.checked = this.alwaysShowLabels;
  }

  // ── Always-on name labels ────────────────────────────────────────

  private clearNameLabels(): void {
    for (const el of this.nameLabels.values()) el.remove();
    this.nameLabels.clear();
  }

  private updateNameLabels(): void {
    if (!this.alwaysShowLabels) return;
    const cam = this.cameras.main;
    const wv = cam.worldView;
    const host = document.getElementById('game') ?? document.body;
    const live = new Set<number>();
    for (const ch of this.characters.values()) {
      const name = ch.agentName || ch.folderName;
      if (!name) continue;
      live.add(ch.id);
      let el = this.nameLabels.get(ch.id);
      if (!el) {
        el = document.createElement('div');
        el.style.cssText =
          "position:absolute;z-index:45;transform:translate(-50%,-100%);pointer-events:none;" +
          "font:12px 'FS Pixel Sans',monospace;color:#e6e9ef;text-shadow:0 0 3px #000,0 0 3px #000;white-space:nowrap;";
        host.appendChild(el);
        this.nameLabels.set(ch.id, el);
      }
      el.textContent = name;
      const sit = ch.state === CharacterState.TYPE ? CHARACTER_SITTING_OFFSET_PX : 0;
      el.style.left = `${Math.round(((ch.x ?? ch.tx) - wv.x) * cam.zoom)}px`;
      el.style.top = `${Math.round(((ch.y ?? ch.ty) + sit - 20 - wv.y) * cam.zoom)}px`;
    }
    for (const [id, el] of this.nameLabels) {
      if (!live.has(id)) {
        el.remove();
        this.nameLabels.delete(id);
      }
    }
  }

  // ── Hover / selection tooltip (DOM overlay, fixed readable size) ──

  private createTooltip(): void {
    if (!document.getElementById('pa-tip-style')) {
      const style = document.createElement('style');
      style.id = 'pa-tip-style';
      style.textContent = `
        .pa-tip{position:absolute;z-index:50;transform:translate(-50%,-100%);
          pointer-events:none;display:none;flex-direction:column;align-items:center;
          font-family:'FS Pixel Sans',ui-monospace,monospace;}
        .pa-tip .row{display:flex;align-items:center;gap:7px;
          background:#1b1f2a;border:2px solid #3a4150;border-radius:5px;
          padding:6px 11px;white-space:nowrap;box-shadow:0 2px 0 rgba(0,0,0,.4);}
        .pa-tip .dot{width:10px;height:10px;border-radius:50%;flex:0 0 auto;}
        .pa-tip .act{color:#eef1f6;font-size:19px;line-height:1.15;}
        .pa-tip .name{color:#9aa4b2;font-size:14px;line-height:1.15;}
        .pa-tip .fuel{width:52px;height:5px;background:#222;margin-top:3px;}
        .pa-tip .fuel > div{height:100%;}
      `;
      document.head.appendChild(style);
    }
    this.tip = document.createElement('div');
    this.tip.className = 'pa-tip';
    (document.getElementById('game') ?? document.body).appendChild(this.tip);
  }

  private updateTooltip(): void {
    if (this.editor.isEditing()) {
      this.tip.style.display = 'none';
      return;
    }
    const id = this.hoveredId ?? this.selectedId;
    const ch = id !== null ? this.characters.get(id) : undefined;
    if (!ch || id === null) {
      this.tip.style.display = 'none';
      return;
    }
    const cam = this.cameras.main;
    const wv = cam.worldView;
    const sit = ch.state === CharacterState.TYPE ? CHARACTER_SITTING_OFFSET_PX : 0;
    const sx = ((ch.x ?? ch.tx) - wv.x) * cam.zoom;
    const sy = ((ch.y ?? ch.ty) + sit - TOOL_OVERLAY_VERTICAL_OFFSET - wv.y) * cam.zoom;
    this.tip.style.left = `${Math.round(sx)}px`;
    this.tip.style.top = `${Math.round(sy)}px`;

    const act = ch.bubbleType === 'permission' ? 'Needs approval' : ch.activity || (ch.isActive ? 'Working…' : ch.isSubagent ? 'Subtask' : 'Idle');
    const name = ch.agentName || ch.folderName || `agent ${id}`;
    const dot = ch.bubbleType === 'permission' ? '#ffcc00' : ch.isActive ? '#44cc44' : '';
    const total = (ch.inputTokens ?? 0) + (ch.outputTokens ?? 0);
    const ratio = total / MAX_CONTEXT_TOKENS;

    this.tip.innerHTML =
      `<div class="row">${dot ? `<span class="dot" style="background:${dot}"></span>` : ''}` +
      `<div><div class="act">${esc(act)}</div><div class="name">${esc(name)}</div></div></div>` +
      (total > 0
        ? `<div class="fuel"><div style="width:${Math.min(ratio * 100, 100)}%;background:${fuelColor(ratio)}"></div></div>`
        : '');
    this.tip.style.display = 'flex';
  }
}

function fuelColor(ratio: number): string {
  if (ratio >= TOKEN_CRITICAL_THRESHOLD) return FUEL_COLOR_CRITICAL;
  if (ratio >= TOKEN_DANGER_THRESHOLD) return FUEL_COLOR_DANGER;
  if (ratio >= TOKEN_WARN_THRESHOLD) return FUEL_COLOR_WARN;
  return FUEL_COLOR_OK;
}

function esc(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
}

function setStatus(text: string): void {
  const el = document.getElementById('status');
  if (el) el.textContent = text;
}
