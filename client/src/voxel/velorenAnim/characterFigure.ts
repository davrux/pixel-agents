/**
 * CharacterFigure — the faithful Veloren renderer + driver (approach B).
 *
 * Standalone new renderer built on the ported `velorenAnim` engine, kept SEPARATE
 * from the shipping `velorenChar.ts` so both can be compared in isolation until
 * this one is visually verified. Once proven, main.ts switches to it.
 *
 * The rig is Veloren's matrix chain (computeMatricesInner), not a Three scene
 * graph: each frame we synthesise Veloren's animation Dependency from movement,
 * run the selected animation against a FRESH base skeleton (like voxygen), smooth
 * the displayed skeleton toward it, compute the bone matrices and write them onto
 * flat mesh-bone nodes. GPL-3.0 (derives from GPL-3.0 code + CC-BY-SA assets).
 */
import * as THREE from 'three';
import { loadVox, buildVoxMesh, dominantColor } from '../voxLoader.js';
import { Mat4, Vec3 as V3 } from './vek.js';
import { CharacterSkeleton, ComputedCharacterSkeleton, Hands, HumanoidBody, MESH_BONES, MeshBone, SkeletonAttr, ToolKind, BodyType, Species, skeletonAttrFromBody, lerpSkeleton } from './character/skeleton.js';
import { idleAnimation } from './character/idle.js';
import { runAnimation } from './character/run.js';
import { jumpAnimation } from './character/jump.js';
import { wieldAnimation } from './character/wield.js';
import { velorenCatalog, type Catalog, type Outfit, type Sp } from '../velorenChar.js';

const TARGET_H = 1.8;
const SKELETON_LERP_RATE = 15;

type Vec3 = [number, number, number];
interface VoxRef {
  vox: string;
  o: Vec3;
  color?: Vec3 | null;
}

const rgb = (c: Vec3): number => (c[0] << 16) | (c[1] << 8) | c[2];
const isSkinSlot = (vox: string): boolean => vox.includes('/misc/') && vox.includes('none');
function mulberry32(a: number): () => number {
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function randomOutfit(sp: Sp, cat: Catalog, seed: number): Outfit {
  const rnd = mulberry32(seed + 1);
  const ri = (arr: unknown[]): number => (arr.length ? Math.floor(rnd() * arr.length) : -1);
  return {
    hair: ri(sp.hairs),
    beard: sp.gender === 'male' ? ri(sp.beards) : -1,
    eyes: ri(sp.eyes),
    hairColor: ri(cat.hairColors[sp.sp] ?? []),
    chest: ri(cat.armor.chest),
    pants: ri(cat.armor.pants),
    belt: ri(cat.armor.belt),
    foot: ri(cat.armor.foot),
    back: ri(cat.armor.back),
    hand: ri(cat.armor.hand),
    shoulder: ri(cat.armor.shoulder),
    weapon: rnd() < 0.6 ? ri(cat.weapons) : -1,
  };
}

function toolKindOf(voxPath: string): string {
  const m = voxPath.match(/weapon\/([a-z]+)\//);
  return m ? m[1] : '';
}
function mapTool(kind: string): { tool: ToolKind | null; hands: [Hands | null, Hands | null] } {
  switch (kind) {
    case 'sword':
      return { tool: ToolKind.Sword, hands: [Hands.Two, null] };
    case 'axe':
      return { tool: ToolKind.Axe, hands: [Hands.Two, null] };
    case 'hammer':
      return { tool: ToolKind.Hammer, hands: [Hands.Two, null] };
    case 'bow':
      return { tool: ToolKind.Bow, hands: [Hands.Two, null] };
    case 'staff':
      return { tool: ToolKind.Staff, hands: [Hands.Two, null] };
    case 'sceptre':
      return { tool: ToolKind.Sceptre, hands: [Hands.Two, null] };
    case 'spear':
      return { tool: ToolKind.Spear, hands: [Hands.Two, null] };
    case 'dagger':
      return { tool: ToolKind.Dagger, hands: [Hands.One, null] };
    case 'shield':
      return { tool: ToolKind.Shield, hands: [Hands.One, null] };
    default:
      return { tool: null, hands: [null, null] };
  }
}
function parseSpeciesId(id: string): HumanoidBody {
  const [sp, ge] = id.split('_');
  const cap = (s: string): string => (s ? s[0].toUpperCase() + s.slice(1) : s);
  return new HumanoidBody(cap(sp) as Species, cap(ge) as BodyType);
}

export class CharacterFigure {
  readonly group = new THREE.Group();
  private readonly space = new THREE.Group();
  private readonly bones = {} as Record<MeshBone, THREE.Group>;
  private readonly tinted: THREE.MeshBasicMaterial[] = [];
  private weaponMat: THREE.MeshBasicMaterial | null = null;
  private readonly speciesId: string;
  private readonly outfit: Outfit | number;

  private readonly body: HumanoidBody;
  private readonly s_a: SkeletonAttr;
  private skel: CharacterSkeleton;
  private seeded = false;
  private toolDep = mapTool('');

  private animTime = 0;
  private globalTime = 0;
  private stride = 0;
  private prevYaw = 0;
  private digT = 0;
  private mining = false;
  private firstPerson = false;
  private airborne = false;
  private vertVel = 0;

  constructor(speciesId = 'human_male', outfit: Outfit | number = 0) {
    this.speciesId = speciesId;
    this.outfit = outfit;
    this.body = parseSpeciesId(speciesId);
    this.s_a = skeletonAttrFromBody(this.body);
    this.skel = new CharacterSkeleton(false, 0, 1);

    this.space.rotation.x = -Math.PI / 2; // Veloren Z-up → Three Y-up
    this.group.add(this.space);
    for (const n of MESH_BONES) {
      const g = new THREE.Group();
      g.matrixAutoUpdate = false;
      this.space.add(g);
      this.bones[n] = g;
    }
    this.updatePose(0, 0, 0); // seed idle
    void this.loadParts();
  }

  private attach(bone: MeshBone, mesh: THREE.Object3D, mat?: THREE.MeshBasicMaterial): void {
    this.bones[bone].add(mesh);
    if (mat) this.tinted.push(mat);
  }
  private async place(base: string, ref: VoxRef, bone: MeshBone, recolor?: number): Promise<void> {
    const m = await loadVox(base + ref.vox);
    const mesh = buildVoxMesh(m, ref.o, recolor);
    this.attach(bone, mesh, mesh.material as THREE.MeshBasicMaterial);
  }
  private armorColor(ref: VoxRef, skin: number): number | undefined {
    if (ref.color) return rgb(ref.color);
    if (isSkinSlot(ref.vox)) return skin;
    return undefined;
  }

  private async loadParts(): Promise<void> {
    const base = new URL('models/veloren/', document.baseURI).href;
    try {
      const cat = await velorenCatalog();
      const sp = cat.species.find((s) => s.id === this.speciesId) ?? cat.species[0];
      const of = typeof this.outfit === 'number' ? randomOutfit(sp, cat, this.outfit) : this.outfit;
      const at = <T>(arr: T[], i: number): T | null => (arr && i >= 0 && i < arr.length ? arr[i] : null);

      const headVox = await loadVox(base + sp.head.vox);
      const skin = dominantColor(headVox);
      const headMesh = buildVoxMesh(headVox, sp.head.o);
      this.attach('head', headMesh, headMesh.material as THREE.MeshBasicMaterial);

      const hcArr = cat.hairColors[sp.sp] ?? [[74, 53, 36]];
      const hairCol = rgb(hcArr[Math.max(0, Math.min(hcArr.length - 1, of.hairColor))] ?? [74, 53, 36]);
      const hair = at(sp.hairs, of.hair);
      if (hair) await this.place(base, hair, 'head', hair.vox.includes('bald') ? skin : hairCol);
      const beard = at(sp.beards, of.beard);
      if (beard) await this.place(base, beard, 'head', hairCol);
      const eyes = at(sp.eyes, of.eyes);
      if (eyes) await this.place(base, eyes, 'head');

      const a = cat.armor;
      const jobs: Promise<void>[] = [];
      const one = (ref: VoxRef | null, bone: MeshBone): void => {
        if (ref) jobs.push(this.place(base, ref, bone, this.armorColor(ref, skin)));
      };
      one(at(a.chest, of.chest), 'chest');
      one(at(a.pants, of.pants), 'shorts');
      one(at(a.belt, of.belt), 'belt');
      one(at(a.back, of.back), 'back');
      const foot = at(a.foot, of.foot);
      one(foot, 'foot_l');
      one(foot, 'foot_r');
      const hand = at(a.hand, of.hand);
      if (hand) {
        one(hand.left, 'hand_l');
        one(hand.right, 'hand_r');
      }
      const sh = at(a.shoulder, of.shoulder);
      if (sh) {
        one(sh.left, 'shoulder_l');
        one(sh.right, 'shoulder_r');
      }
      const w = at(cat.weapons, of.weapon);
      if (w) {
        this.toolDep = mapTool(toolKindOf(w.vox));
        const m = await loadVox(base + w.vox);
        const mesh = buildVoxMesh(m, w.o, w.color ? rgb(w.color) : undefined);
        this.weaponMat = mesh.material as THREE.MeshBasicMaterial;
        this.attach('main', mesh, this.weaponMat);
      }
      await Promise.all(jobs);
    } catch (e) {
      console.warn('[veloren] load failed:', this.speciesId, e);
    }
    this.normalise();
  }

  private normalise(): void {
    this.updatePose(0, 0, 0);
    this.space.scale.setScalar(1);
    this.space.position.set(0, 0, 0);
    const savedPos = this.group.position.clone();
    const savedQuat = this.group.quaternion.clone();
    this.group.position.set(0, 0, 0);
    this.group.quaternion.identity();
    this.group.updateMatrixWorld(true);
    const h = new THREE.Box3().setFromObject(this.space).getSize(new THREE.Vector3()).y || 1;
    const s = TARGET_H / h;
    this.space.scale.setScalar(s);
    this.group.updateMatrixWorld(true);
    const minY = new THREE.Box3().setFromObject(this.space).min.y;
    this.space.position.y = -minY;
    this.group.position.copy(savedPos);
    this.group.quaternion.copy(savedQuat);
    this.group.updateMatrixWorld(true);
  }

  private yaw(): number {
    return new THREE.Euler().setFromQuaternion(this.group.quaternion, 'YXZ').y;
  }

  private updatePose(dt: number, speed: number, pitch: number): void {
    this.animTime += dt;
    this.globalTime += dt;
    this.stride += speed * dt;

    const yaw = this.yaw();
    const dir = (y: number): V3 => new V3(Math.sin(y), Math.cos(y), 0);
    const orientation = dir(yaw);
    const lastOri = dir(this.prevYaw);
    this.prevYaw = yaw;
    const velocity = new V3(orientation.x * speed, orientation.y * speed, this.vertVel);
    const lookDir = new V3(orientation.x, orientation.y, Math.sin(pitch));
    const avgVel = new V3(0, 0, this.vertVel);
    const { tool, hands } = this.toolDep;

    // FRESH base skeleton every frame (voxygen passes CharacterSkeleton::new, NOT
    // the previous skeleton — otherwise bones an animation leaves untouched keep
    // stale values, e.g. idle doesn't set foot orientation → stuck tiptoes).
    const fresh = new CharacterSkeleton(false, 0, 1);
    let base: CharacterSkeleton;
    if (this.airborne) {
      base = jumpAnimation(fresh, { activeToolKind: tool, secondToolKind: null, hands, velocity, orientation, lastOri, lookDir, globalTime: this.globalTime }, this.animTime, this.s_a);
    } else if (speed > 0.5) {
      base = runAnimation(fresh, { activeToolKind: tool, secondToolKind: null, hands, velocity, orientation, lastOri, lookDir, globalTime: this.globalTime, avgVel, accVel: this.stride, wall: null }, this.animTime, this.s_a);
    } else {
      base = idleAnimation(fresh, { activeToolKind: tool, secondToolKind: null, hands, globalTime: this.globalTime }, this.animTime, this.s_a);
    }
    // Veloren chains wield on top of the movement anim (weapon into the hands,
    // legs kept from the base). Our character is always "wielding" a held tool.
    const target = tool != null ? wieldAnimation(base, { activeToolKind: tool, secondToolKind: null, hands, orientation, lastOri, lookDir, velocity, isRiding: false, globalTime: this.globalTime }, this.animTime, this.s_a) : base;

    const t = this.seeded ? Math.min(1, dt * SKELETON_LERP_RATE) : 1;
    this.seeded = true;
    this.skel = lerpSkeleton(this.skel, target, t);
    this.applyDigSwing(this.skel, dt);

    const computed = this.skel.computeMatricesInner(Mat4.identity(), this.body);
    this.applyToNodes(computed);
    this.bones.head.visible = !this.firstPerson;
  }

  private applyToNodes(c: ComputedCharacterSkeleton): void {
    for (const n of MESH_BONES) this.bones[n].matrix.copy(c[n].m);
  }

  private applyDigSwing(next: CharacterSkeleton, dt: number): void {
    if (this.digT > 0) this.digT -= dt;
    if (!this.mining && this.digT <= 0) return;
    const b = this.mining ? (this.animTime % 0.75) / 0.75 : 1 - this.digT / 0.35;
    const c01 = (v: number): number => Math.max(0, Math.min(1, v));
    const m1base = c01(b / 0.4);
    const m2base = c01((b - 0.4) / 0.35);
    const m3base = c01((b - 0.75) / 0.25);
    const pullback = 1 - m3base;
    const m1 = m1base * pullback;
    const m2 = m2base * pullback;
    const ctrl = next.control;
    ctrl.orientation.rotateX(m1 * 2.7).rotateZ(m1 * 1.4).rotateX(m1 * -1.2);
    ctrl.position.x += -12 * m1;
    ctrl.orientation.rotateX(m2 * -1.9).rotateZ(m2 * 0.6);
    next.chest.orientation.rotateZ(m1 * 0.8 + m2 * -1.4);
    next.head.orientation.rotateZ(m1 * -0.3 + m2 * 0.5);
    next.belt.orientation.rotateZ(m1 * -0.1 + m2 * 0.3);
    next.shorts.orientation.rotateZ(m1 * -0.5 + m2 * 1.0);
  }

  // ── Public API (matches VelorenCharacter) ─────────────────────────────────────
  animate(dt: number, speed = 0, pitch = 0): void {
    this.updatePose(dt, speed, pitch);
  }
  setAirborne(on: boolean, vy = 0): void {
    this.airborne = on;
    this.vertVel = vy;
  }
  setFirstPerson(on: boolean): void {
    this.firstPerson = on;
  }
  playDig(): void {
    this.digT = 0.35;
  }
  setMining(on: boolean): void {
    this.mining = on;
  }
  setSwimming(_on: boolean): void {}
  get animState(): { animTime: number; stride: number; runAmt: number } {
    return { animTime: this.animTime, stride: this.stride, runAmt: 0 };
  }
  set animState(s: { animTime: number; stride: number; runAmt: number }) {
    this.animTime = s.animTime;
    this.globalTime = s.animTime;
    this.stride = s.stride;
  }
  setTint(c: THREE.Color): void {
    for (const mat of this.tinted) mat.color.copy(c);
  }
  setOpacity(o: number): void {
    for (const mat of this.tinted) {
      if (mat === this.weaponMat) continue;
      mat.transparent = o < 0.999;
      mat.opacity = o;
      mat.depthWrite = o >= 0.999;
    }
  }
  dispose(): void {
    this.group.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.isMesh) {
        m.geometry?.dispose();
        (m.material as THREE.Material)?.dispose();
      }
    });
  }
}
