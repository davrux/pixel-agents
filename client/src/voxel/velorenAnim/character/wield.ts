/**
 * WieldAnimation — faithful port of Veloren
 * voxygen/anim/src/character/wield.rs (pinned commit ad45ea3, GPL-3.0).
 *
 * Veloren CHAINS animations: a base movement animation (idle/run/jump) runs first,
 * then wield is applied on top of its result — wield only overrides the arms /
 * control / held weapon (its `is_moving` branch skips the body+legs so the base
 * movement's legs survive). Call it with the movement result as `skeleton`.
 *
 * The `Instrument` tool sub-cases (which need an AbilitySpec we don't model and are
 * unreachable in our content) are omitted; every weapon/tool kind is ported.
 *
 * Mechanical Rust→TS translation (see velorenAnim/PORTING.md). GPL-3.0.
 */
import { PI, Quat, Vec2, Vec3, signum } from '../vek.js';
import { CharacterSkeleton, Hands, SkeletonAttr, ToolKind } from './skeleton.js';

export interface WieldDependency {
  activeToolKind: ToolKind | null;
  secondToolKind: ToolKind | null;
  hands: [Hands | null, Hands | null];
  orientation: Vec3;
  lastOri: Vec3;
  lookDir: Vec3;
  velocity: Vec3;
  isRiding: boolean;
  globalTime: number;
}

export function wieldAnimation(skeleton: CharacterSkeleton, dep: WieldDependency, animTime: number, s_a: SkeletonAttr): CharacterSkeleton {
  const { activeToolKind, secondToolKind, hands, orientation, lastOri, lookDir, velocity, isRiding, globalTime } = dep;
  const lab = 0.8;
  const speed = Vec2.fromVec3(velocity).magnitude();
  const speednorm = speed / 9.5;
  const next = skeleton.clone();
  const headLook = new Vec2(Math.sin(Math.floor(globalTime + animTime / 3.0) * 7331.0) * 0.2, Math.sin(Math.floor(globalTime + animTime / 3.0) * 1337.0) * 0.1);

  const beltstatic = Math.sin(animTime * 10.0 * lab + PI / 2.0);
  const footvertlstatic = Math.sin(animTime * 10.0 * lab);
  const footvertrstatic = Math.sin(animTime * 10.0 * lab + PI);

  const slowalt = Math.cos(animTime * 9.0 + PI);
  const uSlow = Math.sin(animTime * 4.5 + PI);
  const slow = Math.sin(animTime * 7.0 + PI);
  const uSlowalt = Math.cos(animTime * 5.0 + PI);
  const direction = velocity.y * -0.098 * orientation.y + velocity.x * -0.098 * orientation.x;

  const ori = Vec2.fromVec3(orientation);
  const lastOriXy = lastOri.xy();
  const tilt =
    (ori.magnitudeSquared() > 0.001 && Number.isFinite(ori.magnitudeSquared()) && lastOriXy.magnitudeSquared() > 0.001 && Number.isFinite(lastOriXy.magnitudeSquared()) && Number.isFinite(ori.angleBetween(lastOriXy))
      ? Math.min(ori.angleBetween(lastOriXy), 0.2) * signum(lastOriXy.determineSide(Vec2.zero(), ori))
      : 0.0) *
    1.25 *
    4.0;
  const jump = velocity.z === 0.0 ? 0.0 : 1.0;

  next.main.position = new Vec3(0.0, 0.0, 0.0);
  next.main.orientation = Quat.rotationZ(0.0);
  next.main.scale = Vec3.one();
  next.second.position = new Vec3(0.0, 0.0, 0.0);
  next.second.orientation = Quat.rotationZ(0.0);
  next.second.scale = Vec3.one();

  const isMoving = (speed > 0.2 && velocity.z === 0.0) || isRiding;

  if (!isMoving) {
    next.head.position = new Vec3(0.0, s_a.head[0], s_a.head[1] + uSlow * 0.1);
    next.head.orientation = Quat.rotationZ(headLook.x + tilt * -0.75).mul(Quat.rotationX(Math.abs(headLook.y) + lookDir.z * 0.7));

    next.chest.position = new Vec3(slowalt * 0.2, s_a.chest[0], s_a.chest[1] + uSlow * 0.35);
    next.belt.orientation = Quat.rotationZ(0.15 + beltstatic * tilt * 0.1);

    next.shorts.orientation = Quat.rotationZ(0.3 + beltstatic * tilt * 0.2);
    next.torso.orientation = Quat.rotationZ(tilt * 0.4);

    next.foot_l.position = new Vec3(-s_a.foot[0], -2.0 + s_a.foot[1] + jump * -4.0, s_a.foot[2] + Math.max(tilt * footvertlstatic * 1.0, 0.0));
    next.foot_l.orientation = Quat.rotationX(jump * -0.7 + uSlowalt * 0.035 + tilt * footvertlstatic * 0.1 - Math.abs(tilt) * 0.3 * speednorm).mul(Quat.rotationZ(-tilt * 0.3));

    next.foot_r.position = new Vec3(s_a.foot[0], 2.0 + s_a.foot[1] + jump * 4.0, s_a.foot[2] + Math.max(tilt * footvertrstatic * 1.0, 0.0));
    next.foot_r.orientation = Quat.rotationX(jump * 0.7 + uSlow * 0.035 + tilt * footvertrstatic * 0.1 - Math.abs(tilt) * 0.3 * speednorm).mul(Quat.rotationZ(-tilt * 0.3));

    next.chest.orientation = Quat.rotationY(uSlowalt * 0.04).mul(Quat.rotationZ(0.15 + tilt * -0.4));

    next.belt.position = new Vec3(0.0, s_a.belt[0], s_a.belt[1]);
    next.shorts.position = new Vec3(0.0, s_a.shorts[0], s_a.shorts[1]);
  }

  // (hands, active_tool, second_tool): the two-handed / primary hold.
  const [h0, h1] = hands;
  const twoTool = h0 === Hands.Two ? activeToolKind : h0 === null && h1 === Hands.Two ? secondToolKind : undefined;
  if (twoTool !== undefined) {
    switch (twoTool) {
      case ToolKind.Sword: {
        next.control_l.position = next.hand_l.position.muls(0.2).add(new Vec3(s_a.sc[0], s_a.sc[1] - slow * 2.0 * speednorm, s_a.sc[2] + direction * -5.0 - slow * 2.0 * speednorm));
        next.control_r.position = next.control_l.position.clone();
        next.hand_l.position = new Vec3(s_a.shl[0] - 0.5, s_a.shl[1], s_a.shl[2]);
        next.hand_l.orientation = Quat.rotationX(s_a.shl[3]).mul(Quat.rotationY(s_a.shl[4]));
        next.control_l.orientation = Quat.rotationX(s_a.sc[3] + uSlow * 0.05).mul(Quat.rotationZ(uSlowalt * 0.04));
        next.control_r.orientation = Quat.rotationX(s_a.sc[3] + uSlow * 0.15).mul(Quat.rotationZ(uSlowalt * 0.08));
        next.hand_r.position = Vec3.zero();
        next.hand_r.orientation = next.hand_l.orientation.mul(Quat.rotationY(PI * 0.3));
        break;
      }
      case ToolKind.Axe: {
        next.main.position = new Vec3(0.0, 0.0, 0.0);
        next.main.orientation = Quat.rotationX(0.0);
        if (speed < 0.5) {
          next.head.position = new Vec3(0.0, 0.0 + s_a.head[0], s_a.head[1] + uSlow * 0.1);
          next.head.orientation = Quat.rotationZ(headLook.x).mul(Quat.rotationX(0.15 + Math.abs(headLook.y) + lookDir.z * 0.7));
          next.chest.orientation = Quat.rotationX(-0.15).mul(Quat.rotationY(uSlowalt * 0.04)).mul(Quat.rotationZ(0.15));
          next.belt.position = new Vec3(0.0, 1.0 + s_a.belt[0], s_a.belt[1]);
          next.belt.orientation = Quat.rotationX(0.15).mul(Quat.rotationY(uSlowalt * 0.03)).mul(Quat.rotationZ(0.15));
          next.shorts.position = new Vec3(0.0, 1.0 + s_a.shorts[0], s_a.shorts[1]);
          next.shorts.orientation = Quat.rotationX(0.15).mul(Quat.rotationZ(0.25));
        }
        next.hand_l.position = new Vec3(s_a.ahl[0], s_a.ahl[1], s_a.ahl[2]);
        next.hand_l.orientation = Quat.rotationX(s_a.ahl[3]).mul(Quat.rotationY(s_a.ahl[4]));
        next.hand_r.position = new Vec3(s_a.ahr[0], s_a.ahr[1], s_a.ahr[2]);
        next.hand_r.orientation = Quat.rotationX(s_a.ahr[3]).mul(Quat.rotationZ(PI));
        next.control.position = new Vec3(s_a.ac[0], s_a.ac[1], s_a.ac[2] + direction * -5.0);
        next.control.orientation = Quat.rotationX(s_a.ac[3]).mul(Quat.rotationY(s_a.ac[4])).mul(Quat.rotationZ(s_a.ac[5]));
        break;
      }
      case ToolKind.Hammer:
      case ToolKind.Pick: {
        next.hand_l.position = new Vec3(s_a.hhl[0], s_a.hhl[1] + 3.0, s_a.hhl[2] - 1.0);
        next.hand_l.orientation = Quat.rotationX(s_a.hhl[3]).mul(Quat.rotationY(s_a.hhl[4])).mul(Quat.rotationZ(s_a.hhl[5]));
        next.hand_r.position = new Vec3(s_a.hhr[0], s_a.hhr[1] + 3.0, s_a.hhr[2] + 1.0);
        next.hand_r.orientation = Quat.rotationX(s_a.hhr[3]).mul(Quat.rotationY(s_a.hhr[4])).mul(Quat.rotationZ(s_a.hhr[5]));
        next.control.position = new Vec3(s_a.hc[0] - 1.0, s_a.hc[1], s_a.hc[2] + direction * -5.0 - 3.0);
        next.control.orientation = Quat.rotationX(s_a.hc[3] + uSlow * 0.15).mul(Quat.rotationY(s_a.hc[4])).mul(Quat.rotationZ(s_a.hc[5] + uSlowalt * 0.07));
        break;
      }
      case ToolKind.Staff:
      case ToolKind.Sceptre: {
        next.control_l.position = next.hand_l.position.muls(0.2).add(new Vec3(s_a.sc[0] + 1.0, s_a.sc[1] - slow * 2.0 * speednorm - 3.0, s_a.sc[2] + direction * -5.0 - slow * 2.0 * speednorm - 3.0));
        next.control_r.position = next.control_l.position.clone();
        next.hand_l.position = new Vec3(s_a.shl[0] - 0.5, s_a.shl[1], s_a.shl[2] + 0.0);
        next.hand_l.orientation = Quat.rotationX(s_a.shl[3]).mul(Quat.rotationY(s_a.shl[4]));
        next.control_l.orientation = Quat.rotationX(s_a.sc[3] + uSlow * 0.05).mul(Quat.rotationZ(uSlowalt * 0.04));
        next.control_r.orientation = Quat.rotationX(s_a.sc[3] + uSlow * 0.15).mul(Quat.rotationZ(uSlowalt * 0.08));
        next.hand_r.position = new Vec3(0.0, 0.0, 8.0);
        next.hand_r.orientation = next.hand_l.orientation.mul(Quat.rotationY(PI * 0.3));
        break;
      }
      case ToolKind.Bow: {
        next.main.position = new Vec3(0.0, 0.0, 0.0);
        next.main.orientation = Quat.rotationX(0.0);
        next.hand_l.position = new Vec3(s_a.bhl[0], s_a.bhl[1], s_a.bhl[2]);
        next.hand_l.orientation = Quat.rotationX(s_a.bhl[3]);
        next.hand_r.position = new Vec3(s_a.bhr[0], s_a.bhr[1], s_a.bhr[2]);
        next.hand_r.orientation = Quat.rotationX(s_a.bhr[3]);
        next.hold.position = new Vec3(0.0, -1.0, -5.2);
        next.hold.orientation = Quat.rotationX(-PI / 2.0);
        next.hold.scale = Vec3.one().muls(1.0);
        next.control.position = new Vec3(s_a.bc[0], s_a.bc[1], s_a.bc[2] + direction * -5.0);
        next.control.orientation = Quat.rotationX(uSlow * 0.06).mul(Quat.rotationY(s_a.bc[4])).mul(Quat.rotationZ(s_a.bc[5] + uSlowalt * 0.1));
        break;
      }
      case ToolKind.Debug: {
        next.hand_l.position = new Vec3(-7.0, 4.0, 3.0);
        next.hand_l.orientation = Quat.rotationX(1.27);
        next.main.position = new Vec3(-5.0, 5.0, 23.0);
        next.main.orientation = Quat.rotationX(PI);
        break;
      }
      case ToolKind.Farming: {
        if (speed < 0.5) {
          next.head.orientation = Quat.rotationZ(headLook.x).mul(Quat.rotationX(-0.2 + Math.abs(headLook.y) + lookDir.z * 0.7));
        }
        next.hand_l.position = new Vec3(9.0, 1.0, 1.0);
        next.hand_l.orientation = Quat.rotationX(PI / 2.0);
        next.hand_r.position = new Vec3(9.0, 1.0, 11.0);
        next.hand_r.orientation = Quat.rotationX(PI / 2.0);
        next.main.position = new Vec3(7.5, 7.5, 13.2);
        next.main.orientation = Quat.rotationY(PI);
        next.control.position = new Vec3(-11.0 + slow * 2.0, 1.8, 4.0);
        next.control.orientation = Quat.rotationX(uSlow * 0.1).mul(Quat.rotationY(0.6 + uSlow * 0.1)).mul(Quat.rotationZ(uSlowalt * 0.1));
        break;
      }
      case ToolKind.Shovel: {
        next.hand_l.position = new Vec3(8.0, 6.0, 3.0);
        next.hand_l.orientation = Quat.rotationX(PI / 2.0);
        next.hand_r.position = new Vec3(8.0, 6.0, 15.0);
        next.hand_r.orientation = Quat.rotationX(PI / 2.0);
        next.main.position = new Vec3(7.5, 7.5, 13.2);
        next.main.orientation = Quat.rotationY(PI);
        next.control.position = new Vec3(-11.0 + slow * 0.02, 1.8, 4.0);
        next.control.orientation = Quat.rotationX(uSlow * 0.01).mul(Quat.rotationY(0.8 + uSlow * 0.01)).mul(Quat.rotationZ(uSlowalt * 0.01));
        break;
      }
      case ToolKind.Shield: {
        next.hand_l.position = new Vec3(0.0, -2.0, 0.0);
        next.hand_l.orientation = Quat.rotationX(PI / 2.0);
        next.hand_r.position = new Vec3(0.0, 0.0, 0.0);
        next.hand_r.orientation = Quat.rotationX(PI / 2.0).mul(Quat.rotationY(2.0));
        next.control.position = new Vec3(0.0, 7.0, 4.0);
        next.control.orientation = Quat.rotationY(-0.5).mul(Quat.rotationZ(-1.25));
        break;
      }
      // ToolKind.Instrument: omitted (needs AbilitySpec; unreachable in our content).
      default:
        break;
    }
  }

  if (h0 === Hands.One) {
    next.control_l.position = next.hand_l.position.mul(new Vec3(0.5, 0.5, 0.3)).add(new Vec3(-4.0, 0.0, 0.0));
    next.control_l.orientation = Quat.lerp(next.hand_l.orientation, Quat.rotationX(PI * -0.5), 0.65);
    next.hand_l.position = new Vec3(0.0, -2.0, 0.0);
    next.hand_l.orientation = Quat.rotationX(PI * 0.5);
  }
  if ((h0 === null || h0 === Hands.One) && h1 === Hands.One) {
    next.control_r.position = next.hand_r.position.mul(new Vec3(0.5, 0.5, 0.3)).add(new Vec3(4.0, 0.0, 0.0));
    next.control_r.orientation = Quat.lerp(next.hand_r.orientation, Quat.rotationX(PI * -0.5), 0.65);
    next.hand_r.position = new Vec3(0.0, -2.0, 0.0);
    next.hand_r.orientation = Quat.rotationX(PI * 0.5);
  }
  if (h0 === null && (h1 === null || h1 === Hands.One)) {
    next.hand_l.position = new Vec3(-8.0, 2.0, 1.0);
    next.hand_l.orientation = Quat.rotationX(0.5).mul(Quat.rotationY(0.25));
  }
  // (None, None) | (Some(One), None): hand_r block is commented out in Veloren.

  if (h0 === null && h1 === Hands.Two) {
    next.second = next.main.clone();
  }

  next.doHoldLantern(s_a, animTime, animTime, speednorm, 0.0, tilt, lastOri, lookDir);

  return next;
}
