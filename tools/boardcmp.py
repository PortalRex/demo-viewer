# Side-by-side sheets of the viewer against autorender's renders of the same
# board runs: for each fixtures/shots/bcmp/<changelog id>_<tick>.jpg (the
# viewer at 25/50/75% of the demo), the frame of fixtures/shots/ref/ar/<id>.mp4
# at that tick, game on the left. The video ends with the demo, so a tick is at
# (tick - (demo end tick - video frames)) / 60 s. The demos' first and last
# ticks come from fixtures/shots/bcmp/demos.json ({id: [start, length]}).
#   python tools/boardcmp.py
import collections
import glob
import json
import os
import subprocess

from PIL import Image

ROOT = os.path.join(os.path.dirname(__file__), '..', 'fixtures', 'shots')
OURS = os.path.join(ROOT, 'bcmp')
VIDEOS = os.path.join(ROOT, 'ref', 'ar')
OUT = os.path.join(ROOT, 'bsheet')
W, H = 480, 270

os.makedirs(OUT, exist_ok=True)
demos = json.load(open(os.path.join(OURS, 'demos.json')))
shots = collections.defaultdict(list)
for path in glob.glob(os.path.join(OURS, '*.jpg')):
    run, tick = os.path.basename(path)[:-4].split('_')
    shots[run].append((int(tick), path))

for run, items in sorted(shots.items()):
    video = os.path.join(VIDEOS, run + '.mp4')
    if not os.path.exists(video) or run not in demos:
        continue
    ticks = demos[run][0] + demos[run][1]
    items = sorted(i for i in items if i[0] <= ticks)
    if not items:
        continue
    duration = float(subprocess.check_output(['ffprobe', '-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', video]))
    start = ticks - round(duration * 60)
    sheet = Image.new('RGB', (W * 2, H * len(items)))
    for row, (tick, path) in enumerate(items):
        frame = os.path.join(OUT, f'{run}_{tick}_game.jpg')
        subprocess.run(['ffmpeg', '-y', '-loglevel', 'error', '-ss', '%.3f' % (max(0, tick - start) / 60), '-i', video,
                        '-frames:v', '1', '-vf', 'scale=in_range=full:out_range=full', frame], check=True)
        sheet.paste(Image.open(frame).convert('RGB').resize((W, H)), (0, row * H))
        sheet.paste(Image.open(path).convert('RGB').resize((W, H)), (W, row * H))
        os.remove(frame)
    sheet.save(os.path.join(OUT, run + '.jpg'), quality=85)
    print(run, ticks, start)
