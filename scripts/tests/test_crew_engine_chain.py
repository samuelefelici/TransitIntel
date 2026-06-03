"""Test per il motore di crew scheduling a CATENA (crew_engine_chain).

Copre: generazione pezzi, classificazione RD131, copertura greedy, e la
riduzione del numero di turni grazie alla concatenazione con cambio bus
(relief) — la capacità che il modello single/pair di v4 non ha.
"""
from __future__ import annotations

import crew_engine_chain as ce
import crew_scheduler_v4 as v4
from optimizer_common import merge_config, parse_clusters_from_config

HUB = "Stazione FS"
OUTER = "Capolinea"


def _trip(tid, dep, arr, frm, to):
    return {
        "type": "trip", "tripId": tid, "routeId": "R0", "routeName": "R0",
        "departureTime": f"{dep // 60:02d}:{dep % 60:02d}",
        "arrivalTime": f"{arr // 60:02d}:{arr % 60:02d}",
        "departureMin": dep, "arrivalMin": arr,
        "firstStopName": frm, "lastStopName": to,
        "stopCount": 8, "durationMin": arr - dep, "directionId": 0, "clusterStops": [],
    }


def _block(vid, start, n_round=4, half=22, sosta=6):
    trips = []
    t = start
    for i in range(n_round):
        trips.append(_trip(f"{vid}_o{i}", t, t + half, HUB, OUTER))
        trips.append(_trip(f"{vid}_r{i}", t + half, t + 2 * half, OUTER, HUB))
        t += 2 * half + sosta
    return {"vehicleId": vid, "vehicleType": "12m", "category": "urbano", "trips": trips}, t


def _setup(shifts):
    config = merge_config({"solverIntensity": 1})
    clusters = parse_clusters_from_config(config)
    bds = v4.BDSConfig.from_config(config)
    blocks = v4.parse_vehicle_blocks(shifts, clusters)
    return config, clusters, bds, blocks


# ----------------------------------------------------------------
# Pezzi
# ----------------------------------------------------------------
def test_build_pieces_splits_at_cluster_boundaries():
    blk, _ = _block("V0", 360, n_round=4)
    _, clusters, _, blocks = _setup([blk])
    pieces = ce.build_pieces(blocks, clusters)
    # ogni giro A/R termina all'hub (cluster) -> 4 pezzi (uno per giro)
    assert len(pieces) == 4
    assert all(p.last_cluster is not None for p in pieces)


# ----------------------------------------------------------------
# Classificazione RD131
# ----------------------------------------------------------------
def test_classify_types():
    # supplemento: singolo pezzo corto
    assert ce._classify(nastro=120, work=120, maxrun=60, n_long=0, long_gap=0, n_pieces=1) == (True, "supplemento")
    # intero: nessuna interruzione lunga, entro 7h15
    assert ce._classify(nastro=420, work=420, maxrun=200, n_long=0, long_gap=0, n_pieces=6) == (True, "intero")
    # semiunico: una interruzione 75-179'
    assert ce._classify(nastro=500, work=380, maxrun=200, n_long=1, long_gap=120, n_pieces=4) == (True, "semiunico")
    # spezzato: una interruzione ≥180'
    assert ce._classify(nastro=600, work=360, maxrun=200, n_long=1, long_gap=240, n_pieces=4) == (True, "spezzato")
    # infattibile: guida continua > 4h30
    ok, _ = ce._classify(nastro=400, work=400, maxrun=300, n_long=0, long_gap=0, n_pieces=5)
    assert ok is False
    # infattibile: due interruzioni lunghe
    ok, _ = ce._classify(nastro=600, work=300, maxrun=200, n_long=2, long_gap=120, n_pieces=5)
    assert ok is False


# ----------------------------------------------------------------
# Copertura greedy + esattezza
# ----------------------------------------------------------------
def test_greedy_cover_is_exact_partition():
    shifts = []
    for k in range(4):
        a, a_end = _block(f"A{k}", 360 + k * 20, n_round=4)
        b, _ = _block(f"B{k}", a_end + 14, n_round=4)
        shifts += [a, b]
    _, clusters, _, blocks = _setup(shifts)
    pieces = ce.build_pieces(blocks, clusters)
    chains = ce.greedy_chain_cover(pieces, clusters)
    covered = [i for ch in chains for i in ch]
    assert sorted(covered) == sorted(p.idx for p in pieces)   # partizione esatta
    assert len(set(covered)) == len(pieces)                   # nessun doppione


# ----------------------------------------------------------------
# Riduzione turni + cambio bus cross-veicolo
# ----------------------------------------------------------------
def test_chain_reduces_duties_with_cross_vehicle_relief():
    """12 coppie di blocchi corti appaiabili via cambio all'hub: il motore a
    catena deve usare <= dei pezzi/2 turni e concatenare bus diversi."""
    shifts = []
    for k in range(6):
        a, a_end = _block(f"A{k:02d}", 360 + (k % 3) * 20, n_round=4)
        b, _ = _block(f"B{k:02d}", a_end + 14, n_round=4)
        shifts += [a, b]
    config, clusters, bds, blocks = _setup(shifts)
    duties, an = ce.optimize_chain(blocks, config, 15, clusters, bds, max_company_cars=0)
    pieces = ce.build_pieces(blocks, clusters)
    # copertura esatta
    cov = [s.idx for d in duties for s in d.segments]
    assert sorted(cov) == sorted(p.idx for p in pieces)
    # 12 blocchi -> molto meno di 12 turni (concatenazione a coppie)
    assert len(duties) <= 8
    # almeno un turno concatena bus diversi (relief)
    assert any(len(set(s.vehicle_id for s in d.segments)) > 1 for d in duties)
