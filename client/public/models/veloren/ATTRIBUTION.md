# Veloren character voxel assets

All `.vox` files here are from **Veloren** (https://gitlab.com/veloren/veloren),
licensed **CC-BY-SA 3.0**. Attribution and share-alike apply.

## What's imported

The full character-relevant voxel tree from `assets/voxygen/voxel/`, mirroring the
original directory layout (so a Veloren dot-path `armor.misc.chest.none` maps to
`armor/misc/chest/none.vox`):

| dir        | contents                                   | .vox |
|------------|--------------------------------------------|------|
| `figure/`  | heads, hair, beards, eyes, accessories     | 359  |
| `armor/`   | all armor sets (chest/pants/belt/foot/hand/shoulder/back/head) | 315 |
| `weapon/`  | weapons (imported; not yet placed in-hand) | 781  |
| `glider/`  | gliders (imported; not yet wired)          | 18   |
| `lantern/` | lanterns (imported; not yet wired)         | 16   |

`manifests/` holds the 12 `humanoid_*_manifest.ron` files (part offsets, armor
maps, hair colours) copied verbatim from Veloren.

## catalog.json

Generated from the manifests by `scripts/gen-veloren-catalog.mjs` (RON → JSON, so
the browser doesn't parse RON). Contains: species (head/hairs/beards/eyes with
combined bone offsets), per-species hair-colour palettes, and every armor slot
(chest/pants/belt/foot/back single + hand/shoulder left/right) with
`{path, offset, color}`. Re-run the script after re-importing assets:

    node scripts/gen-veloren-catalog.mjs

## How it's used

`client/src/voxel/velorenChar.ts` loads catalog.json and assembles a character:
species head/hair/beard/eyes + one piece per armor slot. White "skin-slot" voxels
are recoloured with the head's dominant (skin) colour; grayscale hair with the
species palette; armor with its manifest colour. The skeleton + idle animation are
ported from Veloren (GPL-3.0); see the header of `velorenChar.ts`.
