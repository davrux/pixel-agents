/**
 * First-person view model: the arm + wielded tool that hangs in the lower-right
 * of the screen (the avatar body is hidden in first person, so we need this).
 * The group is parented to the camera (main adds the camera to the scene) so it
 * rides with the view; it swings while mining and does a one-shot chop on place —
 * mirroring the avatar's playDig()/setMining() so both views stay in sync.
 */
import * as THREE from 'three';
import { buildItemMesh } from './tool.js';

const SKIN = 0xc79c72; // hand
const SLEEVE = 0x3f8a4d; // shirt cuff (matches the default green skin roughly)

export class ViewModel {
  readonly group = new THREE.Group();
  private readonly arm = new THREE.Group();
  private mining = false;
  private digT = 0;
  private t = 0;

  constructor(toolUrl: string) {
    const cuff = new THREE.Mesh(new THREE.BoxGeometry(0.13, 0.13, 0.34), new THREE.MeshBasicMaterial({ color: SLEEVE }));
    cuff.position.z = 0.18;
    const hand = new THREE.Mesh(new THREE.BoxGeometry(0.13, 0.13, 0.12), new THREE.MeshBasicMaterial({ color: SKIN }));
    hand.position.z = 0.0;
    this.arm.add(cuff, hand);
    this.group.add(this.arm);

    void buildItemMesh(toolUrl, [0.1, 0.85]).then((tool) => {
      tool.scale.setScalar(0.42);
      tool.position.set(0.02, 0.05, -0.12);
      tool.rotation.set(-0.5, -0.4, 0.5);
      this.arm.add(tool);
      this.group.traverse((o) => (o.frustumCulled = false));
    });

    // rest transform: rig sits lower-right, angled up-left into the view
    this.group.position.set(0.32, -0.3, -0.55);
    this.group.rotation.set(0.2, 0.5, 0.1);
    this.group.traverse((o) => (o.frustumCulled = false));
  }

  playDig(): void {
    this.digT = 0.35;
  }
  setMining(on: boolean): void {
    this.mining = on;
  }

  animate(dt: number): void {
    this.t += dt;
    if (this.digT > 0) this.digT -= dt;
    // gentle idle bob
    this.arm.position.y = Math.sin(this.t * 1.6) * 0.006;
    // chop: continuous while mining, one-shot decay after a place
    const chopping = this.mining || this.digT > 0;
    const phase = this.mining ? (this.t * 9) % (Math.PI * 2) : (1 - Math.max(0, this.digT) / 0.35) * Math.PI;
    this.arm.rotation.x = chopping ? -Math.abs(Math.sin(phase)) * 0.9 : 0;
  }
}
