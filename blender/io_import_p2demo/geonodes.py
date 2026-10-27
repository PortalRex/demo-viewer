# Geometry node groups: showing each frame's own faces of geometry the
# viewer remade every frame, and turning ropes' ribbons to the camera.
import bpy

FRAME_FILTER = 'P2 Frame Filter'
ROPE = 'P2 Rope'


def _tree(name):
    tree = bpy.data.node_groups.get(name)
    if tree:
        return tree, False
    tree = bpy.data.node_groups.new(name, 'GeometryNodeTree')
    tree.interface.new_socket('Geometry', in_out='INPUT', socket_type='NodeSocketGeometry')
    tree.interface.new_socket('Geometry', in_out='OUTPUT', socket_type='NodeSocketGeometry')
    return tree, True


def frame_filter_group():
    """Keeps the faces whose frames [p2_from, p2_to) hold the scene's frame
    (Blender frame f + 1 is the bundle's frame f)."""
    tree, new = _tree(FRAME_FILTER)
    if not new:
        return tree
    n, l = tree.nodes, tree.links
    gin, gout = n.new('NodeGroupInput'), n.new('NodeGroupOutput')
    time = n.new('GeometryNodeInputSceneTime')
    frame = n.new('ShaderNodeMath')
    frame.operation = 'SUBTRACT'
    l.new(time.outputs['Frame'], frame.inputs[0])
    frame.inputs[1].default_value = 1.0
    attr = {}
    for name in ('p2_from', 'p2_to'):
        a = n.new('GeometryNodeInputNamedAttribute')
        a.data_type = 'INT'
        a.inputs['Name'].default_value = name
        attr[name] = a.outputs['Attribute']
    ge = n.new('FunctionNodeCompare')
    ge.data_type, ge.operation = 'FLOAT', 'GREATER_EQUAL'
    l.new(frame.outputs[0], ge.inputs[0])
    l.new(attr['p2_from'], ge.inputs[1])
    lt = n.new('FunctionNodeCompare')
    lt.data_type, lt.operation = 'FLOAT', 'LESS_THAN'
    l.new(frame.outputs[0], lt.inputs[0])
    l.new(attr['p2_to'], lt.inputs[1])
    both = n.new('FunctionNodeBooleanMath')
    both.operation = 'NAND'
    l.new(ge.outputs[0], both.inputs[0])
    l.new(lt.outputs[0], both.inputs[1])
    delete = n.new('GeometryNodeDeleteGeometry')
    delete.domain = 'FACE'
    l.new(gin.outputs[0], delete.inputs['Geometry'])
    l.new(both.outputs[0], delete.inputs['Selection'])
    l.new(delete.outputs[0], gout.inputs[0])
    for i, node in enumerate((gin, time, frame, ge, lt, both, delete, gout)):
        node.location = (i * 200 - 700, 0)
    return tree


def rope_group(scale):
    """A rope's ribbon, its two edges pushed apart across the view (as the
    viewer's rope vertex shader): side 0 and 1, half its width each way."""
    tree, new = _tree(ROPE)
    if not new:
        return tree
    n, l = tree.nodes, tree.links
    gin, gout = n.new('NodeGroupInput'), n.new('NodeGroupOutput')
    cam = n.new('GeometryNodeInputActiveCamera')
    info = n.new('GeometryNodeObjectInfo')
    l.new(cam.outputs[0], info.inputs['Object'])
    pos = n.new('GeometryNodeInputPosition')

    def named(name, kind):
        a = n.new('GeometryNodeInputNamedAttribute')
        a.data_type = kind
        a.inputs['Name'].default_value = name
        return a.outputs['Attribute']

    def vmath(op, a, b=None, scale_in=None):
        m = n.new('ShaderNodeVectorMath')
        m.operation = op
        l.new(a, m.inputs[0])
        if b is not None:
            l.new(b, m.inputs[1])
        if scale_in is not None:
            l.new(scale_in, m.inputs['Scale'])
        return m.outputs['Vector']

    def math(op, a, b):
        m = n.new('ShaderNodeMath')
        m.operation = op
        for i, v in enumerate((a, b)):
            if isinstance(v, bpy.types.NodeSocket):
                l.new(v, m.inputs[i])
            else:
                m.inputs[i].default_value = v
        return m.outputs[0]

    to_eye = vmath('SUBTRACT', pos.outputs[0], info.outputs['Location'])
    across = vmath('NORMALIZE', vmath('CROSS_PRODUCT', to_eye, vmath('NORMALIZE', named('ropeTangent', 'FLOAT_VECTOR'))))
    amount = math('MULTIPLY', math('MULTIPLY', named('ropeWidth', 'FLOAT'), scale), math('SUBTRACT', named('ropeSide', 'FLOAT'), 0.5))
    offset = vmath('SCALE', across, scale_in=amount)
    setp = n.new('GeometryNodeSetPosition')
    l.new(gin.outputs[0], setp.inputs['Geometry'])
    l.new(offset, setp.inputs['Offset'])
    l.new(setp.outputs[0], gout.inputs[0])
    gout.location = (800, 0)
    return tree


VIEWMODEL = 'P2 Viewmodel In View'


def viewmodel_group():
    """The view model drawn by the scene's own camera, for the viewport: in
    the camera's space, squashed across the view by tan(eyes' fov / 2) /
    tan(view model's fov / 2), so it lands where the view model's camera
    draws it (positions T^-1 C S C^-1 T p, T the object's, C the camera's)."""
    tree = bpy.data.node_groups.get(VIEWMODEL)
    if tree:
        return tree
    tree, _ = _tree(VIEWMODEL)
    tree.interface.new_socket('Squash', in_out='INPUT', socket_type='NodeSocketFloat').default_value = 1.0
    n, l = tree.nodes, tree.links
    gin, gout = n.new('NodeGroupInput'), n.new('NodeGroupOutput')
    cam = n.new('GeometryNodeInputActiveCamera')
    cinfo = n.new('GeometryNodeObjectInfo')
    cinfo.transform_space = 'ORIGINAL'
    l.new(cam.outputs[0], cinfo.inputs['Object'])
    me = n.new('GeometryNodeSelfObject')
    minfo = n.new('GeometryNodeObjectInfo')
    minfo.transform_space = 'ORIGINAL'
    l.new(me.outputs[0], minfo.inputs['Object'])
    squash = n.new('ShaderNodeCombineXYZ')
    l.new(gin.outputs['Squash'], squash.inputs[0])
    l.new(gin.outputs['Squash'], squash.inputs[1])
    squash.inputs[2].default_value = 1.0
    s = n.new('FunctionNodeCombineTransform')
    l.new(squash.outputs[0], s.inputs['Scale'])

    def inv(m):
        node = n.new('FunctionNodeInvertMatrix')
        l.new(m, node.inputs[0])
        return node.outputs[0]

    def mul(a, b):
        node = n.new('FunctionNodeMatrixMultiply')
        l.new(a, node.inputs[0])
        l.new(b, node.inputs[1])
        return node.outputs[0]
    t, c = minfo.outputs['Transform'], cinfo.outputs['Transform']
    m = mul(inv(t), mul(c, mul(s.outputs[0], mul(inv(c), t))))
    pos = n.new('GeometryNodeInputPosition')
    tp = n.new('FunctionNodeTransformPoint')
    l.new(pos.outputs[0], tp.inputs['Vector'])
    l.new(m, tp.inputs['Transform'])
    setp = n.new('GeometryNodeSetPosition')
    l.new(gin.outputs[0], setp.inputs['Geometry'])
    l.new(tp.outputs[0], setp.inputs['Position'])
    l.new(setp.outputs[0], gout.inputs[0])
    gout.location = (1200, 0)
    return tree


SCREEN = 'P2 On Screen'


def screen_group():
    """Where each point is on the scene camera's screen, for a material to
    look up the picture there: p2_clip = (x, y, depth) in the camera's space,
    x and y over tan(half the view's height) (and the aspect, across), so
    x / depth and y / depth run -1..1 over the frame. Linear over a face, so
    it's exact between the corners."""
    tree = bpy.data.node_groups.get(SCREEN)
    if tree:
        return tree
    tree, _ = _tree(SCREEN)
    tree.interface.new_socket('Tan Half Height', in_out='INPUT', socket_type='NodeSocketFloat').default_value = 0.5
    tree.interface.new_socket('Aspect', in_out='INPUT', socket_type='NodeSocketFloat').default_value = 16 / 9
    n, l = tree.nodes, tree.links
    gin, gout = n.new('NodeGroupInput'), n.new('NodeGroupOutput')
    cam = n.new('GeometryNodeInputActiveCamera')
    cinfo = n.new('GeometryNodeObjectInfo')
    cinfo.transform_space = 'ORIGINAL'
    l.new(cam.outputs[0], cinfo.inputs['Object'])
    me = n.new('GeometryNodeSelfObject')
    minfo = n.new('GeometryNodeObjectInfo')
    minfo.transform_space = 'ORIGINAL'
    l.new(me.outputs[0], minfo.inputs['Object'])
    inv = n.new('FunctionNodeInvertMatrix')
    l.new(cinfo.outputs['Transform'], inv.inputs[0])
    mul = n.new('FunctionNodeMatrixMultiply')
    l.new(inv.outputs[0], mul.inputs[0])
    l.new(minfo.outputs['Transform'], mul.inputs[1])
    pos = n.new('GeometryNodeInputPosition')
    tp = n.new('FunctionNodeTransformPoint')
    l.new(pos.outputs[0], tp.inputs['Vector'])
    l.new(mul.outputs[0], tp.inputs['Transform'])
    sep = n.new('ShaderNodeSeparateXYZ')
    l.new(tp.outputs[0], sep.inputs[0])

    def math(op, a, b):
        m = n.new('ShaderNodeMath')
        m.operation = op
        for i, v in enumerate((a, b)):
            if isinstance(v, bpy.types.NodeSocket):
                l.new(v, m.inputs[i])
            else:
                m.inputs[i].default_value = v
        return m.outputs[0]
    across = math('MULTIPLY', gin.outputs['Tan Half Height'], gin.outputs['Aspect'])
    clip = n.new('ShaderNodeCombineXYZ')
    l.new(math('DIVIDE', sep.outputs['X'], across), clip.inputs[0])
    l.new(math('DIVIDE', sep.outputs['Y'], gin.outputs['Tan Half Height']), clip.inputs[1])
    l.new(math('MULTIPLY', sep.outputs['Z'], -1.0), clip.inputs[2])
    store = n.new('GeometryNodeStoreNamedAttribute')
    store.data_type = 'FLOAT_VECTOR'
    store.domain = 'POINT'
    store.inputs['Name'].default_value = 'p2_clip'
    l.new(gin.outputs[0], store.inputs['Geometry'])
    l.new(clip.outputs[0], store.inputs['Value'])
    l.new(store.outputs[0], gout.inputs[0])
    gout.location = (1200, 0)
    return tree
