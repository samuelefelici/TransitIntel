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
from vcsp_probe import run_probe_phase

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


# Regole RIGIDE che si rompono nei giunti fra un pezzo di guida e l'altro:
# il tetto delle autovetture aziendali e il bus lasciato senza conducente.
# Non sono violazioni BDS di un turno — sono esiti del parco auto — quindi nel
# costo-ombra per blocco pesavano ZERO: il VSP non sapeva nemmeno che
# esistessero, e nessun numero di round poteva sistemarle.
UNATTENDED_PENALTY_EUR = 300.0
CAR_CAP_PENALTY_EUR = 400.0


def _block_joints(vsp_out: dict) -> dict[str, list[tuple[int, str, str]]]:
    """Per ogni blocco, i giunti fra corse consecutive: (minuto, tripA, tripB).

    Il minuto del giunto e' l'arrivo della corsa precedente: e' li' che il
    conducente smonta e il bus resta fermo in attesa del montante.
    """
    out: dict[str, list[tuple[int, str, str]]] = {}
    for s in vsp_out.get("vehicleShifts", []):
        corse = [t for t in s.get("trips", []) if t.get("type") == "trip"]
        giunti = []
        for k in range(len(corse) - 1):
            giunti.append((int(corse[k].get("arrivalMin") or 0),
                           corse[k].get("tripId"), corse[k + 1].get("tripId")))
        out[s.get("vehicleId")] = giunti
    return out


def handover_arc_penalties(vsp_out: dict, crew_out: dict) -> tuple[dict[str, float], dict]:
    """Penalita' MIRATE sui giunti dove il cambio guida rompe una regola rigida.

    Il costo-ombra per blocco dice al VSP «questo blocco costa troppo» e spalma
    la penalita' su tutti i suoi archi. Qui invece si punta il dito sul singolo
    giunto: e' quello che va sciolto, e spesso basta spostare UNA corsa fra due
    turni macchina perche' il cambio non serva piu'.
    """
    summary = crew_out.get("summary") or {}
    hm = summary.get("handoverModes") or {}
    limite = int(hm.get("unattendedLimitMin") or 15)
    tetto = int(summary.get("companyCarsCap") or 0)
    picco = int(summary.get("companyCarsMaxSimultaneous") or 0)
    conflitti = int(summary.get("companyCarsConflicts") or 0)
    eccedenza = max(0, picco - tetto) if tetto > 0 else 0
    auto_rotte = conflitti + eccedenza

    giunti = _block_joints(vsp_out)
    handovers = [h for h in (crew_out.get("handovers") or [])
                 if isinstance(h, dict) and h.get("kind", "inline") == "inline"]

    def arco_del_giunto(vid: str, at_min: int) -> str | None:
        lista = giunti.get(vid) or []
        if not lista:
            return None
        # il giunto piu' vicino nel tempo al momento del cambio
        m, a, b = min(lista, key=lambda g: abs(g[0] - at_min))
        return f"{a}|{b}" if a and b else None

    penalties: dict[str, float] = {}
    n_incustodito = n_auto = 0

    for h in handovers:
        vid, at_min = h.get("vehicleId"), int(h.get("atMin") or 0)
        chiave = arco_del_giunto(vid, at_min) if vid else None
        if not chiave:
            continue
        if int(h.get("unattendedMin") or 0) > limite:
            penalties[chiave] = penalties.get(chiave, 0.0) + UNATTENDED_PENALTY_EUR
            n_incustodito += 1

    if auto_rotte > 0:
        # I cambi che consumano un'auto sono quelli che affollano il parco:
        # la penalita' del tetto sforato si divide fra loro.
        con_auto = [h for h in handovers
                    if h.get("incomingMode") == "car" or h.get("outgoingMode") == "car"]
        if con_auto:
            quota = (CAR_CAP_PENALTY_EUR * auto_rotte) / len(con_auto)
            for h in con_auto:
                vid, at_min = h.get("vehicleId"), int(h.get("atMin") or 0)
                chiave = arco_del_giunto(vid, at_min) if vid else None
                if chiave:
                    penalties[chiave] = penalties.get(chiave, 0.0) + quota
                    n_auto += 1

    diag = {
        "giuntiIncustoditi": n_incustodito,
        "giuntiConAuto": n_auto,
        "autoRotte": auto_rotte,
        "eccedenzaPicco": eccedenza,
        "conflittiAuto": conflitti,
    }
    return penalties, diag


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
    # Ai costi-ombra per blocco si somma il puntamento sui giunti che rompono
    # una regola rigida: senza, il VSP vedeva solo «blocco caro» e non «questo
    # cambio non ha un'auto» o «qui il bus resta solo un'ora e mezza».
    giunti_pen, giunti_diag = handover_arc_penalties(vsp_out, crew_out)
    for k, v in giunti_pen.items():
        penalties[k] = penalties.get(k, 0.0) + v

    diag = {
        "medianCrewRatePerHour": round(median_rate, 2),
        "blocksPenalized": sum(1 for b in per_block if b["penaltyEur"] > 1.0),
        "arcsPenalized": len(penalties),
        "giunti": giunti_diag,
        "perBlock": sorted(per_block, key=lambda b: -b["penaltyEur"])[:20],
    }
    return penalties, diag


# Costi-ombra della SELEZIONE fra round (e fra soluzioni della sonda).
# Il solo totalCostEur sceglieva male: nella prova reale un round con 2 turni
# in meno e 6 violazioni in meno è stato scartato per €1,76 di costo in più —
# e l'early-stop lo ha pure letto come "nessun miglioramento". Ogni turno vale
# un costo nascosto (reperibilità, HR, ferie — come SCORE_PER_DUTY nel CSP) e
# ogni violazione BDS un costo di sistemazione manuale. Override da
# vcsp.dutyShadowEur / vcsp.violationShadowEur.
DUTY_SHADOW_EUR = 200.0
VIOLATION_SHADOW_EUR = 100.0

# Round consecutivi senza miglioramento prima di fermarsi.
EARLY_STOP_PATIENCE = 2


def _round_kpi(r: int, vsp_out: dict, crew_out: dict) -> dict:
    vm = vsp_out.get("metrics", {}) or {}
    cs = crew_out.get("summary", {}) or {}
    vehicle_cost = float(vm.get("costEur") or 0)
    crew_cost = float(cs.get("totalDailyCost") or 0)
    validation = cs.get("validation", {}) or {}
    duties = cs.get("totalShifts", 0)
    violations = validation.get("totalViolations", 0)
    # Tetto auto aziendali (inviolabile): ogni trasferimento senza auto o
    # l'eccedenza del picco contano come violazioni nella selezione.
    car_conflicts = int(cs.get("companyCarsConflicts") or 0)
    car_cap = int(cs.get("companyCarsCap") or 0)
    car_peak = int(cs.get("companyCarsMaxSimultaneous") or 0)
    car_violations = car_conflicts + (max(0, car_peak - car_cap) if car_cap > 0 else 0)
    # Bus lasciato senza conducente oltre il limite: regola rigida che non
    # compariva ne' fra le violazioni BDS del turno ne' nella selezione, quindi
    # un round che la sistemava poteva perdere per pochi euro.
    hm = cs.get("handoverModes") or {}
    unattended_over = len(hm.get("overLimit") or [])
    violations = int(violations or 0) + car_violations + unattended_over
    total = vehicle_cost + crew_cost
    return {
        "round": r,
        "vehicles": vm.get("vehicles", 0),
        "vehicleCostEur": round(vehicle_cost, 2),
        "duties": duties,
        "supplementi": cs.get("totalSupplementi", 0),
        "crewCostEur": round(crew_cost, 2),
        "bdsViolations": violations,
        "companyCarsConflicts": car_conflicts,
        "companyCarsPeak": car_peak,
        "unattendedOverLimit": unattended_over,
        "totalCostEur": round(total, 2),
        "selectionScoreEur": round(
            total
            + float(duties or 0) * DUTY_SHADOW_EUR
            + float(violations or 0) * VIOLATION_SHADOW_EUR, 2),
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
    # Sonda di spostamento (cervello passo 2): quante prove di re-solve dopo la
    # convergenza (0 = disattivata) e budget VSP per ciascuna prova.
    probes_raw = vcsp_cfg.get("probes")
    probes = max(0, min(10, int(probes_raw))) if probes_raw is not None else 4
    probe_vsp_time = max(20, min(300, int(vcsp_cfg.get("probeVspTime") or 60)))
    # Disturbo all'orario (€ per corsa·minuto spostato) e portata dei candidati
    # guidati dai turni: "trip" = ritocco alla corsa di confine (default),
    # "line" = linea intera. Vedi vcsp_probe.run_probe_phase.
    try:
        shift_penalty_eur = max(0.0, float(vcsp_cfg.get("shiftPenaltyEur", 1.0)))
    except (TypeError, ValueError):
        shift_penalty_eur = 1.0
    crew_shift_scope = str(vcsp_cfg.get("crewShiftScope") or "trip").strip().lower()
    if crew_shift_scope not in ("trip", "line"):
        crew_shift_scope = "trip"

    # Costi-ombra della selezione (vedi commento su DUTY_SHADOW_EUR)
    global DUTY_SHADOW_EUR, VIOLATION_SHADOW_EUR
    try:
        DUTY_SHADOW_EUR = max(0.0, float(vcsp_cfg.get("dutyShadowEur", DUTY_SHADOW_EUR)))
    except (ValueError, TypeError):
        pass
    try:
        VIOLATION_SHADOW_EUR = max(0.0, float(vcsp_cfg.get("violationShadowEur", VIOLATION_SHADOW_EUR)))
    except (ValueError, TypeError):
        pass

    log(f"=== VCSP Orchestrator === rounds≤{rounds}, crewTimeLimit={crew_tl}s, "
        f"probes={probes} (scope {crew_shift_scope}, disturbo €{shift_penalty_eur}/corsa·min), "
        f"trips={len(vsp_payload.get('trips') or [])}, "
        f"reliefTrips={len(trip_cluster_stops)}")

    arc_penalties: dict[str, float] = {}
    penalties_by_round: dict[int, dict[str, float]] = {}   # penalità USATE nel round r
    rounds_kpi: list[dict] = []
    no_gain = 0
    feedback_diag: list[dict] = []
    round_results: list[dict] = []               # per-round: shifts TM + crew (scelta operatore)
    best: tuple[dict, dict, int] | None = None   # (vsp_out, crew_out, round)

    for r in range(1, rounds + 1):
        base_pct = int((r - 1) / rounds * 100)
        report_progress("VCSP", base_pct + 2, f"Round {r}/{rounds}: turni macchina (VSP)…")
        vsp_in = dict(vsp_payload)
        penalties_by_round[r] = dict(arc_penalties)
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
            f"{kpi['bdsViolations']} violazioni) = €{kpi['totalCostEur']} "
            f"· score €{kpi['selectionScoreEur']}")
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

        # Selezione e early-stop sul PUNTEGGIO (costo + ombre turni/violazioni),
        # non sul costo secco: un round con meno turni e meno violazioni deve
        # vincere anche se costa qualche euro in più.
        if best is None or kpi["selectionScoreEur"] < _round_kpi(best[2], best[0], best[1])["selectionScoreEur"]:
            best = (vsp_out, crew_out, r)

        if r < rounds:
            # Early-stop con PAZIENZA: il feedback puo' peggiorare un round
            # prima di trovare la strada — soprattutto ora che punta il dito su
            # giunti precisi, e sciogliere un giunto costa prima di rendere.
            # Fermarsi al primo passo falso (com'era) buttava via il round che
            # sarebbe venuto dopo.
            if len(rounds_kpi) >= 2 and rounds_kpi[-1]["selectionScoreEur"] >= rounds_kpi[-2]["selectionScoreEur"] - 0.01:
                no_gain += 1
                if no_gain >= EARLY_STOP_PATIENCE:
                    log(f"[VCSP] round {r}: {no_gain} round senza miglioramento, early-stop")
                    break
                log(f"[VCSP] round {r}: nessun miglioramento ({no_gain}/{EARLY_STOP_PATIENCE}), continuo")
            else:
                no_gain = 0
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

    # ── SONDA DI SPOSTAMENTO (cervello passo 2) ──
    # A convergenza raggiunta: cerca spostamenti di singole corse entro la
    # flessibilità ±flexMin dichiarata in Planning che fondono blocchi veicolo,
    # verificandoli con re-solve VSP(+CSP). Il confronto usa le STESSE penalità
    # d'arco del best round, così i costi sono commensurabili.
    probe_section: dict | None = None
    if probes > 0:
        report_progress("VCSP", 92, f"Sonda di spostamento: fino a {probes} prove…")
        best_kpi = _round_kpi(best_r, best_vsp, best_crew)
        probe_res = run_probe_phase(
            vsp_payload, best_vsp, best_crew, best_kpi,
            vsp_run=vsp_engine.run, csp_run=csp_engine.run,
            crew_config=crew_config, crew_time_limit=crew_tl,
            kpi_fn=lambda v, c: _round_kpi(0, v, c),
            arc_penalties=penalties_by_round.get(best_r) or None,
            trip_cluster_stops=trip_cluster_stops or None,
            max_probes=probes, probe_vsp_time=probe_vsp_time,
            progress=lambda msg: report_progress("VCSP", 94, msg),
            shift_penalty_eur=shift_penalty_eur, crew_scope=crew_shift_scope,
        )
        probe_section = probe_res["probe"]
        if probe_section.get("accepted"):
            # Lo scenario sonda diventa un round aggiuntivo selezionabile e
            # salvabile come gli altri; è per costruzione il nuovo best.
            best_vsp, best_crew = probe_res["vsp"], probe_res["crew"]
            best_r = len(rounds_kpi) + 1
            kpi = dict(probe_res["kpi"])
            kpi["round"] = best_r
            kpi["probe"] = True
            rounds_kpi.append(kpi)
            round_results.append({
                "round": best_r,
                "probe": True,
                "vehicleShifts": best_vsp.get("vehicleShifts", []),
                "crew": {
                    "summary": best_crew.get("summary"),
                    "metrics": best_crew.get("metrics"),
                    "driverShifts": best_crew.get("driverShifts"),
                    "handovers": best_crew.get("handovers"),
                    "clusters": best_crew.get("clusters"),
                },
            })

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
    if probe_section is not None:
        # Sonda: proposte di spostamento (timeShifts) + diagnostica. Gli orari
        # dello scenario sonda ASSUMONO questi spostamenti: l'operatore li
        # applica in Planning dalla fucina con un click.
        output["vcsp"]["probe"] = probe_section
    write_output(output)


if __name__ == "__main__":
    main()
