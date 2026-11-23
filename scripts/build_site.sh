#!/usr/bin/env bash
# One-shot build for static hosting (Cloudflare Pages etc.).  Output: site/dist  (publish ONLY this directory).
# Never publish the repository root: it contains raw archives (.tgz/.tif, up to ~100 MiB) that exceed Pages' 25 MiB/file limit.
set -euo pipefail
cd "$(dirname "$0")/.."
python3 -c "import numpy, PIL" 2>/dev/null || pip install --quiet numpy pillow
bash tools/precompute/run_all.sh            # -> site/public/{data,assets}
( cd site && npm install --no-audit --no-fund && npm run build )
python3 09_manifests/tools/check_large_files.py --root site/dist --limit-mib 25   # 25 MiB超があれば非0で終了
echo "OK: site/dist ready ($(find site/dist -type f | wc -l) files, $(du -sh site/dist | cut -f1))"
