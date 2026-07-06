/**
 * Simple blocky animal models (sheep / cow / chicken) — Minecraft-style boxes, so
 * animals actually look like animals instead of the humanoid player placeholder.
 * Unlit MeshBasicMaterial (matches the voxel world's lighting) with a day-tint hook,
 * and legs that swing while walking. Exposes the same surface the renderer uses for
 * avatars: `group`, `setTint(color)`, `animate(dt, speed)`.
 */
import * as THREE from 'three';
import { GltfMob, LUANTI_MOBS } from './mobGltf.js';

/** Same surface main.ts needs from any NPC render (real avatars, glTF mobs, boxes). */
export interface NpcRender {
  group: THREE.Object3D;
  setTint(c: THREE.Color): void;
  animate(dt: number, speed: number): void;
}

/** Pick the best model for a mob kind: the real converted Luanti animal model when
 *  we have one, else the blocky box fallback (monsters, unmapped kinds). */
export function makeMob(kind: string): NpcRender {
  const lm = LUANTI_MOBS[kind];
  return lm ? new GltfMob(lm) : new MobModel(kind);
}

interface Part {
  mesh: THREE.Mesh;
  base: THREE.Color; // untinted colour (day tint multiplies this)
}

export const ANIMAL_KINDS = new Set<string>(['sheep', 'cow', 'chicken', 'pig']);
/** All mob kinds that have a blocky model here (animals + monsters). Others fall back
 *  to a generic humanoid. */
export const MOB_KINDS = new Set<string>(['sheep', 'cow', 'chicken', 'pig', 'zombie', 'skeleton', 'spider']);

export class MobModel {
  readonly group = new THREE.Group();
  private readonly parts: Part[] = [];
  private readonly legs: THREE.Group[] = []; // hip-pivoted leg groups that swing
  private phase = 0;

  constructor(kind: string) {
    if (kind === 'chicken') this.buildChicken();
    else if (kind === 'cow') this.buildCow();
    else if (kind === 'pig') this.buildPig();
    else if (kind === 'zombie') this.buildZombie();
    else if (kind === 'skeleton') this.buildSkeleton();
    else if (kind === 'spider') this.buildSpider();
    else this.buildSheep();
  }

  /** Add a coloured box centred at (x,y,z) with size (w,h,d). */
  private box(w: number, h: number, d: number, x: number, y: number, z: number, color: number, parent: THREE.Object3D = this.group): THREE.Mesh {
    const base = new THREE.Color(color);
    const mat = new THREE.MeshBasicMaterial({ color: base.clone() });
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
    mesh.position.set(x, y, z);
    parent.add(mesh);
    this.parts.push({ mesh, base });
    return mesh;
  }

  /** A hip-pivoted leg (rotates about its top) at (x, hipY, z), length `len`. */
  private leg(x: number, hipY: number, z: number, w: number, len: number, color: number): void {
    const hip = new THREE.Group();
    hip.position.set(x, hipY, z);
    this.group.add(hip);
    this.box(w, len, w, 0, -len / 2, 0, color, hip); // box hangs below the pivot
    this.legs.push(hip);
  }

  private buildSheep(): void {
    const wool = 0xe9e6dc,
      face = 0xd8cfbe,
      leg = 0x574f45;
    this.box(0.72, 0.66, 1.02, 0, 0.78, 0, wool); // fluffy body
    this.box(0.46, 0.46, 0.42, 0, 0.9, -0.66, face); // head at -Z (forward)
    const hy = 0.45;
    this.leg(-0.24, hy, -0.34, 0.18, 0.45, leg);
    this.leg(0.24, hy, -0.34, 0.18, 0.45, leg);
    this.leg(-0.24, hy, 0.34, 0.18, 0.45, leg);
    this.leg(0.24, hy, 0.34, 0.18, 0.45, leg);
  }

  private buildCow(): void {
    const body = 0x4a3527,
      patch = 0xe7e2d6,
      leg = 0x2f2118,
      horn = 0xe7e2d6;
    this.box(0.8, 0.8, 1.24, 0, 0.86, 0, body);
    this.box(0.5, 0.35, 0.5, 0, 0.62, 0.5, patch); // white rump patch
    this.box(0.52, 0.5, 0.46, 0, 1.0, -0.82, body); // head
    this.box(0.1, 0.14, 0.1, -0.16, 1.28, -0.82, horn);
    this.box(0.1, 0.14, 0.1, 0.16, 1.28, -0.82, horn);
    const hy = 0.5;
    this.leg(-0.28, hy, -0.42, 0.22, 0.5, leg);
    this.leg(0.28, hy, -0.42, 0.22, 0.5, leg);
    this.leg(-0.28, hy, 0.42, 0.22, 0.5, leg);
    this.leg(0.28, hy, 0.42, 0.22, 0.5, leg);
  }

  private buildPig(): void {
    const body = 0xe89a9a,
      snout = 0xd98080,
      leg = 0xc06868;
    this.box(0.7, 0.6, 1.0, 0, 0.62, 0, body); // body
    this.box(0.5, 0.46, 0.42, 0, 0.66, -0.62, body); // head at -Z
    this.box(0.24, 0.18, 0.1, 0, 0.62, -0.86, snout); // snout
    const hy = 0.34;
    this.leg(-0.22, hy, -0.3, 0.18, 0.34, leg);
    this.leg(0.22, hy, -0.3, 0.18, 0.34, leg);
    this.leg(-0.22, hy, 0.3, 0.18, 0.34, leg);
    this.leg(0.22, hy, 0.3, 0.18, 0.34, leg);
  }

  private buildChicken(): void {
    const body = 0xf2f2ee,
      beak = 0xe8a13a,
      comb = 0xc0392b,
      leg = 0xe8a13a;
    this.box(0.34, 0.4, 0.5, 0, 0.5, 0, body);
    this.box(0.06, 0.34, 0.34, -0.2, 0.5, 0.02, body); // wings
    this.box(0.06, 0.34, 0.34, 0.2, 0.5, 0.02, body);
    this.box(0.26, 0.3, 0.26, 0, 0.78, -0.28, body); // head
    this.box(0.12, 0.1, 0.14, 0, 0.78, -0.46, beak); // beak
    this.box(0.16, 0.12, 0.06, 0, 0.95, -0.24, comb); // comb
    const hy = 0.3;
    this.leg(-0.1, hy, 0, 0.07, 0.3, leg);
    this.leg(0.1, hy, 0, 0.07, 0.3, leg);
  }

  /** A shoulder-pivoted arm at a FIXED rotation (doesn't swing — for a pose). */
  private armFixed(x: number, shoulderY: number, w: number, len: number, color: number, rotX: number): void {
    const sh = new THREE.Group();
    sh.position.set(x, shoulderY, 0);
    sh.rotation.x = rotX;
    this.group.add(sh);
    this.box(w, len, w, 0, -len / 2, 0, color, sh);
  }

  /** Zombie: green skin, tattered shirt, dark sunken eyes, arms outstretched forward. */
  private buildZombie(): void {
    const skin = 0x5aa84b,
      shirt = 0x35506b,
      pants = 0x2f333d,
      eye = 0x11220d;
    const hipY = 0.9,
      legLen = 0.9;
    this.leg(-0.15, hipY, 0, 0.24, legLen, pants);
    this.leg(0.15, hipY, 0, 0.24, legLen, pants);
    this.box(0.56, 0.78, 0.32, 0, 1.28, 0, shirt); // torso
    this.box(0.46, 0.46, 0.46, 0, 1.9, 0, skin); // head
    this.box(0.1, 0.08, 0.04, -0.11, 1.93, -0.235, eye); // sunken eyes (front = -Z)
    this.box(0.1, 0.08, 0.04, 0.11, 1.93, -0.235, eye);
    this.armFixed(-0.4, 1.62, 0.2, 0.72, skin, -1.45); // both arms reach forward
    this.armFixed(0.4, 1.62, 0.2, 0.72, skin, -1.45);
  }

  /** Skeleton: thin bone-white limbs, a skull with eye sockets, holding a wooden bow. */
  private buildSkeleton(): void {
    const bone = 0xe8e6dd,
      dark = 0x1e1e1a,
      bow = 0x6b4a2b;
    const hipY = 0.88,
      legLen = 0.88;
    this.leg(-0.12, hipY, 0, 0.14, legLen, bone); // thin legs
    this.leg(0.12, hipY, 0, 0.14, legLen, bone);
    this.box(0.32, 0.72, 0.2, 0, 1.24, 0, bone); // narrow ribcage
    this.box(0.4, 0.42, 0.4, 0, 1.82, 0, bone); // skull
    this.box(0.09, 0.09, 0.04, -0.1, 1.84, -0.205, dark); // eye sockets
    this.box(0.09, 0.09, 0.04, 0.1, 1.84, -0.205, dark);
    this.armFixed(-0.26, 1.56, 0.12, 0.66, bone, -0.4); // thin arms; right raised to hold the bow
    this.armFixed(0.26, 1.56, 0.12, 0.66, bone, -1.25);
    this.box(0.05, 0.6, 0.05, 0.36, 1.16, -0.34, bow); // bow stave
    this.box(0.05, 0.14, 0.14, 0.36, 1.44, -0.3, bow); // upper tip
    this.box(0.05, 0.14, 0.14, 0.36, 0.9, -0.3, bow); // lower tip
  }

  /** Blocky spider: wide abdomen, cephalothorax with a 4-eye cluster + fangs, 8 legs. */
  private buildSpider(): void {
    const dark = 0x2a2730,
      hair = 0x1b1922,
      eye = 0xc0392b,
      fang = 0xdedede;
    this.box(1.0, 0.5, 0.82, 0, 0.5, 0.16, dark); // abdomen
    this.box(0.56, 0.44, 0.5, 0, 0.5, -0.5, hair); // cephalothorax (front, -Z)
    this.box(0.08, 0.08, 0.05, -0.14, 0.6, -0.74, eye); // main eyes
    this.box(0.08, 0.08, 0.05, 0.14, 0.6, -0.74, eye);
    this.box(0.06, 0.06, 0.05, -0.08, 0.5, -0.74, eye); // secondary eyes
    this.box(0.06, 0.06, 0.05, 0.08, 0.5, -0.74, eye);
    this.box(0.06, 0.12, 0.06, -0.1, 0.35, -0.72, fang); // fangs
    this.box(0.06, 0.12, 0.06, 0.1, 0.35, -0.72, fang);
    const hy = 0.46,
      ll = 0.5;
    for (const z of [-0.2, 0.0, 0.2, 0.4]) {
      this.leg(-0.5, hy, z, 0.07, ll, dark);
      this.leg(0.5, hy, z, 0.07, ll, dark);
    }
  }

  /** Multiply every part by the current day-light colour (matches world shading). */
  setTint(c: THREE.Color): void {
    for (const p of this.parts) (p.mesh.material as THREE.MeshBasicMaterial).color.copy(p.base).multiply(c);
  }

  /** Swing the legs while walking (speed>0); still otherwise. */
  animate(dt: number, speed: number): void {
    if (speed > 0.01) {
      this.phase += dt * 8;
      const s = Math.sin(this.phase) * 0.5;
      this.legs.forEach((l, i) => (l.rotation.x = i % 2 === 0 ? s : -s));
    } else {
      for (const l of this.legs) l.rotation.x *= Math.max(0, 1 - dt * 10); // ease to rest
    }
  }
}
