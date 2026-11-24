#!/usr/bin/env python3
"""
ONC 画像の代表選定（貪欲法による被覆問題）。標準ライブラリのみ使用。

入力: site/public/data/image_geometry.json（l2c 画像の中心緯度経度と有効率）
出力: site/public/data/gallery_picks.json

手順:
  1. 有効率が低い画像（ほぼ真っ黒など）を除外する（既定 0.5 未満）。
  2. 緯度経度を CELL_DEG 度の格子に分け、各画像が RADIUS_DEG 度以内の格子を覆うとみなす。
  3. 「まだ覆われていない格子を最も多く新たに覆う画像」を、K 枚または全格子を覆うまで順に選ぶ。
     同点は画像 ID の順で決めるため、結果は毎回同じになる（再現性あり）。

注意: これは各画像の中心だけを見た簡易な被覆。実際の視野の形や照明条件は扱っていない。
"""
import json
import math
import os
import sys

ROOT = os.path.normpath(os.path.join(os.path.dirname(__file__), "..", ".."))
SRC = os.path.join(ROOT, "site", "public", "data", "image_geometry.json")
OUT = os.path.join(ROOT, "site", "public", "data", "gallery_picks.json")

MIN_VALID_RATIO = 0.5
CELL_DEG = 0.25
RADIUS_DEG = 0.5
K = 12


def build_cells(lat_min, lat_max, lon_min, lon_max):
    """格子の中心点の一覧（行優先、決定的な順序）。"""
    cells = []
    nlat = int(math.ceil((lat_max - lat_min) / CELL_DEG)) + 1
    nlon = int(math.ceil((lon_max - lon_min) / CELL_DEG)) + 1
    for i in range(nlat):
        for j in range(nlon):
            cells.append((lat_min + i * CELL_DEG, lon_min + j * CELL_DEG))
    return cells


def covered_by(img, cells):
    """画像の中心から RADIUS_DEG 以内の格子インデックス集合（経度の繰り返しは考慮しない範囲のみ）。"""
    la, lo = img["center_lat"], img["center_lon"]
    out = set()
    for idx, (clat, clon) in enumerate(cells):
        dlat = clat - la
        dlon = clon - lo
        if dlat * dlat + dlon * dlon <= RADIUS_DEG * RADIUS_DEG:
            out.add(idx)
    return out


def greedy_pick(cands, cells, k):
    """貪欲法で最大 k 枚を選ぶ。戻り値: [(画像, 新規に覆った格子数, 累計覆い率), ...]"""
    coverage = {img["file"]: covered_by(img, cells) for img in cands}
    uncovered = set()
    for s in coverage.values():
        uncovered |= s
    total = len(uncovered)
    picked = []
    remaining = list(cands)
    for _ in range(k):
        best, best_gain = None, 0
        for img in sorted(remaining, key=lambda im: im["file"]):  # 同点は ID 順
            gain = len(coverage[img["file"]] & uncovered)
            if gain > best_gain:
                best, best_gain = img, gain
        if best is None:
            break
        uncovered -= coverage[best["file"]]
        remaining.remove(best)
        covered_now = total - len(uncovered)
        picked.append((best, best_gain, covered_now / total if total else 0.0))
    return picked, total


def main():
    with open(SRC, encoding="utf-8") as f:
        geo = json.load(f)
    imgs = [im for im in geo["images"] if im.get("valid_ratio", 0) >= MIN_VALID_RATIO]
    if not imgs:
        print("NG: 有効な画像がありません", file=sys.stderr)
        return 1

    lats = [im["center_lat"] for im in imgs]
    lons = [im["center_lon"] for im in imgs]
    lat_min, lat_max = math.floor(min(lats)) - RADIUS_DEG, math.ceil(max(lats)) + RADIUS_DEG
    lon_min, lon_max = math.floor(min(lons)) - RADIUS_DEG, math.ceil(max(lons)) + RADIUS_DEG
    cells = build_cells(lat_min, lat_max, lon_min, lon_max)

    picked, total = greedy_pick(imgs, cells, K)
    result = {
        "method": "greedy set cover on lat/lon grid",
        "params": {"min_valid_ratio": MIN_VALID_RATIO, "cell_deg": CELL_DEG,
                   "radius_deg": RADIUS_DEG, "k": K},
        "candidates": len(imgs),
        "covered_cells_total": total,
        "picks": [
            {"rank": r + 1, "file": im["file"], "utc": im.get("utc"), "camera": im.get("camera"),
             "center_lat": im["center_lat"], "center_lon": im["center_lon"],
             "valid_ratio": im.get("valid_ratio"), "new_cells": gain,
             "cumulative_coverage": round(cov, 4)}
            for r, (im, gain, cov) in enumerate(picked)
        ],
    }
    with open(OUT, "w", encoding="utf-8") as f:
        json.dump(result, f, ensure_ascii=False, indent=1)
        f.write("\n")
    last = result["picks"][-1]["cumulative_coverage"] if result["picks"] else 0
    print(f"candidates {len(imgs)} / cells {total} / picked {len(picked)} / coverage {last:.1%}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
