---
name: mmo-readiness
description: Audit a change in the pixel-agents repo against the MMO architecture contract in AGENTS.md — server authority, unified entity model, zones-as-rooms, data-driven content, server-only NPC brain, and a clean typecheck/build. Use before shipping any feature, or when reviewing a contribution, to catch invariant violations that "work" but break composability.
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
bash .claude/skills/mmo-readiness/check.sh          # full: static checks + typecheck + build
bash .claude/skills/mmo-readiness/check.sh --static # fast: static checks only
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
5. **Entity / zone / portal model reused** — synced entities extend `EntitySync`;
   zones are instances of the one room (matchmade by `zone`), not new Room classes;
   travel is placed `portal` furniture + a `ZONES` entry, not a hard-coded jump.
6. **Typecheck + build** — `tsc --noEmit` per package and the client `vite build`.

## Acting on results
- **`✗ FAIL`**: a blocker. Fix it before shipping — these break the contract other
  contributions rely on, even if the feature appears to work.
- **`? CHECK`**: read the listed handlers / patterns and confirm by hand (e.g. open
  each new `onMessage` and verify its server-side validator exists).
- **`! WARN`**: usually a not-built tree or a missing dep; resolve so the check can
  actually run (`pnpm install`, `pnpm build`).

If a check is wrong for a legitimate new pattern, update both `check.sh` and the
relevant AGENTS.md invariant in the same change — keep the doc and the check in
sync.
