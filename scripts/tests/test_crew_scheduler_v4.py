"""Test di regressione per crew_scheduler_v4 (turni guida CP-SAT).

Copre i fix CSP-BUG1/BUG2/B1/B2/BUG4:
  - il cap vetture non strozza più i turni biripresa (modello fattibile);
  - i cap di tipologia sono soft (niente fallback greedy per infeasibility);
  - i cap restano rispettati quando è strutturalmente possibile;
  - helper warm-start e score-da-metriche.
"""
from __future__ import annotations

import crew_scheduler_v4 as cs
from optimizer_common import merge_config, parse_clusters_from_config


# ----------------------------------------------------------------
# Helpers per costruire input sintetici
# ----------------------------------------------------------------
def _trip(tid, route, dep, arr, frm, to):
    return {
        "type": "trip", "tripId": tid, "routeId": route, "routeName": route,
        "departureTime": f"{dep // 60:02d}:{dep % 60:02d}",
        "arrivalTime": f"{arr // 60:02d}:{arr % 60:02d}",
        "departureMin": dep, "arrivalMin": arr,
        "firstStopName": frm, "lastStopName": to,
        "stopCount": 10, "durationMin": arr - dep, "directionId": 0,
        "clusterStops": [],
    }


def _block(vid, route, start, end, leg=42, gap=6):
    trips, t, i = [], start, 0
    while t + leg <= end:
        frm, to = ("Stazione FS", "Tavernelle") if i % 2 == 0 else ("Tavernelle", "Stazione FS")
        trips.append(_trip(f"{vid}_t{i}", route, t, t + leg, frm, to))
        t += leg + gap
        i += 1
    return {"vehicleId": vid, "vehicleType": "12m", "category": "urbano", "trips": trips}


def _run_pipeline(shifts, time_limit=4, intensity=1):
    """Esegue parsing -> segmenti -> ottimizzazione multi-scenario.
    Ritorna (duties, analysis)."""
    config = merge_config({"solverIntensity": intensity})
    clusters = parse_clusters_from_config(config)
    bds = cs.BDSConfig.from_config(config)
    blocks = cs.parse_vehicle_blocks(shifts, clusters)
    for b in blocks:
        cs.analyze_vehicle_block(b, clusters, bds)
    cs.classify_blocks(blocks, clusters)
    cs.collassa_cambi(blocks)
    cs.filter_cuts_by_cluster(blocks, config)
    segments = cs.build_initial_segments(blocks, clusters)
    duties = cs.optimize_multi_scenario(blocks, segments, config, time_limit, clusters, bds)
    return duties, cs.LAST_OPTIMIZATION_ANALYSIS


def _biripresa_input(n=12):
    """N picchi mattina + N pomeriggio scaglionati: soluzione = N turni biripresa.
    Le interruzioni si sovrappongono a mezzogiorno -> stressa il cap vetture."""
    shifts = []
    for k in range(n):
        shifts.append(_block(f"M{k:02d}", f"R{k % 4}", start=390 + 6 * k, end=540 + 6 * k))
    for k in range(n):
        shifts.append(_block(f"A{k:02d}", f"R{k % 4}", start=750 + 6 * k, end=900 + 6 * k))
    return shifts


# ----------------------------------------------------------------
# BUG-1 + BUG-2: il modello CP-SAT è fattibile (niente fallback greedy)
# ----------------------------------------------------------------
def test_biripresa_feasible_not_greedy_fallback():
    """Prima dei fix: il cap vetture (interi intervalli interruzione) + cap %
    HARD rendevano OGNI scenario INFEASIBLE -> fallback greedy. Ora il CP-SAT
    deve trovare soluzioni fattibili."""
    duties, analysis = _run_pipeline(_biripresa_input(12))
    assert analysis["nFeasible"] > 0, "nessuno scenario fattibile (regressione BUG-1/BUG-2)"
    assert analysis["nInfeasible"] < analysis["nScenariosRun"], "tutti infeasible"
    # la soluzione copre tutti i segmenti come turni biripresa
    assert len(duties) == 12
    assert all(len(d.segments) == 2 for d in duties)


def test_company_car_cap_does_not_block_biripresa():
    """Con 12 biripresa e cap vetture=5, il modello resta fattibile perché ora
    contano solo i brevi trasferimenti, non l'intera interruzione."""
    duties, analysis = _run_pipeline(_biripresa_input(12))
    spezzati = sum(1 for d in duties if d.duty_type in ("spezzato", "semiunico"))
    assert spezzati >= 1
    assert cs.MAX_COMPANY_CARS == 5  # default invariato


# ----------------------------------------------------------------
# BUG-2: i cap di tipologia restano rispettati quando è possibile
# ----------------------------------------------------------------
def test_type_caps_respected_when_feasible():
    """Mix: 18 blocchi 'intero' (single) + 2 coppie picco -> 2 spezzati = 10%
    < cap 13%. Il solver deve restare conforme."""
    shifts = []
    for k in range(18):
        shifts.append(_block(f"I{k:02d}", f"R{k % 4}", start=360 + 4 * k, end=780 + 4 * k))
    for k in range(2):
        shifts.append(_block(f"M{k:02d}", f"R{k % 4}", start=390 + 6 * k, end=540 + 6 * k))
    for k in range(2):
        shifts.append(_block(f"A{k:02d}", f"R{k % 4}", start=750 + 6 * k, end=900 + 6 * k))
    duties, analysis = _run_pipeline(shifts)
    assert analysis["nFeasible"] > 0
    n_total = len(duties)
    n_spez = sum(1 for d in duties if d.duty_type == "spezzato")
    # 2 spezzati su ~20 turni: ampiamente entro il 13%
    assert n_spez / max(n_total, 1) <= 0.13 + 1e-9


# ----------------------------------------------------------------
# Helper puri
# ----------------------------------------------------------------
def test_decisions_from_duties_maps_pairs_and_singles():
    class _Seg:
        def __init__(self, idx):
            self.idx = idx

    class _Duty:
        def __init__(self, segs):
            self.segments = segs

    pair_keys = {(1, 2), (5, 7)}
    duties = [
        _Duty([_Seg(2), _Seg(1)]),   # pair (ordine invertito -> (1,2))
        _Duty([_Seg(5), _Seg(7)]),   # pair (5,7)
        _Duty([_Seg(9)]),            # single
        _Duty([_Seg(3), _Seg(4)]),   # coppia non ammissibile -> due single
    ]
    single_true, pair_true = cs._decisions_from_duties(duties, pair_keys)
    assert pair_true == {(1, 2), (5, 7)}
    assert single_true == {9, 3, 4}


def test_score_from_metrics_matches_components():
    cs.SCORE_PER_DUTY = 100.0
    m = {
        "duties": 10, "totalCost": 1000.0, "bdsViolations": 2,
        "invalidi": 1, "supplementi": 0, "semiPct": 0, "spezPct": 0,
    }
    # 1000 + 2*50 + 1*500 + 10*100 = 2600
    assert cs._score_from_metrics(m) == 2600.0

    # sforamento spezzati penalizzato
    m2 = dict(m, spezPct=20)  # 20% > 13% -> +(20-13)*10*2 = 140
    assert cs._score_from_metrics(m2) == 2740.0
