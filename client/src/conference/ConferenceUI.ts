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
 * Media + the in-meeting chat transport live in LiveKitConference; this class is
 * pure UI, driven by handlers + update calls from OfficeScene.
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
  setMuted: (identity: string, muted: boolean) => void;
  sendChat: (text: string) => void;
  leave: () => void;
  /** Retarget the live call back to its small ambient popup without hanging
   *  up. Only meeting areas set this (a monitor conference has no mini
   *  view to shrink back to) — the button hides when it's absent. */
  minimize?: () => void;
}

/** One People-panel row's live elements (reused across re-renders so an active
 *  slider drag isn't destroyed). Volume controls exist for remote rows only. */
interface PartRow {
  row: HTMLElement;
  nm: HTMLElement;
  icons: HTMLElement;
  mute?: HTMLButtonElement;
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
  #pa-conf .pa-conf-head .pa-conf-min{cursor:pointer;background:#242220;border:2px solid #0a0908;color:#f1efec;
    border-radius:0.35rem;font:0.85rem 'FS Pixel Sans',monospace;padding:0.3rem 0.5rem;
    box-shadow:inset 0 2px 0 #4a4744,inset 0 -3px 0 #050505;}
  #pa-conf .pa-conf-head .pa-conf-min:hover{background:#2e2b28;}
  #pa-conf .pa-conf-body{flex:1;display:flex;min-height:0;}
  #pa-conf .pa-conf-main{flex:1;display:flex;min-width:0;min-height:0;}
  /* Default: grid of participant tiles fills the main area. */
  #pa-conf-stage{flex:1;display:grid;gap:0.5rem;padding:0.6rem;overflow:auto;align-content:center;
    grid-template-columns:repeat(auto-fit,minmax(13rem,1fr));background:#141312;min-width:0;}
  #pa-conf .pa-conf-tile{position:relative;aspect-ratio:16/9;background:#262422;border:2px solid #0a0908;
    border-radius:0.4rem;overflow:hidden;display:flex;align-items:center;justify-content:center;
    box-shadow:inset 0 2px 0 #4a4744,inset 0 -3px 0 #050505;}
  #pa-conf .pa-conf-tile.speaking{border-color:#c51a1b;box-shadow:0 0 0 2px #e2585a inset;}
  /* Camera off → a plain black screen (the placeholder avatar sits on top). */
  #pa-conf .pa-conf-tile.camoff{background:#000;box-shadow:none;}
  /* Screen-share spotlight (hidden until a screen is shared). */
  #pa-conf-spotlight{display:none;position:relative;flex:1;min-width:0;padding:0.6rem;background:#141312;
    align-items:center;justify-content:center;}
  #pa-conf.sharing #pa-conf-spotlight{display:flex;}
  #pa-conf-spotlight .pa-conf-screen{position:relative;width:100%;height:100%;background:#000;
    border:2px solid #c51a1b;border-radius:0.4rem;box-shadow:0 0 0 1px #e2585a;
    display:flex;align-items:center;justify-content:center;overflow:hidden;}
  #pa-conf-spotlight .pa-conf-video.contain{width:100%;height:100%;object-fit:contain;}
  .pa-conf-spot-ctl{position:absolute;top:0.55rem;right:0.55rem;z-index:3;display:none;gap:0.35rem;}
  #pa-conf.sharing .pa-conf-spot-ctl{display:flex;}
  .pa-conf-spot-ctl button{cursor:pointer;background:#262422;border:2px solid #0a0908;color:#f1efec;
    border-radius:0.35rem;font:0.9rem 'FS Pixel Sans',monospace;padding:0.32rem 0.55rem;
    box-shadow:inset 0 2px 0 #4a4744,inset 0 -3px 0 #050505;}
  .pa-conf-spot-ctl button:hover{background:#2e2b28;}
  /* While sharing, participant tiles become a scrollable column on the right. */
  #pa-conf.sharing #pa-conf-stage{flex:0 0 14rem;display:flex;flex-direction:column;gap:0.4rem;overflow-y:auto;
    overflow-x:hidden;align-content:stretch;}
  #pa-conf.sharing.people-collapsed #pa-conf-stage{display:none;}
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

export class ConferenceUI {
  private readonly root: HTMLDivElement;
  private readonly stageEl: HTMLDivElement;
  private readonly spotlightEl: HTMLDivElement;
  private readonly titleEl: HTMLSpanElement;
  private readonly subEl: HTMLSpanElement;
  private readonly statusEl: HTMLSpanElement;
  private readonly minBtn: HTMLButtonElement;
  private readonly chatLog: HTMLDivElement;
  private readonly chatInput: HTMLInputElement;
  private readonly partsEl: HTMLDivElement;
  private readonly bar: HTMLDivElement;
  private readonly devPop: HTMLDivElement;
  private handlers: ConferenceUIHandlers | null = null;
  private readonly partRows = new Map<string, PartRow>();
  private devices: ConferenceDevices = { cameras: [], mics: [], speakers: [] };
  private state: ConferenceState = { connected: false, camOn: true, micOn: true, screenOn: false };

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
        <button class="pa-conf-min" data-min title="Minimize" style="display:none">🗕</button>
      </div>
      <div class="pa-conf-body">
        <div class="pa-conf-main">
          <div id="pa-conf-spotlight">
            <div class="pa-conf-spot-ctl">
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
    this.stageEl = root.querySelector('#pa-conf-stage')!;
    this.spotlightEl = root.querySelector('#pa-conf-spotlight')!;
    this.titleEl = root.querySelector('.pa-conf-head .title')!;
    this.subEl = root.querySelector('.pa-conf-head .sub')!;
    this.statusEl = root.querySelector('.pa-conf-head .status')!;
    this.minBtn = root.querySelector('.pa-conf-head .pa-conf-min')!;
    this.chatLog = root.querySelector('.pa-conf-chatlog')!;
    this.chatInput = root.querySelector('.pa-conf-chatin')!;
    this.partsEl = root.querySelector('.pa-conf-parts')!;
    this.bar = root.querySelector('.pa-conf-bar')!;
    this.devPop = root.querySelector('.pa-conf-dev')!;
    this.wire();
  }

  /** The stage element LiveKitConference renders participant tiles into. */
  get stage(): HTMLElement {
    return this.stageEl;
  }
  /** The spotlight element LiveKitConference renders screen shares into. */
  get screens(): HTMLElement {
    return this.spotlightEl;
  }

  /** Switch to/from the screen-share spotlight layout (screen big + people on
   *  the right). Called when a screen share starts/stops. */
  setSharing(active: boolean): void {
    this.root.classList.toggle('sharing', active);
    if (!active) this.root.classList.remove('people-collapsed');
  }

  private wire(): void {
    const q = <T extends HTMLElement>(sel: string): T => this.bar.querySelector<T>(sel)!;
    q('[data-mic]').onclick = () => this.handlers?.toggleMic();
    q('[data-cam]').onclick = () => this.handlers?.toggleCam();
    q('[data-screen]').onclick = () => this.handlers?.toggleScreen();
    q('[data-leave]').onclick = () => this.handlers?.leave();
    this.minBtn.onclick = () => this.handlers?.minimize?.();
    q('[data-chat]').onclick = () => this.openSide('chat');
    q('[data-people]').onclick = () => this.openSide('parts');
    q('[data-dev]').onclick = () => this.devPop.classList.toggle('open');
    q('[data-full]').onclick = () => this.toggleFullscreen();
    // Screen-share spotlight controls (overlay on the shared screen).
    this.spotlightEl.querySelector<HTMLButtonElement>('[data-collapse]')!.onclick = () =>
      this.root.classList.toggle('people-collapsed');
    this.spotlightEl.querySelector<HTMLButtonElement>('[data-spotfull]')!.onclick = () => this.toggleFullscreen();
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
    this.minBtn.style.display = handlers.minimize ? '' : 'none';
    this.chatLog.innerHTML = '';
    this.partsEl.innerHTML = '';
    this.partRows.clear();
    this.devPop.classList.remove('open');
    this.root.style.display = 'flex';
  }

  close(): void {
    if (document.fullscreenElement === this.root) void document.exitFullscreen().catch(() => undefined);
    this.root.style.display = 'none';
    this.root.classList.remove('sharing', 'people-collapsed');
    this.handlers = null;
    this.chatLog.innerHTML = '';
    this.partsEl.innerHTML = '';
    this.partRows.clear();
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
      for (const dev of list) {
        const o = document.createElement('option');
        o.value = dev.deviceId;
        o.textContent = dev.label || icon;
        if (dev.deviceId === active) o.selected = true;
        sel.appendChild(o);
      }
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

  /** One People row: name + mic/cam status, plus (remote only) a local
   *  mute-for-me button and a 0–100% playback volume slider. */
  private createPartRow(identity: string, local: boolean): PartRow {
    const row = document.createElement('div');
    row.className = 'p';
    const nm = document.createElement('span');
    nm.className = 'n';
    const icons = document.createElement('span');
    icons.className = 'i';
    row.append(nm, icons);
    if (local) return { row, nm, icons };

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
    return { row, nm, icons, mute, vol, pct };
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
