/**
 * Character skeleton — faithful port of Veloren
 * voxygen/anim/src/character/mod.rs (pinned commit ad45ea3, GPL-3.0).
 *
 * Mirrors the Rust 1:1: the bone tree lives in `computeMatricesInner` as a matrix
 * chain (NOT a scene graph), `SkeletonAttr` carries the per-species offsets from
 * `From<&Body>`, and the helper methods (`doToolsOnBack`, `doHoldLantern`, …) match
 * their Rust counterparts. Animations mutate a cloned skeleton and return it; the
 * renderer feeds the base matrix in and reads the computed mesh-bone matrices out.
 *
 * See velorenAnim/PORTING.md for the Rust→TS translation dictionary. GPL-3.0.
 */
import { Mat4, PI, Quat, Transform, Vec3, lerp } from '../vek.js';

// ── Body (common/src/comp/body/humanoid.rs) ──────────────────────────────────
export type Species = 'Human' | 'Orc' | 'Elf' | 'Dwarf' | 'Draugr' | 'Danari';
export type BodyType = 'Male' | 'Female';

export class HumanoidBody {
  static readonly BASE_HEIGHT = 20.0 / 9.0;
  private static readonly HEIGHT_SCALE_RANGE_START = 0.85;
  private static readonly HEIGHT_SCALE_RANGE_END = 1.1;

  constructor(
    public species: Species = 'Human',
    public bodyType: BodyType = 'Male',
    /** vek height-scale slider (0..255); default mid = neutral height. */
    public heightScaleU8 = 128,
  ) {}

  heightScale(): number {
    return lerp(HumanoidBody.HEIGHT_SCALE_RANGE_START, HumanoidBody.HEIGHT_SCALE_RANGE_END, this.heightScaleU8 * (1.0 / 255.0));
  }

  scaler(): number {
    switch (`${this.species},${this.bodyType}`) {
      case 'Orc,Male':
        return 1.18;
      case 'Orc,Female':
        return 1.05;
      case 'Human,Male':
        return 1.05;
      case 'Human,Female':
        return 0.99;
      case 'Elf,Male':
        return 1.06;
      case 'Elf,Female':
        return 0.99;
      case 'Dwarf,Male':
        return 0.87;
      case 'Dwarf,Female':
        return 0.81;
      case 'Draugr,Male':
        return 1.01;
      case 'Draugr,Female':
        return 0.94;
      case 'Danari,Male':
        return 0.73;
      case 'Danari,Female':
        return 0.73;
      default:
        return 1.0;
    }
  }
}

// ── Tool/hand kinds (common/src/comp/inventory/item/tool.rs) ──────────────────
export enum ToolKind {
  Sword,
  Axe,
  Hammer,
  Bow,
  Staff,
  Sceptre,
  Dagger,
  Shield,
  Spear,
  Blowgun,
  Throwable,
  Debug,
  Farming,
  Pick,
  Shovel,
  Instrument,
  Natural,
  Empty,
}
export enum Hands {
  One,
  Two,
}

// ── SkeletonAttr (From<&Body>) ────────────────────────────────────────────────
type P2 = [number, number];
type P3 = [number, number, number];
type P6 = [number, number, number, number, number, number];
export interface SkeletonAttr {
  scaler: number;
  head_scale: number;
  head: P2;
  chest: P2;
  belt: P2;
  back: P2;
  shorts: P2;
  hand: P3;
  foot: P3;
  shoulder: P3;
  lantern: P3;
  shl: P6;
  shr: P6;
  sc: P6;
  hhl: P6;
  hhr: P6;
  hc: P6;
  sthl: P6;
  sthr: P6;
  stc: P6;
  ahl: P6;
  ahr: P6;
  ac: P6;
  bhl: P6;
  bhr: P6;
  bc: P6;
}

/** Port of `impl From<&Body> for SkeletonAttr`. */
export function skeletonAttrFromBody(body: HumanoidBody): SkeletonAttr {
  const key = `${body.species},${body.bodyType}`;
  const headScale = ((): number => {
    switch (key) {
      case 'Dwarf,Male':
      case 'Dwarf,Female':
        return 1.0;
      case 'Danari,Male':
      case 'Danari,Female':
        return 1.15;
      default:
        return 0.9; // Orc/Human/Elf/Draugr (all 0.9)
    }
  })();
  const head = ((): P2 => {
    switch (key) {
      case 'Orc,Male':
        return [-2.0, 9.0];
      case 'Orc,Female':
        return [-2.0, 9.5];
      case 'Human,Male':
        return [-2.3, 9.5];
      case 'Human,Female':
        return [-2.0, 9.5];
      case 'Elf,Male':
        return [-2.5, 9.5];
      case 'Elf,Female':
        return [-1.0, 9.5];
      case 'Dwarf,Male':
        return [-2.0, 10.0];
      case 'Dwarf,Female':
        return [-2.0, 9.5];
      case 'Draugr,Male':
        return [-1.5, 8.5];
      case 'Draugr,Female':
        return [-1.5, 9.5];
      case 'Danari,Male':
        return [-1.5, 7.0];
      case 'Danari,Female':
        return [-1.5, 7.0];
      default:
        return [-2.3, 9.5];
    }
  })();
  return {
    scaler: body.scaler(),
    head_scale: headScale,
    head,
    chest: [0.0, 8.0],
    belt: [0.0, -2.0],
    back: [-3.1, 7.25],
    shorts: [0.0, -5.0],
    hand: [7.0, -0.25, 0.5],
    foot: [3.4, 0.5, 2.0],
    shoulder: [5.0, 0.0, 5.0],
    lantern: [5.0, 2.5, 5.5],
    shl: [-0.75, -1.0, 0.5, 1.47, -0.2, 0.0],
    shr: [0.75, -1.5, -2.5, 1.47, 0.3, 0.0],
    sc: [-6.0, 6.0, 0.0, -0.5, 0.0, 0.0],
    hhl: [0.1, 0.0, 11.0, 4.71, 0.0, PI],
    hhr: [0.0, 0.0, 0.0, 4.71, 0.0, PI],
    hc: [6.0, 7.0, 1.0, -0.3, -PI / 2.0, 3.64],
    sthl: [0.0, 0.0, 6.0, 1.97, 0.0, 0.0],
    sthr: [0.0, 0.0, 0.0, 1.27, 0.2, 0.0],
    stc: [-5.0, 7.0, -2.0, -0.3, 0.15, 0.0],
    ahl: [-0.5, -1.5, 5.25, 1.5, PI, 0.0],
    ahr: [0.0, -2.0, 1.0, 1.5, 0.0, PI],
    ac: [-8.5, 2.0, 0.5, 4.25, PI, 0.2],
    bhl: [0.0, -4.0, 1.0, PI / 2.0, 0.0, 0.0],
    bhr: [1.0, 2.0, -2.0, PI / 2.0, 0.0, 0.0],
    bc: [-5.0, 9.0, 1.0, 0.0, 1.2, -0.6],
  };
}

// ── The skeleton ──────────────────────────────────────────────────────────────
/** The 16 mesh bones (Veloren's `+`-prefixed bones), in figure-buffer order. */
export const MESH_BONES = ['head', 'chest', 'belt', 'back', 'shorts', 'hand_l', 'hand_r', 'foot_l', 'foot_r', 'shoulder_l', 'shoulder_r', 'glider', 'main', 'second', 'lantern', 'hold'] as const;
export type MeshBone = (typeof MESH_BONES)[number];
export type ComputedCharacterSkeleton = Record<MeshBone, Mat4>;

export class CharacterSkeleton {
  // Mesh bones
  head = new Transform();
  chest = new Transform();
  belt = new Transform();
  back = new Transform();
  shorts = new Transform();
  hand_l = new Transform();
  hand_r = new Transform();
  foot_l = new Transform();
  foot_r = new Transform();
  shoulder_l = new Transform();
  shoulder_r = new Transform();
  glider = new Transform();
  main = new Transform();
  second = new Transform();
  lantern = new Transform();
  hold = new Transform();
  // Non-mesh (intermediate) bones
  torso = new Transform();
  control = new Transform();
  control_l = new Transform();
  control_r = new Transform();
  // Non-bone fields
  holdingLantern = false;
  backCarryOffset = 0.0;
  mainWeaponTrail = false;
  offWeaponTrail = false;
  gliderTrails = false;
  squash = 1.0;

  constructor(holdingLantern = false, backCarryOffset = 0.0, squash = 1.0) {
    this.holdingLantern = holdingLantern;
    this.backCarryOffset = backCarryOffset;
    this.squash = squash;
  }

  clone(): CharacterSkeleton {
    const s = new CharacterSkeleton(this.holdingLantern, this.backCarryOffset, this.squash);
    for (const b of ['head', 'chest', 'belt', 'back', 'shorts', 'hand_l', 'hand_r', 'foot_l', 'foot_r', 'shoulder_l', 'shoulder_r', 'glider', 'main', 'second', 'lantern', 'hold', 'torso', 'control', 'control_l', 'control_r'] as const) {
      s[b] = this[b].clone();
    }
    s.mainWeaponTrail = this.mainWeaponTrail;
    s.offWeaponTrail = this.offWeaponTrail;
    s.gliderTrails = this.gliderTrails;
    return s;
  }

  /** Port of `compute_matrices_inner`. Returns absolute matrices per mesh bone. */
  computeMatricesInner(baseMat0: Mat4, body: HumanoidBody): ComputedCharacterSkeleton {
    const heightScale = body.heightScale();
    const baseMat = baseMat0.mul(Mat4.scaling3d(HumanoidBody.BASE_HEIGHT * body.scaler() * (1.0 / 25.0)));

    const squash = this.squash;
    const transformChest = (tr: Transform): Transform =>
      new Transform(
        tr.position.mul(new Vec3(1.0, 1.0, squash * heightScale ** 2)).add(new Vec3(0.0, Math.min(squash - 1.0, 0.0) * 8.0, 0.0)),
        tr.orientation.mul(Quat.rotationX(Math.min(squash - 1.0, 0.0) * 2.0)),
        tr.scale.muls(lerp(1.0, heightScale, 0.25)),
      );
    const transformLimb = (tr: Transform): Transform =>
      new Transform(
        tr.position.mul(new Vec3(1.0, 1.0, squash)).add(new Vec3(0.0, Math.max(1.0 - squash, 0.0) * 5.0, 0.0)),
        tr.orientation.mul(Quat.rotationX(Math.max(1.0 - squash, 0.0) * 2.0)),
        tr.scale.clone(), // ..tr
      );
    const transformOther = (stretch: number, tr: Transform): Transform =>
      new Transform(
        tr.position.mul(new Vec3(1.0, 1.0, Math.pow(Math.max(heightScale, 0.0), stretch * 2.0))),
        tr.orientation.clone(), // ..tr
        tr.scale.mul(new Vec3(1.0, 1.0, Math.pow(Math.max(heightScale, 1.0), stretch * 2.0))),
      );

    const M = Mat4.fromTransform;
    const torsoMat = baseMat.mul(M(this.torso));
    const chestMat = torsoMat.mul(M(transformChest(this.chest)));
    const headMat = chestMat.mul(M(transformLimb(this.head)));
    const shortsMat = chestMat.mul(M(transformOther(0.6, this.shorts)));
    const controlMat = chestMat.mul(M(this.control));
    const controlLMat = controlMat.mul(M(this.control_l));
    const controlRMat = controlMat.mul(M(this.control_r));
    const handRMat = controlRMat.mul(M(transformLimb(this.hand_r)));

    const handLMat = M(transformLimb(this.hand_l));
    const lanternMat = (this.holdingLantern ? handRMat : shortsMat).mul(M(this.lantern));
    const mainMat = controlLMat.mul(M(this.main));
    const secondMat = controlRMat.mul(M(this.second));
    const gliderMat = chestMat.mul(M(this.glider));

    return {
      head: headMat,
      chest: chestMat,
      belt: chestMat.mul(M(transformOther(1.1, this.belt))),
      back: chestMat.mul(M(this.back)),
      shorts: shortsMat,
      hand_l: controlLMat.mul(handLMat),
      hand_r: handRMat,
      foot_l: torsoMat.mul(M(this.foot_l)),
      foot_r: torsoMat.mul(M(this.foot_r)),
      shoulder_l: chestMat.mul(M(this.shoulder_l)),
      shoulder_r: chestMat.mul(M(this.shoulder_r)),
      glider: gliderMat,
      main: mainMat,
      second: secondMat,
      lantern: lanternMat,
      hold: controlMat.mul(handLMat).mul(M(this.hold)),
    };
  }

  // ── Helper methods (mod.rs `impl CharacterSkeleton`) ────────────────────────
  /** Animate tools on the back (sheathed) — port of `do_tools_on_back`. */
  doToolsOnBack(hands: [Hands | null, Hands | null], activeToolKind: ToolKind | null, secondToolKind: ToolKind | null): void {
    const [h0, h1] = hands;
    // ((Some(Two), _), tool, _) | ((None, Some(Two)), _, tool)
    let twoTool: ToolKind | null | undefined;
    if (h0 === Hands.Two) twoTool = activeToolKind;
    else if (h0 === null && h1 === Hands.Two) twoTool = secondToolKind;
    if (twoTool !== undefined) {
      if (twoTool === ToolKind.Bow) {
        this.main.position = new Vec3(0.0, -5.0 - this.backCarryOffset, 6.0);
        this.main.orientation = Quat.rotationY(2.5).mul(Quat.rotationZ(PI / 2.0));
      } else if (twoTool === ToolKind.Staff || twoTool === ToolKind.Sceptre) {
        this.main.position = new Vec3(2.0, -5.0 - this.backCarryOffset, -1.0);
        this.main.orientation = Quat.rotationY(-0.5).mul(Quat.rotationZ(PI / 2.0));
      } else if (twoTool === ToolKind.Shield) {
        this.main.position = new Vec3(-2.0, -3.0 - this.backCarryOffset, 1.0);
        this.main.orientation = Quat.rotationY(-0.75).mul(Quat.rotationZ(PI / 2.0));
      } else {
        this.main.position = new Vec3(-7.0, -5.0 - this.backCarryOffset, 15.0);
        this.main.orientation = Quat.rotationY(2.5).mul(Quat.rotationZ(PI / 2.0));
      }
    }
    if (h0 === Hands.One) {
      switch (activeToolKind) {
        case ToolKind.Dagger:
          this.main.position = new Vec3(5.0, 1.0 - this.backCarryOffset, 2.0);
          this.main.orientation = Quat.rotationX(-1.35 * PI).mul(Quat.rotationZ(2.0 * PI));
          break;
        case ToolKind.Axe:
        case ToolKind.Hammer:
        case ToolKind.Sword:
          this.main.position = new Vec3(-4.0, -4.5 - this.backCarryOffset, 10.0);
          this.main.orientation = Quat.rotationY(2.5).mul(Quat.rotationZ(PI / 2.0));
          break;
        case ToolKind.Shield:
          this.main.position = new Vec3(-2.0, -4.0 - this.backCarryOffset, 3.0);
          this.main.orientation = Quat.rotationY(0.25 * PI).mul(Quat.rotationZ(-1.5 * PI));
          break;
        case ToolKind.Throwable:
          this.main.position = new Vec3(-6.0, 0.0, -4.0);
          this.main.scale = Vec3.zero();
          break;
        default:
          break;
      }
    }
    // (None | Some(One), Some(One))
    if ((h0 === null || h0 === Hands.One) && h1 === Hands.One) {
      switch (secondToolKind) {
        case ToolKind.Dagger:
          this.second.position = new Vec3(-5.0, 1.0 - this.backCarryOffset, 2.0);
          this.second.orientation = Quat.rotationX(-1.35 * PI).mul(Quat.rotationZ(-2.0 * PI));
          break;
        case ToolKind.Axe:
        case ToolKind.Hammer:
        case ToolKind.Sword:
          this.second.position = new Vec3(4.0, -5.0 - this.backCarryOffset, 10.0);
          this.second.orientation = Quat.rotationY(-2.5).mul(Quat.rotationZ(-PI / 2.0));
          break;
        case ToolKind.Shield:
          this.second.position = new Vec3(1.5, -4.0 - this.backCarryOffset, 3.0);
          this.second.orientation = Quat.rotationY(-0.25 * PI).mul(Quat.rotationZ(1.5 * PI));
          break;
        case ToolKind.Throwable:
          this.second.position = new Vec3(6.0, 0.0, -4.0);
          this.second.scale = Vec3.zero();
          break;
        default:
          break;
      }
    }
  }

  /** Port of `do_hold_lantern`. look_dir/last_ori are Vec3|null (None). */
  doHoldLantern(s_a: SkeletonAttr, animTime: number, accVel: number, speednorm: number, impact: number, tilt: number, lastOri: Vec3 | null, lookDir: Vec3 | null): void {
    const alignWithCam = lookDir && lastOri ? Math.max(0.0, lookDir.xy().dot(lastOri.xy()) * 0.5 + 0.5) : 0.0;

    const lab = 2.0 / s_a.scaler;
    const shorte = Math.sqrt(1.0 / (0.8 + 0.2 * Math.sin(accVel * lab * 1.6) ** 2)) * Math.sin(accVel * lab * 1.6);

    this.lantern.scale = Vec3.one().muls(0.65);

    if (this.holdingLantern) {
      const pitch = (lookDir ? Math.max(-1.0, Math.min(1.0, lookDir.z)) : 0.0) * Math.min(alignWithCam * 5.0, 1.0);
      const yaw =
        (lookDir && lastOri ? Math.min(lookDir.xy().angleBetween(lastOri.xy()), 1.0) * Math.sign(lookDir.xy().determineSide(new Vec3(0, 0, 0).xy(), lastOri.xy())) : 0.0) * Math.min(alignWithCam * 15.0, 1.0);

      const fast = Math.sin(animTime * 8.0);
      const fast2 = Math.sin(animTime * 6.0 + 8.0);
      const breathe = Math.sin(animTime);

      this.hand_r.position = new Vec3(s_a.hand[0] + 0.5 - yaw * 3.0, s_a.hand[1] + 3.0 - impact * 0.2 + yaw * 3.5 - breathe * 1.0, s_a.hand[2] + 12.0 + impact * -0.1 + pitch * 1.5 + breathe * 0.5);
      this.hand_r.orientation = Quat.rotationZ(yaw * 1.0)
        .mul(Quat.rotationX(2.25 + pitch + breathe * 0.3))
        .mul(Quat.rotationZ(0.9));

      this.control_r.position = Vec3.zero();
      this.control_r.orientation = Quat.rotationX(0.0).mul(Quat.rotationY(0.0)).mul(Quat.rotationZ(0.0));

      this.shoulder_r.position.z += 3.0;
      this.shoulder_r.orientation = Quat.rotationZ(Math.min(yaw, 0.0) * 1.0).mul(Quat.rotationX(2.25 + breathe * 0.1));

      this.head.position.x += yaw;
      this.head.position.y -= Math.min(pitch, 0.0) * 1.5 - Math.abs(yaw);
      this.head.orientation = this.head.orientation.mul(Quat.rotationZ(yaw)).mul(Quat.rotationX(pitch * 0.6));

      this.chest.orientation = this.chest.orientation.mul(Quat.rotationX(pitch * 0.3));

      this.lantern.position = new Vec3(-0.5, -0.5, -2.5);
      this.lantern.orientation = this.hand_r.orientation
        .inverse()
        .mul(this.chest.orientation.inverse())
        .mul(Quat.rotationX((fast + 0.5) * 0.1 * speednorm + Math.min(Math.abs(tilt) * 2.0, PI * 0.5) * (0.25 + speednorm) + pitch + breathe * 0.05))
        .mul(Quat.rotationY(tilt * 1.0 * fast + tilt * 1.0 + fast2 * speednorm * 0.25))
        .mul(Quat.rotationZ(yaw))
        .mul(Quat.slerp(Quat.identity(), this.chest.orientation, 0.3));
    } else {
      this.lantern.position = new Vec3(s_a.lantern[0], s_a.lantern[1], s_a.lantern[2]);
      this.lantern.orientation = Quat.slerp(Quat.identity(), this.chest.orientation.inverse().mul(this.shorts.orientation.inverse()), 0.75)
        .mul(Quat.rotationX(shorte * 0.0 * speednorm ** 2 + 0.25))
        .mul(Quat.rotationY(shorte * 0.2 * speednorm ** 2 - 0.3));
    }
  }
}

/** Per-frame smoothing — voxygen eases the displayed skeleton toward the target
 *  skeleton via `Lerp` on `&CharacterSkeleton` (skeleton_impls! in lib.rs). Bone
 *  interpolation is vek `Transform` Lerp: lerp position/scale, nlerp orientation. */
const ALL_BONES = ['head', 'chest', 'belt', 'back', 'shorts', 'hand_l', 'hand_r', 'foot_l', 'foot_r', 'shoulder_l', 'shoulder_r', 'glider', 'main', 'second', 'lantern', 'hold', 'torso', 'control', 'control_l', 'control_r'] as const;
export function lerpSkeleton(from: CharacterSkeleton, to: CharacterSkeleton, t: number): CharacterSkeleton {
  const out = to.clone(); // non-bone fields come from `to`
  for (const b of ALL_BONES) {
    const a = from[b];
    const c = to[b];
    out[b] = new Transform(Vec3.lerp(a.position, c.position, t), Quat.lerp(a.orientation, c.orientation, t), Vec3.lerp(a.scale, c.scale, t));
  }
  return out;
}

// ── Free helper functions (mod.rs top-level) ─────────────────────────────────
export function twistBack(next: CharacterSkeleton, move1: number, c: number, h: number, b: number, s: number): void {
  next.chest.orientation.rotateZ(move1 * c);
  next.head.orientation.rotateZ(move1 * -h);
  next.belt.orientation.rotateZ(move1 * -b);
  next.shorts.orientation.rotateZ(move1 * -s);
}
export function twistForward(next: CharacterSkeleton, move2: number, c: number, h: number, b: number, s: number): void {
  next.chest.orientation.rotateZ(move2 * -c);
  next.head.orientation.rotateZ(move2 * h);
  next.belt.orientation.rotateZ(move2 * b);
  next.shorts.orientation.rotateZ(move2 * s);
}
export function hammerStart(next: CharacterSkeleton, s_a: SkeletonAttr): void {
  next.main.position = new Vec3(0.0, 0.0, 0.0);
  next.main.orientation = Quat.rotationZ(0.0);
  next.hand_l.position = new Vec3(s_a.hhl[0], s_a.hhl[1] + 3.0, s_a.hhl[2] - 1.0);
  next.hand_l.orientation = Quat.rotationX(s_a.hhl[3]).mul(Quat.rotationY(s_a.hhl[4])).mul(Quat.rotationZ(s_a.hhl[5]));
  next.hand_r.position = new Vec3(s_a.hhr[0], s_a.hhr[1] + 3.0, s_a.hhr[2] + 1.0);
  next.hand_r.orientation = Quat.rotationX(s_a.hhr[3]).mul(Quat.rotationY(s_a.hhr[4])).mul(Quat.rotationZ(s_a.hhr[5]));
  next.control.position = new Vec3(s_a.hc[0] - 1.0, s_a.hc[1], s_a.hc[2] - 3.0);
  next.control.orientation = Quat.rotationX(s_a.hc[3]).mul(Quat.rotationY(s_a.hc[4])).mul(Quat.rotationZ(s_a.hc[5]));
}
export function bowStart(next: CharacterSkeleton, s_a: SkeletonAttr): void {
  next.main.position = new Vec3(0.0, 0.0, 0.0);
  next.main.orientation = Quat.rotationX(0.0);
  next.hand_l.position = new Vec3(s_a.bhl[0] - 1.0, s_a.bhl[1], s_a.bhl[2]);
  next.hand_l.orientation = Quat.rotationX(s_a.bhl[3]);
  next.hand_r.position = new Vec3(s_a.bhr[0], s_a.bhr[1], s_a.bhr[2]);
  next.hand_r.orientation = Quat.rotationX(s_a.bhr[3]);
  next.hold.orientation = Quat.rotationX(-PI / 2.0);
  next.hold.scale = Vec3.one();
  next.control.position = new Vec3(s_a.bc[0], s_a.bc[1], s_a.bc[2]);
  next.control.orientation = Quat.rotationY(s_a.bc[4]).mul(Quat.rotationZ(s_a.bc[5]));
  next.head.position = new Vec3(0.0, s_a.head[0], s_a.head[1]);
}
export function bowDraw(next: CharacterSkeleton, move1: number, lookDirZ: number): void {
  next.control.position = next.control.position.add(new Vec3(7.0 + Math.abs(lookDirZ) * -4.0, 2.0 + Math.abs(lookDirZ) * -5.0, 8.0 + lookDirZ * 15.0).muls(move1));
  next.control.orientation.rotateY(move1 * -1.25);
  next.control.orientation.rotateZ((-0.2 + Math.abs(lookDirZ) * 0.8) * move1);
  next.control.orientation.rotateX(lookDirZ * 1.6 * move1);
  next.head.orientation = Quat.rotationX(lookDirZ * 0.7 * move1);
  next.chest.orientation = Quat.rotationZ(0.8 * move1);
}
export function dualWieldStart(next: CharacterSkeleton): void {
  next.main.position = new Vec3(0.0, 0.0, 0.0);
  next.main.orientation = Quat.rotationZ(0.0);
  next.second.position = new Vec3(0.0, 0.0, 0.0);
  next.second.orientation = Quat.rotationZ(0.0);
  next.control_l.position = next.hand_l.position.mul(new Vec3(0.5, 0.5, 0.3)).add(new Vec3(-4.0, 0.0, 0.0));
  next.control_l.orientation = Quat.lerp(next.hand_l.orientation, Quat.rotationX(PI * -0.5), 0.65);
  next.hand_l.position = new Vec3(0.0, -2.0, 0.0);
  next.hand_l.orientation = Quat.rotationX(PI * 0.5);
  next.control_r.position = next.hand_r.position.mul(new Vec3(0.5, 0.5, 0.3)).add(new Vec3(4.0, 0.0, 0.0));
  next.control_r.orientation = Quat.lerp(next.hand_r.orientation, Quat.rotationX(PI * -0.5), 0.65);
  next.hand_r.position = new Vec3(0.0, -2.0, 0.0);
  next.hand_r.orientation = Quat.rotationX(PI * 0.5);
}
