#!/bin/bash
# Pack dist/ into dist.zip, the asset the dashboard's script/fetch-frontends.sh
# downloads from a release:  <repository>/releases/download/<tag>/dist.zip
#
# The archive must contain a top-level dist/ directory, because that script
# unzips it and then moves `dist` into cmd/dashboard/<path>.
#
#   ./build.sh              -> dist.zip next to this script
#   ./build.sh v1.0.0       -> also print the release command for that tag
set -eu

cd "$(dirname "$0")"

[ -f dist/index.html ] || { echo "dist/index.html is missing" >&2; exit 1; }
[ -f dist/assets/app.js ] || { echo "dist/assets/app.js is missing" >&2; exit 1; }
[ -f theme.json ] || { echo "theme.json is missing" >&2; exit 1; }

if [ ! -d dist/assets/flags ] || [ -z "$(ls -A dist/assets/flags 2>/dev/null)" ]; then
  echo "note: dist/assets/flags is empty -- run 'python tools/fetch-flags.py' first," >&2
  echo "      or the theme will show country codes instead of flags." >&2
fi

if [ ! -f dist/assets/os/generic.svg ]; then
  echo "note: dist/assets/os is empty -- run 'python tools/fetch-os-icons.py' first," >&2
  echo "      or servers will show no platform logo." >&2
fi

rm -f dist.zip
# Python's zipfile, so the same script works in Git Bash, WSL and macOS alike.
python - <<'PY'
import os, zipfile

root = os.path.abspath("dist")
count = 0
with zipfile.ZipFile("dist.zip", "w", zipfile.ZIP_DEFLATED, compresslevel=9) as zf:
    for base, _dirs, files in os.walk(root):
        for name in sorted(files):
            full = os.path.join(base, name)
            # Arcnames are relative to the repository root, so the archive holds
            # exactly the `dist/...` layout the dashboard expects.
            zf.write(full, os.path.relpath(full, "."))
            count += 1
print("dist.zip: %d files, %.0f KB" % (count, os.path.getsize("dist.zip") / 1024))
PY

if [ $# -ge 1 ]; then
  tag="$1"
  echo
  echo "publish it as a release asset:"
  echo "  gh release create $tag dist.zip --title \"$tag\" --notes \"nezha win2000 theme $tag\""
  echo
  echo "then the dashboard entry is:"
  echo "  - path: \"win2000-dist\""
  echo "    name: \"Win2000\""
  echo "    repository: \"<your fork>\""
  echo "    author: \"<your name>\""
  echo "    version: \"$tag\""
fi
