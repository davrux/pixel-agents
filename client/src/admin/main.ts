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
let tab: 'users' | 'zones' | 'meetings' = 'users';
/** Who's signed in — fetched once at startup; backs the "Take ownership" self-button. */
let me: { userId: string; name: string } | null = null;
const ROLE_LABEL: Record<Role, string> = { admin: 'Admin', user: 'User' };

const STYLE = `
  *,*::before,*::after{box-sizing:border-box;}
  html,body{max-width:100%;}
  #pa-adm-head{display:flex;align-items:center;gap:.8rem;padding:.7rem 1.1rem;background:var(--panel);
    border-bottom:1px solid var(--line);flex-wrap:wrap;}
  #pa-adm-head .brand{font-weight:650;font-size:1.05rem;}
  #pa-adm-head .spacer{flex:1;}
  #pa-adm-head button{cursor:pointer;background:var(--panel2);color:var(--text);border:1px solid var(--line);
    border-radius:.5rem;padding:.5rem .8rem;font:inherit;font-size:.85rem;}
  #pa-adm-tabs{display:flex;gap:.3rem;padding:.7rem 1.1rem 0;background:var(--panel);overflow-x:auto;}
  #pa-adm-tabs button{cursor:pointer;background:transparent;color:var(--muted);border:0;border-bottom:2px solid transparent;
    padding:.5rem .8rem;font:inherit;font-size:.95rem;white-space:nowrap;}
  #pa-adm-tabs button.on{color:var(--text);border-bottom-color:var(--accent);}
  #pa-adm-toast{min-height:1.2rem;padding:.3rem 1.1rem;color:var(--muted);font-size:.85rem;}
  #pa-adm-toast.err{color:#f0a6a2;}
  #pa-adm-view{padding:.4rem 1.1rem 2rem;max-width:64rem;margin:0 auto;width:100%;}
  .pa-adm-card{background:var(--panel);border:1px solid var(--line);border-radius:.7rem;padding:1rem 1.1rem;margin-bottom:1rem;}
  .pa-adm-card h2{margin:0 0 .8rem;font-size:1rem;}
  .section-title{margin:1.1rem 0 .4rem;font-size:.75rem;font-weight:600;letter-spacing:.5px;text-transform:uppercase;
    color:var(--muted);}
  .table-wrap{overflow-x:auto;-webkit-overflow-scrolling:touch;}
  table{width:100%;border-collapse:collapse;min-width:30rem;}
  th,td{text-align:left;padding:.5rem .5rem;border-bottom:1px solid var(--line);font-size:.92rem;vertical-align:middle;
    white-space:nowrap;}
  th{color:var(--muted);font-weight:600;font-size:.72rem;letter-spacing:.6px;text-transform:uppercase;}
  td.wrap{white-space:normal;}
  input,select{background:var(--panel2);color:var(--text);border:1px solid var(--line);border-radius:.45rem;
    padding:.4rem .5rem;font:inherit;font-size:.9rem;max-width:100%;}
  input:focus,select:focus{outline:none;border-color:var(--accent);}
  button.act{cursor:pointer;font:inherit;font-size:.85rem;border-radius:.45rem;border:1px solid var(--line);
    padding:.4rem .65rem;background:var(--panel2);color:var(--text);margin-right:.3rem;}
  button.act:hover{border-color:var(--accent);}
  button.act:disabled{opacity:.45;cursor:default;}
  button.primary{background:var(--accent);border-color:transparent;color:#fff;}
  button.danger{background:var(--danger);border-color:transparent;color:#fff;}
  .row{display:flex;gap:.5rem;align-items:center;flex-wrap:wrap;}
  .lock{color:var(--accent2);}
  .muted{color:var(--muted);}
  .status-off{color:var(--danger);}
  .badge-admin{color:#f2c14e;}
  @media (max-width: 640px){
    #pa-adm-head{padding:.6rem .7rem;gap:.5rem;}
    #pa-adm-head .brand{font-size:.95rem;}
    #pa-adm-tabs{padding:.6rem .7rem 0;}
    #pa-adm-view{padding:.4rem .7rem 2rem;}
    .pa-adm-card{padding:.8rem .85rem;}
    .row{gap:.4rem;}
    input,select{width:100%;}
    th,td{padding:.45rem .4rem;font-size:.85rem;}
  }
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
      <button data-tab="zones">Zones</button>
      <button data-tab="meetings">Meetings</button>
    </div>
    <div id="pa-adm-toast"></div>
    <div id="pa-adm-view"></div>`;
  app.querySelector<HTMLButtonElement>('[data-pixels]')!.onclick = () => { window.location.href = './'; };
  app.querySelector<HTMLButtonElement>('[data-logout]')!.onclick = () => gotoLogout();
  app.querySelectorAll<HTMLButtonElement>('#pa-adm-tabs button').forEach((b) => {
    b.onclick = () => { tab = b.dataset.tab as typeof tab; render(); };
  });
  void adminApi.whoami().then((r) => { if (r.ok && r.data) me = r.data; });
}

function render(): void {
  document.querySelectorAll<HTMLButtonElement>('#pa-adm-tabs button').forEach((b) =>
    b.classList.toggle('on', b.dataset.tab === tab),
  );
  if (tab === 'users') void renderUsers();
  else if (tab === 'zones') void renderZones();
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
  const wrap = el('div', 'table-wrap');
  const table = el('table');
  table.innerHTML = '<thead><tr><th>Login</th><th>Role</th><th>Password</th><th>Status</th><th>Actions</th></tr></thead>';
  const tbody = el('tbody');
  for (const u of users) tbody.appendChild(userRow(u));
  table.appendChild(tbody);
  wrap.appendChild(table);
  card.appendChild(wrap);
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

// ── Zones ────────────────────────────────────────────────────────────────────
const AUTOCOMPLETE_MAX = 20; // a full unfiltered list gets unwieldy once there are many accounts

/** Shared <datalist> of account matches, for the owner/ACL autocomplete inputs.
 *  Rebuilt per keystroke (filterUserDatalist), capped at AUTOCOMPLETE_MAX. */
function ensureUserDatalist(): HTMLDataListElement {
  let dl = document.getElementById('pa-adm-userlist') as HTMLDataListElement | null;
  if (!dl) {
    dl = document.createElement('datalist');
    dl.id = 'pa-adm-userlist';
    document.body.appendChild(dl);
  }
  return dl;
}

function filterUserDatalist(query: string): void {
  const dl = ensureUserDatalist();
  const q = query.trim().toLowerCase();
  const matches = (
    q ? users.filter((u) => u.userId.toLowerCase().includes(q) || u.username.toLowerCase().includes(q)) : users
  ).slice(0, AUTOCOMPLETE_MAX);
  dl.innerHTML = matches
    .map((u) => `<option value="${u.userId}">${u.role === 'admin' ? '★ ' : ''}${u.username || u.userId} (${u.userId})</option>`)
    .join('');
}

/** Wire a login-id input to the shared autocomplete: filters as you type. */
function wireUserAutocomplete(input: HTMLInputElement): void {
  input.setAttribute('list', 'pa-adm-userlist');
  input.addEventListener('input', () => filterUserDatalist(input.value));
  input.addEventListener('focus', () => filterUserDatalist(input.value));
}

async function renderZones(): Promise<void> {
  const [zr, ur] = await Promise.all([adminApi.listZones(), adminApi.listUsers()]);
  if (zr.status === 401) return redirectToLogin();
  if (zr.status === 403) {
    document.getElementById('pa-adm-view')!.innerHTML = '<div class="pa-adm-card">This page is for administrators only.</div>';
    return;
  }
  zones = zr.data?.zones ?? [];
  if (ur.ok) users = ur.data?.users ?? [];
  filterUserDatalist('');
  const view = document.getElementById('pa-adm-view')!;
  view.innerHTML = '';
  const intro = el('div', 'pa-adm-card');
  intro.innerHTML =
    '<h2>Zones</h2><div class="muted">A password locks a zone — anyone but admins and its zone-admins must enter ' +
    "it to join; making it private is a stronger, identity-based lock (an access list instead of a shared secret). " +
    'Ownership can be taken, transferred or cleared by an admin at any time — useful for zones that predate ' +
    'ownership or lost their owner.</div>';
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

  // Owner: take (self) / transfer / clear.
  const ownRow = el('div', 'row');
  ownRow.style.marginTop = '.3rem';
  const ownIn = el('input');
  ownIn.placeholder = 'login id';
  ownIn.size = 16;
  wireUserAutocomplete(ownIn);
  const setOwnBtn = el('button', 'act primary', 'Set owner');
  setOwnBtn.onclick = async () => {
    if (!ownIn.value.trim()) return;
    const res = await adminApi.setZoneOwner(z.id, ownIn.value.trim());
    if (res.ok) { toast(`${z.label} is now owned by ${res.data?.ownerName}.`); void renderZones(); } else fail('Set owner', res.error);
  };
  const takeBtn = el('button', 'act', '👑 Take ownership');
  takeBtn.disabled = !me || z.ownerId === me.userId;
  takeBtn.onclick = async () => {
    if (!me) return;
    const res = await adminApi.setZoneOwner(z.id, me.userId);
    if (res.ok) { toast(`You now own ${z.label}.`); void renderZones(); } else fail('Take ownership', res.error);
  };
  const clearOwnBtn = el('button', 'act', 'Clear owner');
  clearOwnBtn.disabled = !z.ownerId;
  clearOwnBtn.onclick = async () => {
    const res = await adminApi.setZoneOwner(z.id, null);
    if (res.ok) { toast(`${z.label} is now ownerless.`); void renderZones(); } else fail('Clear owner', res.error);
  };
  ownRow.append(el('span', 'muted', `Owner: ${z.ownerName ?? '(none)'}`), takeBtn, ownIn, setOwnBtn, clearOwnBtn);
  card.appendChild(ownRow);

  // Zone password control
  const pwRow = el('div', 'row');
  pwRow.style.marginTop = '.6rem';
  const pw = el('input'); pw.type = 'password'; pw.placeholder = z.locked ? '•••••• (set new)' : 'set password';
  const setBtn = el('button', 'act primary', 'Set');
  setBtn.onclick = async () => {
    const res = await adminApi.setZonePassword(z.id, pw.value);
    if (res.ok) { toast(`Password ${res.data?.locked ? 'set' : 'cleared'} for ${z.label}.`); void renderZones(); }
    else fail('Set password', res.error);
  };
  const clrBtn = el('button', 'act', 'Clear lock');
  clrBtn.disabled = !z.locked;
  clrBtn.onclick = async () => {
    const res = await adminApi.setZonePassword(z.id, '');
    if (res.ok) { toast(`Lock cleared for ${z.label}.`); void renderZones(); } else fail('Clear', res.error);
  };
  pwRow.append(el('span', 'muted', 'Password:'), pw, setBtn, clrBtn);
  card.appendChild(pwRow);

  // Private toggle (admin override — works regardless of who, if anyone, owns
  // the zone). Private rejects entry for anyone but the owner/zone-admins/ACL.
  const privRow = el('div', 'row');
  privRow.style.marginTop = '.6rem';
  const privBtn = el('button', 'act' + (z.private ? '' : ' primary'), z.private ? 'Make public' : 'Make private');
  privBtn.onclick = async () => {
    const res = await adminApi.setZonePrivate(z.id, !z.private);
    if (res.ok) { toast(`${z.label} is now ${res.data?.private ? 'private' : 'public'}.`); void renderZones(); }
    else fail('Set private', res.error);
  };
  privRow.append(el('span', 'muted', 'Privacy:'), privBtn);
  card.appendChild(privRow);

  card.appendChild(el('div', 'section-title', 'Who has access'));
  const membersWrap = el('div', 'table-wrap');
  card.appendChild(membersWrap);
  void renderMembersTable(membersWrap, z);

  card.appendChild(el('div', 'section-title', 'Monitors'));
  const monitorsWrap = el('div', 'table-wrap');
  card.appendChild(monitorsWrap);
  void renderMonitorsTable(monitorsWrap, z);

  return card;
}

/** Always-visible "who has access" table — owner + zone-admins (read-only
 *  here; granted via the in-game Zones panel or a future admin route, not
 *  this one) + the private-zone access list (removable), plus an
 *  autocomplete-backed add row. */
async function renderMembersTable(wrap: HTMLElement, z: AdminZone): Promise<void> {
  const r = await adminApi.zoneMembers(z.id);
  const owner = r.data?.owner ?? null;
  const admins = r.data?.admins ?? [];
  const acl = r.data?.acl ?? [];

  const table = el('table');
  table.innerHTML = '<thead><tr><th>Name</th><th>Role</th><th>Actions</th></tr></thead>';
  const tbody = el('tbody');
  const row = (name: string, isAdmin: boolean, role: string, onRemove?: () => void): void => {
    const tr = el('tr');
    tr.appendChild(el('td', undefined, (isAdmin ? '★ ' : '') + name));
    tr.appendChild(el('td', 'muted', role));
    const actTd = el('td');
    if (onRemove) {
      const rm = el('button', 'act danger', 'Remove');
      rm.onclick = onRemove;
      actTd.appendChild(rm);
    }
    tr.appendChild(actTd);
    tbody.appendChild(tr);
  };
  if (owner) row(owner.name, owner.isAdmin, '👑 Owner');
  for (const a of admins) row(a.name, a.isAdmin, '🛠 Zone-admin');
  for (const a of acl) {
    row(a.name, a.isAdmin, '✓ Access list', async () => {
      const res = await adminApi.removeZoneAcl(z.id, a.userId);
      if (res.ok) void renderMembersTable(wrap, z); else fail('Remove', res.error);
    });
  }
  if (!owner && !admins.length && !acl.length) {
    const tr = el('tr');
    const td = el('td', 'muted wrap', 'No one has special access yet.');
    td.colSpan = 3;
    tr.appendChild(td);
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);

  const addRow = el('div', 'row');
  addRow.style.marginTop = '.5rem';
  const idIn = el('input'); idIn.placeholder = 'login id'; idIn.size = 16; wireUserAutocomplete(idIn);
  const addBtn = el('button', 'act primary', 'Add to access list');
  addBtn.onclick = async () => {
    if (!idIn.value.trim()) return;
    const res = await adminApi.addZoneAcl(z.id, idIn.value.trim());
    if (res.ok) { idIn.value = ''; void renderMembersTable(wrap, z); } else fail('Add', res.error);
  };
  addRow.append(idIn, addBtn);

  wrap.innerHTML = '';
  wrap.append(table, addRow);
}

/** Always-visible monitors table for a zone's saved layout. */
async function renderMonitorsTable(wrap: HTMLElement, z: AdminZone): Promise<void> {
  const r = await adminApi.listMonitors(z.id);
  const monitors = r.data?.monitors ?? [];

  const table = el('table');
  table.innerHTML = '<thead><tr><th>Monitor</th><th>Status</th><th>Password</th><th>Actions</th></tr></thead>';
  const tbody = el('tbody');
  if (!monitors.length) {
    const tr = el('tr');
    const td = el('td', 'muted wrap', "No monitors in this zone's saved layout.");
    td.colSpan = 4;
    tr.appendChild(td);
    tbody.appendChild(tr);
  }
  for (const m of monitors) {
    const label = m.name || `Screen ${m.key}`;
    const tr = el('tr');
    tr.appendChild(el('td', undefined, `📹 ${label}`));
    tr.appendChild(el('td', m.locked ? 'lock' : 'muted', m.locked ? '🔒 locked' : '—'));
    const pwTd = el('td');
    const pw = el('input'); pw.type = 'password'; pw.placeholder = m.locked ? 'set new' : 'set password'; pw.size = 14;
    pwTd.appendChild(pw);
    tr.appendChild(pwTd);
    const actTd = el('td');
    const set = el('button', 'act primary', 'Set');
    set.onclick = async () => {
      const res = await adminApi.setMonitorPassword(z.id, m.key, pw.value);
      if (res.ok) { toast(`Monitor "${label}" ${res.data?.locked ? 'locked' : 'unlocked'}.`); void renderMonitorsTable(wrap, z); }
      else fail('Set monitor password', res.error);
    };
    const clr = el('button', 'act', 'Clear');
    clr.disabled = !m.locked;
    clr.onclick = async () => {
      const res = await adminApi.setMonitorPassword(z.id, m.key, '');
      if (res.ok) { toast(`Monitor "${label}" unlocked.`); void renderMonitorsTable(wrap, z); }
      else fail('Clear', res.error);
    };
    actTd.append(set, clr);
    tr.appendChild(actTd);
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);
  wrap.innerHTML = '';
  wrap.appendChild(table);
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
    const wrap = el('div', 'table-wrap');
    const table = el('table');
    table.innerHTML = '<thead><tr><th>Owner</th><th>Label</th><th>Created</th><th>Expires</th><th>Password</th><th>Status</th><th>Actions</th></tr></thead>';
    const tbody = el('tbody');
    for (const m of meetingRooms) tbody.appendChild(meetingRow(m));
    table.appendChild(tbody);
    wrap.appendChild(table);
    card.appendChild(wrap);
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
