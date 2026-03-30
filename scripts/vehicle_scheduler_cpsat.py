#!/usr/bin/env python3
"""
vehicle_scheduler_cpsat.py — CP-SAT Vehicle Scheduling Problem
Conerobus S.p.A. / TransitIntel — Level 1 Optimisation

Reads trips from stdin (JSON), solves Vehicle Scheduling Problem via CP-SAT,
outputs JSON on stdout with vehicle shifts matching the same structure as the
TypeScript greedy engine.

Usage:
  echo '<json>' | python3 vehicle_scheduler_cpsat.py [time_limit_sec]

Input JSON:
  { trips: [...], config?: { timeLimit?, ... } }

Output JSON:
  { status, vehicleShifts: [...], metrics: {...} }
"""

from __future__ import annotations
import sys
import time
import math
from collections import defaultdict

from ortools.sat.python import cp_model

from optimizer_common import (
    Trip, Arc, VShiftTrip, VehicleShift,
    trip_from_dict, vehicle_shift_to_dict,
    VEHICLE_SIZE, VEHICLE_TYPES, MAX_DOWNSIZE_LEVELS,
    MAX_DEADHEAD_KM, MAX_IDLE_AT_TERMINAL, MIN_LAYOVER, DEADHEAD_BUFFER,
    COST_VEHICLE_FIXED_DAY, COST_VEHICLE_PER_SERVICE_KM,
    COST_VEHICLE_PER_DEADHEAD_KM, COST_PER_DEPOT_RETURN,
    AVG_SERVICE_SPEED, DEADHEAD_SPEED,
    haversine_km, estimate_deadhead, is_peak_hour, can_vehicle_serve,
    min_to_time, fmt_dur,
    load_input, write_output, log,
)


# ═══════════════════════════════════════════════════════════════
#  WEIGHTS — objective function
# ═══════════════════════════════════════════════════════════════
W_VEHICLE   = 10_000   # per veicolo attivato
W_DEADHEAD  = 1        # per km di deadhead
W_DEPOT_RET = 50       # per rientro deposito
W_DOWNSIZE  = 5        # per livello di sotto-dimensionamento


# ═══════════════════════════════════════════════════════════════
#  ARC PRE-COMPUTATION
# ═══════════════════════════════════════════════════════════════

def build_compatible_arcs(trips: list[Trip], category: str) -> list[Arc]:
    """
    Pre-filtra gli archi compatibili: trip i -> trip j
    dove j.departure >= i.arrival + layover E dh_km <= MAX_DEADHEAD_KM.
    """
    n = len(trips)
    arcs: list[Arc] = []
    for i in range(n):
        ti = trips[i]
        for j in range(n):
            if i == j:
                continue
            tj = trips[j]
            # Temporal compatibility
            gap = tj.departure_min - ti.arrival_min
            if gap < MIN_LAYOVER:
                continue

            # Same terminal? distance ≈ 0
            same_terminal = (
                ti.last_stop_id == tj.first_stop_id
                or (abs(ti.last_stop_lat - tj.first_stop_lat) < 0.001
                    and abs(ti.last_stop_lon - tj.first_stop_lon) < 0.001)
            )
            if same_terminal:
                dh_km, dh_min = 0.0, 0
            else:
                dh_km, dh_min = estimate_deadhead(
                    ti.last_stop_lat, ti.last_stop_lon,
                    tj.first_stop_lat, tj.first_stop_lon,
                    category,
                )

            if dh_km > MAX_DEADHEAD_KM:
                continue

            # Check vehicle compatibility — at least one vehicle type can serve both
            if not trips_vehicle_compatible(ti, tj):
                continue

            # Arrival + deadhead travel must be before departure
            if ti.arrival_min + max(dh_min, MIN_LAYOVER) > tj.departure_min:
                continue

            depot_return = (gap > MAX_IDLE_AT_TERMINAL)

            arcs.append(Arc(i=i, j=j, dh_km=dh_km, dh_min=dh_min,
                            gap_min=gap, depot_return=depot_return))
    return arcs


def trips_vehicle_compatible(ti: Trip, tj: Trip) -> bool:
    """Check if at least one vehicle type can serve both trips."""
    si = VEHICLE_SIZE.get(ti.required_vehicle, 3)
    sj = VEHICLE_SIZE.get(tj.required_vehicle, 3)
    for vt in VEHICLE_TYPES:
        vs = VEHICLE_SIZE[vt]
        ok_i = (ti.forced and vt == ti.required_vehicle) or (not ti.forced and can_vehicle_serve(vs, si))
        ok_j = (tj.forced and vt == tj.required_vehicle) or (not tj.forced and can_vehicle_serve(vs, sj))
        if ok_i and ok_j:
            return True
    return False


# ═══════════════════════════════════════════════════════════════
#  WARM-START: quick greedy to seed CP-SAT
# ═══════════════════════════════════════════════════════════════

def greedy_warmstart(trips: list[Trip], arcs: list[Arc]) -> list[list[int]]:
    """Simple greedy: assign each trip to earliest-ending compatible vehicle."""
    n = len(trips)
    sorted_indices = sorted(range(n), key=lambda i: trips[i].departure_min)

    # Build adjacency for quick lookup
    adj: dict[int, list[Arc]] = defaultdict(list)
    for a in arcs:
        adj[a.i].append(a)

    vehicles: list[list[int]] = []
    vehicle_ends: list[int] = []       # last arrival time of each vehicle
    vehicle_last: list[int] = []       # last trip index of each vehicle
    vehicle_types: list[str] = []      # vehicle type for each vehicle
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

            # Vehicle compatibility
            if trip.forced:
                if vtype != trip.required_vehicle:
                    continue
            else:
                if not can_vehicle_serve(vsize, req_size):
                    continue

            last_idx = vehicle_last[vi]
            # Check if arc exists
            arc_found = None
            for a in adj[last_idx]:
                if a.j == idx:
                    arc_found = a
                    break
            if arc_found is None:
                continue

            gap = trip.departure_min - trips[last_idx].arrival_min
            score = gap + arc_found.dh_km * 2 + (500 if arc_found.depot_return else 0)

            if score < best_score:
                best_score = score
                best_v = vi

        if best_v >= 0:
            vehicles[best_v].append(idx)
            vehicle_ends[best_v] = trip.arrival_min
            vehicle_last[best_v] = idx
            assigned[idx] = True
        else:
            # Open new vehicle
            vehicles.append([idx])
            vehicle_ends.append(trip.arrival_min)
            vehicle_last.append(idx)
            vehicle_types.append(trip.required_vehicle)
            assigned[idx] = True

    return vehicles


# ═══════════════════════════════════════════════════════════════
#  CP-SAT MODEL
# ═══════════════════════════════════════════════════════════════

def solve_vsp(
    trips: list[Trip],
    arcs: list[Arc],
    category: str,
    time_limit: int = 60,
    warmstart_chains: list[list[int]] | None = None,
) -> tuple[str, list[list[int]], dict]:
    """
    Solve Vehicle Scheduling Problem via CP-SAT.
    Returns (status, chains, metrics).
    chains: list of list[int] — each is an ordered list of trip indices.
    """
    n = len(trips)
    if n == 0:
        return "OPTIMAL", [], {"vehicles": 0, "deadheadKm": 0, "solveTimeSec": 0}

    t0 = time.time()
    model = cp_model.CpModel()

    # ── Decision variables ──
    # seq[i,j] = 1 ↔ trip j immediately follows trip i on same vehicle
    seq = {}
    for a in arcs:
        seq[(a.i, a.j)] = model.new_bool_var(f"seq_{a.i}_{a.j}")

    # first[i] = 1 ↔ trip i is the first trip on its vehicle (depot → trip i)
    first = [model.new_bool_var(f"first_{i}") for i in range(n)]
    # last[i] = 1 ↔ trip i is the last trip on its vehicle (trip i → depot)
    last = [model.new_bool_var(f"last_{i}") for i in range(n)]

    # ── arc sets per node ──
    in_arcs: dict[int, list[tuple[int, int]]] = defaultdict(list)
    out_arcs: dict[int, list[tuple[int, int]]] = defaultdict(list)
    for a in arcs:
        in_arcs[a.j].append((a.i, a.j))
        out_arcs[a.i].append((a.i, a.j))

    # ── Constraints ──

    # 1. Every trip is covered exactly once
    for j in range(n):
        # Incoming: either first on vehicle, or preceded by exactly one trip
        predecessors = [seq[k] for k in in_arcs[j]]
        model.add(sum(predecessors) + first[j] == 1)

    for i in range(n):
        # Outgoing: either last on vehicle, or followed by exactly one trip
        successors = [seq[k] for k in out_arcs[i]]
        model.add(sum(successors) + last[i] == 1)

    # 2. Vehicle count = number of "first" trips
    num_vehicles = model.new_int_var(0, n, "num_vehicles")
    model.add(num_vehicles == sum(first))

    # 3. Total deadhead km (scaled integer)
    DH_SCALE = 10  # 1 decimal
    dh_terms = []
    for a in arcs:
        dh_terms.append(seq[(a.i, a.j)] * int(round(a.dh_km * DH_SCALE)))
    total_dh_scaled = model.new_int_var(0, n * MAX_DEADHEAD_KM * DH_SCALE, "total_dh")
    if dh_terms:
        model.add(total_dh_scaled == sum(dh_terms))
    else:
        model.add(total_dh_scaled == 0)

    # 4. Total depot returns (when gap > MAX_IDLE_AT_TERMINAL)
    depot_arcs = [a for a in arcs if a.depot_return]
    total_depot_returns = model.new_int_var(0, len(depot_arcs), "total_depot_ret")
    if depot_arcs:
        model.add(total_depot_returns == sum(seq[(a.i, a.j)] for a in depot_arcs))
    else:
        model.add(total_depot_returns == 0)

    # 5. Downsize penalty: for each seq arc where vehicle serving both trips
    #    might be smaller than required
    #    (simplified: compute offline penalty per arc)
    downsize_penalty_terms = []
    for a in arcs:
        ti, tj = trips[a.i], trips[a.j]
        si = VEHICLE_SIZE.get(ti.required_vehicle, 3)
        sj = VEHICLE_SIZE.get(tj.required_vehicle, 3)
        max_req = max(si, sj)
        # The vehicle type on this chain will be the max required — penalty is for trips
        # that need less. Actually, downsize = a trip running on vehicle SMALLER than required.
        # We approximate: if arcs connect different sizes, penalty proportional to gap.
        # (Proper per-vehicle-type selection would need VehicleType variables.)
        pass  # Downsize penalty handled in post-processing with chain assignment

    # ── Objective ──
    model.minimize(
        num_vehicles * W_VEHICLE
        + total_dh_scaled * (W_DEADHEAD * 10 // DH_SCALE)
        + total_depot_returns * W_DEPOT_RET
    )

    # ── Warm start ──
    if warmstart_chains:
        # Set hints from greedy
        first_set = set()
        last_set = set()
        seq_set = set()
        for chain in warmstart_chains:
            if len(chain) == 0:
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

    # ── Solve ──
    solver = cp_model.CpSolver()
    solver.parameters.max_time_in_seconds = time_limit
    solver.parameters.num_workers = 8
    solver.parameters.log_search_progress = False

    log(f"  [VSP-{category}] Model: {n} trips, {len(arcs)} arcs, time_limit={time_limit}s")
    status_code = solver.solve(model)
    elapsed = time.time() - t0
    status_str = solver.status_name(status_code)

    if status_code not in (cp_model.OPTIMAL, cp_model.FEASIBLE):
        log(f"  [VSP-{category}] Status={status_str}, no solution found in {elapsed:.1f}s")
        return status_str, [], {"vehicles": 0, "deadheadKm": 0, "solveTimeSec": round(elapsed, 1)}

    # ── Extract chains ──
    chains = extract_chains(n, arcs, seq, first, last, solver)

    total_dh_km = solver.value(total_dh_scaled) / DH_SCALE
    num_veh = solver.value(num_vehicles)
    depot_ret = solver.value(total_depot_returns)

    log(f"  [VSP-{category}] Status={status_str}, vehicles={num_veh}, "
        f"dh_km={total_dh_km:.1f}, depot_ret={depot_ret}, time={elapsed:.1f}s, "
        f"obj={solver.objective_value:.0f}")

    metrics = {
        "vehicles": num_veh,
        "deadheadKm": round(total_dh_km, 1),
        "depotReturns": depot_ret,
        "solveTimeSec": round(elapsed, 1),
        "status": status_str,
        "objectiveValue": round(solver.objective_value, 0),
    }

    return status_str, chains, metrics


def extract_chains(
    n: int, arcs: list[Arc], seq: dict, first: list, last: list,
    solver: cp_model.CpSolver,
) -> list[list[int]]:
    """Extract vehicle chains from solved CP-SAT model."""
    # Find start nodes (first[i] = 1)
    start_nodes = [i for i in range(n) if solver.value(first[i])]

    # Build successor map
    successor: dict[int, int] = {}
    for a in arcs:
        if solver.value(seq[(a.i, a.j)]):
            successor[a.i] = a.j

    chains: list[list[int]] = []
    for s in start_nodes:
        chain = [s]
        current = s
        visited = {s}
        while current in successor:
            nxt = successor[current]
            if nxt in visited:
                break  # safety
            chain.append(nxt)
            visited.add(nxt)
            current = nxt
        chains.append(chain)

    return chains


# ═══════════════════════════════════════════════════════════════
#  CHAIN → VehicleShift CONVERSION
# ═══════════════════════════════════════════════════════════════

def assign_vehicle_type(chain: list[int], trips: list[Trip]) -> str:
    """Determine best vehicle type for a chain — must serve all trips."""
    max_size = 0
    forced_type = None
    for idx in chain:
        t = trips[idx]
        s = VEHICLE_SIZE.get(t.required_vehicle, 3)
        if t.forced:
            forced_type = t.required_vehicle
        if s > max_size:
            max_size = s

    if forced_type:
        return forced_type

    # Find the smallest vehicle type that covers max_size (with downsize flexibility)
    # Try exact match first, then one level below
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

    # Fallback: largest
    return "autosnodato"


def chains_to_shifts(
    chains: list[list[int]],
    trips: list[Trip],
    arcs: list[Arc],
    category: str,
    vehicle_id_offset: int,
) -> list[VehicleShift]:
    """Convert solver chains to VehicleShift objects matching TypeScript format."""
    # Build arc lookup
    arc_map: dict[tuple[int, int], Arc] = {}
    for a in arcs:
        arc_map[(a.i, a.j)] = a

    prefix = "U" if category == "urbano" else "E"
    shifts: list[VehicleShift] = []

    for vi, chain in enumerate(chains):
        if not chain:
            continue

        vtype = assign_vehicle_type(chain, trips)
        vsize = VEHICLE_SIZE[vtype]
        vid = f"{prefix}{str(vehicle_id_offset + vi + 1).zfill(3)}"

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
                arc = arc_map.get((prev_idx, trip_idx))
                prev_t = trips[prev_idx]

                if arc and arc.depot_return:
                    # Depot return
                    depot_dep = prev_t.arrival_min + max(1, arc.dh_min // 2)
                    depot_arr = t.departure_min - max(1, arc.dh_min // 2)
                    vs.trips.append(VShiftTrip(
                        type="depot", trip_id="", route_id="",
                        route_name="🏠 Rientro deposito", headsign=None,
                        departure_time=min_to_time(depot_dep),
                        arrival_time=min_to_time(depot_arr),
                        departure_min=depot_dep, arrival_min=depot_arr,
                    ))
                    vs.depot_returns += 1
                elif arc and arc.dh_km > 0.5:
                    # Deadhead
                    dh_start = prev_t.arrival_min + MIN_LAYOVER
                    dh_end = min(dh_start + arc.dh_min, t.departure_min)
                    vs.trips.append(VShiftTrip(
                        type="deadhead", trip_id="", route_id="",
                        route_name=f"↝ Vuoto ({arc.dh_km} km)",
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
            vs.trips.append(VShiftTrip(
                type="trip", trip_id=t.trip_id, route_id=t.route_id,
                route_name=t.route_name, headsign=t.headsign,
                departure_time=t.departure_time, arrival_time=t.arrival_time,
                departure_min=t.departure_min, arrival_min=t.arrival_min,
                first_stop_name=t.first_stop_name, last_stop_name=t.last_stop_name,
                stop_count=t.stop_count, duration_min=t.duration_min,
                direction_id=t.direction_id,
                downsized=is_down or False,
                original_vehicle=t.required_vehicle if is_down else None,
            ))
            if is_down:
                vs.downsized_trips += 1

            vs.total_service_min += t.duration_min
            vs.trip_count += 1

        # Shift timing
        first_trip_entry = next((e for e in vs.trips if e.type == "trip"), None)
        last_trip_entry = next((e for e in reversed(vs.trips) if e.type == "trip"), None)
        if first_trip_entry and last_trip_entry:
            vs.start_min = first_trip_entry.departure_min
            vs.end_min = last_trip_entry.arrival_min
            vs.first_out = first_trip_entry.departure_min
            vs.last_in = last_trip_entry.arrival_min
            vs.shift_duration = vs.end_min - vs.start_min

        shifts.append(vs)

    # FIFO ordering
    shifts.sort(key=lambda s: s.first_out)
    for idx, s in enumerate(shifts):
        s.fifo_order = idx + 1

    return shifts


# ═══════════════════════════════════════════════════════════════
#  LOCAL SEARCH POST-PROCESSOR
# ═══════════════════════════════════════════════════════════════

def local_search_improve(
    chains: list[list[int]],
    trips: list[Trip],
    arcs: list[Arc],
    max_iterations: int = 500,
) -> list[list[int]]:
    """
    Simple local search: try moving tail of one chain to another
    if it reduces total vehicles or deadhead.
    """
    arc_map: dict[tuple[int, int], Arc] = {}
    for a in arcs:
        arc_map[(a.i, a.j)] = a

    def chain_cost(chain: list[int]) -> float:
        cost = W_VEHICLE  # fixed cost for having a vehicle
        for k in range(len(chain) - 1):
            arc = arc_map.get((chain[k], chain[k + 1]))
            if arc:
                cost += arc.dh_km * W_DEADHEAD
                if arc.depot_return:
                    cost += W_DEPOT_RET
        return cost

    improved = True
    iteration = 0
    while improved and iteration < max_iterations:
        improved = False
        iteration += 1
        for i in range(len(chains)):
            if len(chains[i]) == 0:
                continue
            for j in range(len(chains)):
                if i == j or len(chains[j]) == 0:
                    continue
                # Try appending last trip of chain[i] to chain[j]
                last_i = chains[i][-1]
                last_j = chains[j][-1]
                arc = arc_map.get((last_j, last_i))
                if arc is None:
                    continue
                # Would removing from i and adding to j improve?
                old_cost = chain_cost(chains[i]) + chain_cost(chains[j])
                new_chain_i = chains[i][:-1]
                new_chain_j = chains[j] + [last_i]
                new_cost = (chain_cost(new_chain_j)
                            + (chain_cost(new_chain_i) if new_chain_i else 0))
                if new_cost < old_cost - 0.01:
                    chains[i] = new_chain_i
                    chains[j] = new_chain_j
                    improved = True
                    break
            if improved:
                break

    # Remove empty chains
    chains = [c for c in chains if len(c) > 0]
    return chains


# ═══════════════════════════════════════════════════════════════
#  MAIN
# ═══════════════════════════════════════════════════════════════

def main():
    t_total_start = time.time()

    # Parse arguments
    time_limit = 60
    if len(sys.argv) > 1:
        try:
            time_limit = int(sys.argv[1])
        except ValueError:
            pass

    # Read input
    data = load_input()
    config = data.get("config", {})
    time_limit = config.get("timeLimit", time_limit)

    # Parse trips
    raw_trips = data.get("trips", [])
    if not raw_trips:
        write_output({
            "status": "NO_INPUT",
            "vehicleShifts": [],
            "metrics": {"vehicles": 0, "deadheadKm": 0, "solveTimeSec": 0},
        })
        return

    trips = [trip_from_dict(t, i) for i, t in enumerate(raw_trips)]
    log(f"[VSP] Loaded {len(trips)} trips, time_limit={time_limit}s")

    # Separate by category
    urban_trips = [t for t in trips if t.category == "urbano"]
    extra_trips = [t for t in trips if t.category == "extraurbano"]

    all_shifts: list[VehicleShift] = []
    all_metrics: dict = {
        "totalVehicles": 0,
        "totalDeadheadKm": 0,
        "totalDepotReturns": 0,
        "totalSolveTimeSec": 0,
        "byCategory": {},
    }

    offset = 0

    for category, cat_trips in [("urbano", urban_trips), ("extraurbano", extra_trips)]:
        if not cat_trips:
            continue

        # Re-index trips for this category
        cat_trip_list: list[Trip] = []
        for i, t in enumerate(cat_trips):
            ct = Trip(
                idx=i, trip_id=t.trip_id, route_id=t.route_id,
                route_name=t.route_name, headsign=t.headsign,
                direction_id=t.direction_id,
                departure_time=t.departure_time, arrival_time=t.arrival_time,
                departure_min=t.departure_min, arrival_min=t.arrival_min,
                first_stop_id=t.first_stop_id, last_stop_id=t.last_stop_id,
                first_stop_lat=t.first_stop_lat, first_stop_lon=t.first_stop_lon,
                last_stop_lat=t.last_stop_lat, last_stop_lon=t.last_stop_lon,
                first_stop_name=t.first_stop_name, last_stop_name=t.last_stop_name,
                stop_count=t.stop_count,
                required_vehicle=t.required_vehicle, category=t.category,
                forced=t.forced, duration_min=t.duration_min,
            )
            cat_trip_list.append(ct)

        cat_trip_list.sort(key=lambda x: x.departure_min)
        # Re-index after sorting
        for i, ct in enumerate(cat_trip_list):
            ct.idx = i

        log(f"[VSP-{category}] Building arcs for {len(cat_trip_list)} trips...")
        arcs = build_compatible_arcs(cat_trip_list, category)
        log(f"[VSP-{category}] {len(arcs)} compatible arcs found")

        # Warm start from greedy
        log(f"[VSP-{category}] Running greedy warm-start...")
        ws_chains = greedy_warmstart(cat_trip_list, arcs)
        log(f"[VSP-{category}] Greedy: {len(ws_chains)} vehicles")

        # Allocate time proportionally
        cat_time = max(10, int(time_limit * len(cat_trip_list) / max(len(trips), 1)))

        # Solve CP-SAT
        status, chains, metrics = solve_vsp(
            cat_trip_list, arcs, category,
            time_limit=cat_time,
            warmstart_chains=ws_chains,
        )

        # If CP-SAT failed, use greedy chains
        if not chains:
            log(f"[VSP-{category}] CP-SAT failed, using greedy result")
            chains = ws_chains
            metrics["status"] = "GREEDY_FALLBACK"

        # Local search improvement
        log(f"[VSP-{category}] Local search improvement...")
        chains = local_search_improve(chains, cat_trip_list, arcs)
        log(f"[VSP-{category}] After local search: {len(chains)} vehicles")

        # Convert to shifts
        shifts = chains_to_shifts(chains, cat_trip_list, arcs, category, offset)
        offset += len(shifts)

        all_shifts.extend(shifts)

        all_metrics["byCategory"][category] = metrics
        all_metrics["totalVehicles"] += len(shifts)
        all_metrics["totalDeadheadKm"] += sum(s.total_deadhead_km for s in shifts)
        all_metrics["totalDepotReturns"] += sum(s.depot_returns for s in shifts)

    total_time = time.time() - t_total_start
    all_metrics["totalSolveTimeSec"] = round(total_time, 1)

    # Final status
    statuses = [m.get("status", "UNKNOWN") for m in all_metrics.get("byCategory", {}).values()]
    final_status = "OPTIMAL" if all(s == "OPTIMAL" for s in statuses) else (
        "FEASIBLE" if any(s in ("OPTIMAL", "FEASIBLE") for s in statuses) else "FAILED"
    )

    log(f"[VSP] Done: {len(all_shifts)} vehicles, {all_metrics['totalDeadheadKm']:.1f}km dh, "
        f"{total_time:.1f}s total")

    write_output({
        "status": final_status,
        "vehicleShifts": [vehicle_shift_to_dict(s) for s in all_shifts],
        "metrics": all_metrics,
    })


if __name__ == "__main__":
    main()
