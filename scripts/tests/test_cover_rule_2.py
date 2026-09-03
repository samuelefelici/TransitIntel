"""Seguito della regola del montante (esito del Giro O): le metà di corsa dei
tagli intra riconoscono il rientro in deposito che segue; «stesso veicolo»
vale solo per pezzi consecutivi sul bus; un riposizionamento vietato
dall'archivio fuorilinea viene instradato via deposito dal VSP."""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import crew_scheduler_v4 as v4  # noqa: E402
import vehicle_scheduler_cpsat as vsp  # noqa: E402
from crew_scheduler_v3 import compute_car_pool, same_bus_consecutive, LAST_CAR_POOL_STATS  # noqa: E402
from optimizer_common import Cluster, ClusterStop, set_deadhead_matrix, set_deadhead_min_matrix, dh_key, DH_FORBIDDEN_KM  # noqa: E402
from test_cover_rule import _trip, CLUSTERS  # noqa: E402


def test_right_half_of_intra_cut_sees_following_depot_leg():
    # corsa 07:00-07:40 Passetto → Tavernelle passando per Cavour (07:20); poi
    # rientro in deposito 07:45-09:00; corsa 09:10-09:40 Cavour → Tavernelle
    t0 = _trip("U1", 0, 420, 460, "Passetto", "Tavernelle")
    t0["clusterStops"] = [{"stopId": "s_cav", "stopName": "Piazza Cavour", "stopSequence": 5, "clusterId": "c_cav",
                           "arrivalTime": "07:20", "departureTime": "07:20"}]
    trips = [t0,
             {"type": "depot", "routeName": "Rientro deposito", "departureMin": 465, "arrivalMin": 540,
              "firstStopName": "Tavernelle", "lastStopName": "Piazza Cavour"},
             _trip("U1", 1, 550, 580, "Piazza Cavour", "Tavernelle")]
    b = v4.parse_vehicle_blocks([{"vehicleId": "U1", "vehicleType": "12m", "category": "urbano", "trips": trips}], CLUSTERS)[0]
    cs = b.trips[0].cluster_stops[0]
    left, right = v4._split_trip_at_stop(b.trips[0], cs)
    # metà destra (Cavour → Tavernelle, stesso arrivo della corsa intera): il
    # pezzo che finisce con lei rientra col bus in deposito, niente auto
    seg_r = v4._make_segment("U1", "12m", [right], "second", 0, CLUSTERS, block=b)
    assert seg_r.start_min == cs.departure_min and seg_r.first_stop == "Piazza Cavour"
    assert seg_r.ends_at_depot and seg_r.pullin_min == 5 and seg_r.end_min == 465
    assert v4.seg_transfer_back(seg_r, CLUSTERS) == 0
    # metà sinistra: finisce a Cavour a metà corsa, nessun bordo deposito
    seg_l = v4._make_segment("U1", "12m", [left], "first", 0, CLUSTERS, block=b)
    assert not seg_l.ends_at_depot and seg_l.end_min == cs.arrival_min
    # il pezzo dopo il deposito esce dal deposito
    seg_n = v4._make_segment("U1", "12m", b.trips[1:], "second", 0, CLUSTERS, block=b)
    assert seg_n.starts_at_depot and seg_n.pullout_min == 10 and seg_n.start_min == 540


def test_same_bus_pieces_with_another_driver_between_need_cars():
    class Seg:
        def __init__(self, vid, start, end, fc, lc, fs, ls, sad=False, ead=False):
            self.vehicle_id, self.start_min, self.end_min = vid, start, end
            self.first_cluster, self.last_cluster, self.first_stop, self.last_stop = fc, lc, fs, ls
            self.starts_at_depot, self.ends_at_depot = sad, ead

    class Duty:
        def __init__(self, did, segs, t_out=10, t_back=10):
            self.driver_id, self.segments = did, segs
            self.transfer_min, self.transfer_back_min = t_out, t_back

    # A: bus V 06:00-10:00 (esce dal deposito) e di nuovo bus V 14:00-18:00 (rientra col bus);
    # B: bus V 10:00-14:00 in mezzo (monta a Cavour, smonta a Tavernelle)
    a1 = Seg("V", 360, 600, "c_cav", "c_cav", "Piazza Cavour", "Piazza Cavour", sad=True)
    a2 = Seg("V", 840, 1080, "c_tav", "c_tav", "Tavernelle", "Tavernelle", ead=True)
    b1 = Seg("V", 600, 840, "c_cav", "c_tav", "Piazza Cavour", "Tavernelle")
    A = Duty("A", [a1, a2], t_out=0, t_back=0)
    B = Duty("B", [b1], t_out=10, t_back=15)
    assert not same_bus_consecutive(a1, a2, {"V": [a1, b1, a2]})
    assert same_bus_consecutive(a1, a2, {"V": [a1, a2]})
    trips = compute_car_pool([A, B], CLUSTERS)
    kinds = sorted((t.driver_id, t.trip_type, t.cluster_name) for t in trips)
    # A torna in deposito da Cavour alle 10:00 (con l'auto di B) e riparte per Tavernelle alle 14:00
    assert ("A", "pickup", "PIAZZA CAVOUR") in kinds and ("A", "deliver", "TAVERNELLE") in kinds
    assert all(t.car_id is not None for t in trips), [(t.driver_id, t.trip_type, t.car_id) for t in trips]
    assert LAST_CAR_POOL_STATS["unpaired"] == 0 and LAST_CAR_POOL_STATS["demandPeak"] == 1


def _vtrip(idx, dep, arr, a, b, lat_a, lon_a, lat_b, lon_b):
    return vsp.Trip(idx=idx, trip_id=f"t{idx}", route_id="R1", departure_min=dep, arrival_min=arr,
                    first_stop_id=a, last_stop_id=b, first_stop_lat=lat_a, first_stop_lon=lon_a,
                    last_stop_lat=lat_b, last_stop_lon=lon_b, route_name="1", headsign="X", direction_id=0,
                    departure_time="08:00:00", arrival_time="08:30:00", first_stop_name=a, last_stop_name=b,
                    stop_count=10, required_vehicle=None, category="urbano", forced=False)


def test_forbidden_direct_repositioning_goes_via_depot():
    X, Y, Z, W = (43.60, 13.50), (43.62, 13.52), (43.64, 13.48), (43.66, 13.50)
    D = {"id": "d1", "name": "Deposito", "lat": 43.61, "lon": 13.49}
    trips = [_vtrip(0, 480, 510, "X", "Y", *X, *Y),
             _vtrip(1, 570, 600, "Z", "W", *Z, *W),   # 60' dopo: via deposito ci sta
             _vtrip(2, 525, 555, "Z", "W", *Z, *W)]   # 15' dopo: via deposito NON ci sta
    key = lambda p, q: f"{dh_key(*p)}|{dh_key(*q)}"
    d = (D["lat"], D["lon"])
    set_deadhead_matrix({key(Y, Z): DH_FORBIDDEN_KM, key(Y, d): 3.0, key(d, Z): 2.5})
    set_deadhead_min_matrix({key(Y, d): 10, key(d, Z): 8})
    try:
        arcs = vsp.build_compatible_arcs_fast(trips, vsp.VehicleCostRates(), None, depots=[D])
        by = {(a.i, a.j): a for a in arcs}
        assert (0, 1) in by and by[(0, 1)].depot_return and by[(0, 1)].dh_km == 5.5 and by[(0, 1)].dh_min == 18
        assert (0, 2) not in by
        # senza depositi la coppia vietata resta vietata
        arcs2 = vsp.build_compatible_arcs_fast(trips, vsp.VehicleCostRates(), None, depots=None)
        assert (0, 1) not in {(a.i, a.j) for a in arcs2}
    finally:
        set_deadhead_matrix(None)
        set_deadhead_min_matrix(None)
