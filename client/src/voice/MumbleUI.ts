/**
 * Mumble panel: the server's channel tree with its users, the usual mic /
 * deafen / volume controls, a pin so it can stay open while you play, and a
 * self-register button. Rendered into whatever container the host gives it.
 *
 * Rows are deliberately one line per user (volume is a dropdown, not a slider):
 * a busy channel has to stay readable without scrolling.
 *
 * Desktop only: the constructor renders nothing at all when there is no Mumble
 * client behind it, so the browser build is untouched.
 */
import {
  MumbleVoice,
  type MumbleDevices,
  type MumbleTree,
  type MumbleVoiceState,
} from './MumbleVoice.js';
import type { MumbleChannelInfo, MumbleUserInfo } from '../desktop/bridge.js';
import { MAX_MIC_GAIN } from './micGraph.js';

export interface MumbleUIHooks {
  /** Called when the user joins/leaves, so the scene can park zone voice. */
  onJoin?: () => void;
  onLeave?: () => void;
  /** Open the Settings panel, where the connection details live. */
  onOpenSettings?: () => void;
  /** The user pinned/unpinned the panel; the host decides what that means for
   *  its own menu system (the office exempts it from the one-panel rule). */
  onPinChange?: (pinned: boolean) => void;
}

/** Per-user volume choices. A dropdown keeps each user on one line, where a
 *  slider needed a second row — a channel with a dozen people has to stay
 *  readable without scrolling. */
const VOLUME_STEPS = [0, 0.25, 0.5, 0.75, 1, 1.25, 1.5, 2];

/** A tree row that outlives the snapshot it was built from: the element stays in
 *  the document and `update` folds in fresh data. See renderTree for why the
 *  element has to survive rather than be rebuilt. */
interface ChannelRow {
  el: HTMLElement;
  update(channel: MumbleChannelInfo, userCount: number, depth: number): void;
}
interface UserRow {
  el: HTMLElement;
  update(user: MumbleUserInfo, depth: number, t: MumbleTree): void;
}

export class MumbleUI {
  readonly voice: MumbleVoice | null;

  private track?: HTMLElement;
  private dot?: HTMLElement;
  private hint?: HTMLElement;
  private sub?: HTMLElement;
  private micBtn?: HTMLButtonElement;
  private deafBtn?: HTMLButtonElement;
  private regBtn?: HTMLButtonElement;
  private masterEl?: HTMLInputElement;
  private micGainEl?: HTMLInputElement;
  private gainValEl?: HTMLElement;
  private threshEl?: HTMLInputElement;
  private meterLvl?: HTMLElement;
  private meterThr?: HTMLElement;
  private micSel?: HTMLSelectElement;
  private spkSel?: HTMLSelectElement;
  private treeEl?: HTMLElement;
  private alertsEl?: HTMLInputElement;
  private pinBtn?: HTMLButtonElement;
  /** Rows already in the tree, by channel id and by user session, so a re-render
   *  can update them instead of replacing them — see renderTree. */
  private readonly channelRows = new Map<number, ChannelRow>();
  private readonly userRows = new Map<number, UserRow>();
  private pinned = localStorage.getItem('pa-mb-pinned') === '1';
  private lastState?: MumbleVoiceState;

  constructor(mount: HTMLElement, private readonly hooks: MumbleUIHooks = {}) {
    if (!MumbleVoice.supported) {
      this.voice = null;
      return;
    }
    this.voice = new MumbleVoice(
      (s) => this.renderState(s),
      (t) => this.renderTree(t),
      (d) => this.renderDevices(d),
      (l) => this.renderMicLevel(l),
    );
    this.injectStyles();
    this.build(mount);
    this.renderState(this.voice.state);
    this.renderTree({ channels: [], users: [], talking: new Set(), me: 0 });
  }

  /** Connect now if Mumble was left on last session. */
  start(): void {
    this.voice?.autoStart();
  }

  /** Release the pin — the host calls this when its own close control is used,
   *  so ✕ on a pinned panel means "stop keeping this open" rather than nothing. */
  unpin(): void {
    if (this.pinned) this.setPinned(false);
  }

  /** Whether the user asked for this panel to stay open. False when Mumble is
   *  unavailable, so a browser host never keeps an empty panel docked. */
  get isPinned(): boolean {
    return this.voice !== null && this.pinned;
  }

  /** Re-read settings and reconnect (called after the Settings panel saves). */
  settingsChanged(): void {
    void this.voice?.reconnect();
  }

  private injectStyles(): void {
    if (document.getElementById('pa-mb-style')) return;
    const style = document.createElement('style');
    style.id = 'pa-mb-style';
    style.textContent = `
      #pa-mb{margin-top:0.9rem;border-top:1px solid #2c2a28;padding-top:0.8rem;}
      #pa-mb-master{display:flex;align-items:center;justify-content:space-between;gap:0.75rem;padding:0.7rem 0.8rem;
        background:#141312;border:2px solid #0a0908;border-radius:0.5rem;}
      #pa-mb-master .ti{min-width:0;}
      #pa-mb-master .title{display:flex;align-items:center;gap:0.45rem;font-size:1rem;color:#f1efec;}
      #pa-mb-master .dot{width:0.5rem;height:0.5rem;border-radius:50%;background:#525556;}
      #pa-mb-master .dot.live{background:#5aa348;box-shadow:0 0 6px #5aa348;}
      #pa-mb-master .hint{font-size:0.78rem;color:#818586;margin-top:0.2rem;overflow:hidden;text-overflow:ellipsis;}
      #pa-mb-master .hint.bad{color:#e08894;}
      #pa-mb-pin{flex:none;opacity:.45;filter:grayscale(1);}
      #pa-mb-pin.on{opacity:1;filter:none;background:#3e7a30;border-color:#0a0908;color:#eaf7ec;
        box-shadow:inset 0 2px 0 #6fae5c,inset 0 -3px 0 #1f3f18;}
      #pa-mb-track{flex:none;width:3.4rem;height:1.75rem;border-radius:1rem;border:2px solid #0a0908;cursor:pointer;
        position:relative;background:#302d2a;box-shadow:inset 0 2px 0 #423f3b,inset 0 -2px 0 #141312;transition:background .15s;}
      #pa-mb-track.on{background:#3e7a30;box-shadow:inset 0 2px 0 #6fae5c,inset 0 -3px 0 #1f3f18;}
      #pa-mb-track .knob{position:absolute;top:50%;left:1px;transform:translateY(-50%);width:1.25rem;height:1.25rem;
        border-radius:50%;background:#f5f3f0;box-shadow:0 2px 3px rgba(0,0,0,.5);transition:left .15s;}
      #pa-mb-track.on .knob{left:1.6rem;}
      #pa-mb-sub{margin-top:0.65rem;}
      #pa-mb-sub.off{opacity:.4;pointer-events:none;filter:grayscale(.4);}
      #pa-mb-sub .row{display:flex;align-items:center;gap:0.55rem;margin:0.45rem 0;font-size:0.9rem;}
      #pa-mb-sub .row label{flex:0 0 auto;min-width:4rem;color:#adb0b2;}
      #pa-mb-sub input[type=range]{flex:1;accent-color:#c51a1b;}
      #pa-mb-sub .val{flex:0 0 auto;min-width:3.4rem;text-align:right;font-size:0.78rem;color:#adb0b2;}
      #pa-mb-sub select{flex:1;min-width:0;background:#262422;border:2px solid #0a0908;color:#f1efec;
        border-radius:0.35rem;padding:0.4rem;font:0.85rem 'FS Pixel Sans',monospace;box-shadow:inset 0 2px 0 #4a4744;}
      #pa-mb-sub select:disabled{opacity:0.5;}
      /* Outside #pa-mb-sub on purpose: a preference stays settable while the
         connection is off, when the rest of the sub-panel is disabled. */
      #pa-mb .chk{display:flex;align-items:center;gap:0.5rem;margin:0.6rem 0 0;font-size:0.88rem;color:#adb0b2;
        cursor:pointer;}
      #pa-mb .chk input{accent-color:#3e7a30;width:0.95rem;height:0.95rem;cursor:pointer;}
      #pa-mb-btns{display:flex;gap:0.4rem;margin:0.5rem 0;}
      #pa-mb button{cursor:pointer;background:#262422;border:2px solid #0a0908;color:#d7d5d1;border-radius:0.3rem;
        font:0.85rem 'FS Pixel Sans',monospace;padding:0.3rem 0.55rem;box-shadow:inset 0 2px 0 #4a4744,inset 0 -3px 0 #050505;}
      #pa-mb button.on{background:#7c2634;border-color:#0a0908;color:#f6cdd4;
        box-shadow:inset 0 2px 0 #b34a5a,inset 0 -3px 0 #45111a;}
      #pa-mb-meter{position:relative;flex:1;height:0.6rem;background:#141312;border:2px solid #0a0908;
        border-radius:0.3rem;overflow:hidden;}
      #pa-mb-meter .lvl{position:absolute;left:0;top:0;bottom:0;width:0;background:#6b7280;transition:width .05s linear;}
      #pa-mb-meter .lvl.on{background:#5aa348;}
      #pa-mb-meter .thr{position:absolute;top:0;bottom:0;width:2px;background:#e7da00;}
      #pa-mb-tree{margin-top:0.7rem;max-height:16rem;overflow-y:auto;}
      #pa-mb-tree .ch{display:flex;align-items:center;gap:0.4rem;padding:0.28rem 0.4rem;border-radius:0.3rem;
        cursor:pointer;font-size:0.88rem;color:#cac8c3;}
      #pa-mb-tree .ch:hover{background:#1c1a18;}
      #pa-mb-tree .ch.here{background:#262422;color:#f1efec;}
      #pa-mb-tree .ch .n{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
      #pa-mb-tree .ch .c{font-size:0.75rem;color:#818586;}
      #pa-mb-tree .us{display:flex;align-items:center;gap:0.4rem;padding:0.22rem 0.4rem;margin:0.15rem 0;
        background:#141312;border:2px solid #0a0908;border-radius:0.4rem;}
      #pa-mb-tree .us .tk{width:0.45rem;height:0.45rem;border-radius:50%;background:#423f3b;flex:none;}
      #pa-mb-tree .us .tk.on{background:#5aa348;box-shadow:0 0 5px #5aa348;}
      #pa-mb-tree .us .nm{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:0.86rem;color:#f0eeea;}
      #pa-mb-tree .us .nm.me{color:#9fd2ff;}
      /* Per-user mic / speaker state. Same red-slash idiom as the zone-voice
         mute buttons, so "off" reads identically across both panels. */
      #pa-mb-tree .us .st{flex:none;position:relative;display:inline-block;line-height:1;font-size:0.8rem;opacity:.75;}
      #pa-mb-tree .us .st.off{opacity:1;}
      #pa-mb-tree .us .st.off::after{content:'';position:absolute;left:-12%;top:44%;width:124%;height:0.16em;
        background:#ff5b6b;border-radius:1px;transform:rotate(-24deg);box-shadow:0 0 0 1px rgba(0,0,0,.55);}
      /* Forced by an admin rather than chosen by the user — amber, not red. */
      #pa-mb-tree .us .st.forced::after{background:#e7da00;}
      #pa-mb-tree .us .mu{flex:none;padding:0.1rem 0.3rem;font-size:0.8rem;}
      #pa-mb-tree .us .mu .ico{position:relative;display:inline-block;line-height:1;}
      #pa-mb-tree .us .mu.on .ico::after{content:'';position:absolute;left:-12%;top:44%;width:124%;height:0.16em;
        background:#ff5b6b;border-radius:1px;transform:rotate(-24deg);box-shadow:0 0 0 1px rgba(0,0,0,.55);}
      #pa-mb-tree .us .vol{flex:none;width:4.4rem;background:#262422;border:2px solid #0a0908;color:#d7d5d1;
        border-radius:0.3rem;padding:0.1rem 0.15rem;font:0.78rem 'FS Pixel Sans',monospace;cursor:pointer;}
      #pa-mb-tree .empty{color:#818586;font-size:0.85rem;}
      #pa-mb-note{font-size:0.78rem;color:#e0b062;margin-top:0.4rem;line-height:1.45;}
      #pa-mb-cfg{font-size:0.78rem;color:#818586;margin-top:0.5rem;}
      #pa-mb-cfg a{color:#4998c0;cursor:pointer;text-decoration:underline;}
    `;
    document.head.appendChild(style);
  }

  private build(mount: HTMLElement): void {
    const root = document.createElement('div');
    root.id = 'pa-mb';
    root.innerHTML = `
      <div id="pa-mb-master">
        <div class="ti">
          <div class="title"><span class="dot"></span>Mumble</div>
          <div class="hint"></div>
        </div>
        <button id="pa-mb-pin" title="Keep this panel open">📌</button>
        <div id="pa-mb-track"><div class="knob"></div></div>
      </div>
      <div id="pa-mb-sub">
        <div id="pa-mb-btns">
          <button id="pa-mb-mic" title="Mute your microphone">🎤 Mic</button>
          <button id="pa-mb-deaf" title="Silence everyone">🔊 Sound</button>
          <button id="pa-mb-reg" title="Ask the server to register this identity">Register me</button>
        </div>
        <div class="row"><label>Mic</label><select id="pa-mb-micsel"></select></div>
        <div class="row"><label>Speaker</label><select id="pa-mb-spksel"></select></div>
        <div class="row"><label>Mic boost</label><input id="pa-mb-micgain" type="range" min="0" max="${MAX_MIC_GAIN * 100}" step="5"><span id="pa-mb-gainval" class="val"></span></div>
        <div class="row"><label>Volume</label><input id="pa-mb-vol" type="range" min="0" max="200"></div>
        <div class="row"><label>Threshold</label><input id="pa-mb-thresh" type="range" min="0" max="100"></div>
        <div class="row"><label>Level</label><div id="pa-mb-meter"><div class="lvl"></div><div class="thr"></div></div></div>
        <div id="pa-mb-tree"></div>
      </div>
      <label class="chk" title="System notification when someone joins or leaves your channel"><input id="pa-mb-alerts" type="checkbox"> Join/leave alerts</label>
      <div id="pa-mb-note" hidden></div>
      <div id="pa-mb-cfg">Server and identity live in <a>Settings</a>.</div>`;

    this.dot = root.querySelector('.dot')!;
    this.hint = root.querySelector('.hint')!;
    this.track = root.querySelector('#pa-mb-track')!;
    this.sub = root.querySelector('#pa-mb-sub')!;
    this.micBtn = root.querySelector('#pa-mb-mic')!;
    this.deafBtn = root.querySelector('#pa-mb-deaf')!;
    this.regBtn = root.querySelector('#pa-mb-reg')!;
    this.micSel = root.querySelector('#pa-mb-micsel')!;
    this.spkSel = root.querySelector('#pa-mb-spksel')!;
    this.micGainEl = root.querySelector('#pa-mb-micgain')!;
    this.gainValEl = root.querySelector('#pa-mb-gainval')!;
    this.masterEl = root.querySelector('#pa-mb-vol')!;
    this.threshEl = root.querySelector('#pa-mb-thresh')!;
    this.meterLvl = root.querySelector('#pa-mb-meter .lvl')!;
    this.meterThr = root.querySelector('#pa-mb-meter .thr')!;
    this.treeEl = root.querySelector('#pa-mb-tree')!;
    this.alertsEl = root.querySelector('#pa-mb-alerts')!;
    this.pinBtn = root.querySelector('#pa-mb-pin')!;

    const voice = this.voice!;
    this.track.addEventListener('click', () => {
      if (voice.isEnabled) {
        voice.leave();
        this.hooks.onLeave?.();
      } else {
        voice.join();
        this.hooks.onJoin?.();
      }
    });
    this.pinBtn.classList.toggle('on', this.pinned);
    this.pinBtn.onclick = () => this.setPinned(!this.pinned);
    this.micBtn.onclick = () => voice.toggleMic();
    this.deafBtn.onclick = () => voice.toggleDeafen();
    this.regBtn.onclick = () => voice.selfRegister();
    this.micGainEl.addEventListener('input', () => voice.setMicSensitivity(Number(this.micGainEl!.value) / 100));
    this.threshEl.addEventListener('input', () => voice.setMicThreshold(Number(this.threshEl!.value) / 100));
    this.masterEl.addEventListener('input', () => voice.setMaster(Number(this.masterEl!.value) / 100));
    this.alertsEl.addEventListener('change', () => voice.setJoinAlerts(this.alertsEl!.checked));
    this.micSel.addEventListener('change', () => void voice.switchMic(this.micSel!.value));
    this.spkSel.addEventListener('change', () => void voice.switchSpeaker(this.spkSel!.value));
    root.querySelector('#pa-mb-cfg a')!.addEventListener('click', () => this.hooks.onOpenSettings?.());

    mount.appendChild(root);
    this.renderDevices({ mics: [], speakers: [] });
  }

  private setPinned(on: boolean): void {
    this.pinned = on;
    localStorage.setItem('pa-mb-pinned', on ? '1' : '0');
    this.pinBtn?.classList.toggle('on', on);
    this.pinBtn!.title = on ? 'Unpin — let this panel close with the others' : 'Keep this panel open';
    this.hooks.onPinChange?.(on);
  }

  private renderState(s: MumbleVoiceState): void {
    this.lastState = s;
    if (!this.track) return;
    const enabled = this.voice?.isEnabled === true;
    this.track.classList.toggle('on', enabled);
    this.dot!.classList.toggle('live', s.connected);
    const hint = this.hint!;
    hint.classList.toggle('bad', !!s.error && !s.connected);
    hint.textContent = s.error && !s.connected
      ? s.error
      : s.connected
        ? `Connected${s.host ? ` — ${s.host}` : ''}`
        : s.connecting
          ? 'Connecting…'
          : s.host
            ? 'Off'
            : 'Not configured — open Settings';
    hint.title = hint.textContent;

    this.sub!.classList.toggle('off', !s.connected);
    this.micBtn!.classList.toggle('on', !s.micOn);
    // Mumble ties self-deaf to self-mute, so say so on both buttons rather than
    // letting the mic appear to switch the sound back on out of nowhere.
    this.micBtn!.title = s.micOn
      ? 'Mute your microphone'
      : s.deafened
        ? 'Unmute — this also un-silences everyone'
        : 'Your microphone is muted';
    this.deafBtn!.classList.toggle('on', s.deafened);
    this.deafBtn!.title = s.deafened
      ? 'Everyone is silenced, and your mic with them'
      : 'Silence everyone — this also mutes your mic';
    this.regBtn!.hidden = s.registered;

    this.micGainEl!.value = String(Math.round(s.micGain * 100));
    this.renderGainValue(s.micGain);
    this.threshEl!.value = String(Math.round(s.micThreshold * 100));
    this.meterThr!.style.left = `${Math.round(s.micThreshold * 100)}%`;
    this.masterEl!.value = String(Math.round(s.master * 100));
    this.alertsEl!.checked = s.joinAlerts;

    const note = document.getElementById('pa-mb-note');
    if (note) {
      note.hidden = !s.notice;
      note.textContent = s.notice
        ? `${s.notice} — ask a server admin to register your certificate.`
        : '';
    }
  }

  /** Show the boost as a multiplier plus dB — 400% alone doesn't tell you much. */
  private renderGainValue(gain: number): void {
    if (!this.gainValEl) return;
    if (gain <= 0) {
      this.gainValEl.textContent = 'off';
      return;
    }
    const db = 20 * Math.log10(gain);
    this.gainValEl.textContent = `${gain.toFixed(gain < 10 ? 1 : 0)}x`;
    this.gainValEl.title = `${db >= 0 ? '+' : ''}${db.toFixed(1)} dB`;
  }

  private renderMicLevel(level: number): void {
    if (!this.meterLvl) return;
    this.meterLvl.style.width = `${Math.round(level * 100)}%`;
    const open = level >= (this.lastState?.micThreshold ?? 0);
    this.meterLvl.classList.toggle('on', open && level > 0.001);
  }

  private renderDevices(d: MumbleDevices): void {
    if (!this.micSel || !this.spkSel) return;
    fillSelect(this.micSel, d.mics, d.micId);
    fillSelect(this.spkSel, d.speakers, d.speakerId);
  }

  /**
   * Fold a fresh snapshot into the tree.
   *
   * This runs every TALK_TICK_MS to animate the talking dots, so rows are updated
   * in place and only moved when the order really changes. Rebuilding them — or
   * even detaching and re-inserting the same elements, which is what
   * replaceChildren does — takes the volume <select> out of the document with its
   * native popup open, and that popup dies with it. It is why the dropdown used to
   * shut again a fifth of a second after you clicked it, before you could pick
   * anything.
   */
  private renderTree(t: MumbleTree): void {
    const el = this.treeEl;
    const voice = this.voice;
    if (!el || !voice) return;
    if (t.channels.length === 0) {
      this.channelRows.clear();
      this.userRows.clear();
      el.replaceChildren(mkEmpty(this.lastState?.connected ? 'No channels.' : 'Not connected.'));
      return;
    }

    const byParent = new Map<number, MumbleChannelInfo[]>();
    const roots: MumbleChannelInfo[] = [];
    const ids = new Set(t.channels.map((c) => c.id));
    for (const c of t.channels) {
      // A channel whose parent is itself (the root) or missing hangs at the top.
      if (c.id === c.parent || !ids.has(c.parent)) roots.push(c);
      else {
        const list = byParent.get(c.parent);
        if (list) list.push(c);
        else byParent.set(c.parent, [c]);
      }
    }
    const usersByChannel = new Map<number, MumbleUserInfo[]>();
    for (const u of t.users) {
      const list = usersByChannel.get(u.channel);
      if (list) list.push(u);
      else usersByChannel.set(u.channel, [u]);
    }

    const order: HTMLElement[] = [];
    const liveChannels = new Set<number>();
    const liveUsers = new Set<number>();
    const walk = (channel: MumbleChannelInfo, depth: number): void => {
      const users = (usersByChannel.get(channel.id) ?? []).sort((a, b) => a.name.localeCompare(b.name));
      let ch = this.channelRows.get(channel.id);
      if (!ch) {
        ch = this.mkChannelRow(channel.id);
        this.channelRows.set(channel.id, ch);
      }
      ch.update(channel, users.length, depth);
      liveChannels.add(channel.id);
      order.push(ch.el);
      for (const u of users) {
        let ur = this.userRows.get(u.session);
        if (!ur) {
          ur = this.mkUserRow(u, t);
          this.userRows.set(u.session, ur);
        }
        ur.update(u, depth + 1, t);
        liveUsers.add(u.session);
        order.push(ur.el);
      }
      const kids = (byParent.get(channel.id) ?? []).sort(
        (a, b) => (a.position ?? 0) - (b.position ?? 0) || a.name.localeCompare(b.name),
      );
      for (const k of kids) walk(k, depth + 1);
    };
    for (const r of roots.sort((a, b) => (a.position ?? 0) - (b.position ?? 0) || a.name.localeCompare(b.name))) {
      walk(r, 0);
    }
    for (const id of this.channelRows.keys()) if (!liveChannels.has(id)) this.channelRows.delete(id);
    for (const session of this.userRows.keys()) if (!liveUsers.has(session)) this.userRows.delete(session);
    applyOrder(el, order);
  }

  /** A channel row. Its id is fixed — the map is keyed by it — so only the name,
   *  count, depth and "you are here" highlight are refreshed. */
  private mkChannelRow(id: number): ChannelRow {
    const row = document.createElement('div');
    row.className = 'ch';
    const name = document.createElement('span');
    name.className = 'n';
    const count = document.createElement('span');
    count.className = 'c';
    row.append(name, count);
    row.onclick = () => this.voice?.joinChannel(id);
    return {
      el: row,
      update: (channel, userCount, depth) => {
        row.classList.toggle('here', channel.id === this.lastState?.channel);
        row.style.paddingLeft = `${0.4 + depth * 0.8}rem`;
        name.textContent = channel.name;
        count.textContent = userCount > 0 ? String(userCount) : '';
        row.title = channel.description ? `${channel.name} — ${channel.description}` : `Join ${channel.name}`;
      },
    };
  }

  /**
   * One line per user: talk dot, name, state flags, mute, volume dropdown.
   *
   * Built once per session and updated in place. Whether this is our own row is
   * fixed for the life of the row, since a new session id means a new row, so the
   * controls can be left out of the DOM entirely rather than toggled.
   */
  private mkUserRow(user: MumbleUserInfo, t: MumbleTree): UserRow {
    const voice = this.voice!;
    const row = document.createElement('div');
    row.className = 'us';
    const talk = document.createElement('span');
    const name = document.createElement('span');
    const mic = document.createElement('span');
    const spk = document.createElement('span');
    // Our own row carries no controls: you don't mute or attenuate yourself.
    const self = user.session === t.me;
    name.className = `nm${self ? ' me' : ''}`;
    row.append(talk, name, mic, spk);

    // Mute and volume are local-only, so they key off the display name — session
    // ids churn on every reconnect. A rename keeps the row, so the handlers read
    // the current name at click time rather than closing over the first one.
    let who = user.name;
    let mute: HTMLButtonElement | undefined;
    let vol: HTMLSelectElement | undefined;
    let steps: number[] = [];
    if (!self) {
      mute = document.createElement('button');
      mute.className = 'mu';
      mute.innerHTML = '<span class="ico">🔊</span>';
      mute.onclick = () => voice.setUserMuted(who, !voice.isUserMuted(who));
      const sel = document.createElement('select');
      sel.className = 'vol';
      sel.onchange = () => voice.setUserVolume(who, Number(sel.value));
      vol = sel;
      row.append(mute, sel);
    }

    return {
      el: row,
      update: (u, depth, tree) => {
        who = u.name;
        row.style.marginLeft = `${0.4 + depth * 0.8}rem`;
        talk.className = `tk${tree.talking.has(u.session) ? ' on' : ''}`;
        name.textContent = u.name;
        name.title = u.userId !== undefined ? `${u.name} — registered on the server` : u.name;
        applyStateIcon(mic, 'mic', u);
        applyStateIcon(spk, 'speaker', u);
        if (!mute || !vol) return;
        const muted = voice.isUserMuted(u.name);
        mute.classList.toggle('on', muted);
        mute.title = muted ? 'Unmute this user for you' : 'Mute this user for you';
        vol.title = `Volume for ${u.name}`;
        const current = voice.getUserVolume(u.name);
        // Include the stored value if it isn't one of the presets (e.g. set by an
        // older build's slider), so opening the dropdown never silently changes it.
        const want = VOLUME_STEPS.includes(current)
          ? VOLUME_STEPS
          : [...VOLUME_STEPS, current].sort((a, b) => a - b);
        // Rewriting the options closes an open popup just as surely as replacing
        // the element would, so only do it when the choices actually differ.
        if (want.length !== steps.length || want.some((s, i) => s !== steps[i])) {
          steps = want;
          vol.replaceChildren(
            ...want.map((step) => {
              const o = document.createElement('option');
              o.value = String(step);
              o.textContent = `${Math.round(step * 100)}%`;
              return o;
            }),
          );
        }
        if (Number(vol.value) !== current) vol.value = String(current);
      },
    };
  }
}

/**
 * Make `el`'s children exactly `nodes`, in that order, moving as little as
 * possible.
 *
 * A row that is already in the right place must not be touched at all: taking a
 * node out of the document and putting it back drops focus, and a <select> loses
 * its open popup with it. That rules out replaceChildren even when it is handed
 * the very same elements it already has.
 */
function applyOrder(el: HTMLElement, nodes: HTMLElement[]): void {
  let cur = el.firstChild;
  for (const want of nodes) {
    if (cur === want) {
      cur = cur.nextSibling;
      continue;
    }
    el.insertBefore(want, cur);
  }
  while (cur) {
    const next = cur.nextSibling;
    el.removeChild(cur);
    cur = next;
  }
}

/**
 * Paint one state icon for a user's mic or speaker, in place — the row it belongs
 * to outlives any single snapshot, so the classes are set from scratch each time
 * rather than added to.
 *
 * Mumble distinguishes a user's own choice (self_mute / self_deaf) from one
 * imposed by the server (mute / deaf / suppress); both silence them, so both
 * get a slash, but the forced case is amber to make "an admin did this" legible
 * at a glance. Deafening implies you also transmit nothing, so a deafened user
 * shows a slashed mic too — matching what the official client displays.
 */
function applyStateIcon(el: HTMLElement, kind: 'mic' | 'speaker', user: MumbleUserInfo): void {
  el.className = 'st';
  if (kind === 'speaker') {
    el.textContent = '🎧';
    if (user.deaf) {
      el.classList.add('off', 'forced');
      el.title = 'Deafened by an admin';
    } else if (user.selfDeaf) {
      el.classList.add('off');
      el.title = 'Deafened — hears no one';
    } else {
      el.title = 'Hearing everyone';
    }
    return;
  }
  el.textContent = '🎤';
  if (user.mute) {
    el.classList.add('off', 'forced');
    el.title = 'Muted by an admin';
  } else if (user.suppress) {
    el.classList.add('off', 'forced');
    el.title = 'Suppressed — not allowed to speak here';
  } else if (user.selfMute || user.selfDeaf) {
    el.classList.add('off');
    el.title = user.selfDeaf ? 'Deafened, so not transmitting' : 'Microphone muted';
  } else {
    el.title = 'Microphone live';
  }
}

function mkEmpty(text: string): HTMLElement {
  const el = document.createElement('div');
  el.className = 'empty';
  el.textContent = text;
  return el;
}

function fillSelect(sel: HTMLSelectElement, devices: MediaDeviceInfo[], activeId?: string): void {
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
