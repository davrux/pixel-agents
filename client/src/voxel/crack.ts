/**
 * Procedural block-break crack overlay. We don't ship a crack asset, so the
 * stages are drawn at runtime: N progressively-cracked transparent textures
 * (dark jagged lines growing from the centre outwards). Stage 0 = first hairline,
 * last = shattered. NearestFilter keeps them pixelly to match the blocks.
 */
import * as THREE from 'three';

export function makeCrackStages(count = 6, size = 16): THREE.CanvasTexture[] {
  // deterministic PRNG so cracks look identical across runs/reloads
  let seed = 1337;
  const rnd = (): number => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  const cx = size / 2,
    cy = size / 2;
  const segs: { x0: number; y0: number; x1: number; y1: number }[] = [];
  const stages: THREE.CanvasTexture[] = [];
  for (let i = 0; i < count; i++) {
    // grow a few jagged branches from near the centre each stage
    for (let b = 0; b < 3; b++) {
      let x = cx + (rnd() - 0.5) * 4,
        y = cy + (rnd() - 0.5) * 4;
      let ang = rnd() * Math.PI * 2;
      const steps = 3 + Math.floor(rnd() * 3);
      for (let s = 0; s < steps; s++) {
        ang += (rnd() - 0.5) * 1.4;
        const nx = x + Math.cos(ang) * (2 + rnd() * 2);
        const ny = y + Math.sin(ang) * (2 + rnd() * 2);
        segs.push({ x0: x, y0: y, x1: nx, y1: ny });
        x = nx;
        y = ny;
      }
    }
    const cv = document.createElement('canvas');
    cv.width = cv.height = size;
    const ctx = cv.getContext('2d')!;
    ctx.lineCap = 'round';
    for (const s of segs) {
      // dark core with a lighter halo so cracks read on any block colour
      ctx.strokeStyle = 'rgba(255,255,255,0.5)';
      ctx.lineWidth = 2.2;
      ctx.beginPath();
      ctx.moveTo(s.x0, s.y0);
      ctx.lineTo(s.x1, s.y1);
      ctx.stroke();
      ctx.strokeStyle = 'rgba(0,0,0,0.85)';
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      ctx.moveTo(s.x0, s.y0);
      ctx.lineTo(s.x1, s.y1);
      ctx.stroke();
    }
    const tex = new THREE.CanvasTexture(cv);
    tex.magFilter = THREE.NearestFilter;
    tex.minFilter = THREE.NearestFilter;
    tex.generateMipmaps = false;
    stages.push(tex);
  }
  return stages;
}
