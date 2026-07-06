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
import { TORCH_ID, DOOR_CLOSED, DOOR_OPEN, FENCE_GATE_CLOSED, FENCE_GATE_OPEN } from './blocks.js';

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

// Which model + size for a node. `rotY`/`model` for a torch are decided per-cell (wall
// vs floor vs ceiling) in placement(); doors/gates use a fixed model + default facing.
const TORCH_H = 0.95;
const DOOR_H = 2.0;
const GATE_H = 1.0;
const MODEL_NAMES = ['torch_floor', 'torch_wall', 'torch_ceiling', 'door_a', 'door_b', 'doors_fencegate_closed', 'doors_fencegate_open'];

interface Place {
  model: string;
  targetH: number;
  rotY: number;
  wall?: [number, number]; // wall torch: (dx,dz) toward the wall it mounts on → offset there
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
    await Promise.all(MODEL_NAMES.map((n) => this.loadTemplate(n)));
    this.ready = true;
    this.onReadyCb?.(); // let the app rescan already-loaded chunks
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
    const gltf = await new GLTFLoader().loadAsync(base + `${name}.gltf`);
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
    if (id === DOOR_CLOSED || id === DOOR_OPEN) {
      // Only the bottom cell of the 2-tall door draws the (2-node) model.
      if (w.get(x, y - 1, z) === DOOR_CLOSED || w.get(x, y - 1, z) === DOOR_OPEN) return null;
      return { model: id === DOOR_OPEN ? 'door_b' : 'door_a', targetH: DOOR_H, rotY: 0 };
    }
    if (id === FENCE_GATE_CLOSED) return { model: 'doors_fencegate_closed', targetH: GATE_H, rotY: 0 };
    if (id === FENCE_GATE_OPEN) return { model: 'doors_fencegate_open', targetH: GATE_H, rotY: 0 };
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
      if (id !== TORCH_ID && id !== DOOR_CLOSED && id !== DOOR_OPEN && id !== FENCE_GATE_CLOSED && id !== FENCE_GATE_OPEN) continue;
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
      // Wall torch: shift toward its wall so it mounts on the face instead of floating.
      const ox = place.wall ? place.wall[0] * 0.32 : 0;
      const oz = place.wall ? place.wall[1] * 0.32 : 0;
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
