/**
 * Veloren-style voxel character — a spike.
 *
 * The bone hierarchy and the IDLE animation are ported from Veloren
 * (https://gitlab.com/veloren/veloren, GPL-3.0):
 *   - skeleton parenting + Human `SkeletonAttr` offsets ← voxygen/anim/src/character/mod.rs
 *   - IdleAnimation math (the `slow`/`head_look` breathing pose) ← .../character/idle.rs
 * The RUN animation is a faithful reconstruction in Veloren's style (their run.rs
 * uses the same footrot/short/foothor wave technique over an accumulated stride).
 *
 * Segments are Veloren's real .vox parts (CC-BY-SA 3.0; see ATTRIBUTION.md), driven
 * by catalog.json — generated from Veloren's manifests by
 * scripts/gen-veloren-catalog.mjs. Each character = a species (head/hair/beard/eyes)
 * + an outfit (one piece per armor slot) + optionally a held weapon. White
 * "skin-slot" voxels are recoloured with the head's dominant colour; grayscale hair
 * with the species palette; armor with its manifest colour. Because this derives
 * from GPL-3.0 code + CC-BY-SA assets, THIS FILE IS GPL-3.0.
 *
 * Animation is procedural: each frame we compute a full pose (bone position +
 * orientation + scale) from `anim_time`/stride and write it onto the bone groups,
 * exactly like Veloren's `update_skeleton_inner` returning a new skeleton. Pose
 * objects are preallocated and mutated in place (no per-frame allocation).
 *
 * Coordinate note: Veloren + MagicaVoxel are Z-up, +Y-forward. All bones live
 * inside a `space` group rotated -90° about X (Z-up → Three's Y-up) and uniformly
 * scaled to ~1.8 world units, so inside that group we use Veloren coordinates 1:1.
 *
 * Public API matches Avatar/NpcRender so it drops into main.ts:
 *   group, animate(dt, speed), setTint(color), setSwimming(bool), dispose().
 */
import * as THREE from 'three';
import { loadVox, buildVoxMesh, dominantColor } from './voxLoader.js';

const TARGET_H = 1.8;
const MODEL_UNITS = 32;

const XAXIS = new THREE.Vector3(1, 0, 0);
const ZAXIS = new THREE.Vector3(0, 0, 1);

const S_A = {
  headScale: 0.9,
  head: [-2.3, 9.5] as const,
  chest: [0.0, 8.0] as const,
  belt: [0.0, -2.0] as const,
  back: [-3.1, 7.25] as const,
  shorts: [0.0, -5.0] as const,
  hand: [7.0, -0.25, 0.5] as const,
  foot: [3.4, 0.5, 2.0] as const,
  shoulder: [5.0, 0.0, 5.0] as const,
};

type BoneName =
  | 'torso'
  | 'chest'
  | 'head'
  | 'belt'
  | 'back'
  | 'shorts'
  | 'shoulder_l'
  | 'shoulder_r'
  | 'hand_l'
  | 'hand_r'
  | 'foot_l'
  | 'foot_r';
const BONES: BoneName[] = ['torso', 'chest', 'head', 'belt', 'back', 'shorts', 'shoulder_l', 'shoulder_r', 'hand_l', 'hand_r', 'foot_l', 'foot_r'];

// ── catalog.json (generated from Veloren manifests) ──────────────────────────
type Vec3 = [number, number, number];
interface VoxRef {
  vox: string;
  o: Vec3;
  color?: Vec3 | null;
}
export interface Sp {
  id: string;
  sp: string;
  gender: string;
  head: VoxRef;
  hairs: VoxRef[];
  beards: VoxRef[];
  eyes: VoxRef[];
}
interface Pair {
  left: VoxRef;
  right: VoxRef;
}
export interface Catalog {
  species: Sp[];
  hairColors: Record<string, Vec3[]>;
  armor: { chest: VoxRef[]; pants: VoxRef[]; belt: VoxRef[]; foot: VoxRef[]; back: VoxRef[]; hand: Pair[]; shoulder: Pair[] };
  weapons: VoxRef[];
}

// An explicit outfit: one index per slot (into the catalog arrays); -1 = none.
export interface Outfit {
  hair: number;
  beard: number;
  eyes: number;
  hairColor: number;
  chest: number;
  pants: number;
  belt: number;
  foot: number;
  back: number;
  hand: number;
  shoulder: number;
  weapon: number;
}
const OUTFIT_FIELDS: (keyof Outfit)[] = ['hair', 'beard', 'eyes', 'hairColor', 'chest', 'pants', 'belt', 'foot', 'back', 'hand', 'shoulder', 'weapon'];

/** The default outfit: the bare/first option per slot, no beard, no weapon. Used
 *  as the deterministic fallback for a `veloren:<species>` skin that carries no
 *  outfit code (so a player's look is stable, not random per session). */
export function defaultOutfit(): Outfit {
  return { hair: 0, beard: -1, eyes: 0, hairColor: 0, chest: 0, pants: 0, belt: 0, foot: 0, back: 0, hand: 0, shoulder: 0, weapon: -1 };
}

/** Encode a full character into a synced skin id: `veloren:<species>:<i-i-i-…>`.
 *  Indices are stored +1 (so "none" = -1 → 0) — otherwise a negative index would
 *  emit a "--" that split('-') turns into an empty field, shifting every field after it. */
export function encodeVelorenSkin(species: string, o: Outfit): string {
  return `veloren:${species}:` + OUTFIT_FIELDS.map((f) => o[f] + 1).join('-');
}
/** Parse a veloren skin id. `outfit` is null for the legacy `veloren:<species>`
 *  form (no outfit code) — caller falls back to a seeded random outfit. */
export function parseVelorenSkin(skin: string): { species: string; outfit: Outfit | null } | null {
  if (!skin.startsWith('veloren:')) return null;
  const rest = skin.slice('veloren:'.length);
  const ci = rest.indexOf(':');
  if (ci < 0) return { species: rest, outfit: null };
  const nums = rest
    .slice(ci + 1)
    .split('-')
    .map((n) => parseInt(n, 10));
  const o = {} as Outfit;
  OUTFIT_FIELDS.forEach((f, i) => (o[f] = (Number.isFinite(nums[i]) ? nums[i] : 0) - 1)); // stored +1
  return { species: rest.slice(0, ci), outfit: o };
}

export const SPECIES_IDS: string[] = [
  'human_male',
  'human_female',
  'orc_male',
  'orc_female',
  'elf_male',
  'elf_female',
  'dwarf_male',
  'dwarf_female',
  'draugr_male',
  'draugr_female',
  'danari_male',
  'danari_female',
];

let catalogPromise: Promise<Catalog> | null = null;
/** The parsed catalog (species + armor + weapons), loaded once. Exported so the
 *  character editor can introspect slot counts. */
export function velorenCatalog(): Promise<Catalog> {
  if (!catalogPromise) {
    const url = new URL('models/veloren/catalog.json', document.baseURI).href;
    catalogPromise = fetch(url).then((r) => r.json() as Promise<Catalog>);
  }
  return catalogPromise;
}
const loadCatalog = velorenCatalog;

/** A deterministic random outfit for a species (used for the demo + remote players
 *  that only carry `veloren:<species>` with no explicit outfit code). */
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

const rgb = (c: Vec3): number => (c[0] << 16) | (c[1] << 8) | c[2];
function mulberry32(a: number): () => number {
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const isSkinSlot = (vox: string): boolean => vox.includes('/misc/') && vox.includes('none');

interface Pose {
  p: THREE.Vector3;
  q: THREE.Quaternion;
  s: number;
}

export class VelorenCharacter {
  readonly group = new THREE.Group();
  private readonly space = new THREE.Group();
  private readonly bones = {} as Record<BoneName, THREE.Group>;
  private readonly tinted: THREE.MeshBasicMaterial[] = [];
  private readonly speciesId: string;
  private readonly outfit: Outfit | number; // explicit outfit, or a seed for a random one

  private animTime = 0;
  private stride = 0;
  private runAmt = 0;
  private digT = 0; // one-shot place/dig swing timer (seconds)
  private mining = false; // held: keep swinging while breaking a block
  private firstPerson = false; // hide the head (+hair/eyes) so it doesn't block the FP camera
  // Preallocated poses + scratch quaternions (mutated in place — no per-frame GC).
  private readonly idlePose = {} as Record<BoneName, Pose>;
  private readonly runPose = {} as Record<BoneName, Pose>;
  private readonly qa = new THREE.Quaternion();
  private readonly qb = new THREE.Quaternion();

  /** @param outfit an explicit Outfit, or a number seed for a deterministic random one. */
  constructor(speciesId = 'human_male', outfit: Outfit | number = 0) {
    this.speciesId = speciesId;
    this.outfit = outfit;
    for (const n of BONES) {
      this.idlePose[n] = { p: new THREE.Vector3(), q: new THREE.Quaternion(), s: 1 };
      this.runPose[n] = { p: new THREE.Vector3(), q: new THREE.Quaternion(), s: 1 };
    }
    this.space.rotation.x = -Math.PI / 2; // Veloren Z-up → Three Y-up
    this.space.scale.setScalar(TARGET_H / MODEL_UNITS);
    this.group.add(this.space);
    this.buildSkeleton();
    this.applyPose(this.computeIdle());
    void this.loadParts();
  }

  private buildSkeleton(): void {
    const mk = (name: BoneName, parent: THREE.Object3D): THREE.Group => {
      const g = new THREE.Group();
      parent.add(g);
      this.bones[name] = g;
      return g;
    };
    const torso = mk('torso', this.space);
    const chest = mk('chest', torso);
    mk('head', chest);
    mk('belt', chest);
    mk('back', chest);
    mk('shorts', chest);
    mk('shoulder_l', chest);
    mk('shoulder_r', chest);
    mk('hand_l', chest);
    mk('hand_r', chest);
    mk('foot_l', torso);
    mk('foot_r', torso);
  }

  private attach(bone: BoneName, mesh: THREE.Object3D, mat?: THREE.MeshBasicMaterial): void {
    this.bones[bone].add(mesh);
    if (mat) this.tinted.push(mat);
  }

  private async place(base: string, ref: VoxRef, bone: BoneName, recolor?: number): Promise<void> {
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
      const cat = await loadCatalog();
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
      const one = (ref: VoxRef | null, bone: BoneName): void => {
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
      // Held weapon in the right hand. NOTE: grip transform is approximate (weapon
      // offsets are in Veloren's `main` bone frame) — may need tuning.
      const w = at(cat.weapons, of.weapon);
      if (w) jobs.push(this.placeWeapon(base, w));
      await Promise.all(jobs);
    } catch (e) {
      console.warn('[veloren] load failed:', this.speciesId, e);
    }
    this.normalise();
  }

  /** Weapon held in the right hand: wrapped in a grip group (tuning transform) so
   *  the blade stands up along the arm and swings with the hand during the run. */
  private async placeWeapon(base: string, w: VoxRef): Promise<void> {
    const m = await loadVox(base + w.vox);
    const mesh = buildVoxMesh(m, w.o, w.color ? rgb(w.color) : undefined);
    const grip = new THREE.Group();
    grip.rotation.set(-Math.PI / 2, 0, 0); // stand the blade up out of the fist
    grip.position.set(0, 0, 0);
    grip.add(mesh);
    this.attach('hand_r', grip, mesh.material as THREE.MeshBasicMaterial);
  }

  private normalise(): void {
    this.space.scale.setScalar(1);
    this.space.position.set(0, 0, 0);
    // Measure in GROUP-LOCAL space: the demo may already have positioned/rotated
    // `group` in the world, and setFromObject uses world matrices — so neutralise
    // the group transform while measuring, then restore it. (Otherwise the world
    // Y leaks into space.position.y and the figure sinks through the ground.)
    const savedPos = this.group.position.clone();
    const savedQuat = this.group.quaternion.clone();
    this.group.position.set(0, 0, 0);
    this.group.quaternion.identity();
    this.group.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(this.space);
    const h = box.max.y - box.min.y || 1;
    const s = TARGET_H / h;
    this.space.scale.setScalar(s);
    this.space.position.y = -box.min.y * s;
    this.group.position.copy(savedPos);
    this.group.quaternion.copy(savedQuat);
    this.group.updateMatrixWorld(true);
  }

  // ── Poses (mutate preallocated objects) ───────────────────────────────────────

  private put(P: Record<BoneName, Pose>, name: BoneName, x: number, y: number, z: number, q: THREE.Quaternion, s = 1): void {
    const t = P[name];
    t.p.set(x, y, z);
    t.q.copy(q);
    t.s = s;
  }
  private rotZ(a: number): THREE.Quaternion {
    return this.qa.setFromAxisAngle(ZAXIS, a);
  }
  private rotX(a: number): THREE.Quaternion {
    return this.qa.setFromAxisAngle(XAXIS, a);
  }

  /** IdleAnimation, ported from Veloren idle.rs (breathing bob + idle head-look). */
  private computeIdle(): Record<BoneName, Pose> {
    const t = this.animTime;
    const slow = Math.sin(t);
    const lookX = Math.sin(Math.floor(t / 12) * 7331.0) * 0.1;
    const lookY = Math.sin(Math.floor(t / 12) * 1337.0) * 0.05;
    const P = this.idlePose;
    this.put(P, 'torso', 0, 0, 0, this.qa.identity());
    this.put(P, 'chest', 0, S_A.chest[0], S_A.chest[1] + slow * 0.3, this.rotZ(lookX * 0.6), 1.01);
    // head: rotZ(lookX) * rotX(|lookY|)
    this.qb.setFromAxisAngle(XAXIS, Math.abs(lookY));
    this.qa.setFromAxisAngle(ZAXIS, lookX).multiply(this.qb);
    this.put(P, 'head', 0, S_A.head[0], S_A.head[1] + slow * 0.3, this.qa, S_A.headScale);
    this.put(P, 'belt', 0, S_A.belt[0], S_A.belt[1], this.rotZ(lookX * -0.1));
    this.put(P, 'back', 0, S_A.back[0], S_A.back[1], this.qa.identity(), 1.02);
    this.put(P, 'shorts', 0, S_A.shorts[0], S_A.shorts[1], this.rotZ(lookX * -0.2));
    this.put(P, 'shoulder_l', -S_A.shoulder[0], S_A.shoulder[1], S_A.shoulder[2], this.qa.identity(), 1.1);
    this.put(P, 'shoulder_r', S_A.shoulder[0], S_A.shoulder[1], S_A.shoulder[2], this.qa.identity(), 1.1);
    this.put(P, 'hand_l', -S_A.hand[0], S_A.hand[1] + slow * 0.15, S_A.hand[2] + slow * 0.5, this.rotX(slow * -0.06), 1.04);
    this.put(P, 'hand_r', S_A.hand[0], S_A.hand[1] + slow * 0.15, S_A.hand[2] + slow * 0.5, this.rotX(slow * -0.06), 1.04);
    this.put(P, 'foot_l', -S_A.foot[0], S_A.foot[1], S_A.foot[2], this.qa.identity());
    this.put(P, 'foot_r', S_A.foot[0], S_A.foot[1], S_A.foot[2], this.qa.identity());
    return P;
  }

  /** RunAnimation — reconstruction of Veloren's gait: legs swing in antiphase,
   *  arms counter the legs, torso bobs at 2× stride, slight forward lean. */
  private computeRun(): Record<BoneName, Pose> {
    const ph = this.stride;
    const swingL = Math.sin(ph);
    const swingR = Math.sin(ph + Math.PI);
    // Lift during the SWING (return) half — foot off the ground while sweeping
    // back→front (cos>0). During stance (cos<0) it stays planted and pushes the
    // body forward. (Flipping this sign = moonwalk.)
    const liftL = Math.max(0, Math.cos(ph));
    const liftR = Math.max(0, Math.cos(ph + Math.PI));
    const bob = Math.abs(Math.sin(ph));
    const sway = Math.sin(ph);
    const sn = this.runAmt;
    const FSTEP = 5.0,
      FLIFT = 3.5,
      ASTEP = 4.5,
      BOB = 1.6;
    const P = this.runPose;
    this.put(P, 'torso', 0, 0, bob * BOB * sn, this.qa.identity());
    // chest: rotX(lean) * rotZ(sway)
    this.qb.setFromAxisAngle(ZAXIS, sway * 0.06 * sn);
    this.qa.setFromAxisAngle(XAXIS, 0.12 * sn).multiply(this.qb);
    this.put(P, 'chest', 0, S_A.chest[0], S_A.chest[1], this.qa);
    this.qb.setFromAxisAngle(ZAXIS, -sway * 0.05 * sn);
    this.qa.setFromAxisAngle(XAXIS, 0.1 * sn).multiply(this.qb);
    this.put(P, 'head', 0, S_A.head[0], S_A.head[1] + bob * 0.1 * sn, this.qa);
    this.put(P, 'belt', 0, S_A.belt[0], S_A.belt[1], this.rotZ(sway * -0.05 * sn));
    this.put(P, 'back', 0, S_A.back[0], S_A.back[1], this.qa.identity());
    this.put(P, 'shorts', 0, S_A.shorts[0], S_A.shorts[1], this.rotZ(sway * -0.08 * sn));
    this.put(P, 'shoulder_l', -S_A.shoulder[0], S_A.shoulder[1], S_A.shoulder[2], this.rotX(-swingR * 0.2 * sn));
    this.put(P, 'shoulder_r', S_A.shoulder[0], S_A.shoulder[1], S_A.shoulder[2], this.rotX(-swingL * 0.2 * sn));
    this.put(P, 'hand_l', -S_A.hand[0], S_A.hand[1] + swingR * ASTEP * sn, S_A.hand[2], this.rotX(swingR * 0.6 * sn));
    this.put(P, 'hand_r', S_A.hand[0], S_A.hand[1] + swingL * ASTEP * sn, S_A.hand[2], this.rotX(swingL * 0.6 * sn));
    this.put(P, 'foot_l', -S_A.foot[0], S_A.foot[1] + swingL * FSTEP * sn, S_A.foot[2] + liftL * FLIFT * sn, this.rotX(swingL * 0.5 * sn));
    this.put(P, 'foot_r', S_A.foot[0], S_A.foot[1] + swingR * FSTEP * sn, S_A.foot[2] + liftR * FLIFT * sn, this.rotX(swingR * 0.5 * sn));
    return P;
  }

  private applyPose(p: Record<BoneName, Pose>): void {
    for (const name of BONES) {
      const b = this.bones[name];
      const t = p[name];
      b.position.copy(t.p);
      b.quaternion.copy(t.q);
      b.scale.setScalar(t.s);
    }
  }

  // ── Public API (matches Avatar/NpcRender) ─────────────────────────────────────

  animate(dt: number, speed = 0, _pitch = 0): void {
    this.animTime += dt;
    this.stride += speed * dt * 1.4;
    const wantRun = speed > 0.4 ? 1 : 0;
    this.runAmt += (wantRun - this.runAmt) * Math.min(1, dt * 8);
    const idle = this.computeIdle();
    if (this.runAmt < 0.001) {
      this.applyPose(idle);
    } else {
      const run = this.computeRun();
      for (const name of BONES) {
        const a = idle[name];
        const r = run[name];
        const b = this.bones[name];
        b.position.copy(a.p).lerp(r.p, this.runAmt);
        b.quaternion.copy(a.q).slerp(r.q, this.runAmt);
        b.scale.setScalar(a.s + (r.s - a.s) * this.runAmt);
      }
    }
    this.applyDigSwing(dt); // place/dig arm swing, layered on top of idle/run
    if (this.firstPerson) this.bones.head.scale.setScalar(0.0001); // hide head/hair/eyes in FP
  }

  /** First person: hide the head so it doesn't fill the camera (body + weapon stay
   *  visible, like Veloren's first-person view — it has no separate hands model). */
  setFirstPerson(on: boolean): void {
    this.firstPerson = on;
  }

  /** Overlay a right-arm chop when placing (one-shot) or mining (held). The held
   *  weapon follows, being a child of hand_r. */
  private applyDigSwing(dt: number): void {
    if (this.digT > 0) this.digT -= dt;
    if (!this.mining && this.digT <= 0) return;
    const t = this.mining ? this.animTime * 9 : (1 - this.digT / 0.35) * Math.PI; // loop vs single chop
    const chop = -Math.abs(Math.sin(t)) * 1.2; // forearm swings forward/down
    this.bones.hand_r.quaternion.multiply(this.qa.setFromAxisAngle(XAXIS, chop));
    this.bones.shoulder_r.quaternion.multiply(this.qb.setFromAxisAngle(XAXIS, chop * 0.3));
  }

  /** One-shot swing (block place / a single dig). */
  playDig(): void {
    this.digT = 0.35;
  }
  /** Held state: keep swinging while breaking a block. */
  setMining(on: boolean): void {
    this.mining = on;
  }

  /** No-op: kept so the character satisfies the same interface as Avatar (the
   *  player-render code calls setSwimming); a swim pose isn't ported yet. */
  setSwimming(_on: boolean): void {}

  /** Animation phase (anim time / stride / run blend). Carry it across a rebuild
   *  so swapping outfit parts in the editor keeps the pose continuous. */
  get animState(): { animTime: number; stride: number; runAmt: number } {
    return { animTime: this.animTime, stride: this.stride, runAmt: this.runAmt };
  }
  set animState(s: { animTime: number; stride: number; runAmt: number }) {
    this.animTime = s.animTime;
    this.stride = s.stride;
    this.runAmt = s.runAmt;
  }

  /** Day/night tint — multiplies every (unlit, vertex-coloured) segment. */
  setTint(c: THREE.Color): void {
    for (const mat of this.tinted) mat.color.copy(c);
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
