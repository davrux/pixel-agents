# ADR-0001 Desktop Shell and Cross-Origin Auth Transport

## Status

Accepted (2026-07-01)

## Context

pixel-agents is today a browser-only product. In production the client (Phaser 3 + Vite + TypeScript) is served **same-origin** by the server (`server/src/index.ts:89-91`), and every network target is derived from the page's own origin: `endpoint()` and `serverHttpOrigin()` compute the Colyseus WebSocket and HTTP origins from `window.location` (`client/src/net/room.ts:6-18`). Authentication is a server-rendered HTML login page that sets an **HttpOnly; SameSite=Lax** opaque session cookie `pixel_stream_sid` (`server/src/auth.ts:16,81`); the Colyseus room re-validates that cookie in `onAuth` (`server/src/rooms/SimRoom.ts:190-198`). CORS is currently open (`app.use(cors())`, `server/src/index.ts:82`).

The desktop-application effort (PRD `docs/prd/desktop-application-prd.md`) ships an installable client that connects to a **user-configured remote server** (no bundled local server; the connection URL starts blank). Two coupled technical decisions gate that work, and each meets the documentation-criteria ADR bar independently (external-dependency introduction; data-flow / auth-transport change reaching `onAuth` used across HTTP and WebSocket boundaries):

- **Decision A — Desktop shell strategy.** The client hard-depends on browser platform APIs that must reach full parity: `navigator.mediaDevices.getUserMedia` microphone/camera/screen-share capture, LiveKit WebRTC (zone voice `client/src/voice/ZoneVoice.ts`, conference voice `client/src/conference/LiveKitConference.ts`), Web Audio graphs, and Phaser WebGL rendering. The priority MVP platform is **Linux**, where WebView-based shells have historically had weak or inconsistent getUserMedia/WebRTC behavior. The shell choice determines whether parity is guaranteed or must be validated per-platform, and whether the repo stays all-TypeScript or gains a second toolchain.

- **Decision B — Cross-origin auth transport for the packaged app.** A packaged app loads from its own bundle origin (e.g. `app://` / `file://`); there is no server origin to derive from `window.location`, and a `SameSite=Lax` same-origin cookie set by a server navigation does not exist in — and is not sent from — the packaged renderer talking cross-origin. A new transport must carry an accepted credential into Colyseus `onAuth` and to HTTP endpoints, **without changing** the existing same-origin browser cookie flow, and **without weakening auth** to ship desktop.

Hard constraints carried from the PRD and requirement analysis:
- The same-origin browser login (server-rendered page, `pixel_stream_sid` HttpOnly SameSite=Lax cookie, cookie-based `onAuth`, open `cors()`) MUST keep working unchanged; the desktop path is strictly additive.
- The new path must reach and be accepted by `onAuth` (`SimRoom.ts:190-198`).
- The user-supplied server URL must be validated.
- Tokens must stay out of the public Vite bundle and off plaintext disk.
- Server-side auth/CORS changes are in scope. Linux is the priority; packaging is AppImage via electron-builder; builds are unsigned for now; the app icon reuses existing web-client assets. The repo is a pnpm monorepo (`shared`/`server`/`client`) with no client test framework (verification = `tsc --noEmit` + `vite build` + manual functional; server auth changes get automated tests).

## Decision

**Decision A — Desktop shell: adopt Electron** (bundled Chromium), integrated as an additional build target in the pnpm monorepo that reuses the client's Vite output. No forked UI codebase.

**Decision B — Cross-origin auth transport: adopt the bearer-token transport (Option B1).** The server issues an opaque token to an authenticated desktop client; the desktop app stores it in OS-level secure storage and presents it (a) to Colyseus via the `joinOrCreate` matchmake options that reach `onAuth`, and (b) via an `Authorization: Bearer` header for HTTP endpoints. The server validates that token as an equivalent session to the cookie, leaving the cookie path untouched.

### Decision Details

| Item | Content |
|------|---------|
| **Decision** | Package the existing client with Electron (bundled Chromium), and authenticate the packaged app to a remote server with a server-issued bearer token carried through Colyseus join options and the HTTP `Authorization` header, keeping the same-origin cookie flow unchanged. |
| **Why now** | The desktop MVP cannot start until the shell and the cross-origin auth transport are fixed; both are foundational and expensive to reverse once the Design Doc, packaging pipeline, and server auth changes are built on them. |
| **Why this** | Bundled Chromium is the only shell that guarantees WebRTC/getUserMedia/WebGL parity on the priority Linux platform while keeping the repo all-TypeScript. A bearer token is the only transport that reaches `onAuth` from a packaged origin without relying on cross-origin cookies and without touching the existing cookie path. |
| **Known unknowns** | (A) Actual Electron bundle size/memory on target Linux desktops until an AppImage is built and measured. (B) Whether the current `onAuth` (which today has signature `_options: unknown` and reads only `context.headers.cookie`, per `SimRoom.ts:190-198`) needs additional plumbing to observe the token from matchmake/join options vs. the WebSocket upgrade-request headers in Colyseus 0.16. Follow-up (Design Doc): the Design Doc's **first** early verification point MUST be proving the token is observable in Colyseus 0.16 `onAuth` — determining whether it arrives via matchmake/join options or via the WebSocket upgrade-request headers — **before** building the token-issuance endpoint. If the token cannot be observed by either path, the transport plumbing (not just the endpoint) must be reconsidered first. |
| **Kill criteria** | Decision A: if a measured Electron AppImage cannot deliver FR-4 voice/WebGL parity on the target Linux desktop, or bundle/memory cost is judged unacceptable, revisit the shell; also re-evaluate the shell if standard WebKitGTK gains out-of-the-box WebRTC support (the current basis for rejecting Tauri — see Decision A rationale, source note checked 2026-07). Decision B: if bearer validation cannot be made cryptographically equivalent to the cookie session (same session store, same TTL, constant-time comparison) without weakening the cookie path, revisit the transport. Also revisit the loopback/custom-protocol OAuth option (B3) if an external identity provider enters scope. |

## Rationale

### Decision A — Options Considered

1. **Tauri 2 (OS WebView / WebKitGTK on Linux + Rust core)**
   - Pros: Small bundle (single-digit to low-tens of MB), low memory, native feel; strong security model.
   - Cons: On Linux the WebView is **WebKitGTK**, which has historically weak/inconsistent `getUserMedia`/WebRTC support — directly in tension with the product's hard dependency on LiveKit voice, camera, and screen-share (FR-4). WebGL/Web Audio behavior varies by WebView version. Introduces a **Rust toolchain** into an otherwise all-TypeScript monorepo. Parity would have to be re-validated per platform/WebView version rather than guaranteed.
     - Source (checked 2026-07): the standard WebKitGTK WebView shipped with Tauri on Linux does not provide out-of-the-box WebRTC/`getUserMedia`; enabling it requires custom WebKit builds or environment workarounds. See tauri-apps discussion [#8426](https://github.com/tauri-apps/tauri/discussions/8426) and tauri-apps/wry issue [#85](https://github.com/tauri-apps/wry/issues/85). This is the concrete basis for rejecting Tauri and ties directly to Decision A's kill criterion below: if standard WebKitGTK gains out-of-the-box WebRTC support, this rejection rationale no longer holds and the shell choice should be re-evaluated.

2. **PWA / installable web app (thin wrapper, no packaging)**
   - Pros: Zero extra shell code; reuses the browser engine the user already trusts; smallest maintenance surface.
   - Cons: Still fundamentally browser-hosted — it does **not** solve the cross-origin credential problem (the whole reason for the desktop effort is a first-class client for a *remote* configured server, not the same-origin page a PWA installs from). No native window/launcher identity independent of the browser, no OS secure-storage access for credentials (FR-7), and install/engine behavior varies by the user's browser. Does not meet the "dedicated installable client for a user-chosen remote server" requirement.

3. **Electron (bundled Chromium) — Selected**
   - Pros: Ships a **known Chromium version**, guaranteeing `getUserMedia`/WebRTC/Web Audio/WebGL parity with the browser client on Linux and everywhere else — the decisive factor given FR-4. Keeps the repo **all-TypeScript** (no Rust toolchain); main/preload/renderer are TS. First-class native window, launcher/taskbar identity, and OS secure storage via `safeStorage` (serves FR-7). AppImage packaging via electron-builder fits the Linux-priority MVP. Reuses the existing Vite client output as the single UI source (AC-018).
   - Cons: Larger bundle (~80-150 MB) and higher memory than a WebView shell; ships and must be kept current against a bundled Chromium (security-update responsibility). These costs are **accepted** as the price of guaranteed media/WebGL parity.

**Selection rationale:** The product's core value (voice + rendering parity, FR-4) depends on browser APIs whose behavior is unreliable on Linux WebKitGTK (rejecting Tauri) and cannot be delivered as a same-origin PWA against a remote server (rejecting PWA). Electron's bundled Chromium is the only option that guarantees parity while keeping the codebase all-TypeScript. Bundle/memory cost is the accepted trade-off.

### Decision B — Options Considered

1. **Bearer token via Colyseus join options + HTTP `Authorization` header — Selected (B1)**
   - Description: On sign-in, the server issues an opaque token backed by the **same session store and TTL semantics** as the cookie session. The desktop renderer never holds long-lived secrets in the Vite bundle; the token lives in OS secure storage (`safeStorage`) and is handed to the renderer only through typed preload IPC at connect time. The client passes it in `joinOrCreate(WORLD_ROOM, { ..., token })` (matchmake options reach `onAuth`) and as `Authorization: Bearer <token>` for HTTP (`/health` and any auth-gated HTTP). `onAuth` accepts **either** a valid cookie (browser) **or** a valid bearer token (desktop).
   - Pros: Reaches `onAuth` by the mechanism Colyseus already provides for cross-origin clients (options/headers, not cookies). Strictly additive — the cookie branch in `onAuth` and `registerAuth` is unchanged (satisfies FR-3 / AC-010..012). Works identically over WS and HTTP. No reliance on cross-origin cookie semantics, so no `SameSite=None`. Token is validated **equivalently** to the cookie (same store, constant-time comparison per the existing `tokenEquals` pattern), so auth is not weakened. Fits secure storage (FR-7 / AC-020).
   - Cons: Adds a token-issuance endpoint and a second accepted credential form in `onAuth` (two code paths to keep in sync). Requires care that the token is never logged and never baked into the client bundle.

2. **Credentialed cross-origin cookie (`SameSite=None; Secure` + explicit CORS origin allowlist + credentials)**
   - Pros: Reuses the existing cookie-based `onAuth` almost verbatim; conceptually one credential form.
   - Cons: Fragile from a packaged `file://`/`app://` renderer — third-party/cross-site cookie handling for opaque and non-HTTP origins is inconsistent and increasingly restricted; the packaged origin is not a normal web origin the browser will attach cookies to reliably. Forces `SameSite=None` and a credentialed CORS allowlist (replacing the open `cors()`), enlarging the server's cross-origin attack surface and risking regressions to the same-origin flow (against FR-3). High probability of "works in dev, fails in the packaged app."

3. **Loopback / custom-protocol OAuth-style flow (embedded login webview capturing a redirect)**
   - Pros: Familiar desktop OAuth pattern; keeps credentials out of the main renderer; extensible to third-party identity providers later.
   - Cons: Substantial machinery (custom protocol handler or loopback listener, redirect capture, embedded auth webview) for a credential model that is just login-id + password + optional admin token (`server/src/auth.ts:86-114`) — no external IdP exists or is required for MVP. Over-engineered for the current requirement; larger surface, more moving parts, and still ultimately needs a token or session to reach `onAuth`. YAGNI relative to the fixed MVP scope.

**Recommended option: B1 (bearer token).** It is the smallest transport that reaches `onAuth` from a packaged origin, is validated equivalently to the cookie (auth not weakened), and leaves the same-origin cookie flow untouched. B2 is rejected as fragile from a packaged origin and as enlarging cross-origin surface; B3 is rejected as over-engineered for the MVP credential model.

### Minimal-surface note (Decision B)

Fixed current requirements: reach and be accepted by `onAuth` (AC-005); survive restart from secure storage (AC-007, AC-020); keep the cookie path valid in parallel (AC-011); never weaken auth (Security NFR). Among the three transports, B1 adds the least *new* concept relative to the existing system: it reuses the existing session store and constant-time token comparison, adds one issuance endpoint and one alternate branch in `onAuth`, and introduces **no** cross-origin cookie semantics and **no** custom-protocol/redirect machinery. B2 and B3 each introduce more surface (a widened CORS/credential posture, or protocol + redirect + embedded-webview machinery) without covering any requirement B1 misses. Concrete endpoint shapes, token format, and IPC contracts are deferred to the Design Doc.

## Consequences

### Positive Consequences

- Guaranteed WebRTC/getUserMedia/Web Audio/WebGL parity on Linux and other platforms (Decision A) — directly de-risks FR-4, the product's core value.
- Repo stays all-TypeScript; no Rust toolchain added; desktop build reuses the existing Vite client output as the single UI source (AC-018), avoiding a forked UI.
- Existing browser users are unaffected: the cookie flow, open `cors()`, and cookie branch of `onAuth` are unchanged (FR-3 / AC-010..012).
- Credentials at rest use OS secure storage rather than plaintext (FR-7 / AC-020); tokens stay out of the public bundle.
- The auth change is additive and validated equivalently to the cookie session, so server security posture is not weakened.

### Negative Consequences

- Larger desktop artifact (~80-150 MB) and higher memory than a WebView shell (accepted trade-off).
- Ongoing responsibility to keep the bundled Chromium current for security updates.
- Two accepted credential forms in `onAuth` (cookie + bearer) that must be kept in sync; a new token-issuance endpoint to build and test.

### Neutral Consequences

- The browser build keeps `window.location`-based target resolution; the desktop build derives targets from the configured URL — the client network resolution becomes parameterized by build/runtime rather than hard-coded to the page origin.
- Adds an Electron build target (main/preload/renderer) to the monorepo alongside `shared`/`server`/`client`.

## Architecture Impact

1. **Components that change**
   - Server auth (`server/src/auth.ts`): gains a token-issuance path and a token-validation helper backed by the existing session store; the cookie helpers (`hasValidSession`, `userIdFromCookie`) and the HTML gate are unchanged.
   - Colyseus `onAuth` (`server/src/rooms/SimRoom.ts:190-198`): accepts a valid bearer token (from join options / upgrade-request header) **in addition to** the existing cookie, resolving to the same `AuthInfo`.
   - Server CORS (`server/src/index.ts:82`): must permit the desktop origin's cross-origin HTTP calls with `Authorization` header support **without** switching to credentialed cross-origin cookies; the same-origin browser flow must see no change (AC-012).
   - Client network resolution (`client/src/net/room.ts:6-18`): target derivation is parameterized so the desktop build uses the configured server URL while the browser build keeps `window.location`.
2. **New dependencies introduced**
   - Electron + electron-builder (dev/build-time), producing an AppImage for Linux (unsigned for MVP). Electron `safeStorage` for credential-at-rest.
3. **Architectural constraints added or removed**
   - Added: the desktop renderer runs with `contextIsolation` on, `nodeIntegration` off, secrets reached only via typed preload IPC, and loaded origins validated/allowlisted (see Implementation Guidance).
   - Added: the user-supplied server URL is a validated input boundary (scheme/host validation and reachability check) before any connection.
   - Removed: none — the browser architecture is preserved as-is.

## Implementation Guidance

Principled direction only; concrete contracts, endpoint shapes, token formats, and step-by-step work belong in the Design Doc.

- **Additive, never subtractive auth.** The cookie flow, HTML gate, and cookie branch of `onAuth` are preserved verbatim. The bearer path is a parallel branch; browser non-regression (AC-010..012) is a release gate.
- **Validate the token equivalently to the cookie.** Back the desktop token with the same session store, TTL, and identity resolution the cookie uses; compare tokens with a constant-time comparison (the existing `tokenEquals` pattern). Do not introduce a weaker or divergent validation for desktop.
- **Reach `onAuth` through Colyseus-native means.** Carry the token in `joinOrCreate` options and/or the connection's headers so `onAuth` can read it; do not depend on cross-origin cookies.
- **Scope CORS narrowly.** Enable the desktop origin and `Authorization` header without adopting credentialed cross-origin cookies and without wildcarding a credentialed origin; keep the same-origin browser path unaffected.
- **Keep secrets out of the bundle and off plaintext disk.** No token or admin secret is embedded in the public Vite build. Persist the desktop credential via Electron `safeStorage`; expose it to the renderer only through typed preload IPC at connect time.
- **Electron security baseline.** `contextIsolation: true`, `nodeIntegration: false`, a minimal typed preload IPC surface, and validation/allowlisting of any origin the renderer is allowed to load or navigate to.
- **Validate the user-supplied server URL** (scheme and host) and check reachability (a `/health` equivalent) before connecting; require a secure context for the media stack.
- **Single UI source.** The desktop build consumes the existing client Vite output; do not fork the client UI.
- **Verification.** Client/desktop correctness is proven by `tsc --noEmit` + `vite build` + manual functional testing against a running server (no client test framework); server auth/CORS changes are covered by automated tests, including that the cookie path still authorizes and the bearer path authorizes equivalently.

## Related Information

- PRD: `docs/prd/desktop-application-prd.md` (FR-1..FR-9, AC-001..AC-021)
- Existing code: `server/src/auth.ts` (cookie session, `tokenEquals`, HTML gate), `server/src/index.ts:82,89-104` (open `cors()`, static client, TLS-when-cert), `server/src/rooms/SimRoom.ts:190-198` (`onAuth`), `client/src/net/room.ts:6-18` (`endpoint()`/`serverHttpOrigin()`), `client/src/voice/ZoneVoice.ts`, `client/src/conference/LiveKitConference.ts`
- Follow-up: Desktop Application Design Doc (auth transport contracts, connection/settings screen, packaging pipeline) — pending.
- Prerequisite common ADRs: none exist yet (`docs/adr/` had no `ADR-COMMON-*`); no common ADR is created here because these decisions are specific to the desktop shell and its auth transport rather than a cross-component convention.

## Revision History

| Date | Change |
|------|--------|
| 2026-07-01 | Status changed from **Proposed** to **Accepted** (user-approved). Non-blocking review hardening folded in: (a) added a dated source note (checked 2026-07) for the WebKitGTK WebRTC limitation in Decision A's rationale citing tauri-apps discussion #8426 and tauri-apps/wry issue #85, and tied it to Decision A's kill criterion (re-evaluate the shell if standard WebKitGTK gains out-of-the-box WebRTC); (b) recorded in Decision B's known-unknowns/follow-up that the Design Doc's first early verification point must prove the token is observable in Colyseus 0.16 `onAuth` (matchmake/join options vs. WebSocket upgrade-request headers) before building the token-issuance endpoint, noting `onAuth` today has signature `_options: unknown` and reads only `context.headers.cookie`; (c) added a Decision B reversal trigger — revisit the loopback/OAuth option B3 if an external identity provider enters scope. Both decisions and all option comparisons unchanged. |
