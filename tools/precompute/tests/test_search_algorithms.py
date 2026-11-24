"""timeline_check（DFS）と gallery_picks（貪欲法）の小さな単体テスト。"""
import os
import sys
import unittest

HERE = os.path.dirname(__file__)
sys.path.insert(0, os.path.normpath(os.path.join(HERE, "..")))

import gallery_picks as gp  # noqa: E402
import timeline_check as tc  # noqa: E402


class TimelineDFS(unittest.TestCase):
    def test_parse_handles_suffix_and_precision(self):
        self.assertEqual(tc.parse_date("2020-12-07以降"), (2020, 12, 7))
        self.assertEqual(tc.parse_date("2022-02"), (2022, 2))
        self.assertIsNone(tc.parse_date(""))

    def test_month_vs_day_not_compared(self):
        self.assertFalse(tc.comparable_before((2022, 2), (2022, 2, 11)))
        self.assertFalse(tc.comparable_before((2022, 2, 11), (2022, 2)))
        self.assertTrue(tc.comparable_before((2021, 5, 1), (2022, 1)))

    def _graph(self, dates):
        events = [{"date": d, "event": str(i), "phase": ""} for i, d in enumerate(dates)]
        adj, kinds = tc.build_graph(events)
        return tc.find_cycle(adj, len(events))

    def test_sorted_listing_has_no_cycle(self):
        self.assertIsNone(self._graph(["2018-01-01", "2019-01-01", "2020-01-01"]))

    def test_inversion_is_detected_as_cycle(self):
        cycle = self._graph(["2019-01-01", "2020-01-01", "2018-01-01"])
        self.assertIsNotNone(cycle)
        self.assertEqual(cycle[0], cycle[-1])


class GreedyPick(unittest.TestCase):
    def test_picks_largest_gain_first_and_is_deterministic(self):
        cells = [(0.0, float(i)) for i in range(6)]
        cands = [
            {"file": "a", "center_lat": 0.0, "center_lon": 1.0},
            {"file": "b", "center_lat": 0.0, "center_lon": 4.0},
            {"file": "c", "center_lat": 0.0, "center_lon": 1.2},
        ]
        picked, total = gp.greedy_pick(cands, cells, 2)
        self.assertEqual(total, 2)  # 半径0.5度・格子1度なので覆えるのは2格子
        self.assertEqual(len(picked), 2)
        first = picked[0][0]["file"]
        self.assertIn(first, ("a", "b"))
        self.assertGreater(picked[-1][2], picked[0][2])

    def test_stops_when_nothing_new(self):
        cells = [(0.0, 0.0)]
        cands = [{"file": "x", "center_lat": 0.0, "center_lon": 0.0}]
        picked, _ = gp.greedy_pick(cands, cells, 5)
        self.assertEqual(len(picked), 1)


if __name__ == "__main__":
    unittest.main()
