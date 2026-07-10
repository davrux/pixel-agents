/**
 * JumpAnimation — faithful port of Veloren
 * voxygen/anim/src/character/jump.rs (pinned commit ad45ea3, GPL-3.0).
 *
 * Mechanical Rust→TS translation (see velorenAnim/PORTING.md). GPL-3.0.
 */
import { Quat, Vec2, Vec3, signum } from '../vek.js';
import { CharacterSkeleton, Hands, SkeletonAttr, ToolKind } from './skeleton.js';

export interface JumpDependency {
  activeToolKind: ToolKind | null;
  secondToolKind: ToolKind | null;
  hands: [Hands | null, Hands | null];
  velocity: Vec3;
  orientation: Vec3;
  lastOri: Vec3;
  lookDir: Vec3;
  globalTime: number;
}

export function jumpAnimation(skeleton: CharacterSkeleton, dep: JumpDependency, animTime: number, s_a: SkeletonAttr): CharacterSkeleton {
  const { activeToolKind, secondToolKind, hands, velocity, orientation, lastOri, lookDir, globalTime } = dep;
  const next = skeleton.clone();
  const slow = Math.sin(animTime * 7.0);

  const subtract = globalTime - animTime;
  const check = subtract - Math.trunc(subtract);
  const switch_ = signum(check - 0.5);

  const falling = Math.max(-1.0, Math.min(1.0, velocity.z * 0.1));
  const speed = Vec2.fromVec3(velocity).magnitude();
  const speednorm = Math.min(speed / 10.0, 1.0);

  const ori = Vec2.fromVec3(orientation);
  const lastOriXy = Vec2.fromVec3(lastOri);
  const tilt =
    (ori.magnitudeSquared() > 0.001 && Number.isFinite(ori.magnitudeSquared()) && lastOriXy.magnitudeSquared() > 0.001 && Number.isFinite(lastOriXy.magnitudeSquared()) && Number.isFinite(ori.angleBetween(lastOriXy))
      ? Math.min(ori.angleBetween(lastOriXy), 0.2) * signum(lastOriXy.determineSide(Vec2.zero(), ori))
      : 0.0) * 1.3;

  next.hold.scale = Vec3.one().muls(0.0);

  next.head.scale = Vec3.one().muls(s_a.head_scale);
  next.shoulder_l.scale = Vec3.one().muls(1.1);
  next.shoulder_r.scale = Vec3.one().muls(1.1);
  next.back.scale = Vec3.one().muls(1.02);

  next.head.position = new Vec3(0.0, s_a.head[0], -1.0 + s_a.head[1]);
  next.head.orientation = Quat.rotationX(0.25 + slow * 0.04).mul(Quat.rotationZ(tilt * -2.5));

  next.chest.position = new Vec3(0.0, s_a.chest[0], s_a.chest[1] + 1.0);
  next.chest.orientation = Quat.rotationX(speednorm * -0.3).mul(Quat.rotationZ(tilt * -2.0));

  next.belt.position = new Vec3(0.0, s_a.belt[0] + speednorm * 1.2, s_a.belt[1] + speednorm * 1.0);
  next.belt.orientation = Quat.rotationX(speednorm * 0.3).mul(Quat.rotationZ(tilt * 2.0));

  next.back.position = new Vec3(0.0, s_a.back[0], s_a.back[1]);
  next.back.orientation = Quat.rotationZ(0.0);

  next.shorts.position = new Vec3(0.0, s_a.shorts[0] + speednorm * 1.2, s_a.shorts[1] + speednorm * 1.0);
  next.shorts.orientation = Quat.rotationX(speednorm * 0.5).mul(Quat.rotationZ(tilt * 3.0));

  if (switch_ > 0.0) {
    next.hand_l.position = new Vec3(-s_a.hand[0], 1.0 + s_a.hand[1] + 4.0, 2.0 + s_a.hand[2] + slow * 1.5);
    next.hand_l.orientation = Quat.rotationX(1.9 + slow * 0.4).mul(Quat.rotationY(0.2));
    next.hand_r.position = new Vec3(s_a.hand[0], s_a.hand[1] - 3.0, s_a.hand[2] + slow * 1.5);
    next.hand_r.orientation = Quat.rotationX(-0.5 + slow * -0.4).mul(Quat.rotationY(-0.2));
  } else {
    next.hand_l.position = new Vec3(-s_a.hand[0], s_a.hand[1] - 3.0, s_a.hand[2] + slow * 1.5);
    next.hand_l.orientation = Quat.rotationX(-0.5 + slow * -0.4).mul(Quat.rotationY(0.2));
    next.hand_r.position = new Vec3(s_a.hand[0], 1.0 + s_a.hand[1] + 4.0, 2.0 + s_a.hand[2] + slow * 1.5);
    next.hand_r.orientation = Quat.rotationX(1.9 + slow * 0.4).mul(Quat.rotationY(-0.2));
  }

  next.foot_l.position = new Vec3(-s_a.foot[0], s_a.foot[1] - 5.0 * switch_, 2.0 + s_a.foot[2] + slow * 1.5 + falling * -2.0);
  next.foot_l.orientation = Quat.rotationX(-0.8 * switch_ + slow * -0.2 * switch_);

  next.foot_r.position = new Vec3(s_a.foot[0], s_a.foot[1] + 5.0 * switch_, 2.0 + s_a.foot[2] + slow * 1.5 + falling * -2.0);
  next.foot_r.orientation = Quat.rotationX(0.8 * switch_ + slow * 0.2 * switch_);

  next.shoulder_l.position = new Vec3(-s_a.shoulder[0], s_a.shoulder[1], s_a.shoulder[2]);
  next.shoulder_l.orientation = Quat.rotationX(0.4 * switch_);

  next.shoulder_r.position = new Vec3(s_a.shoulder[0], s_a.shoulder[1], s_a.shoulder[2]);
  next.shoulder_r.orientation = Quat.rotationX(-0.4 * switch_);

  next.glider.position = new Vec3(0.0, 0.0, 10.0);
  next.glider.scale = Vec3.one().muls(0.0);

  next.doToolsOnBack(hands, activeToolKind, secondToolKind);
  next.doHoldLantern(s_a, animTime, animTime, speednorm, 0.0, tilt, lastOri, lookDir);

  next.torso.position = new Vec3(0.0, 0.0, 0.0);
  next.torso.orientation = Quat.rotationX(0.0);

  return next;
}
