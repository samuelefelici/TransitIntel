"""Cambio in linea «il montante prende il bus all'arrivo»: i pezzi coprono sosta
e fuorilinea fra due corse, i rientri in deposito a metà blocco sono bordi
deposito, le riprese escono coi confini di NASTRO e le righe Fuorilinea, il
pool auto accoppia consegna e ritiro anche se la consegna non è ancora partita."""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import crew_scheduler_v4 as v4  # noqa: E402
from crew_scheduler_v3 import compute_car_pool, CarTrip, LAST_CAR_POOL_STATS  # noqa: E402
from optimizer_common import Cluster  # noqa: E402
import vcsp_probe  # noqa: E402


def hhmm(m):
    return f"{m // 60:02d}:{m % 60:02d}"


def _trip(vid, k, t0, t1, a, b, route="1"):
    return {"type": "trip", "tripId": f"{vid}t{k}", "routeId": f"L{route}", "routeName": route,
            "departureTime": hhmm(t0), "arrivalTime": hhmm(t1), "departureMin": t0, "arrivalMin": t1,
            "firstStopName": a, "lastStopName": b, "stopCount": 8, "durationMin": t1 - t0, "directionId": k % 2}


CLUSTERS = [Cluster(id="c_cav", name="PIAZZA CAVOUR", keywords=["CAVOUR"], transfer_from_depot_min=10, stop_names=["Piazza Cavour"]),
            Cluster(id="c_tav", name="TAVERNELLE", keywords=["TAVERNELLE"], transfer_from_depot_min=15, stop_names=["Tavernelle"]),
            Cluster(id="c_pos", name="POSATORA", keywords=["POSATORA"], transfer_from_depot_min=15, stop_names=["Posatora"])]


def _block_with_deadhead_and_depot():
    """Bus U1: uscita 06:48→07:00, corse 07:00-07:30 Cavour→Tavernelle, 07:30-08:00
    Tavernelle→Cavour, FUORILINEA Cavour→Posatora 08:05-08:20, corsa 08:35-09:05
    Posatora→Cavour, RIENTRO deposito 09:10-10:50, corsa 11:00-11:30 Cavour→Tavernelle,
    rientro finale 11:30→11:44."""
    trips = [
        {"type": "deadhead", "depotLeg": "out", "deadheadMin": 12, "deadheadKm": 4.0,
         "departureMin": 408, "arrivalMin": 420, "firstStopName": "Deposito", "lastStopName": "Piazza Cavour"},
        _trip("U1", 0, 420, 450, "Piazza Cavour", "Tavernelle"),
        _trip("U1", 1, 450, 480, "Tavernelle", "Piazza Cavour"),
        {"type": "deadhead", "deadheadMin": 15, "deadheadKm": 6.0, "departureMin": 485, "arrivalMin": 500,
         "firstStopName": "Piazza Cavour", "lastStopName": "Posatora"},
        _trip("U1", 2, 515, 545, "Posatora", "Piazza Cavour"),
        {"type": "depot", "routeName": "Rientro deposito", "departureMin": 550, "arrivalMin": 650,
         "firstStopName": "Piazza Cavour", "lastStopName": "Piazza Cavour"},
        _trip("U1", 3, 660, 690, "Piazza Cavour", "Tavernelle"),
        {"type": "deadhead", "depotLeg": "in", "deadheadMin": 14, "deadheadKm": 4.5,
         "departureMin": 690, "arrivalMin": 704, "firstStopName": "Tavernelle", "lastStopName": "Deposito"},
    ]
    return {"vehicleId": "U1", "vehicleType": "12m", "category": "urbano", "trips": trips}


def test_block_keeps_legs_and_segments_cover_gaps():
    blocks = v4.parse_vehicle_blocks([_block_with_deadhead_and_depot()], CLUSTERS)
    b = blocks[0]
    assert [lg.type for lg in b.legs] == ["deadhead", "deadhead", "depot", "deadhead"]
    assert b.pullout_min == 12 and b.pullin_min == 14
    # taglio dopo la 2ª corsa (arrivo 08:00 a Cavour): il pezzo di destra parte
    # al nodo del taglio quando deve guidare il fuorilinea Cavour→Posatora
    # (08:05, entro i 15′ di vettura incustodita) e lo guida
    left = v4._make_segment("U1", "12m", b.trips[:2], "first", 1, CLUSTERS, block=b)
    right = v4._make_segment("U1", "12m", b.trips[2:3], "second", 1, CLUSTERS, block=b)
    assert left.starts_at_depot and left.start_min == 408 and left.end_min == 480
    assert right.start_min == 485 and right.first_stop == "Piazza Cavour" and right.first_cluster == "c_cav"
    assert v4.piece_start_min(b, 1) == 485
    assert right.driving_min == 30 + 15 + 5      # corsa + fuorilinea guidato + rientro in deposito
    assert right.work_min == 550 - 485           # copre sosta + fuorilinea + rientro
    assert right.lead_idle_min == 515 - 485 - 15  # sosta coperta dopo il fuorilinea
    # rientro in deposito a metà blocco: il pezzo che finisce prima rientra col
    # bus, quello dopo esce dal deposito: niente auto ai due bordi
    assert right.ends_at_depot and right.pullin_min == 5 and right.end_min == 550
    last = v4._make_segment("U1", "12m", b.trips[3:], "second", 2, CLUSTERS, block=b)
    assert last.starts_at_depot and last.pullout_min == 10 and last.start_min == 650
    assert last.ends_at_depot and last.end_min == 704
    assert v4.seg_transfer_out(last, CLUSTERS) == 0 and v4.seg_transfer_back(right, CLUSTERS) == 0


def test_long_gap_is_not_covered():
    trips = [_trip("U2", 0, 420, 450, "Piazza Cavour", "Tavernelle"),
             _trip("U2", 1, 600, 630, "Tavernelle", "Piazza Cavour")]   # sosta 2h30 al capolinea
    blocks = v4.parse_vehicle_blocks([{"vehicleId": "U2", "vehicleType": "12m", "category": "urbano", "trips": trips}], CLUSTERS)
    b = blocks[0]
    right = v4._make_segment("U2", "12m", b.trips[1:], "second", 0, CLUSTERS, block=b)
    assert right.start_min == 600 and right.first_stop == "Tavernelle"


def test_run_emits_nastro_bounds_deadhead_rows_and_pairs_cars():
    cfg = {"bds": {"shiftRules": {"intero": {"maxNastro": 435}}}, "companyCars": 5,
           "clusters": [{"id": c.id, "name": c.name, "keywords": c.keywords, "stopNames": c.stop_names,
                         "transferFromDepotMin": c.transfer_from_depot_min} for c in CLUSTERS]}
    shifts = []
    for i in range(3):
        s = _block_with_deadhead_and_depot()
        s["vehicleId"] = f"U{i + 1}"
        for t in s["trips"]:
            if t.get("type") == "trip":
                t["tripId"] = f"U{i + 1}{t['tripId'][2:]}"
        shifts.append(s)
    out = v4.run({"vehicleShifts": shifts, "config": cfg}, time_limit_sec=10)
    riprese = [r for d in out["driverShifts"] for r in d["riprese"]]
    assert riprese
    for r in riprese:
        # confini di nastro = servizio allargato di pre-turno/trasferimento/rientro
        assert r["startMin"] == r["serviceStartMin"] - r["preTurnoMin"] - r["transferMin"]
        assert r["endMin"] == r["serviceEndMin"] + r["transferBackMin"]
        assert r["preTurnoKind"] in ("bus", "auto", "none")
        if r["preTurnoMin"] > 0:
            assert r["preTurnoKind"] == ("bus" if r["transferMin"] == 0 else "auto")
            assert r["preTurnoMin"] == (12 if r["transferMin"] == 0 else 5)
        for t in r["trips"]:
            assert r["serviceStartMin"] <= t["departureMin"] and t["arrivalMin"] <= r["serviceEndMin"]
        for dh in r["deadheads"]:
            assert r["serviceStartMin"] <= dh["departureMin"] <= dh["arrivalMin"] <= r["serviceEndMin"]
            assert dh["kind"] in ("pullout", "pullin", "reposition", "depot_in", "depot_out")
    kinds = {dh["kind"] for r in riprese for dh in r["deadheads"]}
    assert "pullout" in kinds and "pullin" in kinds
    # ogni uscita/rientro e ogni fuorilinea del bus compare in ESATTAMENTE un pezzo
    n_pullout = sum(1 for r in riprese for dh in r["deadheads"] if dh["kind"] == "pullout")
    n_repo = sum(1 for r in riprese for dh in r["deadheads"] if dh["kind"] == "reposition")
    assert n_pullout == 3 and n_repo == 3
    s = out["summary"]
    assert s["companyCarsUnpaired"] == 0
    assert s["companyCarsConflicts"] == 0
    assert s["companyCarsMaxSimultaneous"] <= 5 and not s["companyCarsHardViolation"]


def test_car_pool_pickup_waits_for_deliver_not_yet_departed():
    class Seg:
        def __init__(self, vid, start, end, fc, lc, fs, ls, sad=False, ead=False):
            self.vehicle_id, self.start_min, self.end_min = vid, start, end
            self.first_cluster, self.last_cluster, self.first_stop, self.last_stop = fc, lc, fs, ls
            self.starts_at_depot, self.ends_at_depot = sad, ead

    class Duty:
        def __init__(self, did, segs, t_out=10, t_back=10):
            self.driver_id, self.segments = did, segs
            self.transfer_min, self.transfer_back_min = t_out, t_back

    # A smonta a Cavour alle 10:00 (ritiro 10:00); B monta a Cavour alle 10:08
    # (consegna parte 09:58, arriva 10:08): A aspetta 8' e torna con l'auto di B
    a = Duty("A", [Seg("V1", 420, 600, "c_cav", "c_cav", "Piazza Cavour", "Piazza Cavour", sad=True)], t_out=0, t_back=10)
    b = Duty("B", [Seg("V1", 608, 800, "c_cav", "c_tav", "Piazza Cavour", "Tavernelle", ead=True)], t_out=10, t_back=0)
    trips = compute_car_pool([a, b], CLUSTERS)
    by = {(t.driver_id, t.trip_type): t for t in trips}
    assert by[("B", "deliver")].car_id == 1 and by[("A", "pickup")].car_id == 1
    assert by[("A", "pickup")].wait_min == 8 and by[("A", "pickup")].depart_min == 608
    assert LAST_CAR_POOL_STATS["unpaired"] == 0 and LAST_CAR_POOL_STATS["demandPeak"] == 1
    # ritiro senza nessuna consegna raggiungibile: «senza auto al nodo», non colpa del tetto
    c = Duty("C", [Seg("V2", 420, 700, "c_pos", "c_pos", "Posatora", "Posatora", sad=True)], t_out=0, t_back=15)
    trips = compute_car_pool([c], CLUSTERS)
    assert trips[0].car_id is None and LAST_CAR_POOL_STATS["unpaired"] == 1


def test_probe_gap_uses_service_times():
    crew_out = {"driverShifts": [{
        "driverId": "U1", "type": "semiunico", "nastroMin": 500,
        "riprese": [
            {"startMin": 400, "endMin": 620, "serviceStartMin": 420, "serviceEndMin": 610,
             "vehicleIds": ["V1"], "trips": [{"tripId": "t1"}]},
            {"startMin": 680, "endMin": 900, "serviceStartMin": 700, "serviceEndMin": 890,
             "vehicleIds": ["V2"], "trips": [{"tripId": "t2"}]},
        ]}]}
    trips_by_id = {"t1": {"tripId": "t1", "routeId": "L1", "departureMin": 420, "arrivalMin": 610, "flexMin": 15},
                   "t2": {"tripId": "t2", "routeId": "L1", "departureMin": 700, "arrivalMin": 890, "flexMin": 15}}
    vcsp_probe.find_crew_probe_candidates(crew_out, trips_by_id, max_candidates=5, scope="trip",
                                          intero_max_nastro=435, semi_int_min=75)
    st = vcsp_probe.LAST_CREW_STATS
    assert st["biRiprese"] == 1
    # stacco di SERVIZIO 90' (700-610), non 60' sui confini di nastro: il turno
    # è irraggiungibile per nastro (500 > 435), quindi finisce nei dettagli
    assert st["unreachableDetails"] and st["unreachableDetails"][0]["gapMin"] == 90
    assert st["unreachableDetails"][0]["nastroMin"] == 500
