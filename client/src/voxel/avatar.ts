/**
 * Skinned blocky avatar using the classic 64×32 humanoid layout (what Luanti /
 * the CC0 "Simple Skins" use). Head/torso/arms/legs are boxes with per-face UVs
 * into the skin texture; limbs hang from pivot groups so they swing while
 * walking. `setSkin(name)` swaps the texture (skins in textures/player/skins/).
 * The model faces its local -Z, which is the player's forward at yaw 0.
 */
import * as THREE from 'three';

const SW = 64;
const SH = 32;
const U = 1.8 / 32; // world units per skin pixel (avatar ≈ 1.8 tall)

type Rects = { front: number[]; back: number[]; right: number[]; left: number[]; top: number[]; bottom: number[] };
const R = (x0: number, y0: number, x1: number, y1: number): number[] => [x0, y0, x1, y1];
// classic single-layer skin regions (px, top-left origin)
const HEAD: Rects = { front: R(8, 8, 16, 16), back: R(24, 8, 32, 16), right: R(0, 8, 8, 16), left: R(16, 8, 24, 16), top: R(8, 0, 16, 8), bottom: R(16, 0, 24, 8) };
const TORSO: Rects = { front: R(20, 20, 28, 32), back: R(32, 20, 40, 32), right: R(16, 20, 20, 32), left: R(28, 20, 32, 32), top: R(20, 16, 28, 20), bottom: R(28, 16, 36, 20) };
const ARM: Rects = { front: R(44, 20, 48, 32), back: R(52, 20, 56, 32), right: R(48, 20, 52, 32), left: R(40, 20, 44, 32), top: R(44, 16, 48, 20), bottom: R(48, 16, 52, 20) };
const LEG: Rects = { front: R(4, 20, 8, 32), back: R(12, 20, 16, 32), right: R(8, 20, 12, 32), left: R(0, 20, 4, 32), top: R(4, 16, 8, 20), bottom: R(8, 16, 12, 20) };

/** BoxGeometry with per-face UVs from a skin layout. Three's face order is
 *  +X,-X,+Y,-Y,+Z,-Z; we route front→-Z, back→+Z so the face points forward. */
function skinnedBox(w: number, h: number, d: number, r: Rects): THREE.BoxGeometry {
  const g = new THREE.BoxGeometry(w, h, d);
  const uv = g.attributes.uv;
  const order = [r.right, r.left, r.top, r.bottom, r.back, r.front];
  for (let f = 0; f < 6; f++) {
    const [x0, y0, x1, y1] = order[f];
    const u0 = x0 / SW,
      u1 = x1 / SW,
      vTop = 1 - y0 / SH,
      vBot = 1 - y1 / SH;
    const b = f * 4;
    uv.setXY(b + 0, u0, vTop);
    uv.setXY(b + 1, u1, vTop);
    uv.setXY(b + 2, u0, vBot);
    uv.setXY(b + 3, u1, vBot);
  }
  uv.needsUpdate = true;
  return g;
}

export class Avatar {
  readonly group = new THREE.Group();
  private readonly mat: THREE.MeshBasicMaterial;
  private readonly loader = new THREE.TextureLoader();
  private readonly legL: THREE.Group;
  private readonly legR: THREE.Group;
  private readonly armL: THREE.Group;
  private readonly armR: THREE.Group;
  private readonly head: THREE.Object3D;
  private phase = 0;
  private amp = 0;
  private digT = 0; // remaining time of a mine/place arm swing

  constructor(skin = 'character_1') {
    this.mat = new THREE.MeshBasicMaterial();
    const mk = (w: number, h: number, d: number, r: Rects): THREE.Mesh => new THREE.Mesh(skinnedBox(w, h, d, r), this.mat);
    const legH = 12 * U,
      torsoH = 12 * U,
      shoulderY = legH + torsoH; // 1.35
    // limbs hang below a pivot group so rotation swings from the top
    const limb = (w: number, h: number, d: number, r: Rects, x: number, py: number): THREE.Group => {
      const g = new THREE.Group();
      g.position.set(x, py, 0);
      const m = mk(w, h, d, r);
      m.position.y = -h / 2;
      g.add(m);
      return g;
    };
    this.legL = limb(4 * U, legH, 4 * U, LEG, -2 * U, legH);
    this.legR = limb(4 * U, legH, 4 * U, LEG, 2 * U, legH);
    this.armL = limb(4 * U, 12 * U, 4 * U, ARM, -6 * U, shoulderY);
    this.armR = limb(4 * U, 12 * U, 4 * U, ARM, 6 * U, shoulderY);
    const torso = mk(8 * U, torsoH, 4 * U, TORSO);
    torso.position.y = legH + torsoH / 2;
    this.head = mk(8 * U, 8 * U, 8 * U, HEAD);
    this.head.position.y = shoulderY + 4 * U;
    this.group.add(this.legL, this.legR, this.armL, this.armR, torso, this.head);
    this.setSkin(skin);
  }

  setSkin(name: string): void {
    const url = new URL(`textures/player/skins/${name}.png`, document.baseURI).href;
    this.loader.load(url, (tex) => {
      tex.magFilter = THREE.NearestFilter;
      tex.minFilter = THREE.NearestFilter;
      tex.generateMipmaps = false;
      tex.colorSpace = THREE.SRGBColorSpace;
      this.mat.map = tex;
      this.mat.needsUpdate = true;
    });
  }

  /** Trigger a short right-arm chop (block break/place). */
  playDig(): void {
    this.digT = 0.32;
  }

  animate(dt: number, speed: number, pitch = 0): void {
    const moving = speed > 0.4;
    this.phase += dt * (moving ? 9 : 0);
    this.amp += ((moving ? 0.9 : 0) - this.amp) * Math.min(1, dt * 10);
    const s = Math.sin(this.phase) * this.amp;
    this.legL.rotation.x = s;
    this.legR.rotation.x = -s;
    this.armL.rotation.x = -s;
    let armR = s;
    if (this.digT > 0) {
      this.digT = Math.max(0, this.digT - dt);
      armR = -1.5 * Math.sin((1 - this.digT / 0.32) * Math.PI); // overlay a downward chop
    }
    this.armR.rotation.x = armR;
    this.head.rotation.x = Math.max(-0.5, Math.min(0.5, -pitch * 0.4));
  }
}
