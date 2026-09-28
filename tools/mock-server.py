#!/usr/bin/env python3
"""A stand-in for a nezha dashboard, for looking at the theme locally.

Serves dist/ as static files and answers the public API the theme reads,
including a hand-rolled WebSocket for /api/v1/ws/server -- the panel pushes the
whole fleet every two seconds and this does the same, with figures that drift
so the meters actually move.

    python tools/mock-server.py [port]      # then open http://127.0.0.1:8008/

Guests only: /api/v1/profile answers 401, so the theme shows the signed-out
view (1-day ranges, login link).  Nothing here is meant to be exposed.
"""

import base64
import hashlib
import json
import math
import os
import random
import sys
import threading
import time
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

ROOT = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "dist")
GIB = 1024 ** 3
MIB = 1024 ** 2

SERVERS = [
    # name, country, platform, version, arch, virt, cores, mem GiB, disk GiB,
    # price/month in the public note (None = no note at all)
    ("hk-hyn-2c2g", "hk", "ubuntu", "22.04", "x86_64", "kvm", 2, 2, 40, "12.50"),
    ("jp-tokyo-4c8g", "jp", "debian", "12", "x86_64", "kvm", 4, 8, 80, "46.00"),
    ("sg-changi-2c4g", "sg", "alpine", "3.19", "x86_64", "docker", 2, 4, 40, "24.00"),
    ("us-lax-arm-4c24g", "us", "debian", "12", "aarch64", "kvm", 4, 24, 200, "0"),
    ("de-fra-1c1g", "de", "ubuntu", "20.04", "x86_64", "kvm", 1, 1, 20, "5.90"),
    ("cn-sh-2c2g", "cn", "centos", "7.9", "x86_64", "kvm", 2, 2, 40, "88.00"),
    ("win-his-2c4g", "cn", "windows", "2022", "x86_64", "hyperv", 2, 4, 60, None),
    ("fr-gra-2c4g", "fr", "darwin", "14.6", "x86_64", "kvm", 2, 4, 40, "9.90"),
    ("kr-seoul-1c2g", "kr", "freebsd", "14.1", "x86_64", "kvm", 1, 2, 30, "7.00"),
    ("tw-tpe-2c2g", "tw", "alpine", "3.18", "x86_64", "lxc", 2, 2, 30, "10.00"),
    ("cn-bj-4c8g", "cn", "openwrt", "23.05", "aarch64", "none", 4, 8, 120, "-1"),
    ("bg-sof-1c1g", "bg", "debian", "12", "x86_64", "kvm", 1, 1, 20, "4.50"),
]

SERVICES = [
    ("广东电信", "http"),
    ("上海联通", "http"),
    ("北京移动", "icmp"),
    ("香港 CN2", "tcp"),
    ("Cloudflare", "http"),
]


def public_note(idx, price):
    if idx == 6:  # a plain-text note, which is also legal
        return "宿主机迁移窗口：每周三 03:00"
    if idx == 9:  # no note at all
        return ""
    if price is None:
        return json.dumps({"planDataMod": {"bandwidth": "100Mbps", "trafficVol": "1T", "networkRoute": "CN2 GIA"}})
    billing = {
        "startDate": "2026-01-15",
        "endDate": "2030-01-15" if price == "0" else "2026-10-%02d" % (5 + idx),
        "autoRenewal": "1" if idx % 3 else "0",
        "cycle": "月",
        "amount": price,
    }
    return json.dumps({"billingDataMod": billing, "orderLink": "https://example.com/order/%d" % idx})


class Fleet:
    """Figures that drift the way a real fleet does."""

    def __init__(self):
        self.t0 = time.time()
        self.servers = []
        random.seed(7)
        for i, row in enumerate(SERVERS):
            name, cc, plat, ver, arch, virt, cores, mem, disk, price = row
            self.servers.append(
                {
                    "id": i + 1,
                    "name": name,
                    "cc": cc,
                    "platform": plat,
                    "platform_version": ver,
                    "arch": arch,
                    "virt": virt,
                    "cores": cores,
                    "mem": mem * GIB,
                    "disk": disk * GIB,
                    "price": price,
                    "note": public_note(i, price),
                    "phase": random.random() * math.tau,
                    "amp": 8 + random.random() * 25,
                    "base": 18 + random.random() * 45,
                    "disk_base": 12 + random.random() * 70,
                    "mem_base": 25 + random.random() * 55,
                    "up": random.random() * 6 * MIB,
                    "down": random.random() * 40 * MIB,
                    "up_total": random.random() * 900 * GIB,
                    "down_total": random.random() * 6000 * GIB,
                    "uptime": random.randint(3600, 60 * 86400),
                    # Two servers stop reporting, so the offline path is visible.
                    "offline_for": 7200 if i == 7 else (86400 if i == 11 else 0),
                    "quota": 2000 * GIB if i in (1, 3, 10) else 0,
                }
            )

    def frame(self):
        t = time.time() - self.t0
        now_ms = int(time.time() * 1000)
        out = []
        for s in self.servers:
            wave = math.sin(s["phase"] + t / 9.0)
            cpu = max(0.3, min(99.5, s["base"] + s["amp"] * wave))
            mem_pct = max(3.0, min(97.0, s["mem_base"] + 6 * math.sin(s["phase"] + t / 23.0)))
            disk_pct = s["disk_base"]
            up = s["up"] * (1 + 0.5 * math.sin(t / 3.0 + s["phase"]))
            down = s["down"] * (1 + 0.5 * math.cos(t / 4.0 + s["phase"]))
            last_active = now_ms - (s["offline_for"] * 1000 or 1200)
            state = {
                "cpu": round(cpu, 2),
                "mem_used": int(s["mem"] * mem_pct / 100),
                "swap_used": int(0.05 * s["mem"]),
                "disk_used": int(s["disk"] * disk_pct / 100),
                "net_in_transfer": int(s["down_total"] + t * down),
                "net_out_transfer": int(s["up_total"] + t * up),
                "net_in_speed": int(down),
                "net_out_speed": int(up),
                "uptime": s["uptime"] + int(t),
                "load_1": round(cpu / 100 * s["cores"] * 1.1, 2),
                "load_5": round(cpu / 100 * s["cores"] * 1.05, 2),
                "load_15": round(cpu / 100 * s["cores"], 2),
                "tcp_conn_count": int(40 + 260 * abs(wave)),
                "udp_conn_count": int(6 + 20 * abs(wave)),
                "process_count": int(90 + 40 * abs(wave)),
                "temperatures": [{"name": "CPU", "temperature": round(38 + cpu / 3, 1)}],
            }
            if s["offline_for"]:
                state.update({"cpu": 0, "net_in_speed": 0, "net_out_speed": 0})
            host = {
                "platform": s["platform"],
                "platform_version": s["platform_version"],
                "cpu": ["%s %s %d-Core" % (s["platform"].title(), s["arch"], s["cores"])],
                "mem_total": s["mem"],
                "disk_total": s["disk"],
                "swap_total": int(s["mem"] / 2),
                "arch": s["arch"],
                "virtualization": s["virt"],
                "boot_time": int(time.time()) - s["uptime"],
                "version": "v2.3.14",
                "gpu": [],
            }
            out.append(
                {
                    "id": s["id"],
                    "name": s["name"],
                    "public_note": s["note"],
                    "display_index": 0,
                    "host": host,
                    "state": state,
                    "country_code": s["cc"],
                    "last_active": time.strftime(
                        "%Y-%m-%dT%H:%M:%S", time.localtime(last_active / 1000)
                    )
                    + ".000000+08:00",
                }
            )
        return {"now": now_ms, "online": 3, "servers": out}


FLEET = Fleet()


def service_stats():
    """Up/down/delay per service, 30 days, oldest first."""
    day = int(time.time() // 86400)
    stats = {}
    for i, (name, _kind) in enumerate(SERVICES):
        random.seed(100 + i)
        upnt = [random.randint(2800, 2880) for _ in range(30)]
        downnt = [random.choice([0] * 7 + [1, 3, 12, 60]) for _ in range(30)]
        delay = [round(20 + i * 40 + random.random() * 30, 1) for _ in range(30)]
        stats[str(i + 1)] = {
            "service_name": name,
            "current_up": upnt[-1],
            "current_down": downnt[-1],
            "total_up": sum(upnt),
            "total_down": sum(downnt),
            "delay": delay,
            "up": upnt,
            "down": downnt,
        }
        day += 0
    return stats


def cycle_transfer():
    out = {}
    for i, s in enumerate(FLEET.servers):
        if not s["quota"]:
            continue
        out[str(100 + i)] = {
            "name": "%s 流量包" % s["name"],
            "from": "2026-09-01T00:00:00+08:00",
            "to": "2026-10-01T00:00:00+08:00",
            "max": s["quota"],
            "min": 200 * GIB,
            "server_name": {str(s["id"]): s["name"]},
            "transfer": {str(s["id"]): int(FLEET.frame()["servers"][i]["state"]["net_in_transfer"] + FLEET.frame()["servers"][i]["state"]["net_out_transfer"])},
            "next_update": {str(s["id"]): "2026-10-01T00:00:00+08:00"},
        }
    return out


def server_services(server_id):
    """Per-monitor delay series for one server, oldest first."""
    out = []
    for i, (name, _kind) in enumerate(SERVICES):
        random.seed(2000 + server_id * 10 + i)
        if (server_id + i) % 5 == 4:
            continue  # not every monitor covers every server
        now = int(time.time() * 1000)
        count = 48
        out.append(
            {
                "monitor_id": i + 1,
                "server_id": server_id,
                "monitor_name": name,
                "server_name": "",
                "display_index": i,
                "created_at": [now - (count - k) * 1800 * 1000 for k in range(count)],
                "avg_delay": [
                    round(
                        (25 + i * 55 + random.random() * 40)
                        * (3.5 if random.random() < 0.03 else 1),
                        1,
                    )
                    for _ in range(count)
                ],
            }
        )
    return out


METRICS = {
    "cpu": ("percent", 3, 42),
    "memory": ("bytes", 0.35, 0.75),
    "swap": ("bytes", 0.02, 0.1),
    "disk": ("bytes", 0.2, 0.8),
    "net_in_speed": ("speed", 0.2, 1.0),
    "net_out_speed": ("speed", 0.1, 0.6),
    "load1": ("number", 0.2, 1.4),
}


def metric_points(server_id, metric, period):
    kind, lo, hi = METRICS.get(metric, ("number", 0, 1))
    server = FLEET.servers[max(0, min(len(FLEET.servers) - 1, server_id - 1))]
    random.seed(9000 + server_id * 31 + len(metric))
    step = {"1d": 5 * 60, "7d": 30 * 60, "30d": 120 * 60}.get(period, 300)
    span = {"1d": 86400, "7d": 7 * 86400, "30d": 30 * 86400}.get(period, 86400)
    count = span // step
    now = int(time.time())
    points = []
    for k in range(count):
        ts = (now - (count - k) * step) * 1000
        wave = 0.5 + 0.5 * math.sin(k / 17.0 + server["phase"])
        value = lo + (hi - lo) * wave
        if kind == "percent":
            value = max(0.5, min(99.0, value))
        elif kind == "bytes":
            total = server["disk"] if metric == "disk" else server["mem"]
            value = total * value
        elif kind == "speed":
            value = value * 12 * MIB
        else:
            value = value * server["cores"]
        points.append({"ts": ts, "value": round(value, 2)})
    return points


def monitor_history(service_id):
    """Per-server stats for one monitor: up_percent and status'd points.

    Loss varies by server -- a German box loses far more packets to 江西电信
    than the Shanghai machine does -- which is exactly what the theme must
    show, not one service-wide number.
    """
    name, kind = SERVICES[service_id - 1]
    base = 20 + (service_id - 1) * 55
    out = []
    for s in FLEET.servers:
        random.seed(7000 + s["id"] * 17 + service_id)
        if (s["id"] + service_id) % 5 == 4:
            continue  # not every monitor covers every server
        far = s["cc"] in ("us", "de", "fr", "bg")
        loss_p = {
            1: 0.04 if far else 0.005,
            2: 0.10 if far else 0.06,
            3: 0.02,
            4: 0.03 if far else 0.01,
            5: 0.05,
        }[service_id]
        if s["offline_for"]:
            loss_p = 0.98
        count = 96
        now = int(time.time() * 1000)
        points = []
        ok_count = 0
        for k in range(count):
            ok = random.random() > loss_p
            delay = 0 if not ok else round(base * (2.4 if far else 1) + random.random() * 30, 1)
            ok_count += 1 if ok else 0
            points.append({"ts": (now - (count - k) * 15 * 60 * 1000), "delay": delay, "status": 1 if ok else 0})
        out.append(
            {
                "server_id": s["id"],
                "server_name": s["name"],
                "stats": {
                    "avg_delay": round(sum(p["delay"] for p in points) / count, 1),
                    "up_percent": round(100.0 * ok_count / count, 2),
                    "total_up": ok_count,
                    "total_down": count - ok_count,
                    "data_points": points,
                },
            }
        )
    return {"service_id": service_id, "service_name": name, "servers": out}


class Handler(SimpleHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    # A class attribute, not an instance one: BaseHTTPRequestHandler.__init__
    # handles the request before any __init__ body of ours would run.
    quiet = os.environ.get("MOCK_QUIET") == "1"

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=ROOT, **kwargs)

    def log_message(self, fmt, *args):
        if not self.quiet:
            sys.stderr.write("  %s\n" % (fmt % args))

    def send_json(self, payload, status=200):
        body = json.dumps(payload).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def ok(self, data):
        self.send_json({"success": True, "data": data})

    def do_GET(self):
        path = self.path.split("?")[0]
        query = {}
        if "?" in self.path:
            for pair in self.path.split("?", 1)[1].split("&"):
                if "=" in pair:
                    k, v = pair.split("=", 1)
                    query[k] = v

        if path == "/api/v1/ws/server":
            return self.ws_fleet()
        if path == "/api/v1/setting":
            return self.ok(
                {
                    "config": {
                        "config_for_guests": {
                            "language": "zh_CN",
                            "site_name": "Mr.Gu 的探针",
                            "custom_code": "",
                        },
                        "oauth2_providers": {},
                    },
                    "version": "v2.3.14",
                    "tsdb_enabled": True,
                    "frontend_templates": [],
                }
            )
        if path == "/api/v1/profile":
            return self.send_json({"success": False, "error": "unauthorized"}, 401)
        if path == "/api/v1/service-groups":
            return self.ok(
                [
                    {"group": {"id": 1, "name": "境外"}, "servers": [1, 2, 3, 4, 5, 8, 9, 10, 12]},
                    {"group": {"id": 2, "name": "国内"}, "servers": [6, 7, 11]},
                ]
            )
        if path == "/api/v1/service":
            return self.ok(
                {"services": service_stats(), "cycle_transfer_stats": cycle_transfer()}
            )
        if path.startswith("/api/v1/service/") and path.endswith("/history"):
            sid = int(path.split("/")[4])
            if 1 <= sid <= len(SERVICES):
                return self.ok(monitor_history(sid))
            return self.send_json({"success": False, "error": "service not found"}, 404)
        if path == "/api/v1/service/server":
            return self.ok([s["id"] for s in FLEET.servers])
        if path.startswith("/api/v1/server/") and path.endswith("/service"):
            sid = int(path.split("/")[4])
            return self.ok(server_services(sid))
        if path.startswith("/api/v1/server/") and path.endswith("/metrics"):
            sid = int(path.split("/")[4])
            metric = query.get("metric", "cpu")
            period = query.get("period", "1d")
            return self.ok(
                {
                    "server_id": sid,
                    "server_name": FLEET.servers[max(0, sid - 1)]["name"],
                    "metric": metric,
                    "data_points": metric_points(sid, metric, period),
                }
            )
        if path.startswith("/api/"):
            return self.send_json({"success": False, "error": "404"}, 404)

        # Static, with the SPA fallback the dashboard itself implements: only
        # "/" and "/server/<id>" are routes, and both are served index.html.
        target = os.path.normpath(os.path.join(ROOT, path.lstrip("/")))
        if os.path.isfile(target):
            return self.serve_file(target)
        if path == "/" or "/server/" in path:
            return self.serve_file(os.path.join(ROOT, "index.html"))
        self.send_json({"success": False, "error": "404"}, 404)

    def serve_file(self, target):
        ctype = {
            ".html": "text/html; charset=utf-8",
            ".css": "text/css; charset=utf-8",
            ".js": "text/javascript; charset=utf-8",
            ".svg": "image/svg+xml",
            ".png": "image/png",
            ".json": "application/json",
        }.get(os.path.splitext(target)[1], "application/octet-stream")
        with open(target, "rb") as fh:
            body = fh.read()
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    # --- websocket ------------------------------------------------------
    def ws_fleet(self):
        key = self.headers.get("Sec-WebSocket-Key")
        if not key:
            return self.send_json({"success": False, "error": "expected websocket"}, 400)
        accept = base64.b64encode(
            hashlib.sha1((key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").encode()).digest()
        ).decode()
        self.send_response(101, "Switching Protocols")
        self.send_header("Upgrade", "websocket")
        self.send_header("Connection", "Upgrade")
        self.send_header("Sec-WebSocket-Accept", accept)
        self.end_headers()

        interval = float(os.environ.get("MOCK_INTERVAL", "2"))
        count = 0
        try:
            while True:
                frame = json.dumps(FLEET.frame()).encode()
                self.wfile.write(ws_text(frame))
                self.wfile.flush()
                count += 1
                if count % 4 == 0:
                    self.wfile.write(b"\x89\x00")  # ping, answered by the browser
                    self.wfile.flush()
                time.sleep(interval)
        except (BrokenPipeError, ConnectionResetError, OSError):
            return


def ws_text(payload):
    header = bytearray([0x81])
    length = len(payload)
    if length < 126:
        header.append(length)
    elif length < 65536:
        header.append(126)
        header += length.to_bytes(2, "big")
    else:
        header.append(127)
        header += length.to_bytes(8, "big")
    return bytes(header) + payload


def main():
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8008
    server = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    print("mock nezha dashboard on http://127.0.0.1:%d/  (Ctrl-C to stop)" % port)
    print("serving %s" % ROOT)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nbye")
    return 0


if __name__ == "__main__":
    sys.exit(main())
