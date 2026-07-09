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
 * by catalog.json — generated from Veloren's humanoid_*_manifest.ron by
 * scripts/gen-veloren-catalog.mjs. Each character = a species (head/hair/beard/eyes)
 * plus an outfit picking one piece per armor slot (chest/pants/belt/foot/hand/
 * shoulder/back). White "skin-slot" voxels are recoloured with the head's dominant
 * (skin) colour; grayscale hair with the species hair palette; armor with its
 * manifest colour. Because this derives from GPL-3.0 code + CC-BY-SA assets, THIS
 * FILE IS GPL-3.0.
 *
 * Animation is procedural: each frame we compute a full pose (bone position +
 * orientation + scale) from `anim_time`/stride and write it onto the bone groups,
 * exactly like Veloren's `update_skeleton_inner` returning a new skeleton.
 *
 * Coordinate note: Veloren + MagicaVoxel are Z-up, +Y-forward. All bones live
 * inside a `space` group rotated -90° about X (Z-up → Three's Y-up) and uniformly
 * scaled to ~1.8 world units, so inside that group we use Veloren coordinates 1:1.
 *
 * Public API matches Avatar/NpcRender so it drops into main.ts:
 *   group, animate(dt, speed), setTint(color), dispose().
 */
import * as THREE from 'three';
import { loadVox, buildVoxMesh, dominantColor } from './voxLoader.js';

const TARGET_H = 1.8; // world-units tall (matches the player AABB, like Avatar)
const MODEL_UNITS = 32; // rough figure height in voxels — initial scale before load

const XAXIS = new THREE.Vector3(1, 0, 0);
const ZAXIS = new THREE.Vector3(0, 0, 1);
const rotX = (a: number): THREE.Quaternion => new THREE.Quaternion().setFromAxisAngle(XAXIS, a);
const rotZ = (a: number): THREE.Quaternion => new THREE.Quaternion().setFromAxisAngle(ZAXIS, a);

// Human male SkeletonAttr offsets from Veloren mod.rs. Tuples follow the anim
// crate's usage: `.0`→Y (forward), `.1`→Z (up); hand/foot/shoulder add `.0`→X.
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

// ── catalog.json (generated from Veloren manifests) ──────────────────────────
type Vec3 = [number, number, number];
interface VoxRef {
  vox: string; // path relative to models/veloren/
  o: Vec3; // bone-local placement offset
  color?: Vec3 | null; // armor tint (grayscale vox), if any
}
interface Sp {
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
interface Catalog {
  species: Sp[];
  hairColors: Record<string, Vec3[]>;
  armor: { chest: VoxRef[]; pants: VoxRef[]; belt: VoxRef[]; foot: VoxRef[]; back: VoxRef[]; hand: Pair[]; shoulder: Pair[] };
}

// The 12 species ids (stable) so main.ts can spawn the row without awaiting the catalog.
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
function loadCatalog(): Promise<Catalog> {
  if (!catalogPromise) {
    const url = new URL('models/veloren/catalog.json', document.baseURI).href;
    catalogPromise = fetch(url).then((r) => r.json() as Promise<Catalog>);
  }
  return catalogPromise;
}

const rgb = (c: Vec3): number => (c[0] << 16) | (c[1] << 8) | c[2];
// Deterministic PRNG so a given seed always yields the same outfit.
function mulberry32(a: number): () => number {
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
// The bare "skin slot" pieces (armor.misc.*.none) are white → tint with skin.
const isSkinSlot = (vox: string): boolean => vox.includes('/misc/') && vox.includes('none');

interface Pose {
  p: THREE.Vector3;
  q: THREE.Quaternion;
  s: number;
}
const pose = (p: THREE.Vector3, q: THREE.Quaternion, s = 1): Pose => ({ p, q, s });

export class VelorenCharacter {
  readonly group = new THREE.Group();
  private readonly space = new THREE.Group();
  private readonly bones = {} as Record<BoneName, THREE.Group>;
  private readonly tinted: THREE.MeshBasicMaterial[] = [];
  private readonly speciesId: string;
  private readonly seed: number;

  private animTime = 0;
  private stride = 0;
  private runAmt = 0;
  private readonly idlePose = {} as Record<BoneName, Pose>;
  private readonly runPose = {} as Record<BoneName, Pose>;

  /** @param seed picks the (deterministic) outfit — armor/hair/beard/eyes variants. */
  constructor(speciesId = 'human_male', seed = 0) {
    this.speciesId = speciesId;
    this.seed = seed;
    this.space.rotation.x = -Math.PI / 2; // Veloren Z-up → Three Y-up
    this.space.scale.setScalar(TARGET_H / MODEL_UNITS); // sane guess until parts load
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

  private attach(bone: BoneName, mesh: THREE.Mesh): void {
    this.bones[bone].add(mesh);
    this.tinted.push(mesh.material as THREE.MeshBasicMaterial);
  }

  private async place(base: string, ref: VoxRef, bone: BoneName, recolor?: number): Promise<void> {
    const m = await loadVox(base + ref.vox);
    this.attach(bone, buildVoxMesh(m, ref.o, recolor));
  }

  /** Armor tint if the piece specifies one; skin for the bare skin-slot; else the vox palette. */
  private armorColor(ref: VoxRef, skin: number): number | undefined {
    if (ref.color) return rgb(ref.color);
    if (isSkinSlot(ref.vox)) return skin;
    return undefined;
  }

  /** Assemble this species + a seeded outfit (one piece per slot), then fit height. */
  private async loadParts(): Promise<void> {
    const base = new URL('models/veloren/', document.baseURI).href;
    try {
      const cat = await loadCatalog();
      const sp = cat.species.find((s) => s.id === this.speciesId) ?? cat.species[0];
      const rnd = mulberry32(this.seed + 1);
      const pick = <T>(arr: T[]): T | null => (arr && arr.length ? arr[Math.floor(rnd() * arr.length)] : null);

      // Head first → derive skin tone for the white skin-slot parts.
      const headVox = await loadVox(base + sp.head.vox);
      const skin = dominantColor(headVox);
      this.attach('head', buildVoxMesh(headVox, sp.head.o)); // baked colours

      // Hair (+ beard for males): grayscale hair-slot → species hair colour.
      const hcArr = cat.hairColors[sp.sp] ?? [[74, 53, 36]];
      const hairCol = rgb(hcArr[Math.floor(rnd() * hcArr.length)]);
      const hair = pick(sp.hairs);
      if (hair) await this.place(base, hair, 'head', hair.vox.includes('bald') ? skin : hairCol);
      const beard = sp.gender === 'male' ? pick(sp.beards) : null;
      if (beard) await this.place(base, beard, 'head', hairCol);
      const eyes = pick(sp.eyes);
      if (eyes) await this.place(base, eyes, 'head'); // baked

      // Outfit: one piece per slot (armor, or the bare skin-slot default).
      const a = cat.armor;
      const jobs: Promise<void>[] = [];
      const one = (ref: VoxRef | null, bone: BoneName): void => {
        if (ref) jobs.push(this.place(base, ref, bone, this.armorColor(ref, skin)));
      };
      one(pick(a.chest), 'chest');
      one(pick(a.pants), 'shorts');
      one(pick(a.belt), 'belt');
      one(pick(a.back), 'back');
      const foot = pick(a.foot);
      one(foot, 'foot_l');
      one(foot, 'foot_r');
      const hand = pick(a.hand);
      if (hand) {
        one(hand.left, 'hand_l');
        one(hand.right, 'hand_r');
      }
      const sh = pick(a.shoulder);
      if (sh) {
        one(sh.left, 'shoulder_l');
        one(sh.right, 'shoulder_r');
      }
      await Promise.all(jobs);
    } catch (e) {
      console.warn('[veloren] load failed:', this.speciesId, e);
    }
    this.normalise();
  }

  private normalise(): void {
    this.space.scale.setScalar(1);
    this.space.position.set(0, 0, 0);
    this.group.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(this.space);
    const h = box.max.y - box.min.y || 1;
    const s = TARGET_H / h;
    this.space.scale.setScalar(s);
    this.space.position.y = -box.min.y * s;
  }

  // ── Poses ───────────────────────────────────────────────────────────────────

  /** IdleAnimation, ported from Veloren idle.rs (breathing bob + idle head-look). */
  private computeIdle(): Record<BoneName, Pose> {
    const t = this.animTime;
    const slow = Math.sin(t);
    const lookX = Math.sin(Math.floor(t / 12) * 7331.0) * 0.1;
    const lookY = Math.sin(Math.floor(t / 12) * 1337.0) * 0.05;
    const P = this.idlePose;
    P.torso = pose(V(0, 0, 0), new THREE.Quaternion());
    P.chest = pose(V(0, S_A.chest[0], S_A.chest[1] + slow * 0.3), rotZ(lookX * 0.6), 1.01);
    P.head = pose(V(0, S_A.head[0], S_A.head[1] + slow * 0.3), rotZ(lookX).multiply(rotX(Math.abs(lookY))), S_A.headScale);
    P.belt = pose(V(0, S_A.belt[0], S_A.belt[1]), rotZ(lookX * -0.1));
    P.back = pose(V(0, S_A.back[0], S_A.back[1]), new THREE.Quaternion(), 1.02);
    P.shorts = pose(V(0, S_A.shorts[0], S_A.shorts[1]), rotZ(lookX * -0.2));
    P.shoulder_l = pose(V(-S_A.shoulder[0], S_A.shoulder[1], S_A.shoulder[2]), new THREE.Quaternion(), 1.1);
    P.shoulder_r = pose(V(S_A.shoulder[0], S_A.shoulder[1], S_A.shoulder[2]), new THREE.Quaternion(), 1.1);
    P.hand_l = pose(V(-S_A.hand[0], S_A.hand[1] + slow * 0.15, S_A.hand[2] + slow * 0.5), rotX(slow * -0.06), 1.04);
    P.hand_r = pose(V(S_A.hand[0], S_A.hand[1] + slow * 0.15, S_A.hand[2] + slow * 0.5), rotX(slow * -0.06), 1.04);
    P.foot_l = pose(V(-S_A.foot[0], S_A.foot[1], S_A.foot[2]), new THREE.Quaternion());
    P.foot_r = pose(V(S_A.foot[0], S_A.foot[1], S_A.foot[2]), new THREE.Quaternion());
    return P;
  }

  /** RunAnimation — reconstruction of Veloren's gait: legs swing in antiphase,
   *  arms counter the legs, torso bobs at 2× stride, slight forward lean. All
   *  amplitudes scale with `runAmt` so idle→run is a smooth blend. Driven by the
   *  accumulated `stride` (Veloren's acc_vel) so footfalls track real movement. */
  private computeRun(): Record<BoneName, Pose> {
    const ph = this.stride;
    const swingL = Math.sin(ph);
    const swingR = Math.sin(ph + Math.PI);
    // Lift during the SWING (return) half — foot off the ground while sweeping
    // back→front (cos>0). During stance (cos<0) it stays planted and sweeps
    // front→back, pushing the body forward. (Flipping this sign = moonwalk.)
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
    P.torso = pose(V(0, 0, bob * BOB * sn), new THREE.Quaternion());
    P.chest = pose(V(0, S_A.chest[0], S_A.chest[1]), rotX(0.12 * sn).multiply(rotZ(sway * 0.06 * sn)));
    P.head = pose(V(0, S_A.head[0], S_A.head[1] + bob * 0.1 * sn), rotX(0.1 * sn).multiply(rotZ(-sway * 0.05 * sn)));
    P.belt = pose(V(0, S_A.belt[0], S_A.belt[1]), rotZ(sway * -0.05 * sn));
    P.back = pose(V(0, S_A.back[0], S_A.back[1]), new THREE.Quaternion());
    P.shorts = pose(V(0, S_A.shorts[0], S_A.shorts[1]), rotZ(sway * -0.08 * sn));
    P.shoulder_l = pose(V(-S_A.shoulder[0], S_A.shoulder[1], S_A.shoulder[2]), rotX(-swingR * 0.2 * sn));
    P.shoulder_r = pose(V(S_A.shoulder[0], S_A.shoulder[1], S_A.shoulder[2]), rotX(-swingL * 0.2 * sn));
    P.hand_l = pose(V(-S_A.hand[0], S_A.hand[1] + swingR * ASTEP * sn, S_A.hand[2]), rotX(swingR * 0.6 * sn));
    P.hand_r = pose(V(S_A.hand[0], S_A.hand[1] + swingL * ASTEP * sn, S_A.hand[2]), rotX(swingL * 0.6 * sn));
    P.foot_l = pose(V(-S_A.foot[0], S_A.foot[1] + swingL * FSTEP * sn, S_A.foot[2] + liftL * FLIFT * sn), rotX(swingL * 0.5 * sn));
    P.foot_r = pose(V(S_A.foot[0], S_A.foot[1] + swingR * FSTEP * sn, S_A.foot[2] + liftR * FLIFT * sn), rotX(swingR * 0.5 * sn));
    return P;
  }

  private applyPose(p: Record<BoneName, Pose>): void {
    for (const name of Object.keys(this.bones) as BoneName[]) {
      const b = this.bones[name];
      const t = p[name];
      if (!t) continue;
      b.position.copy(t.p);
      b.quaternion.copy(t.q);
      b.scale.setScalar(t.s);
    }
  }

  // ── Public API (matches Avatar/NpcRender) ─────────────────────────────────────

  animate(dt: number, speed = 0): void {
    this.animTime += dt;
    this.stride += speed * dt * 1.4;
    const wantRun = speed > 0.4 ? 1 : 0;
    this.runAmt += (wantRun - this.runAmt) * Math.min(1, dt * 8);
    const idle = this.computeIdle();
    if (this.runAmt < 0.001) {
      this.applyPose(idle);
      return;
    }
    const run = this.computeRun();
    for (const name of Object.keys(this.bones) as BoneName[]) {
      const a = idle[name];
      const r = run[name];
      if (!a || !r) continue;
      const b = this.bones[name];
      b.position.copy(a.p).lerp(r.p, this.runAmt);
      b.quaternion.copy(a.q).slerp(r.q, this.runAmt);
      b.scale.setScalar(a.s + (r.s - a.s) * this.runAmt);
    }
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

function V(x: number, y: number, z: number): THREE.Vector3 {
  return new THREE.Vector3(x, y, z);
}
