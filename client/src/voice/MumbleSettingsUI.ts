/**
 * Mumble connection settings, rendered into the Settings panel next to the
 * account controls. Desktop only — it renders nothing when there is no Mumble
 * client behind it.
 *
 * Everything here lives on the user's own machine: the connection details in
 * Electron's userData, the server password and certificate passphrase in the OS
 * keychain. The two secret fields are write-only — a stored secret shows as a
 * placeholder and is never read back into the renderer.
 */
import { desktop, mumbleApi, type MumbleSettingsPatch, type MumbleSettingsView } from '../desktop/bridge.js';
import { serverHttpOrigin } from '../net/room.js';
import { alertDialog } from '../ui/dialog.js';

const SECRET_PLACEHOLDER = '••••••••';

export class MumbleSettingsUI {
  private readonly api = mumbleApi();
  private root?: HTMLElement;
  private view?: MumbleSettingsView;

  private hostEl?: HTMLInputElement;
  private portEl?: HTMLInputElement;
  private nameEl?: HTMLInputElement;
  private channelEl?: HTMLInputElement;
  private passwordEl?: HTMLInputElement;
  private certEl?: HTMLInputElement;
  private passphraseEl?: HTMLInputElement;
  private autoEl?: HTMLInputElement;
  private warnEl?: HTMLElement;
  private suggestEl?: HTMLElement;

  /** @param onSaved called after a successful save, so the panel can reconnect. */
  constructor(mount: HTMLElement, private readonly onSaved: () => void) {
    if (!this.api) return;
    this.injectStyles();
    this.build(mount);
    void this.refresh();
  }

  private async refresh(): Promise<void> {
    const view = await this.api?.getSettings().catch(() => null);
    if (!view) return;
    this.view = view;
    this.hostEl!.value = view.host;
    this.portEl!.value = String(view.port);
    this.nameEl!.value = view.username;
    this.channelEl!.value = view.channel;
    this.certEl!.value = view.certPath ?? '';
    this.autoEl!.checked = view.autoConnect;
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
      #pa-mumble-cfg{margin-top:0.9rem;border-top:1px solid #2c2a28;padding-top:0.7rem;}
      #pa-mumble-cfg h5{margin:0 0 0.5rem;font-size:0.95rem;color:#f1efec;font-weight:normal;}
      #pa-mumble-cfg .btns{display:flex;gap:0.4rem;margin:0.5rem 0;}
      #pa-mumble-cfg .btns button{flex:1;background:#262422;border:2px solid #0a0908;color:#f1efec;
        border-radius:0.35rem;font:0.9rem 'FS Pixel Sans',monospace;padding:0.4rem;cursor:pointer;
        box-shadow:inset 0 2px 0 #4a4744,inset 0 -3px 0 #050505;}
      #pa-mumble-cfg .save{width:100%;margin-top:0.3rem;background:#292725;border:2px solid #0a0908;color:#ece9e4;
        border-radius:0.35rem;font:0.95rem 'FS Pixel Sans',monospace;padding:0.5rem;cursor:pointer;
        box-shadow:inset 0 2px 0 #4a4744,inset 0 -3px 0 #141210;}
      #pa-mumble-cfg .warn{font-size:0.8rem;color:#e0b062;margin:0.35rem 0;line-height:1.45;}
      #pa-mumble-cfg .suggest{font-size:0.8rem;color:#818586;margin:-0.3rem 0 0.5rem;}
      #pa-mumble-cfg .suggest a{color:#4998c0;cursor:pointer;text-decoration:underline;}
      #pa-mumble-cfg .chk{display:flex;align-items:center;gap:0.5rem;margin:0.55rem 0;font-size:0.95rem;color:#cac8c3;}
      #pa-mumble-cfg .chk input{accent-color:#3e7a30;width:1rem;height:1rem;}
    `;
    document.head.appendChild(style);
  }

  private build(mount: HTMLElement): void {
    const root = document.createElement('div');
    root.id = 'pa-mumble-cfg';
    root.innerHTML = `
      <h5>Mumble voice</h5>
      <div class="row"><label for="pa-mb-host">Server</label><input id="pa-mb-host" type="text" maxlength="255" placeholder="mumble.example.com"></div>
      <div class="suggest" hidden></div>
      <div class="row"><label for="pa-mb-port">Port</label><input id="pa-mb-port" type="text" maxlength="5" placeholder="64738"></div>
      <div class="row"><label for="pa-mb-name">Your name</label><input id="pa-mb-name" type="text" maxlength="64" placeholder="(your display name)"></div>
      <div class="row"><label for="pa-mb-chan">Channel</label><input id="pa-mb-chan" type="text" maxlength="128" placeholder="(stay where you land)"></div>
      <div class="row"><label for="pa-mb-pw">Server password</label><input id="pa-mb-pw" type="password" maxlength="128" autocomplete="new-password"></div>
      <div class="row"><label for="pa-mb-cert">Identity</label><input id="pa-mb-cert" type="text" readonly placeholder="(none — connect as a guest)"></div>
      <div class="btns"><button id="pa-mb-pick">Choose .p12…</button><button id="pa-mb-clear">Clear</button></div>
      <div class="row"><label for="pa-mb-pass">Passphrase</label><input id="pa-mb-pass" type="password" maxlength="128" autocomplete="new-password"></div>
      <div class="hint">Use the certificate your Mumble client exports (Configure → Certificate Wizard → Export). Without one you connect as an unregistered guest.</div>
      <label class="chk"><input id="pa-mb-auto" type="checkbox"> Connect on start</label>
      <div class="warn" hidden>No system keychain — the password and passphrase can't be saved and will be asked for each time.</div>
      <button class="save" id="pa-mb-save">Save Mumble settings</button>`;

    this.hostEl = root.querySelector('#pa-mb-host')!;
    this.portEl = root.querySelector('#pa-mb-port')!;
    this.nameEl = root.querySelector('#pa-mb-name')!;
    this.channelEl = root.querySelector('#pa-mb-chan')!;
    this.passwordEl = root.querySelector('#pa-mb-pw')!;
    this.certEl = root.querySelector('#pa-mb-cert')!;
    this.passphraseEl = root.querySelector('#pa-mb-pass')!;
    this.autoEl = root.querySelector('#pa-mb-auto')!;
    this.warnEl = root.querySelector('.warn')!;
    this.suggestEl = root.querySelector('.suggest')!;

    root.querySelector<HTMLButtonElement>('#pa-mb-pick')!.onclick = async () => {
      const path = await this.api!.pickCertFile().catch(() => null);
      if (path) this.certEl!.value = path;
    };
    root.querySelector<HTMLButtonElement>('#pa-mb-clear')!.onclick = () => {
      this.certEl!.value = '';
      this.passphraseEl!.value = '';
    };
    root.querySelector<HTMLButtonElement>('#pa-mb-save')!.onclick = () => void this.save();

    mount.appendChild(root);
    this.root = root;
  }

  private async save(): Promise<void> {
    if (!this.api || !this.root) return;
    const port = Number(this.portEl!.value.trim() || '64738');
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      await alertDialog('Port must be a number between 1 and 65535.');
      return;
    }
    const certPath = this.certEl!.value.trim() || null;
    const patch: MumbleSettingsPatch = {
      host: this.hostEl!.value.trim(),
      port,
      username: this.nameEl!.value.trim(),
      channel: this.channelEl!.value.trim(),
      certPath,
      autoConnect: this.autoEl!.checked,
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
    this.onSaved();
  }
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
      credentials: 'include',
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
