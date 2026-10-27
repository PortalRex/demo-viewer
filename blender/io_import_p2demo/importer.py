# Building a Blender scene from a demo bundle (written by the viewer's
# Blender export, sar-web src/blender/capture.ts): meshes and their
# materials, objects keyframed where they move, show and hide, armatures for
# animated models, the cameras, and the frame-wide values (exposure, fog,
# fades). Frame f of the bundle is Blender frame f + 1.
import json
import math
import os
import time

import bpy
import numpy as np
from mathutils import Matrix, Quaternion, Vector

from . import compositor
from .geonodes import frame_filter_group, rope_group
from . import materials
from .materials import MaterialBuilder, globals_group
from .nodes import Graph

INTERP = {'CONSTANT': 0, 'LINEAR': 1}


class Bundle:
    def __init__(self, path):
        self.dir = os.path.dirname(path)
        with open(path, 'r', encoding='utf-8') as f:
            self.scene = json.load(f)
        self.bin = np.fromfile(os.path.join(self.dir, 'data.bin'), dtype=np.uint8)

    def view(self, v):
        dtype = {'f64': np.float64, 'f32': np.float32, 'f16': np.float16, 'u32': np.uint32, 'u16': np.uint16, 'u8': np.uint8, 'i32': np.int32}[v['type']]
        return np.frombuffer(self.bin, dtype=dtype, count=v['length'], offset=v['offset'])

    def track(self, t):
        frames = self.view(t['frames']).astype(np.float64)
        values = self.view(t['values']).reshape(-1, t['width']) if t['width'] else np.zeros((len(frames), 0))
        return frames, values

    def __getitem__(self, k):
        return self.scene[k]


# ---- keyframes ----

LAYERED = hasattr(bpy.types, 'ActionSlot')  # (Blender 4.4+: actions hold slots, layers, strips)


def channels_for(idb, name):
    """Where an ID's F-curves go: its action's channel bag for its slot (4.4+),
    or the action itself."""
    ad = idb.animation_data or idb.animation_data_create()
    if ad.action is None:
        action = bpy.data.actions.new(name)
        if LAYERED:
            slot = action.slots.new(id_type=idb.id_type, name=idb.name)
            ad.action = action
            ad.action_slot = slot
            strip = action.layers.new('Layer').strips.new(type='KEYFRAME')
            idb_bags[idb.as_pointer()] = strip.channelbag(slot, ensure=True)
        else:
            ad.action = action
    if LAYERED:
        bag = idb_bags.get(idb.as_pointer())
        if bag is None:
            bag = ad.action.layers[0].strips[0].channelbag(ad.action_slot, ensure=True)
            idb_bags[idb.as_pointer()] = bag
        return bag
    return ad.action


idb_bags = {}


def fcurve(channels, path, index, group=None):
    fc = channels.fcurves.find(path, index=index)
    if fc is None:
        fc = channels.fcurves.new(path, index=index)
        if group:
            grp = channels.groups.get(group) or channels.groups.new(group)
            fc.group = grp
    return fc


def keys(idb, path, frames, values, interp='LINEAR', index=0, group=None, name=None):
    """Keyframes at bundle frames (Blender frame = f + 1)."""
    channels = channels_for(idb, name or f'{idb.name}_action')
    fc = fcurve(channels, path, index, group)
    n = len(frames)
    fc.keyframe_points.add(n)
    co = np.empty(n * 2, dtype=np.float32)
    co[0::2] = np.asarray(frames, dtype=np.float32) + 1
    co[1::2] = values
    fc.keyframe_points.foreach_set('co', co)
    fc.keyframe_points.foreach_set('interpolation', np.full(n, INTERP[interp], dtype=np.int32))
    fc.update()
    return fc


def key_vectors(idb, path, frames, values, interp='LINEAR', group=None):
    for i in range(values.shape[1]):
        keys(idb, path, frames, values[:, i], interp, index=i, group=group)


# ---- the importer ----

class Importer:
    def __init__(self, path, scale=0.0254, engine='CYCLES', samples=32, projected_light=True):
        self.b = Bundle(path)
        self.S = scale
        self.engine = engine
        self.samples = samples
        self.projected_light = projected_light
        self.meshes = {}
        self.armatures = {}
        self.log = []

    def note(self, msg):
        self.log.append(msg)
        print('[p2demo]', msg)

    def run(self, context, scene=None, tag=''):
        """Into `scene` (the current one by default); `tag` tells this
        segment's node groups and scene names apart from the others'."""
        t0 = time.time()
        b = self.b
        name = os.path.basename(b.dir.rstrip('/\\'))
        materials.name_groups(tag)
        scene = scene or context.scene
        scene.name = f'{tag} {b["map"]}'.strip()
        self.scene = scene
        self.setup_scene(scene, b['frames'])
        self.root = bpy.data.collections.new(f'P2 {b["map"]}')
        scene.collection.children.link(self.root)
        self.cols = {}
        for key in ('map', 'props', 'entities', 'effects', 'overlay', 'viewmodel', 'cameras'):
            c = bpy.data.collections.new(f'{key}')
            self.root.children.link(c)
            self.cols[key] = c
        self.images = self.load_images()
        self.note(f'images {time.time() - t0:.1f}s')
        self.mats = MaterialBuilder(b.scene, self.images, self.S)
        self.mats.sky = self.sky_setup()
        self.mats.flash = self.projected_light and bool(b.scene.get('flash'))
        self.mats.paint = b.scene.get('paint')
        self.globals()
        self.objects()
        self.dynamics()
        self.sequences_play()
        self.note(f'objects {time.time() - t0:.1f}s')
        self.cameras(scene)
        self.flash()
        self.viewmodel_scene(context)
        self.overlay_scene()
        self.sky_scene()
        self.compositor(scene)
        self.note(f'done in {time.time() - t0:.1f}s ({name})')

    # ---- the sky ----

    def sky_setup(self):
        """The 2D sky (an image, or None) and whether there's a 3D skybox."""
        sky2d = self.b.scene.get('sky2d')
        img = self.images.get(sky2d) if sky2d is not None else None
        return {'image': img, 'skybox': bool(self.b.scene.get('skyCamera'))}

    def sky_scene(self):
        """The 3D skybox, as the viewer draws it first: the map and its props
        from sky_camera (at 1/scale of the eye's position), with its own fog
        and the 2D sky behind, under everything else. A scene of its own,
        layered under the main one in the compositor."""
        self.sky = None
        sc = self.b.scene.get('skyCamera')
        sky_img = self.mats.sky['image']
        main = self.scene
        if not sc and sky_img is None:
            return
        if not sc:
            # (no skybox: the sky faces draw the 2D sky themselves)
            return
        sky = bpy.data.scenes.new(f'{main.name} skybox')
        self.copy_render(main, sky)
        sky.render.film_transparent = False
        world = bpy.data.worlds.new('P2 sky')
        world.use_nodes = True
        nt = world.node_tree
        bg = nt.nodes.get('Background')
        if sky_img is not None:
            env = nt.nodes.new('ShaderNodeTexEnvironment')
            env.image = sky_img
            # (exposed, as everything seen is)
            expo = nt.nodes.new('ShaderNodeGroup')
            expo.node_tree = globals_group()
            mul = nt.nodes.new('ShaderNodeVectorMath')
            mul.operation = 'SCALE'
            nt.links.new(env.outputs['Color'], mul.inputs[0])
            nt.links.new(expo.outputs['Exposure'], mul.inputs['Scale'])
            nt.links.new(mul.outputs[0], bg.inputs['Color'])
        else:
            bg.inputs['Color'].default_value = (0, 0, 0, 1)
        # (seen, never a light: the projected light alone lights diffuse parts)
        path = nt.nodes.new('ShaderNodeLightPath')
        nt.links.new(path.outputs['Is Camera Ray'], bg.inputs['Strength'])
        sky.world = world
        for key in ('map', 'props'):
            inst = bpy.data.objects.new(f'skybox {key}', None)
            inst.instance_type = 'COLLECTION'
            inst.instance_collection = self.cols[key]
            inst['p2_sky'] = 1.0
            sky.collection.objects.link(inst)
        cams = bpy.data.collections.new('skybox camera')
        sky.collection.children.link(cams)
        sky.camera = self.camera('P2 Skybox Eyes', sc['track'], cams)
        fog = sc.get('fog')
        tree = globals_group()
        if fog:
            c = fog['color']  # (linear, as the viewer holds it)
            for node, val in (('Sky Fog R', c[0]), ('Sky Fog G', c[1]), ('Sky Fog B', c[2]),
                              ('Sky Fog Start', fog['start'] * self.S), ('Sky Fog End', fog['end'] * self.S)):
                tree.nodes[node].outputs[0].default_value = val
        else:
            # (no fog in the skybox: pushed out of reach)
            tree.nodes['Sky Fog Start'].outputs[0].default_value = 1e9
            tree.nodes['Sky Fog End'].outputs[0].default_value = 2e9
        main.render.film_transparent = True
        self.sky = sky

    def copy_render(self, main, other):
        other.frame_start, other.frame_end = main.frame_start, main.frame_end
        other.render.fps = main.render.fps
        other.render.resolution_x, other.render.resolution_y = main.render.resolution_x, main.render.resolution_y
        other.render.resolution_percentage = main.render.resolution_percentage
        self.render_settings(other)
        other.view_settings.view_transform = 'Standard'
        other.view_settings.look = 'None'

    # ---- scene settings ----

    def setup_scene(self, scene, frames):
        b = self.b
        scene.frame_start = 1
        scene.frame_end = frames
        scene.frame_current = 1
        fps = b['fps']
        scene.render.fps = fps
        scene.render.fps_base = 1
        # (played back at the run's own speed, frames dropped if need be)
        scene.sync_mode = 'FRAME_DROP'
        scene.render.resolution_x = b['width']
        scene.render.resolution_y = b['height']
        scene.render.resolution_percentage = 100
        self.render_settings(scene)
        # (the viewer's final pass: exposure, clamp, sRGB, no curve)
        vs = scene.view_settings
        scene.display_settings.display_device = 'sRGB'
        vs.view_transform = 'Standard'
        vs.look = 'None'
        vs.gamma = 1.0
        vs.exposure = 0.0
        world = bpy.data.worlds.new('P2 void')
        world.use_nodes = True
        bg = world.node_tree.nodes.get('Background')
        bg.inputs['Color'].default_value = (0, 0, 0, 1)
        bg.inputs['Strength'].default_value = 0
        scene.world = world

    def render_settings(self, scene):
        scene.render.engine = 'CYCLES' if self.engine == 'CYCLES' else 'BLENDER_EEVEE_NEXT'
        c = scene.cycles
        c.samples = self.samples
        c.use_denoising = False
        c.use_adaptive_sampling = False
        # (everything is emission: no light is gathered, only seen)
        c.max_bounces = 0
        c.diffuse_bounces = 0
        c.glossy_bounces = 0
        c.transmission_bounces = 0
        c.volume_bounces = 0
        c.transparent_max_bounces = 64
        c.caustics_reflective = False
        c.caustics_refractive = False
        c.use_light_tree = False
        c.filter_width = 1.0
        c.pixel_filter_type = 'BOX'
        try:
            prefs = bpy.context.preferences.addons['cycles'].preferences
            if prefs.compute_device_type != 'NONE':
                c.device = 'GPU'
        except (KeyError, AttributeError):
            pass
        e = scene.eevee
        e.taa_render_samples = self.samples
        try:
            e.use_raytracing = False
        except AttributeError:
            pass
        scene.render.film_transparent = False

    # ---- images ----

    def load_images(self):
        out = {}
        self.sequences = {}
        for t in self.b['textures']:
            if not t['file']:
                out[t['id']] = None
                continue
            path = os.path.join(self.b.dir, t['file'])
            try:
                img = bpy.data.images.load(path, check_existing=True)
            except RuntimeError:
                self.note(f'missing image {t["file"]}')
                out[t['id']] = None
                continue
            img.colorspace_settings.name = 'sRGB' if t['colorspace'] == 'srgb' else 'Non-Color'
            img.alpha_mode = 'CHANNEL_PACKED'
            if t.get('sequence'):
                # (pictures 0001.png on: shown by frame, see sequences)
                img.source = 'SEQUENCE'
                self.sequences[img.name] = t['sequence']
            out[t['id']] = img
        return out

    def sequences_play(self):
        """Each changing texture (movie screens, gel) shows its picture of the
        frame: picture k from the frame it was taken to the next one's. The
        picture shown is frame + offset, so the offset is keyed to fall by
        one a frame within each picture's frames."""
        if not self.sequences:
            return
        total = self.b['frames'] + 1
        for tree in [m.node_tree for m in bpy.data.materials if m.node_tree] + list(bpy.data.node_groups):
            for node in tree.nodes:
                if node.bl_idname not in ('ShaderNodeTexImage', 'ShaderNodeTexEnvironment') or node.image is None:
                    continue
                seq = self.sequences.get(node.image.name)
                if seq is None:
                    continue
                iu = node.image_user
                iu.frame_start = 1
                iu.frame_duration = total + 1
                iu.use_cyclic = False
                iu.use_auto_refresh = True
                k = self.b.view(seq['keys']).reshape(-1, 2)
                frames, values = [], []
                for i, (f, idx) in enumerate(k):
                    end = k[i + 1][0] - 1 if i + 1 < len(k) else total - 1
                    # (Blender frame f + 1 shows picture idx + 1: offset idx - f)
                    frames += [f, max(f, end)]
                    values += [idx - f, idx - max(f, end)]
                keys(tree, f'nodes["{node.name}"].image_user.frame_offset', np.array(frames, dtype=np.float64), np.array(values, dtype=np.float32), 'LINEAR', name=f'{tree.name} pictures')

    # ---- frame-wide values ----

    def globals(self):
        b = self.b
        tree = globals_group()
        frames, v = b.track(b['globals']['track'])
        layout = b['globals']['layout']
        col = {name: v[:, i] for i, name in enumerate(layout)}
        nodes = tree.nodes

        def animate(node, values, scale=1.0):
            values = np.asarray(values, dtype=np.float64) * scale
            if len(frames) == 1:
                nodes[node].outputs[0].default_value = float(values[0])
                return
            keys(tree, f'nodes["{node}"].outputs[0].default_value', frames, values, 'LINEAR', name='P2 Globals')
        animate('Exposure', col['exposure'])
        animate('Ambient R', col['ambientR'])
        animate('Ambient G', col['ambientG'])
        animate('Ambient B', col['ambientB'])
        # (the exposure is in the materials: see MaterialBuilder.exposure)
        ff, fv = b.track(b['fog']['track'])
        frames = ff
        for i, node in enumerate(('Fog R', 'Fog G', 'Fog B')):
            animate(node, fv[:, i])
        animate('Fog Start', fv[:, 3], self.S)
        animate('Fog End', fv[:, 4], self.S)
        animate('Fog Density', fv[:, 5])
        self.fades = b.track(b['globals']['track'])

    # ---- meshes ----

    def mesh(self, gid, mid, offset=False):
        key = (gid, mid)
        me = self.meshes.get(key)
        if me is not None:
            return me
        g = self.b['geometries'][gid]
        b = self.b
        attrs = g['attributes']

        def attr(name):
            a = attrs.get(name)
            return b.view(a['view']).reshape(-1, a['size']) if a else None
        pos = attr('position').astype(np.float64) * self.S
        normal = attr('normal')
        if normal is not None:
            normal = normal.astype(np.float32)
        count = g['count']
        if g.get('index'):
            idx = b.view(g['index']).astype(np.int64)
        else:
            idx = np.arange(count, dtype=np.int64)
        if g.get('drawRange'):
            start, n = g['drawRange']
            idx = idx[start:start + n] if n is not None and n >= 0 else idx[start:]
        idx = idx[:len(idx) - len(idx) % 3]
        tris = idx.reshape(-1, 3)
        # (Blender takes no faces with a corner twice)
        ok = (tris[:, 0] != tris[:, 1]) & (tris[:, 1] != tris[:, 2]) & (tris[:, 0] != tris[:, 2])
        tris = tris[ok]
        if normal is not None:
            tris = wound_by_normals(tris, pos, normal)
        idx = tris.ravel()
        if offset and normal is not None:
            # (overlays lie on the faces they mark: lifted off them a little)
            pos = pos + normal.astype(np.float64) * 0.1 * self.S
        me = bpy.data.meshes.new(f'g{gid}')
        me.vertices.add(count)
        me.vertices.foreach_set('co', pos.astype(np.float32).ravel())
        me.loops.add(len(idx))
        me.loops.foreach_set('vertex_index', idx.astype(np.int32))
        me.polygons.add(len(tris))
        me.polygons.foreach_set('loop_start', np.arange(0, len(idx), 3, dtype=np.int32))
        me.update(calc_edges=True)
        set_attributes(me, {name: attr(name) for name in attrs if name != 'position'}, idx, count)
        mat = self.mats.get(mid) if mid is not None else None
        if mat:
            me.materials.append(mat)
        self.meshes[key] = me
        return me

    # ---- objects ----

    def objects(self):
        b = self.b
        frames_total = b['frames']
        for rec in b['objects']:
            mid = rec['material']
            desc = b['materials'][mid]
            vf, vv = b.track(rec['visible'])
            if not (vv > 0.5).any():
                continue
            cube = None
            if rec.get('cube'):
                cf, cv = b.track(rec['cube'])
                vals, counts = np.unique(cv[:, 0], return_counts=True)
                best = int(vals[np.argmax(counts)])
                cube = best if best >= 0 else None
            if cube is not None or desc['kind'] == 'model' and desc.get('envPerObject'):
                me = self.mesh_with(rec['geometry'], mid, cube, desc)
            else:
                me = self.mesh(rec['geometry'], mid, offset=bool(desc.get('offset')))
            obj = bpy.data.objects.new(rec['name'][:60], me)
            tf, tv = b.track(rec['transform'])
            moving = len(tf) > 1
            always = len(vf) == 1 and vv[0, 0] > 0.5
            col = self.layer_collection(rec['scene'], rec.get('group', 'entities'))
            col.objects.link(obj)
            # (what casts shadows from the projected light: the solid scene,
            # not glass, effects or the sky, as the viewer's shadow pass)
            if desc.get('blend', 'opaque') not in ('opaque', 'clip') or desc['kind'] in ('shader', 'skymask') or rec.get('group') == 'effects':
                obj.visible_shadow = False
            obj.rotation_mode = 'QUATERNION'
            loc = tv[:, 0:3] * self.S
            obj.location = loc[0]
            obj.rotation_quaternion = tv[0, 3:7]
            obj.scale = tv[0, 7:10]
            if moving:
                key_vectors(obj, 'location', tf, loc)
                key_vectors(obj, 'rotation_quaternion', tf, tv[:, 3:7])
                key_vectors(obj, 'scale', tf, tv[:, 7:10])
            if not always:
                hide = (vv[:, 0] < 0.5).astype(np.float32)
                keys(obj, 'hide_render', vf, hide, 'CONSTANT')
                keys(obj, 'hide_viewport', vf, hide, 'CONSTANT')
                obj.hide_render = bool(hide[0])
            if rec.get('lighting'):
                self.lighting(obj, rec['lighting'])
            if rec.get('uniforms'):
                self.uniforms(obj, rec['uniforms'], desc)
            if rec.get('portal'):
                self.portal(obj, rec['portal'])
            if 'ropeTangent' in b['geometries'][rec['geometry']]['attributes']:
                # (a rope that holds still: its ribbon still turns to the camera)
                obj.modifiers.new('Rope', 'NODES').node_group = rope_group(self.S)
            if rec.get('skeleton') is not None:
                arm = self.armature(rec['skeleton'], col)
                self.skin(obj, rec['geometry'], arm)

    def layer_collection(self, layer, group):
        if layer == 'vm':
            return self.cols['viewmodel']
        if layer == 'overlay':
            return self.cols['overlay']
        return self.cols[group]

    def mesh_with(self, gid, mid, cube, desc):
        key = (gid, mid, cube)
        me = self.meshes.get(key)
        if me is None:
            base = self.mesh(gid, mid, offset=bool(desc.get('offset')))
            me = base.copy()
            me.materials.clear()
            me.materials.append(self.mats.get(mid, cube))
            self.meshes[key] = me
        return me

    def lighting(self, obj, track):
        """A lit model's ambient cube and lights as keyframed properties (read
        by the P2 Model Light node group)."""
        frames, v = self.b.track(track)
        S = self.S
        props = [(f'p2_c{i}', v[:, i * 3:i * 3 + 3]) for i in range(6)]
        for i in range(3):
            base = 18 + i * 9
            props.append((f'p2_l{i}p', v[:, base:base + 3] * S))
            props.append((f'p2_l{i}c', v[:, base + 3:base + 6]))
            # (falloff by distance in Blender's units)
            a = v[:, base + 6:base + 9] / np.array([1.0, S, S * S])
            props.append((f'p2_l{i}a', a))
        # For Eevee, which reads at most 8 object properties a material: the
        # lights folded into the cube at the point the viewer lit it from
        # (each face takes a light by how far it faces it), p2_e0..5
        cube = v[:, :18].reshape(-1, 6, 3).copy()
        at = v[:, 45:48] if v.shape[1] >= 48 else None
        if at is not None:
            axes = np.array([[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]], dtype=np.float64)
            for i in range(3):
                base = 18 + i * 9
                to = v[:, base:base + 3] - at
                d = np.linalg.norm(to, axis=1)
                l = to / np.maximum(d, 1e-6)[:, None]
                ax, ay, az = v[:, base + 6], v[:, base + 7], v[:, base + 8]
                att = 1.0 / np.maximum(ax + ay * d + az * d * d, 1e-3)
                c = v[:, base + 3:base + 6] * att[:, None]
                cube += np.maximum(l @ axes.T, 0.0)[:, :, None] * c[:, None, :]
        props += [(f'p2_e{i}', cube[:, i]) for i in range(6)]
        for name, vals in props:
            obj[name] = [float(x) for x in vals[0]]
            if len(frames) > 1:
                key_vectors(obj, f'["{name}"]', frames, vals)

    def uniforms(self, obj, u, desc):
        """An effect shader's settings that change during the part (the
        material's `animated` ones; the rest are its constants), four to a
        property u_pk<j>, keyframed (read by the effect node trees: Eevee
        reads at most 8 object properties a material)."""
        animated = set(desc.get('animated', []))
        if not animated:
            return
        frames, v = self.b.track(u['track'])
        cols, col = [], 0
        for name, size in u['layout']:
            if name in animated:
                cols += range(col, col + size)
            col += size
        for j in range(0, len(cols), 4):
            part = v[:, cols[j:j + 4]]
            vals = np.zeros((len(frames), 4))
            vals[:, :part.shape[1]] = part
            prop = f'u_pk{j // 4}'
            obj[prop] = [float(x) for x in vals[0]]
            if len(frames) > 1:
                key_vectors(obj, f'["{prop}"]', frames, vals)

    def portal(self, obj, track):
        """Where a portal leads (its partner's side, as a 3 x 4 matrix in
        Blender's units) and whether it's linked."""
        frames, v = self.b.track(track)
        v = v.copy()
        v[:, [3, 7, 11]] *= self.S
        # (rows of the matrix with their translation, p2_pr0..2, and p2_plink)
        for r in range(3):
            obj[f'p2_pr{r}'] = [float(x) for x in v[0, r * 4:r * 4 + 4]]
            if len(frames) > 1 and np.ptp(v[:, r * 4:r * 4 + 4]) > 0:
                key_vectors(obj, f'["p2_pr{r}"]', frames, v[:, r * 4:r * 4 + 4])
        obj['p2_plink'] = float(v[0, 12])
        if len(frames) > 1 and np.ptp(v[:, 12]) > 0:
            keys(obj, '["p2_plink"]', frames, v[:, 12], 'CONSTANT')

    # ---- geometry remade every frame ----

    def dynamics(self):
        b = self.b
        for d in b.scene.get('dynamics', []):
            spans = b.view(d['spans']).reshape(-1, 5).astype(np.int64)
            if not len(spans):
                continue
            # (split so no one object holds too much: each shown only over its frames)
            limit = 600000
            chunk, start = [], 0
            groups = []
            for s in spans:
                if chunk and start + s[3] > limit:
                    groups.append(chunk)
                    chunk, start = [], 0
                chunk.append(s)
                start += s[3]
            if chunk:
                groups.append(chunk)
            for gi, group in enumerate(groups):
                self.dynamic_object(d, np.array(group), gi)

    def snapshot(self, d, span):
        """One state of a dynamic object: its attributes, read from its block
        (each attribute in turn, 4-byte aligned; positions floats, the rest
        half floats)."""
        count, at = int(span[3]), int(span[4])
        out = {}
        for name, size, kind in d['layout']:
            dtype = {'f32': np.float32, 'f16': np.float16}[kind]
            n = count * size
            out[name] = np.frombuffer(self.b.bin, dtype=dtype, count=n, offset=at).reshape(count, size).astype(np.float32)
            at += (n * np.dtype(dtype).itemsize + 3) // 4 * 4
        return out

    def dynamic_object(self, d, spans, part):
        S = self.S
        quads = bool(d.get('quads'))
        per = 4 if quads else 3
        blocks = [self.snapshot(d, s) for s in spans]
        attrs = {name: np.concatenate([bl[name] for bl in blocks]) for name, _, _ in d['layout']}
        n = len(attrs['position'])
        n -= n % per
        if not n:
            return
        me = bpy.data.meshes.new(f'dyn{d["id"]}_{part}')
        me.vertices.add(n)
        me.vertices.foreach_set('co', (attrs['position'][:n].astype(np.float64) * S).astype(np.float32).ravel())
        me.loops.add(n)
        me.loops.foreach_set('vertex_index', np.arange(n, dtype=np.int32))
        me.polygons.add(n // per)
        me.polygons.foreach_set('loop_start', np.arange(0, n, per, dtype=np.int32))
        me.update(calc_edges=True)
        # the frames each face shows over
        frm = np.concatenate([np.full(s[3] // per, s[0]) for s in spans])[:n // per]
        to = np.concatenate([np.full(s[3] // per, s[1]) for s in spans])[:n // per]
        for name, vals in (('p2_from', frm), ('p2_to', to)):
            a = me.attributes.new(name, 'INT', 'FACE')
            a.data.foreach_set('value', vals.astype(np.int32))
        set_attributes(me, {name: a[:n] for name, a in attrs.items() if name != 'position'}, np.arange(n), n)
        me.materials.append(self.mats.get(d['material']))
        obj = bpy.data.objects.new(f'{d["name"][:50]} (frames)', me)
        self.layer_collection(d['scene'], d.get('group', 'effects')).objects.link(obj)
        obj.visible_shadow = False
        if 'ropeTangent' in attrs and 'ropeSide' in attrs:
            mod = obj.modifiers.new('Rope', 'NODES')
            mod.node_group = rope_group(S)
        mod = obj.modifiers.new('Frames', 'NODES')
        mod.node_group = frame_filter_group()
        # (shown only over its frames: none of its faces outside them anyway,
        # but hidden objects aren't evaluated)
        first, last = int(spans[:, 0].min()), int(spans[:, 1].max())
        frames, hide = ([first - 1, first], [1.0, 0.0]) if first > 0 else ([0], [0.0])
        if last < self.b['frames']:
            frames.append(last)
            hide.append(1.0)
        if len(frames) > 1:
            keys(obj, 'hide_render', np.array(frames, dtype=np.float64), np.array(hide, dtype=np.float32), 'CONSTANT')
            keys(obj, 'hide_viewport', np.array(frames, dtype=np.float64), np.array(hide, dtype=np.float32), 'CONSTANT')
        if d.get('uniforms'):
            self.uniforms(obj, d['uniforms'], self.b['materials'][d['material']])

    # ---- armatures ----

    def armature(self, sid, col):
        arm = self.armatures.get(sid)
        if arm is not None:
            return arm
        sk = self.b['skeletons'][sid]
        data = bpy.data.armatures.new(f'skeleton{sid}')
        arm = bpy.data.objects.new(f'skeleton{sid}', data)
        col.objects.link(arm)
        self.armatures[sid] = arm
        S = self.S
        # bones at their bind pose (each unparented: the recording gives every
        # bone's place in the world each frame)
        view_layer = self.scene.view_layers[0]
        prev = view_layer.objects.active
        view_layer.objects.active = arm
        # (edit mode in this segment's scene, whichever the window shows)
        override = bpy.context.temp_override(scene=self.scene, view_layer=view_layer, active_object=arm, object=arm)
        override.__enter__()
        bpy.ops.object.mode_set(mode='EDIT')
        rests = []
        for i, bone in enumerate(sk['bones']):
            eb = data.edit_bones.new(bone['name'] or f'bone{i}')
            m = Matrix(np.array(bone['rest'], dtype=np.float64).reshape(4, 4).T.tolist())
            loc, rot, _ = m.decompose()
            eb.head = (0, 0, 0)
            eb.tail = (0, 2.0 * S, 0)
            eb.matrix = Matrix.LocRotScale(loc * S, rot, None)
            rests.append(eb.name)
        bpy.ops.object.mode_set(mode='OBJECT')
        override.__exit__(None, None, None)
        view_layer.objects.active = prev
        arm.data.display_type = 'STICK'
        arm.show_in_front = False
        arm.hide_render = True
        # the pose each frame: matrix_basis = rest^-1 @ world
        frames, v = self.b.track(sk['pose'])
        nb = len(sk['bones'])
        v = v.reshape(len(frames), nb, 10)
        for i, name in enumerate(rests):
            pb = arm.pose.bones[name]
            pb.rotation_mode = 'QUATERNION'
            rest_inv = np.array(arm.data.bones[name].matrix_local.inverted(), dtype=np.float64)
            world = compose(v[:, i, 0:3] * S, v[:, i, 3:7], v[:, i, 7:10])
            basis = rest_inv[None, :, :] @ world
            loc, quat, scale = decompose(basis)
            pb.location = loc[0]
            pb.rotation_quaternion = quat[0]
            pb.scale = scale[0]
            if len(frames) > 1:
                group = name
                key_vectors(arm, f'pose.bones["{name}"].location', frames, loc, group=group)
                key_vectors(arm, f'pose.bones["{name}"].rotation_quaternion', frames, quat, group=group)
                key_vectors(arm, f'pose.bones["{name}"].scale', frames, scale, group=group)
        return arm

    def skin(self, obj, gid, arm):
        g = self.b['geometries'][gid]
        a_idx, a_w = g['attributes'].get('skinIndex'), g['attributes'].get('skinWeight')
        if not a_idx or not a_w:
            return
        index = self.b.view(a_idx['view']).reshape(-1, a_idx['size']).astype(np.int64)
        weight = self.b.view(a_w['view']).reshape(-1, a_w['size'])
        groups = {}
        for k in range(index.shape[1]):
            for vi in np.nonzero(weight[:, k] > 0)[0]:
                bi = int(index[vi, k])
                name = arm.data.bones[bi].name if bi < len(arm.data.bones) else None
                if name is None:
                    continue
                vg = groups.get(bi)
                if vg is None:
                    vg = groups[bi] = obj.vertex_groups.get(name) or obj.vertex_groups.new(name=name)
                vg.add([int(vi)], float(weight[vi, k]), 'ADD')
        mod = obj.modifiers.new('Armature', 'ARMATURE')
        mod.object = arm
        obj.location = (0, 0, 0)
        obj.rotation_quaternion = (1, 0, 0, 0)
        obj.scale = (1, 1, 1)

    # ---- cameras ----

    def camera(self, name, track, col, sensor_h=24.0):
        frames, v = self.b.track(track)
        data = bpy.data.cameras.new(name)
        data.sensor_fit = 'VERTICAL'
        data.sensor_height = sensor_h
        cam = bpy.data.objects.new(name, data)
        col.objects.link(cam)
        cam.rotation_mode = 'QUATERNION'
        loc = v[:, 0:3] * self.S
        cam.location = loc[0]
        cam.rotation_quaternion = v[0, 3:7]
        fov = np.radians(v[:, 10])
        lens = (sensor_h / 2) / np.tan(fov / 2)
        data.lens = float(lens[0])
        data.clip_start = float(v[0, 11]) * self.S
        data.clip_end = float(v[0, 12]) * self.S
        if len(frames) > 1:
            key_vectors(cam, 'location', frames, loc)
            key_vectors(cam, 'rotation_quaternion', frames, v[:, 3:7])
            keys(data, 'lens', frames, lens)
            keys(data, 'clip_start', frames, v[:, 11] * self.S)
        return cam

    def cameras(self, scene):
        self.cam = self.camera('P2 Eyes', self.b['camera'], self.cols['cameras'])
        scene.camera = self.cam

    def viewmodel_scene(self, context):
        """The view model, drawn as the game does: over the world, with its own
        field of view; a scene of its own, layered on in the compositor."""
        vm_objs = list(self.cols['viewmodel'].objects)
        self.vm_scene = None
        if not vm_objs:
            return
        main = self.scene
        vm = bpy.data.scenes.new(f'{main.name} viewmodel')
        self.copy_render(main, vm)
        vm.render.film_transparent = True
        vm.world = main.world
        # (moved out of the main scene)
        self.root.children.unlink(self.cols['viewmodel'])
        vm.collection.children.link(self.cols['viewmodel'])
        cams = bpy.data.collections.new('viewmodel camera')
        vm.collection.children.link(cams)
        light = bpy.data.objects.get('P2 Projected Light')
        if light is not None:
            cams.objects.link(light)
        vm.camera = self.camera('P2 Viewmodel Eyes', self.b['vmCamera'], cams)
        self.vm_scene = vm

    def flash(self):
        """The projected light (env_projectedtexture), as the viewer draws it:
        its cookie projected from it, its colour, a linear falloff
        (100 / distance, at most 1), faded out towards its far plane, N.L and
        shadows (here ray traced: Cycles). The materials take it through a
        diffuse part (MaterialBuilder.finish); its strength makes that
        albedo x 1.5 x the light, as the viewer adds it."""
        fl = self.b.scene.get('flash')
        if not fl or not self.projected_light:
            return
        frames, v = self.b.track(fl['track'])
        col = {name: v[:, i] for i, name in enumerate(fl['layout'])}
        on = col['on'] > 0.5
        if not on.any():
            return
        S = self.S
        first = int(np.argmax(on))
        data = bpy.data.lights.new('P2 Projected Light', 'SPOT')
        data.spot_blend = 0.0
        data.shadow_soft_size = 1.0 * S
        data.energy = 1.0
        data.use_shadow = bool(col['shadows'][first] > 0.5)
        data.use_nodes = True
        nt = data.node_tree
        nt.nodes.clear()
        g = Graph(nt)
        # (the direction from the light, in its own space: -z ahead, y up)
        d = g.node('ShaderNodeTexCoord').outputs['Normal']
        dx, dy, dz = g.xyz(d)
        fov = g.value(float(col['fov'][first]), 'FOV')
        t = g.math('TANGENT', g.mul(fov, math.pi / 360))
        ahead = g.max(g.mul(dz, -1.0), 1e-6)
        u = g.add(g.mul(g.div(g.div(dx, ahead), t), 0.5), 0.5)
        vv = g.add(g.mul(g.div(g.div(dy, ahead), t), 0.5), 0.5)
        img = self.images.get(fl['cookie'])
        cookie = (1, 1, 1)
        if img is not None:
            cookie, _ = g.image(img, g.vec(u, g.sub(1.0, vv), 0.0), extension='CLIP')
        color = g.vec(g.value(float(col['r'][first]), 'R'), g.value(float(col['g'][first]), 'G'), g.value(float(col['b'][first]), 'B'))
        fall = g.node('ShaderNodeLightFalloff', {'Strength': 1.0})
        dist, dist2 = fall.outputs['Linear'], fall.outputs['Constant']
        far = g.value(float(col['far'][first]), 'Far')
        d_src = g.div(dist, S)
        fade = g.sat(g.div(g.sub(d_src, far), g.mul(far, -0.4)))
        # (atten x d^2: min(100 / d, 1) in game units, d^2 undoing Cycles' own falloff)
        atten = g.min(g.mul(100.0 * S, dist), dist2)
        strength = g.mul(g.mul(fade, atten), 6.0 * math.pi * math.pi)
        emit = g.node('ShaderNodeEmission', {'Color': g.vmul(cookie, color), 'Strength': strength})
        out = g.node('ShaderNodeOutputLight')
        g.link(emit.outputs[0], out.inputs['Surface'])
        light = bpy.data.objects.new('P2 Projected Light', data)
        self.cols['cameras'].objects.link(light)
        light.rotation_mode = 'QUATERNION'
        loc = np.stack([col['x'], col['y'], col['z']], axis=1) * S
        quat = np.stack([col['qw'], col['qx'], col['qy'], col['qz']], axis=1)
        light.location = loc[first]
        light.rotation_quaternion = quat[first]
        # (its cone wide enough for the square frustum's corners)
        spot = 2 * np.arctan(np.tan(np.radians(col['fov']) / 2) * math.sqrt(2))
        data.spot_size = float(spot[first])
        if len(frames) > 1:
            # (where it's off, it holds its last place)
            idx = np.maximum.accumulate(np.where(on, np.arange(len(on)), 0))
            key_vectors(light, 'location', frames, loc[idx])
            key_vectors(light, 'rotation_quaternion', frames, quat[idx])
            keys(data, 'energy', frames, on.astype(np.float32), 'CONSTANT')
            for name, node in (('fov', 'FOV'), ('far', 'Far'), ('r', 'R'), ('g', 'G'), ('b', 'B')):
                vals = col[name][idx]
                if np.ptp(vals) > 0:
                    keys(nt, f'nodes["{node}"].outputs[0].default_value', frames, vals, 'LINEAR', name='P2 Projected Light nodes')
            if np.ptp(spot[idx]) > 0:
                keys(data, 'spot_size', frames, spot[idx])

    def overlay_scene(self):
        """What the viewer draws over everything without depth (glows): a
        scene of its own with the eyes' camera, layered over the world."""
        self.overlay = None
        if not len(self.cols['overlay'].objects):
            self.root.children.unlink(self.cols['overlay'])
            return
        main = self.scene
        ov = bpy.data.scenes.new(f'{main.name} overlay')
        self.copy_render(main, ov)
        ov.render.film_transparent = True
        ov.world = main.world
        self.root.children.unlink(self.cols['overlay'])
        ov.collection.children.link(self.cols['overlay'])
        cams = bpy.data.collections.new('overlay camera')
        ov.collection.children.link(cams)
        cams.objects.link(self.cam)
        ov.camera = self.cam
        self.overlay = ov

    def compositor(self, scene):
        frames, v = self.fades
        layout = self.b['globals']['layout']
        values = {name: v[:, i].astype(np.float64) for i, name in enumerate(layout)}
        compositor.build(scene, (scene, self.vm_scene, self.sky, self.overlay), frames, values, keys)


def wound_by_normals(tris, pos, normal):
    """Triangles turned to face where their vertex normals do. Models come
    wound either way (the viewer draws them double-sided), but Cycles judges
    a face's front by its winding and turns the shading normal round on the
    back: a model wound inside out would be lit from behind."""
    a, b, c = pos[tris[:, 0]], pos[tris[:, 1]], pos[tris[:, 2]]
    face = np.cross(b - a, c - a)
    vn = normal[tris[:, 0]] + normal[tris[:, 1]] + normal[tris[:, 2]]
    flip = np.einsum('ij,ij->i', face, vn) < 0
    if flip.any():
        tris = tris.copy()
        tris[flip] = tris[flip][:, [0, 2, 1]]
    return tris


UV_LAYERS = {'uv': 'UVMap', 'uv1': 'Lightmap', 'uv2': 'UV2'}
SKIP = {'position', 'skinIndex', 'skinWeight'}


def set_attributes(me, attrs, corners, count):
    """A mesh's attributes, by the viewer's names: uv layers (v turned up),
    colours (color -> Col), normals (custom), the rest as they are.
    `corners`: the vertex of each face corner."""
    for name, vals in attrs.items():
        if vals is None or name in SKIP:
            continue
        size = vals.shape[1]
        if name in UV_LAYERS:
            layer = me.uv_layers.new(name=UV_LAYERS[name])
            per = vals[corners].astype(np.float32).copy()
            # (images are upside down to Blender: its v runs up)
            per[:, 1] = 1.0 - per[:, 1]
            layer.data.foreach_set('uv', per.ravel())
        elif name == 'normal':
            me.shade_smooth()
            n = vals[corners].astype(np.float32)
            lens = np.linalg.norm(n, axis=1, keepdims=True)
            n = np.where(lens > 1e-8, n / np.maximum(lens, 1e-8), np.array([0, 0, 1], dtype=np.float32))
            me.normals_split_custom_set(n.tolist())
        elif name in ('color', 'pcolor') and size in (3, 4):
            ca = me.color_attributes.new('Col' if name == 'color' else name, 'FLOAT_COLOR', 'POINT')
            rgba = np.ones((count, 4), dtype=np.float32)
            rgba[:, :size] = vals[:count]
            ca.data.foreach_set('color', rgba.ravel())
        else:
            kind = {1: 'FLOAT', 2: 'FLOAT2', 3: 'FLOAT_VECTOR', 4: 'FLOAT_COLOR'}.get(size)
            if not kind:
                continue
            field = {'FLOAT': 'value', 'FLOAT2': 'vector', 'FLOAT_VECTOR': 'vector', 'FLOAT_COLOR': 'color'}[kind]
            at = me.attributes.new(name, kind, 'POINT')
            at.data.foreach_set(field, vals[:count].astype(np.float32).ravel())


def compose(loc, quat, scale):
    """(n,3), (n,4 wxyz), (n,3) -> (n,4,4)"""
    w, x, y, z = quat[:, 0], quat[:, 1], quat[:, 2], quat[:, 3]
    n = len(loc)
    m = np.zeros((n, 4, 4))
    m[:, 0, 0] = 1 - 2 * (y * y + z * z)
    m[:, 0, 1] = 2 * (x * y - z * w)
    m[:, 0, 2] = 2 * (x * z + y * w)
    m[:, 1, 0] = 2 * (x * y + z * w)
    m[:, 1, 1] = 1 - 2 * (x * x + z * z)
    m[:, 1, 2] = 2 * (y * z - x * w)
    m[:, 2, 0] = 2 * (x * z - y * w)
    m[:, 2, 1] = 2 * (y * z + x * w)
    m[:, 2, 2] = 1 - 2 * (x * x + y * y)
    m[:, :3, :3] *= scale[:, None, :]
    m[:, :3, 3] = loc
    m[:, 3, 3] = 1
    return m


def decompose(m):
    """(n,4,4) -> loc (n,3), quat (n,4 wxyz, continuous), scale (n,3)"""
    loc = m[:, :3, 3].copy()
    r = m[:, :3, :3]
    scale = np.linalg.norm(r, axis=1)
    r = r / np.maximum(scale[:, None, :], 1e-12)
    quat = np.empty((len(m), 4))
    for i in range(len(m)):
        q = Matrix(r[i].tolist()).to_quaternion()
        quat[i] = (q.w, q.x, q.y, q.z)
    for i in range(1, len(quat)):
        if np.dot(quat[i], quat[i - 1]) < 0:
            quat[i] = -quat[i]
    return loc, quat, scale


def load(context, path, **options):
    """A segment's bundle (scene.json), or a whole run (run.json)."""
    if os.path.basename(path).lower() == 'run.json':
        return load_run(context, path, **options)
    imp = Importer(path, **options)
    imp.run(context)
    return imp


def load_run(context, path, **options):
    """A whole run: each segment (one map's part) a scene of its own, and a
    scene "Run" whose sequencer plays them one after another, as the run went:
    play or render that one."""
    with open(path, 'r', encoding='utf-8') as f:
        run = json.load(f)
    base = os.path.dirname(path)
    master = context.scene
    imports = []
    for i, seg in enumerate(run['segments']):
        scene = bpy.data.scenes.new(f'segment {i + 1}')
        imp = Importer(os.path.join(base, seg['dir'], 'scene.json'), **options)
        imp.run(context, scene=scene, tag=f'{i + 1:02d}')
        imports.append(imp)
    master.name = f'Run {run.get("demo", "")}'.strip()
    first = imports[0].scene
    master.render.fps = first.render.fps
    master.render.fps_base = 1
    master.render.resolution_x, master.render.resolution_y = first.render.resolution_x, first.render.resolution_y
    master.render.resolution_percentage = 100
    master.display_settings.display_device = 'sRGB'
    master.view_settings.view_transform = 'Standard'
    master.view_settings.look = 'None'
    master.view_settings.exposure = 0.0
    master.render.use_sequencer = True
    master.render.use_compositing = False
    master.sync_mode = 'FRAME_DROP'
    edit = master.sequence_editor_create()
    strips = getattr(edit, 'strips', None) or edit.sequences
    frame = 1
    for imp in imports:
        sc = imp.scene
        strip = strips.new_scene(name=sc.name, scene=sc, channel=1, frame_start=frame)
        frame += sc.frame_end - sc.frame_start + 1
    master.frame_start = 1
    master.frame_end = frame - 1
    master.frame_current = 1
    if context.window is not None:
        context.window.scene = master
    return imports
