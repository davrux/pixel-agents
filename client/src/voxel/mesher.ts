/**
 * Voxel world → one BufferGeometry. Only air-exposed faces are emitted (face
 * culling). Each face gets the block's atlas UVs (texture) and per-vertex colour
 * = directional face shade × ambient occlusion (baked grey), so the textured,
 * unlit MeshBasicMaterial (map + vertexColors) shows the polished, soft-shadowed
 * Minecraft look. Rebuilt whole on edit; fine for the single spike region.
 */
import * as THREE from 'three';
import { CHUNK, isFluidId, fluidOf, fluidLevel, LAVA_FLUID, type FluidDef } from '@pixel/shared';
import { BLOCKS, SHADE, AIR, TRANSPARENT } from './blocks.js';
import type { Atlas } from './textures.js';
import type { VoxelWorld } from './world.js';

/** Opaque + fluid geometry for one chunk. Water and lava each get their own
 *  transparent/emissive mesh (rendered with different materials). */
export interface ChunkGeom {
  opaque: THREE.BufferGeometry | null;
  water: THREE.BufferGeometry | null;
  lava: THREE.BufferGeometry | null;
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
export function buildChunkMesh(world: VoxelWorld, atlas: Atlas, cx: number, cy: number, cz: number): ChunkGeom {
  const opq = { pos: [] as number[], col: [] as number[], uvs: [] as number[] };
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

  for (let x = x0; x < x0 + CHUNK; x++) {
    for (let y = y0; y < y0 + CHUNK; y++) {
      for (let z = z0; z < z0 + CHUNK; z++) {
        const id = cellAt(x, y, z);
        if (id === AIR) continue;
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
          for (const i of [0, 1, 2, 0, 2, 3]) {
            buf.pos.push(x + q[i][0], y + (q[i][1] === 1 ? topY : q[i][1]), z + q[i][2]);
            const k = cAo[i];
            buf.col.push(k, k, k);
            buf.uvs.push(r.u0 + u[i][0] * (r.u1 - r.u0), r.vBot + u[i][1] * (r.vTop - r.vBot));
          }
        }
      }
    }
  }
  const make = (b: { pos: number[]; col: number[]; uvs: number[] }): THREE.BufferGeometry | null => {
    if (b.pos.length === 0) return null;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(b.pos, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(b.col, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(b.uvs, 2));
    g.computeBoundingSphere();
    return g;
  };
  return { opaque: make(opq), water: make(wat), lava: make(lav) };
}
