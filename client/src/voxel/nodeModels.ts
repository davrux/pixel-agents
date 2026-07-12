/**
 * Real Luanti glTF NODE MODELS — torches, doors and fence gates rendered as their
 * converted minetest_game models (client/public/models/luanti/<name>/) instead of the
 * mesher's cubes (those ids are in blocks.ts MODEL_NODES, which the mesher skips).
 *
 * Same reconcile-per-chunk pattern as the torch-glow halos: on each chunk (re)mesh the
 * manager drops that chunk's instances and re-scans its cells, cloning the right model
 * per node. The world stores only a block id (no param2/orientation), so orientation is
 * INFERRED — a torch leans on whichever solid neighbour it touches; doors/gates use a
 * default facing. A door is 2 cells tall, so the (2-node) model is placed once at the
 * bottom cell and the top cell is skipped.
 */
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { CHUNK, toChunk } from '@pixel/shared';
import { TORCH_ID, DOOR_CLOSED, DOOR_OPEN, FENCE_GATE_CLOSED, FENCE_GATE_OPEN, PORTAL_ID, MONITOR_ID, ARCADE_ID, LADDER_ID, BED_ID } from './blocks.js';

interface Grid {
  rawChunk(cx: number, cy: number, cz: number): Uint8Array | null;
  get(x: number, y: number, z: number): number;
  solid(x: number, y: number, z: number): boolean;
}

interface Template {
  obj: THREE.Object3D;
  box: THREE.Box3;
}

// Invisible per-cell aim proxy: the models aren't in the terrain mesh, so without a
// raycast target you'd aim THROUGH a torch/door/gate and couldn't break or open it.
// A 1³ box per node cell (opacity 0 → not drawn, still raycast) sits in `aimGroup`,
// which main.ts includes in the aim raycast (but NOT camera collision).
const AIM_GEO = new THREE.BoxGeometry(1, 1, 1);
const AIM_MAT = new THREE.MeshBasicMaterial({ transparent: true, opacity: 0, depthWrite: false });

// The converted glTFs still reference their original baked texture filename (e.g.
// doors_door_wood.png, carts_cart.png) which we don't ship — each model dir has a
// `texture.png` instead, and we override the material anyway. Redirect any glTF image
// request to that sibling texture.png so GLTFLoader doesn't 404 + warn on every load.
const gltfTexManager = new THREE.LoadingManager();
gltfTexManager.setURLModifier((url) => url.replace(/\/[^/]+\.png(\?.*)?$/i, '/texture.png'));

// Which model + size for a node. `rotY`/`model` for a torch are decided per-cell (wall
// vs floor vs ceiling) in placement(); doors/gates use a fixed model + default facing.
const TORCH_H = 0.95;
const DOOR_H = 2.0;
const GATE_H = 1.0;
const MODEL_NAMES = ['torch_floor', 'torch_wall', 'torch_ceiling', 'door_a', 'door_b', 'doors_fencegate_closed', 'doors_fencegate_open'];
const MONITOR_H = 1.33; // total height of the built monitor (base + stand + screen head)
const BED_H = 0.6; // total height of a bed half (legs + frame + mattress, head/footboard on top)
const ARCADE_H = 1.9; // total height of the built arcade cabinet (body + marquee)

interface Place {
  model: string;
  targetH: number;
  rotY: number;
  wall?: [number, number]; // wall torch/ladder: (dx,dz) toward the wall it mounts on → offset there
  off?: number; // how far to offset toward the wall (torch 0.32, ladder ~0.46 = flat on the face)
}

export class NodeModels {
  readonly group = new THREE.Group();
  readonly aimGroup = new THREE.Group(); // invisible raycast proxies (added to the aim raycast)
  private readonly templates = new Map<string, Template>();
  private readonly instances = new Map<string, THREE.Object3D>(); // cellKey → placed model
  private readonly proxies = new Map<string, THREE.Mesh>(); // cellKey → invisible aim box
  private ready = false;
  private onReadyCb: (() => void) | null = null;

  constructor() {
    void this.loadAll();
  }

  private async loadAll(): Promise<void> {
    await Promise.all([...MODEL_NAMES.map((n) => this.loadTemplate(n)), this.loadPortalTemplate(), this.loadLadderTemplate()]);
    this.buildMonitorTemplate(); // procedural (no asset) — build synchronously
    this.buildBedTemplates();
    this.buildArcadeTemplate();
    this.ready = true;
    this.onReadyCb?.(); // let the app rescan already-loaded chunks
  }

  /** The ladder is a flat, wall-mounted panel (Luanti wallmounted): a double-sided quad
   *  with the ladder texture, oriented to face away from the wall it hangs on. */
  private async loadLadderTemplate(): Promise<void> {
    const tex = await new THREE.TextureLoader().loadAsync(new URL('textures/blocks/ladder.png', document.baseURI).href).catch(() => null);
    const mat = new THREE.MeshBasicMaterial({ transparent: true, alphaTest: 0.5, side: THREE.DoubleSide });
    if (tex) {
      tex.magFilter = THREE.NearestFilter;
      tex.minFilter = THREE.NearestFilter;
      tex.generateMipmaps = false;
      tex.colorSpace = THREE.SRGBColorSpace;
      mat.map = tex;
    }
    const g = new THREE.Group();
    const panel = new THREE.Mesh(new THREE.PlaneGeometry(0.9, 1.0), mat); // faces +Z by default
    panel.frustumCulled = false;
    g.add(panel);
    this.templates.set('ladder', { obj: g, box: new THREE.Box3().setFromObject(g) });
  }

  /** The conference monitor is a procedural multi-cube model (no glTF asset): a flat
   *  base, a stand pole and a wide screen head whose face shows a "video call" texture —
   *  the voxel equivalent of the 2D office monitor. Built at final world size (~1.33 tall),
   *  centred on X/Z; makeInstance scales targetH/height ≈ 1. Screen faces +Z (rotY 0). */
  private buildMonitorTemplate(): void {
    const box = (w: number, h: number, d: number, color: number): THREE.Mesh => {
      const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), new THREE.MeshBasicMaterial({ color }));
      m.frustumCulled = false;
      return m;
    };
    const g = new THREE.Group();
    const dark = 0x20242e; // stand/frame plastic
    const bezel = 0x15181f; // near-black screen frame
    const base = box(0.5, 0.08, 0.34, dark);
    base.position.set(0, 0.04, 0);
    const pole = box(0.12, 0.55, 0.12, dark);
    pole.position.set(0, 0.35, 0);
    const head = box(0.98, 0.66, 0.1, bezel);
    head.position.set(0, 1.0, 0);
    // The lit screen face — a canvas "video call" texture on a thin front panel.
    const cv = document.createElement('canvas');
    cv.width = 128;
    cv.height = 96;
    const c = cv.getContext('2d')!;
    c.fillStyle = '#2b3550';
    c.fillRect(0, 0, 128, 96);
    c.fillStyle = '#3a6ea5'; // blue screen
    c.fillRect(4, 4, 120, 88);
    c.fillStyle = '#dfe8f5'; // two head-and-shoulders silhouettes
    for (const cx of [40, 88]) {
      c.beginPath();
      c.arc(cx, 40, 12, 0, Math.PI * 2);
      c.fill();
      c.fillRect(cx - 18, 56, 36, 30);
    }
    const tex = new THREE.CanvasTexture(cv);
    tex.magFilter = THREE.NearestFilter;
    tex.minFilter = THREE.NearestFilter;
    tex.generateMipmaps = false;
    tex.colorSpace = THREE.SRGBColorSpace;
    const screen = new THREE.Mesh(new THREE.PlaneGeometry(0.86, 0.54), new THREE.MeshBasicMaterial({ map: tex }));
    screen.position.set(0, 1.0, 0.051); // just in front of the head's +Z face
    screen.frustumCulled = false;
    g.add(base, pole, head, screen);
    this.templates.set('monitor', { obj: g, box: new THREE.Box3().setFromObject(g) });
  }

  /** Procedural arcade cabinet (no glTF asset): an upright body with a lit marquee, an
   *  angled screen showing a game "attract" image, and a control panel with a joystick +
   *  buttons. Authored with its FRONT (screen/controls) toward +Z so placement() can face
   *  it away from an adjacent wall. Built at final size (~1.9 tall) ⇒ makeInstance scale ≈1. */
  private buildArcadeTemplate(): void {
    const box = (w: number, h: number, d: number, color: number): THREE.Mesh => {
      const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), new THREE.MeshBasicMaterial({ color }));
      m.frustumCulled = false;
      return m;
    };
    const g = new THREE.Group();
    const CAB = 0x2b1e46; // cabinet body (deep arcade purple)
    const TRIM = 0x14101f; // near-black trim/bezel
    const body = box(0.82, 1.9, 0.66, CAB);
    body.position.set(0, 0.95, 0);
    const marquee = box(0.84, 0.26, 0.12, 0xf03a3a); // lit red marquee header
    marquee.position.set(0, 1.8, 0.28);
    const bezel = box(0.74, 0.56, 0.06, TRIM); // screen surround, upper front
    bezel.position.set(0, 1.4, 0.33);
    // Screen "attract" image (canvas): a dark scene with a red horizon + title bar.
    const cv = document.createElement('canvas');
    cv.width = 128;
    cv.height = 96;
    const c = cv.getContext('2d')!;
    c.fillStyle = '#101018';
    c.fillRect(0, 0, 128, 96);
    c.fillStyle = '#7a1414'; // hellish red floor
    c.fillRect(0, 60, 128, 36);
    c.fillStyle = '#c23a2a';
    c.fillRect(0, 58, 128, 4);
    c.fillStyle = '#e8e0d0'; // marquee-ish title band
    c.fillRect(14, 12, 100, 20);
    c.fillStyle = '#101018';
    c.font = 'bold 16px monospace';
    c.textAlign = 'center';
    c.textBaseline = 'middle';
    c.fillText('ARCADE', 64, 23);
    const tex = new THREE.CanvasTexture(cv);
    tex.magFilter = THREE.NearestFilter;
    tex.minFilter = THREE.NearestFilter;
    tex.generateMipmaps = false;
    tex.colorSpace = THREE.SRGBColorSpace;
    const screen = new THREE.Mesh(new THREE.PlaneGeometry(0.66, 0.48), new THREE.MeshBasicMaterial({ map: tex }));
    screen.position.set(0, 1.4, 0.361);
    screen.frustumCulled = false;
    const panel = box(0.8, 0.14, 0.36, TRIM); // control deck jutting out at waist height
    panel.position.set(0, 0.98, 0.42);
    const stick = box(0.05, 0.16, 0.05, 0x111111); // joystick shaft
    stick.position.set(-0.18, 1.1, 0.44);
    const knob = box(0.09, 0.09, 0.09, 0xd83030); // joystick ball
    knob.position.set(-0.18, 1.2, 0.44);
    const btnA = box(0.08, 0.05, 0.08, 0xf0c020); // buttons
    btnA.position.set(0.08, 1.06, 0.46);
    const btnB = box(0.08, 0.05, 0.08, 0x30c0f0);
    btnB.position.set(0.22, 1.06, 0.46);
    g.add(body, marquee, bezel, screen, panel, stick, knob, btnA, btnB);
    this.templates.set('arcade', { obj: g, box: new THREE.Box3().setFromObject(g) });
  }

  /** Procedural two-cell bed (no glTF asset). A bed spans two adjacent cells that both
   *  hold BED_ID; placement() decides per cell whether it's the foot half or head half
   *  (the higher-coordinate cell is the head) and the shared facing, so the two halves meet
   *  seamlessly into one bed. Each half is authored in a canonical frame with foot→head
   *  along +Z: legs at the OUTER corners only (so the seam has no doubled legs), a wood
   *  frame + red mattress filling the cell, a footboard on the foot half and a headboard +
   *  white pillow on the head half. Built at final size (BED_H tall) ⇒ makeInstance scale ≈ 1. */
  private buildBedTemplates(): void {
    const WOOD = 0x6b4423,
      SHEET = 0xb5352b, // red mattress/blanket (matches the bed_top tile)
      PILLOW = 0xece3d0;
    // A box spanning [x0,x1]×[y0,y1]×[z0,z1] (local cell frame: x/z centred on 0, y up from 0).
    const box = (x0: number, x1: number, y0: number, y1: number, z0: number, z1: number, color: number): THREE.Mesh => {
      const m = new THREE.Mesh(new THREE.BoxGeometry(x1 - x0, y1 - y0, z1 - z0), new THREE.MeshBasicMaterial({ color }));
      m.position.set((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2);
      m.frustumCulled = false;
      return m;
    };
    const leg = (cx: number, cz: number): THREE.Mesh => box(cx - 0.05, cx + 0.05, 0, 0.16, cz - 0.05, cz + 0.05, WOOD);
    const frame = (): THREE.Mesh => box(-0.5, 0.5, 0.14, 0.3, -0.5, 0.5, WOOD); // base rails, fills the cell
    const mattress = (): THREE.Mesh => box(-0.44, 0.44, 0.3, 0.5, -0.5, 0.5, SHEET); // meets the seam on ±Z
    const build = (parts: THREE.Object3D[]): Template => {
      const g = new THREE.Group();
      for (const p of parts) g.add(p);
      return { obj: g, box: new THREE.Box3().setFromObject(g) };
    };
    // Foot half: legs at the -Z (outer) corners, a footboard rising above the mattress.
    this.templates.set(
      'bed_foot',
      build([leg(-0.44, -0.44), leg(0.44, -0.44), frame(), mattress(), box(-0.5, 0.5, 0.14, 0.6, -0.5, -0.4, WOOD)]),
    );
    // Head half: legs at the +Z (outer) corners, a headboard, and a pillow on the mattress.
    this.templates.set(
      'bed_head',
      build([leg(-0.44, 0.44), leg(0.44, 0.44), frame(), mattress(), box(-0.5, 0.5, 0.14, 0.6, 0.4, 0.5, WOOD), box(-0.4, 0.4, 0.5, 0.6, 0.12, 0.42, PILLOW)]),
    );
    // Single fallback (a lone cell mid-break / legacy): a whole bed squeezed into one cell.
    this.templates.set(
      'bed_single',
      build([
        leg(-0.44, -0.44),
        leg(0.44, -0.44),
        leg(-0.44, 0.44),
        leg(0.44, 0.44),
        frame(),
        box(-0.44, 0.44, 0.3, 0.5, -0.5, 0.36, SHEET),
        box(-0.5, 0.5, 0.14, 0.6, -0.5, -0.42, WOOD),
        box(-0.5, 0.5, 0.14, 0.6, 0.42, 0.5, WOOD),
        box(-0.4, 0.4, 0.5, 0.6, 0.16, 0.42, PILLOW),
      ]),
    );
  }

  /** The portal is the door_a shape with a generated "blue door + bold P" texture — a
   *  distinct portal archway (no dedicated portal model exists). */
  private async loadPortalTemplate(): Promise<void> {
    const gltf = await new GLTFLoader(gltfTexManager).loadAsync(new URL('models/luanti/door_a/door_a.gltf', document.baseURI).href);
    const cv = document.createElement('canvas');
    cv.width = cv.height = 64;
    const g = cv.getContext('2d')!;
    g.fillStyle = '#26307a'; // deep blue border
    g.fillRect(0, 0, 64, 64);
    g.fillStyle = '#3f5fd0'; // brighter inner panel
    g.fillRect(5, 5, 54, 54);
    g.fillStyle = '#eef2ff';
    g.font = 'bold 48px sans-serif';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText('P', 32, 36); // thick centred P
    const tex = new THREE.CanvasTexture(cv);
    tex.magFilter = THREE.NearestFilter;
    tex.minFilter = THREE.NearestFilter;
    tex.generateMipmaps = false;
    tex.flipY = false;
    tex.colorSpace = THREE.SRGBColorSpace;
    const mat = new THREE.MeshBasicMaterial({ map: tex, side: THREE.DoubleSide });
    const obj = gltf.scene;
    obj.traverse((o) => {
      if ((o as THREE.Mesh).isMesh) {
        (o as THREE.Mesh).material = mat;
        o.frustumCulled = false;
      }
    });
    this.templates.set('portal', { obj, box: new THREE.Box3().setFromObject(obj) });
  }

  private async loadTemplate(name: string): Promise<void> {
    const base = new URL(`models/luanti/${name}/`, document.baseURI).href;
    const loader = new THREE.TextureLoader();
    const tex = await loader.loadAsync(base + 'texture.png').catch(() => null);
    const mat = new THREE.MeshBasicMaterial({ alphaTest: 0.5, side: THREE.DoubleSide });
    if (tex) {
      tex.magFilter = THREE.NearestFilter;
      tex.minFilter = THREE.NearestFilter;
      tex.generateMipmaps = false;
      tex.flipY = false; // glTF UVs assume no flip
      tex.colorSpace = THREE.SRGBColorSpace;
      mat.map = tex;
    }
    const gltf = await new GLTFLoader(gltfTexManager).loadAsync(base + `${name}.gltf`);
    const obj = gltf.scene;
    obj.traverse((o) => {
      if ((o as THREE.Mesh).isMesh) {
        (o as THREE.Mesh).material = mat;
        o.frustumCulled = false;
      }
    });
    this.templates.set(name, { obj, box: new THREE.Box3().setFromObject(obj) });
  }

  /** Called once all model templates have loaded — the app rescans loaded chunks. */
  onReady(cb: () => void): void {
    this.onReadyCb = cb;
    if (this.ready) cb();
  }

  /** Which model + orientation for the node at (x,y,z), or null to draw nothing (e.g.
   *  a door's top cell — the 2-tall model is placed at the bottom cell only). */
  private placement(id: number, x: number, y: number, z: number, w: Grid): Place | null {
    if (id === TORCH_ID) {
      if (w.solid(x, y - 1, z)) return { model: 'torch_floor', targetH: TORCH_H, rotY: 0 };
      // Wall torch: lean on the first solid horizontal neighbour. rotY turns the model so
      // its back sits against that wall (model authored leaning on its local -Z wall).
      const dirs: [number, number, number, number][] = [
        [0, 0, -1, 0], // wall at -Z
        [1, 0, 0, Math.PI / 2], // wall at +X
        [0, 0, 1, Math.PI], // wall at +Z
        [-1, 0, 0, -Math.PI / 2], // wall at -X
      ];
      for (const [dx, , dz, rotY] of dirs) {
        if (w.solid(x + dx, y, z + dz)) return { model: 'torch_wall', targetH: TORCH_H, rotY, wall: [dx, dz] };
      }
      if (w.solid(x, y + 1, z)) return { model: 'torch_ceiling', targetH: TORCH_H, rotY: 0 };
      return { model: 'torch_floor', targetH: TORCH_H, rotY: 0 };
    }
    if (id === LADDER_ID) {
      // Flat panel on the first solid horizontal neighbour, facing away from that wall.
      const dirs: [number, number, number, number][] = [
        [0, 0, -1, 0], // wall at -Z → face +Z
        [0, 0, 1, Math.PI], // wall at +Z → face -Z
        [-1, 0, 0, Math.PI / 2], // wall at -X → face +X
        [1, 0, 0, -Math.PI / 2], // wall at +X → face -X
      ];
      for (const [dx, , dz, rotY] of dirs) {
        if (w.solid(x + dx, y, z + dz)) return { model: 'ladder', targetH: 1.0, rotY, wall: [dx, dz], off: 0.46 };
      }
      return { model: 'ladder', targetH: 1.0, rotY: 0 }; // no wall found (legacy/free-standing) → centred
    }
    if (id === DOOR_CLOSED || id === DOOR_OPEN) {
      // Only the bottom cell of the 2-tall door draws the (2-node) model.
      if (w.get(x, y - 1, z) === DOOR_CLOSED || w.get(x, y - 1, z) === DOOR_OPEN) return null;
      return { model: id === DOOR_OPEN ? 'door_b' : 'door_a', targetH: DOOR_H, rotY: 0 };
    }
    if (id === BED_ID) {
      // A bed is two adjacent BED_ID cells. Pair with the first bed neighbour (fixed
      // priority) and infer the layout from coordinates: foot→head runs toward +X (X axis)
      // or +Z (Z axis), so the higher-coordinate cell is the head. Both cells derive the
      // same facing ⇒ the two halves line up seamlessly. A lone cell falls back to a single.
      for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as [number, number][]) {
        if (w.get(x + dx, y, z + dz) !== BED_ID) continue;
        const alongX = dx !== 0;
        const isFoot = alongX ? dx === 1 : dz === 1; // the partner is the head ⇒ this cell is the foot
        return { model: isFoot ? 'bed_foot' : 'bed_head', targetH: BED_H, rotY: alongX ? Math.PI / 2 : 0 };
      }
      return { model: 'bed_single', targetH: BED_H, rotY: 0 };
    }
    if (id === FENCE_GATE_CLOSED) return { model: 'doors_fencegate_closed', targetH: GATE_H, rotY: 0 };
    if (id === FENCE_GATE_OPEN) return { model: 'doors_fencegate_open', targetH: GATE_H, rotY: 0 };
    if (id === PORTAL_ID) return { model: 'portal', targetH: DOOR_H, rotY: 0 }; // a 2-tall blue "P" archway
    if (id === MONITOR_ID) return { model: 'monitor', targetH: MONITOR_H, rotY: 0 }; // standing conference screen
    if (id === ARCADE_ID) {
      // Face the cabinet's front (+Z) AWAY from the first solid horizontal neighbour so
      // its screen points into the room (same wall table as the ladder). No wall → +Z.
      const dirs: [number, number, number, number][] = [
        [0, 0, -1, 0], // wall at -Z → face +Z
        [0, 0, 1, Math.PI], // wall at +Z → face -Z
        [-1, 0, 0, Math.PI / 2], // wall at -X → face +X
        [1, 0, 0, -Math.PI / 2], // wall at +X → face -X
      ];
      for (const [dx, , dz, rotY] of dirs) if (w.solid(x + dx, y, z + dz)) return { model: 'arcade', targetH: ARCADE_H, rotY };
      return { model: 'arcade', targetH: ARCADE_H, rotY: 0 };
    }
    return null;
  }

  /** Build one placed instance: a clone scaled to targetH, centred in the cell (X/Z),
   *  feet at the cell floor, rotated rotY around the cell centre. */
  private makeInstance(p: Place): THREE.Object3D | null {
    const t = this.templates.get(p.model);
    if (!t) return null;
    const m = t.obj.clone(true);
    const size = new THREE.Vector3();
    t.box.getSize(size);
    const s = p.targetH / Math.max(0.001, size.y);
    m.scale.setScalar(s);
    // Centre horizontally on the model's own bounds; drop its bottom to y=0.
    m.position.set(-(t.box.min.x + size.x / 2) * s, -t.box.min.y * s, -(t.box.min.z + size.z / 2) * s);
    const g = new THREE.Group();
    g.add(m);
    g.rotation.y = p.rotY;
    return g;
  }

  /** Drop a chunk's placed models + aim proxies from both maps. */
  private dropChunk(cx: number, cy: number, cz: number): void {
    for (const [key, node] of this.instances) {
      const [px, py, pz] = key.split(',').map(Number);
      if (toChunk(px) === cx && toChunk(py) === cy && toChunk(pz) === cz) {
        this.group.remove(node);
        this.instances.delete(key);
      }
    }
    for (const [key, box] of this.proxies) {
      const [px, py, pz] = key.split(',').map(Number);
      if (toChunk(px) === cx && toChunk(py) === cy && toChunk(pz) === cz) {
        this.aimGroup.remove(box);
        this.proxies.delete(key);
      }
    }
  }

  /** Reconcile one chunk's node models + aim proxies: drop, then re-scan its cells. */
  rebuildChunk(cx: number, cy: number, cz: number, w: Grid): void {
    if (!this.ready) return;
    this.dropChunk(cx, cy, cz);
    const cells = w.rawChunk(cx, cy, cz);
    if (!cells) return;
    const x0 = cx * CHUNK,
      y0 = cy * CHUNK,
      z0 = cz * CHUNK;
    const AREA = CHUNK * CHUNK;
    for (let i = 0; i < cells.length; i++) {
      const id = cells[i];
      if (id !== TORCH_ID && id !== DOOR_CLOSED && id !== DOOR_OPEN && id !== FENCE_GATE_CLOSED && id !== FENCE_GATE_OPEN && id !== PORTAL_ID && id !== MONITOR_ID && id !== ARCADE_ID && id !== LADDER_ID && id !== BED_ID) continue;
      const ly = (i / AREA) | 0,
        rem = i % AREA,
        lz = (rem / CHUNK) | 0,
        lx = rem % CHUNK;
      const x = x0 + lx,
        y = y0 + ly,
        z = z0 + lz;
      // Every node cell gets an invisible aim box so you can look at it to break/open it.
      const box = new THREE.Mesh(AIM_GEO, AIM_MAT);
      box.position.set(x + 0.5, y + 0.5, z + 0.5);
      this.proxies.set(`${x},${y},${z}`, box);
      this.aimGroup.add(box);
      // The visible model (torch/door/gate); door's top cell returns null (bottom draws it).
      const place = this.placement(id, x, y, z, w);
      if (!place) continue;
      const inst = this.makeInstance(place);
      if (!inst) continue;
      // Wall-mounted (torch/ladder): shift toward its wall so it sits on the face.
      const off = place.off ?? 0.32;
      const ox = place.wall ? place.wall[0] * off : 0;
      const oz = place.wall ? place.wall[1] * off : 0;
      inst.position.set(x + 0.5 + ox, y, z + 0.5 + oz);
      this.instances.set(`${x},${y},${z}`, inst);
      this.group.add(inst);
    }
  }

  /** Drop every instance + proxy in a chunk (chunk unloaded). */
  removeChunk(cx: number, cy: number, cz: number): void {
    this.dropChunk(cx, cy, cz);
  }

  /** Forget everything (world switch). */
  clear(): void {
    for (const node of this.instances.values()) this.group.remove(node);
    this.instances.clear();
    for (const box of this.proxies.values()) this.aimGroup.remove(box);
    this.proxies.clear();
  }
}
