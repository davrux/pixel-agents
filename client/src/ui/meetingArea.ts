export interface MeetingAreaHandlers {
  toggleMic: () => void;
  toggleCam: () => void;
  switchCamera: (id: string) => void;
  switchMic: (id: string) => void;
  switchSpeaker: (id: string) => void;
  expand: () => void;
  leave: () => void;
}

export interface MeetingAreaState {
  connected: boolean;
  micOn: boolean;
  camOn: boolean;
  error?: string;
}

export interface MeetingAreaDevices {
  cameras: MediaDeviceInfo[];
  mics: MediaDeviceInfo[];
  speakers: MediaDeviceInfo[];
  camId?: string;
  micId?: string;
  speakerId?: string;
}

/**
 * Walk-in meeting areas (a 'meetingRoom' tile action in OfficeLayout.tileActions,
 * flood-filled into area ids server-side — see OfficeState.areaIdAt). Standing on the tile
 * auto-connects (mirrors WorkAdventure's proximity bubble: no explicit join
 * step) and this small ambient panel IS the call — live camera tiles with a
 * "speaking" glow and a muted-mic placeholder, reusing LiveKitConference's own
 * tile rendering (see OfficeScene's joinMeetingAreaVideo), just retargeted
 * into this panel's own mini stage instead of the full-screen conference
 * window. The "⛶ Expand" button retargets the SAME live call into that full
 * window (ConferenceUI/LiveKitConference, shared wholesale with conference
 * monitors) for device setup, chat, and a big screen-share spotlight.
 */
export class MeetingAreaUI {
  /** Fallback when the area's ActionArea carries no `meetingRoomName`. */
  private static readonly GENERIC_TITLE = '🤝 Meeting area';

  private readonly panel: HTMLDivElement;
  private readonly titleEl: HTMLSpanElement;
  private readonly minBtn: HTMLButtonElement;
  private minimized = false;
  private readonly statusEl: HTMLSpanElement;
  private readonly elsewhereEl: HTMLDivElement;
  private readonly stageEl: HTMLDivElement;
  private readonly screensEl: HTMLDivElement;
  private readonly micBtn: HTMLButtonElement;
  private readonly camBtn: HTMLButtonElement;
  private readonly devPop: HTMLDivElement;
  private handlers: MeetingAreaHandlers | null = null;

  constructor() {
    injectMeetingAreaStyles();
    this.panel = document.createElement('div');
    this.panel.id = 'pa-meeting';
    this.panel.style.display = 'none';

    const header = document.createElement('div');
    header.className = 'pa-meet-head';
    this.titleEl = document.createElement('span');
    this.titleEl.textContent = MeetingAreaUI.GENERIC_TITLE;
    this.statusEl = document.createElement('span');
    this.statusEl.className = 'pa-meet-status';
    this.minBtn = document.createElement('button');
    this.minBtn.className = 'pa-meet-min';
    this.minBtn.textContent = '🗕';
    this.minBtn.title = 'Minimise (the call keeps running)';
    this.minBtn.onclick = (e) => {
      e.stopPropagation(); // the header is also the drag handle
      this.setMinimized(!this.minimized);
    };
    header.append(this.titleEl, this.statusEl, this.minBtn);
    this.panel.appendChild(header);
    this.wireDrag(header);

    // Who is in this call but NOT in the area you are standing in. Same-named areas share
    // one call now (see SimRoom.tileMeetingRoom), so "in the call" stopped meaning "over
    // there, where I can see them" — and a voice from nowhere is worse than a line of text.
    this.elsewhereEl = document.createElement('div');
    this.elsewhereEl.className = 'pa-meet-elsewhere';
    this.elsewhereEl.style.display = 'none';
    this.panel.appendChild(this.elsewhereEl);

    this.stageEl = document.createElement('div');
    this.stageEl.className = 'pa-meet-stage';
    this.panel.appendChild(this.stageEl);

    // LiveKitConference needs a real element for screen-share tiles even
    // while mini — hidden here because a share auto-expands into the full
    // window (see OfficeScene's onMeetingAreaScreens) before it matters.
    this.screensEl = document.createElement('div');
    this.screensEl.className = 'pa-meet-screens';
    this.panel.appendChild(this.screensEl);

    const controls = document.createElement('div');
    controls.className = 'pa-meet-controls';
    this.micBtn = document.createElement('button');
    this.micBtn.title = 'Toggle microphone';
    this.micBtn.onclick = () => this.handlers?.toggleMic();
    this.camBtn = document.createElement('button');
    this.camBtn.title = 'Toggle camera';
    this.camBtn.onclick = () => this.handlers?.toggleCam();
    const devBtn = document.createElement('button');
    devBtn.textContent = '⚙';
    devBtn.title = 'Choose camera / mic / speaker';
    devBtn.onclick = () => this.devPop.classList.toggle('open');
    const expandBtn = document.createElement('button');
    expandBtn.textContent = '⛶';
    expandBtn.title = 'Switch to full meeting view';
    expandBtn.onclick = () => this.handlers?.expand();
    const leaveBtn = document.createElement('button');
    leaveBtn.className = 'pa-meet-leave';
    leaveBtn.textContent = '📵';
    leaveBtn.title = 'Leave the call';
    leaveBtn.onclick = () => this.handlers?.leave();
    controls.append(this.micBtn, this.camBtn, devBtn, expandBtn, leaveBtn);
    this.panel.appendChild(controls);

    this.devPop = document.createElement('div');
    this.devPop.className = 'pa-meet-dev';
    this.panel.appendChild(this.devPop);

    document.body.appendChild(this.panel);
    this.setState({ connected: false, micOn: true, camOn: true });
  }

  /** The stage element LiveKitConference renders participant tiles into
   *  while this popup is the active view (see LiveKitConference.retarget). */
  get stage(): HTMLElement {
    return this.stageEl;
  }
  /** The (hidden-while-mini) element LiveKitConference renders screen-share
   *  tiles into. */
  get screens(): HTMLElement {
    return this.screensEl;
  }

  /** Name this call's room (the area's `meetingRoomName`), or the generic label
   *  when it has none. Set on every entry, because the whole point is telling two
   *  adjacent areas apart when you walk straight from one into the other. */
  setTitle(meetingRoomName?: string): void {
    this.titleEl.textContent = meetingRoomName ? `🤝 ${meetingRoomName}` : MeetingAreaUI.GENERIC_TITLE;
  }

  /**
   * Name the participants who are in another area of the same call.
   *
   * Not a count alone: "2 elsewhere" tells you to look around for people who are not
   * there, while their names tell you who you are talking to. Empty list = hide the line
   * entirely, which is the ordinary case of one area.
   */
  setElsewhere(names: string[]): void {
    if (names.length === 0) {
      this.elsewhereEl.style.display = 'none';
      this.elsewhereEl.textContent = '';
      return;
    }
    const shown = names.slice(0, 3).join(', ');
    const rest = names.length - Math.min(3, names.length);
    this.elsewhereEl.textContent = `📍 elsewhere in this room: ${shown}${rest > 0 ? ` +${rest}` : ''}`;
    this.elsewhereEl.title = `Same room name, different area — you cannot see them from here:\n${names.join('\n')}`;
    this.elsewhereEl.style.display = 'block';
  }

  setVisible(visible: boolean): void {
    this.panel.style.display = visible ? 'flex' : 'none';
    if (!visible) this.devPop.classList.remove('open');
    // Re-apply a dragged position on every show: the window may have been
    // resized (or the panel moved off-screen) while no call was running.
    if (visible) this.applyStoredPosition();
  }

  /**
   * Collapse to just the header — title, status and this button.
   *
   * Deliberately not "hide": a call you cannot see is a call you forget you are
   * in. The stage stays in the DOM (display:none), so LiveKitConference keeps
   * rendering into the same element and audio keeps playing — hiding an element
   * does not pause its media.
   */
  setMinimized(min: boolean): void {
    this.minimized = min;
    this.panel.classList.toggle('min', min);
    this.minBtn.textContent = min ? '🗖' : '🗕';
    this.minBtn.title = min ? 'Restore' : 'Minimise (the call keeps running)';
    if (min) this.devPop.classList.remove('open');
  }

  /** Drag by the header. Switches from the docked right/bottom anchoring to
   *  left/top on first move, and remembers where you left it (a zone switch is a
   *  full reload, so without storing it the panel would jump back every time). */
  private wireDrag(handle: HTMLElement): void {
    handle.style.cursor = 'move';
    let startX = 0;
    let startY = 0;
    let baseLeft = 0;
    let baseTop = 0;
    let dragging = false;
    const onMove = (e: PointerEvent): void => {
      if (!dragging) return;
      const w = this.panel.offsetWidth;
      const h = this.panel.offsetHeight;
      const left = Math.min(Math.max(0, baseLeft + e.clientX - startX), Math.max(0, window.innerWidth - w));
      const top = Math.min(Math.max(0, baseTop + e.clientY - startY), Math.max(0, window.innerHeight - h));
      this.place(left, top);
    };
    const onUp = (e: PointerEvent): void => {
      if (!dragging) return;
      dragging = false;
      handle.releasePointerCapture(e.pointerId);
      try {
        localStorage.setItem('pa-meet-pos', JSON.stringify({ left: this.panel.offsetLeft, top: this.panel.offsetTop }));
      } catch {
        /* storage unavailable — the position just won't survive a reload */
      }
    };
    handle.addEventListener('pointerdown', (e) => {
      if ((e.target as HTMLElement).closest('button')) return; // the minimise button
      const r = this.panel.getBoundingClientRect();
      baseLeft = r.left;
      baseTop = r.top;
      startX = e.clientX;
      startY = e.clientY;
      dragging = true;
      handle.setPointerCapture(e.pointerId);
      e.preventDefault(); // no text selection while dragging
    });
    handle.addEventListener('pointermove', onMove);
    handle.addEventListener('pointerup', onUp);
    handle.addEventListener('pointercancel', onUp);
  }

  private place(left: number, top: number): void {
    this.panel.style.left = `${left}px`;
    this.panel.style.top = `${top}px`;
    this.panel.style.right = 'auto';
    this.panel.style.bottom = 'auto';
  }

  private applyStoredPosition(): void {
    let raw: string | null = null;
    try {
      raw = localStorage.getItem('pa-meet-pos');
    } catch {
      return;
    }
    if (!raw) return;
    try {
      const p = JSON.parse(raw) as { left?: number; top?: number };
      if (typeof p.left !== 'number' || typeof p.top !== 'number') return;
      const w = this.panel.offsetWidth || 224;
      const h = this.panel.offsetHeight || 160;
      this.place(
        Math.min(Math.max(0, p.left), Math.max(0, window.innerWidth - w)),
        Math.min(Math.max(0, p.top), Math.max(0, window.innerHeight - h)),
      );
    } catch {
      /* malformed — keep the docked default */
    }
  }

  setHandlers(h: MeetingAreaHandlers | null): void {
    this.handlers = h;
  }

  setState(s: MeetingAreaState): void {
    this.statusEl.textContent = s.error ? s.error : s.connected ? '● live' : '… connecting';
    this.statusEl.classList.toggle('err', !!s.error);
    this.micBtn.textContent = s.micOn ? '🎙' : '🔇';
    this.camBtn.textContent = s.camOn ? '📷' : '🚫';
    this.micBtn.classList.toggle('off', !s.micOn);
    this.camBtn.classList.toggle('off', !s.camOn);
  }

  setDevices(d: MeetingAreaDevices): void {
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
    const cam = pick('📷', d.cameras, d.camId, (id) => this.handlers?.switchCamera(id));
    const mic = pick('🎙', d.mics, d.micId, (id) => this.handlers?.switchMic(id));
    const spk = pick('🔊', d.speakers, d.speakerId, (id) => this.handlers?.switchSpeaker(id));
    for (const el of [cam, mic, spk]) if (el) this.devPop.appendChild(el);
    if (!this.devPop.childElementCount) {
      const none = document.createElement('div');
      none.textContent = 'No selectable devices.';
      this.devPop.appendChild(none);
    }
  }
}

function injectMeetingAreaStyles(): void {
  if (document.getElementById('pa-meeting-style')) return;
  const s = document.createElement('style');
  s.id = 'pa-meeting-style';
  s.textContent = `
    #pa-meeting{position:fixed;right:calc(0.75rem + var(--pa-dock-r, 0px) + var(--pa-side-panel-w, 0px));bottom:0.75rem;z-index:59;flex-direction:column;gap:0.5rem;
      /* Clamped to the room between the docked windows for the same reason the
         chat box is (see chatUI.ts): inset from the right window only, it can
         still reach the left one when both are open. */
      width:14rem;max-width:calc(var(--pa-hud-gap, 100vw) - 1.5rem);
      background:#1c1a19;border:2px solid #0a0908;border-radius:0.5rem;
      padding:0.6rem;color:#f1efec;font-family:'FS Pixel Sans',ui-monospace,monospace;font-size:0.85rem;
      box-shadow:inset 0 0 0 1px rgba(255,255,255,.04),0 4px 18px rgba(0,0,0,.45);}
    #pa-meeting .pa-meet-head{display:flex;align-items:baseline;justify-content:space-between;gap:0.4rem;font-weight:bold;
      touch-action:none;/* pointer drag, not scroll */}
    #pa-meeting .pa-meet-min{flex:0 0 auto;background:#262422;border:2px solid #0a0908;border-radius:0.35rem;
      color:#adb0b2;font:0.9rem 'FS Pixel Sans',monospace;padding:0 0.35rem;cursor:pointer;
      box-shadow:inset 0 2px 0 #4a4744,inset 0 -3px 0 #050505;}
    #pa-meeting .pa-meet-min:hover{color:#f1efec;}
    /* Minimised: the header alone. The stage stays in the DOM so the call keeps
       running and can be restored without a reconnect. */
    #pa-meeting.min{width:auto;}
    #pa-meeting.min .pa-meet-stage,
    #pa-meeting.min .pa-meet-screens,
    #pa-meeting.min .pa-meet-controls{display:none;}
    #pa-meeting .pa-meet-status{font-weight:normal;font-size:0.75rem;color:#7fbf6a;}
    #pa-meeting .pa-meet-status.err{color:#f2a1a1;}
    #pa-meeting .pa-meet-elsewhere{font-size:0.72rem;color:#adb0b2;margin:-0.1rem 0 0.35rem;
      padding:0.2rem 0.35rem;background:#262422;border:2px solid #0a0908;border-radius:0.3rem;
      white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
    #pa-meeting .pa-meet-screens{display:none;}
    #pa-meeting .pa-meet-stage{display:grid;grid-template-columns:repeat(2,1fr);gap:0.35rem;max-height:14rem;overflow-y:auto;}
    #pa-meeting .pa-conf-tile{position:relative;aspect-ratio:4/3;background:#262422;border:2px solid #0a0908;
      border-radius:0.3rem;overflow:hidden;display:flex;align-items:center;justify-content:center;
      box-shadow:inset 0 1px 0 #4a4744,inset 0 -2px 0 #050505;}
    #pa-meeting .pa-conf-tile.speaking{border-color:#c51a1b;box-shadow:0 0 0 2px #e2585a inset;}
    #pa-meeting .pa-conf-tile.camoff{background:#000;box-shadow:none;}
    #pa-meeting .pa-conf-media{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;}
    #pa-meeting .pa-conf-video{width:100%;height:100%;object-fit:cover;background:#000;}
    #pa-meeting .pa-conf-video.mirror{transform:scaleX(-1);}
    #pa-meeting .pa-conf-ph{width:1.8rem;height:1.8rem;border-radius:50%;background:#141312;border:1px solid #0a0908;
      display:flex;align-items:center;justify-content:center;font-size:0.65rem;color:#d7d9da;}
    #pa-meeting .pa-conf-name{position:absolute;left:0.2rem;bottom:0.15rem;font-size:0.62rem;color:#fff;
      text-shadow:0 0 3px #000,0 0 3px #000;z-index:1;}
    #pa-meeting .pa-conf-micoff{position:absolute;top:0.2rem;right:0.2rem;font-size:0.7rem;z-index:2;
      filter:drop-shadow(0 0 2px #000);}
    #pa-meeting .pa-meet-controls{display:flex;gap:0.3rem;position:relative;}
    #pa-meeting .pa-meet-controls button{flex:1;cursor:pointer;background:#262422;border:2px solid #0a0908;
      color:#f1efec;border-radius:0.35rem;font-size:0.9rem;padding:0.35rem 0.15rem;
      box-shadow:inset 0 2px 0 #4a4744,inset 0 -3px 0 #050505;}
    #pa-meeting .pa-meet-controls button:hover{background:#2f2c29;}
    #pa-meeting .pa-meet-controls button.off{background:#3a1f22;}
    #pa-meeting .pa-meet-controls button.pa-meet-leave{background:#7c2634;border-color:#0a0908;
      box-shadow:inset 0 2px 0 #b34a5a,inset 0 -3px 0 #45111a;}
    #pa-meeting .pa-meet-dev{position:absolute;bottom:2.6rem;left:0;right:0;background:#1c1a19;
      border:2px solid #0a0908;border-radius:0.5rem;padding:0.5rem;display:none;flex-direction:column;gap:0.35rem;
      box-shadow:inset 0 2px 0 #292725,inset 0 -3px 0 #030303,0 8px 20px rgba(0,0,0,.5);}
    #pa-meeting .pa-meet-dev.open{display:flex;}
    #pa-meeting .pa-meet-dev label{font-size:0.7rem;color:#818586;display:flex;align-items:center;gap:0.3rem;}
    #pa-meeting .pa-meet-dev select{flex:1;min-width:0;background:#262422;border:2px solid #0a0908;color:#f1efec;
      border-radius:0.3rem;font:0.75rem 'FS Pixel Sans',monospace;padding:0.25rem;}
  `;
  document.head.appendChild(s);
}
