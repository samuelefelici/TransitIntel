"""
Test unitari per schedule_optimizer_engine.py
Copre: get_time_band, min_to_time, compute_pareto, solve_strategy (golden-path minimo).
"""

import pytest
import json

from schedule_optimizer_engine import (
    Trip,
    RouteGroup,
    get_time_band,
    min_to_time,
    compute_pareto,
    solve_strategy,
    TIME_BANDS,
    STRATEGIES,
    MIN_KEEP_RATIO,
    MAX_SHIFT,
)


# ═══════════════════════════════════════════════════════════════
#  get_time_band
# ═══════════════════════════════════════════════════════════════

class TestGetTimeBand:
    def test_morning_peak(self):
        tb = get_time_band(8 * 60)  # 08:00
        assert tb["name"] == "punta_matt"
        assert tb["demandWeight"] == 1.0

    def test_evening_peak(self):
        tb = get_time_band(18 * 60)  # 18:00
        assert tb["name"] == "punta_sera"
        assert tb["demandWeight"] == 1.0

    def test_off_peak_morning(self):
        tb = get_time_band(10 * 60)  # 10:00
        assert tb["name"] == "mattina"
        assert tb["demandWeight"] < 1.0

    def test_night(self):
        tb = get_time_band(2 * 60)   # 02:00
        assert tb["name"] == "notte"
        assert tb["demandWeight"] == 0.10

    def test_late_night(self):
        tb = get_time_band(23 * 60)  # 23:00
        assert tb["name"] == "notte_tarda"

    def test_boundary_7am(self):
        tb = get_time_band(7 * 60)  # 07:00
        assert tb["name"] == "punta_matt"

    def test_boundary_9am(self):
        tb = get_time_band(9 * 60)  # 09:00 → mattina (not punta_matt since punta is [7,9))
        assert tb["name"] == "mattina"


# ═══════════════════════════════════════════════════════════════
#  min_to_time
# ═══════════════════════════════════════════════════════════════

class TestMinToTime:
    def test_midnight(self):
        assert min_to_time(0) == "00:00"

    def test_morning(self):
        assert min_to_time(450) == "07:30"

    def test_noon(self):
        assert min_to_time(720) == "12:00"

    def test_over_24h(self):
        assert min_to_time(25 * 60 + 30) == "25:30"


# ═══════════════════════════════════════════════════════════════
#  compute_pareto
# ═══════════════════════════════════════════════════════════════

class TestComputePareto:
    def _make_result(self, removed, reg, cov, oc, name="s"):
        return {
            "strategy": {"name": name},
            "metrics": {
                "totalTripsOriginal": 100,
                "totalTripsKept": 100 - removed,
                "tripsRemoved": removed,
                "tripsShifted": 0,
                "savingsMinutes": removed * 20,
                "regularityScore": reg,
                "coverageScore": cov,
                "overcrowdingRisk": oc,
                "solveTimeMs": 100,
                "solverStatus": "OPTIMAL",
                "objectiveValue": 1000,
            },
            "paretoRank": 0,
            "isBest": False,
            "decisions": [],
        }

    def test_single_result_is_pareto_and_best(self):
        results = [self._make_result(10, 0.8, 0.9, 0.1, "balanced")]
        results = compute_pareto(results)
        assert results[0]["paretoRank"] == 0
        assert results[0]["isBest"] is True

    def test_dominated_gets_rank_1(self):
        a = self._make_result(20, 0.9, 0.9, 0.1, "a")  # dominates b on all axes
        b = self._make_result(10, 0.8, 0.8, 0.2, "b")
        results = compute_pareto([a, b])
        ranks = {r["strategy"]["name"]: r["paretoRank"] for r in results}
        assert ranks["a"] == 0
        assert ranks["b"] == 1

    def test_incomparable_both_pareto(self):
        # a: more removed, less regularity
        # b: less removed, more regularity
        a = self._make_result(30, 0.7, 0.8, 0.1, "a")
        b = self._make_result(10, 0.95, 0.85, 0.1, "b")
        results = compute_pareto([a, b])
        ranks = {r["strategy"]["name"]: r["paretoRank"] for r in results}
        assert ranks["a"] == 0
        assert ranks["b"] == 0

    def test_exactly_one_best(self):
        results = [
            self._make_result(20, 0.85, 0.85, 0.1, "a"),
            self._make_result(15, 0.9, 0.9, 0.05, "b"),
            self._make_result(30, 0.7, 0.7, 0.2, "c"),
        ]
        results = compute_pareto(results)
        best_count = sum(1 for r in results if r["isBest"])
        assert best_count == 1

    def test_empty_returns_empty(self):
        assert compute_pareto([]) == []


# ═══════════════════════════════════════════════════════════════
#  solve_strategy — Golden-path con input minimo
# ═══════════════════════════════════════════════════════════════

class TestSolveStrategy:
    @pytest.fixture
    def small_scenario(self):
        """Scenario minimo: 1 route, 2 directions, 6 corse."""
        trips = []
        for i, dep in enumerate([420, 450, 480, 510, 540, 570]):
            trips.append(Trip(
                trip_id=f"T{i}",
                route_id="R1",
                route_name="Linea 1",
                direction_id=0 if i < 3 else 1,
                departure_min=dep,
                arrival_min=dep + 30,
                duration_min=30,
                headsign=None,
                demand=50 + i * 5,
            ))

        groups = {}
        for t in trips:
            key = f"{t.route_id}__{t.direction_id}"
            if key not in groups:
                groups[key] = RouteGroup(
                    route_id=t.route_id,
                    route_name=t.route_name,
                    direction_id=t.direction_id,
                    trips=[], ideal_headway=30,
                )
            groups[key].trips.append(t)

        for grp in groups.values():
            grp.trips.sort(key=lambda t: t.departure_min)

        return trips, groups

    def test_balanced_strategy_returns_valid(self, small_scenario):
        trips, groups = small_scenario
        strategy = STRATEGIES[0]  # balanced
        result = solve_strategy(trips, groups, strategy, time_limit=5)

        assert "metrics" in result
        m = result["metrics"]
        assert m["solverStatus"] in ("OPTIMAL", "FEASIBLE")
        assert m["totalTripsOriginal"] == 6
        assert m["totalTripsKept"] + m["tripsRemoved"] == 6
        assert m["totalTripsKept"] >= 1

    def test_keeps_min_ratio(self, small_scenario):
        trips, groups = small_scenario
        for strategy in STRATEGIES:
            result = solve_strategy(trips, groups, strategy, time_limit=5)
            m = result["metrics"]
            if m["solverStatus"] in ("OPTIMAL", "FEASIBLE"):
                # Each route-direction should keep at least 60%
                assert m["totalTripsKept"] >= 3  # ceil(0.6 * 6) = 4, but per direction

    def test_decisions_have_required_fields(self, small_scenario):
        trips, groups = small_scenario
        result = solve_strategy(trips, groups, STRATEGIES[0], time_limit=5)
        for d in result["decisions"]:
            assert "tripId" in d
            assert "action" in d
            assert d["action"] in ("remove", "shift")
            assert "routeId" in d
            assert "routeName" in d

    def test_cost_focus_removes_more(self, small_scenario):
        """Cost focus strategy should remove at least as many as balanced."""
        trips, groups = small_scenario
        balanced = solve_strategy(trips, groups, STRATEGIES[0], time_limit=5)
        cost_focus = solve_strategy(trips, groups, STRATEGIES[1], time_limit=5)

        bm = balanced["metrics"]
        cm = cost_focus["metrics"]
        if bm["solverStatus"] in ("OPTIMAL", "FEASIBLE") and cm["solverStatus"] in ("OPTIMAL", "FEASIBLE"):
            # Cost focus should remove >= balanced (or equal)
            assert cm["tripsRemoved"] >= bm["tripsRemoved"]
