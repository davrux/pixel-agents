import { parsePlayerId, type ZoneVoice } from '../voice/ZoneVoice.js';

export interface MeetingParticipant {
  id: number;
  name: string;
}

/**
 * Walk-in meeting areas (OfficeLayout.tilePrivateArea, flood-filled into area
 * ids server-side — see OfficeState.areaIdAt). Pops up whenever the local
 * player's current tile is in one: who else is here, plus on-the-fly camera +
 * screen-share. Reuses the zone's existing ZoneVoice connection (same LiveKit
 * room as ambient proximity audio) rather than opening a separate call —
 * entering an area just auto-joins zone voice if it wasn't already on.
 *
 * Privacy note: video tracks are still visible to the whole LiveKit room at
 * the network level (this doesn't spin up a separate per-area room) — this UI
 * only *renders* tiles for people whose synced areaId currently matches yours,
 * same as the audio-visible-to-everyone-but-attenuated-by-distance model the
 * zone voice already uses. A future ambient (WorkAdventure-style) proximity
 * upgrade is a separate, larger change (dynamic per-cluster rooms).
 */
export class MeetingAreaUI {
  private readonly panel: HTMLDivElement;
  private readonly rosterEl: HTMLDivElement;
  private readonly tilesEl: HTMLDivElement;
  private readonly camBtn: HTMLButtonElement;
  private readonly shareBtn: HTMLButtonElement;
  private readonly tiles = new Map<string, HTMLDivElement>();
  private currentAreaId: number | null = null;
  private currentMemberIds = new Set<number>();

  constructor(private readonly voice: ZoneVoice) {
    injectMeetingAreaStyles();
    this.panel = document.createElement('div');
    this.panel.id = 'pa-meeting';
    this.panel.style.display = 'none';

    const header = document.createElement('div');
    header.className = 'pa-meet-head';
    const title = document.createElement('span');
    title.textContent = '🤝 Meeting area';
    header.appendChild(title);
    this.panel.appendChild(header);

    this.rosterEl = document.createElement('div');
    this.rosterEl.className = 'pa-meet-roster';
    this.panel.appendChild(this.rosterEl);

    const controls = document.createElement('div');
    controls.className = 'pa-meet-controls';
    this.camBtn = document.createElement('button');
    this.camBtn.textContent = '🎥 Camera';
    this.camBtn.onclick = () => void this.voice.setCameraEnabled(!this.voice.isCameraOn).then(() => this.updateButtons());
    this.shareBtn = document.createElement('button');
    this.shareBtn.textContent = '🖥️ Share screen';
    this.shareBtn.onclick = () => void this.voice.setScreenShareEnabled(!this.voice.isScreenShareOn).then(() => this.updateButtons());
    controls.append(this.camBtn, this.shareBtn);
    this.panel.appendChild(controls);

    this.tilesEl = document.createElement('div');
    this.tilesEl.className = 'pa-meet-tiles';
    this.panel.appendChild(this.tilesEl);

    document.body.appendChild(this.panel);
  }

  /** Call every frame/tick with the local player's current area id (null =
   *  not in one) and everyone ELSE currently in that same area. */
  update(areaId: number | null, others: MeetingParticipant[]): void {
    if (areaId === null) {
      if (this.currentAreaId !== null) this.leaveMeeting();
      this.currentAreaId = null;
      return;
    }
    const entering = areaId !== this.currentAreaId;
    this.currentAreaId = areaId;
    this.currentMemberIds = new Set(others.map((o) => o.id));
    this.renderRoster(others);
    if (entering) this.enterMeeting();
  }

  private enterMeeting(): void {
    this.panel.style.display = 'flex';
    this.voice.setVideoHandlers({
      onLocalCamera: (el) => this.setTile('local-cam', 'You', el),
      onLocalScreenShare: (el) => this.setTile('local-share', 'You (screen)', el),
      onRemoteCamera: (identity, el) => this.setRemoteTile(identity, 'cam', 'Camera', el),
      onRemoteScreenShare: (identity, el) => this.setRemoteTile(identity, 'share', 'Screen', el),
    });
    if (!this.voice.isEnabled) this.voice.join();
    this.updateButtons();
  }

  private leaveMeeting(): void {
    this.panel.style.display = 'none';
    this.voice.setVideoHandlers(null); // also stops camera/share (see ZoneVoice.setVideoHandlers)
    for (const tile of this.tiles.values()) tile.remove();
    this.tiles.clear();
    this.updateButtons();
  }

  /** Client-side privacy filter: only render a tile if the track owner is
   *  currently in MY area (per the synced areaId roster), even though the
   *  LiveKit track itself is subscribable zone-wide. */
  private setRemoteTile(identity: string, kind: 'cam' | 'share', label: string, el: HTMLVideoElement | null): void {
    const playerId = parsePlayerId(identity);
    if (playerId === null || !this.currentMemberIds.has(playerId)) {
      el?.remove();
      return;
    }
    this.setTile(`${identity}-${kind}`, label, el);
  }

  private setTile(key: string, label: string, el: HTMLVideoElement | null): void {
    const existing = this.tiles.get(key);
    if (!el) {
      existing?.remove();
      this.tiles.delete(key);
      return;
    }
    if (existing) {
      existing.replaceChildren(el, existing.lastElementChild!);
      return;
    }
    const tile = document.createElement('div');
    tile.className = 'pa-meet-tile';
    const cap = document.createElement('div');
    cap.className = 'pa-meet-tile-label';
    cap.textContent = label;
    tile.append(el, cap);
    this.tilesEl.appendChild(tile);
    this.tiles.set(key, tile);
  }

  private renderRoster(others: MeetingParticipant[]): void {
    this.rosterEl.textContent =
      others.length === 0 ? "You're the only one here" : `With you: ${others.map((o) => o.name).join(', ')}`;
  }

  private updateButtons(): void {
    this.camBtn.classList.toggle('on', this.voice.isCameraOn);
    this.shareBtn.classList.toggle('on', this.voice.isScreenShareOn);
  }
}

function injectMeetingAreaStyles(): void {
  if (document.getElementById('pa-meeting-style')) return;
  const s = document.createElement('style');
  s.id = 'pa-meeting-style';
  s.textContent = `
    #pa-meeting{position:fixed;right:0.75rem;bottom:0.75rem;z-index:59;flex-direction:column;gap:0.5rem;
      width:20rem;max-height:60vh;background:#1c1a19;border:2px solid #0a0908;border-radius:0.5rem;
      padding:0.7rem;color:#f1efec;font-family:'FS Pixel Sans',ui-monospace,monospace;font-size:0.85rem;
      box-shadow:inset 0 0 0 1px rgba(255,255,255,.04),0 4px 18px rgba(0,0,0,.45);overflow:hidden;}
    #pa-meeting .pa-meet-head{font-weight:bold;}
    #pa-meeting .pa-meet-roster{color:#c8c5c0;font-size:0.78rem;line-height:1.4;}
    #pa-meeting .pa-meet-controls{display:flex;gap:0.4rem;}
    #pa-meeting .pa-meet-controls button{flex:1;cursor:pointer;background:#262422;border:2px solid #0a0908;
      color:#f1efec;border-radius:0.35rem;font:0.78rem 'FS Pixel Sans',monospace;padding:0.4rem 0.3rem;
      box-shadow:inset 0 2px 0 #4a4744,inset 0 -3px 0 #050505;}
    #pa-meeting .pa-meet-controls button.on{background:#1a6b3f;box-shadow:inset 0 2px 0 #3ecb7d,inset 0 -3px 0 #0a3d24;}
    #pa-meeting .pa-meet-tiles{display:grid;grid-template-columns:repeat(2,1fr);gap:0.4rem;overflow-y:auto;}
    #pa-meeting .pa-meet-tile{position:relative;aspect-ratio:4/3;background:#0a0908;border-radius:0.3rem;overflow:hidden;}
    #pa-meeting .pa-meet-tile video{display:block;width:100%;height:100%;}
    #pa-meeting .pa-meet-tile-label{position:absolute;left:0.25rem;bottom:0.2rem;font-size:0.65rem;
      color:#fff;text-shadow:0 0 3px #000,0 0 3px #000;pointer-events:none;}
  `;
  document.head.appendChild(s);
}
