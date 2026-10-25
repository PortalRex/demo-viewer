# Reference frames from the real game for comparing the viewer against:
# plays recordings in an isolated game folder (no user autoexec or config),
# renders each to video (SAR) and cuts frames at given ticks as
# screenshots. Console only (netcon); the game is quit cleanly, and only a
# hung game is killed (by its PID, never Steam).
#   python tools/refshots.py
import os, random, shutil, socket, string, subprocess, sys, threading, time

GAME = r"C:\Program Files (x86)\Steam\steamapps\common\Portal 2"
CDB = r"C:\Program Files (x86)\Windows Kits\10\Debuggers\x86\cdb.exe"
SAR = r"H:\Claude\sar-deploy\sar.dll"  # the renderer build
AUTORENDER = r"H:\Claude\sar-perf\autorender.cfg"
# the demo player only plays recordings whose game folder's name matches
# the running one's, so the isolated folder is a "portal2" inside refshots
GAMEDIR = "refshots/portal2"
GD = os.path.join(GAME, *GAMEDIR.split("/"))
HERE = os.path.dirname(os.path.abspath(__file__))
FIXTURES = os.path.join(HERE, "..", "fixtures")
OUT = os.path.join(FIXTURES, "shots", "ref")

# demo file (in fixtures) -> ticks to capture
SHOTS = [
    ("cm_duallasers.dem", [200, 300]),
    ("cm_triplelaser.dem", [300, 600]),
    ("cm_bombflings.dem", [300, 600]),
]


def portal_pids():
    out = subprocess.run(["tasklist", "/FI", "IMAGENAME eq portal2.exe", "/FO", "CSV", "/NH"], capture_output=True, text=True).stdout
    return [int(l.split('","')[1]) for l in out.splitlines() if l.startswith('"portal2.exe"')]


def steam_running():
    return subprocess.run(["tasklist", "/FI", "IMAGENAME eq steam.exe"], capture_output=True, text=True).stdout.count("steam.exe") > 0


def say(text):
    try:
        print(text, flush=True)
    except (UnicodeError, OSError):
        pass


def main():
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    if portal_pids():
        sys.exit("Portal 2 is already running; not starting another")
    if not steam_running():
        sys.exit("Steam isn't running")
    os.makedirs(os.path.join(GD, "cfg"), exist_ok=True)
    shutil.copy(os.path.join(HERE, "..", "..", "sar-proof-test", "gameinfo.txt"), os.path.join(GD, "gameinfo.txt"))
    # Rendered the way runs are rendered (autorender's config and client
    # autoexec, as the renderer setup in sar-perf uses), with SAR's renderer
    # build loaded as a copy under its own name: the user's sar.dll is never
    # touched.
    shutil.copy(SAR, os.path.join(GAME, "refshots_sar.dll"))
    with open(AUTORENDER, encoding="utf-8") as f:
        autorender = f.read().replace("plugin_load sar\n", "plugin_load refshots_sar\n", 1)
    with open(os.path.join(GD, "cfg", "autorender.cfg"), "w", encoding="utf-8") as f:
        f.write(autorender)
    with open(os.path.join(GD, "cfg", "autoexec.cfg"), "w", encoding="utf-8") as f:
        f.write("exec autorender\nsar_togglewait\nsar_on_demo_start snd_restart\n"
                "sar_quickhud_set_texture crosshair/quickhud900-\ncl_crosshairgap 7.5\nmat_vsync 0\nfps_max 0\n"
                "sar_render_skip_coop_videos 1\nsar_disable_no_focus_sleep 1\njoystick 0\nvolume 0\necho [ref] ready\n")
    for name, _ in SHOTS:
        shutil.copy(os.path.join(FIXTURES, name), os.path.join(GD, name))

    port = 27100 + random.randint(0, 800)
    pw = "".join(random.choice(string.ascii_letters) for _ in range(16))
    # started directly (Steam must be running) rather than through Steam,
    # which hooks its overlay in
    subprocess.Popen([os.path.join(GAME, "portal2.exe"), "-game", GAMEDIR, "-novid", "-nojoy", "-condebug", "-windowed",
                      "-w", "1600", "-h", "900", "-netconport", str(port), "-netconpassword", pw], cwd=GAME, env=dict(os.environ, VPROJECT=GD))
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

    # the game blocks on its console socket when nobody reads it (loading
    # prints a lot), so it's drained all the time; the text doubles as the log
    out = []
    lock = threading.Lock()

    def drain():
        while True:
            try:
                got = s.recv(65536)
            except socket.timeout:
                continue
            except OSError:
                return
            if not got:
                return
            text = got.decode("utf-8", "replace")
            with lock:
                out.append(text)
            for line in text.splitlines():
                say("  | " + line)

    threading.Thread(target=drain, daemon=True).start()

    def alive():
        return pid is None or pid in portal_pids()

    def cmd(c, wait):
        say("> %s (%.1fs)" % (c, wait))
        try:
            s.sendall((c + "\n").encode())
        except OSError:
            return False
        time.sleep(wait)
        return alive()

    def log_text():
        with lock:
            return "".join(out)

    def wait_log(marker, start, limit):
        # the console output past `start` with `marker` in it
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
        mark = "ref-sync-%d" % seq[0]
        at = len(log_text())
        cmd("echo %s" % mark, 0.1)
        return wait_log(mark, at, limit)

    def dump_stacks():
        # where a stuck game's main thread is (a few samples), for diagnosis
        if not os.path.exists(CDB) or pid is None:
            return
        os.makedirs(OUT, exist_ok=True)
        for i in range(3):
            r = subprocess.run([CDB, "-pv", "-p", str(pid), "-c", "lm o; ~0kv 40; qd"], capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=120)
            with open(os.path.join(OUT, "stack%d.txt" % i), "w", encoding="utf-8") as f:
                f.write(r.stdout)
            time.sleep(2)

    # Each recording is rendered to a video by SAR's renderer (60 fps, one
    # frame per tick) and the shots are cut from it. (Screenshots and paused
    # demos don't work in this setup: jpeg never writes in a map, and paused
    # playback stalls in the engine's frame limiter.)
    rendered = []
    cmd("echo warm", 10)
    for name, ticks in SHOTS:
        base = name[:-4]
        video = os.path.join(GD, base + ".mp4")
        if os.path.exists(video):
            os.remove(video)
        at = len(log_text())
        cmd("playdemo %s" % base, 0.1)
        if not wait_log("Receiving uncompressed update", at, 120):
            say("demo didn't load: " + base)
            cmd("stopdemo", 3)
            continue
        if not wait_log("Rendered", at, 600):
            say("no render finished for " + base)
            dump_stacks()
            break
        cmd("echo next", 3)
        if os.path.exists(video):
            rendered.append((base, ticks, video))

    cmd("quit", 3)
    for limit in (90, 60):
        end = time.time() + limit
        while time.time() < end and portal_pids():
            time.sleep(1)
        if not portal_pids():
            break
        cmd("quit", 3)
    for p in portal_pids():
        say("game hung on quit, killing pid %d" % p)
        subprocess.run(["taskkill", "/PID", str(p), "/F"])

    os.makedirs(OUT, exist_ok=True)
    for base, ticks, video in rendered:
        shutil.copy(video, os.path.join(OUT, base + ".mp4"))
        for t in ticks:
            subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-ss", "%.4f" % (t / 60), "-i", video, "-frames:v", "1", "-q:v", "2",
                            os.path.join(OUT, "%s_%d.jpg" % (base, t))])
    say("rendered: %s" % [b for b, _, _ in rendered])
    log = os.path.join(GD, "console.log")
    if os.path.exists(log):
        shutil.copy(log, os.path.join(OUT, "console.log"))
    say("copied to " + OUT)
    if not steam_running():
        say("WARNING: Steam is no longer running")


if __name__ == "__main__":
    main()
