#!/usr/bin/env bash
# Run order for the build-time pipeline (pure Python: numpy + Pillow; no spiceypy/astropy required).
set -euo pipefail
cd "$(dirname "$0")"
python3 spice_tables.py      # sun_table.json, rotation.json (+ asserts vs observing-conditions CSV)
python3 gravity_grid.py      # gravity_{763,340}.bin + grids
python3 mascot_convert.py    # mascam png + manifest, mara/mag json, mascot_position.json
python3 onc_assets.py        # l2c jpg, image_geometry.json, gallery_manifest.json
python3 spice_sc.py          # sc_table.bin
python3 temperature_curves.py
python3 gallery_picks.py     # gallery_picks.json（有効率0.5以上の画像から貪欲法で12枚）
python3 timeline_check.py    # 年表の掲載順と日付の矛盾をDFSで報告（警告のみ）
bash ../../scripts/sync_assets.sh
python3 validate_outputs.py    # 生成アセットの存在・形状を検証（欠けていれば失敗）
