#!/usr/bin/env node
/**
 * Convert a 3D model to OUR glTF format via assimp (WASM, no native lib / no upload).
 * Unlike the Blender io_scene_b3d add-on, assimp reads Luanti `.b3d` WITH its baked
 * animation keyframes — so animated mob models come through complete (mesh + skeleton +
 * skinning + animations). It also reads most other formats assimp supports (x, obj, fbx,
 * dae, 3ds, …). This is the same engine many online B3D→glTF converters run under the
 * hood, done locally + scriptably.
 *
 *   node scripts/convert-model-assimp.mjs <input-model> <output.gltf>
 *
 * Writes <output>.gltf + <output>.bin (the game loads it with GLTFLoader like the
 * character model; apply your own unlit MeshBasicMaterial + texture).
 */
import assimpjs from 'assimpjs';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, basename, join } from 'node:path';

const [inp, out] = process.argv.slice(2);
if (!inp || !out) {
  console.error('usage: node scripts/convert-model-assimp.mjs <input-model> <output.gltf>');
  process.exit(1);
}

const ajs = await assimpjs();
const list = new ajs.FileList();
list.AddFile(inp, readFileSync(inp));
const res = ajs.ConvertFileList(list, 'gltf2');
if (!res.IsSuccess()) {
  console.error('assimp conversion failed (code ' + res.GetErrorCode() + ') — unsupported/'  + 'corrupt input?');
  process.exit(2);
}

const dir = dirname(out) || '.';
mkdirSync(dir, { recursive: true });
const base = basename(out).replace(/\.gltf$/i, '');
let wroteGltf = false;
for (let i = 0; i < res.FileCount(); i++) {
  const f = res.GetFile(i);
  const buf = Buffer.from(f.GetContent());
  const p = f.GetPath();
  if (p.endsWith('.gltf')) {
    const g = JSON.parse(buf.toString('utf8'));
    // assimp emits result.gltf / result.bin — point the buffer at OUR .bin name.
    for (const b of g.buffers ?? []) if (b.uri && b.uri.endsWith('.bin')) b.uri = base + '.bin';
    writeFileSync(out, JSON.stringify(g));
    wroteGltf = true;
    console.log(`gltf: meshes ${g.meshes?.length ?? 0} · skins ${g.skins?.length ?? 0} · joints ${g.skins?.[0]?.joints?.length ?? 0} · animations ${g.animations?.length ?? 0}`);
  } else if (p.endsWith('.bin')) {
    writeFileSync(join(dir, base + '.bin'), buf);
  }
}
console.log(wroteGltf ? `OK: wrote ${out}` : 'ERROR: assimp produced no glTF');
process.exit(wroteGltf ? 0 : 3);
