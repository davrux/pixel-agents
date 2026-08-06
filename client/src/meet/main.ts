/**
 * Standalone ad-hoc meeting room join page (/meet/<slug>) — no pixel-agents
 * account required. Checks the room (exists/expired, password?), gates on a
 * name (skipped for an already-signed-in viewer, whose account name is used
 * instead) and the password if the room is locked, then joins the same
 * LiveKit conference UI the in-world monitors use (server/src/meetingRoomApi.ts
 * mints the token the same way SimRoom does for a monitor).
 */
import { ConferenceUI, type ConferenceUIHandlers } from '../conference/ConferenceUI.js';
import { LiveKitConference } from '../conference/LiveKitConference.js';
import { isDesktop, desktop } from '../desktop/bridge.js';

const STYLE = `
  html,body{margin:0;height:100%;background:#14161c;color:#e9ecf7;font-family:'FS Pixel Sans',ui-monospace,monospace;}
  #gate{position:fixed;inset:0;display:flex;align-items:center;justify-content:center;}
  #gate .box{width:24rem;max-width:92vw;background:#0f1220;border:2px solid #05060b;border-radius:0.6rem;
    padding:1.3rem 1.4rem;box-shadow:inset 0 2px 0 #232a44,inset 0 -3px 0 #080a14,0 12px 28px rgba(0,0,0,.55);}
  #gate h1{margin:0 0 .3rem;font-size:1.3rem;}
  #gate .hint{margin:0 0 1rem;font-size:.9rem;color:#9aa0b8;line-height:1.4;}
  #gate label{display:block;font-size:.75rem;letter-spacing:1px;text-transform:uppercase;color:#8a90a8;
    margin:.8rem .1rem .3rem;}
  #gate input{width:100%;box-sizing:border-box;background:#171b2b;border:2px solid #05060b;color:#e9ecf7;
    border-radius:.4rem;font:1.02rem 'FS Pixel Sans',monospace;padding:.55rem .65rem;
    box-shadow:inset 0 2px 0 #2b3252,inset 0 -3px 0 #090b16;}
  #gate .err{min-height:1.1rem;margin:.6rem .1rem 0;font-size:.88rem;color:#f1b0ba;}
  #gate button{width:100%;margin-top:1.1rem;cursor:pointer;background:#2f66b0;color:#fff;border:2px solid #05060b;
    border-radius:.45rem;font:1.02rem 'FS Pixel Sans',monospace;padding:.6rem;
    box-shadow:inset 0 2px 0 #5a92d6,inset 0 -3px 0 #163862;}
  #gate button:disabled{opacity:.6;cursor:progress;}
`;

function injectStyle(): void {
  const s = document.createElement('style');
  s.textContent = STYLE;
  document.head.appendChild(s);
}

function slugFromPath(): string {
  const parts = location.pathname.split('/').filter(Boolean); // ["meet", "<slug>"]
  return decodeURIComponent(parts[parts.length - 1] ?? '');
}

async function authHeaders(): Promise<Record<string, string>> {
  if (isDesktop()) {
    const token = await desktop().getToken().catch(() => null);
    if (token) return { Authorization: `Bearer ${token}` };
  }
  return {};
}

interface RoomInfo {
  exists: boolean;
  needsPassword?: boolean;
  authenticatedAs?: string | null;
}

async function fetchInfo(slug: string): Promise<RoomInfo> {
  try {
    const res = await fetch(`/meet/${encodeURIComponent(slug)}/info`, {
      credentials: 'include',
      cache: 'no-store',
      headers: await authHeaders(),
    });
    if (!res.ok) return { exists: false };
    return (await res.json()) as RoomInfo;
  } catch {
    return { exists: false };
  }
}

interface JoinResult {
  token?: string;
  url?: string;
  room?: string;
  name?: string;
  error?: string;
}

async function join(slug: string, name: string, password: string): Promise<JoinResult> {
  try {
    const res = await fetch(`/meet/${encodeURIComponent(slug)}/join`, {
      method: 'POST',
      credentials: 'include',
      cache: 'no-store',
      headers: { 'Content-Type': 'application/json', ...(await authHeaders()) },
      body: JSON.stringify({ name, password }),
    });
    const data = (await res.json().catch(() => ({}))) as JoinResult;
    return res.ok ? data : { error: data.error ?? `error ${res.status}` };
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
}

function buildGate(info: RoomInfo): { root: HTMLDivElement; nameIn: HTMLInputElement | null; pwIn: HTMLInputElement | null; err: HTMLDivElement; button: HTMLButtonElement } {
  const root = document.createElement('div');
  root.id = 'gate';
  const box = document.createElement('div');
  box.className = 'box';
  box.innerHTML = '<h1>🎥 Meeting room</h1>';
  const hint = document.createElement('p');
  hint.className = 'hint';
  hint.textContent = info.authenticatedAs
    ? `Join as ${info.authenticatedAs}.`
    : 'Enter a name to join — no account needed.';
  box.appendChild(hint);

  let nameIn: HTMLInputElement | null = null;
  if (!info.authenticatedAs) {
    const nameLabel = document.createElement('label');
    nameLabel.textContent = 'Your name';
    nameIn = document.createElement('input');
    nameIn.maxLength = 32;
    nameIn.placeholder = 'e.g. Alex';
    box.append(nameLabel, nameIn);
  }
  let pwIn: HTMLInputElement | null = null;
  if (info.needsPassword) {
    const pwLabel = document.createElement('label');
    pwLabel.textContent = 'Password';
    pwIn = document.createElement('input');
    pwIn.type = 'password';
    box.append(pwLabel, pwIn);
  }
  const err = document.createElement('div');
  err.className = 'err';
  box.appendChild(err);
  const button = document.createElement('button');
  button.textContent = 'Join';
  box.appendChild(button);
  root.appendChild(box);
  return { root, nameIn, pwIn, err, button };
}

async function main(): Promise<void> {
  injectStyle();
  const app = document.getElementById('app')!;
  const slug = slugFromPath();
  if (!slug) {
    app.innerHTML = '<div id="gate"><div class="box"><h1>Meeting room</h1><p class="hint">No room link given.</p></div></div>';
    return;
  }
  const info = await fetchInfo(slug);
  if (!info.exists) {
    app.innerHTML =
      '<div id="gate"><div class="box"><h1>Meeting room</h1>' +
      '<p class="hint">This link no longer works — the room does not exist or has expired.</p></div></div>';
    return;
  }

  const { root, nameIn, pwIn, err, button } = buildGate(info);
  app.innerHTML = '';
  app.appendChild(root);
  nameIn?.focus();

  const submit = async (): Promise<void> => {
    const name = info.authenticatedAs ?? (nameIn?.value.trim() ?? '');
    if (!info.authenticatedAs && !name) {
      err.textContent = 'Enter a name to continue.';
      return;
    }
    button.disabled = true;
    err.textContent = '';
    const res = await join(slug, name, pwIn?.value ?? '');
    button.disabled = false;
    if (res.error || !res.token || !res.url || !res.room) {
      err.textContent =
        res.error === 'wrong password'
          ? 'Wrong password.'
          : res.error === 'not-configured'
            ? 'Video is not configured on this server.'
            : res.error === 'name required'
              ? 'Enter a name to continue.'
              : 'Could not join — try again.';
      return;
    }
    root.remove();
    openCall(res.room, res.url, res.token, res.name ?? name);
  };
  button.onclick = () => void submit();
  for (const el of [nameIn, pwIn]) {
    el?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') void submit();
    });
  }
}

/** Open the shared conference UI + connect media — same classes the in-world
 *  monitors use, so a guest's call looks and behaves identically. */
function openCall(room: string, url: string, token: string, displayName: string): void {
  const confUI = new ConferenceUI();
  let conf: LiveKitConference | null = null;
  const handlers: ConferenceUIHandlers = {
    toggleMic: () => void conf?.toggleMic(),
    toggleCam: () => void conf?.toggleCam(),
    toggleScreen: () => void conf?.toggleScreen(),
    switchCamera: (id) => void conf?.switchCamera(id),
    switchMic: (id) => void conf?.switchMic(id),
    switchSpeaker: (id) => void conf?.switchSpeaker(id),
    setVolume: (identity, v) => conf?.setParticipantVolume(identity, v),
    setMuted: (identity, muted) => conf?.setParticipantMuted(identity, muted),
    muteForAll: (identity) => conf?.requestMute(identity),
    sendChat: (text) => conf?.sendChat(text),
    leave: () => {
      void conf?.disconnect();
      confUI.close();
      document.title = 'Meeting ended';
      document.getElementById('app')!.innerHTML =
        '<div id="gate"><div class="box"><h1>Meeting room</h1><p class="hint">You left the meeting. Reopen the link to rejoin.</p></div></div>';
    },
  };
  document.title = `Meeting — ${room}`;
  confUI.open(`Meeting room (${displayName})`, handlers);
  conf = new LiveKitConference(confUI.stage, {
    onState: (s) => confUI.setState(s),
    onDevices: (d) => confUI.setDevices(d),
    onChat: (m) => confUI.addChat(m),
    onParticipants: (list) => confUI.setParticipants(list),
    onNotice: (text) => confUI.notice(text),
  });
  void conf.connect(url, token).catch(() => {
    /* connect() reports failures via the state callback */
  });
}

void main();
