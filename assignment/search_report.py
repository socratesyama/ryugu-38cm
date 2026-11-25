#!/usr/bin/env python3
"""
1年1組 37番 山本和輝 — 探索課題プログラム

テーマ: はやぶさ2の年表（06_timeline_text/timeline.json）に、掲載順と日付が
        食い違う箇所（矛盾）がないかを、探索の深さを変えて調べる。

1. リストの定義  : 年表の全イベントを1本のリスト EVENTS にまとめる
2. 探索         : 探索レベル1〜4（深さが深いほど広く・厳密に調べる）
                  Lv1 隣接比較 / Lv2 全対比較 / Lv3 深さ制限DFS / Lv4 完全DFS
3. HTML出力     : 結果を assignment/search_report.html に書き出す
                  探索レベルごとに色の濃さ（グラデーション）で評価を表示

使い方:  python3 assignment/search_report.py
外部ライブラリ不要（標準ライブラリのみ、Python 3.8 以上）。
"""

import html
import json
import os
import re
import sys
from datetime import datetime

# ---------------------------------------------------------------------------
# 設定
# ---------------------------------------------------------------------------
STUDENT_INFO = "1年1組 37番 山本和輝"
TITLE = "はやぶさ2 年表の探索レポート"

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.normpath(os.path.join(HERE, ".."))
TIMELINE_PATH = os.path.join(ROOT, "06_timeline_text", "timeline.json")
OUTPUT_PATH = os.path.join(HERE, "search_report.html")

DEPTH_LIMIT = 3  # Lv3 の深さ制限（長さ3以下の閉路を探す）

# 探索レベルごとの評価（色の濃さでグラデーションを付ける）
LEVELS = [
    {"no": 1, "name": "隣接比較（線形探索）", "grade": "基礎", "color": "#e8f5e9", "text": "#1b5e20",
     "desc": "掲載順に隣り合う2件だけを比べる。最も単純で、比較回数は n-1 回。"},
    {"no": 2, "name": "全対比較（総当たり）", "grade": "標準", "color": "#a5d6a7", "text": "#1b5e20",
     "desc": "すべての2件の組み合わせを比べる。比較回数は n(n-1)/2 回。"},
    {"no": 3, "name": "深さ制限DFS（閉路検出）", "grade": "応用", "color": "#66bb6a", "text": "#ffffff",
     "desc": f"グラフ上を深さ {DEPTH_LIMIT} までの深さ優先探索（DFS）で辿り、短い閉路を探す。"},
    {"no": 4, "name": "完全DFS（閉路検出・経路復元）", "grade": "発展", "color": "#1b5e20", "text": "#ffffff",
     "desc": "深さの制限なしにDFSを行い、閉路の有無と経路を求める。色の訪問状態（白・灰・黒）で後退辺を判定。"},
]


# ---------------------------------------------------------------------------
# 1. リストの定義
# ---------------------------------------------------------------------------
DATE_RE = re.compile(r"^(\d{4})(?:-(\d{2}))?(?:-(\d{2}))?")


def parse_date(text):
    """先頭の 'YYYY' / 'YYYY-MM' / 'YYYY-MM-DD' を数のタプルにする。読めなければ None。"""
    m = DATE_RE.match(text or "")
    if not m:
        return None
    return tuple(int(g) for g in m.groups() if g is not None)


def is_before(a, b):
    """日付 a が b より確実に前か。粒度が違って共通部分が一致する場合は比べない。"""
    n = min(len(a), len(b))
    if a[:n] == b[:n]:
        return False
    return a[:n] < b[:n]


def load_events():
    """年表を読み込み、EVENTS（掲載順のリスト）を作る。"""
    with open(TIMELINE_PATH, encoding="utf-8") as f:
        data = json.load(f)
    events = []
    for phase in data["phases"]:
        for e in phase["events"]:
            events.append({
                "phase": phase["phase"],
                "date_text": e.get("date", ""),
                "date": parse_date(e.get("date", "")),
                "event": e["event"],
            })
    return events


EVENTS = load_events()
N = len(EVENTS)


# ---------------------------------------------------------------------------
# グラフ（掲載順の辺と日付の辺）
# ---------------------------------------------------------------------------
def build_graph(events):
    adj = {i: [] for i in range(len(events))}
    for i in range(len(events) - 1):          # 辺A: 掲載順（i の次は i+1）
        adj[i].append(i + 1)
    for a in range(len(events)):              # 辺B: 日付が確実に前
        for b in range(len(events)):
            if a == b or events[a]["date"] is None or events[b]["date"] is None:
                continue
            if is_before(events[a]["date"], events[b]["date"]):
                adj[a].append(b)
    return adj


ADJ = build_graph(EVENTS)


# ---------------------------------------------------------------------------
# 2. 探索（レベル1〜4）
# ---------------------------------------------------------------------------
def inverted(i, j):
    """掲載順で i が j より前にあるのに、日付では j が確実に前か。"""
    di, dj = EVENTS[i]["date"], EVENTS[j]["date"]
    if di is None or dj is None:
        return False
    return is_before(dj, di)


def search_lv1():
    """隣接比較: n-1 回比べる。"""
    found, comparisons = [], 0
    for i in range(N - 1):
        comparisons += 1
        if inverted(i, i + 1):
            found.append((i, i + 1))
    return {"found": found, "comparisons": comparisons, "visited": N, "cycle": None}


def search_lv2():
    """全対比較: 全ての組を比べる。"""
    found, comparisons = [], 0
    for i in range(N):
        for j in range(i + 1, N):
            comparisons += 1
            if inverted(i, j):
                found.append((i, j))
    return {"found": found, "comparisons": comparisons, "visited": N, "cycle": None}


def search_lv3():
    """深さ制限DFS: 各節点から DEPTH_LIMIT 本以内の辺で元に戻る経路（閉路）を探す。"""
    visited_count = 0
    cycles = {}

    for start in range(N):
        stack = [(start, [start])]  # (現在の節点, 経路)
        while stack:
            node, path = stack.pop()
            visited_count += 1
            if len(path) - 1 >= DEPTH_LIMIT:
                continue
            for nxt in ADJ[node]:
                if nxt == start and len(path) >= 2:
                    key = tuple(sorted(path))
                    cycles.setdefault(key, path + [start])
                elif nxt not in path:
                    stack.append((nxt, path + [nxt]))

    found = sorted(cycles.values(), key=len)
    first = found[0] if found else None
    return {"found": found, "comparisons": None, "visited": visited_count, "cycle": first}


def search_lv4():
    """完全DFS: 白・灰・黒の状態で後退辺を見つけ、閉路の経路を復元する。"""
    WHITE, GRAY, BLACK = 0, 1, 2
    color = [WHITE] * N
    parent = [-1] * N
    visited_count = 0
    cycle = None

    for root in range(N):
        if color[root] != WHITE or cycle is not None:
            continue
        stack = [(root, iter(ADJ[root]))]
        color[root] = GRAY
        visited_count += 1
        while stack and cycle is None:
            node, it = stack[-1]
            nxt = next(it, None)
            if nxt is None:
                color[node] = BLACK
                stack.pop()
                continue
            if color[nxt] == WHITE:
                color[nxt] = GRAY
                parent[nxt] = node
                visited_count += 1
                stack.append((nxt, iter(ADJ[nxt])))
            elif color[nxt] == GRAY:  # 後退辺を見つけた → 閉路
                path = [node]
                cur = node
                while cur != nxt:
                    cur = parent[cur]
                    path.append(cur)
                path.reverse()
                path.append(nxt)
                cycle = path

    found = [cycle] if cycle else []
    return {"found": found, "comparisons": None, "visited": visited_count, "cycle": cycle}


RUNNERS = [search_lv1, search_lv2, search_lv3, search_lv4]


# ---------------------------------------------------------------------------
# 3. HTML 出力
# ---------------------------------------------------------------------------
def event_label(i):
    e = EVENTS[i]
    return f"[{i}] {e['date_text'] or '日付なし'}　{e['event']}"


def render_level_card(level, result):
    count = len(result["found"])
    if result["comparisons"] is not None:
        cost = f"比較回数 {result['comparisons']} 回"
    else:
        cost = f"訪問した節点 {result['visited']} 回"

    if level["no"] in (1, 2):
        body = "<ul>" + "".join(
            f"<li>{html.escape(event_label(a))}<br>　↳ 次の 「{html.escape(event_label(b))}」 より後の日付</li>"
            for a, b in result["found"][:10]) + "</ul>" if result["found"] else "<p>矛盾は見つかりませんでした。</p>"
        if result["found"] and len(result["found"]) > 10:
            body += f"<p class='muted'>ほか {len(result['found']) - 10} 件（省略）</p>"
    else:
        if result["cycle"]:
            steps = " → ".join(f"[{i}]" for i in result["cycle"])
            body = (f"<p>閉路を検出しました（{len(result['cycle']) - 1} 本の辺）。</p>"
                    f"<p class='path'>{html.escape(steps)}</p>"
                    "<ol>" + "".join(f"<li>{html.escape(event_label(i))}</li>"
                                     for i in result["cycle"][:-1]) + "</ol>")
            if level["no"] == 3:
                body += f"<p class='muted'>深さ {DEPTH_LIMIT} 以内の閉路は {count} 種類。</p>"
        else:
            body = ("<p>閉路は見つかりませんでした。" +
                    (f"（深さ {DEPTH_LIMIT} までの探索）" if level["no"] == 3 else "（全体を探索）") + "</p>")

    return f"""
<section class="card" style="background:{level['color']};color:{level['text']}">
  <div class="card-head">
    <span class="badge">Lv{level['no']} ・ {html.escape(level['grade'])}</span>
    <h3>{html.escape(level['name'])}</h3>
  </div>
  <p>{html.escape(level['desc'])}</p>
  <p class="stat">検出 {count} 件 ／ {cost}</p>
  <div class="inner">{body}</div>
</section>"""


def render_events_table():
    rows = []
    for i, e in enumerate(EVENTS):
        rows.append(f"<tr><td>{i}</td><td>{html.escape(e['phase'])}</td>"
                    f"<td>{html.escape(e['date_text'] or '—')}</td>"
                    f"<td>{html.escape(e['event'])}</td></tr>")
    return ("<table><thead><tr><th>番号</th><th>章</th><th>日付</th><th>出来事</th></tr></thead><tbody>"
            + "".join(rows) + "</tbody></table>")


def render_html(results):
    cards = "".join(render_level_card(LEVELS[k], results[k]) for k in range(len(LEVELS)))
    summary_rows = "".join(
        f"<tr style='background:{LEVELS[k]['color']};color:{LEVELS[k]['text']}'>"
        f"<td>Lv{LEVELS[k]['no']}</td><td>{html.escape(LEVELS[k]['name'])}</td>"
        f"<td>{len(results[k]['found'])}</td>"
        f"<td>{results[k]['comparisons'] if results[k]['comparisons'] is not None else '—'}</td>"
        f"<td>{results[k]['visited']}</td></tr>"
        for k in range(len(LEVELS)))
    now = datetime.now().strftime("%Y-%m-%d %H:%M")
    return f"""<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>{html.escape(TITLE)}</title>
<style>
  :root {{ --ink:#1f2933; --muted:#616e7c; --line:#d9e2ec; --bg:#f7fafc; }}
  @media (prefers-color-scheme: dark) {{
    :root {{ --ink:#e4e7eb; --muted:#9aa5b1; --line:#3e4c59; --bg:#1f2933; }}
  }}
  body {{ margin:0; padding:16px; font-family:-apple-system,"Hiragino Sans","Yu Gothic",sans-serif;
          color:var(--ink); background:var(--bg); line-height:1.7; }}
  main {{ max-width:960px; margin:0 auto; }}
  header {{ border-bottom:3px solid #2e7d32; padding-bottom:12px; margin-bottom:20px; }}
  h1 {{ margin:0 0 4px; font-size:1.6rem; }}
  .who {{ font-size:1.15rem; font-weight:700; color:#2e7d32; }}
  .muted {{ color:var(--muted); font-size:.9rem; }}
  h2 {{ margin-top:32px; border-left:6px solid #2e7d32; padding-left:10px; }}
  .card {{ border-radius:10px; padding:14px 18px; margin:14px 0; box-shadow:0 1px 3px rgba(0,0,0,.12); }}
  .card-head {{ display:flex; align-items:center; gap:10px; flex-wrap:wrap; }}
  .card h3 {{ margin:0; font-size:1.1rem; }}
  .badge {{ background:rgba(0,0,0,.15); border-radius:999px; padding:2px 10px; font-weight:700; font-size:.85rem; }}
  .stat {{ font-weight:700; }}
  .path {{ font-family:ui-monospace,Menlo,monospace; word-break:break-all; background:rgba(0,0,0,.08); padding:6px 8px; border-radius:6px; }}
  .inner ul, .inner ol {{ padding-left:20px; }}
  table {{ width:100%; border-collapse:collapse; font-size:.9rem; }}
  th, td {{ border:1px solid var(--line); padding:6px 8px; text-align:left; vertical-align:top; }}
  th {{ background:rgba(46,125,50,.12); }}
  .scroll {{ overflow-x:auto; }}
  footer {{ margin-top:36px; color:var(--muted); font-size:.85rem; }}
</style>
</head>
<body>
<main>
<header>
  <h1>{html.escape(TITLE)}</h1>
  <p class="who">{html.escape(STUDENT_INFO)}</p>
  <p class="muted">テーマ：はやぶさ2の年表（{N} 件）の掲載順と日付の矛盾を、探索の深さを変えて調べる。
  探索レベルが深いほど、濃い色で示しています。作成: {now}</p>
</header>

<h2>1. リストの定義</h2>
<p>年表の全 {N} 件を、掲載順のリスト <code>EVENTS</code> として定義しています。
各要素は「章・日付・出来事」です。</p>
<div class="scroll">{render_events_table()}</div>

<h2>2. 探索結果（探索レベルによる評価のグラデーション）</h2>
<p>探索レベルが上がるほど、調べる範囲が広く、色が濃くなります。</p>
<div class="scroll"><table>
<thead><tr><th>レベル</th><th>探索方法</th><th>検出数</th><th>比較回数</th><th>訪問回数</th></tr></thead>
<tbody>{summary_rows}</tbody></table></div>
{cards}

<h2>3. 考察</h2>
<p>隣接比較（Lv1）と全対比較（Lv2）は、日付の逆転を「2件の組」で検出します。
グラフの探索（Lv3・Lv4）は、掲載順と日付の辺をたどって「元に戻る経路（閉路）」を探します。
閉路は、ある出来事が別の出来事より前にも後にもなる、という矛盾を意味します。</p>
<p>Lv3 は深さ {DEPTH_LIMIT} までしか探さないため、長い閉路は見つけられません。
Lv4 は深さの制限がないため、閉路の有無と経路を完全に求められます。
このように、探索の深さによって見つけられる矛盾の範囲が変わることを示しています。</p>

<footer>{html.escape(STUDENT_INFO)} ／ 入力: 06_timeline_text/timeline.json ／ 実行: python3 assignment/search_report.py</footer>
</main>
</body>
</html>
"""


# ---------------------------------------------------------------------------
# 実行
# ---------------------------------------------------------------------------
def main():
    print(STUDENT_INFO)
    print(f"リスト EVENTS: {N} 件")
    results = []
    for k, run in enumerate(RUNNERS):
        r = run()
        results.append(r)
        print(f"Lv{k + 1} {LEVELS[k]['name']}: 検出 {len(r['found'])} 件, 訪問 {r['visited']} 回")

    with open(OUTPUT_PATH, "w", encoding="utf-8") as f:
        f.write(render_html(results))
    print(f"HTML を出力しました: {OUTPUT_PATH}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
