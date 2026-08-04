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
import { confirmDialog, passwordPromptDialog } from '../ui/dialog.js';
import { renderZoneAdminsWidget } from '../shared/zoneAdminsWidget.js';
import { renderZonePasswordWidget } from '../shared/zonePasswordWidget.js';
import { renderZoneMonitorsWidget } from '../shared/zoneMonitorsWidget.js';
import { filterUserDatalist as filterDatalist, wireUserAutocomplete as wireAutocomplete, type AutocompleteUser } from '../shared/userAutocomplete.js';

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
  #pa-adm-head button{cursor:pointer;background:var(--panel2);color:var(--text);border:2px solid var(--line);
    border-radius:.45rem;padding:.5rem .8rem;font:inherit;font-size:.85rem;
    box-shadow:inset 0 2px 0 #2b3252,inset 0 -3px 0 #090b16;}
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
  /* Same inset-bevel look as Pixels' .pa-input/.pa-b (see paSkin.ts) — a
     2px dark border plus a lighter-top/darker-bottom inset shadow reads as
     the same "chunky pixel button" family across both surfaces. */
  input,select{background:var(--panel2);color:var(--text);border:2px solid var(--line);border-radius:.35rem;
    padding:.4rem .55rem;font:inherit;font-size:.9rem;max-width:100%;
    box-shadow:inset 0 2px 0 #2b3252,inset 0 -3px 0 #090b16;}
  input:focus,select:focus{outline:none;border-color:var(--accent);}
  button.act{cursor:pointer;font:inherit;font-size:.85rem;border-radius:.35rem;border:2px solid var(--line);
    padding:.4rem .7rem;background:var(--panel2);color:var(--text);margin-right:.3rem;
    box-shadow:inset 0 2px 0 #2b3252,inset 0 -3px 0 #090b16;}
  button.act:hover{border-color:var(--accent);}
  button.act:disabled{opacity:.45;cursor:default;}
  button.primary{background:var(--accent);border-color:var(--line);color:#fff;
    box-shadow:inset 0 2px 0 #5a92d6,inset 0 -3px 0 #163862;}
  button.danger{background:var(--danger);border-color:var(--line);color:#f1d0d6;
    box-shadow:inset 0 2px 0 #b34a5a,inset 0 -3px 0 #45111a;}
  .row{display:flex;gap:.5rem;align-items:center;flex-wrap:wrap;}
  .lock{color:var(--accent2);}
  .muted{color:var(--muted);}
  .status-off{color:var(--danger);}
  .badge-admin{color:#f2c14e;}
  .pw-eye{padding:.4rem .55rem;}
  /* A table with an attached toolbar above it (e.g. "add to access list") reads
     as one unit instead of a table floating with unrelated controls below it. */
  .table-block{border:1px solid var(--line);border-radius:.6rem;overflow:hidden;margin-top:.3rem;}
  .table-toolbar{display:flex;gap:.5rem;align-items:center;flex-wrap:wrap;padding:.55rem .65rem;
    background:var(--panel2);border-bottom:1px solid var(--line);}
  .table-toolbar input{flex:1;min-width:8rem;}
  .table-block .table-wrap table{margin:0;}
  /* Zones overview: one compact summary row per zone; click to expand the full
     management panel inline (master-detail / progressive disclosure — keeps
     the page scannable instead of every zone's whole form always open). */
  tr.zone-row{cursor:pointer;}
  tr.zone-row:hover{background:var(--panel2);}
  tr.zone-row td{padding-top:.65rem;padding-bottom:.65rem;}
  .chevron{display:inline-block;transition:transform .12s ease;color:var(--muted);width:1rem;}
  tr.zone-row.open .chevron{transform:rotate(90deg);}
  tr.zone-detail-row > td{background:var(--panel2);border-bottom:2px solid var(--line);padding:1rem 1.1rem;}
  .badges{display:flex;gap:.4rem;flex-wrap:wrap;}
  .badge{display:inline-flex;align-items:center;gap:.25rem;font-size:.78rem;padding:.15rem .5rem;border-radius:1rem;
    background:var(--panel);border:1px solid var(--line);color:var(--muted);}
  /* A field's compact "view" state: value + a single ⋮ Actions button, instead
     of every possible action (take/transfer/clear, generate/set/clear-lock, …)
     sitting in the row at once. Picking an action that needs input (transfer,
     new password) swaps the row into a small inline form; everything else
     (take ownership, clear) runs immediately from the menu. */
  .menu-wrap{position:relative;display:inline-block;}
  /* position:fixed (not absolute) + JS-computed top/left in actionsMenu() — the
     table rows this lives in scroll inside a .table-wrap, and an absolutely
     positioned dropdown gets clipped by that ancestor's overflow instead of
     floating over the page. */
  .menu-dropdown{display:none;position:fixed;background:var(--panel);
    border:1px solid var(--line);border-radius:.5rem;box-shadow:0 10px 28px rgba(0,0,0,.4);
    min-width:11rem;z-index:500;overflow:hidden;}
  .menu-dropdown.open{display:block;}
  .menu-item{display:block;width:100%;text-align:left;background:transparent;border:0;border-radius:0;
    margin:0;padding:.55rem .8rem;color:var(--text);font:inherit;font-size:.88rem;cursor:pointer;}
  .menu-item:hover{background:var(--panel2);}
  .menu-item:disabled{opacity:.4;cursor:default;background:transparent;}
  .menu-item.danger{color:#f0a6a2;}
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

/** A "⋮ Actions" button + dropdown — one place a field's less-frequent actions
 *  live instead of every button sitting in the row at once. Only one menu is
 *  ever open at a time (closeAllMenus, wired to a page-wide click listener). */
function closeAllMenus(): void {
  document.querySelectorAll<HTMLElement>('.menu-dropdown.open').forEach((m) => m.classList.remove('open'));
}
document.addEventListener('click', closeAllMenus);

interface MenuItem {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  danger?: boolean;
}
function actionsMenu(items: MenuItem[]): HTMLElement {
  const wrap = el('div', 'menu-wrap');
  const btn = el('button', 'act primary', '⋮ Actions');
  const menu = el('div', 'menu-dropdown');
  for (const item of items) {
    const mi = el('button', 'menu-item' + (item.danger ? ' danger' : ''), item.label);
    mi.type = 'button';
    mi.disabled = !!item.disabled;
    mi.onclick = (e) => {
      e.stopPropagation();
      closeAllMenus();
      item.onClick();
    };
    menu.appendChild(mi);
  }
  btn.type = 'button';
  btn.onclick = (e) => {
    e.stopPropagation();
    const isOpen = menu.classList.contains('open');
    closeAllMenus();
    if (!isOpen) {
      menu.classList.add('open');
      const r = btn.getBoundingClientRect();
      menu.style.top = `${r.bottom + 4}px`;
      menu.style.left = `${Math.max(4, r.right - menu.offsetWidth)}px`;
    }
  };
  wrap.append(btn, menu);
  return wrap;
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
    const pw = await passwordPromptDialog(`New password for "${u.userId}" (min 6 chars):`);
    if (pw == null) return;
    const res = await adminApi.updateUser(u.userId, { password: pw });
    if (res.ok) toast(`Password reset for "${u.userId}".`); else fail('Reset password', res.error);
  };
  const toggleBtn = el('button', 'act' + (u.disabled ? '' : ' danger'), u.disabled ? 'Enable' : 'Disable');
  toggleBtn.onclick = async () => {
    const disabling = !u.disabled;
    if (
      disabling &&
      !(await confirmDialog(
        `Disable account "${u.userId}"? They'll be signed out and can't log in — their meeting rooms stop working too, until re-enabled.`,
        { confirmLabel: 'Disable', danger: true },
      ))
    )
      return;
    const res = await adminApi.updateUser(u.userId, { disabled: disabling });
    if (res.ok) { toast(`"${u.userId}" ${disabling ? 'disabled' : 're-enabled'}.`); void renderUsers(); }
    else fail(disabling ? 'Disable' : 'Enable', res.error);
  };
  const delBtn = el('button', 'act danger', 'Delete');
  delBtn.onclick = async () => {
    if (
      !(await confirmDialog(`Delete account "${u.userId}"? This removes its avatar, meeting rooms and room assignments.`, {
        confirmLabel: 'Delete',
        danger: true,
      }))
    )
      return;
    const res = await adminApi.deleteUser(u.userId);
    if (res.ok) { toast(`Deleted "${u.userId}".`); void renderUsers(); } else fail('Delete', res.error);
  };
  actTd.append(pwBtn, toggleBtn, delBtn);
  tr.appendChild(actTd);
  return tr;
}

// ── Zones ────────────────────────────────────────────────────────────────────
const USER_LIST_ID = 'pa-adm-userlist';
const toAutocompleteUsers = (): AutocompleteUser[] => users.map((u) => ({ userId: u.userId, label: u.username || u.userId, isAdmin: u.role === 'admin' }));

function filterUserDatalist(query: string): void {
  filterDatalist(USER_LIST_ID, toAutocompleteUsers(), query);
}

/** Wire a login-id input to the shared autocomplete: filters as you type. */
function wireUserAutocomplete(input: HTMLInputElement): void {
  wireAutocomplete(input, USER_LIST_ID, toAutocompleteUsers);
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
    '<h2>Zones</h2><div class="muted">Click a zone to manage its owner, password, privacy, access list and ' +
    'monitors. A password locks a zone — anyone but admins and its zone-admins must enter it; making it private ' +
    'is a stronger, identity-based lock (an access list instead of a shared secret). Ownership can be taken, ' +
    'transferred or cleared by an admin at any time.</div>';
  view.appendChild(intro);

  // One compact row per zone (master), expandable inline (detail) — keeps the
  // page scannable instead of every zone's whole management form always open.
  const card = el('div', 'pa-adm-card');
  card.innerHTML = `<h2>Zones · ${zones.length}</h2>`;
  const tableWrap = el('div', 'table-wrap');
  const table = el('table');
  table.innerHTML = '<thead><tr><th></th><th>Zone</th><th>Owner</th><th>Status</th></tr></thead>';
  const tbody = el('tbody');
  for (const z of zones) tbody.appendChild(zoneSummaryRow(z));
  table.appendChild(tbody);
  tableWrap.appendChild(table);
  card.appendChild(tableWrap);
  view.appendChild(card);
}

/** One master row: name, owner, lock/privacy badges, and a chevron that
 *  expands the full management panel (zoneDetailPanel) inline below it. */
function zoneSummaryRow(z: AdminZone): HTMLTableRowElement {
  const tr = el('tr', 'zone-row');
  tr.dataset.zoneId = z.id;
  const chevTd = el('td');
  chevTd.innerHTML = '<span class="chevron">▸</span>';
  tr.appendChild(chevTd);
  tr.appendChild(el('td', undefined, z.label));
  tr.appendChild(el('td', 'muted', z.ownerName ?? '(none)'));
  const statusTd = el('td');
  const badges = el('div', 'badges');
  if (z.locked) badges.appendChild(el('span', 'badge', '🔒 password'));
  if (z.private) badges.appendChild(el('span', 'badge', '🔐 private'));
  if (!z.locked && !z.private) badges.appendChild(el('span', 'badge', 'open'));
  statusTd.appendChild(badges);
  tr.appendChild(statusTd);
  tr.onclick = () => toggleZoneDetail(tr, z);
  return tr;
}

/** Expand/collapse the detail row under a summary row — accordion-style (only
 *  one zone's management panel open at a time keeps the page from turning
 *  back into a wall of forms). */
function toggleZoneDetail(tr: HTMLTableRowElement, z: AdminZone): void {
  const next = tr.nextElementSibling;
  if (next?.classList.contains('zone-detail-row')) {
    next.remove();
    tr.classList.remove('open');
    return;
  }
  document.querySelectorAll('tr.zone-detail-row').forEach((r) => r.remove());
  document.querySelectorAll('tr.zone-row.open').forEach((r) => r.classList.remove('open'));
  tr.classList.add('open');
  const detailTr = el('tr', 'zone-detail-row');
  const td = el('td');
  td.colSpan = 4;
  td.appendChild(zoneDetailPanel(z));
  detailTr.appendChild(td);
  tr.after(detailTr);
}

/** Re-fetch zones and rebuild just this one summary+detail row pair in place —
 *  used after an owner/password/privacy change so the still-open panel keeps
 *  showing fresh data instead of the whole page collapsing back to a list. */
async function refreshZoneRow(zoneId: string): Promise<void> {
  const zr = await adminApi.listZones();
  if (!zr.ok) return;
  zones = zr.data?.zones ?? [];
  const z = zones.find((x) => x.id === zoneId);
  const oldRow = document.querySelector<HTMLTableRowElement>(`tr.zone-row[data-zone-id="${zoneId}"]`);
  if (!z || !oldRow) return;
  const wasOpen = oldRow.classList.contains('open');
  const oldDetail = oldRow.nextElementSibling?.classList.contains('zone-detail-row') ? oldRow.nextElementSibling : null;
  const newRow = zoneSummaryRow(z);
  oldRow.replaceWith(newRow);
  oldDetail?.remove();
  if (wasOpen) {
    newRow.classList.add('open');
    const detailTr = el('tr', 'zone-detail-row');
    const td = el('td');
    td.colSpan = 4;
    td.appendChild(zoneDetailPanel(z));
    detailTr.appendChild(td);
    newRow.after(detailTr);
  }
}

/** The full management panel for one zone — owner / privacy fields, the
 *  entry password, zone admins, who-has-access, and monitors. Built once when
 *  its row is expanded. The Owner/Privacy fields render as one table (Field |
 *  Value | Actions), matching the Zones/Users tables instead of a bespoke
 *  layout; Password/Zone admins/Monitors are shared widgets (also callable by
 *  that zone's owner, not just a global admin), so they render as their own
 *  sections rather than table rows. */
function zoneDetailPanel(z: AdminZone): HTMLElement {
  const card = el('div');

  const fieldsTable = el('table');
  fieldsTable.innerHTML = '<thead><tr><th>Field</th><th>Value</th><th>Actions</th></tr></thead>';
  const fieldsBody = el('tbody');
  fieldsBody.append(ownerFieldRow(z), privacyFieldRow(z));
  fieldsTable.appendChild(fieldsBody);
  const fieldsWrap = el('div', 'table-wrap');
  fieldsWrap.appendChild(fieldsTable);
  card.appendChild(fieldsWrap);

  // Entry password — owner's call too (see server/src/adminApi.ts's
  // zoneCapabilityAuth('zone.managePassword')), shared with Pixels' own Zones
  // panel (same widget, same REST route — see shared/zonePasswordWidget.ts).
  card.appendChild(el('div', 'section-title', 'Password'));
  const passwordBlock = el('div', 'table-block');
  passwordBlock.style.padding = '.65rem .8rem';
  card.appendChild(passwordBlock);
  renderZonePasswordWidget(passwordBlock, z.id, z.locked, {
    onError: (action, error) => fail(action, error),
    onChange: () => void refreshZoneRow(z.id),
    classNames: { button: 'act', primaryButton: 'act primary', dangerButton: 'act danger' },
  });

  // Zone admins (co-editors) matter regardless of privacy — they bypass the
  // password and can enter a private zone too — so unlike "Who has access"
  // below, this section is always shown, not gated on z.private. Shared with
  // Pixels' own Zones panel (same widget, same REST route — see
  // shared/zoneAdminsWidget.ts): granting is that zone's owner's call, or a
  // global admin's, enforced server-side either way.
  card.appendChild(el('div', 'section-title', 'Zone admins'));
  const adminsBlock = el('div', 'table-block');
  adminsBlock.style.padding = '.65rem .8rem';
  card.appendChild(adminsBlock);
  renderZoneAdminsWidget(adminsBlock, z.id, {
    wireAutocomplete: wireUserAutocomplete,
    onError: (action, error) => fail(action, error),
    classNames: { revokeButton: 'act danger', grantButton: 'act primary' },
  });

  // The access list only ever gates entry once the zone is private (see
  // renderMembersTable / server canEnterPrivateZone), so the section simply
  // isn't there for a public zone — no need to explain why in prose.
  if (z.private) {
    card.appendChild(el('div', 'section-title', 'Who has access'));
    const membersBlock = el('div', 'table-block');
    card.appendChild(membersBlock);
    void renderMembersTable(membersBlock, z);
  }

  // Conference monitors — owner's call too (see server's
  // zoneCapabilityAuth('zone.manageMonitors')), shared with Pixels' own Zones
  // panel (same widget, same REST routes — see shared/zoneMonitorsWidget.ts).
  card.appendChild(el('div', 'section-title', 'Monitors'));
  const monitorsBlock = el('div', 'table-block');
  monitorsBlock.style.padding = '.65rem .8rem';
  card.appendChild(monitorsBlock);
  renderZoneMonitorsWidget(monitorsBlock, z.id, {
    onError: (action, error) => fail(action, error),
    classNames: { button: 'act', primaryButton: 'act primary' },
  });

  return card;
}

/** Owner row: compact name + ⋮ Actions by default; "Transfer owner…" swaps
 *  the Value/Actions cells into a login-id input + Set/Cancel (Take
 *  ownership / Clear run straight from the menu — they need no further
 *  input, so no reason to open a form for them). */
function ownerFieldRow(z: AdminZone): HTMLTableRowElement {
  const tr = el('tr');
  tr.appendChild(el('td', undefined, 'Owner'));
  const valueTd = el('td');
  const actionsTd = el('td');
  const renderView = (): void => {
    valueTd.textContent = z.ownerName ?? '(none)';
    actionsTd.innerHTML = '';
    actionsTd.appendChild(
      actionsMenu([
        {
          label: '👑 Take ownership',
          disabled: !me || z.ownerId === me.userId,
          onClick: async () => {
            if (!me) return;
            const res = await adminApi.setZoneOwner(z.id, me.userId);
            if (res.ok) { toast(`You now own ${z.label}.`); void refreshZoneRow(z.id); } else fail('Take ownership', res.error);
          },
        },
        { label: '🔁 Transfer owner…', onClick: renderTransfer },
        {
          label: '✕ Clear owner',
          disabled: !z.ownerId,
          danger: true,
          onClick: async () => {
            const res = await adminApi.setZoneOwner(z.id, null);
            if (res.ok) { toast(`${z.label} is now ownerless.`); void refreshZoneRow(z.id); } else fail('Clear owner', res.error);
          },
        },
      ]),
    );
  };
  const renderTransfer = (): void => {
    valueTd.innerHTML = '';
    const ownIn = el('input');
    ownIn.placeholder = 'login id';
    wireUserAutocomplete(ownIn);
    valueTd.appendChild(ownIn);
    actionsTd.innerHTML = '';
    const setOwnBtn = el('button', 'act primary', 'Set owner');
    setOwnBtn.onclick = async () => {
      if (!ownIn.value.trim()) return;
      const res = await adminApi.setZoneOwner(z.id, ownIn.value.trim());
      if (res.ok) { toast(`${z.label} is now owned by ${res.data?.ownerName}.`); void refreshZoneRow(z.id); } else fail('Set owner', res.error);
    };
    const cancelBtn = el('button', 'act', 'Cancel');
    cancelBtn.onclick = () => renderView();
    actionsTd.append(setOwnBtn, cancelBtn);
    ownIn.focus();
  };
  renderView();
  tr.append(valueTd, actionsTd);
  return tr;
}

/** Privacy row: admin override — works regardless of who, if anyone, owns
 *  the zone. Private rejects entry for anyone but the owner/zone-admins/ACL.
 *  Just one action, so a plain button instead of a dropdown. */
function privacyFieldRow(z: AdminZone): HTMLTableRowElement {
  const tr = el('tr');
  tr.appendChild(el('td', undefined, 'Privacy'));
  tr.appendChild(el('td', 'muted', z.private ? '🔐 private' : 'public'));
  const actionsTd = el('td');
  const privBtn = el('button', 'act primary', z.private ? 'Make public' : 'Make private');
  privBtn.onclick = async () => {
    const res = await adminApi.setZonePrivate(z.id, !z.private);
    if (res.ok) { toast(`${z.label} is now ${res.data?.private ? 'private' : 'public'}.`); void refreshZoneRow(z.id); }
    else fail('Set private', res.error);
  };
  actionsTd.appendChild(privBtn);
  tr.appendChild(actionsTd);
  return tr;
}

/** "Who has access" table — owner + the private-zone access list (removable),
 *  plus an autocomplete-backed add row. Zone-admins get their own section
 *  (see zoneDetailPanel) since they matter regardless of privacy; this table
 *  is only ever rendered while the zone IS private (see zoneDetailPanel) —
 *  the ACL is only consulted for entry once a zone is private, so there's
 *  nothing useful to show or manage here for a public zone. */
async function renderMembersTable(block: HTMLElement, z: AdminZone): Promise<void> {
  const r = await adminApi.zoneMembers(z.id);
  const owner = r.data?.owner ?? null;
  const acl = r.data?.acl ?? [];

  // Toolbar above the table (not a floating row below it): add-to-access-list.
  const toolbar = el('div', 'table-toolbar');
  const idIn = el('input'); idIn.placeholder = 'login id to add'; wireUserAutocomplete(idIn);
  const addBtn = el('button', 'act primary', '+ Add to access list');
  addBtn.onclick = async () => {
    if (!idIn.value.trim()) return;
    const res = await adminApi.addZoneAcl(z.id, idIn.value.trim());
    if (res.ok) { idIn.value = ''; void renderMembersTable(block, z); } else fail('Add', res.error);
  };
  toolbar.append(idIn, addBtn);

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
  for (const a of acl) {
    row(a.name, a.isAdmin, '✓ Access list', async () => {
      const res = await adminApi.removeZoneAcl(z.id, a.userId);
      if (res.ok) void renderMembersTable(block, z); else fail('Remove', res.error);
    });
  }
  if (!owner && !acl.length) {
    const tr = el('tr');
    const td = el('td', 'muted wrap', 'No one has special access yet.');
    td.colSpan = 3;
    tr.appendChild(td);
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);
  const tableWrap = el('div', 'table-wrap');
  tableWrap.appendChild(table);

  block.innerHTML = '';
  block.append(toolbar, tableWrap);
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
    if (
      !(await confirmDialog(`End the meeting room "${m.label || m.slug}" (owner: ${m.ownerName}) now? The link stops working immediately.`, {
        confirmLabel: 'End room',
        danger: true,
      }))
    )
      return;
    const res = await adminApi.deleteMeetingRoom(m.slug);
    if (res.ok) { toast('Meeting room deleted.'); void renderMeetings(); } else fail('Delete', res.error);
  };
  actTd.append(copyBtn, delBtn);
  tr.appendChild(actTd);
  return tr;
}

buildShell();
render();
