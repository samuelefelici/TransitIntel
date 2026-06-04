"""Test unitari per crew_transport.py — trasporto multimodale dei conducenti.

Copre: estrazione passaggi su bus (deadhead), assegnazione taxi, riuso auto ai
cluster con sosta massima, conteggio parco (interval colouring), flag conflitti.
"""

from crew_scheduler_v3 import CarTrip
from crew_transport import (
    TransportParams, BusRide, extract_bus_rides, free_ride_index, plan_car_pool,
)


# ── helpers ──────────────────────────────────────────────────────

def deliver(cluster, arrive, transfer=10, driver="D"):
    """Consegna (entrante): auto deposito→cluster, arriva al cluster a `arrive`."""
    return CarTrip(driver_id=driver, cluster_id=cluster, cluster_name=cluster,
                   stop_name=cluster, trip_type="deliver",
                   depart_min=arrive - transfer, arrive_min=arrive, transfer_min=transfer)


def pickup(cluster, depart, transfer=10, driver="D"):
    """Prelievo (uscente): auto cluster→deposito, parte dal cluster a `depart`."""
    return CarTrip(driver_id=driver, cluster_id=cluster, cluster_name=cluster,
                   stop_name=cluster, trip_type="pickup",
                   depart_min=depart, arrive_min=depart + transfer, transfer_min=transfer)


def ride(direction, cluster, t, seats=3, veh="BUS1"):
    return BusRide(direction, cluster, t, veh, seats)


# ── riuso auto entro la sosta massima ────────────────────────────

def test_riuso_auto_entro_max_idle():
    """Consegna alle 10:00 e prelievo alle 10:45 stesso cluster: UNA sola auto serve
    entrambi (riuso), idle 45'."""
    p = TransportParams(n_cars=5, car_max_idle_min=120)
    d = deliver("X", 600); u = pickup("X", 645)
    res = plan_car_pool([d, u], rides=[], params=p)
    assert res.n_pairs == 1
    assert res.fleet_peak == 1
    assert res.max_idle_min == 45
    assert d.mode == "car" and u.mode == "car"
    assert d.car_id == u.car_id          # stessa auto
    assert res.n_conflicts == 0 and res.n_depot_shuttle == 0


def test_default_sosta_massima_15min():
    """Regola operativa: chiavi a bordo → auto incustodita al cluster max 15'.
    È il default. Oltre i 15' non c'è riuso; entro i 15' sì."""
    assert TransportParams(n_cars=5).car_max_idle_min == 15
    # divario 20' > 15' → niente riuso: entrambi serviti da navetta dal deposito
    d, u = deliver("X", 600), pickup("X", 620)
    res = plan_car_pool([d, u], rides=[], params=TransportParams(n_cars=5))
    assert res.n_pairs == 0 and res.n_depot_shuttle == 2 and res.n_conflicts == 0
    assert d.from_depot and u.from_depot
    # divario 12' ≤ 15' → riuso con una sola auto
    d2, u2 = deliver("Y", 600), pickup("Y", 612)
    res2 = plan_car_pool([d2, u2], rides=[], params=TransportParams(n_cars=5))
    assert res2.n_pairs == 1 and res2.max_idle_min == 12 and d2.car_id == u2.car_id


def test_no_riuso_oltre_max_idle():
    """Prelievo troppo distante dalla consegna (oltre max_idle): niente riuso →
    entrambi serviti da navetta auto dal deposito (non è un conflitto)."""
    p = TransportParams(n_cars=5, car_max_idle_min=60)
    d = deliver("X", 600); u = pickup("X", 800)   # 200' > 60'
    res = plan_car_pool([d, u], rides=[], params=p)
    assert res.n_pairs == 0
    assert res.n_depot_shuttle == 2 and d.from_depot and u.from_depot
    assert res.n_conflicts == 0


def test_conflitto_solo_se_cap_superato():
    """Con cap=1 e due navette sovrapposte nel tempo, la seconda resta senza auto."""
    p = TransportParams(n_cars=1, car_max_idle_min=10)
    # due prelievi simultanei a cluster diversi → 2 auto necessarie, cap=1
    u1 = pickup("X", 600); u2 = pickup("Y", 600)
    res = plan_car_pool([u1, u2], rides=[], params=p)
    assert res.fleet_peak == 2
    assert res.n_conflicts == 1            # una sola auto disponibile
    assert sum(1 for t in (u1, u2) if t.conflict) == 1


def test_riuso_a_catena_una_sola_auto():
    """Tre scambi sequenziali allo stesso cluster (consegna→prelievo→consegna→...)
    non sovrapposti: una sola auto li copre tutti in sequenza."""
    p = TransportParams(n_cars=5, car_max_idle_min=60)
    trips = [deliver("X", 600), pickup("X", 630),
             deliver("X", 700), pickup("X", 730),
             deliver("X", 800), pickup("X", 830)]
    res = plan_car_pool(trips, rides=[], params=p)
    assert res.n_pairs == 3
    assert res.fleet_peak == 1            # riusata in sequenza
    assert all(t.car_id == 1 for t in trips)


def test_carpool_due_scambi_una_sola_auto():
    """Due scambi nello stesso istante/cluster: con auto da 4 posti un'unica vettura
    porta i 2 entranti e riporta i 2 uscenti (carpool)."""
    p = TransportParams(n_cars=5, car_max_idle_min=60, car_seats=4)
    trips = [deliver("X", 600), pickup("X", 600),
             deliver("X", 600), pickup("X", 600)]
    res = plan_car_pool(trips, rides=[], params=p)
    assert res.fleet_peak == 1                 # carpool: una sola auto
    assert len({t.car_id for t in trips}) == 1


def test_carpool_capienza_limita_il_gruppo():
    """Cinque entranti simultanei con auto da 4 posti: servono 2 vetture."""
    p = TransportParams(n_cars=5, car_seats=4, pool_window_min=15)
    trips = [deliver("X", 600) for _ in range(5)]
    res = plan_car_pool(trips, rides=[], params=p)
    assert res.n_depot_shuttle == 2            # gruppi da 4 e da 1
    assert res.fleet_peak == 2


# ── taxi su bus (passeggero su deadhead) ─────────────────────────

def test_taxi_assorbe_sbilanciamento():
    """Consegna isolata (nessun prelievo da accoppiare) ma c'è un pull-out verso lo
    stesso cluster poco prima: il conducente entrante viaggia GRATIS in taxi."""
    p = TransportParams(n_cars=5, car_max_idle_min=60, ride_window_min=30)
    d = deliver("X", 600)                  # entrante a X alle 10:00
    r = ride("to_cluster", "X", 580)       # bus deposita a X alle 9:40 (entro 30')
    res = plan_car_pool([d], rides=[r], params=p)
    assert res.n_bus_rides == 1
    assert d.mode == "bus" and d.car_id is None and d.ride_vehicle_id == "BUS1"
    assert res.fleet_peak == 0             # nessuna auto usata


def test_taxi_non_applicabile_fuori_finestra():
    """Pull-out troppo lontano nel tempo: niente taxi, serve l'auto."""
    p = TransportParams(n_cars=5, car_max_idle_min=60, ride_window_min=30)
    d = deliver("X", 600)
    r = ride("to_cluster", "X", 500)       # 100' prima → oltre finestra
    res = plan_car_pool([d], rides=[r], params=p)
    assert res.n_bus_rides == 0
    assert d.mode == "car"


def test_taxi_rispetta_posti():
    """Un solo posto sul bus: solo un conducente viaggia in taxi, l'altro no."""
    p = TransportParams(n_cars=5, car_max_idle_min=60, ride_window_min=30)
    d1 = deliver("X", 600, driver="A"); d2 = deliver("X", 600, driver="B")
    r = ride("to_cluster", "X", 590, seats=1)
    res = plan_car_pool([d1, d2], rides=[r], params=p)
    assert res.n_bus_rides == 1
    modes = sorted([d1.mode, d2.mode])
    assert modes == ["bus", "car"]


# ── la coppia (riuso) ha la precedenza sul taxi (no regressioni) ──

def test_taxi_ha_la_precedenza_poi_auto():
    """Il taxi gratis viene assegnato per primo: l'entrante con un pull-out viaggia in
    taxi, l'uscente (senza bus) rientra in auto."""
    p = TransportParams(n_cars=5, car_max_idle_min=120, ride_window_min=60)
    d = deliver("X", 600); u = pickup("X", 640)
    r = ride("to_cluster", "X", 590)       # solo per l'entrante
    res = plan_car_pool([d, u], rides=[r], params=p)
    assert d.mode == "bus" and u.mode == "car"
    assert res.n_bus_rides == 1 and res.fleet_peak == 1


def test_coppia_interamente_in_taxi_zero_auto():
    """Se SIA l'entrante SIA l'uscente hanno un bus disponibile, lo scambio non usa
    alcuna auto."""
    p = TransportParams(n_cars=5, car_max_idle_min=120, ride_window_min=60)
    d = deliver("X", 600); u = pickup("X", 640)
    rides = [ride("to_cluster", "X", 590), ride("to_depot", "X", 650)]
    res = plan_car_pool([d, u], rides=rides, params=p)
    assert res.fleet_peak == 0
    assert res.n_bus_rides == 2 and res.n_pairs == 0
    assert d.mode == "bus" and u.mode == "bus"


def test_solo_chi_ha_il_bus_va_in_taxi():
    """Posti solo sul to_cluster: l'entrante va in taxi, l'uscente (nessun posto sul
    to_depot) rientra in auto-navetta."""
    p = TransportParams(n_cars=5, car_max_idle_min=120, ride_window_min=60)
    d = deliver("X", 600); u = pickup("X", 640)
    rides = [ride("to_cluster", "X", 590, seats=3), ride("to_depot", "X", 650, seats=0)]
    res = plan_car_pool([d, u], rides=rides, params=p)
    assert d.mode == "bus" and u.mode == "car"
    assert res.n_bus_rides == 1 and res.n_depot_shuttle == 1 and res.fleet_peak == 1


# ── estrazione deadhead dai blocchi ──────────────────────────────

def test_extract_bus_rides_e_index():
    from optimizer_common import VehicleBlock, VShiftTrip, Cluster

    def vt(dep, arr, fs, ls):
        return VShiftTrip(type="trip", trip_id="t", route_id="r", route_name="r",
                          headsign=None, departure_time="", arrival_time="",
                          departure_min=dep, arrival_min=arr, first_stop_name=fs,
                          last_stop_name=ls, stop_count=2, duration_min=arr - dep,
                          direction_id=0)
    blk = VehicleBlock(vehicle_id="V1", vehicle_type="12m", category="urbano",
                       trips=[vt(360, 400, "Stazione FS", "Capo"),
                              vt(1100, 1140, "Capo", "Stazione FS")],
                       start_min=360, end_min=1140, nastro_min=780, driving_min=80,
                       work_min=780, classification="", cut_candidates=[], segments=[])
    clusters = [Cluster(id="staz", name="Stazione FS", keywords=["STAZIONE"],
                        transfer_from_depot_min=10, stop_names=["Stazione FS"])]
    rides = extract_bus_rides([blk], clusters)
    dirs = sorted((r.direction, r.cluster_id, r.time_min) for r in rides)
    assert dirs == [("to_cluster", "staz", 360), ("to_depot", "staz", 1140)]

    has = free_ride_index([blk], clusters, window=30)
    assert has("to_cluster", "staz", 380)      # pull-out alle 360, entro 30'
    assert not has("to_cluster", "staz", 500)  # troppo tardi
    assert has("to_depot", "staz", 1120)       # pull-in alle 1140, entro 30'
