# Portal 2 demo import: File > Import > Portal 2 Demo (run.json / scene.json),
# what the SAR Run Viewer's Blender export writes: a whole run, or a part.
bl_info = {
    'name': 'Portal 2 Demo Bundle',
    'author': 'PortalRex',
    'version': (0, 1, 0),
    'blender': (4, 2, 0),
    'location': 'File > Import > Portal 2 Demo (run.json / scene.json)',
    'description': 'Imports a Portal 2 demo, as the SAR Run Viewer exports it, looking as it does in the game',
    'category': 'Import-Export',
}

import bpy
from bpy.props import BoolProperty, EnumProperty, FloatProperty, IntProperty, StringProperty
from bpy_extras.io_utils import ImportHelper


class ImportP2Demo(bpy.types.Operator, ImportHelper):
    """Import a Portal 2 demo as the viewer exported it: a segment (scene.json) or a whole run (run.json)"""
    bl_idname = 'import_scene.p2demo'
    bl_label = 'Import Portal 2 Demo'
    bl_options = {'REGISTER', 'UNDO'}

    filename_ext = '.json'
    filter_glob: StringProperty(default='scene.json;run.json', options={'HIDDEN'})

    scale: FloatProperty(name='Scale', description='Blender units per game unit (0.0254: one inch, so a player is 1.83 m tall)', default=0.0254, min=1e-4, max=10.0)
    engine: EnumProperty(name='Render engine', items=[
        ('CYCLES', 'Cycles', 'Exact: portals show the view through them'),
        ('EEVEE', 'Eevee', 'Faster previews'),
    ], default='CYCLES')
    samples: IntProperty(name='Samples', description='Antialiasing samples per pixel', default=32, min=1, max=4096)
    projected_light: BoolProperty(name='Projected lights', description="Maps' projected lights (sunlight through windows, Wheatley's flashlight) as real lights with ray-traced shadows (Cycles)", default=True)

    def execute(self, context):
        from . import importer
        importer.load(context, self.filepath, scale=self.scale, engine=self.engine, samples=self.samples, projected_light=self.projected_light)
        return {'FINISHED'}


def menu_import(self, context):
    self.layout.operator(ImportP2Demo.bl_idname, text='Portal 2 Demo (run.json / scene.json)')


def register():
    bpy.utils.register_class(ImportP2Demo)
    bpy.types.TOPBAR_MT_file_import.append(menu_import)


def unregister():
    bpy.types.TOPBAR_MT_file_import.remove(menu_import)
    bpy.utils.unregister_class(ImportP2Demo)
