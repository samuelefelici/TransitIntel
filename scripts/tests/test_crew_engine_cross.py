"""Test: cambi CROSS-cluster nel motore a catena (increment 2).

Un conducente può concatenare un pezzo che finisce al cluster A con un pezzo che
inizia al cluster B≠A SOLO se un bus di linea collega A→B nel gap (gratis). Senza
indice di connettività il comportamento resta stesso-cluster (nessuna regressione).
"""

from optimizer_common import Cluster, ClusterStop, Segment, VShiftTrip, VehicleBlock
from crew_engine_chain import (
    _link_feasible, _inservice_edge, enumerate_duties, build_pieces,
)
from gtfs_clusters import InServiceIndex, build_inservice_index


CLUSTERS = [
    Cluster(id="A", name="Arco", keywords=["ARCO"], transfer_from_depot_min=12, stop_ids=["a1"]),
    Cluster(id="B", name="Porta", keywords=["PORTA"], transfer_from_depot_min=12, stop_ids=["b1"]),
]


def seg(idx, start, end, first_cl, last_cl, vehicle, pullout=True, pullin=True):
    return Segment(
        idx=idx, vehicle_id=vehicle, vehicle_type="12m", trips=[],
        start_min=start, end_min=end, work_min=end - start, driving_min=end - start,
        first_stop=first_cl, last_stop=last_cl, first_cluster=first_cl, last_cluster=last_cl,
        half="piece", cut_index=None, is_pullout=pullout, is_pullin=pullin,
    )


def index_A_to_B(board, alight):
    idx = InServiceIndex()
    idx.add_trip([ClusterStop("a1", "Arco", 1, "A", board, board),
                  ClusterStop("b1", "Porta", 5, "B", alight, alight)], "T1", "V9")
    idx.finalize()
    return idx


# ── _inservice_edge / _link_feasible ─────────────────────────────

def test_cross_link_solo_con_bus_di_linea():
    p = seg(0, 480, 540, "A", "A", "V1", pullin=False)
    q = seg(1, 555, 620, "B", "B", "V2", pullout=False)
    idx = index_A_to_B(542, 550)            # bus parte 542 (dopo p.end 540), arriva 550 ≤ 555
    assert _inservice_edge(p, q, idx) is not None
    assert _link_feasible(p, q, idx) is True
    assert _link_feasible(p, q, None) is False    # senza indice: niente cross-cluster


def test_cross_link_no_se_bus_arriva_dopo_inizio_q():
    p = seg(0, 480, 540, "A", "A", "V1", pullin=False)
    q = seg(1, 545, 620, "B", "B", "V2", pullout=False)
    idx = index_A_to_B(542, 560)            # arriva 560 > q.start 545 → inutilizzabile
    assert _link_feasible(p, q, idx) is False


def test_cross_link_no_oltre_la_ripresa():
    """Gap ≥ 75' è un'interruzione (rientro deposito), non un cambio in linea."""
    p = seg(0, 300, 400, "A", "A", "V1", pullin=False)
    q = seg(1, 500, 600, "B", "B", "V2", pullout=False)   # gap 100' ≥ SOSTA_SPEZZA
    idx = index_A_to_B(402, 410)
    assert _link_feasible(p, q, idx) is False


def test_same_cluster_invariato_senza_indice():
    p = seg(0, 480, 540, "A", "A", "V1", pullin=False)
    q = seg(1, 550, 620, "A", "A", "V2", pullout=False)
    assert _link_feasible(p, q, None) is True       # stesso cluster: sempre ammesso


# ── enumerate_duties: la catena cross-cluster esiste solo con indice ──

def _has_chain(columns, idxs):
    s = set(idxs)
    return any(set(c.piece_idxs) == s for c in columns)


def test_enumerate_crea_catena_cross_solo_con_indice():
    p = seg(0, 480, 540, "A", "A", "V1", pullin=False)
    q = seg(1, 555, 620, "B", "B", "V2", pullout=False)
    idx = index_A_to_B(542, 550)

    cols_no = enumerate_duties([p, q], CLUSTERS, inservice=None)
    assert not _has_chain(cols_no, (0, 1))          # senza bus: nessuna catena cross

    cols_yes = enumerate_duties([p, q], CLUSTERS, inservice=idx)
    assert _has_chain(cols_yes, (0, 1))             # col bus: catena [p,q] enumerata


# ── end-to-end: blocks → pezzi → indice (dai clusterStops) → colonna cross ──

def _trip(tid, fs, ls, dep, arr, cstops=None):
    return VShiftTrip(type="trip", trip_id=tid, route_id="r", route_name="R", headsign=None,
                      departure_time="", arrival_time="", departure_min=dep, arrival_min=arr,
                      first_stop_name=fs, last_stop_name=ls, cluster_stops=cstops or [])


def _block(vid, trips):
    return VehicleBlock(vehicle_id=vid, vehicle_type="12m", category="urbano", trips=trips,
                        start_min=trips[0].departure_min, end_min=trips[-1].arrival_min,
                        nastro_min=0, driving_min=0, work_min=0, classification="")


def test_end_to_end_catena_cross_dai_clusterstops():
    """Pezzo di V1 che finisce ad Arco e pezzo di V2 che inizia a Porta: si concatenano
    SOLO grazie al bus di linea V3 che passa Arco(09:02)→Porta(09:10), ricavato dai
    clusterStops. Senza quei transiti, nessuna catena cross."""
    V1 = _block("V1", [_trip("t1a", "Deposito", "Arco", 480, 540),
                       _trip("t1b", "Deposito", "Deposito", 600, 640)])
    V2 = _block("V2", [_trip("t2", "Porta", "Deposito", 555, 620)])
    V3 = _block("V3", [_trip("t3", "X", "Y", 500, 560, cstops=[
        ClusterStop("a1", "Arco", 1, "A", 540, 542),
        ClusterStop("b1", "Porta", 2, "B", 550, 552)])])
    blocks = [V1, V2, V3]
    pieces = build_pieces(blocks, CLUSTERS)

    # P0 = V1 Deposito→Arco (idx 0), P2 = V2 Porta→Deposito (idx 2)
    p0 = next(p for p in pieces if p.last_cluster == "A")
    p2 = next(p for p in pieces if p.first_cluster == "B")

    idx = build_inservice_index(blocks, CLUSTERS)
    assert idx.edges.get(("A", "B"))                       # il bus V3 collega A→B

    cols_no = enumerate_duties(pieces, CLUSTERS, inservice=None)
    assert not _has_chain(cols_no, (p0.idx, p2.idx))       # senza transiti: niente cross

    cols_yes = enumerate_duties(pieces, CLUSTERS, inservice=idx)
    assert _has_chain(cols_yes, (p0.idx, p2.idx))          # col bus: catena cross enumerata
