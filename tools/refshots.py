# Reference frames from the real game for comparing the viewer against:
# plays recordings in an isolated game folder (no user autoexec, plugins or
# config), pauses at given ticks and saves screenshots. Console only
# (netcon); the game is quit cleanly, and only a hung game is killed (by
# its PID, never Steam).
#   python tools/refshots.py
import os, random, shutil, socket, string, subprocess, sys, time

GAME = r"C:\Program Files (x86)\Steam\steamapps\common\Portal 2"
STEAM = r"C:\Program Files (x86)\Steam\steam.exe"
# the demo player only plays recordings whose game folder's name matches
# the running one's, so the isolated folder is a "portal2" inside refshots
GAMEDIR = "refshots/portal2"
GD = os.path.join(GAME, *GAMEDIR.split("/"))
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from servertick import server_tick  # noqa: E402
FIXTURES = os.path.join(HERE, "..", "fixtures")
OUT = os.path.join(FIXTURES, "shots", "ref")

# demo file (in fixtures) -> ticks to capture
SHOTS = [
    ("cm_columnblocker.dem", [756, 1300]),
    ("cm_duallasers.dem", [451, 600]),
    ("cm_laserovergoo.dem", [500]),
    ("pair_Buttons_1818_76561198795823814_229948.dem", [300, 690]),
    ("pair_TeamRetrieval_1498_76561198795823814_201453.dem", [400, 900]),
    ("cm_bridgeintro.dem", [400]),
]


def portal_pids():
    out = subprocess.run(["tasklist", "/FI", "IMAGENAME eq portal2.exe", "/FO", "CSV", "/NH"], capture_output=True, text=True).stdout
    return [int(l.split('","')[1]) for l in out.splitlines() if l.startswith('"portal2.exe"')]


def steam_running():
    return subprocess.run(["tasklist", "/FI", "IMAGENAME eq steam.exe"], capture_output=True, text=True).stdout.count("steam.exe") > 0


def main():
    if portal_pids():
        sys.exit("Portal 2 is already running; not starting another")
    os.makedirs(os.path.join(GD, "cfg"), exist_ok=True)
    shutil.copy(os.path.join(HERE, "..", "..", "sar-proof-test", "gameinfo.txt"), os.path.join(GD, "gameinfo.txt"))
    open(os.path.join(GD, "cfg", "autoexec.cfg"), "w").write(
        "cl_drawhud 0\ncrosshair 0\nhud_draw_fixed_reticle 0\njpeg_quality 95\nvolume 0\necho [ref] ready\n")
    for name, _ in SHOTS:
        shutil.copy(os.path.join(FIXTURES, name), os.path.join(GD, name))
    shots = os.path.join(GD, "screenshots")
    shutil.rmtree(shots, ignore_errors=True)

    port = 27100 + random.randint(0, 800)
    pw = "".join(random.choice(string.ascii_letters) for _ in range(16))
    subprocess.Popen([STEAM, "-applaunch", "620", "-game", GAMEDIR, "-novid", "-condebug", "-windowed", "-noborder", "-w", "1600", "-h", "900",
                      "-netconport", str(port), "-netconpassword", pw])
    s, pid = None, None
    for _ in range(600):
        pids = portal_pids()
        if pids and pid is None:
            pid = pids[0]
            subprocess.Popen(["powershell", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", r"H:\Claude\sar-perf\muteproc.ps1", "-ProcessId", str(pid)])
        try:
            s = socket.create_connection(("127.0.0.1", port), timeout=1)
            break
        except OSError:
            time.sleep(0.25)
    if not s:
        sys.exit("couldn't reach the game console")
    s.sendall(("PASS %s\n" % pw).encode())
    s.settimeout(0.2)

    def alive():
        return pid is None or pid in portal_pids()

    def cmd(c, wait):
        print("> %s (%.1fs)" % (c, wait), flush=True)
        try:
            s.sendall((c + "\n").encode())
        except OSError:
            return False
        end = time.time() + wait
        while time.time() < end:
            try:
                s.recv(65536)
            except (socket.timeout, OSError):
                pass
        return alive()

    log = os.path.join(GD, "console.log")

    def log_text():
        try:
            return open(log, encoding="utf-8", errors="replace").read()
        except OSError:
            return ""

    def wait_log(marker, start, limit):
        # the console log growing past `start` with `marker` in it
        end = time.time() + limit
        while time.time() < end and alive():
            if marker in log_text()[start:]:
                return True
            time.sleep(0.25)
        return False

    seq = [0]

    def sync(limit):
        # an echo the game must get round to: proves it's still responding
        seq[0] += 1
        mark = "[ref] sync %d" % seq[0]
        at = len(log_text())
        cmd("echo %s" % mark, 0.1)
        return wait_log(mark, at, limit)

    taken = []
    cmd("echo warm", 10)
    # demo_gototick hangs the game in these maps (both ways), so each shot
    # is a fresh playback that pauses itself at the tick's server tick
    for name, ticks in SHOTS:
        base = name[:-4]
        for t in ticks:
            st = server_tick(os.path.join(FIXTURES, name), t)
            at = len(log_text())
            cmd("playdemo %s" % base, 0.1)
            if not wait_log("Receiving uncompressed update", at, 90) or not sync(30):
                print("demo didn't load:", base)
                break
            cmd("demo_pauseatservertick %d" % st, 0.1)
            cmd("demo_timescale 2", t / 60 / 2 + 8)
            if not sync(20):
                print("game stopped responding playing", base)
                break
            cmd("jpeg", 0.1)
            if not sync(20):
                break
            taken.append("%s_%d" % (base, t))
            cmd("stopdemo", 3)
        else:
            continue
        break

    cmd("quit", 3)
    for limit in (90, 60):
        end = time.time() + limit
        while time.time() < end and portal_pids():
            time.sleep(1)
        if not portal_pids():
            break
        cmd("quit", 3)
    for p in portal_pids():
        print("game hung on quit, killing pid", p)
        subprocess.run(["taskkill", "/PID", str(p), "/F"])

    os.makedirs(OUT, exist_ok=True)
    files = sorted(os.listdir(shots)) if os.path.isdir(shots) else []
    print("screenshots:", files)
    for f, label in zip(files, taken):
        shutil.copy(os.path.join(shots, f), os.path.join(OUT, label + os.path.splitext(f)[1]))
    if os.path.exists(log):
        shutil.copy(log, os.path.join(OUT, "console.log"))
    print("copied to", OUT)
    if not steam_running():
        print("WARNING: Steam is no longer running")


if __name__ == "__main__":
    main()
