# Convert a 3D model into OUR runtime format (glTF: separate .gltf + .bin, Y-up, no
# embedded texture — the game maps its own skin, like client/public/models/character).
# Blender is the conversion engine, so ONE pipeline imports every format Blender reads:
#   .obj .gltf .glb .fbx .dae .stl  → glTF
# Luanti's animated mob models are .b3d, which Blender does NOT import out of the box —
# enable a "B3D (.b3d) import" add-on in Blender first (see scripts/README-convert.md),
# then .b3d works through the same command.
#
#   blender --background --python scripts/convert-model.py -- <input> <output.gltf> [texture.png]
import bpy, sys, os

argv = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
if len(argv) < 2:
    print('usage: blender --background --python convert-model.py -- <input> <output.gltf> [texture.png]')
    sys.exit(1)
inp, out = os.path.abspath(argv[0]), os.path.abspath(argv[1])
tex = os.path.abspath(argv[2]) if len(argv) > 2 else None
ext = os.path.splitext(inp)[1].lower()

# Empty the startup scene (default cube/camera/light) WITHOUT a factory reset — a reset
# would disable the user's enabled add-ons (the .b3d/.x importers we rely on).
for _o in list(bpy.data.objects):
    bpy.data.objects.remove(_o, do_unlink=True)

# Import dispatch by extension. .b3d/.x only resolve if an import add-on is enabled.
importers = {
    '.obj': lambda p: bpy.ops.wm.obj_import(filepath=p),
    '.gltf': lambda p: bpy.ops.import_scene.gltf(filepath=p),
    '.glb': lambda p: bpy.ops.import_scene.gltf(filepath=p),
    '.fbx': lambda p: bpy.ops.import_scene.fbx(filepath=p),
    '.dae': lambda p: bpy.ops.wm.collada_import(filepath=p),
    '.stl': lambda p: bpy.ops.wm.stl_import(filepath=p),
    '.b3d': lambda p: bpy.ops.import_scene.blitz3d_b3d(filepath=p),  # needs the B3D add-on
    '.x': lambda p: bpy.ops.import_scene.directx_x(filepath=p),  # needs the DirectX add-on
}
if ext not in importers:
    print(f'ERROR: unsupported format "{ext}". Supported: {", ".join(importers)}')
    sys.exit(2)
try:
    importers[ext](inp)
except AttributeError:
    print(f'ERROR: no importer for "{ext}" — enable the matching Blender add-on (e.g. B3D for .b3d).')
    sys.exit(3)

# Optional texture: one unlit-friendly material (Base Color = image) on every mesh, so
# the export references our own PNG instead of baking materials the game won't use.
if tex and os.path.exists(tex):
    img = bpy.data.images.load(tex)
    mat = bpy.data.materials.new('converted')
    mat.use_nodes = True
    bsdf = mat.node_tree.nodes.get('Principled BSDF')
    node = mat.node_tree.nodes.new('ShaderNodeTexImage')
    node.image = img
    if bsdf:
        mat.node_tree.links.new(bsdf.inputs['Base Color'], node.outputs['Color'])
    for o in bpy.data.objects:
        if o.type == 'MESH':
            o.data.materials.clear()
            o.data.materials.append(mat)

# If the importer produced any animation action, assign it to the armature so glTF
# exports it (some importers leave actions unlinked). Harmless when there are none.
if bpy.data.actions:
    for o in bpy.data.objects:
        if o.type == 'ARMATURE':
            if not o.animation_data:
                o.animation_data_create()
            if not o.animation_data.action:
                o.animation_data.action = bpy.data.actions[0]

os.makedirs(os.path.dirname(out) or '.', exist_ok=True)
bpy.ops.export_scene.gltf(
    filepath=out,
    export_format='GLTF_SEPARATE',  # .gltf + .bin (+ textures if any), like our character model
    export_apply=True,  # apply modifiers
    export_yup=True,
)
meshes = sum(1 for o in bpy.data.objects if o.type == 'MESH')
print(f'OK: wrote {out} ({meshes} mesh object(s))')
