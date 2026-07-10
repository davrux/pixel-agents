# Veloren animation port (approach B — mechanical 1:1 transpile)

Goal: bring Veloren's characters, NPCs and **every** animation over **exactly as in
the original**, not reinterpreted into our own system. We mirror Veloren's
`voxygen/anim` crate file-for-file in TypeScript so the diff between a `.rs` and its
`.ts` is purely syntactic (Rust → TS) and therefore auditable and re-syncable.

## Pinned reference

- Source: `gitlab.com/veloren/veloren`, **commit `ad45ea3a91aa63af48fb21de3bdc1ebd7801af03`** (tag `weekly`).
- Vendored (blobless sparse) at `vendor/veloren/` — only `voxygen/anim/src` + `common/src/comp/body`.
- License: derives from GPL-3.0 code + CC-BY-SA assets → **every file here is GPL-3.0**.

To re-sync after a Veloren update: bump the pin, `git -C vendor/veloren checkout <new>`,
then diff each ported file against its `.rs` and apply the (mechanical) delta.

## Structure (mirrors the Rust crate)

```
velorenAnim/
  vek.ts                     ← the vek math crate (Vec2/Vec3/Quat/Mat4/Transform)
  character/
    skeleton.ts              ← character/mod.rs  (skeleton + compute_matrices + SkeletonAttr + helpers)
    idle.ts                  ← character/idle.rs
    run.ts, jump.ts, …       ← one file per character/<anim>.rs   (TODO)
  quadruped_medium/…         ← next skeleton family                (TODO)
```

One TS module per Rust file. Same function/variable names, same magic numbers,
same order of statements.

## Rust → TS translation dictionary

Rust has operator overloading; TS does not. The only non-syntactic change is that
operators become method calls. Everything else is copied verbatim.

| Rust (vek)                          | TypeScript                          |
| ----------------------------------- | ----------------------------------- |
| `let mut next = (*skeleton).clone()`| `const next = skeleton.clone()`     |
| `Vec3::new(x, y, z)`                | `new Vec3(x, y, z)`                 |
| `Vec3::one()` / `Vec3::zero()`      | `Vec3.one()` / `Vec3.zero()`        |
| `a * b` (Vec3 componentwise)        | `a.mul(b)`                          |
| `a * s` (Vec3 × scalar)             | `a.muls(s)`                         |
| `a + b`                             | `a.add(b)`                          |
| `v.xy()`                            | `v.xy()`                            |
| `Quaternion::rotation_x(a)`         | `Quat.rotationX(a)`                 |
| `a * b` (Quaternion compose)        | `a.mul(b)`                          |
| `q.rotate_x(a)` (in place)          | `q.rotateX(a)`  *(post-multiply)*   |
| `q.inverse()`                       | `q.inverse()`                       |
| `Quaternion::slerp(a, b, t)`        | `Quat.slerp(a, b, t)`               |
| `Quaternion::lerp(a, b, t)`         | `Quat.lerp(a, b, t)`                |
| `Default::default()` (ident quat)   | `Quat.identity()`                   |
| `Mat4::from(t)`                     | `Mat4.fromTransform(t)`             |
| `Mat4::scaling_3d(s)`               | `Mat4.scaling3d(s)`                 |
| `m * n` (Mat4)                      | `m.mul(n)`                          |
| `m.mul_point(v)`                    | `m.mulPoint(v)`                     |
| `Lerp::lerp(a, b, t)` (scalar)      | `lerp(a, b, t)`                     |
| `x.powi(2)` / `x.powf(k)`           | `x ** 2` / `Math.pow(x, k)`         |
| `x.sin()` / `.cos()` / `.abs()` …   | `Math.sin(x)` / `Math.cos` / `Math.abs` |
| `x.min(y).max(z)`                   | `Math.max(Math.min(x, y), z)`       |
| `s_a.head.0` / `.1` / `.2`          | `s_a.head[0]` / `[1]` / `[2]`       |

**`..tr` (struct update)** → clone the base, override the listed fields.

## Non-obvious conventions

- **Composition order.** vek `a * b` and `q.rotate_x` map to three's `.multiply`
  (post-multiply). This matches the already-validated hand-ported run/dig swing.
- **Coordinates.** Veloren + MagicaVoxel are Z-up, +Y-forward. The renderer wraps
  the whole figure in a space rotated −90° about X, so inside the port we use
  Veloren coordinates 1:1 (no axis remapping in the animation code).
- **Bones vs scene graph.** The rig is the matrix chain in `computeMatricesInner`,
  not Three parenting. The renderer sets each mesh-bone's absolute matrix per frame.
- **Allocation.** The Rust reads fresh `Vec3`/`Quaternion` values freely; the port
  does too (readability over micro-opt). Perf headroom is large for ≤20 players +
  NPCs; hot paths can be de-allocated later if a profile ever demands it.
- **SkeletonAttr match arms.** Rust matches `(Species, BodyType)`; the port uses a
  `"Species,BodyType"` string key with the identical arms.

## Status

- [x] `vek.ts`, `character/skeleton.ts` (skeleton + compute_matrices + SkeletonAttr + helpers + lerp)
- [x] `character/idle.ts`, `character/run.ts`, `character/jump.ts`, `character/wield.ts` (1:1 ports)
- [x] renderer + driver: `characterFigure.ts` (`CharacterFigure`) — matrix rig +
      mesh-bone nodes, synthesises the Dependency from movement, selects idle/run/
      jump and CHAINS wield on top (weapon into the hands, legs from the base),
      smooths the skeleton (voxygen-style), computes + writes bone matrices.
- [x] **verified in isolation** via `veloren-test.html` (headless-screenshotted):
      idle/run/wield/dig-swing all render correctly with the proper tool.
- [x] wired into `main.ts` (aliased `CharacterFigure as VelorenCharacter`). Builds.
      **Still to confirm live in the running app** (facing in-world, editor preview).
- [ ] dig/place swing is still a hand-inlined `solid_smash` overlay, not a `basic.rs`
      port — visually correct for a pick/hammer; port `basic.rs` for the full ability
      system later.
- [ ] feed real orientation/velocity/look_dir from the client (turn-lean `tilt`,
      strafing) — currently derived from group yaw + scalar speed (forward-run case).
- [ ] remaining `character/*.rs` (sit, roll, climb, swim, dance, sneak, glide, …)
      + the CharacterState-driven selection state machine (server must sync it).
- [ ] NPC skeleton families (quadruped_medium first).
- [ ] fold `velorenChar.ts`'s asset-loading into a shared module + delete its old
      animation half once `CharacterFigure` is confirmed live.

## Dev harness (not committed)

`client/veloren-test.html` + `client/src/veloren-test.ts` render the OLD class next
to `CharacterFigure` with `?anim=idle|run|jump|dig&weapon=N&species=…&only=old|new`.
Headless screenshot: `chromium --headless=new --enable-unsafe-swiftshader
--ignore-certificate-errors --virtual-time-budget=9000 --screenshot=out.png URL`.

## The one tuning knob

`SKELETON_LERP_RATE` in `velorenChar.ts` (voxygen/figure isn't vendored, so its
per-frame skeleton smoothing rate is reproduced, not ported). Everything else is
derived from the pinned crate.
