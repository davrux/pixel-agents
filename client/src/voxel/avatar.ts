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
import { buildItemMesh } from './tool.js';

const TARGET_H = 1.8; // world-units tall (matches the player AABB height)
const FACING = 0; // model already faces its local -Z, which is the player's forward at yaw 0

// Wield transform in the Arm_Right bone's local space (editable live per item via
// the settings editor, persisted per item). The bone has a 180° rotation baked in
// so +Y runs DOWN the arm and 1 unit = 2 skin px (arm ≈ 6.3 units). The mesh pivot
// is the handle end (buildItemMesh([.1,.85])) so the fist grips the handle.
// Reference for the intent: Luanti's wield3d attaches items to "Arm_Right".
export interface Wield {
  px: number;
  py: number;
  pz: number;
  rx: number;
  ry: number;
  rz: number;
  s: number;
}
// Tuned in-game for the steel pickaxe; other items start from this and get tuned.
export const DEFAULT_WIELD: Wield = { px: 0.2, py: 5.2, pz: 1, rx: -0.86, ry: Math.PI / 2, rz: 0, s: 6 };
const DEFAULT_ITEM = 'items/default_tool_steelpick'; // texUrl (relative under textures/)

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
  private armR: THREE.Object3D | null = null;
  private tool: THREE.Mesh | null = null;
  private toolMat: THREE.Material | null = null;
  private wieldT: Wield = { ...DEFAULT_WIELD };
  private item = DEFAULT_ITEM; // currently wielded item texUrl (relative under textures/)
  private pivot: [number, number] = [0.1, 0.85]; // sprite grip point
  private current = 'stand';
  private mining = false; // held: keep swinging while breaking a block
  private digT = 0; // one-shot swing timer (place feedback)
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
      if (o.name === 'Arm_Right') this.armR = o;
    });

    // Wielded item in the right hand: extrude the item sprite, hang it off the
    // arm bone so it follows the mine swing. Sized/placed in bone-local space.
    this.buildTool();

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

  /** First person (real-body mode) puts the camera at the eye → hide just the
   *  head so it can't block the view (scaling the Head joint hides its verts). */
  setFirstPerson(on: boolean): void {
    if (this.head) this.head.scale.setScalar(on ? 0.0001 : 1);
  }

  /** Fade the whole avatar (body + held tool). Used in first person when looking
   *  down so the body doesn't obscure the view — see-through instead of a
   *  separate hand model. o=1 is fully solid. */
  setOpacity(o: number): void {
    const set = (m: THREE.Material | null): void => {
      if (!m) return;
      m.transparent = o < 0.999;
      m.depthWrite = o >= 0.999;
      (m as THREE.MeshBasicMaterial).opacity = o;
    };
    set(this.mat);
    set(this.toolMat);
  }

  /** How the wielded item attaches to the hand (Arm_Right bone), set live from
   *  the per-item editor. Stored so it applies once the tool mesh has loaded. */
  setWieldTransform(w: Wield): void {
    this.wieldT = { ...w };
    this.applyWield();
  }

  /** Switch the wielded item (texUrl relative under textures/, e.g.
   *  'items/default_tool_steelpick' or 'blocks/stone') + its pivot + hold
   *  transform. Rebuilds the extruded mesh; defers if the model isn't loaded. */
  wield(texUrl: string, pivot: [number, number], w: Wield): void {
    this.item = texUrl;
    this.pivot = pivot;
    this.wieldT = { ...w };
    this.buildTool();
  }

  /** Show an empty hand (no wielded item) — used when only tools are held in hand. */
  hideWield(): void {
    this.item = '';
    if (this.tool && this.armR) {
      this.armR.remove(this.tool);
      this.tool.geometry.dispose();
      (this.tool.material as THREE.Material).dispose();
    }
    this.tool = null;
    this.toolMat = null;
  }

  private buildTool(): void {
    if (!this.armR) return; // model not loaded yet — onLoad will build it
    const arm = this.armR;
    const url = new URL(`textures/${this.item}.png`, document.baseURI).href;
    void buildItemMesh(url, this.pivot).then((tool) => {
      if (this.tool) {
        arm.remove(this.tool);
        this.tool.geometry.dispose();
        (this.tool.material as THREE.Material).dispose();
      }
      tool.frustumCulled = false;
      this.tool = tool;
      this.toolMat = tool.material as THREE.Material;
      arm.add(tool);
      this.applyWield();
    });
  }

  private applyWield(): void {
    const t = this.tool;
    const w = this.wieldT;
    if (!t) return;
    t.position.set(w.px, w.py, w.pz);
    t.rotation.set(w.rx, w.ry, w.rz);
    t.scale.setScalar(w.s);
  }

  /** One-shot swing (block place feedback). */
  playDig(): void {
    this.digT = 0.35;
  }

  /** Held state: keep the mine swing looping while breaking a block. */
  setMining(on: boolean): void {
    this.mining = on;
  }

  /** Crossfade to a clip. All clips loop, so both sides are always playing —
   *  the mine loop doubles as the one-shot swing (we just leave it briefly). */
  private cross(name: string): void {
    if (this.current === name || !this.actions[name]) return;
    const from = this.actions[this.current];
    const to = this.actions[name].reset();
    to.play();
    if (from && from.isRunning()) from.crossFadeTo(to, 0.18, false);
    else to.fadeIn(0.18);
    this.current = name;
  }

  animate(dt: number, speed: number, pitch = 0): void {
    if (!this.mixer) return;
    if (this.digT > 0) this.digT -= dt;
    const want = this.mining || this.digT > 0 ? 'mine' : speed > 0.4 ? 'walk' : 'stand';
    this.cross(want);
    this.mixer.update(dt);
    // Head look is layered on after the clip poses the skeleton.
    if (this.head) this.head.rotation.x = Math.max(-0.5, Math.min(0.5, -pitch * 0.4));
  }
}
