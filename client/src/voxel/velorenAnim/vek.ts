/**
 * vek shim — the math substrate for the faithful Veloren animation port.
 *
 * Veloren's `voxygen/anim` crate is built on the `vek` crate (Vec2/Vec3/
 * Quaternion/Mat4/Transform). Rust has operator overloading; TypeScript does not,
 * so we expose a vek-style *method* API and translate the `.rs` mechanically:
 *
 *   Rust (vek)                         → TypeScript (this shim)
 *   ────────────────────────────────────────────────────────────────
 *   Vec3::new(x, y, z)                 → new Vec3(x, y, z)
 *   Vec3::one()  / Vec3::zero()        → Vec3.one() / Vec3.zero()
 *   a * b   (Vec3, componentwise)      → a.mul(b)
 *   a * s   (Vec3 by scalar)           → a.muls(s)
 *   a + b                              → a.add(b)
 *   Quaternion::rotation_x(a)          → Quat.rotationX(a)
 *   a * b   (Quaternion compose)       → a.mul(b)
 *   q.rotate_x(a)  (in place)          → q.rotateX(a)        // post-multiply
 *   q.inverse()                        → q.inverse()
 *   Quaternion::slerp(a, b, t)         → Quat.slerp(a, b, t)
 *   Quaternion::lerp(a, b, t)          → Quat.lerp(a, b, t)
 *   Default::default() (identity quat) → Quat.identity()
 *   Mat4::from(transform)              → Mat4.fromTransform(t)
 *   Mat4::scaling_3d(s)                → Mat4.scaling3d(s)
 *   m * n  (Mat4)                      → m.mul(n)
 *   m.mul_point(v)                     → m.mulPoint(v)
 *   Lerp::lerp(a, b, t)  (scalar)      → lerp(a, b, t)
 *
 * Quaternion/Mat4 are backed by three.js (correct, well-tested composition);
 * Vec2/Vec3 are plain so their fields stay mutable (`self.head.position.x += …`).
 * Composition order matches three's `.multiply` (post-multiply), which the
 * existing hand-ported run/dig animations already validated visually.
 *
 * Derives from GPL-3.0 code (Veloren) — this module is GPL-3.0.
 */
import * as THREE from 'three';

export const PI = Math.PI;

/** Scalar linear interpolation — vek `Lerp::lerp(from, to, factor)`. */
export function lerp(from: number, to: number, factor: number): number {
  return from + (to - from) * factor;
}

/** Rust `f32::signum` — returns +1 for positive/zero, -1 for negative (NOT Math.sign, which is 0 at 0). */
export function signum(x: number): number {
  return x < 0 ? -1 : 1;
}

export class Vec2 {
  constructor(
    public x = 0,
    public y = 0,
  ) {}
  static zero(): Vec2 {
    return new Vec2(0, 0);
  }
  /** vek `Vec2::from(Vec3)` — drop the z component. */
  static fromVec3(v: Vec3): Vec2 {
    return new Vec2(v.x, v.y);
  }
  dot(o: Vec2): number {
    return this.x * o.x + this.y * o.y;
  }
  magnitude(): number {
    return Math.hypot(this.x, this.y);
  }
  magnitudeSquared(): number {
    return this.x * this.x + this.y * this.y;
  }
  /** vek `Vec2 / f32`. */
  divs(s: number): Vec2 {
    return new Vec2(this.x / s, this.y / s);
  }
  /** vek `rotated_z(angle)` — rotate this 2D vector by `angle` (radians). */
  rotatedZ(angle: number): Vec2 {
    const c = Math.cos(angle),
      s = Math.sin(angle);
    return new Vec2(this.x * c - this.y * s, this.x * s + this.y * c);
  }
  /** vek `angle_between` — unsigned angle (radians) between two vectors. */
  angleBetween(o: Vec2): number {
    const m = this.magnitude() * o.magnitude();
    if (m === 0) return 0;
    return Math.acos(Math.max(-1, Math.min(1, this.dot(o) / m)));
  }
  /** vek `determine_side(a, b)` — signed side of point `this` vs the line a→b. */
  determineSide(a: Vec2, b: Vec2): number {
    return (b.x - a.x) * (this.y - a.y) - (b.y - a.y) * (this.x - a.x);
  }
}

export class Vec3 {
  constructor(
    public x = 0,
    public y = 0,
    public z = 0,
  ) {}
  static one(): Vec3 {
    return new Vec3(1, 1, 1);
  }
  static zero(): Vec3 {
    return new Vec3(0, 0, 0);
  }
  /** Componentwise linear interpolation — vek `Lerp` on Vec3. */
  static lerp(from: Vec3, to: Vec3, t: number): Vec3 {
    return new Vec3(from.x + (to.x - from.x) * t, from.y + (to.y - from.y) * t, from.z + (to.z - from.z) * t);
  }
  clone(): Vec3 {
    return new Vec3(this.x, this.y, this.z);
  }
  /** Componentwise multiply — vek `Vec3 * Vec3`. */
  mul(o: Vec3): Vec3 {
    return new Vec3(this.x * o.x, this.y * o.y, this.z * o.z);
  }
  /** Scalar multiply — vek `Vec3 * f32`. */
  muls(s: number): Vec3 {
    return new Vec3(this.x * s, this.y * s, this.z * s);
  }
  add(o: Vec3): Vec3 {
    return new Vec3(this.x + o.x, this.y + o.y, this.z + o.z);
  }
  sub(o: Vec3): Vec3 {
    return new Vec3(this.x - o.x, this.y - o.y, this.z - o.z);
  }
  xy(): Vec2 {
    return new Vec2(this.x, this.y);
  }
}

/** Quaternion — vek `Quaternion<f32>`, backed by three.js. */
export class Quat {
  /** @internal the backing three quaternion (renderer/compose use it). */
  readonly q: THREE.Quaternion;
  private constructor(q: THREE.Quaternion) {
    this.q = q;
  }
  static fromThree(q: THREE.Quaternion): Quat {
    return new Quat(q);
  }
  static identity(): Quat {
    return new Quat(new THREE.Quaternion());
  }
  static rotationX(a: number): Quat {
    return new Quat(new THREE.Quaternion().setFromAxisAngle(AX_X, a));
  }
  static rotationY(a: number): Quat {
    return new Quat(new THREE.Quaternion().setFromAxisAngle(AX_Y, a));
  }
  static rotationZ(a: number): Quat {
    return new Quat(new THREE.Quaternion().setFromAxisAngle(AX_Z, a));
  }
  static slerp(from: Quat, to: Quat, t: number): Quat {
    return new Quat(from.q.clone().slerp(to.q, t));
  }
  /** vek `Quaternion::lerp` — normalized componentwise lerp (nlerp). */
  static lerp(from: Quat, to: Quat, t: number): Quat {
    const a = from.q,
      b = to.q;
    const r = new THREE.Quaternion(
      a.x + (b.x - a.x) * t,
      a.y + (b.y - a.y) * t,
      a.z + (b.z - a.z) * t,
      a.w + (b.w - a.w) * t,
    );
    r.normalize();
    return new Quat(r);
  }
  clone(): Quat {
    return new Quat(this.q.clone());
  }
  /** vek `a * b` — compose (this then applies to the right). Returns a new quat. */
  mul(o: Quat): Quat {
    return new Quat(this.q.clone().multiply(o.q));
  }
  inverse(): Quat {
    return new Quat(this.q.clone().invert());
  }
  /** vek `q.rotate_x(a)` — in place, post-multiply by rotation_x(a). */
  rotateX(a: number): this {
    this.q.multiply(new THREE.Quaternion().setFromAxisAngle(AX_X, a));
    return this;
  }
  rotateY(a: number): this {
    this.q.multiply(new THREE.Quaternion().setFromAxisAngle(AX_Y, a));
    return this;
  }
  rotateZ(a: number): this {
    this.q.multiply(new THREE.Quaternion().setFromAxisAngle(AX_Z, a));
    return this;
  }
}

const AX_X = new THREE.Vector3(1, 0, 0);
const AX_Y = new THREE.Vector3(0, 1, 0);
const AX_Z = new THREE.Vector3(0, 0, 1);

/** A bone transform — vek `Transform<f32, f32, f32>` (Veloren's `Bone`). */
export class Transform {
  constructor(
    public position: Vec3 = Vec3.zero(),
    public orientation: Quat = Quat.identity(),
    public scale: Vec3 = Vec3.one(),
  ) {}
  clone(): Transform {
    return new Transform(this.position.clone(), this.orientation.clone(), this.scale.clone());
  }
}

/** 4×4 matrix — vek `Mat4<f32>`, backed by three.js. */
export class Mat4 {
  readonly m: THREE.Matrix4;
  private constructor(m: THREE.Matrix4) {
    this.m = m;
  }
  static fromThree(m: THREE.Matrix4): Mat4 {
    return new Mat4(m);
  }
  static identity(): Mat4 {
    return new Mat4(new THREE.Matrix4());
  }
  /** vek `Mat4::from(Transform)` — compose(position, orientation, scale). */
  static fromTransform(t: Transform): Mat4 {
    const p = new THREE.Vector3(t.position.x, t.position.y, t.position.z);
    const s = new THREE.Vector3(t.scale.x, t.scale.y, t.scale.z);
    return new Mat4(new THREE.Matrix4().compose(p, t.orientation.q, s));
  }
  /** vek `Mat4::scaling_3d(s)` — uniform scale. */
  static scaling3d(s: number): Mat4 {
    return new Mat4(new THREE.Matrix4().makeScale(s, s, s));
  }
  /** vek `self * rhs`. Returns a new matrix. */
  mul(o: Mat4): Mat4 {
    return new Mat4(this.m.clone().multiply(o.m));
  }
  /** vek `mul_point(v)` — transform a point (w = 1). */
  mulPoint(v: Vec3): Vec3 {
    const r = new THREE.Vector3(v.x, v.y, v.z).applyMatrix4(this.m);
    return new Vec3(r.x, r.y, r.z);
  }
}
