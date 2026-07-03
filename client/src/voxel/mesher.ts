/**
 * Voxel world → one BufferGeometry. Only air-exposed faces are emitted (face
 * culling). Each face gets the block's atlas UVs (texture) and per-vertex colour
 * = directional face shade × ambient occlusion (baked grey), so the textured,
 * unlit MeshBasicMaterial (map + vertexColors) shows the polished, soft-shadowed
 * Minecraft look. Rebuilt whole on edit; fine for the single spike region.
 */
import * as THREE from 'three';
import { CHUNK, isWaterId, waterLevel } from '@pixel/shared';
import { BLOCKS, SHADE, AIR, WATER_ID, TRANSPARENT } from './blocks.js';
import type { Atlas } from './textures.js';
import type { VoxelWorld } from './world.js';

/** Opaque + water geometry for one chunk (water goes to a separate transparent mesh). */
export interface ChunkGeom {
  opaque: THREE.BufferGeometry | null;
  water: THREE.BufferGeometry | null;
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
  // AO samples opaque occluders only (water casts none).
  const s = (x: number, y: number, z: number): number => (world.solid(x, y, z) ? 1 : 0);
  // Opaque occluder = solid, not water, not a transparent block (glass/ice/leaves/portal).
  const occludes = (x: number, y: number, z: number): boolean => {
    const nid = world.get(x, y, z);
    return nid !== AIR && !isWaterId(nid) && !TRANSPARENT.has(nid);
  };
  const x0 = cx * CHUNK,
    y0 = cy * CHUNK,
    z0 = cz * CHUNK;

  for (let x = x0; x < x0 + CHUNK; x++) {
    for (let y = y0; y < y0 + CHUNK; y++) {
      for (let z = z0; z < z0 + CHUNK; z++) {
        const id = world.get(x, y, z);
        if (id === AIR) continue;
        const isWater = isWaterId(id);
        const transparent = TRANSPARENT.has(id);
        const def = isWater ? BLOCKS[WATER_ID] : BLOCKS[id] ?? BLOCKS[3];
        const buf = isWater ? wat : opq;
        // Flowing water sits lower by its level; a submerged cell (water above) is full.
        const topY = isWater && !isWaterId(world.get(x, y + 1, z)) ? 1 - (waterLevel(id) / 8) * 0.82 : 1;
        for (const f of FACES) {
          const [nx, ny, nz] = f.n;
          const nid = world.get(x + nx, y + ny, z + nz);
          // Cull: water shows only air-exposed faces; a transparent block hides only
          // against the same id or behind opaque (so a glass pane doesn't blank the
          // block it sits on); opaque hides only behind another opaque block.
          const hidden = isWater ? nid !== AIR : transparent ? nid === id || occludes(x + nx, y + ny, z + nz) : occludes(x + nx, y + ny, z + nz);
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
  return { opaque: make(opq), water: make(wat) };
}
