/**
 * Voxel world → one BufferGeometry. Only air-exposed faces are emitted (face
 * culling). Each face gets the block's atlas UVs (texture) and per-vertex colour
 * = directional face shade × ambient occlusion (baked grey), so the textured,
 * unlit MeshBasicMaterial (map + vertexColors) shows the polished, soft-shadowed
 * Minecraft look. Rebuilt whole on edit; fine for the single spike region.
 */
import { CHUNK, isFluidId, fluidOf, fluidLevel, LAVA_FLUID, type FluidDef } from '@pixel/shared';
import { BLOCKS, SHADE, AIR, TRANSPARENT, RENDER_SKIP, MODEL_NODES, PLANT, FENCE_SHAPE, FENCE_GATE_OPEN, RAIL_ID } from './blocks.js';
import { MAX_LIGHT, type LightSampler } from './light.js';
import type { Atlas } from './textures.js';
import type { VoxelWorld } from './world.js';

// This module is deliberately THREE-free (plain typed arrays only) so it can run
// inside a Web Worker off the main thread — the caller assembles a BufferGeometry
// from these buffers (see geometryFromBuffers in main.ts). `pos`/`col`/`uv` are
// interleaved-per-vertex triples/pairs; `sky`/`blk` (opaque only) are the two baked
// light channels the terrain shader reads.
export interface LayerBuffers {
  pos: Float32Array;
  col: Float32Array;
  uv: Float32Array;
  sky?: Float32Array;
  blk?: Float32Array;
}
/** Opaque + fluid geometry buffers for one chunk. Water and lava each get their own
 *  transparent/emissive mesh (rendered with different materials). */
export interface ChunkBuffers {
  opaque: LayerBuffers | null;
  water: LayerBuffers | null;
  lava: LayerBuffers | null;
}

type Corner = [number, number, number];
type UV = [number, number];
interface Face {
  n: [number, number, number];
  fam: 'top' | 'side' | 'bottom';
  quad: [Corner, Corner, Corner, Corner];
  uv: [UV, UV, UV, UV]; // unit UVs per corner (v = world-up on side faces)
}
const FACES: Face[] = [
  { n: [0, 1, 0], fam: 'top', quad: [[0, 1, 0], [0, 1, 1], [1, 1, 1], [1, 1, 0]], uv: [[0, 0], [0, 1], [1, 1], [1, 0]] },
  { n: [0, -1, 0], fam: 'bottom', quad: [[0, 0, 0], [1, 0, 0], [1, 0, 1], [0, 0, 1]], uv: [[0, 0], [1, 0], [1, 1], [0, 1]] },
  { n: [1, 0, 0], fam: 'side', quad: [[1, 0, 0], [1, 1, 0], [1, 1, 1], [1, 0, 1]], uv: [[0, 0], [0, 1], [1, 1], [1, 0]] },
  { n: [-1, 0, 0], fam: 'side', quad: [[0, 0, 1], [0, 1, 1], [0, 1, 0], [0, 0, 0]], uv: [[1, 0], [1, 1], [0, 1], [0, 0]] },
  { n: [0, 0, 1], fam: 'side', quad: [[1, 0, 1], [1, 1, 1], [0, 1, 1], [0, 0, 1]], uv: [[1, 0], [1, 1], [0, 1], [0, 0]] },
  { n: [0, 0, -1], fam: 'side', quad: [[0, 0, 0], [0, 1, 0], [1, 1, 0], [1, 0, 0]], uv: [[0, 0], [0, 1], [1, 1], [1, 0]] },
];
const AO = [0.5, 0.7, 0.85, 1.0]; // occlusion level 0 (deep) → 3 (open)

/** Build the geometry for one chunk (world coords), neighbour-culled across chunk
 *  boundaries via world.get. Opaque blocks and water go to separate buffers: an
 *  opaque block hides a face only behind another opaque block (so submerged terrain
 *  still shows through the water); a water cell only emits faces exposed to AIR
 *  (its surface + shore edges), never internal water-water or water-in-terrain faces. */
export function buildChunkBuffers(world: VoxelWorld, atlas: Atlas, light: LightSampler, cx: number, cy: number, cz: number): ChunkBuffers {
  // Opaque geometry also carries per-vertex sky/block light (0..1); fluids don't (their
  // materials light differently). `sky`/`blk` stay parallel to `opq.pos` vertex-for-vertex.
  const opq = { pos: [] as number[], col: [] as number[], uvs: [] as number[], sky: [] as number[], blk: [] as number[] };
  const wat = { pos: [] as number[], col: [] as number[], uvs: [] as number[] };
  const lav = { pos: [] as number[], col: [] as number[], uvs: [] as number[] };
  const x0 = cx * CHUNK,
    y0 = cy * CHUNK,
    z0 = cz * CHUNK;
  // Fast cell read: the meshed chunk's own cells array for in-chunk coords (no per-call
  // string key + Map lookup), world.get only for the 1-cell border. This is the hot
  // path — thousands of reads per chunk — so it matters a lot for movement smoothness.
  const own = world.rawChunk(cx, cy, cz);
  const cellAt = (x: number, y: number, z: number): number => {
    const lx = x - x0,
      ly = y - y0,
      lz = z - z0;
    if (own && lx >= 0 && lx < CHUNK && ly >= 0 && ly < CHUNK && lz >= 0 && lz < CHUNK) return own[lx + CHUNK * (lz + CHUNK * ly)];
    return world.get(x, y, z);
  };
  // AO samples opaque occluders only (fluids cast none).
  const s = (x: number, y: number, z: number): number => {
    const id = cellAt(x, y, z);
    return id !== AIR && !isFluidId(id) ? 1 : 0;
  };
  // Opaque occluder = solid, not a fluid, not a transparent block (glass/ice/leaves/portal).
  const occludes = (x: number, y: number, z: number): boolean => {
    const nid = cellAt(x, y, z);
    return nid !== AIR && !isFluidId(nid) && !TRANSPARENT.has(nid);
  };
  // Surface height of a cell of fluid `f` (1 if submerged/source), or -1 if not that fluid.
  const fluidTop = (x: number, y: number, z: number, f: FluidDef): number => {
    const wid = cellAt(x, y, z);
    if (fluidOf(wid) !== f) return -1;
    return fluidOf(cellAt(x, y + 1, z)) === f ? 1 : 1 - (fluidLevel(f, wid) / 8) * 0.82;
  };

  // Fence / closed gate: a central post plus rails toward each connected neighbour
  // (another fence-shape, a gate, or any opaque solid). Built from axis-aligned boxes;
  // the DoubleSide material means winding is irrelevant. Flat face-shade + the cell's
  // baked light (fence is transparent, so its own cell carries sky/block light).
  const buildFence = (x: number, y: number, z: number, id: number): void => {
    const def = BLOCKS[id] ?? BLOCKS[3];
    const rect = (fam: 'top' | 'side' | 'bottom'): { u0: number; u1: number; vBot: number; vTop: number } => atlas.rect(def.tiles[fam]);
    const csky = light.sky(x, y, z) / MAX_LIGHT;
    const cblk = light.block(x, y, z) / MAX_LIGHT;
    const uv = [[0, 0], [0, 1], [1, 1], [1, 0]];
    const quad = (fam: 'top' | 'side' | 'bottom', cs: number[][]): void => {
      const r = rect(fam);
      const shade = SHADE[fam];
      for (const i of [0, 1, 2, 0, 2, 3]) {
        opq.pos.push(cs[i][0], cs[i][1], cs[i][2]);
        opq.col.push(shade, shade, shade);
        opq.sky.push(csky);
        opq.blk.push(cblk);
        opq.uvs.push(r.u0 + uv[i][0] * (r.u1 - r.u0), r.vBot + uv[i][1] * (r.vTop - r.vBot));
      }
    };
    const box = (ax: number, ay: number, az: number, bx: number, by: number, bz: number): void => {
      quad('top', [[ax, by, az], [bx, by, az], [bx, by, bz], [ax, by, bz]]);
      quad('bottom', [[ax, ay, az], [bx, ay, az], [bx, ay, bz], [ax, ay, bz]]);
      quad('side', [[ax, ay, az], [ax, by, az], [bx, by, az], [bx, ay, az]]);
      quad('side', [[ax, ay, bz], [ax, by, bz], [bx, by, bz], [bx, ay, bz]]);
      quad('side', [[ax, ay, az], [ax, by, az], [ax, by, bz], [ax, ay, bz]]);
      quad('side', [[bx, ay, az], [bx, by, az], [bx, by, bz], [bx, ay, bz]]);
    };
    box(x + 0.375, y, z + 0.375, x + 0.625, y + 1, z + 0.625); // central post
    const conn = (dx: number, dz: number): boolean => {
      const nid = cellAt(x + dx, y, z + dz);
      return FENCE_SHAPE.has(nid) || nid === FENCE_GATE_OPEN || occludes(x + dx, y, z + dz);
    };
    if (conn(1, 0)) { box(x + 0.625, y + 0.3, z + 0.4375, x + 1, y + 0.45, z + 0.5625); box(x + 0.625, y + 0.6, z + 0.4375, x + 1, y + 0.75, z + 0.5625); }
    if (conn(-1, 0)) { box(x, y + 0.3, z + 0.4375, x + 0.375, y + 0.45, z + 0.5625); box(x, y + 0.6, z + 0.4375, x + 0.375, y + 0.75, z + 0.5625); }
    if (conn(0, 1)) { box(x + 0.4375, y + 0.3, z + 0.625, x + 0.5625, y + 0.45, z + 1); box(x + 0.4375, y + 0.6, z + 0.625, x + 0.5625, y + 0.75, z + 1); }
    if (conn(0, -1)) { box(x + 0.4375, y + 0.3, z, x + 0.5625, y + 0.45, z + 0.375); box(x + 0.4375, y + 0.6, z, x + 0.5625, y + 0.75, z + 0.375); }
  };

  for (let x = x0; x < x0 + CHUNK; x++) {
    for (let y = y0; y < y0 + CHUNK; y++) {
      for (let z = z0; z < z0 + CHUNK; z++) {
        const id = cellAt(x, y, z);
        if (id === AIR || RENDER_SKIP.has(id) || MODEL_NODES.has(id)) continue; // air, state-only ids, + glTF node-models (drawn separately) draw no cube
        // Cross-plant: two crossed quads (an "X"), double-sided (material is DoubleSide) with
        // alpha-cutout — a flat plant, not a cube. No neighbour culling / AO.
        if (PLANT.has(id)) {
          const r = atlas.rect((BLOCKS[id] ?? BLOCKS[3]).tiles.side);
          const c = 0.95; // near-full-bright base tint; the light channels dim it in shade/caves
          const psky = light.sky(x, y, z) / MAX_LIGHT;
          const pblk = light.block(x, y, z) / MAX_LIGHT;
          const quads = [
            [[x, y, z], [x + 1, y, z + 1], [x + 1, y + 1, z + 1], [x, y + 1, z]],
            [[x + 1, y, z], [x, y, z + 1], [x, y + 1, z + 1], [x + 1, y + 1, z]],
          ];
          const uv = [[0, 0], [1, 0], [1, 1], [0, 1]];
          for (const quad of quads) {
            for (const i of [0, 1, 2, 0, 2, 3]) {
              opq.pos.push(quad[i][0], quad[i][1], quad[i][2]);
              opq.col.push(c, c, c);
              opq.sky.push(psky);
              opq.blk.push(pblk);
              opq.uvs.push(r.u0 + uv[i][0] * (r.u1 - r.u0), r.vBot + uv[i][1] * (r.vTop - r.vBot));
            }
          }
          continue;
        }
        // Rail: a flat ground quad (not a cube). Luanti-style auto-connecting track —
        // pick the straight/curved/crossing tile + a 90° rotation from the rail neighbours.
        if (id === RAIL_ID) {
          const rail = (dx: number, dz: number): boolean => cellAt(x + dx, y, z + dz) === RAIL_ID;
          const e = rail(1, 0),
            w = rail(-1, 0),
            s = rail(0, 1),
            nn = rail(0, -1);
          const cnt = (e ? 1 : 0) + (w ? 1 : 0) + (s ? 1 : 0) + (nn ? 1 : 0);
          let tile = 'rail';
          let rot = 0; // straight runs along Z (north-south) at rot 0; rot 1 = along X
          if (cnt >= 3) tile = 'rail_crossing';
          else if (cnt === 2 && (e || w) && !(s || nn)) rot = 1; // straight E-W
          else if (cnt === 2 && (s || nn) && !(e || w)) rot = 0; // straight N-S
          else if (cnt === 2) {
            tile = 'rail_curved'; // corner: texture elbow is at N+E (rot 0); r=1→W+N, r=2→W+S, r=3→E+S
            rot = nn && e ? 0 : nn && w ? 1 : s && w ? 2 : 3; // last = s && e
          } else if (e || w) rot = 1; // single neighbour along X → straight E-W
          const r = atlas.rect(tile);
          const c = 0.95;
          const psky = light.sky(x, y, z) / MAX_LIGHT;
          const pblk = light.block(x, y, z) / MAX_LIGHT;
          const yb = y + 0.03;
          const quad = [[x, yb, z], [x + 1, yb, z], [x + 1, yb, z + 1], [x, yb, z + 1]];
          const base = [[0, 0], [1, 0], [1, 1], [0, 1]];
          for (const i of [0, 1, 2, 0, 2, 3]) {
            const u = base[(i + rot) % 4]; // rotate the texture by rot × 90°
            opq.pos.push(quad[i][0], quad[i][1], quad[i][2]);
            opq.col.push(c, c, c);
            opq.sky.push(psky);
            opq.blk.push(pblk);
            opq.uvs.push(r.u0 + u[0] * (r.u1 - r.u0), r.vBot + u[1] * (r.vTop - r.vBot));
          }
          continue;
        }
        // Fence / closed gate: custom post + rails geometry (see buildFence).
        if (FENCE_SHAPE.has(id)) {
          buildFence(x, y, z, id);
          continue;
        }
        const fluid = fluidOf(id); // water/lava def, or null
        const transparent = TRANSPARENT.has(id);
        const def = fluid ? BLOCKS[fluid.source] : BLOCKS[id] ?? BLOCKS[3];
        const buf = fluid ? (fluid === LAVA_FLUID ? lav : wat) : opq;
        // Flowing fluid sits lower by its level; a submerged cell (same fluid above) is full.
        const topY = fluid && fluidOf(cellAt(x, y + 1, z)) !== fluid ? 1 - (fluidLevel(fluid, id) / 8) * 0.82 : 1;
        for (const f of FACES) {
          const [nx, ny, nz] = f.n;
          const nid = cellAt(x + nx, y + ny, z + nz);
          // Cull. Fluid: top hidden under same fluid; bottom shown only vs air; a SIDE is
          // hidden only if the neighbour (same fluid) surface is at least as high (else the
          // step between differing levels shows — no cracks). Transparent: hidden vs same id
          // or behind opaque. Opaque: hidden behind opaque.
          let hidden: boolean;
          if (fluid) {
            if (ny === 1) hidden = fluidOf(nid) === fluid;
            else if (ny === -1) hidden = nid !== AIR;
            else hidden = fluidOf(nid) === fluid ? fluidTop(x + nx, y + ny, z + nz, fluid) >= topY - 0.01 : nid !== AIR;
          } else if (transparent) {
            hidden = nid === id || occludes(x + nx, y + ny, z + nz);
          } else {
            hidden = occludes(x + nx, y + ny, z + nz);
          }
          if (hidden) continue;
          const shade = SHADE[f.fam];
          const r = atlas.rect(def.tiles[f.fam]);
          const inPlane = [0, 1, 2].filter((a) => f.n[a] === 0);
          const cAo: number[] = [];
          for (const q of f.quad) {
            const d1 = [0, 0, 0];
            d1[inPlane[0]] = q[inPlane[0]] === 1 ? 1 : -1;
            const d2 = [0, 0, 0];
            d2[inPlane[1]] = q[inPlane[1]] === 1 ? 1 : -1;
            const ox = x + nx,
              oy = y + ny,
              oz = z + nz;
            const s1 = s(ox + d1[0], oy + d1[1], oz + d1[2]);
            const s2 = s(ox + d2[0], oy + d2[1], oz + d2[2]);
            const sc = s(ox + d1[0] + d2[0], oy + d1[1] + d2[1], oz + d1[2] + d2[2]);
            cAo.push(AO[s1 && s2 ? 0 : 3 - (s1 + s2 + sc)] * shade);
          }
          const q = f.quad;
          const u = f.uv;
          // Light hitting this face = the light of the air cell it faces into (opaque only;
          // fluids don't carry these attributes). Sampled once per face, shared by its 4 verts.
          const fsky = fluid ? 0 : light.sky(x + nx, y + ny, z + nz) / MAX_LIGHT;
          const fblk = fluid ? 0 : light.block(x + nx, y + ny, z + nz) / MAX_LIGHT;
          for (const i of [0, 1, 2, 0, 2, 3]) {
            buf.pos.push(x + q[i][0], y + (q[i][1] === 1 ? topY : q[i][1]), z + q[i][2]);
            const k = cAo[i];
            buf.col.push(k, k, k);
            buf.uvs.push(r.u0 + u[i][0] * (r.u1 - r.u0), r.vBot + u[i][1] * (r.vTop - r.vBot));
            if (!fluid) {
              opq.sky.push(fsky);
              opq.blk.push(fblk);
            }
          }
        }
      }
    }
  }
  const toBuf = (b: { pos: number[]; col: number[]; uvs: number[]; sky?: number[]; blk?: number[] }): LayerBuffers | null => {
    if (b.pos.length === 0) return null;
    const r: LayerBuffers = { pos: new Float32Array(b.pos), col: new Float32Array(b.col), uv: new Float32Array(b.uvs) };
    if (b.sky) r.sky = new Float32Array(b.sky);
    if (b.blk) r.blk = new Float32Array(b.blk);
    return r;
  };
  return { opaque: toBuf(opq), water: toBuf(wat), lava: toBuf(lav) };
}
