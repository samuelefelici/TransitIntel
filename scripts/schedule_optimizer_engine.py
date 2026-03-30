#!/usr/bin/env python3
"""
Schedule Optimizer Engine — CP-SAT Multi-Strategy
Conerobus S.p.A. / TransitIntel

Reads trip data from stdin (JSON), runs CP-SAT with multiple strategies,
computes Pareto front, outputs JSON on stdout.

Usage:
  echo '<json>' | python3 schedule_optimizer_engine.py [time_limit_sec] [custom_strategy_json]
"""

import json
import sys
import time
import math
from dataclasses import dataclass, field
from typing import Optional

from ortools.sat.python import cp_model

# ═════════════════════════════════════════════════════════════════
#  CONSTANTS
# ═════════════════════════════════════════════════════════════════

SCALE = 1000
MAX_SHIFT = 15          # max minutes a trip can be shifted
MIN_HEADWAY = 3         # hard minimum between consecutive trips
MIN_KEEP_RATIO = 0.60   # keep at least 60% of trips per route-direction

# Time bands with demand weights and headway constraints
TIME_BANDS = [
    {"name": "notte",         "start": 0,  "end": 6,  "minTrips": 0, "maxHeadway": 120, "demandWeight": 0.10},
    {"name": "mattina_early", "start": 6,  "end": 7,  "minTrips": 1, "maxHeadway": 30,  "demandWeight": 0.60},
    {"name": "punta_matt",    "start": 7,  "end": 9,  "minTrips": 3, "maxHeadway": 15,  "demandWeight": 1.00},
    {"name": "mattina",       "start": 9,  "end": 12, "minTrips": 2, "maxHeadway": 20,  "demandWeight": 0.70},
    {"name": "pranzo",        "start": 12, "end": 14, "minTrips": 2, "maxHeadway": 20,  "demandWeight": 0.80},
    {"name": "pomeriggio",    "start": 14, "end": 17, "minTrips": 2, "maxHeadway": 20,  "demandWeight": 0.70},
    {"name": "punta_sera",    "start": 17, "end": 19, "minTrips": 3, "maxHeadway": 15,  "demandWeight": 1.00},
    {"name": "sera",          "start": 19, "end": 22, "minTrips": 1, "maxHeadway": 30,  "demandWeight": 0.40},
    {"name": "notte_tarda",   "start": 22, "end": 27, "minTrips": 0, "maxHeadway": 60,  "demandWeight": 0.10},
]

# Predefined strategies
STRATEGIES = [
    {"name": "balanced",         "description": "Bilanciata — compromesso tra risparmio e qualità",
     "weights": {"cost": 0.30, "regularity": 0.25, "coverage": 0.25, "overcrowd": 0.10, "connections": 0.10}},
    {"name": "cost_focus",       "description": "Focus costi — massimizza corse rimosse",
     "weights": {"cost": 0.60, "regularity": 0.10, "coverage": 0.15, "overcrowd": 0.05, "connections": 0.10}},
    {"name": "quality_focus",    "description": "Focus qualità — protegge copertura e regolarità",
     "weights": {"cost": 0.10, "regularity": 0.35, "coverage": 0.30, "overcrowd": 0.15, "connections": 0.10}},
    {"name": "regularity_focus", "description": "Focus regolarità — headway uniformi",
     "weights": {"cost": 0.15, "regularity": 0.50, "coverage": 0.15, "overcrowd": 0.10, "connections": 0.10}},
    {"name": "peak_optimize",    "description": "Ottimizza picco — protegge punta, taglia morbide",
     "weights": {"cost": 0.20, "regularity": 0.20, "coverage": 0.15, "overcrowd": 0.35, "connections": 0.10}},
]


# ═════════════════════════════════════════════════════════════════
#  DATA STRUCTURES
# ═════════════════════════════════════════════════════════════════

@dataclass
class Trip:
    trip_id: str
    route_id: str
    route_name: str
    direction_id: int
    departure_min: int      # minutes since midnight
    arrival_min: int
    duration_min: int
    headsign: Optional[str]
    demand: float           # 0-100


@dataclass
class RouteGroup:
    route_id: str
    route_name: str
    direction_id: int
    trips: list             # sorted by departure_min
    ideal_headway: float    # avg headway if all kept


# ═════════════════════════════════════════════════════════════════
#  SOLVER
# ═════════════════════════════════════════════════════════════════

def get_time_band(dep_min: int):
    """Return the time band for a departure time."""
    h = dep_min / 60.0
    for tb in TIME_BANDS:
        if tb["start"] <= h < tb["end"]:
            return tb
    return TIME_BANDS[-1]


def solve_strategy(trips: list[Trip], groups: dict[str, RouteGroup],
                   strategy: dict, time_limit: int) -> dict:
    """Run CP-SAT for one strategy. Returns result dict."""
    t0 = time.time()
    n = len(trips)
    w = strategy["weights"]

    model = cp_model.CpModel()

    # Index lookup
    idx_map = {t.trip_id: i for i, t in enumerate(trips)}

    # Decision variables
    x = [model.new_bool_var(f"x_{i}") for i in range(n)]                  # keep?
    shift = [model.new_int_var(-MAX_SHIFT, MAX_SHIFT, f"s_{i}") for i in range(n)]
    dep = [model.new_int_var(0, 27*60, f"d_{i}") for i in range(n)]       # effective departure

    # Link dep = original + shift, shift=0 if removed
    for i, t in enumerate(trips):
        model.add(dep[i] == t.departure_min + shift[i])
        # If removed, shift must be 0
        model.add(shift[i] == 0).only_enforce_if(x[i].negated())

    # ── Constraint 1: Min headway between consecutive trips per route-direction ──
    for key, grp in groups.items():
        indices = [idx_map[t.trip_id] for t in grp.trips]
        # Only consecutive pairs (trips already sorted by departure_min)
        for a in range(len(indices) - 1):
            ia, ib = indices[a], indices[a+1]
            # Both active → dep[b] - dep[a] >= MIN_HEADWAY
            both_active = model.new_bool_var(f"both_{ia}_{ib}")
            model.add_min_equality(both_active, [x[ia], x[ib]])
            model.add(dep[ib] - dep[ia] >= MIN_HEADWAY).only_enforce_if(both_active)

    # ── Constraint 2: Keep at least 60% per route-direction ──
    for key, grp in groups.items():
        indices = [idx_map[t.trip_id] for t in grp.trips]
        min_keep = math.ceil(MIN_KEEP_RATIO * len(indices))
        model.add(sum(x[i] for i in indices) >= min_keep)

    # ── Constraint 3: Min trips per time band per route-direction ──
    for key, grp in groups.items():
        for tb in TIME_BANDS:
            band_indices = [idx_map[t.trip_id] for t in grp.trips
                          if tb["start"]*60 <= t.departure_min < tb["end"]*60]
            if len(band_indices) == 0:
                continue
            min_req = min(tb["minTrips"], len(band_indices))
            if min_req > 0:
                model.add(sum(x[i] for i in band_indices) >= min_req)

    # ── Objective components ──

    # Component 1: Regularity penalty (headway deviation from ideal)
    reg_penalties = []
    for key, grp in groups.items():
        indices = [idx_map[t.trip_id] for t in grp.trips]
        ideal = max(5, int(grp.ideal_headway))
        for a in range(len(indices) - 1):
            ia, ib = indices[a], indices[a+1]
            both_active = model.new_bool_var(f"reg_{ia}_{ib}")
            model.add_min_equality(both_active, [x[ia], x[ib]])
            gap = model.new_int_var(0, 27*60, f"gap_{ia}_{ib}")
            model.add(gap == dep[ib] - dep[ia]).only_enforce_if(both_active)
            model.add(gap == 0).only_enforce_if(both_active.negated())
            dev = model.new_int_var(-27*60, 27*60, f"dev_{ia}_{ib}")
            model.add(dev == gap - ideal)
            abs_dev = model.new_int_var(0, 27*60, f"absdev_{ia}_{ib}")
            model.add_abs_equality(abs_dev, dev)
            reg_penalties.append(abs_dev)

    # Component 2: Overcrowding penalty (removing trips in peak = bad)
    overcrowd_penalties = []
    for i, t in enumerate(trips):
        tb = get_time_band(t.departure_min)
        if tb["demandWeight"] >= 0.8:
            # Penalty for removing peak trip: demand² scaled
            pen = model.new_int_var(0, 10000 * SCALE, f"oc_{i}")
            removed = x[i].negated()
            penalty_val = int((t.demand / 100.0) ** 2 * SCALE)
            model.add(pen == penalty_val).only_enforce_if(removed)
            model.add(pen == 0).only_enforce_if(x[i])
            overcrowd_penalties.append(pen)

    # Component 3: Cost savings (trips removed = good for cost)
    # = sum of (1 - x[i]) * duration
    cost_savings = []
    for i, t in enumerate(trips):
        sav = model.new_int_var(0, t.duration_min * SCALE, f"cs_{i}")
        model.add(sav == t.duration_min * SCALE).only_enforce_if(x[i].negated())
        model.add(sav == 0).only_enforce_if(x[i])
        cost_savings.append(sav)

    # Component 4: Coverage bonus (keeping trips weighted by demand band)
    coverage_bonuses = []
    for i, t in enumerate(trips):
        tb = get_time_band(t.departure_min)
        bonus_val = int(tb["demandWeight"] * SCALE)
        bon = model.new_int_var(0, bonus_val, f"cov_{i}")
        model.add(bon == bonus_val).only_enforce_if(x[i])
        model.add(bon == 0).only_enforce_if(x[i].negated())
        coverage_bonuses.append(bon)

    # Weighted objective
    w_reg = int(w["regularity"] * SCALE)
    w_oc = int(w["overcrowd"] * SCALE)
    w_cost = int(w["cost"] * SCALE)
    w_cov = int(w["coverage"] * SCALE)

    OFFSET = n * 500 * SCALE  # keep positive

    reg_term = sum(reg_penalties) if reg_penalties else 0
    oc_term = sum(overcrowd_penalties) if overcrowd_penalties else 0
    cost_term = sum(cost_savings) if cost_savings else 0
    cov_term = sum(coverage_bonuses) if coverage_bonuses else 0

    objective = (
        w_reg * reg_term
        + w_oc * oc_term
        - w_cost * cost_term
        - w_cov * cov_term
        + OFFSET
    )
    model.minimize(objective)

    # Solve
    solver = cp_model.CpSolver()
    solver.parameters.max_time_in_seconds = time_limit
    solver.parameters.num_workers = 8
    status = solver.solve(model)

    solve_time = int((time.time() - t0) * 1000)

    status_name = {
        cp_model.OPTIMAL: "OPTIMAL",
        cp_model.FEASIBLE: "FEASIBLE",
        cp_model.INFEASIBLE: "INFEASIBLE",
        cp_model.MODEL_INVALID: "INFEASIBLE",
        cp_model.UNKNOWN: "UNKNOWN",
    }.get(status, "UNKNOWN")

    if status not in (cp_model.OPTIMAL, cp_model.FEASIBLE):
        return {
            "strategy": strategy,
            "metrics": {
                "totalTripsOriginal": n, "totalTripsKept": n,
                "tripsRemoved": 0, "tripsShifted": 0,
                "savingsMinutes": 0, "regularityScore": 0.5,
                "coverageScore": 0.5, "overcrowdingRisk": 0.5,
                "solveTimeMs": solve_time, "solverStatus": status_name,
                "objectiveValue": 0,
            },
            "paretoRank": 99, "isBest": False,
            "decisions": [],
        }

    # Extract decisions
    decisions = []
    kept = 0
    removed_count = 0
    shifted_count = 0
    total_savings = 0
    kept_demand_weighted = 0.0
    total_demand_weighted = 0.0
    peak_removed = 0
    peak_total = 0

    for i, t in enumerate(trips):
        tb = get_time_band(t.departure_min)
        total_demand_weighted += tb["demandWeight"]
        is_peak = tb["demandWeight"] >= 0.8
        if is_peak:
            peak_total += 1

        if solver.value(x[i]) == 1:
            kept += 1
            kept_demand_weighted += tb["demandWeight"]
            s = solver.value(shift[i])
            if s != 0:
                shifted_count += 1
                new_dep = t.departure_min + s
                decisions.append({
                    "tripId": t.trip_id,
                    "routeId": t.route_id,
                    "routeName": t.route_name,
                    "originalDeparture": min_to_time(t.departure_min),
                    "newDeparture": min_to_time(new_dep),
                    "action": "shift",
                    "shiftMinutes": s,
                    "mergedWith": None,
                    "reason": f"Spostata di {'+' if s>0 else ''}{s} min per regolarizzare headway"
                })
        else:
            removed_count += 1
            total_savings += t.duration_min
            if is_peak:
                peak_removed += 1
            decisions.append({
                "tripId": t.trip_id,
                "routeId": t.route_id,
                "routeName": t.route_name,
                "originalDeparture": min_to_time(t.departure_min),
                "newDeparture": None,
                "action": "remove",
                "shiftMinutes": 0,
                "mergedWith": None,
                "reason": f"Rimossa — domanda {t.demand:.0f}/100, risparmio {t.duration_min} min"
            })

    # Compute regularity score
    headway_cvs = []
    for key, grp in groups.items():
        active_deps = sorted([
            solver.value(dep[idx_map[t.trip_id]])
            for t in grp.trips if solver.value(x[idx_map[t.trip_id]]) == 1
        ])
        if len(active_deps) < 2:
            continue
        gaps = [active_deps[j+1] - active_deps[j] for j in range(len(active_deps)-1)]
        avg_gap = sum(gaps) / len(gaps)
        if avg_gap > 0:
            std_gap = (sum((g - avg_gap)**2 for g in gaps) / len(gaps)) ** 0.5
            cv = std_gap / avg_gap
            headway_cvs.append(cv)

    regularity_score = max(0, 1 - (sum(headway_cvs) / max(1, len(headway_cvs)))) if headway_cvs else 0.5
    coverage_score = kept_demand_weighted / max(1, total_demand_weighted)
    overcrowd_risk = peak_removed / max(1, peak_total) if peak_total > 0 else 0

    return {
        "strategy": strategy,
        "metrics": {
            "totalTripsOriginal": n,
            "totalTripsKept": kept,
            "tripsRemoved": removed_count,
            "tripsShifted": shifted_count,
            "savingsMinutes": total_savings,
            "regularityScore": round(regularity_score, 4),
            "coverageScore": round(coverage_score, 4),
            "overcrowdingRisk": round(overcrowd_risk, 4),
            "solveTimeMs": solve_time,
            "solverStatus": status_name,
            "objectiveValue": solver.objective_value if status in (cp_model.OPTIMAL, cp_model.FEASIBLE) else 0,
        },
        "paretoRank": 0,
        "isBest": False,
        "decisions": decisions,
    }


def min_to_time(m: int) -> str:
    h = m // 60
    mm = m % 60
    return f"{h:02d}:{mm:02d}"


# ═════════════════════════════════════════════════════════════════
#  PARETO FRONT
# ═════════════════════════════════════════════════════════════════

def compute_pareto(results: list[dict]) -> list[dict]:
    """Compute Pareto front and assign ranks. Modifies in-place."""
    n = len(results)
    if n == 0:
        return results

    def dominates(a, b):
        """a dominates b if a is >= b on all axes and > on at least one."""
        ma, mb = a["metrics"], b["metrics"]
        axes_a = [
            ma["tripsRemoved"],
            ma["regularityScore"],
            ma["coverageScore"],
            1 - ma["overcrowdingRisk"],
        ]
        axes_b = [
            mb["tripsRemoved"],
            mb["regularityScore"],
            mb["coverageScore"],
            1 - mb["overcrowdingRisk"],
        ]
        ge = all(aa >= ab for aa, ab in zip(axes_a, axes_b))
        gt = any(aa > ab for aa, ab in zip(axes_a, axes_b))
        return ge and gt

    # Assign Pareto ranks
    for i in range(n):
        dominated = False
        for j in range(n):
            if i != j and dominates(results[j], results[i]):
                dominated = True
                break
        results[i]["paretoRank"] = 0 if not dominated else 1

    # Select best via composite score
    max_removed = max(r["metrics"]["tripsRemoved"] for r in results) or 1
    best_idx = 0
    best_score = -1
    for i, r in enumerate(results):
        m = r["metrics"]
        score = (
            0.25 * (m["tripsRemoved"] / max_removed) +
            0.30 * m["regularityScore"] +
            0.30 * m["coverageScore"] +
            0.15 * (1 - m["overcrowdingRisk"])
        )
        if score > best_score:
            best_score = score
            best_idx = i

    results[best_idx]["isBest"] = True
    return results


# ═════════════════════════════════════════════════════════════════
#  MAIN
# ═════════════════════════════════════════════════════════════════

def main():
    # Read input from stdin
    input_data = json.load(sys.stdin)

    trip_data = input_data.get("trips", [])
    time_limit = input_data.get("timeLimitSeconds", 30)
    custom_strategy = input_data.get("customStrategy", None)

    if not trip_data:
        json.dump({"error": "No trips provided"}, sys.stdout)
        return

    # Build Trip objects
    trips: list[Trip] = []
    for td in trip_data:
        trips.append(Trip(
            trip_id=td["tripId"],
            route_id=td["routeId"],
            route_name=td["routeName"],
            direction_id=td.get("directionId", 0),
            departure_min=td["departureMin"],
            arrival_min=td["arrivalMin"],
            duration_min=td.get("durationMin", max(1, td["arrivalMin"] - td["departureMin"])),
            headsign=td.get("headsign"),
            demand=td.get("demand", 50),
        ))

    trips.sort(key=lambda t: t.departure_min)

    # Group by route + direction
    groups: dict[str, RouteGroup] = {}
    for t in trips:
        key = f"{t.route_id}__{t.direction_id}"
        if key not in groups:
            groups[key] = RouteGroup(
                route_id=t.route_id,
                route_name=t.route_name,
                direction_id=t.direction_id,
                trips=[], ideal_headway=0,
            )
        groups[key].trips.append(t)

    # Calculate ideal headway per group
    for grp in groups.values():
        grp.trips.sort(key=lambda t: t.departure_min)
        if len(grp.trips) >= 2:
            span = grp.trips[-1].departure_min - grp.trips[0].departure_min
            grp.ideal_headway = span / (len(grp.trips) - 1)
        else:
            grp.ideal_headway = 60

    # Build list of strategies
    strategies_to_run = list(STRATEGIES)
    if custom_strategy:
        strategies_to_run.append(custom_strategy)

    # Per-strategy time limit
    per_strategy_limit = max(5, time_limit // len(strategies_to_run))

    # Run all strategies
    results = []
    for strat in strategies_to_run:
        result = solve_strategy(trips, groups, strat, per_strategy_limit)
        results.append(result)
        # Progress on stderr
        m = result["metrics"]
        sys.stderr.write(
            f"[{strat['name']}] status={m['solverStatus']} "
            f"removed={m['tripsRemoved']} shifted={m['tripsShifted']} "
            f"reg={m['regularityScore']:.3f} cov={m['coverageScore']:.3f} "
            f"oc={m['overcrowdingRisk']:.3f} time={m['solveTimeMs']}ms\n"
        )
        sys.stderr.flush()

    # Compute Pareto
    results = compute_pareto(results)

    best_name = next((r["strategy"]["name"] for r in results if r["isBest"]), strategies_to_run[0]["name"])
    pareto_front = [r["strategy"]["name"] for r in results if r["paretoRank"] == 0]

    total_time = sum(r["metrics"]["solveTimeMs"] for r in results)

    # Build comparison matrix
    comparison = {}
    for r in results:
        name = r["strategy"]["name"]
        m = r["metrics"]
        comparison[name] = {
            "tripsRemoved": m["tripsRemoved"],
            "tripsShifted": m["tripsShifted"],
            "savingsHours": round(m["savingsMinutes"] / 60, 1),
            "regularityScore": m["regularityScore"],
            "coverageScore": m["coverageScore"],
            "overcrowdingRisk": m["overcrowdingRisk"],
            "solverStatus": m["solverStatus"],
            "solveTimeMs": m["solveTimeMs"],
            "paretoRank": r["paretoRank"],
        }

    # Build route-level before/after per best strategy
    best_result = next(r for r in results if r["isBest"])
    removed_ids = set(d["tripId"] for d in best_result["decisions"] if d["action"] == "remove")

    route_before_after = {}
    for t in trips:
        key = t.route_name
        if key not in route_before_after:
            route_before_after[key] = {"routeName": key, "routeId": t.route_id, "before": 0, "after": 0}
        route_before_after[key]["before"] += 1
        if t.trip_id not in removed_ids:
            route_before_after[key]["after"] += 1

    output = {
        "bestStrategy": best_name,
        "paretoFront": pareto_front,
        "totalSolveTimeMs": total_time,
        "inputSummary": {
            "totalTrips": len(trips),
            "totalRoutes": len(set(t.route_id for t in trips)),
            "routeDirections": len(groups),
            "timeBands": len(TIME_BANDS),
            "maxShiftMinutes": MAX_SHIFT,
            "strategiesTested": len(strategies_to_run),
        },
        "comparisonMatrix": comparison,
        "routeBeforeAfter": sorted(route_before_after.values(), key=lambda x: -x["before"])[:20],
        "results": results,
    }

    json.dump(output, sys.stdout, ensure_ascii=False)


if __name__ == "__main__":
    main()
