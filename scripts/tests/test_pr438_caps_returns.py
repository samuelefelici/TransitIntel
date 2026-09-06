"""Tetti percentuali rigidi con tolleranza di frazione di turno, tetto di guida
per ripresa nella segmentazione, rientri in deposito con le due tratte reali,
proposte di corse di rientro in linea al posto dei rientri a vuoto."""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import crew_scheduler_v4 as v4  # noqa: E402
import vehicle_scheduler_cpsat as vsp  # noqa: E402
from optimizer_common import (Cluster, VehicleShift, VShiftTrip, set_deadhead_matrix,  # noqa: E402
                              set_deadhead_min_matrix, dh_key, DH_FORBIDDEN_KM)
BDSConfig = v4.BDSConfig
from test_cover_rule import _trip, CLUSTERS, _block_with_deadhead_and_depot  # noqa: E402
from test_cover_rule_2 import _vtrip  # noqa: E402


def test_pct_cap_allowed_rounds_within_the_unit():
    v4.PCT_CAP_TOLERANCE_SHIFTS = 0.9
    # 12% di 38 = 4,56 → 5 ammessi (sforamento 0,44); 12% di 25 = 3,0 → 3; 12% di 26 = 3,12 → 4? no: 3,12+0,9=4,02 → 4
    assert v4.pct_cap_allowed(12, 38) == 5
    assert v4.pct_cap_allowed(12, 25) == 3
    assert v4.pct_cap_allowed(12, 26) == 4
    # 13% di 37 = 4,81 → 5; mai un turno intero oltre: 10% di 10 = 1 → 1
    assert v4.pct_cap_allowed(13, 37) == 5 and v4.pct_cap_allowed(10, 10) == 1
    assert v4.pct_cap_allowed(None, 10) is None


class _D:
    def __init__(self, t):
        self.duty_type = t
        self.segments = []
        self.driver_id = t


def test_pct_caps_status_reports_violation():
    duties = [_D("intero")] * 20 + [_D("semiunico")] * 6 + [_D("spezzato")] * 2
    old = dict(v4.SHIFT_RULES["semiunico"]), dict(v4.SHIFT_RULES["spezzato"])
    try:
        v4.SHIFT_RULES["semiunico"]["maxPct"] = 12
        v4.SHIFT_RULES["spezzato"]["maxPct"] = 13
        st = v4.pct_caps_status(duties, BDSConfig())
        semi = st["byType"]["semiunico"]
        # 12% di 28 = 3,36 → 4 ammessi, 6 presenti → violazione
        assert semi["allowed"] == 4 and semi["count"] == 6 and not semi["ok"]
        assert st["byType"]["spezzato"]["ok"]
    finally:
        v4.SHIFT_RULES["semiunico"].update(old[0]); v4.SHIFT_RULES["spezzato"].update(old[1])


def test_run_respects_pct_caps_and_reports_them():
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
    caps = out["summary"]["pctCaps"]
    assert caps["hard"] is True and caps["toleranceShifts"] == 0.9
    for k, v in caps["byType"].items():
        assert v["count"] <= v["allowed"] or caps["relaxed"], (k, v)
    val = out["summary"]["validation"]
    assert "globalViolations" in val and "pctCaps" in val


def test_cut_analysis_counts_deadheads_in_driving():
    b = v4.parse_vehicle_blocks([_block_with_deadhead_and_depot()], CLUSTERS)[0]
    v4.analyze_vehicle_block(b, CLUSTERS, BDSConfig())
    # blocco: uscita 12 + 30 + 30 + fuorilinea 15 + 30 + rientro/uscita deposito (5+10) + 30 + rientro 14 = 176
    assert v4.block_total_driving(b) == 12 + 30 + 30 + 15 + 30 + 5 + 10 + 30 + 14
    c = next(c for c in b.cut_candidates if c.index == 1 and c.cut_type == "inter")
    assert c.left_driving_min == 12 + 30 + 30          # uscita + due corse
    assert c.right_driving_min == 15 + 30 + 5 + 10 + 30 + 14  # fuorilinea guidato dal montante, deposito, ultima corsa, rientro


def test_via_depot_arc_keeps_the_two_legs():
    X, Y, Z, W = (43.60, 13.50), (43.62, 13.52), (43.64, 13.48), (43.66, 13.50)
    D = {"id": "d1", "name": "Deposito", "lat": 43.61, "lon": 13.49}
    trips = [_vtrip(0, 480, 510, "X", "Y", *X, *Y), _vtrip(1, 570, 600, "Z", "W", *Z, *W)]
    key = lambda p, q: f"{dh_key(*p)}|{dh_key(*q)}"
    d = (D["lat"], D["lon"])
    set_deadhead_matrix({key(Y, Z): DH_FORBIDDEN_KM, key(Y, d): 3.0, key(d, Z): 2.5})
    set_deadhead_min_matrix({key(Y, d): 15, key(d, Z): 8})
    try:
        arcs = vsp.build_compatible_arcs_fast(trips, vsp.VehicleCostRates(), None, depots=[D])
        a = next(x for x in arcs if (x.i, x.j) == (0, 1))
        assert a.via_depot and a.leg_in_min == 15 and a.leg_out_min == 8 and a.dh_min == 23
        assert a.leg_in_km == 3.0 and a.leg_out_km == 2.5 and a.depot_id == "d1"
    finally:
        set_deadhead_matrix(None); set_deadhead_min_matrix(None)


def test_service_return_proposal_after_empty_return():
    # Linea 30: andata A→B 06:12-06:27 e ritorni B→A ogni ora dalle 07:46; il bus
    # dopo la 06:12 rientra a vuoto: proposta 30R B→A alle 06:30 (o 06:46 per cadenza)
    A, B, C = (43.60, 13.50), (43.62, 13.52), (43.61, 13.51)
    D = {"id": "d1", "name": "Deposito", "lat": 43.605, "lon": 13.505}
    trips = [_vtrip(0, 372, 387, "A", "B", *A, *B)]
    trips[0].route_name = "30"; trips[0].variant_code = "30A"; trips[0].direction_id = 0
    k = 1
    for h in range(7, 12):
        t = _vtrip(k, h * 60 + 46, h * 60 + 61, "B", "A", *B, *A); t.route_name = "30"; t.variant_code = "30R"; t.direction_id = 1
        trips.append(t); k += 1
    nxt = _vtrip(k, 470, 500, "C", "A", *C, *A); nxt.route_name = "1"; nxt.direction_id = 0
    trips.append(nxt)
    key = lambda p, q: f"{dh_key(*p)}|{dh_key(*q)}"
    d = (D["lat"], D["lon"])
    set_deadhead_matrix({key(B, d): 4.0, key(d, C): 3.0, key(A, C): 1.0, key(A, d): 1.5})
    set_deadhead_min_matrix({key(B, d): 15, key(d, C): 12, key(A, C): 4, key(A, d): 5})
    try:
        s = VehicleShift(vehicle_id="U1", vehicle_type="12m", category="urbano", residenza_depot_id="d1")
        s.trips = [
            VShiftTrip(type="trip", trip_id="t0", route_id="R1", route_name="30", headsign=None, departure_time="06:12", arrival_time="06:27",
                       departure_min=372, arrival_min=387, first_stop_name="A", last_stop_name="B"),
            VShiftTrip(type="depot", trip_id="", route_id="", route_name="Rientro deposito", headsign=None, departure_time="06:42", arrival_time="07:38",
                       departure_min=402, arrival_min=458, first_stop_name="B", last_stop_name="C", deadhead_km=7.0, deadhead_min=27),
            VShiftTrip(type="trip", trip_id=f"t{k}", route_id="R1", route_name="1", headsign=None, departure_time="07:50", arrival_time="08:20",
                       departure_min=470, arrival_min=500, first_stop_name="C", last_stop_name="A"),
        ]
        props = vsp.service_return_proposals([s], trips, vsp.VehicleCostRates(), [D])
        assert len(props) == 1
        p = props[0]
        assert p["kind"] == "midBlock" and p["fromStop"] == "B" and p["toStop"] == "A"
        assert p["departMin"] == 387 + 3 and p["runMin"] == 15 and p["variantCode"] == "30R"
        assert p["cadenceDepartTime"] == "06:46"           # ritorni tutti al minuto :46
        assert p["deadheadKmSaved"] == 7.0 - 1.0 and "In linea" not in p["description"]
        assert p["nextTripId"] == f"t{k}"
    finally:
        set_deadhead_matrix(None); set_deadhead_min_matrix(None)
