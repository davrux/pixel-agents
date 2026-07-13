/**
 * Customer rooms portal — a professional (non-pixel) front-end on the SAME
 * authoritative backend as the Pixels/Voxel clients. Rooms are the server's zones
 * (managed in Pixels), so auth/users/rooms/voice/conference/chat are shared: any
 * server-side change applies here too. This client is just another renderer.
 *
 * First cut: pick a room (zone), see who's in it (participant list), room-wide
 * voice (ZoneVoice with proximity off), text chat, and join the room's monitors as
 * video meetings (ConferenceUI + LiveKit) — all via the shared UI modules.
 */
import { injectPaSkin } from '../ui/paSkin.js';
import { connect, isAuthError, redirectToLogin, gotoLogout } from '../net/room.js';
import { ChatUI } from '../ui/chatUI.js';
import { ZoneVoiceUI } from '../voice/ZoneVoiceUI.js';
import { ConferenceUI } from '../conference/ConferenceUI.js';
import { LiveKitConference } from '../conference/LiveKitConference.js';
import { getCatalogEntry } from '@pixel/shared/office/layout/furnitureCatalog.js';
import type { Room } from 'colyseus.js';

interface ZoneInfo { id: string; label?: string }
interface Monitor { col: number; row: number; name?: string }
/** Minimal view of the synced room state we read (see officeSync schema). */
interface RoomStateView {
  characters: { forEach(cb: (c: { folderName: string; isPlayer: boolean; agentName: string }) => void): void };
  furniture: { forEach(cb: (f: { type: string; col: number; row: number; name?: string }) => void): void };
}

let room: Room | null = null;
let zones: ZoneInfo[] = [];
let currentZone = '';
let isAdmin = false;
let myConference: Monitor | null = null;
let conf: LiveKitConference | null = null;

const confUI = new ConferenceUI();
const chat = new ChatUI({
  sendChat: (text) => void room?.send('chat', { text }),
  sendCommand: (name, args) => void room?.send('command', { name, args }),
  isAdmin: () => isAdmin,
});
let zoneVoice: ZoneVoiceUI | null = null;

// ── Professional shell ───────────────────────────────────────────────────────
const STYLE = `
  #rp-head{display:flex;align-items:center;gap:.8rem;padding:.7rem 1rem;background:var(--panel);
    border-bottom:1px solid var(--line);}
  #rp-head .brand{font-weight:650;font-size:1.05rem;letter-spacing:.2px;}
  #rp-head .spacer{flex:1;}
  #rp-head .who{color:var(--muted);font-size:.9rem;}
  #rp-head button{cursor:pointer;background:var(--panel2);color:var(--text);border:1px solid var(--line);
    border-radius:.5rem;padding:.4rem .7rem;font:inherit;font-size:.85rem;}
  #rp-head button:hover{border-color:var(--accent);}
  #rp-body{flex:1;display:flex;min-height:0;}
  #rp-rooms{width:15rem;flex:0 0 auto;border-right:1px solid var(--line);background:var(--panel);
    overflow-y:auto;padding:.6rem;}
  #rp-rooms h3,#rp-main h3{margin:.2rem .2rem .5rem;font-size:.72rem;letter-spacing:1px;text-transform:uppercase;color:var(--muted);}
  #rp-rooms .room{display:block;width:100%;text-align:left;cursor:pointer;background:transparent;color:var(--text);
    border:1px solid transparent;border-radius:.5rem;padding:.55rem .6rem;font:inherit;margin-bottom:.25rem;}
  #rp-rooms .room:hover{background:var(--panel2);}
  #rp-rooms .room.on{background:var(--panel2);border-color:var(--accent);}
  #rp-main{flex:1;min-width:0;overflow-y:auto;padding:1rem 1.2rem;}
  #rp-main .roomtitle{font-size:1.3rem;font-weight:650;margin:0 0 1rem;}
  .rp-cards{display:grid;grid-template-columns:repeat(auto-fill,minmax(15rem,1fr));gap:.7rem;margin-bottom:1.4rem;}
  .rp-card{background:var(--panel);border:1px solid var(--line);border-radius:.6rem;padding:.8rem .9rem;}
  .rp-card .t{font-weight:600;margin-bottom:.5rem;}
  .rp-card .join{cursor:pointer;background:var(--accent);color:#fff;border:0;border-radius:.5rem;padding:.45rem .8rem;font:inherit;}
  .rp-card .join:hover{filter:brightness(1.1);}
  .rp-people{list-style:none;margin:0;padding:0;}
  .rp-people li{padding:.35rem .1rem;border-bottom:1px solid var(--line);display:flex;align-items:center;gap:.5rem;}
  .rp-people li .dot{width:.5rem;height:.5rem;border-radius:50%;background:var(--accent2);}
  .rp-empty{color:var(--muted);font-size:.9rem;}
  #rp-voice{margin-top:1.2rem;}
`;

function buildShell(): void {
  injectPaSkin(); // shared widgets (chat/voice/conference) rely on the pa-* skin
  const s = document.createElement('style');
  s.textContent = STYLE;
  document.head.appendChild(s);
  const app = document.getElementById('app')!;
  app.innerHTML = `
    <div id="rp-head">
      <span class="brand">🏢 Rooms</span>
      <span class="spacer"></span>
      <span class="who"></span>
      <button data-logout>Sign out</button>
    </div>
    <div id="rp-body">
      <aside id="rp-rooms">
        <h3>Rooms</h3><div class="list"></div>
        <div id="rp-voice"><h3>Voice</h3><div class="vmount"></div></div>
      </aside>
      <main id="rp-main"></main>
    </div>`;
  app.querySelector<HTMLButtonElement>('[data-logout]')!.onclick = () => gotoLogout();
  // Persistent room-wide voice control (proximity off → everyone in the room hears
  // everyone). Lives in the sidebar so re-rendering the room view never destroys it.
  zoneVoice = new ZoneVoiceUI(app.querySelector<HTMLDivElement>('#rp-voice .vmount')!, {
    requestToken: () => { room?.send('zoneVoiceToken'); },
    announceVoice: (event) => { room?.send('voiceEvent', { event }); },
    myPosition: () => null,
    positionOf: () => null,
    onSpeakers: () => {},
    onVoiceStatus: () => {},
  });
  zoneVoice.voice.setProximity(false);
  zoneVoice.start();
}

function renderRoomList(): void {
  const list = document.querySelector<HTMLDivElement>('#rp-rooms .list');
  if (!list) return;
  list.innerHTML = '';
  for (const z of zones) {
    const b = document.createElement('button');
    b.className = 'room' + (z.id === currentZone ? ' on' : '');
    b.textContent = z.label || z.id;
    b.onclick = () => void joinZone(z.id);
    list.appendChild(b);
  }
}

function state(): RoomStateView | null {
  return (room?.state as unknown as RoomStateView) ?? null;
}

function renderRoom(): void {
  const main = document.getElementById('rp-main');
  if (!main) return;
  const zone = zones.find((z) => z.id === currentZone);
  const st = state();
  const people: string[] = [];
  st?.characters.forEach((c) => {
    if (c.isPlayer) people.push(c.folderName || c.agentName || 'Guest');
  });
  const monitors: Monitor[] = [];
  st?.furniture.forEach((f) => {
    if (getCatalogEntry(f.type)?.conference) monitors.push({ col: f.col, row: f.row, name: f.name });
  });

  main.innerHTML = `
    <div class="roomtitle">${esc(zone?.label || currentZone || '—')}</div>
    <h3>Meetings</h3>
    <div class="rp-cards" id="rp-meetings"></div>
    <h3>In this room · ${people.length}</h3>
    <ul class="rp-people" id="rp-people"></ul>`;

  const meets = main.querySelector<HTMLDivElement>('#rp-meetings')!;
  if (!monitors.length) meets.innerHTML = '<div class="rp-empty">No meeting screens set up in this room yet.</div>';
  for (const m of monitors) {
    const card = document.createElement('div');
    card.className = 'rp-card';
    const inThis = !!myConference && myConference.col === m.col && myConference.row === m.row;
    card.innerHTML = `<div class="t">📹 ${esc(m.name || `Screen ${m.col},${m.row}`)}</div>`;
    const btn = document.createElement('button');
    btn.className = 'join';
    btn.textContent = inThis ? 'In call' : 'Join call';
    btn.disabled = inThis;
    btn.onclick = () => joinMeeting(m);
    card.appendChild(btn);
    meets.appendChild(card);
  }

  const ul = main.querySelector<HTMLUListElement>('#rp-people')!;
  if (!people.length) ul.innerHTML = '<li class="rp-empty">Nobody here yet.</li>';
  for (const name of people.sort()) {
    const li = document.createElement('li');
    li.innerHTML = `<span class="dot"></span>${esc(name)}`;
    ul.appendChild(li);
  }
}

// ── Meetings (direct join — no walking, see SimRoom conferenceJoin) ───────────
function joinMeeting(m: Monitor): void {
  if (!room) return;
  if (myConference) room.send('conferenceLeave', { col: myConference.col, row: myConference.row });
  myConference = m;
  room.send('conferenceJoin', { col: m.col, row: m.row }); // membership
  room.send('conferenceToken', { col: m.col, row: m.row }); // → media token
  renderRoom();
}

function onConfToken(m: Record<string, unknown>): void {
  const c = myConference;
  if (!c || `${c.col},${c.row}` !== `${m.col},${m.row}`) return;
  const title = (c.name || '').trim() || `Meeting (${c.col}, ${c.row})`;
  confUI.open(title, {
    toggleMic: () => void conf?.toggleMic(),
    toggleCam: () => void conf?.toggleCam(),
    toggleScreen: () => void conf?.toggleScreen(),
    switchCamera: (id) => void conf?.switchCamera(id),
    switchMic: (id) => void conf?.switchMic(id),
    switchSpeaker: (id) => void conf?.switchSpeaker(id),
    sendChat: (text) => conf?.sendChat(text),
    leave: () => leaveMeeting(),
  });
  if (m.error === 'not-configured' || typeof m.url !== 'string' || typeof m.token !== 'string') {
    confUI.setState({ connected: false, camOn: true, micOn: true, screenOn: false, error: 'Video not configured on the server.' });
    return;
  }
  conf = new LiveKitConference(confUI.stage, confUI.screens, {
    onState: (s) => confUI.setState(s),
    onDevices: (d) => confUI.setDevices(d),
    onChat: (msg) => confUI.addChat(msg),
    onParticipants: (list) => confUI.setParticipants(list),
    onScreens: (n) => confUI.setSharing(n > 0),
  });
  zoneVoice?.voice.suspend(); // can't be in two calls at once
  void conf.connect(m.url as string, m.token as string).catch(() => undefined);
}

function leaveMeeting(): void {
  if (room && myConference) room.send('conferenceLeave', { col: myConference.col, row: myConference.row });
  myConference = null;
  confUI.close();
  void conf?.disconnect?.();
  conf = null;
  zoneVoice?.voice.resume();
  renderRoom();
}

// ── Connection ───────────────────────────────────────────────────────────────
function wireRoom(r: Room): void {
  r.onMessage('m', (m: Record<string, unknown>) => {
    switch (m.type) {
      case 'zoneList':
        zones = (m.zones as ZoneInfo[]) ?? [];
        if (typeof m.current === 'string') currentZone = m.current;
        renderRoomList();
        renderRoom();
        break;
      case 'chat':
        chat.addChatLine((m.from as string) ?? '?', (m.text as string) ?? '', m.at as number | undefined);
        break;
      case 'chatHistory':
        chat.addHistory((m.messages as Array<{ from?: string; text?: string; at?: number }>) ?? []);
        break;
      case 'system':
        chat.addSystemLine((m.text as string) ?? '');
        break;
      case 'zoneVoiceToken':
        zoneVoice?.onToken(m);
        break;
      case 'conferenceToken':
        onConfToken(m);
        break;
      case 'conferenceMembers':
        renderRoom(); // roster changed → refresh counts/buttons
        break;
      default:
        if (m.me && typeof m.me === 'object') isAdmin = !!(m.me as { isAdmin?: boolean }).isAdmin;
    }
  });
  // Light polling keeps the participant + meeting lists fresh without wiring every
  // schema callback (state changes as players come/go and furniture is edited).
  r.onStateChange(() => renderRoom());
}

async function joinZone(zone?: string): Promise<void> {
  if (zone && zone === currentZone && room) return;
  if (myConference) leaveMeeting();
  if (room) {
    try { await room.leave(); } catch { /* ignore */ }
    room = null;
  }
  try {
    room = await connect(zone);
  } catch (e) {
    if (isAuthError(e)) return redirectToLogin();
    document.getElementById('rp-main')!.innerHTML = `<div class="rp-empty">Could not join the room. ${esc(String(e))}</div>`;
    return;
  }
  currentZone = zone ?? currentZone;
  wireRoom(room);
  // The server sends the account + a zoneList shortly after join; render what we have.
  renderRoomList();
  renderRoom();
  // If voice was on, reconnect it to the new zone's token.
  zoneVoice?.voice.suspend();
  zoneVoice?.voice.resume();
}

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

buildShell();
void joinZone();
