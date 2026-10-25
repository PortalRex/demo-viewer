# Demo tick -> server tick (from each packet's net_Tick), for pausing the
# game's demo player at a given demo tick with demo_pauseatservertick
#   python tools/servertick.py fixtures/x.dem 500
import struct, sys


def offsets(path):
    d = open(path, "rb").read()
    p = 1072
    out = []
    while p < len(d):
        cmd = d[p]
        tick = struct.unpack_from("<i", d, p + 1)[0]
        p += 6
        if cmd in (1, 2):
            p += 152 + 8
            size = struct.unpack_from("<i", d, p)[0]
            data = d[p + 4:p + 4 + size]
            p += 4 + size
            # first message: 6-bit type, net_Tick (4) carries the server tick
            if len(data) >= 5 and data[0] & 0x3f == 4:
                bits = int.from_bytes(data[:6], "little")
                out.append((tick, (bits >> 6) & 0xffffffff))
        elif cmd == 3:
            pass
        elif cmd in (4, 5, 6, 8, 9):  # console cmd, user cmd, data tables, custom data, string tables
            if cmd in (5, 8):
                p += 4
            size = struct.unpack_from("<i", d, p)[0]
            p += 4 + size
        elif cmd == 7:
            break
        else:
            break
    return out


def server_tick(path, demo_tick):
    best = None
    for t, s in offsets(path):
        if t > 0 and (best is None or abs(t - demo_tick) < abs(best[0] - demo_tick)):
            best = (t, s)
    return best[1] + (demo_tick - best[0]) if best else None


if __name__ == "__main__":
    print(server_tick(sys.argv[1], int(sys.argv[2])))
    o = offsets(sys.argv[1])
    print(o[:3], o[-2:])
