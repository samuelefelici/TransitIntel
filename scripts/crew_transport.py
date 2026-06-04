"""crew_transport.py — Trasporto multimodale dei conducenti verso/dai cambi in linea.

Quando un conducente deve raggiungere o lasciare un punto di cambio in linea (un
cluster) senza guidare un bus, può essere trasportato in due modi:

  1. PASSEGGERO SU BUS ("taxi", gratuito): chi esce dal deposito con un bus
     (pull-out) o vi rientra guidandolo (pull-in) può portare con sé un collega.
     Questi movimenti deposito↔cluster sono FISSI: dipendono dal timetable dei
     turni macchina, non da come si assegnano i conducenti.

  2. AUTOVETTURA AZIENDALE: pool limitato. Un'auto portata a un cluster da un
     conducente entrante può essere RIPRESA da un conducente uscente dallo stesso
     cluster (riuso), a patto che non resti in sosta incustodita oltre
     `car_max_idle_min`. Le auto sono conservate: ogni viaggio è deposito↔cluster.

Strategia (priorità a costo crescente, senza regressioni sul pairing esistente):
  a. Accoppia, per ogni cluster, i prelievi (uscenti) con le consegne (entranti)
     già parcheggiate, in ordine cronologico ed entro `car_max_idle_min`. Una
     sola auto serve così due conducenti (consegna entrante → sosta → ripresa
     uscente) — è la generalizzazione dello "scambio bus" oltre il simultaneo.
  b. I conducenti rimasti spaiati (sbilanciamento consegne/prelievi a un cluster)
     vengono serviti, se possibile, da un PASSAGGIO SU BUS gratuito.
  c. Ciò che resta richiede comunque un'auto dedicata (consegna che resterebbe in
     sosta oltre il massimo → `idle_violation`; prelievo senza auto reperibile →
     `conflict`, da coprire con una vettura inviata a vuoto).
  d. I "compiti auto" risultanti (intervalli fuori-deposito) vengono colorati: il
     numero di colori = auto in uso simultaneo (dimensione minima del parco).
"""

from __future__ import annotations

import heapq
from dataclasses import dataclass, field

from optimizer_common import (
    Cluster,
    VehicleBlock,
    match_cluster,
)


# ════════════════════════════════════════════════════════════════
#  Parametri di trasporto
# ════════════════════════════════════════════════════════════════

@dataclass
class TransportParams:
    n_cars: int = 5                 # vetture aziendali disponibili (cap simultaneo)
    car_max_idle_min: int = 15      # sosta MASSIMA di un'auto incustodita a un cluster:
                                    # le chiavi restano a bordo, non può restare di più
    car_seats: int = 4              # conducenti per autovettura (uno guida, gli altri
                                    # rientrano/escono insieme — carpool)
    pool_window_min: int = 15       # scarto massimo d'orario per condividere la stessa auto
    ride_window_min: int = 30       # attesa massima di un conducente per il "taxi" su bus
    ride_seats: int = 3             # passeggeri trasportabili per ogni deadhead bus

    @classmethod
    def from_config(cls, config: dict | None, n_cars: int) -> "TransportParams":
        cfg = (config or {})
        bus = cfg.get("busPool", {}) if isinstance(cfg.get("busPool"), dict) else {}
        car = cfg.get("carPool", {}) if isinstance(cfg.get("carPool"), dict) else {}
        return cls(
            n_cars=n_cars,
            car_max_idle_min=int(car.get("maxIdleMin", cfg.get("carMaxIdleMin", 15))),
            car_seats=int(car.get("seats", cfg.get("carSeats", 4))),
            pool_window_min=int(car.get("poolWindowMin", cfg.get("carPoolWindowMin", 15))),
            ride_window_min=int(bus.get("rideWindowMin", cfg.get("busRideWindowMin", 30))),
            ride_seats=int(bus.get("rideSeats", cfg.get("busRideSeats", 3))),
        )


# ════════════════════════════════════════════════════════════════
#  Passaggi su bus (deadhead deposito↔cluster) — FISSI dal timetable
# ════════════════════════════════════════════════════════════════

@dataclass
class BusRide:
    direction: str       # "to_cluster" (pull-out) | "to_depot" (pull-in)
    cluster_id: str
    time_min: int        # arrivo al cluster (to_cluster) o partenza dal cluster (to_depot)
    vehicle_id: str
    seats_left: int


def extract_bus_rides(blocks: list[VehicleBlock], clusters: list[Cluster],
                      seats: int = 3) -> list[BusRide]:
    """Ogni turno macchina genera un pull-out (deposito→primo capolinea) e un
    pull-in (ultimo capolinea→deposito) che possono trasportare conducenti.
    Indipendenti dall'assegnazione dei conducenti."""
    rides: list[BusRide] = []
    for b in blocks:
        if not b.trips:
            continue
        c_out = match_cluster(b.trips[0].first_stop_name, clusters)
        if c_out:
            rides.append(BusRide("to_cluster", c_out, b.trips[0].departure_min, b.vehicle_id, seats))
        c_in = match_cluster(b.trips[-1].last_stop_name, clusters)
        if c_in:
            rides.append(BusRide("to_depot", c_in, b.trips[-1].arrival_min, b.vehicle_id, seats))
    return rides


def _ride_fits(ride: BusRide, direction: str, cluster_id: str,
               need_min: int, window: int) -> bool:
    """Un passaggio è compatibile se stesso cluster/direzione e l'orario è coerente:
    - to_cluster: il bus deposita il passeggero a `ride.time_min` ≤ orario di servizio
      (entro `window` di attesa al capolinea).
    - to_depot: il bus parte a `ride.time_min` ≥ fine servizio (entro `window`)."""
    if ride.seats_left <= 0 or ride.direction != direction or ride.cluster_id != cluster_id:
        return False
    if direction == "to_cluster":
        return 0 <= (need_min - ride.time_min) <= window
    return 0 <= (ride.time_min - need_min) <= window


def free_ride_index(blocks: list[VehicleBlock], clusters: list[Cluster],
                    window: int = 30):
    """Indice (FISSO) per il solver: dato (direzione, cluster, orario) dice se esiste
    un deadhead bus che può trasportare gratis il conducente. Le capacità non sono
    considerate qui (stima ottimistica lato solver; il piano definitivo è post-solve)."""
    rides = extract_bus_rides(blocks, clusters, seats=10**9)

    def has_ride(direction: str, cluster_id: str | None, need_min: int) -> bool:
        if not cluster_id:
            return False
        return any(_ride_fits(r, direction, cluster_id, need_min, window) for r in rides)

    return has_ride


# ════════════════════════════════════════════════════════════════
#  Pianificazione del pool auto con riuso + taxi sui rimasti
# ════════════════════════════════════════════════════════════════

@dataclass
class PlanResult:
    fleet_peak: int = 0          # auto in uso simultaneo (= dimensione parco necessaria)
    n_bus_rides: int = 0         # conducenti trasportati gratis su bus
    n_car_trips: int = 0         # tratte effettive in autovettura
    n_pairs: int = 0             # scambi serviti da un'unica auto riusata (≤ 15')
    n_depot_shuttle: int = 0     # tratte auto dal deposito senza riuso (navetta dedicata)
    n_conflicts: int = 0         # tratte rimaste senza auto (cap del parco superato)
    max_idle_min: int = 0        # sosta massima osservata di un'auto al cluster
    notes: list[str] = field(default_factory=list)


def _find_ride(rides: list[BusRide], direction: str, cluster_id: str | None,
               need_min: int, window: int) -> BusRide | None:
    """Primo deadhead bus compatibile con un posto libero (None se nessuno)."""
    for r in rides:
        if _ride_fits(r, direction, cluster_id, need_min, window):
            return r
    return None


def _try_bus(trip, rides: list[BusRide], direction: str, need_min: int,
             window: int) -> bool:
    r = _find_ride(rides, direction, trip.cluster_id, need_min, window)
    if r is None:
        return False
    r.seats_left -= 1
    trip.mode = "bus"
    trip.car_id = None
    trip.ride_vehicle_id = r.vehicle_id
    return True


@dataclass
class _Group:
    """Un gruppo di conducenti che condividono la STESSA autovettura su una tratta
    deposito↔cluster (uno guida, gli altri sono passeggeri — carpool)."""
    cluster_id: str
    kind: str                 # "deliver" (verso il cluster) | "pickup" (verso il deposito)
    time_min: int             # quando l'auto è al cluster (arrivo deliver / partenza pickup)
    transfer_min: int
    trips: list


def _pool(items: list, kind: str, window: int, seats: int) -> list[_Group]:
    """Raggruppa domande dello stesso cluster/direzione, vicine nel tempo, in auto da
    `seats` posti. Per i deliver l'auto arriva entro il primo orario richiesto (gli
    altri attendono ≤ window); per i pickup parte all'ultimo (gli altri attendono)."""
    key = (lambda t: t.arrive_min) if kind == "deliver" else (lambda t: t.depart_min)
    items = sorted(items, key=key)
    groups: list[_Group] = []
    cur: list = []
    for t in items:
        if cur and (len(cur) >= seats or abs(key(t) - key(cur[0])) > window):
            groups.append(_mk_group(cur, kind))
            cur = []
        cur.append(t)
    if cur:
        groups.append(_mk_group(cur, kind))
    return groups


def _mk_group(trips: list, kind: str) -> _Group:
    tr = max(t.transfer_min for t in trips)
    if kind == "deliver":          # l'auto deve essere al cluster per il PRIMO che inizia
        t_cluster = min(t.arrive_min for t in trips)
    else:                          # parte quando l'ULTIMO uscente è pronto
        t_cluster = max(t.depart_min for t in trips)
    return _Group(trips[0].cluster_id or "?", kind, t_cluster, tr, trips)


def plan_car_pool(trips: list, rides: list[BusRide], params: TransportParams) -> PlanResult:
    """Arricchisce in-place i CarTrip (mode/car_id/flags) e ritorna le metriche.

    Priorità: taxi su bus (gratis) → carpool in auto con riuso (un'auto porta più
    conducenti e viene ripresa entro 15') → navetta dal deposito per i rimasti.

    `trips` sono le DOMANDE di trasporto (deliver = entrante verso il cluster,
    pickup = uscente verso il deposito)."""
    res = PlanResult()

    # ── (a) Taxi su bus: assegna i deadhead disponibili (gratis, limitati dai posti) ──
    car_delivers: list = []
    car_pickups: list = []
    for t in trips:
        if t.trip_type == "deliver":
            if _try_bus(t, rides, "to_cluster", t.arrive_min, params.ride_window_min):
                res.n_bus_rides += 1
            else:
                car_delivers.append(t)
        else:
            if _try_bus(t, rides, "to_depot", t.depart_min, params.ride_window_min):
                res.n_bus_rides += 1
            else:
                car_pickups.append(t)

    # ── (b) Carpool: raggruppa per cluster i conducenti in auto da `car_seats` ──
    by_cluster: dict[str, dict[str, list]] = {}
    for t in car_delivers:
        by_cluster.setdefault(t.cluster_id or "?", {"deliver": [], "pickup": []})["deliver"].append(t)
    for t in car_pickups:
        by_cluster.setdefault(t.cluster_id or "?", {"deliver": [], "pickup": []})["pickup"].append(t)

    car_tasks: list[dict] = []          # {start, end, trips:[...]}
    leftover_dg: list[_Group] = []
    leftover_pg: list[_Group] = []

    for cid, slot in by_cluster.items():
        dgroups = _pool(slot["deliver"], "deliver", params.pool_window_min, params.car_seats)
        pgroups = _pool(slot["pickup"], "pickup", params.pool_window_min, params.car_seats)

        # ── (c) Riuso: un'auto-carpool arrivata col gruppo entrante viene ripresa dal
        #        gruppo uscente entro car_max_idle_min (la sosta incustodita ≤ 15'). ──
        parked: list[_Group] = []
        di = 0
        dgroups.sort(key=lambda g: g.time_min)
        pgroups.sort(key=lambda g: g.time_min)
        for pg in pgroups:
            while di < len(dgroups) and dgroups[di].time_min <= pg.time_min:
                parked.append(dgroups[di]); di += 1
            while parked and (pg.time_min - parked[0].time_min) > params.car_max_idle_min:
                leftover_dg.append(parked.pop(0))
            if parked:
                dg = parked.pop(0)
                res.max_idle_min = max(res.max_idle_min, pg.time_min - dg.time_min)
                res.n_pairs += 1
                # un'auto: esce col gruppo entrante, sosta ≤15', rientra col gruppo uscente
                car_tasks.append({"start": dg.time_min - dg.transfer_min,
                                  "end": pg.time_min + pg.transfer_min,
                                  "trips": dg.trips + pg.trips})
            else:
                leftover_pg.append(pg)
        leftover_dg.extend(parked)
        leftover_dg.extend(dgroups[di:])

    # ── (d) Navetta dal deposito per i gruppi rimasti (round-trip, mai sosta >15') ──
    for dg in leftover_dg:
        res.n_depot_shuttle += 1
        for t in dg.trips:
            t.from_depot = True
        car_tasks.append({"start": dg.time_min - dg.transfer_min,
                          "end": dg.time_min + dg.transfer_min, "trips": dg.trips})
    for pg in leftover_pg:
        res.n_depot_shuttle += 1
        for t in pg.trips:
            t.from_depot = True
        car_tasks.append({"start": pg.time_min - pg.transfer_min,
                          "end": pg.time_min + pg.transfer_min, "trips": pg.trips})

    # ── (e) Colorazione intervalli → numero minimo di auto simultanee ──
    res.fleet_peak = _color_tasks(car_tasks, params.n_cars)
    res.n_conflicts = sum(1 for t in trips if t.conflict)   # solo se il cap è superato
    res.n_car_trips = len(car_tasks)
    if res.n_depot_shuttle:
        res.notes.append(f"{res.n_depot_shuttle} navette auto dal deposito (senza riuso)")
    if res.n_conflicts:
        res.notes.append(f"{res.n_conflicts} conducenti senza auto: cap parco ({params.n_cars}) superato")
    return res


def _color_tasks(tasks: list[dict], n_cars: int) -> int:
    """Assegna un car_id a ogni compito auto riusando le vetture (interval colouring).
    Ritorna il picco di auto simultanee. Se eccede n_cars, alcuni viaggi restano
    senza auto (car_id None) — segnale di violazione del cap."""
    tasks.sort(key=lambda t: t["start"])
    free: list[int] = []          # car_id disponibili in deposito (min-heap)
    busy: list[tuple[int, int]] = []   # (end_min, car_id)
    next_id = 1
    peak = 0
    for t in tasks:
        while busy and busy[0][0] <= t["start"]:
            _, cid = heapq.heappop(busy)
            heapq.heappush(free, cid)
        if free:
            cid = heapq.heappop(free)
        else:
            cid = next_id
            next_id += 1
        over_cap = n_cars > 0 and cid > n_cars
        for tr in t["trips"]:
            tr.mode = "car"
            tr.car_id = None if over_cap else cid
            tr.conflict = over_cap
        heapq.heappush(busy, (t["end"], cid))
        peak = max(peak, len(busy))
    return peak
