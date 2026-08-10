# Matrix Chat Client Design Document

## Overview

Add a **Matrix (Element-style) chat client** to the pixel-agents web/desktop client: a right-docked,
pinnable pixel-skinned panel where a signed-in pixel-agents user can log in to *their own* Matrix
homeserver, see their rooms split into People / Groups, read a live timeline, send messages, start
new DMs from the homeserver's user directory, create and join group rooms, invite members, leave,
and accept or decline invites.

The feature is **client-only**. It adds no server endpoint, no Colyseus message, no schema field and
no npm dependency. It talks directly from the browser (and from the Electron `app://bundle` renderer)
to the user's homeserver over the Matrix Client-Server (CS) API v3, through a small hand-rolled
fetch layer that lives entirely inside a lazily-imported chunk.

### Referenced UI Spec

No separate UI Spec exists. The full panel design is included below under
[UX Specification](#ux-specification), reusing the canonical pixel-menu skin
(`client/src/ui/paSkin.ts` + the CSS block in `client/src/scenes/OfficeScene.ts`).

## Design Summary (Meta)

```yaml
design_type: "extension"
risk_level: "medium"
complexity_level: "high"
complexity_rationale: >
  (1) A chat client is mostly failure states — long-poll /sync with gappy-sync handling,
  backoff, token expiry, offline/reconnect, optimistic send with reconciliation;
  (2) it is a second, foreign, *non-authoritative* network stack living beside Colyseus,
  so the world-model boundary and the keyboard/focus boundary with the in-world ChatUI
  both have to be drawn explicitly; (3) the UI is a multi-view router (login, room list,
  room, members, new-DM, new-group, join) that must be pixel-token-exact and must not
  bloat the main bundle for users who never open it.
main_constraints:
  - "No new npm dependency and no new server surface — the CS-API slice is hand-rolled in client/src/matrix/."
  - "Zero Matrix traffic through Colyseus room state, the office engine or @pixel/shared/schema (AGENTS rules 1/2)."
  - "Main bundle must not grow beyond a button + a dynamic import (AGENTS: heavy role-specific code is lazily imported)."
  - "Same bundle must work in Chrome, Firefox and the Electron app://bundle origin (AGENTS rules 8/10)."
  - "Every pixel of chrome uses the .pa-* skin tokens; the deprecated blue palette is forbidden."
biggest_risks:
  - "Homeserver CORS: a reverse proxy with an origin allowlist will reject app://bundle (desktop) and the game origin (browser). Mitigated by an explicit, named error state — never a silent hang."
  - "Encrypted rooms: v1 cannot read them. Mitigated by labelling them, never by showing an empty timeline."
unknowns:
  - "Which homeserver the user actually runs (see Assumptions) — the design targets spec-compliant Synapse-class servers with password login."
```

## Background and Context

### Prerequisite ADRs

- `docs/adr/ADR-0001-desktop-shell-and-cross-origin-auth.md` (**Accepted**) — establishes the
  `app://bundle` standard+secure renderer origin and the "no `window.location`-derived server URL"
  rule this design inherits. No new ADR is required: this design introduces no new cross-component
  convention, only a new client surface. If E2EE is later brought in scope (see
  [E2EE Position](#2-e2ee-position)), that reversal **does** need an ADR, because it changes the
  transport decision below.

### Problem to Solve

Team chat currently has no home in pixel-agents. The in-world `ChatUI` is *zone* chat: ephemeral,
proximity-scoped, tied to a Colyseus room, and gone when you portal away. What is wanted is a
persistent, identity-based messenger — the thing Element is — reachable without leaving the world,
and looking like it was always part of the app.

### Requirements

#### Functional Requirements

- **FR-1** Connect to a Matrix homeserver: homeserver URL + user + password; session survives reload;
  visible logout.
- **FR-2** Room list, segmented People / Groups / Invites, with unread indicators.
- **FR-3** Open a room: scrollback timeline that live-updates and back-paginates; send messages.
- **FR-4** Start a new DM: search the homeserver user directory, or paste a raw `@user:server` MXID.
- **FR-5** Groups: create a room, join by alias/id, list members, invite, leave, accept/decline invites.
- **FR-6** Indistinguishable from the rest of the app's chrome (pixel skin, tokens, no new look).

#### Non-Functional Requirements

- **NFR-1** Zero main-bundle cost for users who never use chat (beyond one top-bar button).
- **NFR-2** Works in current Chrome and Firefox and in the Electron shell.
- **NFR-3** Never lies: an encrypted message is labelled encrypted; a failed send is labelled failed;
  a stale connection is labelled reconnecting.
- **NFR-4** No regression to world authority, zone chat, or the existing docked-panel behaviour.

### Assumptions about the user's homeserver

These are **assumptions**, stated so a reviewer can reject them rather than discover them:

- **A-1** The homeserver implements the Matrix CS API **v3** (Synapse/Dendrite/Conduit class) and
  serves `/_matrix/client/*` and `/.well-known/matrix/client` **CORS-open** (`Access-Control-Allow-Origin: *`),
  as the spec requires. A reverse proxy with an origin allowlist will break the browser build and
  will *certainly* break the desktop build, whose `Origin` is `app://bundle`. This is surfaced as a
  named error, not a hang.
- **A-2** **Password login (`m.login.password`) is enabled.** SSO/OIDC-only homeservers are detected
  from `GET /_matrix/client/v3/login` and reported as unsupported in v1 — the login form is replaced
  by an explanatory message, not left broken.
- **A-3** The homeserver does **not** force E2EE on newly created private rooms/DMs
  (Synapse `encryption_enabled_by_default_for_room_type` is off or `off`). If it does, rooms we create
  come back encrypted and immediately render as read-only with the lock label — degraded but honest.
- **A-4** The homeserver is reachable over **https** (or is `localhost` in dev). Both the browser page
  and the `app://` renderer are secure contexts, so an `http://` homeserver URL is blocked by
  mixed-content rules; the login form rejects it up front with that exact reason.
- **A-5** Standard rate limiting applies; `429` responses carry `retry_after_ms`.

---

## 1. Transport Decision

> ### ⚠️ SUPERSEDED — see [`docs/design/matrix-e2ee-design.md`](./matrix-e2ee-design.md)
>
> **This section's decision has been reversed.** The transport is now the official
> **`matrix-js-sdk@42.x` with `initRustCrypto()`**; `api.ts` and `sync.ts` are replaced by SDK-backed
> equivalents. **Reason: the repo owner asked for it** — *"i want the project to have e2ee use the
> official matrix sdk"*. This is a product instruction, not a re-evaluation of the reasoning below,
> which is left intact as the record of why the hand-rolled layer was chosen at the time.
>
> Everything else in this document — §3 credentials, §4 world-model boundary, §5 UX, §6's UI files,
> §7's non-E2EE scope items — remains in force. Read the E2EE design for the parts it replaces.

### Decision

**Hand-roll a minimal Matrix CS-API layer in `client/src/matrix/` (`api.ts` + `sync.ts`). Do not add
`matrix-js-sdk`.**

### This is a choice, not a constraint

The dependency-install probe **succeeded**: `pnpm add --filter @pixel/client matrix-js-sdk
--lockfile-only` exited 0 against the live registry, resolved 492 packages and pinned
`matrix-js-sdk@42.1.0`; the tree was restored clean. Package installation is available in this
environment. The hand-rolled layer is therefore chosen on merit, not forced by an offline box.

### Why

1. **The required slice of the CS API is small and stable.** The complete v1 feature set is
   ~18 endpoints (listed in [API Surface Used](#api-surface-used)), all of them plain JSON over
   `fetch`, all of them unchanged since Matrix 1.1. `matrix-js-sdk@42` brings a full client runtime —
   crypto, VoIP, widgets, spaces, threads, sliding sync, MSC experiments, a store abstraction and a
   `Room`/`RoomState`/`EventTimelineSet` object graph — to serve that slice. The impedance mismatch
   is larger than the code it saves.
2. **Bundle weight is the repo's stated concern and the game server ships the bundle.**
   `pnpm start` serves `client/dist` from the same Express process as Colyseus and `/feed`
   (`server/src/index.ts:216`). `vite.config.ts` has no `manualChunks`. matrix-js-sdk tree-shakes
   poorly (side-effectful module graph, `olm`/rust-crypto entry pulled by the default `matrix` entry)
   and lands in the multi-hundred-KB-to-MB range even when only the REST surface is used. The
   hand-rolled layer is an estimated **~30 KB min / ~10 KB br** of first-party code with no
   transitive graph.
3. **The single strongest reason to take the SDK — E2EE — is explicitly out of scope for v1**
   (§2). Without crypto, the SDK is a very large sync-state manager we would immediately wrap in our
   own view models anyway.
4. **Toolchain friction we do not have to buy.** `matrix-js-sdk` v29+ loads
   `@matrix-org/matrix-sdk-crypto-wasm`, a runtime `.wasm` asset. That would mean: a Vite wasm/TLA
   story, a `client/public/` vendoring step in the mould of `scripts/vendor-mediapipe.mjs` /
   `vendor-emulatorjs.mjs` (this repo deliberately vendors heavy third-party assets rather than
   CDN-loading them), correct `application/wasm` serving from *both* Express and the desktop
   `app://` protocol handler, and possibly a `pnpm-workspace.yaml` `allowBuilds` entry plus a
   `minimumReleaseAgeExclude` exemption for the supply-chain policy. All of that is real cost for a
   feature that, in v1, never calls a crypto function.
5. **Total control of the fetch boundary is exactly what rule 10 wants.** Every request in our layer
   takes an absolute `baseUrl` supplied by the user at login. There is no `window.location`
   derivation to audit, no library-internal relative URL, no cookie jar assumption — the desktop and
   browser code paths are byte-identical by construction.
6. **Auditability.** AGENTS.md's threat model ("assume the client is fully compromised") is easier to
   reason about when the only code touching the user's Matrix access token is ~200 lines we wrote.

### What we give up (honestly)

- Gappy-sync/timeline-continuity edge cases, retry/backoff, and transaction-id reconciliation are now
  **our** bugs. Mitigated by specifying them precisely in [Sync Contract](#sync-contract) rather than
  leaving them to the implementer.
- No free path to E2EE, threads, spaces, or sliding sync later. Mitigated by keeping `api.ts` behind a
  narrow interface (`MatrixApi`) and `sync.ts` behind a narrow store interface, so a future
  SDK-backed implementation is a two-file swap behind an ADR — the UI never imports `fetch` directly.
- No community-maintained handling of homeserver quirks. Accepted: the target is one homeserver
  (A-1..A-5), not the federation at large.

### Rejected alternatives

| Alternative | Why rejected |
|---|---|
| **`matrix-js-sdk` (statically imported)** | Multi-MB in the main bundle for every viewer including those who never chat. Violates NFR-1 outright. |
| **`matrix-js-sdk` (dynamically imported)** | Fixes NFR-1 but keeps every other cost: wasm/vendoring pipeline, supply-chain policy exemptions, 350+ transitive packages, and a `client/dist` that roughly doubles. Buys us mostly E2EE, which v1 does not ship. |
| **`matrix-js-sdk` with a curated deep-import set** (`matrix-js-sdk/lib/http-api` etc.) | Deep imports into an SDK's internals are unsupported and break on minor versions; we would own the breakage *and* the dependency. Strictly worse than owning ~700 lines. |
| **Embed Element Web in an `actionIframe`** | Cheapest by far, and rejected: it is a foreign design system in a pixel-skinned app (FR-6 fails at the first pixel), it needs a hosted Element deployment, it cannot be styled, and `X-Frame-Options: DENY` / `frame-ancestors 'none'` policies on the Element host make it unreliable. |
| **Server-side Matrix bridge (server proxies CS API for the client)** | Would put the user's third-party credential on our server, invent a whole authenticated proxy API, and add a per-user long-poll to the game process. Enormous new attack surface and server load for zero user-visible gain. Rejected — see §3. |

### Bundle & dynamic-import strategy

- **One lazy chunk.** `client/src/matrix/index.ts` exports `createMatrixClient(...)`. `OfficeScene`
  reaches it *only* via `await import('../matrix/index.js')`, exactly the pattern used for
  `openAdminOverlay` (`OfficeScene.ts:904`). Nothing else in `client/src` may statically import
  anything under `client/src/matrix/`; that is the rule that keeps the chunk separate, and it is
  checkable by grep.
- **Static cost in the main bundle:** one `mkBarBtn` call, one `MenuId` union member, one panel shell,
  one `import()` call site (~40 lines total). The `/matrix` `CommandSpec` lives in `shared/src/commands.ts`
  (§4) and costs five lines there.
- **When the chunk loads: on first open of the Matrix panel (or the first `/matrix` command), and
  never before.** There is no idle/autostart pre-boot path.
  - *Why not autostart.* An earlier draft pre-loaded the chunk at idle when a `pa-mx-autostart` marker
    existed, to keep unread badges live for users who had logged in once. That is cut: (a) it is a
    second boot path with its own race against `myUserId` resolution (§3), and (b) `goToZone()`
    does `history.replaceState` + `reloadApp()` (`OfficeScene.ts:3734-3735`), so *every portal is a
    full page reload* — an idle pre-boot would pay a cold initial `/sync` on every zone hop for a
    panel the user may not open. One boot path, triggered by intent, is both simpler and cheaper.
  - **Consequence, stated honestly:** the top-bar unread pip only appears once the panel has been
    opened during the current page load, and a zone change resets that. Once loaded, the sync loop
    **keeps running while the panel is closed**, so the pip and the room list stay live for the rest
    of the page's lifetime. Unread counts themselves are server-side (`unread_notifications`) and are
    never lost — only the *pip* is late.
- **No new npm dependency**, therefore no `pnpm-lock.yaml` churn, no `allowBuilds` entry, no
  `minimumReleaseAgeExclude` entry, and `mmo-readiness` check 3 (banned-engine grep over every
  `package.json`) is untouched.

### API surface used

`{hs}` = the discovered homeserver base URL. All calls carry `Authorization: Bearer <access_token>`
except discovery/versions/login.

| Purpose | Call |
|---|---|
| Discovery | `GET {entered}/.well-known/matrix/client` → `m.homeserver.base_url` (fallback: the entered URL). **The discovered value is re-validated exactly like typed input — see §5.3.** |
| Sanity | `GET {hs}/_matrix/client/versions` |
| Login flows | `GET {hs}/_matrix/client/v3/login` |
| Login | `POST {hs}/_matrix/client/v3/login` |
| Logout | `POST {hs}/_matrix/client/v3/logout` |
| Sync | `GET {hs}/_matrix/client/v3/sync?filter=…&since=…&timeout=30000` |
| Back-pagination | `GET {hs}/_matrix/client/v3/rooms/{roomId}/messages?dir=b&from=…&limit=30` |
| Send | `PUT {hs}/_matrix/client/v3/rooms/{roomId}/send/m.room.message/{txnId}` |
| Read marker | `POST {hs}/_matrix/client/v3/rooms/{roomId}/read_markers` |
| Create room / DM | `POST {hs}/_matrix/client/v3/createRoom` |
| Join by alias/id | `POST {hs}/_matrix/client/v3/join/{roomIdOrAlias}` — with `?server_name=<via>` when the input is a raw `!roomid:server` (see §5.3 `join`) |
| **Accept invite** | `POST {hs}/_matrix/client/v3/rooms/{roomId}/join` — the correct endpoint for a room you are *already invited to*; needs no `via` |
| Leave / decline | `POST {hs}/_matrix/client/v3/rooms/{roomId}/leave` |
| Invite | `POST {hs}/_matrix/client/v3/rooms/{roomId}/invite` |
| Members | `GET {hs}/_matrix/client/v3/rooms/{roomId}/members?membership=join&membership=invite` — **not** `/joined_members`, which by definition omits pending invitees and would make a successful invite look like it failed (FR-5) |
| Directory search | `POST {hs}/_matrix/client/v3/user_directory/search` |
| **DM map read** | `GET {hs}/_matrix/client/v3/user/{userId}/account_data/m.direct` — mandatory immediately before every write; `404 M_NOT_FOUND` ⇒ `{}` |
| DM map write | `PUT {hs}/_matrix/client/v3/user/{userId}/account_data/m.direct` |

`GET /_matrix/client/v3/profile/{userId}` is deliberately **not** used: avatars are initials (§7) and
display names come from member events and `rooms.join[].summary.m.heroes` (see
[Sync contract](#sync-contract)). One fewer endpoint, one fewer round trip.

---

## 2. E2EE Position

> ### ⚠️ SUPERSEDED — see [`docs/design/matrix-e2ee-design.md`](./matrix-e2ee-design.md)
>
> **Reversed together with §1, at the repo owner's explicit request.** Encrypted rooms are now
> readable *and* writable; undecryptable events render a typed reason instead of a fixed placeholder;
> the composer is no longer disabled. Rule 6 below ("never a silent empty timeline") survives and is
> strengthened. Rules 1–5 are replaced.

### Decision

**Encrypted rooms are OUT OF SCOPE for v1 and are explicitly, visibly labelled as unreadable.
The client never attempts to decrypt, never sends into an encrypted room, and never shows an
encrypted room as empty.**

Rules the implementation must obey — these are correctness requirements, not polish:

1. **Detection.** A room is encrypted iff its state contains `m.room.encryption`. The `/sync` filter
   (see [Sync contract](#sync-contract)) **does not restrict state event types at all**, so the
   initial sync's full room state carries `m.room.encryption` for every joined room before any
   timeline is rendered. (`lazy_load_members` limits *`m.room.member`* events only; it does not
   filter other state types.) An `m.room.encryption` event arriving later in `timeline`/`state`
   flips the room to encrypted live.
2. **Room list.** Encrypted rooms are listed normally with a `🔒` marker in the row
   (`.pa-list-row small` slot, `title="End-to-end encrypted — not readable in this client"`).
   They are **not** hidden: hiding rooms is a lie by omission.
3. **Timeline.** Opening an encrypted room shows a full-width notice strip at the top of the
   timeline: *"🔒 This room is end-to-end encrypted. This client cannot read encrypted messages."*
   Individual `m.room.encrypted` events render as dim placeholder rows
   *"🔒 Encrypted message"* with the sender and timestamp (both are cleartext in the event) —
   so you can see that traffic exists and who is talking, which is true, without pretending to
   have content.
4. **Composer.** Disabled in encrypted rooms, replaced by the notice
   *"Sending is disabled in encrypted rooms."* We do **not** send an unencrypted `m.room.message`
   into an encrypted room: it is spec-legal but Element and friends render it with a red shield, i.e.
   we would be publishing a "this user's client is broken/insecure" marker on the user's behalf.
5. **Room creation.** Rooms we create request no encryption (`preset: trusted_private_chat` /
   `private_chat` / `public_chat`, no `m.room.encryption` initial state). If the homeserver forces it
   anyway (A-3), the new room appears immediately as an encrypted, read-only room and a `.mx-toast`
   (§5.4) says *"Your homeserver encrypts new rooms by default — this client cannot read it."*
6. **Never a silent empty timeline.** If a room has zero renderable events, the reason is always
   stated: "No messages yet", "🔒 encrypted", or "Failed to load — Retry".

### Rejected alternatives

- **Partial/opportunistic E2EE via `matrix-js-sdk` rust-crypto** — reverses the transport decision,
  imports the wasm pipeline, and delivers a half-working experience (device verification,
  cross-signing, key backup, "unable to decrypt" recovery UI are each a feature in their own right).
  A chat client that *sometimes* decrypts is worse than one that never claims to.
- **Silently skipping `m.room.encrypted` events** — produces an empty timeline in an active room.
  This is the failure mode the requirement explicitly forbids.
- **Sending plaintext into encrypted rooms** — see 4 above.

---

## 3. Credential / Session Model

### Decision

**(a) Browser `localStorage` only, namespaced per pixel-agents user. No server component, no new
endpoint, no new capability.**

Exactly **two** keys, one of them optional:
```
pa-mx:<paUserId||'_'>   →  { hsBaseUrl, hsOrigin, userId, deviceId, accessToken, savedAt }
pa-mx-pinned            →  "1" | "0"   (dock pin state, no secret; §5.1)
```
- `paUserId` is `OfficeScene.myUserId` (resolved server-side in `onAuth`, delivered on the authed
  `'m'` channel as `viewerIdentity`) — never a client-typed name. Empty in open dev mode → `_`.
- **Startup race (must be handled, not assumed away).** `myUserId` is `''` until the
  `viewerIdentity` message arrives (`OfficeScene.ts:293` init, `:619` assignment), and `''` is *also*
  the legitimate open-dev-mode value — the two are indistinguishable by inspecting the field.
  Therefore: **`OfficeScene` disables the `✉ Matrix` bar button (and rejects `/matrix`) until
  `viewerIdentity` has been received**, setting an `identityResolved` flag in that handler. The
  Matrix chunk can only be booted after that flag is true, so the namespace is always the final one.
  Open dev mode then resolves deterministically to `_` exactly once.
- `hsOrigin` is the **normalised** origin of the *validated* base URL: lowercased
  `scheme://host[:port]`, no path, no trailing slash. It is stored *inside* the record (used by
  `api.ts`'s URL assertion), not as part of the key.
- **One session, one key.** An earlier draft keyed additionally by homeserver origin to keep parallel
  sessions on several homeservers. That is cut: §7 already scopes v1 to one Matrix session per pixel
  user, and no view offers a homeserver switch — signing out returns to the `login` view, and signing
  in to a different homeserver simply replaces the record. Fewer keys, one restore branch, no
  `pa-mx-active` pointer.
- `deviceId` is stored and **reused** on re-login (`device_id` in the login request) so the user does
  not accumulate a new device per browser reload.

### Why this does not violate AGENTS rule 9

Rule 9's "secrets stay on the server" enumerates *our* secrets: the LiveKit API key/secret, the admin
token, scrypt password hashes — values the server owns and a client must never learn. A Matrix access
token is the mirror image: it is **the end user's own credential to a third-party service**, it is
useless to our server, and the client is precisely the party that must hold it in order to speak to
the homeserver. Element itself keeps it in browser storage for the same reason.

Rule 9's "personal data is keyed by the authenticated `userId`" governs data *the server stores*. We
store nothing server-side, so there is nothing to key — but we still honour the spirit by namespacing
the browser key with the authenticated `myUserId`, so two pixel-agents accounts sharing one browser
profile cannot see each other's Matrix session.

Storing it server-side would **add** risk, not remove it:
- it creates a new high-value credential store (one DB read ⇒ every user's Matrix account);
- it needs a new authenticated endpoint that, by definition, hands the token back to the browser —
  so an XSS in our bundle simply calls that endpoint. Server storage buys no XSS resistance
  whatsoever, it only widens the blast radius of a DB compromise;
- it puts a third-party credential under our operational duty of care for zero functional gain.

### Tradeoffs accepted

- **No cross-device sync.** Logging in on the desktop app and in the browser means two Matrix
  sessions/devices. Acceptable — this is also how Element behaves.
- **Shared/kiosk browsers retain the token until logout.** Mitigated by the prominent Sign-out
  button and by clearing on any `M_UNKNOWN_TOKEN`.
- **XSS in our bundle can exfiltrate it.** True, and unavoidable in any architecture (see above).
  Same-origin XSS already grants the attacker the pixel-agents session's full capability.
- Not using `sessionStorage`: the requirement is explicitly "session persisted across reloads".

### Logout behaviour (exact)

`Sign out` in the Matrix panel:
1. abort the in-flight `/sync` (`AbortController`) and stop the loop;
2. best-effort `POST /_matrix/client/v3/logout` with a 5 s timeout — failures are **ignored** (the
   local state must be cleared even if the homeserver is unreachable);
3. `localStorage.removeItem('pa-mx:<pa>')` (the pin key is a UI preference and is left alone);
4. drop all in-memory store state (rooms, timelines, member caches, directory results);
5. unpin the dock, return the panel to the **login** view and clear the unread badge/pip.

**Involuntary logout:** any CS-API response with `errcode: M_UNKNOWN_TOKEN` (or a login response with
`soft_logout: true`) runs steps 1 and 3–5 and shows the login view with the banner
*"Your Matrix session expired — sign in again."* The homeserver `logout` call is skipped (the token
is already dead).

**Pixel-agents logout does not touch Matrix storage** — the namespaced key simply stops being read by
the next (different) user. Deleting another user's namespaced key on logout would be surprising on a
shared machine and is not done.

### Desktop (Bearer-token client)

Nothing special. The `app://bundle` origin is registered `standard: true, secure: true`
(`desktop/src/main.ts:421-424`), so `localStorage` is stable and persistent across launches — the
same property `pa-zv-*` voice settings already rely on. No new `PixelDesktopApi` IPC, no
`safeStorage`, no changes to `desktop/`. The pixel-agents `Authorization: Bearer <sid>` token and the
Matrix `Authorization: Bearer <access_token>` are two unrelated credentials sent to two unrelated
origins; our layer never reads `serverHttpOrigin()` and never attaches a pixel-agents credential to a
homeserver request, nor vice versa.

*(Future, non-blocking: routing the token through `safeStorage` on desktop is a clean additive change
behind `isDesktop()`. Not in v1.)*

### Rejected alternatives

- **(b) Server-side per-user storage behind an authenticated endpoint** — rejected above. It would
  also require: two new HTTP handlers, two validators, a new `permissions.ts` capability
  (`matrix.credentials` scoped to self), CORS review for the desktop Bearer path, and a migration.
  All of it to end up handing the same token to the same browser.
- **(c) Both (server as the source of truth, localStorage as a cache)** — worst of both: the risk of
  (b) plus a two-writer consistency problem on logout.
- **Un-namespaced `matrix_access_token` (Element's own key name)** — collides across homeservers and
  across pixel-agents accounts on one profile. Explicitly rejected.

---

## 4. World-Model Boundary

**Statement.** Matrix is an *external service*. It is not world state.

- **No Colyseus.** No new `room.send(...)`, no new `onMessage` handler, no new state field. Matrix
  data never enters `OfficeState`, `EntitySync`/`CharacterSync`, or any `@pixel/schema` class. The
  Colyseus connection and the Matrix `/sync` connection never observe each other.
- **No shared schema.** No `@pixel/shared/schema` class, no engine type, no state field. The **only**
  `shared/` change in the whole feature is a five-line `CommandSpec` appended to
  `shared/src/commands.ts` (see below) — data, not logic, and it touches nothing the office engine
  reads.
- **`/matrix` is registered in `shared/src/commands.ts`, and handled client-side.** AGENTS.md is
  explicit: *"when you add a new destination … add a matching command in `commands.ts` and handle it
  — client-side via the shared `ChatUI` `clientCommand` hook for navigation"*, and it names
  `/admin-site` as the precedent. `/admin-site` **is** in the registry
  (`shared/src/commands.ts:81-86`) *and* handled through `clientCommand`
  (`OfficeScene.ts:3920-3927`) — an earlier draft of this document claimed the opposite and used it
  to justify `extraCommands`; that claim was wrong and the conclusion with it. Registering costs
  nothing server-side: `clientCommand` returns `true` before `sendCommand` ever runs, so a
  registered client-handled command never reaches `SimRoom.runCommand`. `ChatHooks.extraCommands` is
  **not** used.
- **No server change.** Zero new endpoints, zero new Colyseus messages ⇒ zero new validators and no
  new `permissions.ts` capability. AGENTS rule 7/9 ("every new handler needs a validator + a
  capability check in the same change") is satisfied vacuously because the change adds no handler.
  Server authority over positions, movement, collision, occupancy and interaction outcomes is
  untouched: nothing in this feature can move a character, occupy a station, or change a zone.
- **No second engine.** No renderer, no physics, no game loop. The panel is DOM over the Phaser
  canvas, like every other panel. `mmo-readiness` checks 1–3 are unaffected.
- **Naming discipline for `mmo-readiness` check 2.** That check greps `client/src` for
  `\b(os|officeState|state|sim)\.update\s*\(`. The Matrix store must therefore **never** expose a
  method named `update` on an object named `state`/`sim`/`os`/`officeState`. The store object is
  named `store` and its ingest method is `applySync(...)`. This is a hard naming rule, written down
  so nobody rediscovers it via a red CI run.

### Coexistence with the in-world ChatUI

Two chat surfaces in one app is a real UX hazard. It is resolved by naming, placement and focus:

| | Zone chat (`ChatUI`) | Matrix chat (this feature) |
|---|---|---|
| Name in UI | "Chat" | "**Matrix**" (top-bar label; panel title "Matrix") |
| Icon | 💬 bubble | ✉ |
| Placement | bottom-left overlay | right-docked panel, top bar |
| Scope | the current zone, ephemeral | your Matrix account, persistent |
| DOM | `#pa-chat` | `#pa-mx` inside `#pa-matrix-panel` |

The word "chat" is never used unqualified in the Matrix panel; rooms are "rooms", people are
"people". The two DOM trees are disjoint and neither imports the other.

**Focus / keystroke isolation** (four independent guards, all required):

1. The Matrix composer is a `<textarea>`. `ChatUI`'s Enter-to-focus global handler
   (`chatUI.ts:165-171`) already returns early when `document.activeElement.tagName` is
   `INPUT|TEXTAREA|SELECT`, so typing Enter in the composer can never focus the zone chat. This is
   also why the composer must **not** be a `contenteditable` div.
2. `OfficeScene`'s `canFocus` hook gains `&& !this.matrix?.ownsFocus()`, where `ownsFocus()` is
   `panelRoot.contains(document.activeElement)`. This covers the non-textarea controls in the panel
   (search field, buttons, room list) so Enter on a focused room-list row does not also open the zone
   chat.
3. All `keydown` handlers inside `#pa-mx` call `e.stopPropagation()` **for `Enter` and `Escape`
   only** — enough to keep those two keys out of `OfficeScene`'s window-level handler and out of
   `actionIframe.ts:74`'s window-level Escape (which would otherwise close an open iframe action)
   without swallowing browser shortcuts. **F8 is never intercepted** — the perf overlay keeps working
   with the panel open.
4. **`setupKeyboardMovement().blocked()` gains `|| this.matrix?.ownsFocus() === true`.**
   *Correcting an earlier draft:* the world is **not** click-to-walk only. `OfficeScene`
   (`:1363-1432`) registers window-level `keydown`/`keyup` for `KeyW/A/S/D` + the four arrows
   (`playerDir`), plus `KeyC` (sit) and `KeyM` (mic mute), each `preventDefault()`-ing. Its existing
   `blocked()` guard covers `INPUT|TEXTAREA|SELECT|contenteditable` — which catches the composer and
   every `.pa-input`, but **not a focused `<button>`**. Without guard 4, clicking a room row, a
   `.seg` tab or `📌` and then pressing an arrow key walks the avatar around underneath the panel.
   Accepted consequence, stated so it is not rediscovered as a bug: while focus is inside the Matrix
   panel, WASD/arrows/C/M do not move the avatar; clicking the canvas (or `Escape` out of the panel)
   restores them. `input.keyboard.enabled` is never touched — the arcade overlay remains the only
   thing that toggles it.

---

## 5. UX Specification

### 5.1 Placement and host integration

> **SUPERSEDED (placement only).** The panel is no longer a right-docked, pinnable popover: Matrix is
> now the **left** docked application window, Mumble the right one, with the game between them. There
> is no pin, no one-dock-at-a-time rule, and no `--pa-dock-w` / `body.pa-dock-pinned` / `.pa-docked`;
> `client/src/ui/dockWindow.ts` owns `--pa-dock-l` / `--pa-dock-r`, which inset `#game` alongside
> `--pa-side-panel-w`. See "Docked windows" in `docs/dev-notes.md`. Everything else in this section
> (the `viewerIdentity` gate, the lazy `ensureMatrix()` boot, `display:flex` over `block`, the
> `sessionStorage` restore across zone travel) still holds.

**A right-docked, pinnable panel in the Mumble mould.** Not an `--pa-side-panel-w` iframe dock:
that CSS variable is owned exclusively by `client/src/ui/actionIframe.ts` (set at :50, cleared at
:84) and shrinks `#game`; a second owner would fight it. The Mumble pin pattern already solves
"a second client that stays open while you walk around", and reusing it keeps one dock concept.

- **Top-bar button:** `this.mkBarBtn('✉', 'Matrix')`, `id="pa-matrix-btn"`, placed immediately after
  the Mumble button in `createHud()`. Click → `setMenu(currentMenu === 'matrix' ? null : 'matrix')`.
  **Disabled (`disabled = true`, `title="Connecting…"`) until the `viewerIdentity` message resolves
  the pixel user id** (§3 startup race); enabled in that handler.
- **Panel:** `this.mkPanel('Matrix', 'right')`, `panel.id = 'pa-matrix-panel'`. Its `.pa-x` close
  handler unpins first, then `setMenu(null)` — the exact pattern at `OfficeScene.ts:1962-1969`.
- **`MenuId`** gains `'matrix'` (`OfficeScene.ts:86`); `setMenu` gains a matrix branch, an `.active`
  toggle, and the same pin exemption Mumble has.
- **`display:flex`, not `display:block` — this is load-bearing.** `setMenu`'s generic `show()` helper
  writes `el.style.display = 'block'` (`OfficeScene.ts:1738-1740`), and `applyMumblePin()` forces
  `'block'` too (`:1785`). An inline style beats any stylesheet rule, so the flex-column geometry
  below would be silently defeated and the timeline would not size. The Matrix panel therefore does
  **not** go through `show()`: `setMenu` and `applyDock()` set
  `this.matrixPanel.style.display = visible ? 'flex' : 'none'` explicitly. (Chosen over rewriting
  `show()` to use `''` + an `.pa-open` class, because that would change the display semantics of
  eight existing panels for no benefit.)
- **One right dock at a time.** `applyMumblePin()` is generalised to `applyDock()`: it computes which
  (if any) panel is pinned, toggles `body.pa-dock-pinned`, sets `--pa-dock-w` on `document.body`,
  and adds `.pa-docked` to the pinned panel. **Pinning one unpins the other** — the right dock holds
  exactly one panel. Enforced in `OfficeScene` (the host), not in either child, matching how
  `setMenu` owns the one-panel rule.
- **`--pa-dock-w` is `panel width + 1.5rem`.** The existing `25.5rem` literal is
  `24rem` (`.pa-panel` width, `paSkin.ts:45`) `+ 0.75rem` (`.pa-panel.right`'s `right`, `:50`)
  `+ 0.75rem` gap. So: **Mumble `25.5rem`** (its panel is the stock 24 rem — `MumbleUI.ts` contains
  no width rule at all, so a "pinned Mumble dock" is just a 24 rem popover that stays open) and
  **Matrix `27.5rem`** (26 rem panel). An earlier draft used `26rem` for Matrix, which would have let
  other right panels overlap the dock by 0.75 rem. `applyDock()` sets the literal that matches the
  pinned panel; it does **not** measure `offsetWidth` (a hidden panel measures 0).
- **Pin state** persists in `localStorage` under `pa-mx-pinned` (`'1'`/`'0'`), mirroring
  `pa-mb-pinned` (`MumbleUI.ts:74`). Like `MumbleUI.isPinned`, `MatrixUI.isPinned` returns `false`
  when there is no live session, so the host never keeps an empty dock on screen.
- **Panel geometry:** unpinned, the standard 24 rem popover with
  `height:min(36rem, calc(100vh - 4.7rem))`. Pinned, `width:26rem;
  height:calc(100vh - 4.7rem)`. In both cases the panel itself does **not** scroll
  (`overflow:hidden; display:flex; flex-direction:column`), its `.pa-body` is
  `flex:1; min-height:0; display:flex; flex-direction:column; overflow:hidden`, and the scrolling
  happens inside the room list or the timeline. This overrides `.pa-panel`'s own
  `overflow-y:auto` and is scoped by `#pa-matrix-panel`.
- **Zone travel is a full page reload.** `goToZone()` (`OfficeScene.ts:3548-3735`) does
  `history.replaceState` + `reloadApp()`, so portaling tears the panel down and re-runs an initial
  `/sync` on arrival. The Mumble pin pattern gives "stays open while you *walk around*", not "stays
  open across zones" — nothing can, short of moving the panel out of the page, which is out of
  scope. Mitigations, all cheap:
  - `sessionStorage['pa-mx-view']` = `{ view, roomId }` written on every view change and restored on
    boot, so the panel reopens on the room you were reading;
  - `sessionStorage['pa-mx-draft:<roomId>']` holds the unsent composer text per room;
  - the pinned state (`localStorage`) already survives, so a pinned dock re-pins itself, boots the
    chunk, and restores the session — this is the one place the panel loads without a click.
- **Slash command:** `/matrix [@user:server]` — `{ name:'matrix', group:'user',
  usage:'/matrix [@user:server]', summary:'Open the Matrix chat panel (optionally start a direct
  chat).' }` appended to `COMMANDS` in `shared/src/commands.ts`, and handled in `OfficeScene`'s
  `clientCommand` branch: with no argument it opens the panel; with an argument matching
  `/^@[^:\s]+:[^:\s]+$/` it opens the panel and runs the open-or-create-DM flow for that MXID;
  with any other argument it replies *"Usage: /matrix [@user:server]"* via `sys()`. Before
  `viewerIdentity` has arrived it replies *"Still connecting — try again in a moment."*. Registering
  it in the shared registry is what makes it appear in `/help` and TAB-completion (§4).

### 5.2 View router

One root `<div id="pa-mx" class="pa-ui">` inside the panel's `.pa-body`, containing a persistent
**status strip** + a **view stack**. Exactly one `<section data-view="…">` is visible at a time:

```
login | rooms | room | members | newdm | newgroup | join
```

Navigation is a small explicit stack (`rooms` is the root; `room` pushes; `members` pushes on top of
`room`). Back is `◀` in each sub-view's sub-header and Escape (see 5.7).

### 5.3 Views

#### `login` (logged-out)

```
[grouplbl] HOMESERVER
[.pa-input#hs   placeholder "https://matrix.org"  spellcheck=false]
[.muted] Enter your homeserver's address. HTTPS required.
[grouplbl] ACCOUNT
[.pa-input#user placeholder "user"      autocomplete=username]
[.pa-input#pw   type=password           autocomplete=current-password]
[.pa-b.primary.wide#signin] Sign in
[.mx-err]  (hidden unless set)
```
- On submit: **normalise and validate the typed value**, run well-known discovery, **normalise and
  validate the discovered value with the identical function**, then `GET /versions`,
  `GET /login` flows, then `POST /login` with `initial_device_display_name: "pixel-agents"`.
- **`normaliseHomeserverUrl(raw): { baseUrl, origin } | { error }`** — one function, applied to *both*
  the typed input and `m.homeserver.base_url`. It: trims; prefixes `https://` if the value has no
  scheme; parses with `new URL()` (parse failure → *"That doesn't look like a server address."*);
  **rejects any scheme other than `https:`, and `http:` only when the hostname is exactly
  `localhost`, `127.0.0.1` or `[::1]`** — message *"HTTPS is required; this page is served over a
  secure connection."*; strips any query/hash; strips a trailing `/`. Returns the base URL and the
  lowercased `scheme://host[:port]` origin.
  - **Why the discovered value gets the same treatment:** `/.well-known/matrix/client` is a
    third-party JSON document. Trusting `m.homeserver.base_url` blindly would let a typo'd or hostile
    well-known redirect every subsequent request — *including the one carrying the access token* — to
    an `http://` or unrelated host. The token-URL assertion in `api.ts` (Security Considerations) is
    no defence on its own, because `hsBaseUrl` would *be* the attacker-supplied value. Validating it
    here is the actual control.
  - **The resolved origin is shown before credentials are submitted.** When discovery resolves to an
    origin different from what the user typed, the form shows
    `.muted` → *"Signing in to `<resolved origin>`"* under the homeserver field, and the Sign-in
    button is only armed after that line has rendered (it re-renders on `blur`/`change` of the
    homeserver field via a debounced discovery probe; a failed probe leaves the typed origin, which
    is then used verbatim).
- Button shows a `Signing in…` label and is disabled for the duration; the whole form is disabled.
- If `m.login.password` is absent from the flows: the form is replaced by
  *"This homeserver requires single sign-on, which this client does not support yet."*

#### `rooms` (room list — the root view)

```
[#pa-mx-top]  ● <status>   @me:server            [📌 pin] [⎋ sign out]
[.pa-seg]     [ People (n) ][ Groups (n) ][ Invites (n) ]
[.pa-input.mx-filter  placeholder "Filter rooms…"]
[#pa-mx-list]  ← the only scrolling element in this view
   .pa-list-row.mx-room[.unread][.here]
       .mx-av         2.1rem square, initials, deterministic tint
       .nm            room / person name (ellipsis, title=full)
       .mx-prev       last message preview, one line, dim
       small          relative time
       .mx-badge      unread count (hidden when 0; .hl when highlight_count>0)
[foot]  [.pa-b.wide.primary  ✚ New chat] [.pa-b  ⊞ New group] [.pa-b  ⇥ Join room]
```
- **DM classification (`MxRoom.isDirect`).** A room is *People* if **any** of:
  1. its room id appears in the `m.direct` account-data map; **or**
  2. our own `m.room.member` event for that room (state_key = our MXID, from `state`/`timeline`, or
     from the stripped `invite_state` for invites) carried `content.is_direct === true`; **or**
  3. `summary['m.joined_member_count'] + summary['m.invited_member_count'] <= 2`.

  **Groups** = every other joined room. **Invites** = `rooms.invite` from `/sync`; the tab is hidden
  entirely when the count is 0.

  *Correcting an earlier draft:* it claimed `m.room.create` "carried `is_direct`". It does not —
  `is_direct` is a field on the **`m.room.member` invite event content** (and on the `createRoom`
  *request*), never on `m.room.create`. It also required "≤2 joined members", which is not derivable
  from a lazy-loaded sync's member events; `summary` (rule 3) is where that number actually comes
  from. Both clauses are replaced above.
- **Row name** comes from `roomDisplayName(room)` in the [Sync contract](#sync-contract) — never the
  raw room id unless every fallback is exhausted.
- Sort: rooms with unread first, then by last event timestamp desc.
- The filter is a plain case-insensitive substring match on the display name and, for People, on the
  hero MXIDs.
- Invite rows replace the badge with two inline buttons: `[.pa-b.primary Accept] [.pa-b.danger Decline]`.
  **Accept** → `POST /rooms/{roomId}/join`, and **if the invite's `m.room.member` for us had
  `content.is_direct === true`, merge `{ inviterMxid: [roomId] }` into `m.direct`** (read-modify-write,
  Sync contract) after the join succeeds — otherwise an accepted DM would sit in Groups forever,
  since nothing else ever writes the map for an inbound DM. **Decline** → `POST /rooms/{roomId}/leave`.
  Both buttons disable while in flight; failure shows `.mx-err` inline in the row and re-enables.

#### `room` (open room)

```
[.mx-subhead]  [◀]  <room name> [🔒]      [.pa-b 👥 n]
[.mx-notice]   (only when encrypted / degraded)
[#pa-mx-tl]    ← scrolls; flex:1
   [.mx-more]  "Load earlier messages" / spinner / "Beginning of the room"
   .mx-day     date separator ("Today", "Yesterday", "12 Mar")
   .mx-grp     one sender group
      .mx-grp-head   .mx-av + sender display name + relative time
      .mx-msg        one message (repeatable)  [.pending|.failed|.enc|.notice|.emote]
         .mx-txt     escaped + linkified body
         .mx-retry   (only .failed) "Failed — Retry"
[.mx-composer] [textarea.pa-input.mx-input rows=1 auto-grow to 5]  [.pa-b.primary ➤]
```

#### `members`

`◀` back to the room; then `[grouplbl] MEMBERS (n)` listing `membership:"join"` as `.pa-list-row`
(avatar-initials, display name, `small` = MXID); then — **only when non-empty** —
`[grouplbl] INVITED (n)` listing `membership:"invite"` rows at `opacity:.7` with `small` =
`"invited"`; then `[grouplbl] INVITE`,
`[.pa-input placeholder "@user:server"] [.pa-b.primary Invite]`, then `[.pa-b.danger.wide Leave room]`
behind **`confirmDialog(message, { danger: true, confirmLabel: 'Leave' })`** from
`client/src/ui/dialog.ts`. (The exports are `confirmDialog` / `alertDialog` / `promptDialog` /
`textLabelDialog` / `passwordPromptDialog` — there is no `confirm()`.)

- Source: `GET /rooms/{roomId}/members?membership=join&membership=invite`, refetched on entry and
  after a successful invite. **A successful invite must make the invitee appear immediately** — this
  is why `/joined_members` (join-only) is not used.
- Invite input validates `/^@[^:\s]+:[^:\s]+$/` client-side before sending; `M_FORBIDDEN` →
  *"You don't have permission to invite people to this room."*; `M_NOT_FOUND`/unknown user →
  *"No such user on that server."*
- **Kept as its own view rather than a collapsible section inside `room`** (an alternative the review
  raised): the room view's flex column is `subhead / notice / timeline(flex:1) / composer`, and
  expanding a member list inside it would resize the timeline viewport mid-read — precisely the
  viewport-yank the timeline rules exist to prevent. One extra stack level is the cheaper cost.

#### `newdm`

`◀` back; `[.pa-input placeholder "Search people or paste @user:server"]`; results as
`.pa-list-row` (avatar-initials, display name, `small` MXID) with a trailing `[.pa-b Chat]`.
- Debounce 300 ms; `POST /user_directory/search {limit:20}`.
- If the input matches `/^@[^:\s]+:[^:\s]+$/`, that MXID is always offered as the first row
  ("Start a chat with @x:y") even when the directory returns nothing — a directory can be
  disabled or scoped, and a raw MXID must always work (FR-4).
- Choosing a person: if an existing DM room with exactly that person is known, open it;
  otherwise `createRoom {is_direct:true, preset:'trusted_private_chat', invite:[mxid]}` and then
  merge the new room into `m.direct` — **read-modify-write against a fresh
  `GET …/account_data/m.direct` (404 ⇒ `{}`), never against a possibly-truncated sync value**
  (Sync contract). Overwriting the map would destroy every other DM association the user has.

#### `newgroup`

`◀` back; `[.pa-input Name]`; `[.pa-seg [Private][Public]]`; `[.muted]` one line explaining the
difference; `[.pa-b.primary.wide Create]`.
Private → `preset:'private_chat', visibility:'private'`. Public → `preset:'public_chat',
visibility:'public'` plus an optional `[.pa-input Address (optional)  #alias]` mapped to
`room_alias_name`.

#### `join`

`◀` back; `[.pa-input placeholder "#room:server (or !roomid:server via.example.org)"]`;
`[.pa-b.primary.wide Join]`; `[.muted]` *"An address like `#room:server` is enough. A raw room id
also needs the server to route through, separated by a space."*

- **Alias input** (`/^#[^:\s]+:[^:\s]+$/`) → `POST /join/{alias}` with no extra parameters. This is
  the documented happy path.
- **Raw room id** (`/^![^:\s]+:[^:\s]+$/`) → `POST /join/{roomId}?server_name=<via>`. A bare
  `!roomid:server` over federation fails `M_NOT_FOUND` without a routing server, so the input
  accepts `!id:server via.example.org` (space-separated); if no `via` is given, the room id's own
  domain is used as `server_name` and, on `M_NOT_FOUND`, the error copy says
  *"No such room — a room id usually also needs the server to join through, e.g.
  `!abc:example.org matrix.org`."*
- Errors: `M_FORBIDDEN` → *"You are not invited to that room, and it is not public."*;
  `M_NOT_FOUND` → as above; `M_UNKNOWN` / anything else → the homeserver's `error` string, escaped
  and rendered with `textContent`.
- **Accepting an invite does not go through this view** — it uses `POST /rooms/{roomId}/join`
  from the invite row (§`rooms`), which needs no routing server.

### 5.4 Classes and tokens

**Reused verbatim from `paSkin.ts`:** `.pa-ui`, `.pa-panel` + `.pa-head`/`.pa-body`/`.pa-x`,
`.pa-seg` + `.seg`/`.seg.on`, `.pa-input`, `.pa-b` (+`.primary`/`.danger`/`.wide`),
`.pa-list-row` + `.nm`/`small`, `.grouplbl`, `.muted`, `.pa-btn` (top bar).
(`.pa-chip` and `.pa-select` were listed in an earlier draft and appear in no view — dropped, so the
list is a checkable claim rather than a wish.)

**New CSS lives in exactly two places:**

1. **`client/src/matrix/matrixSkin.ts`** — one idempotent injected `<style id="pa-mx-style">`
   (the `MumbleUI.injectStyles()` / `ZoneVoiceUI` `pa-zv-style` pattern), every selector scoped under
   `#pa-mx` or `#pa-matrix-panel` or `#pa-matrix-btn`. It ships inside the lazy chunk. New classes,
   with their mandated tokens:

   | Class | Purpose | Tokens |
   |---|---|---|
   | `#pa-mx-top` | account/status/pin row | bg `#242220`, border `2px solid #0a0908`, bevel `inset 0 2px 0 #4a4744, inset 0 -3px 0 #050505`, radius `0.45rem` |
   | `.mx-dot` / `.mx-dot.live` / `.mx-dot.warn` / `.mx-dot.off` | connection status | `#525556` / `#5aa348`+glow / `#a86a2e` / `#7c2634` |
   | `.mx-av` | 2.1rem initials square | bg deep-inset `#141312`, border `2px solid #0a0908`, radius `0.35rem`, text `#f1efec`. **Tint = `box-shadow: inset 0 0 0 2px <c>` where `<c>` is picked from the existing accent set only** — `#c51a1b #7c2634 #a86a2e #5aa348 #4998c0 #e7da00 #37342f #818586` — indexed by a stable hash of the MXID. No new hues: an earlier draft said "a fixed 8-colour set derived from the MXID hash", which is a palette expansion and would make the panel *not* indistinguishable from the rest of the chrome (FR-6). |
   | `.mx-room.unread .nm` | unread room name | `#f5f3f0`, `font-weight:600` |
   | `.mx-badge` / `.mx-badge.hl` | unread count | `#37342f` text `#adb0b2` / `#c51a1b` text `#fff` with `inset 0 2px 0 #e2585a, inset 0 -3px 0 #5c0f10` |
   | `.mx-prev` | last-message preview | `#818586`, `0.8rem`, single-line ellipsis |
   | `.mx-subhead` | in-room header | border-bottom `2px solid #0a0908`, `inset 0 -1px 0 #2c2a28` |
   | `#pa-mx-list`, `#pa-mx-tl` | scroll containers | `overflow-y:auto; overscroll-behavior:contain; flex:1; min-height:0`. **`#pa-mx-tl` and its `.mx-day`/`.mx-grp`/`.mx-gap` children additionally set `overflow-anchor:none`** — both Chrome and Firefox implement CSS scroll anchoring and would adjust `scrollTop` on prepend with *different* heuristics, compounding with our own restore and producing a jump in one engine but not the other (a rule-8 bug by construction). |
   | `.mx-day` | date separator | `#818586`, `0.72rem`, uppercase, `1px solid #2c2a28` rules |
   | `.mx-grp-head` | sender line | name `#f0eeea`, time `#818586 0.78rem` |
   | `.mx-msg .mx-txt` | message body | `#f1efec`, `0.95rem`, `line-height:1.5`, `white-space:pre-wrap`, `overflow-wrap:anywhere` |
   | `.mx-msg.pending` | local echo in flight | `opacity:.55` |
   | `.mx-msg.failed` | send failed | text `#f6cdd4`, left border `3px solid #7c2634` |
   | `.mx-msg.enc` | encrypted placeholder | `#818586`, italic-equivalent (the pixel font has no italic → use `opacity:.75` + the 🔒 prefix, never `font-style`) |
   | `.mx-msg.notice` / `.mx-msg.emote` | `m.notice` / `m.emote` | `#adb0b2` / `#adb0b2` with `* ` prefix |
   | `.mx-notice` | room-level banner | bg `#262422`, border `2px solid #0a0908`, text `#adb0b2` |
   | `.mx-err` | error line | `#f6cdd4` on `#7c2634` bevel `inset 0 2px 0 #b34a5a, inset 0 -3px 0 #45111a` |
   | `.mx-composer` | composer row | top border `2px solid #0a0908`, bg `#1c1a19` |
   | `.mx-input` | textarea | inherits `.pa-input`; adds `resize:none; line-height:1.5; max-height:7.5rem` |
   | `.mx-link` | linkified URL | `#4998c0` |
   | `.mx-gap` | "messages may be missing" marker after a gappy sync | `#a86a2e`, `0.78rem`, centred, `1px solid #2c2a28` rules either side, with a `.pa-b` `Load` affordance |
   | `.mx-toast` | transient notice inside the panel | absolutely positioned bottom-centre of `#pa-mx`, bg `#242220`, border `2px solid #0a0908`, bevel `inset 0 2px 0 #4a4744, inset 0 -3px 0 #050505`, text `#f1efec`, radius `0.45rem`, auto-dismiss after 4 s, dismissible on click, `role="status"`. **This is the "toast" the rest of the document refers to** — no toast helper exists in the client, so `MatrixUI` owns exactly one `toast(msg: string): void` method and this one class. Modal confirmations use `confirmDialog`, not this. |
   | `#pa-matrix-btn .mx-badge` | top-bar unread pip | `#c51a1b`, absolutely positioned top-right of the `.pa-btn` |

   Text that must render emoji falls back beyond the pixel font:
   `font-family:'FS Pixel Sans',ui-monospace,'Noto Color Emoji','Apple Color Emoji','Segoe UI Emoji',monospace`
   on `.mx-txt`, `.nm` and `.mx-prev` only — the pixel font has no emoji glyphs and would otherwise
   show tofu.

2. **`client/src/ui/paSkin.ts`** — **one rule changed**, the generalised dock rule replacing the
   Mumble-specific one at :54-56:
   ```css
   /* A pinned right dock (Mumble or Matrix) keeps its column; the other
      right-hand popovers step aside for it. --pa-dock-w is the pinned panel's
      width + 1.5rem (its own 0.75rem `right` offset + a 0.75rem gap) and is set
      by applyDock() in OfficeScene: 25.5rem for Mumble's stock 24rem panel,
      27.5rem for the 26rem Matrix panel. Only where there is room — on a narrow
      window they overlap as before rather than being pushed off-screen. */
   @media (min-width: 56rem) {
     body.pa-dock-pinned .pa-panel.right:not(.pa-docked){
       right:calc(var(--pa-dock-w, 25.5rem) + var(--pa-side-panel-w, 0px));
     }
   }
   ```
   The default in the `var()` fallback keeps Mumble's historical behaviour if `--pa-dock-w` is ever
   unset. No other paSkin change. `#pa-menubar`'s existing `--pa-side-panel-w` handling is untouched; the
   menubar deliberately does **not** step aside for a pinned dock today and this design does not
   change that behaviour.

The deprecated palette (`#14161c`, `#3a6df0`, `1px` chrome borders, flat `0 8px 0` shadows) appears
nowhere. Every border on new chrome is `2px solid #0a0908`.

### 5.5 Empty / loading / error / offline / reconnecting states

A persistent **status strip** (`.mx-dot` + one word) sits in `#pa-mx-top` and is the single source of
truth about the connection:

| State | Dot | Label | Trigger | Behaviour |
|---|---|---|---|---|
| Connected | `.live` (`#5aa348`) | `Connected` | a `/sync` returned within the last 60 s | normal |
| Syncing | `.warn` | `Syncing…` | initial sync in flight | list shows 3 skeleton rows |
| Reconnecting | `.warn` (`#a86a2e`) | `Reconnecting… 4s` | sync failed; backoff countdown | live countdown, `[Retry now]` link |
| Offline | `.off` (`#7c2634`) | `Offline` | `navigator.onLine === false` or 3 consecutive failures | sync paused; resumes instantly on `window online` |
| Signed out | `.mx-dot` grey | — | no session | `login` view |

Per-surface states:

- **Room list empty:** *"No rooms yet."* + `✚ New chat`.
- **Filter matches nothing:** *"No rooms match “x”."*
- **Timeline loading:** the `.mx-more` slot shows `Loading…`; the timeline area itself shows three
  dim skeleton groups on first open of a room.
- **Timeline empty:** *"No messages yet — say hello."* (or the encrypted notice, §2.6).
- **Back-pagination exhausted:** *"Beginning of the room."*, `.mx-more` becomes non-interactive.
- **Timeline load failed:** *"Could not load messages."* + `[Retry]`.
- **Send failed:** the echo row goes `.failed` with an inline `Retry` — the text is **never** lost
  and never silently dropped. Retry reuses the same transaction id (idempotent by spec).
- **Rate limited (429):** `.mx-toast` *"Slow down — retrying in Ns"*; the pending action auto-retries
  once after `retry_after_ms`.
- **Gappy sync while scrolled up:** a `.mx-gap` marker *"— messages may be missing —"* with a `Load`
  button, rather than wiping what the user is reading (Sync contract).
- **CORS / network failure at login:** *"Could not reach `<host>`. Check the address — the homeserver
  may also be refusing requests from this app (CORS)."* This is the single most likely deployment
  failure (A-1) and it must name CORS, because "network error" would send the user hunting the wrong
  problem.
- **Any `M_UNKNOWN_TOKEN`:** involuntary logout, §3.

### 5.6 Timeline rendering rules

- **Only `m.room.message` and `m.room.encrypted` are rendered.** Reactions, receipts, state changes,
  typing, redaction events and everything else are consumed for bookkeeping and **not** drawn —
  never as unlabelled junk rows.
- **Grouping:** consecutive events from the same sender within 5 minutes and not crossing a day
  boundary form one `.mx-grp` under a single sender header.
- **Timestamps:** relative — `now`, `3m`, `2h`, `Mon 14:32` (<7 days), `12 Mar`. A single
  60-second interval re-renders visible group headers; it is cleared when the panel is not pinned and
  hidden. Absolute time is always available in the `title` attribute.
- **Redacted** (`unsigned.redacted_because`): *"(message deleted)"*, dim.
- **Edits** (`m.replace`): the relation is ignored; the fallback body (which the spec defines as
  `* <new text>`) renders as an ordinary message. Zero code, honest output.
- **`formatted_body` HTML is ignored** — the plain `body` is escaped then linkified
  (http/https only, escape-per-segment).
- **Non-text msgtypes:** `m.image`/`m.file`/`m.audio`/`m.video` render as
  *"📎 `<filename>` (not supported in this client)"* — labelled, not blank.
- **DOM cap: a hard 400 message elements, always enforced.** Trim from the *far* end relative to the
  user's position: when at the bottom, drop from the top; when scrolled up (i.e. after
  back-pagination), drop from the bottom, keeping the read position stable. An earlier draft only
  trimmed "when the user is scrolled to the bottom", which means a user who scrolls up in a busy
  room and walks away grows the DOM without bound. Trimming adjusts `scrollTop` by the removed
  height in the same frame so the viewport never yanks.
- **Scroll anchoring:** append sticks to the bottom only if already within 24 px of the bottom.
- **Back-pagination scroll restore, synchronously, in one frame:** read `scrollHeight` → insert the
  prepended nodes → set `scrollTop += (newScrollHeight - oldScrollHeight)`. **Not** from a
  `requestAnimationFrame` callback, and with `overflow-anchor:none` on the container and its
  children (§5.4) so the browser's own scroll anchoring does not add a second, engine-specific
  correction on top of ours.
- **Incremental diff:** rows live in a `Map`, updated in place, and are ordered with an
  `applyOrder`-style helper ported from `MumbleUI.ts:545-559` — nodes already in the right place are
  never removed and re-inserted, so selection and focus survive updates.
- **Row key resolution order (this exact order — duplicates are otherwise the normal case, not an
  edge case):**
  1. `unsigned.transaction_id` matches a pending echo → **replace that echo row in place**;
  2. `event_id` matches an existing row → update in place;
  3. otherwise → new row, inserted by `origin_server_ts` then `event_id`.

  Synapse routinely delivers an event down `/sync` *before* the `PUT` response returns, so at that
  moment no `txnId → event_id` mapping exists yet and an `event_id`-only match cannot fire. That is
  exactly what `unsigned.transaction_id` is for; it must be the **primary** key, and `MxEvent` must
  carry it.

#### Remote-content rule (hard requirement, not a guideline)

> **No remote string may ever be interpolated into an `innerHTML` string, a `title`, an
> `aria-label`, an `href`, or a `style`.** Remote text is assigned with `el.textContent = x` or
> `el.title = x` (the property assignment, never a template). `innerHTML` may only ever receive a
> first-party literal template with **no** interpolation of remote data.
>
> **The single exception** is `.mx-txt.innerHTML = linkify(body)`.

"Remote" means: message bodies, display names, room names and topics, MXIDs, aliases, filenames,
and homeserver `error` strings — every string that came off the network.

`esc()` and `linkify()` are **copied verbatim from `chatUI.ts:333-355`** into
`client/src/matrix/timeline.ts`, because they are module-private there and this feature must not
repurpose zone-chat's module. Two notes on the copy:

- add `'` → `&#39;` to `esc()`'s character class, so the helper is safe under single-quoted
  attributes too (the original is safe only because `linkify`'s one attribute is double-quoted);
- do not otherwise change it — the escape-per-segment structure is what makes `javascript:`/`data:`
  unreachable.

`MumbleUI.build()` is cited elsewhere in this document as the structural precedent (one root, refs
via `querySelector`, incremental row updates). **Its `innerHTML`-template style is explicitly *not*
the precedent for any row that carries remote data** — a room-name interpolation written that way is
stored XSS. Build such rows with `createElement` + `textContent`.

### 5.7 Keyboard

| Key | Context | Behaviour |
|---|---|---|
| `Enter` | composer | send (if non-empty and the room is sendable); `preventDefault` + `stopPropagation` |
| `Shift+Enter` | composer | newline; textarea auto-grows to 5 rows then scrolls |
| `Escape` | composer focused | blur the composer, keep the panel open; `stopPropagation` |
| `Escape` | panel focused, sub-view | pop one view (`members`→`room`, `room`→`rooms`, `newdm`/`newgroup`/`join`→`rooms`) |
| `Escape` | panel focused, `rooms` view | unpin + `setMenu(null)` (the same thing `.pa-x` does) |
| `Enter` | anywhere else | unchanged — zone chat focuses, exactly as today |
| `Tab` | inside panel | natural DOM order; the composer is the last stop in the `room` view |

The three isolation guards in §4 are what make row 6 true. Nothing in this panel calls
`input.keyboard.enabled = false`; the arcade overlay remains the only thing that does.

### 5.8 Readability / accessibility

- Sender grouping (5.6) plus a 0.55rem gap between groups is what makes a pixel-font timeline
  scannable; per-message avatars are deliberately not repeated.
- **Long messages:** `white-space:pre-wrap; overflow-wrap:anywhere` — no horizontal scroll ever
  appears in the timeline. A URL longer than the panel wraps mid-token.
- **Long room names / display names:** single-line ellipsis with the full value in `title`.
  Names are never truncated in the room *header*; it wraps to at most two lines there.
- **Unicode / emoji:** the extended font stack in 5.4. Emoji render at the surrounding font size;
  no scaling hacks. RTL text is left to the browser (`dir="auto"` on `.mx-txt` and `.nm`).
- **Contrast:** body text `#f1efec` on `#1c1a19` and dim `#818586` for metadata only — never for
  message content.
- **Live region, scoped so it does not spam.** `#pa-mx-tl` gets `role="log"` but **`aria-live="off"`
  by default**. A polite live region on the whole scroller would announce ~30 prepended nodes as new
  arrivals on every back-pagination, and re-announce every echo→event replacement. Instead:
  - the *newest* group container carries `aria-live="polite"`, so genuinely new incoming messages are
    announced and nothing else is;
  - during back-pagination the prepended block is inserted with `aria-busy="true"` on `#pa-mx-tl`,
    cleared after the scroll restore;
  - echo→event replacement mutates an existing node inside a non-live subtree, so it is silent.
- Buttons get `aria-label`s and the unread badge gets `aria-label="N unread"` — **assigned as
  properties from already-escaped-by-assignment values, never built by string interpolation into
  markup** (§5.6 remote-content rule). Focus outlines are not suppressed.
- Avatars are initials, not images (see [Scope Fence](#7-scope-fence)) — deterministic, instant, and
  free of the authenticated-media problem.

---

## 6. File Plan

### New files — `client/src/matrix/`

| File | Responsibility (one line) | ~LoC |
|---|---|---|
| `types.ts` | All CS-API payload types and the internal view models (`MxRoom` — including `summary`-derived `heroes`/`joinedCount`/`invitedCount`/`isDirect`/`encrypted`, `MxEvent` — including `unsigned.transaction_id`, `MxMember`, `MxSession`). Imports nothing. Contains exactly **two** runtime exports — the `MatrixError` class and the `PA_GAP_TYPE` constant; everything else is `interface`/`type`. | 170 |
| `api.ts` | `MatrixApi`: stateless `fetch` wrapper over the [endpoint table](#api-surface-used), with `MatrixError` normalisation, 429 handling, `AbortSignal` support, the validated-origin URL assertion and `redirect:'error'` on authenticated calls. | 240 |
| `session.ts` | `normaliseHomeserverUrl` (applied to typed *and* discovered URLs), well-known discovery, login-flow probe, login/logout, and the per-pixel-user `localStorage` credential store (§3) including restore and involuntary-logout clearing. | 170 |
| `sync.ts` | The `/sync` long-poll loop (filter, `since`, backoff, offline handling) and `MatrixStore` — rooms, `summary` ingest + `roomDisplayName`, DM classification, invites, unread counts, capped per-room timeline windows with gap markers, `applySync()`, back-pagination, optimistic send + `transaction_id` reconciliation, read-modify-write `m.direct`, and a tiny typed emitter. **No DOM.** | 520 |
| `matrixSkin.ts` | The single idempotent `<style id="pa-mx-style">` injection (§5.4 table). | 150 |
| `timeline.ts` | Keyed, diffing timeline renderer: grouping, day separators, relative time, the copied `esc`/`linkify`, encrypted/redacted/unsupported placeholders, gap markers, scroll anchoring + synchronous prepend restore, hard DOM cap, pagination trigger. | 340 |
| `MatrixUI.ts` | The panel root and view router: `login`, `rooms`, `room`, `members`, `newdm`, `newgroup`, `join`; status strip; pin button; composer; `toast()`; keyboard rules; `sessionStorage` view/draft restore; exposes `isPinned`, `ownsFocus()`, `openDm(mxid)`, `destroy()`. | 680 |
| `index.ts` | `createMatrixClient(mount, hooks): MatrixClientHandle` — the one and only dynamic-import entry point; wires skin + session + sync + UI. | 60 |

Nothing under `client/src/matrix/` may be statically imported from outside that directory.
`index.ts` is the sole export surface.

### Existing files touched — the single integration step

| File | Minimal edit |
|---|---|
| `client/src/scenes/OfficeScene.ts` | (1) `MenuId` += `'matrix'` (:86). (2) Fields `matrixBtn`, `matrixPanel`, `matrix?: MatrixClientHandle` (type-only `import('../matrix/index.js')`), `identityResolved = false`. (3) `createHud()`: `mkBarBtn('✉','Matrix')` with `id='pa-matrix-btn'` (initially `disabled`) + `mkPanel('Matrix','right')` with `id='pa-matrix-panel'`, `.pa-x` → unpin then `setMenu(null)`. (4) `setMenu()`: an explicit matrix branch using `display:'flex'` (**not** the generic `show()`, which writes `'block'` and would defeat the flex column) behind the pin exemption + `.active` toggle. (5) `applyMumblePin()` → `applyDock()`: `body.pa-dock-pinned`, `--pa-dock-w` (25.5rem Mumble / 27.5rem Matrix), `.pa-docked`, one-dock-at-a-time, `display:'flex'` for a pinned Matrix panel. (6) Lazy boot `ensureMatrix()`: `await import('../matrix/index.js')` on first open or `/matrix`; no idle autostart. (7) `clientCommand` branch for `matrix` (the spec itself lives in `shared/src/commands.ts`; **no** `extraCommands`). (8) `canFocus` += `&& !this.matrix?.ownsFocus()`. (9) `setupKeyboardMovement().blocked()` += `|| this.matrix?.ownsFocus() === true`. (10) `viewerIdentity` handler: `identityResolved = true`, enable `matrixBtn`, and if `localStorage['pa-mx-pinned'] === '1'` boot the chunk. (11) Lifecycle: call `this.matrix?.destroy()` from the scene's shutdown/`beforeunload` path (the same place other UI teardown happens) — nothing else owns it. |
| `client/src/ui/paSkin.ts` | Replace the `body.pa-mumble-pinned … :not(#pa-mumble-panel)` rule (:54-56) with the generalised `body.pa-dock-pinned … :not(.pa-docked)` + `--pa-dock-w` rule (§5.4). |
| `shared/src/commands.ts` | Append one `CommandSpec`: `{ name:'matrix', group:'user', usage:'/matrix [@user:server]', summary:'Open the Matrix chat panel (optionally start a direct chat).' }`. Data only; no server-side execution branch is needed or added, because `clientCommand` returns `true` before `sendCommand` runs (§4). |

**Not touched, by design:** `client/src/voice/MumbleUI.ts` (the host owns the body class, so the pin
generalisation needs no child change — and its panel width is unchanged, so `25.5rem` still holds),
`client/src/ui/chatUI.ts`, `shared/**` *other than the one `commands.ts` entry*, `server/**`,
`desktop/**`, `client/package.json`, `pnpm-lock.yaml`, `pnpm-workspace.yaml`, `vite.config.ts`,
`client/index.html`.

### Disjoint ownership for parallel implementers

`types.ts` is a **contract written first** (by the integrator, from this document) and then frozen;
everyone imports it and nobody else edits it. After that, four workstreams touch disjoint files:

| Agent | Owns | Depends on |
|---|---|---|
| **A — transport** | `api.ts`, `session.ts` | `types.ts` |
| **B — state** | `sync.ts` | `types.ts`, `api.ts` *interface* |
| **C — presentation** | `matrixSkin.ts`, `timeline.ts` | `types.ts` |
| **D — views** | `MatrixUI.ts`, `index.ts` | `types.ts` + the three interfaces above |
| **E — integration (last, alone)** | `OfficeScene.ts`, `paSkin.ts`, `shared/src/commands.ts` | A–D merged |

Only agent E edits pre-existing files; A–D create new files exclusively. No two agents share a file.

### Sync contract

Written here so B and D agree without negotiating.

**Filter** (inline, URL-encoded):

```json
{"room":{"state":{"lazy_load_members":true},"timeline":{"limit":20}},
 "presence":{"not_types":["*"]},
 "account_data":{"types":["m.direct"]}}
```

- `presence` uses `"not_types":["*"]` — the documented way to drop an event category. `"limit":0` is
  not: `Filter.presence` is an `EventFilter`, and a server may treat `0` as unset.
- `account_data` uses a **type allowlist, not a limit**. An earlier draft used `{"limit":10}`; a real
  account has `m.push_rules`, `m.secret_storage.*`, `m.cross_signing.*`, `im.vector.setting.*`,
  `m.identity_server`, … so a limit of 10 can silently truncate `m.direct` away — and the People tab
  and every DM write depend on it.
- `room.state` deliberately sets **no `types` allowlist**, so full room state (including
  `m.room.encryption`, `m.room.name`, `m.room.canonical_alias`) arrives on the initial sync.

**Loop.** Initial: `timeout=0`, no `since`. Subsequent: `since=<next_batch>&timeout=30000`, in a loop
guarded by one `AbortController`.

**Backoff** on network error / 5xx: 1 s, 2 s, 4 s, 8 s, 16 s, 30 s cap, ±20 % jitter; reset on the
first success. `429` waits `retry_after_ms`. `401 M_UNKNOWN_TOKEN` → involuntary logout (§3).

#### Room display name — `roomDisplayName(room): string`

Without this, every DM renders as `!abc:server`: DMs essentially never carry `m.room.name`, and
`lazy_load_members` means the sync returns member events only for senders present in the timeline,
so the name cannot be recovered from state either. `sync.ts` **must** ingest and cache
`rooms.join[roomId].summary` (`m.heroes`, `m.joined_member_count`, `m.invited_member_count`) per
room, and `MxRoom` must expose `heroes: string[]`, `joinedCount: number`, `invitedCount: number`.

Resolution order, per the spec's calculation:

1. `m.room.name` content `name`, if non-empty;
2. `m.room.canonical_alias` content `alias`, if present;
3. from `summary.m.heroes` (MXIDs, excluding us) — resolve each to a display name via the cached
   member event if we have one, else use the MXID:
   - 1 hero → that name; 2–3 heroes → `"A, B and C"`;
   - >3 heroes → `"A, B, C and N others"` where `N = joined + invited - 1 - shown`;
   - **0 heroes** and `joined + invited <= 1` → `"Empty room"`; the spec's "was …" variant is out of
     scope — `"Empty room"` is honest and one branch;
4. last resort: the room id.

**Invites** get the same function against the **stripped** `invite_state.events` (which carry
`m.room.name`/`m.room.canonical_alias`/`m.room.member` but no `summary`); with none of those, fall
back to the inviter's MXID: `"Invite from @x:y"`.

#### Gappy sync (`timeline.limited === true`)

- **If the room's timeline is at the bottom (or the room is not currently open):** replace that
  room's cached window with the new chunk and adopt the new `prev_batch`. Continuity is preserved and
  nothing the user was reading is lost.
- **If the user is scrolled up in that room:** **do not wipe the window.** Keep it, append the new
  chunk after a rendered `.mx-gap` marker (*"— messages may be missing —"* + a `Load` button that
  back-paginates from the new `prev_batch`), and store the new `prev_batch` against that gap. An
  earlier draft replaced unconditionally, which after a 40-second network stall would destroy 200
  back-paginated events and yank a reader to the bottom — exactly what §5.6 promises never happens.
- Never splice a limited chunk onto a stale window without a gap marker.

#### Store caps (bounded memory is a requirement, not an optimisation)

- **Per room: at most 300 events** in the store window, dropping oldest first (independent of, and
  larger than, the 400-element DOM cap so scrolling has slack). Dropping resets that room's "beginning
  of room" flag so pagination can refetch.
- **Rooms not opened in the last 15 minutes keep only their last event** (for the list preview) —
  their window is evicted. Reopening re-fetches via `/messages`.
- The `txnId → event_id` map drops entries on reconciliation and on send-failure resolution; the
  member/display-name cache is capped at 500 entries, LRU. Nothing in the store grows without bound
  over a multi-hour session.

#### Unread

Taken from `unread_notifications.notification_count` / `highlight_count`. Cleared by
`POST …/read_markers {"m.fully_read":evId,"m.read":evId}` when the room is open, the panel is
visible, and the timeline is at the bottom — debounced 1 s. (This is why "send our own read marker"
is in scope even though displaying *other people's* receipts is not: without it, unread badges would
never clear and FR-2 would be broken.)

#### Send + reconciliation

`txnId = 'pa' + Date.now().toString(36) + (counter++)`. The echo row appears immediately as
`.pending`. Reconciliation follows the **three-step key order in §5.6** — `unsigned.transaction_id`
first, then `event_id`, then new row — because the homeserver frequently delivers the event down
`/sync` before the `PUT` response returns. `MxEvent` therefore carries
`unsigned?: { transaction_id?: string; redacted_because?: unknown }`. The `PUT` response's
`event_id` is still recorded (it resolves the pending state when the sync path did not fire first).
Timeout 30 s → `.failed` + Retry (same txnId — idempotent by spec).

#### `m.direct` writes

Always **read-modify-write against a fresh `GET …/user/{userId}/account_data/m.direct`** (`404`
⇒ `{}`), never against the sync's cached copy, then `PUT` the merged map. Written in exactly two
places: after creating a DM, and after accepting an invite whose `m.room.member` for us carried
`content.is_direct === true` (§5.3).

---

## 7. Scope Fence

v1 deliberately does **not** do the following. These are decisions, not omissions.
Entries marked **[shipped]** were v1 non-goals that have since been built; they are
kept here (rather than deleted) because the reasoning for deferring them is still
the reason they are shaped the way they are.

- ~~**No E2EE**~~ **[shipped]** — full rust-crypto E2EE; see `matrix-e2ee-design.md`.
- **No voice or video calls** (Matrix VoIP, Element Call). Voice in this app is Mumble + LiveKit zone voice.
- **No threads, no reactions, no message editing, no replies, no redaction UI.**
- **No read-receipt display** and no typing notifications. (We *send* our own read marker; see above.)
- ~~**No file/image upload and no media display**~~ **[shipped]** — PNG/JPEG/GIF send and view, over
  Matrix 1.11 authenticated media with a token-bearing fetch and a per-session blob lifecycle
  (`media.ts`). Other attachment types are still labelled placeholders.
- ~~**No avatars from `mxc://`**~~ **[shipped]** — real profile pictures, layered over the
  deterministic initials square so a slow or missing one degrades to what v1 drew.
- **No Spaces** (`m.space` hierarchy), no room directory browsing, no public-room search.
- **No SSO/OIDC/CAS login, no registration, no password reset, no 3PID/email invites.**
- **No room settings** — no rename, topic, avatar, join rules, history visibility, power levels.
- **No moderation** — no kick, ban, mute, or redact.
- ~~**No notifications**~~ **[shipped, desktop only]** — OS notifications via `notify.ts` +
  `bridge.ts`'s `notifyDesktop`. The browser build is still badges-only: it has no permission-free
  path to a notification, and the 🔔 button and its view are not built there at all. Push rules are
  *consumed*, never reimplemented — `getPushActionsForEvent` is the homeserver's verdict, and the
  client only narrows it (mentions and DMs always; other rooms only while the window is closed or
  the app is unfocused; never the room on screen). Message text is off by default: a notification
  body leaves the app for the desktop's notification service, and for an encrypted room that would
  put decrypted content outside it.
- **No multi-account and no parallel homeservers** — one Matrix session per pixel-agents user
  (§3); signing in elsewhere replaces it.
- **No cross-device session sync** and no server-side credential storage (§3).
- ~~**No `formatted_body` HTML rendering**, no markdown composition, no code blocks~~
  **[shipped]** — `richHtml.ts` rebuilds an allowlisted subset of incoming `formatted_body` into
  fresh nodes (never `innerHTML`), `markdown.ts` composes it. Still **no pills**.
- **No background sync before the panel is opened in the current page load** (§1). A pinned dock is
  the one exception — it re-pins itself after the reload that zone travel performs.
- **No cross-zone persistence of the panel** — `goToZone()` reloads the page; the view, the open room
  and the composer draft are restored from `sessionStorage`, the sync is not (§5.1).
- **No server-side anything** — no endpoint, no Colyseus message, no schema field, no DB table.
  (The one `CommandSpec` in `shared/src/commands.ts` is registry data with no server execution
  branch.)

---

## Security Considerations

- **New attack surface on our server: none.** No endpoint, no handler, no capability.
- **Remote content is never trusted as markup** — the hard rule is stated in full in §5.6
  ("Remote-content rule"), and it covers `title`, `aria-label`, `href` and `style` as well as
  `innerHTML`. The single `innerHTML` exception is `.mx-txt = linkify(body)`.
- **The homeserver base URL is validated twice with one function** — on the typed input *and* on the
  discovered `m.homeserver.base_url` (§5.3). This, not the URL assertion below, is what stops a
  hostile or typo'd `/.well-known/matrix/client` from redirecting the token-bearing requests.
- **The access token is never logged, never put in a URL, never sent anywhere but the validated
  homeserver origin.** `api.ts` asserts the request URL starts with the stored (validated)
  `hsBaseUrl` before attaching the `Authorization` header, and uses
  `fetch(..., { redirect: 'error' })` on authenticated calls so a redirect cannot carry it
  elsewhere.
- **Credential namespacing** by authenticated `myUserId` prevents cross-account leakage on a shared
  browser profile (§3).
- **Mixed content / TLS:** `http://` homeservers are rejected outside localhost (A-4), consistent
  with AGENTS rule 9's "serve over TLS in production".
- **Rate limiting:** all user-triggered network actions are debounced and disabled-while-inflight, so
  a stuck UI cannot hammer a homeserver.
- **No secret of ours reaches this code path**; the pixel-agents session cookie / bearer sid is never
  attached to a cross-origin homeserver request (we never call `credentials: 'include'`).

## Verification Strategy

1. `pnpm -r run check-types` clean.
2. `pnpm build` succeeds; inspect `client/dist` and confirm the Matrix code is in its **own chunk**
   and the main entry chunk did not grow by more than ~5 KB.
3. `.claude/skills/mmo-readiness/check.sh` passes — in particular check 2 (no
   `state.update(`-shaped call in `client/src`; see the naming rule in §4) and check 3 (no banned
   engine in any `package.json`; we added no dependency at all).
4. Manual, against a real homeserver (matrix.org or a local Synapse): login → room list → open room →
   scrollback → send → new DM by directory search → new DM by raw MXID → create group → invite →
   member list → leave → join by alias → accept invite → decline invite → reload (session restored) →
   sign out (session gone).
5. Failure-path manual: kill network mid-session (Reconnecting → Offline → recovery), revoke the
   access token server-side (involuntary logout), open an encrypted room (labelled, composer
   disabled), send while offline (`.failed` + Retry works).
6. **Chrome and Firefox** both (rule 8), and the **Electron shell** (rule 10) — the desktop run must
   verify that the homeserver accepts `Origin: app://bundle`, and that `localStorage` survives a
   restart. **Explicitly include prepend-scroll parity:** back-paginate a long room in both engines
   and confirm the viewport does not move (this is the `overflow-anchor` / synchronous-restore rule
   in §5.6, and it is the failure most likely to differ between engines).
7. Docked-panel regression: pin Matrix with Mumble pinned and vice versa (each must unpin the other);
   confirm other right panels clear the dock with no overlap at both `25.5rem` and `27.5rem`; open an
   iframe action while a dock is pinned (`--pa-side-panel-w` + `--pa-dock-w` must compose, not
   fight); narrow the window below 56rem.
8. Zone-chat regression: Enter still focuses zone chat when the Matrix composer is not focused, and
   never when it is.
9. World-input regression: with a room row / `.seg` tab / pin button focused in the panel, arrow keys
   and WASD do **not** walk the avatar; clicking the canvas restores movement; F8 still toggles the
   perf overlay with the panel open.
10. Grep gates: `grep -rn "from '.*matrix/" client/src --include=*.ts | grep -v '^client/src/matrix/'`
    returns only the dynamic `import('../matrix/index.js')` call site and the type-only import in
    `OfficeScene.ts`; `grep -rn "innerHTML" client/src/matrix` shows no interpolation of a remote
    value (§5.6).

## Risks and Mitigation

| Risk | Mitigation |
|---|---|
| Homeserver CORS rejects the browser or `app://bundle` origin | Named, actionable error at login (§5.5); documented as assumption A-1. |
| Hand-rolled sync has a gappy-sync/ordering bug | The sync contract is specified, not left to taste; timeline is keyed by `event_id` so duplicates are idempotent rather than corrupting. |
| The panel becomes a second "chat" users confuse with zone chat | Distinct name, icon, placement and vocabulary (§4). |
| Homeserver forces E2EE on new rooms (A-3) | Detected and surfaced immediately; the room is honest about being unreadable. |
| Scope creep into E2EE/media/threads mid-implementation | Explicit scope fence (§7); any reversal of §1 or §2 requires an ADR. |
| Lazy chunk accidentally pulled into the main bundle by a stray static import | One export surface (`index.ts`), and a build-output size check in the verification list. |

## Future Extensibility

- Swapping the transport for `matrix-js-sdk` (if E2EE is brought in scope) is contained to `api.ts` +
  `sync.ts` behind their interfaces — the UI never touches `fetch`. Requires an ADR.
- `safeStorage`-backed credentials on desktop: additive behind `isDesktop()`, no UI change.
- Authenticated media (avatars, images): one fetch helper + a blob-URL cache in `api.ts`, plus
  swapping `.mx-av` initials for `<img>`.
- A second dock (Matrix + Mumble side by side) is a CSS-only change once `--pa-dock-w` exists.

## References

- `AGENTS.md` — rules 1, 2, 7, 8, 9, 10; the UI design-system section and its token table.
- `docs/adr/ADR-0001-desktop-shell-and-cross-origin-auth.md` — the `app://bundle` origin.
- `client/src/ui/paSkin.ts` — canonical `.pa-*` skin.
- `client/src/voice/MumbleUI.ts` — the pinnable-dock and incremental-row-diff precedent.
- `client/src/ui/chatUI.ts` — the in-world zone chat this feature must not merge with.
- `client/src/ui/actionIframe.ts` — sole owner of `--pa-side-panel-w`.
- Matrix Client-Server API v3 specification.

## Update History

| Date | Change |
|---|---|
| 2026-08-07 | Initial design. Transport, E2EE, credential, boundary, UX, file-plan and scope decisions recorded. |
| 2026-08-07 | **§1 (Transport) and §2 (E2EE Position) marked SUPERSEDED** by `docs/design/matrix-e2ee-design.md`, at the repo owner's explicit request to use the official `matrix-js-sdk` with E2EE. No other section changed. |
| 2026-08-07 | Adversarial review folded in. **Protocol corrections:** room display-name algorithm added (`summary.m.heroes`); DM classification no longer claims `m.room.create` carries `is_direct`; `unsigned.transaction_id` made the primary echo key; `account_data` filter switched from `{"limit":10}` to a `m.direct` type allowlist and a mandatory `GET` added before every write; accepting a DM invite now writes `m.direct`; members read via `/members?membership=join&membership=invite`; invite acceptance uses `/rooms/{roomId}/join`; raw room-id joins carry `server_name`; `presence` uses `not_types`. **Host corrections:** the Matrix panel bypasses `setMenu`'s `display:'block'` and uses `flex`; `--pa-dock-w` corrected to panel width + 1.5 rem (27.5 rem); `blocked()` extended for WASD/arrows; the bar button is gated on `viewerIdentity` and `destroy()` given a lifecycle owner; zone travel's full reload documented with `sessionStorage` restore. **Security:** the discovered `m.homeserver.base_url` is re-validated; the remote-content rule promoted to a hard rule covering `title`/`aria-label`/`href`/`style`; `esc()` extended with `'`. **Rendering:** gappy sync no longer wipes a back-paginated window; store and DOM caps made hard and bounded; `overflow-anchor:none` + synchronous scroll restore; `aria-live` scoped. **Scope:** `/matrix` moved into `shared/src/commands.ts` (the `/admin-site`-is-unregistered claim was false); `pa-mx-autostart`, the per-homeserver key dimension, `pa-mx-active`, `GET /profile`, `.pa-chip` and `.pa-select` removed; `.mx-av` tints drawn from existing accents; `.mx-toast` and `.mx-gap` given owners. |
| 2026-08-10 | **§5.1 placement SUPERSEDED.** Matrix and Mumble became docked application windows either side of the game (Matrix left, Mumble right) instead of pinnable right-hand popovers. Pin state, `MatrixClientHandle.isPinned`/`unpin()`, `MumbleUI.isPinned`/`unpin()`, `onPinChange`, `applyDock()`, `--pa-dock-w`, `body.pa-dock-pinned`, `.pa-docked` and the `pa-mx-pinned`/`pa-mb-pinned` keys are all gone; `client/src/ui/dockWindow.ts` owns `--pa-dock-l`/`--pa-dock-r` (which inset `#game` alongside `--pa-side-panel-w`), a drag-to-resize grip, and the `pa-mx-win-*`/`pa-mb-win-*` width + open-state keys. `MatrixClientHandle` gains `setDocked(open)`, which replaces the pin as the timeline-poll gate. |
