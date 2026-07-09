#!/usr/bin/env node
/**
 * Batch-convert every model under a Luanti mods tree to OUR glTF format (via assimp,
 * keeps b3d animations). Writes client/public/models/luanti/<name>/<name>.gltf (+.bin)
 * and a manifest.json. Wiring a model into the renderer is a per-model follow-up.
 *
 *   node scripts/convert-luanti-all.mjs [modsRoot] [outDir]
 *   defaults: modsRoot=/tmp/mtg   outDir=client/public/models/luanti
 */
import assimpjs from 'assimpjs';
import { readFileSync, writeFileSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { join, basename, extname } from 'node:path';

const root = process.argv[2] || '/tmp/mtg';
const outDir = process.argv[3] || 'client/public/models/luanti';
const EXT = new Set(['.b3d', '.x', '.obj', '.dae', '.3ds', '.gltf', '.glb', '.fbx']);

function walk(dir) {
  const out = [];
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    const s = statSync(p);
    if (s.isDirectory()) out.push(...walk(p));
    else if (EXT.has(extname(p).toLowerCase())) out.push(p);
  }
  return out;
}

const models = walk(root).sort();
console.log(`Found ${models.length} model(s) under ${root}`);
const ajs = await assimpjs();
const manifest = [];
for (const inp of models) {
  const base = basename(inp, extname(inp));
  const dir = join(outDir, base);
  const list = new ajs.FileList();
  list.AddFile(inp, readFileSync(inp));
  const res = ajs.ConvertFileList(list, 'gltf2');
  if (!res.IsSuccess()) {
    console.log(`  ✗ ${base} (${extname(inp)}) — ${res.GetErrorCode()}`);
    continue;
  }
  mkdirSync(dir, { recursive: true });
  let meshes = 0,
    anims = 0,
    joints = 0;
  for (let i = 0; i < res.FileCount(); i++) {
    const f = res.GetFile(i);
    const buf = Buffer.from(f.GetContent());
    const p = f.GetPath();
    if (p.endsWith('.gltf')) {
      const g = JSON.parse(buf.toString('utf8'));
      for (const b of g.buffers ?? []) if (b.uri && b.uri.endsWith('.bin')) b.uri = base + '.bin';
      meshes = g.meshes?.length ?? 0;
      anims = g.animations?.length ?? 0;
      joints = g.skins?.[0]?.joints?.length ?? 0;
      writeFileSync(join(dir, base + '.gltf'), JSON.stringify(g));
    } else if (p.endsWith('.bin')) {
      writeFileSync(join(dir, base + '.bin'), buf);
    }
  }
  manifest.push({ name: base, source: inp.replace(root + '/', ''), meshes, joints, animations: anims });
  console.log(`  ✓ ${base}: meshes ${meshes} · joints ${joints} · anims ${anims}`);
}
mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2));
console.log(`\nWrote ${manifest.length} model(s) → ${outDir} (+ manifest.json)`);
