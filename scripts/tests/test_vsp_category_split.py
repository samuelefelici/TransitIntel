"""Separazione urbano/extraurbano nei turni macchina.

Regole (richiesta operatore):
1. flotte distinte: nessun arco — quindi nessuna catena — tra corse di
   categoria diversa, anche se i capolinea coincidono;
2. codifica turni distinta per rete: U### urbano, E### extraurbano,
   con numerazione separata.
"""
import sys, os
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

import vehicle_scheduler_cpsat as v


def _trip(idx, dep, arr, cat, stop="T0"):
    return v.Trip(
        idx=idx, trip_id=f"t{idx}", route_id=f"R{cat[0]}", departure_min=dep,
        arrival_min=arr, first_stop_id=stop, last_stop_id=stop,
        first_stop_lat=43.5, first_stop_lon=13.4,
        last_stop_lat=43.5, last_stop_lon=13.4,
        route_name=f"R{cat[0]}", headsign="X", direction_id=0,
        departure_time="08:00:00", arrival_time="08:30:00",
        first_stop_name="A", last_stop_name="A", stop_count=10,
        required_vehicle=None, category=cat, forced=False,
    )


def test_no_arcs_between_categories():
    # stesso capolinea, orari perfettamente concatenabili: senza il vincolo
    # di categoria l'arco urbano→extraurbano esisterebbe di sicuro
    trips = [
        _trip(0, 480, 510, "urbano"),
        _trip(1, 520, 550, "extraurbano"),
        _trip(2, 560, 590, "urbano"),
    ]
    arcs = v.build_compatible_arcs_fast(trips, v.VehicleCostRates(), None)
    for a in arcs:
        assert trips[a.i].category == trips[a.j].category, \
            f"arco misto vietato: {trips[a.i].category} -> {trips[a.j].category}"
    # il concatenamento urbano→urbano (0→2) deve invece esserci
    assert any(a.i == 0 and a.j == 2 for a in arcs)


def test_vehicle_compatible_rejects_mixed_categories():
    u = _trip(0, 480, 510, "urbano")
    e = _trip(1, 520, 550, "extraurbano")
    assert v.trips_vehicle_compatible(u, e) is False
    assert v.trips_vehicle_compatible(u, _trip(2, 520, 550, "urbano")) is True


def test_shift_codes_prefixed_and_numbered_per_category():
    trips = [
        _trip(0, 480, 510, "urbano"),
        _trip(1, 480, 510, "extraurbano"),
        _trip(2, 600, 630, "urbano"),
        _trip(3, 600, 630, "extraurbano"),
    ]
    chains = [[0], [1], [2], [3]]
    shifts = v.chains_to_shifts(chains, trips, {}, v.VehicleCostRates())
    codes = [s.vehicle_id for s in shifts]
    assert codes == ["U001", "E001", "U002", "E002"]
    cats = [s.category for s in shifts]
    assert cats == ["urbano", "extraurbano", "urbano", "extraurbano"]
