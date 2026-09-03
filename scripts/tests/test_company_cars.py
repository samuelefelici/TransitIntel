"""Auto aziendali per i cambi in linea: i pezzi che iniziano/finiscono in
deposito non usano l'auto (il conducente esce/rientra col bus), i contatori
del summary dicono il vero, il tetto entra nel modello."""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import crew_scheduler_v4 as v4  # noqa: E402
from crew_scheduler_v3 import compute_car_pool, _cars_out_demand_peak, _max_simultaneous_cars_out  # noqa: E402
from optimizer_common import Cluster, DriverDutyV3  # noqa: E402


def hhmm(m):
    return f"{m // 60:02d}:{m % 60:02d}"


def _shift(vid, t0, end, dur=25, headway=30, pullout=12, pullin=14):
    trips, d, k = [], 0, 0
    t = t0
    while t + dur <= end:
        a, b = ("Piazza Cavour", "Tavernelle") if d == 0 else ("Tavernelle", "Piazza Cavour")
        trips.append({"type": "trip", "tripId": f"{vid}t{k}", "routeId": "L1", "routeName": "1",
                      "departureTime": hhmm(t), "arrivalTime": hhmm(t + dur), "departureMin": t, "arrivalMin": t + dur,
                      "firstStopName": a, "lastStopName": b, "stopCount": 10, "durationMin": dur, "directionId": d})
        t += headway
        d ^= 1
        k += 1
    legs = ([{"type": "deadhead", "depotLeg": "out", "deadheadMin": pullout, "deadheadKm": 4.0,
              "departureMin": t0 - pullout, "arrivalMin": t0, "firstStopName": "Deposito", "lastStopName": "Piazza Cavour"}]
            + trips
            + [{"type": "deadhead", "depotLeg": "in", "deadheadMin": pullin, "deadheadKm": 4.5,
                "departureMin": trips[-1]["arrivalMin"], "arrivalMin": trips[-1]["arrivalMin"] + pullin,
                "firstStopName": trips[-1]["lastStopName"], "lastStopName": "Deposito"}])
    return {"vehicleId": vid, "vehicleType": "12m", "category": "urbano", "trips": legs}


CLUSTERS = [Cluster(id="c_cav", name="PIAZZA CAVOUR", keywords=["CAVOUR"], transfer_from_depot_min=10, stop_names=["Piazza Cavour"]),
            Cluster(id="c_tav", name="TAVERNELLE", keywords=["TAVERNELLE"], transfer_from_depot_min=15, stop_names=["Tavernelle"])]


def test_blocks_and_segments_carry_depot_edges():
    blocks = v4.parse_vehicle_blocks([_shift("U001", 8 * 60, 21 * 60)], CLUSTERS)
    b = blocks[0]
    assert b.pullout_min == 12 and b.pullin_min == 14
    full = v4._make_segment(b.vehicle_id, b.vehicle_type, b.trips, "full", None, CLUSTERS, block=b)
    assert full.starts_at_depot and full.ends_at_depot
    assert full.start_min == b.trips[0].departure_min - 12 and full.end_min == b.trips[-1].arrival_min + 14
    assert full.driving_min == sum(t.arrival_min - t.departure_min for t in b.trips) + 12 + 14
    # spezzato a metà: il primo pezzo esce dal deposito, il secondo rientra
    mid = len(b.trips) // 2
    left = v4._make_segment(b.vehicle_id, b.vehicle_type, b.trips[:mid], "first", mid - 1, CLUSTERS, block=b)
    right = v4._make_segment(b.vehicle_id, b.vehicle_type, b.trips[mid:], "second", mid - 1, CLUSTERS, block=b)
    assert left.starts_at_depot and not left.ends_at_depot
    assert right.ends_at_depot and not right.starts_at_depot
    # niente auto ai bordi in deposito, auto al cambio in linea
    assert v4.seg_transfer_out(left, CLUSTERS) == 0 and v4.seg_transfer_back(left, CLUSTERS) > 0
    assert v4.seg_transfer_out(right, CLUSTERS) > 0 and v4.seg_transfer_back(right, CLUSTERS) == 0
    assert v4._car_deliver_window(left, CLUSTERS) is None and v4._car_pickup_window(right, CLUSTERS) is None
    assert v4._car_events_single(left, CLUSTERS) == [(left.end_min + v4.seg_transfer_back(left, CLUSTERS), -1)]
    # un pezzo senza blocco (compatibilità): comportamento precedente
    legacy = v4._make_segment(b.vehicle_id, b.vehicle_type, b.trips, "full", None, CLUSTERS)
    assert not legacy.starts_at_depot and legacy.pullout_min == 0


def test_car_pool_skips_depot_edges_and_counts_demand():
    blocks = v4.parse_vehicle_blocks([_shift("U001", 8 * 60, 21 * 60), _shift("U002", 8 * 60 + 10, 21 * 60 + 30)], CLUSTERS)
    duties = []
    idx = 0
    for b in blocks:
        mid = len(b.trips) // 2
        left = v4._make_segment(b.vehicle_id, b.vehicle_type, b.trips[:mid], "first", mid - 1, CLUSTERS, block=b)
        right = v4._make_segment(b.vehicle_id, b.vehicle_type, b.trips[mid:], "second", mid - 1, CLUSTERS, block=b)
        for seg in (left, right):
            t = v4.seg_transfer_out(seg, CLUSTERS)
            tb = v4.seg_transfer_back(seg, CLUSTERS)
            duties.append(DriverDutyV3(idx=idx, driver_id=f"U{idx + 1:03d}", duty_type="intero", segments=[seg],
                                       nastro_start=seg.start_min - t, nastro_end=seg.end_min + tb,
                                       nastro_min=seg.work_min + t + tb, work_min=seg.work_min + tb,
                                       driving_min=seg.driving_min, interruption_min=0, pre_turno_min=12,
                                       transfer_min=t, transfer_back_min=tb))
            idx += 1
    v4.COMPANY_CARS = 5
    import crew_scheduler_v3 as v3
    v3.COMPANY_CARS = 5
    moves = compute_car_pool(duties, CLUSTERS)
    # 2 blocchi × 1 cambio in linea = 2 ritiri (fine pezzo sinistro) + 2 consegne (inizio pezzo destro)
    assert len(moves) == 4, [(m.driver_id, m.trip_type) for m in moves]
    assert all(m.car_id is not None for m in moves)
    assert _cars_out_demand_peak(moves) == _max_simultaneous_cars_out(moves) == 2
    # tetto 1 auto: la domanda resta 2, l'assegnazione si ferma a 1 e un viaggio resta senza auto
    v3.COMPANY_CARS = 1
    moves1 = compute_car_pool(duties, CLUSTERS)
    assert _cars_out_demand_peak(moves1) == 2 and _max_simultaneous_cars_out(moves1) <= 1
    assert sum(1 for m in moves1 if m.car_id is None) >= 1
    v3.COMPANY_CARS = 5


def test_run_summary_counts_cars_not_buses():
    shifts = [_shift(f"U{v + 1:03d}", 8 * 60 + (v % 3) * 10, 21 * 60 + (v % 2) * 30) for v in range(4)]
    cfg = {"bds": {"serviceType": "urbano", "optimizer": {"maxCompanyCars": 5}}, "solverIntensity": 1,
           "clusters": [{"id": c.id, "name": c.name, "keywords": c.keywords, "stopNames": c.stop_names, "transferFromDepotMin": c.transfer_from_depot_min} for c in CLUSTERS]}
    out = v4.run({"vehicleShifts": shifts, "config": cfg}, time_limit_sec=15)
    s = out["summary"]
    assert s["companyCarsCap"] == 5
    assert s["companyCarsUsed"] <= 5, s["companyCarsUsed"]          # auto distinte, non i 4 bus
    assert s["companyCarsMovements"] == out["metrics"]["carPool"]["totalTrips"]
    assert s["companyCarsMaxSimultaneous"] <= 5 and s["companyCarsConflicts"] == 0
    assert s["companyCarsHardViolation"] is False
    # ogni pezzo in deposito dichiara i suoi bordi e la sua uscita/rientro
    riprese = [r for d in out["driverShifts"] for r in d["riprese"]]
    assert any(r["startsAtDepot"] for r in riprese) and any(r["endsAtDepot"] for r in riprese)
    assert all((r["carPoolOut"] is None) for r in riprese if r["startsAtDepot"])
    assert all((r["carPoolReturn"] is None) for r in riprese if r["endsAtDepot"])
    assert {m["type"] for m in out["metrics"]["carPool"]["movements"]} <= {"deliver", "pickup"}
    assert out["carPool"]["totalTrips"] == s["companyCarsMovements"]
