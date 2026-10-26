# Side-by-side sheets of the viewer against autorender's renders of the same
# board runs: for each fixtures/shots/bcmp/<changelog id>_<tick>.jpg (the
# viewer at 25/50/75% of the demo), the frame of fixtures/shots/ref/ar/<id>.mp4
# at that tick, game on the left. The video ends with the demo, so a tick is at
# about (tick - (demo end tick - video frames)) / 60 s, refined by matching
# the frames against the video's nearby ones. The demos' first and last
# ticks come from fixtures/shots/bcmp/demos.json ({id: [start, length]}).
#   python tools/boardcmp.py
import collections
import glob
import json
import os
import subprocess

import numpy as np
from PIL import Image

ROOT = os.path.join(os.path.dirname(__file__), '..', 'fixtures', 'shots')
OURS = os.path.join(ROOT, 'bcmp')
VIDEOS = os.path.join(ROOT, 'ref', 'ar')
OUT = os.path.join(ROOT, 'bsheet')
W, H = 480, 270
FPS = 30            # the video sampled this often for lining up
SW, SH = 64, 36     # at this size
WINDOW = 6          # seconds either side of the estimate searched


def signature(img):
    # the picture's top two thirds (no gun, no autorender corner inset), grey,
    # small, normalised
    a = np.asarray(img.convert('L').resize((SW, SH)), dtype=np.float32)[:SH * 2 // 3]
    return (a - a.mean()) / (a.std() + 1e-3)


def video_signatures(video):
    raw = subprocess.check_output(['ffmpeg', '-loglevel', 'error', '-i', video, '-vf', f'fps={FPS},scale={SW}:{SH}', '-f', 'rawvideo', '-pix_fmt', 'gray', '-'])
    frames = np.frombuffer(raw, dtype=np.uint8).reshape(-1, SH, SW).astype(np.float32)[:, :SH * 2 // 3]
    m = frames.mean(axis=(1, 2), keepdims=True)
    s = frames.std(axis=(1, 2), keepdims=True)
    return (frames - m) / (s + 1e-3)


def align(items, start, video):
    # the shift (in seconds) that best matches our frames to the video's
    # around where the estimate puts them: their median, once they agree
    frames = video_signatures(video)
    shifts = []
    for tick, path in items:
        est = (tick - start) / 60
        lo, hi = max(0, int((est - WINDOW) * FPS)), min(len(frames), int((est + WINDOW) * FPS) + 1)
        if hi <= lo:
            continue
        ours = signature(Image.open(path))
        score = (frames[lo:hi] * ours).mean(axis=(1, 2))
        best = int(score.argmax())
        if score[best] > 0.35:
            shifts.append((lo + best) / FPS - est)
    return float(np.median(shifts)) if shifts else 0.0

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
    # (frames from before the video starts, a co-op run's loading in, are left out)
    items = [i for i in items if i[0] >= start]
    if not items:
        continue
    shift = align(items, start, video)
    sheet = Image.new('RGB', (W * 2, H * len(items)))
    for row, (tick, path) in enumerate(items):
        frame = os.path.join(OUT, f'{run}_{tick}_game.jpg')
        subprocess.run(['ffmpeg', '-y', '-loglevel', 'error', '-ss', '%.3f' % max(0, (tick - start) / 60 + shift), '-i', video,
                        '-frames:v', '1', '-vf', 'scale=in_range=full:out_range=full', frame], check=True)
        sheet.paste(Image.open(frame).convert('RGB').resize((W, H)), (0, row * H))
        sheet.paste(Image.open(path).convert('RGB').resize((W, H)), (W, row * H))
        os.remove(frame)
    sheet.save(os.path.join(OUT, run + '.jpg'), quality=85)
    print(run, ticks, start, '%+.2fs' % shift)
