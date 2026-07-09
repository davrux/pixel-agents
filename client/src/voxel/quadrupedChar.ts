/**
 * Veloren quadruped voxel character — a spike foundation for NPCs/monsters.
 *
 * Second skeleton family after the humanoid (velorenChar.ts). Bone hierarchy +
 * Wolf `SkeletonAttr` offsets are from Veloren (GPL-3.0):
 *   voxygen/anim/src/quadruped_medium/mod.rs (compute_matrices_inner + SkeletonAttr)
 *   + idle.rs for the s_a→axis mapping. Segments are the real Wolf .vox parts
 *   (CC-BY-SA) placed with quadruped_medium_{central,lateral}_manifest.ron offsets.
 * THIS FILE IS GPL-3.0 (derives from GPL-3.0 code + CC-BY-SA assets).
 *
 * Currently wired for the Wolf only; the config (S_A + PARTS) is the template for
 * adding other quadruped_medium species. IDLE is a subtle breather; RUN is a
 * reconstructed trot (diagonal leg pairs). Same coordinate handling + public API
 * as VelorenCharacter (group, animate(dt, speed), setTint, dispose).
 */
import * as THREE from 'three';
import { loadVox, buildVoxMesh } from './voxLoader.js';

const TARGET_H = 1.0; // wolf ~1 world-unit at the shoulder
const MODEL_UNITS = 26;

const XAXIS = new THREE.Vector3(1, 0, 0);
const ZAXIS = new THREE.Vector3(0, 0, 1);

// Wolf SkeletonAttr (voxygen/anim/src/quadruped_medium/mod.rs). 2-tuples are
// (y, z); leg/feet 3-tuples are (x, y, z). Left side uses -x, right side +x.
const S = {
  head: [1.5, 3.0],
  neck: [-4.5, 2.0],
  jaw: [5.0, -2.5],
  tail: [-11.0, 0.0],
  torso_back: [-12.5, 1.0],
  torso_front: [12.0, 13.0],
  ears: [3.0, 2.5],
  leg_f: [4.5, -6.5, -1.5],
  leg_b: [5.0, -6.5, -3.0],
  feet_f: [0.5, 0.0, -2.0],
  feet_b: [0.0, -1.0, -1.5],
};

type BoneName =
  | 'torso_front'
  | 'torso_back'
  | 'neck'
  | 'head'
  | 'jaw'
  | 'ears'
  | 'tail'
  | 'leg_fl'
  | 'leg_fr'
  | 'leg_bl'
  | 'leg_br'
  | 'foot_fl'
  | 'foot_fr'
  | 'foot_bl'
  | 'foot_br';

type Vec3 = [number, number, number];
// Wolf .vox parts + their manifest placement offsets (bone-local). Left legs reuse
// the "_fr"/"_br" model (Veloren mirrors the lateral parts).
const PARTS: { bone: BoneName; f: string; o: Vec3 }[] = [
  { bone: 'torso_front', f: 'torso_front', o: [-5, -13, -5] },
  { bone: 'torso_back', f: 'torso_back', o: [-4, -11, -5] },
  { bone: 'neck', f: 'neck', o: [-5, -2, -5] },
  { bone: 'head', f: 'head', o: [-5, 0, -3.5] },
  { bone: 'jaw', f: 'jaw', o: [-2, 0, -1] },
  { bone: 'ears', f: 'ears', o: [-5, -1, 0] },
  { bone: 'tail', f: 'tail', o: [-2, -13, -3.5] },
  { bone: 'leg_fl', f: 'leg_fr', o: [-2, -3.5, -4] },
  { bone: 'leg_fr', f: 'leg_fr', o: [-2, -3.5, -4] },
  { bone: 'leg_bl', f: 'leg_br', o: [-1.5, -3.5, -3.5] },
  { bone: 'leg_br', f: 'leg_br', o: [-1.5, -3.5, -3.5] },
  { bone: 'foot_fl', f: 'foot_fr', o: [-1.5, -2.5, -10] },
  { bone: 'foot_fr', f: 'foot_fr', o: [-1.5, -2.5, -10] },
  { bone: 'foot_bl', f: 'foot_br', o: [-1.5, -2.5, -10] },
  { bone: 'foot_br', f: 'foot_br', o: [-1.5, -2.5, -10] },
];

export class QuadrupedCharacter {
  readonly group = new THREE.Group();
  private readonly space = new THREE.Group();
  private readonly bones = {} as Record<BoneName, THREE.Group>;
  private readonly tinted: THREE.MeshBasicMaterial[] = [];
  private readonly q = new THREE.Quaternion(); // scratch

  private animTime = 0;
  private stride = 0;
  private runAmt = 0;

  constructor(private readonly kind = 'wolf') {
    this.space.rotation.x = -Math.PI / 2; // Veloren Z-up → Three Y-up
    this.space.scale.setScalar(TARGET_H / MODEL_UNITS);
    this.group.add(this.space);
    this.buildSkeleton();
    void this.loadParts();
  }

  /** Bone hierarchy per Veloren compute_matrices_inner (quadruped_medium). */
  private buildSkeleton(): void {
    const mk = (name: BoneName, parent: THREE.Object3D): THREE.Group => {
      const g = new THREE.Group();
      parent.add(g);
      this.bones[name] = g;
      return g;
    };
    const tf = mk('torso_front', this.space);
    const tb = mk('torso_back', tf);
    const neck = mk('neck', tf);
    const head = mk('head', neck);
    mk('jaw', head);
    mk('ears', head);
    mk('tail', tb);
    const fl = mk('leg_fl', tf);
    const fr = mk('leg_fr', tf);
    const bl = mk('leg_bl', tb);
    const br = mk('leg_br', tb);
    mk('foot_fl', fl);
    mk('foot_fr', fr);
    mk('foot_bl', bl);
    mk('foot_br', br);
    this.setRest();
  }

  private async loadParts(): Promise<void> {
    const base = new URL(`models/veloren/npc/${this.kind}/male/`, document.baseURI).href;
    await Promise.all(
      PARTS.map(async (p) => {
        try {
          const m = await loadVox(base + p.f + '.vox');
          const mesh = buildVoxMesh(m, p.o); // npc parts are baked-colour → no recolor
          this.bones[p.bone].add(mesh);
          this.tinted.push(mesh.material as THREE.MeshBasicMaterial);
        } catch (e) {
          console.warn('[quadruped] part load failed:', this.kind, p.f, e);
        }
      }),
    );
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

  private setBone(name: BoneName, x: number, y: number, z: number, rotXa = 0): void {
    const b = this.bones[name];
    b.position.set(x, y, z);
    b.quaternion.copy(this.q.setFromAxisAngle(XAXIS, rotXa));
  }

  /** Neutral stance (used before parts load + as the idle base). */
  private setRest(): void {
    this.setBone('torso_front', 0, S.torso_front[0], S.torso_front[1]);
    this.setBone('torso_back', 0, S.torso_back[0], S.torso_back[1]);
    this.setBone('neck', 0, S.neck[0], S.neck[1]);
    this.setBone('head', 0, S.head[0], S.head[1]);
    this.setBone('jaw', 0, S.jaw[0], S.jaw[1]);
    this.setBone('ears', 0, S.ears[0], S.ears[1]);
    this.setBone('tail', 0, S.tail[0], S.tail[1]);
    this.setBone('leg_fl', -S.leg_f[0], S.leg_f[1], S.leg_f[2]);
    this.setBone('leg_fr', S.leg_f[0], S.leg_f[1], S.leg_f[2]);
    this.setBone('leg_bl', -S.leg_b[0], S.leg_b[1], S.leg_b[2]);
    this.setBone('leg_br', S.leg_b[0], S.leg_b[1], S.leg_b[2]);
    this.setBone('foot_fl', -S.feet_f[0], S.feet_f[1], S.feet_f[2]);
    this.setBone('foot_fr', S.feet_f[0], S.feet_f[1], S.feet_f[2]);
    this.setBone('foot_bl', -S.feet_b[0], S.feet_b[1], S.feet_b[2]);
    this.setBone('foot_br', S.feet_b[0], S.feet_b[1], S.feet_b[2]);
  }

  /** One leg of the trot: swing fore/aft + lift on the swing half + toe rotation. */
  private legTrot(name: BoneName, xSign: number, base: number[], phase: number, sn: number): void {
    const sw = Math.sin(phase);
    const lift = Math.max(0, Math.cos(phase));
    const STEP = 4.0,
      LIFT = 3.0;
    this.setBone(name, xSign * base[0], base[1] + sw * STEP * sn, base[2] + lift * LIFT * sn, sw * 0.5 * sn);
  }

  animate(dt: number, speed = 0): void {
    this.animTime += dt;
    this.stride += speed * dt * 1.2;
    const wantRun = speed > 0.4 ? 1 : 0;
    this.runAmt += (wantRun - this.runAmt) * Math.min(1, dt * 8);
    const sn = this.runAmt;
    const t = this.animTime;

    // Idle breather + gentle tail sway (always on, subtle).
    const breathe = Math.sin(t * 2) * 0.3 * (1 - sn);
    this.setBone('torso_front', 0, S.torso_front[0], S.torso_front[1] + breathe + Math.abs(Math.sin(this.stride)) * 1.2 * sn);
    this.setBone('torso_back', 0, S.torso_back[0], S.torso_back[1] + breathe * 0.5);
    this.setBone('neck', 0, S.neck[0], S.neck[1] + breathe * 0.4);
    this.setBone('head', 0, S.head[0], S.head[1] + Math.sin(t * 2 + 1) * 0.2 * (1 - sn));
    this.setBone('jaw', 0, S.jaw[0], S.jaw[1]);
    this.setBone('ears', 0, S.ears[0], S.ears[1]);
    this.setBone('tail', 0, S.tail[0] + Math.sin(t * 3) * 1.2, S.tail[1]);

    // Trot: diagonal pairs (front-left + back-right, then the other diagonal).
    const p = this.stride;
    this.legTrot('leg_fl', -1, S.leg_f, p, sn);
    this.legTrot('leg_br', 1, S.leg_b, p, sn);
    this.legTrot('leg_fr', 1, S.leg_f, p + Math.PI, sn);
    this.legTrot('leg_bl', -1, S.leg_b, p + Math.PI, sn);
  }

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
