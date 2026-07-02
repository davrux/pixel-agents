/**
 * Player avatar — the real Luanti character model (converted b3d → glTF in
 * Blender: models/character/character.gltf, mesh + 6-bone skeleton + one baked
 * animation timeline at 60 fps). The single "anim" clip is sliced into the
 * classic player_api sub-clips (stand/walk/mine/…) by frame range. The model is
 * unlit (MeshBasicMaterial, no lights in the scene) and wears a 64×32 skin from
 * textures/player/skins/ mapped onto material.map — same skins the box model used.
 *
 * `group` exists immediately (empty) so main.ts can add + position it while the
 * glTF streams in; the model is parented once loaded. Public API is unchanged:
 * setSkin(name), playDig(), animate(dt, speed, pitch).
 */
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';

const TARGET_H = 1.8; // world-units tall (matches the player AABB height)
const FACING = 0; // model already faces its local -Z, which is the player's forward at yaw 0

// Luanti player_api frame ranges within the single baked timeline (fps = 60).
const FPS = 60;
const RANGES: Record<string, [number, number]> = {
  stand: [0, 79],
  sit: [81, 160],
  lay: [162, 166],
  walk: [168, 187],
  mine: [189, 198],
  walk_mine: [200, 219],
};

export class Avatar {
  readonly group = new THREE.Group();
  private readonly mat = new THREE.MeshBasicMaterial({ alphaTest: 0.5 });
  private readonly loader = new THREE.TextureLoader();
  private mixer: THREE.AnimationMixer | null = null;
  private actions: Record<string, THREE.AnimationAction> = {};
  private head: THREE.Object3D | null = null;
  private current = 'stand';
  private digging = false;
  private pendingSkin = 'character_1';

  constructor(skin = 'character_1') {
    this.pendingSkin = skin;
    const url = new URL('models/character/character.gltf', document.baseURI).href;
    new GLTFLoader().load(url, (gltf) => this.onLoad(gltf));
    this.setSkin(skin);
  }

  private onLoad(gltf: { scene: THREE.Group; animations: THREE.AnimationClip[] }): void {
    const model = gltf.scene;
    model.traverse((o) => {
      if ((o as THREE.Mesh).isMesh) {
        const m = o as THREE.Mesh;
        m.material = this.mat; // swap PBR → our unlit skinned material
        m.frustumCulled = false; // small model, avoid pop-out on the box bounds
      }
      if (o.name === 'Head') this.head = o;
    });

    // Scale so the model is TARGET_H tall and its feet sit at group origin y=0.
    const box = new THREE.Box3().setFromObject(model);
    const s = TARGET_H / (box.max.y - box.min.y);
    model.scale.setScalar(s);
    model.position.y = -box.min.y * s;
    model.rotation.y = FACING;
    this.group.add(model);

    // Slice the one baked timeline into named clips and build looping actions.
    this.mixer = new THREE.AnimationMixer(model);
    const source = gltf.animations[0];
    for (const [name, [a, b]] of Object.entries(RANGES)) {
      const clip = THREE.AnimationUtils.subclip(source, name, a, b, FPS);
      this.actions[name] = this.mixer.clipAction(clip);
    }
    this.actions.mine.setLoop(THREE.LoopOnce, 1);
    this.actions.mine.clampWhenFinished = false;
    this.mixer.addEventListener('finished', () => {
      this.digging = false;
    });
    this.actions[this.current].play();
  }

  setSkin(name: string): void {
    this.pendingSkin = name;
    const url = new URL(`textures/player/skins/${name}.png`, document.baseURI).href;
    this.loader.load(url, (tex) => {
      tex.magFilter = THREE.NearestFilter;
      tex.minFilter = THREE.NearestFilter;
      tex.generateMipmaps = false;
      tex.flipY = false; // glTF UVs assume no flip
      tex.colorSpace = THREE.SRGBColorSpace;
      this.mat.map = tex;
      this.mat.needsUpdate = true;
    });
  }

  /** Trigger a one-shot mine/place arm swing. */
  playDig(): void {
    const mine = this.actions.mine;
    if (!mine) return;
    this.digging = true;
    mine.reset();
    mine.play();
  }

  /** Crossfade to a looping locomotion clip (stand ↔ walk). */
  private setBase(name: 'stand' | 'walk'): void {
    if (this.current === name || !this.actions[name]) return;
    const from = this.actions[this.current];
    const to = this.actions[name].reset();
    to.play();
    if (from) from.crossFadeTo(to, 0.2, false);
    else to.fadeIn(0.2);
    this.current = name;
  }

  animate(dt: number, speed: number, pitch = 0): void {
    if (!this.mixer) return;
    if (!this.digging) this.setBase(speed > 0.4 ? 'walk' : 'stand');
    this.mixer.update(dt);
    // Head look is layered on after the clip poses the skeleton.
    if (this.head) this.head.rotation.x = Math.max(-0.5, Math.min(0.5, -pitch * 0.4));
  }
}
