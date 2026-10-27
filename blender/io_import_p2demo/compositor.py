# The viewer's last steps, in the compositor (sar-web src/ui/view3d.ts
# renderFrame and src/ui/bloom.ts): the 3D skybox under the world, the view
# model over it, then the final pass: exposed, clamped, sRGB-encoded; the
# bloom (a quarter-size bright pass blurred by the engine's 25-tap Gaussian)
# added at half strength in gamma space; the screen fade over that. The
# result is turned back to linear and divided by the exposure, which the
# scene's Standard view transform applies again: the picture is the viewer's.
import bpy
import numpy as np

# BlurFilter $kernel 4: bilinear taps (weights, offsets in quarter-size texels)
WEIGHTS = (0.000534, 0.003733, 0.018004, 0.059928, 0.137740, 0.218677, 0.122765, 0.218677, 0.137740, 0.059928, 0.018004, 0.003733, 0.000534)
OFFSETS = (-11.251852, -9.289172, -7.329586, -5.372686, -3.417910, -1.464557, 0.0, 1.464557, 3.417910, 5.372686, 7.329586, 9.289172, 11.251852)


class Comp:
    def __init__(self, tree):
        self.tree = tree
        self.col = 0

    def node(self, kind, x=None, **props):
        n = self.tree.nodes.new(kind)
        for k, v in props.items():
            setattr(n, k, v)
        self.col += 1
        n.location = ((x if x is not None else self.col) * 200 - 1600, 0)
        return n

    def link(self, a, b):
        self.tree.links.new(a, b)

    def mix(self, blend, a, b, fac=1.0, clamp=False, name=None):
        n = self.node('CompositorNodeMixRGB', blend_type=blend, use_clamp=clamp)
        if name:
            n.name = n.label = name
        if isinstance(fac, bpy.types.NodeSocket):
            self.link(fac, n.inputs[0])
        else:
            n.inputs[0].default_value = fac
        for sock, v in ((n.inputs[1], a), (n.inputs[2], b)):
            if isinstance(v, bpy.types.NodeSocket):
                self.link(v, sock)
            else:
                sock.default_value = v if len(v) == 4 else (*v, 1.0)
        return n.outputs[0]

    def value(self, name, v=0.0):
        n = self.node('CompositorNodeValue')
        n.name = n.label = name
        n.outputs[0].default_value = v
        return n.outputs[0]

    def colorspace(self, image, src, dst):
        n = self.node('CompositorNodeConvertColorSpace')
        n.from_color_space = src
        n.to_color_space = dst
        self.link(image, n.inputs[0])
        return n.outputs[0]

    def translate(self, image, x, y):
        n = self.node('CompositorNodeTranslate', use_relative=False)
        if hasattr(n, 'interpolation'):
            n.interpolation = 'BILINEAR'
        self.link(image, n.inputs['Image'])
        n.inputs['X'].default_value = x
        n.inputs['Y'].default_value = y
        return n.outputs[0]

    def blur(self, image, horizontal):
        acc = None
        for w, o in zip(WEIGHTS, OFFSETS):
            # (a tap at +o samples the texel o away: the image moves by -o)
            tap = self.translate(image, -o if horizontal else 0.0, 0.0 if horizontal else -o)
            scaled = self.mix('MULTIPLY', tap, (w, w, w, 1.0))
            acc = scaled if acc is None else self.mix('ADD', acc, scaled)
        return acc


def build(scene, layers, frames, globals_values, keys):
    """`layers`: (main scene, viewmodel, skybox, overlay scenes or None);
    `globals_values`: name -> per-key values (exposure, bloom, fade...)."""
    main, vm, sky, overlay = layers
    scene.use_nodes = True
    tree = scene.node_tree
    tree.nodes.clear()
    c = Comp(tree)
    rl = c.node('CompositorNodeRLayers', 0)
    rl.scene = main
    image = rl.outputs['Image']
    if sky is not None:
        srl = c.node('CompositorNodeRLayers', 0)
        srl.scene = sky
        srl.location.y = -300
        over = c.node('CompositorNodeAlphaOver')
        c.link(srl.outputs['Image'], over.inputs[1])
        c.link(image, over.inputs[2])
        image = over.outputs[0]
    if overlay is not None:
        orl = c.node('CompositorNodeRLayers', 0)
        orl.scene = overlay
        orl.location.y = -900
        over = c.node('CompositorNodeAlphaOver')
        c.link(image, over.inputs[1])
        c.link(orl.outputs['Image'], over.inputs[2])
        image = over.outputs[0]
    if vm is not None:
        vrl = c.node('CompositorNodeRLayers', 0)
        vrl.scene = vm
        vrl.location.y = -600
        over = c.node('CompositorNodeAlphaOver')
        c.link(image, over.inputs[1])
        c.link(vrl.outputs['Image'], over.inputs[2])
        image = over.outputs[0]

    exposure = c.value('P2 Exposure', float(globals_values['exposure'][0]))
    exposed = c.mix('MULTIPLY', image, exposure, clamp=True)
    shown = c.colorspace(exposed, 'Linear Rec.709', 'sRGB')

    # bloom: the bright pass (colour^2.2 x its luminance) at a quarter size
    bloom = globals_values['bloom']
    if np.max(bloom) > 0:
        small = c.node('CompositorNodeScale', space='RELATIVE')
        c.link(shown, small.inputs['Image'])
        small.inputs['X'].default_value = small.inputs['Y'].default_value = 0.25
        sep = c.node('CompositorNodeSeparateColor')
        c.link(small.outputs[0], sep.inputs[0])
        lum = None
        for ch, k in (('Red', 0.3), ('Green', 0.59), ('Blue', 0.11)):
            m = c.node('CompositorNodeMath', operation='MULTIPLY')
            c.link(sep.outputs[ch], m.inputs[0])
            m.inputs[1].default_value = k
            if lum is None:
                lum = m.outputs[0]
            else:
                a = c.node('CompositorNodeMath', operation='ADD')
                c.link(lum, a.inputs[0])
                c.link(m.outputs[0], a.inputs[1])
                lum = a.outputs[0]
        gamma = c.node('CompositorNodeGamma')
        c.link(small.outputs[0], gamma.inputs['Image'])
        gamma.inputs['Gamma'].default_value = 2.2
        bright = c.mix('MULTIPLY', gamma.outputs[0], lum)
        blurred = c.blur(c.blur(bright, True), False)
        big = c.node('CompositorNodeScale', space='RENDER_SIZE', frame_method='STRETCH')
        c.link(blurred, big.inputs['Image'])
        amount = c.value('P2 Bloom', 0.5 * float(bloom[0]))
        shown = c.mix('ADD', shown, big.outputs[0], fac=amount)

    # the fade: over the picture, or multiplying it
    alpha = globals_values['fadeA']
    if np.max(alpha) > 0:
        color = c.node('CompositorNodeRGB')
        color.name = color.label = 'P2 Fade Color'
        mod = globals_values['fadeModulate']
        a_mix = c.value('P2 Fade Mix', float(alpha[0] * (1 - mod[0])))
        a_mod = c.value('P2 Fade Modulate', float(alpha[0] * mod[0]))
        shown = c.mix('MIX', shown, color.outputs[0], fac=a_mix)
        shown = c.mix('MULTIPLY', shown, color.outputs[0], fac=a_mod)
    clamped = c.mix('MIX', shown, (0, 0, 0, 1), fac=0.0, clamp=True)
    linear = c.colorspace(clamped, 'sRGB', 'Linear Rec.709')
    out_img = c.mix('DIVIDE', linear, exposure)
    out = c.node('CompositorNodeComposite')
    out.use_alpha = False
    c.link(out_img, out.inputs['Image'])

    # the values each frame
    if len(frames) > 1:
        keys(tree, 'nodes["P2 Exposure"].outputs[0].default_value', frames, globals_values['exposure'], 'LINEAR', name='P2 Compositor')
        if np.max(bloom) > 0 and np.ptp(bloom) > 0:
            keys(tree, 'nodes["P2 Bloom"].outputs[0].default_value', frames, 0.5 * bloom, 'LINEAR', name='P2 Compositor')
        if np.max(alpha) > 0:
            mod = globals_values['fadeModulate']
            keys(tree, 'nodes["P2 Fade Mix"].outputs[0].default_value', frames, alpha * (1 - mod), 'LINEAR', name='P2 Compositor')
            keys(tree, 'nodes["P2 Fade Modulate"].outputs[0].default_value', frames, alpha * mod, 'LINEAR', name='P2 Compositor')
            for i, ch in enumerate(('fadeR', 'fadeG', 'fadeB')):
                keys(tree, 'nodes["P2 Fade Color"].outputs[0].default_value', frames, globals_values[ch], 'LINEAR', index=i, name='P2 Compositor')
    elif np.max(alpha) > 0:
        tree.nodes['P2 Fade Color'].outputs[0].default_value = (float(globals_values['fadeR'][0]), float(globals_values['fadeG'][0]), float(globals_values['fadeB'][0]), 1)
