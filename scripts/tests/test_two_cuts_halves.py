"""Blocco LUNGO con due tagli di cui il primo intra-corsa: la seconda metà della
corsa spezzata deve entrare nel pezzo di mezzo (prima restava senza
conducente: il montante arrivava 15′ dopo al capolinea successivo, bus
incustodito oltre il limite, consegna e ritiro dell'auto in nodi diversi)."""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import crew_scheduler_v4 as v4  # noqa: E402
from optimizer_common import Cluster, CutCandidate  # noqa: E402


def hhmm(m):
    return f"{m // 60:02d}:{m % 60:02d}"


CLUSTERS = [Cluster(id="c_cav", name="PIAZZA CAVOUR", keywords=["CAVOUR"], transfer_from_depot_min=10, stop_names=["PIAZZA CAVOUR"]),
            Cluster(id="c_ub", name="PIAZZA UGO BASSI", keywords=["UGO BASSI"], transfer_from_depot_min=10, stop_names=["PIAZZA UGO BASSI"]),
            Cluster(id="c_pos", name="POSATORA", keywords=["POSATORA"], transfer_from_depot_min=15, stop_names=["POSATORA CAPOLINEA"])]


def _trip(k, t0, t1, a, b, cluster_stops=None):
    d = {"type": "trip", "tripId": f"t{k}", "routeId": "L3", "routeName": "3",
         "departureTime": hhmm(t0), "arrivalTime": hhmm(t1), "departureMin": t0, "arrivalMin": t1,
         "firstStopName": a, "lastStopName": b, "stopCount": 12, "durationMin": t1 - t0, "directionId": k % 2}
    if cluster_stops:
        d["clusterStops"] = cluster_stops
    return d


def _block():
    """Bus U3: 07:00 Posatora→Cavour, 08:25 Cavour→(Ugo Bassi 08:30)→Posatora 08:42,
    09:13 Posatora→Cavour, 09:40 Cavour→Posatora, 10:13 Posatora→Cavour, 10:40 Cavour→Posatora."""
    ub = [{"stopId": "S_UB", "stopName": "PIAZZA UGO BASSI", "stopSequence": 3, "clusterId": "c_ub",
           "arrivalTime": "08:30", "departureTime": "08:30"}]
    trips = [
        {"type": "deadhead", "depotLeg": "out", "deadheadMin": 12, "deadheadKm": 4.0,
         "departureMin": 408, "arrivalMin": 420, "firstStopName": "Deposito", "lastStopName": "POSATORA CAPOLINEA"},
        _trip(0, 420, 442, "POSATORA CAPOLINEA", "PIAZZA CAVOUR"),
        _trip(1, 505, 522, "PIAZZA CAVOUR", "POSATORA CAPOLINEA", ub),
        _trip(2, 553, 575, "POSATORA CAPOLINEA", "PIAZZA CAVOUR"),
        _trip(3, 580, 602, "PIAZZA CAVOUR", "POSATORA CAPOLINEA"),
        _trip(4, 613, 635, "POSATORA CAPOLINEA", "PIAZZA CAVOUR"),
        _trip(5, 640, 662, "PIAZZA CAVOUR", "POSATORA CAPOLINEA"),
        {"type": "deadhead", "depotLeg": "in", "deadheadMin": 15, "deadheadKm": 5.0,
         "departureMin": 662, "arrivalMin": 677, "firstStopName": "POSATORA CAPOLINEA", "lastStopName": "Deposito"},
    ]
    b = v4.parse_vehicle_blocks([{"vehicleId": "U3", "vehicleType": "12m", "category": "urbano", "trips": trips}], CLUSTERS)[0]
    return b


def _intra(index, time_min, stop_id="S_UB", seq=3, score=50.0):
    return CutCandidate(index=index, gap_min=0, time_min=time_min, stop_name="PIAZZA UGO BASSI", cluster_id="c_ub",
                        score=score, allows_cambio=True, left_driving_min=0, left_work_min=time_min - 408,
                        right_driving_min=0, right_work_min=677 - time_min, transfer_cost_min=10,
                        cut_type="intra", stop_sequence=seq, stop_id=stop_id, trip_id=f"t{index}", route_name="3")


def _inter(index, b, score=40.0):
    t = b.trips[index]
    return CutCandidate(index=index, gap_min=b.trips[index + 1].departure_min - t.arrival_min, time_min=t.arrival_min,
                        stop_name=t.last_stop_name, cluster_id=v4.match_cluster(t.last_stop_name, CLUSTERS),
                        score=score, allows_cambio=True, left_driving_min=0, left_work_min=t.arrival_min - 408,
                        right_driving_min=0, right_work_min=677 - t.arrival_min, transfer_cost_min=10)


def _all_minutes(segs):
    return sum(t.arrival_min - t.departure_min for s in segs for t in s.trips)


def test_two_cuts_intra_then_inter_keep_both_halves():
    b = _block()
    total = sum(t.arrival_min - t.departure_min for t in b.trips)
    left, mid, right = v4._split_trips_for_two_cuts(b, _intra(1, 510), _inter(3, b))
    assert [t.trip_id for t in left] == ["t0", "t1"] and left[-1].last_stop_name == "PIAZZA UGO BASSI"
    assert [t.trip_id for t in mid] == ["t1", "t2", "t3"] and mid[0].first_stop_name == "PIAZZA UGO BASSI"
    assert mid[0].departure_min == 510 and mid[0].arrival_min == 522
    assert [t.trip_id for t in right] == ["t4", "t5"]
    assert _all_minutes([type("S", (), {"trips": x}) for x in (left, mid, right)]) == total
    # ordine dei tagli indifferente
    l2, m2, r2 = v4._split_trips_for_two_cuts(b, _inter(3, b), _intra(1, 510))
    assert [t.trip_id for t in m2] == ["t1", "t2", "t3"] and m2[0].departure_min == 510


def test_two_cuts_same_trip_intra_then_inter():
    b = _block()
    left, mid, right = v4._split_trips_for_two_cuts(b, _inter(1, b), _intra(1, 510))
    assert [t.trip_id for t in left] == ["t0", "t1"] and left[-1].arrival_min == 510
    assert [t.trip_id for t in mid] == ["t1"] and mid[0].departure_min == 510 and mid[0].arrival_min == 522
    assert [t.trip_id for t in right] == ["t2", "t3", "t4", "t5"]


def test_two_cuts_both_intra_same_trip():
    b = _block()
    b.trips[1].cluster_stops.append(type(b.trips[1].cluster_stops[0])(
        stop_id="S_X", stop_name="PIAZZA CAVOUR", stop_sequence=6, cluster_id="c_cav", arrival_min=516, departure_min=516))
    c2 = _intra(1, 516, stop_id="S_X", seq=6)
    left, mid, right = v4._split_trips_for_two_cuts(b, _intra(1, 510), c2)
    assert left[-1].arrival_min == 510
    assert len(mid) == 1 and mid[0].departure_min == 510 and mid[0].arrival_min == 516
    assert right[0].departure_min == 516 and right[0].arrival_min == 522 and [t.trip_id for t in right[1:]] == ["t2", "t3", "t4", "t5"]


def test_build_initial_segments_covers_every_minute_and_hands_over_at_the_stop():
    b = _block()
    b.classification = "LUNGO"
    b.cut_candidates = [_intra(1, 510), _inter(3, b)]
    segs = v4.build_initial_segments([b], CLUSTERS)
    assert len(segs) == 3
    total = sum(t.arrival_min - t.departure_min for t in b.trips)
    assert _all_minutes(segs) == total
    s1, s2, s3 = segs
    # il primo pezzo finisce alla fermata intermedia, il secondo ci comincia: bus mai incustodito
    assert s1.end_min == 510 and s1.last_stop == "PIAZZA UGO BASSI" and s1.last_cluster == "c_ub"
    assert s2.start_min == 510 and s2.first_stop == "PIAZZA UGO BASSI" and s2.first_cluster == "c_ub"
    assert s2.trips[0].trip_id == "t1" and s2.trips[0].arrival_min == 522
    assert s2.driving_min == (522 - 510) + 22 + 22
    # il terzo pezzo prende il bus a Cavour all'arrivo della corsa t3 (sosta 11′ coperta)
    assert s3.start_min == 602 and s3.first_stop == "POSATORA CAPOLINEA"
    assert s1.starts_at_depot and s3.ends_at_depot


def _long_block(n=14, run=60, layover=10):
    """Bus lungo: n corse da `run` minuti alternate Cavour↔Posatora con sosta `layover`."""
    trips = [{"type": "deadhead", "depotLeg": "out", "deadheadMin": 12, "deadheadKm": 4.0,
              "departureMin": 348, "arrivalMin": 360, "firstStopName": "Deposito", "lastStopName": "PIAZZA CAVOUR"}]
    t = 360
    for k in range(n):
        a, b = ("PIAZZA CAVOUR", "POSATORA CAPOLINEA") if k % 2 == 0 else ("POSATORA CAPOLINEA", "PIAZZA CAVOUR")
        trips.append(_trip(k, t, t + run, a, b))
        t += run + layover
    trips.append({"type": "deadhead", "depotLeg": "in", "deadheadMin": 15, "deadheadKm": 5.0,
                  "departureMin": t - layover, "arrivalMin": t - layover + 15,
                  "firstStopName": trips[-1]["lastStopName"], "lastStopName": "Deposito"})
    b = v4.parse_vehicle_blocks([{"vehicleId": "U9", "vehicleType": "12m", "category": "urbano", "trips": trips}], CLUSTERS)[0]
    total = v4.block_total_driving(b)
    cands = []
    cum = b.pullout_min
    for i, tr in enumerate(b.trips[:-1]):
        cum += tr.arrival_min - tr.departure_min
        cands.append(CutCandidate(index=i, gap_min=layover, time_min=tr.arrival_min, stop_name=tr.last_stop_name,
                                  cluster_id=v4.match_cluster(tr.last_stop_name, CLUSTERS), score=50.0, allows_cambio=True,
                                  left_driving_min=cum, left_work_min=tr.arrival_min - b.start_min + b.pullout_min,
                                  right_driving_min=total - cum, right_work_min=b.trips[-1].arrival_min - tr.arrival_min + b.pullin_min,
                                  transfer_cost_min=10))
    b.classification = "LUNGO"
    b.cut_candidates = cands
    return b


def test_long_block_gets_three_cuts_within_driving_cap():
    old = v4.MAX_GUIDA_RIPRESA
    v4.MAX_GUIDA_RIPRESA = 270
    try:
        b = _long_block()                       # 14 × 60′ + 12 + 15 = 867′ di guida: con 2 tagli ≥ 289′ a pezzo
        segs = v4.build_initial_segments([b], CLUSTERS)
        assert len(segs) == 4
        assert all(s.driving_min <= 270 for s in segs), [s.driving_min for s in segs]
        assert sum(len(s.trips) for s in segs) == len(b.trips)
        assert segs[0].starts_at_depot and segs[-1].ends_at_depot
        # i pezzi si passano il bus al capolinea, all'arrivo della corsa precedente
        for prev, nxt in zip(segs, segs[1:]):
            assert nxt.start_min == prev.end_min and nxt.first_stop == prev.last_stop
    finally:
        v4.MAX_GUIDA_RIPRESA = old


def test_two_cuts_when_cap_is_satisfiable():
    old = v4.MAX_GUIDA_RIPRESA
    v4.MAX_GUIDA_RIPRESA = 330
    try:
        segs = v4.build_initial_segments([_long_block()], CLUSTERS)
        assert len(segs) == 3 and all(s.driving_min <= 330 for s in segs), [s.driving_min for s in segs]
    finally:
        v4.MAX_GUIDA_RIPRESA = old
