/**
 * Facade over matrix-js-sdk's `CryptoApi` (docs/design/matrix-e2ee-design.md §4.3, §5.2-§5.7, §8.1).
 *
 * `createMatrixCrypto()` is called BEFORE `createClient` — its `callbacks` (the Secret Storage / "4S"
 * broker) are handed to `createClient({ cryptoCallbacks })`, and `attach()` is called after
 * `initRustCrypto()` succeeds. Every method is a no-op/rejects gracefully before `attach()` — this file
 * never assumes a client exists.
 *
 * This is the ONE place in the app that ever sees the three high-value secrets (the 4S recovery key,
 * the security phrase, the derived private key). Per §8.1: never logged, never persisted anywhere
 * (localStorage/sessionStorage/IndexedDB/cookie/URL/history.state), and every derived `Uint8Array` is
 * `.fill(0)`ed once it is no longer needed. The one deliberate exception is the unlocked 4S private key,
 * kept in the module-scoped `keyCache` so the SDK is not re-prompted for every secret — it lives only
 * until `destroy()`. JavaScript strings cannot be zeroed (a platform limit); this module never copies a
 * secret string into a field that outlives the call that received it.
 *
 * `unlock()` works whether or not the SDK currently has a `getSecretStorageKey` call outstanding
 * (`pendingBroker`). Ordinarily there IS no pending broker at unlock time — boot's `refresh()` derives
 * `'locked'` purely from `secretStorage.getDefaultKeyId()`, with nothing on the boot path calling
 * `getSecretStorageKey` — so `unlock()` fetches the key description itself via
 * `client.secretStorage.getKey()` in that case, and only defers to the broker's own `keys` map when one
 * is genuinely pending (e.g. a `bootstrapCrossSigning`/`store()` call blocked on us mid-flight).
 *
 * An incoming SAS verification request (§5.7, explicitly out of scope — we never accept one) has no
 * event of its own in `MatrixCryptoEventMap`; it is emitted under the informal key
 * `'verificationRequest'` via the same `on()`/`emit()` machinery, for a caller willing to subscribe to
 * it through a runtime cast.
 */
import {
  CryptoEvent,
  DecryptionFailureCode,
  ImportRoomKeyStage,
  decodeRecoveryKey,
  deriveRecoveryKeyFromPassphrase,
  SdkMatrixError,
} from './sdk.js';
import type {
  MatrixClient,
  MatrixEvent,
  CryptoApi,
  CryptoCallbacks,
  ImportRoomKeyProgressData,
  OwnDeviceKeys,
  GeneratedSecretStorageKey,
  SecretStorageKeyDescription,
} from './sdk.js';
import { MatrixError } from './types.js';
import type {
  MxCryptoState,
  MxCryptoStorage,
  MxDeviceInfo,
  MxKeyImportResult,
  MxSecretRequest,
  MxDecryptError,
  MxDecryptAction,
  MxBackupStatus,
} from './types.js';

export interface MatrixCryptoEventMap {
  state: void;
  devices: void;
  secretRequest: MxSecretRequest;
}

export interface MatrixCrypto {
  readonly callbacks: CryptoCallbacks;
  readonly state: MxCryptoState;
  readonly storage: MxCryptoStorage;
  on<K extends keyof MatrixCryptoEventMap>(k: K, fn: (p: MatrixCryptoEventMap[K]) => void): () => void;
  attach(client: MatrixClient, storage: MxCryptoStorage): void;
  refresh(): Promise<void>;
  ownDevice(): Promise<MxDeviceInfo>;
  otherDevices(): Promise<MxDeviceInfo[]>;
  unlock(input: string): Promise<'ok' | 'wrong-key' | 'no-passphrase' | 'error'>;
  cancelUnlock(): void;
  setUpRecovery(
    askPassword: (message: string) => Promise<string | null>,
  ): Promise<{ kind: 'created'; key: string } | { kind: 'already-set-up' }>;
  backupStatus(): Promise<MxBackupStatus>;
  connectBackup(): Promise<void>;
  restoreBackup(onProgress: (pct: number | null) => void): Promise<{ total: number; imported: number }>;
  exportRoomKeys(): Promise<string>;
  importRoomKeys(json: string, onProgress: (pct: number | null) => void): Promise<MxKeyImportResult>;
  decryptErrorFor(ev: MatrixEvent): MxDecryptError;
  destroy(): void;
}

/** A 4S secret-storage request pending the view's Unlock/Cancel, or the 5-minute timeout. */
interface PendingBroker {
  resolve: (v: [string, Uint8Array<ArrayBuffer>] | null) => void;
  timer: ReturnType<typeof setTimeout>;
  keys: Record<string, SecretStorageKeyDescription>;
}

/** [code, rendered text, follow-up action] — the exact taxonomy from §4.3, read from
 *  lib/crypto-api/index.d.ts:631. Compared by enum MEMBER, never by string literal: the enum is a
 *  string enum, so a mistyped literal would compile and silently never match. */
const DECRYPT_ERROR_TABLE: ReadonlyArray<readonly [DecryptionFailureCode, string, MxDecryptAction | null]> = [
  [DecryptionFailureCode.MEGOLM_UNKNOWN_INBOUND_SESSION_ID, "🔒 Waiting for this message's key…", 'unlock'],
  [
    DecryptionFailureCode.OLM_UNKNOWN_MESSAGE_INDEX,
    "🔒 Sent to this room before this point — your key doesn't cover it.",
    'unlock',
  ],
  [
    DecryptionFailureCode.HISTORICAL_MESSAGE_BACKUP_UNCONFIGURED,
    '🔒 Sent before you signed in on this device, and you have no key backup.',
    'unlock',
  ],
  [
    DecryptionFailureCode.HISTORICAL_MESSAGE_NO_KEY_BACKUP,
    '🔒 Sent before you signed in on this device — not in your key backup.',
    'unlock',
  ],
  [DecryptionFailureCode.HISTORICAL_MESSAGE_WORKING_BACKUP, "🔒 Fetching this message's key from your backup…", null],
  [DecryptionFailureCode.HISTORICAL_MESSAGE_USER_NOT_JOINED, '🔒 Sent before you joined this room.', null],
  [DecryptionFailureCode.MEGOLM_KEY_WITHHELD, "🔒 The sender chose not to share this message's key.", null],
  [
    DecryptionFailureCode.MEGOLM_KEY_WITHHELD_FOR_UNVERIFIED_DEVICE,
    '🔒 The sender only shares keys with verified devices.',
    'verify',
  ],
  [
    DecryptionFailureCode.SENDER_IDENTITY_PREVIOUSLY_VERIFIED,
    "🔒 The sender's identity changed — this message can't be trusted.",
    null,
  ],
  [DecryptionFailureCode.UNSIGNED_SENDER_DEVICE, "🔒 Can't confirm which device sent this.", null],
  [DecryptionFailureCode.UNKNOWN_SENDER_DEVICE, "🔒 Can't confirm which device sent this.", null],
];
const DECRYPT_ERROR_MAP = new Map<DecryptionFailureCode, { text: string; action: MxDecryptAction | null }>(
  DECRYPT_ERROR_TABLE.map(([code, text, action]) => [code, { text, action }]),
);
const GENERIC_DECRYPT_ERROR = "🔒 Couldn't decrypt this message.";

const UNLOCK_TIMEOUT_MS = 5 * 60_000;

/** Reduces the discriminated `ImportRoomKeyProgressData` union to a single percent, or `null` while
 *  indeterminate (the `Fetch` stage carries no counts at all — destructuring it unconditionally would
 *  yield NaN). Shared by importRoomKeys() and restoreBackup(), whose progressCallback is the same union. */
function pctFromProgress(p: ImportRoomKeyProgressData): number | null {
  switch (p.stage) {
    case ImportRoomKeyStage.Fetch:
      return null;
    case ImportRoomKeyStage.LoadKeys:
      return p.total > 0 ? ((p.successes + p.failures) / p.total) * 100 : null;
    default:
      return null;
  }
}

/** `MxCryptoStorage` is exactly the string union `'indexeddb' | 'memory' | 'none'` — a plain string
 *  comparison, no cast needed. */
function isMemoryOnly(storage: MxCryptoStorage): boolean {
  return storage === 'memory';
}

/** Builds an `MxDeviceInfo`. */
function deviceInfo(
  deviceId: string,
  displayName: string | null,
  ed25519: string,
  verified: boolean,
  isCurrent: boolean,
): MxDeviceInfo {
  return { deviceId, displayName, ed25519, verified, isCurrent };
}

/** Builds an `MxKeyImportResult`. */
function keyImportResult(imported: number, total: number, failures: number, counted: boolean): MxKeyImportResult {
  return { imported, total, failures, counted };
}

export function createMatrixCrypto(): MatrixCrypto {
  let client: MatrixClient | null = null;
  let cryptoApi: CryptoApi | null = null;
  let storageInfo: MxCryptoStorage = 'none';
  let state: MxCryptoState = 'unavailable';
  let pendingBroker: PendingBroker | null = null;

  // The unlocked 4S private key(s), keyed by 4S key id. This Map is the ONE permitted long-lived
  // retention of secret material in this feature (§8.1) — cleared and zeroed only in destroy().
  const keyCache = new Map<string, Uint8Array<ArrayBuffer>>();

  // A plain `Map<string, ...>`, not a per-key object: `MatrixCryptoEventMap` names three events, but
  // §5.7 also wants a fire-and-forget notice for an incoming SAS verification request we cannot act on
  // (out of scope — we never accept one). There is no fourth entry in the typed contract for it, so it
  // is emitted under the informal key `'verificationRequest'`; `on()`'s public signature stays exactly
  // the three-key contract, but nothing stops a caller from subscribing to the extra key via the same
  // runtime function (as EncryptionUI.ts does, defensively, behind a cast).
  const listeners = new Map<string, Set<(payload: unknown) => void>>();
  const sdkUnsubs: Array<() => void> = [];

  function emit(k: string, payload: unknown): void {
    for (const fn of listeners.get(k) ?? []) fn(payload);
  }

  function setState(next: MxCryptoState): void {
    state = next;
    emit('state', undefined);
  }

  function settleBroker(v: [string, Uint8Array<ArrayBuffer>] | null): void {
    if (!pendingBroker) return;
    clearTimeout(pendingBroker.timer);
    const { resolve } = pendingBroker;
    pendingBroker = null;
    resolve(v);
  }

  // --- The 4S broker (docs §5.4). MUST resolve null, MUST NEVER reject — a mid-flight throw here can
  // leave bootstrapSecretStorage()'s multi-step write half-done. ---
  const callbacks: CryptoCallbacks = {
    getSecretStorageKey: async ({ keys }, secretName) => {
      for (const keyId of Object.keys(keys)) {
        const cached = keyCache.get(keyId);
        if (cached) return [keyId, cached];
      }

      setState('locked');
      const hasPassphrase = Object.values(keys).some((k) => !!k.passphrase);
      emit('secretRequest', {
        keyIds: Object.keys(keys),
        secretName,
        hasPassphrase,
      } as unknown as MxSecretRequest);

      return await new Promise<[string, Uint8Array<ArrayBuffer>] | null>((resolve) => {
        // Only one 4S request is ever outstanding in this app's flow; if a stale one is still
        // waiting, resolve it null rather than leak it before starting the new one.
        settleBroker(null);
        const timer = setTimeout(() => {
          pendingBroker = null;
          resolve(null);
        }, UNLOCK_TIMEOUT_MS);
        pendingBroker = { resolve, timer, keys };
      });
    },
    cacheSecretStorageKey: (keyId, _keyInfo, key) => {
      keyCache.set(keyId, key);
    },
  };

  function on<K extends keyof MatrixCryptoEventMap>(k: K, fn: (p: MatrixCryptoEventMap[K]) => void): () => void {
    let set = listeners.get(k);
    if (!set) {
      set = new Set();
      listeners.set(k, set);
    }
    const wrapped = fn as (p: unknown) => void;
    set.add(wrapped);
    // `attach()` kicks off `refresh()` (and its first `setState()`) before the caller has necessarily
    // had a chance to subscribe — replay the current state to a fresh 'state' subscriber so a
    // transition emitted in that window is never silently dropped.
    if (k === 'state') wrapped(undefined);
    return () => set?.delete(wrapped);
  }

  function attach(c: MatrixClient, storage: MxCryptoStorage): void {
    client = c;
    storageInfo = storage;
    cryptoApi = c.getCrypto() ?? null;

    if (!cryptoApi) {
      setState('unavailable');
      return;
    }

    const onDevicesUpdated = () => emit('devices', undefined);
    c.on(CryptoEvent.DevicesUpdated, onDevicesUpdated);
    sdkUnsubs.push(() => c.off(CryptoEvent.DevicesUpdated, onDevicesUpdated));

    // SAS is out of scope (§5.7): we never accept a verification request, but we surface that one
    // arrived so the UI can show an honest "can't verify that way yet" notice instead of silence.
    // `MatrixCryptoEventMap` has no fourth event for this, so it is emitted under the informal key
    // `'verificationRequest'` — see the comment above the `listeners` declaration.
    const onVerificationRequest = () => emit('verificationRequest', undefined);
    c.on(CryptoEvent.VerificationRequestReceived, onVerificationRequest);
    sdkUnsubs.push(() => c.off(CryptoEvent.VerificationRequestReceived, onVerificationRequest));

    void refresh();
  }

  async function refresh(): Promise<void> {
    if (!client || !cryptoApi) {
      setState('unavailable');
      return;
    }
    if (isMemoryOnly(storageInfo)) {
      setState('memory-only');
      return;
    }

    let defaultKeyId: string | null = null;
    let failed = false;
    try {
      defaultKeyId = await client.secretStorage.getDefaultKeyId();
    } catch {
      // This is an authed HTTP GET before initial sync completes, so a
      // transient network/CORS/rate-limit error is possible here — do NOT
      // collapse that into "no 4S configured" (a false statement about a
      // security-critical fact). 'unknown' lets the UI say "couldn't check"
      // and offer a retry instead of a wrong answer.
      failed = true;
    }

    if (failed) {
      setState('unknown');
    } else if (defaultKeyId === null) {
      setState('never-set-up');
    } else if (keyCache.has(defaultKeyId)) {
      setState('ready');
    } else {
      setState('locked');
    }
  }

  async function ownDevice(): Promise<MxDeviceInfo> {
    const empty = deviceInfo('', null, '', false, true);
    if (!client || !cryptoApi) return empty;

    const deviceId = client.getDeviceId() ?? '';
    let ed25519 = '';
    try {
      const keys: OwnDeviceKeys = await cryptoApi.getOwnDeviceKeys();
      ed25519 = keys.ed25519;
    } catch {
      /* leave blank — the panel shows the device id regardless */
    }

    let verified = false;
    const userId = client.getUserId();
    if (userId) {
      try {
        const status = await cryptoApi.getDeviceVerificationStatus(userId, deviceId);
        verified = status?.crossSigningVerified === true;
      } catch {
        /* leave false */
      }
    }

    return deviceInfo(deviceId, null, ed25519, verified, true);
  }

  async function otherDevices(): Promise<MxDeviceInfo[]> {
    if (!client || !cryptoApi) return [];
    const userId = client.getUserId();
    if (!userId) return [];

    let deviceMap;
    try {
      deviceMap = await cryptoApi.getUserDeviceInfo([userId], true);
    } catch {
      return [];
    }
    const own = deviceMap.get(userId);
    if (!own) return [];
    const myDeviceId = client.getDeviceId();

    const out: MxDeviceInfo[] = [];
    for (const [deviceId, device] of own) {
      if (deviceId === myDeviceId) continue;
      let verified = false;
      try {
        const status = await cryptoApi.getDeviceVerificationStatus(userId, deviceId);
        verified = status?.crossSigningVerified === true;
      } catch {
        /* leave false */
      }
      // Device display names are remote strings the OTHER device chose — never assign as markup; the
      // UI must set it via textContent.
      out.push(
        deviceInfo(deviceId, device.displayName ?? null, device.keys.get(`ed25519:${deviceId}`) ?? '', verified, false),
      );
    }
    return out;
  }

  async function unlock(input: string): Promise<'ok' | 'wrong-key' | 'no-passphrase' | 'error'> {
    if (!client || !cryptoApi) return 'error';

    let keyId: string | null = null;
    let keyInfo: SecretStorageKeyDescription | null = null;
    const broker = pendingBroker;
    if (broker) {
      try {
        const def = await client.secretStorage.getDefaultKeyId();
        if (def && def in broker.keys) keyId = def;
      } catch {
        keyId = null;
      }
      if (!keyId) keyId = Object.keys(broker.keys)[0] ?? null;
      if (keyId) keyInfo = broker.keys[keyId];
    } else {
      // No `getSecretStorageKey` call is currently outstanding — this is the
      // ordinary case (new device, account already has 4S, nothing has
      // asked the SDK for a secret yet). Fetch the key description directly
      // rather than refuse: without this, unlock can never succeed on the
      // most common path into this feature.
      try {
        const tuple = await client.secretStorage.getKey();
        if (tuple) {
          keyId = tuple[0];
          keyInfo = tuple[1];
        }
      } catch {
        keyId = null;
        keyInfo = null;
      }
    }
    if (!keyId || !keyInfo) return 'error';

    let privateKey: Uint8Array<ArrayBuffer>;
    try {
      privateKey = decodeRecoveryKey(input);
    } catch {
      if (!keyInfo.passphrase) return 'no-passphrase';
      try {
        privateKey = await deriveRecoveryKeyFromPassphrase(
          input,
          keyInfo.passphrase.salt,
          keyInfo.passphrase.iterations,
        );
      } catch {
        return 'error';
      }
    }

    setState('unlocking');

    let ok: boolean;
    try {
      ok = await client.secretStorage.checkKey(privateKey, keyInfo);
    } catch {
      privateKey.fill(0);
      setState('locked');
      return 'error';
    }

    if (!ok) {
      // If the SDK is still awaiting the broker promise, do NOT settle it, so the user gets another try.
      privateKey.fill(0);
      setState('wrong-key');
      return 'wrong-key';
    }

    keyCache.set(keyId, privateKey);
    if (broker) settleBroker([keyId, privateKey]);
    setState('ready');

    try {
      await cryptoApi.bootstrapCrossSigning({});
      await cryptoApi.loadSessionBackupPrivateKeyFromSecretStorage();
      await cryptoApi.checkKeyBackupAndEnable();
    } catch {
      // Best-effort follow-up; 4S is unlocked either way (state is already 'ready').
    }
    emit('devices', undefined);
    return 'ok';
  }

  function cancelUnlock(): void {
    settleBroker(null);
    // Leave `state` alone: it is already 'locked' (set when the request was raised); refresh()
    // will re-derive it on demand.
  }

  async function setUpRecovery(
    askPassword: (message: string) => Promise<string | null>,
  ): Promise<{ kind: 'created'; key: string } | { kind: 'already-set-up' }> {
    if (!client || !cryptoApi) {
      throw new MatrixError(0, '', 'Encryption is not available in this browser session.');
    }
    const cc = cryptoApi;
    const cl = client;

    const authUploadDeviceSigningKeys = async (
      makeRequest: (authData: Record<string, unknown> | null) => Promise<void>,
    ): Promise<void> => {
      try {
        await makeRequest(null);
        return;
      } catch (err) {
        if (!(err instanceof SdkMatrixError)) throw err;
        const data = err.data as { flows?: Array<{ stages: string[] }>; session?: string } | undefined;
        const flows = data?.flows ?? [];
        const passwordFlow = flows.find((f) => f.stages.length === 1 && f.stages[0] === 'm.login.password');
        if (!passwordFlow) {
          throw new MatrixError(0, '', "Your homeserver needs a sign-in method this client doesn't support.");
        }

        const password = await askPassword('Confirm your password to set up recovery.');
        if (password === null) {
          throw new MatrixError(0, '', 'Cancelled.');
        }
        const userId = cl.getUserId();
        if (!userId) {
          throw new MatrixError(0, '', 'Not signed in.');
        }
        await makeRequest({
          type: 'm.login.password',
          identifier: { type: 'm.id.user', user: userId },
          password,
          session: data?.session ?? '',
        });
      }
    };

    // Deliberately no reset-cross-signing flag in this options object: the SDK's own branch (see
    // CrossSigningIdentity.js) decides and its JSDoc says that's safe when things are already set up.
    // Forcing a reset here would call resetCrossSigning() with no existence check — on an account that
    // already has cross-signing (but no 4S, which is exactly the state this method handles) that
    // permanently invalidates every existing device/user verification. Don't add that flag back.
    // `AuthDict` isn't re-exported through sdk.ts (only the specific symbols this module needs are),
    // so the auth-data payload here is typed structurally rather than against the SDK's own union.
    await cc.bootstrapCrossSigning({
      authUploadDeviceSigningKeys: authUploadDeviceSigningKeys as unknown as Parameters<
        typeof cc.bootstrapCrossSigning
      >[0]['authUploadDeviceSigningKeys'],
    });

    const existingBackup = await cc.getKeyBackupInfo();

    // A plain `let` reassigned only inside the nested callback below defeats TS's narrowing (the
    // compiler can't see the closure's assignment as part of this function's control flow, so a read
    // after the `await` would type as `never`) — an indirection through an object property sidesteps
    // that; see the repro in this module's PR notes.
    const generated: { key: GeneratedSecretStorageKey | null } = { key: null };
    await cc.bootstrapSecretStorage({
      createSecretStorageKey: async () => {
        generated.key = await cc.createRecoveryKeyFromPassphrase();
        return generated.key;
      },
      // Only reset the backup when the account genuinely has none — resetKeyBackup() replaces any
      // existing backup version, which would orphan every megolm key already stored there.
      setupNewKeyBackup: existingBackup === null,
    });

    await refresh();
    emit('devices', undefined);

    // bootstrapSecretStorage() never invokes createSecretStorageKey when 4S already exists on the
    // account (exactly the state this method is meant to handle) — never silently hand back a falsy
    // key captioned as "the only way back into your encrypted history"; tell the caller so it can fall
    // into the unlock flow instead.
    if (!generated.key) return { kind: 'already-set-up' };
    // `encodedPrivateKey` is typed optional by the SDK but is always populated by
    // createRecoveryKeyFromPassphrase() (the only path that ever fills `generated.key` here) — the
    // fallback is defensive, not expected to be exercised.
    return { kind: 'created', key: generated.key.encodedPrivateKey ?? '' };
  }

  async function backupStatus(): Promise<MxBackupStatus> {
    if (!cryptoApi) return { version: null, active: false };
    const version = await cryptoApi.getActiveSessionBackupVersion();
    return { version, active: version !== null };
  }

  async function connectBackup(): Promise<void> {
    if (!cryptoApi) return;
    await cryptoApi.checkKeyBackupAndEnable();
  }

  async function restoreBackup(
    onProgress: (pct: number | null) => void,
  ): Promise<{ total: number; imported: number }> {
    if (!cryptoApi) return { total: 0, imported: 0 };
    const result = await cryptoApi.restoreKeyBackup({
      progressCallback: (p) => onProgress(pctFromProgress(p)),
    });
    return { total: result.total, imported: result.imported };
  }

  async function exportRoomKeys(): Promise<string> {
    if (!cryptoApi) return '[]';
    return await cryptoApi.exportRoomKeysAsJson();
  }

  async function importRoomKeys(
    json: string,
    onProgress: (pct: number | null) => void,
  ): Promise<MxKeyImportResult> {
    const notCounted = keyImportResult(0, 0, 0, false);
    if (!cryptoApi) return notCounted;

    // See the comment in setUpRecovery(): an object-property indirection, not a bare `let`, because
    // this is only ever reassigned inside the nested progressCallback below.
    const last: { seen: { successes: number; failures: number; total: number } | null } = { seen: null };
    await cryptoApi.importRoomKeysAsJson(json, {
      progressCallback: (p) => {
        onProgress(pctFromProgress(p));
        if (p.stage === ImportRoomKeyStage.LoadKeys) {
          last.seen = { successes: p.successes, failures: p.failures, total: p.total };
        }
      },
    });

    if (!last.seen) return notCounted;
    return keyImportResult(last.seen.successes, last.seen.total, last.seen.failures, true);
  }

  function decryptErrorFor(ev: MatrixEvent): MxDecryptError {
    const code = ev.decryptionFailureReason;
    const entry = code ? DECRYPT_ERROR_MAP.get(code) : undefined;
    if (entry) {
      return { code: code as string, text: entry.text, action: entry.action };
    }
    return {
      code: (code as string | null) ?? 'UNKNOWN_ERROR',
      text: GENERIC_DECRYPT_ERROR,
      action: null,
    };
  }

  function destroy(): void {
    for (const key of keyCache.values()) key.fill(0);
    keyCache.clear();
    settleBroker(null);
    for (const off of sdkUnsubs) off();
    sdkUnsubs.length = 0;
    for (const set of listeners.values()) set.clear();
    client = null;
    cryptoApi = null;
    state = 'unavailable';
  }

  return {
    callbacks,
    get state() {
      return state;
    },
    get storage() {
      return storageInfo;
    },
    on,
    attach,
    refresh,
    ownDevice,
    otherDevices,
    unlock,
    cancelUnlock,
    setUpRecovery,
    backupStatus,
    connectBackup,
    restoreBackup,
    exportRoomKeys,
    importRoomKeys,
    decryptErrorFor,
    destroy,
  };
}
