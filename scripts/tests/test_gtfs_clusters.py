"""Test per gtfs_clusters.py — generazione clusterStops dal GTFS e indice di
connettività in linea cluster→cluster.

Gli unit test usano dati sintetici. Un test d'integrazione gira sul feed GTFS reale
(attached_assets) se presente, altrimenti viene saltato.
"""

import os

import pytest

from optimizer_common import ClusterStop
from gtfs_clusters import (
    JESI_CLUSTERS, hms_to_min, stop_to_cluster_map,
    build_cluster_passages, attach_cluster_stops_to_shifts,
    InServiceIndex, build_inservice_index,
)


# ── helpers ──────────────────────────────────────────────────────

def cs(cluster, seq, arr, dep=None):
    return ClusterStop(stop_id=f"s{seq}", stop_name=cluster, stop_sequence=seq,
                       cluster_id=cluster, arrival_min=arr, departure_min=dep if dep is not None else arr)


# ── parsing orari ────────────────────────────────────────────────

def test_hms_to_min_base_e_oltre_mezzanotte():
    assert hms_to_min("07:36:00") == 7 * 60 + 36
    assert hms_to_min("25:10:00") == 25 * 60 + 10      # servizio notturno GTFS
    assert hms_to_min("") == 0


def test_stop_to_cluster_map():
    m = stop_to_cluster_map(JESI_CLUSTERS)
    assert m["21178"] == "arco_clementino"
    assert m["CI003"] == "portavalle"
    assert m["20420"] == "stazione_jesi"


# ── indice di connettività in linea ──────────────────────────────

def test_indice_collega_cluster_diversi_sulla_stessa_corsa():
    """Una corsa che passa A(part.731) poi B(arr.736): arco A→B salita 731 discesa 736."""
    idx = InServiceIndex()
    idx.add_trip([cs("arco_clementino", 15, 730, 731), cs("stazione_jesi", 19, 736, 737)], "T1", "V1")
    idx.finalize()
    e = idx.connect("arco_clementino", "stazione_jesi", ready_min=728, window=30)
    assert e is not None and e.board_min == 731 and e.alight_min == 736 and e.trip_id == "T1"


def test_indice_nessun_arco_per_stesso_cluster():
    idx = InServiceIndex()
    idx.add_trip([cs("arco_clementino", 1, 700, 701), cs("arco_clementino", 5, 710, 711)], "T1")
    idx.finalize()
    assert idx.connect("arco_clementino", "arco_clementino", 700, 30) is None
    assert idx.edges == {}


def test_indice_rispetta_finestra_e_ordine():
    idx = InServiceIndex()
    idx.add_trip([cs("portavalle", 1, 800, 800), cs("stazione_jesi", 4, 810, 811)], "T1")
    idx.finalize()
    # pronto alle 805: il bus è già partito (800 < 805) → nessun arco utile
    assert idx.connect("portavalle", "stazione_jesi", ready_min=805, window=30) is None
    # pronto alle 795: attesa 5' ≤ 30 → ok
    assert idx.connect("portavalle", "stazione_jesi", ready_min=795, window=30).board_min == 800
    # pronto alle 760: attesa 40' > 30 → fuori finestra
    assert idx.connect("portavalle", "stazione_jesi", ready_min=760, window=30) is None


def test_indice_sceglie_il_primo_bus_utile():
    idx = InServiceIndex()
    idx.add_trip([cs("portavalle", 1, 900, 900), cs("stazione_jesi", 2, 905, 905)], "tardi")
    idx.add_trip([cs("portavalle", 1, 840, 840), cs("stazione_jesi", 2, 845, 845)], "presto")
    idx.finalize()
    e = idx.connect("portavalle", "stazione_jesi", ready_min=835, window=60)
    assert e.trip_id == "presto" and e.board_min == 840


# ── build_inservice_index su VehicleBlock (clusterStops vuoti → indice vuoto) ──

class _T:
    def __init__(self, trip_id, cluster_stops): self.trip_id = trip_id; self.cluster_stops = cluster_stops

class _B:
    def __init__(self, vehicle_id, trips): self.vehicle_id = vehicle_id; self.trips = trips


def test_build_index_da_blocks_vuoto_se_no_clusterstops():
    blocks = [_B("V1", [_T("T1", [])])]
    assert build_inservice_index(blocks).edges == {}


def test_build_index_da_blocks_popolato():
    trips = [_T("T1", [cs("arco_clementino", 1, 700, 701), cs("portavalle", 3, 712, 713)])]
    idx = build_inservice_index([_B("V1", trips)])
    assert idx.connect("arco_clementino", "portavalle", 698, 30).alight_min == 712


# ── generazione clusterStops + iniezione nei turni ───────────────

def test_attach_cluster_stops_to_shifts():
    shifts = [{"trips": [{"tripId": "T1"}, {"tripId": "T2"}]}]
    passages = {"T1": [ClusterStop("21178", "Arco Clementino", 15, "arco_clementino", 451, 452)]}
    n = attach_cluster_stops_to_shifts(shifts, passages)
    assert n == 1
    t1 = shifts[0]["trips"][0]
    assert t1["clusterStops"][0]["clusterId"] == "arco_clementino"
    assert t1["clusterStops"][0]["arrivalTime"] == "07:31"
    assert "clusterStops" not in shifts[0]["trips"][1]   # T2 non ha transiti


# ── integrazione sul feed GTFS reale (se presente) ───────────────

_GTFS = os.path.join(os.path.dirname(__file__), "..", "..", "attached_assets",
                     "stop_times_1774019646190.txt")


@pytest.mark.skipif(not os.path.exists(_GTFS), reason="feed GTFS non presente")
def test_integrazione_gtfs_reale_arco_to_stazione():
    """Sul feed reale: la corsa 623_CodUdp:D1318_364685 passa Arco Clementino (07:31)
    e Stazione Jesi (07:36) → l'indice deve offrire il salto Arco→Stazione."""
    passages = build_cluster_passages(_GTFS, JESI_CLUSTERS)
    assert len(passages) > 100                      # molte corse toccano i cluster
    tid = "623_CodUdp:D1318_364685"
    assert tid in passages
    cls = {p.cluster_id for p in passages[tid]}
    assert {"arco_clementino", "stazione_jesi"} <= cls

    idx = InServiceIndex()
    for t, ps in passages.items():
        idx.add_trip(ps, t)
    idx.finalize()
    e = idx.connect("arco_clementino", "stazione_jesi", ready_min=7 * 60 + 30, window=15)
    assert e is not None and e.alight_min > e.board_min
