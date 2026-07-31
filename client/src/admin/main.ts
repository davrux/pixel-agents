/**
 * Administration page — admin-only user + room management on the shared backend.
 * A thin SPA over the admin REST API (server/src/adminApi.ts); the server enforces
 * admin access, so this page just presents the data and issues the calls.
 *
 * Users: create / delete / change role / reset password. Rooms: set or clear a
 * room's entry password and each monitor's call password (stored hashed
 * server-side). The last admin can't be deleted/demoted.
 */
import { redirectToLogin, gotoLogout } from '../net/room.js';
import { adminApi, type AdminUser, type AdminZone, type AdminMeetingRoom, type Role } from './api.js';

let users: AdminUser[] = [];
let zones: AdminZone[] = [];
let meetingRooms: AdminMeetingRoom[] = [];
let tab: 'users' | 'rooms' | 'meetings' = 'users';
const ROLE_LABEL: Record<Role, string> = { admin: 'Admin', user: 'User' };

const STYLE = `
  #pa-adm-head{display:flex;align-items:center;gap:.8rem;padding:.7rem 1.1rem;background:var(--panel);
    border-bottom:1px solid var(--line);}
  #pa-adm-head .brand{font-weight:650;font-size:1.05rem;}
  #pa-adm-head .spacer{flex:1;}
  #pa-adm-head button{cursor:pointer;background:var(--panel2);color:var(--text);border:1px solid var(--line);
    border-radius:.5rem;padding:.4rem .7rem;font:inherit;font-size:.85rem;}
  #pa-adm-tabs{display:flex;gap:.3rem;padding:.7rem 1.1rem 0;background:var(--panel);}
  #pa-adm-tabs button{cursor:pointer;background:transparent;color:var(--muted);border:0;border-bottom:2px solid transparent;
    padding:.5rem .8rem;font:inherit;font-size:.95rem;}
  #pa-adm-tabs button.on{color:var(--text);border-bottom-color:var(--accent);}
  #pa-adm-toast{min-height:1.2rem;padding:.3rem 1.1rem;color:var(--muted);font-size:.85rem;}
  #pa-adm-toast.err{color:#f0a6a2;}
  #pa-adm-view{padding:.4rem 1.1rem 2rem;max-width:60rem;}
  .pa-adm-card{background:var(--panel);border:1px solid var(--line);border-radius:.7rem;padding:1rem 1.1rem;margin-bottom:1rem;}
  .pa-adm-card h2{margin:0 0 .8rem;font-size:1rem;}
  table{width:100%;border-collapse:collapse;}
  th,td{text-align:left;padding:.5rem .5rem;border-bottom:1px solid var(--line);font-size:.92rem;vertical-align:middle;}
  th{color:var(--muted);font-weight:600;font-size:.72rem;letter-spacing:.6px;text-transform:uppercase;}
  input,select{background:var(--panel2);color:var(--text);border:1px solid var(--line);border-radius:.45rem;
    padding:.4rem .5rem;font:inherit;font-size:.9rem;}
  input:focus,select:focus{outline:none;border-color:var(--accent);}
  button.act{cursor:pointer;font:inherit;font-size:.85rem;border-radius:.45rem;border:1px solid var(--line);
    padding:.35rem .6rem;background:var(--panel2);color:var(--text);margin-right:.3rem;}
  button.act:hover{border-color:var(--accent);}
  button.primary{background:var(--accent);border-color:transparent;color:#fff;}
  button.danger{background:var(--danger);border-color:transparent;color:#fff;}
  .row{display:flex;gap:.5rem;align-items:center;flex-wrap:wrap;}
  .lock{color:var(--accent2);}
  .muted{color:var(--muted);}
  .status-off{color:var(--danger);}
  .rooms-panel{padding:.5rem 0 .2rem;}
  .rooms-panel label{display:inline-flex;align-items:center;gap:.35rem;margin:.15rem .8rem .15rem 0;font-size:.9rem;}
  .mon-list{margin:.4rem 0 0;padding:.5rem .6rem;background:var(--panel2);border-radius:.5rem;}
  .mon-list .row{margin:.3rem 0;}
`;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}
function toast(msg: string, err = false): void {
  const t = document.getElementById('pa-adm-toast');
  if (!t) return;
  t.textContent = msg;
  t.classList.toggle('err', err);
}
/** Turn an API error code into a readable line. */
function fail(prefix: string, error?: string): void {
  const map: Record<string, string> = {
    'last admin': 'the last admin cannot be removed or demoted',
    'weak password': 'password too short (min 6 characters)',
    'user exists': 'a user with that login id already exists',
    'invalid login id': 'invalid login id',
    'cannot delete yourself': 'you cannot delete your own account',
    'cannot disable yourself': 'you cannot disable your own account',
    forbidden: 'not allowed',
  };
  toast(`${prefix}: ${error ? (map[error] ?? error) : 'failed'}`, true);
}

function buildShell(): void {
  const s = document.createElement('style');
  s.textContent = STYLE;
  document.head.appendChild(s);
  const app = document.getElementById('app')!;
  app.innerHTML = `
    <div id="pa-adm-head"><span class="brand">🛡 Administration</span><span class="spacer"></span>
      <button data-pixels>← Pixels</button>
      <button data-logout>Sign out</button></div>
    <div id="pa-adm-tabs">
      <button data-tab="users">Users</button>
      <button data-tab="rooms">Rooms</button>
      <button data-tab="meetings">Meetings</button>
    </div>
    <div id="pa-adm-toast"></div>
    <div id="pa-adm-view"></div>`;
  app.querySelector<HTMLButtonElement>('[data-pixels]')!.onclick = () => { window.location.href = './'; };
  app.querySelector<HTMLButtonElement>('[data-logout]')!.onclick = () => gotoLogout();
  app.querySelectorAll<HTMLButtonElement>('#pa-adm-tabs button').forEach((b) => {
    b.onclick = () => { tab = b.dataset.tab as typeof tab; render(); };
  });
}

function render(): void {
  document.querySelectorAll<HTMLButtonElement>('#pa-adm-tabs button').forEach((b) =>
    b.classList.toggle('on', b.dataset.tab === tab),
  );
  if (tab === 'users') void renderUsers();
  else if (tab === 'rooms') void renderRooms();
  else void renderMeetings();
}

// ── Users ──────────────────────────────────────────────────────────────────
async function refreshUsers(): Promise<boolean> {
  const r = await adminApi.listUsers();
  if (r.status === 401) return redirectToLogin(), false;
  if (r.status === 403) {
    document.getElementById('pa-adm-view')!.innerHTML = '<div class="pa-adm-card">This page is for administrators only.</div>';
    return false;
  }
  users = r.data?.users ?? [];
  return true;
}

async function renderUsers(): Promise<void> {
  if (!(await refreshUsers())) return;
  const view = document.getElementById('pa-adm-view')!;
  view.innerHTML = '';

  // Create form
  const create = el('div', 'pa-adm-card');
  create.innerHTML = '<h2>Create account</h2>';
  const form = el('div', 'row');
  const idIn = el('input'); idIn.placeholder = 'login id'; idIn.size = 16;
  const pwIn = el('input'); pwIn.placeholder = 'password'; pwIn.type = 'password';
  const roleSel = el('select');
  for (const r of ['user', 'admin'] as Role[]) roleSel.appendChild(new Option(ROLE_LABEL[r], r));
  const addBtn = el('button', 'act primary', 'Create');
  addBtn.onclick = async () => {
    const res = await adminApi.createUser(idIn.value.trim(), pwIn.value, roleSel.value as Role);
    if (res.ok) { toast(`Created "${res.data?.user.userId}".`); idIn.value = pwIn.value = ''; void renderUsers(); }
    else fail('Create', res.error);
  };
  form.append(idIn, pwIn, roleSel, addBtn);
  create.appendChild(form);
  view.appendChild(create);

  // User table
  const card = el('div', 'pa-adm-card');
  card.innerHTML = `<h2>Accounts · ${users.length}</h2>`;
  const table = el('table');
  table.innerHTML = '<thead><tr><th>Login</th><th>Role</th><th>Password</th><th>Status</th><th>Actions</th></tr></thead>';
  const tbody = el('tbody');
  for (const u of users) tbody.appendChild(userRow(u));
  table.appendChild(tbody);
  card.appendChild(table);
  view.appendChild(card);
}

function userRow(u: AdminUser): HTMLTableRowElement {
  const tr = el('tr');
  tr.appendChild(el('td', undefined, u.userId + (u.role === 'admin' ? ' ★' : '')));

  const roleTd = el('td');
  const sel = el('select');
  for (const r of ['admin', 'user'] as Role[]) sel.appendChild(new Option(ROLE_LABEL[r], r));
  sel.value = u.role;
  sel.onchange = async () => {
    const res = await adminApi.updateUser(u.userId, { role: sel.value as Role });
    if (res.ok) { toast(`"${u.userId}" is now ${ROLE_LABEL[res.data!.user.role]}.`); void renderUsers(); }
    else { sel.value = u.role; fail('Change role', res.error); }
  };
  roleTd.appendChild(sel);
  tr.appendChild(roleTd);

  tr.appendChild(el('td', 'muted', u.hasPassword ? 'set' : '—'));
  tr.appendChild(el('td', u.disabled ? 'status-off' : 'muted', u.disabled ? '⛔ disabled' : 'active'));

  const actTd = el('td');
  const pwBtn = el('button', 'act', 'Reset password');
  pwBtn.onclick = async () => {
    const pw = prompt(`New password for "${u.userId}" (min 6 chars):`);
    if (pw == null) return;
    const res = await adminApi.updateUser(u.userId, { password: pw });
    if (res.ok) toast(`Password reset for "${u.userId}".`); else fail('Reset password', res.error);
  };
  const toggleBtn = el('button', 'act' + (u.disabled ? '' : ' danger'), u.disabled ? 'Enable' : 'Disable');
  toggleBtn.onclick = async () => {
    const disabling = !u.disabled;
    if (disabling && !confirm(`Disable account "${u.userId}"? They'll be signed out and can't log in — their meeting rooms stop working too, until re-enabled.`)) return;
    const res = await adminApi.updateUser(u.userId, { disabled: disabling });
    if (res.ok) { toast(`"${u.userId}" ${disabling ? 'disabled' : 're-enabled'}.`); void renderUsers(); }
    else fail(disabling ? 'Disable' : 'Enable', res.error);
  };
  const delBtn = el('button', 'act danger', 'Delete');
  delBtn.onclick = async () => {
    if (!confirm(`Delete account "${u.userId}"? This removes its avatar, meeting rooms and room assignments.`)) return;
    const res = await adminApi.deleteUser(u.userId);
    if (res.ok) { toast(`Deleted "${u.userId}".`); void renderUsers(); } else fail('Delete', res.error);
  };
  actTd.append(pwBtn, toggleBtn, delBtn);
  tr.appendChild(actTd);
  return tr;
}

// ── Rooms ────────────────────────────────────────────────────────────────────
async function renderRooms(): Promise<void> {
  const r = await adminApi.listZones();
  if (r.status === 401) return redirectToLogin();
  if (r.status === 403) {
    document.getElementById('pa-adm-view')!.innerHTML = '<div class="pa-adm-card">This page is for administrators only.</div>';
    return;
  }
  zones = r.data?.zones ?? [];
  const view = document.getElementById('pa-adm-view')!;
  view.innerHTML = '';
  const intro = el('div', 'pa-adm-card');
  intro.innerHTML =
    '<h2>Rooms</h2><div class="muted">A password locks the room — anyone but admins and the room\'s admins ' +
    'must enter it to join. Monitors can be locked separately.</div>';
  view.appendChild(intro);

  for (const z of zones) view.appendChild(zoneCard(z));
}

function zoneCard(z: AdminZone): HTMLElement {
  const card = el('div', 'pa-adm-card');
  const title = el('div', 'row');
  const h = el('h2', undefined, z.label);
  h.style.margin = '0';
  title.append(h);
  if (z.locked) title.append(el('span', 'lock', '🔒 password'));
  if (z.private) title.append(el('span', 'status-off', '🔐 private'));
  card.appendChild(title);
  card.appendChild(el('div', 'muted', `Owner: ${z.ownerName ?? '(none)'}`));

  // Zone password control
  const pwRow = el('div', 'row');
  pwRow.style.marginTop = '.6rem';
  const pw = el('input'); pw.type = 'password'; pw.placeholder = z.locked ? '•••••• (set new)' : 'set password';
  const setBtn = el('button', 'act primary', 'Set');
  setBtn.onclick = async () => {
    const res = await adminApi.setZonePassword(z.id, pw.value);
    if (res.ok) { toast(`Password ${res.data?.locked ? 'set' : 'cleared'} for ${z.label}.`); void renderRooms(); }
    else fail('Set password', res.error);
  };
  const clrBtn = el('button', 'act', 'Clear lock');
  clrBtn.disabled = !z.locked;
  clrBtn.onclick = async () => {
    const res = await adminApi.setZonePassword(z.id, '');
    if (res.ok) { toast(`Lock cleared for ${z.label}.`); void renderRooms(); } else fail('Clear', res.error);
  };
  pwRow.append(el('span', 'muted', 'Room password:'), pw, setBtn, clrBtn);
  card.appendChild(pwRow);

  // Private toggle (admin override — works regardless of who, if anyone, owns
  // the zone). Private rejects entry for anyone but the owner/zone-admins/ACL.
  const privRow = el('div', 'row');
  privRow.style.marginTop = '.6rem';
  const privBtn = el('button', 'act' + (z.private ? '' : ' primary'), z.private ? 'Make public' : 'Make private');
  privBtn.onclick = async () => {
    const res = await adminApi.setZonePrivate(z.id, !z.private);
    if (res.ok) { toast(`${z.label} is now ${res.data?.private ? 'private' : 'public'}.`); void renderRooms(); }
    else fail('Set private', res.error);
  };
  privRow.append(el('span', 'muted', 'Privacy:'), privBtn);
  card.appendChild(privRow);

  // Monitors + access-list expanders
  const btnRow = el('div', 'row');
  btnRow.style.marginTop = '.6rem';
  const monBtn = el('button', 'act', 'Monitors ▾');
  monBtn.onclick = () => toggleMonitors(card, z, monBtn);
  const aclBtn = el('button', 'act', 'Access list ▾');
  aclBtn.onclick = () => toggleAcl(card, z, aclBtn);
  btnRow.append(monBtn, aclBtn);
  card.appendChild(btnRow);
  return card;
}

function toggleMonitors(card: HTMLElement, z: AdminZone, btn: HTMLButtonElement): void {
  const existing = card.querySelector('.mon-list');
  if (existing) { existing.remove(); btn.textContent = 'Monitors ▾'; return; }
  btn.textContent = 'Monitors ▴';
  void openMonitors(card, z);
}

function toggleAcl(card: HTMLElement, z: AdminZone, btn: HTMLButtonElement): void {
  const existing = card.querySelector('.acl-list');
  if (existing) { existing.remove(); btn.textContent = 'Access list ▾'; return; }
  btn.textContent = 'Access list ▴';
  void openAcl(card, z);
}

/** (Re)build the private-zone access list under a zone card from the server —
 *  who besides the owner/zone-admins/global-admins may enter while it's private. */
async function openAcl(card: HTMLElement, z: AdminZone): Promise<void> {
  card.querySelector('.acl-list')?.remove();
  const r = await adminApi.listZoneAcl(z.id);
  const list = el('div', 'mon-list acl-list');
  const members = r.data?.members ?? [];
  if (!members.length) list.appendChild(el('div', 'muted', 'No one on the access list yet.'));
  for (const m of members) {
    const row = el('div', 'row');
    row.append(el('span', undefined, m.name));
    const rm = el('button', 'act danger', 'Remove');
    rm.onclick = async () => {
      const res = await adminApi.removeZoneAcl(z.id, m.userId);
      if (res.ok) void openAcl(card, z); else fail('Remove', res.error);
    };
    row.append(rm);
    list.appendChild(row);
  }
  const addRow = el('div', 'row');
  addRow.style.marginTop = '.4rem';
  const idIn = el('input'); idIn.placeholder = 'login id'; idIn.size = 16;
  const addBtn = el('button', 'act primary', 'Add');
  addBtn.onclick = async () => {
    if (!idIn.value.trim()) return;
    const res = await adminApi.addZoneAcl(z.id, idIn.value.trim());
    if (res.ok) { idIn.value = ''; void openAcl(card, z); } else fail('Add', res.error);
  };
  addRow.append(idIn, addBtn);
  list.appendChild(addRow);
  card.appendChild(list);
}

/** (Re)build the monitor list under a zone card from the server. */
async function openMonitors(card: HTMLElement, z: AdminZone): Promise<void> {
  card.querySelector('.mon-list')?.remove();
  const r = await adminApi.listMonitors(z.id);
  const list = el('div', 'mon-list');
  const monitors = r.data?.monitors ?? [];
  if (!monitors.length) list.appendChild(el('div', 'muted', "No monitors in this room's saved layout."));
  for (const m of monitors) {
    const row = el('div', 'row');
    const label = m.name || `Screen ${m.key}`;
    row.append(el('span', undefined, `📹 ${label}`));
    if (m.locked) row.append(el('span', 'lock', '🔒'));
    const pw = el('input'); pw.type = 'password'; pw.placeholder = m.locked ? 'set new' : 'set password'; pw.size = 14;
    const set = el('button', 'act primary', 'Set');
    set.onclick = async () => {
      const res = await adminApi.setMonitorPassword(z.id, m.key, pw.value);
      if (res.ok) { toast(`Monitor "${label}" ${res.data?.locked ? 'locked' : 'unlocked'}.`); void openMonitors(card, z); }
      else fail('Set monitor password', res.error);
    };
    const clr = el('button', 'act', 'Clear');
    clr.disabled = !m.locked;
    clr.onclick = async () => {
      const res = await adminApi.setMonitorPassword(z.id, m.key, '');
      if (res.ok) { toast(`Monitor "${label}" unlocked.`); void openMonitors(card, z); }
      else fail('Clear', res.error);
    };
    row.append(pw, set, clr);
    list.appendChild(row);
  }
  card.appendChild(list);
}

// ── Meeting rooms (ad-hoc /meet/<slug> calls) ─────────────────────────────────
function fmtDate(ms: number): string {
  return new Date(ms).toLocaleString(undefined, {
    year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
  });
}

async function renderMeetings(): Promise<void> {
  const r = await adminApi.listMeetingRooms();
  if (r.status === 401) return redirectToLogin();
  if (r.status === 403) {
    document.getElementById('pa-adm-view')!.innerHTML = '<div class="pa-adm-card">This page is for administrators only.</div>';
    return;
  }
  meetingRooms = r.data?.rooms ?? [];
  const view = document.getElementById('pa-adm-view')!;
  view.innerHTML = '';

  const intro = el('div', 'pa-adm-card');
  intro.innerHTML =
    '<h2>Meeting rooms</h2><div class="muted">Ad-hoc video-call rooms minted from the "Meeting Room Kiosk" ' +
    "furniture — anyone with the link (and password, if set) can join at /meet/&lt;slug&gt;, no account needed. " +
    'Expired rooms are pruned automatically; delete one here to end it early.</div>';
  view.appendChild(intro);

  const card = el('div', 'pa-adm-card');
  card.innerHTML = `<h2>Rooms · ${meetingRooms.length}</h2>`;
  if (!meetingRooms.length) {
    card.appendChild(el('div', 'muted', 'No meeting rooms have been created yet.'));
  } else {
    const table = el('table');
    table.innerHTML = '<thead><tr><th>Owner</th><th>Label</th><th>Created</th><th>Expires</th><th>Password</th><th>Status</th><th>Actions</th></tr></thead>';
    const tbody = el('tbody');
    for (const m of meetingRooms) tbody.appendChild(meetingRow(m));
    table.appendChild(tbody);
    card.appendChild(table);
  }
  view.appendChild(card);
}

function meetingRow(m: AdminMeetingRoom): HTMLTableRowElement {
  const tr = el('tr');
  tr.appendChild(el('td', undefined, m.ownerName + (m.ownerDisabled ? ' ⛔' : '')));
  tr.appendChild(el('td', 'muted', m.label || '—'));
  tr.appendChild(el('td', undefined, fmtDate(m.createdAt)));
  tr.appendChild(el('td', undefined, fmtDate(m.expiresAt)));
  tr.appendChild(el('td', m.hasPassword ? 'lock' : 'muted', m.hasPassword ? '🔒 set' : '—'));
  const status = m.ownerDisabled ? 'owner disabled' : m.expired ? 'expired' : 'active';
  const statusCls = status === 'active' ? undefined : m.ownerDisabled ? 'status-off' : 'muted';
  tr.appendChild(el('td', statusCls, status));

  const actTd = el('td');
  const copyBtn = el('button', 'act', 'Copy link');
  copyBtn.onclick = () => {
    const link = `${location.origin}/meet/${encodeURIComponent(m.slug)}`;
    void navigator.clipboard?.writeText(link).then(
      () => toast('Link copied to clipboard.'),
      () => toast(link),
    );
  };
  const delBtn = el('button', 'act danger', 'Delete');
  delBtn.onclick = async () => {
    if (!confirm(`End the meeting room "${m.label || m.slug}" (owner: ${m.ownerName}) now? The link stops working immediately.`)) return;
    const res = await adminApi.deleteMeetingRoom(m.slug);
    if (res.ok) { toast('Meeting room deleted.'); void renderMeetings(); } else fail('Delete', res.error);
  };
  actTd.append(copyBtn, delBtn);
  tr.appendChild(actTd);
  return tr;
}

buildShell();
render();
