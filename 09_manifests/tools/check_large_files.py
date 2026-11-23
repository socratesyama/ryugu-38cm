#!/usr/bin/env python3
"""
リポジトリ内の大きすぎるファイルを列挙する（Cloudflare Pages の上限確認用）。
scripts/build_site.sh と同じ基準（25 MiB）で判定する。標準ライブラリのみ使用。

使用例:
  python3 09_manifests/tools/check_large_files.py
  python3 09_manifests/tools/check_large_files.py --limit-mib 10
"""
import argparse
import os
import sys

SKIP_DIRS = {".git", "node_modules", "__pycache__"}


def find_large_files(root, limit_bytes):
    hits = []
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = [d for d in dirnames if d not in SKIP_DIRS]
        for name in filenames:
            path = os.path.join(dirpath, name)
            try:
                size = os.path.getsize(path)
            except OSError:
                continue
            if size > limit_bytes:
                hits.append((size, os.path.relpath(path, root)))
    return sorted(hits, reverse=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--root", default=os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..")),
                        help="検査するリポジトリのルート（既定: このスクリプトから見た上位2階層）")
    parser.add_argument("--limit-mib", type=float, default=25.0, help="上限サイズ（MiB、既定 25）")
    args = parser.parse_args()

    limit_bytes = int(args.limit_mib * 1024 * 1024)
    hits = find_large_files(args.root, limit_bytes)

    if not hits:
        print(f"OK: {args.limit_mib} MiB を超えるファイルはありません。")
        return 0

    print(f"{args.limit_mib} MiB を超えるファイル: {len(hits)} 件")
    for size, rel in hits:
        print(f"  {size / (1024 * 1024):8.2f} MiB  {rel}")
    return 1


if __name__ == "__main__":
    sys.exit(main())
