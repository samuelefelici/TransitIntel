"""Il corrispettivo €/km sui km a vuoto, corsa per corsa (tappa 6.29).

Prima il motore dei turni macchina pesava ogni km a vuoto al netto di 2,60
€/km scritti nel codice (il corrispettivo dell'urbano di Ancona), per tutte le
reti. Ora ogni corsa porta quello della sua rete (dalla pagina Reti e linee):
0 se la rete non lo paga sui km a vuoto, e allora quei km costano per intero.
"""
import sys, os
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

import vehicle_scheduler_cpsat as v
from optimizer_common import Arc, VehicleCostRates, corrispettivo_vuoti, trip_from_dict


def _trip(idx, dep, arr, corr):
    t = v.Trip(
        idx=idx, trip_id=f"t{idx}", route_id="R", departure_min=dep,
        arrival_min=arr, first_stop_id="A", last_stop_id="B",
        first_stop_lat=43.5, first_stop_lon=13.4,
        last_stop_lat=43.6, last_stop_lon=13.5,
        route_name="R", headsign="X", direction_id=0,
        departure_time="08:00:00", arrival_time="08:30:00",
        first_stop_name="A", last_stop_name="B", stop_count=10,
        required_vehicle="12m", category="extraurbano", forced=False,
    )
    t.corrispettivo_vuoti = corr
    return t


def test_la_corsa_porta_il_suo_corrispettivo():
    base = {"tripId": "t1", "routeId": "R", "departureMin": 480, "arrivalMin": 510}
    assert trip_from_dict({**base, "corrispettivoVuoti": 1.66}, 0).corrispettivo_vuoti == 1.66
    assert trip_from_dict({**base, "corrispettivoVuoti": 0}, 0).corrispettivo_vuoti == 0.0
    for no in (None, -1, "due", float("nan")):
        assert trip_from_dict({**base, "corrispettivoVuoti": no}, 0).corrispettivo_vuoti is None
    assert trip_from_dict(base, 0).corrispettivo_vuoti is None


def test_senza_il_suo_vale_quello_generale():
    r = VehicleCostRates()
    assert corrispettivo_vuoti(_trip(0, 480, 510, None), r) == 0.0
    r.corrispettivo_per_km = 2.0
    assert corrispettivo_vuoti(_trip(0, 480, 510, None), r) == 2.0
    assert corrispettivo_vuoti(_trip(0, 480, 510, 1.66), r) == 1.66


def test_il_vuoto_prende_il_corrispettivo_della_corsa_che_va_a_servire():
    r = VehicleCostRates()
    arco = Arc(i=0, j=1, dh_km=10.0, dh_min=15, gap_min=40, depot_return=False)
    lookup = {(0, 1): arco}

    def costo(corr_della_seconda):
        trips = [_trip(0, 480, 510, 1.66), _trip(1, 550, 580, corr_della_seconda)]
        return v.chain_cost_detailed([0, 1], trips, lookup, r).deadhead_km_cost

    pagato = costo(1.66)
    non_pagato = costo(0.0)
    # pagato sui vuoti: i 10 km sono compensati, resta il tempo del conducente
    assert abs(pagato - 15 * r.driver_cost_per_min) < 1e-9
    # non pagato: i 10 km costano per intero
    assert abs(non_pagato - pagato - 10 * r.per_deadhead_km["12m"]) < 1e-9
