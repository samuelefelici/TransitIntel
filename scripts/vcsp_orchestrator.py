"""
VCSP Orchestrator — ottimizzazione INTEGRATA turni macchina + turni guida.

Realizza l'approccio "iterativo con feedback" del modello VCSP:

    min  c_v·Σ_b y_b  +  Σ_d c_d·x_d     (mezzi + guida)

senza riscrivere un monolite: i due motori esistenti girano in loop nello
stesso processo. A ogni round:

  1. VSP  (vehicle_scheduler_cpsat.run)  → blocchi veicolo
  2. CSP  (crew_scheduler_v4.run)        → turni guida BDS sui blocchi
  3. costi-ombra: per ogni blocco si misura l'extra-costo guida che impone
     (costo turni per ora di servizio oltre la mediana, violazioni BDS,
     supplementi) e lo si trasforma in PENALITÀ sugli archi (pairing di corse)
     che hanno formato quel blocco
  4. il VSP del round successivo ri-ottimizza con quelle penalità → evita i
     pairing "mal tagliabili" e favorisce blocchi sezionabili in turni legali.

Si ferma dopo N round o quando il costo totale (mezzi+guida) non migliora.
Output: il MIGLIOR round in formato vehicle-scheduler (il backend lo
post-processa come un normale run CP-SAT) + la sezione `vcsp` con i KPI di
tutti i round e il risultato guida del best round.

Input (stdin JSON):
  {
    "vsp":  { trips, config, routeDetails, psClusters, depots?, deadheadKm? },
    "crew": { config },                  # config crew_scheduler_v4 (bds, clusters…)
    "vcsp": { rounds?: 3, crewTimeLimit?: 90 },
    "tripClusterStops": { tripId: [ClusterStop…] }   # relief points per corsa
  }
"""
from __future__ import annotations

import time
from collections import defaultdict

import vehicle_scheduler_cpsat as vsp_engine
import crew_scheduler_v4 as csp_engine
from optimizer_common import load_input, write_output, log, report_progress

# ── Parametri del feedback (costi-ombra) ────────────────────────────────
EXCESS_WEIGHT = 0.5          # quota dell'extra-costo guida trasferita in penalità
VIOLATION_PENALTY_EUR = 40.0  # per violazione BDS che tocca il blocco
SUPPLEMENTO_PENALTY_EUR = 25.0  # per turno "supplemento" che tocca il blocco
MAX_BLOCK_PENALTY_EUR = 400.0
MAX_ROUNDS = 10


def _crew_cost_by_vehicle(crew_out: dict) -> tuple[dict, dict, dict]:
    """Ripartisce costo/violazioni/supplementi dei turni guida sui blocchi veicolo."""
    cost = defaultdict(float)
    violations = defaultdict(int)
    supplementi = defaultdict(int)
    for duty in crew_out.get("driverShifts", []):
        # minuti di lavoro del duty su ciascun veicolo (dalle corse delle riprese)
        wbyv: dict[str, float] = defaultdict(float)
        for rip in duty.get("riprese", []):
            for tr in rip.get("trips", []):
                vid = tr.get("vehicleId")
                if not vid:
                    continue
                dur = max(0, (tr.get("arrivalMin") or 0) - (tr.get("departureMin") or 0))
                wbyv[vid] += dur
        total_w = sum(wbyv.values())
        if total_w <= 0:
            continue
        duty_cost = float(duty.get("costEuro") or 0)
        bv = duty.get("bdsValidation") or {}
        viol = len(bv.get("violations") or []) if isinstance(bv, dict) else 0
        if isinstance(bv, dict) and not bv.get("violations") and bv.get("valid") is False:
            viol = 1
        is_suppl = duty.get("type") == "supplemento"
        for vid, w in wbyv.items():
            share = w / total_w
            cost[vid] += duty_cost * share
            if viol:
                violations[vid] += viol
            if is_suppl:
                supplementi[vid] += 1
    return cost, violations, supplementi


def extract_arc_penalties(vsp_out: dict, crew_out: dict) -> tuple[dict[str, float], dict]:
    """Costi-ombra: penalità EUR sugli archi (tripIdA|tripIdB) dei blocchi costosi."""
    shifts = vsp_out.get("vehicleShifts", [])
    cost_v, viol_v, suppl_v = _crew_cost_by_vehicle(crew_out)

    # tasso costo-guida per ora di servizio, per blocco
    rates: dict[str, float] = {}
    service_h: dict[str, float] = {}
    for s in shifts:
        vid = s.get("vehicleId")
        h = max(0.25, (s.get("totalServiceMin") or 0) / 60.0)
        service_h[vid] = h
        rates[vid] = cost_v.get(vid, 0.0) / h
    positive = sorted(r for r in rates.values() if r > 0)
    median_rate = positive[len(positive) // 2] if positive else 0.0

    penalties: dict[str, float] = {}
    per_block: list[dict] = []
    for s in shifts:
        vid = s.get("vehicleId")
        excess = max(0.0, (rates.get(vid, 0.0) - median_rate) * service_h.get(vid, 0.0))
        pen = (EXCESS_WEIGHT * excess
               + VIOLATION_PENALTY_EUR * viol_v.get(vid, 0)
               + SUPPLEMENTO_PENALTY_EUR * suppl_v.get(vid, 0))
        pen = min(MAX_BLOCK_PENALTY_EUR, pen)
        trip_ids = [t.get("tripId") for t in s.get("trips", []) if t.get("type") == "trip"]
        pairs = [(trip_ids[k], trip_ids[k + 1]) for k in range(len(trip_ids) - 1)]
        if pen > 1.0 and pairs:
            per_arc = pen / len(pairs)
            for a, b in pairs:
                key = f"{a}|{b}"
                penalties[key] = penalties.get(key, 0.0) + per_arc
        per_block.append({
            "vehicleId": vid,
            "crewCostEur": round(cost_v.get(vid, 0.0), 2),
            "crewCostPerServiceHour": round(rates.get(vid, 0.0), 2),
            "violations": viol_v.get(vid, 0),
            "supplementi": suppl_v.get(vid, 0),
            "penaltyEur": round(pen, 2),
        })
    diag = {
        "medianCrewRatePerHour": round(median_rate, 2),
        "blocksPenalized": sum(1 for b in per_block if b["penaltyEur"] > 1.0),
        "arcsPenalized": len(penalties),
        "perBlock": sorted(per_block, key=lambda b: -b["penaltyEur"])[:20],
    }
    return penalties, diag


def _round_kpi(r: int, vsp_out: dict, crew_out: dict) -> dict:
    vm = vsp_out.get("metrics", {}) or {}
    cs = crew_out.get("summary", {}) or {}
    vehicle_cost = float(vm.get("costEur") or 0)
    crew_cost = float(cs.get("totalDailyCost") or 0)
    validation = cs.get("validation", {}) or {}
    return {
        "round": r,
        "vehicles": vm.get("vehicles", 0),
        "vehicleCostEur": round(vehicle_cost, 2),
        "duties": cs.get("totalShifts", 0),
        "supplementi": cs.get("totalSupplementi", 0),
        "crewCostEur": round(crew_cost, 2),
        "bdsViolations": validation.get("totalViolations", 0),
        "totalCostEur": round(vehicle_cost + crew_cost, 2),
    }


def main() -> None:
    t0 = time.time()
    data = load_input()
    vsp_payload = data.get("vsp") or {}
    crew_config = (data.get("crew") or {}).get("config") or {}
    vcsp_cfg = data.get("vcsp") or {}
    trip_cluster_stops = data.get("tripClusterStops") or {}

    rounds = max(1, min(MAX_ROUNDS, int(vcsp_cfg.get("rounds") or 3)))
    crew_tl = max(20, min(600, int(vcsp_cfg.get("crewTimeLimit") or 90)))

    log(f"=== VCSP Orchestrator === rounds≤{rounds}, crewTimeLimit={crew_tl}s, "
        f"trips={len(vsp_payload.get('trips') or [])}, "
        f"reliefTrips={len(trip_cluster_stops)}")

    arc_penalties: dict[str, float] = {}
    rounds_kpi: list[dict] = []
    feedback_diag: list[dict] = []
    round_results: list[dict] = []               # per-round: shifts TM + crew (scelta operatore)
    best: tuple[dict, dict, int] | None = None   # (vsp_out, crew_out, round)

    for r in range(1, rounds + 1):
        base_pct = int((r - 1) / rounds * 100)
        report_progress("VCSP", base_pct + 2, f"Round {r}/{rounds}: turni macchina (VSP)…")
        vsp_in = dict(vsp_payload)
        if arc_penalties:
            vsp_in["arcPenalties"] = arc_penalties
        vsp_out = vsp_engine.run(vsp_in)
        shifts = vsp_out.get("vehicleShifts", [])
        if not shifts:
            log(f"[VCSP] round {r}: VSP senza turni, stop")
            break

        # Relief points (cluster) sulle corse — precomputati dal backend
        if trip_cluster_stops:
            for s in shifts:
                for t in s.get("trips", []):
                    if t.get("type") == "trip":
                        cs_list = trip_cluster_stops.get(t.get("tripId"))
                        if cs_list:
                            t["clusterStops"] = cs_list

        report_progress("VCSP", base_pct + int(100 / rounds * 0.45),
                        f"Round {r}/{rounds}: turni guida (CSP, {len(shifts)} blocchi)…")
        crew_out = csp_engine.run({"vehicleShifts": shifts, "config": crew_config}, crew_tl)

        kpi = _round_kpi(r, vsp_out, crew_out)
        rounds_kpi.append(kpi)
        log(f"[VCSP] round {r}: {kpi['vehicles']} veicoli (€{kpi['vehicleCostEur']}) + "
            f"{kpi['duties']} turni guida (€{kpi['crewCostEur']}, "
            f"{kpi['bdsViolations']} violazioni) = €{kpi['totalCostEur']}")
        report_progress("VCSP", base_pct + int(100 / rounds * 0.9),
                        f"Round {r}/{rounds}: €{kpi['totalCostEur']} totale "
                        f"({kpi['vehicles']} mezzi + {kpi['duties']} turni)")

        # Risultato completo del round: l'operatore potrà scegliere QUESTO
        # scenario dalla tabella round anche se non è il migliore per costo.
        round_results.append({
            "round": r,
            "vehicleShifts": vsp_out.get("vehicleShifts", []),
            "crew": {
                "summary": crew_out.get("summary"),
                # metrics include il check del vincolo RIGIDO autovetture
                # (companyCarsCap / MaxSimultaneous / HardViolation) per round
                "metrics": crew_out.get("metrics"),
                "driverShifts": crew_out.get("driverShifts"),
                "handovers": crew_out.get("handovers"),
                "clusters": crew_out.get("clusters"),
            },
        })

        if best is None or kpi["totalCostEur"] < _round_kpi(best[2], best[0], best[1])["totalCostEur"]:
            best = (vsp_out, crew_out, r)

        if r < rounds:
            # early-stop: nessun miglioramento rispetto al round precedente
            if len(rounds_kpi) >= 2 and rounds_kpi[-1]["totalCostEur"] >= rounds_kpi[-2]["totalCostEur"] - 0.01:
                log(f"[VCSP] round {r}: nessun miglioramento, early-stop")
                break
            arc_penalties, diag = extract_arc_penalties(vsp_out, crew_out)
            diag["afterRound"] = r
            feedback_diag.append(diag)
            log(f"[VCSP] feedback: {diag['blocksPenalized']} blocchi penalizzati "
                f"→ {diag['arcsPenalized']} archi (mediana €{diag['medianCrewRatePerHour']}/h)")

    if best is None:
        write_output({"vehicleShifts": [], "metrics": {"status": "NO_INPUT"},
                      "vcsp": {"rounds": rounds_kpi, "bestRound": None}})
        return

    best_vsp, best_crew, best_r = best
    elapsed = time.time() - t0
    log(f"=== VCSP DONE in {elapsed:.0f}s — best round {best_r}/{len(rounds_kpi)}: "
        f"€{rounds_kpi[best_r - 1]['totalCostEur']} totale ===")
    report_progress("VCSP", 100, f"Best: round {best_r} · €{rounds_kpi[best_r - 1]['totalCostEur']}")

    # Output = miglior VSP (formato standard, post-processabile dal backend
    # come un run CP-SAT) + sezione vcsp con round, feedback e risultato guida.
    output = dict(best_vsp)
    output["vcsp"] = {
        "rounds": rounds_kpi,
        "bestRound": best_r,
        "roundsExecuted": len(rounds_kpi),
        "elapsedSec": round(elapsed, 1),
        "feedback": feedback_diag,
        "crew": {
            "summary": best_crew.get("summary"),
            "metrics": best_crew.get("metrics"),
            "driverShifts": best_crew.get("driverShifts"),
            "handovers": best_crew.get("handovers"),
            "clusters": best_crew.get("clusters"),
        },
        # Risultati COMPLETI per round (TM + TG): la tabella round diventa una
        # scelta di scenario, non solo un resoconto.
        "roundResults": round_results,
    }
    write_output(output)


if __name__ == "__main__":
    main()
