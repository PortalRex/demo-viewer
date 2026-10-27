# Packs the Blender add-on (blender/io_import_p2demo) into dist/ as an
# extension zip (Blender 4.2+: Preferences > Get Extensions > Install from
# Disk, or drag the zip onto Blender):
#   python tools/pack_blender_addon.py
import os
import zipfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, 'blender', 'io_import_p2demo')
OUT = os.path.join(ROOT, 'dist', 'io_import_p2demo.zip')

os.makedirs(os.path.dirname(OUT), exist_ok=True)
with zipfile.ZipFile(OUT, 'w', zipfile.ZIP_DEFLATED) as z:
    for name in sorted(os.listdir(SRC)):
        if name.endswith('.py') or name.endswith('.toml'):
            z.write(os.path.join(SRC, name), name)
print(OUT)
