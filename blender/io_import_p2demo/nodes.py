# A small layer over Blender's shader node trees, so the viewer's shader
# math reads as math: values are sockets or constants, every helper returns
# the output socket, and nodes are laid out in columns by how deep they sit.
import bpy


class Graph:
    def __init__(self, tree):
        self.tree = tree
        self.nodes = tree.nodes
        self.links = tree.links
        self._rows = {}

    # ---- plumbing ----

    def node(self, kind, inputs=None, **props):
        n = self.nodes.new(kind)
        for k, v in props.items():
            setattr(n, k, v)
        depth = 0
        for key, value in (inputs or {}).items():
            sock = n.inputs[key]
            if isinstance(value, bpy.types.NodeSocket):
                self.links.new(value, sock)
                depth = max(depth, self._depth(value.node) + 1)
            elif value is not None:
                self.set(sock, value)
        self._place(n, depth)
        return n

    @staticmethod
    def set(sock, value):
        dv = sock.default_value
        if isinstance(value, (int, float)):
            try:
                n = len(dv)
            except TypeError:
                sock.default_value = value
                return
            sock.default_value = [value] * (n - 1) + [1.0] if n == 4 else [value] * n
        else:
            value = list(value)
            try:
                n = len(dv)
            except TypeError:
                sock.default_value = value[0]
                return
            if n == 4 and len(value) == 3:
                value = value + [1.0]
            sock.default_value = value[:n]

    def _depth(self, node):
        return int(node.get('_depth', 0)) if hasattr(node, 'get') else 0

    def _place(self, n, depth):
        n['_depth'] = depth
        row = self._rows.get(depth, 0)
        self._rows[depth] = row + 1
        n.location = (depth * 220 - 1400, -row * 180)

    def link(self, out, inp):
        self.links.new(out, inp)

    # ---- values ----

    def value(self, v, label=None):
        n = self.node('ShaderNodeValue')
        n.outputs[0].default_value = v
        if label:
            n.label = n.name = label
        return n.outputs[0]

    def vec(self, x, y=None, z=None):
        if y is None:
            x, y, z = x
        return self.node('ShaderNodeCombineXYZ', {0: x, 1: y, 2: z}).outputs[0]

    def xyz(self, v):
        n = self.node('ShaderNodeSeparateXYZ', {0: v})
        return n.outputs[0], n.outputs[1], n.outputs[2]

    # ---- scalar math ----

    def math(self, op, a, b=None, c=None, clamp=False):
        ins = {0: a}
        if b is not None:
            ins[1] = b
        if c is not None:
            ins[2] = c
        return self.node('ShaderNodeMath', ins, operation=op, use_clamp=clamp).outputs[0]

    def add(self, a, b): return self.math('ADD', a, b)
    def sub(self, a, b): return self.math('SUBTRACT', a, b)
    def mul(self, a, b): return self.math('MULTIPLY', a, b)
    def div(self, a, b): return self.math('DIVIDE', a, b)
    def pow(self, a, b): return self.math('POWER', a, b)
    def max(self, a, b): return self.math('MAXIMUM', a, b)
    def min(self, a, b): return self.math('MINIMUM', a, b)
    def sat(self, a): return self.math('ADD', a, 0.0, clamp=True)
    def step(self, edge, x): return self.math('GREATER_THAN', x, edge)  # (x > edge)

    def smoothstep(self, lo, hi, x):
        return self.node('ShaderNodeMapRange', {'Value': x, 'From Min': lo, 'From Max': hi, 'To Min': 0.0, 'To Max': 1.0},
                         interpolation_type='SMOOTHSTEP', clamp=True).outputs[0]

    def mixf(self, a, b, t):
        return self.node('ShaderNodeMix', {'Factor': t, 'A': a, 'B': b}, data_type='FLOAT', clamp_factor=False).outputs[0]

    # ---- vector math ----

    def vmath(self, op, a, b=None, c=None, scale=None):
        n = self.node('ShaderNodeVectorMath', operation=op)
        for i, v in enumerate((a, b, c)):
            if v is None:
                continue
            if isinstance(v, bpy.types.NodeSocket):
                self.links.new(v, n.inputs[i])
                n['_depth'] = max(int(n['_depth']), self._depth(v.node) + 1)
            else:
                self.set(n.inputs[i], v if not isinstance(v, (int, float)) else [v, v, v])
        if scale is not None:
            if isinstance(scale, bpy.types.NodeSocket):
                self.links.new(scale, n.inputs['Scale'])
            else:
                n.inputs['Scale'].default_value = scale
        self._place(n, int(n['_depth']))
        return n.outputs['Value'] if op in ('DOT_PRODUCT', 'LENGTH', 'DISTANCE') else n.outputs['Vector']

    def vadd(self, a, b): return self.vmath('ADD', a, b)
    def vsub(self, a, b): return self.vmath('SUBTRACT', a, b)
    def vmul(self, a, b): return self.vmath('MULTIPLY', a, b)
    def vscale(self, a, s): return self.vmath('SCALE', a, scale=s)
    def dot(self, a, b): return self.vmath('DOT_PRODUCT', a, b)
    def norm(self, a): return self.vmath('NORMALIZE', a)
    def length(self, a): return self.vmath('LENGTH', a)
    def vmax(self, a, b): return self.vmath('MAXIMUM', a, b)
    def vmin(self, a, b): return self.vmath('MINIMUM', a, b)

    def vmix(self, a, b, t):
        # (t a float or a vector)
        kind = 'NON_UNIFORM' if isinstance(t, bpy.types.NodeSocket) and t.type == 'VECTOR' else 'UNIFORM'
        n = self.node('ShaderNodeMix', data_type='VECTOR', factor_mode=kind, clamp_factor=False)
        fac = n.inputs[1] if kind == 'NON_UNIFORM' else n.inputs[0]
        for sock, v in ((fac, t), (n.inputs[4], a), (n.inputs[5], b)):
            if isinstance(v, bpy.types.NodeSocket):
                self.links.new(v, sock)
                n['_depth'] = max(int(n['_depth']), self._depth(v.node) + 1)
            else:
                self.set(sock, v if not isinstance(v, (int, float)) or sock.type != 'VECTOR' else [v, v, v])
        self._place(n, int(n['_depth']))
        return n.outputs[1]

    def vsat(self, a):
        return self.vmin(self.vmax(a, 0.0), 1.0)

    def lum(self, a):
        return self.dot(a, (0.299, 0.587, 0.114))

    def splat(self, f):
        return self.vec(f, f, f)

    # ---- inputs ----

    def geometry(self):
        if not hasattr(self, '_geo'):
            self._geo = self.node('ShaderNodeNewGeometry')
        return self._geo

    def attr(self, name, kind='GEOMETRY', out='Vector'):
        return self.node('ShaderNodeAttribute', attribute_type=kind, attribute_name=name).outputs[out]

    def uv(self, name):
        key = '_uv_' + name
        if not hasattr(self, key):
            setattr(self, key, self.node('ShaderNodeUVMap', uv_map=name).outputs[0])
        return getattr(self, key)

    def image(self, img, vector, extension='REPEAT', interpolation='Linear'):
        n = self.node('ShaderNodeTexImage', {'Vector': vector}, image=img, extension=extension, interpolation=interpolation)
        return n.outputs['Color'], n.outputs['Alpha']

    def env(self, img, direction):
        n = self.node('ShaderNodeTexEnvironment', {'Vector': direction}, image=img, interpolation='Linear')
        return n.outputs['Color']

    def group(self, tree, inputs=None):
        n = self.node('ShaderNodeGroup', node_tree=tree)
        for k, v in (inputs or {}).items():
            if isinstance(v, bpy.types.NodeSocket):
                self.links.new(v, n.inputs[k])
            elif v is not None:
                self.set(n.inputs[k], v)
        return n

    def out(self):
        n = self.nodes.get('Material Output') or self.node('ShaderNodeOutputMaterial')
        n.location = (900, 0)
        return n
