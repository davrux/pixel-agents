/**
 * SDK client lifecycle: the only file that calls `createClient`. Owns the
 * single-writer Web Lock election, the pending-wipe drain, `initRustCrypto`
 * (with its memory-only fallback) and `startClient`. `store.ts` treats the
 * result as an opaque handle — it never re-derives any of this.
 *
 * Boot order here is load-bearing (see docs/design.md
 * §1.1/§1.5/§1.6/§2.6): the lock must be held before the pending-wipe drain,
 * which must run before a namespace can be reused, which must happen before
 * `createClient`, which must happen before `initRustCrypto` (to-device key
 * traffic arrives on the very first `/sync`), which must happen before
 * `startClient`.
 *
 * No DOM. No console.* — nothing here ever sees a message body or a token,
 * but the access token flows through `createClient`'s options object, so
 * even an accidental `console.log(o)` one line up would leak it.
 */
import { createClient, MemoryStore, PendingEventOrdering } from './sdk.js';
import type { MatrixClient } from './sdk.js';
import type { MxSession, MxCryptoStorage } from './types.js';
import { cryptoNamespace, cryptoDbPrefix, loadOrCreateStorageKey, drainPendingWipes } from './storage.js';
import type { MatrixCrypto } from './crypto.js';

export type MxBootState = 'ok' | 'locked-out' | 'wipe-pending' | 'failed';

export interface MxClientBoot {
  state: MxBootState;
  client: MatrixClient | null;
  ns: string;
  cryptoStorage: MxCryptoStorage;
  /** Display-ready reason, '' when state === 'ok'. */
  message: string;
  /** Display-ready non-fatal warning, '' when none. */
  warning: string;
  /** Release the Web Lock; idempotent. */
  release(): void;
}

function refused(ns: string, message: string): MxClientBoot {
  return { state: 'locked-out', client: null, ns, cryptoStorage: 'none', message, warning: '', release: noop };
}

function noop(): void {}

/** Resolves once we know whether the lock was granted; the lock itself, if
 *  granted, is held until `hold.release()` is called. `warning` is set only
 *  when `navigator.locks` does not exist at all — a browser that should not
 *  exist in this app's supported set, per AGENTS rule 8, but one we degrade
 *  loudly for rather than silently assume away. */
async function acquireLock(lockName: string): Promise<{ acquired: boolean; release: () => void; warning: string }> {
  if (typeof navigator === 'undefined' || !navigator.locks) {
    return {
      acquired: true,
      release: noop,
      warning: "Can't detect other tabs on this browser — keep Matrix open in only one tab.",
    };
  }
  return new Promise((resolveOuter) => {
    let settled = false;
    const settleOuter = (result: { acquired: boolean; release: () => void; warning: string }): void => {
      if (settled) return;
      settled = true;
      resolveOuter(result);
    };
    navigator.locks
      .request(lockName, { mode: 'exclusive', ifAvailable: true }, (lock) => {
        if (!lock) {
          settleOuter({ acquired: false, release: noop, warning: '' });
          return Promise.resolve();
        }
        // Held until `release()` resolves this — request() itself only
        // settles once the lock is released, so the caller must not await it.
        return new Promise<void>((releaseHeld) => {
          settleOuter({ acquired: true, release: releaseHeld, warning: '' });
        });
      })
      .catch(() => settleOuter({ acquired: false, release: noop, warning: '' }));
  });
}

export async function bootMatrixClient(o: {
  session: MxSession;
  paUserId: string;
  crypto: MatrixCrypto;
  onPhase(label: string): void;
}): Promise<MxClientBoot> {
  const ns = cryptoNamespace(o.paUserId, o.session.hsOrigin, o.session.userId);
  const dbPrefix = cryptoDbPrefix(ns);

  // ---- 1/1.5: single-writer election. Two rust-crypto machines on one
  // IndexedDB store corrupt it, so a miss here creates no client at all. ----
  const lock = await acquireLock(dbPrefix);
  if (!lock.acquired) {
    return refused(
      ns,
      'Matrix is already open in another tab of this app. Close the other tab and reload this one.',
    );
  }
  let release = lock.release;
  const releaseOnce = (): void => {
    release();
    release = noop;
  };

  // ---- 2/2.6: drain a wipe an earlier session couldn't finish, then refuse
  // to reuse a namespace that still has one pending (its storage key is
  // already gone, so reopening it would just build on an undecryptable
  // store — see storage.ts's wipeNamespace/drainPendingWipes). ----
  const stillPending = await drainPendingWipes();
  if (stillPending.some((name) => name.startsWith(dbPrefix))) {
    releaseOnce();
    return {
      state: 'wipe-pending',
      client: null,
      ns,
      cryptoStorage: 'none',
      message: 'Sign-out did not finish on this browser. Reload with other tabs of this app closed.',
      warning: '',
      release: noop,
    };
  }

  // ---- 3: construct. baseUrl is the already-validated MxSession URL —
  // never re-discovered, never re-set. ----
  const client: MatrixClient = createClient({
    baseUrl: o.session.hsBaseUrl,
    accessToken: o.session.accessToken,
    userId: o.session.userId,
    deviceId: o.session.deviceId,
    store: new MemoryStore({ localStorage: undefined }),
    timelineSupport: true,
    useAuthorizationHeader: true,
    cryptoCallbacks: o.crypto.callbacks,
  });

  // ---- 4: crypto store. IndexedDB first; memory-only is the sole fallback,
  // never no crypto at all (an encrypted room must stay readable). ----
  o.onPhase('Starting encryption…');
  let cryptoStorage: MxCryptoStorage;
  let warning = lock.warning;
  try {
    await client.initRustCrypto({
      useIndexedDB: true,
      cryptoDatabasePrefix: dbPrefix,
      storageKey: loadOrCreateStorageKey(ns),
    });
    cryptoStorage = 'indexeddb';
  } catch {
    try {
      await client.initRustCrypto({ useIndexedDB: false });
      cryptoStorage = 'memory';
      warning = warning
        ? `${warning} Encryption keys can't be saved on this device — you'll be asked to unlock again after a reload.`
        : "Encryption keys can't be saved on this device — you'll be asked to unlock again after a reload.";
    } catch (err) {
      releaseOnce();
      // Both initRustCrypto attempts failed — the constructed client never started (no
      // startClient()) and is being dropped; stop it so it can't hold open connections/timers.
      try {
        client.stopClient();
      } catch {
        /* best effort */
      }
      const reason = err instanceof Error ? err.message : 'unknown error';
      return {
        state: 'failed',
        client: null,
        ns,
        cryptoStorage: 'none',
        message: `Encryption unavailable — ${reason}`,
        warning: '',
        release: noop,
      };
    }
  }

  // ---- 5/6/7: attach, then the explicit non-default-trusting flag (see
  // file header — leaving this implicit is how a future SDK default flip
  // silently breaks delivery with no UI to explain it). ----
  o.crypto.attach(client, cryptoStorage);
  const crypto = client.getCrypto();
  if (crypto) crypto.globalBlacklistUnverifiedDevices = false;

  // ---- 8: start. Detached is mandatory — see Room.getPendingEvents() in
  // the file header of store.ts. ----
  await client.startClient({
    initialSyncLimit: 20,
    lazyLoadMembers: true,
    threadSupport: false,
    pollTimeout: 30000,
    pendingEventOrdering: PendingEventOrdering.Detached,
  });

  return { state: 'ok', client, ns, cryptoStorage, message: '', warning, release: releaseOnce };
}
