/**
 * The conference window shell (WebEx-style), styled like the rest of the pixel
 * menus. Fills the whole browser viewport whenever it's open (there's no
 * "windowed" state to speak of — a call is the thing you're doing, not a panel
 * beside something else) — same surface whether it's opened over the pixel
 * world (a monitor) or on the standalone /meet page: a tiled participant stage,
 * a toggleable side panel (Chat / Participants), and a bottom control bar (mic,
 * cam, screen, chat, participants, devices, fullscreen, leave). The "Fullscreen"
 * button still calls the browser's Fullscreen API on top of that, to additionally
 * hide the tab/address bar.
 *
 * Two stage layouts, both owned here:
 *  - **Grid** (default): every tile — cameras *and* shared screens — is laid out
 *    in a page-filling grid. The row/column split is picked in JS (`layoutGrid`)
 *    because CSS auto-fit can only fill rows left-to-right, which strands a
 *    handful of participants in one thin line across a wide window.
 *  - **Focus**: one tile fills the stage with the rest as a filmstrip below it.
 *    Any tile can be focused by clicking it (a new screen share focuses itself);
 *    "▦ Grid", Esc, or a double-click goes back.
 *
 * Media + the in-meeting chat transport live in LiveKitConference; this class is
 * pure UI, driven by handlers + update calls from OfficeScene. Tiles are created
 * by LiveKitConference into `stage`; this class only moves and sizes them, and
 * watches for tiles coming and going with a MutationObserver.
 */
import type {
  ConferenceState,
  ConferenceDevices,
  ConferenceParticipant,
  ConferenceChatMsg,
} from './LiveKitConference.js';

export interface ConferenceUIHandlers {
  toggleMic: () => void;
  toggleCam: () => void;
  toggleScreen: () => void;
  switchCamera: (id: string) => void;
  switchMic: (id: string) => void;
  switchSpeaker: (id: string) => void;
  setVolume: (identity: string, v: number) => void; // 0..1
  setMuted: (identity: string, muted: boolean) => void; // for me only
  muteForAll: (identity: string) => void; // asks them to switch their mic off
  sendChat: (text: string) => void;
  leave: () => void;
}

/** One People-panel row's live elements (reused across re-renders so an active
 *  slider drag isn't destroyed). Volume controls exist for remote rows only. */
interface PartRow {
  row: HTMLElement;
  nm: HTMLElement;
  icons: HTMLElement;
  mute?: HTMLButtonElement;
  muteAll?: HTMLButtonElement;
  vol?: HTMLInputElement;
  pct?: HTMLElement;
}

// Shared pixel-menu look (matches #pa-menubar / .pa-btn / .pa-panel in OfficeScene):
// dark #1c1a19 surfaces, #0a0908 borders, the inset 2px-light / 3px-dark bevel,
// red #c51a1b accents (primary and "on" states alike). Keep in sync with OfficeScene's CSS.
const CSS = `
  #pa-conf{position:fixed;inset:0;z-index:120;display:none;
    width:100%;height:100%;flex-direction:column;background:#1c1a19;
    color:#f1efec;font-family:'FS Pixel Sans',ui-monospace,monospace;overflow:hidden;}
  #pa-conf .pa-conf-head{display:flex;align-items:center;gap:0.6rem;padding:0.6rem 0.85rem;background:#1c1a19;
    border-bottom:2px solid #0a0908;box-shadow:inset 0 -1px 0 #2c2a28;}
  #pa-conf .pa-conf-head .title{font-size:1.2rem;color:#f5f3f0;font-weight:600;letter-spacing:.3px;}
  #pa-conf .pa-conf-head .sub{color:#818586;font-size:0.85rem;}
  #pa-conf .pa-conf-head .status{margin-left:auto;font-size:0.85rem;color:#7fbf6a;}
  #pa-conf .pa-conf-head .status.err{color:#f2a1a1;}
  #pa-conf .pa-conf-body{flex:1;display:flex;min-height:0;}
  #pa-conf .pa-conf-main{flex:1;display:flex;flex-direction:column;min-width:0;min-height:0;background:#141312;}
  /* Default: a page-filling grid. Wrapping flex rather than CSS grid so a partial
     last row centres under the rest; --tile-w (written by layoutGrid()) is what
     actually decides the wrap. GRID_GAP / GRID_PAD must match the px used there. */
  #pa-conf-stage{flex:1;display:flex;flex-wrap:wrap;gap:8px;padding:8px;overflow:auto;min-width:0;min-height:0;
    justify-content:center;align-content:safe center;}
  #pa-conf .pa-conf-tile{position:relative;flex:0 0 auto;width:var(--tile-w,13rem);aspect-ratio:16/9;
    box-sizing:border-box;background:#262422;border:2px solid #0a0908;
    border-radius:0.4rem;overflow:hidden;display:flex;align-items:center;justify-content:center;cursor:pointer;
    box-shadow:inset 0 2px 0 #4a4744,inset 0 -3px 0 #050505;}
  #pa-conf .pa-conf-tile.speaking{border-color:#c51a1b;box-shadow:0 0 0 2px #e2585a inset;}
  /* Camera off → a plain black screen (the placeholder avatar sits on top). */
  #pa-conf .pa-conf-tile.camoff{background:#000;box-shadow:none;}
  /* A shared screen is just another tile — never cropped, and flagged in red. */
  #pa-conf .pa-conf-tile.screen{background:#000;border-color:#c51a1b;box-shadow:0 0 0 1px #e2585a;}
  #pa-conf .pa-conf-tile.screen .pa-conf-video{object-fit:contain;}
  /* Focus mode: the focused tile fills the stage, the rest run along the bottom. */
  #pa-conf-focus{display:none;position:relative;flex:1;min-width:0;min-height:0;padding:8px;
    align-items:center;justify-content:center;}
  #pa-conf.focus-mode #pa-conf-focus{display:flex;}
  #pa-conf.focus-mode #pa-conf-stage{flex:0 0 auto;height:8.5rem;flex-wrap:nowrap;
    justify-content:safe center;overflow-x:auto;overflow-y:hidden;}
  #pa-conf.focus-mode #pa-conf-stage .pa-conf-tile{flex:0 0 auto;width:auto;height:100%;}
  #pa-conf.focus-mode.strip-collapsed #pa-conf-stage,
  #pa-conf.focus-mode.strip-empty #pa-conf-stage{display:none;}
  #pa-conf .pa-conf-tile.focused{width:100%;height:100%;aspect-ratio:auto;cursor:default;}
  #pa-conf .pa-conf-tile.focused .pa-conf-video{object-fit:contain;background:#000;}
  .pa-conf-spot-ctl{position:absolute;top:0.55rem;right:0.55rem;z-index:3;display:flex;gap:0.35rem;}
  .pa-conf-spot-ctl button{cursor:pointer;background:#262422;border:2px solid #0a0908;color:#f1efec;
    border-radius:0.35rem;font:0.9rem 'FS Pixel Sans',monospace;padding:0.32rem 0.55rem;
    box-shadow:inset 0 2px 0 #4a4744,inset 0 -3px 0 #050505;}
  .pa-conf-spot-ctl button:hover{background:#2e2b28;}
  #pa-conf .pa-conf-media{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;}
  #pa-conf .pa-conf-video{width:100%;height:100%;object-fit:cover;background:#000;}
  #pa-conf .pa-conf-video.mirror{transform:scaleX(-1);}
  #pa-conf .pa-conf-video.contain{object-fit:contain;}
  #pa-conf .pa-conf-ph{width:3.4rem;height:3.4rem;border-radius:50%;background:#141312;border:2px solid #0a0908;
    display:flex;align-items:center;justify-content:center;font-size:1.2rem;color:#d7d9da;
    box-shadow:inset 0 2px 0 #4a4744,inset 0 -3px 0 #050505;}
  #pa-conf .pa-conf-name{position:absolute;left:0.35rem;bottom:0.3rem;font-size:0.8rem;color:#fff;
    text-shadow:0 0 3px #000,0 0 3px #000;z-index:1;}
  #pa-conf .pa-conf-side{width:17rem;flex:0 0 auto;display:none;flex-direction:column;background:#1c1a19;
    border-left:2px solid #0a0908;min-height:0;}
  #pa-conf.side-open .pa-conf-side{display:flex;}
  #pa-conf .pa-conf-tabs{display:flex;gap:0.35rem;padding:0.35rem;background:#141312;border-bottom:2px solid #0a0908;}
  #pa-conf .pa-conf-tabs button{flex:1;background:transparent;border:0;color:#adb0b2;cursor:pointer;border-radius:0.35rem;
    font:0.95rem 'FS Pixel Sans',monospace;padding:0.45rem 0.3rem;}
  #pa-conf .pa-conf-tabs button.on{color:#fff;background:#37342f;
    box-shadow:inset 0 2px 0 rgba(255,255,255,.14),inset 0 -2px 0 rgba(0,0,0,.35);}
  #pa-conf .pa-conf-chat,#pa-conf .pa-conf-parts{flex:1;min-height:0;display:none;flex-direction:column;}
  #pa-conf.tab-chat .pa-conf-chat{display:flex;}
  #pa-conf.tab-parts .pa-conf-parts{display:flex;}
  #pa-conf .pa-conf-chatlog{flex:1;overflow-y:auto;padding:0.5rem 0.6rem;display:flex;flex-direction:column;
    gap:0.25rem;font-size:0.92rem;line-height:1.35;}
  #pa-conf .pa-conf-chatlog .ln .ts{color:#818586;font-size:0.82em;}
  #pa-conf .pa-conf-chatlog .ln b{color:#4998c0;}
  #pa-conf .pa-conf-chatin{border:0;border-top:2px solid #0a0908;background:#262422;color:#f1efec;
    font:1rem 'FS Pixel Sans',monospace;padding:0.55rem 0.6rem;box-shadow:inset 0 2px 0 #4a4744;}
  #pa-conf .pa-conf-parts{padding:0.4rem 0.2rem;overflow-y:auto;}
  #pa-conf .pa-conf-parts .p{display:flex;align-items:center;flex-wrap:wrap;gap:0.5rem;padding:0.4rem 0.5rem;
    font-size:0.95rem;border-bottom:1px solid #2c2a28;}
  #pa-conf .pa-conf-parts .p .n{flex:1;}
  #pa-conf .pa-conf-parts .p .i{opacity:0.85;}
  #pa-conf .pa-conf-parts .p .vol-row{display:flex;align-items:center;gap:0.4rem;width:100%;}
  #pa-conf .pa-conf-parts .p .vol-row button{cursor:pointer;background:#262422;border:2px solid #0a0908;
    color:#f1efec;border-radius:0.35rem;font:0.85rem 'FS Pixel Sans',monospace;padding:0.2rem 0.4rem;
    box-shadow:inset 0 2px 0 #4a4744,inset 0 -3px 0 #050505;}
  #pa-conf .pa-conf-parts .p .vol-row button:hover{background:#2e2b28;}
  #pa-conf .pa-conf-parts .p .vol-row button.muted{color:#f2a1a1;border-color:#7c2634;}
  #pa-conf .pa-conf-parts .p .vol-row input[type=range]{flex:1;min-width:0;accent-color:#c51a1b;}
  #pa-conf .pa-conf-parts .p .vol-row .pct{font-size:0.8rem;color:#adb0b2;min-width:2.6rem;text-align:right;}
  #pa-conf .pa-conf-parts .p button.mute-all{cursor:pointer;background:#262422;border:2px solid #0a0908;
    color:#f1efec;border-radius:0.35rem;font:0.8rem 'FS Pixel Sans',monospace;padding:0.2rem 0.4rem;
    box-shadow:inset 0 2px 0 #4a4744,inset 0 -3px 0 #050505;}
  #pa-conf .pa-conf-parts .p button.mute-all:hover:not(:disabled){background:#2e2b28;}
  #pa-conf .pa-conf-parts .p button.mute-all:disabled{opacity:0.4;cursor:default;}
  /* Transient notice ("Ada muted you") over the stage. */
  #pa-conf .pa-conf-toast{position:absolute;top:3.4rem;left:50%;transform:translateX(-50%);z-index:6;
    background:#1c1a19;border:2px solid #0a0908;border-radius:0.6rem;padding:0.5rem 0.8rem;color:#f1efec;
    font-size:0.95rem;max-width:80%;text-align:center;transition:opacity .4s;
    box-shadow:inset 0 2px 0 #292725,inset 0 -3px 0 #030303,0 12px 28px rgba(0,0,0,.55);}
  #pa-conf .pa-conf-toast.out{opacity:0;}
  #pa-conf .pa-conf-bar{display:flex;align-items:center;justify-content:center;gap:0.5rem;flex-wrap:wrap;
    padding:0.6rem;background:#1c1a19;border-top:2px solid #0a0908;box-shadow:inset 0 1px 0 #2c2a28;position:relative;}
  #pa-conf .pa-conf-bar button{cursor:pointer;background:#242220;border:2px solid #0a0908;color:#f1efec;
    border-radius:0.45rem;font:0.95rem 'FS Pixel Sans',monospace;padding:0.5rem 0.3rem;
    width:5.5rem;box-sizing:border-box;text-align:center;white-space:nowrap;
    box-shadow:inset 0 2px 0 #4a4744,inset 0 -3px 0 #050505;}
  #pa-conf .pa-conf-bar button:hover{background:#2e2b28;}
  #pa-conf .pa-conf-bar button.off{opacity:0.5;}
  #pa-conf .pa-conf-bar button.on{background:#c51a1b;border-color:#0a0908;color:#fff;
    box-shadow:inset 0 2px 0 #e2585a,inset 0 -3px 0 #5c0f10;}
  #pa-conf .pa-conf-bar button.leave{background:#7c2634;border-color:#0a0908;color:#f1d0d6;
    box-shadow:inset 0 2px 0 #b34a5a,inset 0 -3px 0 #45111a;}
  #pa-conf .pa-conf-dev{position:absolute;bottom:3.6rem;left:50%;transform:translateX(-50%);background:#1c1a19;
    border:2px solid #0a0908;border-radius:0.6rem;padding:0.7rem;display:none;flex-direction:column;gap:0.45rem;
    min-width:16rem;box-shadow:inset 0 2px 0 #292725,inset 0 -3px 0 #030303,0 12px 28px rgba(0,0,0,.55);}
  #pa-conf .pa-conf-dev.open{display:flex;}
  #pa-conf .pa-conf-dev label{font-size:0.72rem;letter-spacing:1px;color:#818586;text-transform:uppercase;}
  #pa-conf .pa-conf-dev select{background:#262422;border:2px solid #0a0908;color:#f1efec;border-radius:0.35rem;
    font:0.9rem 'FS Pixel Sans',monospace;padding:0.4rem;box-shadow:inset 0 2px 0 #4a4744,inset 0 -3px 0 #050505;}
`;

/** Stage gap / padding, in px — must match #pa-conf-stage's CSS. */
const GRID_GAP = 8;
const GRID_PAD = 8;
/** Tiles never shrink below this (the grid scrolls instead). */
const MIN_TILE_W = 120;
/** Ignore a "double-click to unfocus" this soon after the click that focused. */
const DBLCLICK_MS = 700;

export class ConferenceUI {
  private readonly root: HTMLDivElement;
  private readonly mainEl: HTMLDivElement;
  private readonly stageEl: HTMLDivElement;
  private readonly focusEl: HTMLDivElement;
  private readonly titleEl: HTMLSpanElement;
  private readonly subEl: HTMLSpanElement;
  private readonly statusEl: HTMLSpanElement;
  private readonly chatLog: HTMLDivElement;
  private readonly chatInput: HTMLInputElement;
  private readonly partsEl: HTMLDivElement;
  private readonly bar: HTMLDivElement;
  private readonly devPop: HTMLDivElement;
  private handlers: ConferenceUIHandlers | null = null;
  private readonly partRows = new Map<string, PartRow>();
  private devices: ConferenceDevices = { cameras: [], mics: [], speakers: [] };
  private state: ConferenceState = { connected: false, camOn: true, micOn: true, screenOn: false };
  /** The tile currently filling the stage (null → grid layout). */
  private focused: HTMLElement | null = null;
  /** Where the focused tile sat in the stage, so unfocusing puts it back there. */
  private focusHome: Element | null = null;
  /** The visible transient notice, if any (only one at a time). */
  private toast: HTMLElement | null = null;
  /** Event timestamp of the click that focused the current tile. */
  private focusedAt = 0;
  /** Screen-share tiles we've already reacted to (so each one auto-focuses once). */
  private readonly knownScreens = new Set<string>();
  /** Last tile width written, so a re-layout that changes nothing is a no-op. */
  private gridTileW = 0;

  constructor() {
    if (!document.getElementById('pa-conf-style')) {
      const s = document.createElement('style');
      s.id = 'pa-conf-style';
      s.textContent = CSS;
      document.head.appendChild(s);
    }
    const root = document.createElement('div');
    root.id = 'pa-conf';
    root.className = 'pa-ui tab-chat';
    root.innerHTML = `
      <div class="pa-conf-head">
        <span class="title"></span><span class="sub"></span><span class="status"></span>
      </div>
      <div class="pa-conf-body">
        <div class="pa-conf-main">
          <div id="pa-conf-focus">
            <div class="pa-conf-spot-ctl">
              <button data-ungrid title="Back to the grid (Esc)">▦ Grid</button>
              <button data-collapse title="Show / hide participants">👥</button>
              <button data-spotfull title="Fullscreen">⛶</button>
            </div>
          </div>
          <div id="pa-conf-stage"></div>
        </div>
        <div class="pa-conf-side">
          <div class="pa-conf-tabs">
            <button data-tab="chat" class="on">💬 Chat</button>
            <button data-tab="parts">👥 People</button>
          </div>
          <div class="pa-conf-chat">
            <div class="pa-conf-chatlog"></div>
            <input class="pa-conf-chatin" type="text" maxlength="500" placeholder="Message the meeting…" autocomplete="off">
          </div>
          <div class="pa-conf-parts"></div>
        </div>
      </div>
      <div class="pa-conf-bar">
        <button data-mic>🎙 Mic</button>
        <button data-cam>📷 Cam</button>
        <button data-screen>🖥 Share</button>
        <button data-chat>💬 Chat</button>
        <button data-people>👥 People</button>
        <button data-dev title="Devices">⚙</button>
        <button data-full title="Fullscreen">⛶</button>
        <button data-leave class="leave">Leave</button>
        <div class="pa-conf-dev"></div>
      </div>`;
    (document.getElementById('game') ?? document.body).appendChild(root);
    this.root = root;
    this.mainEl = root.querySelector('.pa-conf-main')!;
    this.stageEl = root.querySelector('#pa-conf-stage')!;
    this.focusEl = root.querySelector('#pa-conf-focus')!;
    this.titleEl = root.querySelector('.pa-conf-head .title')!;
    this.subEl = root.querySelector('.pa-conf-head .sub')!;
    this.statusEl = root.querySelector('.pa-conf-head .status')!;
    this.chatLog = root.querySelector('.pa-conf-chatlog')!;
    this.chatInput = root.querySelector('.pa-conf-chatin')!;
    this.partsEl = root.querySelector('.pa-conf-parts')!;
    this.bar = root.querySelector('.pa-conf-bar')!;
    this.devPop = root.querySelector('.pa-conf-dev')!;
    this.wire();
  }

  /** The stage element LiveKitConference renders every tile into (cameras and
   *  screen shares alike). Focusing only moves a tile between containers. */
  get stage(): HTMLElement {
    return this.stageEl;
  }

  // ── Stage layout: page-filling grid ⇄ focused tile + filmstrip ─────

  /** Watch the stage for tiles coming and going, and for the window resizing. */
  private observeStage(): void {
    const mo = new MutationObserver(() => this.onTilesChanged());
    mo.observe(this.stageEl, { childList: true });
    mo.observe(this.focusEl, { childList: true }); // focused tile removed (left / stopped sharing)
    if (typeof ResizeObserver !== 'undefined') {
      new ResizeObserver(() => this.layoutGrid()).observe(this.stageEl);
    }
  }

  private onTilesChanged(): void {
    // A screen share takes the spotlight the moment it appears — that's what
    // everyone came to look at. Each share does this once, so a viewer who
    // clicks back to the grid isn't yanked into focus again.
    const screens = [...this.mainEl.querySelectorAll<HTMLElement>('.pa-conf-tile.screen')];
    const live = new Set<string>();
    for (const el of screens) {
      const key = el.dataset.focusKey ?? '';
      live.add(key);
      if (!this.knownScreens.has(key)) this.setFocus(el);
    }
    for (const key of this.knownScreens) if (!live.has(key)) this.knownScreens.delete(key);
    for (const key of live) this.knownScreens.add(key);
    // The focused tile's participant left (or stopped sharing) → fall back to
    // another share if there is one, else to the grid. (setFocus sees the stale
    // `focused` element, notices it's detached, and just drops it.)
    if (this.focused && !this.focused.isConnected) {
      this.setFocus(screens.find((el) => el.isConnected) ?? null);
    }
    this.layoutGrid();
  }

  /** Focus a tile (fills the stage) or, with null, return to the grid. */
  private setFocus(el: HTMLElement | null): void {
    if (this.focused === el) return;
    const prev = this.focused;
    if (prev) {
      prev.classList.remove('focused');
      if (prev.isConnected) {
        const home = this.focusHome?.parentElement === this.stageEl ? this.focusHome : null;
        this.stageEl.insertBefore(prev, home); // back into its old slot, not the end
        prev.title = 'Click to focus';
      }
    }
    this.focused = el;
    this.focusHome = el?.nextElementSibling ?? null;
    if (el) {
      el.classList.add('focused');
      el.title = 'Double-click to go back to the grid';
      this.focusEl.appendChild(el);
    }
    this.root.classList.toggle('focus-mode', !!el);
    if (!el) this.root.classList.remove('strip-collapsed');
    // Moving a <video> keeps it playing, but nudge it in case a browser paused it.
    for (const host of [prev, el]) {
      host?.querySelectorAll('video').forEach((v) => void v.play().catch(() => undefined));
    }
    this.layoutGrid();
  }

  /** Size the tiles so they fill the stage: try every column count and keep the
   *  one that makes the (16:9) tiles biggest, then let them wrap into that many
   *  per row. CSS auto-fit can't do this — it packs as many tiles per row as fit,
   *  so five people on a wide monitor end up as one thin row with the rest of the
   *  page empty. */
  private layoutGrid(): void {
    const n = this.stageEl.querySelectorAll('.pa-conf-tile').length;
    this.root.classList.toggle('strip-empty', n === 0); // solo focus → no empty strip
    if (this.focused) return; // filmstrip sizes itself off its fixed height
    const w = this.stageEl.clientWidth - GRID_PAD * 2;
    const h = this.stageEl.clientHeight - GRID_PAD * 2;
    if (!n || w <= 0 || h <= 0) return;
    let bestW = 0;
    for (let cols = 1; cols <= n; cols++) {
      const rows = Math.ceil(n / cols);
      const tw = Math.min((w - GRID_GAP * (cols - 1)) / cols, ((h - GRID_GAP * (rows - 1)) / rows) * (16 / 9));
      if (tw > bestW) bestW = tw;
    }
    // Floor, so `cols` tiles plus their gaps can never round up past the stage
    // and wrap one tile early.
    const tileW = Math.max(MIN_TILE_W, Math.floor(bestW));
    if (tileW === this.gridTileW) return; // nothing to write → no resize feedback loop
    this.gridTileW = tileW;
    this.stageEl.style.setProperty('--tile-w', `${tileW}px`);
  }

  private wire(): void {
    const q = <T extends HTMLElement>(sel: string): T => this.bar.querySelector<T>(sel)!;
    q('[data-mic]').onclick = () => this.handlers?.toggleMic();
    q('[data-cam]').onclick = () => this.handlers?.toggleCam();
    q('[data-screen]').onclick = () => this.handlers?.toggleScreen();
    q('[data-leave]').onclick = () => this.handlers?.leave();
    q('[data-chat]').onclick = () => this.openSide('chat');
    q('[data-people]').onclick = () => this.openSide('parts');
    q('[data-dev]').onclick = () => this.devPop.classList.toggle('open');
    q('[data-full]').onclick = () => this.toggleFullscreen();
    // Focus-mode controls (overlaid on the focused tile).
    const f = <T extends HTMLElement>(sel: string): T => this.focusEl.querySelector<T>(sel)!;
    f<HTMLButtonElement>('[data-ungrid]').onclick = () => this.setFocus(null);
    f<HTMLButtonElement>('[data-collapse]').onclick = () => this.root.classList.toggle('strip-collapsed');
    f<HTMLButtonElement>('[data-spotfull]').onclick = () => this.toggleFullscreen();
    // Click any tile to focus it; double-click the focused one to go back — but
    // not when the double-click is what focused it a moment ago.
    this.mainEl.addEventListener('click', (e) => {
      const tile = (e.target as HTMLElement | null)?.closest<HTMLElement>('.pa-conf-tile');
      if (tile && tile !== this.focused) {
        this.focusedAt = e.timeStamp;
        this.setFocus(tile);
      }
    });
    this.mainEl.addEventListener('dblclick', (e) => {
      if (!this.focused || e.timeStamp - this.focusedAt < DBLCLICK_MS) return;
      if ((e.target as HTMLElement | null)?.closest('.pa-conf-tile') === this.focused) this.setFocus(null);
    });
    // Esc leaves focus mode — but only once it's no longer closing fullscreen.
    document.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape' || this.root.style.display === 'none') return;
      if (!this.focused || document.fullscreenElement) return;
      e.stopPropagation();
      this.setFocus(null);
    });
    this.observeStage();
    this.root.querySelectorAll<HTMLButtonElement>('.pa-conf-tabs button').forEach((b) => {
      b.onclick = () => this.openSide(b.dataset.tab as 'chat' | 'parts');
    });
    this.chatInput.onkeydown = (e) => {
      e.stopPropagation(); // never reaches game/zone-chat key handlers
      if (e.key === 'Enter') {
        const t = this.chatInput.value.trim();
        if (t) this.handlers?.sendChat(t);
        this.chatInput.value = '';
      }
    };
    document.addEventListener('fullscreenchange', () => this.syncFullscreenBtn());
  }

  private openSide(tab: 'chat' | 'parts'): void {
    // Toggle the panel off if the same tab's bar button is pressed while open.
    const already = this.root.classList.contains('side-open') && this.root.classList.contains(`tab-${tab}`);
    this.root.classList.toggle('side-open', !already);
    this.root.classList.toggle('tab-chat', tab === 'chat');
    this.root.classList.toggle('tab-parts', tab === 'parts');
    this.root.querySelectorAll<HTMLButtonElement>('.pa-conf-tabs button').forEach((b) =>
      b.classList.toggle('on', b.dataset.tab === tab),
    );
    if (!already && tab === 'chat') setTimeout(() => this.chatInput.focus(), 0);
  }

  private toggleFullscreen(): void {
    if (document.fullscreenElement) void document.exitFullscreen().catch(() => undefined);
    else void this.root.requestFullscreen?.().catch(() => undefined);
  }
  private syncFullscreenBtn(): void {
    const on = document.fullscreenElement === this.root;
    this.bar.querySelector<HTMLButtonElement>('[data-full]')!.classList.toggle('on', on);
  }

  open(title: string, handlers: ConferenceUIHandlers): void {
    this.handlers = handlers;
    this.titleEl.textContent = `📹 ${title}`;
    this.chatLog.innerHTML = '';
    this.partsEl.innerHTML = '';
    this.partRows.clear();
    this.devPop.classList.remove('open');
    this.resetStage();
    this.root.style.display = 'flex';
  }

  close(): void {
    if (document.fullscreenElement === this.root) void document.exitFullscreen().catch(() => undefined);
    this.root.style.display = 'none';
    this.resetStage();
    this.handlers = null;
    this.chatLog.innerHTML = '';
    this.partsEl.innerHTML = '';
    this.partRows.clear();
  }

  /** Back to a clean grid — the tiles themselves belong to LiveKitConference. */
  private resetStage(): void {
    this.toast?.remove();
    this.toast = null;
    this.focused = null;
    this.focusHome = null;
    this.knownScreens.clear();
    this.gridTileW = 0;
    this.root.classList.remove('focus-mode', 'strip-collapsed', 'strip-empty');
  }

  setState(s: ConferenceState): void {
    this.state = s;
    this.statusEl.textContent = s.error ? s.error : s.connected ? '● live' : '… connecting';
    this.statusEl.classList.toggle('err', !!s.error);
    const set = (sel: string, active: boolean, on: string, off: string): void => {
      const b = this.bar.querySelector<HTMLButtonElement>(sel);
      if (!b) return;
      b.textContent = active ? on : off;
      b.classList.toggle('off', !active);
    };
    set('[data-mic]', s.micOn, '🎙 Mic', '🔇 Mic');
    set('[data-cam]', s.camOn, '📷 Cam', '🚫 Cam');
    const screen = this.bar.querySelector<HTMLButtonElement>('[data-screen]');
    if (screen) {
      screen.textContent = s.screenOn ? '🖥 Stop' : '🖥 Share';
      screen.classList.toggle('on', s.screenOn);
    }
  }

  setDevices(d: ConferenceDevices): void {
    this.devices = d;
    const pick = (icon: string, list: MediaDeviceInfo[], active: string | undefined, on: (id: string) => void): HTMLElement | null => {
      if (list.length < 2) return null;
      const wrap = document.createElement('label');
      wrap.textContent = icon;
      const sel = document.createElement('select');
      list.forEach((dev, i) => {
        const o = document.createElement('option');
        o.value = dev.deviceId;
        // Firefox leaves labels blank for a kind it has no permission for, and
        // every option reading "📷 Camera" is unusable — number them instead.
        o.textContent = dev.label || `${icon} ${i + 1}`;
        if (dev.deviceId === active) o.selected = true;
        sel.appendChild(o);
      });
      sel.onchange = () => on(sel.value);
      wrap.appendChild(sel);
      return wrap;
    };
    this.devPop.innerHTML = '';
    const cam = pick('📷 Camera', d.cameras, d.camId, (id) => this.handlers?.switchCamera(id));
    const mic = pick('🎙 Microphone', d.mics, d.micId, (id) => this.handlers?.switchMic(id));
    const spk = pick('🔊 Speaker', d.speakers, d.speakerId, (id) => this.handlers?.switchSpeaker(id));
    for (const el of [cam, mic, spk]) if (el) this.devPop.appendChild(el);
    if (!this.devPop.childElementCount) {
      const none = document.createElement('div');
      none.textContent = 'No selectable devices.';
      none.style.color = '#adb0b2';
      this.devPop.appendChild(none);
    }
  }

  setParticipants(list: ConferenceParticipant[]): void {
    this.subEl.textContent = `· ${list.length} ${list.length === 1 ? 'person' : 'people'}`;
    const seen = new Set<string>();
    for (const p of list) {
      seen.add(p.identity);
      let e = this.partRows.get(p.identity);
      if (!e) {
        e = this.createPartRow(p.identity, p.local);
        this.partRows.set(p.identity, e);
        this.partsEl.appendChild(e.row);
      }
      e.nm.textContent = p.name;
      e.icons.textContent = `${p.micOn ? '🎙' : '🔇'} ${p.camOn ? '📷' : '🚫'}`;
      if (e.mute) {
        e.mute.textContent = p.mutedLocally ? '🔇' : '🔊';
        e.mute.classList.toggle('muted', p.mutedLocally);
        e.mute.title = p.mutedLocally ? 'Unmute for me' : 'Mute for me';
      }
      // Nothing to ask for once their mic is already off.
      if (e.muteAll) e.muteAll.disabled = !p.micOn;
      // Don't stomp a slider the user is actively dragging (its input handler
      // keeps the value + % readout current). Refresh others from state.
      if (e.vol && e.pct && document.activeElement !== e.vol) {
        const pct = Math.round(p.volume * 100);
        e.vol.value = String(pct);
        e.pct.textContent = `${pct}%`;
      }
    }
    for (const [id, e] of this.partRows) {
      if (!seen.has(id)) {
        e.row.remove();
        this.partRows.delete(id);
      }
    }
  }

  /** One People row: name + mic/cam status and a "mute for everyone" button,
   *  plus (remote only) a local mute-for-me button and a 0–100% playback volume
   *  slider. The two mutes are deliberately different: the slider and 🔊 change
   *  only what *this* viewer hears, "Mute for all" turns their mic off in the
   *  actual call (and they can turn it back on). */
  private createPartRow(identity: string, local: boolean): PartRow {
    const row = document.createElement('div');
    row.className = 'p';
    const nm = document.createElement('span');
    nm.className = 'n';
    const icons = document.createElement('span');
    icons.className = 'i';
    row.append(nm, icons);
    if (local) return { row, nm, icons };

    const muteAll = document.createElement('button');
    muteAll.className = 'mute-all';
    muteAll.textContent = 'Mute for all';
    muteAll.title = 'Turn their microphone off for everyone (they can unmute themselves)';
    muteAll.onclick = () => this.handlers?.muteForAll(identity);
    row.appendChild(muteAll);

    const volRow = document.createElement('div');
    volRow.className = 'vol-row';
    const mute = document.createElement('button');
    mute.onclick = () => this.handlers?.setMuted(identity, !mute.classList.contains('muted'));
    const vol = document.createElement('input');
    vol.type = 'range';
    vol.min = '0';
    vol.max = '100';
    vol.title = 'Volume';
    const pct = document.createElement('span');
    pct.className = 'pct';
    vol.oninput = () => {
      this.handlers?.setVolume(identity, Number(vol.value) / 100);
      pct.textContent = `${vol.value}%`;
    };
    volRow.append(mute, vol, pct);
    row.appendChild(volRow);
    return { row, nm, icons, mute, muteAll, vol, pct };
  }

  /** Show a transient banner over the stage (mute requests and the like). */
  notice(text: string): void {
    this.toast?.remove();
    const el = document.createElement('div');
    el.className = 'pa-conf-toast';
    el.textContent = text;
    this.root.appendChild(el);
    this.toast = el;
    window.setTimeout(() => el.classList.add('out'), 4000);
    window.setTimeout(() => {
      el.remove();
      if (this.toast === el) this.toast = null;
    }, 4500);
  }

  addChat(m: ConferenceChatMsg): void {
    const atBottom = this.chatLog.scrollHeight - this.chatLog.scrollTop - this.chatLog.clientHeight < 24;
    const ln = document.createElement('div');
    ln.className = 'ln';
    const d = new Date(m.at);
    const ts = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
    ln.innerHTML = `<span class="ts">${ts}</span> <b>${esc(m.from)}:</b> ${esc(m.text)}`;
    this.chatLog.appendChild(ln);
    while (this.chatLog.childElementCount > 200) this.chatLog.firstElementChild?.remove();
    if (atBottom) this.chatLog.scrollTop = this.chatLog.scrollHeight;
  }
}

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}
