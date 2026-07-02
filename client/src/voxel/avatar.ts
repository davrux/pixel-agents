/**
 * A blocky Minecraft-ish avatar: head, body, two arms, two legs. Limbs hang from
 * pivot groups (shoulder/hip) so they swing on the X axis; `animate()` advances a
 * walk phase from the horizontal speed and eases the swing back to rest when idle.
 * Root origin is at the feet; the caller sets group.position (feet) + rotation.y.
 */
import * as THREE from 'three';

const SKIN = 0xe0ac7a;
const HAIR = 0x5a4030;
const SHIRT = 0x2f8f8f;
const PANTS = 0x34407a;

function box(w: number, h: number, d: number, color: number, y: number): THREE.Mesh {
  const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), new THREE.MeshBasicMaterial({ color }));
  m.position.y = y;
  return m;
}
/** A limb that hangs below a pivot group (so rotation swings from the top). */
function limb(w: number, h: number, d: number, color: number, x: number, pivotY: number): THREE.Group {
  const g = new THREE.Group();
  g.position.set(x, pivotY, 0);
  g.add(box(w, h, d, color, -h / 2));
  return g;
}

export class Avatar {
  readonly group = new THREE.Group();
  private readonly legL: THREE.Group;
  private readonly legR: THREE.Group;
  private readonly armL: THREE.Group;
  private readonly armR: THREE.Group;
  private readonly head: THREE.Group;
  private phase = 0;
  private amp = 0;

  constructor() {
    const legH = 0.75;
    const bodyH = 0.7;
    const shoulderY = legH + bodyH; // 1.45
    // legs (pivot at hip)
    this.legL = limb(0.22, legH, 0.24, PANTS, -0.13, legH);
    this.legR = limb(0.22, legH, 0.24, PANTS, 0.13, legH);
    // body
    const body = box(0.5, bodyH, 0.28, SHIRT, legH + bodyH / 2);
    // arms (pivot at shoulder)
    this.armL = limb(0.18, 0.7, 0.2, SHIRT, -0.34, shoulderY);
    this.armR = limb(0.18, 0.7, 0.2, SHIRT, 0.34, shoulderY);
    this.armL.add(box(0.18, 0.18, 0.2, SKIN, -0.7)); // hand
    this.armR.add(box(0.18, 0.18, 0.2, SKIN, -0.7));
    // head (+ a thin hair cap)
    this.head = new THREE.Group();
    this.head.position.y = shoulderY + 0.05;
    this.head.add(box(0.5, 0.5, 0.5, SKIN, 0.25));
    this.head.add(box(0.52, 0.14, 0.52, HAIR, 0.47));
    this.group.add(this.legL, this.legR, body, this.armL, this.armR, this.head);
  }

  /** speed = horizontal blocks/s; pitch tilts the head a little in 3rd person. */
  animate(dt: number, speed: number, pitch = 0): void {
    const moving = speed > 0.4;
    this.phase += dt * (moving ? 9 : 0);
    // ease the swing amplitude toward walking (0.9 rad) or rest (0)
    const target = moving ? 0.9 : 0;
    this.amp += (target - this.amp) * Math.min(1, dt * 10);
    const s = Math.sin(this.phase) * this.amp;
    this.legL.rotation.x = s;
    this.legR.rotation.x = -s;
    this.armL.rotation.x = -s;
    this.armR.rotation.x = s;
    this.head.rotation.x = Math.max(-0.5, Math.min(0.5, -pitch * 0.4));
  }
}
