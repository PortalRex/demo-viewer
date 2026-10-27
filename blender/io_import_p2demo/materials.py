# Materials as the viewer draws them (sar-web src/ui/shaderhooks.ts and
# view3d's MaterialLibrary), rebuilt as node trees. Everything ends in an
# Emission shader: the world is lit by its baked light maps, models by their
# ambient cubes and local lights, as the game lights them, so no Blender
# lights are involved and Eevee and Cycles draw the same picture. The frame
# is linear and unexposed, as the viewer's is; the scene's exposure and the
# Standard view transform do the rest.
import math
import bpy

from .nodes import Graph

# vrad's bump basis (LightmappedGeneric)
BUMP_BASIS = (
    (0.81649658, 0.0, 0.57735027),
    (-0.40824830, 0.70710678, 0.57735027),
    (-0.40824830, -0.70710678, 0.57735027),
)

# (each imported segment has its own: their values are keyframed per segment)
GLOBALS = 'P2 Globals'
MODEL_LIGHT = 'P2 Model Light'


def name_groups(tag):
    """The shared groups' names for the segment being imported."""
    global GLOBALS, MODEL_LIGHT
    GLOBALS = f'P2 Globals {tag}'.strip()
    MODEL_LIGHT = f'P2 Model Light {tag}'.strip()


def globals_group():
    """Frame-wide values (keyframed by the importer): exposure, mat_ambient_light,
    the world's fog."""
    tree = bpy.data.node_groups.get(GLOBALS)
    if tree:
        return tree
    tree = bpy.data.node_groups.new(GLOBALS, 'ShaderNodeTree')
    outs = [('Exposure', 'NodeSocketFloat'), ('Ambient', 'NodeSocketVector'), ('Fog Color', 'NodeSocketVector'),
            ('Fog Start', 'NodeSocketFloat'), ('Fog End', 'NodeSocketFloat'), ('Fog Density', 'NodeSocketFloat'), ('Sky', 'NodeSocketFloat')]
    for name, kind in outs:
        tree.interface.new_socket(name, in_out='OUTPUT', socket_type=kind)
    g = Graph(tree)
    out = g.node('NodeGroupOutput')
    out.location = (600, 0)
    vals = {}
    for name in ('Exposure', 'Ambient R', 'Ambient G', 'Ambient B', 'Fog R', 'Fog G', 'Fog B', 'Fog Start', 'Fog End', 'Fog Density',
                 'Sky Fog R', 'Sky Fog G', 'Sky Fog B', 'Sky Fog Start', 'Sky Fog End'):
        vals[name] = g.value(1.0 if name == 'Exposure' else 0.0, label=name)
    # (in the 3D skybox's scene, its own fog: the objects there are instanced
    # by an empty that carries p2_sky = 1)
    sky = g.attr('p2_sky', kind='INSTANCER', out='Fac')
    fog = g.vmix(g.vec(vals['Fog R'], vals['Fog G'], vals['Fog B']), g.vec(vals['Sky Fog R'], vals['Sky Fog G'], vals['Sky Fog B']), sky)
    g.link(vals['Exposure'], out.inputs['Exposure'])
    g.link(g.vec(vals['Ambient R'], vals['Ambient G'], vals['Ambient B']), out.inputs['Ambient'])
    g.link(fog, out.inputs['Fog Color'])
    g.link(g.mixf(vals['Fog Start'], vals['Sky Fog Start'], sky), out.inputs['Fog Start'])
    g.link(g.mixf(vals['Fog End'], vals['Sky Fog End'], sky), out.inputs['Fog End'])
    # (the sky's fog has no density cap)
    g.link(g.mixf(vals['Fog Density'], 1.0, sky), out.inputs['Fog Density'])
    g.link(sky, out.inputs['Sky'])
    return tree


def outward_normal(g):
    """The surface's own normal, not turned to the viewer on its back: the
    viewer lights models (cube, lights, phong) by it from either side (Cycles
    and Eevee turn the shading normal round on back faces)."""
    geo = g.geometry()
    flip = g.sub(1.0, g.mul(geo.outputs['Backfacing'], 2.0))
    return g.vscale(g.norm(geo.outputs['Normal']), flip)


def viewer_back(g):
    """1 on the faces the viewer sees from behind: by the model's own
    winding, which the importer turned round on some faces (p2_wound)."""
    w = g.attr('p2_wound', 'GEOMETRY', 'Fac')
    return g.math('ABSOLUTE', g.sub(g.geometry().outputs['Backfacing'], w))


def model_light_eevee_group():
    """Eevee's model light: the cube with the lights folded in (p2_e0..5):
    6 object properties, where Eevee reads no more than 8."""
    name = MODEL_LIGHT + ' Eevee'
    tree = bpy.data.node_groups.get(name)
    if tree:
        return tree
    tree = bpy.data.node_groups.new(name, 'ShaderNodeTree')
    tree.interface.new_socket('Light', in_out='OUTPUT', socket_type='NodeSocketVector')
    g = Graph(tree)
    out = g.node('NodeGroupOutput')
    out.location = (1000, 0)
    n = outward_normal(g)
    amb = None
    for axis, comp in enumerate(g.xyz(n)):
        side = g.vmix(g.attr(f'p2_e{axis * 2 + 1}', 'OBJECT'), g.attr(f'p2_e{axis * 2}', 'OBJECT'), g.math('GREATER_THAN', comp, -1e-9))
        term = g.vscale(side, g.mul(comp, comp))
        amb = term if amb is None else g.vadd(amb, term)
    g.link(g.vadd(amb, g.node('ShaderNodeGroup', node_tree=globals_group()).outputs['Ambient']), out.inputs['Light'])
    return tree


def model_light_group(scale):
    """A moving model's light (AMBIENT_FRAGMENT): its ambient cube by the
    normal plus three local lights, each with its falloff, read from the
    object's keyframed properties; and their phong highlights."""
    tree = bpy.data.node_groups.get(MODEL_LIGHT)
    if tree:
        return tree
    tree = bpy.data.node_groups.new(MODEL_LIGHT, 'ShaderNodeTree')
    tree.interface.new_socket('Exponent', in_out='INPUT', socket_type='NodeSocketFloat').default_value = 10.0
    tree.interface.new_socket('Light', in_out='OUTPUT', socket_type='NodeSocketVector')
    tree.interface.new_socket('Specular', in_out='OUTPUT', socket_type='NodeSocketVector')
    g = Graph(tree)
    inp = g.node('NodeGroupInput')
    out = g.node('NodeGroupOutput')
    out.location = (1600, 0)
    geo = g.geometry()
    n = outward_normal(g)
    p = geo.outputs['Position']
    eye = g.norm(geo.outputs['Incoming'])
    nx, ny, nz = g.xyz(n)
    amb = None
    for axis, comp in enumerate((nx, ny, nz)):
        pos = g.attr(f'p2_c{axis * 2}', 'OBJECT')
        neg = g.attr(f'p2_c{axis * 2 + 1}', 'OBJECT')
        side = g.vmix(neg, pos, g.math('GREATER_THAN', comp, -1e-9))
        term = g.vscale(side, g.mul(comp, comp))
        amb = term if amb is None else g.vadd(amb, term)
    amb = g.vadd(amb, g.node('ShaderNodeGroup', node_tree=globals_group()).outputs['Ambient'])
    spec = None
    for i in range(3):
        lp = g.attr(f'p2_l{i}p', 'OBJECT')
        lc = g.attr(f'p2_l{i}c', 'OBJECT')
        la = g.attr(f'p2_l{i}a', 'OBJECT')
        to = g.vsub(lp, p)
        d = g.length(to)
        ax, ay, az = g.xyz(la)
        att = g.div(1.0, g.max(g.add(g.add(ax, g.mul(ay, d)), g.mul(az, g.mul(d, d))), 1e-3))
        at = g.vscale(lc, att)
        l = g.norm(to)
        ndl = g.max(g.dot(n, l), 0.0)
        amb = g.vadd(amb, g.vscale(at, ndl))
        h = g.norm(g.vadd(eye, l))
        s = g.mul(g.pow(g.sat(g.dot(n, h)), inp.outputs['Exponent']), g.math('SQRT', g.sat(g.dot(n, l))))
        term = g.vscale(at, s)
        spec = term if spec is None else g.vadd(spec, term)
    g.link(amb, out.inputs['Light'])
    g.link(spec, out.inputs['Specular'])
    return tree


class MaterialBuilder:
    def __init__(self, bundle, images, scale):
        self.bundle = bundle
        self.images = images  # texture id -> bpy image (or None)
        self.scale = scale
        self.cache = {}
        # the projected light (env_projectedtexture), when there is one: the
        # opaque materials take it as a real light (see Importer.flash)
        self.flash = False
        self._flash_albedo = None
        self._target, self._eevee = None, False

    def get(self, mid, cube=None):
        key = (mid, cube)
        m = self.cache.get(key)
        if m is None:
            desc = self.bundle['materials'][mid]
            m = self.cache[key] = self.build(desc, cube)
        return m

    def skymask(self, g):
        """The sky faces: where the sky shows. The 2D sky along the view, or
        with a 3D skybox, a hole the skybox scene shows through (and in that
        scene, instanced with p2_sky, the 2D sky again)."""
        sky = getattr(self, 'sky', None) or {}
        img = sky.get('image')
        if img is not None:
            view = g.vscale(g.geometry().outputs['Incoming'], -1.0)
            color = self.exposed(g, g.env(img, view))
        else:
            color = g.vec(0, 0, 0)
        emit = g.node('ShaderNodeEmission', {'Color': color, 'Strength': self.seen(g)}).outputs[0]
        if sky.get('skybox'):
            hole = g.node('ShaderNodeHoldout').outputs[0]
            in_sky = g.attr('p2_sky', kind='INSTANCER', out='Fac')
            shader = g.node('ShaderNodeMixShader', {0: in_sky, 1: hole, 2: emit}).outputs[0]
        else:
            shader = emit
        g.link(shader, g.out().inputs['Surface'])

    # ---- shared pieces ----

    def exposure(self, g):
        """The frame's exposure (keyframed in P2 Globals). It's applied here,
        to everything seen, rather than by the view transform: a segment then
        looks right in its own scene, in the run's sequencer and in the
        viewport alike."""
        if getattr(g, '_exposure', None) is None:
            g._exposure = g.node('ShaderNodeGroup', node_tree=globals_group()).outputs['Exposure']
        return g._exposure

    def exposed(self, g, color):
        return g.vscale(color, self.exposure(g))

    def seen(self, g):
        """How strongly a surface's colour shows: fully to the camera (and
        through glass and portals, which keep the ray a camera ray). With the
        projected light there are diffuse surfaces, and nothing but that light
        may light them: emission isn't a light here."""
        if not self.flash:
            return 1.0
        return g.node('ShaderNodeLightPath').outputs['Is Camera Ray']

    def tex(self, g, tid, uv='UVMap', ext='REPEAT'):
        img = self.images.get(tid) if tid is not None else None
        if img is None:
            return None, None
        return g.image(img, g.uv(uv), extension=ext)

    def fog(self, g, color, glob):
        dist = g.node('ShaderNodeCameraData').outputs['View Distance']
        span = g.max(g.sub(glob.outputs['Fog End'], glob.outputs['Fog Start']), 1e-3)
        f = g.min(glob.outputs['Fog Density'], g.sat(g.div(g.sub(dist, glob.outputs['Fog Start']), span)))
        return g.vmix(color, glob.outputs['Fog Color'], g.mul(f, f))

    def env(self, g, desc, env, light, base_alpha, bump_alpha, detail, cube_tid):
        """$envmap (ENV_FRAGMENT): the cube along the reflected view, by its mask,
        light scale, tint, contrast and saturation."""
        img = self.images.get(cube_tid) if cube_tid is not None else None
        if img is None:
            return None
        geo = g.geometry()
        refl = g.node('ShaderNodeTexCoord').outputs['Reflection']
        spec = g.vscale(g.env(img, refl), env.get('scale', 1.0))
        mask = None
        kind = env.get('mask', 'none')
        if kind == 'base' and base_alpha is not None:
            mask = base_alpha
        elif kind == 'bump' and bump_alpha is not None:
            mask = bump_alpha
        elif kind in ('texture', 'alpha'):
            c, a = self.tex(g, env.get('maskMap'))
            if c is not None:
                mask = a if kind == 'alpha' else g.xyz(c)[0]
        if detail is not None and detail.get('mode') == 7 and base_alpha is not None:
            dc, da = detail['texel']
            _, dg, db = g.xyz(dc)
            m7 = g.mul(2.0, g.mixf(dg, db, base_alpha))
            mask = m7 if mask is None else g.mul(mask, m7)
        # (models' by their own normal from either side, as the game's shaders
        # and the viewer's two-sided glass: grazing from behind)
        n = outward_normal(g) if desc.get('kind') == 'model' else g.norm(geo.outputs['Normal'])
        ndv = g.sat(g.dot(n, g.norm(geo.outputs['Incoming'])))
        if env.get('fresnel') and desc.get('phong'):
            fr = desc['phong']['fresnel']
            f = g.mul(g.sub(1.0, ndv), g.sub(1.0, ndv))
            lo = g.mixf(fr[0], fr[1], g.mul(2.0, f))
            hi = g.mixf(fr[1], fr[2], g.sub(g.mul(2.0, f), 1.0))
            fres = g.mixf(lo, hi, g.math('GREATER_THAN', f, 0.5))
            spec = g.vmix(spec, g.vscale(spec, fres), env['fresnel'])
        if env.get('lightScale'):
            spec = g.vmix(spec, g.vmul(spec, g.vsat(light)), env['lightScale'])
        if mask is not None:
            spec = g.vscale(spec, mask)
        spec = g.vmul(spec, env.get('tint', (1, 1, 1)))
        if env.get('contrast'):
            spec = g.vmix(spec, g.vmul(spec, spec), env['contrast'])
        sat = env.get('saturation', (1, 1, 1))
        if list(sat) != [1, 1, 1]:
            spec = g.vmix(g.splat(g.lum(spec)), spec, g.vec(*sat))
        if env.get('fresnelReflection', 1) != 1:
            spec = g.vscale(spec, g.mixf(env['fresnelReflection'], 1.0, g.pow(g.sub(1.0, ndv), 4.0)))
        refract = desc.get('refract') or {}
        if refract.get('refractEnv'):
            spec = g.vscale(spec, g.add(0.6, g.mul(0.4, g.sub(1.0, ndv))))
        return spec

    def finish(self, mat, g, desc, color, alpha):
        """The shader by how the viewer blends it, one-sided where it is."""
        blend = desc.get('blend', 'opaque')
        opacity = desc.get('opacity', 1.0)
        if alpha is not None and opacity != 1.0:
            alpha = g.mul(alpha, opacity)
        elif alpha is None and opacity != 1.0:
            alpha = g.value(opacity)
        ratio = color  # (what multiplying blends multiply by: not exposed)
        color = self.exposed(g, color)
        emit = g.node('ShaderNodeEmission', {'Color': color, 'Strength': self.seen(g)}).outputs[0]
        if self.flash and self._flash_albedo is not None and blend in ('opaque', 'clip'):
            # (the projected light, as the viewer adds it: albedo x 1.5 x its
            # light; the 1.5 is in the light)
            diffuse = g.node('ShaderNodeBsdfDiffuse', {'Color': self.exposed(g, self._flash_albedo)}).outputs[0]
            emit = g.node('ShaderNodeAddShader', {0: emit, 1: diffuse}).outputs[0]
        shader = emit
        transparent = False
        if blend == 'clip' and alpha is not None:
            keep = g.math('GREATER_THAN', alpha, desc.get('alphaTest', 0.5) - 1e-4)
            clear = g.node('ShaderNodeBsdfTransparent').outputs[0]
            shader = g.node('ShaderNodeMixShader', {0: keep, 1: clear, 2: emit}).outputs[0]
            transparent = True
        elif blend == 'blend':
            clear = g.node('ShaderNodeBsdfTransparent').outputs[0]
            shader = g.node('ShaderNodeMixShader', {0: alpha if alpha is not None else 1.0, 1: clear, 2: emit}).outputs[0]
            transparent = True
        elif blend == 'add':
            c = g.vscale(color, alpha) if alpha is not None else color
            emit = g.node('ShaderNodeEmission', {'Color': c, 'Strength': self.seen(g)}).outputs[0]
            clear = g.node('ShaderNodeBsdfTransparent').outputs[0]
            shader = g.node('ShaderNodeAddShader', {0: clear, 1: emit}).outputs[0]
            transparent = True
        elif blend == 'multiply':
            shader = g.node('ShaderNodeBsdfTransparent', {'Color': ratio}).outputs[0]
            transparent = True
        elif blend == 'modulate2x':
            shader = g.node('ShaderNodeBsdfTransparent', {'Color': g.vscale(ratio, 2.0)}).outputs[0]
            transparent = True
        elif blend == 'addAlphaBehind':
            behind = g.node('ShaderNodeBsdfTransparent', {'Color': g.splat(alpha) if alpha is not None else (1, 1, 1)}).outputs[0]
            shader = g.node('ShaderNodeAddShader', {0: behind, 1: emit}).outputs[0]
            transparent = True
        elif blend == 'premultiplied':
            behind = g.node('ShaderNodeBsdfTransparent', {'Color': g.splat(g.sub(1.0, alpha)) if alpha is not None else (0, 0, 0)}).outputs[0]
            shader = g.node('ShaderNodeAddShader', {0: behind, 1: emit}).outputs[0]
            transparent = True
        # one-sided faces: Cycles ignores backface culling, so their backs are
        # left clear. And shadows from the projected light are cast as the
        # viewer's light-facing depth pass draws them: by faces that face the
        # light, i.e. those a shadow ray (towards the light) meets from behind
        # (alpha-tested double-sided ones cast either way, by their alpha)
        back = viewer_back(g)
        front = g.sub(1.0, back)
        shadow_ray = g.node('ShaderNodeLightPath').outputs['Is Shadow Ray'] if self.flash else None
        clear_t = None
        if desc.get('side') == 'front':
            clear_t = g.mixf(back, front, shadow_ray) if shadow_ray is not None else back
            mat.use_backface_culling = True
        elif shadow_ray is not None and blend != 'clip':
            clear_t = g.mul(shadow_ray, front)
        if clear_t is not None:
            clear = g.node('ShaderNodeBsdfTransparent').outputs[0]
            shader = g.node('ShaderNodeMixShader', {0: clear_t, 1: shader, 2: clear}).outputs[0]
        if self._target is not None:
            # (a material drawn differently per engine: this one's output)
            out = g.out() if self._target == 'CYCLES' else g.node('ShaderNodeOutputMaterial')
            out.target = self._target
            if self._target == 'EEVEE':
                out.location = (900, -400)
            g.link(shader, out.inputs['Surface'])
            mat.surface_render_method = 'BLENDED' if transparent and blend not in ('clip',) else 'DITHERED'
            mat.use_transparency_overlap = True
            return
        g.link(shader, g.out().inputs['Surface'])
        mat.surface_render_method = 'BLENDED' if transparent and blend not in ('clip',) else 'DITHERED'
        mat.use_transparency_overlap = True

    def unscaled(self, g, color, glob):
        # (REFRACT_UNSCALED: not scaled by the exposure)
        return g.vscale(color, g.div(1.0, g.max(glob.outputs['Exposure'], 1e-4)))

    # ---- by kind ----

    def build(self, desc, cube):
        kind = desc['kind']
        mat = bpy.data.materials.new(f"p2_{desc['id']}_{desc.get('shader', kind).split(':')[0]}")
        mat.use_nodes = True
        # (emission here is what's seen, not a light: nothing is lit by it)
        try:
            mat.cycles.emission_sampling = 'NONE'
        except AttributeError:
            pass
        self._flash_albedo = None
        mat.node_tree.nodes.clear()
        g = Graph(mat.node_tree)
        if kind == 'skymask':
            self.skymask(g)
            return mat
        glob = g.node('ShaderNodeGroup', node_tree=globals_group())
        if kind == 'shader':
            from .effects import EffectBuilder
            EffectBuilder(self, g, desc, glob).build(mat)
            return mat
        builder = {'world': self.world, 'model': self.model, 'vertexlit': self.vertexlit}.get(kind, self.unlit)
        # (lit models: Cycles reads every light's settings, Eevee only 8 object
        # properties: an output for each)
        targets = ['CYCLES', 'EEVEE'] if kind == 'model' else [None]
        for target in targets:
            self._target, self._eevee = target, target == 'EEVEE'
            color, alpha = builder(g, desc, glob, cube)
            if desc.get('fog', True):
                color = self.fog(g, color, glob)
            self.finish(mat, g, desc, color, alpha)
        self._target, self._eevee = None, False
        return mat

    def albedo(self, g, desc):
        base, alpha = self.tex(g, desc.get('map'))
        col = desc.get('color', (1, 1, 1))
        albedo = g.vmul(base, col) if base is not None else g.vec(*col)
        if desc.get('vertexColors'):
            col = g.node('ShaderNodeAttribute', attribute_type='GEOMETRY', attribute_name='Col')
            albedo = g.vmul(albedo, col.outputs['Vector'])
            # (four-part vertex colours carry alpha too)
            alpha = col.outputs['Alpha'] if alpha is None else g.mul(alpha, col.outputs['Alpha'])
        return albedo, base, alpha

    def local_refract(self, g, desc):
        """Refract's $localrefract (REFRACT_FRAGMENT): the base texture looked
        into through its normal map, from a depth below the surface, darker
        where the normal tilts (the slats of light covers). Tangent frame from
        the uv map: t along u, b along the viewer's v (down)."""
        r = desc.get('refract') or {}
        base_img = self.images.get(desc.get('map'))
        normal_img = self.images.get(r.get('localNormal'))
        if base_img is None or normal_img is None:
            return None
        px, depth = (r.get('localParams') or [1, 0])[:2]
        bx, by, _ = g.xyz(g.uv('UVMap'))
        uv = g.vec(bx, g.sub(1.0, by), 0.0)  # (the viewer's uv: v down)
        sample = lambda img, at: g.image(img, g.vec(g.xyz(at)[0], g.sub(1.0, g.xyz(at)[1]), 0.0), extension='EXTEND')
        nc, _ = sample(normal_img, uv)
        n_ts = g.vsub(g.vscale(nc, 2.0), 1.0)
        nx, ny, nz = g.xyz(n_ts)
        geo = g.geometry()
        gn = g.norm(geo.outputs['True Normal'])
        t = g.norm(g.node('ShaderNodeTangent', direction_type='UV_MAP', uv_map='UVMap').outputs[0])
        b = g.vscale(g.norm(g.vmath('CROSS_PRODUCT', gn, t)), -1.0)
        eye = g.norm(geo.outputs['Incoming'])
        r_ts = g.norm(g.vec(g.dot(eye, t), g.dot(eye, b), g.dot(eye, gn)))
        rx, ry, rz = g.xyz(r_ts)
        k = g.div(1.0, g.mul(rz, -1.0))
        nzk = g.add(1.0, g.sub(1.0, nz))
        ox = g.add(g.mul(g.mul(rx, k), nzk), nx)
        oy = g.add(g.mul(g.mul(ry, k), nzk), ny)
        ruv = g.vadd(g.vec(g.mul(ox, px * depth), g.mul(oy, depth), 0.0), uv)
        ruv = g.vmin(g.vmax(ruv, 0.0), 1.0)
        seen, _ = sample(base_img, ruv)
        _, seen_a = sample(base_img, g.vmin(g.vmax(g.vadd(uv, g.vscale(g.vec(nx, ny, 0.0), 0.1)), 0.0), 1.0))
        seen = g.vmix(seen, g.splat(seen_a), 0.025)
        shade = g.pow(g.max(nz, 0.0), 3.0)
        return g.vmul(g.vscale(seen, shade), desc.get('color', (1, 1, 1)))

    def refract_color(self, g, desc, glob, albedo):
        r = desc.get('refract') or {}
        if r.get('refractLocal'):
            local = self.local_refract(g, desc)
            if local is not None:
                albedo = local
        if r.get('decalModulate'):
            # (the game multiplies its gamma-space frame by twice the texture;
            # in linear light that's (2 x tex)^2.2, halved for the blend's x2)
            return g.vscale(albedo, 0.5 * 2.0 ** 2.2)
        if r.get('refractUnscaled'):
            return self.unscaled(g, albedo, glob)
        return albedo

    def world(self, g, desc, glob, cube):
        albedo, base, alpha = self.albedo(g, desc)
        r = desc.get('refract') or {}
        if r.get('refractTint') or r.get('decalModulate'):
            # (Refract and DecalModulate: unlit)
            color = self.refract_color(g, desc, glob, albedo)
            if r.get('refractEnv') and desc.get('env'):
                light = g.vec(1, 1, 1)
                env = self.env(g, desc, desc['env'], light, alpha, None, None, desc['env'].get('cube'))
                alpha = g.dot(albedo, (1 / 3, 1 / 3, 1 / 3))
                color = env if env is not None else g.vec(0, 0, 0)
            return color, alpha
        if desc.get('blend2'):
            b2 = desc['blend2']
            base2, alpha2 = self.tex(g, b2.get('map'))
            if base2 is not None and base is not None:
                f = g.attr('blend', out='Fac')
                if b2.get('modulate') is not None:
                    mc, _ = self.tex(g, b2['modulate'])
                    if mc is not None:
                        mr, mg, _ = g.xyz(mc)
                        lo, hi = g.sat(g.sub(mg, mr)), g.sat(g.add(mg, mr))
                        f = g.smoothstep(lo, hi, f)
                base = g.vmix(base, base2, f)
                alpha = g.mixf(alpha, alpha2, f)
                albedo = g.vmul(base, desc.get('color', (1, 1, 1)))
        detail = None
        if desc.get('detail'):
            d = desc['detail']
            img = self.images.get(d.get('map'))
            if img is not None:
                duv = g.vscale(g.uv('UVMap'), d.get('scale', 1.0))
                texel = g.image(img, duv)
                detail = dict(d, texel=texel)
                dc, da = texel
                mode, k = d['mode'], d.get('blend', 1.0)
                if mode == 0:
                    albedo = g.vmul(albedo, g.vmix((1, 1, 1), g.vscale(dc, 2.0), k))
                elif mode == 1:
                    albedo = g.vadd(albedo, g.vscale(dc, k))
                elif mode == 7 and alpha is not None:
                    dr = g.xyz(dc)[0]
                    albedo = g.vmul(albedo, g.vmix((1, 1, 1), g.splat(g.mul(2.0, g.mixf(dr, da, alpha))), k))
                elif mode == 8:
                    albedo = g.vmix(albedo, g.vmul(albedo, dc), k)
        # the light: the light map (or vrad's three bumped ones, by the normal map)
        lm, _ = self.tex(g, desc.get('lightmap'), 'Lightmap', 'EXTEND')
        if lm is not None:
            self._flash_albedo = albedo
        bump_alpha = None
        if lm is not None:
            bump = desc.get('bump')
            light = lm
            if bump:
                bn, bump_alpha = self.tex(g, bump.get('normal'))
                lights = [self.tex(g, t, 'Lightmap', 'EXTEND')[0] for t in bump.get('lights', [])]
                if bn is not None and len(lights) == 3 and all(x is not None for x in lights):
                    if bump.get('ssbump'):
                        if detail is not None and detail.get('mode') == 10:
                            bn = g.vmul(bn, g.vscale(detail['texel'][0], 2.0))
                        bx, by, bz = g.xyz(bn)
                        light = g.vscale(g.vadd(g.vadd(g.vscale(lights[0], bx), g.vscale(lights[1], by)), g.vscale(lights[2], bz)), 0.57735)
                    else:
                        n = g.norm(g.vsub(g.vscale(bn, 2.0), 1.0))
                        dps = [g.sat(g.dot(n, b)) for b in BUMP_BASIS]
                        dps = [g.mul(x, x) for x in dps]
                        total = g.max(g.add(g.add(dps[0], dps[1]), dps[2]), 1e-4)
                        acc = g.vadd(g.vadd(g.vscale(lights[0], dps[0]), g.vscale(lights[1], dps[1])), g.vscale(lights[2], dps[2]))
                        light = g.vscale(acc, g.div(1.0, total))
            light = g.vscale(g.vadd(light, glob.outputs['Ambient']), desc.get('lightmapScale', 1.5))
        else:
            light = g.vec(1, 1, 1)
        surface_light = light
        if desc.get('selfIllum') and alpha is not None:
            light = g.vmix(light, desc['selfIllum']['tint'], alpha)
        color = g.vmul(albedo, light)
        if detail is not None and detail['mode'] in (5, 6):
            dc = detail['texel'][0]
            k = detail.get('blend', 1.0)
            if detail['mode'] == 5:
                color = g.vadd(color, g.vscale(dc, k))
            elif k > 0.5:
                color = g.vadd(color, g.vsat(g.vscale(g.vmax(g.vsub(dc, 1.0 - k), 0.0), 1.0 / k)))
            else:
                color = g.vadd(color, g.vscale(g.vmax(g.vsub(dc, 0.5), 0.0), 4.0 * k))
        if desc.get('env'):
            if desc['env'].get('mask') == 'bump' and bump_alpha is None and desc.get('bumpNormal') is not None:
                _, bump_alpha = self.tex(g, desc['bumpNormal'])
            spec = self.env(g, desc, desc['env'], surface_light, alpha, bump_alpha, detail, desc['env'].get('cube'))
            if spec is not None:
                color = g.vadd(color, spec)
        if lm is not None:
            color = self.gel(g, color, lm, desc.get('lightmapScale', 1.5))
        return color, alpha

    def gel(self, g, color, lm, scale):
        """The gel over a surface (PAINT_FRAGMENT, PAINT_FINAL): its coverage in
        light map coordinates, with the splat texture's alpha averaged in;
        thin gel desaturated and darker; lit by the flat light map (x 0.82,
        plus a little of its own colour), blended over at most 85%."""
        paint = getattr(self, 'paint', None)
        img = self.images.get(paint.get('map')) if paint else None
        if img is None:
            return color
        gel, gel_a = g.image(img, g.uv('Lightmap'), extension='EXTEND')
        splat_a = 0.0
        splat = self.images.get(paint.get('splat'))
        if splat is not None:
            tx, ty = paint.get('tiles', (1, 1))
            _, splat_a = g.image(splat, g.vmul(g.uv('Lightmap'), (tx, ty, 1.0)))
        amount = g.mul(g.sat(g.mul(g.add(gel_a, splat_a), 0.5)), g.math('GREATER_THAN', gel_a, 0.01))
        thick = g.smoothstep(0.34, 0.63, amount)
        c = g.vmath('POWER', gel, (2.2, 2.2, 2.2))
        paint_color = g.vmix(g.splat(g.mul(g.lum(c), 0.5)), c, thick)
        light = g.vadd(g.vscale(g.vscale(lm, scale), 0.82), 0.06)
        over = g.vmul(g.vmul(light, paint_color), (0.8, 0.85, 1.0))
        return g.vmix(color, over, g.mul(g.smoothstep(0.40, 0.45, amount), 0.85))

    def model(self, g, desc, glob, cube):
        albedo, base, alpha = self.albedo(g, desc)
        r = desc.get('refract') or {}
        if r.get('refractTint'):
            color = self.refract_color(g, desc, glob, albedo)
            if r.get('refractEnv') and desc.get('env'):
                env = self.env(g, desc, desc['env'], g.vec(1, 1, 1), None, None, None, cube)
                alpha = g.dot(albedo, (1 / 3, 1 / 3, 1 / 3))
                color = env if env is not None else g.vec(0, 0, 0)
            return color, alpha
        scale = desc.get('ambScale', 1.5)
        phong = desc.get('phong')
        exponent = phong['exponent'] if phong else 1.0
        if phong and phong.get('expMap') is not None:
            ec, _ = self.tex(g, phong['expMap'])
            if ec is not None:
                exponent = g.add(1.0, g.mul(149.0, g.xyz(ec)[0]))
        self._flash_albedo = albedo
        if self._eevee:
            amb = g.group(model_light_eevee_group()).outputs['Light']
            phong = None
        else:
            lit = g.group(model_light_group(self.scale), {'Exponent': exponent})
            amb = lit.outputs['Light']
        color = g.vscale(g.vmul(albedo, amb), scale)
        if phong:
            spec = lit.outputs['Specular']
            geo = g.geometry()
            ndv = g.sat(g.dot(outward_normal(g), g.norm(geo.outputs['Incoming'])))
            f = g.mul(g.sub(1.0, ndv), g.sub(1.0, ndv))
            fr = phong['fresnel']
            fres = g.mixf(g.mixf(fr[0], fr[1], g.mul(2.0, f)), g.mixf(fr[1], fr[2], g.sub(g.mul(2.0, f), 1.0)), g.math('GREATER_THAN', f, 0.5))
            mask = None
            if phong.get('mask') == 'base':
                mask = alpha
            elif phong.get('mask') == 'bump':
                _, mask = self.tex(g, phong.get('maskMap'))
            spec = g.vscale(g.vmul(spec, phong.get('tint', (1, 1, 1))), g.mul(g.mul(fres, phong.get('boost', 1.0)), scale))
            if mask is not None:
                spec = g.vscale(spec, mask)
            color = g.vadd(color, spec)
        si = desc.get('selfIllum')
        if si:
            glow = None
            if si.get('mask') is not None:
                glow, _ = self.tex(g, si['mask'])
            elif alpha is not None:
                glow = g.splat(alpha)
            if glow is not None:
                color = g.vmix(color, g.vmul(albedo, si.get('tint', (1, 1, 1))), glow)
        if desc.get('env') and (cube is not None or desc['env'].get('cube') is not None):
            if isinstance(cube, tuple):
                # (the cubemap the object's p2_cube picks, frame by frame)
                pick = g.attr('p2_cube', 'OBJECT', 'Fac')
                spec = None
                for i, c in enumerate(cube):
                    one = self.env(g, desc, desc['env'], g.vscale(amb, scale), alpha, None, None, c)
                    if one is None:
                        continue
                    one = g.vscale(one, g.math('COMPARE', pick, float(i), 0.5))
                    spec = one if spec is None else g.vadd(spec, one)
            else:
                spec = self.env(g, desc, desc['env'], g.vscale(amb, scale), alpha, None, None, cube if cube is not None else desc['env'].get('cube'))
            if spec is not None:
                color = g.vadd(color, spec)
        return color, alpha

    def vertexlit(self, g, desc, glob, cube):
        albedo, base, alpha = self.albedo(g, desc)
        if (desc.get('refract') or {}).get('refractTint'):
            # (Refract on a prop: unlit, its vertex light unused)
            return self.refract_color(g, desc, glob, albedo), alpha
        color = albedo
        col = desc.get('color', (1, 1, 1))
        if base is not None:
            color = g.vadd(color, g.vmul(g.vmul(base, col), glob.outputs['Ambient']))
            # (its colour holds the 1.5 the projected light carries itself)
            self._flash_albedo = g.vmul(base, [c / 1.5 for c in col])
        si = desc.get('selfIllum')
        if si and base is not None:
            glow = None
            if si.get('mask') is not None:
                glow, _ = self.tex(g, si['mask'])
            elif alpha is not None:
                glow = g.splat(alpha)
            if glow is not None:
                color = g.vmix(color, g.vmul(base, si.get('tint', (1, 1, 1))), glow)
        return color, alpha

    def unlit(self, g, desc, glob, cube):
        albedo, base, alpha = self.albedo(g, desc)
        return self.refract_color(g, desc, glob, albedo), alpha
