/**
 * Simple blocky animal models (sheep / cow / chicken) — Minecraft-style boxes, so
 * animals actually look like animals instead of the humanoid player placeholder.
 * Unlit MeshBasicMaterial (matches the voxel world's lighting) with a day-tint hook,
 * and legs that swing while walking. Exposes the same surface the renderer uses for
 * avatars: `group`, `setTint(color)`, `animate(dt, speed)`.
 */
import * as THREE from 'three';

interface Part {
  mesh: THREE.Mesh;
  base: THREE.Color; // untinted colour (day tint multiplies this)
}

export type AnimalKind = 'sheep' | 'cow' | 'chicken';
export const ANIMAL_KINDS = new Set<string>(['sheep', 'cow', 'chicken']);

export class MobModel {
  readonly group = new THREE.Group();
  private readonly parts: Part[] = [];
  private readonly legs: THREE.Group[] = []; // hip-pivoted leg groups that swing
  private phase = 0;

  constructor(kind: string) {
    if (kind === 'chicken') this.buildChicken();
    else if (kind === 'cow') this.buildCow();
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
