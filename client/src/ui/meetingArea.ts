export interface MeetingParticipant {
  id: number;
  name: string;
}

export interface MeetingAreaHandlers {
  onJoin: () => void;
}

/**
 * Walk-in meeting areas (OfficeLayout.tilePrivateArea, flood-filled into area
 * ids server-side — see OfficeState.areaIdAt). Pops up whenever the local
 * player's current tile is in one: who else is here, plus a "Join video"
 * button. This UI only renders the roster — the actual call (device setup,
 * spotlight-on-screenshare, mute/participants controls) is the EXISTING
 * conference-monitor UI (ConferenceUI/LiveKitConference, see OfficeScene's
 * onMeetingAreaToken), reused wholesale rather than rebuilt. Each area gets
 * its own LiveKit room (keyed by its stable flood-fill anchor tile, see
 * OfficeState.areaAnchor) exactly like a conference monitor gets its own room
 * keyed by name-or-position.
 */
export class MeetingAreaUI {
  private readonly panel: HTMLDivElement;
  private readonly rosterEl: HTMLDivElement;
  private readonly joinBtn: HTMLButtonElement;
  private handlers: MeetingAreaHandlers | null = null;
  private lastOthers: MeetingParticipant[] | null = null;
  private inCall = false;

  constructor() {
    injectMeetingAreaStyles();
    this.panel = document.createElement('div');
    this.panel.id = 'pa-meeting';
    this.panel.style.display = 'none';

    const header = document.createElement('div');
    header.className = 'pa-meet-head';
    header.textContent = '🤝 Meeting area';
    this.panel.appendChild(header);

    this.rosterEl = document.createElement('div');
    this.rosterEl.className = 'pa-meet-roster';
    this.panel.appendChild(this.rosterEl);

    this.joinBtn = document.createElement('button');
    this.joinBtn.className = 'pa-meet-join';
    this.joinBtn.textContent = '🎥 Join video';
    this.joinBtn.onclick = () => this.handlers?.onJoin();
    this.panel.appendChild(this.joinBtn);

    document.body.appendChild(this.panel);
  }

  /** Call whenever the local player's meeting-area membership or its roster
   *  changes. `others` excludes the local player; pass null when not
   *  currently standing in any meeting area (hides the popup). */
  update(others: MeetingParticipant[] | null, handlers: MeetingAreaHandlers | null): void {
    this.lastOthers = others;
    this.handlers = handlers;
    this.render();
  }

  /** Hide the popup while a video call is open for this area (its own
   *  participant list already shows inside ConferenceUI) — call with false
   *  once the call ends so the popup can reappear if still a member. */
  setInCall(inCall: boolean): void {
    this.inCall = inCall;
    this.render();
  }

  private render(): void {
    if (this.lastOthers === null || this.inCall) {
      this.panel.style.display = 'none';
      return;
    }
    this.rosterEl.textContent =
      this.lastOthers.length === 0
        ? "You're the only one here"
        : `With you: ${this.lastOthers.map((o) => o.name).join(', ')}`;
    this.panel.style.display = 'flex';
  }
}

function injectMeetingAreaStyles(): void {
  if (document.getElementById('pa-meeting-style')) return;
  const s = document.createElement('style');
  s.id = 'pa-meeting-style';
  s.textContent = `
    #pa-meeting{position:fixed;right:0.75rem;bottom:0.75rem;z-index:59;flex-direction:column;gap:0.5rem;
      width:16rem;background:#1c1a19;border:2px solid #0a0908;border-radius:0.5rem;
      padding:0.7rem;color:#f1efec;font-family:'FS Pixel Sans',ui-monospace,monospace;font-size:0.85rem;
      box-shadow:inset 0 0 0 1px rgba(255,255,255,.04),0 4px 18px rgba(0,0,0,.45);}
    #pa-meeting .pa-meet-head{font-weight:bold;}
    #pa-meeting .pa-meet-roster{color:#c8c5c0;font-size:0.78rem;line-height:1.4;}
    #pa-meeting .pa-meet-join{cursor:pointer;background:#262422;border:2px solid #0a0908;
      color:#f1efec;border-radius:0.35rem;font:0.78rem 'FS Pixel Sans',monospace;padding:0.45rem 0.5rem;
      box-shadow:inset 0 2px 0 #4a4744,inset 0 -3px 0 #050505;}
    #pa-meeting .pa-meet-join:hover{background:#2f2c29;}
  `;
  document.head.appendChild(s);
}
