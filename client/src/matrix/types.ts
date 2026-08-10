/**
 * Vocabulary shared by every module under client/src/matrix/: the
 * normalised error class every store boundary throws, and the plain data
 * shapes the SDK-backed store (client.ts/store.ts) projects `sdk.Room` /
 * `sdk.MatrixEvent` onto for the UI (MatrixUI.ts/timeline.ts).
 *
 * This module imports ONLY ./sdk.js (for MatrixError.from's instanceof
 * checks against the SDK's own error classes) — nothing else, so it stays a
 * safe import for any file that must not drag in more than that.
 */
import { ConnectionError, SdkMatrixError } from './sdk.js';

export interface MatrixErrorInit {
  retryAfterMs?: number;
  softLogout?: boolean;
}

/** Thrown at every store/session boundary. Callers branch on `errcode` /
 *  `isNetwork` / `isUnknownToken` rather than parsing `message`, which is
 *  only for display. Use `MatrixError.from(e)` to normalise anything caught
 *  from the SDK (or a rejected fetch) into this shape — every public method
 *  in client.ts/store.ts/session.ts does this at its boundary. */
export class MatrixError extends Error {
  readonly status: number; // 0 == network/CORS failure
  readonly errcode: string; // '' when unknown
  readonly retryAfterMs?: number;
  readonly softLogout: boolean;

  constructor(status: number, errcode: string, message: string, init?: MatrixErrorInit) {
    super(message);
    this.name = 'MatrixError';
    this.status = status;
    this.errcode = errcode;
    this.retryAfterMs = init?.retryAfterMs;
    this.softLogout = init?.softLogout ?? false;
  }

  get isNetwork(): boolean {
    return this.status === 0;
  }

  get isUnknownToken(): boolean {
    return this.errcode === 'M_UNKNOWN_TOKEN' || this.softLogout;
  }

  /** Normalise anything caught at a store/session boundary into a
   *  MatrixError. MUST be called at every such boundary — without it,
   *  `e instanceof MatrixError` checks in the UI (e.g. `joinErrText`) silently
   *  stop matching and every error degrades to a generic string. */
  static from(e: unknown): MatrixError {
    if (e instanceof MatrixError) return e;
    if (e instanceof SdkMatrixError) {
      const retryAfterMs = typeof e.data?.retry_after_ms === 'number' ? e.data.retry_after_ms : undefined;
      const softLogout = e.data?.soft_logout === true;
      return new MatrixError(e.httpStatus ?? 0, e.errcode ?? '', e.data?.error ?? e.message, {
        retryAfterMs,
        softLogout,
      });
    }
    if (e instanceof ConnectionError) return new MatrixError(0, '', e.message);
    if (e instanceof DOMException && e.name === 'AbortError') return new MatrixError(0, 'M_ABORTED', 'Aborted.');
    return new MatrixError(0, '', e instanceof Error ? e.message : 'Something went wrong talking to the homeserver.');
  }
}

export interface MxEventUnsigned {
  transaction_id?: string;
  redacted_because?: unknown;
  age?: number;
}

/** Why an event body couldn't be shown: 'unlock' means the user can act (4S
 *  unlock / import a key), 'verify' means another device must resend the key,
 *  null means neither is currently actionable (e.g. a permanent failure). */
export type MxDecryptAction = 'unlock' | 'verify';

export interface MxDecryptError {
  code: string;
  text: string;
  action: MxDecryptAction | null;
}

export interface MxEvent {
  event_id: string;
  type: string;
  sender: string;
  origin_server_ts: number;
  content: Record<string, unknown>;
  state_key?: string;
  unsigned?: MxEventUnsigned;
  /** Local echo only: our transaction id. Absent on confirmed events. */
  txnId?: string;
  /** Local echo lifecycle. Absent on confirmed events. */
  echo?: 'pending' | 'failed';
  /** Set while the SDK is still attempting to decrypt this event. */
  decrypting?: true;
  /** Set once decryption has definitively failed. */
  decryptError?: MxDecryptError;
}

export type MxMembership = 'join' | 'invite' | 'leave';

export interface MxRoom {
  roomId: string;
  membership: MxMembership;
  name: string; // resolved display name, never a bare room id if avoidable
  isDirect: boolean;
  encrypted: boolean;
  joinedCount: number;
  invitedCount: number;
  unread: number; // notification_count
  highlight: number; // highlight_count
  lastTs: number; // 0 when no event known
  preview: string; // one-line plain-text preview, '' when none
  inviterId: string; // invites only, else ''
  inviteIsDirect: boolean; // invites only
  /** mxc:// of the room's picture, or for a DM without one, the other
   *  person's. null when there is nothing to show (the UI falls back to its
   *  initials square). Never an http URL — resolving it is the store's job. */
  avatarMxc: string | null;
}

export interface MxMember {
  userId: string;
  displayName: string;
  membership: 'join' | 'invite';
  avatarMxc: string | null;
}

export interface MxDirectoryUser {
  userId: string;
  displayName: string;
  avatarMxc: string | null;
}

export interface MxSession {
  hsBaseUrl: string;
  hsOrigin: string;
  userId: string;
  deviceId: string;
  accessToken: string;
  savedAt: number;
}

export type MxStatus = 'connecting' | 'connected' | 'syncing' | 'reconnecting' | 'offline' | 'signedout';

export interface MxLoginFlows {
  passwordSupported: boolean;
}

export type MxCryptoState =
  | 'unavailable'
  | 'memory-only'
  | 'unknown'
  | 'never-set-up'
  | 'locked'
  | 'unlocking'
  | 'wrong-key'
  | 'ready';

export type MxCryptoStorage = 'indexeddb' | 'memory' | 'none';

export interface MxDeviceInfo {
  deviceId: string;
  displayName: string | null;
  ed25519: string;
  verified: boolean;
  isCurrent: boolean;
}

export interface MxKeyImportResult {
  imported: number;
  total: number;
  failures: number;
  counted: boolean;
}

export interface MxSecretRequest {
  keyIds: string[];
  secretName: string;
  hasPassphrase: boolean;
}

export interface MxBackupStatus {
  version: string | null;
  active: boolean;
}
