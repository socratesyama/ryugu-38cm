# RYUGU 38cm/s

**1年1組 37番 山本和輝**

## どんなサイトか

小惑星リュウグウの3Dモデルの上を、**秒速38cm（人が歩く速さ）**で歩いて探索できるブラウザ向けの教育サイト。
はやぶさ2が着陸・観測した場所（TD1、SCI 人工クレーター、MASCOT など）を歩いて回りながら、
地形の名前、出来事、探査機の動きを学べることになっている。

- **見どころ**: 3D表示（three.js）、視界に入った地形へ地名を重ねる「地名ガイド」、MASCOT の再生、ギャラリー（ONC 画像783枚）、年表、用語集、出典ページ
- **仕組み**: 太陽・自転・重力・探査機の位置などは事前計算（Python）し、サイトは計算結果を読み込んで表示（TypeScript）
- **注意**: JAXA・ISAS 非公式の制作物です。データの出典は `08_references/credits_and_licenses.md` を参照せよ。

## どこに「探索」を使ったか

このリポジトリでは、年表やギャラリーを対象に、探索アルゴリズムを使っている。**（加点のために必死にアピールしておく。）**

| 場所 | 使った探索 | 内容 | 出力 |
|---|---|---|---|
| **`assignment/search_report.py`**（課題プログラム） | 隣接比較・全対比較・深さ制限DFS・完全DFS の4レベル | 年表36件のリストを定義し、掲載順と日付の矛盾を、探索の深さを変えて調べる | `assignment/search_report.html`（レベルごとに色の濃さで評価を表示） |
| **`tools/precompute/timeline_check.py`** | DFS（閉路検出） | 掲載順の辺と日付の辺からグラフを作り、閉路（矛盾）を経路つきで報告。ビルド時に実行（警告のみ） | 標準出力 |
| **`tools/precompute/gallery_picks.py`** | 貪欲法（被覆問題） | 有効率0.5以上の画像から、緯度経度の格子を最も多く覆うものを順に12枚選ぶ | `site/public/data/gallery_picks.json`（決定的に同じ結果） |

### 探索の具体例（年表の矛盾）

年表の「2023-08」の出来事が、掲載順では「2024-09-06」より後に並んでいる。
DFS で閉路を探すと、次の経路が見つかる。

```
[29] 2024-09-06 → [30] 2024-11-22 → [31] 2020-12-07以降 → [32] 2023-08 → [29]
```

探索の深さを変えると、見つかる矛盾の数が変わる（課題プログラムの結果）。

| レベル | 方法 | 検出数 |
|---|---|---|
| Lv1 | 隣接比較 | 1 |
| Lv2 | 全対比較 | 15 |
| Lv3 | 深さ3までのDFS | 14（長さ3以下の閉路） |
| Lv4 | 完全DFS | 閉路1（長さ4） |

## このサイトの作り方

このサイトは、次の流れで作った。

1. **データを集める**: データ収集には Perplexity を使用。なめデータを解析して持ってきてくれるのは本当に心強い限りである。これは、**正当なAIの使用方法**であると確信している。JAXA/ISAS の DARTS と はやぶさ2公式サイトから、形状モデル・ONC 画像・SPICE カーネル・地図・年表などを取得。取得日・取得元・未収録データは `09_manifests/data_manifest.md` に記録してある。
   - 海外のアーカイブとして **NASA PDS**（https://pds.nasa.gov/）も一応参照先に載せている（`08_references/official_links.md`）。
   - **NASA の公開素材**は、星空や背景の画像として使う予定の候補（`09_manifests/追加データ一覧.md`）。未使用だった気がする。
2. **データを整える（Python）**: `tools/precompute/` のスクリプトが、SPICE カーネルから太陽方向や自転の表を計算し、重力の格子、MASCOT の画像・データ、ONC 画像の幾何情報を作る。最後に `validate_outputs.py` で生成物の有無と形状を確かめている。外部ライブラリは numpy と Pillow だけで、SPICE 関連のライブラリは使っていないのが素晴らしいところだと思う。
3. **サイトを実装する（TypeScript）**: `site/` を Vite と three.js で作りました。地形の描画、歩行、探査機の動き、地名ガイドなどを実装し、`site/tests/` の単体テストで物理計算や温度モデルの振る舞いを確かめている。実際にCloudflareで公開している
4. **自動で検証・公開する仕組みの存在**: `.github/workflows/pages.yml` が、単体テスト、事前計算、サイトのビルド、サイズ制限（1ファイル25MiB以下）のチェックを行い、GitHub Pages へ配備。Cloudflare Pages 向けには `scripts/build_site.sh` を使う。
5. **探索を追加する**: 年表の矛盾検査とギャラリーの代表画像選びに、探索アルゴリズムを使った（上の「どこに探索を使ったか」を参照）。

## 実行方法

```bash
# 課題: 探索レポート（HTML）を作る。標準ライブラリのみ
python3 assignment/search_report.py
# → assignment/search_report.html をブラウザで開く

# サイト用の事前計算（numpy + Pillow）と検証
bash tools/precompute/run_all.sh

# サイト本体
cd site && npm install && npm run build     # 開発: npm run dev
```

単体テスト（探索アルゴリズムを含む）:

```bash
python3 -m unittest discover -s tools/precompute/tests -v
python3 -m unittest discover -s 12_site_data/tests -v
```

## リポジトリの構成（主なもの）

| フォルダ | 内容 |
|---|---|
| `assignment/` | 課題プログラムと、生成された探索レポート（HTML） |
| `site/` | サイト本体（Vite + TypeScript + three.js） |
| `tools/precompute/` | 事前計算パイプライン（Python）と探索ツール |
| `scripts/` | Cloudflare Pages 向けのビルド・アセット同期 |
| `06_timeline_text/` | 年表（timeline.json）。探索の入力 |
| `02_onc_images/` | ONC 画像（ギャラリー・幾何情報） |
| `01_shape_models/`・`10_pointclouds/`・`11_spacecraft_model/` | 形状モデル、点群、探査機の3Dモデル |
| `12_site_data/` | サイト用データ（地点、出来事、出典など） |
| `09_manifests/` | データの収集記録、変換ツール、サイズ確認ツール |
| `03_spice/`・`04_science_data/`・`05_mascot/`・`07_glossary_faq/`・`08_references/` | SPICE カーネル、科学データ、MASCOT データ、用語集、出典 |

## データのバージョン（引用時に記録すること）

- 形状モデル: SPC v20200323（最終版）・SfM v20180804/v20200815
- ONC 画像: v03c（較正済み L2C）
- SPICE: hyb2_spice_v001
- 地図プロダクト: v06
- 収集日: 2026-11-03 ／ 取得元: data.darts.isas.jaxa.jp、www.hayabusa2.jaxa.jp、planetarium.jp、curation.isas.jaxa.jp

## ライセンス

- DARTS 科学データ: ISAS データポリシー（CC BY 4.0、出典明記）
- JAXA 公式画像: 「©JAXA」表記。商用利用は要許諾
- 詳細: `08_references/credits_and_licenses.md`
