/**
 * RunAnimation — faithful port of Veloren
 * voxygen/anim/src/character/run.rs (pinned commit ad45ea3, GPL-3.0).
 *
 * Mechanical Rust→TS translation (see velorenAnim/PORTING.md). GPL-3.0.
 */
import { PI, Quat, Vec2, Vec3, signum } from '../vek.js';
import { CharacterSkeleton, Hands, SkeletonAttr, ToolKind } from './skeleton.js';

export interface RunDependency {
  activeToolKind: ToolKind | null;
  secondToolKind: ToolKind | null;
  hands: [Hands | null, Hands | null];
  velocity: Vec3;
  orientation: Vec3;
  lastOri: Vec3;
  lookDir: Vec3;
  globalTime: number;
  avgVel: Vec3;
  accVel: number;
  wall: Vec3 | null;
}

export function runAnimation(skeleton: CharacterSkeleton, dep: RunDependency, animTime: number, s_a: SkeletonAttr): CharacterSkeleton {
  const { activeToolKind, secondToolKind, hands, velocity, orientation, lastOri, lookDir, globalTime, avgVel, accVel, wall } = dep;
  const next = skeleton.clone();

  const speed = Vec2.fromVec3(velocity).magnitude();
  const impact = Math.max(avgVel.z, -8.0);
  const speednorm = speed ** 0.5 * 0.3;

  const lab = 0.6 / s_a.scaler ** 0.75;

  const footrotl = Math.sqrt(1.0 / (0.5 + 0.5 * Math.sin(accVel * 1.6 * lab + PI * 1.4) ** 2)) * Math.sin(accVel * 1.6 * lab + PI * 1.4);
  const footrotr = Math.sqrt(1.0 / (0.5 + 0.5 * Math.sin(accVel * 1.6 * lab + PI * 0.4) ** 2)) * Math.sin(accVel * 1.6 * lab + PI * 0.4);

  const noisea = Math.sin(accVel * 11.0 + PI / 6.0);
  const noiseb = Math.sin(accVel * 19.0 + PI / 4.0);

  const backSpeed = 2.6;

  const dirside = signum(orientation.xy().dot(velocity.xy()));
  const foothoril = dirside > 0.0 ? Math.sin(accVel * 1.6 * lab + PI * 1.45) * dirside : Math.sin(accVel * backSpeed * lab + PI * 1.45) * dirside;
  const foothorir = dirside > 0.0 ? Math.sin(accVel * 1.6 * lab + PI * 0.45) * dirside : Math.sin(accVel * backSpeed * lab + PI * 0.45) * dirside;
  const strafeside = signum(orientation.xy().dot(velocity.xy().rotatedZ(PI * -0.5)));
  const footstrafel = Math.sin(accVel * 1.6 * lab + PI * 1.5) * strafeside;
  const footstrafer = Math.sin(accVel * 1.6 * lab + PI) * -strafeside;

  const footvertl = dirside > 0.0 ? Math.sin(accVel * 1.6 * lab) : Math.sin(accVel * backSpeed * lab);
  const footvertr = dirside > 0.0 ? Math.sin(accVel * 1.6 * lab + PI) : Math.sin(accVel * backSpeed * lab + PI);
  const footvertsl = Math.sin(accVel * 1.6 * lab);
  const footvertsr = Math.sin(accVel * 1.6 * lab + PI * 0.5);

  const shortalt = Math.sin(accVel * lab * 3.2 + PI / 1.0);
  const shortalt2 = Math.sin(accVel * lab * 3.2);

  const short = Math.sqrt(5.0 / (1.5 + 3.5 * Math.sin(accVel * lab * 1.6 + PI * 0.5) ** 2)) * Math.sin(accVel * lab * 1.6 + PI * 0.5);

  const side = (velocity.x * -0.098 * orientation.y + velocity.y * 0.098 * orientation.x) * -1.0;
  const sideabs = Math.abs(side);
  const ori = Vec2.fromVec3(orientation);
  const lastOriXy = lastOri.xy();
  const tilt =
    (ori.magnitudeSquared() > 0.001 && Number.isFinite(ori.magnitudeSquared()) && lastOriXy.magnitudeSquared() > 0.001 && Number.isFinite(lastOriXy.magnitudeSquared()) && Number.isFinite(ori.angleBetween(lastOriXy))
      ? Math.min(ori.angleBetween(lastOriXy), 0.2) * signum(lastOriXy.determineSide(Vec2.zero(), ori))
      : 0.0) * 1.3;

  const headLook = new Vec2(Math.sin(Math.floor(globalTime + animTime / 18.0) * 7331.0) * 0.2, Math.sin(Math.floor(globalTime + animTime / 18.0) * 1337.0) * 0.1);

  next.hold.scale = Vec3.one().muls(0.0);

  next.head.position = new Vec3(0.0, s_a.head[0] * 1.5, s_a.head[1] + short * 0.1);
  next.head.orientation = Quat.rotationZ(tilt * -2.5 + headLook.x * 0.2 + short * -0.3 * speednorm).mul(Quat.rotationX(headLook.y + 0.45 * speednorm + shortalt2 * -0.05));
  next.head.scale = Vec3.one().muls(s_a.head_scale);

  next.chest.position = new Vec3(0.0, s_a.chest[0], s_a.chest[1] + 1.0 * speednorm + shortalt * 1.1);
  next.chest.orientation = Quat.rotationX(impact * 0.07)
    .mul(Quat.rotationZ(short * 0.4 * speednorm + tilt * -0.6))
    .mul(Quat.rotationY(tilt * 2.0 + short * 0.2 * speednorm))
    .mul(Quat.rotationX(shortalt2 * 0.03 + speednorm * -0.5 + Math.abs(tilt)));

  next.belt.position = new Vec3(0.0, 0.25 + s_a.belt[0], 0.25 + s_a.belt[1]);
  next.belt.orientation = Quat.rotationX(0.1 * speednorm)
    .mul(Quat.rotationZ(short * -0.2 + tilt * -1.1))
    .mul(Quat.rotationY(tilt * 0.5));

  next.back.position = new Vec3(0.0, s_a.back[0], s_a.back[1]);
  next.back.orientation = Quat.rotationX(-0.05 + short * 0.02 + noisea * 0.02 + noiseb * 0.02).mul(Quat.rotationY(foothorir * 0.35 * speednorm ** 2));

  next.shorts.position = new Vec3(0.0, 0.65 + s_a.shorts[0], 0.65 * speednorm + s_a.shorts[1]);
  next.shorts.orientation = Quat.rotationX(0.2 * speednorm)
    .mul(Quat.rotationZ(short * -0.9 * speednorm + tilt * -1.5))
    .mul(Quat.rotationY(tilt * 0.7 + short * 0.08));

  next.hand_l.position = new Vec3(
    -s_a.hand[0] * 1.2 - foothorir * 1.3 * speednorm + (Math.abs(foothoril) ** 2 - 0.5) * speednorm * 4.0,
    s_a.hand[1] * 1.3 + foothorir * -7.0 * speednorm ** 2 * (1.0 - sideabs),
    s_a.hand[2] - foothorir * 2.75 * speednorm + Math.abs(foothoril) ** 3 * speednorm ** 2 * 8.0,
  );
  next.hand_l.orientation = Quat.rotationX(0.6 * speednorm + (footrotr * -1.5 + 0.5) * speednorm ** 2 * (1.0 - sideabs)).mul(Quat.rotationY(footrotr * 0.4 * speednorm + PI * 0.07));

  next.hand_r.position = new Vec3(
    s_a.hand[0] * 1.2 + foothoril * 1.3 * speednorm - (Math.abs(foothorir) ** 2 - 0.5) * speednorm * 4.0,
    s_a.hand[1] * 1.3 + foothoril * -7.0 * speednorm ** 2 * (1.0 - sideabs),
    s_a.hand[2] - foothoril * 2.75 * speednorm + Math.abs(foothorir) ** 3 * speednorm ** 2 * 8.0,
  );
  next.hand_r.orientation = Quat.rotationX(0.6 * speednorm + (footrotl * -1.5 + 0.5) * speednorm ** 2 * (1.0 - sideabs)).mul(Quat.rotationY(footrotl * -0.4 * speednorm - PI * 0.07));

  next.foot_l.position = new Vec3(
    -s_a.foot[0] + footstrafel * sideabs * 7.0 + tilt * -5.0,
    s_a.foot[1] + (1.0 - sideabs) * (-1.5 * speednorm + foothoril * -10.0 * speednorm),
    s_a.foot[2] + (1.0 - sideabs) * (1.25 + Math.max(footvertl * -5.0, -1.0)) * speednorm + side * Math.max(footvertsl * 1.5, -1.0),
  );
  next.foot_l.orientation = Quat.rotationX((1.0 - sideabs) * (foothoril + 0.3 * (1.0 - sideabs)) * -2.0 * speednorm + sideabs * -0.5)
    .mul(Quat.rotationY(side * (foothoril * 0.3) + footstrafer * side * 0.5))
    .mul(Quat.rotationZ(side * 1.3 * orientation.xy().dot(velocity.xy().divs(speed + 0.01)) - tilt * 2.0));

  next.foot_r.position = new Vec3(
    s_a.foot[0] + footstrafer * sideabs * 7.0 + tilt * -5.0,
    s_a.foot[1] + (1.0 - sideabs) * (-1.5 * speednorm + foothorir * -10.0 * speednorm),
    s_a.foot[2] + (1.0 - sideabs) * (1.25 + Math.max(footvertr * -5.0, -1.0)) * speednorm + side * Math.max(footvertsr * -1.5, -1.0),
  );
  next.foot_r.orientation = Quat.rotationX((1.0 - sideabs) * (foothorir + 0.3 * (1.0 - sideabs)) * -2.0 * speednorm + sideabs * -0.5)
    .mul(Quat.rotationY(side * (foothorir * 0.3) - footstrafer * side * 0.5))
    .mul(Quat.rotationZ(side * 1.3 * orientation.xy().dot(velocity.xy().divs(speed + 0.01)) - tilt * 2.0));

  next.shoulder_l.position = new Vec3(-s_a.shoulder[0], s_a.shoulder[1], s_a.shoulder[2]);
  next.shoulder_l.orientation = Quat.rotationX(short * 0.15 * speednorm + (footrotl * 0.5 + 0.5) * speednorm);
  next.shoulder_l.scale = Vec3.one().muls(1.1);

  next.shoulder_r.position = new Vec3(s_a.shoulder[0], s_a.shoulder[1], s_a.shoulder[2]);
  next.shoulder_r.orientation = Quat.rotationX(short * -0.15 * speednorm + (footrotr * 0.5 + 0.5) * speednorm);
  next.shoulder_r.scale = Vec3.one().muls(1.1);

  next.glider.position = new Vec3(0.0, 0.0, 10.0);
  next.glider.scale = Vec3.one().muls(0.0);

  next.doToolsOnBack(hands, activeToolKind, secondToolKind);
  next.doHoldLantern(s_a, animTime, accVel, speednorm, impact, tilt, lastOri, lookDir);

  next.torso.position = new Vec3(0.0, 0.0, 0.0);

  // Wall-run hand placement (wall = surface normal, or null).
  const wallHands = (rightSub: number, leftSub: number, push: number): void => {
    next.hand_l.position = new Vec3(-s_a.hand[0], s_a.hand[1], s_a.hand[2] + push * 5.0 + 2.0 * leftSub);
    next.hand_r.position = new Vec3(s_a.hand[0], s_a.hand[1], s_a.hand[2] + push * 5.0 + 2.0 * rightSub);
    next.hand_l.orientation = Quat.rotationX(push * 2.0 + footrotr * -0.2 * rightSub)
      .mul(Quat.rotationY(1.0 * leftSub))
      .mul(Quat.rotationZ(2.5 * leftSub + 1.0 * rightSub));
    next.hand_r.orientation = Quat.rotationX(push * 2.0 + footrotl * -0.2 * leftSub)
      .mul(Quat.rotationY(-1.0 * rightSub))
      .mul(Quat.rotationZ(-2.5 * rightSub - 1.0 * leftSub));
  };
  if (wall && wall.y > 0.5) {
    const push = (1.0 - Math.abs(orientation.x)) ** 2;
    wallHands(-Math.min(orientation.x, 0.0), Math.max(orientation.x, 0.0), push);
  } else if (wall && wall.y < -0.5) {
    const push = (1.0 - Math.abs(orientation.x)) ** 2;
    wallHands(Math.max(orientation.x, 0.0), -Math.min(orientation.x, 0.0), push);
  } else if (wall && wall.x < -0.5) {
    const push = (1.0 - Math.abs(orientation.y)) ** 2;
    wallHands(-Math.min(orientation.y, 0.0), Math.max(orientation.y, 0.0), push);
  } else if (wall && wall.x > 0.5) {
    const push = (1.0 - Math.abs(orientation.y)) ** 2;
    wallHands(Math.max(orientation.y, 0.0), -Math.min(orientation.y, 0.0), push);
  }

  return next;
}
