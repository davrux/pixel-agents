import {
  ZoneVoice,
  type Peer,
  type ZoneVoiceDevices,
  type ZoneVoiceHooks,
  type ZoneVoiceState,
} from './ZoneVoice.js';

/**
 * Top-bar UI for zone voice (sits next to the main menu). A Join/Leave toggle, a
 * mic mute/unmute icon, and a popover with master volume, a proximity switch and
 * a per-participant list (mute + volume). Owns a {@link ZoneVoice} instance and
 * renders its state/peers; the scene feeds it tokens + avatar positions.
 */
export class ZoneVoiceUI {
  readonly voice: ZoneVoice;

  private voiceBtn!: HTMLButtonElement;
  private micBtn!: HTMLButtonElement;
  private deafenBtn!: HTMLButtonElement;
  private gearBtn!: HTMLButtonElement;
  private popover!: HTMLElement;
  private devicesEl!: HTMLElement;
  private peersEl!: HTMLElement;
  private masterEl!: HTMLInputElement;
  private proxEl!: HTMLInputElement;
  private micSel!: HTMLSelectElement;
  private spkSel!: HTMLSelectElement;
  private micGainEl!: HTMLInputElement;
  private open = false;
  private lastState: ZoneVoiceState;

  constructor(mount: HTMLElement, hooks: ZoneVoiceHooks) {
    this.voice = new ZoneVoice(
      hooks,
      (s) => this.renderState(s),
      (peers) => this.renderPeers(peers),
      (devices) => this.renderDevices(devices),
    );
    this.lastState = this.voice.state;
    this.injectStyles();
    this.buildButtons(mount);
    this.buildPopover();
    this.renderState(this.voice.state);

    // Close the popover when clicking anywhere outside it (but not when clicking
    // the gear that opens it).
    document.addEventListener('click', (e) => {
      if (!this.open) return;
      const t = e.target as Node;
      if (this.popover.contains(t) || this.gearBtn.contains(t)) return;
      this.open = false;
      this.popover.classList.remove('open');
    });
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
      #pa-zv-grp{display:flex;gap:0.3rem;align-items:stretch;}
      #pa-zv-grp button{cursor:pointer;background:#1b1f2a;border:2px solid #3a4150;border-radius:0.4rem;
        color:#eef1f6;font:inherit;font-size:1rem;padding:0.2rem 0.5rem;}
      #pa-zv-grp button:hover{background:#262c3a;}
      #pa-zv-grp button.on{background:#23402e;border-color:#3f7a52;color:#bdf0cd;}
      #pa-zv-grp button.live{background:#2e4636;border-color:#4caf73;color:#d6ffe2;}
      #pa-zv-grp button.off{background:#46302e;border-color:#7a3f3f;color:#f0bdbd;}
      #pa-zv-grp button.micoff .mi{position:relative;}
      #pa-zv-grp button.micoff .mi::after{content:'';position:absolute;left:-15%;top:45%;width:130%;height:0.14em;
        background:#f0696e;transform:rotate(-20deg);border-radius:1px;}
      #pa-zv-grp button:disabled{opacity:0.45;cursor:default;}
      #pa-zv-pop{position:fixed;top:3.4rem;right:0.5rem;z-index:61;width:18rem;display:none;
        background:#1b1f2af2;border:2px solid #3a4150;border-radius:0.5rem;padding:0.6rem 0.7rem;
        font-family:'FS Pixel Sans',ui-monospace,monospace;color:#eef1f6;font-size:1rem;}
      #pa-zv-pop.open{display:block;}
      #pa-zv-pop h4{margin:0 0 0.5rem;font-size:1.15rem;color:#cdd3dd;}
      #pa-zv-pop .row{display:flex;align-items:center;gap:0.5rem;margin:0.35rem 0;}
      #pa-zv-pop .row label{flex:0 0 auto;min-width:3.2rem;color:#aab2c0;font-size:0.9rem;}
      #pa-zv-pop input[type=range]{flex:1;}
      #pa-zv-pop select{flex:1;min-width:0;background:#11151d;border:1px solid #3a4150;color:#eef1f6;
        border-radius:0.3rem;padding:0.25rem 0.3rem;font:0.85rem 'FS Pixel Sans',monospace;}
      #pa-zv-pop select:disabled{opacity:0.5;}
      #pa-zv-pop .hint{color:#8b93a1;font-size:0.8rem;margin:0.1rem 0 0.4rem;}
      #pa-zv-peers{margin-top:0.4rem;border-top:1px solid #3a4150;padding-top:0.4rem;
        max-height:14rem;overflow-y:auto;}
      #pa-zv-peers .pr{display:flex;align-items:center;gap:0.4rem;margin:0.25rem 0;}
      #pa-zv-peers .pr .nm{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:0.9rem;}
      #pa-zv-peers .pr input[type=range]{flex:0 0 5rem;}
      #pa-zv-peers .pr button{cursor:pointer;background:#2a2f3a;border:1px solid #3a4150;color:#cdd3dd;
        border-radius:0.3rem;font:inherit;font-size:0.8rem;padding:0.1rem 0.4rem;}
      #pa-zv-peers .pr button.muted{background:#46302e;border-color:#7a3f3f;color:#f0bdbd;}
      #pa-zv-peers .empty{color:#8b93a1;font-size:0.85rem;}
    `;
    document.head.appendChild(style);
  }

  private buildButtons(mount: HTMLElement): void {
    const grp = document.createElement('span');
    grp.id = 'pa-zv-grp';

    this.voiceBtn = document.createElement('button');
    this.voiceBtn.title = 'Join / leave this zone’s voice chat';
    this.voiceBtn.addEventListener('click', () => {
      if (this.voice.isEnabled) this.voice.leave();
      else this.voice.join();
    });

    this.micBtn = document.createElement('button');
    this.micBtn.title = 'Mute / unmute your microphone';
    this.micBtn.addEventListener('click', () => this.voice.toggleMic());

    this.deafenBtn = document.createElement('button');
    this.deafenBtn.title = 'Silence everyone / un-silence (deafen)';
    this.deafenBtn.addEventListener('click', () => this.voice.toggleDeafen());

    this.gearBtn = document.createElement('button');
    this.gearBtn.textContent = '▾'; // ▾
    this.gearBtn.title = 'Voice settings';
    this.gearBtn.addEventListener('click', () => this.togglePopover());

    grp.append(this.voiceBtn, this.micBtn, this.deafenBtn, this.gearBtn);
    // Prepend so it sits at the left of the always-visible menubar, separate
    // from the collapsible ☰ button row.
    mount.insertBefore(grp, mount.firstChild);
  }

  private buildPopover(): void {
    this.popover = document.createElement('div');
    this.popover.id = 'pa-zv-pop';
    this.popover.innerHTML = `
      <h4>Zone voice</h4>
      <div id="pa-zv-devices">
        <div class="row"><label>Mic</label><select id="pa-zv-mic"></select></div>
        <div class="row"><label>Speaker</label><select id="pa-zv-spk"></select></div>
        <div class="row"><label>Mic sens.</label><input id="pa-zv-micgain" type="range" min="0" max="200"></div>
      </div>
      <div class="row"><label>Volume</label><input id="pa-zv-master" type="range" min="0" max="100"></div>
      <div class="row"><label><input id="pa-zv-prox" type="checkbox"> Proximity</label></div>
      <div class="hint">Nearby players sound louder; distant ones fade out.</div>
      <div id="pa-zv-peers"></div>
    `;
    document.body.appendChild(this.popover);
    this.devicesEl = this.popover.querySelector('#pa-zv-devices')!;
    this.peersEl = this.popover.querySelector('#pa-zv-peers')!;
    this.masterEl = this.popover.querySelector('#pa-zv-master')!;
    this.proxEl = this.popover.querySelector('#pa-zv-prox')!;
    this.micSel = this.popover.querySelector('#pa-zv-mic')!;
    this.spkSel = this.popover.querySelector('#pa-zv-spk')!;
    this.micGainEl = this.popover.querySelector('#pa-zv-micgain')!;
    this.micGainEl.addEventListener('input', () => this.voice.setMicSensitivity(Number(this.micGainEl.value) / 100));
    this.masterEl.addEventListener('input', () => this.voice.setMaster(Number(this.masterEl.value) / 100));
    this.proxEl.addEventListener('change', () => this.voice.setProximity(this.proxEl.checked));
    this.micSel.addEventListener('change', () => void this.voice.switchMic(this.micSel.value));
    this.spkSel.addEventListener('change', () => void this.voice.switchSpeaker(this.spkSel.value));
    this.renderDevices({ mics: [], speakers: [] });
  }

  private togglePopover(): void {
    this.open = !this.open;
    this.popover.classList.toggle('open', this.open);
    if (this.open) this.positionPopover();
  }

  /** Anchor the popover directly under the gear button (right-aligned to it). */
  private positionPopover(): void {
    const r = this.gearBtn.getBoundingClientRect();
    const w = this.popover.offsetWidth || 288;
    this.popover.style.left = `${Math.max(8, r.right - w)}px`;
    this.popover.style.right = 'auto';
    this.popover.style.top = `${r.bottom + 6}px`;
  }

  // ---- rendering ----

  private renderState(s: ZoneVoiceState): void {
    this.lastState = s;
    const connected = s.connected;
    this.voiceBtn.textContent = connected ? '🔊 Voice' : s.connecting ? '… Voice' : '🔇 Voice';
    this.voiceBtn.classList.toggle('on', connected || s.connecting);
    this.voiceBtn.title = this.voice.isEnabled ? 'Leave this zone’s voice chat' : 'Join this zone’s voice chat';

    this.micBtn.style.display = connected ? '' : 'none';
    // Strike the mic glyph through when muted (the label stays readable).
    this.micBtn.innerHTML = `<span class="mi">🎤</span> ${s.micOn ? 'Live' : 'Muted'}`;
    this.micBtn.classList.toggle('live', s.micOn);
    this.micBtn.classList.toggle('micoff', !s.micOn);

    // Deafen = silence everyone you hear (independent of your mic).
    this.deafenBtn.style.display = connected ? '' : 'none';
    this.deafenBtn.textContent = s.deafened ? '🔇 Silenced' : '🔊 Sound';
    this.deafenBtn.classList.toggle('off', s.deafened);

    // Mic/Speaker pickers only make sense once connected (devices need the live
    // room + mic permission); hide them otherwise.
    this.devicesEl.style.display = connected ? '' : 'none';

    this.micGainEl.value = String(Math.round(s.micGain * 100));
    this.masterEl.value = String(Math.round(s.master * 100));
    this.proxEl.checked = s.proximity;
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
    this.peersEl.replaceChildren();
    if (peers.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'empty';
      empty.textContent = this.lastState.connected ? 'No one else here yet.' : 'Not connected.';
      this.peersEl.appendChild(empty);
      return;
    }
    for (const p of peers) {
      const row = document.createElement('div');
      row.className = 'pr';
      const nm = document.createElement('span');
      nm.className = 'nm';
      nm.textContent = p.name;
      const vol = document.createElement('input');
      vol.type = 'range';
      vol.min = '0';
      vol.max = '100';
      vol.value = String(Math.round(p.volume * 100));
      vol.addEventListener('input', () => this.voice.setPeerVolume(p.identity, Number(vol.value) / 100));
      const mute = document.createElement('button');
      mute.textContent = p.muted ? '🔇' : '🔊';
      mute.classList.toggle('muted', p.muted);
      mute.title = p.muted ? 'Unmute this user' : 'Mute this user';
      mute.addEventListener('click', () => this.voice.setPeerMuted(p.identity, !p.muted));
      row.append(nm, vol, mute);
      this.peersEl.appendChild(row);
    }
  }
}
