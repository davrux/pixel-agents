/**
 * Administration overlay — admin-only user + room management on the shared
 * backend. A thin SPA over the admin REST API (server/src/adminApi.ts); the
 * server enforces admin access, so this just presents the data and issues the
 * calls.
 *
 * Rendered as an in-game <dialog> overlay (see openAdminOverlay below), NOT a
 * separate page: opening it used to navigate the whole tab to admin.html,
 * which tore down the zone's WebRTC voice call (and, on desktop, made the
 * Mumble UI vanish) even though the player never actually left the zone.
 * Staying on the same document keeps all of that alive.
 *
 * Users: create / delete / change role / reset password. Rooms: set or clear a
 * room's entry password (stored hashed server-side). The last admin can't be
 * deleted/demoted.
 */
import { redirectToLogin, gotoLogout } from '../net/room.js';
import {
  adminApi,
  type AdminUser,
  type AdminZone,
  type AdminMeetingRoom,
  type AdminArcadeCabinet,
  type AdminOidcSettings,
  type Role,
} from './api.js';
import type { ArcadeGame } from '@pixel/shared';
import { confirmDialog, passwordPromptDialog } from '../ui/dialog.js';
import { renderZoneAdminsWidget } from '../shared/zoneAdminsWidget.js';
import { renderZonePasswordWidget } from '../shared/zonePasswordWidget.js';
import { filterUserDatalist as filterDatalist, wireUserAutocomplete as wireAutocomplete, type AutocompleteUser } from '../shared/userAutocomplete.js';

let users: AdminUser[] = [];
let zones: AdminZone[] = [];
let meetingRooms: AdminMeetingRoom[] = [];
let arcadeGames: ArcadeGame[] = [];
let tab: 'users' | 'zones' | 'meetings' | 'arcade' | 'signin' = 'users';
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
    box-shadow:inset 0 2px 0 #4a4744,inset 0 -3px 0 #050505;}
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
    box-shadow:inset 0 2px 0 #4a4744,inset 0 -3px 0 #050505;}
  input:focus,select:focus{outline:none;border-color:var(--accent);}
  button.act{cursor:pointer;font:inherit;font-size:.85rem;border-radius:.35rem;border:2px solid var(--line);
    padding:.4rem .7rem;background:var(--panel2);color:var(--text);margin-right:.3rem;
    box-shadow:inset 0 2px 0 #4a4744,inset 0 -3px 0 #050505;}
  button.act:hover{border-color:var(--accent);}
  button.act:disabled{opacity:.45;cursor:default;}
  button.primary{background:var(--accent);border-color:var(--line);color:#fff;
    box-shadow:inset 0 2px 0 #e2585a,inset 0 -3px 0 #5c0f10;}
  button.danger{background:var(--danger);border-color:var(--line);color:#f1d0d6;
    box-shadow:inset 0 2px 0 #b34a5a,inset 0 -3px 0 #45111a;}
  .row{display:flex;gap:.5rem;align-items:center;flex-wrap:wrap;}
  .lock{color:var(--accent2);}
  .muted{color:var(--muted);}
  .status-off{color:var(--danger);}
  .badge-admin{color:#e7da00;}
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
  .chk-list{display:flex;flex-direction:column;border:1px solid var(--line);border-radius:.5rem;
    overflow:hidden;margin:.6rem 0;}
  .chk-list label{display:flex;align-items:center;gap:.55rem;font-size:.88rem;cursor:pointer;
    padding:.5rem .7rem;border-bottom:1px solid var(--line);}
  .chk-list label:last-child{border-bottom:none;}
  .chk-list label:hover{background:var(--panel2);}
  .chk-list input{margin:0;}
  .save-ok{color:#7fbf6a;font-size:.85rem;opacity:0;transition:opacity .15s ease;}
  .save-ok.show{opacity:1;}
  /* Sign-in tab: the editable connection fields, and a read-only list for the rest. */
  .conn-field{padding:.65rem 0;border-bottom:1px solid var(--line);}
  .conn-field:last-of-type{border-bottom:none;}
  .conn-field label{display:block;font-size:.78rem;letter-spacing:.6px;text-transform:uppercase;color:var(--muted);
    margin-bottom:.3rem;}
  .conn-field .row input{flex:1;min-width:12rem;}
  .conn-field .src{font-size:.8rem;color:var(--muted);margin-top:.25rem;}
  .conn-field .src b{color:var(--text);font-weight:600;}
  .warn{border:1px solid #a86a2e;border-radius:.5rem;padding:.6rem .7rem;margin:.7rem 0 0;font-size:.87rem;
    color:#e6c48f;background:rgba(168,106,46,.12);}
  /* Sign-in tab: a read-only key/value list for the environment-set half. */
  .kv{display:grid;grid-template-columns:minmax(8rem,14rem) 1fr;gap:.35rem .8rem;font-size:.88rem;margin:.6rem 0 0;}
  .kv dt{color:var(--muted);}
  .kv dd{margin:0;overflow-wrap:anywhere;}
  .kv dd code{font-size:.85rem;color:var(--text);}
  .setting{display:flex;gap:.6rem;align-items:flex-start;padding:.6rem 0;border-bottom:1px solid var(--line);}
  .setting:last-of-type{border-bottom:none;}
  .setting input[type=checkbox]{margin:.2rem 0 0;}
  .setting .body{flex:1;}
  .setting .body label{font-size:.92rem;cursor:pointer;}
  .setting .body .muted{font-size:.82rem;display:block;margin-top:.15rem;}
  .arcade-cabinet{border:1px solid var(--line);border-radius:.5rem;padding:.55rem .7rem;}
  .arcade-cabinet .editor{display:none;margin-top:.6rem;}
  .arcade-cabinet .editor.open{display:block;}
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
/** Briefly show "✓ Saved" at the end of a button row — the page-wide
 *  #pa-adm-toast (still set too, see toast()) sits far from a Save button at
 *  the bottom of a long checkbox list, easy to miss entirely. */
const saveFlashTimers = new WeakMap<HTMLElement, number>();
function flashSaved(row: HTMLElement, text = '✓ Saved'): void {
  let mark = row.querySelector<HTMLElement>('.save-ok');
  if (!mark) {
    mark = el('span', 'save-ok');
    row.appendChild(mark);
  }
  mark.textContent = text;
  mark.classList.add('show');
  const prev = saveFlashTimers.get(mark);
  if (prev) window.clearTimeout(prev);
  saveFlashTimers.set(mark, window.setTimeout(() => mark!.classList.remove('show'), 1600));
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

function buildShell(app: HTMLElement, onClose: () => void): void {
  app.innerHTML = `
    <div id="pa-adm-head"><span class="brand">🛡 Administration</span><span class="spacer"></span>
      <button data-close>✕ Close</button>
      <button data-logout>Sign out</button></div>
    <div id="pa-adm-tabs">
      <button data-tab="users">Users</button>
      <button data-tab="zones">Zones</button>
      <button data-tab="meetings">Meetings</button>
      <button data-tab="arcade">Arcade</button>
      <button data-tab="signin">Sign-in</button>
    </div>
    <div id="pa-adm-toast"></div>
    <div id="pa-adm-view"></div>`;
  app.querySelector<HTMLButtonElement>('[data-close]')!.onclick = () => onClose();
  app.querySelector<HTMLButtonElement>('[data-logout]')!.onclick = () => gotoLogout();
  app.querySelectorAll<HTMLButtonElement>('#pa-adm-tabs button').forEach((b) => {
    b.onclick = () => { tab = b.dataset.tab as typeof tab; render(); };
  });
  void adminApi.whoami().then((r) => { if (r.ok && r.data) me = r.data; });
}

/** Colors admin.html used to define at its own :root — scoped to the overlay
 *  element instead of the game's global :root so this is the only place that
 *  needs to know them (the game itself has no use for these variable names). */
const OVERLAY_VARS = `
  --bg:#141312; --panel:#1c1a19; --panel2:#262422; --line:#0a0908; --text:#f1efec;
  --muted:#818586; --accent:#c51a1b; --accent2:#3e7a30; --danger:#7c2634;
`;

/** One admin overlay at a time — mirrors openPaDialog's singleton contract. */
let current: HTMLDialogElement | null = null;

/** Open the administration overlay in-place, over the running game — no page
 *  navigation, so the zone's voice call (and, on desktop, the Mumble
 *  connection) is never interrupted by an admin merely checking a setting. */
export function openAdminOverlay(): void {
  current?.close();

  const dialogEl = document.createElement('dialog');
  dialogEl.id = 'pa-admin-overlay';
  dialogEl.style.cssText = `
    ${OVERLAY_VARS}
    position:fixed; inset:0; margin:auto; padding:0; border:0; color:var(--text);
    width:min(64rem,94vw); height:min(90vh,50rem); max-width:94vw; max-height:94vh;
    background:var(--bg); border-radius:.7rem; overflow:hidden;
    font-family:'FS Pixel Sans',ui-monospace,monospace;
  `;
  if (!document.getElementById('pa-admin-overlay-style')) {
    const s = document.createElement('style');
    s.id = 'pa-admin-overlay-style';
    s.textContent = `dialog#pa-admin-overlay::backdrop{background:rgba(0,0,0,.55);}
      dialog#pa-admin-overlay{display:flex; flex-direction:column;}
      #pa-admin-overlay #app{flex:1; min-height:0; display:flex; flex-direction:column;}
      #pa-admin-overlay #pa-adm-head,#pa-admin-overlay #pa-adm-tabs,#pa-admin-overlay #pa-adm-toast{flex:0 0 auto;}
      #pa-admin-overlay #pa-adm-view{flex:1; min-height:0; overflow-y:auto;}
      ${STYLE}`;
    document.head.appendChild(s);
  }
  const app = document.createElement('div');
  app.id = 'app';
  dialogEl.appendChild(app);

  const close = () => dialogEl.close();
  dialogEl.addEventListener('close', () => {
    if (current === dialogEl) current = null;
    dialogEl.remove();
  });
  dialogEl.addEventListener('mousedown', (e) => {
    if (e.target === dialogEl) close();
  });

  (document.getElementById('game') ?? document.body).appendChild(dialogEl);
  current = dialogEl;
  dialogEl.showModal();

  buildShell(app, close);
  render();
}

function render(): void {
  document.querySelectorAll<HTMLButtonElement>('#pa-adm-tabs button').forEach((b) =>
    b.classList.toggle('on', b.dataset.tab === tab),
  );
  if (tab === 'users') void renderUsers();
  else if (tab === 'zones') void renderZones();
  else if (tab === 'arcade') void renderArcade();
  else if (tab === 'signin') void renderSignIn();
  else void renderMeetings();
}

/** Fetch + cache the arcade catalog (public /arcade/catalog) — same metadata
 *  both the Default-games tab and each zone's cabinet editor render checkboxes
 *  from, so it's loaded once and reused rather than re-fetched per section. */
async function ensureArcadeGames(): Promise<ArcadeGame[]> {
  if (arcadeGames.length) return arcadeGames;
  const r = await adminApi.listArcadeGames();
  if (r.ok) arcadeGames = r.data?.games ?? [];
  return arcadeGames;
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
    '<h2>Zones</h2><div class="muted">Click a zone to manage its owner, password, privacy, and access list. ' +
    'A password locks a zone — anyone but admins and its zone-admins must enter it; making it private ' +
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
 *  entry password, zone admins, and who-has-access. Built once when its row
 *  is expanded. The Owner/Privacy fields render as one table (Field | Value |
 *  Actions), matching the Zones/Users tables instead of a bespoke layout;
 *  Password/Zone admins are shared widgets (also callable by that zone's
 *  owner, not just a global admin), so they render as their own sections
 *  rather than table rows. */
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

  // Arcade cabinets — admin-only (see renderZoneArcadeCabinets), so unlike the
  // sections above this isn't a shared widget with any in-game panel.
  card.appendChild(el('div', 'section-title', 'Arcade cabinets'));
  const arcadeBlock = el('div', 'table-block');
  arcadeBlock.style.padding = '.65rem .8rem';
  card.appendChild(arcadeBlock);
  void renderZoneArcadeCabinets(arcadeBlock, z.id);

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

// ── Arcade — global default game list ─────────────────────────────────────
// Admin-only (server's PUT/GET /admin/arcade/default-games use the plain
// admin() guard, not zoneCapabilityAuth) — a zone owner does not get this,
// unlike Password, so it's not a shared widget with any in-game panel; it
// only ever renders here.
async function renderArcade(): Promise<void> {
  const [games, def] = await Promise.all([ensureArcadeGames(), adminApi.getArcadeDefaultGames()]);
  if (def.status === 401) return redirectToLogin();
  const view = document.getElementById('pa-adm-view')!;
  view.innerHTML = '';
  if (def.status === 403) {
    view.innerHTML = '<div class="pa-adm-card">This page is for administrators only.</div>';
    return;
  }

  const card = el('div', 'pa-adm-card');
  card.innerHTML =
    '<h2>Default games</h2><div class="muted">Games a newly placed arcade cabinet offers, unless it\'s given its ' +
    "own list under a zone's Arcade cabinets section. Saving here immediately updates every cabinet that still " +
    'follows the default.</div>';
  if (!games.length) {
    card.appendChild(el('div', 'muted', 'No games in the arcade catalog.'));
  } else {
    const checked = new Set(def.data?.gameIds ?? games.map((g) => g.id));
    const list = el('div', 'chk-list');
    const boxes: HTMLInputElement[] = [];
    for (const g of games) {
      const label = el('label');
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = checked.has(g.id);
      cb.dataset.gameId = g.id;
      boxes.push(cb);
      label.append(cb, document.createTextNode(g.title));
      list.appendChild(label);
    }
    card.appendChild(list);
    const actions = el('div', 'row');
    const saveBtn = el('button', 'act primary', 'Save');
    saveBtn.onclick = async () => {
      const ids = boxes.filter((b) => b.checked).map((b) => b.dataset.gameId!);
      const res = await adminApi.setArcadeDefaultGames(ids);
      if (res.ok) { flashSaved(actions); toast(`Default games saved (${ids.length}/${games.length}).`); }
      else fail('Save default games', res.error);
    };
    actions.appendChild(saveBtn);
    card.appendChild(actions);
  }
  view.appendChild(card);
}

// ── Sign-in / single sign-on ───────────────────────────────────────────────
//
// Three cards, and the order is the order somebody sets this up in: which directory to talk to,
// how the button looks, and what the deployment decided that this panel does not touch.
//
// The connection fields (issuer, client id, redirect URI) are editable here by explicit request.
// The client secret is not, and the panel says out loud when overriding the connection has taken
// it out of use — that is the rule that keeps an editable issuer from being a way to send the
// deployment's secret to a directory the deployment never named (server: oidc/adminSettings.ts).
// Everything that decides who becomes an admin stays environment-only and is shown read-only.
async function renderSignIn(): Promise<void> {
  const res = await adminApi.getOidcSettings();
  if (res.status === 401) return redirectToLogin();
  const view = document.getElementById('pa-adm-view')!;
  view.innerHTML = '';
  if (res.status === 403) {
    view.innerHTML = '<div class="pa-adm-card">This page is for administrators only.</div>';
    return;
  }
  if (!res.ok || !res.data) {
    fail('Load sign-in settings', res.error);
    return;
  }
  const data: AdminOidcSettings = res.data;

  view.appendChild(connectionCard(data));
  view.appendChild(presentationCard(data));
  view.appendChild(environmentCard(data));
}

/** Card 1: which directory this world trusts. Editable. */
function connectionCard(data: AdminOidcSettings): HTMLElement {
  const card = el('div', 'pa-adm-card');
  card.innerHTML =
    '<h2>Provider connection</h2><div class="muted">Which OpenID Connect provider (Zitadel, Keycloak, …) ' +
    'this world signs people in with. Saved here, these override the server environment and take effect ' +
    'on the next sign-in — nothing to restart. Leave a field empty to use the deployment\'s own value.</div>';

  if (!data.configured) {
    const warn = el(
      'div',
      'warn',
      'Single sign-on is off: all three fields below need a value, from here or from the environment. ' +
        'Until then the sign-in screens offer login id + password only.',
    );
    card.appendChild(warn);
  }
  if (data.secret.configured && !data.secret.active) {
    card.appendChild(
      el(
        'div',
        'warn',
        "The deployment's client secret is NOT in use, because the issuer or the client id is overridden here. " +
          'The sign-in then authenticates as a public client with PKCE — which most providers support, but the ' +
          'application must be configured for it. Clear both overrides to use the secret again.',
      ),
    );
  }

  const fields = connectionFields(data, card);

  const actions = el('div', 'row');
  const save = el('button', 'act primary', 'Save connection');
  save.onclick = async () => {
    save.disabled = true;
    const r = await adminApi.setOidcSettings({
      issuer: fields.issuer.value.trim(),
      clientId: fields.clientId.value.trim(),
      redirectUri: fields.redirectUri.value.trim(),
      scopes: fields.scopes.value.trim(),
      adminRole: fields.adminRole.value.trim(),
    });
    save.disabled = false;
    if (!r.ok) {
      // The server names the field it refused and why — point at it instead of a generic failure.
      const field = r.data?.field;
      if (field && field in fields) fields[field as keyof typeof fields].focus();
      toast(r.error ?? 'Could not save the provider connection.', true);
      return;
    }
    flashSaved(actions);
    toast(r.data?.configured ? 'Provider connection saved.' : 'Saved — single sign-on is still incomplete.');
    void renderSignIn(); // re-read: the sources, the secret line and the warnings all change
  };
  actions.appendChild(save);
  card.appendChild(actions);
  return card;
}

/** The three inputs, each saying where its current value comes from. */
function connectionFields(
  data: AdminOidcSettings,
  card: HTMLElement,
): {
  issuer: HTMLInputElement;
  clientId: HTMLInputElement;
  redirectUri: HTMLInputElement;
  scopes: HTMLInputElement;
  adminRole: HTMLInputElement;
} {
  const specs = [
    {
      key: 'issuer' as const,
      label: 'Issuer URL',
      placeholder: 'https://your-instance.zitadel.cloud',
      hint: 'The provider\'s base URL. Its /.well-known/openid-configuration is what this server reads. https, unless it is localhost.',
    },
    {
      key: 'clientId' as const,
      label: 'Client id',
      placeholder: '123456789@your_project',
      hint: 'The application id from the provider.',
    },
    {
      key: 'redirectUri' as const,
      label: 'Redirect URI',
      placeholder: `https://this-server.example.com${data.callbackPath}`,
      hint: `Must end in ${data.callbackPath} and be registered with the provider exactly as written here.`,
    },
    {
      key: 'scopes' as const,
      label: 'Scopes',
      placeholder: 'openid profile email',
      hint:
        'Space-separated. "openid" is always included. Scopes decide which claims come back — ' +
        'including the one that carries roles, so if an admin role is mapped below, the scope that ' +
        'delivers it has to be here (in Zitadel that means enabling the project\'s role assertion, ' +
        'or adding its …:aud scope). Remove it and the next sign-in reports no roles, which revokes ' +
        'admin from everyone but the last one left.',
    },
    {
      key: 'adminRole' as const,
      label: 'Admin role',
      placeholder: 'admin',
      hint:
        'A user with this role in the directory becomes an admin here on their next sign-in — and ' +
        'loses it when the role is taken away. Leave it empty and the directory says nothing about ' +
        'admin: the flag stays whatever it is set to here. The last usable admin is never revoked, ' +
        'so a wrong role name cannot lock everyone out. Zitadel has to be asserting roles for the ' +
        'name to arrive at all (see Scopes above); the server logs the roles it saw on each sign-in.',
    },
  ];
  const inputs = {} as {
    issuer: HTMLInputElement;
    clientId: HTMLInputElement;
    redirectUri: HTMLInputElement;
    scopes: HTMLInputElement;
    adminRole: HTMLInputElement;
  };
  for (const spec of specs) {
    const field = data.connection[spec.key];
    const wrap = el('div', 'conn-field');
    const label = el('label');
    label.htmlFor = `pa-adm-oidc-${spec.key}`;
    label.textContent = spec.label;

    const row = el('div', 'row');
    const input = document.createElement('input');
    input.id = `pa-adm-oidc-${spec.key}`;
    input.type = 'text';
    input.spellcheck = false;
    input.value = field.override;
    input.placeholder = field.env || spec.placeholder;
    inputs[spec.key] = input;
    row.appendChild(input);
    // Only offered when there is something to fall back TO, so the button never means "clear it".
    if (field.override && field.env) {
      const reset = el('button', 'act', "Use deployment's");
      reset.title = field.env;
      reset.onclick = () => {
        input.value = '';
        input.dispatchEvent(new Event('input'));
      };
      row.appendChild(reset);
    }

    const src = el('div', 'src');
    const say = (): void => {
      const typed = input.value.trim();
      if (typed) src.innerHTML = `In use: <b>${escapeHtml(typed)}</b>${field.env ? ' (overrides the deployment)' : ''}`;
      else if (field.env) src.innerHTML = `From the deployment: <b>${escapeHtml(field.env)}</b>`;
      else src.textContent = 'Not set anywhere yet.';
    };
    say();
    input.addEventListener('input', say);

    wrap.append(label, row, spec.hint ? el('div', 'src', spec.hint) : el('div'), src);
    card.appendChild(wrap);
  }
  return inputs;
}

/** Card 2: how the provider is offered. Presentation only — none of it can grant access. */
function presentationCard(data: AdminOidcSettings): HTMLElement {
  const p = data.presentation;
  const envLabel = data.environment?.envLabel ?? 'Zitadel';
  const card = el('div', 'pa-adm-card');
  card.innerHTML =
    '<h2>Sign-in button</h2><div class="muted">How the provider is offered on the sign-in screens, in the ' +
    'browser and in the desktop app. Takes effect on the next page load.</div>';

  const showRow = settingRow(
    'Offer the sign-in button',
    'Shows "Sign in with …" on the login, create-account and desktop sign-in screens. ' +
      'Turning it off hides the button; it does not close the flow for anyone holding the link.',
    p.showButton,
  );
  const redirectRow = settingRow(
    'Send new visitors straight to the provider',
    'An unauthenticated page visit goes to the provider instead of showing the login page. ' +
      'The password form stays reachable at /login — keep it in mind if the provider is ever down.',
    p.autoRedirect,
  );

  const labelWrap = el('div', 'setting');
  const labelBody = el('div', 'body');
  const labelLabel = el('label');
  labelLabel.htmlFor = 'pa-adm-oidc-label';
  labelLabel.textContent = 'Button label';
  const labelInput = document.createElement('input');
  labelInput.id = 'pa-adm-oidc-label';
  labelInput.type = 'text';
  labelInput.maxLength = data.maxLabelLength;
  labelInput.value = p.label ?? '';
  labelInput.placeholder = envLabel;
  labelBody.append(
    labelLabel,
    labelInput,
    el('span', 'muted', `What the button says: "Sign in with <label>". Leave empty to use the server's own setting ("${envLabel}").`),
  );
  labelWrap.appendChild(labelBody);

  card.append(showRow.wrap, labelWrap, redirectRow.wrap);

  const actions = el('div', 'row');
  const save = el('button', 'act primary', 'Save');
  save.onclick = async () => {
    save.disabled = true;
    const r = await adminApi.setOidcSettings({
      label: labelInput.value.trim() === '' ? null : labelInput.value,
      showButton: showRow.input.checked,
      autoRedirect: redirectRow.input.checked,
    });
    save.disabled = false;
    if (!r.ok || !r.data) return fail('Save sign-in settings', r.error);
    // Echo what the server stored, not what was typed: it trims and caps the label.
    labelInput.value = r.data.presentation.label ?? '';
    flashSaved(actions);
    toast('Sign-in settings saved.');
  };
  actions.appendChild(save);
  card.appendChild(actions);
  return card;
}

/** Card 3: what the deployment decided and this panel deliberately does not touch. */
function environmentCard(data: AdminOidcSettings): HTMLElement {
  const card = el('div', 'pa-adm-card');
  card.innerHTML =
    '<h2>Deployment settings</h2><div class="muted">Set in the server environment and shown here to check ' +
    'against. Not editable from this panel: each one decides who becomes an admin, or whose existing account ' +
    'a directory username may take over. The client secret is never sent to this page at all.</div>';
  const env = data.environment;
  const dl = el('dl', 'kv');
  const rows: Array<[string, string]> = [
    [
      'Client secret',
      data.secret.configured
        ? data.secret.active
          ? 'set and in use (confidential client)'
          : 'set, but NOT in use — the connection above is overridden, so the flow is a public/PKCE client'
        : 'not set (public client, PKCE only)',
    ],
  ];
  if (env) {
    rows.push(
      ['Roles claim', `${env.rolesClaim} (Zitadel's project-scoped variants are read too)`],
      [
        'Adopt matching accounts',
        env.claimExisting
          ? 'yes — a first sign-in takes over the local account with the same login id'
          : 'no — a colliding login id gets a new account with a suffix',
      ],
      ['Sign out at provider', env.endSession ? 'yes — /logout also ends the provider session' : 'no — only the local session is dropped'],
    );
  }
  for (const [key, value] of rows) {
    dl.appendChild(el('dt', undefined, key));
    const dd = el('dd');
    dd.appendChild(el('code', undefined, value));
    dl.appendChild(dd);
  }
  card.appendChild(dl);
  if (!env) {
    card.appendChild(
      el(
        'div',
        'muted',
        'The environment names no provider at all, so these fall back to their defaults: the ' +
          "standard Zitadel roles claim, and matching local accounts adopted on a first sign-in. " +
          'Set PIXEL_OIDC_* to change them — see .env.example.',
      ),
    );
  }
  return card;
}

/** One checkbox setting: the box, its label and a line saying what it does. */
function settingRow(title: string, hint: string, checked: boolean): { wrap: HTMLElement; input: HTMLInputElement } {
  const wrap = el('div', 'setting');
  const input = document.createElement('input');
  input.type = 'checkbox';
  input.checked = checked;
  const body = el('div', 'body');
  const label = el('label');
  label.textContent = title;
  label.onclick = () => {
    input.checked = !input.checked;
  };
  body.append(label, el('span', 'muted', hint));
  wrap.append(input, body);
  return { wrap, input };
}

/** Escape the values this tab interpolates into innerHTML — a URL an admin typed, and the
 *  deployment's own. Everything else on the page goes in as a text node. */
function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c);
}

// ── Arcade cabinets (per zone) ─────────────────────────────────────────────
// Rendered inline in zoneDetailPanel — but NOT a shared widget: this is
// admin-only (see renderArcade's note above), so there's no in-game consumer
// to share it with.
async function renderZoneArcadeCabinets(container: HTMLElement, zoneId: string): Promise<void> {
  const [games, res] = await Promise.all([ensureArcadeGames(), adminApi.listArcadeCabinets(zoneId)]);
  container.innerHTML = '';
  if (!res.ok) {
    fail('Load arcade cabinets', res.error);
    return;
  }
  const cabinets = res.data?.cabinets ?? [];
  if (!cabinets.length) {
    const empty = el('div', 'muted', "No arcade cabinets in this zone's saved layout.");
    empty.style.fontSize = '.85rem';
    container.appendChild(empty);
    return;
  }
  const list = el('div');
  list.style.cssText = 'display:flex;flex-direction:column;gap:.6rem;';
  for (const cab of cabinets) list.appendChild(arcadeCabinetRow(zoneId, cab, games));
  container.appendChild(list);
}

/** One cabinet: a compact summary row (name, "N/M games (default|custom)") that
 *  expands into a checkbox editor — same progressive-disclosure idiom as the
 *  Owner/Privacy field rows, so the zone panel doesn't turn into a wall of
 *  checkboxes when a zone has several cabinets. */
function arcadeCabinetRow(zoneId: string, cab: AdminArcadeCabinet, games: ArcadeGame[]): HTMLElement {
  const label = cab.name || `Cabinet ${cab.key}`;
  const statusText = (c: AdminArcadeCabinet) => `${c.effective.length}/${games.length} games (${c.override ? 'custom' : 'default'})`;

  const wrap = el('div', 'arcade-cabinet');
  const head = el('div', 'row');
  const nm = el('span', undefined, `🕹 ${label}`);
  nm.style.cssText = 'flex:1;font-size:.85rem;';
  const status = el('span', 'muted', statusText(cab));
  status.style.fontSize = '.85rem';
  const editBtn = el('button', 'act', 'Edit');
  head.append(nm, status, editBtn);
  wrap.appendChild(head);

  const editor = el('div', 'editor');
  const list = el('div', 'chk-list');
  const boxes: HTMLInputElement[] = [];
  const activeIds = new Set(cab.effective);
  for (const g of games) {
    const lab = el('label');
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = activeIds.has(g.id);
    cb.dataset.gameId = g.id;
    boxes.push(cb);
    lab.append(cb, document.createTextNode(g.title));
    list.appendChild(lab);
  }
  editor.appendChild(list);

  const actions = el('div', 'row');
  const saveBtn = el('button', 'act primary', 'Save');
  const resetBtn = el('button', 'act', 'Use default');
  resetBtn.disabled = !cab.override;
  saveBtn.onclick = async () => {
    const ids = boxes.filter((b) => b.checked).map((b) => b.dataset.gameId!);
    const r = await adminApi.setArcadeCabinetGames(zoneId, cab.key, ids);
    if (!r.ok) return void fail('Save cabinet games', r.error);
    cab.override = ids;
    cab.effective = r.data?.effective ?? ids;
    status.textContent = statusText(cab);
    resetBtn.disabled = false;
    flashSaved(actions);
    toast(`Saved "${label}".`);
  };
  resetBtn.onclick = async () => {
    const r = await adminApi.setArcadeCabinetGames(zoneId, cab.key, null);
    if (!r.ok) return void fail('Reset cabinet games', r.error);
    cab.override = null;
    cab.effective = r.data?.effective ?? cab.effective;
    for (const b of boxes) b.checked = cab.effective.includes(b.dataset.gameId!);
    status.textContent = statusText(cab);
    resetBtn.disabled = true;
    flashSaved(actions, '✓ Reset');
    toast(`"${label}" reset to the default list.`);
  };
  actions.append(saveBtn, resetBtn);
  editor.appendChild(actions);
  wrap.appendChild(editor);

  editBtn.onclick = () => editor.classList.toggle('open');
  return wrap;
}
