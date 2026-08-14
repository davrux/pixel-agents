import { getAudioSettings, onAudioSettingsChange, setAudioSettings } from './audioSettings.js';
import { MAX_MIC_GAIN, MicGraph } from './micGraph.js';

/**
 * The Audio panel: the viewer's microphone and playback settings, and nothing
 * else.
 *
 * It used to be zone voice's control panel — a join/leave toggle, a proximity
 * switch and a peer list wrapped around the sliders — so the settings only
 * existed while that call did. Zone voice is gone (conversations happen in
 * meeting areas now), but the settings are not a property of any one call: they
 * are this viewer's microphone and this viewer's speakers, so they live here on
 * their own and apply to whatever you are in. Everything written here goes
 * through {@link setAudioSettings}, which persists it AND pushes it into a
 * running meeting — opening this panel mid-conversation and finding the sliders
 * inert would be worse than having no sliders.
 *
 * The level meter has no call to borrow a microphone from when you are not in
 * one, so it offers "Test" instead: an explicit click opens the mic through the
 * very same {@link MicGraph} a meeting would use, so what the meter shows is
 * what the meeting would send. Nothing is captured until that click, and a
 * running meeting feeds the meter directly (see `setMicLevel`) rather than
 * opening the device a second time.
 */
export class AudioSettingsUI {
  private readonly micSel: HTMLSelectElement;
  private readonly spkSel: HTMLSelectElement;
  private readonly micGainEl: HTMLInputElement;
  private readonly masterEl: HTMLInputElement;
  private readonly threshEl: HTMLInputElement;
  private readonly meterLvl: HTMLElement;
  private readonly meterThr: HTMLElement;
  private readonly testBtn: HTMLButtonElement;
  /** Only for the meter's own preview — a meeting never uses this one. */
  private testGraph?: MicGraph;
  /** True while a call is feeding the meter, so Test stays out of its way. */
  private liveFromCall = false;
  private readonly unsub: () => void;

  constructor(mount: HTMLElement) {
    this.injectStyles();
    const root = document.createElement('div');
    root.id = 'pa-as';
    root.innerHTML = `
      <div class="row"><label>Mic</label><select id="pa-as-mic"></select></div>
      <div class="row"><label>Speaker</label><select id="pa-as-spk"></select></div>
      <div class="row"><label>Mic sens.</label><input id="pa-as-micgain" type="range" min="0" max="${MAX_MIC_GAIN * 100}"></div>
      <div class="row"><label>Volume</label><input id="pa-as-master" type="range" min="0" max="200"></div>
      <div class="row"><label>Threshold</label><input id="pa-as-thresh" type="range" min="0" max="100"></div>
      <div class="row"><label>Level</label><div id="pa-as-meter"><div class="lvl"></div><div class="thr"></div></div>
        <button id="pa-as-test" class="pa-b" title="Open the mic to check your level">Test</button></div>
      <p class="hint">Used by every call you join. Below the threshold nothing is
        transmitted, so raise it until the meter stops twitching at silence.</p>`;
    this.micSel = root.querySelector('#pa-as-mic')!;
    this.spkSel = root.querySelector('#pa-as-spk')!;
    this.micGainEl = root.querySelector('#pa-as-micgain')!;
    this.masterEl = root.querySelector('#pa-as-master')!;
    this.threshEl = root.querySelector('#pa-as-thresh')!;
    this.meterLvl = root.querySelector('#pa-as-meter .lvl')!;
    this.meterThr = root.querySelector('#pa-as-meter .thr')!;
    this.testBtn = root.querySelector('#pa-as-test')!;

    this.micGainEl.addEventListener('input', () => {
      const micGain = Number(this.micGainEl.value) / 100;
      setAudioSettings({ micGain });
      this.testGraph?.setGain(micGain);
    });
    this.threshEl.addEventListener('input', () => {
      const micThreshold = Number(this.threshEl.value) / 100;
      setAudioSettings({ micThreshold });
      this.testGraph?.setThreshold(micThreshold);
    });
    this.masterEl.addEventListener('input', () => setAudioSettings({ master: Number(this.masterEl.value) / 100 }));
    this.micSel.addEventListener('change', () => {
      setAudioSettings({ micId: this.micSel.value });
      if (this.testGraph) void this.testGraph.switchDevice(this.micSel.value);
    });
    this.spkSel.addEventListener('change', () => setAudioSettings({ speakerId: this.spkSel.value }));
    this.testBtn.addEventListener('click', () => void this.toggleTest());

    mount.appendChild(root);
    this.render(getAudioSettings());
    // Someone else may change these — the meeting window has its own device
    // pickers, and they write to the same store.
    this.unsub = onAudioSettingsChange((s) => this.render(s));
    void this.refreshDevices();
    navigator.mediaDevices?.addEventListener?.('devicechange', () => void this.refreshDevices());
  }

  /**
   * Live mic level (0..1) from a call, for the meter.
   *
   * A call owns the microphone while it runs, so its level is the truthful one
   * and the Test button steps aside (and stops its own capture) for as long as
   * one is feeding us.
   */
  setMicLevel(level: number | null): void {
    const live = level !== null;
    if (live && this.testGraph) void this.stopTest();
    if (this.liveFromCall !== live) {
      this.liveFromCall = live;
      this.testBtn.disabled = live;
      this.testBtn.title = live ? 'A call is using the mic — this is its live level' : 'Open the mic to check your level';
    }
    this.renderLevel(level ?? 0);
  }

  destroy(): void {
    this.unsub();
    void this.stopTest();
  }

  // ---- mic preview ----

  private async toggleTest(): Promise<void> {
    if (this.testGraph) return void this.stopTest();
    const s = getAudioSettings();
    try {
      this.testGraph = await MicGraph.start({
        deviceId: s.micId || undefined,
        gain: s.micGain,
        threshold: s.micThreshold,
        onLevel: (level) => this.renderLevel(level),
      });
      this.testBtn.classList.add('primary');
      this.testBtn.textContent = 'Stop';
      // Labels are only revealed once permission is granted — now.
      void this.refreshDevices();
    } catch {
      this.testBtn.textContent = 'No mic';
      window.setTimeout(() => (this.testBtn.textContent = 'Test'), 2000);
    }
  }

  private async stopTest(): Promise<void> {
    this.testGraph?.stop();
    this.testGraph = undefined;
    this.testBtn.classList.remove('primary');
    this.testBtn.textContent = 'Test';
    this.renderLevel(0);
  }

  // ---- rendering ----

  private render(s: ReturnType<typeof getAudioSettings>): void {
    // Never stomp the control the user is dragging right now.
    const busy = document.activeElement;
    if (busy !== this.micGainEl) this.micGainEl.value = String(Math.round(s.micGain * 100));
    if (busy !== this.masterEl) this.masterEl.value = String(Math.round(s.master * 100));
    if (busy !== this.threshEl) this.threshEl.value = String(Math.round(s.micThreshold * 100));
    this.meterThr.style.left = `${Math.round(s.micThreshold * 100)}%`;
    if (this.micSel.value !== s.micId) this.micSel.value = s.micId;
    if (this.spkSel.value !== s.speakerId) this.spkSel.value = s.speakerId;
  }

  private renderLevel(level: number): void {
    this.meterLvl.style.width = `${Math.round(level * 100)}%`;
    const { micThreshold } = getAudioSettings();
    this.meterLvl.classList.toggle('on', level > 0.001 && level >= micThreshold);
  }

  /** Devices are only named once a mic permission exists, so this is called
   *  again after Test succeeds — before that the list is real but anonymous. */
  private async refreshDevices(): Promise<void> {
    let devices: MediaDeviceInfo[] = [];
    try {
      devices = await navigator.mediaDevices.enumerateDevices();
    } catch {
      /* no device access (insecure origin, no permission) — leave the "—" rows */
    }
    const s = getAudioSettings();
    this.fillSelect(this.micSel, devices.filter((d) => d.kind === 'audioinput'), s.micId);
    this.fillSelect(this.spkSel, devices.filter((d) => d.kind === 'audiooutput'), s.speakerId);
  }

  private fillSelect(sel: HTMLSelectElement, devices: MediaDeviceInfo[], activeId: string): void {
    sel.replaceChildren();
    sel.disabled = devices.length === 0;
    if (devices.length === 0) {
      sel.appendChild(new Option('—', ''));
      return;
    }
    // "System default" is a real choice, not the absence of one: it follows the
    // OS when someone plugs in a headset mid-call.
    sel.appendChild(new Option('System default', ''));
    devices.forEach((d, i) => sel.appendChild(new Option(d.label || `Device ${i + 1}`, d.deviceId)));
    sel.value = devices.some((d) => d.deviceId === activeId) ? activeId : '';
  }

  private injectStyles(): void {
    if (document.getElementById('pa-as-style')) return;
    const style = document.createElement('style');
    style.id = 'pa-as-style';
    style.textContent = `
      #pa-as .row{display:flex;align-items:center;gap:0.55rem;margin:0.45rem 0;font-size:0.9rem;}
      #pa-as .row label{flex:0 0 auto;min-width:4.5rem;color:#adb0b2;}
      #pa-as input[type=range]{flex:1;accent-color:#c51a1b;min-width:0;}
      #pa-as select{flex:1;min-width:0;background:#262422;border:2px solid #0a0908;color:#f1efec;
        border-radius:0.35rem;padding:0.4rem;font:0.85rem 'FS Pixel Sans',monospace;box-shadow:inset 0 2px 0 #4a4744;}
      #pa-as select:disabled{opacity:0.5;}
      #pa-as-meter{position:relative;flex:1;height:0.6rem;background:#141312;border:2px solid #0a0908;
        border-radius:0.3rem;overflow:hidden;}
      #pa-as-meter .lvl{position:absolute;left:0;top:0;bottom:0;width:0;background:#6b7280;transition:width .05s linear;}
      #pa-as-meter .lvl.on{background:#5aa348;}
      #pa-as-meter .thr{position:absolute;top:0;bottom:0;width:2px;background:#e7da00;}
      #pa-as-test{flex:0 0 auto;padding:0.25rem 0.6rem;font-size:0.8rem;}
      #pa-as .hint{font-size:0.78rem;color:#818586;margin:0.6rem 0 0;line-height:1.5;}
    `;
    document.head.appendChild(style);
  }
}
