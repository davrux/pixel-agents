/**
 * Voxel world → one BufferGeometry. Only air-exposed faces are emitted (face
 * culling). Each face gets the block's atlas UVs (texture) and per-vertex colour
 * = directional face shade × ambient occlusion (baked grey), so the textured,
 * unlit MeshBasicMaterial (map + vertexColors) shows the polished, soft-shadowed
 * Minecraft look. Rebuilt whole on edit; fine for the single spike region.
 */
import * as THREE from 'three';
import { BLOCKS, SHADE } from './blocks.js';
import type { Atlas } from './textures.js';
import type { VoxelWorld } from './world.js';

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

export function buildMesh(world: VoxelWorld, atlas: Atlas): THREE.BufferGeometry {
  const pos: number[] = [];
  const col: number[] = [];
  const uvs: number[] = [];
  const s = (x: number, y: number, z: number): number => (world.solid(x, y, z) ? 1 : 0);

  for (let x = 0; x < world.sx; x++) {
    for (let y = 0; y < world.sy; y++) {
      for (let z = 0; z < world.sz; z++) {
        const id = world.get(x, y, z);
        if (id === 0) continue;
        const def = BLOCKS[id] ?? BLOCKS[3];
        for (const f of FACES) {
          const [nx, ny, nz] = f.n;
          if (world.solid(x + nx, y + ny, z + nz)) continue; // hidden face
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
            pos.push(x + q[i][0], y + q[i][1], z + q[i][2]);
            const k = cAo[i];
            col.push(k, k, k);
            uvs.push(r.u0 + u[i][0] * (r.u1 - r.u0), r.vBot + u[i][1] * (r.vTop - r.vBot));
          }
        }
      }
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  g.computeBoundingSphere();
  return g;
}
