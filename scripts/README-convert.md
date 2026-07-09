# Model converter (→ our glTF format)

The voxel game loads **glTF** (separate `.gltf` + `.bin`, no embedded texture — the game
maps its own skin, see `client/public/models/character/`). Two converters:

## Recommended: assimp (handles Luanti `.b3d` WITH animations)

`scripts/convert-model-assimp.mjs` uses **assimp** (via the `assimpjs` WASM package — no
native lib, no upload to any online service). assimp reads `.b3d` including its baked
animation keyframes, so animated mob/character models come through complete:

```sh
node scripts/convert-model-assimp.mjs <input-model> client/public/models/<name>/<name>.gltf
```

Verified: Luanti `character.b3d` → glTF with a skinned mesh (6 joints, JOINTS_0/WEIGHTS_0)
**and its animation**. Supports most formats assimp reads (b3d, x, obj, fbx, dae, 3ds, …).
This is the same engine online B3D→glTF converters run under the hood — done locally.

## Alternative: Blender

`scripts/convert-model.py` turns any model Blender can read into glTF (one pipeline for
every format Blender imports).

## Usage

```sh
blender --background --python scripts/convert-model.py -- <input> <output.gltf> [texture.png]
```

Example (a Luanti node model → glTF):

```sh
blender --background --python scripts/convert-model.py -- \
  /path/minetest_game/mods/boats/models/boats_boat.obj \
  client/public/models/boat/boat.gltf
```

Output: `boat.gltf` + `boat.bin`, valid glTF 2.0 — loads with three's `GLTFLoader` exactly
like the character model.

## Supported source formats

Natively (no setup): **`.obj` `.gltf` `.glb` `.fbx` `.dae` `.stl`**. Most Luanti *node*
models (torches, chests, doors, boats, fence gates, …) are `.obj` → work immediately.

## Luanti mob models (`.b3d`)

Luanti's animated creatures (mobs_animal etc.) and the player use **`.b3d`** (Blitz3D),
which Blender does **not** import out of the box. Enable a B3D import add-on once, then
`.b3d` (and `.x`) go through the same command:

1. Get a Blender **"B3D (.b3d) import"** add-on (e.g. the community `io_scene_b3d`).
2. Blender ▸ Edit ▸ Preferences ▸ Add-ons ▸ Install… ▸ pick the add-on ▸ enable it.
   (Headless: drop it in the Blender add-ons dir and `bpy.ops.preferences.addon_enable`.)
3. Re-run the command on the `.b3d`; `convert-model.py` already dispatches to the
   `import_scene.blitz3d_b3d` / `import_scene.directx_x` operators the add-ons register.

The player character in `client/public/models/character/` was produced this way (b3d →
glTF), so mob models convert the same way with the add-on present.

**Animation caveat (Blender path only):** the `io_scene_b3d` add-on imports geometry +
skeleton (rest pose) + skinning, but NOT the baked animation keyframes. **For animated
b3d, use the assimp converter above instead** — it reads the keyframes. (This Blender
path is still fine for static models or when you prefer Blender.)

Note: the "Draco … library could not be found" line on export is harmless — we export
uncompressed on purpose.

## Wiring the result into the game

Drop the `.gltf` + `.bin` under `client/public/models/<name>/` and load it with
`GLTFLoader` (see `client/src/voxel/avatar.ts`). Apply the world's unlit
`MeshBasicMaterial` + your own texture (the export carries geometry + UVs, not our shading).
