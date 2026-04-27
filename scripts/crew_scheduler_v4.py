#!/usr/bin/env python3
"""
crew_scheduler_v4.py — Crew Scheduler Multi-Scenario (RD 131/1938)
Conerobus S.p.A. / TransitIntel

APPROCCIO VSF (Vehicle-Shift-First) con normativa RD 131/1938:
  - Regio Decreto 131/1938 per autoservizi pubblici di trasporto
  - PrePostRules: preturno 12min (solo con bus), post = solo trasferimento vuoto
  - Guida continuativa max 4h30, sosta ≥15min azzera continuità
  - Intero: nastro max 7h15, lavoro max 7h15, ≥1 sosta 15min al capolinea
  - Semiunico: nastro max 9h15, interruzione 1h15–2h59 in deposito, lavoro max 8h
  - Spezzato: nastro max 10h30, interruzione ≥3h, lavoro max 7h30
  - Supplemento: nastro max 2h30 straordinario
  - Intervallo pasto (pranzo/cena)
  - Stacco minimo differenziato
  - Multi-scenario: genera 8-20 scenari CP-SAT, sceglie il migliore
  - Preferenza tagli al capolinea su fermate intermedie

Pipeline:
  1. parse_vehicle_blocks     — JSON → VehicleBlock[]
  2. analyze_vehicle_block    — punti di taglio con bonus capolinea
  3. collassa_cambi           — collasso gap < 45min tra tagli
  4. classify_blocks          — CORTO / CORTO_BASSO / MEDIO / LUNGO
  5. build_initial_segments   — applica tagli, genera segmenti
  6. optimize_multi_scenario  — N scenari CP-SAT con seed e noise diversi
  7. classify_duty            — classificazione post-hoc RD 131/1938
  8. validate_all_bds         — validazione RD 131 + BDS
  9. compute_costs            — costi con pre/post multi-livello
  10. serialize_output        — JSON per il backend
"""

from __future__ import annotations

import json
import sys
import time
import signal
import threading
from dataclasses import dataclass, field
from typing import Any

from ortools.sat.python import cp_model

from optimizer_common import (
    # Costanti
    SHIFT_RULES, PRE_TURNO_MIN, PRE_TURNO_AUTO_MIN,
    DEPOT_TRANSFER_CENTRAL, DEPOT_TRANSFER_OUTER,
    MAX_CONTINUOUS_DRIVING, MIN_BREAK_AFTER_DRIVING,
    TARGET_WORK_LOW, TARGET_WORK_HIGH, TARGET_WORK_MID,
    COMPANY_CARS,
    # Dataclass esistenti
    VShiftTrip, VehicleShift, CambioInfo, ClusterStop,
    VehicleBlock, CutCandidate, Segment, DriverDutyV3,
    Cluster, DEFAULT_CLUSTERS,
    # BDS dataclass
    PrePostRules, CEE561Config, RD131Config, IntervalloPastoConfig,
    StaccoMinimo, GestoreRiprese, CoperturaSosteConfig,
    CollegamentoConfig, WorkCalculation, BDSValidation,
    # Funzioni
    match_cluster, cluster_by_id, depot_transfer_min,
    build_cluster_stop_lookup,
    min_to_time, fmt_dur,
    load_input, write_output, log, report_progress,
    merge_config, parse_clusters_from_config,
)
from cost_model import CostRates, DutyCostBreakdown, compute_duty_cost


# ----------------------------------------------------------------
# Graceful SIGINT
# ----------------------------------------------------------------
_stop_requested = threading.Event()

def _handle_sigint(signum, frame):
    log("[V4] SIGINT received - requesting graceful stop...")
    _stop_requested.set()

signal.signal(signal.SIGINT, _handle_sigint)

# ----------------------------------------------------------------
# Cost scale
# ----------------------------------------------------------------
COST_SCALE = 100

# ----------------------------------------------------------------
# Classificazione turni macchina
# ----------------------------------------------------------------
NASTRO_INTERO_MAX = 435
DRIVING_BASSO_THRESHOLD = 120
NASTRO_LUNGO_THRESHOLD = 555     # 9h15 (semiunico max) → oltre serve 3 conducenti
MIN_CUT_GAP = 3
SUPPLEMENTO_NASTRO_MAX = 150
COLLASSA_MIN_GAP = 45  # gap minimo tra tagli per collasso


def apply_shift_rules_override(cfg: dict) -> None:
    """Permette all'utente di sovrascrivere SHIFT_RULES e costanti correlate
    da config.bds.shiftRules. Modifica le globali IN-PLACE prima di ogni run.

    Schema atteso:
      config.bds.shiftRules = {
        "intero":      {"maxNastro": 435, "maxLavoro": 435, "sostaMinCapolinea": 15},
        "semiunico":   {"maxNastro": 555, "maxLavoro": 480, "intMin": 75, "intMax": 179, "maxPct": 12},
        "spezzato":    {"maxNastro": 630, "maxLavoro": 450, "intMin": 180, "intMax": 999, "maxPct": 13},
        "supplemento": {"maxNastro": 150, "maxLavoro": 150}
      }
      config.bds.targetWork = {"low": 390, "high": 435, "mid": 408}
    """
    global NASTRO_INTERO_MAX, NASTRO_LUNGO_THRESHOLD, SUPPLEMENTO_NASTRO_MAX
    global TARGET_WORK_LOW, TARGET_WORK_HIGH, TARGET_WORK_MID

    bds = cfg.get("bds", {}) if cfg else {}
    overrides = bds.get("shiftRules") or {}
    if not overrides:
        return

    for duty_type in ("intero", "semiunico", "spezzato", "supplemento"):
        ov = overrides.get(duty_type)
        if not ov:
            continue
        if duty_type not in SHIFT_RULES:
            continue
        for k in ("maxNastro", "maxLavoro", "intMin", "intMax", "maxPct", "sostaMinCapolinea"):
            if k in ov:
                try:
                    SHIFT_RULES[duty_type][k] = int(ov[k])
                except (ValueError, TypeError):
                    pass

    # Aggiorna costanti derivate
    if "intero" in overrides and "maxNastro" in overrides["intero"]:
        NASTRO_INTERO_MAX = SHIFT_RULES["intero"]["maxNastro"]
    if "semiunico" in overrides and "maxNastro" in overrides["semiunico"]:
        NASTRO_LUNGO_THRESHOLD = SHIFT_RULES["semiunico"]["maxNastro"]
    if "supplemento" in overrides and "maxNastro" in overrides["supplemento"]:
        SUPPLEMENTO_NASTRO_MAX = SHIFT_RULES["supplemento"]["maxNastro"]

    target = bds.get("targetWork") or {}
    if "low" in target:
        TARGET_WORK_LOW = int(target["low"])
    if "high" in target:
        TARGET_WORK_HIGH = int(target["high"])
    if "mid" in target:
        TARGET_WORK_MID = int(target["mid"])

    log(f"[V4] SHIFT_RULES override applicato: "
        f"intero={SHIFT_RULES['intero']['maxNastro']}/{SHIFT_RULES['intero']['maxLavoro']}, "
        f"semi={SHIFT_RULES['semiunico']['maxNastro']}/{SHIFT_RULES['semiunico']['maxLavoro']}, "
        f"spez={SHIFT_RULES['spezzato']['maxNastro']}/{SHIFT_RULES['spezzato']['maxLavoro']}, "
        f"target=[{TARGET_WORK_LOW},{TARGET_WORK_HIGH}]")


# ----------------------------------------------------------------
# Iperparametri ottimizzatore CP-SAT (override-abili da UI)
# ----------------------------------------------------------------
# Saturazione: lavoro minimo (minuti) per un turno "intero" o pair principale.
# Sotto questa soglia, il segmento NON puo' essere assegnato come single intero
# se esiste almeno un pair che lo copre (forza accorpamento → meno turni vuoti).
MIN_WORK_PER_DUTY = 360            # 6h00

# Cap HARD sulle vetture aziendali necessarie ai trasferimenti a vuoto driver
# (transfer fra fine s1 e inizio s2 di un pair semiunico/spezzato).
# Vincolo cumulative: massimo MAX_COMPANY_CARS pair "in trasferimento" in
# qualunque istante del giorno.
MAX_COMPANY_CARS = COMPANY_CARS    # default 5

# FIX-CSP-1: Peso per minimizzare aggressivamente il numero di turni.
# Default alzato da 5000 a 20000 per dominare le differenze di costo orario
# tra "1 pair lungo" vs "2 single corti" che oggi rendono 5000 insufficiente.
# Letto da config.bds.optimizer.weightDutyCount.
WEIGHT_DUTY_COUNT = 20000          # = ~200 € extra "virtuali" per ogni turno

# FIX-CSP-1: Penalita per minuto di idle (nastro - lavoro) sui single non
# supplemento. CAPPATA a IDLE_PENALTY_MAX_MIN minuti per evitare doppia
# penalita' con work_imbalance_per_min che gia' copre la deviazione dal target.
WEIGHT_IDLE_PENALTY = 30
IDLE_PENALTY_MAX_MIN = 60          # cap sopra il quale non aumenta piu'

# FIX-CSP-2: score penalty per turno totale, applicata in _score_solution.
# Rappresenta il "costo nascosto" per turno (reperibilita', gestione HR, ferie).
# Permette al portfolio di preferire scenari con MENO turni anche se costo +1-2%.
# Letto da config.bds.optimizer.scorePerDuty.
SCORE_PER_DUTY = 100.0


def apply_optimizer_overrides(cfg: dict) -> None:
    """Applica override agli iperparametri di ottimizzazione da
    config.bds.optimizer. Modifica le globali IN-PLACE.

    Schema atteso:
      config.bds.optimizer = {
        "minWorkPerDuty": 360,     # minuti lavoro min per turno intero/pair
        "maxCompanyCars": 5,       # cap HARD vetture aziendali simultanee
        "weightDutyCount": 5000,   # peso per minimizzare N turni guida
        "weightIdlePenalty": 30    # peso per minuto idle (nastro - lavoro)
      }
    """
    global MIN_WORK_PER_DUTY, MAX_COMPANY_CARS
    global WEIGHT_DUTY_COUNT, WEIGHT_IDLE_PENALTY, IDLE_PENALTY_MAX_MIN
    global SCORE_PER_DUTY

    bds = cfg.get("bds", {}) if cfg else {}
    opt = bds.get("optimizer") or {}
    if not opt:
        return

    def _set_int(key: str, current: int) -> int:
        if key in opt:
            try:
                return int(opt[key])
            except (ValueError, TypeError):
                return current
        return current

    def _set_float(key: str, current: float) -> float:
        if key in opt:
            try:
                return float(opt[key])
            except (ValueError, TypeError):
                return current
        return current

    MIN_WORK_PER_DUTY    = _set_int("minWorkPerDuty",    MIN_WORK_PER_DUTY)
    MAX_COMPANY_CARS     = _set_int("maxCompanyCars",    MAX_COMPANY_CARS)
    WEIGHT_DUTY_COUNT    = _set_int("weightDutyCount",   WEIGHT_DUTY_COUNT)
    WEIGHT_IDLE_PENALTY  = _set_int("weightIdlePenalty", WEIGHT_IDLE_PENALTY)
    IDLE_PENALTY_MAX_MIN = _set_int("idlePenaltyMaxMin", IDLE_PENALTY_MAX_MIN)
    SCORE_PER_DUTY       = _set_float("scorePerDuty",    SCORE_PER_DUTY)

    log(f"[V4] Optimizer overrides: minWork={MIN_WORK_PER_DUTY}min, "
        f"maxCompanyCars={MAX_COMPANY_CARS}, "
        f"wDuty={WEIGHT_DUTY_COUNT}, wIdle={WEIGHT_IDLE_PENALTY} (cap {IDLE_PENALTY_MAX_MIN}min), "
        f"scorePerDuty={SCORE_PER_DUTY}")


# ----------------------------------------------------------------
# Multi-scenario
# ----------------------------------------------------------------
MIN_SCENARIOS = 14                 # minimo scenari (intensita 1)
MAX_SCENARIOS = 36                 # massimo scenari (intensita 3)
DEFAULT_SCENARIOS = 24             # intensita 2 (medio)
SCENARIO_TIME_FRACTION = 0.78     # 78% agli scenari, 22% alla polish phase
SCENARIO_MIN_BUDGET = 6           # almeno 6s per scenario (piu scenari -> meno tempo ciascuno)
POLISH_TIME_FRACTION = 0.20       # 20% del tempo totale alla rifinitura finale
POLISH_MIN_BUDGET = 15            # almeno 15s alla polish

# ----------------------------------------------------------------
# Portfolio di strategie (obiettivi alternativi)
# Ogni strategia riscala selettivamente i pesi dell'obiettivo CP-SAT
# per esplorare soluzioni strutturalmente diverse.
# ----------------------------------------------------------------
SCENARIO_STRATEGIES = {
    "balanced":         {"label": "Bilanciato",           "desc": "Costo + qualita in equilibrio (baseline)",        "mul_cost": 1.0, "mul_balance": 1.0, "mul_suppl": 1.0, "mul_spezz": 1.0, "mul_transfer": 1.0},
    "min_cost":         {"label": "Minimo costo",          "desc": "Spinge al risparmio puro (orario)",               "mul_cost": 1.4, "mul_balance": 0.6, "mul_suppl": 0.8, "mul_spezz": 0.8, "mul_transfer": 0.8},
    "min_drivers":      {"label": "Meno autisti",          "desc": "Favorisce pair (meno turni totali)",              "mul_cost": 1.1, "mul_balance": 0.8, "mul_suppl": 3.0, "mul_spezz": 0.5, "mul_transfer": 1.0},
    "max_quality":      {"label": "Alta qualita",          "desc": "Carichi di lavoro bilanciati",                    "mul_cost": 0.9, "mul_balance": 2.5, "mul_suppl": 1.2, "mul_spezz": 1.2, "mul_transfer": 1.0},
    "min_supplementi":  {"label": "Zero supplementi",      "desc": "Elimina straordinari",                            "mul_cost": 1.0, "mul_balance": 1.0, "mul_suppl": 5.0, "mul_spezz": 1.0, "mul_transfer": 1.0},
    "min_spezzati":     {"label": "Zero spezzati",         "desc": "Evita turni spezzati (preferisce interi/semi)",   "mul_cost": 1.0, "mul_balance": 1.0, "mul_suppl": 1.0, "mul_spezz": 4.0, "mul_transfer": 1.0},
    "min_transfer":     {"label": "Minimi cambi",          "desc": "Minimizza trasferimenti/auto aziendali",          "mul_cost": 1.0, "mul_balance": 1.0, "mul_suppl": 1.0, "mul_spezz": 1.5, "mul_transfer": 3.0},
    "aggressive":       {"label": "Aggressivo",            "desc": "Costo bassissimo anche con semi/spezz",           "mul_cost": 1.8, "mul_balance": 0.4, "mul_suppl": 0.5, "mul_spezz": 0.6, "mul_transfer": 0.7},
}

# Container globali: metriche di tutti gli scenari + analisi dell'ultima run
# (letti da main() per serializzare nell'output)
LAST_SCENARIO_RESULTS: list[dict] = []
LAST_OPTIMIZATION_ANALYSIS: dict = {}

# ----------------------------------------------------------------
# Scoring tagli
# ----------------------------------------------------------------
CUT_SCORE_GAP_BASE = 1.0
CUT_SCORE_GAP_BONUS_PER_MIN = 0.1
CUT_SCORE_CLUSTER_BONUS = 3.0
CUT_SCORE_BALANCE_MAX = 5.0
CUT_NASTRO_PENALTY_PER_MIN = 0.05
CUT_SAME_ROUTE_PENALTY = 15.0
CUT_NO_CLUSTER_PENALTY = 8.0
CUT_SCORE_CAPOLINEA_BONUS = 5.0   # bonus per tagli al capolinea con sosta ≥ 15min

# ----------------------------------------------------------------
# Costi cambio conducente
# ----------------------------------------------------------------
INTER_CAMBIO_COST_EUR = 5.0    # cambio al capolinea (tra corse)
INTRA_CAMBIO_COST_EUR = 15.0   # cambio a fermata intermedia (intra-corsa)

# ----------------------------------------------------------------
# Scoring intra-trip cut
# ----------------------------------------------------------------
INTRA_MIN_SOSTA = 2            # minuti minimi di sosta alla fermata per tentare un taglio intra
INTRA_SCORE_BASE = -2.0        # penalità base vs inter (l'intra è meno desiderabile)
INTRA_CLUSTER_BONUS = 2.0      # bonus se la fermata intermedia è in cluster
INTRA_BALANCE_MAX = 4.0        # bonus max per bilanciamento


# ═══════════════════════════════════════════════════════════════
#  BDS CONFIG BUNDLE
# ═══════════════════════════════════════════════════════════════

@dataclass
class BDSConfig:
    """Bundle di tutte le configurazioni BDS (normativa RD 131/1938)."""
    pre_post: PrePostRules = field(default_factory=PrePostRules)
    rd131: RD131Config = field(default_factory=RD131Config)
    pasto: IntervalloPastoConfig = field(default_factory=IntervalloPastoConfig)
    stacco: StaccoMinimo = field(default_factory=StaccoMinimo)
    riprese: GestoreRiprese = field(default_factory=GestoreRiprese)
    copertura: CoperturaSosteConfig = field(default_factory=CoperturaSosteConfig)
    collegamento: CollegamentoConfig = field(default_factory=CollegamentoConfig)

    @property
    def cee561(self) -> RD131Config:
        """Alias retrocompatibilità."""
        return self.rd131

    @classmethod
    def from_config(cls, cfg: dict) -> "BDSConfig":
        bds = cfg.get("bds", {})
        return cls(
            pre_post=PrePostRules.from_config(bds.get("prePost")),
            rd131=RD131Config.from_config(bds.get("rd131") or bds.get("cee561")),
            pasto=IntervalloPastoConfig.from_config(bds.get("pasto")),
            stacco=StaccoMinimo.from_config(bds.get("stacco")),
            riprese=GestoreRiprese.from_config(bds.get("riprese")),
            copertura=CoperturaSosteConfig.from_config(bds.get("copertura")),
            collegamento=CollegamentoConfig.from_config(bds.get("collegamento")),
        )

    def to_dict(self) -> dict:
        return {
            "prePost": self.pre_post.to_dict(),
            "rd131": self.rd131.to_dict(),
            "cee561": self.rd131.to_dict(),  # retrocompat
            "pasto": self.pasto.to_dict(),
            "stacco": self.stacco.to_dict(),
            "riprese": self.riprese.to_dict(),
            "copertura": self.copertura.to_dict(),
            "collegamento": self.collegamento.to_dict(),
        }


# ═══════════════════════════════════════════════════════════════
#  FUNZIONI DI SUPPORTO PRE/POST BDS
# ═══════════════════════════════════════════════════════════════

def pre_turno_bds(is_depot: bool, pp: PrePostRules) -> int:
    """Pre-turno BDS: deposito vs cambio in linea."""
    return pp.pre_turno_deposito if is_depot else pp.pre_turno_cambio


def post_turno_bds(is_depot: bool, pp: PrePostRules) -> int:
    """Post-turno BDS: deposito vs cambio in linea."""
    return pp.post_turno_deposito if is_depot else pp.post_turno_cambio


def pre_turno_for(transfer_min: int) -> int:
    """Pre-turno legacy: 5 min se auto aziendale, 12 min altrimenti."""
    return PRE_TURNO_AUTO_MIN if transfer_min > 0 else PRE_TURNO_MIN


def compute_pre_post_total(
    duty: DriverDutyV3,
    pp: PrePostRules,
    clusters: list[Cluster],
) -> int:
    """Calcola il totale tempi pre/post BDS per un turno guida."""
    total = 0
    n_segs = len(duty.segments)
    if n_segs == 0:
        return 0

    first_seg = duty.segments[0]
    last_seg = duty.segments[-1]

    # Pre-turno: deposito se ha trasferimento, cambio altrimenti
    is_depot_start = duty.transfer_min > 0
    total += pre_turno_bds(is_depot_start, pp)

    # Post-turno
    is_depot_end = duty.transfer_back_min > 0
    total += post_turno_bds(is_depot_end, pp)

    # Se biripresa (2+ segmenti), aggiungi pre/post ripresa
    if n_segs >= 2:
        total += pp.post_ripresa  # fine prima ripresa
        total += pp.pre_ripresa   # inizio seconda ripresa

    # Pre/post pezzo per cambi in linea (veicoli diversi nello stesso segmento)
    for seg in duty.segments:
        if hasattr(seg, '_n_cambi') and seg._n_cambi > 0:
            total += seg._n_cambi * (pp.pre_pezzo_cambio + pp.post_pezzo_cambio)

    return total


# ═══════════════════════════════════════════════════════════════
#  FASE 1: PARSING
# ═══════════════════════════════════════════════════════════════

def _hhmm_to_min(s: str) -> int:
    """Converte 'HH:MM:SS' o 'HH:MM' in minuti dal mezzanotte. Supporta >24h per GTFS."""
    if not s:
        return 0
    parts = s.split(":")
    h = int(parts[0]) if len(parts) > 0 else 0
    m = int(parts[1]) if len(parts) > 1 else 0
    return h * 60 + m


def parse_vehicle_blocks(vehicle_shifts: list[dict], clusters: list[Cluster]) -> list[VehicleBlock]:
    """Converte i turni macchina JSON in VehicleBlock."""
    blocks: list[VehicleBlock] = []

    for vs_dict in vehicle_shifts:
        vid = vs_dict.get("vehicleId", "?")
        vtype = vs_dict.get("vehicleType", "12m")
        category = vs_dict.get("category", "urbano")

        raw_trips = vs_dict.get("trips", [])
        trips: list[VShiftTrip] = []
        for t in raw_trips:
            if t.get("type") != "trip":
                continue

            # Parse clusterStops dal JSON (aggiunto dal backend)
            raw_cs = t.get("clusterStops", [])
            cluster_stops: list[ClusterStop] = []
            for cs in raw_cs:
                cluster_stops.append(ClusterStop(
                    stop_id=cs.get("stopId", ""),
                    stop_name=cs.get("stopName", ""),
                    stop_sequence=cs.get("stopSequence", 0),
                    cluster_id=cs.get("clusterId", ""),
                    arrival_min=_hhmm_to_min(cs.get("arrivalTime", "")),
                    departure_min=_hhmm_to_min(cs.get("departureTime", "")),
                ))

            trips.append(VShiftTrip(
                type="trip",
                trip_id=t.get("tripId", ""),
                route_id=t.get("routeId", ""),
                route_name=t.get("routeName", ""),
                headsign=t.get("headsign"),
                departure_time=t.get("departureTime", ""),
                arrival_time=t.get("arrivalTime", ""),
                departure_min=t.get("departureMin", 0),
                arrival_min=t.get("arrivalMin", 0),
                first_stop_name=t.get("firstStopName", ""),
                last_stop_name=t.get("lastStopName", ""),
                stop_count=t.get("stopCount", 0),
                duration_min=t.get("durationMin", 0),
                direction_id=t.get("directionId", 0),
                cluster_stops=cluster_stops,
            ))

        if not trips:
            continue

        trips.sort(key=lambda t: t.departure_min)
        start = trips[0].departure_min
        end = trips[-1].arrival_min
        driving = sum(t.arrival_min - t.departure_min for t in trips)

        blocks.append(VehicleBlock(
            vehicle_id=vid,
            vehicle_type=vtype,
            category=category,
            trips=trips,
            start_min=start,
            end_min=end,
            nastro_min=end - start,
            driving_min=driving,
            work_min=end - start,
            classification="",
        ))

    blocks.sort(key=lambda b: b.start_min)
    return blocks


# ═══════════════════════════════════════════════════════════════
#  FASE 2: ANALISI PUNTI DI TAGLIO CON BDS
# ═══════════════════════════════════════════════════════════════

def analyze_vehicle_block(
    block: VehicleBlock,
    clusters: list[Cluster],
    bds: BDSConfig,
) -> None:
    """Identifica punti di taglio con scoring BDS-aware (copertura soste)."""
    trips = block.trips
    if len(trips) < 2:
        return

    candidates: list[CutCandidate] = []
    total_driving = block.driving_min

    # Pre-calcola driving cumulativo
    cum_driving = [0]
    for t in trips:
        cum_driving.append(cum_driving[-1] + (t.arrival_min - t.departure_min))

    for i in range(len(trips) - 1):
        gap = trips[i + 1].departure_min - trips[i].arrival_min
        if gap < MIN_CUT_GAP:
            continue

        cut_time = trips[i].arrival_min
        stop_name = trips[i].last_stop_name
        cid = match_cluster(stop_name, clusters)
        transfer_cost = depot_transfer_min(stop_name, clusters)

        left_driving = cum_driving[i + 1]
        right_driving = total_driving - left_driving
        left_work = trips[i].arrival_min - trips[0].departure_min
        right_work = trips[-1].arrival_min - trips[i + 1].departure_min

        # ── Scoring ──
        score = 0.0

        # Bonus gap
        if gap >= 5:
            score += CUT_SCORE_GAP_BASE + (gap - 5) * CUT_SCORE_GAP_BONUS_PER_MIN

        # Cluster bonus/penalità
        if cid:
            score += CUT_SCORE_CLUSTER_BONUS
        else:
            score -= CUT_NO_CLUSTER_PENALTY

        # ── BDS Copertura Soste ──
        # Un gap coperto dalla copertura soste NON è un buon taglio (la sosta
        # è coperta dal conducente in testa, non deve essere interrotta)
        min_sosta = bds.copertura.min_sosta_cambio_urbano
        if block.category == "extraurbano":
            min_sosta = bds.copertura.min_sosta_cambio_extra
        if gap > 0 and gap < min_sosta:
            # Sosta troppo breve per essere un punto di cambio
            score -= 5.0

        # Struttura radiale: penalità capolinea periferico
        trip_before = trips[i]
        trip_after = trips[i + 1]
        same_route = (trip_before.route_id and trip_after.route_id
                      and trip_before.route_id == trip_after.route_id)
        diff_direction = trip_before.direction_id != trip_after.direction_id

        if same_route and diff_direction:
            score -= CUT_SAME_ROUTE_PENALTY * 1.5
        elif same_route:
            if not cid:
                score -= CUT_SAME_ROUTE_PENALTY
            elif gap < 15:
                score -= CUT_SAME_ROUTE_PENALTY * 0.5

        if not same_route and not cid:
            score -= CUT_NO_CLUSTER_PENALTY * 0.5

        # Bilanciamento
        if total_driving > 0:
            balance = 1.0 - abs(left_driving - right_driving) / total_driving
            score += balance * CUT_SCORE_BALANCE_MAX

        # ── RD 131/1938: bonus capolinea con sosta ≥ 15min ──
        if cid and gap >= 15:
            score += CUT_SCORE_CAPOLINEA_BONUS

        # Penalità nastro
        max_nastro = SHIFT_RULES["intero"]["maxNastro"]
        left_nastro = left_work + pre_turno_for(transfer_cost) + transfer_cost * 2
        right_nastro = right_work + pre_turno_for(transfer_cost) + transfer_cost * 2
        if left_nastro > max_nastro:
            score -= (left_nastro - max_nastro) * CUT_NASTRO_PENALTY_PER_MIN
        if right_nastro > max_nastro:
            score -= (right_nastro - max_nastro) * CUT_NASTRO_PENALTY_PER_MIN

        candidates.append(CutCandidate(
            index=i,
            gap_min=gap,
            time_min=cut_time,
            stop_name=stop_name,
            cluster_id=cid,
            score=score,
            allows_cambio=cid is not None,
            left_driving_min=left_driving,
            left_work_min=left_work,
            right_driving_min=right_driving,
            right_work_min=right_work,
            transfer_cost_min=transfer_cost,
            cut_type="inter",
        ))

    # ── Tagli INTRA-CORSA: a fermate intermedie in cluster ──
    # Per ogni corsa che ha cluster_stops, valutiamo se una fermata intermedia
    # può essere un punto di cambio conducente dentro la corsa.
    for i, trip in enumerate(trips):
        if not trip.cluster_stops:
            continue
        for cs in trip.cluster_stops:
            if cs.arrival_min <= 0:
                continue
            # La fermata deve essere intermedia (non primo/ultimo stop della corsa)
            if cs.arrival_min <= trip.departure_min or cs.arrival_min >= trip.arrival_min:
                continue

            cut_time_intra = cs.arrival_min
            cid_intra = cs.cluster_id
            if not cid_intra:
                continue  # deve essere in un cluster

            transfer_cost_intra = depot_transfer_min(cs.stop_name, clusters)

            # Driving/work split per intra: la corsa trip[i] viene spezzata al minuto cs.arrival_min
            left_driving_intra = cum_driving[i] + (cs.arrival_min - trip.departure_min)
            right_driving_intra = total_driving - left_driving_intra
            left_work_intra = cs.arrival_min - trips[0].departure_min
            right_work_intra = trips[-1].arrival_min - cs.departure_min

            # ── Scoring intra ──
            score_intra = INTRA_SCORE_BASE  # penalità base vs inter

            # Bonus cluster (sempre in cluster per intra)
            score_intra += INTRA_CLUSTER_BONUS

            # Bilanciamento
            if total_driving > 0:
                balance_intra = 1.0 - abs(left_driving_intra - right_driving_intra) / total_driving
                score_intra += balance_intra * INTRA_BALANCE_MAX

            # Penalità nastro
            max_nastro = SHIFT_RULES["intero"]["maxNastro"]
            left_nastro_i = left_work_intra + pre_turno_for(transfer_cost_intra) + transfer_cost_intra * 2
            right_nastro_i = right_work_intra + pre_turno_for(transfer_cost_intra) + transfer_cost_intra * 2
            if left_nastro_i > max_nastro:
                score_intra -= (left_nastro_i - max_nastro) * CUT_NASTRO_PENALTY_PER_MIN
            if right_nastro_i > max_nastro:
                score_intra -= (right_nastro_i - max_nastro) * CUT_NASTRO_PENALTY_PER_MIN

            candidates.append(CutCandidate(
                index=i,
                gap_min=0,  # nessun gap: il taglio è dentro la corsa
                time_min=cut_time_intra,
                stop_name=cs.stop_name,
                cluster_id=cid_intra,
                score=score_intra,
                allows_cambio=True,
                left_driving_min=left_driving_intra,
                left_work_min=left_work_intra,
                right_driving_min=right_driving_intra,
                right_work_min=right_work_intra,
                transfer_cost_min=transfer_cost_intra,
                cut_type="intra",
                stop_sequence=cs.stop_sequence,
                stop_id=cs.stop_id,
                trip_id=trip.trip_id,
                route_name=trip.route_name,
            ))

    candidates.sort(key=lambda c: -c.score)
    block.cut_candidates = candidates


# ═══════════════════════════════════════════════════════════════
#  FASE 2B: COLLASSA CAMBI
# ═══════════════════════════════════════════════════════════════

def collassa_cambi(blocks: list[VehicleBlock], min_gap: int = COLLASSA_MIN_GAP) -> None:
    """Collassa tagli troppo vicini: se due tagli distano < min_gap min, tieni solo il migliore.
    Ispirato a BDS collassa_cambi: evita tagli che generano segmenti troppo corti."""
    for b in blocks:
        if len(b.cut_candidates) < 2:
            continue

        # Ordina per posizione (index)
        sorted_cuts = sorted(b.cut_candidates, key=lambda c: c.index)
        keep: list[CutCandidate] = [sorted_cuts[0]]

        for c in sorted_cuts[1:]:
            last = keep[-1]
            gap_between = c.time_min - last.time_min
            if gap_between < min_gap:
                # Tieni quello con score migliore
                if c.score > last.score:
                    keep[-1] = c
            else:
                keep.append(c)

        removed = len(b.cut_candidates) - len(keep)
        if removed > 0:
            log(f"  {b.vehicle_id}: collassati {removed} tagli troppo vicini")

        # Riordina per score
        keep.sort(key=lambda c: -c.score)
        b.cut_candidates = keep


def filter_cuts_by_cluster(blocks: list[VehicleBlock], config: dict) -> None:
    """Se cutOnlyAtClusters=true, rimuove i tagli non su cluster."""
    cut_only = config.get("cutOnlyAtClusters", True)
    if not cut_only:
        return
    for b in blocks:
        original = len(b.cut_candidates)
        b.cut_candidates = [c for c in b.cut_candidates if c.allows_cambio]
        filtered = original - len(b.cut_candidates)
        if filtered > 0:
            log(f"  {b.vehicle_id}: rimossi {filtered}/{original} tagli non su cluster")


# ═══════════════════════════════════════════════════════════════
#  FASE 2C: CLASSIFICAZIONE BLOCCHI
# ═══════════════════════════════════════════════════════════════

def classify_blocks(blocks: list[VehicleBlock], clusters: list[Cluster]) -> None:
    """Classifica ogni blocco in CORTO, CORTO_BASSO, MEDIO, LUNGO."""
    for b in blocks:
        first_stop = b.trips[0].first_stop_name if b.trips else ""
        last_stop = b.trips[-1].last_stop_name if b.trips else ""
        transfer = depot_transfer_min(first_stop, clusters)
        transfer_back = depot_transfer_min(last_stop, clusters)
        nastro = b.nastro_min + pre_turno_for(transfer) + transfer + transfer_back

        if nastro <= NASTRO_INTERO_MAX:
            if b.driving_min < DRIVING_BASSO_THRESHOLD:
                b.classification = "CORTO_BASSO"
            else:
                b.classification = "CORTO"
        elif nastro <= NASTRO_LUNGO_THRESHOLD:
            b.classification = "MEDIO"
        else:
            b.classification = "LUNGO"


# ═══════════════════════════════════════════════════════════════
#  FASE 3: COSTRUZIONE SEGMENTI
# ═══════════════════════════════════════════════════════════════

_seg_counter = 0

def _next_seg_idx() -> int:
    global _seg_counter
    _seg_counter += 1
    return _seg_counter - 1


def _make_segment(
    vehicle_id: str,
    vehicle_type: str,
    trips: list[VShiftTrip],
    half: str,
    cut_index: int | None,
    clusters: list[Cluster],
) -> Segment:
    start = trips[0].departure_min
    end = trips[-1].arrival_min
    driving = sum(t.arrival_min - t.departure_min for t in trips)
    first_stop = trips[0].first_stop_name
    last_stop = trips[-1].last_stop_name
    return Segment(
        idx=_next_seg_idx(),
        vehicle_id=vehicle_id,
        vehicle_type=vehicle_type,
        trips=trips,
        start_min=start,
        end_min=end,
        work_min=end - start,
        driving_min=driving,
        first_stop=first_stop,
        last_stop=last_stop,
        first_cluster=match_cluster(first_stop, clusters),
        last_cluster=match_cluster(last_stop, clusters),
        half=half,
        cut_index=cut_index,
    )


def _split_trip_at_stop(trip: VShiftTrip, cs: ClusterStop) -> tuple[VShiftTrip, VShiftTrip]:
    """Spezza una corsa in due sub-trip al cluster stop intermedio.
    
    trip_a: partenza originale → arrivo a cs (prima metà)
    trip_b: partenza da cs → arrivo originale (seconda metà)
    """
    trip_a = VShiftTrip(
        type="trip",
        trip_id=trip.trip_id,
        route_id=trip.route_id,
        route_name=trip.route_name,
        headsign=trip.headsign,
        departure_time=trip.departure_time,
        arrival_time=min_to_time(cs.arrival_min),
        departure_min=trip.departure_min,
        arrival_min=cs.arrival_min,
        first_stop_name=trip.first_stop_name,
        last_stop_name=cs.stop_name,
        stop_count=cs.stop_sequence,  # approssimazione
        duration_min=cs.arrival_min - trip.departure_min,
        direction_id=trip.direction_id,
    )
    trip_b = VShiftTrip(
        type="trip",
        trip_id=trip.trip_id,
        route_id=trip.route_id,
        route_name=trip.route_name,
        headsign=trip.headsign,
        departure_time=min_to_time(cs.departure_min if cs.departure_min > 0 else cs.arrival_min),
        arrival_time=trip.arrival_time,
        departure_min=cs.departure_min if cs.departure_min > 0 else cs.arrival_min,
        arrival_min=trip.arrival_min,
        first_stop_name=cs.stop_name,
        last_stop_name=trip.last_stop_name,
        stop_count=max(0, trip.stop_count - cs.stop_sequence),
        duration_min=trip.arrival_min - (cs.departure_min if cs.departure_min > 0 else cs.arrival_min),
        direction_id=trip.direction_id,
    )
    return trip_a, trip_b


def _split_trips_for_cut(block: VehicleBlock, cut: CutCandidate) -> tuple[list[VShiftTrip], list[VShiftTrip]]:
    """Genera left_trips e right_trips per un taglio, gestendo sia inter che intra."""
    trips = block.trips
    if cut.cut_type == "inter":
        # Taglio classico tra trips[index] e trips[index+1]
        return trips[:cut.index + 1], trips[cut.index + 1:]
    else:
        # Taglio INTRA: spezza trips[index] al stop_sequence
        trip = trips[cut.index]
        # Trova il ClusterStop corrispondente
        cs_match = None
        for cs in trip.cluster_stops:
            if cs.stop_id == cut.stop_id and cs.stop_sequence == cut.stop_sequence:
                cs_match = cs
                break
        if cs_match is None:
            # Fallback: cerca per stop_id
            for cs in trip.cluster_stops:
                if cs.stop_id == cut.stop_id:
                    cs_match = cs
                    break
        if cs_match is None:
            # Non trovato — fallback a inter
            log(f"  WARN: intra cut stop_id={cut.stop_id} not found in trip {trip.trip_id}, fallback inter")
            return trips[:cut.index + 1], trips[cut.index + 1:]

        trip_a, trip_b = _split_trip_at_stop(trip, cs_match)
        left_trips = list(trips[:cut.index]) + [trip_a]
        right_trips = [trip_b] + list(trips[cut.index + 1:])
        return left_trips, right_trips


def _select_best_cut(b: VehicleBlock, clusters: list[Cluster]) -> CutCandidate | None:
    """Seleziona il miglior taglio per un blocco MEDIO. Gestisce sia inter che intra."""
    max_nastro = SHIFT_RULES["intero"]["maxNastro"]
    valid_cuts: list[CutCandidate] = []

    for c in b.cut_candidates:
        left_first = b.trips[0].first_stop_name
        if c.cut_type == "intra":
            left_last = c.stop_name  # fermata intermedia
            right_first = c.stop_name
        else:
            left_last = b.trips[c.index].last_stop_name
            right_first = b.trips[c.index + 1].first_stop_name if c.index + 1 < len(b.trips) else ""
        right_last = b.trips[-1].last_stop_name

        lt_out = depot_transfer_min(left_first, clusters)
        lt_back = depot_transfer_min(left_last, clusters)
        rt_out = depot_transfer_min(right_first, clusters)
        rt_back = depot_transfer_min(right_last, clusters)
        left_nastro = c.left_work_min + pre_turno_for(lt_out) + lt_out + lt_back
        right_nastro = c.right_work_min + pre_turno_for(rt_out) + rt_out + rt_back

        if left_nastro <= max_nastro and right_nastro <= max_nastro:
            valid_cuts.append(c)

    if valid_cuts:
        return max(valid_cuts, key=lambda c: c.score)

    if b.cut_candidates:
        def worst_nastro(c: CutCandidate) -> int:
            lf = b.trips[0].first_stop_name
            if c.cut_type == "intra":
                ll = c.stop_name
                rf = c.stop_name
            else:
                ll = b.trips[c.index].last_stop_name
                rf = b.trips[c.index + 1].first_stop_name if c.index + 1 < len(b.trips) else ""
            rl = b.trips[-1].last_stop_name
            lo, lb = depot_transfer_min(lf, clusters), depot_transfer_min(ll, clusters)
            ro, rb = depot_transfer_min(rf, clusters), depot_transfer_min(rl, clusters)
            return max(
                c.left_work_min + pre_turno_for(lo) + lo + lb,
                c.right_work_min + pre_turno_for(ro) + ro + rb,
            )
        return min(b.cut_candidates, key=worst_nastro)

    return None


def build_initial_segments(blocks: list[VehicleBlock], clusters: list[Cluster]) -> list[Segment]:
    """Genera segmenti iniziali in base alla classificazione."""
    global _seg_counter
    _seg_counter = 0
    all_segments: list[Segment] = []

    for b in blocks:
        if b.classification in ("CORTO", "CORTO_BASSO"):
            seg = _make_segment(b.vehicle_id, b.vehicle_type, b.trips, "full", None, clusters)
            b.segments = [seg]
            all_segments.append(seg)

        elif b.classification == "MEDIO":
            best = _select_best_cut(b, clusters)
            if best:
                left_trips, right_trips = _split_trips_for_cut(b, best)
                seg1 = _make_segment(b.vehicle_id, b.vehicle_type, left_trips, "first", best.index, clusters)
                seg2 = _make_segment(b.vehicle_id, b.vehicle_type, right_trips, "second", best.index, clusters)
                b.segments = [seg1, seg2]
                all_segments.extend([seg1, seg2])
            else:
                seg = _make_segment(b.vehicle_id, b.vehicle_type, b.trips, "full", None, clusters)
                b.segments = [seg]
                all_segments.append(seg)

        elif b.classification == "LUNGO":
            max_nastro = SHIFT_RULES["intero"]["maxNastro"]
            best_pair_cuts = None
            best_pair_score = -999.0

            cands = b.cut_candidates
            for ci in range(len(cands)):
                for cj in range(ci + 1, len(cands)):
                    c1_raw, c2_raw = cands[ci], cands[cj]
                    if c1_raw.index > c2_raw.index:
                        c1_raw, c2_raw = c2_raw, c1_raw

                    mid_start = b.trips[c1_raw.index + 1].departure_min
                    mid_end = b.trips[c2_raw.index].arrival_min
                    mid_work = max(0, mid_end - mid_start)

                    for seg_first, seg_last, w in [
                        (b.trips[0].first_stop_name, b.trips[c1_raw.index].last_stop_name, c1_raw.left_work_min),
                        (b.trips[c1_raw.index + 1].first_stop_name if c1_raw.index + 1 < len(b.trips) else "",
                         b.trips[c2_raw.index].last_stop_name, mid_work),
                        (b.trips[c2_raw.index + 1].first_stop_name if c2_raw.index + 1 < len(b.trips) else "",
                         b.trips[-1].last_stop_name, c2_raw.right_work_min),
                    ]:
                        pass  # just scanning

                    lf, ll = b.trips[0].first_stop_name, b.trips[c1_raw.index].last_stop_name
                    mf = b.trips[c1_raw.index + 1].first_stop_name if c1_raw.index + 1 < len(b.trips) else ""
                    ml = b.trips[c2_raw.index].last_stop_name
                    rf = b.trips[c2_raw.index + 1].first_stop_name if c2_raw.index + 1 < len(b.trips) else ""
                    rl = b.trips[-1].last_stop_name

                    lt, lb = depot_transfer_min(lf, clusters), depot_transfer_min(ll, clusters)
                    mt, mb = depot_transfer_min(mf, clusters), depot_transfer_min(ml, clusters)
                    rt, rb = depot_transfer_min(rf, clusters), depot_transfer_min(rl, clusters)
                    ln = c1_raw.left_work_min + pre_turno_for(lt) + lt + lb
                    mn = mid_work + pre_turno_for(mt) + mt + mb
                    rn = c2_raw.right_work_min + pre_turno_for(rt) + rt + rb
                    worst = max(ln, mn, rn)
                    score = c1_raw.score + c2_raw.score - max(0, worst - max_nastro) * 2

                    if score > best_pair_score:
                        best_pair_score = score
                        best_pair_cuts = (c1_raw, c2_raw) if c1_raw.index < c2_raw.index else (c2_raw, c1_raw)

            if best_pair_cuts:
                c1, c2 = best_pair_cuts
                # Prima split per c1
                left_trips_c1, rest_after_c1 = _split_trips_for_cut(b, c1)
                # Per c2 dobbiamo lavorare su rest_after_c1, ma c2.index è relativo al blocco originale.
                # Approccio semplice: ricostruiamo la split per c2 dal blocco originale.
                _, right_trips_c2 = _split_trips_for_cut(b, c2)
                # Mid trips: tutto ciò che c'è tra c1 e c2
                # Per semplicità, se entrambi sono inter, usiamo i trip originali
                if c1.cut_type == "inter" and c2.cut_type == "inter":
                    mid_trips = b.trips[c1.index + 1:c2.index + 1]
                else:
                    # Per intra, usiamo il blocco tra la fine del left e l'inizio del right
                    mid_trips = rest_after_c1[:max(0, len(rest_after_c1) - len(right_trips_c2))]
                    if not mid_trips:
                        mid_trips = rest_after_c1

                seg1 = _make_segment(b.vehicle_id, b.vehicle_type, left_trips_c1, "first", c1.index, clusters)
                segs = [seg1]
                if mid_trips:
                    seg2 = _make_segment(b.vehicle_id, b.vehicle_type, mid_trips, "middle", c1.index, clusters)
                    segs.append(seg2)
                seg3 = _make_segment(b.vehicle_id, b.vehicle_type, right_trips_c2, "second", c2.index, clusters)
                segs.append(seg3)
                b.segments = segs
                all_segments.extend(segs)
            elif b.cut_candidates:
                best = _select_best_cut(b, clusters)
                if best:
                    l, r = _split_trips_for_cut(b, best)
                    seg1 = _make_segment(b.vehicle_id, b.vehicle_type, l, "first", best.index, clusters)
                    seg2 = _make_segment(b.vehicle_id, b.vehicle_type, r, "second", best.index, clusters)
                    b.segments = [seg1, seg2]
                    all_segments.extend([seg1, seg2])
                else:
                    seg = _make_segment(b.vehicle_id, b.vehicle_type, b.trips, "full", None, clusters)
                    b.segments = [seg]
                    all_segments.append(seg)
            else:
                seg = _make_segment(b.vehicle_id, b.vehicle_type, b.trips, "full", None, clusters)
                b.segments = [seg]
                all_segments.append(seg)

    return all_segments


# ═══════════════════════════════════════════════════════════════
#  CLASSIFICAZIONE POST-HOC BDS
# ═══════════════════════════════════════════════════════════════

def classify_duty(duty: DriverDutyV3, bds: BDSConfig, clusters: list[Cluster]) -> str:
    """Classificazione post-hoc ispirata a BDS TIPOLOGIE_PARAMETRICHE.

    Ordine: supplemento → intero → semiunico → spezzato → invalido.
    Non forza la classificazione in fase di enumerazione — la determina dopo.

    RD 131/1938: controlla sia nastro che lavoro effettivo.
    """
    nastro = duty.nastro_min
    work = duty.work_min
    interruzione = duty.interruption_min
    n_segs = len(duty.segments)
    rules = SHIFT_RULES

    # 1. Supplemento: nastro ≤ 150 min, singolo segmento
    if nastro <= SUPPLEMENTO_NASTRO_MAX and n_segs == 1:
        return "supplemento"

    # 2. Intero: singolo segmento, nastro ≤ 435, lavoro ≤ 435
    max_lavoro_intero = rules["intero"].get("maxLavoro", 435)
    if n_segs == 1 and nastro <= rules["intero"]["maxNastro"] and work <= max_lavoro_intero:
        return "intero"

    # 3. Semiunico: 2 segmenti, interruzione 75-179 min, nastro ≤ 555, lavoro ≤ 480
    max_lavoro_semi = rules["semiunico"].get("maxLavoro", 480)
    if n_segs >= 2 and interruzione >= rules["semiunico"]["intMin"] and interruzione <= rules["semiunico"]["intMax"]:
        if nastro <= rules["semiunico"]["maxNastro"] and work <= max_lavoro_semi:
            return "semiunico"

    # 4. Spezzato: 2 segmenti, interruzione ≥ 180 min, nastro ≤ 630, lavoro ≤ 450
    max_lavoro_spez = rules["spezzato"].get("maxLavoro", 450)
    if n_segs >= 2 and interruzione >= rules["spezzato"]["intMin"]:
        if nastro <= rules["spezzato"]["maxNastro"] and work <= max_lavoro_spez:
            return "spezzato"

    # 5. Fallback: intero con tolleranza se singolo segmento
    if n_segs == 1 and nastro <= rules["intero"]["maxNastro"] + 15:
        return "intero"

    # 6. Invalido
    return "invalido"


# ═══════════════════════════════════════════════════════════════
#  VALIDAZIONE BDS
# ═══════════════════════════════════════════════════════════════

def check_rd131(duty: DriverDutyV3, rd: RD131Config) -> tuple[bool, list[str]]:
    """Verifica RD 131/1938: guida continuativa max 4h30.

    Nel RD 131 la regola è più semplice del CE 561/2006:
    una sosta ≥ 15 min azzera completamente il conteggio di guida continuativa.
    Non c'è il concetto di pause frazionate da accumulare.
    """
    if not rd.attivo:
        return True, []

    violations: list[str] = []

    for seg in duty.segments:
        continuous_driving = 0

        for i, t in enumerate(seg.trips):
            dur = t.arrival_min - t.departure_min
            continuous_driving += dur

            if continuous_driving > rd.max_guida_continuativa:
                violations.append(
                    f"guida continuativa {continuous_driving}min > max {rd.max_guida_continuativa}min "
                    f"(segmento {seg.vehicle_id}, trip {t.trip_id})"
                )
                break

            # Sosta dopo questa corsa: ≥ 15 min azzera il conteggio
            if i + 1 < len(seg.trips):
                gap = seg.trips[i + 1].departure_min - t.arrival_min
                if gap >= rd.sosta_minima:
                    continuous_driving = 0

    return len(violations) == 0, violations


# Alias retrocompatibilità
check_cee561 = check_rd131


def check_sosta_capolinea(duty: DriverDutyV3, rules: dict = SHIFT_RULES) -> tuple[bool, list[str]]:
    """RD 131/1938: turno intero deve avere almeno 1 sosta ≥15min al capolinea."""
    if duty.duty_type != "intero":
        return True, []

    sosta_min = rules.get("intero", SHIFT_RULES["intero"]).get("sostaMinCapolinea", 15)

    for seg in duty.segments:
        for i in range(len(seg.trips) - 1):
            gap = seg.trips[i + 1].departure_min - seg.trips[i].arrival_min
            if gap >= sosta_min:
                return True, []

    return False, [f"intero senza sosta ≥ {sosta_min}min al capolinea"]


def check_intervallo_pasto(
    duty: DriverDutyV3,
    pasto: IntervalloPastoConfig,
) -> tuple[bool, list[str]]:
    """Verifica intervallo pasto: pranzo e cena."""
    if not pasto.attivo:
        return True, []

    violations: list[str] = []

    # Tutte le soste del turno (gap ≥ 10 min tra corse)
    breaks: list[tuple[int, int]] = []  # (start_min, end_min)
    for seg in duty.segments:
        for i in range(len(seg.trips) - 1):
            gap_start = seg.trips[i].arrival_min
            gap_end = seg.trips[i + 1].departure_min
            if gap_end - gap_start >= 10:
                breaks.append((gap_start, gap_end))

    # Aggiungi interruzione tra segmenti
    if len(duty.segments) >= 2:
        for si in range(len(duty.segments) - 1):
            seg_end = duty.segments[si].end_min
            seg_start = duty.segments[si + 1].start_min
            if seg_start > seg_end:
                breaks.append((seg_end, seg_start))

    def _check_fascia(
        controllo_inizio: int,
        controllo_fine: int,
        sosta_inizio: int,
        sosta_fine: int,
        sosta_minima: int,
        label: str,
    ):
        # Il turno attraversa la fascia di controllo?
        turno_start = duty.nastro_start
        turno_end = duty.nastro_end
        if turno_start >= controllo_fine or turno_end <= controllo_inizio:
            return  # turno non attraversa la fascia

        # Cerca una sosta ≥ minima nella fascia di sosta
        found = False
        for b_start, b_end in breaks:
            # Sosta che si sovrappone alla fascia
            overlap_start = max(b_start, sosta_inizio)
            overlap_end = min(b_end, sosta_fine)
            if overlap_end - overlap_start >= sosta_minima:
                found = True
                break

        # L'interruzione conta come sosta
        if not found and duty.interruption_min >= sosta_minima:
            # Controlla se l'interruzione cade nella fascia
            if len(duty.segments) >= 2:
                int_start = duty.segments[0].end_min
                int_end = duty.segments[1].start_min
                overlap_start = max(int_start, sosta_inizio)
                overlap_end = min(int_end, sosta_fine)
                if overlap_end - overlap_start >= sosta_minima:
                    found = True

        if not found:
            violations.append(
                f"nessuna pausa {label} ≥ {sosta_minima}min nella fascia "
                f"{min_to_time(sosta_inizio)}-{min_to_time(sosta_fine)}"
            )

    _check_fascia(
        pasto.pranzo_controllo_inizio, pasto.pranzo_controllo_fine,
        pasto.pranzo_sosta_inizio, pasto.pranzo_sosta_fine,
        pasto.pranzo_sosta_minima, "pranzo",
    )
    _check_fascia(
        pasto.cena_controllo_inizio, pasto.cena_controllo_fine,
        pasto.cena_sosta_inizio, pasto.cena_sosta_fine,
        pasto.cena_sosta_minima, "cena",
    )

    return len(violations) == 0, violations


def check_stacco_minimo(
    duty: DriverDutyV3,
    stacco: StaccoMinimo,
) -> tuple[bool, list[str]]:
    """Verifica stacco minimo tra pezzi di guida."""
    violations: list[str] = []

    for seg in duty.segments:
        for i in range(len(seg.trips) - 1):
            gap = seg.trips[i + 1].departure_min - seg.trips[i].arrival_min
            # Stesso veicolo → stacco 0
            min_gap = stacco.stesso_veicolo
            if gap < min_gap:
                violations.append(
                    f"stacco {gap}min < min {min_gap}min "
                    f"tra trip {seg.trips[i].trip_id} e {seg.trips[i+1].trip_id}"
                )

    # Stacco tra segmenti (veicoli diversi)
    if len(duty.segments) >= 2:
        for si in range(len(duty.segments) - 1):
            s1 = duty.segments[si]
            s2 = duty.segments[si + 1]
            gap = s2.start_min - s1.end_min
            if s1.vehicle_id != s2.vehicle_id:
                min_gap = stacco.tra_pezzi_guida
            else:
                min_gap = stacco.stesso_veicolo
            if gap < min_gap:
                violations.append(
                    f"stacco tra segmenti {gap}min < min {min_gap}min "
                    f"(seg {s1.vehicle_id} → {s2.vehicle_id})"
                )

    return len(violations) == 0, violations


def check_riprese(
    duty: DriverDutyV3,
    gestore: GestoreRiprese,
) -> tuple[bool, list[str]]:
    """Verifica regole riprese BDS."""
    violations: list[str] = []

    n_segs = len(duty.segments)

    # Max riprese
    if n_segs > gestore.max_riprese:
        violations.append(f"n.riprese {n_segs} > max {gestore.max_riprese}")

    # Durata massima per ripresa
    for seg in duty.segments:
        dur = seg.end_min - seg.start_min
        if dur > gestore.max_durata_ripresa:
            violations.append(
                f"ripresa {seg.vehicle_id} durata {dur}min > max {gestore.max_durata_ripresa}min"
            )

    # Guida per ripresa
    for seg in duty.segments:
        if seg.driving_min > gestore.max_guida_per_ripresa:
            violations.append(
                f"guida ripresa {seg.vehicle_id} {seg.driving_min}min > max {gestore.max_guida_per_ripresa}min"
            )

    return len(violations) == 0, violations


def validate_duty_bds(
    duty: DriverDutyV3,
    bds: BDSConfig,
    clusters: list[Cluster],
) -> BDSValidation:
    """Validazione completa BDS/RD 131/1938 di un turno guida."""
    result = BDSValidation()

    # Classificazione
    classified = classify_duty(duty, bds, clusters)
    if classified == "invalido":
        result.classificazione_valida = False
        result.violations.append(f"classificazione invalida: nastro={duty.nastro_min}, int={duty.interruption_min}")

    # Nastro
    rules = SHIFT_RULES.get(duty.duty_type, {})
    max_nastro = rules.get("maxNastro", 999)
    tolerance = 15 if duty.duty_type == "intero" else 5
    if duty.nastro_min > max_nastro + tolerance:
        result.nastro_ok = False
        result.violations.append(f"nastro {duty.nastro_min}min > max {max_nastro}+{tolerance}min")

    # Lavoro effettivo (RD 131/1938)
    max_lavoro = rules.get("maxLavoro", 999)
    if duty.work_min > max_lavoro + tolerance:
        result.lavoro_ok = False
        result.violations.append(f"lavoro {duty.work_min}min > max {max_lavoro}+{tolerance}min")

    # Interruzione
    if duty.duty_type in ("semiunico", "spezzato"):
        int_min = rules.get("intMin", 0)
        int_max = rules.get("intMax", 999)
        if duty.interruption_min < int_min:
            result.violations.append(f"interruzione {duty.interruption_min}min < min {int_min}min")
            result.classificazione_valida = False
        if duty.interruption_min > int_max:
            result.violations.append(f"interruzione {duty.interruption_min}min > max {int_max}min")
            result.classificazione_valida = False

    # RD 131/1938 guida continuativa
    rd_ok, rd_viol = check_rd131(duty, bds.rd131)
    result.rd131_ok = rd_ok
    result.violations.extend(rd_viol)

    # Sosta capolinea (turni intero)
    sosta_ok, sosta_viol = check_sosta_capolinea(duty)
    result.sosta_capolinea_ok = sosta_ok
    result.violations.extend(sosta_viol)

    # Intervallo pasto
    pasto_ok, pasto_viol = check_intervallo_pasto(duty, bds.pasto)
    result.intervallo_pasto_ok = pasto_ok
    result.violations.extend(pasto_viol)

    # Stacco minimo
    stacco_ok, stacco_viol = check_stacco_minimo(duty, bds.stacco)
    result.stacco_minimo_ok = stacco_ok
    result.violations.extend(stacco_viol)

    # Riprese
    riprese_ok, riprese_viol = check_riprese(duty, bds.riprese)
    result.riprese_ok = riprese_ok
    result.violations.extend(riprese_viol)

    return result


def validate_all_bds(
    duties: list[DriverDutyV3],
    bds: BDSConfig,
    clusters: list[Cluster],
) -> dict:
    """Valida tutti i turni con BDS. Ritorna stats + lista violazioni."""
    total_violations = 0
    duty_violations: dict[str, list[str]] = {}
    bds_results: dict[str, dict] = {}

    for d in duties:
        v = validate_duty_bds(d, bds, clusters)
        d.bds_validation = v  # type: ignore[attr-defined]
        bds_results[d.driver_id] = v.to_dict()
        if not v.valid:
            duty_violations[d.driver_id] = v.violations
            total_violations += len(v.violations)

    return {
        "totalViolations": total_violations,
        "dutiesWithViolations": len(duty_violations),
        "details": duty_violations,
        "bdsResults": bds_results,
    }


# ═══════════════════════════════════════════════════════════════
#  CALCOLO LAVORO BDS (WorkCalculation)
# ═══════════════════════════════════════════════════════════════

def compute_work_bds(
    duty: DriverDutyV3,
    bds: BDSConfig,
    clusters: list[Cluster],
) -> WorkCalculation:
    """Calcola il lavoro BDS per un turno guida.
    Ispirato a BDS RegolaCalcoloLavoroSommaRiprese."""
    wc = WorkCalculation()

    # Guida
    wc.driving_min = duty.driving_min

    # Attese al capolinea tra corse
    idle = 0
    for seg in duty.segments:
        for i in range(len(seg.trips) - 1):
            gap = seg.trips[i + 1].departure_min - seg.trips[i].arrival_min
            if gap > 0:
                idle += gap
    wc.idle_at_terminal_min = idle

    # Pre/post BDS
    wc.pre_post_min = compute_pre_post_total(duty, bds.pre_post, clusters)

    # Trasferimenti
    wc.transfer_min = duty.transfer_min + duty.transfer_back_min

    # Soste fra riprese (per semiunico/spezzato)
    if len(duty.segments) >= 2 and duty.interruption_min > 0:
        # Determina se la sosta è in residenza (deposito) o fuori residenza
        first_seg_last_cluster = duty.segments[0].last_cluster
        if first_seg_last_cluster:
            # Fuori residenza: il conducente aspetta al cluster
            wc.soste_fra_riprese_fr_min = duty.interruption_min
            wc.coeff_fr = 0.0  # non retribuita
        else:
            # In residenza: il conducente torna al deposito
            wc.soste_fra_riprese_ir_min = duty.interruption_min
            wc.coeff_ir = 0.0  # non retribuita

    return wc


# ═══════════════════════════════════════════════════════════════
#  COSTO BDS
# ═══════════════════════════════════════════════════════════════

def compute_duty_cost_v4(
    duty: DriverDutyV3,
    rates: CostRates,
    bds: BDSConfig,
    clusters: list[Cluster],
) -> DutyCostBreakdown:
    """Costo turno con pre/post multi-livello BDS."""
    c = DutyCostBreakdown()
    per_min = rates.hourly_rate / 60.0

    wc = compute_work_bds(duty, bds, clusters)
    duty.work_calculation = wc  # type: ignore[attr-defined]

    # 1. Guida
    c.driving_cost = wc.driving_min * per_min

    # 2. Attesa capolinea
    idle_cost = wc.idle_at_terminal_min * per_min * rates.idle_rate_fraction
    # Penalità attese lunghe
    long_idle_extra = 0.0
    for seg in duty.segments:
        for i in range(len(seg.trips) - 1):
            gap = seg.trips[i + 1].departure_min - seg.trips[i].arrival_min
            if gap > 20:
                long_idle_extra += (gap - 20) * rates.long_idle_penalty_per_min
    c.idle_at_terminal_cost = idle_cost + long_idle_extra

    # 3. Pre-turno/post-turno BDS
    c.pre_turno_cost = wc.pre_post_min * per_min * rates.pre_turno_rate_fraction

    # 4. Trasferimenti
    c.transfer_depot_cost = wc.transfer_min * per_min * rates.transfer_rate_fraction

    # 5. Auto aziendale
    n_transfers = len(duty.segments)
    c.company_car_cost = n_transfers * rates.company_car_per_use

    # 6. Retribuzione base (lavoro convenzionale BDS)
    lavoro_retribuito = wc.lavoro_convenzionale
    c.base_salary = lavoro_retribuito * per_min

    # 7. Straordinario
    target_mid = (rates.target_work_min + rates.target_work_max) / 2.0
    if lavoro_retribuito > target_mid + 12:
        excess = lavoro_retribuito - target_mid
        c.overtime_cost = excess * per_min * (rates.overtime_multiplier - 1)

    if lavoro_retribuito < target_mid - 30:
        deficit = target_mid - lavoro_retribuito
        c.undertime_cost = deficit * rates.work_imbalance_per_min

    # 8. Supplemento
    if duty.duty_type == "supplemento":
        c.base_salary += rates.supplemento_fixed

    # 9. Interruzione
    if duty.interruption_min > 0:
        c.interruption_cost = duty.interruption_min * per_min * rates.interruption_rate_fraction

    # 10. Penalità sbilanciamento
    dev = abs(lavoro_retribuito - target_mid)
    c.work_imbalance_penalty = dev * rates.work_imbalance_per_min

    c.compute()
    return c


# ═══════════════════════════════════════════════════════════════
#  FASE 4: OTTIMIZZAZIONE GLOBALE CP-SAT
# ═══════════════════════════════════════════════════════════════

def _feasible_pair(s1: Segment, s2: Segment, rules: dict) -> str | None:
    """Verifica se due segmenti possono formare un turno biripresa (semiunico/spezzato).

    Semiunico/spezzato servono per coprire i picchi (entrata/uscita scuole e uffici):
    un conducente lavora al mattino, torna in deposito per l'interruzione, riesce al pomeriggio.
    """
    if s1.start_min > s2.start_min:
        s1, s2 = s2, s1

    interruption = s2.start_min - s1.end_min
    if interruption < 0:
        return None

    if s1.vehicle_id != s2.vehicle_id:
        if not s1.last_cluster or not s2.first_cluster:
            return None

    nastro = (s2.end_min - s1.start_min
              + pre_turno_for(DEPOT_TRANSFER_CENTRAL) + DEPOT_TRANSFER_CENTRAL * 2)
    work = (s1.work_min + s2.work_min
            + pre_turno_for(DEPOT_TRANSFER_CENTRAL) + DEPOT_TRANSFER_CENTRAL * 2)

    # RD 131/1938: verifica lavoro max oltre a nastro max
    sr_semi = rules.get("semiunico", SHIFT_RULES["semiunico"])
    sr_spez = rules.get("spezzato", SHIFT_RULES["spezzato"])

    # Semiunico: interruzione 1h15-2h59, nastro <= 9h15, lavoro <= 8h
    if (sr_semi["intMin"] <= interruption <= sr_semi["intMax"]
            and nastro <= sr_semi["maxNastro"]
            and work <= sr_semi.get("maxLavoro", 480)
            and work >= 180):
        return "semiunico"

    # Spezzato: interruzione >= 3h, nastro <= 10h30, lavoro <= 7h30
    if (interruption >= sr_spez["intMin"]
            and nastro <= sr_spez["maxNastro"]
            and work <= sr_spez.get("maxLavoro", 450)
            and work >= 180):
        return "spezzato"

    return None


def _build_cpsat_model(
    segments: list[Segment],
    feasible_pairs: list[tuple[int, int, str]],
    rules: dict,
    rates: CostRates,
    bds: BDSConfig,
    clusters: list[Cluster],
    scenario_seed: int,
    scenario_noise: float = 0.0,
    strategy: str = "balanced",
) -> tuple[cp_model.CpModel, dict, dict, dict]:
    """Costruisce un modello CP-SAT. Parametri:
    - scenario_noise: perturba i costi per esplorare soluzioni alternative
    - strategy: profilo di pesi (vedi SCENARIO_STRATEGIES) per obiettivi alternativi.
    """
    import random

    strat = SCENARIO_STRATEGIES.get(strategy, SCENARIO_STRATEGIES["balanced"])
    mul_cost = strat["mul_cost"]
    mul_balance = strat["mul_balance"]
    mul_suppl = strat["mul_suppl"]
    mul_spezz = strat["mul_spezz"]
    mul_transfer = strat["mul_transfer"]

    model = cp_model.CpModel()
    n_seg = len(segments)
    seg_by_idx = {s.idx: s for s in segments}

    # -- Variabili single --
    single: dict[int, Any] = {}
    for s in segments:
        single[s.idx] = model.new_bool_var(f"single_{s.idx}")

    # Segmenti troppo lunghi per intero
    too_long_for_single: set[int] = set()
    for s in segments:
        _t = depot_transfer_min(s.first_stop, clusters)
        _tb = depot_transfer_min(s.last_stop, clusters)
        nastro_s = s.work_min + pre_turno_for(_t) + _t + _tb
        is_suppl = nastro_s <= SUPPLEMENTO_NASTRO_MAX
        intero_max = rules.get("intero", SHIFT_RULES["intero"]).get("maxNastro", 435)
        if not is_suppl and nastro_s > intero_max:
            too_long_for_single.add(s.idx)

    # -- Variabili pair --
    pair_vars: dict[tuple[int, int], Any] = {}
    pair_types: dict[tuple[int, int], str] = {}
    for s1_idx, s2_idx, ptype in feasible_pairs:
        key = (s1_idx, s2_idx)
        pair_vars[key] = model.new_bool_var(f"pair_{s1_idx}_{s2_idx}")
        pair_types[key] = ptype

    # -- Indice rapido: per ogni segmento i pair che lo coprono --
    pairs_by_seg: dict[int, list[tuple[int, int]]] = {s.idx: [] for s in segments}
    for key in pair_vars:
        pairs_by_seg[key[0]].append(key)
        pairs_by_seg[key[1]].append(key)

    # -- HARD: saturazione (min lavoro per turno intero) --
    # Se un segmento da solo (single) genererebbe un turno "intero" sotto la
    # soglia minima di lavoro, lo VIETIAMO purche' esista almeno un pair che
    # lo possa coprire (altrimenti rendiamo il modello infeasible).
    # I supplementi (nastro <= SUPPLEMENTO_NASTRO_MAX) sono esentati per
    # definizione: hanno regole di durata proprie.
    n_forbidden_single = 0
    if MIN_WORK_PER_DUTY > 0:
        for s in segments:
            _t = depot_transfer_min(s.first_stop, clusters)
            _tb = depot_transfer_min(s.last_stop, clusters)
            _pt = pre_turno_for(_t)
            nastro_s = s.work_min + _pt + _t + _tb
            if nastro_s <= SUPPLEMENTO_NASTRO_MAX:
                continue  # supplementi esentati
            pp = bds.pre_post
            pre_post_val = pp.pre_turno_deposito if _t > 0 else pp.pre_turno_cambio
            work_w = s.work_min + pre_post_val + _tb
            if work_w >= MIN_WORK_PER_DUTY:
                continue
            if pairs_by_seg.get(s.idx):
                model.add(single[s.idx] == 0)
                n_forbidden_single += 1
    if n_forbidden_single > 0:
        log(f"[V4][CPSAT] Saturazione: vietati {n_forbidden_single} single sotto {MIN_WORK_PER_DUTY}min lavoro")

    # -- HARD: cap vetture aziendali simultanee per trasferimenti a vuoto --
    # Ogni pair (semiunico/spezzato) richiede UNA vettura aziendale per spostare
    # il driver da fine s1 a inizio s2. Modelliamo come cumulative su intervalli
    # opzionali con capacita' MAX_COMPANY_CARS.
    if MAX_COMPANY_CARS > 0 and pair_vars:
        car_intervals = []
        for key, pv in pair_vars.items():
            s1_idx, s2_idx = key
            s1, s2 = seg_by_idx[s1_idx], seg_by_idx[s2_idx]
            if s1.start_min > s2.start_min:
                s1, s2 = s2, s1
            car_start = s1.end_min
            car_end = s2.start_min
            duration = car_end - car_start
            if duration <= 0:
                continue
            iv = model.new_optional_fixed_size_interval_var(
                start=car_start,
                size=duration,
                is_present=pv,
                name=f"car_iv_{key[0]}_{key[1]}",
            )
            car_intervals.append(iv)
        if car_intervals:
            model.add_cumulative(
                car_intervals,
                [1] * len(car_intervals),
                MAX_COMPANY_CARS,
            )
            log(f"[V4][CPSAT] Cap HARD vetture aziendali = {MAX_COMPANY_CARS} su {len(car_intervals)} pair")

    # -- Vincoli: copertura esatta --
    for s in segments:
        involved = [single[s.idx]]
        for key, pv in pair_vars.items():
            if s.idx in key:
                involved.append(pv)
        model.add_exactly_one(involved)

    # -- Penalita nastro violato --
    nastro_violation_penalty: dict[int, int] = {}
    for s_idx in too_long_for_single:
        has_pair = any(s_idx in key for key in pair_vars)
        seg = seg_by_idx[s_idx]
        _t = depot_transfer_min(seg.first_stop, clusters)
        _tb = depot_transfer_min(seg.last_stop, clusters)
        nastro_s = seg.work_min + pre_turno_for(_t) + _t + _tb
        excess = nastro_s - SHIFT_RULES["intero"]["maxNastro"]
        if has_pair:
            nastro_violation_penalty[s_idx] = excess * 500 * COST_SCALE
        else:
            nastro_violation_penalty[s_idx] = excess * 200 * COST_SCALE

    # -- Conta turni per tipo --
    total_duties = model.new_int_var(0, n_seg, "total_duties")
    n_supplemento = []
    n_semi = []
    n_spezzato = []

    for s in segments:
        _t_out = depot_transfer_min(s.first_stop, clusters)
        _t_back = depot_transfer_min(s.last_stop, clusters)
        nastro_single = s.work_min + pre_turno_for(_t_out) + _t_out + _t_back
        if nastro_single <= SUPPLEMENTO_NASTRO_MAX:
            n_supplemento.append(single[s.idx])

    for key, pv in pair_vars.items():
        ptype = pair_types[key]
        if ptype == "semiunico":
            n_semi.append(pv)
        else:
            n_spezzato.append(pv)

    model.add(total_duties == sum(single.values()) + sum(pair_vars.values()))

    # Vincoli percentuali
    if n_supplemento:
        suppl_count = model.new_int_var(0, n_seg, "suppl_count")
        model.add(suppl_count == sum(n_supplemento))
        model.add(10 * suppl_count <= total_duties)

    if n_semi:
        semi_count = model.new_int_var(0, n_seg, "semi_count")
        model.add(semi_count == sum(n_semi))
        semi_max_pct = rules.get("semiunico", SHIFT_RULES["semiunico"]).get("maxPct", 12)
        model.add(100 * semi_count <= semi_max_pct * total_duties)

    if n_spezzato:
        spez_count = model.new_int_var(0, n_seg, "spez_count")
        model.add(spez_count == sum(n_spezzato))
        spez_max_pct = rules.get("spezzato", SHIFT_RULES["spezzato"]).get("maxPct", 13)
        model.add(100 * spez_count <= spez_max_pct * total_duties)

    # -- Obiettivo (con noise per multi-scenario) --
    rng = random.Random(scenario_seed)
    obj_terms: list[Any] = []

    for s in segments:
        _t = depot_transfer_min(s.first_stop, clusters)
        _tb = depot_transfer_min(s.last_stop, clusters)
        _pt = pre_turno_for(_t)
        nastro_s = s.work_min + _pt + _t + _tb

        pp = bds.pre_post
        pre_post_val = pp.pre_turno_deposito if _t > 0 else pp.pre_turno_cambio

        work_with_overhead = s.work_min + pre_post_val + _tb
        dev_from_target = abs(work_with_overhead - TARGET_WORK_MID)

        if nastro_s <= SUPPLEMENTO_NASTRO_MAX:
            cost_cents = int(rates.supplemento_daily * COST_SCALE * mul_suppl)
        else:
            hours = work_with_overhead / 60.0
            cost_cents = int((hours * rates.hourly_rate * mul_cost
                             + dev_from_target * rates.work_imbalance_per_min * mul_balance) * COST_SCALE)
            # FIX-CSP-1: penalita' idle CAPPATA per evitare doppia penalita' con
            # work_imbalance. Solo i primi IDLE_PENALTY_MAX_MIN minuti contano:
            # oltre, il segmento e' strutturalmente isolato e non c'e' alternativa.
            if WEIGHT_IDLE_PENALTY > 0:
                idle_min_raw = max(0, nastro_s - work_with_overhead)
                idle_min_capped = min(idle_min_raw, IDLE_PENALTY_MAX_MIN)
                cost_cents += WEIGHT_IDLE_PENALTY * idle_min_capped * COST_SCALE

        # Perturbazione per esplorare soluzioni diverse
        if scenario_noise > 0:
            noise = rng.gauss(0, scenario_noise * cost_cents)
            cost_cents = max(1, int(cost_cents + noise))

        obj_terms.append(cost_cents * single[s.idx])

    for key, pv in pair_vars.items():
        s1_idx, s2_idx = key
        s1, s2 = seg_by_idx[s1_idx], seg_by_idx[s2_idx]
        ptype = pair_types[key]

        pp = bds.pre_post
        combined_work = (s1.work_min + s2.work_min
                        + pp.pre_turno_deposito
                        + pp.pre_ripresa
                        + DEPOT_TRANSFER_CENTRAL * 2)
        hours = combined_work / 60.0
        dev = abs(combined_work - TARGET_WORK_MID)

        # Moltiplicatore specifico per tipo pair (spezzato vs semiunico)
        pair_type_mul = mul_spezz if ptype == "spezzato" else 1.0

        cost_cents = int((hours * rates.hourly_rate * mul_cost
                         + dev * rates.work_imbalance_per_min * mul_balance
                         + rates.company_car_per_use * mul_transfer) * COST_SCALE * pair_type_mul)

        if scenario_noise > 0:
            noise = rng.gauss(0, scenario_noise * cost_cents)
            cost_cents = max(1, int(cost_cents + noise))

        obj_terms.append(cost_cents * pv)

    for s_idx, penalty in nastro_violation_penalty.items():
        obj_terms.append(penalty * single[s_idx])

    # -- Minimizzazione AGGRESSIVA del numero di turni guida --
    # Aggiunge un costo "virtuale" fisso per ogni turno selezionato:
    # spinge il solver a preferire pair (1 turno copre 2 segmenti) rispetto
    # a 2 single, anche quando l'aritmetica oraria sarebbe quasi pari.
    if WEIGHT_DUTY_COUNT > 0:
        obj_terms.append(WEIGHT_DUTY_COUNT * COST_SCALE * total_duties)

    model.minimize(sum(obj_terms))

    return model, single, pair_vars, pair_types


def _extract_duties_from_solution(
    solver: cp_model.CpSolver,
    segments: list[Segment],
    single: dict[int, Any],
    pair_vars: dict[tuple[int, int], Any],
    pair_types: dict[tuple[int, int], str],
    clusters: list[Cluster],
    bds: BDSConfig,
) -> list[DriverDutyV3]:
    """Estrae i turni guida da una soluzione CP-SAT."""
    seg_by_idx = {s.idx: s for s in segments}
    duties: list[DriverDutyV3] = []
    duty_idx = 0

    for s in segments:
        if solver.value(single[s.idx]):
            transfer = depot_transfer_min(s.first_stop, clusters)
            transfer_back = depot_transfer_min(s.last_stop, clusters)
            pt = pre_turno_for(transfer)
            nastro_s = s.work_min + pt + transfer + transfer_back

            dtype = "supplemento" if nastro_s <= SUPPLEMENTO_NASTRO_MAX else "intero"

            duties.append(DriverDutyV3(
                idx=duty_idx,
                driver_id=f"D{duty_idx + 1:03d}",
                duty_type=dtype,
                segments=[s],
                nastro_start=s.start_min - pt - transfer,
                nastro_end=s.end_min + transfer_back,
                nastro_min=nastro_s,
                work_min=s.work_min + pt + transfer_back,
                driving_min=s.driving_min,
                interruption_min=0,
                pre_turno_min=pt,
                transfer_min=transfer,
                transfer_back_min=transfer_back,
            ))
            duty_idx += 1

    for key, pv in pair_vars.items():
        if solver.value(pv):
            s1_idx, s2_idx = key
            s1, s2 = seg_by_idx[s1_idx], seg_by_idx[s2_idx]
            ptype = pair_types[key]

            if s1.start_min > s2.start_min:
                s1, s2 = s2, s1

            interruption = s2.start_min - s1.end_min
            transfer = depot_transfer_min(s1.first_stop, clusters)
            transfer_back = depot_transfer_min(s2.last_stop, clusters)
            pt = pre_turno_for(transfer)
            nastro = s2.end_min - s1.start_min + pt + transfer + transfer_back
            # Bugfix: includere pre_ripresa nel work_min coerentemente con la
            # cost function di _build_cpsat_model (combined_work).
            work = (s1.work_min + s2.work_min + pt + transfer_back
                    + bds.pre_post.pre_ripresa)

            duties.append(DriverDutyV3(
                idx=duty_idx,
                driver_id=f"D{duty_idx + 1:03d}",
                duty_type=ptype,
                segments=[s1, s2],
                nastro_start=s1.start_min - pt - transfer,
                nastro_end=s2.end_min + transfer_back,
                nastro_min=nastro,
                work_min=work,
                driving_min=s1.driving_min + s2.driving_min,
                interruption_min=interruption,
                pre_turno_min=pt,
                transfer_min=transfer,
                transfer_back_min=transfer_back,
            ))
            duty_idx += 1

    # Post-hoc: riclassifica con RD 131/1938
    for d in duties:
        classified = classify_duty(d, bds, clusters)
        if classified != d.duty_type:
            d.duty_type = classified

    return duties


def _capture_solver_decisions(
    solver: cp_model.CpSolver,
    single: dict[int, Any],
    pair_vars: dict[tuple[int, int], Any],
) -> tuple[dict[int, bool], dict[tuple[int, int], bool]]:
    """FIX-CSP-3: Estrae le decisioni booleane di una soluzione CP-SAT per
    riusarle come hint in un modello successivo (polish phase warm-start)."""
    single_decisions = {s_idx: bool(solver.value(sv)) for s_idx, sv in single.items()}
    pair_decisions = {key: bool(solver.value(pv)) for key, pv in pair_vars.items()}
    return single_decisions, pair_decisions


def _score_solution(
    duties: list[DriverDutyV3],
    rates: CostRates,
    bds: BDSConfig,
    clusters: list[Cluster],
) -> float:
    """Calcola un punteggio di qualita di una soluzione (piu basso = meglio)."""
    total_cost = 0.0
    n_violations = 0
    n_invalido = 0

    for d in duties:
        cb = compute_duty_cost_v4(d, rates, bds, clusters)
        total_cost += cb.total

        v = validate_duty_bds(d, bds, clusters)
        n_violations += len(v.violations)
        if d.duty_type == "invalido":
            n_invalido += 1

    score = total_cost + n_violations * 50.0 + n_invalido * 500.0

    n_total = len(duties)

    # FIX-CSP-2: termine esplicito n_turni × SCORE_PER_DUTY
    # Permette al portfolio di preferire scenari con meno turni anche se
    # marginalmente piu' costosi sul costo orario.
    score += n_total * SCORE_PER_DUTY

    n_suppl = sum(1 for d in duties if d.duty_type == "supplemento")
    suppl_pct = n_suppl / max(n_total, 1)
    if suppl_pct > 0.15:
        score += (suppl_pct - 0.15) * n_total * 20.0

    return score


def _compute_scenario_metrics(
    duties: list[DriverDutyV3],
    rates: CostRates,
    bds: BDSConfig,
    clusters: list[Cluster],
) -> dict:
    """Calcola un dizionario di metriche complete per uno scenario risolto.

    Riporta tutte le metriche significative perche l'utente possa confrontarle e
    scegliere lo scenario migliore non solo sul costo.
    """
    n_total = len(duties)
    type_counts = {"intero": 0, "semiunico": 0, "spezzato": 0, "supplemento": 0, "invalido": 0}
    total_work_min = 0
    total_nastro_min = 0
    total_driving_min = 0
    total_interruption_min = 0
    total_pre_turno_min = 0
    total_transfer_min = 0
    total_cost = 0.0
    n_violations = 0
    idle_per_duty: list[int] = []   # minuti "vuoti" (nastro - work) per turno

    for d in duties:
        type_counts[d.duty_type] = type_counts.get(d.duty_type, 0) + 1
        total_work_min += d.work_min
        total_nastro_min += d.nastro_min
        total_driving_min += d.driving_min
        total_interruption_min += d.interruption_min
        total_pre_turno_min += d.pre_turno_min
        total_transfer_min += d.transfer_min + d.transfer_back_min

        cb = compute_duty_cost_v4(d, rates, bds, clusters)
        total_cost += cb.total

        v = validate_duty_bds(d, bds, clusters)
        n_violations += len(v.violations)

        idle = max(0, d.nastro_min - d.work_min)
        idle_per_duty.append(idle)

    n_princ = max(1, n_total - type_counts["supplemento"])
    semi_pct = round(type_counts["semiunico"] / n_princ * 100, 1)
    spez_pct = round(type_counts["spezzato"] / n_princ * 100, 1)
    suppl_pct = round(type_counts["supplemento"] / max(n_total, 1) * 100, 1)

    total_idle = sum(idle_per_duty)
    avg_idle = round(total_idle / max(n_total, 1), 1)

    # "Vuoti" significativi: turni con idle > 60min (nastro molto piu lungo del lavoro)
    n_vuoti_significativi = sum(1 for v in idle_per_duty if v >= 60)

    return {
        "duties": n_total,
        "interi": type_counts["intero"],
        "semiunici": type_counts["semiunico"],
        "spezzati": type_counts["spezzato"],
        "supplementi": type_counts["supplemento"],
        "invalidi": type_counts["invalido"],
        "semiPct": semi_pct,
        "spezPct": spez_pct,
        "supplPct": suppl_pct,
        "totalWorkH": round(total_work_min / 60, 1),
        "totalNastroH": round(total_nastro_min / 60, 1),
        "totalDrivingH": round(total_driving_min / 60, 1),
        "totalInterruptionH": round(total_interruption_min / 60, 1),
        "totalTransferH": round(total_transfer_min / 60, 1),
        "avgWorkMin": round(total_work_min / max(n_total, 1), 1),
        "avgNastroMin": round(total_nastro_min / max(n_total, 1), 1),
        "avgIdleMin": avg_idle,                 # media minuti "vuoti" per turno
        "totalIdleH": round(total_idle / 60, 1), # ore totali "vuote"
        "vuotiSignificativi": n_vuoti_significativi,
        "totalCost": round(total_cost, 2),
        "costPerDuty": round(total_cost / max(n_total, 1), 2),
        "bdsViolations": n_violations,
        # conformita
        "semiCompliant": semi_pct <= 12,
        "spezCompliant": spez_pct <= 13,
    }


def optimize_multi_scenario(
    blocks: list[VehicleBlock],
    segments: list[Segment],
    config: dict,
    time_limit_sec: int,
    clusters: list[Cluster],
    bds: BDSConfig,
) -> list[DriverDutyV3]:
    """Ottimizzazione multi-scenario: genera N scenari CP-SAT con parametri diversi,
    poi sceglie il migliore.

    Ispirato agli ottimizzatori professionali che generano 10-20 scenari e selezionano
    il migliore. Ogni scenario usa:
    - Seed CP-SAT diverso -> esplora rami diversi dell'albero di ricerca
    - Noise sui costi -> perturba l'obiettivo per trovare soluzioni strutturalmente diverse
    - Linearization level diverso -> strategie di bound diverse
    """
    rules = config.get("shiftRules", SHIFT_RULES)
    rates = CostRates.from_config(config)
    n_seg = len(segments)

    # Determina numero scenari in base all'intensita
    # Accetta sia int legacy (1/2/3) sia stringhe (fast/normal/deep/extreme)
    intensity = config.get("solverIntensity", 2)
    if isinstance(intensity, str):
        intensity_map = {"fast": 1, "normal": 2, "deep": 3, "extreme": 4}
        intensity = intensity_map.get(intensity, 2)
    n_scenarios = {1: MIN_SCENARIOS, 2: DEFAULT_SCENARIOS, 3: MAX_SCENARIOS, 4: MAX_SCENARIOS + 12}.get(intensity, DEFAULT_SCENARIOS)

    # Tempo: frazione agli scenari, frazione alla polish phase
    scenario_time_total = time_limit_sec * SCENARIO_TIME_FRACTION
    polish_time_total = max(POLISH_MIN_BUDGET, int(time_limit_sec * POLISH_TIME_FRACTION))
    scenario_budget = int(scenario_time_total / n_scenarios)
    scenario_budget = max(SCENARIO_MIN_BUDGET, scenario_budget)

    log(f"Multi-scenario: {n_scenarios} scenari x {scenario_budget}s = {n_scenarios * scenario_budget}s "
        f"+ polish {polish_time_total}s (totale budget {time_limit_sec}s, intensita {intensity})")
    report_progress("optimize", 28, f"Portfolio: {n_scenarios} scenari x {scenario_budget}s + rifinitura")

    # -- Pre-calcola coppie fattibili (uguale per tutti gli scenari) --
    feasible_pairs: list[tuple[int, int, str]] = []
    for i in range(n_seg):
        for j in range(i + 1, n_seg):
            s1, s2 = segments[i], segments[j]
            gap_between = abs(s1.start_min - s2.end_min)
            if gap_between > 700:
                continue
            if s1.end_min > s2.start_min and s2.end_min > s1.start_min:
                continue
            pair_type = _feasible_pair(s1, s2, rules)
            if pair_type:
                feasible_pairs.append((s1.idx, s2.idx, pair_type))

    log(f"CP-SAT: {n_seg} segmenti, {len(feasible_pairs)} coppie fattibili")

    # -- Scenari: portfolio di strategie diverse --
    best_duties: list[DriverDutyV3] | None = None
    best_score = float('inf')
    best_scenario_idx = -1
    best_strategy_used: str = "balanced"
    # FIX-CSP-3: salva decisioni del best per warm-start polish
    best_single_decisions: dict[int, bool] = {}
    best_pair_decisions: dict[tuple[int, int], bool] = {}
    scenario_results: list[dict] = []

    base_seed = int(time.time()) % 10000

    # Rotazione ampia delle strategie + parametri diversificati
    strategy_keys = list(SCENARIO_STRATEGIES.keys())
    lin_levels = [2, 1, 0, 2, 1, 0, 2, 1, 2, 0, 1, 2]
    worker_pool = [8, 6, 4, 8, 6, 4, 8, 6, 4, 8, 6, 4]

    scenario_params = []
    for sc_idx in range(n_scenarios):
        # Scenario 0 = balanced, pure (no noise) → baseline di riferimento
        # Scenari 1..N-1 = rotazione strategie + noise crescente per diversita
        if sc_idx == 0:
            strategy = "balanced"
            noise = 0.0
        else:
            strategy = strategy_keys[(sc_idx - 1) % len(strategy_keys)]
            # Noise progressivo: pochi scenari con noise basso (exploit), altri con noise alto (explore)
            bucket = (sc_idx - 1) // len(strategy_keys)  # 0, 1, 2...
            noise = 0.03 + bucket * 0.06 + ((sc_idx * 17) % 7) * 0.01  # 0.03..~0.25
        scenario_params.append({
            "seed": base_seed + sc_idx * 137 + hash(strategy) % 500,
            "noise": min(0.30, noise),
            "lin_level": lin_levels[sc_idx % len(lin_levels)],
            "n_workers": worker_pool[sc_idx % len(worker_pool)],
            "strategy": strategy,
        })

    t_total_start = time.time()

    for sc_idx, params in enumerate(scenario_params):
        if _stop_requested.is_set():
            log(f"  Scenario {sc_idx+1}/{n_scenarios}: SKIP (stop requested)")
            break

        sc_start = time.time()
        pct = 28 + int(50 * sc_idx / n_scenarios)
        strat_label = SCENARIO_STRATEGIES.get(params["strategy"], {}).get("label", params["strategy"])
        report_progress("optimize", pct,
                       f"Scenario {sc_idx+1}/{n_scenarios} [{strat_label}] noise={params['noise']:.2f}")

        model, single, pvars, ptypes = _build_cpsat_model(
            segments, feasible_pairs, rules, rates, bds, clusters,
            scenario_seed=params["seed"],
            scenario_noise=params["noise"],
            strategy=params["strategy"],
        )

        solver = cp_model.CpSolver()
        solver.parameters.max_time_in_seconds = scenario_budget
        solver.parameters.num_workers = params["n_workers"]
        solver.parameters.log_search_progress = False
        solver.parameters.random_seed = params["seed"]
        solver.parameters.linearization_level = params["lin_level"]
        # Diversificazione extra: alcuni scenari abilitano LNS focalizzata
        if sc_idx % 3 == 2:
            try:
                solver.parameters.use_lns_only = False
                solver.parameters.diversify_lns_params = True
            except Exception:
                pass

        status = solver.solve(model)
        sc_elapsed = time.time() - sc_start

        status_name = {
            cp_model.OPTIMAL: "OPTIMAL",
            cp_model.FEASIBLE: "FEASIBLE",
            cp_model.INFEASIBLE: "INFEASIBLE",
            cp_model.MODEL_INVALID: "MODEL_INVALID",
            cp_model.UNKNOWN: "UNKNOWN",
        }.get(status, f"CODE_{status}")

        params_out = {
            "seed": params["seed"],
            "noise": round(params["noise"], 3),
            "linLevel": params["lin_level"],
            "nWorkers": params["n_workers"],
            "strategy": params["strategy"],
            "strategyLabel": strat_label,
        }

        if status not in (cp_model.OPTIMAL, cp_model.FEASIBLE):
            log(f"  Scenario {sc_idx+1} [{strat_label}]: {status_name} in {sc_elapsed:.1f}s -- skip")
            scenario_results.append({
                "idx": sc_idx,
                "scenarioNum": sc_idx + 1,
                "status": status_name,
                "score": float('inf'),
                "feasible": False,
                "elapsed": round(sc_elapsed, 1),
                "params": params_out,
            })
            continue

        duties = _extract_duties_from_solution(
            solver, segments, single, pvars, ptypes, clusters, bds,
        )

        score = _score_solution(duties, rates, bds, clusters)
        metrics = _compute_scenario_metrics(duties, rates, bds, clusters)

        n_total = len(duties)
        n_suppl = sum(1 for d in duties if d.duty_type == "supplemento")
        obj_val = solver.objective_value

        is_best = " * BEST" if score < best_score else ""
        log(f"  Scenario {sc_idx+1} [{strat_label}]: {status_name} in {sc_elapsed:.1f}s -- "
            f"{n_total} turni ({n_suppl} suppl), work={metrics['totalWorkH']}h, "
            f"cost=EUR{metrics['totalCost']:.0f}, score={score:.0f}{is_best}")

        scenario_results.append({
            "idx": sc_idx,
            "scenarioNum": sc_idx + 1,
            "status": status_name,
            "feasible": True,
            "score": round(score, 2),
            "obj": round(obj_val, 0),
            "elapsed": round(sc_elapsed, 1),
            "params": params_out,
            **metrics,
        })

        if score < best_score:
            best_score = score
            best_duties = duties
            best_scenario_idx = sc_idx
            best_strategy_used = params["strategy"]
            # FIX-CSP-3: cattura decisioni per warm-start polish
            best_single_decisions, best_pair_decisions = _capture_solver_decisions(
                solver, single, pvars,
            )

        if time.time() - t_total_start > scenario_time_total:
            log(f"  Tempo esaurito dopo {sc_idx+1} scenari")
            break

    total_scenario_elapsed = time.time() - t_total_start

    # ═══════════ POLISH PHASE ═══════════
    # Prendi il migliore e rifiniscilo: stessa strategia + tempo piu lungo + noise=0
    # per convergere verso l'ottimo della strategia vincente.
    polish_improved = False
    polish_score_before = best_score
    polish_score_after = best_score
    polish_elapsed = 0.0

    if best_duties is not None and not _stop_requested.is_set():
        polish_budget = min(polish_time_total, max(POLISH_MIN_BUDGET, int(polish_time_total)))
        report_progress("optimize", 82, f"Rifinitura: polish {polish_budget}s su strategia {best_strategy_used}")
        log(f"Polish phase: strategia={best_strategy_used}, tempo={polish_budget}s, "
            f"warm-start da scenario {best_scenario_idx + 1}")

        polish_start = time.time()
        polish_model, p_single, p_pvars, p_ptypes = _build_cpsat_model(
            segments, feasible_pairs, rules, rates, bds, clusters,
            scenario_seed=base_seed + 99991,
            scenario_noise=0.0,
            strategy=best_strategy_used,
        )

        # FIX-CSP-3: warm-start dal best scenario.
        # Senza questo, il polish parte cieco e raramente trova soluzioni
        # migliori perche' il budget tempo (15-30s) e' troppo basso per
        # ricominciare da zero.
        n_hints_single = 0
        n_hints_pair = 0
        for s_idx, sv in p_single.items():
            if s_idx in best_single_decisions:
                polish_model.add_hint(sv, 1 if best_single_decisions[s_idx] else 0)
                n_hints_single += 1
        for key, pv in p_pvars.items():
            if key in best_pair_decisions:
                polish_model.add_hint(pv, 1 if best_pair_decisions[key] else 0)
                n_hints_pair += 1
        log(f"Polish: applicati {n_hints_single} hint single + {n_hints_pair} hint pair")

        polish_solver = cp_model.CpSolver()
        polish_solver.parameters.max_time_in_seconds = polish_budget
        polish_solver.parameters.num_workers = 8
        polish_solver.parameters.log_search_progress = False
        polish_solver.parameters.random_seed = base_seed + 99991
        polish_solver.parameters.linearization_level = 2

        polish_status = polish_solver.solve(polish_model)
        polish_elapsed = time.time() - polish_start

        if polish_status in (cp_model.OPTIMAL, cp_model.FEASIBLE):
            polish_duties = _extract_duties_from_solution(
                polish_solver, segments, p_single, p_pvars, p_ptypes, clusters, bds,
            )
            polish_score = _score_solution(polish_duties, rates, bds, clusters)
            polish_metrics = _compute_scenario_metrics(polish_duties, rates, bds, clusters)

            log(f"  Polish: score={polish_score:.0f} (prima={best_score:.0f}) in {polish_elapsed:.1f}s")

            # Aggiungi il risultato polish come "scenario" speciale
            scenario_results.append({
                "idx": len(scenario_results),
                "scenarioNum": 0,  # 0 = polish
                "status": {cp_model.OPTIMAL: "OPTIMAL", cp_model.FEASIBLE: "FEASIBLE"}.get(polish_status, "?"),
                "feasible": True,
                "score": round(polish_score, 2),
                "obj": round(polish_solver.objective_value, 0),
                "elapsed": round(polish_elapsed, 1),
                "params": {
                    "seed": base_seed + 99991,
                    "noise": 0.0,
                    "linLevel": 2,
                    "nWorkers": 8,
                    "strategy": best_strategy_used,
                    "strategyLabel": SCENARIO_STRATEGIES.get(best_strategy_used, {}).get("label", best_strategy_used),
                    "isPolish": True,
                },
                "isPolish": True,
                **polish_metrics,
            })

            if polish_score < best_score:
                log(f"  Polish MIGLIORATO -> delta={best_score - polish_score:.0f} ({((best_score - polish_score) / best_score * 100):.1f}%)")
                polish_improved = True
                polish_score_after = polish_score
                best_duties = polish_duties
                best_score = polish_score

    total_elapsed = time.time() - t_total_start
    log(f"Portfolio: {len(scenario_results)} scenari in {total_elapsed:.1f}s, "
        f"migliore = scenario {best_scenario_idx+1} strategia '{best_strategy_used}' (score={best_score:.0f})")
    report_progress("optimize", 88, f"Rifinitura completata (score {best_score:.0f})")

    # Ranking: scenari fattibili ordinati per score asc, poi gli infattibili in fondo
    feasible = [s for s in scenario_results if s.get("feasible")]
    infeasible = [s for s in scenario_results if not s.get("feasible")]
    feasible.sort(key=lambda s: s["score"])
    for rank, s in enumerate(feasible, start=1):
        s["rank"] = rank
        s["isBest"] = (rank == 1)
    ranked = feasible + infeasible

    # Salva in container globale per il main()
    global LAST_SCENARIO_RESULTS, LAST_OPTIMIZATION_ANALYSIS
    LAST_SCENARIO_RESULTS = ranked

    # -- Costruisci analisi sintetica per il frontend --
    # Raggruppa per strategia
    by_strategy: dict[str, list[dict]] = {}
    for s in feasible:
        k = s.get("params", {}).get("strategy", "balanced")
        by_strategy.setdefault(k, []).append(s)

    strategy_summary = []
    for strat_key, strat_runs in by_strategy.items():
        meta = SCENARIO_STRATEGIES.get(strat_key, {})
        best_of_strat = min(strat_runs, key=lambda x: x["score"])
        strategy_summary.append({
            "key": strat_key,
            "label": meta.get("label", strat_key),
            "desc": meta.get("desc", ""),
            "nRuns": len(strat_runs),
            "bestScore": round(best_of_strat["score"], 2),
            "bestCost": best_of_strat.get("totalCost"),
            "bestDuties": best_of_strat.get("duties"),
            "isWinner": strat_key == best_strategy_used,
        })
    strategy_summary.sort(key=lambda x: x["bestScore"])

    # Best metrics overview (dalla soluzione migliore finale)
    best_metrics_final = None
    best_entry = next((s for s in ranked if s.get("isBest")), None)
    if best_entry:
        best_metrics_final = {
            "duties": best_entry.get("duties"),
            "totalCost": best_entry.get("totalCost"),
            "totalWorkH": best_entry.get("totalWorkH"),
            "bdsViolations": best_entry.get("bdsViolations"),
            "vuotiSignificativi": best_entry.get("vuotiSignificativi"),
            "score": best_entry.get("score"),
        }

    # Score spread (min vs max feasible) -> da' idea di quanta variabilita c'e
    if len(feasible) >= 2:
        score_min = feasible[0]["score"]
        score_max = feasible[-1]["score"]
        score_spread_pct = round((score_max - score_min) / max(score_min, 1) * 100, 1)
    else:
        score_spread_pct = 0.0

    LAST_OPTIMIZATION_ANALYSIS = {
        "nScenariosRun": len([s for s in scenario_results if not s.get("isPolish")]),
        "nScenariosRequested": n_scenarios,
        "nFeasible": len(feasible),
        "nInfeasible": len(infeasible),
        "totalElapsedSec": round(total_elapsed, 1),
        "scenarioElapsedSec": round(total_scenario_elapsed, 1),
        "polishElapsedSec": round(polish_elapsed, 1),
        "polishImproved": polish_improved,
        "polishDeltaScore": round(polish_score_before - polish_score_after, 2) if polish_improved else 0.0,
        "polishDeltaPct": round((polish_score_before - polish_score_after) / max(polish_score_before, 1) * 100, 2) if polish_improved else 0.0,
        "bestScore": round(best_score, 2),
        "bestStrategy": best_strategy_used,
        "bestStrategyLabel": SCENARIO_STRATEGIES.get(best_strategy_used, {}).get("label", best_strategy_used),
        "bestStrategyDesc": SCENARIO_STRATEGIES.get(best_strategy_used, {}).get("desc", ""),
        "scoreSpreadPct": score_spread_pct,
        "strategiesExplored": len(by_strategy),
        "totalStrategiesAvailable": len(SCENARIO_STRATEGIES),
        "strategySummary": strategy_summary,
        "bestMetrics": best_metrics_final,
        "intensity": intensity,
        "timeBudgetSec": time_limit_sec,
        "scenarioBudgetSec": scenario_budget,
        "polishBudgetSec": polish_time_total,
        "nSegments": n_seg,
        "nFeasiblePairs": len(feasible_pairs),
    }

    if best_duties is None:
        log("Tutti gli scenari falliti -- fallback a greedy")
        return greedy_fallback(blocks, segments, config, clusters, bds)

    return best_duties


# Alias retrocompatibilita
def optimize_global(
    blocks: list[VehicleBlock],
    segments: list[Segment],
    config: dict,
    time_limit_sec: int,
    clusters: list[Cluster],
    bds: BDSConfig,
) -> list[DriverDutyV3]:
    """Wrapper retrocompatibilita -> multi-scenario."""
    return optimize_multi_scenario(blocks, segments, config, time_limit_sec, clusters, bds)


# ═══════════════════════════════════════════════════════════════
#  GREEDY FALLBACK
# ═══════════════════════════════════════════════════════════════

def greedy_fallback(
    blocks: list[VehicleBlock],
    segments: list[Segment],
    config: dict,
    clusters: list[Cluster],
    bds: BDSConfig,
) -> list[DriverDutyV3]:
    """Fallback greedy se CP-SAT non trova soluzione."""
    rules = config.get("shiftRules", SHIFT_RULES)
    duties: list[DriverDutyV3] = []
    used: set[int] = set()
    duty_idx = 0

    sorted_segs = sorted(segments, key=lambda s: s.start_min)

    # Pass 1: pairing greedy
    morning = [s for s in sorted_segs if s.end_min <= 840]
    afternoon = [s for s in sorted_segs if s.start_min >= 720]

    for sm in morning:
        if sm.idx in used:
            continue
        best_pair = None
        best_type = None
        best_score = -1.0

        for sa in afternoon:
            if sa.idx in used or sa.idx == sm.idx:
                continue
            ptype = _feasible_pair(sm, sa, rules)
            if ptype:
                combined_work = sm.work_min + sa.work_min
                dev = abs(combined_work + pre_turno_for(DEPOT_TRANSFER_CENTRAL) + DEPOT_TRANSFER_CENTRAL - TARGET_WORK_MID)
                score = 1000.0 - dev
                if score > best_score:
                    best_score = score
                    best_pair = sa
                    best_type = ptype

        if best_pair and best_type:
            s1, s2 = sm, best_pair
            if s1.start_min > s2.start_min:
                s1, s2 = s2, s1

            interruption = s2.start_min - s1.end_min
            transfer = depot_transfer_min(s1.first_stop, clusters)
            transfer_back = depot_transfer_min(s2.last_stop, clusters)
            pt = pre_turno_for(transfer)
            nastro = s2.end_min - s1.start_min + pt + transfer + transfer_back
            work = s1.work_min + s2.work_min + pt + transfer_back + bds.pre_post.pre_ripresa

            d = DriverDutyV3(
                idx=duty_idx,
                driver_id=f"D{duty_idx + 1:03d}",
                duty_type=best_type,
                segments=[s1, s2],
                nastro_start=s1.start_min - pt - transfer,
                nastro_end=s2.end_min + transfer_back,
                nastro_min=nastro,
                work_min=work,
                driving_min=s1.driving_min + s2.driving_min,
                interruption_min=interruption,
                pre_turno_min=pt,
                transfer_min=transfer,
                transfer_back_min=transfer_back,
            )
            # Riclassifica post-hoc
            d.duty_type = classify_duty(d, bds, clusters)
            duties.append(d)
            used.add(sm.idx)
            used.add(best_pair.idx)
            duty_idx += 1

    # Pass 2: segmenti rimasti
    for s in sorted_segs:
        if s.idx in used:
            continue
        transfer = depot_transfer_min(s.first_stop, clusters)
        transfer_back = depot_transfer_min(s.last_stop, clusters)
        pt = pre_turno_for(transfer)
        nastro_s = s.work_min + pt + transfer + transfer_back

        d = DriverDutyV3(
            idx=duty_idx,
            driver_id=f"D{duty_idx + 1:03d}",
            duty_type="supplemento" if nastro_s <= SUPPLEMENTO_NASTRO_MAX else "intero",
            segments=[s],
            nastro_start=s.start_min - pt - transfer,
            nastro_end=s.end_min + transfer_back,
            nastro_min=nastro_s,
            work_min=s.work_min + pt + transfer_back,
            driving_min=s.driving_min,
            interruption_min=0,
            pre_turno_min=pt,
            transfer_min=transfer,
            transfer_back_min=transfer_back,
        )
        d.duty_type = classify_duty(d, bds, clusters)
        duties.append(d)
        used.add(s.idx)
        duty_idx += 1

    return duties


# ═══════════════════════════════════════════════════════════════
#  HANDOVER & CAR POOL (importati da v3 — stessa logica)
# ═══════════════════════════════════════════════════════════════

# Importiamo le funzioni da v3 per non duplicare codice
from crew_scheduler_v3 import (
    Handover,
    compute_handovers,
    serialize_handovers,
    CarTrip,
    compute_car_pool,
    car_pool_by_driver,
    _max_simultaneous_cars_out,
)


# ═══════════════════════════════════════════════════════════════
#  SERIALIZZAZIONE OUTPUT
# ═══════════════════════════════════════════════════════════════

def _segment_to_ripresa(
    seg: Segment,
    is_first: bool,
    is_last: bool,
    duty: DriverDutyV3,
    clusters: list[Cluster] | None = None,
) -> dict:
    """Converte un Segment nella struttura Ripresa per il frontend."""
    n_segs = len(duty.segments)
    diff_vehicles = n_segs >= 2 and duty.segments[0].vehicle_id != duty.segments[-1].vehicle_id

    if diff_vehicles:
        _transfer_out = depot_transfer_min(seg.first_stop, clusters)
        _transfer_back = depot_transfer_min(seg.last_stop, clusters)
        pre_turno = pre_turno_for(_transfer_out)
        transfer = _transfer_out
        transfer_back = _transfer_back
    else:
        pre_turno = duty.pre_turno_min if is_first else 0
        transfer = duty.transfer_min if is_first else 0
        transfer_back = duty.transfer_back_min if is_last else 0

    transfer_type = "depot_to_start" if transfer > 0 else "none"
    transfer_back_type = "end_to_depot" if transfer_back > 0 else "none"
    transfer_to_stop = seg.first_stop or "?"
    transfer_to_cluster = seg.first_cluster or None
    vehicle_ids = list(dict.fromkeys([seg.vehicle_id]))

    trips_out = []
    for t in seg.trips:
        if t.type != "trip":
            continue
        trips_out.append({
            "tripId": t.trip_id,
            "routeId": t.route_id,
            "routeName": t.route_name,
            "headsign": t.headsign,
            "departureTime": t.departure_time,
            "arrivalTime": t.arrival_time,
            "departureMin": t.departure_min,
            "arrivalMin": t.arrival_min,
            "firstStopName": t.first_stop_name,
            "lastStopName": t.last_stop_name,
            "vehicleId": seg.vehicle_id,
            "vehicleType": seg.vehicle_type,
        })

    return {
        "startTime": min_to_time(seg.start_min),
        "endTime": min_to_time(seg.end_min),
        "startMin": seg.start_min,
        "endMin": seg.end_min,
        "preTurnoMin": pre_turno,
        "transferMin": transfer,
        "transferType": transfer_type,
        "transferToStop": transfer_to_stop,
        "transferToCluster": transfer_to_cluster,
        "transferBackMin": transfer_back,
        "transferBackType": transfer_back_type,
        "lastStop": seg.last_stop or "?",
        "lastCluster": seg.last_cluster or None,
        "workMin": seg.work_min,
        "vehicleIds": vehicle_ids,
        "vehicleType": seg.vehicle_type,
        "cambi": [],
        "trips": trips_out,
    }


def serialize_output(
    duties: list[DriverDutyV3],
    blocks: list[VehicleBlock],
    segments: list[Segment],
    config: dict,
    clusters: list[Cluster],
    validation: dict,
    elapsed_sec: float,
    bds: BDSConfig,
    handovers: list[Handover] | None = None,
    car_movements: list[CarTrip] | None = None,
) -> dict:
    """Serializza nel formato atteso dal frontend, con dati BDS arricchiti."""
    rates = CostRates.from_config(config)

    if handovers is None:
        handovers = []
    if car_movements is None:
        car_movements = []

    handovers_by_driver: dict[str, list[Handover]] = {}
    for h in handovers:
        handovers_by_driver.setdefault(h.outgoing_driver, []).append(h)
        handovers_by_driver.setdefault(h.incoming_driver, []).append(h)

    car_by_driver = car_pool_by_driver(car_movements)

    # ── Costi BDS ──
    total_cost = 0.0
    for d in duties:
        cb = compute_duty_cost_v4(d, rates, bds, clusters)
        d.cost_euro = round(cb.total, 2)
        d.cost_breakdown_obj = cb  # type: ignore[attr-defined]
        total_cost += cb.total

    # ── Summary ──
    type_counts: dict[str, int] = {"intero": 0, "semiunico": 0, "spezzato": 0, "supplemento": 0}
    for d in duties:
        type_counts[d.duty_type] = type_counts.get(d.duty_type, 0) + 1

    n_total = len(duties)
    n_suppl = type_counts.get("supplemento", 0)
    n_princ = n_total - n_suppl

    all_work = [d.work_min for d in duties]
    all_nastro = [d.nastro_min for d in duties]
    avg_work = sum(all_work) / max(n_total, 1)
    avg_nastro = sum(all_nastro) / max(n_total, 1)
    total_work_hours = sum(all_work) / 60.0
    total_nastro_hours = sum(all_nastro) / 60.0
    total_driving = sum(d.driving_min for d in duties)

    semi_pct = round(type_counts.get("semiunico", 0) / max(n_princ, 1) * 100, 1)
    spez_pct = round(type_counts.get("spezzato", 0) / max(n_princ, 1) * 100, 1)

    # ── Serializza driver shifts ──
    cluster_names = {c.id: c.name for c in clusters}
    driver_shifts = []

    for d in duties:
        riprese = []
        my_car = car_by_driver.get(d.driver_id, {})
        all_delivers: list = my_car.get("all_delivers", [])
        all_pickups: list = my_car.get("all_pickups", [])

        for si, seg in enumerate(d.segments):
            rip = _segment_to_ripresa(seg, si == 0, si == len(d.segments) - 1, d, clusters)

            deliver = all_delivers[si] if si < len(all_delivers) else None
            if deliver:
                car_label = f"Auto {deliver.car_id}" if deliver.car_id else "⚠️ Nessuna auto"
                rip["carPoolOut"] = {
                    "carId": deliver.car_id,
                    "departMin": deliver.depart_min,
                    "departTime": min_to_time(deliver.depart_min),
                    "arriveMin": deliver.arrive_min,
                    "arriveTime": min_to_time(deliver.arrive_min),
                    "description": f"Guidi {car_label} dal deposito a {deliver.cluster_name}",
                }
            else:
                rip["carPoolOut"] = None

            pickup = all_pickups[si] if si < len(all_pickups) else None
            if pickup:
                car_label = f"Auto {pickup.car_id}" if pickup.car_id else "⚠️ Nessuna auto"
                rip["carPoolReturn"] = {
                    "carId": pickup.car_id,
                    "departMin": pickup.depart_min,
                    "departTime": min_to_time(pickup.depart_min),
                    "arriveMin": pickup.arrive_min,
                    "arriveTime": min_to_time(pickup.arrive_min),
                    "description": f"Prendi {car_label} da {pickup.cluster_name} al deposito",
                }
            else:
                rip["carPoolReturn"] = None

            riprese.append(rip)

        # Handover
        my_handovers = handovers_by_driver.get(d.driver_id, [])
        handovers_out = []
        for h in my_handovers:
            is_outgoing = (h.outgoing_driver == d.driver_id)
            cluster_label = cluster_names.get(h.cluster or "", h.at_stop or "?")
            cut_type = getattr(h, 'cut_type', 'inter')
            trip_id = getattr(h, 'trip_id', '')
            route_name = getattr(h, 'route_name', '')
            intra_label = f" (intra-corsa {route_name})" if cut_type == "intra" and route_name else ""
            handovers_out.append({
                "vehicleId": h.vehicle_id,
                "atMin": h.at_min,
                "atTime": min_to_time(h.at_min),
                "atStop": h.at_stop,
                "cluster": h.cluster,
                "clusterName": cluster_label,
                "role": "outgoing" if is_outgoing else "incoming",
                "otherDriver": h.incoming_driver if is_outgoing else h.outgoing_driver,
                "cutType": cut_type,
                "tripId": trip_id,
                "routeName": route_name,
                "description": (
                    f"LASCIA bus {h.vehicle_id} AL TURNO {h.incoming_driver} a {cluster_label}{intra_label}"
                    if is_outgoing else
                    f"PRENDE bus {h.vehicle_id} DAL TURNO {h.outgoing_driver} a {cluster_label}{intra_label}"
                ),
            })

        handover_labels: list[str] = []
        for h in my_handovers:
            is_outgoing = (h.outgoing_driver == d.driver_id)
            if is_outgoing:
                handover_labels.append(f"LASCIA bus {h.vehicle_id} AL TURNO {h.incoming_driver}")
            else:
                handover_labels.append(f"PRENDE bus {h.vehicle_id} DAL TURNO {h.outgoing_driver}")

        # BDS validation per duty
        bds_val = getattr(d, 'bds_validation', None)
        bds_val_dict = bds_val.to_dict() if bds_val else None

        # Work calculation BDS
        wc = getattr(d, 'work_calculation', None)
        wc_dict = wc.to_dict() if wc else None

        # Cost breakdown dettagliato
        cb_obj = getattr(d, 'cost_breakdown_obj', None)
        cb_dict = cb_obj.to_dict() if cb_obj else None

        driver_shifts.append({
            "driverId": d.driver_id,
            "type": d.duty_type,
            "nastroStart": min_to_time(max(0, d.nastro_start)),
            "nastroEnd": min_to_time(d.nastro_end),
            "nastroStartMin": d.nastro_start,
            "nastroEndMin": d.nastro_end,
            "nastroMin": d.nastro_min,
            "nastro": fmt_dur(d.nastro_min),
            "workMin": d.work_min,
            "work": fmt_dur(d.work_min),
            "interruptionMin": d.interruption_min,
            "interruption": fmt_dur(d.interruption_min) if d.interruption_min > 0 else None,
            "transferMin": d.transfer_min,
            "transferBackMin": d.transfer_back_min,
            "preTurnoMin": d.pre_turno_min,
            "cambiCount": len(d.cambi) + len(my_handovers),
            "riprese": riprese,
            "handovers": handovers_out,
            "vehicleHandoverLabels": handover_labels,
            "costEuro": d.cost_euro,
            "costBreakdown": cb_dict or {
                "base": round(d.work_min * rates.hourly_rate / 60.0, 2),
                "transfer": round((d.transfer_min + d.transfer_back_min) * rates.hourly_rate / 60.0, 2),
            },
            # ── BDS arricchimenti ──
            "bdsValidation": bds_val_dict,
            "workCalculation": wc_dict,
        })

    return {
        "driverShifts": driver_shifts,
        "handovers": serialize_handovers(handovers, clusters),
        "summary": {
            "totalDriverShifts": n_princ,
            "totalSupplementi": n_suppl,
            "totalShifts": n_total,
            "byType": type_counts,
            "totalWorkHours": round(total_work_hours, 1),
            "avgWorkMin": round(avg_work, 0),
            "totalNastroHours": round(total_nastro_hours, 1),
            "avgNastroMin": round(avg_nastro, 0),
            "semiunicoPct": semi_pct,
            "spezzatoPct": spez_pct,
            "totalCambi": len(handovers),
            "totalInterCambi": sum(1 for h in handovers if getattr(h, 'cut_type', 'inter') == 'inter'),
            "totalIntraCambi": sum(1 for h in handovers if getattr(h, 'cut_type', 'inter') == 'intra'),
            "companyCarsUsed": len({seg.vehicle_id for d in duties for seg in d.segments}),
            "totalDailyCost": round(total_cost, 2),
            "costBreakdown": {
                "salaries": round(sum(d.work_min for d in duties) * rates.hourly_rate / 60, 2),
                "transfers": round(n_total * rates.company_car_per_use, 2),
                "supplementi": round(n_suppl * rates.supplemento_daily, 2),
            },
            "efficiency": {
                "productivityPct": round(total_driving / max(sum(all_work), 1) * 100, 1),
                "supplementiPct": round(n_suppl / max(n_total, 1) * 100, 1),
                "costPerDriver": round(total_cost / max(n_total, 1), 2),
                "avgCostPerDriver": round(total_cost / max(n_total, 1), 2),
            },
            "validation": validation,
        },
        "metrics": {
            "solver": "cpsat_v4_bds",
            "vehicleBlocks": len(blocks),
            "segments": len(segments),
            "totalDuties": n_total,
            "elapsedSec": round(elapsed_sec, 1),
            "classifications": {
                "CORTO": sum(1 for b in blocks if b.classification == "CORTO"),
                "CORTO_BASSO": sum(1 for b in blocks if b.classification == "CORTO_BASSO"),
                "MEDIO": sum(1 for b in blocks if b.classification == "MEDIO"),
                "LUNGO": sum(1 for b in blocks if b.classification == "LUNGO"),
            },
        },
        "bdsConfig": bds.to_dict(),
        "clusters": [
            {"id": c.id, "name": c.name, "transferMin": c.transfer_from_depot_min}
            for c in clusters
        ],
        "companyCars": COMPANY_CARS,
        "optimizerParams": {
            "minWorkPerDuty": MIN_WORK_PER_DUTY,
            "maxCompanyCars": MAX_COMPANY_CARS,
            "weightDutyCount": WEIGHT_DUTY_COUNT,
            "weightIdlePenalty": WEIGHT_IDLE_PENALTY,
            "idlePenaltyMaxMin": IDLE_PENALTY_MAX_MIN,
            "scorePerDuty": SCORE_PER_DUTY,
        },
        "carPool": {
            "totalTrips": len(car_movements),
            "deliveries": sum(1 for t in car_movements if t.trip_type == "deliver"),
            "pickups": sum(1 for t in car_movements if t.trip_type == "pickup"),
            "conflicts": sum(1 for t in car_movements if t.car_id is None),
            "maxSimultaneous": _max_simultaneous_cars_out(car_movements),
        },
        "rates": rates.to_dict(),
    }


# ═══════════════════════════════════════════════════════════════
#  MAIN
# ═══════════════════════════════════════════════════════════════

def main() -> None:
    t_start = time.time()

    # ── Input ──
    # Default tempo PIÙ ALTO (Maior-style): 240s anziché 120s, scala con intensità via UI
    time_limit_sec = int(sys.argv[1]) if len(sys.argv) > 1 else 240
    raw = load_input()
    vehicle_shifts_raw = raw.get("vehicleShifts", [])
    user_config = raw.get("config", {})
    config = merge_config(user_config)

    # Permetti override delle SHIFT_RULES da config.bds.shiftRules
    apply_shift_rules_override(config)
    # Override iperparametri ottimizzatore (saturazione, vetture, pesi)
    apply_optimizer_overrides(config)

    clusters = parse_clusters_from_config(config)
    bds = BDSConfig.from_config(config)

    log(f"=== Crew Scheduler V4 (BDS) ===")
    log(f"Input: {len(vehicle_shifts_raw)} turni macchina, timeLimit={time_limit_sec}s")
    log(f"BDS config: pre/post={bds.pre_post.pre_turno_deposito}/{bds.pre_post.post_turno_deposito}, "
        f"RD131={'ON' if bds.rd131.attivo else 'OFF'}, "
        f"pasto={'ON' if bds.pasto.attivo else 'OFF'}")
    report_progress("init", 5, f"{len(vehicle_shifts_raw)} turni macchina")

    # ── Fase 1: Parsing ──
    blocks = parse_vehicle_blocks(vehicle_shifts_raw, clusters)
    log(f"Fase 1: {len(blocks)} vehicle blocks parsati")
    report_progress("parse", 10, f"{len(blocks)} blocchi")

    # ── Fase 2: Analisi con BDS ──
    for b in blocks:
        analyze_vehicle_block(b, clusters, bds)
    classify_blocks(blocks, clusters)

    # Collassa tagli troppo vicini (BDS)
    collassa_cambi(blocks)

    # Filtra tagli solo su cluster
    filter_cuts_by_cluster(blocks, config)

    class_summary: dict[str, int] = {}
    for b in blocks:
        class_summary[b.classification] = class_summary.get(b.classification, 0) + 1
    log(f"Fase 2: classificazione = {class_summary}")
    report_progress("analyze", 20, f"Classificati: {class_summary}")

    # ── Fase 3: Costruzione segmenti ──
    segments = build_initial_segments(blocks, clusters)
    log(f"Fase 3: {len(segments)} segmenti generati")
    report_progress("segments", 25, f"{len(segments)} segmenti")

    # ── Fase 4: Ottimizzazione multi-scenario CP-SAT (RD 131/1938) ──
    duties = optimize_multi_scenario(blocks, segments, config, time_limit_sec, clusters, bds)

    n_total = len(duties)
    n_suppl = sum(1 for d in duties if d.duty_type == "supplemento")
    log(f"Fase 4: {n_total} turni guida ({n_total - n_suppl} principali + {n_suppl} supplementi)")
    report_progress("duties", 70, f"{n_total} turni ({n_suppl} suppl)")

    # ── Fase 5: Validazione BDS completa ──
    validation = validate_all_bds(duties, bds, clusters)
    n_viol = validation["totalViolations"]
    log(f"Fase 5: validazione BDS — {n_viol} violazioni su {validation['dutiesWithViolations']} turni")
    report_progress("validate", 80, f"{n_viol} violazioni BDS")

    # ── Fase 6: Handover & Car Pool ──
    handovers = compute_handovers(duties, clusters)
    log(f"Fase 6: {len(handovers)} cambi bus identificati")

    car_movements = compute_car_pool(duties, clusters)
    n_conflicts = sum(1 for m in car_movements if m.car_id is None)
    max_sim = _max_simultaneous_cars_out(car_movements)
    log(f"Fase 6: {len(car_movements)} viaggi auto, {n_conflicts} conflitti, max {max_sim} auto fuori deposito")
    report_progress("carpool", 90, f"{len(car_movements)} viaggi auto")

    # ── Fase 7: Output ──
    elapsed = time.time() - t_start
    output = serialize_output(
        duties, blocks, segments, config, clusters, validation,
        elapsed, bds, handovers, car_movements,
    )

    # Inietta la classifica di tutti gli scenari multi-CP-SAT
    if LAST_SCENARIO_RESULTS:
        output["scenarios"] = LAST_SCENARIO_RESULTS
        feasible_count = sum(1 for s in LAST_SCENARIO_RESULTS if s.get("feasible"))
        log(f"Scenari classificati: {feasible_count}/{len(LAST_SCENARIO_RESULTS)} fattibili")

    # Inietta l'analisi sintetica del processo di ottimizzazione
    if LAST_OPTIMIZATION_ANALYSIS:
        output["optimizationAnalysis"] = LAST_OPTIMIZATION_ANALYSIS

    log(f"=== DONE in {elapsed:.1f}s — {n_total} turni, {n_suppl} supplementi "
        f"({n_suppl * 100 // max(n_total, 1)}%), €{output['summary']['totalDailyCost']:.0f}/giorno, "
        f"{n_viol} violazioni BDS ===")
    report_progress("done", 100, f"{n_total} turni, €{output['summary']['totalDailyCost']:.0f}/giorno")

    write_output(output)


if __name__ == "__main__":
    main()
