/**
 * Login-id autocomplete: a shared `<datalist>`, rebuilt per keystroke (not
 * dumped once in full, so a large user base doesn't turn it into an unusable
 * dropdown) and capped at AUTOCOMPLETE_MAX matches. Used by both the admin
 * site and Pixels' in-game panels for their owner/ACL/zone-admin/invite inputs
 * — each host keeps its own user-list cache and datalist id (so the two never
 * collide) and maps its own user shape into `AutocompleteUser`.
 */

export interface AutocompleteUser {
  userId: string;
  label: string;
  isAdmin: boolean;
}

/** Above this many matches, a native <datalist> gets unwieldy (and some
 *  browsers cap/slow down anyway). */
const AUTOCOMPLETE_MAX = 20;

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

function ensureDatalist(listId: string): HTMLDataListElement {
  let dl = document.getElementById(listId) as HTMLDataListElement | null;
  if (!dl) {
    dl = document.createElement('datalist');
    dl.id = listId;
    document.body.appendChild(dl);
  }
  return dl;
}

/** Rebuild `listId`'s <datalist> to at most AUTOCOMPLETE_MAX matches of `query`
 *  (case-insensitive substring on login id or label; empty query = first
 *  AUTOCOMPLETE_MAX accounts, so something shows before typing). */
export function filterUserDatalist(listId: string, allUsers: AutocompleteUser[], query: string): void {
  const dl = ensureDatalist(listId);
  const q = query.trim().toLowerCase();
  const matches = (q ? allUsers.filter((u) => u.userId.toLowerCase().includes(q) || u.label.toLowerCase().includes(q)) : allUsers).slice(
    0,
    AUTOCOMPLETE_MAX,
  );
  dl.innerHTML = matches.map((u) => `<option value="${esc(u.userId)}">${u.isAdmin ? '★ ' : ''}${esc(u.label)} (${esc(u.userId)})</option>`).join('');
}

/** Wire a login-id input to `listId`'s shared autocomplete: filters as you
 *  type, and on focus (so something shows before typing). `getUsers` is
 *  called lazily on each event so the host's own cache can refresh
 *  independently of when inputs were wired. */
export function wireUserAutocomplete(input: HTMLInputElement, listId: string, getUsers: () => AutocompleteUser[]): void {
  input.setAttribute('list', listId);
  const refresh = (): void => filterUserDatalist(listId, getUsers(), input.value);
  input.addEventListener('input', refresh);
  input.addEventListener('focus', refresh);
}
