export interface MeetingAreaHandlers {
  toggleMic: () => void;
  toggleCam: () => void;
  expand: () => void;
  leave: () => void;
}

export interface MeetingAreaState {
  connected: boolean;
  micOn: boolean;
  camOn: boolean;
  error?: string;
}

/**
 * Walk-in meeting areas (OfficeLayout.tilePrivateArea, flood-filled into area
 * ids server-side — see OfficeState.areaIdAt). Standing on the tile
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
  private readonly panel: HTMLDivElement;
  private readonly statusEl: HTMLSpanElement;
  private readonly stageEl: HTMLDivElement;
  private readonly screensEl: HTMLDivElement;
  private readonly micBtn: HTMLButtonElement;
  private readonly camBtn: HTMLButtonElement;
  private handlers: MeetingAreaHandlers | null = null;

  constructor() {
    injectMeetingAreaStyles();
    this.panel = document.createElement('div');
    this.panel.id = 'pa-meeting';
    this.panel.style.display = 'none';

    const header = document.createElement('div');
    header.className = 'pa-meet-head';
    const title = document.createElement('span');
    title.textContent = '🤝 Meeting area';
    this.statusEl = document.createElement('span');
    this.statusEl.className = 'pa-meet-status';
    header.append(title, this.statusEl);
    this.panel.appendChild(header);

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
    this.micBtn.textContent = '🎙';
    this.micBtn.title = 'Toggle microphone';
    this.micBtn.onclick = () => this.handlers?.toggleMic();
    this.camBtn = document.createElement('button');
    this.camBtn.textContent = '📷';
    this.camBtn.title = 'Toggle camera';
    this.camBtn.onclick = () => this.handlers?.toggleCam();
    const expandBtn = document.createElement('button');
    expandBtn.textContent = '⛶';
    expandBtn.title = 'Switch to full meeting view';
    expandBtn.onclick = () => this.handlers?.expand();
    const leaveBtn = document.createElement('button');
    leaveBtn.className = 'pa-meet-leave';
    leaveBtn.textContent = '📵';
    leaveBtn.title = 'Leave the call';
    leaveBtn.onclick = () => this.handlers?.leave();
    controls.append(this.micBtn, this.camBtn, expandBtn, leaveBtn);
    this.panel.appendChild(controls);

    document.body.appendChild(this.panel);
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

  setVisible(visible: boolean): void {
    this.panel.style.display = visible ? 'flex' : 'none';
  }

  setHandlers(h: MeetingAreaHandlers | null): void {
    this.handlers = h;
  }

  setState(s: MeetingAreaState): void {
    this.statusEl.textContent = s.error ? s.error : s.connected ? '● live' : '… connecting';
    this.statusEl.classList.toggle('err', !!s.error);
    this.micBtn.classList.toggle('off', !s.micOn);
    this.camBtn.classList.toggle('off', !s.camOn);
  }
}

function injectMeetingAreaStyles(): void {
  if (document.getElementById('pa-meeting-style')) return;
  const s = document.createElement('style');
  s.id = 'pa-meeting-style';
  s.textContent = `
    #pa-meeting{position:fixed;right:0.75rem;bottom:0.75rem;z-index:59;flex-direction:column;gap:0.5rem;
      width:14rem;background:#1c1a19;border:2px solid #0a0908;border-radius:0.5rem;
      padding:0.6rem;color:#f1efec;font-family:'FS Pixel Sans',ui-monospace,monospace;font-size:0.85rem;
      box-shadow:inset 0 0 0 1px rgba(255,255,255,.04),0 4px 18px rgba(0,0,0,.45);}
    #pa-meeting .pa-meet-head{display:flex;align-items:baseline;justify-content:space-between;gap:0.4rem;font-weight:bold;}
    #pa-meeting .pa-meet-status{font-weight:normal;font-size:0.75rem;color:#7fbf6a;}
    #pa-meeting .pa-meet-status.err{color:#f2a1a1;}
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
    #pa-meeting .pa-meet-controls{display:flex;gap:0.35rem;}
    #pa-meeting .pa-meet-controls button{flex:1;cursor:pointer;background:#262422;border:2px solid #0a0908;
      color:#f1efec;border-radius:0.35rem;font-size:0.95rem;padding:0.35rem 0.2rem;
      box-shadow:inset 0 2px 0 #4a4744,inset 0 -3px 0 #050505;}
    #pa-meeting .pa-meet-controls button:hover{background:#2f2c29;}
    #pa-meeting .pa-meet-controls button.off{opacity:0.5;}
    #pa-meeting .pa-meet-controls button.pa-meet-leave{background:#7c2634;border-color:#0a0908;
      box-shadow:inset 0 2px 0 #b34a5a,inset 0 -3px 0 #45111a;}
  `;
  document.head.appendChild(s);
}
