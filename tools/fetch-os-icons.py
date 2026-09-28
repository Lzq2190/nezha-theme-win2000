#!/usr/bin/env python3
"""Fetch platform (OS) logos into dist/assets/os/.

Source is simple-icons (CC0; the logos themselves remain their owners'
trademarks -- same set the Nezha ecosystem draws from).  The upstream SVGs are
monochrome with no fill, so each file gets its brand colour injected here: an
<img> cannot be recoloured from CSS, and the theme relies on the colour to
tell a Debian from an Ubuntu at 14px.

Slugs that upstream no longer ships are skipped with a note; the theme falls
back to the bundled generic mark for anything missing.

Run from the repo root:  python tools/fetch-os-icons.py
"""

import concurrent.futures
import os
import re
import sys
import urllib.request

VERSION = "11.14.0"
BASE = f"https://cdn.jsdelivr.net/npm/simple-icons@{VERSION}/icons"
OUT = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                   "dist", "assets", "os")

# host.platform (lower-cased) -> (simple-icons slug, brand colour)
PLATFORMS = {
    "ubuntu": ("ubuntu", "#E95420"),
    "debian": ("debian", "#A81D33"),
    "centos": ("centos", "#9CCD2A"),
    "alpine": ("alpinelinux", "#0D597F"),
    "arch": ("archlinux", "#1793D1"),
    "archlinux": ("archlinux", "#1793D1"),
    "manjaro": ("manjaro", "#35BF5C"),
    "fedora": ("fedora", "#51A2DA"),
    "redhat": ("redhat", "#EE0000"),
    "rhel": ("redhat", "#EE0000"),
    "rocky": ("rockylinux", "#10B981"),
    "rockylinux": ("rockylinux", "#10B981"),
    "almalinux": ("almalinux", "#FFCC00"),
    "opensuse": ("opensuse", "#73BA25"),
    "suse": ("opensuse", "#73BA25"),
    "linuxmint": ("linuxmint", "#87CF3E"),
    "mint": ("linuxmint", "#87CF3E"),
    "kali": ("kalilinux", "#367BF0"),
    "gentoo": ("gentoo", "#54487A"),
    "nixos": ("nixos", "#5277C3"),
    "void": ("voidlinux", "#47806B"),
    "freebsd": ("freebsd", "#AB2B28"),
    "openwrt": ("openwrt", "#00B5E2"),
    "raspbian": ("raspberrypi", "#C51A4A"),
    "raspberrypi": ("raspberrypi", "#C51A4A"),
    "oracle": ("oracle", "#F80000"),
    "ol": ("oracle", "#F80000"),
    "windows": ("windows", "#0078D4"),
    "darwin": ("apple", "#A2A2A2"),
    "macos": ("apple", "#A2A2A2"),
    "osx": ("apple", "#A2A2A2"),
    "apple": ("apple", "#A2A2A2"),
    "deepin": ("linux", "#238CFE"),
    "amit": ("linux", "#E95420"),
}
# Always fetched: the Tux fallback and the drawn generic mark.
EXTRA = {"linux": ("linux", "#F0B429")}

GENERIC = """<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="#8a8a8a">
  <path d="M3 4h18a1 1 0 0 1 1 1v12a1 1 0 0 1-1 1h-8v2h3a1 1 0 0 1 0 2H8a1 1 0 0 1 0-2h3v-2H3a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1zm1 2v10h16V6H4zm3 2 3 3-3 3-1.2-1.2L7.6 11 5.8 9.2 7 8zm5 6h6v1.6h-6V14z"/>
</svg>
"""


def fetch(slug, color):
    dest = os.path.join(OUT, f"{slug}.svg")
    if os.path.exists(dest) and os.path.getsize(dest) > 0:
        return "skip"
    url = f"{BASE}/{slug}.svg"
    try:
        with urllib.request.urlopen(url, timeout=45) as r:
            data = r.read().decode("utf-8", "replace")
    except Exception as exc:
        return f"MISSING ({exc.reason if hasattr(exc, 'reason') else exc})"
    if "<svg" not in data:
        return "MISSING (not an svg)"
    # Inject the brand colour on the root element; the path inherits it.
    data = re.sub(r"<svg ", f'<svg fill="{color}" ', data, count=1)
    data = re.sub(r"<title>.*?</title>", "", data, flags=re.S)
    with open(dest, "w", encoding="utf-8", newline="\n") as fh:
        fh.write(data)
    return "ok"


def main():
    os.makedirs(OUT, exist_ok=True)
    # A generic mark drawn for this theme: a terminal, tinted grey.
    with open(os.path.join(OUT, "generic.svg"), "w", encoding="utf-8", newline="\n") as fh:
        fh.write(GENERIC)

    wanted = dict(PLATFORMS)
    wanted.update(EXTRA)
    results = {}
    with concurrent.futures.ThreadPoolExecutor(max_workers=10) as pool:
        futures = {pool.submit(fetch, slug, color): slug for slug, (slug, color) in wanted.items()}
        for fut in concurrent.futures.as_completed(futures):
            results[futures[fut]] = fut.result()

    ok = sorted(s for s, r in results.items() if r in ("ok", "skip"))
    missing = sorted(f"{s}: {r}" for s, r in results.items() if s not in ok)
    print(f"os icons: {len(ok)} present -> {OUT}")
    for m in missing:
        print("  !", m)
    return 0


if __name__ == "__main__":
    sys.exit(main())
