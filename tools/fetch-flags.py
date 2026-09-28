#!/usr/bin/env python3
"""Fetch the 4x3 country flags into dist/assets/flags/.

The theme lazy-loads one SVG per country that actually shows up in the fleet,
so the whole set never crosses the wire at once -- but the files have to sit in
the package.  flag-icons (MIT) is the same set the official frontend uses via
its `fi fi-xx` classes; here they are plain files an <img> can point at.

Run from the repo root:  python tools/fetch-flags.py
"""

import concurrent.futures
import json
import os
import sys
import urllib.request

VERSION = "7.2.3"
BASE = f"https://cdn.jsdelivr.net/npm/flag-icons@{VERSION}/flags/4x3"
LISTING = f"https://data.jsdelivr.com/v1/packages/npm/flag-icons@{VERSION}?structure=flat"
OUT = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                   "dist", "assets", "flags")


def names():
    listing = json.load(urllib.request.urlopen(LISTING, timeout=60))
    return sorted(
        os.path.basename(f["name"])[:-4]
        for f in listing["files"]
        if f["name"].startswith("/flags/4x3/") and f["name"].endswith(".svg")
    )


def fetch(code):
    dest = os.path.join(OUT, f"{code}.svg")
    if os.path.exists(dest) and os.path.getsize(dest) > 0:
        return "skip"
    with urllib.request.urlopen(f"{BASE}/{code}.svg", timeout=60) as r:
        data = r.read()
    if not data.lstrip().startswith(b"<svg"):
        raise RuntimeError(f"{code}: not an SVG")
    with open(dest, "wb") as fh:
        fh.write(data)
    return "ok"


def main():
    os.makedirs(OUT, exist_ok=True)
    codes = names()
    done = failed = 0
    with concurrent.futures.ThreadPoolExecutor(max_workers=12) as pool:
        futures = {pool.submit(fetch, c): c for c in codes}
        for fut in concurrent.futures.as_completed(futures):
            code = futures[fut]
            try:
                if fut.result() == "ok":
                    done += 1
            except Exception as exc:  # keep going: one missing flag is not fatal
                failed += 1
                print(f"  ! {code}: {exc}", file=sys.stderr)
    total = sum(os.path.getsize(os.path.join(OUT, f)) for f in os.listdir(OUT))
    print(f"flags: {len(codes)} known, {done} fetched, {failed} failed, "
          f"{total // 1024} KB on disk -> {OUT}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
