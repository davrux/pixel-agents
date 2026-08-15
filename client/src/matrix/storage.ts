/**
 * Storage namespacing and the sign-out wipe (docs/design.md
 * §2). No DOM here — this module only touches localStorage/sessionStorage/
 * IndexedDB.
 *
 * The crypto storage key (`pa-mx-ck:<ns>`) is not a security boundary against
 * an attacker who already holds the browser profile (they can read the key
 * too) — its job is requirement F's failure mode: dropStorageKey() runs
 * BEFORE any database delete, so a database that survives the rest of a wipe
 * is an undecryptable blob rather than a readable megolm key store. Do not
 * reorder wipeNamespace's steps for tidiness; the ordering is the point.
 *
 * The two IndexedDB suffixes below are not a guess: MatrixClient.clearStores
 * (lib/client.js:715) hardcodes exactly `::matrix-sdk-crypto` and
 * `::matrix-sdk-crypto-meta` on the given prefix. There is deliberately NO
 * "record every indexedDB.databases() name that appeared during boot and
 * treat it as ours" mechanism — initRustCrypto's await spans a multi-MB wasm
 * fetch, a window wide enough for unrelated app code (EmulatorJS, js-dos) to
 * create its own IndexedDB databases, and an "is new" rule would delete those
 * on Matrix sign-out. The only extra sweep here is a strict prefix match,
 * which cannot catch anything this app did not create.
 */
import { storageKey } from './sessionProbe.js';

const CRYPTO_KEY_PREFIX = 'pa-mx-ck:';
const NSGEN_PREFIX = 'pa-mx-nsgen:';
const WIPE_PENDING_KEY = 'pa-mx-wipe-pending';
const VIEW_KEY = 'pa-mx-view';
const DRAFT_PREFIX = 'pa-mx-draft:';
const NOTIFY_KEY = 'pa-mx-notify';
const NOTIFY_BODY_KEY = 'pa-mx-notify-body';

const DELETE_TIMEOUT_MS = 3000;

function readNsGen(paUserId: string): number {
  try {
    const raw = localStorage.getItem(`${NSGEN_PREFIX}${paUserId || '_'}`);
    const n = raw ? parseInt(raw, 10) : 0;
    return Number.isFinite(n) && n >= 0 ? n : 0;
  } catch {
    return 0;
  }
}

/** Not a security boundary against a same-browser-profile adversary (anyone who can sign into
 *  pixel-agents as a given user can already read that user's IndexedDB/localStorage directly via
 *  devtools) — its job is hygiene: give each (pixel-agents user, homeserver, matrix user) triple its
 *  own crypto store so a normal sign-out/sign-in cycle never mixes keys. A plain `encodeURIComponent`-
 *  joined literal (rather than a hash) keeps that unambiguous and needs no collision resistance: unlike
 *  a 32-bit FNV-1a fold, two different inputs can never produce the same namespace string. */
export function cryptoNamespace(paUserId: string, hsOrigin: string, mxUserId: string): string {
  const nsgen = readNsGen(paUserId);
  const parts = [paUserId || '_', hsOrigin, mxUserId, String(nsgen)].map(encodeURIComponent);
  return parts.join('|');
}

export function cryptoDbPrefix(ns: string): string {
  return `pa-mx-crypto:${ns}`;
}

export function cryptoDbNames(ns: string): string[] {
  const prefix = cryptoDbPrefix(ns);
  return [`${prefix}::matrix-sdk-crypto`, `${prefix}::matrix-sdk-crypto-meta`];
}

function b64Encode(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

function b64Decode(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Loads the persisted 32-byte rust-crypto storage key for this namespace,
 *  generating and persisting a fresh one on first use. */
export function loadOrCreateStorageKey(ns: string): Uint8Array {
  const key = `${CRYPTO_KEY_PREFIX}${ns}`;
  try {
    const existing = localStorage.getItem(key);
    if (existing) {
      const bytes = b64Decode(existing);
      if (bytes.length === 32) return bytes;
    }
  } catch {
    // fall through to generating a fresh key
  }
  const fresh = new Uint8Array(32);
  crypto.getRandomValues(fresh);
  try {
    localStorage.setItem(key, b64Encode(fresh));
  } catch {
    // Firefox private mode / full or blocked storage: the key lives only for
    // this session, which degrades to memory-only crypto behaviour on the
    // next reload rather than crashing now.
  }
  return fresh;
}

export function dropStorageKey(ns: string): void {
  try {
    localStorage.removeItem(`${CRYPTO_KEY_PREFIX}${ns}`);
  } catch {
    // see loadOrCreateStorageKey
  }
}

/** Escape hatch for a namespace whose wipe could not be completed (design
 *  §2.6 "Start fresh"): bumps the per-pixel-user salt so the next boot
 *  derives a brand new namespace, leaving the stuck one (already
 *  undecryptable — its storage key is already gone) untouched on disk. */
export function startFresh(paUserId: string): void {
  try {
    const gen = readNsGen(paUserId) + 1;
    localStorage.setItem(`${NSGEN_PREFIX}${paUserId || '_'}`, String(gen));
  } catch {
    // If this can't persist, the caller will keep re-deriving the same
    // namespace and see the same refusal — a degraded retry, not a crash.
  }
}

export function pendingWipeNames(): string[] {
  try {
    const raw = localStorage.getItem(WIPE_PENDING_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((x): x is string => typeof x === 'string');
  } catch {
    return [];
  }
}

function writePendingWipeNames(names: string[]): void {
  try {
    if (names.length === 0) localStorage.removeItem(WIPE_PENDING_KEY);
    else localStorage.setItem(WIPE_PENDING_KEY, JSON.stringify(names));
  } catch {
    // best effort — see other localStorage catches in this file
  }
}

/** Notification preferences. Device-scoped, like Mumble's join/leave alerts —
 *  they describe this machine's desktop, not the account, so they are not part
 *  of the sign-out wipe and carry no account data to leak. */
export interface MxNotifyPrefs {
  enabled: boolean;
  showBody: boolean;
}

function readFlag(key: string, fallback: boolean): boolean {
  try {
    const raw = localStorage.getItem(key);
    if (raw === null) return fallback;
    return raw === '1';
  } catch {
    return fallback; // private mode
  }
}

/**
 * Defaults: notifications on, message text off.
 *
 * The text default is the conservative one and is a privacy decision, not a
 * taste one: a notification body leaves the app for the OS notification service,
 * which on Linux is a daemon that may log or persist it, and for an
 * end-to-end-encrypted room that would be decrypted content going somewhere the
 * user never asked it to go. Notifications still say who and where by default.
 */
export function readNotifyPrefs(): MxNotifyPrefs {
  return {
    enabled: readFlag(NOTIFY_KEY, true),
    showBody: readFlag(NOTIFY_BODY_KEY, false),
  };
}

export function writeNotifyPrefs(prefs: MxNotifyPrefs): void {
  try {
    localStorage.setItem(NOTIFY_KEY, prefs.enabled ? '1' : '0');
    localStorage.setItem(NOTIFY_BODY_KEY, prefs.showBody ? '1' : '0');
  } catch {
    // Private mode: the choice holds for this session and is re-read from the
    // defaults next boot, which is the safe direction for showBody.
  }
}

export function clearViewBreadcrumbs(): void {
  try {
    sessionStorage.removeItem(VIEW_KEY);
    const toRemove: string[] = [];
    for (let i = 0; i < sessionStorage.length; i++) {
      const k = sessionStorage.key(i);
      if (k && k.startsWith(DRAFT_PREFIX)) toRemove.push(k);
    }
    for (const k of toRemove) sessionStorage.removeItem(k);
  } catch {
    // sessionStorage can throw under the same conditions as localStorage
  }
}

/** Deletes one IndexedDB database, resolving on success/error/no-op and
 *  rejecting on a timeout (a delete blocked by a still-open connection that
 *  never resolves). `blocked` is treated as a failure, not a hang. */
function deleteDatabase(name: string): Promise<{ name: string; ok: boolean }> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (ok: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ name, ok });
    };
    const timer = setTimeout(() => finish(false), DELETE_TIMEOUT_MS);
    try {
      const req = indexedDB.deleteDatabase(name);
      req.onsuccess = () => finish(true);
      req.onerror = () => finish(false);
      req.onblocked = () => finish(false);
    } catch {
      finish(false);
    }
  });
}

async function sweepPrefixedDbNames(prefix: string): Promise<string[]> {
  // Chrome/Electron only — Firefox has no indexedDB.databases(). Belt and
  // braces ONLY: a strict prefix match can never catch a database this app
  // did not create, and there is deliberately no "is new" clause (see file
  // header).
  const databases = (indexedDB as IDBFactory & { databases?: () => Promise<Array<{ name?: string }>> }).databases;
  if (typeof databases !== 'function') return [];
  try {
    const all = await databases.call(indexedDB);
    return all.map((d) => d.name).filter((n): n is string => typeof n === 'string' && n.startsWith(prefix));
  } catch {
    return [];
  }
}

export interface WipeResult {
  ok: boolean;
  failed: string[];
}

/** Implements design §2.4 steps 4 and 6-9. Steps 1-3, 5 and 10 need a live
 *  MatrixClient and are owned by store.ts (M2); call this AFTER
 *  client.stopClient()/logout()/clearStores() have already run. */
export async function wipeNamespace(o: { ns: string; paUserId: string }): Promise<WipeResult> {
  // Step 4 FIRST, unconditionally, before any database delete is attempted:
  // the storage key must die before any database delete, so a database that
  // survives the rest of this sequence is undecryptable rather than a
  // readable megolm key store. Do not reorder this.
  dropStorageKey(o.ns);

  // Step 6.
  try {
    localStorage.removeItem(storageKey(o.paUserId));
  } catch {
    // best effort
  }
  clearViewBreadcrumbs();

  // Step 7.
  const prefix = cryptoDbPrefix(o.ns);
  const swept = await sweepPrefixedDbNames(prefix);
  const names = Array.from(new Set([...cryptoDbNames(o.ns), ...swept]));
  const results = await Promise.all(names.map((n) => deleteDatabase(n)));
  const failed = results.filter((r) => !r.ok).map((r) => r.name);

  // Steps 8-9.
  if (failed.length === 0) return { ok: true, failed: [] };
  const merged = Array.from(new Set([...pendingWipeNames(), ...failed]));
  writePendingWipeNames(merged);
  return { ok: false, failed };
}

/** Retries every name recorded in `pa-mx-wipe-pending` (design §2.6 "drain at
 *  boot"). Returns the names still failing after the retry; the caller must
 *  refuse to open any namespace whose derived database names intersect this
 *  list. */
export async function drainPendingWipes(): Promise<string[]> {
  const pending = pendingWipeNames();
  if (pending.length === 0) return [];
  const results = await Promise.all(pending.map((n) => deleteDatabase(n)));
  const stillFailing = results.filter((r) => !r.ok).map((r) => r.name);
  writePendingWipeNames(stillFailing);
  return stillFailing;
}
