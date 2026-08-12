/**
 * The ONLY file in this app permitted to deep-import `matrix-js-sdk/lib/*`.
 *
 * matrix-js-sdk@42.1.0 ships no `exports` map, so subpaths like
 * `matrix-js-sdk/lib/crypto-api/index.js` resolve today only because nothing
 * blocks them — `lib/matrix.d.ts` (the package root) does not itself
 * re-export `./crypto-api`, so every crypto symbol needs a deep import.
 * Confining all of them to this one shim bounds the blast radius if a future
 * SDK release adds an `exports` map that seals those subpaths: only this file
 * would need to change.
 *
 * The SDK's own root export is also literally named `MatrixError`, colliding
 * with our normalised `MatrixError` in ./types.ts. It is aliased to
 * `SdkMatrixError` here and must never be imported unaliased anywhere else.
 */
export * as sdk from 'matrix-js-sdk';
export {
  createClient,
  MemoryStore,
  PendingEventOrdering,
  EventStatus,
  ClientEvent,
  RoomEvent,
  RoomStateEvent,
  MatrixEventEvent,
  HttpApiEvent,
  SyncState,
  ConnectionError,
  MatrixError as SdkMatrixError,
} from 'matrix-js-sdk';
export type { MatrixClient, Room, MatrixEvent, RoomMember, ICreateClientOpts } from 'matrix-js-sdk';

export {
  CryptoEvent,
  DecryptionFailureCode,
  ImportRoomKeyStage,
  decodeRecoveryKey,
  deriveRecoveryKeyFromPassphrase,
} from 'matrix-js-sdk/lib/crypto-api/index.js';
export type {
  CryptoApi,
  CryptoCallbacks,
  DeviceVerificationStatus,
  ImportRoomKeyProgressData,
  ImportRoomKeysOpts,
  OwnDeviceKeys,
  KeyBackupInfo,
  GeneratedSecretStorageKey,
} from 'matrix-js-sdk/lib/crypto-api/index.js';
export type { SecretStorageKeyDescription } from 'matrix-js-sdk/lib/secret-storage.js';
/** `lib/matrix.d.ts` re-exports `./@types/event.ts` but not `./@types/events.ts`
 *  (singular vs plural — two different files), so the content type
 *  `sendMessage()` accepts is only reachable by deep import. */
export type { RoomMessageEventContent } from 'matrix-js-sdk/lib/@types/events.js';
