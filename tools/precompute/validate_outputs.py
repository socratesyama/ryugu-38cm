#!/usr/bin/env python3
"""
run_all.sh の最後に実行する、生成済みサイトアセットの検証。
check-assets.mjs（7 ファイル）が見ていない項目を含めて確認する。標準ライブラリのみ使用。

確認内容:
  - 必須ファイルが存在し、空でないこと（形状メッシュ・GLB・ギャラリーを含む）
  - temperature_curves.json の形（513 曲線 × 96 点）と mara_comparison の存在
  - 各 JSON が解析できること
"""
import json
import os
import sys

ROOT = os.path.normpath(os.path.join(os.path.dirname(__file__), "..", ".."))
PUB = os.path.join(ROOT, "site", "public")

REQUIRED_FILES = [
    "data/rotation.json",
    "data/sun_table.json",
    "data/gravity_763.json",
    "data/gravity_340.json",
    "data/features.json",
    "data/temperature_curves.json",
    "data/gallery_manifest.json",
    "data/gallery_picks.json",
    "data/mara.json",
    "data/sc_table.bin",
    "assets/generated/ryugu_lod3_5k.obj",
    "assets/generated/ryugu_heightmap_2048.png",
    "assets/hayabusa2_spacecraft.glb",
    "assets/shape/ryugu_shape_spc_49k_v20200323_web.obj",
    "assets/shape/ryugu_shape_sfm_50k_v20200815_web.obj",
    "assets/shape/ryugu_pointcloud_sfm3m_316k_color_web.ply",
]
JSON_FILES = [f for f in REQUIRED_FILES if f.endswith(".json")]

TC_CURVES = 19 * 9 * 3   # lat(-90..90 step 10) x TI(50..450 step 50) x sub-solar lat(3)
TC_POINTS = 96           # 15 分刻み


def fail(errors, msg):
    errors.append(msg)


def main():
    errors = []

    for rel in REQUIRED_FILES:
        path = os.path.join(PUB, rel)
        if not os.path.isfile(path):
            fail(errors, f"欠落: {rel}")
        elif os.path.getsize(path) == 0:
            fail(errors, f"空のファイル: {rel}")

    for rel in JSON_FILES:
        path = os.path.join(PUB, rel)
        if not os.path.isfile(path) or os.path.getsize(path) == 0:
            continue
        try:
            with open(path, encoding="utf-8") as f:
                json.load(f)
        except (OSError, ValueError) as e:
            fail(errors, f"JSON 解析エラー: {rel}: {e}")

    tc_path = os.path.join(PUB, "data", "temperature_curves.json")
    if os.path.isfile(tc_path):
        with open(tc_path, encoding="utf-8") as f:
            tc = json.load(f)
        curves = tc.get("curves_K", [])
        if len(curves) != TC_CURVES:
            fail(errors, f"temperature_curves: 曲線数 {len(curves)} != {TC_CURVES}")
        bad = [i for i, c in enumerate(curves) if len(c) != TC_POINTS]
        if bad:
            fail(errors, f"temperature_curves: 点数が {TC_POINTS} でない曲線 {len(bad)} 本（先頭 index {bad[0]}）")
        if "mara_comparison" not in tc:
            fail(errors, "temperature_curves: mara_comparison がありません")

    if errors:
        print(f"NG: {len(errors)} 件の問題があります")
        for e in errors:
            print(f"  - {e}")
        return 1
    print(f"OK: 生成アセット {len(REQUIRED_FILES)} 件・JSON 形状を検証しました")
    return 0


if __name__ == "__main__":
    sys.exit(main())
