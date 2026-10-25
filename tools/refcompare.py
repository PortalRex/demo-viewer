# Brightness of viewer shots against the game's renders: the mean linear
# luminance of each frame's upper 60% (above the gun and the timer HUD), and
# viewer / game.
#   python tools/refcompare.py
import os, subprocess

SHOTS = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "fixtures", "shots")

PAIRS = [
    ("ref/cm_laserovergoo_300.jpg", "v_cm_laserovergoo_300.png"),
    ("ref/cm_laserovergoo_500.jpg", "v_cm_laserovergoo_500.png"),
    ("ref/cm_laserovergoo_800.jpg", "v_cm_laserovergoo_800.png"),
    ("ref/cm_duallasers_300.jpg", "v_cm_duallasers_300.png"),
    ("ref/cm_columnblocker_756.jpg", "cmp_cm_columnblocker_756.png"),
    ("ref/cm_columnblocker_1300.jpg", "cmp_cm_columnblocker_1300.png"),
    ("ref/tr_400.jpg", "cmp_retrieval_400.png"),
    ("ref/tr_700.jpg", "cmp_retrieval_700.png"),
]


def lum(path):
    raw = subprocess.run(["ffmpeg", "-loglevel", "error", "-i", path, "-vf", "scale=160:90,format=rgb24", "-f", "rawvideo", "-"],
                         capture_output=True).stdout
    lin = lambda c: ((c / 255 + 0.055) / 1.055) ** 2.4 if c / 255 > 0.04045 else c / 255 / 12.92
    total = 0
    for y in range(54):
        for x in range(160):
            i = (y * 160 + x) * 3
            r, g, b = (lin(c) for c in raw[i:i + 3])
            total += 0.2126 * r + 0.7152 * g + 0.0722 * b
    return total / (54 * 160)


if __name__ == "__main__":
    for game, viewer in PAIRS:
        g, v = os.path.join(SHOTS, game), os.path.join(SHOTS, viewer)
        if not (os.path.exists(g) and os.path.exists(v)):
            continue
        a, b = lum(g), lum(v)
        print(f"{viewer:34s} game {a:.4f} viewer {b:.4f} ratio {b / a:.2f}")
