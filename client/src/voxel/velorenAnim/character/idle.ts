/**
 * IdleAnimation — faithful port of Veloren
 * voxygen/anim/src/character/idle.rs (pinned commit ad45ea3, GPL-3.0).
 *
 * Mechanical Rust→TS translation (see velorenAnim/PORTING.md). GPL-3.0.
 */
import { Quat, Vec2, Vec3 } from '../vek.js';
import { CharacterSkeleton, Hands, SkeletonAttr, ToolKind } from './skeleton.js';

/** IdleAnimation::update_skeleton_inner. Dependency = (activeToolKind,
 *  secondToolKind, (hands0, hands1), globalTime). `rate` is unused (matches `_rate`). */
export function idleAnimation(
  skeleton: CharacterSkeleton,
  dep: {
    activeToolKind: ToolKind | null;
    secondToolKind: ToolKind | null;
    hands: [Hands | null, Hands | null];
    globalTime: number;
  },
  animTime: number,
  s_a: SkeletonAttr,
): CharacterSkeleton {
  const { activeToolKind, secondToolKind, hands, globalTime } = dep;
  const next = skeleton.clone();

  const slow = Math.sin(animTime * 1.0);
  const headLook = new Vec2(Math.sin(Math.floor(globalTime + animTime / 12.0) * 7331.0) * 0.1, Math.sin(Math.floor(globalTime + animTime / 12.0) * 1337.0) * 0.05);

  next.head.scale = Vec3.one().muls(s_a.head_scale);
  next.chest.scale = Vec3.one().muls(1.01);
  next.hand_l.scale = Vec3.one().muls(1.04);
  next.hand_r.scale = Vec3.one().muls(1.04);
  next.back.scale = Vec3.one().muls(1.02);
  next.hold.scale = Vec3.one().muls(0.0);
  next.shoulder_l.scale = Vec3.one().muls(1.1);
  next.shoulder_r.scale = Vec3.one().muls(1.1);

  next.head.position = new Vec3(0.0, s_a.head[0], s_a.head[1] + slow * 0.3);
  next.head.orientation = Quat.rotationZ(headLook.x).mul(Quat.rotationX(Math.abs(headLook.y)));

  next.chest.position = new Vec3(0.0, s_a.chest[0], s_a.chest[1] + slow * 0.3);
  next.chest.orientation = Quat.rotationZ(headLook.x * 0.6);

  next.belt.position = new Vec3(0.0, s_a.belt[0], s_a.belt[1]);
  next.belt.orientation = Quat.rotationZ(headLook.x * -0.1);

  next.back.position = new Vec3(0.0, s_a.back[0], s_a.back[1]);

  next.shorts.position = new Vec3(0.0, s_a.shorts[0], s_a.shorts[1]);
  next.shorts.orientation = Quat.rotationZ(headLook.x * -0.2);

  next.hand_l.position = new Vec3(-s_a.hand[0], s_a.hand[1] + slow * 0.15, s_a.hand[2] + slow * 0.5);
  next.hand_l.orientation = Quat.rotationX(slow * -0.06);

  next.hand_r.position = new Vec3(s_a.hand[0], s_a.hand[1] + slow * 0.15, s_a.hand[2] + slow * 0.5);
  next.hand_r.orientation = Quat.rotationX(slow * -0.06);

  next.foot_l.position = new Vec3(-s_a.foot[0], s_a.foot[1], s_a.foot[2]);
  next.foot_r.position = new Vec3(s_a.foot[0], s_a.foot[1], s_a.foot[2]);

  next.shoulder_l.position = new Vec3(-s_a.shoulder[0], s_a.shoulder[1], s_a.shoulder[2]);
  next.shoulder_l.orientation = Quat.rotationX(0.0);

  next.shoulder_r.position = new Vec3(s_a.shoulder[0], s_a.shoulder[1], s_a.shoulder[2]);
  next.shoulder_r.orientation = Quat.rotationX(0.0);

  next.glider.position = new Vec3(0.0, 0.0, 10.0);
  next.glider.scale = Vec3.one().muls(0.0);
  next.hold.position = new Vec3(0.4, -0.3, -5.8);

  next.doToolsOnBack(hands, activeToolKind, secondToolKind);
  next.doHoldLantern(s_a, animTime, 0.0, 0.0, 0.0, 0.0, null, null);

  next.torso.position = new Vec3(0.0, 0.0, 0.0);

  return next;
}
