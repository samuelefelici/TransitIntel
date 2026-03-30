#!/usr/bin/env python3
"""
vehicle_scheduler_cpsat.py - CP-SAT Vehicle Scheduling Problem v2
Conerobus S.p.A. / TransitIntel - Level 1 Optimisation

MAIOR-inspired cost model: every minute of every vehicle shift has a real-EUR cost.
The objective function is the sum of all shift costs - no arbitrary weights.

Usage:
  echo '<json>' | python3 vehicle_scheduler_cpsat.py [time_limit_sec]
"""

from __future__ import annotations
import bisect
import random
import sys
import time
import math
from collections import defaultdict
from typing import Any

from ortools.sat.python import cp_model

from optimizer_common import (
    Trip, Arc, VShiftTrip, VehicleShift, VehicleCostRates, VehicleShiftCost,
    trip_from_dict, vehicle_shift_to_dict,
    VEHICLE_SIZE, VEHICLE_TYPES, MAX_DOWNSIZE_LEVELS,
    MAX_DEADHEAD_KM, MIN_LAYOVER, DEADHEAD_BUFFER,
    AVG_SERVICE_SPEED, DEADHEAD_SPEED,
    haversine_km, estimate_deadhead, is_peak_hour, can_vehicle_serve,
    min_to_time, fmt_dur,
    load_input, write_output, log, report_progress,
)

COST_SCALE = 100  # 1 unit = EUR 0.01


def _estimate_trip_km(trip: Trip, rates: VehicleCostRates) -> float:
    """Estimate service km from trip duration and category speed."""
    speed = rates.avg_service_speed.get(trip.category, 20.0)
    return trip.duration_min * speed / 60.0


# ---- ARC PRE-COMPUTATION - O(n x k) with bisect ----

def trips_vehicle_compatible(ti: Trip, tj: Trip) -> bool:
    """Check if any vehicle type can serve BOTH trips."""
    si = VEHICLE_SIZE.get(ti.required_vehicle, 3)
    sj = VEHICLE_SIZE.get(tj.required_vehicle, 3)
    for vt in VEHICLE_TYPES:
        vs = VEHICLE_SIZE[vt]
        ok_i = (ti.forced and vt == ti.required_vehicle) or (not ti.forced and can_vehicle_serve(vs, si))
        ok_j = (tj.forced and vt == tj.required_vehicle) or (not tj.forced and can_vehicle_serve(vs, sj))
        if ok_i and ok_j:
            return True
    return False


def build_compatible_arcs_fast(trips: list[Trip], rates: VehicleCostRates) -> list[Arc]:
    """O(n x k) arc building with bisect temporal windowing."""
    n = len(trips)
    sorted_by_dep = sorted(range(n), key=lambda idx: trips[idx].departure_min)
    dep_mins = [trips[sorted_by_dep[k]].departure_min for k in range(n)]
    max_window = rates.max_idle_at_terminal + 30

    arcs: list[Arc] = []
    for i in range(n):
        ti = trips[i]
        earliest_j = ti.arrival_min + MIN_LAYOVER
        latest_j = ti.arrival_min + max_window

        lo = bisect.bisect_left(dep_mins, earliest_j)
        hi = bisect.bisect_right(dep_mins, latest_j)

        for k in range(lo, hi):
            j = sorted_by_dep[k]
            if i == j:
                continue
            tj = trips[j]

            same = (ti.last_stop_id == tj.first_stop_id
                    or (abs(ti.last_stop_lat - tj.first_stop_lat) < 0.001
                        and abs(ti.last_stop_lon - tj.first_stop_lon) < 0.001))
            if same:
                dh_km, dh_min = 0.0, 0
            else:
                dh_km, dh_min = estimate_deadhead(
                    ti.last_stop_lat, ti.last_stop_lon,
                    tj.first_stop_lat, tj.first_stop_lon, ti.category)

            if dh_km > MAX_DEADHEAD_KM:
                continue
            if ti.arrival_min + max(dh_min, MIN_LAYOVER) > tj.departure_min:
                continue
            if not trips_vehicle_compatible(ti, tj):
                continue

            gap = tj.departure_min - ti.arrival_min
            depot_return = gap > rates.max_idle_at_terminal
            arcs.append(Arc(i=i, j=j, dh_km=round(dh_km, 1), dh_min=dh_min,
                            gap_min=gap, depot_return=depot_return))
    return arcs


# ---- ARC COST PRE-COMPUTATION (centesimi for CP-SAT) ----

def precompute_arc_costs(arcs: list[Arc], trips: list[Trip], rates: VehicleCostRates) -> dict[tuple[int, int], int]:
    costs: dict[tuple[int, int], int] = {}
    for a in arcs:
        ti = trips[a.i]
        vtype = ti.required_vehicle
        cost_euro = 0.0
        if a.dh_km > rates.min_deadhead_km:
            cost_euro += a.dh_km * rates.per_deadhead_km.get(vtype, 0.80)
        idle_min = max(0, a.gap_min - max(a.dh_min, MIN_LAYOVER))
        cost_euro += idle_min * rates.idle_per_min
        if idle_min > rates.long_idle_threshold:
            cost_euro += (idle_min - rates.long_idle_threshold) * rates.long_idle_per_min
        if a.depot_return:
            cost_euro += rates.per_depot_return
        costs[(a.i, a.j)] = int(round(cost_euro * COST_SCALE))
    return costs


def precompute_fixed_costs(trips: list[Trip], rates: VehicleCostRates) -> list[int]:
    return [int(round(rates.fixed_daily.get(t.required_vehicle, 42.0) * COST_SCALE)) for t in trips]


# ---- WARM-START: cost-aware greedy ----

def greedy_warmstart(
    trips: list[Trip], arcs: list[Arc], arcs_lookup: dict[tuple[int, int], Arc],
    rates: VehicleCostRates,
) -> list[list[int]]:
    n = len(trips)
    sorted_indices = sorted(range(n), key=lambda i: trips[i].departure_min)
    adj: dict[int, list[Arc]] = defaultdict(list)
    for a in arcs:
        adj[a.i].append(a)

    vehicles: list[list[int]] = []
    vehicle_last: list[int] = []
    vehicle_types: list[str] = []
    assigned = [False] * n

    for idx in sorted_indices:
        if assigned[idx]:
            continue
        trip = trips[idx]
        req_size = VEHICLE_SIZE.get(trip.required_vehicle, 3)
        best_v = -1
        best_score = float("inf")

        for vi in range(len(vehicles)):
            vtype = vehicle_types[vi]
            vsize = VEHICLE_SIZE[vtype]
            if trip.forced:
                if vtype != trip.required_vehicle:
                    continue
            else:
                if not can_vehicle_serve(vsize, req_size):
                    continue
            last_idx = vehicle_last[vi]
            arc_found = None
            for a in adj[last_idx]:
                if a.j == idx:
                    arc_found = a
                    break
            if arc_found is None:
                continue
            gap = trip.departure_min - trips[last_idx].arrival_min
            dh_cost = arc_found.dh_km * rates.per_deadhead_km.get(vtype, 0.80)
            idle_min = max(0, gap - max(arc_found.dh_min, MIN_LAYOVER))
            idle_cost = idle_min * rates.idle_per_min
            depot_cost = rates.per_depot_return if arc_found.depot_return else 0
            score = dh_cost + idle_cost + depot_cost
            if score < best_score:
                best_score = score
                best_v = vi

        if best_v >= 0:
            vehicles[best_v].append(idx)
            vehicle_last[best_v] = idx
            assigned[idx] = True
        else:
            vehicles.append([idx])
            vehicle_last.append(idx)
            vehicle_types.append(trip.required_vehicle)
            assigned[idx] = True
    return vehicles


# ---- CP-SAT MODEL - real-EUR cost objective ----

def solve_vsp_cost_based(
    trips: list[Trip], arcs: list[Arc],
    arc_costs: dict[tuple[int, int], int], fixed_costs: list[int],
    rates: VehicleCostRates, category: str,
    time_limit: int = 60, warmstart_chains: list[list[int]] | None = None,
    intensity: str = "normal",
) -> tuple[str, list[list[int]], dict]:
    n = len(trips)
    if n == 0:
        return "OPTIMAL", [], _empty_metrics()

    t0 = time.time()
    model = cp_model.CpModel()

    seq: dict[tuple[int, int], Any] = {}
    for a in arcs:
        seq[(a.i, a.j)] = model.new_bool_var(f"s_{a.i}_{a.j}")

    first = [model.new_bool_var(f"f_{i}") for i in range(n)]
    last = [model.new_bool_var(f"l_{i}") for i in range(n)]

    in_arcs: dict[int, list[tuple[int, int]]] = defaultdict(list)
    out_arcs: dict[int, list[tuple[int, int]]] = defaultdict(list)
    for a in arcs:
        in_arcs[a.j].append((a.i, a.j))
        out_arcs[a.i].append((a.i, a.j))

    for j in range(n):
        predecessors = [seq[k] for k in in_arcs[j]]
        model.add(sum(predecessors) + first[j] == 1)

    for i in range(n):
        successors = [seq[k] for k in out_arcs[i]]
        model.add(sum(successors) + last[i] == 1)

    num_vehicles = model.new_int_var(0, n, "nv")
    model.add(num_vehicles == sum(first))

    # Objective: real costs in centesimi
    obj_terms: list = []
    for i in range(n):
        obj_terms.append(first[i] * fixed_costs[i])
    for a in arcs:
        cost_cents = arc_costs.get((a.i, a.j), 0)
        if cost_cents > 0:
            obj_terms.append(seq[(a.i, a.j)] * cost_cents)

    model.minimize(sum(obj_terms))

    # Warm start
    if warmstart_chains:
        first_set: set[int] = set()
        last_set: set[int] = set()
        seq_set: set[tuple[int, int]] = set()
        for chain in warmstart_chains:
            if not chain:
                continue
            first_set.add(chain[0])
            last_set.add(chain[-1])
            for k in range(len(chain) - 1):
                seq_set.add((chain[k], chain[k + 1]))
        for i in range(n):
            model.add_hint(first[i], 1 if i in first_set else 0)
            model.add_hint(last[i], 1 if i in last_set else 0)
        for key, var in seq.items():
            model.add_hint(var, 1 if key in seq_set else 0)

    solver = cp_model.CpSolver()
    solver.parameters.max_time_in_seconds = time_limit
    solver.parameters.log_search_progress = False
    if intensity == "fast":
        solver.parameters.num_workers = 4
    elif intensity == "deep":
        solver.parameters.num_workers = 12
        solver.parameters.linearization_level = 2
        solver.parameters.symmetry_level = 2
    else:
        solver.parameters.num_workers = 8

    log(f"  [VSP-{category}] Model: {n} trips, {len(arcs)} arcs, tl={time_limit}s, int={intensity}")
    status_code = solver.solve(model)
    elapsed = time.time() - t0
    status_str = solver.status_name(status_code)

    if status_code not in (cp_model.OPTIMAL, cp_model.FEASIBLE):
        log(f"  [VSP-{category}] Status={status_str}, no solution in {elapsed:.1f}s")
        return status_str, [], _empty_metrics(elapsed)

    chains = _extract_chains(n, arcs, seq, first, solver)
    num_veh = solver.value(num_vehicles)
    obj_euro = solver.objective_value / COST_SCALE

    total_dh_km = 0.0
    depot_ret = 0
    for a in arcs:
        if solver.value(seq[(a.i, a.j)]):
            total_dh_km += a.dh_km
            if a.depot_return:
                depot_ret += 1

    log(f"  [VSP-{category}] {status_str}, veh={num_veh}, dh={total_dh_km:.1f}km, "
        f"depot={depot_ret}, cost=EUR{obj_euro:.2f}, t={elapsed:.1f}s")

    return status_str, chains, {
        "vehicles": num_veh, "deadheadKm": round(total_dh_km, 1),
        "depotReturns": depot_ret, "solveTimeSec": round(elapsed, 1),
        "status": status_str, "objectiveValue": round(obj_euro, 2),
    }


def _extract_chains(n, arcs, seq, first, solver):
    start_nodes = [i for i in range(n) if solver.value(first[i])]
    successor = {}
    for a in arcs:
        if solver.value(seq[(a.i, a.j)]):
            successor[a.i] = a.j
    chains = []
    for s in start_nodes:
        chain = [s]
        current = s
        visited = {s}
        while current in successor:
            nxt = successor[current]
            if nxt in visited:
                break
            chain.append(nxt)
            visited.add(nxt)
            current = nxt
        chains.append(chain)
    return chains


def _empty_metrics(elapsed=0.0):
    return {"vehicles": 0, "deadheadKm": 0, "depotReturns": 0,
            "solveTimeSec": round(elapsed, 1), "status": "NO_SOLUTION", "objectiveValue": 0}


# ---- COST EVALUATION & VEHICLE TYPE ASSIGNMENT ----

def assign_vehicle_type(chain: list[int], trips: list[Trip]) -> str:
    """Find smallest vehicle type that can serve ALL trips in chain."""
    forced_type = None
    max_size = 0
    for idx in chain:
        t = trips[idx]
        s = VEHICLE_SIZE.get(t.required_vehicle, 3)
        if t.forced:
            forced_type = t.required_vehicle
        if s > max_size:
            max_size = s
    if forced_type:
        return forced_type
    for vt in sorted(VEHICLE_TYPES, key=lambda v: VEHICLE_SIZE[v]):
        vs = VEHICLE_SIZE[vt]
        all_ok = True
        for idx in chain:
            t = trips[idx]
            rs = VEHICLE_SIZE.get(t.required_vehicle, 3)
            if t.forced and vt != t.required_vehicle:
                all_ok = False
                break
            if not can_vehicle_serve(vs, rs):
                all_ok = False
                break
        if all_ok:
            return vt
    return "autosnodato"


def _arc_idle_min(arc: Arc) -> float:
    """Compute idle minutes from arc gap (gap - max(dh_min, layover))."""
    return max(0, arc.gap_min - max(arc.dh_min, MIN_LAYOVER))


def chain_cost_detailed(
    chain: list[int], trips: list[Trip], arcs_lookup: dict[tuple[int, int], Arc],
    rates: VehicleCostRates,
) -> VehicleShiftCost:
    """Compute full real-EUR cost with quadratic penalties for a chain."""
    vtype = assign_vehicle_type(chain, trips)

    service_km = sum(_estimate_trip_km(trips[i], rates) for i in chain)

    deadhead_km = 0.0
    idle_minutes = 0.0
    depot_returns = 0
    for k in range(len(chain) - 1):
        arc = arcs_lookup.get((chain[k], chain[k + 1]))
        if arc:
            deadhead_km += arc.dh_km
            idle_minutes += _arc_idle_min(arc)
            if arc.depot_return:
                depot_returns += 1

    shift_start = trips[chain[0]].departure_min
    shift_end = trips[chain[-1]].arrival_min
    nastro = shift_end - shift_start

    cost = VehicleShiftCost()
    cost.fixed_daily = rates.fixed_daily.get(vtype, 42.0)
    cost.service_km_cost = service_km * rates.per_service_km.get(vtype, 0.95)
    cost.deadhead_km_cost = deadhead_km * rates.per_deadhead_km.get(vtype, 0.80)

    idle_cost = idle_minutes * rates.idle_per_min
    long_idle = max(0, idle_minutes - rates.long_idle_threshold)
    idle_cost += long_idle * rates.long_idle_per_min
    cost.idle_cost = idle_cost

    cost.depot_return_cost = depot_returns * rates.per_depot_return

    # Quadratic balance penalty
    delta = nastro - rates.target_shift_duration
    cost.balance_penalty = delta * delta * rates.balance_quadratic_coeff

    # Quadratic gap penalty (nastro vs working time)
    working = sum(trips[i].duration_min for i in chain)
    gap = nastro - working
    cost.gap_penalty = max(0, gap) ** 2 * rates.gap_quadratic_coeff

    # Downsize penalty
    vsize = VEHICLE_SIZE.get(vtype, 3)
    ds_pen = 0.0
    for i in chain:
        t = trips[i]
        rs = VEHICLE_SIZE.get(t.required_vehicle, 3)
        if vsize < rs:
            levels = rs - vsize
            if is_peak_hour(t.departure_min):
                ds_pen += levels * t.duration_min * rates.downsize_peak_per_level_per_min
            else:
                ds_pen += levels * t.duration_min * rates.downsize_offpeak_per_level_per_min
    cost.downsize_penalty = ds_pen

    cost.compute()
    return cost


def chain_cost_fast(
    chain: list[int], trips: list[Trip], arcs_lookup: dict[tuple[int, int], Arc],
    rates: VehicleCostRates,
) -> float:
    """Faster cost approximation (no quadratic penalties)."""
    vtype = assign_vehicle_type(chain, trips)
    fixed = rates.fixed_daily.get(vtype, 42.0)
    service_km = sum(_estimate_trip_km(trips[i], rates) for i in chain)
    dh_km = 0.0
    idle_min = 0.0
    depot_ret = 0
    for k in range(len(chain) - 1):
        arc = arcs_lookup.get((chain[k], chain[k + 1]))
        if arc:
            dh_km += arc.dh_km
            idle_min += _arc_idle_min(arc)
            if arc.depot_return:
                depot_ret += 1
    return (fixed
            + service_km * rates.per_service_km.get(vtype, 0.95)
            + dh_km * rates.per_deadhead_km.get(vtype, 0.80)
            + idle_min * rates.idle_per_min
            + depot_ret * rates.per_depot_return)


# ---- ADVANCED LOCAL SEARCH (5 move types) ----

def _try_merge(chains, idx_a, idx_b, trips, arcs_lookup, rates):
    ca, cb = chains[idx_a], chains[idx_b]
    arc = arcs_lookup.get((ca[-1], cb[0]))
    if not arc:
        return None
    if not trips_vehicle_compatible(trips[ca[0]], trips[cb[0]]):
        return None
    merged = ca + cb
    old_cost = chain_cost_fast(ca, trips, arcs_lookup, rates) + chain_cost_fast(cb, trips, arcs_lookup, rates)
    new_cost = chain_cost_fast(merged, trips, arcs_lookup, rates)
    if new_cost < old_cost - 0.01:
        return (new_cost - old_cost, merged, idx_a, idx_b)
    return None


def _try_relocate(chains, src_idx, pos_in_src, dst_idx, trips, arcs_lookup, rates):
    src = chains[src_idx]
    if len(src) <= 1:
        return None
    trip_idx = src[pos_in_src]
    new_src = src[:pos_in_src] + src[pos_in_src + 1:]
    dst = chains[dst_idx]
    best = None
    for insert_pos in range(len(dst) + 1):
        new_dst = dst[:insert_pos] + [trip_idx] + dst[insert_pos:]
        ok = True
        for k in range(len(new_dst) - 1):
            if (new_dst[k], new_dst[k + 1]) not in arcs_lookup:
                ok = False
                break
        if not ok:
            continue
        for k in range(len(new_src) - 1):
            if (new_src[k], new_src[k + 1]) not in arcs_lookup:
                ok = False
                break
        if not ok:
            continue
        old_cost = (chain_cost_fast(src, trips, arcs_lookup, rates)
                    + chain_cost_fast(dst, trips, arcs_lookup, rates))
        new_cost = (chain_cost_fast(new_src, trips, arcs_lookup, rates)
                    + chain_cost_fast(new_dst, trips, arcs_lookup, rates))
        delta = new_cost - old_cost
        if delta < -0.01 and (best is None or delta < best[0]):
            best = (delta, new_src, new_dst, src_idx, dst_idx)
    return best


def _try_swap(chains, idx_a, pos_a, idx_b, pos_b, trips, arcs_lookup, rates):
    ca, cb = list(chains[idx_a]), list(chains[idx_b])
    ca[pos_a], cb[pos_b] = cb[pos_b], ca[pos_a]
    for c in (ca, cb):
        for k in range(len(c) - 1):
            if (c[k], c[k + 1]) not in arcs_lookup:
                return None
    old_cost = (chain_cost_fast(chains[idx_a], trips, arcs_lookup, rates)
                + chain_cost_fast(chains[idx_b], trips, arcs_lookup, rates))
    new_cost = (chain_cost_fast(ca, trips, arcs_lookup, rates)
                + chain_cost_fast(cb, trips, arcs_lookup, rates))
    if new_cost < old_cost - 0.01:
        return (new_cost - old_cost, ca, cb, idx_a, idx_b)
    return None


def _try_or_opt(chains, idx, seg_start, seg_len, new_pos, trips, arcs_lookup, rates):
    chain = chains[idx]
    if seg_start + seg_len > len(chain):
        return None
    segment = chain[seg_start:seg_start + seg_len]
    rest = chain[:seg_start] + chain[seg_start + seg_len:]
    if new_pos > len(rest):
        return None
    new_chain = rest[:new_pos] + segment + rest[new_pos:]
    for k in range(len(new_chain) - 1):
        if (new_chain[k], new_chain[k + 1]) not in arcs_lookup:
            return None
    old_cost = chain_cost_fast(chain, trips, arcs_lookup, rates)
    new_cost = chain_cost_fast(new_chain, trips, arcs_lookup, rates)
    if new_cost < old_cost - 0.01:
        return (new_cost - old_cost, new_chain, idx)
    return None


def _try_rebalance(chains, idx_long, idx_short, trips, arcs_lookup, rates):
    cl, cs = chains[idx_long], chains[idx_short]
    if len(cl) <= 2:
        return None
    trip_idx = cl[-1]
    new_long = cl[:-1]
    arc = arcs_lookup.get((cs[-1], trip_idx))
    if not arc:
        return None
    new_short = cs + [trip_idx]
    for k in range(len(new_short) - 1):
        if (new_short[k], new_short[k + 1]) not in arcs_lookup:
            return None
    old_cost = (chain_cost_fast(cl, trips, arcs_lookup, rates)
                + chain_cost_fast(cs, trips, arcs_lookup, rates))
    new_cost = (chain_cost_fast(new_long, trips, arcs_lookup, rates)
                + chain_cost_fast(new_short, trips, arcs_lookup, rates))
    if new_cost < old_cost - 0.01:
        return (new_cost - old_cost, new_long, new_short, idx_long, idx_short)
    return None


def advanced_local_search(
    chains: list[list[int]], trips: list[Trip],
    arcs_lookup: dict[tuple[int, int], Arc], rates: VehicleCostRates,
    max_iter: int = 3000, max_time_sec: float = 15.0,
) -> list[list[int]]:
    if len(chains) <= 1:
        return chains

    t0 = time.time()
    chains = [list(c) for c in chains]
    best_total = sum(chain_cost_fast(c, trips, arcs_lookup, rates) for c in chains)
    no_improve = 0
    rng = random.Random(42)
    move_weights = [30, 25, 20, 15, 10]
    moves = ["merge", "relocate", "swap", "or_opt", "rebalance"]
    iteration = 0

    for iteration in range(max_iter):
        if time.time() - t0 > max_time_sec:
            break
        if no_improve > 300:
            break

        move = rng.choices(moves, weights=move_weights, k=1)[0]
        result = None
        nc = len(chains)
        if nc < 2 and move in ("merge", "relocate", "swap", "rebalance"):
            no_improve += 1
            continue

        if move == "merge":
            a, b = rng.sample(range(nc), 2)
            result = _try_merge(chains, a, b, trips, arcs_lookup, rates)
            if result:
                _, merged, ia, ib = result
                chains[ia] = merged
                chains.pop(ib)
        elif move == "relocate":
            a, b = rng.sample(range(nc), 2)
            if chains[a]:
                pos = rng.randrange(len(chains[a]))
                result = _try_relocate(chains, a, pos, b, trips, arcs_lookup, rates)
                if result:
                    _, new_src, new_dst, ia, ib = result
                    chains[ia] = new_src
                    chains[ib] = new_dst
                    chains = [c for c in chains if c]
        elif move == "swap":
            a, b = rng.sample(range(nc), 2)
            if chains[a] and chains[b]:
                pa = rng.randrange(len(chains[a]))
                pb = rng.randrange(len(chains[b]))
                result = _try_swap(chains, a, pa, b, pb, trips, arcs_lookup, rates)
                if result:
                    _, ca, cb, ia, ib = result
                    chains[ia] = ca
                    chains[ib] = cb
        elif move == "or_opt":
            idx = rng.randrange(nc)
            if len(chains[idx]) >= 3:
                seg_len = rng.choice([1, 2, 3])
                seg_start = rng.randrange(max(1, len(chains[idx]) - seg_len + 1))
                new_pos = rng.randrange(max(1, len(chains[idx]) - seg_len + 1))
                result = _try_or_opt(chains, idx, seg_start, seg_len, new_pos, trips, arcs_lookup, rates)
                if result:
                    _, new_chain, ci = result
                    chains[ci] = new_chain
        elif move == "rebalance":
            lengths = [(len(c), i) for i, c in enumerate(chains)]
            lengths.sort(reverse=True)
            if len(lengths) >= 2:
                result = _try_rebalance(chains, lengths[0][1], lengths[-1][1], trips, arcs_lookup, rates)
                if result:
                    _, new_long, new_short, il, is_ = result
                    chains[il] = new_long
                    chains[is_] = new_short

        if result:
            new_total = sum(chain_cost_fast(c, trips, arcs_lookup, rates) for c in chains)
            if new_total < best_total:
                best_total = new_total
                no_improve = 0
            else:
                no_improve += 1
        else:
            no_improve += 1

    elapsed = time.time() - t0
    log(f"  [LS] {iteration + 1} iter, {len(chains)} chains, EUR{best_total:.2f}, {elapsed:.1f}s")
    return chains


# ---- CHAIN -> VEHICLE SHIFT CONVERSION (matching v1 output format) ----

def chains_to_shifts(
    chains: list[list[int]], trips: list[Trip],
    arcs_lookup: dict[tuple[int, int], Arc], rates: VehicleCostRates,
    route_names: dict[str, str] | None = None,
) -> list[VehicleShift]:
    """Convert solver chains to VehicleShift objects matching TypeScript format."""
    shifts: list[VehicleShift] = []

    for vi, chain in enumerate(chains):
        if not chain:
            continue

        vtype = assign_vehicle_type(chain, trips)
        vsize = VEHICLE_SIZE.get(vtype, 3)
        vid = f"V{str(vi + 1).zfill(3)}"

        # Determine category from majority of trips
        cat_count = {"urbano": 0, "extraurbano": 0}
        for idx in chain:
            cat_count[trips[idx].category] = cat_count.get(trips[idx].category, 0) + 1
        category = max(cat_count, key=cat_count.get)

        vs = VehicleShift(
            vehicle_id=vid,
            vehicle_type=vtype,
            category=category,
        )

        for ci, trip_idx in enumerate(chain):
            t = trips[trip_idx]

            # Insert deadhead/depot between consecutive trips
            if ci > 0:
                prev_idx = chain[ci - 1]
                arc = arcs_lookup.get((prev_idx, trip_idx))
                prev_t = trips[prev_idx]

                if arc and arc.depot_return:
                    depot_dep = prev_t.arrival_min + max(1, arc.dh_min // 2)
                    depot_arr = t.departure_min - max(1, arc.dh_min // 2)
                    vs.trips.append(VShiftTrip(
                        type="depot", trip_id="", route_id="",
                        route_name="Rientro deposito", headsign=None,
                        departure_time=min_to_time(depot_dep),
                        arrival_time=min_to_time(depot_arr),
                        departure_min=depot_dep, arrival_min=depot_arr,
                    ))
                    vs.depot_returns += 1
                elif arc and arc.dh_km > 0.5:
                    dh_start = prev_t.arrival_min + MIN_LAYOVER
                    dh_end = min(dh_start + arc.dh_min, t.departure_min)
                    vs.trips.append(VShiftTrip(
                        type="deadhead", trip_id="", route_id="",
                        route_name=f"Vuoto ({arc.dh_km} km)",
                        headsign=None,
                        departure_time=min_to_time(dh_start),
                        arrival_time=min_to_time(dh_end),
                        departure_min=dh_start, arrival_min=dh_end,
                        deadhead_km=arc.dh_km, deadhead_min=arc.dh_min,
                    ))
                    vs.total_deadhead_min += arc.dh_min
                    vs.total_deadhead_km += arc.dh_km

            # Trip entry
            req_size = VEHICLE_SIZE.get(t.required_vehicle, 3)
            is_down = vsize < req_size
            rname = (route_names or {}).get(t.route_id, t.route_name)
            vs.trips.append(VShiftTrip(
                type="trip", trip_id=t.trip_id, route_id=t.route_id,
                route_name=rname, headsign=t.headsign,
                departure_time=t.departure_time, arrival_time=t.arrival_time,
                departure_min=t.departure_min, arrival_min=t.arrival_min,
                first_stop_name=t.first_stop_name, last_stop_name=t.last_stop_name,
                stop_count=t.stop_count, duration_min=t.duration_min,
                direction_id=t.direction_id,
                downsized=is_down,
                original_vehicle=t.required_vehicle if is_down else None,
            ))
            if is_down:
                vs.downsized_trips += 1

            vs.total_service_min += t.duration_min
            vs.trip_count += 1

        # Shift timing
        first_trip = next((e for e in vs.trips if e.type == "trip"), None)
        last_trip = next((e for e in reversed(vs.trips) if e.type == "trip"), None)
        if first_trip and last_trip:
            vs.start_min = first_trip.departure_min
            vs.end_min = last_trip.arrival_min
            vs.first_out = first_trip.departure_min
            vs.last_in = last_trip.arrival_min
            vs.shift_duration = vs.end_min - vs.start_min

        shifts.append(vs)

    # FIFO ordering
    shifts.sort(key=lambda s: s.first_out)
    for idx, s in enumerate(shifts):
        s.fifo_order = idx + 1

    return shifts


def compute_shift_costs(
    chains: list[list[int]], trips: list[Trip],
    arcs_lookup: dict[tuple[int, int], Arc], rates: VehicleCostRates,
) -> dict:
    """Post-processing: detailed cost breakdown per shift and aggregated."""
    shift_costs: list[dict] = []
    totals = VehicleShiftCost()

    for v_idx, chain in enumerate(chains):
        if not chain:
            continue
        sc = chain_cost_detailed(chain, trips, arcs_lookup, rates)
        d = sc.to_dict()
        d["vehicleId"] = v_idx + 1
        d["vehicleType"] = assign_vehicle_type(chain, trips)
        d["numTrips"] = len(chain)
        shift_costs.append(d)
        totals.fixed_daily += sc.fixed_daily
        totals.service_km_cost += sc.service_km_cost
        totals.deadhead_km_cost += sc.deadhead_km_cost
        totals.idle_cost += sc.idle_cost
        totals.depot_return_cost += sc.depot_return_cost
        totals.balance_penalty += sc.balance_penalty
        totals.gap_penalty += sc.gap_penalty
        totals.downsize_penalty += sc.downsize_penalty
        totals.total += sc.total

    return {
        "perShift": shift_costs,
        "aggregated": totals.to_dict(),
        "numVehicles": len(shift_costs),
    }


# ---- MAIN ----

def main():
    t_start = time.time()
    data = load_input()
    config = data.get("config", {})
    forced = config.get("forced", False)

    # Parse cost rates from operator config
    vehicle_costs_cfg = config.get("vehicleCosts", {})
    rates = VehicleCostRates.from_config(vehicle_costs_cfg)

    intensity = config.get("solverIntensity", "normal")
    time_limit = {"fast": 30, "normal": 60, "deep": 120}.get(intensity, 60)
    ls_time = {"fast": 5.0, "normal": 15.0, "deep": 30.0}.get(intensity, 15.0)
    ls_iter = {"fast": 1000, "normal": 3000, "deep": 5000}.get(intensity, 3000)

    route_names: dict[str, str] = {}
    for rd in data.get("routeDetails", []):
        route_names[rd["routeId"]] = rd.get("routeName", rd["routeId"])

    trips_data = data.get("trips", [])
    if not trips_data:
        log("No trips provided")
        write_output({"vehicleShifts": [], "metrics": _empty_metrics(),
                       "costBreakdown": {"perShift": [], "aggregated": {}, "numVehicles": 0}})
        return

    trips: list[Trip] = [trip_from_dict(td, i) for i, td in enumerate(trips_data)]
    trips.sort(key=lambda t: (t.departure_min, t.arrival_min))
    # Re-index after sort
    for i, t in enumerate(trips):
        t.idx = i
    n = len(trips)
    log(f"=== CP-SAT Vehicle Scheduler v2 (MAIOR-inspired) ===")
    log(f"  Trips: {n}, intensity: {intensity}, forced: {forced}")
    report_progress("VSP", 5, f"Loaded {n} trips")

    # Build arcs
    report_progress("VSP", 10, "Building compatibility arcs...")
    arcs = build_compatible_arcs_fast(trips, rates)
    arcs_lookup: dict[tuple[int, int], Arc] = {(a.i, a.j): a for a in arcs}
    log(f"  Arcs: {len(arcs)}")
    report_progress("VSP", 15, f"Built {len(arcs)} arcs")

    # Pre-compute costs
    report_progress("VSP", 18, "Pre-computing costs...")
    arc_costs = precompute_arc_costs(arcs, trips, rates)
    fixed_costs = precompute_fixed_costs(trips, rates)

    # Greedy warmstart
    report_progress("VSP", 20, "Greedy warmstart...")
    greedy_chains = greedy_warmstart(trips, arcs, arcs_lookup, rates)
    greedy_cost_total = sum(chain_cost_fast(c, trips, arcs_lookup, rates) for c in greedy_chains)
    log(f"  Greedy: {len(greedy_chains)} vehicles, EUR{greedy_cost_total:.2f}")
    report_progress("VSP", 25, f"Greedy: {len(greedy_chains)} vehicles")

    # CP-SAT solve
    report_progress("VSP", 30, "Solving CP-SAT model...")
    status, cpsat_chains, cpsat_metrics = solve_vsp_cost_based(
        trips, arcs, arc_costs, fixed_costs, rates, "ALL",
        time_limit=time_limit, warmstart_chains=greedy_chains,
        intensity=intensity,
    )
    report_progress("VSP", 70, f"CP-SAT: {cpsat_metrics.get('vehicles', '?')} vehicles")

    if not cpsat_chains:
        cpsat_chains = greedy_chains
        log("  Fallback to greedy solution")

    # Local search improvement
    report_progress("VSP", 75, "Local search optimization...")
    improved_chains = advanced_local_search(
        cpsat_chains, trips, arcs_lookup, rates,
        max_iter=ls_iter, max_time_sec=ls_time,
    )
    report_progress("VSP", 90, f"Post-LS: {len(improved_chains)} vehicles")

    # Convert to VehicleShift objects (full v1-compatible format)
    shifts = chains_to_shifts(improved_chains, trips, arcs_lookup, rates, route_names)

    # Cost breakdown
    cost_breakdown = compute_shift_costs(improved_chains, trips, arcs_lookup, rates)
    final_cost = cost_breakdown["aggregated"].get("total", 0)

    # Greedy comparison
    greedy_breakdown = compute_shift_costs(greedy_chains, trips, arcs_lookup, rates)
    greedy_total = greedy_breakdown["aggregated"].get("total", 0)
    savings = greedy_total - final_cost
    savings_pct = (savings / greedy_total * 100) if greedy_total > 0 else 0

    elapsed_total = time.time() - t_start
    log(f"\n=== RESULTS ===")
    log(f"  Vehicles: {len(improved_chains)} (greedy was {len(greedy_chains)})")
    log(f"  Cost: EUR{final_cost:.2f} (greedy EUR{greedy_total:.2f})")
    log(f"  Savings: EUR{savings:.2f} ({savings_pct:.1f}%)")
    log(f"  Total time: {elapsed_total:.1f}s")

    # Metrics
    total_dh_km = sum(s.total_deadhead_km for s in shifts)
    total_dh_min = sum(s.total_deadhead_min for s in shifts)
    total_service_min = sum(s.total_service_min for s in shifts)
    metrics = {
        "vehicles": len(shifts),
        "totalTrips": n,
        "totalServiceKm": round(sum(_estimate_trip_km(trips[i], rates) for c in improved_chains for i in c), 1),
        "totalDeadheadKm": round(total_dh_km, 1),
        "totalDeadheadMin": round(total_dh_min, 0),
        "totalServiceMin": total_service_min,
        "status": status,
        "solveTimeSec": round(elapsed_total, 1),
        "costEur": round(final_cost, 2),
        "greedyVehicles": len(greedy_chains),
        "greedyCostEur": round(greedy_total, 2),
        "savingsEur": round(savings, 2),
        "savingsPct": round(savings_pct, 1),
        "intensity": intensity,
    }

    report_progress("VSP", 95, "Writing output...")
    output = {
        "vehicleShifts": [vehicle_shift_to_dict(s) for s in shifts],
        "metrics": metrics,
        "costBreakdown": cost_breakdown,
        "greedyComparison": {
            "vehicles": len(greedy_chains),
            "costBreakdown": greedy_breakdown,
        },
    }
    write_output(output)
    report_progress("VSP", 100, f"Done: {len(shifts)} vehicles, EUR{final_cost:.2f}")


if __name__ == "__main__":
    main()
