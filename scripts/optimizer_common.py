"""
optimizer_common.py — Tipi condivisi, I/O JSON, utilità geometriche e costanti CCNL
per i solver CP-SAT Turni Macchina (vehicle_scheduler_cpsat.py)
e Turni Guida (crew_scheduler_cpsat.py).
"""

from __future__ import annotations
import json
import math
import sys
from dataclasses import dataclass, field
from typing import Any

# ═══════════════════════════════════════════════════════════════
#  COSTANTI
# ═══════════════════════════════════════════════════════════════

VEHICLE_SIZE = {"autosnodato": 4, "12m": 3, "10m": 2, "pollicino": 1}
VEHICLE_TYPES = list(VEHICLE_SIZE.keys())

MAX_DOWNSIZE_LEVELS = 1

# Deadhead / idle
MAX_DEADHEAD_KM = 30
MAX_IDLE_AT_TERMINAL = 60      # min — oltre questo, rientro deposito
MIN_LAYOVER = 3                # min — sosta minima allo stesso capolinea
DEADHEAD_BUFFER = 5            # min — aggiunto a ogni deadhead stimato
DEADHEAD_SPEED = {"urbano": 20, "extraurbano": 40}   # km/h
ROAD_CIRCUITY = 1.3            # fattore rettilinea → stradale

# Costi (€)
COST_VEHICLE_FIXED_DAY = {"autosnodato": 55, "12m": 42, "10m": 32, "pollicino": 18}
COST_VEHICLE_PER_SERVICE_KM = {"autosnodato": 1.20, "12m": 0.95, "10m": 0.75, "pollicino": 0.45}
COST_VEHICLE_PER_DEADHEAD_KM = {"autosnodato": 1.00, "12m": 0.80, "10m": 0.65, "pollicino": 0.40}
AVG_SERVICE_SPEED = {"urbano": 18, "extraurbano": 32}  # km/h
COST_PER_DRIVING_HOUR = 28
COST_PER_DEPOT_RETURN = 15
COST_PER_IDLE_HOUR = 5

# Turni guida — normativa CCNL
PRE_TURNO_MIN = 12
PRE_TURNO_AUTO_MIN = 5   # pre-turno ridotto quando si usa auto aziendale
TARGET_WORK_LOW = 390     # 6h30
TARGET_WORK_HIGH = 402    # 6h42
TARGET_WORK_MID = 396     # media
COMPANY_CARS = 5

SHIFT_RULES = {
    "intero":      {"maxNastro": 435, "intMin": 0,   "intMax": 0,   "maxPct": 100},
    "semiunico":   {"maxNastro": 555, "intMin": 75,  "intMax": 179, "maxPct": 12},
    "spezzato":    {"maxNastro": 630, "intMin": 180, "intMax": 999, "maxPct": 13},
    "supplemento": {"maxNastro": 150, "intMin": 0,   "intMax": 0,   "maxPct": 100},
}

DEPOT_TRANSFER_CENTRAL = 10
DEPOT_TRANSFER_OUTER = 15

# Pausa obbligatoria dopo guida continuativa
MAX_CONTINUOUS_DRIVING = 270   # 4h30 — oltre serve pausa ≥15 min
MIN_BREAK_AFTER_DRIVING = 15   # min

# ═══════════════════════════════════════════════════════════════
#  CLUSTER DI CAMBIO IN LINEA
# ═══════════════════════════════════════════════════════════════

@dataclass
class Cluster:
    id: str
    name: str
    keywords: list[str]
    transfer_from_depot_min: int
    stop_ids: list[str] = field(default_factory=list)    # GTFS stop_id list (from DB)
    stop_names: list[str] = field(default_factory=list)  # corrispondenti stop_name

DEFAULT_CLUSTERS = [
    Cluster("ugo_bassi",  "Piazza Ugo Bassi",   ["UGO BASSI", "U.BASSI"], 10),
    Cluster("stazione",   "Stazione FS",         ["STAZIONE F", "STAZIONE FS", "TRAIN STATION"], 10),
    Cluster("cavour",     "Piazza Cavour",       ["CAVOUR", "STAMIRA", "VECCHINI"], 10),
    Cluster("4_novembre", "Piazza IV Novembre",  ["IV NOVEMBRE", "4 NOVEMBRE"], 10),
    Cluster("tavernelle", "Tavernelle",          ["TAVERNELLE"], 10),
    Cluster("torrette",   "Ospedale Torrette",   ["OSPEDALE REGIONALE", "TORRETTE"], 15),
]


def match_cluster(stop_name: str | None, clusters: list[Cluster] | None = None,
                   stop_id: str | None = None) -> str | None:
    """Restituisce l'id del cluster. Prima cerca per stop_id, poi per keyword."""
    if not stop_name and not stop_id:
        return None
    for c in (clusters or DEFAULT_CLUSTERS):
        # Match per stop_id (prioritario — cluster dal DB)
        if stop_id and c.stop_ids and stop_id in c.stop_ids:
            return c.id
        # Match per stop_name nelle stop_names salvate dal DB
        if stop_name and c.stop_names:
            up = stop_name.upper()
            for sn in c.stop_names:
                if sn.upper() == up:
                    return c.id
    # Fallback: keyword matching (cluster hardcoded)
    if stop_name:
        up = stop_name.upper()
        for c in (clusters or DEFAULT_CLUSTERS):
            for kw in c.keywords:
                if kw in up:
                    return c.id
    return None


def cluster_by_id(cluster_id: str, clusters: list[Cluster] | None = None) -> Cluster | None:
    for c in (clusters or DEFAULT_CLUSTERS):
        if c.id == cluster_id:
            return c
    return None


def depot_transfer_min(stop_name: str | None, clusters: list[Cluster] | None = None) -> int:
    cid = match_cluster(stop_name, clusters)
    if cid:
        c = cluster_by_id(cid, clusters)
        return c.transfer_from_depot_min if c else DEPOT_TRANSFER_CENTRAL
    return DEPOT_TRANSFER_OUTER


# ═══════════════════════════════════════════════════════════════
#  DATACLASS — TIPI CONDIVISI
# ═══════════════════════════════════════════════════════════════

@dataclass
class Trip:
    """Una corsa GTFS con coordinate fermate, tipo veicolo richiesto, ecc."""
    idx: int                      # indice progressivo nel vettore trips
    trip_id: str
    route_id: str
    route_name: str
    headsign: str | None
    direction_id: int
    departure_time: str
    arrival_time: str
    departure_min: int
    arrival_min: int
    first_stop_id: str
    last_stop_id: str
    first_stop_lat: float
    first_stop_lon: float
    last_stop_lat: float
    last_stop_lon: float
    first_stop_name: str
    last_stop_name: str
    stop_count: int
    required_vehicle: str         # tipo veicolo richiesto
    category: str                 # "urbano" | "extraurbano"
    forced: bool                  # solo tipo esatto
    duration_min: int = 0


@dataclass
class Arc:
    """Arco tra due corse: costo del deadhead per il sequenziamento."""
    i: int          # indice corsa origine
    j: int          # indice corsa destinazione
    dh_km: float
    dh_min: int
    gap_min: int    # departure(j) - arrival(i)
    depot_return: bool  # gap > MAX_IDLE_AT_TERMINAL


@dataclass
class VShiftTrip:
    """Una corsa dentro un turno macchina (formato output)."""
    type: str           # "trip" | "deadhead" | "depot"
    trip_id: str
    route_id: str
    route_name: str
    headsign: str | None
    departure_time: str
    arrival_time: str
    departure_min: int
    arrival_min: int
    first_stop_name: str = ""
    last_stop_name: str = ""
    stop_count: int = 0
    duration_min: int = 0
    direction_id: int = 0
    deadhead_km: float = 0
    deadhead_min: int = 0
    downsized: bool = False
    original_vehicle: str | None = None


@dataclass
class VehicleShift:
    """Un turno macchina completo."""
    vehicle_id: str
    vehicle_type: str
    category: str
    trips: list[VShiftTrip] = field(default_factory=list)
    start_min: int = 0
    end_min: int = 0
    total_service_min: int = 0
    total_deadhead_min: int = 0
    total_deadhead_km: float = 0
    depot_returns: int = 0
    trip_count: int = 0
    fifo_order: int = 0
    first_out: int = 0
    last_in: int = 0
    shift_duration: int = 0
    downsized_trips: int = 0


@dataclass
class Task:
    """Un pezzo di lavoro atomico per i turni guida (sequenza di corse su un veicolo)."""
    idx: int
    vehicle_id: str
    vehicle_type: str
    trips: list[VShiftTrip]
    start_min: int
    end_min: int
    duration_min: int
    driving_min: int
    first_stop: str
    last_stop: str
    first_cluster: str | None
    last_cluster: str | None
    # ── Estensioni v2 ──
    granularity: str = "fine"          # "fine" | "medium" | "coarse"
    vehicle_shift_id: str | None = None  # id del turno macchina di origine
    first_lat: float = 0.0
    first_lon: float = 0.0
    last_lat: float = 0.0
    last_lon: float = 0.0


@dataclass
class CambioInfo:
    cluster: str
    cluster_name: str
    from_vehicle: str
    to_vehicle: str


@dataclass
class DutyBlock:
    task: Task
    cambio: CambioInfo | None = None


@dataclass
class Ripresa:
    blocks: list[DutyBlock]
    start_min: int
    end_min: int
    pre_turno_min: int
    transfer_min: int
    transfer_type: str      # "auto" | "bus" | "piedi"
    work_min: int


@dataclass
class Duty:
    """Un turno guida candidato (feasible per CCNL)."""
    idx: int
    duty_type: str            # "intero" | "semiunico" | "spezzato" | "supplemento"
    riprese: list[Ripresa]
    nastro_start: int
    nastro_end: int
    nastro_min: int
    work_min: int
    interruption_min: int
    transfer_min: int
    pre_turno_min: int
    cambi_count: int
    task_indices: list[int]   # indici dei Task coperti da questo duty
    # ── Estensioni v2 (cost model) ──
    cost_euro: float = 0.0                     # costo totale in euro
    cost_breakdown: Any = None                 # DutyCostBreakdown (set dal cost_model)


# ═══════════════════════════════════════════════════════════════
#  UTILITÀ GEOMETRICHE
# ═══════════════════════════════════════════════════════════════

def haversine_km(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    R = 6371.0
    rlat1, rlon1 = math.radians(lat1), math.radians(lon1)
    rlat2, rlon2 = math.radians(lat2), math.radians(lon2)
    dlat = rlat2 - rlat1
    dlon = rlon2 - rlon1
    a = math.sin(dlat / 2) ** 2 + math.cos(rlat1) * math.cos(rlat2) * math.sin(dlon / 2) ** 2
    return R * 2 * math.atan2(math.sqrt(a), math.sqrt(1 - a))


def estimate_deadhead(
    from_lat: float, from_lon: float,
    to_lat: float, to_lon: float,
    category: str = "urbano",
) -> tuple[float, int]:
    """Restituisce (km_stradali, minuti) per il deadhead."""
    straight = haversine_km(from_lat, from_lon, to_lat, to_lon)
    road_km = straight * ROAD_CIRCUITY
    speed = DEADHEAD_SPEED.get(category, 20)
    minutes = math.ceil((road_km / speed) * 60) + DEADHEAD_BUFFER
    return round(road_km, 1), minutes


def is_peak_hour(departure_min: int) -> bool:
    h = departure_min // 60
    return (7 <= h <= 9) or (17 <= h <= 19)


def can_vehicle_serve(vehicle_size: int, required_size: int) -> bool:
    if vehicle_size >= required_size:
        return True
    return (required_size - vehicle_size) <= MAX_DOWNSIZE_LEVELS


# ═══════════════════════════════════════════════════════════════
#  FORMATTAZIONE TEMPO
# ═══════════════════════════════════════════════════════════════

def min_to_time(m: int) -> str:
    h = m // 60
    mm = round(m % 60)
    return f"{h:02d}:{mm:02d}"


def fmt_dur(m: int) -> str:
    return f"{m // 60}h{round(m % 60):02d}"


# ═══════════════════════════════════════════════════════════════
#  I/O JSON
# ═══════════════════════════════════════════════════════════════

def load_input() -> dict[str, Any]:
    """Legge JSON da stdin."""
    return json.load(sys.stdin)


def write_output(data: dict[str, Any]) -> None:
    """Scrive JSON su stdout."""
    json.dump(data, sys.stdout, ensure_ascii=False)
    sys.stdout.flush()


def log(msg: str) -> None:
    """Scrive log su stderr (non inquina stdout)."""
    print(msg, file=sys.stderr, flush=True)


def report_progress(phase: str, percentage: float, detail: str, extra: dict | None = None) -> None:
    """
    Emette una riga di progresso su stderr nel formato:
      PROGRESS|phase|percentage|detail|extra_json
    Il JobManager backend parsifica queste righe e le inoltra via SSE.
    """
    pct = max(0.0, min(100.0, percentage))
    extra_str = json.dumps(extra, ensure_ascii=False) if extra else ""
    print(f"PROGRESS|{phase}|{pct:.1f}|{detail}|{extra_str}", file=sys.stderr, flush=True)


# ═══════════════════════════════════════════════════════════════
#  MERGE CONFIG OPERATORE
# ═══════════════════════════════════════════════════════════════

# Pesi default (scala 0-10, frontend li normalizza)
DEFAULT_OPERATOR_CONFIG: dict[str, Any] = {
    # shiftRules — sovrascrivibili dall'operatore
    "shiftRules": {
        "intero":      {"maxNastro": 435, "intMin": 0,   "intMax": 0,   "maxPct": 100},
        "semiunico":   {"maxNastro": 555, "intMin": 75,  "intMax": 179, "maxPct": 12},
        "spezzato":    {"maxNastro": 630, "intMin": 180, "intMax": 999, "maxPct": 13},
        "supplemento": {"maxNastro": 150, "intMin": 0,   "intMax": 0,   "maxPct": 100},
    },
    # Pesi obiettivo (0-10)
    "weights": {
        "minDrivers": 8,          # quanto minimizzare il numero conducenti
        "workBalance": 6,         # quanto bilanciare le ore lavoro
        "minCambi": 5,            # quanto penalizzare i cambi in linea
        "preferIntero": 7,        # preferenza per turni intero
        "minSupplementi": 4,      # minimizzare turni supplemento
        "qualityTarget": 5,       # quanto avvicinarsi al target 6h30-6h42
    },
    # Intensità solver (1=veloce, 2=bilanciato, 3=aggressivo)
    "solverIntensity": 2,
    # Round iterativi max
    "maxRounds": 5,
    # Vincoli fissati dall'operatore
    "pinnedConstraints": {
        "lockedDuties": [],       # driverId da mantenere invariati
        "pinnedTasks": {},         # taskIdx -> driverId forzato
        "forbidCambi": [],        # coppie (taskA, taskB) vietate come cambio
        "forceCambi": [],         # coppie (taskA, taskB) forzate come cambio
        "maxCambiPerTurno": None, # null = nessun limite extra
    },
    # Max turni (null = nessun vincolo)
    "maxDuties": None,
    # ── v2: parametri avanzati ──
    "taskGranularity": "auto",          # "auto" | "fine" | "medium" | "coarse"
    "enableCrossCluster": True,         # trasferimenti cross-cluster
    "enableTaxiFallback": True,         # taxi se auto esaurite
    "costRates": {},                    # override tariffe (CostRates fields in camelCase)
}


def merge_config(user_config: dict | None) -> dict:
    """
    Fonde la configurazione operatore con i default.
    Valida e clamp i pesi a [0, 10].
    """
    if not user_config:
        return dict(DEFAULT_OPERATOR_CONFIG)

    merged: dict[str, Any] = {}

    # shiftRules: merge per tipo
    default_rules = DEFAULT_OPERATOR_CONFIG["shiftRules"]
    user_rules = user_config.get("shiftRules", {})
    merged_rules: dict[str, dict] = {}
    for typ, defaults in default_rules.items():
        ur = user_rules.get(typ, {})
        merged_rules[typ] = {k: ur.get(k, v) for k, v in defaults.items()}
    merged["shiftRules"] = merged_rules

    # weights: merge e clamp a [0, 10]
    default_weights = DEFAULT_OPERATOR_CONFIG["weights"]
    user_weights = user_config.get("weights", {})
    merged_w: dict[str, float] = {}
    for k, v in default_weights.items():
        raw = user_weights.get(k, v)
        merged_w[k] = max(0.0, min(10.0, float(raw)))
    merged["weights"] = merged_w

    # solverIntensity
    si = user_config.get("solverIntensity", DEFAULT_OPERATOR_CONFIG["solverIntensity"])
    merged["solverIntensity"] = max(1, min(3, int(si)))

    # maxRounds
    mr = user_config.get("maxRounds", DEFAULT_OPERATOR_CONFIG["maxRounds"])
    merged["maxRounds"] = max(1, min(10, int(mr)))

    # pinnedConstraints
    default_pinned = DEFAULT_OPERATOR_CONFIG["pinnedConstraints"]
    user_pinned = user_config.get("pinnedConstraints", {})
    merged["pinnedConstraints"] = {
        k: user_pinned.get(k, v)
        for k, v in default_pinned.items()
    }

    # maxDuties
    md = user_config.get("maxDuties")
    merged["maxDuties"] = int(md) if md is not None else None

    # timeLimit viene gestito a livello di main(), non qui
    if "timeLimit" in user_config:
        merged["timeLimit"] = user_config["timeLimit"]

    # ── v2: parametri avanzati ──
    merged["taskGranularity"] = user_config.get(
        "taskGranularity", DEFAULT_OPERATOR_CONFIG["taskGranularity"])
    merged["enableCrossCluster"] = user_config.get(
        "enableCrossCluster", DEFAULT_OPERATOR_CONFIG["enableCrossCluster"])
    merged["enableTaxiFallback"] = user_config.get(
        "enableTaxiFallback", DEFAULT_OPERATOR_CONFIG["enableTaxiFallback"])
    merged["costRates"] = user_config.get("costRates", {})

    # ── v3: restrizione cambi a cluster definiti ──
    merged["cutOnlyAtClusters"] = user_config.get("cutOnlyAtClusters", True)

    return merged


def weights_to_solver_params(weights: dict[str, float]) -> dict[str, int]:
    """
    Converte i pesi 0-10 dell'operatore in pesi CP-SAT interni.
    """
    return {
        "W_CREW":       int(50_000 + weights.get("minDrivers", 8) * 10_000),
        "W_WORK_DEV":   int(5 + weights.get("workBalance", 6) * 3),
        "W_CAMBI":      int(50 + weights.get("minCambi", 5) * 50),
        "W_SEMIUNICO":  int(20 + (10 - weights.get("preferIntero", 7)) * 15),
        "W_SPEZZATO":   int(40 + (10 - weights.get("preferIntero", 7)) * 20),
        "W_SUPPL":      int(2000 + weights.get("minSupplementi", 4) * 1000),
        "W_SINGLETON":  int(4000 + weights.get("minSupplementi", 4) * 1000),
        "W_QUALITY":    int(5 + weights.get("qualityTarget", 5) * 3),
    }


# ═══════════════════════════════════════════════════════════════
#  CONVERSIONE DICTS ↔ DATACLASS
# ═══════════════════════════════════════════════════════════════

def trip_from_dict(d: dict, idx: int) -> Trip:
    dep_min = d["departureMin"]
    arr_min = d["arrivalMin"]
    return Trip(
        idx=idx,
        trip_id=d["tripId"],
        route_id=d["routeId"],
        route_name=d.get("routeName", d["routeId"]),
        headsign=d.get("headsign"),
        direction_id=d.get("directionId", 0),
        departure_time=d.get("departureTime", min_to_time(dep_min)),
        arrival_time=d.get("arrivalTime", min_to_time(arr_min)),
        departure_min=dep_min,
        arrival_min=arr_min,
        first_stop_id=d.get("firstStopId", ""),
        last_stop_id=d.get("lastStopId", ""),
        first_stop_lat=d.get("firstStopLat", 43.6),
        first_stop_lon=d.get("firstStopLon", 13.5),
        last_stop_lat=d.get("lastStopLat", 43.6),
        last_stop_lon=d.get("lastStopLon", 13.5),
        first_stop_name=d.get("firstStopName", ""),
        last_stop_name=d.get("lastStopName", ""),
        stop_count=d.get("stopCount", 0),
        required_vehicle=d.get("requiredVehicle", "12m"),
        category=d.get("category", "urbano"),
        forced=d.get("forced", False),
        duration_min=max(1, arr_min - dep_min),
    )


def vshift_trip_to_dict(t: VShiftTrip) -> dict:
    d: dict[str, Any] = {
        "type": t.type,
        "tripId": t.trip_id,
        "routeId": t.route_id,
        "routeName": t.route_name,
        "headsign": t.headsign,
        "departureTime": t.departure_time,
        "arrivalTime": t.arrival_time,
        "departureMin": t.departure_min,
        "arrivalMin": t.arrival_min,
    }
    if t.type == "trip":
        d["firstStopName"] = t.first_stop_name
        d["lastStopName"] = t.last_stop_name
        d["stopCount"] = t.stop_count
        d["durationMin"] = t.duration_min
        d["directionId"] = t.direction_id
        if t.downsized:
            d["downsized"] = True
            d["originalVehicle"] = t.original_vehicle
    elif t.type == "deadhead":
        d["deadheadKm"] = t.deadhead_km
        d["deadheadMin"] = t.deadhead_min
    return d


def vehicle_shift_to_dict(vs: VehicleShift) -> dict:
    return {
        "vehicleId": vs.vehicle_id,
        "vehicleType": vs.vehicle_type,
        "category": vs.category,
        "trips": [vshift_trip_to_dict(t) for t in vs.trips],
        "startMin": vs.start_min,
        "endMin": vs.end_min,
        "totalServiceMin": vs.total_service_min,
        "totalDeadheadMin": vs.total_deadhead_min,
        "totalDeadheadKm": round(vs.total_deadhead_km, 1),
        "depotReturns": vs.depot_returns,
        "tripCount": vs.trip_count,
        "fifoOrder": vs.fifo_order,
        "firstOut": vs.first_out,
        "lastIn": vs.last_in,
        "shiftDuration": vs.shift_duration,
        "downsizedTrips": vs.downsized_trips,
    }


# ═══════════════════════════════════════════════════════════════
#  DATACLASS — V3 (Vehicle-Shift-First)
# ═══════════════════════════════════════════════════════════════

@dataclass
class CutCandidate:
    """Un potenziale punto di taglio tra due corse consecutive in un turno macchina."""
    index: int                    # posizione nel vettore trips del VehicleBlock (taglio tra index e index+1)
    gap_min: int                  # gap tra arrivo corsa[index] e partenza corsa[index+1]
    time_min: int                 # minuto in cui avviene il taglio (arrivo corsa[index])
    stop_name: str                # fermata dove avviene il taglio
    cluster_id: str | None        # id cluster se la fermata è in un cluster
    score: float                  # punteggio qualità del taglio (più alto = meglio)
    allows_cambio: bool           # True se il taglio avviene in un cluster (cambio in linea possibile)
    left_driving_min: int         # minuti guida nella metà sinistra
    left_work_min: int            # minuti lavoro (guida + attese) nella metà sinistra
    right_driving_min: int        # minuti guida nella metà destra
    right_work_min: int           # minuti lavoro nella metà destra
    transfer_cost_min: int        # minuti di trasferimento deposito<->punto taglio


@dataclass
class Segment:
    """Una porzione di un turno macchina assegnata a un singolo conducente."""
    idx: int                      # indice globale segmento
    vehicle_id: str               # id turno macchina di provenienza
    vehicle_type: str
    trips: list[VShiftTrip]       # corse assegnate
    start_min: int
    end_min: int
    work_min: int                 # lavoro effettivo (guida + attese interne)
    driving_min: int              # solo guida
    first_stop: str
    last_stop: str
    first_cluster: str | None
    last_cluster: str | None
    half: str                     # "full" | "first" | "second" | "middle"
    cut_index: int | None         # indice del CutCandidate usato per produrre questo segmento


@dataclass
class VehicleBlock:
    """Un turno macchina parsato e analizzato per il crew scheduling v3."""
    vehicle_id: str
    vehicle_type: str
    category: str                 # "urbano" | "extraurbano"
    trips: list[VShiftTrip]       # solo type=="trip"
    start_min: int
    end_min: int
    nastro_min: int               # end_min - start_min
    driving_min: int              # somma durate corse
    work_min: int                 # driving + attese interne
    classification: str           # "CORTO" | "CORTO_BASSO" | "MEDIO" | "LUNGO"
    cut_candidates: list[CutCandidate] = field(default_factory=list)
    segments: list[Segment] = field(default_factory=list)


@dataclass
class DriverDutyV3:
    """Un turno guida v3 — più semplice di Duty, orientato ai segmenti."""
    idx: int
    driver_id: str                # es. "D001"
    duty_type: str                # "intero" | "semiunico" | "spezzato" | "supplemento"
    segments: list[Segment]       # 1 per intero/supplemento, 2 per semiunico/spezzato
    nastro_start: int
    nastro_end: int
    nastro_min: int
    work_min: int
    driving_min: int
    interruption_min: int         # 0 per intero, gap tra le due riprese per semi/spezzato
    pre_turno_min: int
    transfer_min: int             # trasferimento deposito → primo cluster (andata)
    transfer_back_min: int = 0    # trasferimento ultimo cluster → deposito (rientro)
    cambi: list[CambioInfo] = field(default_factory=list)
    cost_euro: float = 0.0
    cost_breakdown: Any = None


# ═══════════════════════════════════════════════════════════════
#  UTILITÀ DI PARSING CLUSTER
# ═══════════════════════════════════════════════════════════════

def parse_clusters_from_config(config: dict) -> list[Cluster]:
    """Parsa cluster dal JSON di config, oppure usa i default."""
    raw = config.get("clusters")
    if not raw:
        return DEFAULT_CLUSTERS
    return [
        Cluster(
            id=c["id"],
            name=c["name"],
            keywords=c.get("keywords", []),
            transfer_from_depot_min=c.get("transferFromDepotMin", DEPOT_TRANSFER_CENTRAL),
            stop_ids=c.get("stopIds", []),
            stop_names=c.get("stopNames", []),
        )
        for c in raw
    ]
