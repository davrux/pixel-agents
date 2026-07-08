/**
 * Real Luanti animal models (mobs_animal b3d → glTF via assimp: mesh + skeleton +
 * one baked animation timeline at 60 fps). Loaded from
 * models/luanti-mobs/<dir>/<dir>.gltf with the mob's texture.png on an unlit
 * MeshBasicMaterial (the voxel world has no lights). Exposes the same surface
 * main.ts uses for every NPC render: `group`, `setTint(color)`, `animate(dt,speed)`.
 *
 * The b3d packs stand/walk/run/… into ONE timeline; mobs_animal's Lua declares the
 * frame ranges (below), so — exactly like avatar.ts does for the player — we slice
 * named sub-clips out of it and crossfade stand↔walk by speed. Without this the
 * whole timeline loops (stand+walk+die), which looks like "sliding, barely moving".
 */
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';

// The converted mob glTFs reference their original baked texture name (e.g.
// mobs_cow_map.png) which we don't ship — each dir has a `texture.png` we override with.
// Redirect glTF image requests to that sibling so GLTFLoader doesn't 404 + warn.
const gltfTexManager = new THREE.LoadingManager();
gltfTexManager.setURLModifier((url) => url.replace(/\/[^/]+\.png(\?.*)?$/i, '/texture.png'));

export interface MobSpec {
  dir: string;
  h: number; // world-height in blocks
  stand: [number, number]; // [startFrame, endFrame] at 60 fps
  walk: [number, number];
}

// Server mob `kind` → converted model + height + Lua frame ranges (mobs_animal).
// (pig has no plain-pig model in mobs_animal — Pumba the warthog stands in.)
export const LUANTI_MOBS: Record<string, MobSpec> = {
  cow: { dir: 'mobs_cow', h: 1.4, stand: [35, 75], walk: [85, 114] },
  sheep: { dir: 'mobs_sheep', h: 1.3, stand: [0, 80], walk: [81, 100] },
  chicken: { dir: 'mobs_chicken', h: 0.8, stand: [1, 30], walk: [71, 90] },
  pig: { dir: 'mobs_pumba', h: 1.0, stand: [25, 55], walk: [70, 100] },
  bunny: { dir: 'mobs_bunny', h: 0.5, stand: [1, 15], walk: [16, 24] },
  panda: { dir: 'mobs_panda', h: 1.3, stand: [130, 270], walk: [10, 70] },
  penguin: { dir: 'mobs_penguin', h: 0.8, stand: [1, 20], walk: [25, 45] },
  bee: { dir: 'mobs_bee', h: 0.6, stand: [0, 30], walk: [0, 30] }, // walk [35-65] is a big body HOP → use the flat hover range for both (wings flap, body steady)
};

const FPS = 60; // the batch converter bakes the b3d timeline at 60 fps
// The game yaws a mob so its local -Z points along travel (same as the player
// avatar); the assimp-exported models already face -Z, so no extra turn.
const FACING = 0;

export class GltfMob {
  readonly group = new THREE.Group();
  private readonly mat = new THREE.MeshBasicMaterial({ alphaTest: 0.5 });
  private mixer: THREE.AnimationMixer | null = null;
  private actions: Record<string, THREE.AnimationAction> = {};
  private current = 'stand';

  constructor(private readonly spec: MobSpec) {
    const base = new URL(`models/luanti-mobs/${spec.dir}/`, document.baseURI).href;
    new THREE.TextureLoader().load(base + 'texture.png', (tex) => {
      tex.magFilter = THREE.NearestFilter;
      tex.minFilter = THREE.NearestFilter;
      tex.generateMipmaps = false;
      tex.flipY = false; // glTF UVs assume no flip
      tex.colorSpace = THREE.SRGBColorSpace;
      this.mat.map = tex;
      this.mat.needsUpdate = true;
    });
    new GLTFLoader(gltfTexManager).load(base + `${spec.dir}.gltf`, (gltf) => this.onLoad(gltf));
  }

  private onLoad(gltf: { scene: THREE.Group; animations: THREE.AnimationClip[] }): void {
    const model = gltf.scene;
    model.traverse((o) => {
      if ((o as THREE.Mesh).isMesh) {
        const m = o as THREE.Mesh;
        m.material = this.mat; // swap PBR → our unlit skinned material
        m.frustumCulled = false;
      }
    });
    // Scale so the model is spec.h tall and its feet sit at group origin y=0.
    const box = new THREE.Box3().setFromObject(model);
    const s = this.spec.h / Math.max(0.001, box.max.y - box.min.y);
    model.scale.setScalar(s);
    model.position.y = -box.min.y * s;
    model.rotation.y = FACING;
    this.group.add(model);

    // Slice the one baked timeline into stand/walk sub-clips (Lua frame ranges).
    const source = gltf.animations[0];
    if (source) {
      this.mixer = new THREE.AnimationMixer(model);
      for (const [name, [a, b]] of [['stand', this.spec.stand], ['walk', this.spec.walk]] as const) {
        const clip = THREE.AnimationUtils.subclip(source, name, a, b, FPS);
        this.actions[name] = this.mixer.clipAction(clip);
      }
      this.actions[this.current]?.play();
    }
  }

  /** Day/night tint — multiplies the (unlit) texture, matching the world shading. */
  setTint(c: THREE.Color): void {
    this.mat.color.copy(c);
  }

  private cross(name: string): void {
    if (this.current === name || !this.actions[name]) return;
    const from = this.actions[this.current];
    const to = this.actions[name].reset();
    to.play();
    if (from && from.isRunning()) from.crossFadeTo(to, 0.2, false);
    else to.fadeIn(0.2);
    this.current = name;
  }

  /** Crossfade stand↔walk by movement speed. */
  animate(dt: number, speed: number): void {
    if (!this.mixer) return;
    this.cross(speed > 0.4 ? 'walk' : 'stand');
    this.mixer.update(dt);
  }
}
