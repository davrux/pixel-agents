# Model converter (→ our glTF format)

The voxel game loads **glTF** (separate `.gltf` + `.bin`, no embedded texture — the game
maps its own skin, see `client/public/models/character/`). This converter turns any model
Blender can read into that format, so there's **one import pipeline for every format**.

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

**Animation caveat:** the `io_scene_b3d` add-on imports **geometry + the skeleton (rest
pose) + skinning**, but NOT the baked animation keyframes — the exported glTF has a
skinned mesh + bones but no `animations`. That's fine for static nodes and for mobs we
animate procedurally (see `mob.ts`); for baked clips you'd need an add-on that reads b3d
`ANIM`/keyframes (the original character clips were sliced from a manual export). The
converter itself already assigns/export any actions it finds, so a better importer drops
straight in.

Note: the "Draco … library could not be found" line on export is harmless — we export
uncompressed on purpose.

## Wiring the result into the game

Drop the `.gltf` + `.bin` under `client/public/models/<name>/` and load it with
`GLTFLoader` (see `client/src/voxel/avatar.ts`). Apply the world's unlit
`MeshBasicMaterial` + your own texture (the export carries geometry + UVs, not our shading).
