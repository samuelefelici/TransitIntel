"""Rilievi della revisione avversariale sulla #434: sosta coperta vista dalle
regole BDS, cambio a piedi senza auto, cambio al deposito senza handover,
righe deposito ai bordi, promessa del pool solo a consegne con auto,
crew_tools coerente col motore."""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import crew_scheduler_v4 as v4  # noqa: E402
import crew_tools  # noqa: E402
from crew_scheduler_v3 import inline_handovers, compute_car_pool, compute_handovers, walk_change, LAST_CAR_POOL_STATS, CarTrip, _simulate_car_pool  # noqa: E402
from optimizer_common import SHIFT_RULES  # noqa: E402
from test_cover_rule import _trip, CLUSTERS, _block_with_deadhead_and_depot  # noqa: E402


class Seg:
    def __init__(self, vid, start, end, fc, lc, fs, ls, sad=False, ead=False, trips=None, lead=0):
        self.vehicle_id, self.start_min, self.end_min = vid, start, end
        self.first_cluster, self.last_cluster, self.first_stop, self.last_stop = fc, lc, fs, ls
        self.starts_at_depot, self.ends_at_depot = sad, ead
        self.trips = trips or []
        self.lead_idle_min = lead
        self.work_min = end - start
        self.driving_min = end - start


class Duty:
    def __init__(self, did, segs, t_out=10, t_back=10):
        self.driver_id, self.segments = did, segs
        self.transfer_min, self.transfer_back_min = t_out, t_back
        self.duty_type = "intero"


def test_covered_layover_counts_as_rest():
    # 07:00-07:30 Cavour→Tav, 07:35-08:05 Tav→Cavour, SOSTA 20' a Cavour, poi 4 corse fino alle 10:40
    trips = [_trip("U3", 0, 420, 450, "Piazza Cavour", "Tavernelle"), _trip("U3", 1, 455, 485, "Tavernelle", "Piazza Cavour"),
             _trip("U3", 2, 505, 535, "Piazza Cavour", "Tavernelle"), _trip("U3", 3, 540, 570, "Tavernelle", "Piazza Cavour"),
             _trip("U3", 4, 575, 605, "Piazza Cavour", "Tavernelle"), _trip("U3", 5, 610, 640, "Tavernelle", "Piazza Cavour")]
    b = v4.parse_vehicle_blocks([{"vehicleId": "U3", "vehicleType": "12m", "category": "urbano", "trips": trips}], CLUSTERS)[0]
    s1 = v4._make_segment("U3", "12m", b.trips[:2], "first", 1, CLUSTERS, block=b)
    s2 = v4._make_segment("U3", "12m", b.trips[2:], "second", 1, CLUSTERS, block=b)
    # il montante prende il bus 15′ dopo l'arrivo (vettura incustodita ≤ 15′) e copre i 5′ restanti
    assert s2.start_min == 500 and s2.lead_idle_min == 5
    assert v4._feasible_pair(s1, s2, SHIFT_RULES) == "intero"
    d = Duty("A", [s1, s2])
    ok, viol = v4.check_sosta_capolinea(d, SHIFT_RULES)
    assert ok and not viol


def test_walk_change_same_node_needs_no_car():
    a = Seg("V1", 420, 600, "c_cav", "c_cav", "Piazza Cavour", "Piazza Cavour", sad=True)
    b = Seg("V2", 600, 800, "c_cav", "c_tav", "Piazza Cavour", "Tavernelle", ead=True)
    assert walk_change(a, b)
    trips = compute_car_pool([Duty("D", [a, b], t_out=0, t_back=0)], CLUSTERS)
    assert trips == [] and LAST_CAR_POOL_STATS["demandPeak"] == 0
    assert v4._car_events_pair(a, b, CLUSTERS, {"V1": [a], "V2": [b]}) == []


def test_depot_change_is_not_a_line_handover_and_rows_at_borders():
    b = v4.parse_vehicle_blocks([_block_with_deadhead_and_depot()], CLUSTERS)[0]
    right = v4._make_segment("U1", "12m", b.trips[2:3], "second", 1, CLUSTERS, block=b)
    last = v4._make_segment("U1", "12m", b.trips[3:], "second", 2, CLUSTERS, block=b)
    hs = compute_handovers([Duty("A", [right]), Duty("B", [last])], CLUSTERS)
    # tracciato come passaggio in deposito, ma NON è un cambio in linea
    assert [h.kind for h in hs] == ["depot"] and inline_handovers(hs) == []
    kinds_r = [d["kind"] for d in v4._ripresa_deadheads(right, b.legs)]
    kinds_l = [d["kind"] for d in v4._ripresa_deadheads(last, b.legs)]
    assert "depot_in" in kinds_r and "depot_out" not in kinds_r
    assert "depot_out" in kinds_l and "depot_in" not in kinds_l and "pullin" in kinds_l


def test_pool_promise_skips_deliver_without_car():
    P1 = CarTrip("P", "Y0", "X", "X", "deliver", 500, 510, 10)
    P2 = CarTrip("P", "Y0", "X", "X", "pickup", 590, 603, 13)
    Q1 = CarTrip("Q1", "Y", "Y", "Y", "deliver", 600, 610, 10)
    Q2 = CarTrip("Q2", "Y", "Y", "Y", "deliver", 604, 615, 11)
    R = CarTrip("R", "Y", "Y", "Y", "pickup", 605, 620, 15)
    trips = [P1, P2, Q1, Q2, R]
    orig = [(t.depart_min, t.arrive_min) for t in trips]
    res = _simulate_car_pool(trips, 1, orig)
    assert R.car_id == 1 and R.wait_min == 10 and R.depart_min == 615
    assert Q1 in res["conflicts"] and R not in res["conflicts"] and not res["unpaired"]


def test_crew_tools_honours_engine_bounds():
    cfg = {"bds": {"shiftRules": {"intero": {"maxNastro": 435}}}, "companyCars": 5,
           "clusters": [{"id": c.id, "name": c.name, "keywords": c.keywords, "stopNames": c.stop_names,
                         "transferFromDepotMin": c.transfer_from_depot_min} for c in CLUSTERS]}
    out = v4.run({"vehicleShifts": [_block_with_deadhead_and_depot()], "config": cfg}, time_limit_sec=10)
    val = crew_tools.run_validate({"shifts": out["driverShifts"], "config": cfg})
    for d in out["driverShifts"]:
        r = val["results"][d["driverId"]]
        assert "error" not in r, r
        assert r["nastroMin"] == d["nastroMin"], (d["driverId"], r["nastroMin"], d["nastroMin"])
        assert r["preTurnoMin"] == d["preTurnoMin"] and r["transferMin"] == d["transferMin"] and r["transferBackMin"] == d["transferBackMin"]
