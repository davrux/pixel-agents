---
name: mmo-readiness
description: Audit a change in the pixel-agents repo against the MMO architecture contract in AGENTS.md — server authority, unified entity model, zones-as-rooms, data-driven content, server-only NPC brain, security (no unauthorized access to a resource — routes, room messages, meetings, chat, secrets), memory (nothing that only grows), and a clean typecheck/build. Use before shipping any feature, or when reviewing a contribution, to catch invariant violations that "work" but break composability or open a hole.
---

# MMO readiness check

This repo is a fun, AI-built, MMO-style world (see `AGENTS.md`). Many contributors
work mostly autonomously, so a few **architecture invariants** must hold for their
extensions to compose. This skill verifies them.

## When to use
- Before committing/shipping a feature, especially one touching movement, entities,
  zones, portals, the schema, NPC behaviour, or any client/server message.
- When reviewing someone else's change.

## How to run
From the repo root:

```bash
bash .claude/skills/mmo-readiness/check.sh            # full: static checks + typecheck + build
bash .claude/skills/mmo-readiness/check.sh --static   # fast: static checks only
bash .claude/skills/mmo-readiness/check.sh --selftest # do the security + memory rules still bite?
```

The script reports `✓ PASS` / `✗ FAIL` (hard, blocking), `! WARN` (look into it),
and `? CHECK` (needs human judgement — the script can't decide). It exits non-zero
if any hard check fails.

## What it checks (the contract, condensed from AGENTS.md)
1. **Server-only code stays off the client** — no behaviour-tree (mistreevous) or
   server-package code in `client/dist` or `client/src`. The NPC brain is
   server-only and must never enter the bundle.
2. **Client does not simulate** — no `OfficeState`/sim-update or pathfinding in
   `client/src`. The client renders synced state and interpolates; decisions are
   synced, not recomputed.
3. **One engine only** — no second game/physics/render engine in any
   `package.json`. Gameplay goes in the shared office engine; visuals in Phaser.
4. **Server authority over input** — lists every `onMessage` handler so you can
   confirm each validates identity/length/format/bounds server-side (client checks
   are UX only).
5. **Pawn / zone / portal model reused** — synced pawns extend `PawnSync` (the body; a
   `ControllerKind` on it says what drives it);
   zones are instances of the one room (matchmade by `zone`), not new Room classes;
   travel is placed `portal` furniture + a `ZONES` entry, not a hard-coded jump.
5b. **Security — nobody unauthorized reaches a resource** (see below).
5c. **Memory — nothing that only grows** (see below).
6. **Typecheck + build** — `tsc --noEmit` per package and the client `vite build`.

## Security is checked, not recited

`security.mjs` treats AGENTS.md § Security as what it is: a contract about code that
exists, therefore checkable. For every surface a client can reach a resource
through, it requires the gate to be present in the code that serves it — and fails
otherwise. A surface that is open on purpose is named in an allow-list **with its
reason**, so "this one is fine" is a decision somebody wrote down rather than an
absence nobody noticed.

- **HTTP routes** — every route either shows a gate in its own body
  (`hasValidSession`/`reqUserId`/`admin(req`/`can(`/`verifyPassword`…) or is listed
  in `PUBLIC_ROUTES` (public by design, with the reason) or `CENTRALLY_GATED` (a GET
  that inherits the session gate). This matters because the gate in `auth.ts` covers
  **GET only** — every other verb, and everything registered before the gate, is on
  its own. The gate's own exemption list is compared against the signed-off set, so
  it cannot quietly grow a `/backdoor`.
- **Room messages** — a handler that acts on an id/name/slug from its own payload
  must resolve the actor server-side (`authOf(client)`, `players.get(sessionId)`) or
  check a capability (`may`). The payload may say WHAT, never WHO. Privilege
  (`isAdmin`, `role`, capabilities) may never come out of a payload at all.
- **No dead surface** — every `onMessage` type must actually be sent by client
  code, or be named in `SENDERLESS_OK` with its reason. A door nobody uses is a
  door nobody checks: `meetingRoomJoin` was unsent since furniture meetings moved
  to membership-on-arrival, and it still added membership **from any distance** —
  i.e. a voice token for a call you are not standing at. This rule found it.
- **Meetings** — an in-world voice token is minted only for a **member** of that
  call, with a server-derived identity; a guest link verifies its password, throttles
  guesses and honours expiry; slugs are crypto-random and passwords hashed. Holding a
  token *is* being in the call, so this is the lock, not a formality.
- **Chat** — attributed from the session (never `msg.from`), length-capped,
  rate-limited, and zone-scoped by being a room broadcast.
- **Identity plumbing** — the world room and the agent feed both require an account;
  an agent's owner comes from the per-user agent token; zone entry gates the privacy
  ACL and the entry password in `onAuth`.
- **Secrets** — no LiveKit key/secret, admin token or password hash named in
  `client/src` or placed in a `client.send`/`broadcast` payload.

**The rules are self-tested.** `--selftest` punches one hole per rule into the real
source (an ungated route, a token minted without membership, a payload-supplied
`userId`, …), requires the check to fail on each, and reverts. A grep-based check
silently stops matching when the code it greps moves, and then prints PASS at a file
it no longer understands — which reads like evidence. So: **a new security rule ships
with its self-test case in the same change**, and the self-test refuses to run while
the files it patches have uncommitted edits.

## Memory is checked the same way

A leak is not a crash, which is exactly why it needs a check: this server runs for
weeks and a tab stays open all day, so "it got slow" arrives days later with no stack
trace and nothing to bisect. `leaks.mjs` therefore asks the same question the security
section asks — **is the release present in the code that acquires?** — and anything
that grows on purpose is named in an allow-list **with its bound**.

- **Long-lived collections shrink** — every `Map`/`Set` that is a class FIELD or
  module-level state and gains entries at runtime must be deleted from, cleared, or
  rebuilt wholesale somewhere. Three things keep this from being noise, and each was
  a wrong version first: only field/module scope counts (a function-local `visited`
  set dies with the call, and there are ~90 of those); a collection built once from a
  literal and only read cannot leak, so growth must be shown (`.set(`/`.add(`); and a
  wholesale rebuild (`this.points = layoutToSitPoints(…)`) counts as release, because
  a layout change bounds it. Scope is *parsed*, not grepped — `class SimRoom extends
  Room<{ state: RoomState }> {` hid the keyword behind its generic's braces, and every
  field in the biggest file on the server went unexamined while the rule printed PASS.
- **Subscriptions on a shared emitter are balanced** — a module singleton outlives
  every room, so a room that subscribes without unsubscribing is retained for the life
  of the server together with its state, clients and layout. The rule asks whether the
  emitter is IMPORTED rather than naming the buses: `controlBus` and the agent
  `director` are both process-wide, a `ws.on('close')` is an object the subscriber owns
  and goes with it — and naming the two buses would have kept passing on the day a
  third arrives.
- **Timers end** — every `setInterval` is cleared or `unref`'d. Not just memory: a
  referenced timer turns "the server is idle" into "the server will not exit".
- **Blob URLs are revoked** — `createObjectURL` keeps the whole Blob alive, and in a
  media path that is megabytes per call.
- **Per-entity textures are removed** — GPU memory the garbage collector cannot help
  with. The art stores that keep textures on purpose (the runtime atlas, the marker
  icons) say so in `TEXTURES_KEPT`.
- **Synced entities leave the schema** — a `MapSchema` entry nobody deletes is worse
  than a leak: it grows the state *every* client decodes, forever.

**A static rule and a heap measurement catch different things**, so the section is not
the whole answer. A per-user `Map` entry is ~100 bytes: 10 000 visitors is 1 MB, which
no heap graph makes you look at and the rule above sees immediately. The other way
round, an object graph held alive by a closure is invisible to a grep. To measure the
server, start an isolated instance (`PIXEL_STREAM_PORT`/`PIXEL_STREAM_DATA_DIR` at a
scratch dir) with `--inspect`, then drive join/leave cycles from a headless Colyseus
client and read `process.memoryUsage().heapUsed` through `Runtime.evaluate` after a
`HeapProfiler.collectGarbage`. **RSS is not the signal** — it grew 1.4 MB per cycle
here while nothing was retained, because V8 does not hand memory back. Measured this
way (2026-08-20): 36 join/leave cycles left `heapUsed` at 64.3 → 64.6 MB, and 150
visits by 30 distinct accounts through a room kept alive by an anchor client left the
live heap at 73.5 → 73.6 MB, with a snapshot diff showing no object class growing —
only JIT code.

The `? CHECK` items are the three judgements a scanner cannot make: whether a new
module cache is keyed by CONTENT (bounded by the art) or by a session; whether DOM
listeners outlive the element they are on; and what is held across a zone switch or a
reconnect, where the room is new but the module state is not.

**These rules are self-tested too**, in the same `selftest.mjs` and for the same
reason. Two of its seven planted leaks are regressions rather than inventions — the
per-user `savedSpots` entry that had no delete site, and the mock driver's interval
that was neither cleared nor unref'd — so the suite demonstrably catches the bugs
that motivated it. **A new memory rule ships with its self-test case in the same
change**, and an allow-list entry always carries the bound that makes it safe.

## Acting on results
- **`✗ FAIL`**: a blocker. Fix it before shipping — these break the contract other
  contributions rely on, even if the feature appears to work.
- **`? CHECK`**: read the listed handlers / patterns and confirm by hand (e.g. open
  each new `onMessage` and verify its server-side validator exists). The security
  section keeps this list deliberately short — anything mechanically decidable is a
  PASS/FAIL above, so a `? CHECK` there really is judgement.
- **`! WARN`**: usually a not-built tree or a missing dep; resolve so the check can
  actually run (`pnpm install`, `pnpm build`).

If a check is wrong for a legitimate new pattern, update both the check
(`check.sh` / `security.mjs` / `leaks.mjs`) and the relevant AGENTS.md invariant in
the same change — keep the doc and the check in sync. For a security or memory rule
that also means its `selftest.mjs` case: widening an allow-list without a reason, or deleting a rule
because it fired, is how a contract quietly stops being one.
