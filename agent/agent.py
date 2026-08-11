import argparse
import ctypes
import json
import os
import platform
import sys
import time
import urllib.error
import urllib.request

DEFAULT_URL = os.environ.get("STATUS_SERVER_URL", "https://status-server.bdhm32.workers.dev")


def _uptime():
    if platform.system() == "Windows":
        try:
            return ctypes.windll.kernel32.GetTickCount64() // 1000
        except Exception:
            return None
    if os.path.exists("/proc/uptime"):
        try:
            with open("/proc/uptime") as f:
                return float(f.read().split()[0])
        except Exception:
            return None
    return None


def _memory():
    try:
        import psutil

        vm = psutil.virtual_memory()
        return round(vm.used / vm.total, 4) if vm.total else None
    except ImportError:
        pass
    if platform.system() == "Windows":
        try:

            class MEMORYSTATUSEX(ctypes.Structure):
                _fields_ = [
                    ("dwLength", ctypes.c_ulong),
                    ("dwMemoryLoad", ctypes.c_ulong),
                    ("ullTotalPhys", ctypes.c_ulonglong),
                    ("ullAvailPhys", ctypes.c_ulonglong),
                    ("ullTotalPageFile", ctypes.c_ulonglong),
                    ("ullAvailPageFile", ctypes.c_ulonglong),
                    ("ullTotalVirtual", ctypes.c_ulonglong),
                    ("ullAvailVirtual", ctypes.c_ulonglong),
                    ("ullAvailExtendedVirtual", ctypes.c_ulonglong),
                ]

            mem = MEMORYSTATUSEX()
            mem.dwLength = ctypes.sizeof(MEMORYSTATUSEX)
            if ctypes.windll.kernel32.GlobalMemoryStatusEx(ctypes.byref(mem)) and mem.ullTotalPhys:
                return round(1 - mem.ullAvailPhys / mem.ullTotalPhys, 4)
        except Exception:
            return None
    if os.path.exists("/proc/meminfo"):
        try:
            total = avail = None
            with open("/proc/meminfo") as f:
                for line in f:
                    key, val = line.split(":", 1)
                    val = int(val.strip().split()[0]) * 1024
                    if key == "MemTotal":
                        total = val
                    elif key == "MemAvailable":
                        avail = val
            if total and avail:
                return round(1 - avail / total, 4)
        except Exception:
            return None
    return None


def _cpu():
    try:
        import psutil

        return round(psutil.cpu_percent(interval=0.3) / 100.0, 4)
    except ImportError:
        pass
    if platform.system() == "Windows":
        return _cpu_windows()
    if os.path.exists("/proc/stat"):
        return _cpu_proc()
    return None


def _cpu_windows():
    try:

        class FILETIME(ctypes.Structure):
            _fields_ = [("dwLowDateTime", ctypes.c_uint), ("dwHighDateTime", ctypes.c_uint)]

        k32 = ctypes.windll.kernel32
        idle1, kernel1, user1 = FILETIME(), FILETIME(), FILETIME()
        idle2, kernel2, user2 = FILETIME(), FILETIME(), FILETIME()
        k32.GetSystemTimes(ctypes.byref(idle1), ctypes.byref(kernel1), ctypes.byref(user1))
        time.sleep(0.3)
        k32.GetSystemTimes(ctypes.byref(idle2), ctypes.byref(kernel2), ctypes.byref(user2))

        def to_us(ft):
            return (ft.dwHighDateTime << 32) | ft.dwLowDateTime

        idle = to_us(idle2) - to_us(idle1)
        total = (to_us(kernel2) + to_us(user2)) - (to_us(kernel1) + to_us(user1))
        if total <= 0:
            return None
        return round(1 - idle / total, 4)
    except Exception:
        return None


def _cpu_proc():
    try:

        def snap():
            with open("/proc/stat") as f:
                vals = [int(v) for v in f.readline().split()[1:8]]
            return vals

        t1 = snap()
        time.sleep(0.3)
        t2 = snap()
        d = [b - a for a, b in zip(t1, t2)]
        total = sum(d)
        idle = d[3] + d[4]
        if total <= 0:
            return None
        return round(1 - idle / total, 4)
    except Exception:
        return None


def collect(hostname):
    return {
        "status": "ok",
        "cpu": _cpu(),
        "memory": _memory(),
        "uptime": _uptime(),
        "message": f"{hostname} alive",
        "timestamp": int(time.time() * 1000),
    }


def send(url, token, payload):
    req = urllib.request.Request(
        url.rstrip("/") + "/api/v1/status",
        data=json.dumps(payload).encode(),
        headers={
            "Authorization": "Bearer " + token,
            "Content-Type": "application/json",
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36",
        },
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=15) as resp:
        return resp.status, resp.read()


def main():
    p = argparse.ArgumentParser(description="Report device status to the status-server API.")
    p.add_argument("--url", default=DEFAULT_URL, help="base URL of the status server")
    p.add_argument("--token", default=os.environ.get("STATUS_TOKEN"), help="device token (or STATUS_TOKEN env var)")
    p.add_argument("--interval", type=int, default=60, help="seconds between pings")
    p.add_argument("--once", action="store_true", help="send one ping and exit")
    args = p.parse_args()

    if not args.token:
        p.error("a device token is required: --token <TOKEN> or set the STATUS_TOKEN env var")

    hostname = platform.node()
    print(f"reporting to {args.url} as {hostname}", flush=True)

    while True:
        try:
            status, body = send(args.url, args.token, collect(hostname))
            print(f"[{time.strftime('%H:%M:%S')}] {status} {body.decode()}", flush=True)
        except urllib.error.HTTPError as e:
            print(f"[{time.strftime('%H:%M:%S')}] server rejected: {e.code} {e.read().decode()}", flush=True)
        except Exception as e:
            print(f"[{time.strftime('%H:%M:%S')}] error: {e}", flush=True)
        if args.once:
            break
        time.sleep(args.interval)


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        sys.exit(0)
