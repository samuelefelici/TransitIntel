"""Test per il motore di crew scheduling a CATENA (crew_engine_chain).

Copre: generazione pezzi, classificazione RD131 a riprese, copertura greedy,
conformità BDS (escluse pause pasto) e concatenazione con cambio bus (relief).
"""
from __future__ import annotations

import crew_engine_chain as ce
import crew_scheduler_v4 as v4
from optimizer_common import merge_config, parse_clusters_from_config

HUB = "Stazione FS"
OUTER = "Capolinea"


def _trip(tid, dep, arr, frm, to, vid="V0"):
    return {
        "type": "trip", "tripId": tid, "routeId": "R0", "routeName": "R0",
        "departureTime": f"{dep // 60:02d}:{dep % 60:02d}",
        "arrivalTime": f"{arr // 60:02d}:{arr % 60:02d}",
        "departureMin": dep, "arrivalMin": arr,
        "firstStopName": frm, "lastStopName": to,
        "stopCount": 8, "durationMin": arr - dep, "directionId": 0, "clusterStops": [],
    }


def _block(vid, start, n_round=3, half=20, layover_after=1):
    """n_round giri A/R dall'hub; una sosta di 16' (≥15) dopo il giro layover_after,
    7' altrimenti -> consente turni interi RD131-validi."""
    trips = []
    t = start
    for i in range(n_round):
        trips.append(_trip(f"{vid}_o{i}", t, t + half, HUB, OUTER))
        trips.append(_trip(f"{vid}_r{i}", t + half, t + 2 * half, OUTER, HUB))
        sosta = 16 if i == layover_after else 7
        t += 2 * half + sosta
    return {"vehicleId": vid, "vehicleType": "12m", "category": "urbano", "trips": trips}, t


def _setup(shifts):
    config = merge_config({"solverIntensity": 1})
    clusters = parse_clusters_from_config(config)
    bds = v4.BDSConfig.from_config(config)
    bds.pasto.attivo = False   # pause pasto escluse (come da esercizio)
    blocks = v4.parse_vehicle_blocks(shifts, clusters)
    return config, clusters, bds, blocks


# ----------------------------------------------------------------
# Pezzi
# ----------------------------------------------------------------
def test_build_pieces_splits_at_cluster_boundaries():
    blk, _ = _block("V0", 360, n_round=3)
    _, clusters, _, blocks = _setup([blk])
    pieces = ce.build_pieces(blocks, clusters)
    assert len(pieces) == 3                                  # un pezzo per giro
    assert all(p.last_cluster is not None for p in pieces)


# ----------------------------------------------------------------
# Classificazione RD131 (riprese, guida, sosta)
# ----------------------------------------------------------------
def test_classify_types():
    C = ce._classify
    # supplemento: corto, una ripresa
    assert C(120, 120, 60, 120, 0, 0, 1, False) == (True, "supplemento")
    # intero: una ripresa, guida ≤4h30, CON sosta ≥15
    assert C(420, 420, 200, 240, 0, 0, 6, True) == (True, "intero")
    # intero SENZA sosta ≥15 -> non valido come intero (ma corto -> supplemento)
    assert C(140, 140, 120, 140, 0, 0, 2, False) == (True, "supplemento")
    # semiunico: una interruzione 75-179'
    assert C(500, 380, 200, 240, 1, 120, 4, True) == (True, "semiunico")
    # spezzato: una interruzione ≥180'
    assert C(600, 360, 200, 240, 1, 240, 4, True) == (True, "spezzato")
    # guida continuativa > 4h30 -> infattibile
    assert C(400, 400, 300, 240, 0, 0, 5, True)[0] is False
    # guida per ripresa > 4h30 -> infattibile
    assert C(420, 420, 200, 300, 0, 0, 6, True)[0] is False
    # due interruzioni lunghe -> infattibile
    assert C(600, 300, 200, 200, 2, 120, 5, True)[0] is False


# ----------------------------------------------------------------
# Copertura greedy = partizione esatta
# ----------------------------------------------------------------
def test_greedy_cover_is_exact_partition():
    shifts = []
    for k in range(4):
        a, a_end = _block(f"A{k}", 360 + k * 20, n_round=3)
        b, _ = _block(f"B{k}", a_end + 7, n_round=3)
        shifts += [a, b]
    _, clusters, _, blocks = _setup(shifts)
    pieces = ce.build_pieces(blocks, clusters)
    chains = ce.greedy_chain_cover(pieces, clusters)
    covered = [i for ch in chains for i in ch]
    assert sorted(covered) == sorted(p.idx for p in pieces)
    assert len(set(covered)) == len(pieces)


# ----------------------------------------------------------------
# Conformità BDS (no pasto) + cambio bus cross-veicolo
# ----------------------------------------------------------------
def test_chain_duties_are_bds_conformant_and_use_relief():
    """Coppie A/B sullo stesso hub: A (3 giri) + cambio bus + B (3 giri) = un
    intero valido da ~240' di guida con sosta ≥15'. Il motore deve produrre turni
    CONFORMI (0 violazioni BDS, pasto escluso) e usare il cambio bus."""
    shifts = []
    for k in range(6):
        a, a_end = _block(f"A{k:02d}", 360 + (k % 3) * 20, n_round=3)
        b, _ = _block(f"B{k:02d}", a_end + 7, n_round=3)   # B riparte subito (relief)
        shifts += [a, b]
    config, clusters, bds, blocks = _setup(shifts)
    duties, an = ce.optimize_chain(blocks, config, 15, clusters, bds, max_company_cars=0)
    pieces = ce.build_pieces(blocks, clusters)

    # copertura esatta dei pezzi
    cov = [s.trips[j].trip_id for d in duties for s in d.segments for j in range(len(s.trips))]
    assert len(cov) == sum(len(p.trips) for p in pieces)

    # conformità RD131/BDS: nessuna violazione (pasto escluso)
    nviol = sum(len(v4.validate_duty_bds(d, bds, clusters).violations) for d in duties)
    assert nviol == 0, "i turni del motore a catena devono essere conformi RD131"

    # almeno un turno concatena due bus diversi (cambio/relief) tramite i cambi
    assert any(d.cambi for d in duties), "atteso almeno un cambio bus (relief)"


# ----------------------------------------------------------------
# Riprese: un turno ha al più 2 riprese (segmenti)
# ----------------------------------------------------------------
def test_duties_have_at_most_two_riprese():
    shifts = []
    for k in range(4):
        a, a_end = _block(f"A{k}", 360 + k * 25, n_round=3)
        b, _ = _block(f"B{k}", a_end + 90, n_round=3)   # gap 90' -> seconda ripresa
        shifts += [a, b]
    config, clusters, bds, blocks = _setup(shifts)
    duties, _ = ce.optimize_chain(blocks, config, 15, clusters, bds, max_company_cars=0)
    assert all(len(d.segments) <= 2 for d in duties)
