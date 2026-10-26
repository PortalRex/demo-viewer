# Which viewer shots a change moved, and whether toward the game: pairs the
# shots in two folders by name (<changelog id>_<tick>.jpg, as the sweeps and
# regression runs write them), measures how much each changed, and scores
# both against autorender's frame of that moment (fixtures/shots/ref/ar/<id>.mp4,
# matched to the shot within SEARCH ticks of where the demo puts it). Only
# shots that changed get a sheet (game | before | after); a summary lists all
# of them, most changed first.
#   python tools/shotdiff.py <before dir> <after dir> <out dir> [--threshold 2]
# Dirs are relative to fixtures/shots. Regression runs: shoot a job list
# (fixtures/shots/regress/jobs.json) in the current and a baseline checkout
# with the dev hook shootAt into regress/head and regress/base, then compare.
import argparse
import json
import os
import subprocess

import numpy as np
from PIL import Image, ImageDraw

ROOT = os.path.join(os.path.dirname(__file__), '..', 'fixtures', 'shots')
VIDEOS = os.path.join(ROOT, 'ref', 'ar')
DEMOS = os.path.join(ROOT, 'bcmp', 'demos.json')
W, H = 480, 270
SW, SH = 96, 54
SEARCH = 30  # ticks either side searched for the game's frame


def grey(img):
    a = np.asarray(img.convert('L').resize((SW, SH)), dtype=np.float32)
    return (a - a.mean()) / (a.std() + 1e-3)


def game_frame(id, tick, shot, demos):
    # autorender's frame nearest to what the shot shows, or None
    video = os.path.join(VIDEOS, f'{id}.mp4')
    if id not in demos or not os.path.exists(video):
        return None, 0.0
    dur = float(subprocess.run(['ffprobe', '-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', video], capture_output=True, text=True).stdout or 0)
    start = demos[id][1] - round(dur * 60)
    t0 = max(0, (tick - SEARCH - start) / 60)
    raw = subprocess.run(['ffmpeg', '-v', 'error', '-ss', '%.3f' % t0, '-i', video, '-frames:v', str(2 * SEARCH + 1),
                          '-vf', f'scale={SW}:{SH}', '-f', 'rawvideo', '-pix_fmt', 'gray', '-'], capture_output=True).stdout
    if not raw:
        return None, 0.0
    frames = np.frombuffer(raw, np.uint8).reshape(-1, SH, SW).astype(np.float32)
    frames = (frames - frames.mean(axis=(1, 2), keepdims=True)) / (frames.std(axis=(1, 2), keepdims=True) + 1e-3)
    # (the HUD corner left out)
    mask = np.ones((SH, SW), bool)
    mask[SH * 3 // 4:, SW * 5 // 8:] = False
    target = grey(shot)
    scores = [(f[mask] * target[mask]).mean() for f in frames]
    i = int(np.argmax(scores))
    at = t0 + i / 60
    full = subprocess.run(['ffmpeg', '-v', 'error', '-ss', '%.3f' % at, '-i', video, '-frames:v', '1',
                           '-vf', 'scale=in_range=full:out_range=full', '-f', 'image2pipe', '-vcodec', 'png', '-'], capture_output=True).stdout
    from io import BytesIO
    return (Image.open(BytesIO(full)).convert('RGB') if full else None), float(scores[i])


def likeness(a, b):
    # how alike two pictures are: structure (correlation of the grey
    # pictures) less the mean colour difference (0..1)
    if a is None or b is None:
        return float('nan')
    x, y = grey(a), grey(b)
    corr = float((x * y).mean())
    ca = np.asarray(a.convert('RGB').resize((SW, SH)), dtype=np.float32)
    cb = np.asarray(b.convert('RGB').resize((SW, SH)), dtype=np.float32)
    return corr - float(np.abs(ca - cb).mean()) / 255


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('before')
    ap.add_argument('after')
    ap.add_argument('out')
    ap.add_argument('--threshold', type=float, default=2.0, help='mean change (0-255) a shot needs for a sheet')
    args = ap.parse_args()
    before, after, out = (os.path.join(ROOT, d) for d in (args.before, args.after, args.out))
    os.makedirs(out, exist_ok=True)
    demos = json.load(open(DEMOS)) if os.path.exists(DEMOS) else {}
    names = sorted(set(os.listdir(before)) & set(os.listdir(after)))
    rows = []
    for name in names:
        if not name.endswith('.jpg'):
            continue
        id, tick = name[:-4].split('_')
        b, a = Image.open(os.path.join(before, name)).convert('RGB'), Image.open(os.path.join(after, name)).convert('RGB')
        change = float(np.abs(np.asarray(a.resize((W, H)), np.float32) - np.asarray(b.resize((W, H)), np.float32)).mean())
        game, matched = game_frame(id, int(tick), a, demos) if change >= args.threshold else (None, 0.0)
        lb, la = likeness(b, game), likeness(a, game)
        rows.append((change, name, lb, la, matched))
        if change < args.threshold:
            continue
        sheet = Image.new('RGB', (W * 3, H + 22), 'black')
        for i, img in enumerate([game, b, a]):
            if img is not None:
                sheet.paste(img.resize((W, H)), (i * W, 22))
        d = ImageDraw.Draw(sheet)
        verdict = '' if game is None else (' better' if la > lb + 0.02 else ' worse' if la < lb - 0.02 else ' same')
        d.text((4, 4), f'{name}  game (match {matched:.2f}) | before ({lb:.2f}) | after ({la:.2f})  change {change:.1f}{verdict}', fill='white')
        sheet.save(os.path.join(out, name), quality=88)
    rows.sort(reverse=True)
    with open(os.path.join(out, 'summary.txt'), 'w') as f:
        for change, name, lb, la, matched in rows:
            line = f'{name:24} change {change:5.1f}  vs game: before {lb:6.2f} after {la:6.2f}  (match {matched:.2f})'
            f.write(line + '\n')
            print(line)


if __name__ == '__main__':
    main()
