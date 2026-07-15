/**
 * Customer rooms portal — a professional (non-pixel) front-end on the SAME
 * authoritative backend as the Pixels/Voxel clients. Rooms are the server's zones
 * (managed in Pixels), so auth/users/rooms/voice/conference/chat are shared: any
 * server-side change applies here too. This client is just another renderer.
 *
 * Teams-like layout: left rail of rooms, a center pane (meetings + who's here) with
 * a call-controls bar at the bottom, and an integrated chat column on the right.
 * Voice is room-wide (no proximity — that makes no sense here) and built directly
 * on the shared ZoneVoice engine, so it carries no pixel-menu chrome. Video meetings
 * still open in the shared ConferenceUI modal.
 */
import { connect, isAuthError, isZoneLockedError, isForbiddenError, isServerUp, redirectToLogin, gotoLogout } from '../net/room.js';
import { injectPaSkin } from '../ui/paSkin.js';
import { ZoneVoice, type ZoneVoiceState } from '../voice/ZoneVoice.js';
import { ConferenceUI } from '../conference/ConferenceUI.js';
import { LiveKitConference } from '../conference/LiveKitConference.js';
import { getCatalogEntry, buildDynamicCatalog } from '@pixel/shared/office/layout/furnitureCatalog.js';
import { KICK_CLOSE_CODE } from '@pixel/shared/commands';
import type { Room } from 'colyseus.js';

interface ZoneInfo { id: string; label?: string }
interface Monitor { col: number; row: number; name?: string }
interface Person { ids: number[]; name: string; pixels: boolean; rooms: boolean }
/** Minimal view of the synced room state we read (see officeSync schema). */
interface RoomStateView {
  characters: {
    forEach(cb: (c: { id: number; folderName: string; isPlayer: boolean; agentName: string; spectator: boolean }) => void): void;
  };
  furniture: { forEach(cb: (f: { type: string; col: number; row: number; name?: string }) => void): void };
}

let room: Room | null = null;
let zones: ZoneInfo[] = [];
let currentZone = '';
let isAdmin = false;
let role: 'admin' | 'user' | 'customer' = 'user';
/** For customers: the only rooms they may enter (the portal hides the rest). */
let assignedZones: string[] | null = null;
/** Monitor keys ("col,row") that are password-locked in the current room. */
const lockedMonitors = new Set<string>();
/** Remembered zone passwords so switching back doesn't re-prompt this session. */
const zonePasswords = new Map<string, string>();
/** Remembered monitor passwords, keyed "col,row". */
const monitorPasswords = new Map<string, string>();
let myConference: Monitor | null = null;
let conf: LiveKitConference | null = null;

type ConnState = 'connecting' | 'connected' | 'reconnecting' | 'kicked';
/** True while we tear down a room on purpose (zone switch) — suppresses reconnect. */
let leavingIntentionally = false;
let reconnecting = false;

let voice: ZoneVoice | null = null;
let voiceState: ZoneVoiceState | null = null;
const talking = new Set<number>(); // player ids currently speaking (room voice)
const confUI = new ConferenceUI();

// ── Professional (Teams-like) shell ───────────────────────────────────────────
const STYLE = `
  #rp-head{display:flex;align-items:center;gap:.8rem;padding:.65rem 1rem;background:var(--panel);
    border-bottom:1px solid var(--line);}
  #rp-head .brand{font-weight:650;font-size:1.05rem;letter-spacing:.2px;}
  #rp-head .spacer{flex:1;}
  #rp-head .who{color:var(--muted);font-size:.9rem;}
  #rp-conn{display:inline-flex;align-items:center;gap:.4rem;color:var(--muted);font-size:.82rem;}
  #rp-conn .dot{width:.55rem;height:.55rem;border-radius:50%;background:var(--muted);transition:background .2s;}
  #rp-conn.ok .dot{background:var(--accent2);}
  #rp-conn.warn .dot{background:#d9a441;animation:rp-pulse 1s infinite ease-in-out;}
  #rp-conn.bad .dot{background:#b4453f;}
  @keyframes rp-pulse{0%,100%{opacity:.4;}50%{opacity:1;}}
  #rp-head button{cursor:pointer;background:var(--panel2);color:var(--text);border:1px solid var(--line);
    border-radius:.5rem;padding:.4rem .7rem;font:inherit;font-size:.85rem;}
  #rp-head button:hover{border-color:var(--accent);}
  #rp-head #rp-pixels{background:var(--accent);border-color:transparent;color:#fff;}
  #rp-head #rp-pixels[hidden]{display:none;}
  #rp-body{flex:1;display:flex;min-height:0;}

  /* Left rail — rooms */
  #rp-rooms{width:15rem;flex:0 0 auto;border-right:1px solid var(--line);background:var(--panel);
    overflow-y:auto;padding:.6rem;}
  #rp-rooms h3{margin:.2rem .2rem .5rem;font-size:.72rem;letter-spacing:1px;text-transform:uppercase;color:var(--muted);}
  #rp-rooms .room{display:block;width:100%;text-align:left;cursor:pointer;background:transparent;color:var(--text);
    border:1px solid transparent;border-radius:.5rem;padding:.55rem .6rem;font:inherit;margin-bottom:.25rem;}
  #rp-rooms .room:hover{background:var(--panel2);}
  #rp-rooms .room.on{background:var(--panel2);border-color:var(--accent);}

  /* Center column — meetings + roster + call bar */
  #rp-center{width:20rem;flex:0 0 auto;display:flex;flex-direction:column;}
  #rp-main{flex:1;min-height:0;overflow-y:auto;padding:1rem 1.2rem;}
  #rp-main h3{margin:.2rem .2rem .5rem;font-size:.72rem;letter-spacing:1px;text-transform:uppercase;color:var(--muted);}
  #rp-main .roomtitle{font-size:1.3rem;font-weight:650;margin:0 0 1rem;}
  .rp-cards{display:grid;grid-template-columns:repeat(auto-fill,minmax(15rem,1fr));gap:.7rem;margin-bottom:1.4rem;}
  .rp-card{background:var(--panel);border:1px solid var(--line);border-radius:.6rem;padding:.8rem .9rem;}
  .rp-card .t{font-weight:600;margin-bottom:.5rem;}
  .rp-card .join{cursor:pointer;background:var(--accent);color:#fff;border:0;border-radius:.5rem;padding:.45rem .8rem;font:inherit;}
  .rp-card .join:hover{filter:brightness(1.1);}
  .rp-card .join:disabled{opacity:.55;cursor:default;}
  .rp-people{list-style:none;margin:0;padding:0;}
  .rp-people li{padding:.4rem .1rem;border-bottom:1px solid var(--line);display:flex;align-items:center;gap:.55rem;}
  .rp-people li .av{width:1.7rem;height:1.7rem;flex:0 0 auto;border-radius:50%;background:var(--panel2);
    display:flex;align-items:center;justify-content:center;font-size:.8rem;color:var(--text);border:2px solid transparent;}
  .rp-people li.talking .av{border-color:var(--accent2);box-shadow:0 0 0 2px var(--accent2) inset;}
  .rp-people li .tag{font-size:.62rem;letter-spacing:.4px;text-transform:uppercase;padding:.1rem .4rem;border-radius:1rem;
    margin-left:.4rem;border:1px solid var(--line);color:var(--muted);}
  .rp-people li .tag.pixels{color:#cdd6ff;border-color:var(--accent);}
  .rp-people li .tag.rooms{color:#bff0d8;border-color:var(--accent2);}
  .rp-people li .spk{margin-left:auto;color:var(--accent2);font-size:.85rem;opacity:0;}
  .rp-people li.talking .spk{opacity:1;}
  .rp-empty{color:var(--muted);font-size:.9rem;}

  /* Call bar (room voice) */
  #rp-callbar{flex:0 0 auto;display:flex;align-items:center;gap:.7rem;padding:.6rem 1.2rem;
    background:var(--panel);border-top:1px solid var(--line);}
  #rp-callbar .status{display:flex;align-items:center;gap:.5rem;color:var(--muted);font-size:.9rem;}
  #rp-callbar .status .dot{width:.55rem;height:.55rem;border-radius:50%;background:var(--muted);}
  #rp-callbar .status.live .dot{background:var(--accent2);}
  #rp-callbar .spacer{flex:1;}
  #rp-callbar button{cursor:pointer;font:inherit;border-radius:2rem;border:1px solid var(--line);
    padding:.45rem .9rem;background:var(--panel2);color:var(--text);}
  #rp-callbar button:hover{filter:brightness(1.12);}
  #rp-callbar button:disabled{opacity:.5;cursor:default;}
  #rp-callbar button.primary{background:var(--accent);border-color:transparent;color:#fff;}
  #rp-callbar button.leave{background:#7f1d1d;border-color:transparent;color:#fff;}
  #rp-callbar button.muted{background:#7f1d1d;border-color:transparent;color:#fff;}

  /* Right chat column */
  #rp-chat{flex:1;min-width:0;border-right:1px solid var(--line);background:var(--panel);
    display:flex;flex-direction:column;min-height:0;}
  #rp-chat h3{margin:0;padding:.7rem 1rem;font-size:.72rem;letter-spacing:1px;text-transform:uppercase;color:var(--muted);
    border-bottom:1px solid var(--line);}
  #rp-chatlog{flex:1;min-height:0;overflow-y:auto;padding:.7rem .9rem;display:flex;flex-direction:column;gap:.55rem;}
  #rp-chatlog .msg .from{font-size:.72rem;color:var(--muted);margin-bottom:.1rem;display:flex;align-items:baseline;gap:.5rem;}
  #rp-chatlog .msg .from .time{font-size:.68rem;color:var(--muted);opacity:.7;}
  #rp-chatlog .msg .body{background:var(--panel2);border-radius:.55rem;padding:.4rem .6rem;font-size:.92rem;
    word-break:break-word;white-space:pre-wrap;}
  #rp-chatlog .sys{color:var(--muted);font-size:.82rem;font-style:italic;text-align:center;}
  #rp-chatform{flex:0 0 auto;display:flex;gap:.4rem;padding:.6rem;border-top:1px solid var(--line);}
  #rp-chatform input{flex:1;min-width:0;background:var(--panel2);color:var(--text);border:1px solid var(--line);
    border-radius:.5rem;padding:.5rem .6rem;font:inherit;}
  #rp-chatform input:focus{outline:none;border-color:var(--accent);}
  #rp-chatform button{cursor:pointer;background:var(--accent);color:#fff;border:0;border-radius:.5rem;padding:.5rem .8rem;font:inherit;}
`;

function buildShell(): void {
  injectPaSkin(); // the shared ConferenceUI modal still relies on the pa-* skin
  const s = document.createElement('style');
  s.textContent = STYLE;
  document.head.appendChild(s);
  const app = document.getElementById('app')!;
  app.innerHTML = `
    <div id="rp-head">
      <span class="brand">🏢 Rooms</span>
      <span class="spacer"></span>
      <button id="rp-pixels" hidden>Open in Pixels ↗</button>
      <span id="rp-conn" class="conn"><span class="dot"></span><span class="txt">Connecting…</span></span>
      <span class="who"></span>
      <button data-logout>Sign out</button>
    </div>
    <div id="rp-body">
      <aside id="rp-rooms"><h3>Rooms</h3><div class="list"></div></aside>
      <aside id="rp-chat">
        <h3>Chat</h3>
        <div id="rp-chatlog"></div>
        <form id="rp-chatform" autocomplete="off">
          <input name="t" placeholder="Message the room…" maxlength="500" />
          <button type="submit">Send</button>
        </form>
      </aside>
      <section id="rp-center">
        <main id="rp-main"></main>
        <div id="rp-callbar">
          <div class="status"><span class="dot"></span><span class="txt">Audio off</span></div>
          <div class="spacer"></div>
          <button class="mic" hidden></button>
          <button class="join primary"></button>
        </div>
      </section>
    </div>`;
  app.querySelector<HTMLButtonElement>('[data-logout]')!.onclick = () => gotoLogout();
  // Switch to the Pixels 2D world at the current room (shown only if allowed).
  app.querySelector<HTMLButtonElement>('#rp-pixels')!.onclick = () => {
    window.location.href = currentZone ? `./?zone=${encodeURIComponent(currentZone)}` : './';
  };

  buildVoice();
  wireCallBar();
  wireChatForm();
}

// ── Connection status + auto-reconnect ───────────────────────────────────────
function setConn(state: ConnState): void {
  const el = document.getElementById('rp-conn');
  if (!el) return;
  const cls = { connecting: 'warn', connected: 'ok', reconnecting: 'warn', kicked: 'bad' }[state];
  const txt = {
    connecting: 'Connecting…',
    connected: 'Connected',
    reconnecting: 'Reconnecting…',
    kicked: 'Disconnected',
  }[state];
  el.className = 'conn ' + cls;
  el.querySelector<HTMLSpanElement>('.txt')!.textContent = txt;
}

/** Connection dropped unexpectedly (e.g. server restart): poll /health, then
 *  rejoin the current room in place — no reload, so we stay in the same zone. */
function scheduleReconnect(): void {
  if (reconnecting || leavingIntentionally) return;
  reconnecting = true;
  setConn('reconnecting');
  room = null; // the dead room object — drop it so joinZone reconnects fresh
  const poll = async (): Promise<void> => {
    if (await isServerUp()) {
      reconnecting = false;
      await joinZone(currentZone || undefined);
      return;
    }
    window.setTimeout(() => void poll(), 2000);
  };
  window.setTimeout(() => void poll(), 1500);
}

function showKicked(): void {
  leavingIntentionally = true;
  setConn('kicked');
  const app = document.getElementById('app')!;
  const o = document.createElement('div');
  o.style.cssText =
    'position:fixed;inset:0;z-index:300;display:flex;align-items:center;justify-content:center;' +
    'background:rgba(15,14,25,.88);color:var(--text);font-size:1.1rem;text-align:center;';
  o.innerHTML = 'You were disconnected by an administrator.<br><br>' +
    '<button style="cursor:pointer;background:var(--accent);color:#fff;border:0;border-radius:.5rem;padding:.5rem 1rem;font:inherit">Reload</button>';
  o.querySelector('button')!.addEventListener('click', () => window.location.reload());
  app.appendChild(o);
}

// ── Room-wide voice (ZoneVoice engine, no proximity, no pixel chrome) ─────────
function buildVoice(): void {
  voice = new ZoneVoice(
    {
      requestToken: () => { room?.send('zoneVoiceToken'); },
      announceVoice: (event) => { room?.send('voiceEvent', { event }); },
      myPosition: () => null,
      positionOf: () => null, // non-spatial: distance never matters here
      onSpeakers: (ids) => {
        talking.clear();
        for (const id of ids) talking.add(id);
        updateTalking();
      },
      onVoiceStatus: () => {},
    },
    (st) => { voiceState = st; renderCallBar(); },
    () => {}, // peers list — the roster below already shows who's here
    () => {}, // device changes — device pickers deferred
    () => {}, // mic level meter — deferred
  );
  voice.setProximity(false); // room-wide: everyone in the room hears everyone
  voice.autoStart(); // reconnect if the user had audio on before
}

function wireCallBar(): void {
  const bar = document.getElementById('rp-callbar')!;
  bar.querySelector<HTMLButtonElement>('.join')!.onclick = () => {
    if (!voice) return;
    voice.isEnabled ? voice.leave() : voice.join();
  };
  bar.querySelector<HTMLButtonElement>('.mic')!.onclick = () => voice?.toggleMic();
}

function renderCallBar(): void {
  const bar = document.getElementById('rp-callbar');
  if (!bar) return;
  const s = voiceState;
  const connected = !!s?.connected;
  const connecting = !!s?.connecting;
  const statusEl = bar.querySelector<HTMLDivElement>('.status')!;
  const txtEl = bar.querySelector<HTMLSpanElement>('.status .txt')!;
  const joinBtn = bar.querySelector<HTMLButtonElement>('.join')!;
  const micBtn = bar.querySelector<HTMLButtonElement>('.mic')!;

  statusEl.classList.toggle('live', connected);
  txtEl.textContent = connected
    ? s!.micOn ? 'Live — your mic is on' : 'Live — your mic is muted'
    : connecting ? 'Connecting…' : 'Audio off';

  const enabled = voice?.isEnabled ?? false;
  joinBtn.textContent = enabled ? 'Leave audio' : 'Join audio';
  joinBtn.classList.toggle('primary', !enabled);
  joinBtn.classList.toggle('leave', enabled);

  micBtn.hidden = !connected;
  if (connected) {
    micBtn.textContent = s!.micOn ? '🎙 Mute' : '🔇 Unmute';
    micBtn.classList.toggle('muted', !s!.micOn);
  }
}

/** Toggle the talking highlight on roster rows without a full re-render. */
function updateTalking(): void {
  document.querySelectorAll<HTMLLIElement>('#rp-people li[data-ids]').forEach((li) => {
    const ids = (li.dataset.ids ?? '').split(',').map(Number);
    li.classList.toggle('talking', ids.some((id) => talking.has(id)));
  });
}

// ── Chat (integrated column) ──────────────────────────────────────────────────
function wireChatForm(): void {
  const form = document.getElementById('rp-chatform') as HTMLFormElement;
  form.onsubmit = (e) => {
    e.preventDefault();
    const input = form.elements.namedItem('t') as HTMLInputElement;
    const text = input.value.trim();
    if (!text) return;
    if (text.startsWith('/')) {
      const [name, ...rest] = text.slice(1).split(' ');
      room?.send('command', { name, args: rest.join(' ') });
    } else {
      room?.send('chat', { text });
    }
    input.value = '';
  };
}

function chatAtBottom(): boolean {
  const log = document.getElementById('rp-chatlog');
  return !log || log.scrollHeight - log.scrollTop - log.clientHeight < 40;
}
function chatScroll(): void {
  const log = document.getElementById('rp-chatlog');
  if (log) log.scrollTop = log.scrollHeight;
}
function fmtTime(at?: number): string {
  const d = at ? new Date(at) : new Date();
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}
function addChatLine(from: string, text: string, at?: number): void {
  const log = document.getElementById('rp-chatlog');
  if (!log) return;
  const stick = chatAtBottom();
  const el = document.createElement('div');
  el.className = 'msg';
  el.innerHTML = `<div class="from">${esc(from)}<span class="time">${fmtTime(at)}</span></div>` +
    `<div class="body">${esc(text)}</div>`;
  log.appendChild(el);
  if (stick) chatScroll();
}
function addSystemLine(text: string): void {
  const log = document.getElementById('rp-chatlog');
  if (!log) return;
  const stick = chatAtBottom();
  const el = document.createElement('div');
  el.className = 'sys';
  el.textContent = text;
  log.appendChild(el);
  if (stick) chatScroll();
}
function resetChat(): void {
  const log = document.getElementById('rp-chatlog');
  if (log) log.innerHTML = '';
}

// ── Room list + room view ─────────────────────────────────────────────────────
function renderRoomList(): void {
  const list = document.querySelector<HTMLDivElement>('#rp-rooms .list');
  if (!list) return;
  list.innerHTML = '';
  // Customers only ever see the rooms they've been assigned to.
  const visible = role === 'customer' && assignedZones ? zones.filter((z) => assignedZones!.includes(z.id)) : zones;
  if (!visible.length) list.innerHTML = '<div class="rp-empty" style="padding:.4rem .6rem">No rooms assigned yet.</div>';
  for (const z of visible) {
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

/** Players in the room, deduped by name (the same person on two clients — e.g.
 *  Pixels + this portal — has a character per session). Keep all their ids so the
 *  talking highlight matches whichever session is speaking. */
function collectPeople(): Person[] {
  const byName = new Map<string, Person>();
  state()?.characters?.forEach((c) => {
    if (!c.isPlayer) return;
    const name = c.folderName || c.agentName || 'Guest';
    let p = byName.get(name);
    if (!p) { p = { ids: [], name, pixels: false, rooms: false }; byName.set(name, p); }
    p.ids.push(c.id);
    // Where the person is present: a portal viewer is a spectator, a walking
    // Pixels avatar is not. Someone in both gets both badges.
    if (c.spectator) p.rooms = true;
    else p.pixels = true;
  });
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

function collectMonitors(): Monitor[] {
  const monitors: Monitor[] = [];
  state()?.furniture?.forEach((f) => {
    if (getCatalogEntry(f.type)?.conference) monitors.push({ col: f.col, row: f.row, name: f.name });
  });
  return monitors;
}

/** Full (re)build of the room view shell. Called on structural changes (zone
 *  switch, catalog load, join/leave). The frequent participant updates go through
 *  renderPeople() so the meeting buttons aren't destroyed mid-click. */
function renderRoom(): void {
  const main = document.getElementById('rp-main');
  if (!main) return;
  const zone = zones.find((z) => z.id === currentZone);
  main.innerHTML = `
    <div class="roomtitle">${esc(zone?.label || currentZone || '—')}</div>
    <h3>Meetings</h3>
    <div class="rp-cards" id="rp-meetings"></div>
    <h3 id="rp-people-h">In this room</h3>
    <ul class="rp-people" id="rp-people"></ul>`;
  renderMeetings();
  lastPeopleSig = ''; // the shell was rebuilt (empty list) → force a fill
  renderPeople();
}

function renderMeetings(): void {
  const meets = document.getElementById('rp-meetings');
  if (!meets) return;
  const monitors = collectMonitors();
  meets.innerHTML = '';
  if (!monitors.length) {
    meets.innerHTML = '<div class="rp-empty">No meeting screens set up in this room yet.</div>';
    return;
  }
  for (const m of monitors) {
    const card = document.createElement('div');
    card.className = 'rp-card';
    const inThis = !!myConference && myConference.col === m.col && myConference.row === m.row;
    const locked = lockedMonitors.has(`${m.col},${m.row}`);
    card.innerHTML = `<div class="t">📹 ${esc(m.name || `Screen ${m.col},${m.row}`)}${locked ? ' 🔒' : ''}</div>`;
    const btn = document.createElement('button');
    btn.className = 'join';
    btn.textContent = inThis ? 'In call' : 'Join call';
    btn.disabled = inThis;
    btn.onclick = () => joinMeeting(m);
    card.appendChild(btn);
    meets.appendChild(card);
  }
}

// State patches fire ~20 Hz (avatars move); coalesce participant re-renders to one
// per animation frame and skip the DOM rebuild entirely when the roster is
// unchanged — so an idle portal does no per-patch DOM work.
let peopleRaf = 0;
let lastPeopleSig = '';
function schedulePeople(): void {
  if (peopleRaf) return;
  peopleRaf = requestAnimationFrame(() => { peopleRaf = 0; renderPeople(); });
}

/** Cheap update of just the participant list + count (safe to call on every state
 *  patch — leaves the meeting cards/buttons untouched). Skips work when nothing
 *  about the roster changed (talking is applied separately via updateTalking). */
function renderPeople(): void {
  const ul = document.getElementById('rp-people');
  if (!ul) return;
  const people = collectPeople();
  // Signature of what actually affects this list; identical → nothing to redraw.
  const sig = people.map((p) => `${p.name}${p.pixels ? 1 : 0}${p.rooms ? 1 : 0}${p.ids.join('.')}`).join('');
  if (sig === lastPeopleSig) return;
  lastPeopleSig = sig;
  const h = document.getElementById('rp-people-h');
  if (h) h.textContent = `In this room · ${people.length}`;
  ul.innerHTML = '';
  if (!people.length) {
    ul.innerHTML = '<li class="rp-empty">Nobody here yet.</li>';
    return;
  }
  for (const p of people) {
    const li = document.createElement('li');
    li.dataset.ids = p.ids.join(',');
    if (p.ids.some((id) => talking.has(id))) li.classList.add('talking');
    const tags =
      (p.pixels ? '<span class="tag pixels">Pixels</span>' : '') +
      (p.rooms ? '<span class="tag rooms">Rooms</span>' : '');
    li.innerHTML =
      `<span class="av">${esc(initials(p.name))}</span>${esc(p.name)}${tags}<span class="spk">🔊</span>`;
    ul.appendChild(li);
  }
}

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return '?';
  return (parts[0][0] + (parts[1]?.[0] ?? '')).toUpperCase();
}

// ── Meetings (direct join — no walking, see SimRoom conferenceJoin) ───────────
function joinMeeting(m: Monitor): void {
  if (!room) return;
  if (myConference) room.send('conferenceLeave', { col: myConference.col, row: myConference.row });
  myConference = m;
  room.send('conferenceJoin', { col: m.col, row: m.row }); // membership
  requestConfToken(m); // → media token (with password if the monitor is locked)
  renderMeetings();
}

/** Ask the server for a monitor's media token, supplying a remembered password. */
function requestConfToken(m: Monitor): void {
  room?.send('conferenceToken', { col: m.col, row: m.row, password: monitorPasswords.get(`${m.col},${m.row}`) });
}

function onConfToken(m: Record<string, unknown>): void {
  const c = myConference;
  if (!c || `${c.col},${c.row}` !== `${m.col},${m.row}`) return;
  // Locked monitor → prompt for its password and retry the token request.
  if (m.error === 'locked') {
    const pw = prompt('This meeting is password-protected. Enter the meeting password:');
    if (pw == null) { leaveMeeting(); return; }
    monitorPasswords.set(`${c.col},${c.row}`, pw);
    requestConfToken(c);
    return;
  }
  const title = (c.name || '').trim() || `Meeting (${c.col}, ${c.row})`;
  confUI.open(title, {
    toggleMic: () => void conf?.toggleMic(),
    toggleCam: () => void conf?.toggleCam(),
    toggleScreen: () => void conf?.toggleScreen(),
    switchCamera: (id) => void conf?.switchCamera(id),
    switchMic: (id) => void conf?.switchMic(id),
    switchSpeaker: (id) => void conf?.switchSpeaker(id),
    setVolume: (identity, v) => conf?.setParticipantVolume(identity, v),
    setMuted: (identity, muted) => conf?.setParticipantMuted(identity, muted),
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
  voice?.suspend(); // can't be in two calls at once
  void conf.connect(m.url as string, m.token as string).catch(() => undefined);
}

function leaveMeeting(): void {
  if (room && myConference) room.send('conferenceLeave', { col: myConference.col, row: myConference.row });
  myConference = null;
  confUI.close();
  void conf?.disconnect?.();
  conf = null;
  voice?.resume();
  renderMeetings();
}

// ── Connection ───────────────────────────────────────────────────────────────
function wireRoom(r: Room): void {
  // Auto-reconnect: an unexpected close (server restart / network drop) → poll and
  // rejoin. An admin kick stops reconnection; a consented leave (zone switch, code
  // 1000) is ignored (leavingIntentionally guards that path).
  r.onLeave((code) => {
    if (code === KICK_CLOSE_CODE) return showKicked();
    if (!leavingIntentionally && code !== 1000) scheduleReconnect();
  });
  r.onMessage('m', (m: Record<string, unknown>) => {
    switch (m.type) {
      case 'zoneList':
        zones = (m.zones as ZoneInfo[]) ?? [];
        if (typeof m.current === 'string') currentZone = m.current;
        renderRoomList();
        renderRoom();
        break;
      case 'chat':
        addChatLine((m.from as string) ?? '?', (m.text as string) ?? '', m.at as number | undefined);
        break;
      case 'chatHistory':
        for (const msg of (m.messages as Array<{ from?: string; text?: string; at?: number }>) ?? [])
          addChatLine(msg.from ?? '?', msg.text ?? '', msg.at);
        break;
      case 'system':
        addSystemLine((m.text as string) ?? '');
        break;
      case 'furnitureAssetsLoaded':
        // The catalog (which furniture is a conference monitor) is built from this
        // bootstrap message — without it getCatalogEntry() is empty and no meetings
        // show up. Rebuild, then re-render so the room's meeting screens appear.
        if (Array.isArray(m.catalog)) {
          buildDynamicCatalog({ catalog: m.catalog as never, sprites: (m.sprites ?? {}) as never });
          renderRoom();
        }
        break;
      case 'zoneVoiceToken':
        void voice?.onToken(m);
        break;
      case 'conferenceToken':
        onConfToken(m);
        break;
      case 'conferenceMembers':
        renderMeetings(); // membership changed → refresh join/in-call buttons
        break;
      case 'viewerIdentity': {
        isAdmin = !!m.isAdmin;
        role = (m.role as typeof role) ?? 'user';
        assignedZones = Array.isArray(m.assignedZones) ? (m.assignedZones as string[]) : null;
        const who = document.querySelector<HTMLSpanElement>('#rp-head .who');
        const name = typeof m.username === 'string' ? m.username : '';
        if (who) who.textContent = name;
        const pixBtn = document.getElementById('rp-pixels');
        if (pixBtn) pixBtn.hidden = !m.canPixels; // only offer the jump when permitted
        renderRoomList();
        break;
      }
      case 'monitorLocks':
        lockedMonitors.clear();
        for (const k of (m.keys as string[]) ?? []) lockedMonitors.add(k);
        renderRoom();
        break;
    }
  });
  // State patches fire often (avatars move); coalesce to one participant refresh
  // per frame (and it self-skips when the roster is unchanged). Rebuilding the
  // meeting cards here would destroy the Join-call button mid-click, so those go
  // through renderRoom/Meetings on structural changes (catalog/zone/membership).
  r.onStateChange(() => schedulePeople());
}

async function joinZone(zone?: string): Promise<void> {
  if (zone && zone === currentZone && room) return;
  if (myConference) leaveMeeting();
  if (room) {
    leavingIntentionally = true; // our own teardown — don't trigger auto-reconnect
    try { await room.leave(); } catch { /* ignore */ }
    room = null;
    leavingIntentionally = false;
  }
  setConn('connecting');
  // Retry loop so a locked room can re-prompt on a wrong password.
  for (;;) {
    try {
      // Spectator: the portal is a non-spatial view — join for presence/voice/chat
      // without spawning a second walking avatar next to the user's Pixels one.
      room = await connect(zone, false, { zonePassword: zone ? zonePasswords.get(zone) : undefined, spectator: true });
      break;
    } catch (e) {
      if (isForbiddenError(e)) {
        document.getElementById('rp-main')!.innerHTML = '<div class="rp-empty">You don\'t have access to this room.</div>';
        return;
      }
      if (isZoneLockedError(e) && zone) {
        const pw = prompt('This room is password-protected. Enter the room password:');
        if (pw == null) return; // cancelled
        zonePasswords.set(zone, pw);
        continue; // retry with the password
      }
      if (isAuthError(e)) return redirectToLogin();
      document.getElementById('rp-main')!.innerHTML = `<div class="rp-empty">Could not join the room. ${esc(String(e))}</div>`;
      return;
    }
  }
  currentZone = zone ?? currentZone;
  setConn('connected');
  lockedMonitors.clear();
  resetChat();
  wireRoom(room);
  // The server sends the account + a zoneList shortly after join; render what we have.
  renderRoomList();
  renderRoom();
  // If voice was on, reconnect it to the new zone's token.
  voice?.suspend();
  voice?.resume();
}

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

buildShell();
void joinZone();
