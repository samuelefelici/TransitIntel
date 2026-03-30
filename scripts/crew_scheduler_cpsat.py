#!/usr/bin/env python3
"""
crew_scheduler_cpsat.py  -  CP-SAT Crew Scheduling v2
Conerobus / TransitIntel  -  Level 2 Optimisation

v2  Cost-based objective (EUR) instead of weight-based.
Pipeline: task_generator -> transfer_matrix -> duty_enumerator -> cost_model.
"""

from __future__ import annotations
import sys, time, math, signal, threading
from collections import defaultdict

from ortools.sat.python import cp_model

from optimizer_common import (
    Task, Duty, DutyBlock, Ripresa, CambioInfo,
    VShiftTrip, VehicleShift,
    VEHICLE_SIZE,
    PRE_TURNO_MIN, TARGET_WORK_LOW, TARGET_WORK_HIGH, TARGET_WORK_MID,
    COMPANY_CARS,
    SHIFT_RULES, DEPOT_TRANSFER_CENTRAL, DEPOT_TRANSFER_OUTER,
    MAX_CONTINUOUS_DRIVING, MIN_BREAK_AFTER_DRIVING,
    DEFAULT_CLUSTERS,
    match_cluster, cluster_by_id, depot_transfer_min,
    min_to_time, fmt_dur,
    load_input, write_output, log, report_progress,
    merge_config, weights_to_solver_params,
)

from cost_model import (
    CostRates, DutyCostBreakdown,
    compute_duty_cost, compute_global_cost_breakdown,
)
from transfer_matrix import build_transfer_matrix, can_chain_extended
from task_generator import build_tasks_multilevel, ExclusivityGroup
from duty_enumerator import enumerate_duties_with_options

# ----------------------------------------------------------------
# Graceful SIGINT
# ----------------------------------------------------------------
_stop_requested = threading.Event()

def _handle_sigint(signum, frame):
    log("[CSP] SIGINT received - requesting graceful stop...")
    _stop_requested.set()

signal.signal(signal.SIGINT, _handle_sigint)

# ----------------------------------------------------------------
# Cost scale  - CP-SAT needs integers; we use centesimi (EUR x 100)
# ----------------------------------------------------------------
COST_SCALE = 100


# ================================================================
#  SOLVE_CSP  -  Set Partitioning with cost-based objective
# ================================================================

def solve_csp(
    tasks,
    duties,
    time_limit=60,
    rates=None,
    round_label="",
    warmstart_selected=None,
    extra_constraints=None,
    exclusivity_groups=None,
):
    """Set Partitioning via CP-SAT.  Objective = min total cost (EUR)."""

    n_tasks = len(tasks)
    n_duties = len(duties)
    if n_tasks == 0 or n_duties == 0:
        return "NO_INPUT", [], {"drivers": 0, "solveTimeSec": 0}

    label = f"[{round_label}] " if round_label else ""
    t0 = time.time()
    model = cp_model.CpModel()

    # -- decision variables --
    z = [model.new_bool_var(f"z_{d}") for d in range(n_duties)]

    # -- coverage: each task at least once (set covering) --
    # If a task cannot be covered we add a slack variable with high penalty
    task_duties = defaultdict(list)
    for d, duty in enumerate(duties):
        for ti in duty.task_indices:
            task_duties[ti].append(d)

    uncoverable = []
    slack_vars = {}  # t_idx -> slack BoolVar (1 = task uncovered)
    UNCOV_PENALTY = 500 * COST_SCALE  # EUR 500 per task non coperto
    for t_idx in range(n_tasks):
        cov = task_duties.get(t_idx, [])
        if not cov:
            uncoverable.append(t_idx)
            continue
        # Soft coverage: sum(z[d]) + slack >= 1
        slack = model.new_bool_var(f"slack_{t_idx}")
        slack_vars[t_idx] = slack
        model.add(sum(z[d] for d in cov) + slack >= 1)

    if uncoverable:
        log(f"  {label}WARNING: {len(uncoverable)} uncoverable tasks")

    # -- exclusivity (multi-granularity) --
    if exclusivity_groups:
        for group in exclusivity_groups:
            levels = []
            level_tasks = []
            if group.coarse_indices:
                v = model.new_bool_var(f"lc_{group.vehicle_id}")
                levels.append(v)
                level_tasks.append((v, group.coarse_indices))
            if group.fine_indices:
                v = model.new_bool_var(f"lf_{group.vehicle_id}")
                levels.append(v)
                level_tasks.append((v, group.fine_indices))
            if group.medium_indices:
                v = model.new_bool_var(f"lm_{group.vehicle_id}")
                levels.append(v)
                level_tasks.append((v, group.medium_indices))
            if len(levels) > 1:
                model.add(sum(levels) == 1)
                for lvar, tis in level_tasks:
                    for ti in tis:
                        for d in task_duties.get(ti, []):
                            model.add(z[d] == 0).only_enforce_if(lvar.negated())

    # -- driver count --
    principal_idx = [d for d, dt in enumerate(duties) if dt.duty_type != "supplemento"]
    suppl_idx    = [d for d, dt in enumerate(duties) if dt.duty_type == "supplemento"]
    num_drivers = model.new_int_var(0, n_duties, "num_drivers")
    if principal_idx:
        model.add(num_drivers == sum(z[d] for d in principal_idx))
    else:
        model.add(num_drivers == 0)

    # -- supplementi cap: max 15% of total shifts (principal + supplementi) --
    if suppl_idx:
        num_suppl = model.new_int_var(0, len(suppl_idx), "num_suppl")
        model.add(num_suppl == sum(z[d] for d in suppl_idx))
        max_suppl_pct = (extra_constraints or {}).get("maxSupplementiPct", 15)
        # num_suppl * 100 <= maxPct * (num_drivers + num_suppl)
        model.add(num_suppl * 100 <= max_suppl_pct * (num_drivers + num_suppl))

    # -- extra constraints --
    ec = extra_constraints or {}
    if ec.get("maxDrivers"):
        model.add(num_drivers <= ec["maxDrivers"])

    if not ec.get("relaxPercentages"):
        sr = ec.get("shiftRules", SHIFT_RULES)
        semi_d = [d for d, dt in enumerate(duties) if dt.duty_type == "semiunico"]
        spez_d = [d for d, dt in enumerate(duties) if dt.duty_type == "spezzato"]
        if semi_d:
            mp = sr.get("semiunico", {}).get("maxPct", 12)
            model.add(sum(z[d] for d in semi_d) * 100 <= mp * num_drivers)
        if spez_d:
            mp = sr.get("spezzato", {}).get("maxPct", 13)
            model.add(sum(z[d] for d in spez_d) * 100 <= mp * num_drivers)

    mc = ec.get("maxCambiPerTurno")
    if mc is not None:
        for d, dt in enumerate(duties):
            if dt.cambi_count > mc:
                model.add(z[d] == 0)

    # -- company-car temporal constraint --
    cc = ec.get("companyCars", rates.company_cars if rates else COMPANY_CARS)
    if cc > 0:
        _add_car_constraint(model, z, duties, cc)

    # -- warmstart --
    if warmstart_selected:
        ws = set(warmstart_selected)
        for d in range(n_duties):
            model.add_hint(z[d], 1 if d in ws else 0)

    # -- OBJECTIVE: min total cost (centesimi) + uncoverage penalties --
    obj = []
    for d, duty in enumerate(duties):
        cents = int(getattr(duty, "cost_euro", 0) * COST_SCALE)
        if cents <= 0:
            pmr = (rates.hourly_rate if rates else 22.0) / 60.0
            cents = int(duty.work_min * pmr * COST_SCALE)
            if duty.duty_type == "supplemento":
                cents += int((rates.supplemento_fixed if rates else 18.0) * COST_SCALE)
        obj.append(z[d] * cents)
    # Penalità per task non coperti (slack=1 means uncovered)
    for sv in slack_vars.values():
        obj.append(sv * UNCOV_PENALTY)
    model.minimize(sum(obj))

    # -- solve --
    solver = cp_model.CpSolver()
    solver.parameters.max_time_in_seconds = time_limit
    solver.parameters.num_workers = 8
    solver.parameters.log_search_progress = False
    intensity = ec.get("solverIntensity", 2)
    if intensity >= 3:
        solver.parameters.linearization_level = 2
        solver.parameters.symmetry_level = 2
    elif intensity >= 2:
        solver.parameters.linearization_level = 1

    log(f"  {label}Model: {n_tasks} tasks, {n_duties} duties, "
        f"{len(uncoverable)} uncov, tl={time_limit}s, int={intensity}")

    sc = solver.solve(model)
    elapsed = time.time() - t0
    ss = solver.status_name(sc)

    if sc not in (cp_model.OPTIMAL, cp_model.FEASIBLE):
        log(f"  {label}Status={ss}, no solution in {elapsed:.1f}s")
        return ss, [], {"drivers": 0, "solveTimeSec": round(elapsed, 1)}

    selected = [d for d in range(n_duties) if solver.value(z[d])]
    np_ = sum(1 for d in selected if duties[d].duty_type != "supplemento")
    ns_ = len(selected) - np_
    tc = solver.objective_value / COST_SCALE
    n_uncov = sum(1 for sv in slack_vars.values() if solver.value(sv))

    log(f"  {label}Status={ss}, aut={np_} (+{ns_} suppl), "
        f"cost=EUR{tc:.2f}, uncov={n_uncov}, t={elapsed:.1f}s")

    by_type = defaultdict(int)
    tw = tn = tcm = 0
    for d in selected:
        dt = duties[d]
        by_type[dt.duty_type] += 1
        tw += dt.work_min
        tn += dt.nastro_min
        tcm += dt.cambi_count

    nsel = len(selected)
    return ss, selected, {
        "drivers": np_, "totalShifts": nsel, "supplementi": ns_,
        "byType": dict(by_type),
        "totalWorkHours": round(tw / 60, 1),
        "avgWorkMin": round(tw / max(nsel, 1)),
        "totalNastroHours": round(tn / 60, 1),
        "avgNastroMin": round(tn / max(nsel, 1)),
        "totalCambi": tcm,
        "solveTimeSec": round(elapsed, 1),
        "status": ss,
        "objectiveValue": round(solver.objective_value, 0),
        "totalCostEuro": round(tc, 2),
        "uncoverableTasks": len(uncoverable),
    }


def _add_car_constraint(model, z, duties, cars):
    """Company-car temporal constraint (10-min slots)."""
    mn = min((d.nastro_start for d in duties), default=300)
    mx = max((d.nastro_end for d in duties), default=1500)
    for sl in range((mn // 10) * 10 - 30, min(mx + 30, 1500), 10):
        se = sl + 10
        bag = []
        for di, dt in enumerate(duties):
            for rip in dt.riprese:
                ts = rip.start_min
                te = ts + rip.transfer_min
                if ts < se and te > sl:
                    bag.append(di)
                    break
        if len(bag) > cars:
            model.add(sum(z[d] for d in bag) <= cars)


# ================================================================
#  SERIALIZE
# ================================================================

def serialize_driver_shifts(selected_indices, duties, rates=None):
    result = []
    driver_n = 0
    for duty in sorted((duties[d] for d in selected_indices), key=lambda d: d.nastro_start):
        driver_n += 1
        did = f"AUT-U{str(driver_n).zfill(3)}"
        rips = []
        for rip in duty.riprese:
            vids = list({b.task.vehicle_id for b in rip.blocks})
            cambi = []
            for b in rip.blocks:
                if b.cambio:
                    cambi.append({
                        "cluster": b.cambio.cluster,
                        "clusterName": b.cambio.cluster_name,
                        "fromVehicle": b.cambio.from_vehicle,
                        "toVehicle": b.cambio.to_vehicle,
                        "atMin": b.task.start_min,
                        "atTime": min_to_time(b.task.start_min),
                    })
            trips = []
            for b in rip.blocks:
                for t in b.task.trips:
                    trips.append({
                        "tripId": t.trip_id, "routeId": t.route_id,
                        "routeName": t.route_name, "headsign": t.headsign,
                        "departureTime": t.departure_time,
                        "arrivalTime": t.arrival_time,
                        "departureMin": t.departure_min,
                        "arrivalMin": t.arrival_min,
                        "firstStopName": t.first_stop_name,
                        "lastStopName": t.last_stop_name,
                        "vehicleId": b.task.vehicle_id,
                    })
            rips.append({
                "startTime": min_to_time(rip.start_min),
                "endTime": min_to_time(rip.end_min),
                "startMin": rip.start_min, "endMin": rip.end_min,
                "preTurnoMin": rip.pre_turno_min,
                "transferMin": rip.transfer_min,
                "transferType": rip.transfer_type,
                "workMin": rip.work_min,
                "vehicleIds": vids, "cambi": cambi, "trips": trips,
            })

        cb = getattr(duty, "cost_breakdown", None)
        if cb is None and rates:
            cb = compute_duty_cost(duty, rates)
        cd = cb.to_dict() if cb else None

        out = {
            "driverId": did, "type": duty.duty_type,
            "nastroStart": min_to_time(duty.nastro_start),
            "nastroEnd": min_to_time(duty.nastro_end),
            "nastroStartMin": duty.nastro_start,
            "nastroEndMin": duty.nastro_end,
            "nastroMin": duty.nastro_min,
            "nastro": fmt_dur(duty.nastro_min),
            "workMin": duty.work_min,
            "work": fmt_dur(duty.work_min),
            "interruptionMin": duty.interruption_min,
            "interruption": fmt_dur(duty.interruption_min) if duty.interruption_min > 0 else None,
            "transferMin": duty.transfer_min,
            "preTurnoMin": duty.pre_turno_min,
            "cambiCount": duty.cambi_count,
            "riprese": rips,
        }
        if cd:
            out["costBreakdown"] = cd
            out["costEuro"] = cd["total"]
        result.append(out)
    return result


# ================================================================
#  MERGE SUPPLEMENTI -> SPEZZATO / SEMIUNICO
# ================================================================

def merge_supplementi(selected_indices, duties, rates=None):
    suppl = [(d, duties[d]) for d in selected_indices if duties[d].duty_type == "supplemento"]
    other = [d for d in selected_indices if duties[d].duty_type != "supplemento"]
    if len(suppl) < 2:
        return selected_indices

    ex_semi = sum(1 for d in other if duties[d].duty_type == "semiunico")
    ex_spez = sum(1 for d in other if duties[d].duty_type == "spezzato")
    cur_pr = len(other)
    semi_mp = (SHIFT_RULES["semiunico"].get("maxPct", 12) - 1) / 100.0
    spez_mp = (SHIFT_RULES["spezzato"].get("maxPct", 13) - 1) / 100.0
    a_semi = a_spez = 0

    suppl.sort(key=lambda x: x[1].nastro_end)
    merged_pairs = []
    used = set()

    smn = SHIFT_RULES["semiunico"]["maxNastro"]
    simin = SHIFT_RULES["semiunico"]["intMin"]
    simax = SHIFT_RULES["semiunico"]["intMax"]
    spmn = SHIFT_RULES["spezzato"]["maxNastro"]
    spimin = SHIFT_RULES["spezzato"]["intMin"]

    for i, (d1, du1) in enumerate(suppl):
        if d1 in used:
            continue
        for j in range(i + 1, len(suppl)):
            d2, du2 = suppl[j]
            if d2 in used or du1.nastro_end >= du2.nastro_start:
                continue
            rg = du2.riprese[0].blocks[0].task.start_min - du1.riprese[-1].blocks[-1].task.end_min
            ei = rg - PRE_TURNO_MIN - du2.transfer_min
            nas = du2.nastro_end - du1.nastro_start
            tw = du1.work_min + du2.work_min

            mt = None
            if simin <= ei <= simax and nas <= smn:
                mt = "semiunico"
            elif ei >= spimin and nas <= spmn:
                mt = "spezzato"
            if not mt:
                continue

            if mt == "semiunico" and not (240 <= tw <= 480):
                if ei >= spimin and nas <= spmn and 240 <= tw <= 450:
                    mt = "spezzato"
                else:
                    continue
            elif mt == "spezzato" and not (240 <= tw <= 450):
                continue

            pp = max(cur_pr + len(merged_pairs) + 1, 1)
            if mt == "semiunico":
                if (ex_semi + a_semi + 1) / pp > semi_mp:
                    if ei >= spimin and nas <= spmn:
                        if (ex_spez + a_spez + 1) / pp > spez_mp:
                            continue
                        mt = "spezzato"
                    else:
                        continue
            elif mt == "spezzato":
                if (ex_spez + a_spez + 1) / pp > spez_mp:
                    continue

            ni = len(duties) + len(merged_pairs)
            mti = sorted(set(du1.task_indices) | set(du2.task_indices))
            md = Duty(
                idx=ni, duty_type=mt,
                riprese=du1.riprese + du2.riprese,
                nastro_start=du1.nastro_start, nastro_end=du2.nastro_end,
                nastro_min=nas, work_min=tw, interruption_min=ei,
                transfer_min=du1.transfer_min + du2.transfer_min,
                pre_turno_min=PRE_TURNO_MIN * 2,
                cambi_count=du1.cambi_count + du2.cambi_count,
                task_indices=mti,
            )

            if rates:
                c1 = getattr(du1, "cost_euro", 0) or compute_duty_cost(du1, rates).total
                c2 = getattr(du2, "cost_euro", 0) or compute_duty_cost(du2, rates).total
                mcb = compute_duty_cost(md, rates)
                md.cost_breakdown = mcb
                md.cost_euro = mcb.total
                if mcb.total > (c1 + c2) * 1.10:
                    continue

            if mt == "semiunico":
                a_semi += 1
            else:
                a_spez += 1
            merged_pairs.append((d1, d2, md))
            used.add(d1)
            used.add(d2)
            break

    if not merged_pairs:
        return selected_indices

    off = len(duties)
    for io, (_, _, md) in enumerate(merged_pairs):
        md.idx = off + io
        duties.append(md)

    rem = [d for d, _ in suppl if d not in used]
    ns = other + rem + [off + i for i in range(len(merged_pairs))]
    log(f"  [CSP] Post-merge: {len(merged_pairs)} pairs -> "
        f"{sum(1 for _,_,m in merged_pairs if m.duty_type=='semiunico')} semi + "
        f"{sum(1 for _,_,m in merged_pairs if m.duty_type=='spezzato')} spez, "
        f"{len(selected_indices)} -> {len(ns)}")
    return ns


# ================================================================
#  GREEDY FALLBACK
# ================================================================

def greedy_fallback(tasks, duties):
    """Greedy set-cover ottimizzato: priorità a turni lunghi (intero > semi > spez > suppl).

    Strategia:
    1. Pre-sort duties: intero con più task prima, supplemento per ultimo
    2. Prima pass: copri tutto con turni principali (overlap OK se copre nuovo task)
    3. Seconda pass: solo se rimangono task non coperti, usa supplementi (con limite)
    """
    covered = set()
    selected_set = set()
    selected = []
    n_tasks = len(tasks)

    # Pre-calcola task_indices come set per O(1) overlap check
    duty_task_sets = [set(dt.task_indices) for dt in duties]

    # Scoring: favorisci turni con molti task e tipo principale
    TYPE_PRIO = {"intero": 0, "semiunico": 1, "spezzato": 2, "supplemento": 4}

    def _score(d):
        dt = duties[d]
        nc = len(duty_task_sets[d])
        tp = TYPE_PRIO.get(dt.duty_type, 3)
        wb = min(dt.work_min, TARGET_WORK_HIGH) / TARGET_WORK_HIGH
        cost = getattr(dt, "cost_euro", 0)
        return (-tp, nc, wb, -dt.cambi_count, -cost)

    # Ordina duties per score (migliori prima)
    sorted_duties = sorted(range(len(duties)), key=_score, reverse=True)

    # Separa principali e supplementi
    principal = [d for d in sorted_duties if duties[d].duty_type != "supplemento"]
    supplementi = [d for d in sorted_duties if duties[d].duty_type == "supplemento"]

    # Pass 1: copri con turni principali — priorità a chi copre PIÙ task nuovi
    # Greedy adattivo: a ogni step, scegli il duty con più task nuovi
    # (invece di un ordine fisso pre-calcolato)
    principal_set = set(principal)
    for _pass in range(3):
        # Re-sort per task nuovi a ogni pass (leggero: solo su principali restanti)
        still_available = [d for d in principal if d not in selected_set]
        if not still_available:
            break
        
        # Ordina per nuovi task coperti (desc), poi tipo, poi lavoro
        still_available.sort(
            key=lambda d: (
                -len(duty_task_sets[d] - covered),  # più task nuovi prima
                TYPE_PRIO.get(duties[d].duty_type, 3),  # intero prima
                -duties[d].work_min,  # più lavoro prima
            )
        )
        
        for d in still_available:
            if len(covered) >= n_tasks:
                break
            ts = duty_task_sets[d]
            if not ts:
                continue
            new_tasks = ts - covered
            if not new_tasks:
                continue
            selected.append(d)
            selected_set.add(d)
            covered.update(ts)

    # Pass 2: supplementi solo per ciò che manca (con limite ~15% dei turni totali)
    n_principal = len(selected)
    max_suppl = max(5, n_principal // 6)  # ~15% max dei totali
    n_suppl = 0
    for d in supplementi:
        if len(covered) >= n_tasks:
            break
        if n_suppl >= max_suppl:
            break
        ts = duty_task_sets[d]
        new_tasks = ts - covered
        if not new_tasks:
            continue
        selected.append(d)
        selected_set.add(d)
        covered.update(ts)
        n_suppl += 1

    # Pass 3: se ancora non coperto, rilassa il limite supplementi (fino a 25%)
    if len(covered) < n_tasks:
        max_suppl_relaxed = max(max_suppl * 2, n_principal // 4)
        for d in supplementi:
            if len(covered) >= n_tasks:
                break
            if n_suppl >= max_suppl_relaxed:
                break
            if d in selected_set:
                continue
            ts = duty_task_sets[d]
            new_tasks = ts - covered
            if not new_tasks:
                continue
            selected.append(d)
            selected_set.add(d)
            covered.update(ts)
            n_suppl += 1

    np_ = sum(1 for d in selected if duties[d].duty_type != "supplemento")
    ns_ = len(selected) - np_
    log(f"  [Greedy] {np_} principali + {ns_} supplementi, "
        f"{len(covered)}/{n_tasks} coperti")
    return selected


# ================================================================
#  ITERATIVE SOLVER  -  multi-round progressive tightening
# ================================================================

def iterative_solve(
    tasks, duties, total_time_limit, merged_cfg, rates,
    greedy_warmstart=None, exclusivity_groups=None,
):
    max_rounds = merged_cfg.get("maxRounds", 5)
    intensity = merged_cfg.get("solverIntensity", 2)
    sr = merged_cfg.get("shiftRules", SHIFT_RULES)
    pinned = merged_cfg.get("pinnedConstraints", {})

    fracs = [0.10, 0.15, 0.35, 0.25, 0.15]
    names = ["Relaxed", "CCNL", "Minimize", "Quality", "Polish"]

    best_sel = []
    best_st = "NO_SOLUTION"
    best_m = {"drivers": 0, "solveTimeSec": 0}
    rounds = []

    if greedy_warmstart:
        best_sel = greedy_warmstart
        best_st = "GREEDY_WARMSTART"
        gp = sum(1 for d in greedy_warmstart if duties[d].duty_type != "supplemento")
        gc = sum(getattr(duties[d], "cost_euro", 0) for d in greedy_warmstart)
        best_m = {"drivers": gp, "solveTimeSec": 0, "totalCostEuro": round(gc, 2)}
        log(f"[CSP] Greedy warmstart: {gp} aut, EUR{gc:.2f}")

    t_start = time.time()
    for rnd in range(min(max_rounds, len(fracs))):
        if _stop_requested.is_set():
            break
        el = time.time() - t_start
        rem = max(5, total_time_limit - el)
        rt = max(5, int(rem * fracs[rnd] / sum(fracs[rnd:])))

        rl = f"R{rnd+1}/{names[rnd]}"
        pb = 30 + (rnd / max_rounds) * 58
        pe = 30 + ((rnd + 1) / max_rounds) * 58
        bp = sum(1 for d in best_sel if duties[d].duty_type != "supplemento") if best_sel else 0
        bc = best_m.get("totalCostEuro", 0)

        report_progress("solving", pb,
            f"Round {rnd+1}/{max_rounds}: {names[rnd]} ({rt}s) - EUR{bc}",
            {"round": rnd+1, "roundName": names[rnd], "timeLimit": rt,
             "bestDrivers": bp, "bestCost": bc})

        ec = {"shiftRules": sr, "solverIntensity": intensity,
              "companyCars": rates.company_cars,
              "maxSupplementiPct": merged_cfg.get("maxSupplementiPct", 15)}
        if pinned.get("maxCambiPerTurno") is not None:
            ec["maxCambiPerTurno"] = pinned["maxCambiPerTurno"]

        if rnd == 0:
            ec["relaxPercentages"] = True
            ec["maxSupplementiPct"] = 25  # più rilassato nel round esplorativo
        elif rnd == 2 and bp > 0:
            ec["maxDrivers"] = bp - 1
        elif rnd >= 3 and bp > 0:
            ec["maxDrivers"] = bp

        st, sel, met = solve_csp(
            tasks, duties, time_limit=rt, rates=rates,
            round_label=rl, warmstart_selected=best_sel or None,
            extra_constraints=ec, exclusivity_groups=exclusivity_groups)

        met["round"] = rnd + 1
        met["roundName"] = names[rnd]
        rounds.append(met)

        if sel:
            sc = met.get("totalCostEuro", float("inf"))
            if not best_sel or sc < best_m.get("totalCostEuro", float("inf")):
                best_sel = sel
                best_st = st
                best_m = dict(met)
                log(f"  [{rl}] * New best: {met.get('drivers',0)} aut, EUR{sc:.2f}")
        else:
            log(f"  [{rl}] No improvement ({st})")
            if rnd == 2:
                log(f"  [{rl}] N-1 infeasible - optimal confirmed")

        report_progress("solving", pe,
            f"Round {rnd+1}: {best_m.get('drivers',0)} aut, EUR{best_m.get('totalCostEuro',0)} ({best_st})",
            {"round": rnd+1, "drivers": best_m.get("drivers",0),
             "cost": best_m.get("totalCostEuro",0), "status": best_st})

    best_m["rounds"] = rounds
    best_m["totalRounds"] = len(rounds)
    return best_st, best_sel, best_m


# ================================================================
#  MAIN
# ================================================================

def main():
    t0 = time.time()

    tl_cli = None
    if len(sys.argv) > 1:
        try:
            tl_cli = int(sys.argv[1])
        except ValueError:
            pass

    data = load_input()
    rc = data.get("config", {})
    cfg = merge_config(rc)
    tl = tl_cli or cfg.get("timeLimit", rc.get("timeLimit", 60))

    rates = CostRates.from_config(cfg)
    log(f"[CSP] Rates: EUR{rates.hourly_rate}/h, extra EUR{rates.extra_driver_daily}/d, "
        f"cars={rates.company_cars}")

    raw = data.get("vehicleShifts", [])
    if not raw:
        write_output({"status": "NO_INPUT", "driverShifts": [],
                       "summary": _empty_summary(), "metrics": {"drivers": 0, "solveTimeSec": 0}})
        return

    log(f"[CSP] {len(raw)} vehicle shifts, tl={tl}s")
    report_progress("loading", 5, f"Caricati {len(raw)} turni macchina")

    # -- Phase 2A: multi-level task generation --
    tg = cfg.get("taskGranularity", "auto")
    report_progress("task_gen", 8, f"Generazione task ({tg})...")
    tasks, excl = build_tasks_multilevel(raw, tg)
    log(f"[CSP] {len(tasks)} tasks, {len(excl)} exclusivity groups")
    report_progress("task_gen", 12, f"Generati {len(tasks)} task", {"tasks": len(tasks)})

    if not tasks:
        write_output({"status": "NO_TASKS", "driverShifts": [],
                       "summary": _empty_summary(), "metrics": {"drivers": 0, "solveTimeSec": 0}})
        return

    # -- Phase 2A.5: transfer matrix --
    xc = cfg.get("enableCrossCluster", True)
    tm = None
    if xc:
        report_progress("transfers", 14, "Calcolo matrice trasferimenti...")
        tm = build_transfer_matrix(tasks, rates)
        report_progress("transfers", 16, f"Matrice: {len(tm)} entry", {"transfers": len(tm)})

    # -- Phase 2B: duty enumeration with costs --
    report_progress("enum_duties", 17, "Enumerazione turni con costi...")
    nt = len(tasks)
    max_d = 60_000 if nt <= 500 else 80_000
    duties = enumerate_duties_with_options(
        tasks, transfer_matrix=tm, rates=rates,
        max_duties=max_d, enable_cross_cluster=xc)
    report_progress("enum_duties", 22, f"Generati {len(duties)} turni",
                    {"duties": len(duties), "tasks": nt})

    if not duties:
        log("[CSP] No feasible duties!")
        write_output({"status": "NO_DUTIES", "driverShifts": [],
                       "summary": _empty_summary(), "metrics": {"drivers": 0, "solveTimeSec": 0}})
        return

    # -- Greedy warmstart --
    # Per il greedy, usa solo task "fine" (o "coarse" se non c'è fine per quel veicolo)
    # per evitare duplicazioni multi-livello
    report_progress("warmstart", 25, "Warmstart greedy...")
    if excl and tg == "auto":
        # Determina gli indici task "preferiti" per ogni veicolo
        preferred_task_indices = set()
        for group in excl:
            # Preferisci fine > medium > coarse
            if group.fine_indices:
                preferred_task_indices.update(group.fine_indices)
            elif group.medium_indices:
                preferred_task_indices.update(group.medium_indices)
            else:
                preferred_task_indices.update(group.coarse_indices)
        
        # Filtra task e duty per il greedy
        greedy_task_map = {}  # old_idx -> new_idx
        greedy_tasks = []
        for t in tasks:
            if t.idx in preferred_task_indices:
                greedy_task_map[t.idx] = len(greedy_tasks)
                greedy_tasks.append(t)
        
        # Filtra duty: solo quelli i cui task_indices sono tutti nel set preferito
        greedy_duties = []
        greedy_duty_map = {}  # new_idx -> old_idx in duties
        for di, d in enumerate(duties):
            if all(ti in preferred_task_indices for ti in d.task_indices) and d.task_indices:
                # Remappa task_indices al nuovo spazio
                new_ti = sorted(greedy_task_map[ti] for ti in d.task_indices if ti in greedy_task_map)
                if new_ti:
                    from copy import copy
                    nd = copy(d)
                    nd.idx = len(greedy_duties)
                    nd.task_indices = new_ti
                    greedy_duty_map[len(greedy_duties)] = di
                    greedy_duties.append(nd)
        
        log(f"[CSP] Greedy filter: {len(greedy_tasks)}/{len(tasks)} tasks, "
            f"{len(greedy_duties)}/{len(duties)} duties")
        
        gs_local = greedy_fallback(greedy_tasks, greedy_duties)
        # Rimappa indici al set originale
        gs = [greedy_duty_map[g] for g in gs_local]
    else:
        gs = greedy_fallback(tasks, duties)
    
    gc = sum(getattr(duties[d], "cost_euro", 0) for d in gs)
    log(f"[CSP] Greedy: {len(gs)} turni, EUR{gc:.2f}")
    report_progress("warmstart", 28, f"Warmstart: {len(gs)} turni, EUR{gc:.0f}",
                    {"greedyDrivers": len(gs), "greedyCost": round(gc, 2)})

    # -- Phase 2C: solve --
    report_progress("solving", 28, "Avvio solver CP-SAT (cost-based)...")
    intensity = cfg.get("solverIntensity", 2)
    mr = cfg.get("maxRounds", 5)
    st_time = max(10, int(tl - (time.time() - t0)))
    use_excl = excl if tg == "auto" else None

    if intensity == 1 or mr == 1:
        status, sel, met = solve_csp(
            tasks, duties, time_limit=st_time, rates=rates,
            round_label="Single", warmstart_selected=gs,
            extra_constraints={"shiftRules": cfg.get("shiftRules", SHIFT_RULES),
                               "solverIntensity": intensity,
                               "companyCars": rates.company_cars},
            exclusivity_groups=use_excl)
    else:
        status, sel, met = iterative_solve(
            tasks, duties, total_time_limit=st_time,
            merged_cfg=cfg, rates=rates,
            greedy_warmstart=gs, exclusivity_groups=use_excl)

    report_progress("solving", 90,
        f"Solver: {met.get('drivers',0)} aut, EUR{met.get('totalCostEuro',0)} ({status})")

    if not sel:
        log("[CSP] CP-SAT failed, greedy fallback...")
        report_progress("fallback", 92, "Fallback greedy...")
        sel = greedy_fallback(tasks, duties)
        met["status"] = "GREEDY_FALLBACK"
        status = "GREEDY_FALLBACK"

    # -- Post-process: merge supplementi --
    pre = len(sel)
    report_progress("merge", 92, "Merge supplementi...")
    sel = merge_supplementi(sel, duties, rates)
    if len(sel) < pre:
        report_progress("merge", 94, f"Merge: {pre} -> {len(sel)}")

    # -- Serialize --
    report_progress("serialize", 95, "Serializzazione...")
    ds_out = serialize_driver_shifts(sel, duties, rates)

    # -- Summary --
    by_type = {"intero": 0, "semiunico": 0, "spezzato": 0, "supplemento": 0}
    total_work = total_nastro = total_cambi = 0
    for d in sel:
        dt = duties[d]
        by_type[dt.duty_type] = by_type.get(dt.duty_type, 0) + 1
        total_work += dt.work_min
        total_nastro += dt.nastro_min
        total_cambi += dt.cambi_count

    total_shifts = len(sel)
    n_suppl = by_type.get("supplemento", 0)
    total_drivers = total_shifts - n_suppl

    ca = compute_global_cost_breakdown(sel, duties, rates)

    summary = {
        "totalDriverShifts": total_drivers,
        "totalSupplementi": n_suppl,
        "totalShifts": total_shifts,
        "byType": by_type,
        "totalWorkHours": round(total_work / 60, 1),
        "avgWorkMin": round(total_work / max(total_shifts, 1)),
        "totalNastroHours": round(total_nastro / 60, 1),
        "avgNastroMin": round(total_nastro / max(total_shifts, 1)),
        "semiunicoPct": round(by_type["semiunico"] / max(total_drivers, 1) * 100, 1),
        "spezzatoPct": round(by_type["spezzato"] / max(total_drivers, 1) * 100, 1),
        "totalCambi": total_cambi,
        "companyCarsUsed": min(rates.company_cars, math.ceil(total_drivers / 10)),
        "totalDailyCost": ca["totalDailyCost"],
        "costBreakdown": ca["costBreakdown"],
        "efficiency": ca["efficiency"],
    }

    elapsed = time.time() - t0
    met["totalSolveTimeSec"] = round(elapsed, 1)

    log(f"[CSP] Done: {total_drivers} aut + {n_suppl} suppl, EUR{ca['totalDailyCost']:.2f}/d, "
        f"{total_cambi} cambi, {elapsed:.1f}s")
    report_progress("done", 100,
        f"Completato: {total_drivers} autisti, EUR{ca['totalDailyCost']:.0f}/giorno, {elapsed:.1f}s",
        {"drivers": total_drivers, "supplementi": n_suppl,
         "cost": ca["totalDailyCost"], "cambi": total_cambi})

    write_output({
        "status": status,
        "driverShifts": ds_out,
        "summary": summary,
        "metrics": met,
        "costAnalysis": ca,
        "clusters": [{"id": c.id, "name": c.name, "transferMin": c.transfer_from_depot_min}
                      for c in DEFAULT_CLUSTERS],
        "companyCars": rates.company_cars,
        "costRates": rates.to_dict(),
    })


def _empty_summary():
    return {
        "totalDriverShifts": 0, "totalSupplementi": 0, "totalShifts": 0,
        "byType": {"intero": 0, "semiunico": 0, "spezzato": 0, "supplemento": 0},
        "totalWorkHours": 0, "avgWorkMin": 0,
        "totalNastroHours": 0, "avgNastroMin": 0,
        "semiunicoPct": 0, "spezzatoPct": 0,
        "totalCambi": 0, "companyCarsUsed": 0,
        "totalDailyCost": 0, "costBreakdown": {}, "efficiency": {},
    }


if __name__ == "__main__":
    main()
