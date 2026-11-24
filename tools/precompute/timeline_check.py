#!/usr/bin/env python3
"""
年表（06_timeline_text/timeline.json）の順序整合性を DFS で検査する。標準ライブラリのみ。

グラフの作り方:
  - 節点: 年表の各イベント（掲載順に番号を振る）
  - 辺A: 掲載順の前後（i -> i+1）。「この並びで書かれている」という前提
  - 辺B: 日付が厳密に前（date(a) < date(b) なら a -> b）
  閉路があれば、掲載順と日付が食い違っている（矛盾）ことを意味する。
  DFS で閉路を探し、該当するイベントの経路を表示する。

日付の粒度:
  「2022-02」のような月単位の日付は、日単位の日付と比べない（粒度が揃わないため）。

終了コード:
  矛盾があっても既定では 0（データの確認用の警告）。--strict を付けると 1 を返す。
"""
import argparse
import json
import os
import re
import sys

ROOT = os.path.normpath(os.path.join(os.path.dirname(__file__), "..", ".."))
DEFAULT_TIMELINE = os.path.join(ROOT, "06_timeline_text", "timeline.json")


DATE_RE = re.compile(r"^(\d{4})(?:-(\d{2}))?(?:-(\d{2}))?")


def parse_date(s):
    """先頭の 'YYYY' / 'YYYY-MM' / 'YYYY-MM-DD' を tuple にする（'2020-12-07以降' も 2020-12-07 として扱う）。"""
    if not s:
        return None
    m = DATE_RE.match(s)
    if not m:
        return None
    return tuple(int(g) for g in m.groups() if g is not None)


def comparable_before(a, b):
    """a が b より厳密に前と言えるか。粒度が違い共通部分が一致する場合は比較不能。"""
    n = min(len(a), len(b))
    if a[:n] == b[:n]:
        return False
    return a[:n] < b[:n]


def load_events(path):
    with open(path, encoding="utf-8") as f:
        data = json.load(f)
    events = []
    for ph in data.get("phases", []):
        for e in ph.get("events", []):
            events.append({"phase": ph.get("phase", ""), "date": e.get("date", ""),
                           "event": e.get("event", "")})
    return events


def build_graph(events):
    n = len(events)
    dates = [parse_date(e["date"]) for e in events]
    adj = {i: [] for i in range(n)}
    kinds = {}  # (i, j) -> 辺の種類
    for i in range(n - 1):
        adj[i].append(i + 1)
        kinds[(i, i + 1)] = "掲載順"
    for a in range(n):
        if dates[a] is None:
            continue
        for b in range(n):
            if a == b or dates[b] is None:
                continue
            if comparable_before(dates[a], dates[b]):
                adj[a].append(b)
                kinds.setdefault((a, b), "日付")
    return adj, kinds


def find_cycle(adj, n):
    """DFS で最初に見つかった閉路を返す（節点番号のリスト。始点と終点は同じ）。無ければ None。"""
    WHITE, GRAY, BLACK = 0, 1, 2
    color = [WHITE] * n
    parent = [-1] * n

    for root in range(n):
        if color[root] != WHITE:
            continue
        stack = [(root, iter(adj[root]))]
        color[root] = GRAY
        while stack:
            node, it = stack[-1]
            nxt = next(it, None)
            if nxt is None:
                color[node] = BLACK
                stack.pop()
                continue
            if color[nxt] == WHITE:
                color[nxt] = GRAY
                parent[nxt] = node
                stack.append((nxt, iter(adj[nxt])))
            elif color[nxt] == GRAY:
                # node -> nxt が後退辺。nxt から node まで辿って閉路にする
                cycle = [node]
                cur = node
                while cur != nxt:
                    cur = parent[cur]
                    cycle.append(cur)
                cycle.reverse()
                cycle.append(nxt)
                return cycle
    return None


def describe(events, idx):
    e = events[idx]
    return f"[{idx}] {e['date'] or '(日付なし)'}  {e['event'][:40]}"


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--timeline", default=DEFAULT_TIMELINE)
    ap.add_argument("--strict", action="store_true", help="矛盾があれば非0で終了")
    args = ap.parse_args()

    events = load_events(args.timeline)
    adj, kinds = build_graph(events)
    cycle = find_cycle(adj, len(events))

    print(f"イベント {len(events)} 件を検査しました。")
    if cycle is None:
        print("OK: 掲載順と日付の間に矛盾はありません（閉路なし）。")
        return 0

    print("矛盾（閉路）を検出しました:")
    for a, b in zip(cycle, cycle[1:]):
        print(f"  {describe(events, a)}")
        print(f"      --({kinds.get((a, b), '?')}により後)-->")
    print(f"  {describe(events, cycle[-1])}  ← 始点に戻る")
    print("  ※ 掲載順と日付のどちらかが誤りか、意図的な並び（テーマ別の章立て）かを確認してください。")
    return 1 if args.strict else 0


if __name__ == "__main__":
    sys.exit(main())
