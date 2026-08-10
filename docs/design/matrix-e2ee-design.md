# Matrix E2EE — Official SDK Transport Swap

**Status:** Accepted (design). Supersedes §1 (Transport Decision) and §2 (E2EE Position) of
`docs/design/matrix-chat-design.md`.

**Why this exists:** the user asked for it, in these words —

> *"i want the project to have e2ee use the official matrix sdk. add an option to upload your matrix
> keys like the mumble certificate. make sure the client works in web an desktop"*

The previous document required an ADR before the transport decision could be reversed. The reversal
here is a **direct product instruction from the repo owner**, not a re-litigation of the old
decision's merits. This document is the record of the reversal. If the repo later wants a formal
`ADR-0002`, it is a one-page extract of §0 and §1 below; nothing in it would be new.

---

## 0. Summary of the change

| | Before | After |
|---|---|---|
| Transport | hand-rolled `fetch` CS-API (`api.ts` + `sync.ts`) | `matrix-js-sdk@42.x` with `initRustCrypto()` |
| Encrypted rooms | read-only, `🔒 Encrypted message` placeholder, composer disabled | **readable and writable**; undecryptable events render an honest, typed reason |
| Key material | none | rust-crypto IndexedDB store, namespaced per (pa user, homeserver, mxid), wiped on sign-out |
| Key portability | none | Element-format room-key file import/export + Secret Storage (4S) recovery key / security phrase + server-side key backup |
| Devices | invisible | this device's id + fingerprint + trust; other devices listed with trust state |
| npm deps | zero | `matrix-js-sdk` (+12 transitive, incl. `@matrix-org/matrix-sdk-crypto-wasm`) |
| Build config | none | **none** — proven by build probe (§6) |
| Server change | none | **none** (still zero endpoints, zero Colyseus messages, zero schema fields) |

The seam documented in the recon survives: `index.ts` still exports exactly
`createMatrixClient(mount, hooks) -> MatrixClientHandle`, so `OfficeScene.ts` gains **one net
improvement** (the `session.js` import fix) and no other functional change.

### Requirements traceability

| Req | Where |
|---|---|
| A — full transport swap to the official SDK | §1, §3 |
| B — E2EE actually works, honest failures | §4 |
| C1 — room-key file import/export | §5.3 |
| C2 — 4S recovery key / security phrase | §5.4 |
| D — device panel + verify-this-device | §5.6; SAS explicitly **out of scope** (§5.7) |
| E — Chrome + Firefox + Electron `app://` | §6, §7 |
| F — logout destroys local crypto state | §2 (numbered, testable) |
| defect — `OfficeScene` bypasses `index.ts` | §6.5 |

---

## 1. SDK client lifecycle

### 1.1 Construction

`client/src/matrix/client.ts` (new) owns the whole lifecycle. It is the only file that calls
`createClient`.

```ts
import * as sdk from 'matrix-js-sdk';          // resolves to lib/browser-index.js under Vite
import { PendingEventOrdering } from 'matrix-js-sdk';

const client = sdk.createClient({
  baseUrl:      session.hsBaseUrl,   // the VALIDATED base URL (§8.2) — never window.location-derived
  accessToken:  session.accessToken,
  userId:       session.userId,
  deviceId:     session.deviceId,
  store:        new sdk.MemoryStore({ localStorage: undefined }),   // §1.2
  timelineSupport: true,
  useAuthorizationHeader: true,
  cryptoCallbacks: { getSecretStorageKey },   // §5.4
});
```

**The crypto layer is NOT reachable from the package root.** `lib/matrix.d.ts` has no
`export * from "./crypto-api/index.ts"` (verified against the installed package). `CryptoApi`,
`CryptoEvent`, `DecryptionFailureCode`, `ImportRoomKeyStage`, `DeviceVerificationStatus`,
`decodeRecoveryKey` and `deriveRecoveryKeyFromPassphrase` therefore require **deep imports**
(`matrix-js-sdk/lib/crypto-api/index.js`), which only work because the package ships no `exports`
map. That is an unsealed-subpath accident a minor release can close, so **every deep import lives in
exactly one file**, `client/src/matrix/sdk.ts`, a re-export shim:

```ts
// client/src/matrix/sdk.ts — the ONLY file allowed to deep-import the SDK.
export * as sdk from 'matrix-js-sdk';
export { MatrixError as SdkMatrixError, ConnectionError } from 'matrix-js-sdk';
export {
  CryptoEvent, DecryptionFailureCode, ImportRoomKeyStage,
  decodeRecoveryKey, deriveRecoveryKeyFromPassphrase,
} from 'matrix-js-sdk/lib/crypto-api/index.js';
export type {
  CryptoApi, CryptoCallbacks, DeviceVerificationStatus, ImportRoomKeyProgressData,
  ImportRoomKeysOpts, OwnDeviceKeys, KeyBackupInfo,
} from 'matrix-js-sdk/lib/crypto-api/index.js';
```

The SDK's own root export is also literally named `MatrixError` and collides with ours; it is aliased
to `SdkMatrixError` at this one boundary and never imported unaliased anywhere else.

Boot order — **this order is load-bearing**:

1. acquire the single-writer lock (§1.5); on failure stop here and show the "open in another tab" state;
2. drain any pending wipe from a previous session (§2.6);
3. `await initRustCrypto(...)` (§1.3) — **before** `startClient`, because to-device key traffic
   arrives on the very first `/sync` and there must be an olm machine to consume it;
4. `client.getCrypto()!.globalBlacklistUnverifiedDevices = false` — set **explicitly**. The default is
   already `false`, but leaving it implicit is how a future SDK default flip silently turns every send
   into "message not delivered to unverified devices" with no UI to explain it;
5. `await client.startClient({ initialSyncLimit: 20, lazyLoadMembers: true, threadSupport: false,
   pollTimeout: 30000, pendingEventOrdering: PendingEventOrdering.Detached })`;
6. wire the event listeners (§3.3).

**`pendingEventOrdering: Detached` is mandatory, not a preference.** `Room.getPendingEvents()` throws
`"Cannot call getPendingEvents with pendingEventOrdering == chronological"` unless the room was
constructed with `Detached` (`lib/models/room.js:566`), and `chronological` is the SDK default. §3.3's
`timeline(roomId)` calls `getPendingEvents()`, so without this option the panel throws on the first
render of any room. `Detached` also keeps local echoes *out* of the live timeline, which is what makes
the `getLiveTimeline().getEvents()` + `getPendingEvents()` concatenation in §3.3 correct rather than
double-rendering every pending message.

Steps 1–6 all run inside `MatrixStore.start()`, which stays **synchronous to its caller** (it kicks
off an async boot and returns). This is what lets `MatrixUI.startStoreFromSession()` keep its exact
current shape: `new MatrixStore({ session }); … ; this.store.start();`.

Boot failure is reported through the existing status surface: `status = 'offline'` and
`statusLabel = 'Encryption unavailable — <reason>'`. (One-line UI diff: the top strip's Retry link is
shown for `'offline'` as well as `'reconnecting'`.)

### 1.2 Sync store: **MemoryStore**, not IndexedDBStore

**Decision: `MemoryStore` for the sync/room store; IndexedDB **only** for the crypto store.**

Why:

- **Requirement F is a security requirement and every extra database is another thing the wipe can
  fail to delete.** One persistent database (crypto) is auditable; two are twice the failure surface,
  and the sync store is the one holding *plaintext room content*.
- **Multi-tab.** `IndexedDBStore` is the SDK's most tab-hostile component (it holds long-lived
  connections and its remote/worker variant exists precisely because of this). MemoryStore removes
  that whole class of problem from the sync path; only the crypto store then needs the lock (§1.5).
- **No regression.** The client being replaced also had no persistent sync store — it did a cold
  initial `/sync` on every page load. And `goToZone()` does `history.replaceState` + `reloadApp()`, so
  **every portal is already a full page reload**: a persistent sync store would be re-warmed and
  re-invalidated constantly for a panel the user may not even open.
- **Bundle.** MemoryStore avoids pulling the IndexedDB store backends into the lazy chunk.

Cost, stated honestly: a cold `initialSyncLimit: 20` sync on every page load. For a large account this
is 1–3 s of "Syncing…" before the room list is complete — which the existing UI already renders
(`renderRoomsView` shows a first-load spinner on `status === 'syncing' && rooms.length === 0`).

**Assumption A-9 (verify):** Synapse returns *pending* to-device messages on an initial sync (its
`_generate_sync_entry_for_to_device` reads from stream id 0 when `since` is absent), so a memory sync
store does not lose room keys sent while the tab was closed. This must be confirmed against the target
homeserver before shipping; if a homeserver is found that drops them, the fallback is
`IndexedDBStore` for the sync store with its database added to the §2 wipe list — a contained change.

*Rejected:* **IndexedDBStore** — faster warm starts, but three costs above and the correctness risk
of two writers. *Rejected:* **StubStore** — the SDK needs a real store for room state.

### 1.3 Crypto store initialisation

```ts
await client.initRustCrypto({
  useIndexedDB: true,
  cryptoDatabasePrefix: `pa-mx-crypto:${ns}`,   // ns per §2.1
  storageKey: cryptoStorageKey,                 // 32 random bytes, §2.2
});
```

- `storagePassword` is deliberately **not** used: it is a slow passphrase KDF for a passphrase we do
  not have and would have to prompt for on every reload. `storageKey` gives the same at-rest
  encryption with a locally generated key.
- The `storageKey` is *not* a security boundary against an attacker who has the browser profile (they
  have the key too — §8.4). Its real job is **requirement F's failure mode**: the wipe deletes the key
  *before* it deletes the databases, so if a database delete is blocked or errors, what remains on
  disk is an undecryptable blob rather than a readable megolm key store.
- **IndexedDB unavailable** (private mode, storage denied, quota): fall back to
  `initRustCrypto({ useIndexedDB: false })` — **memory-only crypto, never no crypto**. E2EE still works
  for the session; a persistent `.mx-warn` banner in the panel says *"Encryption keys can't be saved on
  this device — you'll be asked to unlock again after a reload."* Disabling crypto instead would make
  encrypted rooms unreadable, which is the outcome this whole change exists to remove.

### 1.4 `device_id` stability

- **Fresh sign-in creates a new device.** `lastDeviceId()` is **no longer passed** to
  `loginWithPassword`. Under E2EE a device id is bound to a crypto identity (ed25519/curve25519); reusing
  an id after the crypto store was wiped produces a device whose keys changed under a stable id —
  other clients render that as a security warning and some refuse to send keys to it. Element creates a
  new device per login for exactly this reason. This is a **behaviour change** from the current code
  and it is required for correctness.
- **Across reloads** the device id is stable: it comes from the persisted `MxSession.deviceId` and the
  crypto store keyed by the same namespace is reopened, so the device identity is unchanged.
- **Soft logout** (`soft_logout: true` on a 401) means *the device is still valid, only the token
  died*. Handled separately from a hard logout: keep the crypto store and `deviceId`, clear only
  `accessToken`, show the login view with the user id prefilled, and on successful re-login pass
  `device_id: session.deviceId` so the existing crypto store is adopted. This is the one place
  `lastDeviceId()` survives.
- **Hard `M_UNKNOWN_TOKEN`** (no `soft_logout`) means the device was deleted server-side. Its crypto
  store is worthless and keeping it is a liability → run the full §2 wipe.

### 1.5 Second tab

IndexedDB is shared across tabs of one origin, and **two rust-crypto machines on one store corrupt it**
(one-time-key accounting and megolm session state are not concurrency-safe across processes).
"Tolerate" is not an option.

**Decision: single-writer election with the Web Locks API.**

- On boot, `navigator.locks.request('pa-mx-crypto:' + ns, { mode: 'exclusive', ifAvailable: true }, …)`.
  The lock is held for the lifetime of the client (the callback returns a promise resolved on
  `destroy()`/sign-out).
- **Lock acquired** → normal boot.
- **Lock not available** → no client is created. The panel shows a dedicated state (reusing the
  existing `login`-view section slot's error area, no new view):
  *"Matrix is already open in another tab of this app. Close the other tab and reload this one."*
  with a `[.pa-b Try again]` button that simply re-attempts the lock.
  **There is deliberately no cross-tab handover.** A `BroadcastChannel` "Use it here" button was
  designed and then cut: it is distributed consensus in miniature (the holder must stop, flush and
  release while the requester polls, with a timeout on both sides and no way to distinguish "the other
  tab is busy" from "the other tab is gone"), and it guards a case — two tabs of the same app, same
  pixel user, same Matrix account — that a one-line instruction resolves. Racy code paths in the one
  component that must not corrupt its store are not worth a saved click.
- **`navigator.locks` missing** (should not happen in Chrome/Firefox/Electron — flag it): boot anyway
  and show a persistent `.mx-warn`: *"Can't detect other tabs on this browser — keep Matrix open in only
  one tab."* Degrading loudly beats refusing to run.
- Two *different* pixel-agents users, or two different Matrix accounts, in two tabs → different `ns`
  → different lock names → both run. Correct by construction.

Accepted consequence, written down so it is not rediscovered as a bug: **the second tab shows no unread
badge and no room list** until it takes over.

### 1.6 Stop / destroy

- `stop()` → `client.stopClient()`, remove listeners, clear timers. Crypto store untouched, lock held.
- `destroy()` → `stop()` + release the Web Lock + `client.getCrypto()` handles are dropped.
  **No storage is deleted** — `destroy()` runs on page unload, and deleting
  crypto on unload would destroy the device on every reload.
- `logout()` → §2.

---

## 2. Storage namespacing and wipe (requirement F)

### 2.1 The namespace

```
ns = fnv1a32hex(`${paUserId || '_'} ${hsOrigin} ${mxUserId}`)     // 8 lowercase hex chars
```

- `paUserId` — `OfficeScene.myUserId`, resolved server-side in `onAuth`, never client-typed. `''`
  (open dev mode) normalises to `_`, exactly as today.
- `hsOrigin` — the **validated, lowercased** `scheme://host[:port]` from `MxSession.hsOrigin`.
- `mxUserId` — `MxSession.userId` (`@user:server`).
- FNV-1a, not SHA-256: this is a namespace, not a secret, and it must be computable synchronously at
  boot. A collision would require two accounts to hash-collide *and* would only mean one refuses to
  open the other's store — which it does anyway, because the crypto store is `storageKey`-encrypted
  and the key is stored under the same `ns` (§2.2). No security property rests on the hash.

### 2.2 The exact keys and databases

| Kind | Name | Contents | Wiped on sign-out |
|---|---|---|---|
| `localStorage` | `pa-mx:<paUserId\|\|'_'>` | `MxSession` JSON (token, deviceId, mxid, hsBaseUrl, hsOrigin, savedAt) | **yes** |
| `localStorage` | `pa-mx-ck:<ns>` | base64 of 32 bytes from `crypto.getRandomValues` — the rust store `storageKey` | **yes, first** |
| `localStorage` | `pa-mx-wipe-pending` | JSON array of database names a previous wipe failed to delete | drained at boot |
| `localStorage` | `pa-mx-nsgen:<paUserId\|\|'_'>` | integer salt, bumped only by the §2.6 "Start fresh" escape hatch | no |
| `localStorage` | `pa-mx-pinned` | `'1'`/`'0'` dock pin — a UI preference, no secret | no |
| `sessionStorage` | `pa-mx-view`, `pa-mx-draft:<roomId>` | last view, unsent composer text | **yes** |
| IndexedDB | `pa-mx-crypto:<ns>::matrix-sdk-crypto` | rust-crypto: olm account, device keys, megolm inbound sessions, cross-signing private keys once unlocked | **yes** |
| IndexedDB | `pa-mx-crypto:<ns>::matrix-sdk-crypto-meta` | rust-crypto store metadata / cipher parameters | **yes** |

**A-6 is no longer an assumption — it is confirmed by the SDK's own source.** `MatrixClient.clearStores`
(`lib/client.js:715`) hardcodes exactly these two names:

```js
for (const dbname of [`${args.cryptoDatabasePrefix ?? RUST_SDK_STORE_PREFIX}::matrix-sdk-crypto`,
                      `${args.cryptoDatabasePrefix ?? RUST_SDK_STORE_PREFIX}::matrix-sdk-crypto-meta`])
```

### 2.3 The database names are derived, not discovered

An earlier draft snapshotted `indexedDB.databases()` before and after `initRustCrypto` and recorded
"every name that is new **or** prefixed" into a `pa-mx-dbs:<ns>` list that the wipe then deleted.
**That mechanism is deleted.** Two reasons, both decisive:

1. **It could delete unrelated application data.** `initRustCrypto` is an `await` spanning a 7.8 MB wasm
   fetch — a window seconds wide. Any database created by another part of this app in that window
   (EmulatorJS and js-dos both persist saves in IndexedDB) would be recorded as "new" and destroyed on
   Matrix sign-out. A crypto sign-out silently wiping someone's arcade saves is a worse bug than the one
   the recorder was guarding against. `IndexedDBCryptoStore.containsData()`'s transient
   `matrix-js-sdk:crypto` probe database (`lib/indexeddb-helpers.js:25`) would land in the list too.
2. **It was solving a problem that does not exist.** The suffixes are hardcoded in the SDK (above), so
   the derived names are correct by construction, not by guess.

The wipe therefore deletes exactly `pa-mx-crypto:<ns>::matrix-sdk-crypto` and
`pa-mx-crypto:<ns>::matrix-sdk-crypto-meta`. Deleting a database that does not exist is a no-op.
As a belt-and-braces pass **only**, if `indexedDB.databases` exists (Chrome/Electron; Firefox does not
have it) the wipe additionally deletes any database whose name `startsWith('pa-mx-crypto:' + ns)` —
a filter that cannot match anything this app did not create. There is no "is new" clause and no
recorded list, which also removes the Firefox asymmetry the recorder introduced.

### 2.4 Sign-out sequence (numbered, testable)

`handleSignOut()` → `store.logout()` runs exactly this. Every step is individually observable.

1. Set `wiping = true`; disable the whole panel body (the existing `login`/`rooms` sections are hidden
   behind a "Signing out…" state). No further store method may start work.
2. `client.stopClient()` — stops `/sync` and the scheduler.
3. Best-effort `await client.logout(true)` with a **5 s timeout**; failures are logged to the panel's
   toast but **never abort the wipe**. (This is what invalidates the access token and deletes the
   device server-side; skipping it would leave a live credential behind. It is skipped entirely when
   the reason is `M_UNKNOWN_TOKEN` — the token is already dead.)
4. `localStorage.removeItem('pa-mx-ck:' + ns)` — **the storage key dies first.** After this line, any
   database that survives the rest of the sequence is undecryptable.
5. `await client.clearStores({ cryptoDatabasePrefix: 'pa-mx-crypto:' + ns })` — best effort, wrapped in
   try/catch. **The argument is load-bearing:** called bare, `clearStores` defaults the prefix to
   `RUST_SDK_STORE_PREFIX` (`"matrix-js-sdk"`) and would delete two databases this design never creates
   while leaving ours untouched — i.e. it would do nothing at all. With the prefix it performs the real
   deletion, using the SDK's own blocked/error handling, and steps 7–8 become a verification pass rather
   than the sole mechanism. (Note it throws if `clientRunning`, hence step 2 first.)
6. `localStorage.removeItem('pa-mx:' + paUserId)`; remove `pa-mx-view` and every `pa-mx-draft:*` from
   `sessionStorage`.
7. For each of the two derived database names (plus any `pa-mx-crypto:<ns>`-prefixed name found via
   `indexedDB.databases()` where that API exists — §2.3): issue `indexedDB.deleteDatabase(name)` and
   await `success` | `error` | `blocked`, each with a 3 s timeout.
8. Collect failures (`error`, `blocked`, or timeout). If the set is empty, continue.
9. **If the set is non-empty:** write it to `localStorage['pa-mx-wipe-pending']`, and show a
   **persistent, non-dismissable** `.mx-warn` banner in the panel:
   *"Some encryption data could not be deleted from this browser. Close other tabs of this app and
   reload."* Never silently succeed. The banner survives view changes and is only cleared when a
   subsequent drain (§2.6) succeeds.
10. Drop all in-memory state (rooms, timelines, member caches, the 4S key cache §8.1, directory
    results), release the Web Lock, emit `loggedOut { expired:false }`, unpin the dock, clear the unread
    badge, and route to the `login` view.

### 2.5 What "blocked" means and what we do about it

`deleteDatabase` fires `blocked` when another connection to that database is still open. Two sources:

- **Our own client** — eliminated by steps 2 and 5 running first. If it still blocks, the 3 s timeout
  takes us to step 9 rather than hanging the UI.
- **Another tab** — should be impossible: we hold the exclusive Web Lock for this `ns` (§1.5), and a
  tab without the lock never opens the store. If the lock is unavailable (no `navigator.locks`), this
  is the realistic failure and step 9's banner is the honest answer.

### 2.6 Drain at boot

Before **any** client is created, `client.ts` reads `pa-mx-wipe-pending`, retries those deletes with
the same timeout, and removes the entries that succeed. If any remain, the panel boots with the §2.4/9
banner still shown. A namespace with a pending wipe is **never reused for a new client** — if the
pending list intersects the namespace we are about to open, boot is refused with
*"Sign-out did not finish on this browser. Reload with other tabs of this app closed."*

**The refusal must not be a soft-brick, so it ships with an escape hatch.** The undeletable database is
already undecryptable (step 4 killed its storage key first), so refusing to reuse it protects nothing
once the delete has failed twice; and if the browser never fires `success` on that delete — a stale
connection, a quota-locked profile — the user's only other recourse would be DevTools. The refusal
screen therefore carries `[.pa-b.primary Start fresh]`, which increments
`localStorage['pa-mx-nsgen:<paUserId>']` and boots against a namespace derived with the new salt
(§2.1). The husk is left on disk, still listed in `pa-mx-wipe-pending` so later drains keep retrying it,
and still unreadable. The button's copy states this plainly: *"Start fresh — this device gets new
encryption keys. Old messages need your recovery key or an exported key file."*

### 2.7 Pixel-agents logout / user switch

**What is delivered.** Requirement F's own words are *"Storage must be namespaced per (pixel-agents
userId, homeserver, matrix userId) and wiped on sign-out."* Both halves are delivered literally: §2.1 is
the namespace, §2.4 is the wipe. A pixel-agents user switch leaves the previous user's crypto database
on disk, and the next pixel user's `ns` differs, so the app will never open it and — without
`pa-mx-ck:<ns>`, keyed by the same namespace — could not decrypt it if it did.

**What is deliberately NOT delivered, and why.** A stricter reading ("wipe the previous pixel user's
Matrix namespace whenever a different `paUserId` authenticates") was considered and **rejected**. That
crypto store is not incidental cache: it *is* that person's Matrix device — its olm identity, its megolm
inbound sessions, and possibly the only copy of keys for history they have not backed up. Destroying it
because a colleague logged into pixel-agents on the same laptop would silently and irrecoverably remove
a Matrix device its owner never signed out of, with no prompt and no undo. Losing someone's message
history without asking is a worse outcome than retaining a store the app refuses to open.

The honest boundary, stated rather than implied: **namespacing is an application-level separation, not a
security boundary against someone who holds the browser profile.** §8.4 says exactly what such an
attacker gets, and the answer does not change with or without the switch-time wipe. The real mitigation
is Matrix sign-out (§2.4), which is one click in the Encryption view and which the sign-out dialog
explains. To make that reachable rather than theoretical, the Encryption view's DEVICE group names the
pixel-agents account the local crypto store belongs to, so a shared machine shows whose device it is.

---

## 3. The seam

### 3.1 What survives verbatim

**Every type the UI imports, and the entire `MatrixStore` method/event contract.** Specifically, from
recon A: `MxEvent`, `MxRoom`, `MxMember`, `MxDirectoryUser`, `MxSession`, `MxStatus`, `MxLoginFlows`,
`MatrixError`, and all of `MatrixStore`'s §4a–§4h surface —
`on()`/`status`/`statusLabel`/`userId`/`start`/`stop`/`destroy`/`rooms`/`room`/`totalUnread`/
`displayName`/`existingDmWith`/`timeline`/`atStart`/`loadingTimeline`/`timelineError`/`openRoom`/
`closeRoom`/`paginate`/`markRead`/`send`/`retrySend`/`members`/`invite`/`leave`/`acceptInvite`/
`declineInvite`/`createDm`/`createGroup`/`joinRoom`/`searchUsers`/`logout`.

`session.ts` survives almost intact: `normaliseHomeserverUrl`, `discoverHomeserver`, `probeLoginFlows`,
`loginWithPassword`, `loadSession`, `saveSession`, `clearSession`, `describeError` keep their exact
signatures. **Login and discovery stay plain `fetch`** — they are ~60 already-correct lines, they carry
no crypto, and keeping them means the token-bearing URL validation (§8.2) stays first-party and
auditable, which is what AGENTS rule 10 wants.

### 3.2 What changes shape, and why

| Change | Why | UI diff |
|---|---|---|
| `MatrixApi` class deleted; `MatrixStoreOpts` becomes `{ session: MxSession }` | The SDK owns the HTTP layer. `MatrixUI` only ever passed `api` through to the store constructor and nulled it. | delete 3 lines + the `api` field |
| `import { MatrixStore } from './sync.js'` → `'./store.js'` | file rename | 1 line |
| `MxEvent` gains `decryptError?: MxDecryptError` and `decrypting?: true` | undecryptable events must render a *typed reason*, not a fixed string, and an event mid-decryption must render "Decrypting…" rather than a blank row (§4.3) | `timeline.ts` only |
| `MxRoom.heroes` **deleted** | `Room.getSummary()` does not exist in the SDK (there is a `summary` field whose `RoomSummary` class exposes only `roomId` — no heroes), and recon A confirmed nothing in `MatrixUI.ts`/`timeline.ts` reads `heroes`. The heroes calculation survives inside `room.name`, which is where the UI actually consumes it. | none |
| new `client/src/matrix/sdk.ts` re-export shim | the crypto layer needs deep imports (§1.1); confining them to one file bounds the blast radius if upstream adds an `exports` map, and aliases the SDK's own `MatrixError` away from ours | none |
| `PA_GAP_TYPE`, `buildGap()` and the gap branches **deleted** | The SDK stitches `/sync` gaps internally via its own pagination; we never synthesize a gap event again. Unreachable branches in a renderer are a maintenance trap. | −~25 lines in `timeline.ts`, −1 const in `types.ts` |
| `TimelineRenderOpts.encrypted: boolean` → `warning: string \| null` | The top-of-timeline notice is no longer "we can't read this room" (we can). It becomes a generic slot used for *"Encryption keys can't be saved on this device"* and *"Unlock encryption to read older messages"*. | ~10 lines |
| `statusLabel` for `'reconnecting'` loses its live countdown | The SDK owns the retry schedule and does not publish the next-attempt time. `retryNow()` maps to `client.retryImmediately()`. | none (it is just a string); the store no longer needs a 1 Hz `status` tick |
| `searchUsers(term, signal)` keeps its signature but the signal only **discards** the result | `client.searchUserDirectory()` takes no `AbortSignal`. Debounce + generation counter preserve the behaviour the UI depends on. | none |
| The `m.direct` read-modify-write reads `client.getAccountData('m.direct')` instead of a fresh `GET` | The SDK keeps account data live from `/sync`; its cached copy *is* the fresh copy, and the old doc's "never trust the sync copy" was a workaround for a filter that could truncate it. | none |
| Wire types (`MxSyncResponse`, `MxTimelineBlock`, `MxJoinedRoom`, `MxInvitedRoom`, `MxMessagesResponse`) deleted from `types.ts` | nothing imports them once `api.ts`/`sync.ts` die | none |

**Verdict on the UI:** the change is **superficial-to-moderate and additive**. The seven views, the
router, the room list, the timeline grouping/day-separators/local-echo vocabulary, the composer, the
pin and the dock all survive. The only genuinely new UI is the Encryption view, and it lives in its own
file (§5). Estimated diff: `MatrixUI.ts` ~120 lines, `timeline.ts` ~60 lines, `matrixSkin.ts` ~35 lines.

### 3.3 How each contract member is implemented over the SDK

**Events.** One coalescing emitter (microtask-batched, as today):

| Our event | SDK sources |
|---|---|
| `status` | `ClientEvent.Sync`, mapped over the **whole** `SyncState` enum (`Prepared`/`Syncing`→`connected`; before the first `Prepared`→`syncing`; `Reconnecting`/`Catchup`/`Error`→`reconnecting`; `Stopped`→ **keep the previous status** unless our own `logout()` set a `signingOut` flag, in which case `signedout`), plus `window` `online`/`offline` → `offline` |
| `rooms` | `ClientEvent.Sync`, `ClientEvent.Room`, `ClientEvent.DeleteRoom`, `RoomEvent.Name`, `RoomEvent.MyMembership`, `RoomEvent.UnreadNotifications`, `RoomEvent.Timeline`, `RoomStateEvent.Update` (for `m.room.encryption`), `ClientEvent.AccountData` (`m.direct`) |
| `timeline` (roomId) | `RoomEvent.Timeline`, `RoomEvent.TimelineReset`, `RoomEvent.LocalEchoUpdated`, `RoomEvent.Redaction`, `MatrixEventEvent.Decrypted` (subscribed per event, or via the client-level re-emit, since it fires on the `MatrixEvent`) |
| `loggedOut` | `HttpApiEvent.SessionLoggedOut` → `{ expired: true }`; our own `logout()` → `{ expired: false }` |

**Rooms.** `MxRoom` is projected from `sdk.Room` on demand and memoised per emit:
`name` ← `room.name` (the SDK implements the spec's heroes calculation, so `roomDisplayName` dies);
`membership` ← `room.getMyMembership()`; `encrypted` ← `room.hasEncryptionStateEvent()`;
`joinedCount`/`invitedCount` ← `room.getJoinedMemberCount()` / `getInvitedMemberCount()`;
`unread`/`highlight` ← `room.getUnreadNotificationCount(Total|Highlight)`;
`lastTs` ← last live-timeline event ts; `preview` ← §4.4; `isDirect` ← `m.direct` map;
`inviterId` ← sender of our invite `m.room.member`. **There is no `heroes` field** — `getSummary()` does
not exist on `Room`, and the heroes calculation is already inside `room.name`.
Sort order (unread first, then `lastTs` desc, `lastTs===0` last by roomId) is reimplemented unchanged.

**Timeline.** Live timeline only — no `TimelineWindow`, no permalinks.
`timeline(roomId)` = `room.getLiveTimeline().getEvents()` **plus** `room.getPendingEvents()` (which
requires `pendingEventOrdering: Detached`, §1.1), filtered to renderable events and mapped to `MxEvent`.
"Renderable" is decided by the §4.3 predicate order, **never** by `getType()` alone. `atStart(roomId)` = the live timeline has no backward
pagination token. `paginate(roomId)` = `client.paginateEventTimeline(liveTimeline, { backwards: true, limit: 30 })`,
setting/clearing the per-room loading flag and emitting `timeline` at both ends (as today).
`timelineError(roomId)` is set from a normalised `MatrixError`.

**Send / echo.** `client.sendTextMessage(roomId, body)` — it encrypts automatically in encrypted rooms.
Mapping to the existing echo vocabulary:

`EventStatus` has **six** members (`lib/models/event-status.d.ts`), and `null` is the *absence* of a
status, not a member. All six must be handled, as an exhaustive `switch` over the enum so that a future
member is a type error rather than a row that silently matches nothing:

| SDK `event.status` | our `MxEvent` |
|---|---|
| `QUEUED` / `SENDING` / `ENCRYPTING` / **`SENT`** | `echo: 'pending'`, `txnId: ev.getTxnId()` |
| `NOT_SENT` | `echo: 'failed'`, `txnId: ev.getTxnId()` |
| **`CANCELLED`** | drop the row entirely |
| `null` (confirmed) | no `echo`, no `txnId`, real `event_id` |

`SENT` means *"sent to the server, but we have not yet received the echo"* — it is still a pending local
echo. Omitting it (as an earlier draft did) leaves that event matching neither branch, so
`timeline.ts`'s row-key resolution would flip its key mid-flight and duplicate the row.

`retrySend(roomId, txnId)` finds the event in `room.getPendingEvents()` by `getTxnId()` and calls
`client.resendEvent(ev, room)`. Neither method rejects to the caller (matching the current contract);
failures surface as the `.failed` row. `unsigned.transaction_id` is passed through when present so
`timeline.ts`'s three-step row-key resolution keeps working unchanged.

**Everything else.** `members` → `room.getMembersWithMembership('join'|'invite')` (falling back to
`client.members()` when lazy-loading has not yet populated them, and calling
`room.loadMembersIfNeeded()` first — an invite must appear immediately, which is why `/joined_members`
was rejected in the old doc and stays rejected); `invite` → `client.invite`; `leave`/`declineInvite`
→ `client.leave`; `acceptInvite` → `client.joinRoom(roomId)` + the `m.direct` merge when our invite
member event had `is_direct`; `createDm` → `client.createRoom({ is_direct:true, preset:'trusted_private_chat',
invite:[mxid] })` + `m.direct` merge; `createGroup` → `client.createRoom` with the same presets as today;
`joinRoom` → `client.joinRoom(idOrAlias, { viaServers })`; `searchUsers` → `client.searchUserDirectory`;
`markRead` → debounced 1 s `client.sendReadReceipt(lastEvent)` + `client.setRoomReadMarkers`;
`displayName` → `room.getMember(userId)?.name ?? userId`.

**Error normalisation is mandatory at the store boundary.** Every public store method wraps its
rejection in `MatrixError.from(e)`, which maps `sdk.MatrixError` (`errcode`, `httpStatus`,
`data.retry_after_ms`, `data.soft_logout`) and `sdk.ConnectionError` (→ `status: 0`) onto our class.
Without this, `MatrixUI.joinErrText`'s `e instanceof MatrixError` check silently stops matching and
every join error degrades to the generic string. `describeError` gains the same normalisation call at
its head so it keeps producing the exact message quality recon A catalogued.

### 3.4 File plan

**Deleted**

| File | Reason |
|---|---|
| `client/src/matrix/api.ts` | the SDK is the HTTP layer |
| `client/src/matrix/sync.ts` | replaced by `store.ts` |

**New**

| File | Responsibility | ~LoC |
|---|---|---|
| `client/src/matrix/sessionProbe.ts` | `storageKey(paUserId)`, `hasMatrixSession(paUserId)`, `cryptoNamespace(...)`. **Zero imports.** The one module outside `index.ts` that may be *statically* imported from the host (§6.5). | 40 |
| `client/src/matrix/sdk.ts` | the ONLY file that imports `matrix-js-sdk` deep paths; re-exports the crypto-api symbols and aliases the SDK's `MatrixError` → `SdkMatrixError` (§1.1) | 30 |
| `client/src/matrix/storage.ts` | namespace derivation (incl. the `pa-mx-nsgen` salt), the `storageKey` generate/load/delete, and the §2.4 wipe + §2.6 drain | 170 |
| `client/src/matrix/client.ts` | `createClient`, Web-Lock election, `initRustCrypto` (+ memory fallback), `startClient`, stop/destroy | 260 |
| `client/src/matrix/store.ts` | `MatrixStore` over the SDK — the whole §3.3 mapping. **No DOM.** | 620 |
| `client/src/matrix/crypto.ts` | `CryptoApi` facade: device info + fingerprint, device list, 4S state machine, `getSecretStorageKey` broker, bootstrap/unlock, key backup, `importRoomKeys`/`exportRoomKeys`. **No DOM.** | 380 |
| `client/src/matrix/keyfile.ts` | Element `MEGOLM SESSION DATA` envelope: encrypt/decrypt with WebCrypto (§5.3). **No DOM, no SDK.** | 170 |
| `client/src/matrix/EncryptionUI.ts` | the new `encryption` view section (§5) | 520 |

**Edited**

| File | Edit |
|---|---|
| `client/src/matrix/types.ts` | drop wire types + `PA_GAP_TYPE` + `MxRoom.heroes`; add `MxDecryptError`, `MxDeviceInfo`, `MxCryptoState`, `MxKeyImportResult`; add `MatrixError.from()`; `MxEvent` gains `decryptError?` and `decrypting?` |
| `client/src/matrix/session.ts` | re-export `hasMatrixSession`/`storageKey` from `sessionProbe.ts`; stop passing `lastDeviceId()` on fresh login (kept for soft-logout re-login); `describeError` normalises SDK errors first |
| `client/src/matrix/MatrixUI.ts` | `ViewName` += `'encryption'`; mount `EncryptionUI` as that section; a 🔐 status-strip button (with an attention dot); route case; `pushRootView` union; un-gate the composer (§4.5); lock badge/banner copy (§4.6); route to `encryption` on a `secretRequest`; show Retry for `'offline'`; delete the `api` field |
| `client/src/matrix/timeline.ts` | render `decryptError` (§4.3); `opts.encrypted` → `opts.warning`; delete the gap code |
| `client/src/matrix/matrixSkin.ts` | **add** `.mx-utd`, `.mx-utd.working`, `.mx-utd .act`, `.mx-warn`, `.mx-chip`/`.mx-chip.ok`/`.mx-chip.warn`, `.mx-keyrow`, `.mx-btns`, `.mx-hint`, `.mx-fp`. **Reuse, do not redefine:** `.mx-err`, `.mx-notice`, `.mx-link`, `.mx-msg.enc` (renamed `.mx-utd`) already exist here, and `.grouplbl`, `.pa-input`, `.pa-b`, `.pa-list-row`, `.muted` come from `client/src/ui/paSkin.ts` / the `OfficeScene.ts` CSS block. Redefining any of them would drift the tokens. |
| `client/src/matrix/index.ts` | unchanged public surface; internal wiring only |
| `client/src/scenes/OfficeScene.ts` | **only** the `session.js` import fix (§6.5) |
| `client/package.json` | `+ "matrix-js-sdk": "^42.1.0"` |

**Untouched:** `server/**`, `desktop/**`, `shared/**`, `client/vite.config.ts`, `pnpm-workspace.yaml`,
`client/src/ui/paSkin.ts`, `client/index.html`.

---

## 4. E2EE behaviour

### 4.1 Sending

Nothing special. `client.sendTextMessage` consults `room.hasEncryptionStateEvent()` and encrypts. The
composer's `if (room?.encrypted) return;` guard is **deleted**. The only remaining reason to disable the
composer is `cryptoState === 'unavailable'` (crypto failed to initialise at all), in which case the
disabled notice reads *"Encryption isn't available in this browser session — reload to try again."*

`globalBlacklistUnverifiedDevices = false` (§1.1 step 4) means we encrypt **to unverified devices too**.
This is the correct default for a client whose users have not all cross-signed: the alternative silently
fails to deliver to most recipients. It is the same choice Element ships.

### 4.2 Receiving and the late-key path

The SDK decrypts on receipt. Our store listens for `MatrixEventEvent.Decrypted` on every room and
re-emits `timeline(roomId)`. Because keys can arrive **after** the event:

- a to-device `m.room_key` arriving later, or
- a key restored from server-side backup, or
- keys imported from a file or from 4S,

the SDK **automatically re-attempts decryption** of the failed events it is holding and fires
`Decrypted` again. Our re-emit turns that into a re-render, and the UTD row becomes a real message with
no user action. This is the retry-after-key-arrives path and it needs no button.

There is therefore **no "retry decryption" button** — a UTD is never fixed by retrying, only by
acquiring the key. The affordance on a UTD row is an action that can actually acquire one (§4.3).

### 4.3 Decryption-failure taxonomy

**Dispatch on the predicates, never on `getType()`.** This is the single most important rule in this
section, because the SDK's default rendering path is actively wrong for us. On a decryption failure,
`MatrixEvent.setClearDataForDecryptionFailure` (`lib/models/event.js:812`) installs a synthetic clear
event:

```js
this.clearEvent = { type: EventType.RoomMessage,
  content: { msgtype: "m.bad.encrypted", body: `** Unable to decrypt: ${reason} **` } };
```

and `getType()` returns the *clear* type when one is set. So a UTD event reports
`getType() === 'm.room.message'` and would sail through a type-based filter, with
`** Unable to decrypt: DecryptionError: … **` — a raw JS error string — landing in a chat bubble.
Conversely an event still being decrypted has **no** `clearEvent`, so `getType()` is
`'m.room.encrypted'` and `getContent()` has no `body` at all, which a naive body read renders as an
empty row on every fresh sync of an encrypted room.

The store therefore classifies each event in this exact order, using
`isEncrypted()` / `isBeingDecrypted()` / `isDecryptionFailure()` (`lib/models/event.d.ts:539/476/486`):

1. `ev.isBeingDecrypted()` → `MxEvent { type: 'm.room.encrypted', decrypting: true }` → renders
   **`🔒 Decrypting…`** (`.mx-utd.working`). A third rendered state, and the one an earlier draft
   omitted entirely.
2. `ev.isDecryptionFailure()` → `MxEvent { type: 'm.room.encrypted', decryptError: {...} }` from the
   table below. `getContent().body` is **never** read for these events.
3. otherwise → a normal message. As a belt-and-braces guard the store also drops any content whose
   `msgtype === 'm.bad.encrypted'` into branch 2 with the generic reason, so the SDK's internal string
   can never reach the DOM even if a future SDK version changes which predicate fires.

`MxEvent.decryptError = { code: string; text: string; action?: 'unlock' | 'verify' | null }`, produced
from `ev.decryptionFailureReason`. `timeline.ts` renders it on the existing `.mx-msg.enc` row (renamed
`.mx-utd`), keeping the sender, avatar and timestamp — those are cleartext and true — and rendering
`text` in the body plus, when `action` is set, an inline `.act` link.

**A-7 is resolved: the member names below are the real enum**, read from
`lib/crypto-api/index.d.ts:631`. Two names in an earlier draft (`OLM_DECRYPTION_ERROR`,
`UNKNOWN_ENCRYPTION_ALGORITHM`) do not exist, and because `DecryptionFailureCode` is a *string* enum
they would have compiled as harmless string literals that simply never matched. Import the enum through
`sdk.ts` and compare **members, not literals**, so a future rename is a build failure.

| `DecryptionFailureCode` member | Rendered text | Action |
|---|---|---|
| `MEGOLM_UNKNOWN_INBOUND_SESSION_ID` | 🔒 Waiting for this message's key… | `unlock` → Encryption view |
| `OLM_UNKNOWN_MESSAGE_INDEX` | 🔒 Sent to this room before this point — your key doesn't cover it. | `unlock` |
| `HISTORICAL_MESSAGE_BACKUP_UNCONFIGURED` | 🔒 Sent before you signed in on this device, and you have no key backup. | `unlock` |
| `HISTORICAL_MESSAGE_NO_KEY_BACKUP` | 🔒 Sent before you signed in on this device — not in your key backup. | `unlock` |
| `HISTORICAL_MESSAGE_WORKING_BACKUP` | 🔒 Fetching this message's key from your backup… | — |
| `HISTORICAL_MESSAGE_USER_NOT_JOINED` | 🔒 Sent before you joined this room. | — |
| `MEGOLM_KEY_WITHHELD` | 🔒 The sender chose not to share this message's key. | — |
| `MEGOLM_KEY_WITHHELD_FOR_UNVERIFIED_DEVICE` | 🔒 The sender only shares keys with verified devices. | `verify` → Encryption view |
| `SENDER_IDENTITY_PREVIOUSLY_VERIFIED` | 🔒 The sender's identity changed — this message can't be trusted. | — |
| `UNSIGNED_SENDER_DEVICE` / `UNKNOWN_SENDER_DEVICE` | 🔒 Can't confirm which device sent this. | — |
| `UNKNOWN_ERROR` / anything unmapped / `null` reason | 🔒 Couldn't decrypt this message. | — |

`OLM_UNKNOWN_MESSAGE_INDEX` is the everyday "you were invited part-way through a conversation" failure
and is the most common code in practice — leaving it unmapped would degrade the most frequent case to
the generic row. Unmapped codes fall through to the last row with the raw code in `title=` (never in the
body). A row is **never** blank and the event is **never** filtered out.

### 4.4 Room-list preview

`preview` for the last event, classified by the same §4.3 predicate order (never by `getType()`, never
from a `m.bad.encrypted` body): decrypted → its `body`; UTD → `🔒 Encrypted message` (honest — we
genuinely cannot read it *yet*); mid-decryption on a fresh sync → the same. It flips to the real text on
the next `Decrypted` emit.

### 4.5 Room encryption state — detection and display

- Detection: `room.hasEncryptionStateEvent()`, recomputed on `RoomStateEvent.Update`.
- Room-list row: keeps the `🔒` marker, `title` changes to **"End-to-end encrypted"** (the "not readable
  in this client" copy is a lie now and must go). When the room is encrypted **and** `cryptoState` is
  `'locked'` or `'unavailable'`, the marker gains a `.warn` tint and the title says
  *"End-to-end encrypted — this device can't read it yet"*.
- Room header: `🔒` icon with the same rules.
- Room banner (`.mx-notice`): **only** shown when the room is encrypted and something is wrong —
  `'locked'` → *"Unlock encryption to read older messages."* + a link to the Encryption view;
  `'unavailable'` → *"Encryption isn't available in this browser session."* In the normal case there is
  **no banner** (a permanent "this is encrypted" banner is noise; the lock icon carries it).
- Timeline top notice: fed by the same string via `opts.warning`.

### 4.6 Enabling encryption mid-session

`m.room.encryption` arrives in `timeline`/`state`; `RoomStateEvent.Update` fires; `encrypted` flips
true; `rooms` and `timeline` are emitted; the composer **stays enabled** and the next send is encrypted.
A one-shot `.mx-notice` appears for that room: *"This room is now end-to-end encrypted."* We never
enable encryption ourselves and there is no UI to do so (§9).

### 4.7 The two hard rules

1. **Never claim readable when it is not, and never render a blank row.** Every path that can produce an
   unreadable event produces either `decrypting: true` ("🔒 Decrypting…") or a `decryptError` with a
   reason. The two ways an earlier draft violated this were both SDK-shaped and both are closed in §4.3:
   an in-flight decryption has no `body` (→ blank), and a failed one has the SDK's raw
   `** Unable to decrypt: … **` string as its `body` (→ a lie dressed as a message).
2. **Never silently drop.** Non-renderable *state* events (membership, topic, power levels) are filtered
   as they are today — that is not "dropping a message". Every `m.room.message` and every
   `m.room.encrypted` reaches the renderer.

---

## 5. Key management UX — the `encryption` view

### 5.1 Placement and routing

- `ViewName` gains `'encryption'`. It is a root-level push, exactly like `newdm`/`newgroup`/`join`:
  `pushRootView('encryption')` sets the stack to `[{view:'rooms'},{view:'encryption'}]`. `◀` and Escape
  return to `rooms`. The existing `persistView`/`restoreView` `sessionStorage` round-trip covers it for
  free.
- **Reached from three places:**
  1. a **🔐 button** in the status strip, between `📌` and `⎋`, `class="pa-b"`,
     `aria-label="Encryption"`. It carries an attention dot (`::after`, `#c51a1b`) whenever
     `cryptoState !== 'ready'` or this device is not cross-signed;
  2. the `.act` link on a UTD row (§4.3);
  3. the `.mx-notice` link in a locked encrypted room (§4.5).
- The view is one scrolling `.pa-body`-style column of `grouplbl` groups, in the order below. All
  chrome is `.pa-*`; the file-picker rows deliberately mirror `MumbleSettingsUI`'s certificate row
  (readonly field + a two-button `.mx-btns` row + a paired passphrase field + a one-line `.mx-hint`),
  restyled onto `.pa-input`/`.pa-b` instead of Mumble's private `#pa-mumble-cfg` CSS.

### 5.2 `cryptoState` — the single state machine

`crypto.ts` exposes one enum that every part of the view (and §4.5) keys off:

| State | Meaning | What the view shows |
|---|---|---|
| `unavailable` | `initRustCrypto` failed even in memory mode | red banner; everything else disabled |
| `memory-only` | crypto works, IndexedDB refused | warn banner; the rest fully usable |
| `never-set-up` | `secretStorage.getDefaultKeyId()` is `null` — the **account** has no 4S | RECOVERY shows "Set up recovery" |
| `locked` | 4S exists; this device does not have the key | RECOVERY shows the unlock field |
| `unlocking` | a key was submitted and is being checked | Unlock button → "Checking…", disabled |
| `wrong-key` | `checkKey` returned false | inline `.mx-err`, field cleared and refocused |
| `ready` | 4S unlocked (or freshly bootstrapped); cross-signing usable | RECOVERY shows "set up and unlocked" |

`import-running` and `import-partial` are *local to the import row*, not global (§5.3).

### 5.3 C1 — Element room-key file import / export

**Why hand-rolled:** recon B proved `matrix-js-sdk@42.1.0` exports **no** `encryptMegolmKeyFile` /
`decryptMegolmKeyFile` / `MEGOLM_KEY_FILE`; that codec lives in the app layer (matrix-react-sdk). We
therefore implement the documented Matrix "key export" envelope in `keyfile.ts` on WebCrypto.

**Envelope (must be byte-compatible with Element, both directions):**

```
-----BEGIN MEGOLM SESSION DATA-----
<base64, wrapped at 64 columns, of:
   version : 1 byte  = 0x01
   salt    : 16 bytes
   iv      : 16 bytes
   rounds  : 4 bytes, big-endian uint32
   ciphertext : AES-256-CTR(plaintext)
   hmac    : 32 bytes, HMAC-SHA-256 over version||salt||iv||rounds||ciphertext >
-----END MEGOLM SESSION DATA-----
```

- KDF: `PBKDF2(passphrase, salt, rounds, SHA-512) -> 64 bytes`; bytes `0..31` = AES-256 key,
  bytes `32..63` = HMAC-SHA-256 key. Default `rounds = 500000` on export.
- AES-CTR with `counter = iv`, `length = 64`. **On export the top bit of `iv[8]` is cleared**, matching
  Element, so the 64-bit counter cannot overflow into the nonce half.
- Parser: strip all whitespace between the header/footer lines; reject a missing/short body; verify the
  HMAC **before** decrypting and before parsing any JSON.
- Plaintext is exactly what `crypto.exportRoomKeysAsJson()` returns / what
  `crypto.importRoomKeysAsJson()` accepts — a JSON array of `IMegolmSessionData`.

**Import row (mirrors MumbleSettingsUI's certificate row):**

```
[grouplbl] ROOM KEY FILE
[label "Key file"]  [.pa-input readonly  placeholder "(none selected)"]
[.mx-btns]          [.pa-b Choose file…] [.pa-b Clear]
[label "Passphrase"][.pa-input type=password autocomplete="new-password" maxlength=256]
[.pa-b.primary.wide  Import keys]
[.mx-hint] Use the file Element exports with Settings → Encryption → Export room keys.
[.mx-err] / [.muted result line]
```

- **`<input type="file" accept=".txt,text/plain" hidden>` read into memory in BOTH environments** —
  `.click()`ed by the "Choose file…" button, `file.text()` into a string. This is the deliberate
  divergence from Mumble: `pickCertFile()` is an Electron native dialog that returns a *path* stored in
  `userData/mumble.json`, which has no browser equivalent and no meaning here (there is nothing to
  persist — the file is consumed once). `<input type="file">` behaves identically in Chrome, Firefox and
  the Electron renderer. We mirror Mumble's **look**, not its mechanism.
- The readonly field shows `name (12.4 kB)` — never the contents. **Clear** blanks both the field and
  the passphrase (Mumble's "clearing the artifact drops its passphrase" idiom).
- Reject files > 32 MB up front with *"That file is too large to be a key export."*
- Flow: `keyfile.decrypt(text, passphrase)` → JSON string →
  `crypto.importRoomKeysAsJson(json, { progressCallback })`.
- **Progress:** `ImportRoomKeyProgressData` is a **discriminated union**, not a flat record
  (`lib/crypto-api/index.d.ts:852-906`). The `Fetch` variant carries **only** `{ stage }` — no
  `successes`/`failures`/`total` — so destructuring all four unconditionally yields `NaN%`. Switch on
  `stage` (`ImportRoomKeyStage.Fetch` | `ImportRoomKeyStage.LoadKeys`, imported through `sdk.ts`):
  `Fetch` → the indeterminate label `Importing…`; `LoadKeys` → `Importing… 42%` from
  `successes+failures` over `total`. The whole group is disabled meanwhile (`import-running`).
- **Result:** `importRoomKeysAsJson()` resolves to `void` — it returns no counts. The result line is
  built from the **last `LoadKeys` payload seen**, which the row stashes as it arrives: *"Imported 412
  keys."* or, when `failures > 0` (`import-partial`), *"Imported 409 of 412 keys — 3 could not be read."*
  If no `LoadKeys` tick ever arrived, say *"Imported keys."* and nothing more. Never rounded, never
  "done", and never a fabricated count.
- **Errors:** HMAC mismatch → *"That passphrase didn't open the file."*; missing/!== header → *"That
  doesn't look like an Element room-key export."*; valid but empty array → *"The file contained no
  keys."*; anything else → `describeError`.
- After a successful import the SDK re-attempts decryption of held UTD events; our `Decrypted` listener
  repaints the affected rooms. The result line adds *"Older messages should now be readable."*

**Export row:**

```
[label "Passphrase"] [.pa-input type=password]
[label "Confirm"]    [.pa-input type=password]
[.pa-b.wide  Export room keys]
[.mx-warn] Anyone with this file and its passphrase can read your encrypted messages.
```

- Validate: non-empty, ≥ 8 characters, both fields equal. Errors inline; nothing leaves the page until
  they pass.
- `crypto.exportRoomKeysAsJson()` → `keyfile.encrypt(json, passphrase)` → `Blob([text], {type:'text/plain'})`
  → `URL.createObjectURL` → a transient `<a download>` clicked programmatically →
  `URL.revokeObjectURL` in a `setTimeout(…, 0)`. **No Node `fs`, no Electron dialog** — `<a download>`
  works in Chrome, Firefox and the Electron renderer (the shell's default download handling applies).
- Filename: `pixel-agents-matrix-keys-<localpart>-YYYY-MM-DD.txt` (localpart sanitised to
  `[a-z0-9._-]`), e.g. `pixel-agents-matrix-keys-eric-2026-08-07.txt`.
- Both passphrase fields are cleared the instant the blob is produced.
- 500 000 PBKDF2 rounds takes ~0.5–2 s; the button shows `Encrypting…` and is disabled. WebCrypto's
  `deriveBits` is async and does not block paint. No Worker (it would add a chunk for one call).

### 5.4 C2 — Secret Storage (4S) recovery key / security phrase

**The broker.** `cryptoCallbacks.getSecretStorageKey` is supplied at `createClient` time and points at
a module-scoped broker in `crypto.ts`:

```
getSecretStorageKey({ keys }, secretName):   // => Promise<[keyId, Uint8Array] | null>
  1. for each candidate keyId in `keys`: if the in-memory cache has a private key for it, return it.
  2. otherwise emit `secretRequest { keyIds, keyInfos, secretName }` on the store.
     MatrixUI routes to the `encryption` view (not a modal — a modal would fight the docked panel,
     and navigating is honest about where the control lives) and puts RECOVERY into `locked`.
  3. await a promise settled by the view's Unlock button, by Cancel, or by a 5-minute timeout
     (an un-answered prompt must never leak a pending promise).
  4. on Unlock, cache `[keyId, privateKey]` in memory and return it.
     on Cancel or timeout, **resolve `null`** — never reject.
```

**The broker resolves `null`; it never rejects.** The callback is typed
`=> Promise<[string, Uint8Array] | null>` and documented *"if none of the keys are known, may return
`null` — in which case the original operation … may fail with an exception."* Rejecting instead throws
an unmodelled exception up through whatever crypto operation asked, and `bootstrapSecretStorage`'s own
JSDoc warns that *"there may be multiple accesses to secret storage during the course of this call"* —
a mid-flight throw can leave 4S half-written. `null` lets the SDK fail the one operation cleanly.

**Unlock submission** — one field accepts **either** form, because users cannot reliably tell them
apart:

1. try `decodeRecoveryKey(input)` → `Uint8Array`;
2. if that throws, treat the input as a security phrase:
   `deriveRecoveryKeyFromPassphrase(input, keyInfo.passphrase.salt, keyInfo.passphrase.iterations)`
   (if the key info has no `passphrase` block, a phrase is impossible → *"This account uses a recovery
   key, not a phrase."*);
3. `await client.secretStorage.checkKey(privateKey, keyInfo)` — `false` → `wrong-key`, clear and
   refocus the field, **do not** resolve the broker promise (the SDK is still waiting; the user gets
   another try);
4. `true` → resolve, cache, set `ready`, then, in this order:
   `await crypto.bootstrapCrossSigning({})` (no `setupNewCrossSigning` — see below) so this device is
   signed; `await crypto.loadSessionBackupPrivateKeyFromSecretStorage()` so the backup decryption key is
   in the crypto store; `await crypto.checkKeyBackupAndEnable()` so the backup engine starts pulling
   keys.

**A-8 is resolved, and the answer is "deep import".** `decodeRecoveryKey`
(`lib/crypto-api/recovery-key.d.ts`) and `deriveRecoveryKeyFromPassphrase`
(`lib/crypto-api/key-passphrase.d.ts`) are re-exported from `lib/crypto-api/index.ts` but **not** from
the package root. They come in through `sdk.ts` (§1.1) like every other crypto symbol.

**`never-set-up` (the account has no 4S at all):**

```
[grouplbl] RECOVERY
[.muted] Your account has no encryption recovery. Without it, signing in on a new
         device can't read your encrypted history.
[.pa-b.primary.wide  Set up recovery]
```

```ts
// 1. Never pass setupNewCrossSigning. See below.
await crypto.bootstrapCrossSigning({ authUploadDeviceSigningKeys });
// 2. Only reset the key backup when the account genuinely has none.
const existingBackup = await crypto.getKeyBackupInfo();
await crypto.bootstrapSecretStorage({
  createSecretStorageKey,
  setupNewKeyBackup: existingBackup === null,
});
```

**`setupNewCrossSigning: true` is forbidden here, and this is a data-loss rule, not a style one.**
`CrossSigningIdentity.bootstrapCrossSigning` (`lib/rust-crypto/CrossSigningIdentity.js:33`) branches on
that flag *unconditionally* and calls `resetCrossSigning()` — it performs **no** existence check. An
earlier draft gated the call on `secretStorage.getDefaultKeyId() === null`, but that is a **4S** check,
not a **cross-signing** check, and the two are independent: an account can have published cross-signing
keys and no 4S (4S was reset, or set up by a client that skipped it, or a bootstrap half-completed). In
that case the flag publishes a brand-new master key, permanently invalidating every existing device
verification and every other user's verification of this user. Requirement C2 exists to *recover* an
identity; this would detonate it. Called without the flag, the SDK's own branch
(`CrossSigningIdentity.js:52-115`) decides, and its JSDoc is explicit: *"If everything is already set
up, then no changes are made, so this is safe to run."* A genuine reset, if ever wanted, needs its own
destructive-action UI with a warning — it is not a state-machine default. (§9 keeps it out of scope.)

**`setupNewKeyBackup: true` is gated on `getKeyBackupInfo() === null` for the same reason.** That option
routes to `CryptoApi.resetKeyBackup()`, whose JSDoc reads *"Creates a new key backup version. **If there
are existing backups they will be replaced.**"* (`lib/crypto-api/index.d.ts:538-548`). An account with a
populated backup and no 4S — the same gap as above — would have every megolm key in that backup orphaned
and its encrypted history made unrecoverable on all future devices. With `setupNewKeyBackup: false`,
`bootstrapSecretStorage` *stores the existing backup key into the new 4S* instead of replacing the
version, which is exactly what we want.

- `authUploadDeviceSigningKeys` performs User-Interactive Auth: we prompt with the repo's existing
  `passwordPromptDialog` from `client/src/ui/dialog.ts` and answer the `m.login.password` stage. Any
  other required stage → *"Your homeserver needs a sign-in method this client doesn't support."* and
  the bootstrap is abandoned cleanly.
- `createSecretStorageKey` returns a freshly generated key; the encoded recovery key is then shown
  **once**, in a readonly `.pa-input` with a `[Copy]` button, above
  `[.mx-warn] Save this now. It is the only way back into your encrypted history.` and a mandatory
  `[.pa-b.primary I've saved it]` before the group collapses to the `ready` state. It is never written
  to storage by us.

**`ready`:** *"Recovery is set up and this device is unlocked."* plus the KEY BACKUP group:
status from `crypto.getActiveSessionBackupVersion()` / `checkKeyBackupAndEnable()` —
*"Backup v3 — active"* (`.mx-chip.ok`) or *"Not connected"* (`.mx-chip.warn`) — with
`[Connect backup]` (`checkKeyBackupAndEnable`) and `[Restore from backup]`.

**`[Restore from backup]` has a precondition the flow must satisfy.** `restoreKeyBackup()`'s JSDoc:
*"Before calling this method, a decryption key, and the backup version to restore, must have been saved
in the crypto store."* That happens in step 4 of the unlock flow above
(`loadSessionBackupPrivateKeyFromSecretStorage()` then `checkKeyBackupAndEnable()`); the button stays
disabled until both have succeeded, so it can never be pressed into a guaranteed failure. Unlike the
file import, `restoreKeyBackup()` **does** return counts —
`KeyBackupRestoreResult { total, imported }` — so *"Restored 118 of 120 keys."* is a real number, not a
reconstruction. Its `progressCallback` is the same `ImportRoomKeyProgressData` union as §5.3 and gets
the same `switch (stage)` treatment.

### 5.5 Every state, enumerated

| State | RECOVERY group | Rest of the view |
|---|---|---|
| `unavailable` | hidden | red `.mx-warn` at the top; DEVICE group shows id only; file import/export disabled |
| `memory-only` | normal | warn banner: keys won't survive a reload |
| `never-set-up` | "Set up recovery" CTA | file import/export fully usable (they don't need 4S) |
| `locked` | unlock field + Unlock + Cancel | DEVICE shows "Not verified"; UTD rows link here |
| `unlocking` | field + button disabled, label "Checking…" | — |
| `wrong-key` | `.mx-err` *"That recovery key or phrase didn't work."*, field cleared + focused | — |
| `ready` | "set up and unlocked" + KEY BACKUP | DEVICE shows "Verified ✓" |
| `import-running` | — | import group disabled, button "Importing… n%" |
| `import-partial` | — | *"Imported 409 of 412 keys — 3 could not be read."* |

### 5.6 D — device panel

```
[grouplbl] THIS DEVICE
[label "Device"]      [.pa-input readonly  value=<deviceId>]
[label "Fingerprint"] [.pa-input readonly .mx-fp  value=<ed25519 in groups of 4>]
[.mx-chip.ok Verified ✓] | [.mx-chip.warn Not verified]
[.mx-btns] [.pa-b.primary Verify this device] [.pa-b.danger Sign out]

[grouplbl] OTHER DEVICES (n)
.pa-list-row  → .nm = display name | small = deviceId | [.mx-chip …]
[.muted] (when empty) This is the only device on your account.
```

- Fingerprint ← `crypto.getOwnDeviceKeys()` (`ed25519`), rendered in space-separated groups of 4.
- Trust ← `crypto.getDeviceVerificationStatus(myUserId, deviceId)` → `crossSigningVerified`.
- Other devices ← `crypto.getUserDeviceInfo([myUserId], true)`, refreshed on
  `CryptoEvent.DevicesUpdated`; the current device is excluded and labelled "This device" if it slips in.
- **Verify this device** = scroll to / focus the RECOVERY unlock field. Verification-by-recovery-key is
  the *only* verification path (§5.7), and it is a complete one: unlocking 4S signs this device with
  cross-signing, which is exactly what makes it "verified" to every other client.
- **Sign out** = `confirmDialog(…, { danger:true, confirmLabel:'Sign out' })` → §2.4. The dialog copy
  states the consequence plainly: *"This deletes this device's encryption keys from this browser.
  Without a recovery key or an exported key file you will not be able to read old encrypted messages
  here again."*
- **No remote device sign-out or rename** (§9).

### 5.7 Interactive emoji SAS — **OUT OF SCOPE**, explicitly

Requirement D allows this to be cut. It is cut, and here is the reason rather than a shrug: SAS is a
full second protocol surface — request/ready/start/accept/key/mac/done with a cancellation-code
taxonomy, a timeout model, a second online device, and its own UI states — and getting it *half* right
produces the worst outcome in the whole feature (a user who believes they verified and did not).
Verification via the recovery key achieves the identical practical end (this device becomes
cross-signed, is trusted by other clients, and receives keys), and it works with **zero** other devices
online, which SAS cannot.

One concession so the gap is not silently confusing: we listen for
`CryptoEvent.VerificationRequestReceived` and, instead of ignoring it, show a `.muted` line in the
Encryption view and a one-shot toast — *"Another device asked to verify. This client can't do emoji
verification yet — unlock with your recovery key instead."* The request is left to time out on the
other side; we never accept and then fail.

---

## 6. Build and delivery

### 6.1 `client/package.json`

```diff
   "dependencies": {
+    "matrix-js-sdk": "^42.1.0",
```

That is the entire manifest change **on the default path**; the §6.3 wasm contingency, if it is ever
exercised, adds a second pinned line. Recon B installed it live: 12 transitive additions including
`@matrix-org/matrix-sdk-crypto-wasm@18.4.0`, **no blocked build scripts**, and
`✓ Lockfile passes supply-chain policies`. Therefore:

- **`pnpm-workspace.yaml` `allowBuilds`: no entry.** The crypto-wasm package ships its compiled `.wasm`
  prebuilt; its `build` script is for its own maintainers and is never run by consumers.
- **`minimumReleaseAgeExclude`: no entry.** The install passed the policy as-is. If a *future* version
  bump is blocked by release age, add the exclude then — do not pre-add an exemption for a problem that
  did not occur.

### 6.2 `client/vite.config.ts`

**No change.** The probe built the whole SDK + rust-crypto + wasm against the **unmodified** config: no
wasm plugin, no `optimizeDeps`, no `build.target` bump, no `manualChunks`. `tsc --noEmit` also passed
(`moduleResolution: Bundler` + the SDK's `type: module` and `browser` field are compatible).

Do not add configuration the probe did not require.

**UNVERIFIED (flag, do not pre-solve):** the probe ran `vite build` only. `pnpm dev:client` uses
esbuild dependency pre-bundling, which historically needs
`optimizeDeps: { exclude: ['@matrix-org/matrix-sdk-crypto-wasm'] }` for wasm-carrying packages. Verify
in dev **before** deciding; if and only if dev breaks, add the exclude with a comment naming the reason.

### 6.3 The wasm asset

- Emission: `@matrix-org/matrix-sdk-crypto-wasm`'s `index.mjs` contains
  `new URL("./pkg/matrix_sdk_crypto_wasm_bg.wasm", import.meta.url)` — Vite's static analyser recognises
  this pattern, copies the 7.8 MB binary to `dist/assets/matrix_sdk_crypto_wasm_bg-<hash>.wasm`, and
  rewrites the URL to `new URL("/assets/matrix_sdk_crypto_wasm_bg-<hash>.wasm", import.meta.url)`.
- Fetch: `WebAssembly.instantiateStreaming(fetch(url))` inside `loadModuleAsync`.
- **Browser/Express:** `express.static(clientDist)` → serve-static → send → mime-db, whose
  `application/wasm` entry carries `"extensions": ["wasm"]`. Correct `Content-Type` with **zero server
  code**. (Verified by inspecting mime-db 1.54.0, not by an HTTP request — see §7.)
- **Electron `app://`:** `new URL('/assets/x.wasm', 'app://bundle/assets/rust-crypto-*.js')` resolves to
  `app://bundle/assets/x.wasm`; the protocol handler already maps `.wasm` → `application/wasm`
  (`desktop/src/main.ts:58`) and the scheme is registered `{ standard, secure, supportFetchAPI, stream }`
  (`desktop/src/main.ts:421`), which is what `instantiateStreaming` needs.
- **Contingency if `instantiateStreaming` refuses the `app://` response** (UNVERIFIED, §7): the SDK calls
  `RustSdkCryptoJs.initAsync()` with no argument and gives us no URL hook — **but `initAsync` is
  idempotent behind a module-level promise** (`if (!modPromise) modPromise = loadModuleAsync(url)`), so
  `client.ts` can `import('@matrix-org/matrix-sdk-crypto-wasm')` and call `initAsync(explicitUrl)`
  **before** `initRustCrypto()`, warming the module with a URL we control (or with bytes we fetched
  ourselves and instantiated non-streaming). This is the documented escape hatch, not the default path.
  **It carries a manifest cost that §6.1 must then absorb:** there is no `.npmrc` and no hoisting config
  in `pnpm-workspace.yaml`, so pnpm's default isolated linking means `@matrix-org/matrix-sdk-crypto-wasm`
  is a *transitive* dependency and is **not resolvable from `@pixel/client`**. Exercising the contingency
  requires adding it as a direct `client/package.json` dependency pinned to the exact version
  `matrix-js-sdk@42.1.0` resolves (`18.4.0`), so that two copies can never be loaded. Do not pre-add it;
  add it only if the `app://` streaming test fails.

### 6.4 No vendoring script

`scripts/vendor-emulatorjs.mjs` / `vendor-mediapipe.mjs` exist for assets **outside** the module graph —
runtime-URL-loaded blobs in `client/public/` that Vite never sees. This wasm is *inside* the graph: Vite
already fingerprints it, emits it, and rewrites the URL correctly for both origins. A vendor step would
duplicate 7.8 MB, discard the content hash, and force us to hand-maintain a URL the bundler already gets
right. **Not warranted.**

### 6.5 Lazy-chunk boundary and the `session.js` defect

**The rule, amended and made precise:**

> Nothing outside `client/src/matrix/` may statically import anything under it **except**
> `client/src/matrix/sessionProbe.ts`, which is a leaf module with **zero imports** whose entire content
> is three `localStorage`-shaped helpers. `index.ts` remains the only surface that can reach the SDK.

**The fix.** `OfficeScene.maybeAutoStartMatrix()` currently does
`const { hasMatrixSession } = await import('../matrix/session.js')` — a dynamic import that bypasses
`index.ts`, breaks the stated single-surface contract, and (now that `session.ts` sits in the SDK's
dependency neighbourhood) risks dragging transport code into a chunk that only needed a
`localStorage.getItem`. Replace it with a **static** import:

```ts
import { hasMatrixSession } from '../matrix/sessionProbe.js';
```

Cost to the main bundle: ~15 lines, no SDK, no `types.ts`. Benefit: the contract becomes true again,
one async hop disappears from the boot path, and the grep gate
(`grep -rn "from '.*matrix/" client/src --include=*.ts | grep -v '^client/src/matrix/'`) has exactly two
expected hits — the type-only `MatrixClientHandle` import and this one — plus the dynamic
`import('../matrix/index.js')`.

### 6.6 Expected chunk sizes (from the probe — measured, not estimated)

| Chunk | Raw | gzip | When it loads |
|---|---|---|---|
| main entry | unchanged | unchanged | always |
| `matrix-*.js` (our code) | 67.7 kB → ~110 kB expected | 17.6 kB → ~28 kB | first panel open |
| `browser-index-*.js` (SDK core) | 167.9 kB | 40.6 kB | first panel open |
| `dist-*.js` (SDK deps) | 158.3 kB | 47.1 kB | first panel open |
| `indexeddb-crypto-store-*.js` | 705.9 kB | 211.6 kB | first panel open (see note) |
| `rust-crypto-*.js` | 226.6 kB | 45.2 kB | at `initRustCrypto` |
| `matrix_sdk_crypto_wasm_bg-*.wasm` | 7 820.7 kB | 2 132.0 kB | at `initRustCrypto` |

**Note on `indexeddb-crypto-store` (705.9 kB).** This is the *legacy libolm* crypto store, pulled in
because `browser-index.js` calls `setCryptoStoreFactory(() => new IndexedDBCryptoStore(...))` at module
top level. We never use it (rust-crypto has its own store). It can most likely be dropped with a
`resolve.alias` from `matrix-js-sdk` to `matrix-js-sdk/lib/index.js` (the non-browser entry), but the
probe did **not** test that and deep-entry aliasing is exactly the fragility the old doc warned about.
**Ship without it; treat the alias as a measured follow-up**, gated on a build that proves both the size
win and that nothing else depended on the browser entry. One extra gate for that follow-up:
`browser-index.js:18` throws `"Multiple matrix-js-sdk entrypoints detected!"` when
`globalThis.__js_sdk_entrypoint` is already set, so if *any* remaining path still resolves the browser
entry the alias produces a hard runtime throw rather than a size regression. The follow-up must assert
the built chunks contain exactly one entrypoint marker.

Total first-open cost: ~1.16 MB raw / ~317 kB gz of JS, then 7.8 MB / 2.1 MB gz of wasm on crypto init —
paid **only** by users who open the Matrix panel while signed in, and cached thereafter. The status
strip shows `Starting encryption…` while the wasm loads so the delay is explained, not mysterious.

---

## 7. Cross-environment matrix (requirement E)

Every cell is either **VERIFIED** (recon B actually observed it), **INSPECTED** (confirmed by reading
the code/database that decides it, without executing), or **UNVERIFIED** (must be tested before ship).

| Capability | Chrome | Firefox | Electron `app://bundle` |
|---|---|---|---|
| Build emits the wasm & rewrites its URL | **VERIFIED** (one build, engine-independent) | **VERIFIED** | **VERIFIED** |
| `.wasm` served as `application/wasm` | **INSPECTED** (mime-db 1.54.0 via express.static) | **INSPECTED** | **INSPECTED** (`desktop/src/main.ts:58`) |
| `WebAssembly.instantiateStreaming` succeeds | UNVERIFIED | UNVERIFIED | **UNVERIFIED — highest-risk cell**; contingency in §6.3 |
| IndexedDB available (crypto store) | UNVERIFIED (expected yes) | UNVERIFIED (expected yes; private mode is in-memory) | **INSPECTED** — scheme is `{standard:true, secure:true}` (`main.ts:421`), a real secure origin |
| WebCrypto `getRandomValues` | UNVERIFIED (expected yes) | UNVERIFIED (expected yes) | INSPECTED (secure origin) |
| WebCrypto PBKDF2 **SHA-512** | UNVERIFIED | **UNVERIFIED — test explicitly** | UNVERIFIED |
| WebCrypto AES-**CTR** + HMAC-SHA-256 | UNVERIFIED | **UNVERIFIED — test explicitly** | UNVERIFIED |
| `<input type="file">` + `File.text()` | UNVERIFIED (expected yes) | UNVERIFIED (expected yes) | UNVERIFIED (expected yes) |
| `<a download>` + blob URL | UNVERIFIED (expected yes) | UNVERIFIED (expected yes) | **UNVERIFIED — Electron download handling on `app://` must be confirmed** |
| `navigator.locks` (single-writer, §1.5) | UNVERIFIED (expected yes) | UNVERIFIED (expected yes, FF 96+) | UNVERIFIED (expected yes) |
| `indexedDB.databases()` (belt-and-braces wipe sweep only) | expected **yes** | expected **no** — and it does not matter: §2.3 derives the names, so the sweep is optional everywhere | expected **yes** |
| Cross-origin fetch to the homeserver (CORS) | UNVERIFIED — homeserver-dependent (assumption A-1) | UNVERIFIED | **UNVERIFIED — `Origin: app://bundle` is the likeliest rejection**; surfaced as a named error, never a hang |
| `localStorage` persistence across restarts | INSPECTED (secure origin) | INSPECTED | INSPECTED (the `pa-zv-*` voice settings already rely on it) |

Two cells drive the ship/no-ship decision and must be tested first: **`instantiateStreaming` on
`app://`** and **CORS from `app://bundle`**. Neither is new to this change (CORS was already assumption
A-1) but the first is.

---

## 8. Security review of this design

### 8.1 The high-value secrets and how they are handled

Three secrets pass through the UI: the **4S recovery key**, the **security phrase**, and the **key-file
passphrase**. For all three:

- **Never persisted.** Not `localStorage`, not `sessionStorage`, not IndexedDB, not a cookie, not the
  URL, not `history.state`. There is exactly one persistent secret in this feature — the Matrix access
  token — and it was already there.
- **Never logged.** No `console.*` may take a value derived from these fields. This is a grep gate in
  the verification list, not a promise.
- **Never a `value=` attribute.** The fields are created with `document.createElement('input')` and
  written through the `.value` **property**, which does not serialise into `outerHTML`/`innerHTML`, so a
  DOM dump or a copied subtree cannot carry them. `autocomplete="new-password"` on every one, so no
  browser password manager offers to save them as a site password.
- **Cleared at the earliest possible moment:** the import passphrase field is blanked the instant
  `keyfile.decrypt` returns (success *or* failure); both export fields the instant the blob exists; the
  unlock field on every submit, success or not.
- **Zeroed where the platform allows.** Derived `Uint8Array` key material (`PBKDF2` output, the AES and
  HMAC subkeys, the decoded recovery key before it is handed to the SDK) is `.fill(0)`ed after use.
  JavaScript `string`s cannot be zeroed — that is a platform limit, stated rather than papered over,
  and it is why the *strings* are cleared from the DOM immediately and never copied into a long-lived
  structure.
- **In-memory cache scope.** The unlocked 4S private key is cached in a module-scoped `Map` in
  `crypto.ts` purely so the SDK is not re-prompted for every secret. It is cleared on `destroy()`, on
  sign-out, and on `loggedOut`. It is never serialised.
- **Never transmitted.** File decryption is entirely local. The recovery key never leaves the device; 4S
  only ever sends *encrypted* secrets to the homeserver, and the SDK does that, not us.

### 8.2 Homeserver-URL trust

Unchanged from the superseded document, and still the actual control: `normaliseHomeserverUrl` is
applied to **both** the typed input and the `m.homeserver.base_url` discovered from
`/.well-known/matrix/client`; `https:` is required except for `localhost`/`127.0.0.1`/`[::1]`; query and
hash are stripped. The SDK's `MatrixClient` is then constructed with that validated `baseUrl` and
**never re-runs discovery**, so there is no later point at which a hostile well-known can redirect
token-bearing traffic. We never call `client.setHomeserverUrl` after construction. Nothing in this
feature derives a URL from `window.location` (AGENTS rule 10) and nothing attaches the pixel-agents
session cookie or Bearer sid to a homeserver request (no `credentials: 'include'`).

### 8.3 New server attack surface

**None.** Zero endpoints, zero Colyseus messages, zero schema fields, zero `permissions.ts` capabilities.
AGENTS rules 7 and 9 are satisfied vacuously — there is no handler to validate. Rules 1 and 2 are
untouched: nothing here can move a character, occupy a station, or change a zone, and no Matrix data
enters `OfficeState` or `@pixel/shared/schema`. The `mmo-readiness` naming rule still applies — the store
is named `store`, and no object named `state`/`sim`/`os`/`officeState` gains an `update(` method.

### 8.4 What an attacker with the browser profile gets

Stated bluntly, because the honest answer is not reassuring and pretending otherwise would be the
security defect:

**They get:** the Matrix access token (`localStorage`) → full account access, same as Element; the
crypto storage key (`localStorage`) **and** the rust crypto database (IndexedDB) → this device's olm
identity, every megolm inbound session it holds, and — if 4S was ever unlocked on this device — the
cached cross-signing private keys, which the SDK deliberately caches in the rust store. That is a **full
device compromise**: they can read every encrypted message this device can read, and impersonate the
device.

**They do not get:** the recovery key or the security phrase themselves (§8.1), so they cannot
re-bootstrap 4S or lock the real user out of their own recovery; and they cannot read another
pixel-agents user's Matrix state on the same profile, because the namespace (§2.1) and the per-namespace
storage key differ.

This is the same posture as every browser Matrix client and is not made worse by this design. The
mitigations that exist are the honest ones: sign out (§2.4 actually destroys the local state, which is
what requirement F is for), and serve over TLS (AGENTS rule 9).

### 8.5 Supply chain

One new direct dependency, 12 transitive, pinned by `pnpm-lock.yaml`, no install-time build scripts, and
a 7.8 MB third-party wasm binary that is content-hashed by Vite at build time and served from our own
origin (never a CDN — consistent with the repo's stated vendoring philosophy even though the mechanism
differs). The `mmo-readiness` banned-engine grep over every `package.json` is unaffected:
`matrix-js-sdk` is not a game, physics or render engine.

---

## 9. Scope fence — what this change does NOT do

Decisions, not omissions.

**Encryption:**
- **No interactive SAS emoji verification and no QR verification** (§5.7). Verification is by recovery
  key only.
- **No verification of other users** — no user-trust UI, no "verify @alice", no shields on messages
  beyond the failure taxonomy.
- **No signing out other devices, renaming them, or blocking them.** The device list is read-only.
- **No enabling encryption on a room from this client**, and no room-security settings.
- **No dehydrated devices, no MSC3814, no room-key sharing on invite, no key-forwarding requests UI.**
- **No key backup version management** — no rotate, no delete, no "reset everything". If 4S is broken,
  the answer is Element.
- **No cross-signing reset and no key-backup reset on an account that already has them.** This is now an
  enforced invariant, not just an omission: `setupNewCrossSigning` is never passed, and
  `setupNewKeyBackup` is passed only when `getKeyBackupInfo()` returns `null` (§5.4). Both are
  irreversible account-wide operations; if they are ever wanted they need their own destructive-action
  UI with an explicit warning, in a change that says so.
- **No cross-tab handover** (§1.5) — one writer, "close the other tab and reload".
- **No per-message shields** (verified/unverified sender badges) beyond the UTD reasons.

**Storage / sync:**
- **No persistent sync store** (§1.2) — a cold initial sync every page load, unchanged from today.
- **No sliding sync / simplified sliding sync.**
- **No multi-tab concurrent operation** — one writer (§1.5).

**Carried over unchanged from the superseded document's §7:**
- no voice/video calls; no threads, reactions, edits, replies or redaction UI; no read-receipt display;
  no typing notifications; no file/image upload or media display; no `mxc://` avatars; no Spaces or room
  directory browsing; no SSO/OIDC/registration/password reset; no room settings; no moderation; no
  desktop/OS notifications; no multi-account or parallel homeservers; no cross-device credential sync;
  no `formatted_body` HTML rendering; no cross-zone persistence of the panel.

**Repo:**
- **No server change of any kind.** No endpoint, no Colyseus message, no schema field, no DB table, no
  new `permissions.ts` capability.
- **No `shared/` change** — `/matrix` is already registered.
- **No `desktop/` change** — the `app://` handler already does what is needed.
- **No `vite.config.ts` change** (§6.2), **no `pnpm-workspace.yaml` change** (§6.1).

---

## 10. Assumptions (explicit, each falsifiable)

| # | Assumption | Consequence if wrong |
|---|---|---|
| A-1..A-5 | inherited from the superseded doc (CS-API v3, CORS-open, password login, https, standard rate limiting) | unchanged |
| ~~A-6~~ | **RESOLVED — no longer an assumption.** The `::matrix-sdk-crypto` / `::matrix-sdk-crypto-meta` suffixes are hardcoded in `lib/client.js:715`. | — |
| ~~A-7~~ | **RESOLVED — the §4.3 table is now the real enum** from `lib/crypto-api/index.d.ts:631`, with members (not string literals) compared, so a rename is a build failure. | — |
| ~~A-8~~ | **RESOLVED — deep import.** `decodeRecoveryKey`/`deriveRecoveryKeyFromPassphrase` live in `lib/crypto-api/`, not the package root. | — |
| A-15 | `matrix-js-sdk` ships **no** `exports` map, so `matrix-js-sdk/lib/crypto-api/index.js` stays importable | every crypto symbol becomes unreachable; contained to `sdk.ts` (§1.1), which is the one file that would need a new strategy (vendoring the enum values, or pinning) |
| A-9 | Synapse returns pending to-device messages on an initial sync | key loss across reloads → switch the sync store to IndexedDBStore and add it to the §2 wipe list |
| A-10 | `WebAssembly.instantiateStreaming` works on `app://bundle` | §6.3 contingency (pre-warm `initAsync` with our own URL/bytes) |
| A-11 | `navigator.locks` exists in Chrome, Firefox and Electron | §1.5 degrades loudly with a banner |
| A-12 | WebCrypto supports PBKDF2-SHA-512 and AES-CTR in Firefox | C1 blocked in Firefox; would need a JS fallback (large) — test **early** |
| ~~A-13~~ | **RESOLVED.** `clearStores({cryptoDatabasePrefix})` provably deletes the two rust databases (`lib/client.js:715`); called bare it deletes the wrong ones. §2.4 step 5 passes the prefix, and steps 7–8 remain the verification pass. | — |
| A-14 | The user's homeserver has server-side key backup enabled | C2's backup group shows "Not connected"; C1 file import still works |

---

## 11. Verification strategy

1. `pnpm -r run check-types` clean; `pnpm build` succeeds.
2. `.claude/skills/mmo-readiness/check.sh` — no hard failures. Check 3 (banned engines in any
   `package.json`) must still pass with the new dependency.
3. **Chunk gate:** the main entry chunk must not grow by more than ~2 kB (the `sessionProbe` import).
   `matrix-js-sdk` must appear in **no** chunk reachable without `import('../matrix/index.js')`.
4. **Grep gates:** the two-hit import gate in §6.5; `grep -rn "console\." client/src/matrix` shows no
   secret-derived value; `grep -rn "window.location" client/src/matrix` is empty;
   `grep -rn "matrix-js-sdk/lib" client/src/matrix` matches **only** `sdk.ts`;
   `grep -rn "getType()" client/src/matrix` never appears in a decryption branch (§4.3);
   `grep -rn "setupNewCrossSigning" client/src/matrix` is empty (§5.4).
5. **Interop gate (the one that proves C1 is real):** export room keys from **Element**, import the file
   here, and confirm previously-UTD messages become readable. Then export from here and import into
   **Element**. Both directions, or the format is wrong.
6. **E2EE happy path:** two accounts, an encrypted DM; send both ways; verify Element sees our messages
   without a red shield and we see theirs.
7. **Late-key path:** send from Element to a fresh device here (UTD), then unlock 4S here, and confirm
   the row repaints to plaintext **with no user click**.
8. **Every §5.5 state** reachable and correct, including `wrong-key` (the SDK must still be waiting) and
   `import-partial` (feed a file with three corrupted entries).
9. **Requirement F, as an explicit test:** sign in as pixel user A with Matrix account X; open DevTools
   → Application; record the IndexedDB databases and the three `localStorage` keys; sign out; confirm
   **all** of them are gone. Then repeat with a second tab open holding a connection and confirm the
   §2.4/9 banner appears rather than a silent success.
10. **Second tab:** open two tabs, confirm the second shows "already open in another tab", close the
    first, confirm `[Try again]` boots the second, and confirm the crypto store is not corrupted
    afterwards (reload and read an encrypted room).
10b. **The blank-row and raw-error-string regressions (§4.3), explicitly.** Open an encrypted room on a
    fresh device: while the SDK is decrypting, no row may be blank (`🔒 Decrypting…`); once it fails, no
    row may contain the substring `Unable to decrypt:` (that is the SDK's internal string leaking).
    Grep the rendered DOM for it.
10c. **The `never-set-up` flow against an account that already has cross-signing and/or a key backup but
    no 4S** — the exact gap that made `setupNewCrossSigning`/`setupNewKeyBackup` dangerous (§5.4). After
    "Set up recovery", the account's master key fingerprint and the backup version number must both be
    **unchanged**. This is the test that proves the two blockers are actually fixed; run it against a
    throwaway account first, because a regression here is irreversible.
11. **Chrome, Firefox and Electron** all of 5–10, plus the §7 UNVERIFIED cells, with the wasm load and
    the `app://` CORS check done **first**.
12. **Regression:** everything in the superseded document's verification list §4 items 4, 7, 8, 9 (docked
    panel, zone-chat focus, WASD blocking, F8) still passes.

---

## Update History

| Date | Change |
|---|---|
| 2026-08-07 | Initial design. Transport swapped to `matrix-js-sdk@42` + rust-crypto at the user's explicit instruction; E2EE read/write; namespaced crypto storage with a numbered wipe; Element key-file import/export; 4S recovery-key unlock; device panel. SAS emoji verification explicitly out of scope. |
| 2026-08-07 | Adversarial review folded in, all claims re-checked against the installed `matrix-js-sdk@42.1.0`. **Data-loss fixes:** `setupNewCrossSigning` removed entirely (it resets the account's identity unconditionally); `setupNewKeyBackup` gated on `getKeyBackupInfo() === null` (it replaces existing backups); `clearStores` now receives `cryptoDatabasePrefix` (bare, it deleted the wrong databases and requirement F did nothing). **Crash/blank-render fixes:** `pendingEventOrdering: Detached` added (`getPendingEvents()` throws without it); §4.3 rewritten to dispatch on `isBeingDecrypted()`/`isDecryptionFailure()` instead of `getType()`, with a new "Decrypting…" state, so the SDK's `** Unable to decrypt: … **` string can never reach a chat bubble and no row is ever blank; `EventStatus.SENT`/`CANCELLED` added to the echo mapping. **Correctness:** crypto symbols require deep imports, now confined to a new `sdk.ts` shim (SDK `MatrixError` aliased); `DecryptionFailureCode` table corrected against the real enum (`OLM_UNKNOWN_MESSAGE_INDEX` added, two invented members removed); `MxRoom.heroes` dropped (`getSummary()` does not exist); import `progressCallback` treated as a discriminated union; `getSecretStorageKey` resolves `null` rather than rejecting; `restoreKeyBackup` preceded by `loadSessionBackupPrivateKeyFromSecretStorage`; `SyncState.Catchup` mapped and `Stopped` no longer mislabelled "signed out". **Scope reductions:** the `indexedDB.databases()` diff recorder deleted (it could delete arcade saves) and the `BroadcastChannel` tab handover cut. **Added:** a "Start fresh" escape hatch so a failed wipe cannot soft-brick the panel; an explicit, reasoned §2.7 on what requirement F does and does not cover at pixel-agents user switch. A-6/A-7/A-8/A-13 resolved; A-15 (no upstream `exports` map) added. |
