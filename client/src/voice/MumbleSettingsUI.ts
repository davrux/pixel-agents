/**
 * Mumble connection settings, rendered as a view *inside* the Mumble window —
 * the same shape Matrix chat uses for its own encryption / notification pages
 * (matrix/MatrixUI.ts): a section that stands in for the panel's main view, with
 * a ◀ subhead back to it. The server you talk to belongs with the client that
 * talks to it, not in the office's own Settings panel.
 *
 * Desktop only — it builds nothing when there is no Mumble client behind it,
 * which is also when MumbleUI itself renders nothing.
 *
 * Everything here lives on the user's own machine: the connection details in
 * Electron's userData, the server password and certificate passphrase in the OS
 * keychain. The two secret fields are write-only — a stored secret shows as a
 * placeholder and is never read back into the renderer.
 */
import { desktop, mumbleApi, type MumbleSettingsPatch, type MumbleSettingsView } from '../desktop/bridge.js';
import { serverHttpOrigin } from '../net/room.js';
import { alertDialog } from '../ui/dialog.js';
import { acceleratorFromEvent } from './hotkeys.js';

const SECRET_PLACEHOLDER = '••••••••';

export interface MumbleSettingsHooks {
  /** ◀ — the window should show its main view again. */
  onBack(): void;
  /** A successful save, so the panel can reconnect with the new details. */
  onSaved(): void;
}

export class MumbleSettingsUI {
  /** The view element, for the host to place and show/hide. Empty in the
   *  browser, where there is nothing to configure. */
  readonly el: HTMLElement;

  private readonly api = mumbleApi();

  private hostEl?: HTMLInputElement;
  private portEl?: HTMLInputElement;
  private nameEl?: HTMLInputElement;
  private channelEl?: HTMLInputElement;
  private passwordEl?: HTMLInputElement;
  private certEl?: HTMLInputElement;
  private passphraseEl?: HTMLInputElement;
  private autoEl?: HTMLInputElement;
  private hkMicEl?: HTMLInputElement;
  private hkDeafEl?: HTMLInputElement;
  private warnEl?: HTMLElement;
  private suggestEl?: HTMLElement;
  private view?: MumbleSettingsView;

  constructor(private readonly hooks: MumbleSettingsHooks) {
    this.el = document.createElement('section');
    this.el.id = 'pa-mb-settings';
    this.el.dataset.view = 'settings';
    if (!this.api) return;
    this.injectStyles();
    this.build();
    void this.refresh();
  }

  /** Re-read what is stored. Called whenever the view is opened, so a token that
   *  only became available after boot gets its server suggestion a chance too. */
  async refresh(): Promise<void> {
    const view = await this.api?.getSettings().catch(() => null);
    if (!view) return;
    this.view = view;
    this.hostEl!.value = view.host;
    this.portEl!.value = String(view.port);
    this.nameEl!.value = view.username;
    this.channelEl!.value = view.channel;
    this.certEl!.value = view.certPath ?? '';
    this.autoEl!.checked = view.autoConnect;
    this.hkMicEl!.value = view.hotkeyMuteMic ?? '';
    this.hkDeafEl!.value = view.hotkeyDeafen ?? '';
    this.passwordEl!.value = '';
    this.passwordEl!.placeholder = view.hasPassword ? SECRET_PLACEHOLDER : '(none)';
    this.passphraseEl!.value = '';
    this.passphraseEl!.placeholder = view.hasPassphrase ? SECRET_PLACEHOLDER : '(none)';
    this.warnEl!.hidden = view.keychainAvailable;
    void this.offerSuggestion();
  }

  /** The pixel-agents server can suggest a voice server (env only, no secrets),
   *  so users don't have to type an address the operator already knows. */
  private async offerSuggestion(): Promise<void> {
    const el = this.suggestEl;
    if (!el || this.hostEl!.value.trim()) {
      if (el) el.hidden = true;
      return;
    }
    const suggestion = await fetchSuggestion();
    if (!suggestion?.host || this.hostEl!.value.trim()) return;
    el.hidden = false;
    el.replaceChildren('Suggested: ');
    const link = document.createElement('a');
    link.textContent = `${suggestion.host}:${suggestion.port}`;
    link.onclick = () => {
      this.hostEl!.value = suggestion.host!;
      this.portEl!.value = String(suggestion.port);
      if (suggestion.channel && !this.channelEl!.value) this.channelEl!.value = suggestion.channel;
      el.hidden = true;
    };
    el.appendChild(link);
  }

  private injectStyles(): void {
    if (document.getElementById('pa-mbcfg-style')) return;
    const style = document.createElement('style');
    style.id = 'pa-mbcfg-style';
    style.textContent = `
      /* A view of the Mumble window: the subhead is pinned and the fields scroll
         under it, so ◀ stays reachable from the bottom of the form. */
      #pa-mb-settings{overflow:hidden;margin-top:0.65rem;}
      #pa-mb-settings .subhead{flex:0 0 auto;display:flex;align-items:center;gap:0.5rem;
        padding-bottom:0.5rem;border-bottom:2px solid #0a0908;box-shadow:inset 0 -1px 0 #2c2a28;}
      #pa-mb-settings .subhead .ti{flex:1;min-width:0;font-size:1rem;color:#f1efec;
        overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
      #pa-mb-settings .fields{flex:1 1 auto;min-height:0;overflow-y:auto;overscroll-behavior:contain;
        padding-top:0.3rem;}
      /* Label above field, not beside it: this column is ~24rem wide and a server
         address or a certificate path needs all of it. */
      #pa-mb-settings label.lbl{display:block;color:#818586;font-size:0.85rem;margin:0.55rem 0 0.15rem;}
      #pa-mb-settings .pa-input{width:100%;}
      #pa-mb-settings .btns{display:flex;gap:0.4rem;margin:0.5rem 0;}
      #pa-mb-settings .btns button{flex:1;}
      #pa-mb-settings .save{width:100%;margin-top:0.6rem;background:#292725;color:#ece9e4;
        font-size:0.95rem;padding:0.5rem;box-shadow:inset 0 2px 0 #4a4744,inset 0 -3px 0 #141210;}
      #pa-mb-settings .hint{font-size:0.8rem;color:#818586;margin:0.35rem 0 0.2rem;line-height:1.45;}
      #pa-mb-settings .warn{font-size:0.8rem;color:#e0b062;margin:0.5rem 0 0;line-height:1.45;}
      #pa-mb-settings .suggest{font-size:0.8rem;color:#818586;margin:0.25rem 0 0;}
      #pa-mb-settings .suggest a{color:#4998c0;cursor:pointer;text-decoration:underline;}
    `;
    document.head.appendChild(style);
  }

  private build(): void {
    this.el.innerHTML = `
      <div class="subhead">
        <button class="back" title="Back to the channel tree" aria-label="Back to the channel tree">◀</button>
        <span class="ti">Mumble settings</span>
      </div>
      <div class="fields">
        <label class="lbl" for="pa-mb-host">Server</label>
        <input id="pa-mb-host" class="pa-input" type="text" maxlength="255" placeholder="mumble.example.com">
        <div class="suggest" hidden></div>
        <label class="lbl" for="pa-mb-port">Port</label>
        <input id="pa-mb-port" class="pa-input" type="text" maxlength="5" placeholder="64738">
        <label class="lbl" for="pa-mb-name">Your name</label>
        <input id="pa-mb-name" class="pa-input" type="text" maxlength="64" placeholder="(your display name)">
        <label class="lbl" for="pa-mb-chan">Channel</label>
        <input id="pa-mb-chan" class="pa-input" type="text" maxlength="128" placeholder="(stay where you land)">
        <label class="lbl" for="pa-mb-pw">Server password</label>
        <input id="pa-mb-pw" class="pa-input" type="password" maxlength="128" autocomplete="new-password">
        <label class="lbl" for="pa-mb-cert">Identity</label>
        <input id="pa-mb-cert" class="pa-input" type="text" readonly placeholder="(none — connect as a guest)">
        <div class="btns"><button id="pa-mb-pick">Choose .p12…</button><button id="pa-mb-clear">Clear</button></div>
        <label class="lbl" for="pa-mb-pass">Passphrase</label>
        <input id="pa-mb-pass" class="pa-input" type="password" maxlength="128" autocomplete="new-password">
        <div class="hint">Use the certificate your Mumble client exports (Configure → Certificate Wizard → Export). Without one you connect as an unregistered guest.</div>
        <label class="lbl" for="pa-mb-hk-mic">Mute-mic hotkey</label>
        <input id="pa-mb-hk-mic" class="pa-input hk" type="text" readonly placeholder="(none — click, then press keys)">
        <label class="lbl" for="pa-mb-hk-deaf">Silence-everyone hotkey</label>
        <input id="pa-mb-hk-deaf" class="pa-input hk" type="text" readonly placeholder="(none — click, then press keys)">
        <div class="hint">Press a combination with Ctrl, Alt or Super (or an F-key alone); Backspace clears, Esc keeps the current one. Works system-wide where the OS allows global shortcuts; elsewhere (e.g. Wayland) only while this window is focused.</div>
        <label class="chk"><input id="pa-mb-auto" type="checkbox"> Connect on start</label>
        <div class="warn" hidden>No system keychain — the password and passphrase can't be saved and will be asked for each time.</div>
        <button class="save" id="pa-mb-save">Save Mumble settings</button>
      </div>`;

    this.hostEl = this.el.querySelector('#pa-mb-host')!;
    this.portEl = this.el.querySelector('#pa-mb-port')!;
    this.nameEl = this.el.querySelector('#pa-mb-name')!;
    this.channelEl = this.el.querySelector('#pa-mb-chan')!;
    this.passwordEl = this.el.querySelector('#pa-mb-pw')!;
    this.certEl = this.el.querySelector('#pa-mb-cert')!;
    this.passphraseEl = this.el.querySelector('#pa-mb-pass')!;
    this.autoEl = this.el.querySelector('#pa-mb-auto')!;
    this.hkMicEl = this.el.querySelector('#pa-mb-hk-mic')!;
    this.hkDeafEl = this.el.querySelector('#pa-mb-hk-deaf')!;
    this.warnEl = this.el.querySelector('.warn')!;
    this.suggestEl = this.el.querySelector('.suggest')!;
    bindHotkeyRecorder(this.hkMicEl);
    bindHotkeyRecorder(this.hkDeafEl);

    this.el.querySelector<HTMLButtonElement>('.back')!.onclick = () => this.hooks.onBack();
    this.el.querySelector<HTMLButtonElement>('#pa-mb-pick')!.onclick = async () => {
      const path = await this.api!.pickCertFile().catch(() => null);
      if (path) this.certEl!.value = path;
    };
    this.el.querySelector<HTMLButtonElement>('#pa-mb-clear')!.onclick = () => {
      this.certEl!.value = '';
      this.passphraseEl!.value = '';
    };
    this.el.querySelector<HTMLButtonElement>('#pa-mb-save')!.onclick = () => void this.save();
  }

  private async save(): Promise<void> {
    if (!this.api) return;
    const port = Number(this.portEl!.value.trim() || '64738');
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      await alertDialog('Port must be a number between 1 and 65535.');
      return;
    }
    const certPath = this.certEl!.value.trim() || null;
    const hotkeyMuteMic = this.hkMicEl!.value;
    const hotkeyDeafen = this.hkDeafEl!.value;
    if (hotkeyMuteMic && hotkeyMuteMic === hotkeyDeafen) {
      await alertDialog('The two hotkeys must differ — one key cannot both mute the mic and silence everyone.');
      return;
    }
    const patch: MumbleSettingsPatch = {
      host: this.hostEl!.value.trim(),
      port,
      username: this.nameEl!.value.trim(),
      channel: this.channelEl!.value.trim(),
      certPath,
      autoConnect: this.autoEl!.checked,
      hotkeyMuteMic,
      hotkeyDeafen,
    };
    // A blank secret field means "leave what's stored alone"; clearing the
    // certificate is the one action that also drops its passphrase.
    if (this.passwordEl!.value) patch.password = this.passwordEl!.value;
    if (this.passphraseEl!.value) patch.passphrase = this.passphraseEl!.value;
    else if (!certPath && this.view?.hasPassphrase) patch.passphrase = '';

    const view = await this.api.setSettings(patch).catch(() => null);
    if (!view) {
      await alertDialog('Could not save the Mumble settings.');
      return;
    }
    this.view = view;
    await this.refresh();
    if (!view.keychainAvailable && (patch.password || patch.passphrase)) {
      await alertDialog('Settings saved, but this system has no keychain, so the password could not be stored.');
    }
    this.hooks.onSaved();
  }
}

/**
 * Turn a readonly input into a hotkey recorder: focus it, press a combination,
 * and the canonical accelerator lands in `value` (the same grammar the desktop
 * side stores and matches — see voice/hotkeys.ts). Backspace/Delete clears,
 * Escape leaves whatever was there; a combo the grammar refuses (a bare letter
 * that would swallow typing) is simply not taken. Recording ends the moment a
 * combo is accepted, so the key that set the hotkey cannot also trigger it.
 */
function bindHotkeyRecorder(input: HTMLInputElement): void {
  input.addEventListener('keydown', (e) => {
    // The recorder eats every key: nothing pressed here may reach the panel's
    // own hotkey listener, scroll the page or tab away mid-recording.
    e.preventDefault();
    e.stopPropagation();
    if (e.key === 'Escape') {
      input.blur();
      return;
    }
    const accelerator = acceleratorFromEvent(e);
    if (accelerator) {
      input.value = accelerator;
      input.blur();
      return;
    }
    // Unmodified Backspace/Delete never form an accelerator, so they are free
    // to mean "no hotkey". Anything else invalid is ignored: likely half of a
    // combination still being pressed.
    if (e.key === 'Backspace' || e.key === 'Delete') input.value = '';
  });
}

interface MumbleSuggestion {
  host: string | null;
  port: number;
  channel: string | null;
}

/** Ask the pixel-agents server for its suggested voice address. Returns null
 *  when the endpoint is absent, unauthorized or unset — it is purely optional. */
async function fetchSuggestion(): Promise<MumbleSuggestion | null> {
  try {
    const token = await desktop().getToken();
    const res = await fetch(`${serverHttpOrigin()}/mumble/config`, {
      cache: 'no-store',
      // Desktop-only file (see header comment): this is always a genuine
      // cross-origin request (app://bundle -> the real server), and the
      // server's CORS response never sets Access-Control-Allow-Credentials,
      // so 'include' would make the browser reject the response outright.
      // Auth here is bearer-token-only anyway.
      credentials: 'omit',
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
    if (!res.ok) return null;
    const body = (await res.json()) as Partial<MumbleSuggestion>;
    if (typeof body.host !== 'string' || !body.host) return null;
    return {
      host: body.host,
      port: Number.isInteger(body.port) ? (body.port as number) : 64738,
      channel: typeof body.channel === 'string' && body.channel ? body.channel : null,
    };
  } catch {
    return null;
  }
}
