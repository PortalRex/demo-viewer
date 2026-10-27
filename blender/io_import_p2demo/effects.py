# The viewer's effect shaders (sar-web src/ui/effects.ts, particles.ts,
# ropes.ts, movies.ts, paintblobs.ts) as node trees. Their per-frame
# settings come from the object's keyframed properties u_<uniform>_<i>
# (every object drawn with one has them all); textures are sampled in the
# viewer's own uv space (v down, as the game's), turned to Blender's here.
import bpy

from .nodes import Graph


class EffectBuilder:
    def __init__(self, mats, g: Graph, desc, glob):
        self.mats = mats
        self.g = g
        self.desc = desc
        self.glob = glob
        self.values = desc.get('values', {})
        self.textures = desc.get('textures', {})

    # ---- inputs ----

    def u(self, name, i=0):
        """A uniform's component, per object (keyframed where it changes)."""
        return self.g.attr(f'u_{name}_{i}', 'OBJECT', 'Fac')

    def uvec(self, name, n=3):
        comps = [self.u(name, i) for i in range(n)]
        while len(comps) < 3:
            comps.append(0.0)
        return self.g.vec(*comps[:3])

    def const(self, name, default=0.0):
        v = self.values.get(name, default)
        return v

    def raw_uv(self, layer='UVMap'):
        """The viewer's uv (v down): Blender's layers hold 1 - v."""
        x, y, _ = self.g.xyz(self.g.uv(layer))
        return self.g.vec(x, self.g.sub(1.0, y), 0.0)

    def sample(self, name, uv, ext='REPEAT'):
        """A texture uniform at viewer uv coordinates."""
        tid = self.textures.get(name)
        img = self.mats.images.get(tid) if tid is not None else None
        if img is None:
            return None, None
        x, y, _ = self.g.xyz(uv)
        return self.g.image(img, self.g.vec(x, self.g.sub(1.0, y), 0.0), extension=ext)

    def unexposed(self, color, cap_at_one=False):
        """Undo the frame's exposure (fixed-brightness effects); SolidEnergy
        takes at most 1."""
        e = self.glob.outputs['Exposure']
        if cap_at_one:
            e = self.g.max(e, 1.0)
        return self.g.vscale(color, self.g.div(1.0, self.g.max(e, 1e-4)))

    def camera_fade(self):
        """SolidEnergy's camera fade: none at the 7 unit near plane, full 40 on."""
        depth = self.g.node('ShaderNodeCameraData').outputs['View Z Depth']
        x = self.g.sat(self.g.mul(self.g.sub(self.g.div(depth, self.mats.scale), 7.0), 0.025))
        return self.g.smoothstep(0.0, 1.0, x)

    # ---- by shader ----

    def build(self, mat):
        shader = self.desc.get('shader', '')
        fn = {
            'spritecard': self.spritecard, 'laser': self.laser, 'solidenergy': self.solidenergy,
            'fizzler': self.fizzler, 'portal': self.portal, 'rope': self.rope, 'screen': self.screen,
            'gelblob': self.gelblob,
        }.get(shader)
        if fn is None:
            # (an effect not ported: drawn invisible rather than wrong)
            self.g.link(self.g.node('ShaderNodeBsdfTransparent').outputs[0], self.g.out().inputs['Surface'])
            mat.surface_render_method = 'BLENDED'
            return
        out = fn(mat)
        if out is not None:
            color, alpha = out
            self.mats.finish(mat, self.g, self.desc, color, alpha)

    def spritecard(self, mat):
        """SpriteCard: texture x overbright, x the particle colour (gamma to
        linear), $addself premultiplied, saturated once exposed."""
        g = self.g
        t, a = self.sample('map', self.raw_uv(), 'EXTEND')
        if t is None:
            return g.vec(0, 0, 0), g.value(0.0)
        dual = self.desc.get('defines', {}).get('DUAL')
        if dual is not None:
            t2, a2 = self.sample('map', self.raw_uv('UV2'), 'EXTEND')
            if t2 is not None:
                if dual == '0':
                    t, a = g.vscale(g.vadd(t, t2), 0.5), g.mul(g.add(a, a2), 0.5)
                elif dual == '1':
                    t = t2
                else:
                    t = g.vmix(t, t2, a2)
        pc = g.node('ShaderNodeAttribute', attribute_type='GEOMETRY', attribute_name='pcolor')
        vcol = g.vmath('POWER', g.vmax(pc.outputs['Color'], 0.0), (2.2, 2.2, 2.2))
        rgb = g.vscale(t, self.const('overbright', 1.0))
        alpha = g.mul(a, pc.outputs['Alpha'])
        add_self = self.const('addSelf', 0.0)
        if 'ADDSELF' in self.desc.get('defines', {}):
            rgb = g.vscale(rgb, g.mul(alpha, 1.0 + add_self))
        cap = g.div(1.0, g.max(self.glob.outputs['Exposure'], 1e-3))
        rgb = g.vmin(g.vmul(rgb, vcol), g.splat(cap))
        return rgb, g.min(alpha, 1.0)

    def laser(self, mat):
        """UnlitTwoTexture beam: texture x the second (its own transform,
        drifting) x colour, added."""
        g = self.g
        uv = self.raw_uv()
        ux, uy, _ = g.xyz(uv)
        e = [self.u('t2', i) for i in range(9)]
        sx = g.add(g.add(g.mul(e[0], ux), g.mul(e[3], uy)), e[6])
        sy = g.add(g.add(g.mul(e[1], ux), g.mul(e[4], uy)), e[7])
        sx = g.add(sx, g.mul(self.u('ramp'), self.u('time')))
        base, _ = self.sample('base', uv, 'EXTEND')
        second, _ = self.sample('second', g.vec(sx, sy, 0.0))
        if base is None:
            return g.vec(0, 0, 0), g.value(0.0)
        c = base if second is None else g.vmul(base, second)
        return g.vmul(c, self.uvec('color')), None

    def solidenergy(self, mat):
        """SolidEnergy (light bridges, funnels, laser fields)."""
        g = self.g
        uv = self.raw_uv()
        off = lambda n: g.vec(self.u(n, 0), self.u(n, 1), 0.0)
        c, ca = self.sample('base', g.vadd(uv, off('baseOffset')))
        if c is None:
            return g.vec(0, 0, 0), None
        d1 = None
        if self.const('hasDetail1') > 0.5:
            d1, _ = self.sample('detail1', g.vadd(uv, off('detail1Offset')))
            if d1 is not None:
                c = g.vscale(g.vmul(c, d1), 2.0) if self.const('detail1Mode') < 0.5 else g.vmix(g.vmul(c, d1), c, ca)
        if self.const('hasDetail2') > 0.5:
            d2, _ = self.sample('detail2', g.vadd(uv, off('detail2Offset')))
            if d2 is not None:
                if d1 is not None and self.const('detail2Mode') < 0.5:
                    d2 = g.vmul(d2, d1)
                c = g.vadd(c, d2) if self.const('detail2Mode') < 0.5 else g.vmul(c, d2)
        geo = g.geometry()
        view = g.norm(geo.outputs['Incoming'])
        n = g.norm(geo.outputs['Normal'])
        alpha = 1.0
        if self.const('useTangent') > 0.5:
            local = g.node('ShaderNodeTexCoord').outputs['Object']
            lx, _, lz = g.xyz(local)
            around = self.const('tangentAround') > 0.5
            t_local = g.vec(g.mul(lz, -1.0), 0.0, lx) if around else g.vec(0.0, 1.0, 0.0)
            to_world = lambda v: g.node('ShaderNodeVectorTransform', {'Vector': v}, vector_type='VECTOR', convert_from='OBJECT', convert_to='WORLD').outputs[0]
            tangent = g.norm(to_world(t_local))
            if around:
                axis = g.norm(to_world(g.vec(0.0, 1.0, 0.0)))
                aligned = g.norm(g.vmath('CROSS_PRODUCT', axis, g.vmath('CROSS_PRODUCT', axis, view)))
            else:
                aligned = view
            along = g.math('ABSOLUTE', g.dot(tangent, aligned))
            r = [self.u('tangentRanges', i) for i in range(4)]
            alpha = g.mixf(r[0], r[1], g.pow(along, r[2]))
            front = g.add(g.mul(g.dot(view, n), 0.5), 0.5)
            alpha = g.mul(alpha, g.mixf(1.0, r[3], g.mul(front, front)))
            c = g.vscale(c, g.mul(g.add(1.0, alpha), self.camera_fade()))
        else:
            facing = g.math('ABSOLUTE', g.dot(n, view))
            fade = g.mixf(1.0, g.sub(1.0, g.mul(g.mul(facing, facing), 0.85)), self.u('edgeFade'))
            c = g.vscale(c, fade)
        if self.const('useVertexColor') > 0.5:
            k = g.mul(g.sub(2.0, alpha), 2.0) if not isinstance(alpha, float) else 2.0 * (2.0 - alpha)
            c = g.vmul(c, g.vmath('POWER', self.uvec('vertexColor'), g.splat(k) if not isinstance(k, float) else (k, k, k)))
        c = g.vscale(g.vmul(g.vmax(c, 0.0), self.uvec('color')), self.u('intensity'))
        return self.unexposed(c, cap_at_one=True), None

    def fizzler(self, mat):
        """SolidEnergy's flow-map path (fizzlers): world-space ripples pushed
        along the flow map in two cross-fading phases, vortices near objects."""
        g = self.g
        uv = self.raw_uv()
        b, _ = self.sample('bounds', uv)
        fl, _ = self.sample('flow', uv)
        if b is None or fl is None:
            return g.vec(0, 0, 0), None
        br, bg, bb = g.xyz(b)
        fr, fg, _ = g.xyz(fl)
        f = g.vscale(g.vec(g.sub(g.mul(fr, 2.0), 1.0), g.sub(g.mul(fg, 2.0), 1.0), 0.0), br)
        geo = g.geometry()
        p = g.vscale(geo.outputs['Position'], 1.0 / self.mats.scale)
        vortex = None
        for k in (1, 2):
            at = self.uvec(f'vortex{k}')
            on = self.u(f'vortex{k}', 3)
            v = g.mul(g.sat(g.sub(g.div(self.u('vortexSize'), g.max(g.length(g.vsub(at, p)), 1e-3)), 0.5)), g.math('GREATER_THAN', on, 0.0))
            vortex = v if vortex is None else g.add(vortex, v)
        t1 = g.math('FRACT', g.div(self.u('time'), self.u('interval')))
        t2 = g.math('FRACT', g.add(t1, 0.5))
        w1 = g.sub(1.0, g.math('ABSOLUTE', g.sub(g.mul(t1, 2.0), 1.0)))
        # world coordinates on the plane the face mostly lies in
        nx, ny, nz = g.xyz(g.vmath('ABSOLUTE', geo.outputs['Normal']))
        px, py, pz = g.xyz(p)
        use_x = g.mul(g.math('GREATER_THAN', nx, ny), g.math('GREATER_THAN', nx, nz))
        use_y = g.mul(g.sub(1.0, use_x), g.math('GREATER_THAN', ny, nz))
        wu = g.mixf(g.mixf(px, px, use_y), py, use_x)
        wv = g.mixf(g.mixf(py, pz, use_y), pz, use_x)
        wuv = g.vscale(g.vec(wu, wv, 0.0), self.u('worldScale'))
        sc = g.mul(self.u('scroll'), g.add(1.0, vortex))
        c1, a1 = self.sample('base', g.vadd(wuv, g.vscale(f, g.mul(t1, sc))))
        c2, a2 = self.sample('base', g.vadd(wuv, g.vscale(f, g.mul(t2, sc))))
        if c1 is None:
            return g.vec(0, 0, 0), None
        cg = g.add(g.mixf(g.xyz(c2)[1], g.xyz(c1)[1], w1), bg)
        ca = g.add(g.mixf(a2, a1, w1), bg)
        rgb = g.vscale(self.uvec('flowColor'), ca)
        has = g.math('GREATER_THAN', g.add(self.u('vortex1', 3), self.u('vortex2', 3)), 0.0)
        rgb = g.vmix(rgb, g.vscale(self.uvec('vortexColor'), cg), g.mul(vortex, has))
        k = g.mul(g.mul(g.mul(bb, self.u('flowIntensity')), g.mul(2.0, self.u('intensity'))), self.camera_fade())
        return self.unexposed(g.vscale(rgb, k), cap_at_one=True), None

    def portal(self, mat):
        """PortalRefract: the view through (a Cycles ray portal to the partner's
        side), flames around the opening, static while it activates."""
        g = self.g
        x, y, _ = g.xyz(g.uv('UVMap'))
        # (plane coordinates -1..1: Blender's uv is (x+1)/2, 1 - (y+1)/2)
        base = g.vec(g.sub(1.0, x), y, 0.0)
        bx, by, _ = g.xyz(base)
        OUTER, INNER = 0.075, 0.3
        uvp = g.vsub(g.vscale(base, 1.0 + OUTER), OUTER * 0.5)
        open_amount = g.smoothstep(0.0, 1.0, g.sat(self.u('open')))
        open2 = g.mul(open_amount, open_amount)
        dist = g.length(g.vsub(g.vscale(uvp, 2.0), g.vec(1.0, 1.0, 0.0)))
        hole = g.math('LESS_THAN', dist, g.add(open2, 1e-6))
        noise_uv = g.vadd(g.vscale(g.vsub(base, g.vec(0.5, 0.5, 0.0)), g.div(1.0, g.max(open_amount, 0.01))), g.vec(0.5, 0.5, 0.0))
        scroll = g.mul(self.u('time'), 0.0275)
        nu = g.vscale(noise_uv, 0.3)
        n1, _ = self.sample('noise', g.vadd(nu, g.vec(scroll, 0.0, 0.0)))
        if n1 is None:
            n1 = g.vec(0.5, 0.5, 0.5)
        n1r, n1g, _ = g.xyz(n1)
        q = g.vsub(nu, g.vec(scroll, 0.0, 0.0))
        qx, qy, _ = g.xyz(q)
        n2, _ = self.sample('noise', g.vsub(g.vec(qy, qx, 0.0), g.vscale(g.vec(n1r, n1g, 0.0), 0.02)))
        if n2 is None:
            n2 = g.vec(0.5, 0.5, 0.5)
        n2r, n2g, _ = g.xyz(n2)
        n1b, _ = self.sample('noise', g.vsub(g.vadd(nu, g.vec(scroll, 0.0, 0.0)), g.vscale(g.vec(n2r, n2g, 0.0), 0.02)))
        n1g = g.xyz(n1b)[1] if n1b is not None else n1g
        lin = lambda a, b, v: g.sat(g.div(g.sub(v, a), g.sub(b, a)))
        outer_mask = g.mul(g.sub(1.0, lin(open2, g.add(open2, OUTER), dist)), g.sub(1.0, hole))
        inner_mask = g.mul(lin(g.sub(open2, INNER), open2, dist), hole)
        linked = self.g.attr('p2_plink', 'OBJECT', 'Fac')
        active = g.mul(linked, g.sub(1.0, g.sat(self.u('staticAmount'))))
        fade_in = g.max(g.sat(g.mul(open_amount, 2.5)), g.sub(1.0, active))
        mask = g.mul(g.add(inner_mask, outer_mask), fade_in)
        flame = g.mul(g.add(n1g, n2g), 0.5)
        # (smoothstep(0, flame, active))
        active_noise = g.smoothstep(0.0, g.max(flame, 1e-4), active)
        border = g.sub(1.0, g.smoothstep(g.sub(mask, 0.875), g.add(mask, 0.875), flame))
        mask = g.mul(mask, border)
        alpha = g.mul(g.sat(g.add(mask, g.mul(hole, g.sub(1.0, active_noise)))), 1.5)
        _, uy, _ = g.xyz(uvp)
        shift = g.add(g.mul(g.pow(g.math('ABSOLUTE', uy), 1.5), 0.8), 0.2)
        at = g.mul(g.mul(g.pow(g.max(border, 0.0), 0.5), shift), alpha)
        if self.const('tinted') > 0.5:
            flame_color = g.vscale(self.uvec('tint'), g.sat(at))
        else:
            grad, _ = self.sample('gradient', g.vec(at, 0.5, 0.0), 'EXTEND')
            flame_color = grad if grad is not None else g.vec(1.0, 0.5, 0.1)
        flame_color = self.unexposed(g.vscale(flame_color, self.u('colorScale')))
        alpha = g.sat(alpha)
        emit = g.node('ShaderNodeEmission', {'Color': flame_color, 'Strength': self.mats.seen(g)}).outputs[0]
        clear = g.node('ShaderNodeBsdfTransparent').outputs[0]
        # the way through: the ray goes on from the partner's side
        P = g.geometry().outputs['Position']
        D = g.vscale(g.geometry().outputs['Incoming'], -1.0)
        rows = [g.vec(self.g.attr(f'p2_pm{r * 4}', 'OBJECT', 'Fac'), self.g.attr(f'p2_pm{r * 4 + 1}', 'OBJECT', 'Fac'), self.g.attr(f'p2_pm{r * 4 + 2}', 'OBJECT', 'Fac')) for r in range(3)]
        trans = g.vec(*[self.g.attr(f'p2_pm{r * 4 + 3}', 'OBJECT', 'Fac') for r in range(3)])
        P2 = g.vadd(g.vec(*[g.dot(rows[r], P) for r in range(3)]), trans)
        D2 = g.norm(g.vec(*[g.dot(rows[r], D) for r in range(3)]))
        # (past the partner's own surface, which sits just in front of it)
        P2 = g.vadd(P2, g.vscale(D2, 1.5 * self.mats.scale))
        through = g.node('ShaderNodeBsdfRayPortal', {'Color': (1, 1, 1), 'Position': P2, 'Direction': D2}).outputs[0]
        black = g.node('ShaderNodeEmission', {'Color': (0, 0, 0), 'Strength': 0.0}).outputs[0]
        inside = g.node('ShaderNodeMixShader', {0: linked, 1: black, 2: through}).outputs[0]
        under = g.node('ShaderNodeMixShader', {0: hole, 1: clear, 2: inside}).outputs[0]
        shader = g.node('ShaderNodeMixShader', {0: alpha, 1: under, 2: emit}).outputs[0]
        # (one-sided: from behind it's nothing)
        back = g.geometry().outputs['Backfacing']
        shader = g.node('ShaderNodeMixShader', {0: back, 1: shader, 2: g.node('ShaderNodeBsdfTransparent').outputs[0]}).outputs[0]
        g.link(shader, g.out().inputs['Surface'])
        mat.surface_render_method = 'BLENDED'
        return None

    def rope(self, mat):
        """A rope: its texture, shaded across by the normal map, times its light."""
        g = self.g
        uv = self.raw_uv()
        tex, a = self.sample('map', uv)
        nm, _ = self.sample('normalMap', uv)
        if tex is None:
            return g.vec(0, 0, 0), None
        n = g.sub(g.mul(g.xyz(nm)[2], 2.0), 1.0) if nm is not None else 1.0
        l = g.add(g.mul(n, 0.5), 0.5) if not isinstance(n, float) else 1.0
        shade = g.mul(l, l) if not isinstance(l, float) else 1.0
        light = g.attr('Col')
        c = g.vmul(g.vscale(tex, shade), light)
        if self.const('alphaTest') > 0:
            self.desc['blend'] = 'clip'
            self.desc['alphaTest'] = self.const('alphaTest')
        return c, a

    def screen(self, mat):
        """A movie screen or sign panel: unlit; images exposed with their alpha,
        movies drawn unexposed."""
        g = self.g
        c, a = self.sample('map', self.raw_uv(), 'EXTEND')
        if c is None:
            return g.vec(0, 0, 0), g.value(0.0)
        if self.const('image', 1) > 0.5:
            return c, a
        self.desc['blend'] = 'opaque'
        return self.unexposed(c), None

    def gelblob(self, mat):
        """Gel in flight: its colour lit mostly from above, a sheen at the rim."""
        g = self.g
        geo = g.geometry()
        n = g.norm(geo.outputs['Normal'])
        _, _, nz = g.xyz(n)
        diffuse = g.add(0.45, g.mul(0.55, g.max(nz, 0.0)))
        rim = g.pow(g.sub(1.0, g.math('ABSOLUTE', g.dot(n, g.norm(geo.outputs['Incoming'])))), 3.0)
        col = g.attr('Col')
        return g.vadd(g.vscale(col, diffuse), g.vscale(col, g.mul(rim, 0.6))), None
