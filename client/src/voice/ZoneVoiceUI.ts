import {
  ZoneVoice,
  type Peer,
  type ZoneVoiceDevices,
  type ZoneVoiceHooks,
  type ZoneVoiceState,
} from './ZoneVoice.js';

/** ZoneVoiceUI hooks = the ZoneVoice hooks plus a UI-only callback the scene
 *  uses to reflect live state on the Audio top-bar button. */
type VoiceBarState = { connected: boolean; micOn: boolean; deafened: boolean };
type ZoneVoiceUIHooks = ZoneVoiceHooks & {
  onStateChange?: (s: VoiceBarState) => void;
  /** Called at ~20 Hz with the live mic input level (0..1). Zero when disconnected. */
  onMicLevel?: (level: number) => void;
};

/**
 * Audio panel for zone voice (rendered into the shared menu popover the scene
 * supplies). A master "Voice communication" toggle (join/leave), device pickers,
 * mic-sensitivity + volume sliders with a live level meter, a proximity switch,
 * and a per-participant list. Mic-mute / silence-others are surfaced as
 * quick-access buttons in the top bar by the scene (via onStateChange). Owns a
 * {@link ZoneVoice} instance and renders its state/peers; the scene feeds it
 * tokens + avatar positions.
 */
export class ZoneVoiceUI {
  readonly voice: ZoneVoice;

  private masterTrack!: HTMLElement;
  private masterKnob!: HTMLElement;
  private masterDot!: HTMLElement;
  private liveHint!: HTMLElement;
  private subWrap!: HTMLElement;
  private devicesEl!: HTMLElement;
  private peersEl!: HTMLElement;
  private masterEl!: HTMLInputElement;
  private proxEl!: HTMLInputElement;
  private micSel!: HTMLSelectElement;
  private spkSel!: HTMLSelectElement;
  private micGainEl!: HTMLInputElement;
  private threshEl!: HTMLInputElement;
  private meterLvl!: HTMLElement;
  private meterThr!: HTMLElement;
  private lastState: ZoneVoiceState;
  /** Live per-peer row elements, keyed by identity, so re-renders update in
   *  place (rebuilding would drop the slider a user is mid-drag on). */
  private readonly peerRows = new Map<
    string,
    { row: HTMLElement; nm: HTMLElement; pct: HTMLElement; vol: HTMLInputElement; mute: HTMLButtonElement }
  >();
  private readonly onStateChange?: (s: VoiceBarState) => void;
  private readonly onMicLevelCb?: (level: number) => void;

  constructor(mount: HTMLElement, hooks: ZoneVoiceUIHooks) {
    this.onStateChange = hooks.onStateChange;
    this.onMicLevelCb = hooks.onMicLevel;
    this.voice = new ZoneVoice(
      hooks,
      (s) => this.renderState(s),
      (peers) => this.renderPeers(peers),
      (devices) => this.renderDevices(devices),
      (level) => { this.renderMicLevel(level); this.onMicLevelCb?.(level); },
    );
    this.lastState = this.voice.state;
    this.injectStyles();
    this.buildPanel(mount);
    this.renderState(this.voice.state);
    this.renderPeers([]);
  }

  /** Connect now if the user left zone voice enabled last session. */
  start(): void {
    this.voice.autoStart();
  }

  /** Route a server 'zoneVoiceToken' reply to the voice client. */
  onToken(msg: { url?: string; token?: string; error?: string }): void {
    void this.voice.onToken(msg);
  }

  // ---- DOM ----

  private injectStyles(): void {
    if (document.getElementById('pa-zv-style')) return;
    const style = document.createElement('style');
    style.id = 'pa-zv-style';
    style.textContent = `
      #pa-zv-master{display:flex;align-items:center;justify-content:space-between;gap:0.75rem;padding:0.7rem 0.8rem;
        background:#141312;border:2px solid #0a0908;border-radius:0.5rem;}
      #pa-zv-master .ti{min-width:0;}
      #pa-zv-master .title{display:flex;align-items:center;gap:0.45rem;font-size:1rem;color:#f1efec;}
      #pa-zv-master .dot{width:0.5rem;height:0.5rem;border-radius:50%;background:#525556;}
      #pa-zv-master .dot.live{background:#5aa348;box-shadow:0 0 6px #5aa348;}
      #pa-zv-master .hint{font-size:0.78rem;color:#818586;margin-top:0.2rem;}
      #pa-zv-track{flex:none;width:3.4rem;height:1.75rem;border-radius:1rem;border:2px solid #0a0908;cursor:pointer;
        position:relative;background:#302d2a;box-shadow:inset 0 2px 0 #423f3b,inset 0 -2px 0 #141312;transition:background .15s;}
      #pa-zv-track.on{background:#3e7a30;box-shadow:inset 0 2px 0 #6fae5c,inset 0 -3px 0 #1f3f18;}
      #pa-zv-track .knob{position:absolute;top:50%;left:1px;transform:translateY(-50%);width:1.25rem;height:1.25rem;border-radius:50%;
        background:#f5f3f0;box-shadow:0 2px 3px rgba(0,0,0,.5);transition:left .15s;}
      #pa-zv-track.on .knob{left:1.6rem;}
      #pa-zv-sub{margin-top:0.65rem;}
      #pa-zv-sub.off{opacity:.4;pointer-events:none;filter:grayscale(.4);}
      #pa-zv-devices{margin-top:0.2rem;}
      #pa-zv-devices .row,#pa-zv-sub .row{display:flex;align-items:center;gap:0.55rem;margin:0.45rem 0;font-size:0.9rem;}
      #pa-zv-devices .row label,#pa-zv-sub .row label{flex:0 0 auto;min-width:4rem;color:#adb0b2;}
      #pa-zv-sub input[type=range]{flex:1;accent-color:#c51a1b;}
      #pa-zv-devices select{flex:1;min-width:0;background:#262422;border:2px solid #0a0908;color:#f1efec;
        border-radius:0.35rem;padding:0.4rem 0.4rem;font:0.85rem 'FS Pixel Sans',monospace;box-shadow:inset 0 2px 0 #4a4744;}
      #pa-zv-devices select:disabled{opacity:0.5;}
      #pa-zv-meter{position:relative;flex:1;height:0.6rem;background:#141312;border:2px solid #0a0908;
        border-radius:0.3rem;overflow:hidden;}
      #pa-zv-meter .lvl{position:absolute;left:0;top:0;bottom:0;width:0;background:#6b7280;transition:width .05s linear;}
      #pa-zv-meter .lvl.on{background:#5aa348;}
      #pa-zv-meter .thr{position:absolute;top:0;bottom:0;width:2px;background:#e7da00;}
      #pa-zv-prox{display:flex;align-items:center;gap:0.5rem;margin-top:0.7rem;font-size:0.9rem;color:#cac8c3;cursor:pointer;}
      #pa-zv-prox input{accent-color:#3e7a30;width:1rem;height:1rem;}
      #pa-zv-sub .subhint{font-size:0.78rem;color:#818586;margin-top:0.35rem;line-height:1.5;}
      #pa-zv-peers{margin-top:0.7rem;border-top:1px solid #2c2a28;padding-top:0.6rem;}
      #pa-zv-peers .pr{display:flex;flex-direction:column;gap:0.4rem;margin:0.45rem 0;padding:0.5rem 0.55rem;
        background:#141312;border:2px solid #0a0908;border-radius:0.45rem;}
      #pa-zv-peers .pr .top{display:flex;align-items:center;gap:0.5rem;}
      #pa-zv-peers .pr .nm{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:0.9rem;color:#f0eeea;}
      #pa-zv-peers .pr .pct{min-width:2.6rem;text-align:right;font-size:0.78rem;color:#adb0b2;}
      #pa-zv-peers .pr button{cursor:pointer;background:#262422;border:2px solid #0a0908;color:#d7d5d1;
        border-radius:0.3rem;font:0.85rem 'FS Pixel Sans',monospace;padding:0.2rem 0.45rem;box-shadow:inset 0 2px 0 #4a4744,inset 0 -3px 0 #050505;}
      #pa-zv-peers .pr button.muted{background:#7c2634;border-color:#0a0908;color:#f6cdd4;box-shadow:inset 0 2px 0 #b34a5a,inset 0 -3px 0 #45111a;}
      #pa-zv-peers .pr button .ico{position:relative;display:inline-block;line-height:1;}
      #pa-zv-peers .pr button.muted .ico::after{content:'';position:absolute;left:-12%;top:44%;width:124%;height:0.16em;
        background:#ff5b6b;border-radius:1px;transform:rotate(-24deg);box-shadow:0 0 0 1px rgba(0,0,0,.55);}
      /* Pixel-styled per-peer volume slider (Chrome + Firefox). */
      #pa-zv-peers input[type=range]{-webkit-appearance:none;appearance:none;width:100%;height:0.6rem;background:transparent;cursor:pointer;}
      #pa-zv-peers input[type=range]::-webkit-slider-runnable-track{height:0.6rem;background:#262422;border:2px solid #0a0908;
        border-radius:0.3rem;box-shadow:inset 0 2px 0 #4a4744;}
      #pa-zv-peers input[type=range]::-webkit-slider-thumb{-webkit-appearance:none;appearance:none;margin-top:-0.32rem;
        width:0.95rem;height:1.15rem;background:#c51a1b;border:2px solid #0a0908;border-radius:0.25rem;
        box-shadow:inset 0 2px 0 #e2585a,inset 0 -3px 0 #5c0f10;}
      #pa-zv-peers input[type=range]::-moz-range-track{height:0.6rem;background:#262422;border:2px solid #0a0908;border-radius:0.3rem;}
      #pa-zv-peers input[type=range]::-moz-range-thumb{width:0.95rem;height:1.15rem;background:#c51a1b;border:2px solid #0a0908;
        border-radius:0.25rem;box-shadow:inset 0 2px 0 #e2585a,inset 0 -3px 0 #5c0f10;}
      #pa-zv-peers .empty{color:#818586;font-size:0.85rem;}
    `;
    document.head.appendChild(style);
  }

  private buildPanel(mount: HTMLElement): void {
    // Master "Voice communication" toggle = join / leave the zone's voice room.
    const master = document.createElement('div');
    master.id = 'pa-zv-master';
    master.innerHTML = `
      <div class="ti">
        <div class="title"><span class="dot"></span>Voice communication</div>
        <div class="hint"></div>
      </div>
      <div id="pa-zv-track"><div class="knob"></div></div>`;
    this.masterDot = master.querySelector('.dot')!;
    this.liveHint = master.querySelector('.hint')!;
    this.masterTrack = master.querySelector('#pa-zv-track')!;
    this.masterKnob = master.querySelector('.knob')!;
    this.masterTrack.addEventListener('click', () => {
      if (this.voice.isEnabled) this.voice.leave();
      else this.voice.join();
    });

    // Independent controls, greyed out until voice is connected.
    const sub = document.createElement('div');
    sub.id = 'pa-zv-sub';
    sub.innerHTML = `
      <div id="pa-zv-devices">
        <div class="row"><label>Mic</label><select id="pa-zv-mic"></select></div>
        <div class="row"><label>Speaker</label><select id="pa-zv-spk"></select></div>
        <div class="row"><label>Mic sens.</label><input id="pa-zv-micgain" type="range" min="0" max="200"></div>
        <div class="row"><label>Volume</label><input id="pa-zv-master-vol" type="range" min="0" max="200"></div>
        <div class="row"><label>Threshold</label><input id="pa-zv-thresh" type="range" min="0" max="100"></div>
        <div class="row"><label>Level</label><div id="pa-zv-meter"><div class="lvl"></div><div class="thr"></div></div></div>
      </div>
      <label id="pa-zv-prox"><input type="checkbox"> Proximity chat</label>
      <p class="subhint">Nearby players sound louder; distant ones fade out.</p>
      <div id="pa-zv-peers"></div>`;

    this.subWrap = sub;
    this.devicesEl = sub.querySelector('#pa-zv-devices')!;
    this.peersEl = sub.querySelector('#pa-zv-peers')!;
    this.masterEl = sub.querySelector('#pa-zv-master-vol')!;
    this.proxEl = sub.querySelector('#pa-zv-prox input')!;
    this.micSel = sub.querySelector('#pa-zv-mic')!;
    this.spkSel = sub.querySelector('#pa-zv-spk')!;
    this.micGainEl = sub.querySelector('#pa-zv-micgain')!;
    this.threshEl = sub.querySelector('#pa-zv-thresh')!;
    this.meterLvl = sub.querySelector('#pa-zv-meter .lvl')!;
    this.meterThr = sub.querySelector('#pa-zv-meter .thr')!;

    this.micGainEl.addEventListener('input', () => this.voice.setMicSensitivity(Number(this.micGainEl.value) / 100));
    this.threshEl.addEventListener('input', () => this.voice.setMicThreshold(Number(this.threshEl.value) / 100));
    this.masterEl.addEventListener('input', () => this.voice.setMaster(Number(this.masterEl.value) / 100));
    this.proxEl.addEventListener('change', () => this.voice.setProximity(this.proxEl.checked));
    this.micSel.addEventListener('change', () => void this.voice.switchMic(this.micSel.value));
    this.spkSel.addEventListener('change', () => void this.voice.switchSpeaker(this.spkSel.value));

    mount.append(master, sub);
    this.renderDevices({ mics: [], speakers: [] });
  }

  // ---- rendering ----

  private renderState(s: ZoneVoiceState): void {
    this.lastState = s;
    const connected = s.connected;
    const enabled = this.voice.isEnabled;

    // Master toggle reflects "enabled" (join intent); dot lights when connected.
    this.masterTrack.classList.toggle('on', enabled);
    this.masterDot.classList.toggle('live', connected);
    this.liveHint.textContent = connected
      ? s.micOn && !s.deafened
        ? 'On — you can talk and hear others'
        : s.deafened && !s.micOn
          ? 'On — mic muted and others silenced'
          : s.deafened
            ? 'On — others are silenced'
            : 'On — your mic is muted'
      : s.connecting
        ? 'Connecting…'
        : 'Off — no audio in or out';

    // The sub-controls need a live room; grey them out otherwise.
    this.subWrap.classList.toggle('off', !connected);

    this.micGainEl.value = String(Math.round(s.micGain * 100));
    this.threshEl.value = String(Math.round(s.micThreshold * 100));
    this.meterThr.style.left = `${Math.round(s.micThreshold * 100)}%`;
    this.masterEl.value = String(Math.round(s.master * 100));
    this.proxEl.checked = s.proximity;

    this.onStateChange?.({ connected, micOn: s.micOn, deafened: s.deafened });
  }

  /** Live mic input level (0..1) → meter fill; green above threshold, dim below. */
  private renderMicLevel(level: number): void {
    if (!this.meterLvl) return;
    this.meterLvl.style.width = `${Math.round(level * 100)}%`;
    const open = level >= this.lastState.micThreshold && this.lastState.micThreshold >= 0;
    this.meterLvl.classList.toggle('on', open && level > 0.001);
  }

  private renderDevices(d: ZoneVoiceDevices): void {
    this.fillSelect(this.micSel, d.mics, d.micId);
    this.fillSelect(this.spkSel, d.speakers, d.speakerId);
  }

  private fillSelect(sel: HTMLSelectElement, devices: MediaDeviceInfo[], activeId?: string): void {
    sel.replaceChildren();
    sel.disabled = devices.length === 0;
    if (devices.length === 0) {
      const o = document.createElement('option');
      o.value = '';
      o.textContent = '—';
      sel.appendChild(o);
      return;
    }
    devices.forEach((dev, i) => {
      const o = document.createElement('option');
      o.value = dev.deviceId;
      o.textContent = dev.label || `Device ${i + 1}`;
      if (dev.deviceId === activeId) o.selected = true;
      sel.appendChild(o);
    });
  }

  private renderPeers(peers: Peer[]): void {
    if (peers.length === 0) {
      this.peerRows.clear();
      this.peersEl.replaceChildren();
      const empty = document.createElement('div');
      empty.className = 'empty';
      empty.textContent = this.lastState.connected ? 'No one else here yet.' : 'Not connected.';
      this.peersEl.appendChild(empty);
      return;
    }
    this.peersEl.querySelector('.empty')?.remove();
    const seen = new Set<string>();
    for (const p of peers) {
      seen.add(p.identity);
      let e = this.peerRows.get(p.identity);
      if (!e) {
        e = this.createPeerRow(p.identity);
        this.peerRows.set(p.identity, e);
        this.peersEl.appendChild(e.row);
      }
      e.nm.textContent = p.name;
      e.mute.classList.toggle('muted', p.muted);
      e.mute.title = p.muted ? 'Unmute this user' : 'Mute this user';
      // Don't stomp the slider a user is actively dragging (its input handler
      // keeps the value + % readout current). Refresh others from state.
      if (document.activeElement !== e.vol) {
        const pct = Math.round(p.volume * 100);
        e.vol.value = String(pct);
        e.pct.textContent = `${pct}%`;
      }
    }
    for (const [id, e] of this.peerRows) {
      if (!seen.has(id)) {
        e.row.remove();
        this.peerRows.delete(id);
      }
    }
  }

  /** One peer row (mute + name + % on top, a volume slider below). Handlers read
   *  live DOM/input state so the row survives in-place re-renders. */
  private createPeerRow(identity: string): {
    row: HTMLElement;
    nm: HTMLElement;
    pct: HTMLElement;
    vol: HTMLInputElement;
    mute: HTMLButtonElement;
  } {
    const row = document.createElement('div');
    row.className = 'pr';
    const top = document.createElement('div');
    top.className = 'top';
    // Mute keeps the speaker glyph and gains a red slash (CSS) when muted.
    const mute = document.createElement('button');
    mute.innerHTML = '<span class="ico">🔊</span>';
    mute.addEventListener('click', () => this.voice.setPeerMuted(identity, !mute.classList.contains('muted')));
    const nm = document.createElement('span');
    nm.className = 'nm';
    const pct = document.createElement('span');
    pct.className = 'pct';
    top.append(mute, nm, pct);

    const vol = document.createElement('input');
    vol.type = 'range';
    vol.min = '0';
    vol.max = '200';
    vol.title = 'Volume';
    vol.addEventListener('input', () => {
      this.voice.setPeerVolume(identity, Number(vol.value) / 100);
      pct.textContent = `${vol.value}%`;
    });

    row.append(top, vol);
    return { row, nm, pct, vol, mute };
  }
}
