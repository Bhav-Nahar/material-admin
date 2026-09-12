"""
render_room.py — the PDP media pack, rendered in Blender's Cycles.

Runs INSIDE Blender's own Python, never the project venv:

    blender -b scene.blend -P render_room.py -- --payload job.json
    blender -b -P render_room.py -- --bootstrap templates/greybox_kitchen.blend

WHY A RENDERER AT ALL, when roomwarp.py already matches the benchmark

Four things a planar homography cannot do, and this is all four of them:

  1. Real light transport. roomwarp's gloss pass is a per-column vertical smear of the
     photo — a trick that works because floors mostly reflect what stands on them.
     The `sheen_grazing` shot is not available to that trick at any quality.
  2. Real metric scale. `across: 6` is a number a human guesses per photograph. Here
     1200 x 600 mm with a 3 mm joint is 1.2 x 0.6 with 0.003 between, and the camera
     works out the rest. A tiler can measure this render and be right.
  3. Chamfers. A 1.5 mm bevel catching a grazing highlight is geometry, not shading.
  4. Three cameras off one setup, instead of three photographed plates each needing
     its corners marked by hand.

THE FLOOR IS REAL GEOMETRY, NOT A SHADER

The obvious build is a shader node group: one plane, grout drawn by a procedural grid,
chamfers faked into a bump map. That is what a texture artist does when they cannot
change the mesh, and it is the wrong tool when you can. A 6 x 6 m floor in 1200 x 600
slabs is FIFTY TILES. Fifty boxes is nothing to Cycles, and building them for real
buys, for less code than the node group would have taken:

  - grout depth that is actually depth, so it occludes and catches shadow
  - a chamfer from an actual Bevel modifier, which is correct at every angle
  - stagger patterns as one `+=` in a loop instead of a coordinate transform
  - per-tile UV rotation, the trick that stops fifty identical bitmaps reading as
    wallpaper, as four lines instead of a hash-per-cell in shader nodes

ponytail: no Geometry Nodes tree. Building one from Python is ~150 lines of node
wiring to make fifty boxes parametric at a level nothing re-evaluates at runtime — the
whole scene is rebuilt per job anyway. A plain loop is the shortest thing that works.

THE SWATCH ARRIVES PREPARED. blenderRoom.js insets its outer 1.5% and resizes it,
because a rectified swatch is only as tight as the quad someone clicked and a sliver
of studio backdrop along one edge lands in the grout of every joint on the floor. That
lives in Node because sharp is already there, and it is deliberately NOT repeated
here — but it does mean a hand-run `--payload` with a raw swatch will show the tan
joint this pipeline exists to have fixed. Prepare it, or expect that.

CONTRACT
  payload JSON, all lengths in millimetres unless the name says otherwise:
    { swatch, out_dir, width_mm, height_mm, grout_mm, grout_color, finish,
      pattern, shots, resolution, samples, thickness_mm, seed, view_transform }
  writes  <out_dir>/<shot>.png, plus <out_dir>/result.json describing what it did
"""

import json
import math
import os
import random
import sys

import bpy
import bmesh
from mathutils import Vector

# ── the finish table ─────────────────────────────────────────────────────────────
# Roughness values carried over from studio3d.js, which calibrated them against the
# benchmark's hero shot rather than choosing them. Coat is this file's own addition:
# a glazed tile is a rough body under a thin clear layer, and one roughness number
# cannot say that. It is the difference between polished porcelain and matte stone
# that survives being photographed.
FINISH_PRESETS = {
    'matte':         {'roughness': 0.62, 'coat': 0.00, 'coat_roughness': 0.00, 'bump': 1.0},
    'carving matte': {'roughness': 0.58, 'coat': 0.00, 'coat_roughness': 0.00, 'bump': 1.4},
    'glue matte':    {'roughness': 0.62, 'coat': 0.00, 'coat_roughness': 0.00, 'bump': 1.0},
    'texture':       {'roughness': 0.66, 'coat': 0.00, 'coat_roughness': 0.00, 'bump': 1.3},
    'suede':         {'roughness': 0.55, 'coat': 0.05, 'coat_roughness': 0.30, 'bump': 1.1},
    'satin':         {'roughness': 0.40, 'coat': 0.10, 'coat_roughness': 0.20, 'bump': 0.9},
    'glossy':        {'roughness': 0.20, 'coat': 0.80, 'coat_roughness': 0.08, 'bump': 0.7},
    'high gloss':    {'roughness': 0.08, 'coat': 1.00, 'coat_roughness': 0.03, 'bump': 0.5},
    'polished':      {'roughness': 0.08, 'coat': 1.00, 'coat_roughness': 0.02, 'bump': 0.5},
}
DEFAULT_FINISH = 'matte'

# ── the look, per shot ──────────────────────────────────────────────────────────
# studio3d.js measured that a film curve flattens tile texture and settled on no
# tone mapping at all. That finding is real but its scope is a STUDIO shot: lights
# under control and no light source in frame.
#
# Two of these three shots have a window in frame, and 'Standard' has no highlight
# latitude whatever — measured on the first pack, the sill and about a third of the
# grazing frame clipped to pure white and took the tile with them. AgX rolls that
# off and keeps the glaze readable, which is the entire subject of that shot.
#
# macro_detail keeps Standard: nothing bright is in frame, and there the texture
# contrast studio3d.js was protecting is the whole point.
SHOT_LOOK = {
    'hero_wide':     ('AgX', 0.2),
    'sheen_grazing': ('AgX', -0.3),
    'macro_detail':  ('Standard', 0.0),
}
DEFAULT_LOOK = ('AgX', 0.0)

# Bump strength before the finish's multiplier. Deliberately small: the height map is
# a luminance read of a PHOTOGRAPH, so it treats dark pigment as depth — a charcoal
# vein in white marble becomes a groove. That is right for stone and wood grain and
# wrong for a dark printed pattern, and the only defence is to keep the amplitude
# below where the error becomes visible. Anything above ~0.2 starts looking embossed.
BUMP_BASE = 0.11

# A 600 mm tile has a 2 mm chamfer. The first thing that reads as computer-generated
# is a tile edge that stops dead, and the second is one bevelled like a snooker table.
CHAMFER_MM = 1.5
CHAMFER_SEGMENTS = 3

# How far the grout sits below the tile face.
#
# 1.2 mm was the first guess and it is too deep to light. On a 3 mm joint that is a
# channel deeper than a third of its width, and with a 1.5 mm chamfer either side
# almost no light reaches the bottom — measured on a real kitchen, every joint came
# out near-black while the benchmark's are thin, light and easy to miss.
#
# Modern large-format rectified porcelain is grouted very nearly flush. 0.5 mm keeps
# the occlusion gradient that makes the joint read as a recess rather than a painted
# line, without turning it into a slot.
GROUT_DROP_MM = 0.5
# Only used when nothing better is known; blenderRoom.js normally derives this.
GROUT_FALLBACK = '#3A3A3A'

# What the macro shot actually frames, in metres across.
#
# The brief said "4 intersecting tiles", and for large-format slabs that is not
# geometrically available: two 1200 mm tiles is 2.4 m across, and a 100 mm lens on a
# 36 mm sensor needs 2.4 * 100/36 = 6.7 m of distance to frame it. Inside a 2.7 m room
# there is no such distance, and the first attempt put the camera at z = 3.2 m — above
# the ceiling, rendering the world background.
#
# A macro detail shot is not about whole tiles anyway. It exists to prove joint depth,
# chamfer and texture resolution, and all three of those live at the INTERSECTION. So
# frame a fixed 420 mm — a hand's width of tile either side of one joint — which is
# both what the shot is for and reachable in any room.
MACRO_FRAME_M = 0.42
SENSOR_MM = 36.0
# Nothing gets closer to a ceiling than this, so a camera cannot end up above one.
CEILING_CLEARANCE_M = 0.25

# How thick a slice of z counts as one floor level, and how big a footprint an object
# needs before its polygons are worth transforming.
FLOOR_BAND_M = 0.06
MIN_FLOOR_M2 = 2.0

# How far below the camera the floor it stands on can be. A standing eye is ~1.6 m; an
# architectural camera is often higher, and a lobby shot higher still.
EYE_MIN_M = 0.6
EYE_MAX_M = 4.5

# How far in front of a level or upward-tilted camera to assume it cares about.
VIEW_AHEAD_M = 3.5
# How far back the grazing camera stands from its subject. A fraction of the room's
# span is wrong once the room is big: 40% of 17 m is another room entirely.
GRAZE_STANDOFF_M = 2.4
# Camera height and how far ahead it looks, which together set the depression angle.
#
# The first pair (0.32 m looking 1.7 m ahead) is 10 degrees below horizontal, and a
# 50 mm lens on a square frame reaches 20 degrees above its own axis — so the top two
# thirds of the frame was the BACKSPLASH. Measured on a real kitchen: the shot that
# exists to prove the floor's finish contained mostly wall.
#
# 0.45 m looking 1.0 m ahead is 24 degrees down, which puts the horizon 4 degrees
# outside the top of frame. All floor, at a genuinely grazing incidence.
GRAZE_HEIGHT_M = 0.45
GRAZE_LOOK_AHEAD_M = 1.0

# Names this script owns. Anything it created on a previous run is deleted before it
# builds again, so re-rendering into a purchased scene cannot accumulate floors.
OWNED = 'MD_'
FLOOR_TARGET = 'Floor_Target'

DEFAULTS = {
    'width_mm': 600,
    'height_mm': 600,
    'thickness_mm': 10,
    'grout_mm': 3,
    'grout_color': None,
    'finish': DEFAULT_FINISH,
    'pattern': 'straight',
    'resolution': 2048,
    'samples': 200,
    'seed': 7,
    'device': 'auto',
    # Multiplier on the scene's world lighting. Only reaches a room with an opening.
    'ambient': 1.0,
    # Multiplier on the scene's own lamps and emissive materials. THIS is the one that
    # works on a sealed interior. 1.0 leaves the artist's scene alone.
    'lighting': 1.0,
    # 'scene' uses the camera the .blend came with; 'auto' uses the computed rig.
    'hero': 'scene',
    # studio3d.js measured this on the benchmark: a film curve (ACES there, AgX here)
    # rolls off highlights and flattens the exact texture the image exists to sell.
    # 'Standard' keeps texture contrast; exposure is what controls brightness.
    # No global view transform, because the three shots do not want the same one.
    # See SHOT_LOOK. A payload may still override both for every shot at once.
    'view_transform': None,
    'exposure': None,
    'shots': ['hero_wide', 'sheen_grazing', 'macro_detail'],
}


def log(msg):
    """Blender's stdout is noisy; a prefix makes this script's lines greppable."""
    print(f'[render_room] {msg}', flush=True)


# ── Principled BSDF socket names ────────────────────────────────────────────────
# Blender 4.0 RENAMED half of them. 'Clearcoat' became 'Coat Weight', 'Specular'
# became 'Specular IOR Level', 'Transmission' became 'Transmission Weight'. Any script
# that hardcodes the 3.x names raises KeyError on every material it touches, and one
# that hardcodes the 4.x names will do the same on 5.0. So: ask for a role, try the
# names that role has had, and skip the socket if this Blender has none of them.
SOCKET_ALIASES = {
    'base_color': ('Base Color',),
    'roughness': ('Roughness',),
    'metallic': ('Metallic',),
    'ior': ('IOR',),
    'coat': ('Coat Weight', 'Clearcoat'),
    'coat_roughness': ('Coat Roughness', 'Clearcoat Roughness'),
    'normal': ('Normal',),
}


def nodes_of(datablock):
    """
    The node tree, without touching `use_nodes`.

    5.x deprecates the flag and 6.0 removes it: node trees are simply always there.
    Setting it still works today and warns, so ask for the tree and only reach for the
    flag on a Blender old enough not to have made one.
    """
    if getattr(datablock, 'node_tree', None) is None:
        datablock.use_nodes = True
    return datablock.node_tree


def socket(node, role):
    for name in SOCKET_ALIASES[role]:
        if name in node.inputs:
            return node.inputs[name]
    log(f'no socket for {role!r} on this Blender ({bpy.app.version_string}) — skipped')
    return None


def put(node, role, value):
    s = socket(node, role)
    if s is not None:
        s.default_value = value
    return s


def hex_rgb(value, fallback=(0.23, 0.23, 0.23)):
    """'#3A3A3A' -> linear RGB. sRGB in, linear out, because Cycles works in linear."""
    try:
        h = str(value).lstrip('#')
        srgb = [int(h[i:i + 2], 16) / 255.0 for i in (0, 2, 4)]
    except (ValueError, IndexError, TypeError):
        srgb = list(fallback)
    # The standard sRGB EOTF. Skipping it is why hand-picked greys come out milky.
    return tuple(c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4 for c in srgb)


# ── device selection ────────────────────────────────────────────────────────────
def enable_device(scene, want='auto'):
    """
    Cycles on whatever this machine has. Returns a human-readable device name for the
    response, because "why is this slow" is answered by that string more often than
    by anything else in the payload.

    METAL before CUDA before OPTIX is not a preference order, it is a platform order:
    only one of them will report devices on any given box — a Blender built for macOS
    reports its enum as ('NONE', 'METAL') and raises TypeError on the rest, which is
    what the try/except is reading.

    `want='cpu'` is not just a fallback, it is a DIAGNOSTIC. GPU compositing failures
    on a headless box are silent hangs rather than errors, and the only cheap way to
    tell "the scene is wrong" from "the GPU is unavailable" is to render the same
    frame on the CPU and see which one moves.
    """
    if str(want).lower() == 'cpu':
        scene.cycles.device = 'CPU'
        return 'CPU (forced)'

    prefs = bpy.context.preferences.addons.get('cycles')
    if prefs is None:
        scene.cycles.device = 'CPU'
        return 'CPU (no cycles addon prefs)'
    cprefs = prefs.preferences

    for backend in ('METAL', 'OPTIX', 'CUDA', 'HIP', 'ONEAPI'):
        try:
            cprefs.compute_device_type = backend
        except TypeError:
            continue  # this build was not compiled with that backend
        cprefs.get_devices()
        gpus = [d for d in cprefs.devices if d.type == backend]
        if not gpus:
            continue
        for d in cprefs.devices:
            # CPU stays on alongside the GPU: Cycles splits tiles across both, and on
            # an M-series the CPU is not the slow half.
            d.use = d.type in (backend, 'CPU')
        scene.cycles.device = 'GPU'
        names = ', '.join(d.name for d in gpus)
        return f'{names} ({backend.title()})'

    scene.cycles.device = 'CPU'
    return 'CPU'


# ── the tiled floor, as geometry ────────────────────────────────────────────────
def clear_owned():
    """Delete everything a previous run of this script made. Idempotent by name."""
    for coll in (bpy.data.objects, bpy.data.meshes, bpy.data.materials, bpy.data.cameras):
        for item in [i for i in coll if i.name.startswith(OWNED)]:
            coll.remove(item)


def floor_faces():
    """
    The floor as FACES, not as an object.

    Object-level detection was the first cut and it does not survive contact with a
    real purchased scene. Measured on one: a 382 MB kitchen whose entire room shell —
    floor, four walls and ceiling — is a single six-faced `Cube`. There is no floor
    object to find, and the "largest roughly-horizontal mesh" fallback rejected the
    shell for being 3.63 m tall and settled on `Cylinder.096`, a 1.02 x 0.59 m disc
    at z=1.10. A pan lid. It would have rendered a tiled pan lid and reported success.

    Asking the artist to split the floor into its own object is real modelling work on
    a file someone paid for. Faces need no such favour: an upward-facing polygon at
    the bottom of the scene IS the floor, whatever object it happens to belong to.

    Only objects that reach the scene's floor level and have a real footprint are
    scanned, because the alternative is transforming 600,000 polygons in Python to
    look at six of them.
    """
    meshes = [ob for ob in bpy.data.objects
              if ob.type == 'MESH' and not ob.name.startswith(OWNED) and ob.visible_get()]
    if not meshes:
        return None

    # Every upward-facing polygon in the scene, bucketed by height. One pass, then the
    # question "which of these is the floor" is answered on 20 numbers instead of
    # 600,000 polygons.
    levels = {}
    for ob in meshes:
        bb = [ob.matrix_world @ Vector(c) for c in ob.bound_box]
        footprint = ((max(v.x for v in bb) - min(v.x for v in bb))
                     * (max(v.y for v in bb) - min(v.y for v in bb)))
        if footprint < MIN_FLOOR_M2:
            continue
        mw = ob.matrix_world
        rot = mw.to_3x3()
        verts = ob.data.vertices
        for poly in ob.data.polygons:
            if (rot @ poly.normal).normalized().z < 0.9:
                continue
            pts = [mw @ verts[i].co for i in poly.vertices]
            xs = [p.x for p in pts]
            ys = [p.y for p in pts]
            # Shoelace on the XY projection — poly.area is LOCAL, and a scaled object
            # reports it wrong. That is how a 127 m2 floor once measured 10.87.
            area = abs(sum(xs[i] * ys[(i + 1) % len(xs)] - xs[(i + 1) % len(xs)] * ys[i]
                           for i in range(len(xs)))) / 2.0
            key = round(sum(p.z for p in pts) / len(pts) / FLOOR_BAND_M)
            box, tot, owners = levels.get(key, (None, 0.0, set()))
            here = (min(xs), min(ys), max(xs), max(ys))
            box = here if box is None else (min(box[0], here[0]), min(box[1], here[1]),
                                            max(box[2], here[2]), max(box[3], here[3]))
            owners.add(ob.name)
            levels[key] = (box, tot + area, owners)

    if not levels:
        return None

    # WHICH LEVEL IS THE FLOOR — and "the lowest one" is wrong.
    #
    # That was the first rule and it works only on a single-storey scene. Measured on
    # a hotel .blend: 107 m long, z from -26.69 to 18.41, and the three largest
    # horizontal surfaces in it are a 578 m2 box lid, a 554 m2 ROOF and the ceiling of
    # the storey below. The lowest point was 23 m under the room being photographed,
    # and the detector found no floor at all.
    #
    # The camera settles it. Whoever framed the scene was standing on the floor that
    # matters, so the floor is the largest upward surface a plausible eye height below
    # the camera. Failing a camera — the grey box builds its own — the lowest level is
    # the right guess again.
    cam = scene_camera()
    if cam is not None:
        eye = cam.matrix_world.translation.z
        band = [k for k in levels
                if EYE_MIN_M <= eye - k * FLOOR_BAND_M <= EYE_MAX_M]
        if band:
            key = max(band, key=lambda k: levels[k][1])
        else:
            # The camera is nowhere near any surface: take the biggest below it.
            below = [k for k in levels if k * FLOOR_BAND_M < eye]
            key = max(below or levels, key=lambda k: levels[k][1])
    else:
        key = min(levels)

    box, total, owners = levels[key]
    return (*box, key * FLOOR_BAND_M, total, sorted(owners))


def floor_extent():
    """
    Where the floor is, in world metres: (min_x, min_y, max_x, max_y, z).

    Floor_Target still wins when it exists — it is unambiguous and it lets someone
    override a bad guess. Everything else goes through floor_faces().
    """
    target = bpy.data.objects.get(FLOOR_TARGET)
    if target is not None:
        bb = [target.matrix_world @ Vector(c) for c in target.bound_box]
        xs = [v.x for v in bb]
        ys = [v.y for v in bb]
        zs = [v.z for v in bb]
        log(f'floor from {FLOOR_TARGET}: {max(xs) - min(xs):.2f} x {max(ys) - min(ys):.2f} m')
        # Hide it: a named target is a surface the tiles REPLACE, and two coplanar
        # surfaces is z-fighting plus a doubled shadow.
        target.hide_render = True
        target.hide_viewport = True
        return min(xs), min(ys), max(xs), max(ys), max(zs)

    hit = floor_faces()
    if hit is None:
        log('no floor found — using a default 6 x 6 m at z=0')
        return -3.0, -3.0, 3.0, 3.0, 0.0

    x0, y0, x1, y1, z, area, owners = hit
    log(f'floor from faces on {", ".join(owners[:3])}'
        f'{" +%d more" % (len(owners) - 3) if len(owners) > 3 else ""}: '
        f'{x1 - x0:.2f} x {y1 - y0:.2f} m, {area:.1f} m2 of it, at z={z:.2f}')
    # NOTHING IS HIDDEN here, deliberately. The tiles sit at z..z+thickness, ABOVE the
    # floor they cover, so there is no coplanar surface to fight — and hiding the face
    # would mean hiding the whole room shell it belongs to.
    return x0, y0, x1, y1, z


# A ceiling is above head height. Anything lower is furniture, and the first version
# of room_height took the lowest object over 1 m — which on a real kitchen was a
# 1.06 m countertop, reported as the ceiling, with the whole camera rig placed off it.
HEAD_HEIGHT_M = 1.9


def room_height(floor_z):
    """
    Floor to ceiling, in metres.

    Found the same way as the floor and for the same reason: by FACES. A ceiling is a
    downward-facing polygon above head height, and the lowest one of those is the one
    you would hit. Object bounding boxes cannot answer this — in a scene whose room
    shell is a single box, the floor and the ceiling are the same object.
    """
    lowest = None
    for ob in bpy.data.objects:
        if ob.type != 'MESH' or ob.name.startswith(OWNED) or not ob.visible_get():
            continue
        bb = [ob.matrix_world @ Vector(c) for c in ob.bound_box]
        if max(v.z for v in bb) < floor_z + HEAD_HEIGHT_M:
            continue  # nothing in this object is high enough to be a ceiling
        footprint = ((max(v.x for v in bb) - min(v.x for v in bb))
                     * (max(v.y for v in bb) - min(v.y for v in bb)))
        if footprint < MIN_FLOOR_M2:
            continue

        mw = ob.matrix_world
        rot = mw.to_3x3()
        verts = ob.data.vertices
        for poly in ob.data.polygons:
            if (rot @ poly.normal).normalized().z > -0.9:
                continue
            z = (mw @ poly.center).z
            if z < floor_z + HEAD_HEIGHT_M:
                continue
            lowest = z if lowest is None else min(lowest, z)

    return (lowest if lowest is not None else floor_z + 2.6) - floor_z


def tile_origins(pattern, x0, y0, x1, y1, tw, th, gap):
    """
    Where every tile goes. Yields (x, y, w, h) in metres, over-covering the floor
    rectangle so the clip at the walls is a cut tile rather than a gap — which is what
    a real install does.

    Stagger is one addition to x. That is the entire reason to build geometry instead
    of a shader: in a node group this is a coordinate transform with a per-cell hash,
    and here it is a modulo.
    """
    pitch_x, pitch_y = tw + gap, th + gap
    # One extra row and column each way: a stagger offset pushes tiles off the edge,
    # and a floor that stops short of the wall is worse than one that runs under it.
    cols = int(math.ceil((x1 - x0) / pitch_x)) + 2
    rows = int(math.ceil((y1 - y0) / pitch_y)) + 2

    offsets = {
        'straight': lambda r: 0.0,
        'stagger_half': lambda r: (r % 2) * pitch_x / 2.0,
        'stagger_third': lambda r: (r % 3) * pitch_x / 3.0,
    }
    if pattern not in offsets:
        raise ValueError(
            f'unknown pattern {pattern!r}. This build lays straight, stagger_half and '
            'stagger_third. Herringbone is deliberately not here: it interlocks only '
            'at a 2:1 plank ratio and needs its own lattice, and since the floor is '
            'real geometry it is a per-tile rotation to add when a plank SKU needs it.'
        )
    shift = offsets[pattern]

    for r in range(rows):
        y = y0 - pitch_y + r * pitch_y
        ox = shift(r)
        for c in range(cols):
            yield x0 - pitch_x + c * pitch_x + ox, y, tw, th


def build_floor(spec, extent, mat_tile, mat_grout, near=None):
    """
    Fifty-odd boxes with per-tile UVs, joined into one mesh, bevelled once.

    PER-TILE UV ROTATION IS NOT A FLOURISH. roomwarp.py learned this the hard way: one
    identical bitmap repeated in a grid is the single clearest tell that a floor was
    not photographed, because a real install turns tiles as it goes and no two fired
    tiles are quite the same. Seeded, so the same SKU lays the same floor every time —
    an image that changes on re-render is a cache and a diffing problem.
    """
    x0, y0, x1, y1, z = extent
    tw = spec['width_mm'] / 1000.0
    th = spec['height_mm'] / 1000.0
    gap = spec['grout_mm'] / 1000.0
    thick = spec['thickness_mm'] / 1000.0
    rng = random.Random(spec['seed'])

    bm = bmesh.new()
    uv_layer = bm.loops.layers.uv.new('UVMap')
    count = 0
    # The joint the macro camera will frame: the tile corner nearest the floor's
    # centre. Aiming at the centre itself lands mid-tile as often as not, and a macro
    # shot of the middle of a slab proves nothing.
    #
    # On a stagger pattern this is a T-junction, not a cross, because A STAGGERED FLOOR
    # HAS NO FOUR-TILE CROSSINGS — that is what stagger means. Framing the junction the
    # floor actually has is the honest shot.
    cx0, cy0 = near if near else ((x0 + x1) / 2.0, (y0 + y1) / 2.0)
    joint, joint_d = (cx0, cy0), float('inf')

    for tx, ty, w, h in tile_origins(spec['pattern'], x0, y0, x1, y1, tw, th, gap):
        corner = (tx + w + gap / 2.0, ty + h + gap / 2.0)
        d = (corner[0] - cx0) ** 2 + (corner[1] - cy0) ** 2
        if d < joint_d:
            joint, joint_d = corner, d
        # A box, not a plane: the chamfer needs a side to run into, and the tile needs
        # a thickness for the grout channel to be a channel.
        verts_top = [
            bm.verts.new((tx, ty, z + thick)),
            bm.verts.new((tx + w, ty, z + thick)),
            bm.verts.new((tx + w, ty + h, z + thick)),
            bm.verts.new((tx, ty + h, z + thick)),
        ]
        verts_bot = [
            bm.verts.new((tx, ty, z)),
            bm.verts.new((tx + w, ty, z)),
            bm.verts.new((tx + w, ty + h, z)),
            bm.verts.new((tx, ty + h, z)),
        ]
        top = bm.faces.new(verts_top)
        bm.faces.new(list(reversed(verts_bot)))
        for i in range(4):
            j = (i + 1) % 4
            bm.faces.new((verts_top[i], verts_bot[i], verts_bot[j], verts_top[j]))

        # UVs: the swatch fills the tile face exactly, turned a random quarter and
        # sometimes mirrored.
        corners = [(0.0, 0.0), (1.0, 0.0), (1.0, 1.0), (0.0, 1.0)]
        turn = rng.randrange(4)
        corners = corners[turn:] + corners[:turn]
        if rng.random() < 0.5:
            corners = [(1.0 - u, v) for u, v in corners]
        for loop, uv in zip(top.loops, corners):
            loop[uv_layer].uv = uv
        count += 1

    mesh = bpy.data.meshes.new(f'{OWNED}TileMesh')
    bm.to_mesh(mesh)
    bm.free()
    mesh.materials.append(mat_tile)

    tiles = bpy.data.objects.new(f'{OWNED}Tiles', mesh)
    bpy.context.scene.collection.objects.link(tiles)

    # ONE bevel modifier for the whole floor. ANGLE limiting means it finds the tile
    # edges and leaves the coplanar interior alone, so 200 tiles cost one modifier.
    bev = tiles.modifiers.new(name='Chamfer', type='BEVEL')
    bev.width = CHAMFER_MM / 1000.0
    bev.segments = CHAMFER_SEGMENTS
    bev.limit_method = 'ANGLE'
    bev.angle_limit = math.radians(30)
    # Flat shading, deliberately. The only curvature on a tile is the chamfer, and
    # the bevel's own geometry supplies that. Mesh.use_auto_smooth was removed in 4.1
    # and smoothing the face would round the slab like a pebble.
    bev.harden_normals = False

    # The grout bed: one plane under the joints, dropped so the channel has depth.
    # Not modelled per joint — nothing sees its underside, and a plane is one quad.
    pad = max(tw, th)
    bpy.ops.mesh.primitive_plane_add(size=1, location=(
        (x0 + x1) / 2.0, (y0 + y1) / 2.0, z + thick - GROUT_DROP_MM / 1000.0))
    grout = bpy.context.active_object
    grout.name = f'{OWNED}Grout'
    grout.scale = ((x1 - x0) + pad * 2, (y1 - y0) + pad * 2, 1)
    grout.data.materials.append(mat_grout)

    log(f'{count} tiles at {spec["width_mm"]}x{spec["height_mm"]}mm, '
        f'{spec["grout_mm"]}mm joint, {spec["pattern"]} — macro joint at '
        f'({joint[0]:.2f}, {joint[1]:.2f})')
    return tiles, count, (joint[0], joint[1], z + thick)


# ── materials ───────────────────────────────────────────────────────────────────
def tile_material(spec):
    """
    The swatch as a PBR material, from the one RGB image a merchant actually uploads.

    Base colour is the photograph. Everything else is synthesised: roughness and coat
    from the finish table, and relief from the image's own luminance. There is no
    normal map, no roughness map and no height map, because there is no second photo —
    and asking a tile merchant for a four-channel PBR set is asking them to stop using
    the tool.
    """
    finish = FINISH_PRESETS.get(
        str(spec.get('finish', '')).strip().lower(), FINISH_PRESETS[DEFAULT_FINISH])

    mat = bpy.data.materials.new(f'{OWNED}Tile')
    nt = nodes_of(mat)
    nt.nodes.clear()

    out = nt.nodes.new('ShaderNodeOutputMaterial')
    out.location = (600, 0)
    bsdf = nt.nodes.new('ShaderNodeBsdfPrincipled')
    bsdf.location = (300, 0)
    nt.links.new(bsdf.outputs['BSDF'], out.inputs['Surface'])

    put(bsdf, 'roughness', finish['roughness'])
    put(bsdf, 'metallic', 0.0)
    put(bsdf, 'ior', 1.5)  # glazed ceramic; the default 1.45 is close enough to matter
    put(bsdf, 'coat', finish['coat'])
    put(bsdf, 'coat_roughness', finish['coat_roughness'])

    img = nt.nodes.new('ShaderNodeTexImage')
    img.location = (-300, 100)
    img.image = bpy.data.images.load(spec['swatch'], check_existing=True)
    img.image.colorspace_settings.name = 'sRGB'
    # The UVs are per-tile and already normalised, so the texture needs no mapping
    # node at all — one fewer thing between the photo and the render.
    img.interpolation = 'Smart'
    nt.links.new(img.outputs['Color'], socket(bsdf, 'base_color'))

    # Relief from the same image. One datablock, read twice: colour management is a
    # property of the image, not the node, so a separate Non-Color copy would mean
    # loading the file twice. RGB-to-BW off the sRGB read is a gamma error of no
    # consequence at an amplitude this small.
    bw = nt.nodes.new('ShaderNodeRGBToBW')
    bw.location = (0, -200)
    nt.links.new(img.outputs['Color'], bw.inputs['Color'])

    bump = nt.nodes.new('ShaderNodeBump')
    bump.location = (150, -200)
    bump.inputs['Strength'].default_value = BUMP_BASE * finish['bump']
    # Distance in metres. A ceramic pore is tenths of a millimetre.
    bump.inputs['Distance'].default_value = 0.0004
    nt.links.new(bw.outputs['Val'], bump.inputs['Height'])
    normal_in = socket(bsdf, 'normal')
    if normal_in is not None:
        nt.links.new(bump.outputs['Normal'], normal_in)

    return mat


def grout_material(spec):
    """
    Matte, and non-specular on purpose. Cementitious grout is the one surface in a
    bathroom that does not shine, and giving it any coat at all makes the joints
    glitter under the grazing camera — which is the shot that exists to prove the
    TILE's finish, not the grout's.
    """
    mat = bpy.data.materials.new(f'{OWNED}Grout')
    bsdf = next(n for n in nodes_of(mat).nodes if n.type == 'BSDF_PRINCIPLED')
    # None means "read it off the tile", which blenderRoom.js supplies from the
    # swatch's own median. A fixed dark grey draws a hard black grid over pale marble
    # and vanishes under a charcoal tile, and the catalogue contains both — the same
    # lesson roomwarp.py already learned.
    put(bsdf, 'base_color', (*hex_rgb(spec.get('grout_color') or GROUT_FALLBACK), 1.0))
    put(bsdf, 'roughness', 0.95)
    put(bsdf, 'metallic', 0.0)
    put(bsdf, 'coat', 0.0)
    return mat


# ── the camera rig ──────────────────────────────────────────────────────────────
def aim(ob, at):
    """Point an object's -Z at a world position. Blender cameras look down -Z."""
    d = Vector(at) - ob.location
    ob.rotation_euler = d.to_track_quat('-Z', 'Y').to_euler()


def brightest_light():
    """
    Where the room's key light is, for the grazing shot to face into.

    Emissive MESHES are the common case, not lamps: an artist's window is a plane with
    an emission shader, and a scene built that way has no LIGHT object at all.
    """
    best, best_power = None, -1.0
    for ob in bpy.data.objects:
        if ob.name.startswith(OWNED) or not ob.visible_get():
            continue
        if ob.type == 'LIGHT':
            power = ob.data.energy
        elif ob.type == 'MESH':
            power = 0.0
            for slot in ob.material_slots:
                mat = slot.material
                if not mat or not mat.use_nodes:
                    continue
                for node in mat.node_tree.nodes:
                    if node.type == 'EMISSION':
                        power += node.inputs['Strength'].default_value * 50
        else:
            continue
        if power > best_power:
            best, best_power = ob, power
    return (best.matrix_world.translation.copy() if best else None)


def scene_camera():
    """The camera the scene came with, if any. Ours are all prefixed."""
    return next((o for o in bpy.data.objects
                 if o.type == 'CAMERA' and not o.name.startswith(OWNED)), None)


def view_focus(extent):
    """
    The point on the floor the shots should be about.

    NOT the floor's centroid. A purchased scene is not a 6 m box: the one measured
    here is a 7.3 x 17.5 m open plan, and its centroid is several metres from the
    kitchen the artist built. Putting the macro and grazing cameras there would
    photograph a stretch of floor nobody was ever meant to look at.

    So: follow the scene camera's own view down to the floor. That is where the
    kitchen is, because that is what the artist pointed at. If the camera looks level
    or upward — this one tilts up by 0.07 — there is no intersection, and a few metres
    along its heading is the honest approximation.
    """
    x0, y0, x1, y1, z = extent
    centre = ((x0 + x1) / 2.0, (y0 + y1) / 2.0)
    cam = scene_camera()
    if cam is None:
        return centre

    look = cam.matrix_world.to_quaternion() @ Vector((0.0, 0.0, -1.0))
    here = cam.matrix_world.translation
    if look.z < -0.05:
        t = (z - here.z) / look.z
        hit = (here.x + look.x * t, here.y + look.y * t)
    else:
        flat = Vector((look.x, look.y, 0.0))
        flat = flat.normalized() if flat.length > 1e-4 else Vector((0.0, 1.0, 0.0))
        hit = (here.x + flat.x * VIEW_AHEAD_M, here.y + flat.y * VIEW_AHEAD_M)

    # Clamped into the floor, because a camera aimed out of a window would otherwise
    # put the macro shot outside the building.
    pad = 0.6
    return (min(max(hit[0], x0 + pad), x1 - pad), min(max(hit[1], y0 + pad), y1 - pad))


def build_cameras(extent, spec, macro_focus):
    """
    Three cameras, placed from framing geometry rather than from multipliers that
    happened to look right in one room.

    Created every run, never read from the .blend: a purchased scene arrives with the
    artist's own camera framing their hero angle, and the PDP needs these three.

    All three are clamped inside the floor rectangle and under the ceiling. The first
    version was not, and put hero_wide outside the building and macro_detail through
    the roof — both of which render perfectly happily and return a picture of nothing.
    """
    x0, y0, x1, y1, z = extent
    cx, cy = (x0 + x1) / 2.0, (y0 + y1) / 2.0
    span = max(x1 - x0, y1 - y0)
    height = room_height(z)
    ceiling = z + height - CEILING_CLEARANCE_M
    inset = 0.25  # keep a camera off the skirting

    def clamp(p):
        return (min(max(p[0], x0 + inset), x1 - inset),
                min(max(p[1], y0 + inset), y1 - inset),
                min(p[2], ceiling))

    cams = {}

    def cam(name, loc, target, lens, fstop=None):
        data = bpy.data.cameras.new(f'{OWNED}{name}')
        data.lens = lens
        loc = clamp(loc)
        if fstop is not None:
            data.dof.use_dof = True
            data.dof.focus_distance = max(0.05, (Vector(loc) - Vector(target)).length)
            data.dof.aperture_fstop = fstop
        ob = bpy.data.objects.new(f'{OWNED}{name}', data)
        bpy.context.scene.collection.objects.link(ob)
        ob.location = loc
        aim(ob, target)
        cams[name] = ob
        return ob

    def distance_for(width_m, lens):
        """How far back a `lens` has to be to frame `width_m` across. Similar triangles."""
        return width_m * lens / SENSOR_MM

    # 1. hero_wide — THE ARTIST'S CAMERA, when the scene has one.
    #
    #    Placing this automatically is right for the grey box and wrong for anything
    #    bought. The measured case: a 7.3 x 17.5 m open plan where span * 0.34 puts
    #    the camera 5.9 m from centre — through a wall, or in the next room. Whoever
    #    built that scene already chose a viewpoint that shows the kitchen, and their
    #    choice beats an offset computed from a bounding box every time.
    #
    #    The fallback below is the grey-box placement: eye level, inside the floor
    #    rectangle, on a 35 mm lens — the widest that does not splay the verticals or
    #    stretch the tile at the frame edge, which is the subject.
    artist = scene_camera() if str(spec.get('hero', 'scene')) == 'scene' else None
    if artist is not None:
        cams['hero_wide'] = artist
        log(f'hero_wide: the scene\'s own camera {artist.name} '
            f'({artist.data.lens:.0f} mm at z={artist.location.z:.2f})')
    else:
        cam('hero_wide',
            (cx - span * 0.34, cy - span * 0.42, z + min(1.55, height - CEILING_CLEARANCE_M)),
            (cx + span * 0.06, cy + span * 0.12, z + 0.30),
            lens=35)

    # 2. sheen_grazing — low, and facing INTO the key light, because a specular
    #    highlight only exists near the mirror direction. Put this camera anywhere
    #    else and a polished tile renders identically to a matte one, which defeats
    #    the entire purpose of the shot.
    #
    #    0.32 m is about shin height: low enough that the floor fills the frame and
    #    the reflection angle is genuinely grazing.
    key = brightest_light()
    if key is None:
        log('no light found for sheen_grazing — facing the +Y wall')
        key = Vector((cx, y1, z + 2.0))
    to_key = Vector((key.x - macro_focus[0], key.y - macro_focus[1], 0.0))
    if to_key.length < 1e-4:
        to_key = Vector((0.0, 1.0, 0.0))
    to_key.normalize()
    # Anchored on the focus rather than the room's centre, and stepped by a few
    # metres rather than by a fraction of the span — in a 17 m room a 40% step is
    # seven metres backwards, which is another room.
    fx, fy = macro_focus[0], macro_focus[1]
    reach = min(span * 0.40, GRAZE_STANDOFF_M)
    stand = Vector((fx, fy, 0.0)) - to_key * reach
    # Looks at a point just in front of itself, not at the far side of the room:
    # the depression angle is what keeps the wall out of frame.
    look = stand + to_key * GRAZE_LOOK_AHEAD_M
    cam('sheen_grazing',
        (stand.x, stand.y, z + GRAZE_HEIGHT_M),
        (look.x, look.y, z + 0.01),
        lens=50, fstop=5.6)

    # 3. macro_detail — steeply down onto one grout joint, framing MACRO_FRAME_M
    #    across. See that constant for why it is a fixed width and not "four tiles".
    #
    #    80 degrees off horizontal, not straight down: at 90 the chamfer faces the
    #    camera flat and vanishes, and the whole point of the shot is that the bevel
    #    is visible. f/4 leaves the far corner soft the way a real macro would.
    lens = 100.0
    dist = distance_for(MACRO_FRAME_M, lens)
    tilt = math.radians(80)
    # Back off along the light direction so the highlight runs across the joint
    # rather than away from it.
    back = -to_key * (dist * math.cos(tilt))
    focus = macro_focus
    top = focus[2] + dist * math.sin(tilt)
    if top > ceiling:
        # Not enough headroom for 100 mm: shorten the lens until it fits rather than
        # silently pushing the camera through the roof.
        usable = max(0.15, ceiling - focus[2])
        lens = max(24.0, lens * (usable / (dist * math.sin(tilt))))
        dist = distance_for(MACRO_FRAME_M, lens)
        back = -to_key * (dist * math.cos(tilt))
        top = focus[2] + dist * math.sin(tilt)
        log(f'macro headroom {usable:.2f} m — lens shortened to {lens:.0f} mm')
    cam('macro_detail',
        (focus[0] + back.x, focus[1] + back.y, top),
        focus,
        lens=lens, fstop=4.0)

    log(f'cameras placed; room height {height:.2f} m, macro lens {lens:.0f} mm')
    return cams


# ── bootstrap: the grey box ─────────────────────────────────────────────────────
def bootstrap(path):
    """
    A calibration room, and it is honest about being one.

    NOT a product shot. A kitchen that reads as photographed is cabinet detail, a
    bevelled backsplash, a toaster, a fruit bowl and a fortnight of someone's
    attention — bpy primitives produce grey boxes in a grey room, and a grey-box hero
    shot is worse than the homography composite it would replace. That scene gets
    bought or commissioned; this one exists so tile scale, grout metrics, chamfers and
    the camera rig can be developed and measured without it.

    Which makes it genuinely useful: a ruler laid across a render of this room says
    whether a 1200 mm tile is 1200 mm, and no amount of styling helps answer that.
    """
    bpy.ops.wm.read_factory_settings(use_empty=True)
    scene = bpy.context.scene

    W, D, H = 6.0, 6.0, 2.7

    # Floor_Target: the one name a scene has to carry for this pipeline to find it.
    bpy.ops.mesh.primitive_plane_add(size=1, location=(0, 0, 0))
    floor = bpy.context.active_object
    floor.name = FLOOR_TARGET
    floor.scale = (W, D, 1)
    floor.data.materials.append(bpy.data.materials.new('Floor_Target'))

    # FOUR walls, and the fourth has a hole in it.
    #
    # Three was the obvious economy — the camera stands where the fourth would be, so
    # why build it. Because hero_wide looks ACROSS the room, not along it, and the
    # missing +X wall rendered as a slab of world background sitting where a kitchen
    # should be. A room needs to be enclosed from every angle the cameras use, and
    # they use most of them.
    #
    # +X is the window wall, built as four pieces around an opening rather than as a
    # plane with the emitter stuck in front of it: a light indoors of a solid wall is
    # a light in a box, and the grazing shot needs the key to come from outside.
    for name, loc, scale in (
        ('Wall_Y', (0, D / 2, H / 2), (W, 1, H)),
        ('Wall_Y2', (0, -D / 2, H / 2), (W, 1, H)),
        ('Wall_X', (-W / 2, 0, H / 2), (1, D, H)),
        ('Ceiling', (0, 0, H), (W, D, 1)),
    ):
        bpy.ops.mesh.primitive_plane_add(size=1, location=loc)
        ob = bpy.context.active_object
        ob.name = name
        if name.startswith('Wall_Y'):
            ob.rotation_euler = (math.radians(90), 0, 0)
            ob.scale = (scale[0], scale[2], 1)
        elif name == 'Wall_X':
            ob.rotation_euler = (0, math.radians(90), 0)
            ob.scale = (scale[2], scale[1], 1)
        else:
            ob.scale = (scale[0], scale[1], 1)

    # The window wall: floor-to-sill, head-to-ceiling, and a pier each side, leaving
    # a 2.6 x 2.0 m opening centred on the emitter below.
    SILL, HEAD, OPEN_W = 0.35, 2.35, 2.6
    for i, (cy_, cz, sy, sz) in enumerate((
        (0.0, SILL / 2, D, SILL),                       # under the sill
        (0.0, (HEAD + H) / 2, D, H - HEAD),             # over the head
        (-(D + OPEN_W) / 4, (SILL + HEAD) / 2, (D - OPEN_W) / 2, HEAD - SILL),
        ((D + OPEN_W) / 4, (SILL + HEAD) / 2, (D - OPEN_W) / 2, HEAD - SILL),
    )):
        if sy <= 0 or sz <= 0:
            continue
        bpy.ops.mesh.primitive_plane_add(size=1, location=(W / 2, cy_, cz))
        ob = bpy.context.active_object
        ob.name = f'Wall_Window_{i}'
        ob.rotation_euler = (0, math.radians(90), 0)
        ob.scale = (sz, sy, 1)

    wall_mat = bpy.data.materials.new('Wall')
    wall_bsdf = next(n for n in nodes_of(wall_mat).nodes if n.type == 'BSDF_PRINCIPLED')
    put(wall_bsdf, 'base_color', (0.72, 0.71, 0.69, 1))
    put(wall_bsdf, 'roughness', 0.85)
    for ob in bpy.data.objects:
        if ob.type == 'MESH' and ob.name.startswith(('Wall', 'Ceiling')):
            ob.data.materials.append(wall_mat)

    # An island, for the contact shadow. A floor with nothing standing on it gives the
    # eye no scale and no shadow to judge the tile against, and the shadow is half of
    # what makes the tile look like it is IN the room rather than under it.
    # Pushed to the far half of the room on purpose. At (0.4, -0.6) it sat squarely
    # in front of the shin-height grazing camera and filled half that frame with grey
    # cabinet — the one shot whose entire subject is an uninterrupted run of floor.
    bpy.ops.mesh.primitive_cube_add(size=1, location=(-0.5, 1.5, 0.45))
    island = bpy.context.active_object
    island.name = 'Island'
    island.scale = (2.4, 1.0, 0.9)
    island.data.materials.append(wall_mat)

    # A patio window: a large area emitter low and to one side. Directional enough to
    # make the grazing shot mean something, broad enough not to look like a studio.
    win = bpy.data.lights.new('Window', type='AREA')
    win.shape = 'RECTANGLE'
    win.size, win.size_y = 2.6, 2.0
    # Was 900 when the world was dark and this light was the whole sun. With a real
    # sky coming through the opening it is a fill, and at 900 it clipped the sill.
    win.energy = 260
    win.color = (1.0, 0.98, 0.94)
    ob = bpy.data.objects.new('Window', win)
    scene.collection.objects.link(ob)
    ob.location = (W / 2 - 0.06, 0.0, (SILL + HEAD) / 2)
    ob.rotation_euler = (0, math.radians(-90), 0)

    # Two 3000 K downlights, so the far side of the room is not a black hole.
    for i, x in enumerate((-1.6, 1.6)):
        d = bpy.data.lights.new(f'Down_{i}', type='AREA')
        d.shape, d.size = 'DISK', 0.28
        d.energy = 110
        d.color = (1.0, 0.87, 0.72)  # ~3000 K
        o = bpy.data.objects.new(f'Down_{i}', d)
        scene.collection.objects.link(o)
        o.location = (x, 1.2, H - 0.06)
        o.rotation_euler = (math.radians(180), 0, 0)

    # DAYLIGHT, not ambient fill.
    #
    # The first version used a dim blue-grey at 0.25 strength, on the reasoning that a
    # world is there to lift shadows. Then the wall got a window in it, and that dim
    # world became the thing you SEE through the window: a dark slab hanging in the
    # opening where the sky should be. A window onto a darker-than-indoors outside is
    # the most immediately wrong thing a render can contain.
    #
    # So the world is sky, at sky brightness, and it lights the room through the
    # opening the way a window actually does. The area emitter below drops to match —
    # it is now filling in the direct light rather than supplying all of it.
    world = bpy.data.worlds.new('World')
    bg = next(n for n in nodes_of(world).nodes if n.type == 'BACKGROUND')
    bg.inputs['Color'].default_value = (0.55, 0.68, 0.92, 1.0)
    bg.inputs['Strength'].default_value = 2.6
    scene.world = world

    os.makedirs(os.path.dirname(path), exist_ok=True)
    bpy.ops.wm.save_as_mainfile(filepath=path)
    log(f'bootstrapped {path}')


# ── render ──────────────────────────────────────────────────────────────────────
def apply_look(scene, shot, spec):
    """The view transform and exposure for one shot; a payload value overrides both."""
    view, exposure = SHOT_LOOK.get(shot, DEFAULT_LOOK)
    view = spec.get('view_transform') or view
    exposure = spec['exposure'] if spec.get('exposure') is not None else exposure
    try:
        scene.view_settings.view_transform = view
    except TypeError:
        log(f'view transform {view!r} unavailable on this build — leaving default')
    scene.view_settings.exposure = float(exposure)
    return view, exposure


def lift_ambient(factor):
    """
    Scale the scene's world lighting.

    A bought interior is lit for MOOD, not for a product shot. The one measured here
    has a world of 5% grey — effectively black — with the whole room carried by seven
    7.9 W under-cabinet strips and 137 emissive downlight discs, plus a 1000 W lamp
    parked at z=5.90 above a 2.08 m ceiling where it does nothing at all. Beautiful
    evening kitchen. The floor renders at 23% brightness, and the floor is the product.

    Scaling the world rather than adding a light, because the world is the one source
    that fills shadow uniformly, and multiplying it keeps an HDRI's direction and
    colour intact where a scene has one. 1.0 is untouched.
    """
    if abs(factor - 1.0) < 1e-6:
        return None
    world = bpy.context.scene.world
    if world is None or world.node_tree is None:
        log('no world to lift')
        return None
    for node in world.node_tree.nodes:
        if node.type == 'BACKGROUND' and 'Strength' in node.inputs:
            was = node.inputs['Strength'].default_value
            node.inputs['Strength'].default_value = was * factor
            log(f'ambient {was:.2f} -> {was * factor:.2f}')
            return was * factor
    return None


def lift_lighting(factor):
    """
    Scale the scene's own lamps and emissive materials.

    `ambient` is the obvious knob and it does NOTHING on a sealed room — measured:
    multiplying the world by ten on a kitchen whose shell is a closed six-faced box
    changed the render by literally zero, because world light only enters through an
    opening and there was none. The log said 1.00 -> 10.00 and the pixels were
    identical.

    Emission is what actually lights that scene: seven 7.9 W strips and 137 emissive
    material slots. Scaling those raises the level while keeping the artist's lighting
    DESIGN — where the light comes from, what colour it is, which surfaces bounce it.
    That is the difference between this and `exposure`, which lifts the whole image
    including its black point: measured on the same frame, +1.6 EV raised the floor
    from 106 to 169 but flattened the tile's own pattern contrast from 5.55 to 4.53.
    Tone mapping cannot add light that was never cast.

    Emissive slots whose colour is black scale to nothing, which is why this is safe
    to apply broadly.
    """
    if abs(factor - 1.0) < 1e-6:
        return
    lamps = 0
    for ob in bpy.data.objects:
        if ob.type == 'LIGHT':
            ob.data.energy *= factor
            lamps += 1

    slots = 0
    for mat in bpy.data.materials:
        if mat.node_tree is None:
            continue
        for node in mat.node_tree.nodes:
            if node.type == 'EMISSION' and 'Strength' in node.inputs:
                node.inputs['Strength'].default_value *= factor
                slots += 1
            elif node.type == 'BSDF_PRINCIPLED' and 'Emission Strength' in node.inputs:
                if node.inputs['Emission Strength'].default_value > 0:
                    node.inputs['Emission Strength'].default_value *= factor
                    slots += 1
    log(f'lighting x{factor:g}: {lamps} lamps, {slots} emissive slots')


def configure(scene, spec):
    scene.render.engine = 'CYCLES'
    device = enable_device(scene, spec.get('device', 'auto'))

    scene.cycles.samples = int(spec['samples'])
    scene.cycles.use_adaptive_sampling = True
    scene.cycles.adaptive_threshold = 0.01
    scene.cycles.use_denoising = True
    # Glossy bounces are what a polished floor is made of; the default 4 loses the
    # reflection of the reflection, which is visible on a mirror finish.
    scene.cycles.max_bounces = 12
    scene.cycles.glossy_bounces = 8
    scene.cycles.transmission_bounces = 8
    # Clamping indirect kills fireflies from the small bright downlights. 10 is high
    # enough not to darken the render.
    scene.cycles.sample_clamp_indirect = 10.0

    scene.render.resolution_x = int(spec['resolution'])
    scene.render.resolution_y = int(spec['resolution'])
    scene.render.resolution_percentage = 100
    scene.render.image_settings.file_format = 'PNG'
    scene.render.image_settings.color_mode = 'RGB'
    scene.render.film_transparent = False

    return device


def run(payload_path):
    spec = dict(DEFAULTS)
    with open(payload_path) as fh:
        spec.update({k: v for k, v in json.load(fh).items() if v is not None})

    if not spec.get('swatch') or not os.path.isfile(spec['swatch']):
        raise SystemExit(f'swatch not found: {spec.get("swatch")!r}')
    out_dir = spec.get('out_dir') or os.path.dirname(payload_path)
    os.makedirs(out_dir, exist_ok=True)

    scene = bpy.context.scene
    device = configure(scene, spec)

    clear_owned()
    lift_ambient(float(spec.get('ambient', 1.0)))
    lift_lighting(float(spec.get('lighting', 1.0)))
    extent = floor_extent()
    focus = view_focus(extent)
    log(f'shots centred on ({focus[0]:.2f}, {focus[1]:.2f})')
    tiles, count, macro_focus = build_floor(
        spec, extent, tile_material(spec), grout_material(spec), near=focus)
    cams = build_cameras(extent, spec, macro_focus)

    written = {}
    for shot in spec['shots']:
        if shot not in cams:
            log(f'no camera called {shot!r} — skipped')
            continue
        scene.camera = cams[shot]
        view, exposure = apply_look(scene, shot, spec)
        path = os.path.join(out_dir, f'{shot}.png')
        scene.render.filepath = path
        log(f'rendering {shot} at {spec["resolution"]}px, {spec["samples"]} samples, '
            f'{view} {exposure:+.1f} EV')
        bpy.ops.render.render(write_still=True)
        written[shot] = path

    result = {
        'ok': True,
        'device': device,
        'tiles': count,
        'blender': bpy.app.version_string,
        'shots': written,
        'spec': {k: spec[k] for k in (
            'width_mm', 'height_mm', 'grout_mm', 'finish', 'pattern', 'resolution',
            'samples', 'seed', 'ambient', 'lighting', 'hero')},
    }
    with open(os.path.join(out_dir, 'result.json'), 'w') as fh:
        json.dump(result, fh, indent=2)
    log('done')


def inspect(blend=None):
    """
    blender -b -noaudio -P render_room.py -- --inspect <scene>.blend

    Opens the file itself rather than taking it as Blender's own positional argument,
    so `npm run blender:inspect -- path.blend` works — npm appends its arguments to
    the END of the command, which is the wrong side of `-P` for Blender to read a
    scene from.

    Answers, in two seconds, the four questions that otherwise cost a full render to
    find out. Every one of these fails SILENTLY — the pipeline renders something
    plausible and wrong — which is exactly the kind of failure worth a tool.

      1. Is there a floor this can find, and is it its own object? A scene whose floor
         is welded into the same mesh as the walls cannot have its floor replaced.
      2. Is the scene in real metres? A room that comes in at 600 m wide lays tiles
         that are correct and invisible, and the render looks like concrete.
      3. Is there a light? brightest_light() aims the grazing shot, and that shot is
         the whole reason for using a renderer.
      4. Are the textures packed and how big are they? An unpacked scene loses every
         texture the moment it leaves the artist's machine, and 4K everything will not
         fit alongside Cycles on 16 GB.
    """
    if blend:
        bpy.ops.wm.open_mainfile(filepath=os.path.abspath(blend))
    x0, y0, x1, y1, z = floor_extent()
    w, d = x1 - x0, y1 - y0
    h = room_height(z)
    named = bpy.data.objects.get(FLOOR_TARGET)

    print(f'blender      {bpy.app.version_string}')
    print(f'floor        {w:.2f} x {d:.2f} m, top at z={z:.2f}, headroom {h:.2f} m')
    print(f'{FLOOR_TARGET:<12} ' + ('yes' if named else
          'not named — floor FACES used instead, which is fine'))

    # 25 m is not a kitchen. Either the scene is in centimetres or it is a warehouse,
    # and both make the tile scale meaningless.
    if not 1.5 <= max(w, d) <= 25.0:
        print(f'  ^ SUSPECT SCALE: a room is 3-12 m across. Check the scene\'s unit '
              f'settings and apply the scale before using it.')
    if not 1.9 <= h <= 6.0:
        print(f'  ^ SUSPECT HEADROOM: {h:.2f} m. The cameras place themselves off this.')

    key = brightest_light()
    print('key light    ' + (f'at ({key.x:.2f}, {key.y:.2f}, {key.z:.2f})' if key
                             else 'NONE — sheen_grazing will face the +Y wall blindly'))

    unpacked, mb = [], 0.0
    for img in bpy.data.images:
        if img.source != 'FILE':
            continue
        px = (img.size[0] * img.size[1] * img.channels) / 1e6
        mb += px
        if not img.packed_file:
            unpacked.append(f'{img.name} ({img.size[0]}x{img.size[1]})')
    print(f'textures     {len(bpy.data.images)} images, ~{mb:.0f} MB uncompressed')
    if unpacked:
        print(f'  ^ {len(unpacked)} NOT PACKED: {", ".join(unpacked[:4])}'
              f'{" ..." if len(unpacked) > 4 else ""}')
        print('    Fix in Blender: File > External Data > Pack Resources, then save.')
    if mb > 3000:
        print('  ^ heavy for a 16 GB box. Scale the biggest maps to 2K.')

    meshes = sum(1 for ob in bpy.data.objects if ob.type == 'MESH')
    tris = sum(len(ob.data.polygons) for ob in bpy.data.objects if ob.type == 'MESH')
    print(f'geometry     {meshes} meshes, {tris} faces')
    cams = [o.name for o in bpy.data.objects if o.type == 'CAMERA']
    print('scene camera ' + (f'{cams[0]} — will be used for hero_wide' if cams
                             else 'none — hero_wide will be placed automatically'))
    # A missing floor is not a warning, it is a refusal: the tiles would be laid on a
    # default 6 x 6 m guess at z=0, somewhere in mid-air. The first version of this
    # verdict printed 'ok' in exactly that case.
    if floor_faces() is None:
        print('NOT USABLE — no floor found. Open it in Blender, select the floor '
              f'surface, and name that object {FLOOR_TARGET}.')
        return
    warned = (not key or not 1.5 <= max(w, d) <= 25.0 or not 1.9 <= h <= 6.0
              or unpacked)
    print('usable, with the warnings above' if warned else 'ok')


def selfcheck():
    """
    blender -b -P render_room.py -- --selfcheck

    Metric scale is the whole argument for this engine over the 2D composite, so it
    is the thing that gets asserted rather than eyeballed. A render that LOOKS right
    and lays 1150 mm tiles is worse than one that looks wrong, because nobody checks
    a picture with a ruler and a tiler will.

    Also covers the stagger arithmetic and the joint the macro camera aims at, all of
    which are silent when wrong — a floor with the offset applied to the wrong axis
    is still a perfectly plausible floor.
    """
    bpy.ops.wm.read_factory_settings(use_empty=True)
    tol = 1e-5

    for w_mm, h_mm, g_mm, pattern in (
        (1200, 600, 3, 'stagger_third'),
        (600, 600, 2, 'straight'),
        (300, 300, 5, 'stagger_half'),
    ):
        spec = dict(DEFAULTS, width_mm=w_mm, height_mm=h_mm, grout_mm=g_mm,
                    pattern=pattern, swatch=None, seed=7)
        extent = (-3.0, -3.0, 3.0, 3.0, 0.0)
        origins = list(tile_origins(pattern, *extent[:4],
                                    w_mm / 1000.0, h_mm / 1000.0, g_mm / 1000.0))

        # One tile is exactly its label, in metres.
        _, _, w, h = origins[0]
        assert abs(w - w_mm / 1000.0) < tol, f'{w_mm}mm tile came out {w * 1000:.1f}mm'
        assert abs(h - h_mm / 1000.0) < tol, f'{h_mm}mm tile came out {h * 1000:.1f}mm'

        # Neighbours in a row are one tile plus one joint apart, and not one joint
        # plus a rounding error.
        row0 = sorted(x for x, y, _, _ in origins if abs(y - origins[0][1]) < tol)
        gap = row0[1] - row0[0] - w
        assert abs(gap - g_mm / 1000.0) < tol, f'joint came out {gap * 1000:.2f}mm, wanted {g_mm}'

        # Stagger offsets the row, and by the fraction it says.
        ys = sorted({y for _, y, _, _ in origins})
        xs_by_row = [min(x for x, y, _, _ in origins if abs(y - yy) < tol) for yy in ys[:4]]
        shifts = [round((x - xs_by_row[0]) / (w + g_mm / 1000.0), 4) % 1 for x in xs_by_row]
        expected = {'straight': [0, 0, 0, 0],
                    'stagger_half': [0, 0.5, 0, 0.5],
                    'stagger_third': [0, 1 / 3, 2 / 3, 0]}[pattern]
        assert all(abs(a - b) < 1e-3 for a, b in zip(shifts, expected)), \
            f'{pattern} shifted {shifts}, wanted {[round(e, 4) for e in expected]}'

        print(f'{pattern:>14}  {w_mm}x{h_mm}mm  joint {gap * 1000:.2f}mm  '
              f'rows offset {[round(x, 3) for x in shifts]}')

    # An unknown pattern must say so rather than quietly laying a grid.
    try:
        list(tile_origins('herringbone', -1, -1, 1, 1, 0.6, 0.3, 0.003))
    except ValueError as e:
        assert 'herringbone' in str(e).lower()
    else:
        raise AssertionError('herringbone silently laid something')

    # The finish table has to survive whatever Principled BSDF is called today. This
    # is the assertion that would have caught the brief's `clearcoat` on 4.x.
    mat = bpy.data.materials.new('probe')
    bsdf = next(n for n in nodes_of(mat).nodes if n.type == 'BSDF_PRINCIPLED')
    missing = [r for r in SOCKET_ALIASES if socket(bsdf, r) is None]
    assert not missing, f'no socket on this Blender for: {missing}'
    for name, preset in FINISH_PRESETS.items():
        for role in ('roughness', 'coat', 'coat_roughness'):
            assert put(bsdf, role, preset[role]) is not None, f'{name}: {role} did not set'
    print(f'{len(FINISH_PRESETS)} finishes set cleanly on Blender {bpy.app.version_string}')
    print('selfcheck ok')


def main():
    argv = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
    if '--selfcheck' in argv:
        selfcheck()
    elif '--inspect' in argv:
        rest = argv[argv.index('--inspect') + 1:]
        inspect(rest[0] if rest else None)
    elif '--bootstrap' in argv:
        bootstrap(os.path.abspath(argv[argv.index('--bootstrap') + 1]))
    elif '--payload' in argv:
        run(os.path.abspath(argv[argv.index('--payload') + 1]))
    else:
        raise SystemExit(__doc__)


if __name__ == '__main__':
    main()
