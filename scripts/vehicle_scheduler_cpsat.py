#!/usr/bin/env python3
"""
vehicle_scheduler_cpsat.py - CP-SAT Vehicle Scheduling Problem v3
Conerobus S.p.A. / TransitIntel / Cerbero - Level 1 Optimisation

CHANGELOG v3 (rispetto a v2):
  FIX-1  Warm-start strategy: primi N/2 scenari partono da perturbazioni del
         greedy (diversità strutturale), secondi N/2 dal best corrente
         (intensificazione), polish dal best.
  FIX-2  Bonus/penalty di strategia scalati sui costi dominanti:
         - monolinea: -(fixed_daily * 0.15 * (mul-1))  -> ~6.3 EUR per arco
         - pairing:   +gap * 0.05 * (mul-1)            -> ~0.75 EUR/min gap
         (prima erano 0.5 e 0.005, sotto la soglia di rumore del rounding)
  FIX-3  No-good cuts tra scenari: ogni scenario dopo il primo impone che
         almeno `min_arc_diff_pct` degli archi del best attuale siano
         sostituiti -> garantisce diversità topologica reale.
  FIX-4  Local search ora usa chain_cost_detailed (con penalità quadratiche)
         come funzione di accettazione - coerente con il costo reportato.
  FIX-5  Polish usa strategia COMPLEMENTARE al best trovato (non sempre
         balanced). Mappatura definita in POLISH_COMPLEMENT.
  FIX-6  COST_SCALE portato a 1000 (centesimi -> decimi di centesimo)
         per preservare differenze fini nel rounding.
  FIX-7  Nuovo oggetto VSPConfig con parametri utente esponibili via UI
         (letto da config.vspAdvanced) + validazione.

Usage:
  echo '<json>' | python3 vehicle_scheduler_cpsat.py [time_limit_sec]
"""

from __future__ import annotations
import bisect
import random
import sys
import time
import math
from collections import defaultdict
from dataclasses import dataclass, field
from typing import Any

from ortools.sat.python import cp_model

from optimizer_common import (
    Trip, Arc, VShiftTrip, VehicleShift, VehicleCostRates, VehicleShiftCost,
    trip_from_dict, vehicle_shift_to_dict,
    VEHICLE_SIZE, VEHICLE_TYPES, MAX_DOWNSIZE_LEVELS,
    MAX_DEADHEAD_KM, MIN_LAYOVER, DEADHEAD_BUFFER,
    AVG_SERVICE_SPEED, DEADHEAD_SPEED,
    haversine_km, estimate_deadhead, is_peak_hour, can_vehicle_serve,
    min_to_time, fmt_dur,
    load_input, write_output, log, report_progress,
)

# FIX-6: aumentato da 100 a 1000 per evitare che bonus < 0.01 EUR vengano
# azzerati dal rounding intero. Tutti i costi CP-SAT ora in "decimi di cent".
COST_SCALE = 1000


# ─── USER-CONFIGURABLE PARAMETERS (esponibile via UI Cerbero) ──────────
# Questi parametri erano hard-coded in v2. Ora sono raggruppati in VSPConfig
# e possono essere sovrascritti da config.vspAdvanced nel JSON input.

@dataclass
class VSPConfig:
    """Parametri utente per il portfolio multi-scenario.

    Defaults scelti per bilanciamento qualità/tempo su istanze tipiche
    Conerobus (200-400 corse/giorno, ~15k archi)."""
    # --- PORTFOLIO ---
    intensity: str = "deep"                      # fast | normal | deep | extreme
    strategies_enabled: list[str] = field(default_factory=lambda: [
        "balanced", "min_vehicles", "saturation", "min_deadhead", "monolinea",
        "min_idle", "compact", "depot_minimal",
    ])
    # Se None, viene derivato da intensity. Se int, forza numero scenari.
    scenarios_override: int | None = None

    # --- DIVERSITY (no-good cuts) ---
    enable_no_good_cuts: bool = True
    min_arc_diff_pct: float = 0.12      # almeno 12% archi diversi dal best
    min_arc_diff_abs: int = 5           # minimo assoluto di archi diversi

    # --- WARM-START ---
    warmstart_split: float = 0.5        # frazione scenari SENZA warm-start (diversificazione)
    greedy_perturbations: int = 3       # variazioni greedy per diversificare

    # --- POLISH ---
    enable_polish: bool = True
    polish_time_pct: float = 0.20       # % del budget totale per polish
    polish_strategy: str = "auto"       # auto | fisso (nome strategia)

    # --- LOCAL SEARCH ---
    ls_use_detailed_cost: bool = True   # FIX-4: usa chain_cost_detailed
    ls_time_override_sec: float | None = None
    ls_iter_override: int | None = None
    ls_no_improve_limit: int = 500      # era 300; plateau più tollerante

    # --- STRATEGY WEIGHTS SCALING (FIX-2) ---
    # Se l'utente vuole amplificare ulteriormente l'effetto delle strategie
    strategy_amplifier: float = 1.0

    # --- REGOLA #1: PRIORITA' MINIMIZZAZIONE NUMERO TURNI MACCHINA ---
    # off            = nessun bonus extra (usa solo fixed_daily)
    # soft           = comportamento legacy (moltiplicatori strategia)
    # strict         = aggiunge bonus pari a ~3x il fixed_daily a ogni veicolo
    # lexicographic  = bonus enorme: il solver MAI aggiunge un veicolo se
    #                  esiste una soluzione con uno in meno (anche a costo
    #                  variabile altissimo). Equivale a min num_vehicles
    #                  prima del costo.
    min_vehicles_priority: str = "soft"

    # Override diretto dei costi (se passati da UI sovrascrivono i default)
    cost_rates_override: dict = field(default_factory=dict)

    # Preferenza monolinea: se True, forza la strategia monolinea ad alta priorità
    # nel portfolio e amplifica i bonus same-route negli archi.
    prefer_monolinea: bool = False

    # Post-ottimizzazione: tentativo di eliminare veicoli ridistribuendo le loro
    # corse su altri veicoli (anche con piccolo aumento di costo variabile).
    enable_vehicle_elimination: bool = True
    vehicle_elimination_max_passes: int = 10
    # Tempo dedicato (secondi) — oltre i CP-SAT scenari. Default alto perché
    # l'utente preferisce attendere 30-60s in più piuttosto che vedere un turno
    # in eccesso che a mano si rimuove. None = auto (ls_time, min 45s).
    vehicle_elimination_time_sec: float | None = None

    # FIX-VSP-ITER-RED: dopo tutta la pipeline (CP-SAT + LS + elimination)
    # rilancia CP-SAT con vincolo HARD `nv ≤ N-1`, `N-2`, ... finché trova
    # feasibility o dimostra infeasibility. È la mossa più potente per
    # forzare la riduzione: il solver deve cercare tutte le combinazioni
    # possibili. Costoso ma potente. Default: ON con budget 180s.
    enable_iterative_reduction: bool = True
    iterative_reduction_time_sec: float = 180.0

    # FIX-VSP-1: override esplicito della finestra archi (None = usa default rates,
    # auto-alzato a 600 quando regola#1 ∈ {strict, lexicographic}).
    max_idle_for_arc_min: int | None = None

    # --- MISC ---
    total_time_override_sec: int | None = None
    log_scenario_details: bool = True

    @classmethod
    def from_config(cls, config: dict) -> "VSPConfig":
        """Costruisce VSPConfig da config.vspAdvanced del JSON input."""
        adv = config.get("vspAdvanced", {}) or {}
        cfg = cls()
        # Legacy: solverIntensity rimane valido
        cfg.intensity = adv.get("intensity", config.get("solverIntensity", cfg.intensity))
        if "strategiesEnabled" in adv and adv["strategiesEnabled"]:
            cfg.strategies_enabled = list(adv["strategiesEnabled"])
        cfg.scenarios_override = adv.get("scenariosOverride")
        cfg.enable_no_good_cuts = adv.get("enableNoGoodCuts", cfg.enable_no_good_cuts)
        cfg.min_arc_diff_pct = float(adv.get("minArcDiffPct", cfg.min_arc_diff_pct))
        cfg.min_arc_diff_abs = int(adv.get("minArcDiffAbs", cfg.min_arc_diff_abs))
        cfg.warmstart_split = float(adv.get("warmstartSplit", cfg.warmstart_split))
        cfg.greedy_perturbations = int(adv.get("greedyPerturbations", cfg.greedy_perturbations))
        cfg.enable_polish = adv.get("enablePolish", cfg.enable_polish)
        cfg.polish_time_pct = float(adv.get("polishTimePct", cfg.polish_time_pct))
        cfg.polish_strategy = adv.get("polishStrategy", cfg.polish_strategy)
        cfg.ls_use_detailed_cost = adv.get("lsUseDetailedCost", cfg.ls_use_detailed_cost)
        cfg.ls_time_override_sec = adv.get("lsTimeOverrideSec")
        cfg.ls_iter_override = adv.get("lsIterOverride")
        cfg.ls_no_improve_limit = int(adv.get("lsNoImproveLimit", cfg.ls_no_improve_limit))
        cfg.strategy_amplifier = float(adv.get("strategyAmplifier", cfg.strategy_amplifier))
        cfg.total_time_override_sec = adv.get("totalTimeOverrideSec")
        cfg.log_scenario_details = adv.get("logScenarioDetails", cfg.log_scenario_details)
        # REGOLA #1: priorità min veicoli (off/soft/strict/lexicographic)
        prio = str(adv.get("minVehiclesPriority", cfg.min_vehicles_priority)).lower()
        if prio not in ("off", "soft", "strict", "lexicographic"):
            prio = "soft"
        cfg.min_vehicles_priority = prio
        # Override diretto dei costi dalla UI (es. {"fixedDaily": {"12m": 50}, "idlePerMin": 0.12})
        if isinstance(adv.get("costRatesOverride"), dict):
            cfg.cost_rates_override = adv["costRatesOverride"]
        cfg.prefer_monolinea = bool(adv.get("preferMonolinea", cfg.prefer_monolinea))
        cfg.enable_vehicle_elimination = bool(adv.get("enableVehicleElimination",
                                                       cfg.enable_vehicle_elimination))
        cfg.vehicle_elimination_max_passes = int(adv.get("vehicleEliminationMaxPasses",
                                                          cfg.vehicle_elimination_max_passes))
        if "vehicleEliminationTimeSec" in adv and adv["vehicleEliminationTimeSec"] is not None:
            cfg.vehicle_elimination_time_sec = float(adv["vehicleEliminationTimeSec"])
        cfg.enable_iterative_reduction = bool(adv.get("enableIterativeReduction",
                                                       cfg.enable_iterative_reduction))
        if "iterativeReductionTimeSec" in adv and adv["iterativeReductionTimeSec"] is not None:
            cfg.iterative_reduction_time_sec = float(adv["iterativeReductionTimeSec"])
        # FIX-VSP-1: override finestra archi
        if "maxIdleForArcMin" in adv and adv["maxIdleForArcMin"] is not None:
            cfg.max_idle_for_arc_min = int(adv["maxIdleForArcMin"])
        # Validazione
        cfg.min_arc_diff_pct = max(0.0, min(0.5, cfg.min_arc_diff_pct))
        cfg.warmstart_split = max(0.0, min(1.0, cfg.warmstart_split))
        cfg.polish_time_pct = max(0.0, min(0.5, cfg.polish_time_pct))
        if not cfg.strategies_enabled:
            cfg.strategies_enabled = ["balanced"]
        return cfg

    def summary(self) -> str:
        return (f"VSPConfig(intensity={self.intensity}, "
                f"strategies={len(self.strategies_enabled)}, "
                f"nogood={self.enable_no_good_cuts} pct={self.min_arc_diff_pct}, "
                f"ws_split={self.warmstart_split}, polish={self.enable_polish})")


# ─── PORTFOLIO MULTI-STRATEGIA per VSP ──────────────────────────────────
# FIX-2: moltiplicatori lasciati invariati MA i bonus monolinea/pairing
# ora sono applicati con scala proporzionale ai costi dominanti.
VSP_STRATEGIES = {
    "balanced":     {"label": "Bilanciato",          "desc": "Equilibrio costo/qualità",
                     "mul_fixed": 1.0, "mul_deadhead": 1.0, "mul_idle": 1.0,
                     "mul_depot": 1.0, "mul_monolinea": 1.0, "mul_pairing": 1.0},
    "min_vehicles": {"label": "Meno veicoli",        "desc": "Massimizza concatenazione (1 mezzo serve più corse)",
                     "mul_fixed": 2.5, "mul_deadhead": 0.8, "mul_idle": 1.5,
                     "mul_depot": 0.8, "mul_monolinea": 0.5, "mul_pairing": 1.5},
    "saturation":   {"label": "Massima saturazione", "desc": "Pochi mezzi e turni pieni: minimo idle e pairing serrato",
                     "mul_fixed": 3.0, "mul_deadhead": 1.2, "mul_idle": 2.5,
                     "mul_depot": 1.5, "mul_monolinea": 1.2, "mul_pairing": 2.5},
    "min_deadhead": {"label": "Minimo vuoto",        "desc": "Riduce trasferimenti senza passeggeri",
                     "mul_fixed": 0.9, "mul_deadhead": 3.0, "mul_idle": 0.8,
                     "mul_depot": 1.5, "mul_monolinea": 1.0, "mul_pairing": 1.0},
    "monolinea":    {"label": "Preferenza monolinea","desc": "Stessa linea su un veicolo (Maior-style)",
                     "mul_fixed": 1.1, "mul_deadhead": 1.2, "mul_idle": 1.0,
                     "mul_depot": 1.0, "mul_monolinea": 4.0, "mul_pairing": 0.9},
    "min_idle":     {"label": "Anti-attese",         "desc": "Minimizza minuti morti tra corse",
                     "mul_fixed": 1.0, "mul_deadhead": 1.0, "mul_idle": 3.0,
                     "mul_depot": 1.2, "mul_monolinea": 0.8, "mul_pairing": 1.2},
    "compact":      {"label": "Turni compatti",      "desc": "Pairing serrato, veicoli pronti subito",
                     "mul_fixed": 1.3, "mul_deadhead": 1.0, "mul_idle": 2.0,
                     "mul_depot": 1.0, "mul_monolinea": 1.0, "mul_pairing": 2.5},
    "depot_minimal":{"label": "Pochi rientri",       "desc": "Evita rientri in deposito intermedi",
                     "mul_fixed": 1.0, "mul_deadhead": 1.0, "mul_idle": 1.2,
                     "mul_depot": 4.0, "mul_monolinea": 1.0, "mul_pairing": 1.0},
    "aggressive":   {"label": "Aggressivo",          "desc": "Costo bassissimo, accetta qualità minore",
                     "mul_fixed": 2.0, "mul_deadhead": 1.5, "mul_idle": 0.5,
                     "mul_depot": 0.7, "mul_monolinea": 0.5, "mul_pairing": 1.8},
}

# FIX-5: mappatura polish -> strategia complementare al best trovato
POLISH_COMPLEMENT = {
    "min_vehicles":  "saturation",    # ha concatenato tanto -> saturare i turni
    "saturation":    "min_deadhead",  # turni pieni -> ottimizza km vuoto
    "min_deadhead":  "saturation",    # ha evitato vuoti -> ora saturare
    "monolinea":     "min_deadhead",  # stesse linee -> riduciamo km vuoto residuo
    "min_idle":      "compact",       # no attese -> compattiamo
    "compact":       "min_vehicles",  # compatti -> meno mezzi se possibile
    "depot_minimal": "monolinea",     # evita depot -> preferisci stessa linea
    "aggressive":    "balanced",      # aggressivo -> riequilibra
    "balanced":      "min_deadhead",  # bilanciato -> ottimizza punto debole tipico
}

# Container globale per analisi multi-scenario
LAST_VSP_SCENARIOS: list[dict] = []
LAST_VSP_ANALYSIS: dict = {}


def _estimate_trip_km(trip: Trip, rates: VehicleCostRates) -> float:
    """Estimate service km from trip duration and category speed."""
    speed = rates.avg_service_speed.get(trip.category, 20.0)
    return trip.duration_min * speed / 60.0


# ─── ARC PRE-COMPUTATION ────────────────────────────────────────────────

def trips_vehicle_compatible(ti: Trip, tj: Trip) -> bool:
    """Check if any vehicle type can serve BOTH trips."""
    si = VEHICLE_SIZE.get(ti.required_vehicle, 3)
    sj = VEHICLE_SIZE.get(tj.required_vehicle, 3)
    for vt in VEHICLE_TYPES:
        vs = VEHICLE_SIZE[vt]
        ok_i = (ti.forced and vt == ti.required_vehicle) or (not ti.forced and can_vehicle_serve(vs, si))
        ok_j = (tj.forced and vt == tj.required_vehicle) or (not tj.forced and can_vehicle_serve(vs, sj))
        if ok_i and ok_j:
            return True
    return False


def build_terminal_clusters(trips: list[Trip], radius_m: int) -> dict[str, int]:
    """FIX-VSP-CLUSTER: union-find geografico sui capolinea.

    Raggruppa stop_id (first/last di ogni corsa) entro `radius_m` metri.
    Restituisce mappa stop_id → cluster_id (int). Stop in cluster diverso
    vengono trattati come fermate distinte (deadhead reale). Stop nello stesso
    cluster sono considerati "stesso punto fisico" (deadhead km=0, tempo=0).

    Riproduce la logica MAIOR dei punti di interscambio: capolinea
    fisicamente coincidenti ma con stop_id GTFS multipli (es. "Stazione FS
    lato A/B/C") che dovrebbero permettere il passaggio diretto della
    vettura tra una corsa e la successiva senza tempo di trasferimento.

    Complessità O(k²) con k = numero di terminali distinti (tipicamente 30-80).
    """
    if radius_m <= 0:
        return {}
    # Estrai terminali unici (stop_id → (lat, lon))
    terminals: dict[str, tuple[float, float]] = {}
    for t in trips:
        terminals.setdefault(t.first_stop_id, (t.first_stop_lat, t.first_stop_lon))
        terminals.setdefault(t.last_stop_id, (t.last_stop_lat, t.last_stop_lon))
    keys = list(terminals.keys())
    n = len(keys)
    if n == 0:
        return {}

    # Union-Find
    parent = list(range(n))

    def find(x: int) -> int:
        while parent[x] != x:
            parent[x] = parent[parent[x]]
            x = parent[x]
        return x

    def union(a: int, b: int) -> None:
        ra, rb = find(a), find(b)
        if ra != rb:
            parent[ra] = rb

    radius_km = radius_m / 1000.0
    for i in range(n):
        lat_i, lon_i = terminals[keys[i]]
        for j in range(i + 1, n):
            lat_j, lon_j = terminals[keys[j]]
            if haversine_km(lat_i, lon_i, lat_j, lon_j) <= radius_km:
                union(i, j)

    cluster_of: dict[str, int] = {}
    for i, k in enumerate(keys):
        cluster_of[k] = find(i)

    # Log diagnostico
    n_clusters = len(set(cluster_of.values()))
    n_grouped = sum(1 for k in keys if sum(1 for kk in keys
                                            if cluster_of[kk] == cluster_of[k]) > 1)
    log(f"  [VSP-CLUSTER] terminals={n}, cluster_radius={radius_m}m, "
        f"distinct_clusters={n_clusters}, stops_grouped={n_grouped}")
    return cluster_of


def build_compatible_arcs_fast(trips: list[Trip], rates: VehicleCostRates) -> list[Arc]:
    """O(n x k) arc building with bisect temporal windowing.

    FIX-VSP-1: la finestra per generare archi è separata dalla soglia depot_return.
    Permettiamo archi fino a max_idle_for_arc_min (default 10h), e marchiamo come
    depot_return solo quelli con gap > max_idle_at_terminal. Questo evita di
    escludere a priori riassorbimenti che il solver potrebbe accettare quando
    l'utente forza la minimizzazione veicoli (regola #1).

    FIX-VSP-CLUSTER: due capolinea entro `terminal_cluster_radius_m` vengono
    trattati come stesso punto (deadhead km=0, tempo=0, nessun buffer di 5min).
    """
    n = len(trips)
    sorted_by_dep = sorted(range(n), key=lambda idx: trips[idx].departure_min)
    dep_mins = [trips[sorted_by_dep[k]].departure_min for k in range(n)]
    max_window = max(rates.max_idle_for_arc_min, rates.max_idle_at_terminal) + 30

    # FIX-VSP-CLUSTER: pre-computa cluster geografici dei terminali
    cluster_of = build_terminal_clusters(trips, rates.terminal_cluster_radius_m)

    arcs: list[Arc] = []
    same_cluster_count = 0
    tight_arc_count = 0   # FIX-TIGHT: archi salvati grazie al layover=0 sullo stesso capolinea
    for i in range(n):
        ti = trips[i]
        # FIX-TIGHT: usiamo gap≥0 (NON arrival+MIN_LAYOVER) per non pre-escludere
        # archi tight. Il filtro `MIN_LAYOVER` viene applicato dopo, e SOLO se le
        # due corse non sono sullo stesso capolinea fisico.
        earliest_j = ti.arrival_min
        latest_j = ti.arrival_min + max_window

        lo = bisect.bisect_left(dep_mins, earliest_j)
        hi = bisect.bisect_right(dep_mins, latest_j)

        for k in range(lo, hi):
            j = sorted_by_dep[k]
            if i == j:
                continue
            tj = trips[j]

            # 1) Stesso stop_id GTFS, oppure coordinate identiche entro ~100m
            same_id = (ti.last_stop_id == tj.first_stop_id
                       or (abs(ti.last_stop_lat - tj.first_stop_lat) < 0.001
                           and abs(ti.last_stop_lon - tj.first_stop_lon) < 0.001))
            # 2) FIX-VSP-CLUSTER: stesso cluster geografico (stop_id diversi
            #    ma fisicamente coincidenti — es. "Stazione FS A" e "Stazione FS B")
            same_cluster = (cluster_of and ti.last_stop_id in cluster_of
                            and tj.first_stop_id in cluster_of
                            and cluster_of[ti.last_stop_id] == cluster_of[tj.first_stop_id])

            if same_id or same_cluster:
                dh_km, dh_min = 0.0, 0
                if same_cluster and not same_id:
                    same_cluster_count += 1
            else:
                dh_km, dh_min = estimate_deadhead(
                    ti.last_stop_lat, ti.last_stop_lon,
                    tj.first_stop_lat, tj.first_stop_lon, ti.category)

            if dh_km > MAX_DEADHEAD_KM:
                continue
            # FIX-TIGHT: il bus che arriva alle 12:58 e riparte alle 13:00 dallo
            # stesso capolinea NON deve essere bloccato dal MIN_LAYOVER=3min.
            # Il layover serve solo come buffer per spostarsi tra fermate diverse.
            min_layover_eff = 0 if (same_id or same_cluster) else MIN_LAYOVER
            if ti.arrival_min + max(dh_min, min_layover_eff) > tj.departure_min:
                continue
            if not trips_vehicle_compatible(ti, tj):
                continue

            gap = tj.departure_min - ti.arrival_min
            # FIX-VSP-1: depot_return è ora SOLO un flag informativo; il filtro
            # gap > max_idle_at_terminal NON scarta più l'arco.
            depot_return = gap > rates.max_idle_at_terminal
            arcs.append(Arc(i=i, j=j, dh_km=round(dh_km, 1), dh_min=dh_min,
                            gap_min=gap, depot_return=depot_return))
            # FIX-TIGHT: log diagnostico per archi tight (gap<MIN_LAYOVER) sullo
            # stesso capolinea — sono ESATTAMENTE quelli che prima venivano persi.
            if (same_id or same_cluster) and gap < MIN_LAYOVER:
                tight_arc_count += 1
    if same_cluster_count > 0:
        log(f"  [VSP-CLUSTER] archi extra grazie a cluster geografico: "
            f"{same_cluster_count} (su {len(arcs)} totali)")
    if tight_arc_count > 0:
        log(f"  [VSP-TIGHT] {tight_arc_count} archi tight (gap<{MIN_LAYOVER}min) "
            f"salvati grazie a layover=0 sullo stesso capolinea")
    return arcs


# ─── ARC COST PRE-COMPUTATION ───────────────────────────────────────────

def precompute_arc_costs(
    arcs: list[Arc],
    trips: list[Trip],
    rates: VehicleCostRates,
    strategy: dict | None = None,
    amplifier: float = 1.0,
) -> dict[tuple[int, int], int]:
    """Calcola il costo di ogni arco scalato per la strategia corrente.

    FIX-2: bonus monolinea e penalità pairing sono ora SCALATI ai costi
    dominanti della funzione obiettivo (fixed_daily ~ 42 EUR). Prima erano
    infinitesimi sotto la soglia di rounding.
    """
    s = strategy or {}
    mul_dh = 1.0 + (s.get("mul_deadhead", 1.0) - 1.0) * amplifier
    mul_idle = 1.0 + (s.get("mul_idle", 1.0) - 1.0) * amplifier
    mul_depot = 1.0 + (s.get("mul_depot", 1.0) - 1.0) * amplifier
    mul_mono = 1.0 + (s.get("mul_monolinea", 1.0) - 1.0) * amplifier
    mul_pair = 1.0 + (s.get("mul_pairing", 1.0) - 1.0) * amplifier

    costs: dict[tuple[int, int], int] = {}
    for a in arcs:
        ti = trips[a.i]
        tj = trips[a.j]
        vtype = ti.required_vehicle
        fixed_ref = rates.fixed_daily.get(vtype, 42.0)

        cost_euro = 0.0

        # Deadhead
        if a.dh_km > rates.min_deadhead_km:
            cost_euro += a.dh_km * rates.per_deadhead_km.get(vtype, 0.80) * mul_dh

        # Idle
        idle_min = max(0, a.gap_min - max(a.dh_min, MIN_LAYOVER))
        cost_euro += idle_min * rates.idle_per_min * mul_idle
        if idle_min > rates.long_idle_threshold:
            cost_euro += (idle_min - rates.long_idle_threshold) * rates.long_idle_per_min * mul_idle

        # Depot return
        if a.depot_return:
            cost_euro += rates.per_depot_return * mul_depot

        # FIX-2: Bonus monolinea ORA scalato sui costi reali
        # Scala: 15% del costo fisso giornaliero per ogni punto sopra 1.0
        # Con mul_mono=4.0: sconto di (4-1)*0.15*42 = ~19 EUR per arco same-route
        # Prima era 0.5*(mul-1)=1.5 EUR, sotto la soglia di rumore
        if mul_mono > 1.0 and ti.route_id == tj.route_id:
            cost_euro -= fixed_ref * 0.15 * (mul_mono - 1.0)

        # FIX-2: Penalità pairing ORA rilevante
        # Con mul_pair=2.5 e gap=30min: 30*0.05*1.5 = 2.25 EUR (era 0.225)
        if mul_pair > 1.0:
            cost_euro += a.gap_min * 0.05 * (mul_pair - 1.0)

        costs[(a.i, a.j)] = max(0, int(round(cost_euro * COST_SCALE)))
    return costs


def precompute_fixed_costs(
    trips: list[Trip],
    rates: VehicleCostRates,
    strategy: dict | None = None,
    amplifier: float = 1.0,
) -> list[int]:
    base_mul = (strategy or {}).get("mul_fixed", 1.0)
    mul = 1.0 + (base_mul - 1.0) * amplifier
    return [int(round(rates.fixed_daily.get(t.required_vehicle, 42.0) * mul * COST_SCALE)) for t in trips]


# ─── WARM-START: greedy + perturbazioni diversificanti ──────────────────

def greedy_warmstart(
    trips: list[Trip], arcs: list[Arc], arcs_lookup: dict[tuple[int, int], Arc],
    rates: VehicleCostRates, rng: random.Random | None = None,
    pref: str = "cost",
    new_vehicle_penalty_eur: float = 0.0,
) -> list[list[int]]:
    """Greedy warmstart. `pref` controlla l'euristica di assegnazione:
       - 'cost'      : minimizza costo incrementale (default)
       - 'route'     : preferisce same-route anche a costo maggiore
       - 'nearest'   : preferisce arco con minor gap
       - 'saturate'  : preferisce IL VEICOLO PIU' PIENO (max trip già assegnati)
                       → satura un veicolo prima di passare al successivo
       - 'random'    : tra le opzioni feasible ne sceglie una casuale

    FIX-VSP-6: `new_vehicle_penalty_eur` (default 0 = nessun effetto)
    introduce un costo virtuale per la creazione di un nuovo veicolo:
    quando >0, il greedy preferisce il riuso anche con archi peggiori,
    rifiutando il nuovo veicolo se penalty supera il delta. In modalità
    strict/lexicographic si imposta a ~3× fixed_daily medio per saturare
    al massimo i veicoli esistenti.
    """
    n = len(trips)
    sorted_indices = sorted(range(n), key=lambda i: trips[i].departure_min)
    adj: dict[int, list[Arc]] = defaultdict(list)
    for a in arcs:
        adj[a.i].append(a)

    vehicles: list[list[int]] = []
    vehicle_last: list[int] = []
    vehicle_types: list[str] = []
    assigned = [False] * n

    for idx in sorted_indices:
        if assigned[idx]:
            continue
        trip = trips[idx]
        req_size = VEHICLE_SIZE.get(trip.required_vehicle, 3)
        candidates = []

        for vi in range(len(vehicles)):
            vtype = vehicle_types[vi]
            vsize = VEHICLE_SIZE[vtype]
            if trip.forced:
                if vtype != trip.required_vehicle:
                    continue
            else:
                if not can_vehicle_serve(vsize, req_size):
                    continue
            last_idx = vehicle_last[vi]
            arc_found = None
            for a in adj[last_idx]:
                if a.j == idx:
                    arc_found = a
                    break
            if arc_found is None:
                continue
            gap = trip.departure_min - trips[last_idx].arrival_min
            dh_cost = arc_found.dh_km * rates.per_deadhead_km.get(vtype, 0.80)
            idle_min = max(0, gap - max(arc_found.dh_min, MIN_LAYOVER))
            idle_cost = idle_min * rates.idle_per_min
            depot_cost = rates.per_depot_return if arc_found.depot_return else 0
            base_score = dh_cost + idle_cost + depot_cost
            same_route = trips[last_idx].route_id == trip.route_id

            if pref == "route":
                score = base_score - (10.0 if same_route else 0.0)
            elif pref == "nearest":
                score = gap
            elif pref == "saturate":
                # Più trip ha già il veicolo, più è preferibile (score basso = meglio)
                # Aggiungiamo penalità minima per coerenza di costo
                score = -len(vehicles[vi]) * 100.0 + base_score * 0.01
            elif pref == "random":
                score = 0  # scelta random dopo
            else:
                score = base_score
            candidates.append((score, vi))

        if candidates:
            if pref == "random" and rng is not None:
                _, best_v = rng.choice(candidates)
                vehicles[best_v].append(idx)
                vehicle_last[best_v] = idx
                assigned[idx] = True
            else:
                candidates.sort(key=lambda x: x[0])
                best_score, best_v = candidates[0]
                # FIX-VSP-6: in saturation mode (penalty>0), accetta SEMPRE il riuso
                # anche quando il costo incrementale è alto, finché < soglia.
                # Il default 0.0 preserva il comportamento storico (sempre riuso).
                if new_vehicle_penalty_eur > 0:
                    # Score effettivo "nuovo veicolo" = fixed_daily + penalty
                    # Se best_score (in unità score, ~EUR) supera questa soglia
                    # virtuale, conviene creare un nuovo veicolo.
                    new_veh_threshold = (
                        rates.fixed_daily.get(trip.required_vehicle, 42.0)
                        + new_vehicle_penalty_eur
                    )
                    if best_score > new_veh_threshold:
                        vehicles.append([idx])
                        vehicle_last.append(idx)
                        vehicle_types.append(trip.required_vehicle)
                        assigned[idx] = True
                        continue
                vehicles[best_v].append(idx)
                vehicle_last[best_v] = idx
                assigned[idx] = True
        else:
            vehicles.append([idx])
            vehicle_last.append(idx)
            vehicle_types.append(trip.required_vehicle)
            assigned[idx] = True
    return vehicles


def generate_diverse_warmstarts(
    trips: list[Trip], arcs: list[Arc], arcs_lookup: dict[tuple[int, int], Arc],
    rates: VehicleCostRates, n_variants: int,
    new_vehicle_penalty_eur: float = 0.0,
) -> list[list[list[int]]]:
    """FIX-1: genera N warm-start strutturalmente diversi per iniettare
    diversità nei primi scenari del portfolio.

    FIX-VSP-6: propaga `new_vehicle_penalty_eur` ai greedy sottostanti.
    """
    variants = []
    prefs = ["saturate", "cost", "route", "nearest", "saturate", "random"]
    for i in range(n_variants):
        pref = prefs[i % len(prefs)]
        rng = random.Random(1000 + i * 17)
        try:
            chains = greedy_warmstart(
                trips, arcs, arcs_lookup, rates, rng=rng, pref=pref,
                new_vehicle_penalty_eur=new_vehicle_penalty_eur,
            )
            if chains:
                variants.append(chains)
        except Exception as e:
            log(f"  [WS-variant-{i}/{pref}] failed: {e}")
    return variants


# ─── CP-SAT MODEL ───────────────────────────────────────────────────────

def solve_vsp_cost_based(
    trips: list[Trip], arcs: list[Arc],
    arc_costs: dict[tuple[int, int], int], fixed_costs: list[int],
    rates: VehicleCostRates, category: str,
    time_limit: int = 60,
    warmstart_chains: list[list[int]] | None = None,
    intensity: str = "normal", seed: int = 42, label: str = "balanced",
    # FIX-3: no-good cuts tra scenari
    forbidden_arc_sets: list[set[tuple[int, int]]] | None = None,
    min_arc_diff_pct: float = 0.12,
    min_arc_diff_abs: int = 5,
    # REGOLA #1: bonus extra (in COST_SCALE units) aggiunto a ogni first[i]
    # per spingere il solver a minimizzare il numero di turni macchina.
    vehicle_priority_bonus: int = 0,
) -> tuple[str, list[list[int]], dict]:
    n = len(trips)
    if n == 0:
        return "OPTIMAL", [], _empty_metrics()

    t0 = time.time()
    model = cp_model.CpModel()

    seq: dict[tuple[int, int], Any] = {}
    for a in arcs:
        seq[(a.i, a.j)] = model.new_bool_var(f"s_{a.i}_{a.j}")

    first = [model.new_bool_var(f"f_{i}") for i in range(n)]
    last = [model.new_bool_var(f"l_{i}") for i in range(n)]

    in_arcs: dict[int, list[tuple[int, int]]] = defaultdict(list)
    out_arcs: dict[int, list[tuple[int, int]]] = defaultdict(list)
    for a in arcs:
        in_arcs[a.j].append((a.i, a.j))
        out_arcs[a.i].append((a.i, a.j))

    for j in range(n):
        predecessors = [seq[k] for k in in_arcs[j]]
        model.add(sum(predecessors) + first[j] == 1)

    for i in range(n):
        successors = [seq[k] for k in out_arcs[i]]
        model.add(sum(successors) + last[i] == 1)

    num_vehicles = model.new_int_var(0, n, "nv")
    model.add(num_vehicles == sum(first))

    # FIX-3: NO-GOOD CUTS - forza diversità strutturale rispetto a soluzioni già viste
    nogood_count = 0
    if forbidden_arc_sets:
        for forbidden in forbidden_arc_sets:
            vars_in_forbidden = [seq[k] for k in forbidden if k in seq]
            if not vars_in_forbidden:
                continue
            min_diff = max(min_arc_diff_abs, int(len(vars_in_forbidden) * min_arc_diff_pct))
            # Almeno min_diff archi del forbidden set NON devono essere selezionati
            # -> sum <= len - min_diff
            model.add(sum(vars_in_forbidden) <= len(vars_in_forbidden) - min_diff)
            nogood_count += 1

    # Objective: real costs in COST_SCALE units
    obj_terms: list = []
    for i in range(n):
        # REGOLA #1: il bonus si SOMMA al costo fisso. Se vehicle_priority_bonus
        # è enorme (modalità lexicographic), il solver minimizzerà il numero
        # di first[i]=1 PRIMA di considerare i costi variabili.
        obj_terms.append(first[i] * (fixed_costs[i] + vehicle_priority_bonus))
    for a in arcs:
        cost_unit = arc_costs.get((a.i, a.j), 0)
        if cost_unit > 0:
            obj_terms.append(seq[(a.i, a.j)] * cost_unit)

    model.minimize(sum(obj_terms))

    # Warm start
    if warmstart_chains:
        first_set: set[int] = set()
        last_set: set[int] = set()
        seq_set: set[tuple[int, int]] = set()
        for chain in warmstart_chains:
            if not chain:
                continue
            first_set.add(chain[0])
            last_set.add(chain[-1])
            for k in range(len(chain) - 1):
                seq_set.add((chain[k], chain[k + 1]))
        for i in range(n):
            model.add_hint(first[i], 1 if i in first_set else 0)
            model.add_hint(last[i], 1 if i in last_set else 0)
        for key, var in seq.items():
            model.add_hint(var, 1 if key in seq_set else 0)

    solver = cp_model.CpSolver()
    solver.parameters.max_time_in_seconds = time_limit
    solver.parameters.log_search_progress = False
    solver.parameters.random_seed = seed
    solver.parameters.randomize_search = True
    if intensity == "fast":
        solver.parameters.num_workers = 4
    elif intensity == "deep":
        solver.parameters.num_workers = 12
        solver.parameters.linearization_level = 2
        solver.parameters.symmetry_level = 2
    elif intensity == "extreme":
        solver.parameters.num_workers = 16
        solver.parameters.linearization_level = 2
        solver.parameters.symmetry_level = 2
        solver.parameters.cp_model_probing_level = 3
    else:
        solver.parameters.num_workers = 8

    log(f"  [VSP-{category}/{label}] Model: {n} trips, {len(arcs)} arcs, "
        f"tl={time_limit}s, seed={seed}, int={intensity}, nogood_cuts={nogood_count}, "
        f"veh_prio_bonus={vehicle_priority_bonus}")
    status_code = solver.solve(model)
    elapsed = time.time() - t0
    status_str = solver.status_name(status_code)

    if status_code not in (cp_model.OPTIMAL, cp_model.FEASIBLE):
        log(f"  [VSP-{category}/{label}] Status={status_str}, no solution in {elapsed:.1f}s")
        return status_str, [], _empty_metrics(elapsed)

    chains = _extract_chains(n, arcs, seq, first, solver)
    num_veh = solver.value(num_vehicles)
    obj_euro = solver.objective_value / COST_SCALE

    total_dh_km = 0.0
    depot_ret = 0
    for a in arcs:
        if solver.value(seq[(a.i, a.j)]):
            total_dh_km += a.dh_km
            if a.depot_return:
                depot_ret += 1

    log(f"  [VSP-{category}/{label}] {status_str}, veh={num_veh}, dh={total_dh_km:.1f}km, "
        f"depot={depot_ret}, cost=EUR{obj_euro:.2f}, t={elapsed:.1f}s")

    return status_str, chains, {
        "vehicles": num_veh, "deadheadKm": round(total_dh_km, 1),
        "depotReturns": depot_ret, "solveTimeSec": round(elapsed, 1),
        "status": status_str, "objectiveValue": round(obj_euro, 2),
    }


def _extract_chains(n, arcs, seq, first, solver):
    start_nodes = [i for i in range(n) if solver.value(first[i])]
    successor = {}
    for a in arcs:
        if solver.value(seq[(a.i, a.j)]):
            successor[a.i] = a.j
    chains = []
    for s in start_nodes:
        chain = [s]
        current = s
        visited = {s}
        while current in successor:
            nxt = successor[current]
            if nxt in visited:
                break
            chain.append(nxt)
            visited.add(nxt)
            current = nxt
        chains.append(chain)
    return chains


def _empty_metrics(elapsed=0.0):
    return {"vehicles": 0, "deadheadKm": 0, "depotReturns": 0,
            "solveTimeSec": round(elapsed, 1), "status": "NO_SOLUTION", "objectiveValue": 0}


def chains_to_arc_set(chains: list[list[int]]) -> set[tuple[int, int]]:
    """Estrae il set di archi (i,j) usati da una soluzione."""
    s: set[tuple[int, int]] = set()
    for chain in chains:
        for k in range(len(chain) - 1):
            s.add((chain[k], chain[k + 1]))
    return s


def _set_workers_by_intensity(solver: cp_model.CpSolver, intensity: str) -> None:
    """FIX-VSP-2: helper condiviso per il setup workers/parametri CP-SAT."""
    solver.parameters.log_search_progress = False
    solver.parameters.randomize_search = True
    if intensity == "fast":
        solver.parameters.num_workers = 4
    elif intensity == "deep":
        solver.parameters.num_workers = 12
        solver.parameters.linearization_level = 2
        solver.parameters.symmetry_level = 2
    elif intensity == "extreme":
        solver.parameters.num_workers = 16
        solver.parameters.linearization_level = 2
        solver.parameters.symmetry_level = 2
        solver.parameters.cp_model_probing_level = 3
    else:
        solver.parameters.num_workers = 8


def solve_vsp_lexicographic(
    trips: list[Trip], arcs: list[Arc],
    arc_costs: dict[tuple[int, int], int], fixed_costs: list[int],
    rates: VehicleCostRates, category: str,
    time_limit: int,
    warmstart_chains: list[list[int]] | None = None,
    intensity: str = "normal", seed: int = 42, label: str = "lexico",
    forbidden_arc_sets: list[set[tuple[int, int]]] | None = None,
    min_arc_diff_pct: float = 0.12,
    min_arc_diff_abs: int = 5,
) -> tuple[str, list[list[int]], dict]:
    """FIX-VSP-2: solve lessicografico vero a 2 fasi.

      Fase 1: minimizza solo num_vehicles (objective = Σ first[i]).
      Fase 2: vincola num_vehicles == ottimo fase 1, poi minimizza costi variabili.

    Garantito che la fase 2 NON aumenti mai i veicoli rispetto alla fase 1.
    Sostituisce il bonus "enorme ma finito" della modalità lexicographic legacy,
    che era fragile rispetto a max_arc_cost · |archi|.
    """
    n = len(trips)
    if n == 0:
        return "OPTIMAL", [], _empty_metrics()

    in_arcs: dict[int, list[tuple[int, int]]] = defaultdict(list)
    out_arcs: dict[int, list[tuple[int, int]]] = defaultdict(list)
    for a in arcs:
        in_arcs[a.j].append((a.i, a.j))
        out_arcs[a.i].append((a.i, a.j))

    # ── FASE 1: min num_vehicles puro ──────────────────────────────────
    t_phase1 = time.time()
    phase1_budget = max(15, int(time_limit * 0.4))

    model1 = cp_model.CpModel()
    seq1: dict[tuple[int, int], Any] = {}
    for a in arcs:
        seq1[(a.i, a.j)] = model1.new_bool_var(f"s1_{a.i}_{a.j}")
    first1 = [model1.new_bool_var(f"f1_{i}") for i in range(n)]
    last1 = [model1.new_bool_var(f"l1_{i}") for i in range(n)]

    for j in range(n):
        model1.add(sum(seq1[k] for k in in_arcs[j]) + first1[j] == 1)
    for i in range(n):
        model1.add(sum(seq1[k] for k in out_arcs[i]) + last1[i] == 1)

    nv1 = model1.new_int_var(0, n, "nv1")
    model1.add(nv1 == sum(first1))

    if forbidden_arc_sets:
        for forbidden in forbidden_arc_sets:
            vars_in_forbidden = [seq1[k] for k in forbidden if k in seq1]
            if not vars_in_forbidden:
                continue
            min_diff = max(min_arc_diff_abs, int(len(vars_in_forbidden) * min_arc_diff_pct))
            model1.add(sum(vars_in_forbidden) <= len(vars_in_forbidden) - min_diff)

    if warmstart_chains:
        first_set = {c[0] for c in warmstart_chains if c}
        last_set = {c[-1] for c in warmstart_chains if c}
        seq_set = {(c[k], c[k + 1]) for c in warmstart_chains for k in range(len(c) - 1)}
        for i in range(n):
            model1.add_hint(first1[i], 1 if i in first_set else 0)
            model1.add_hint(last1[i], 1 if i in last_set else 0)
        for key, var in seq1.items():
            model1.add_hint(var, 1 if key in seq_set else 0)

    model1.minimize(nv1)

    solver1 = cp_model.CpSolver()
    solver1.parameters.max_time_in_seconds = phase1_budget
    solver1.parameters.random_seed = seed
    _set_workers_by_intensity(solver1, intensity)

    log(f"  [VSP-LEXI/{label}] Phase 1: minimize #vehicles, "
        f"tl={phase1_budget}s, n={n}, |arcs|={len(arcs)}")
    sc1 = solver1.solve(model1)
    elapsed1 = time.time() - t_phase1
    status1 = solver1.status_name(sc1)

    if sc1 not in (cp_model.OPTIMAL, cp_model.FEASIBLE):
        log(f"  [VSP-LEXI/{label}] Phase 1 FAILED: {status1} in {elapsed1:.1f}s")
        return status1, [], _empty_metrics(elapsed1)

    best_nv = solver1.value(nv1)
    phase1_chains = _extract_chains(n, arcs, seq1, first1, solver1)
    log(f"  [VSP-LEXI/{label}] Phase 1 {status1}: {best_nv} veicoli in {elapsed1:.1f}s")

    # ── FASE 2: min costo variabile, num_vehicles bloccato ─────────────
    phase2_budget = max(15, time_limit - int(elapsed1))

    model2 = cp_model.CpModel()
    seq2: dict[tuple[int, int], Any] = {}
    for a in arcs:
        seq2[(a.i, a.j)] = model2.new_bool_var(f"s2_{a.i}_{a.j}")
    first2 = [model2.new_bool_var(f"f2_{i}") for i in range(n)]
    last2 = [model2.new_bool_var(f"l2_{i}") for i in range(n)]

    for j in range(n):
        model2.add(sum(seq2[k] for k in in_arcs[j]) + first2[j] == 1)
    for i in range(n):
        model2.add(sum(seq2[k] for k in out_arcs[i]) + last2[i] == 1)

    nv2 = model2.new_int_var(0, n, "nv2")
    model2.add(nv2 == sum(first2))
    # ★ vincolo lessicografico ★
    model2.add(nv2 == best_nv)

    if forbidden_arc_sets:
        for forbidden in forbidden_arc_sets:
            vars_in_forbidden = [seq2[k] for k in forbidden if k in seq2]
            if not vars_in_forbidden:
                continue
            min_diff = max(min_arc_diff_abs, int(len(vars_in_forbidden) * min_arc_diff_pct))
            model2.add(sum(vars_in_forbidden) <= len(vars_in_forbidden) - min_diff)

    p1_first = {c[0] for c in phase1_chains if c}
    p1_last = {c[-1] for c in phase1_chains if c}
    p1_seq = {(c[k], c[k + 1]) for c in phase1_chains for k in range(len(c) - 1)}
    for i in range(n):
        model2.add_hint(first2[i], 1 if i in p1_first else 0)
        model2.add_hint(last2[i], 1 if i in p1_last else 0)
    for key, var in seq2.items():
        model2.add_hint(var, 1 if key in p1_seq else 0)

    obj_terms: list = []
    for i in range(n):
        obj_terms.append(first2[i] * fixed_costs[i])
    for a in arcs:
        cost_unit = arc_costs.get((a.i, a.j), 0)
        if cost_unit > 0:
            obj_terms.append(seq2[(a.i, a.j)] * cost_unit)
    model2.minimize(sum(obj_terms))

    solver2 = cp_model.CpSolver()
    solver2.parameters.max_time_in_seconds = phase2_budget
    solver2.parameters.random_seed = seed + 1
    _set_workers_by_intensity(solver2, intensity)

    log(f"  [VSP-LEXI/{label}] Phase 2: minimize cost, #veh={best_nv} (locked), "
        f"tl={phase2_budget}s")
    sc2 = solver2.solve(model2)
    elapsed2 = time.time() - t_phase1 - elapsed1
    elapsed_tot = time.time() - t_phase1
    status2 = solver2.status_name(sc2)

    if sc2 not in (cp_model.OPTIMAL, cp_model.FEASIBLE):
        log(f"  [VSP-LEXI/{label}] Phase 2 failed ({status2}), uso soluzione fase 1")
        total_dh_km = sum(a.dh_km for a in arcs if solver1.value(seq1[(a.i, a.j)]))
        depot_ret = sum(1 for a in arcs
                        if solver1.value(seq1[(a.i, a.j)]) and a.depot_return)
        return status1, phase1_chains, {
            "vehicles": best_nv,
            "deadheadKm": round(total_dh_km, 1),
            "depotReturns": depot_ret,
            "solveTimeSec": round(elapsed_tot, 1),
            "status": f"PHASE1_ONLY_{status1}",
            "objectiveValue": 0,
            "lexicographic": True,
            "phase1Vehicles": best_nv,
            "phase1TimeSec": round(elapsed1, 1),
            "phase2TimeSec": round(elapsed2, 1),
        }

    chains = _extract_chains(n, arcs, seq2, first2, solver2)
    obj_euro = solver2.objective_value / COST_SCALE
    total_dh_km = sum(a.dh_km for a in arcs if solver2.value(seq2[(a.i, a.j)]))
    depot_ret = sum(1 for a in arcs
                    if solver2.value(seq2[(a.i, a.j)]) and a.depot_return)

    log(f"  [VSP-LEXI/{label}] Phase 2 {status2}: {best_nv} veh (locked), "
        f"cost EUR{obj_euro:.2f}, dh={total_dh_km:.1f}km, "
        f"phase1={elapsed1:.1f}s + phase2={elapsed2:.1f}s")

    return status2, chains, {
        "vehicles": best_nv,
        "deadheadKm": round(total_dh_km, 1),
        "depotReturns": depot_ret,
        "solveTimeSec": round(elapsed_tot, 1),
        "status": f"LEXI_{status2}",
        "objectiveValue": round(obj_euro, 2),
        "lexicographic": True,
        "phase1Vehicles": best_nv,
        "phase1TimeSec": round(elapsed1, 1),
        "phase2TimeSec": round(elapsed2, 1),
    }


# ─── ITERATIVE VEHICLE REDUCTION ────────────────────────────────────────

def solve_vsp_feasibility_with_bound(
    trips: list[Trip], arcs: list[Arc],
    arc_costs: dict[tuple[int, int], int], fixed_costs: list[int],
    max_vehicles: int, time_limit: float,
    warmstart_chains: list[list[int]] | None = None,
    intensity: str = "deep", seed: int = 42, label: str = "feas",
) -> tuple[str, list[list[int]] | None]:
    """Cerca QUALSIASI assegnazione con #veicoli ≤ max_vehicles.

    Modello: minimizza Σ first[i] (numero veicoli) soggetto a `nv ≤ max_vehicles`,
    con costi variabili come tie-breaker (peso piccolo). Se OPTIMAL/FEASIBLE
    con nv ≤ max_vehicles, ritorna le catene. Se INFEASIBLE, ritorna None.
    """
    n = len(trips)
    if n == 0:
        return "OPTIMAL", []

    in_arcs: dict[int, list[tuple[int, int]]] = defaultdict(list)
    out_arcs: dict[int, list[tuple[int, int]]] = defaultdict(list)
    for a in arcs:
        in_arcs[a.j].append((a.i, a.j))
        out_arcs[a.i].append((a.i, a.j))

    model = cp_model.CpModel()
    seq: dict[tuple[int, int], Any] = {}
    for a in arcs:
        seq[(a.i, a.j)] = model.new_bool_var(f"feq_{a.i}_{a.j}")
    first = [model.new_bool_var(f"ff_{i}") for i in range(n)]
    last = [model.new_bool_var(f"fl_{i}") for i in range(n)]

    for j in range(n):
        model.add(sum(seq[k] for k in in_arcs[j]) + first[j] == 1)
    for i in range(n):
        model.add(sum(seq[k] for k in out_arcs[i]) + last[i] == 1)

    nv = model.new_int_var(0, n, "nv_feas")
    model.add(nv == sum(first))
    model.add(nv <= max_vehicles)         # ★ HARD BOUND ★

    # Objective: minimize nv (con peso DOMINANTE) + costo variabile tie-breaker.
    # In questo modo se anche nv-1 è feasible, il solver ce lo dirà gratis.
    BIG = 10_000_000
    obj_terms = [nv * BIG]
    for i in range(n):
        if fixed_costs[i] > 0:
            obj_terms.append(first[i] * fixed_costs[i])
    for a in arcs:
        c = arc_costs.get((a.i, a.j), 0)
        if c > 0:
            obj_terms.append(seq[(a.i, a.j)] * c)
    model.minimize(sum(obj_terms))

    if warmstart_chains:
        first_set = {c[0] for c in warmstart_chains if c}
        last_set = {c[-1] for c in warmstart_chains if c}
        seq_set = {(c[k], c[k + 1]) for c in warmstart_chains for k in range(len(c) - 1)}
        for i in range(n):
            model.add_hint(first[i], 1 if i in first_set else 0)
            model.add_hint(last[i], 1 if i in last_set else 0)
        for key, var in seq.items():
            model.add_hint(var, 1 if key in seq_set else 0)

    solver = cp_model.CpSolver()
    solver.parameters.max_time_in_seconds = float(time_limit)
    solver.parameters.random_seed = seed
    _set_workers_by_intensity(solver, intensity)

    log(f"  [VSP-FEAS/{label}] Cerco soluzione con #veh ≤ {max_vehicles}, "
        f"tl={time_limit:.0f}s")
    sc = solver.solve(model)
    status = solver.status_name(sc)

    if sc not in (cp_model.OPTIMAL, cp_model.FEASIBLE):
        log(f"  [VSP-FEAS/{label}] {status}: nessuna soluzione con ≤{max_vehicles} veicoli")
        return status, None

    chains = _extract_chains(n, arcs, seq, first, solver)
    actual_nv = solver.value(nv)
    log(f"  [VSP-FEAS/{label}] {status}: trovata soluzione con {actual_nv} veicoli "
        f"(bound era ≤{max_vehicles})")
    return status, chains


def iterative_vehicle_reduction(
    chains: list[list[int]], trips: list[Trip], arcs: list[Arc],
    arc_costs: dict[tuple[int, int], int], fixed_costs: list[int],
    time_budget_sec: float,
    intensity: str = "deep", seed: int = 4242,
) -> tuple[list[list[int]], dict]:
    """Riduzione iterativa veicoli: dato N=len(chains), prova target N-1, N-2,...
    finché il solver dimostra infeasibility o si esaurisce il time budget.

    Esattamente quello che farebbe un operatore manuale: "11 va, 10 anche?
    9 anche? Se non riesco con 8, mi fermo".
    """
    t0 = time.time()
    initial = len(chains)
    if initial <= 1:
        return chains, {"initial": initial, "final": initial, "attempts": 0,
                        "infeasibleAt": None, "elapsedSec": 0}

    best = chains
    attempts = 0
    infeasible_at = None
    proven_optimal = False

    log(f"  [VSP-ITER-RED] Inizio: {initial} veicoli, budget {time_budget_sec:.0f}s")

    while True:
        elapsed = time.time() - t0
        remaining = time_budget_sec - elapsed
        if remaining < 10:
            log(f"  [VSP-ITER-RED] Budget esaurito ({elapsed:.1f}s)")
            break

        target = len(best) - 1
        if target < 1:
            break
        # Distribuisci budget: più tempo se siamo vicini al limite (target piccolo)
        attempt_budget = min(remaining, max(30.0, time_budget_sec / 3))
        attempts += 1

        status, found = solve_vsp_feasibility_with_bound(
            trips, arcs, arc_costs, fixed_costs,
            max_vehicles=target, time_limit=attempt_budget,
            warmstart_chains=best,
            intensity=intensity, seed=seed + attempts,
            label=f"target{target}",
        )
        if found is None:
            # INFEASIBLE → abbiamo dimostrato il minimo
            if status == "INFEASIBLE":
                proven_optimal = True
                infeasible_at = target
                log(f"  [VSP-ITER-RED] Provato che ≤{target} è IMPOSSIBILE: "
                    f"{len(best)} è il minimo assoluto")
            else:
                log(f"  [VSP-ITER-RED] Timeout su target={target} ({status}): "
                    f"non posso scendere oltre {len(best)} entro il budget")
            break
        # Successo → accetta e continua
        best = found
        log(f"  [VSP-ITER-RED] ✔ Ridotto a {len(best)} veicoli (attempt #{attempts})")

    elapsed = time.time() - t0
    log(f"  [VSP-ITER-RED] Fine: {initial} → {len(best)} veicoli "
        f"(-{initial - len(best)}), {attempts} tentativi, {elapsed:.1f}s "
        f"{'[OTTIMO PROVATO]' if proven_optimal else '[best-effort]'}")
    return best, {
        "initial": initial,
        "final": len(best),
        "vehiclesEliminated": initial - len(best),
        "attempts": attempts,
        "infeasibleAt": infeasible_at,
        "provenOptimal": proven_optimal,
        "elapsedSec": round(elapsed, 1),
    }


def assign_vehicle_type(chain: list[int], trips: list[Trip]) -> str:
    """Find smallest vehicle type that can serve ALL trips in chain."""
    forced_type = None
    max_size = 0
    for idx in chain:
        t = trips[idx]
        s = VEHICLE_SIZE.get(t.required_vehicle, 3)
        if t.forced:
            forced_type = t.required_vehicle
        if s > max_size:
            max_size = s
    if forced_type:
        return forced_type
    for vt in sorted(VEHICLE_TYPES, key=lambda v: VEHICLE_SIZE[v]):
        vs = VEHICLE_SIZE[vt]
        all_ok = True
        for idx in chain:
            t = trips[idx]
            rs = VEHICLE_SIZE.get(t.required_vehicle, 3)
            if t.forced and vt != t.required_vehicle:
                all_ok = False
                break
            if not can_vehicle_serve(vs, rs):
                all_ok = False
                break
        if all_ok:
            return vt
    return "autosnodato"


def _arc_idle_min(arc: Arc) -> float:
    return max(0, arc.gap_min - max(arc.dh_min, MIN_LAYOVER))


def chain_cost_detailed(
    chain: list[int], trips: list[Trip], arcs_lookup: dict[tuple[int, int], Arc],
    rates: VehicleCostRates,
) -> VehicleShiftCost:
    """Compute full real-EUR cost with quadratic penalties for a chain."""
    vtype = assign_vehicle_type(chain, trips)
    service_km = sum(_estimate_trip_km(trips[i], rates) for i in chain)

    deadhead_km = 0.0
    idle_minutes = 0.0
    depot_returns = 0
    for k in range(len(chain) - 1):
        arc = arcs_lookup.get((chain[k], chain[k + 1]))
        if arc:
            deadhead_km += arc.dh_km
            idle_minutes += _arc_idle_min(arc)
            if arc.depot_return:
                depot_returns += 1

    shift_start = trips[chain[0]].departure_min
    shift_end = trips[chain[-1]].arrival_min
    nastro = shift_end - shift_start

    cost = VehicleShiftCost()
    cost.fixed_daily = rates.fixed_daily.get(vtype, 42.0)
    cost.service_km_cost = service_km * rates.per_service_km.get(vtype, 0.95)
    cost.deadhead_km_cost = deadhead_km * rates.per_deadhead_km.get(vtype, 0.80)

    idle_cost = idle_minutes * rates.idle_per_min
    long_idle = max(0, idle_minutes - rates.long_idle_threshold)
    idle_cost += long_idle * rates.long_idle_per_min
    cost.idle_cost = idle_cost

    cost.depot_return_cost = depot_returns * rates.per_depot_return

    delta = nastro - rates.target_shift_duration
    cost.balance_penalty = delta * delta * rates.balance_quadratic_coeff

    working = sum(trips[i].duration_min for i in chain)
    gap = nastro - working
    cost.gap_penalty = max(0, gap) ** 2 * rates.gap_quadratic_coeff

    vsize = VEHICLE_SIZE.get(vtype, 3)
    ds_pen = 0.0
    for i in chain:
        t = trips[i]
        rs = VEHICLE_SIZE.get(t.required_vehicle, 3)
        if vsize < rs:
            levels = rs - vsize
            if is_peak_hour(t.departure_min):
                ds_pen += levels * t.duration_min * rates.downsize_peak_per_level_per_min
            else:
                ds_pen += levels * t.duration_min * rates.downsize_offpeak_per_level_per_min
    cost.downsize_penalty = ds_pen

    cost.compute()
    return cost


def chain_cost_fast(
    chain: list[int], trips: list[Trip], arcs_lookup: dict[tuple[int, int], Arc],
    rates: VehicleCostRates,
) -> float:
    """Approssimazione veloce senza penalità quadratiche."""
    vtype = assign_vehicle_type(chain, trips)
    fixed = rates.fixed_daily.get(vtype, 42.0)
    service_km = sum(_estimate_trip_km(trips[i], rates) for i in chain)
    dh_km = 0.0
    idle_min = 0.0
    depot_ret = 0
    for k in range(len(chain) - 1):
        arc = arcs_lookup.get((chain[k], chain[k + 1]))
        if arc:
            dh_km += arc.dh_km
            idle_min += _arc_idle_min(arc)
            if arc.depot_return:
                depot_ret += 1
    return (fixed
            + service_km * rates.per_service_km.get(vtype, 0.95)
            + dh_km * rates.per_deadhead_km.get(vtype, 0.80)
            + idle_min * rates.idle_per_min
            + depot_ret * rates.per_depot_return)


def chain_cost_accept(
    chain: list[int], trips: list[Trip], arcs_lookup: dict[tuple[int, int], Arc],
    rates: VehicleCostRates, use_detailed: bool,
) -> float:
    """FIX-4: funzione di accettazione per la local search.

    Se use_detailed=True, include penalità quadratiche (balance/gap/downsize)
    e aggiunge ~30% tempo ma migliora direzione di ottimizzazione."""
    if use_detailed:
        return chain_cost_detailed(chain, trips, arcs_lookup, rates).total
    return chain_cost_fast(chain, trips, arcs_lookup, rates)


# ─── ADVANCED LOCAL SEARCH ──────────────────────────────────────────────

def _try_merge(chains, idx_a, idx_b, trips, arcs_lookup, rates, use_detailed):
    ca, cb = chains[idx_a], chains[idx_b]
    arc = arcs_lookup.get((ca[-1], cb[0]))
    if not arc:
        return None
    if not trips_vehicle_compatible(trips[ca[0]], trips[cb[0]]):
        return None
    merged = ca + cb
    old_cost = (chain_cost_accept(ca, trips, arcs_lookup, rates, use_detailed)
                + chain_cost_accept(cb, trips, arcs_lookup, rates, use_detailed))
    new_cost = chain_cost_accept(merged, trips, arcs_lookup, rates, use_detailed)
    if new_cost < old_cost - 0.01:
        return (new_cost - old_cost, merged, idx_a, idx_b)
    return None


def _try_relocate(chains, src_idx, pos_in_src, dst_idx, trips, arcs_lookup, rates, use_detailed):
    src = chains[src_idx]
    # FIX-VSP-4: rimosso `if len(src) <= 1: return None`.
    # Permettiamo di svuotare la chain d'origine: il caller filtra
    # `chains = [c for c in chains if c]` riducendo il numero di veicoli di 1.
    if not src:
        return None
    trip_idx = src[pos_in_src]
    new_src = src[:pos_in_src] + src[pos_in_src + 1:]
    dst = chains[dst_idx]
    best = None
    for insert_pos in range(len(dst) + 1):
        new_dst = dst[:insert_pos] + [trip_idx] + dst[insert_pos:]
        ok = True
        for k in range(len(new_dst) - 1):
            if (new_dst[k], new_dst[k + 1]) not in arcs_lookup:
                ok = False
                break
        if not ok:
            continue
        for k in range(len(new_src) - 1):
            if (new_src[k], new_src[k + 1]) not in arcs_lookup:
                ok = False
                break
        if not ok:
            continue
        old_cost = (chain_cost_accept(src, trips, arcs_lookup, rates, use_detailed)
                    + chain_cost_accept(dst, trips, arcs_lookup, rates, use_detailed))
        new_cost = (chain_cost_accept(new_src, trips, arcs_lookup, rates, use_detailed)
                    + chain_cost_accept(new_dst, trips, arcs_lookup, rates, use_detailed))
        delta = new_cost - old_cost
        if delta < -0.01 and (best is None or delta < best[0]):
            best = (delta, new_src, new_dst, src_idx, dst_idx)
    return best


def _try_swap(chains, idx_a, pos_a, idx_b, pos_b, trips, arcs_lookup, rates, use_detailed):
    ca, cb = list(chains[idx_a]), list(chains[idx_b])
    ca[pos_a], cb[pos_b] = cb[pos_b], ca[pos_a]
    for c in (ca, cb):
        for k in range(len(c) - 1):
            if (c[k], c[k + 1]) not in arcs_lookup:
                return None
    old_cost = (chain_cost_accept(chains[idx_a], trips, arcs_lookup, rates, use_detailed)
                + chain_cost_accept(chains[idx_b], trips, arcs_lookup, rates, use_detailed))
    new_cost = (chain_cost_accept(ca, trips, arcs_lookup, rates, use_detailed)
                + chain_cost_accept(cb, trips, arcs_lookup, rates, use_detailed))
    if new_cost < old_cost - 0.01:
        return (new_cost - old_cost, ca, cb, idx_a, idx_b)
    return None


def _try_or_opt(chains, idx, seg_start, seg_len, new_pos, trips, arcs_lookup, rates, use_detailed):
    chain = chains[idx]
    if seg_start + seg_len > len(chain):
        return None
    segment = chain[seg_start:seg_start + seg_len]
    rest = chain[:seg_start] + chain[seg_start + seg_len:]
    if new_pos > len(rest):
        return None
    new_chain = rest[:new_pos] + segment + rest[new_pos:]
    for k in range(len(new_chain) - 1):
        if (new_chain[k], new_chain[k + 1]) not in arcs_lookup:
            return None
    old_cost = chain_cost_accept(chain, trips, arcs_lookup, rates, use_detailed)
    new_cost = chain_cost_accept(new_chain, trips, arcs_lookup, rates, use_detailed)
    if new_cost < old_cost - 0.01:
        return (new_cost - old_cost, new_chain, idx)
    return None


def _try_rebalance(chains, idx_long, idx_short, trips, arcs_lookup, rates, use_detailed):
    cl, cs = chains[idx_long], chains[idx_short]
    if len(cl) <= 2:
        return None
    trip_idx = cl[-1]
    new_long = cl[:-1]
    arc = arcs_lookup.get((cs[-1], trip_idx))
    if not arc:
        return None
    new_short = cs + [trip_idx]
    for k in range(len(new_short) - 1):
        if (new_short[k], new_short[k + 1]) not in arcs_lookup:
            return None
    old_cost = (chain_cost_accept(cl, trips, arcs_lookup, rates, use_detailed)
                + chain_cost_accept(cs, trips, arcs_lookup, rates, use_detailed))
    new_cost = (chain_cost_accept(new_long, trips, arcs_lookup, rates, use_detailed)
                + chain_cost_accept(new_short, trips, arcs_lookup, rates, use_detailed))
    if new_cost < old_cost - 0.01:
        return (new_cost - old_cost, new_long, new_short, idx_long, idx_short)
    return None


def advanced_local_search(
    chains: list[list[int]], trips: list[Trip],
    arcs_lookup: dict[tuple[int, int], Arc], rates: VehicleCostRates,
    max_iter: int = 3000, max_time_sec: float = 15.0,
    use_detailed_cost: bool = True,
    no_improve_limit: int = 500,
    saturation_mode: bool = False,
) -> list[list[int]]:
    """FIX-4: use_detailed_cost=True usa chain_cost_detailed come funzione
    di accettazione - coerente con il costo reportato al cliente.

    FIX-VSP-3: saturation_mode=True (regola#1 strict/lexicographic) disattiva
    le penalità anti-saturazione (balance/gap/downsize quadratiche) forzando
    use_detailed_cost=False. Questo permette catene lunghe e dense che
    minimizzano il numero di veicoli, anche a costo di nastri non bilanciati.
    """
    if len(chains) <= 1:
        return chains

    if saturation_mode and use_detailed_cost:
        log(f"  [LS] saturation_mode=ON → use_detailed_cost forzato a False "
            f"(anti-saturation penalties disabled)")
        use_detailed_cost = False

    t0 = time.time()
    chains = [list(c) for c in chains]
    best_total = sum(chain_cost_accept(c, trips, arcs_lookup, rates, use_detailed_cost)
                     for c in chains)
    no_improve = 0
    rng = random.Random(42)
    move_weights = [30, 25, 20, 15, 10]
    moves = ["merge", "relocate", "swap", "or_opt", "rebalance"]
    iteration = 0

    log(f"  [LS] start: {len(chains)} chains, EUR{best_total:.2f}, "
        f"detailed={use_detailed_cost}, no_improve_limit={no_improve_limit}")

    for iteration in range(max_iter):
        if time.time() - t0 > max_time_sec:
            break
        if no_improve > no_improve_limit:
            break

        move = rng.choices(moves, weights=move_weights, k=1)[0]
        result = None
        nc = len(chains)
        if nc < 2 and move in ("merge", "relocate", "swap", "rebalance"):
            no_improve += 1
            continue

        if move == "merge":
            a, b = rng.sample(range(nc), 2)
            result = _try_merge(chains, a, b, trips, arcs_lookup, rates, use_detailed_cost)
            if result:
                _, merged, ia, ib = result
                chains[ia] = merged
                chains.pop(ib)
        elif move == "relocate":
            a, b = rng.sample(range(nc), 2)
            if chains[a]:
                pos = rng.randrange(len(chains[a]))
                result = _try_relocate(chains, a, pos, b, trips, arcs_lookup, rates, use_detailed_cost)
                if result:
                    _, new_src, new_dst, ia, ib = result
                    chains[ia] = new_src
                    chains[ib] = new_dst
                    chains = [c for c in chains if c]
        elif move == "swap":
            a, b = rng.sample(range(nc), 2)
            if chains[a] and chains[b]:
                pa = rng.randrange(len(chains[a]))
                pb = rng.randrange(len(chains[b]))
                result = _try_swap(chains, a, pa, b, pb, trips, arcs_lookup, rates, use_detailed_cost)
                if result:
                    _, ca, cb, ia, ib = result
                    chains[ia] = ca
                    chains[ib] = cb
        elif move == "or_opt":
            idx = rng.randrange(nc)
            if len(chains[idx]) >= 3:
                seg_len = rng.choice([1, 2, 3])
                seg_start = rng.randrange(max(1, len(chains[idx]) - seg_len + 1))
                new_pos = rng.randrange(max(1, len(chains[idx]) - seg_len + 1))
                result = _try_or_opt(chains, idx, seg_start, seg_len, new_pos,
                                     trips, arcs_lookup, rates, use_detailed_cost)
                if result:
                    _, new_chain, ci = result
                    chains[ci] = new_chain
        elif move == "rebalance":
            lengths = [(len(c), i) for i, c in enumerate(chains)]
            lengths.sort(reverse=True)
            if len(lengths) >= 2:
                result = _try_rebalance(chains, lengths[0][1], lengths[-1][1],
                                        trips, arcs_lookup, rates, use_detailed_cost)
                if result:
                    _, new_long, new_short, il, is_ = result
                    chains[il] = new_long
                    chains[is_] = new_short

        if result:
            new_total = sum(chain_cost_accept(c, trips, arcs_lookup, rates, use_detailed_cost)
                            for c in chains)
            if new_total < best_total:
                best_total = new_total
                no_improve = 0
            else:
                no_improve += 1
        else:
            no_improve += 1

    elapsed = time.time() - t0
    log(f"  [LS] done: {iteration + 1} iter, {len(chains)} chains, "
        f"EUR{best_total:.2f}, {elapsed:.1f}s")
    return chains


# ─── POST-PASS: ELIMINAZIONE VEICOLI (regola #1 hard) ───────────────────

def vehicle_elimination_pass(
    chains: list[list[int]], trips: list[Trip],
    arcs_lookup: dict[tuple[int, int], Arc], rates: VehicleCostRates,
    max_passes: int = 5, time_budget_sec: float = 30.0,
) -> tuple[list[list[int]], dict]:
    """Elimina veicoli con strategia aggressiva multi-mossa.

    Strategia per ogni passata:
      FASE A — Chain concatenation (la più potente): per ogni coppia (A, B) di
        catene, se arco (A[-1] -> B[0]) è feasible e i tipi sono compatibili,
        fonde A+B ed elimina la catena risultante più "scarica" come veicolo.
        Ordine di prova: tail-time crescente (cerca prima quelle che finiscono
        presto, perché possono essere prefissi di catene successive).
      FASE B — Block insertion: per ogni catena vittima (piccola), prova a
        inserirla come BLOCCO CONTIGUO in un'altra catena (in qualche posizione
        feasible). Più veloce e robusto della rilocazione trip-per-trip.
      FASE C — Trip-by-trip relocation: fallback. Senza più cap di dimensione
        (rimosso il vecchio limite len > 8); ordina vittime per # trip crescente
        ma considera tutte.
      FASE D — Split 2-way: se la vittima non si riassorbe intera, prova a
        spezzare i suoi trip su 2 catene riceventi (split point ottimale).

    Le fasi vengono ripetute finché si elimina almeno un veicolo per passata
    o si esaurisce il time budget.
    """
    t0 = time.time()
    chains = [list(c) for c in chains if c]
    initial_count = len(chains)
    eliminated_total = 0
    eliminated_by_phase = {"concat": 0, "mid_absorb": 0, "block": 0, "relocate": 0, "split": 0, "ruin": 0}
    passes_done = 0

    log(f"  [VEH-ELIM] Inizio: {initial_count} veicoli, budget {time_budget_sec}s")

    def chain_feasible(c: list[int]) -> bool:
        return all((c[k], c[k + 1]) in arcs_lookup for k in range(len(c) - 1))

    def try_insert_block(target: list[int], block: list[int]) -> list[int] | None:
        """Tenta di inserire `block` come segmento contiguo in `target` in qualche
        posizione preservando feasibility e compatibilità tipo.
        Ritorna la nuova catena oppure None.
        """
        if not block:
            return list(target)
        if not trips_vehicle_compatible(trips[target[0]], trips[block[0]]):
            return None
        # Verifica che il blocco stesso sia internamente feasible
        if not chain_feasible(block):
            return None
        b_first, b_last = block[0], block[-1]
        n = len(target)
        for pos in range(n + 1):
            # join sinistro
            if pos > 0 and (target[pos - 1], b_first) not in arcs_lookup:
                continue
            # join destro
            if pos < n and (b_last, target[pos]) not in arcs_lookup:
                continue
            return target[:pos] + block + target[pos:]
        return None

    for pass_idx in range(max_passes):
        if time.time() - t0 > time_budget_sec:
            log(f"  [VEH-ELIM] Time budget esaurito al pass {pass_idx + 1}")
            break

        eliminated_this_pass = 0

        # ─── FASE A: Chain concatenation ────────────────────────────────
        # Cerca coppie (A, B) feasible per concatenazione. Itera fino a
        # quando non trova più coppie utili in questa fase.
        while True:
            if time.time() - t0 > time_budget_sec:
                break
            best_pair: tuple[int, int] | None = None
            # Ordiniamo per "tail time" crescente per A (chi finisce presto)
            # e per "head time" crescente per B (chi parte presto)
            order_a = sorted(range(len(chains)), key=lambda i: trips[chains[i][-1]].arrival_min)
            for ai in order_a:
                a_chain = chains[ai]
                a_last = a_chain[-1]
                a_arr = trips[a_last].arrival_min
                for bi in range(len(chains)):
                    if bi == ai:
                        continue
                    b_chain = chains[bi]
                    b_first = b_chain[0]
                    if trips[b_first].departure_min <= a_arr:
                        continue
                    if not trips_vehicle_compatible(trips[a_chain[0]], trips[b_first]):
                        continue
                    if (a_last, b_first) not in arcs_lookup:
                        continue
                    best_pair = (ai, bi)
                    break
                if best_pair is not None:
                    break
            if best_pair is None:
                break
            ai, bi = best_pair
            len_a, len_b = len(chains[ai]), len(chains[bi])
            merged = chains[ai] + chains[bi]
            # Sostituisci A con merged e rimuovi B
            new_chains = []
            for k, c in enumerate(chains):
                if k == ai:
                    new_chains.append(merged)
                elif k == bi:
                    continue
                else:
                    new_chains.append(c)
            chains = new_chains
            eliminated_this_pass += 1
            eliminated_total += 1
            eliminated_by_phase["concat"] += 1
            log(f"  [VEH-ELIM] pass {pass_idx + 1} CONCAT: fuse A({len_a}) "
                f"+ B -> merged len {len(merged)}, ora {len(chains)} veicoli")

        # ─── FASE A2: Mid-chain absorption (FIX-VSP-5) ─────────────────
        # Per vittime molto piccole (≤4 trip): prova a inserire OGNI trip
        # in posizione mid-chain di altre catene, accettando split del trip
        # in chain diverse. Più aggressiva di BLOCK (non richiede contiguità)
        # ma più mirata di RELOCATE (limitata alle piccole vittime).
        # Eseguita prima di BLOCK perché spesso sblocca casi che BLOCK rifiuta
        # per impossibilità di mantenere il blocco contiguo.
        order = sorted(range(len(chains)), key=lambda i: len(chains[i]))
        kept = set(range(len(chains)))
        for victim_idx in order:
            if time.time() - t0 > time_budget_sec:
                break
            if victim_idx not in kept:
                continue
            victim = chains[victim_idx]
            if not (1 <= len(victim) <= 4):
                continue
            # Prova relocazione trip-per-trip su tutte le posizioni feasible
            other = {i: list(chains[i]) for i in kept if i != victim_idx}
            relocations: list[tuple[int, list[int]]] = []
            ok_all = True
            for trip_idx in victim:
                trip = trips[trip_idx]
                placed = False
                # Preferisci catene più piene (saturazione)
                cand = sorted(other.keys(), key=lambda i: -len(other[i]))
                for tgt in cand:
                    tc = other[tgt]
                    if not trips_vehicle_compatible(trips[tc[0]], trip):
                        continue
                    # Cerca QUALSIASI posizione feasible (anche mid-chain)
                    for pos in range(len(tc) + 1):
                        if pos > 0 and (tc[pos - 1], trip_idx) not in arcs_lookup:
                            continue
                        if pos < len(tc) and (trip_idx, tc[pos]) not in arcs_lookup:
                            continue
                        nc = tc[:pos] + [trip_idx] + tc[pos:]
                        other[tgt] = nc
                        relocations.append((tgt, nc))
                        placed = True
                        break
                    if placed:
                        break
                if not placed:
                    ok_all = False
                    break
            if ok_all:
                for tgt, nc in relocations:
                    chains[tgt] = nc
                kept.discard(victim_idx)
                eliminated_this_pass += 1
                eliminated_total += 1
                eliminated_by_phase["mid_absorb"] += 1
                log(f"  [VEH-ELIM] pass {pass_idx + 1} MID-ABSORB: vittima "
                    f"({len(victim)} corse) assorbita in posizioni mid-chain")
        chains = [chains[i] for i in sorted(kept)]

        # ─── FASE B: Block insertion ────────────────────────────────────
        # Ordina vittime per # trip crescente (le più scariche prime)
        order = sorted(range(len(chains)), key=lambda i: len(chains[i]))
        kept = set(range(len(chains)))
        for victim_idx in order:
            if time.time() - t0 > time_budget_sec:
                break
            if victim_idx not in kept:
                continue
            victim = chains[victim_idx]
            # Considera anche vittime di dimensione media
            if len(victim) > 12:
                continue
            inserted = False
            # Prova in altre catene, prima quelle più piene (saturazione)
            cand = sorted([i for i in kept if i != victim_idx],
                          key=lambda i: -len(chains[i]))
            for tgt in cand:
                merged = try_insert_block(chains[tgt], victim)
                if merged is not None:
                    chains[tgt] = merged
                    kept.discard(victim_idx)
                    eliminated_this_pass += 1
                    eliminated_total += 1
                    eliminated_by_phase["block"] += 1
                    log(f"  [VEH-ELIM] pass {pass_idx + 1} BLOCK: vittima "
                        f"({len(victim)} corse) inserita in catena {tgt}")
                    inserted = True
                    break
            # nessun else necessario
        chains = [chains[i] for i in sorted(kept)]

        # ─── FASE C: Trip-by-trip relocation (fallback) ─────────────────
        order = sorted(range(len(chains)), key=lambda i: len(chains[i]))
        kept = set(range(len(chains)))
        for victim_idx in order:
            if time.time() - t0 > time_budget_sec:
                break
            if victim_idx not in kept:
                continue
            victim = chains[victim_idx]
            # Rimosso il limite len>8: tentiamo anche catene grandi
            other = {i: list(chains[i]) for i in kept if i != victim_idx}
            relocations: list[tuple[int, list[int]]] = []
            ok_all = True
            for trip_idx in victim:
                trip = trips[trip_idx]
                placed = False
                cand = sorted(other.keys(), key=lambda i: -len(other[i]))
                for tgt in cand:
                    tc = other[tgt]
                    if not trips_vehicle_compatible(trips[tc[0]], trip):
                        continue
                    for pos in range(len(tc) + 1):
                        if pos > 0 and (tc[pos - 1], trip_idx) not in arcs_lookup:
                            continue
                        if pos < len(tc) and (trip_idx, tc[pos]) not in arcs_lookup:
                            continue
                        nc = tc[:pos] + [trip_idx] + tc[pos:]
                        other[tgt] = nc
                        relocations.append((tgt, nc))
                        placed = True
                        break
                    if placed:
                        break
                if not placed:
                    ok_all = False
                    break
            if ok_all:
                for tgt, nc in relocations:
                    chains[tgt] = nc
                kept.discard(victim_idx)
                eliminated_this_pass += 1
                eliminated_total += 1
                eliminated_by_phase["relocate"] += 1
                log(f"  [VEH-ELIM] pass {pass_idx + 1} RELOC: vittima "
                    f"({len(victim)} corse) ridistribuita")
        chains = [chains[i] for i in sorted(kept)]

        # ─── FASE D: Split 2-way (vittima divisa su 2 catene) ───────────
        # Solo per vittime piccole (≤6) altrimenti combinatoriale esplode
        order = sorted(range(len(chains)), key=lambda i: len(chains[i]))
        kept = set(range(len(chains)))
        for victim_idx in order:
            if time.time() - t0 > time_budget_sec:
                break
            if victim_idx not in kept:
                continue
            victim = chains[victim_idx]
            if len(victim) > 6 or len(victim) < 2:
                continue
            placed = False
            # Prova ogni split point: prefix [0..k], suffix [k..]
            for k in range(1, len(victim)):
                prefix, suffix = victim[:k], victim[k:]
                if not (chain_feasible(prefix) and chain_feasible(suffix)):
                    continue
                cand = sorted([i for i in kept if i != victim_idx],
                              key=lambda i: -len(chains[i]))
                # Trova target per prefix
                for tp in cand:
                    new_p = try_insert_block(chains[tp], prefix)
                    if new_p is None:
                        continue
                    # Trova target per suffix (diverso da tp)
                    for ts in cand:
                        if ts == tp:
                            continue
                        new_s = try_insert_block(chains[ts], suffix)
                        if new_s is None:
                            continue
                        chains[tp] = new_p
                        chains[ts] = new_s
                        kept.discard(victim_idx)
                        eliminated_this_pass += 1
                        eliminated_total += 1
                        eliminated_by_phase["split"] += 1
                        log(f"  [VEH-ELIM] pass {pass_idx + 1} SPLIT: vittima "
                            f"({len(victim)} corse) divisa {len(prefix)}+{len(suffix)} "
                            f"su catene {tp},{ts}")
                        placed = True
                        break
                    if placed:
                        break
                if placed:
                    break
        chains = [chains[i] for i in sorted(kept)]

        # ─── FASE E: Ruin & Recreate (dissolve K piccole + reinsert) ────
        # Mossa "manuale": prendi le K catene più scariche, smonta tutti i loro
        # trip in una pool, e prova a reinserirli uno-a-uno (best-fit) nelle
        # catene rimanenti. Se TUTTI inseribili → -K veicoli. Altrimenti
        # rollback. Si prova K = 1, 2, 3 a cascata.
        # Più potente di RELOCATE perché smonta SIMULTANEAMENTE più vittime,
        # liberando posizioni mid-chain che prima erano occupate.
        if len(chains) >= 4 and time.time() - t0 <= time_budget_sec:
            for K in (1, 2, 3):
                if time.time() - t0 > time_budget_sec:
                    break
                if len(chains) < K + 2:
                    continue
                # Le K catene più scariche (per # trip)
                victims_idx = sorted(range(len(chains)),
                                     key=lambda i: len(chains[i]))[:K]
                victim_set = set(victims_idx)
                pool: list[int] = []
                for vi in victims_idx:
                    pool.extend(chains[vi])
                # Ordina la pool per departure_min (greedy stabile)
                pool.sort(key=lambda ti: trips[ti].departure_min)
                # Working copy delle catene riceventi
                working = {i: list(chains[i]) for i in range(len(chains))
                           if i not in victim_set}
                ok_all = True
                for trip_idx in pool:
                    trip = trips[trip_idx]
                    placed = False
                    # Best-fit: prova catene più piene prima
                    cand = sorted(working.keys(), key=lambda i: -len(working[i]))
                    for tgt in cand:
                        tc = working[tgt]
                        if not trips_vehicle_compatible(trips[tc[0]], trip):
                            continue
                        for pos in range(len(tc) + 1):
                            if pos > 0 and (tc[pos - 1], trip_idx) not in arcs_lookup:
                                continue
                            if pos < len(tc) and (trip_idx, tc[pos]) not in arcs_lookup:
                                continue
                            working[tgt] = tc[:pos] + [trip_idx] + tc[pos:]
                            placed = True
                            break
                        if placed:
                            break
                    if not placed:
                        ok_all = False
                        break
                if ok_all:
                    # Successo: applica e abbandona K più alti (le catene sono
                    # cambiate, sarà il prossimo pass a riprovare)
                    chains = [working[i] for i in sorted(working.keys())]
                    eliminated_this_pass += K
                    eliminated_total += K
                    eliminated_by_phase["ruin"] += K
                    log(f"  [VEH-ELIM] pass {pass_idx + 1} RUIN&RECREATE: "
                        f"dissolte {K} catene piccole, {len(pool)} corse riassorbite")
                    break

        passes_done = pass_idx + 1
        if eliminated_this_pass == 0:
            log(f"  [VEH-ELIM] pass {pass_idx + 1}: nessun veicolo eliminabile, fine")
            # ─── DIAGNOSTICA: spiega PERCHÉ le piccole vittime sono bloccate
            small = sorted([i for i in range(len(chains)) if len(chains[i]) <= 8],
                           key=lambda i: len(chains[i]))[:3]
            for vi in small:
                victim = chains[vi]
                first_t = trips[victim[0]]
                last_t = trips[victim[-1]]
                # Quanti archi entranti ha il primo trip della vittima da catene altre
                in_arcs = sum(1 for j in range(len(chains))
                              if j != vi
                              and (chains[j][-1], victim[0]) in arcs_lookup)
                # Quanti archi uscenti dall'ultimo trip della vittima verso primi di altre
                out_arcs = sum(1 for j in range(len(chains))
                               if j != vi
                               and (victim[-1], chains[j][0]) in arcs_lookup)
                log(f"  [VEH-ELIM-DIAG] vittima {len(victim)}t "
                    f"[{first_t.departure_time}→{last_t.arrival_time}, "
                    f"start={first_t.first_stop_name[:18]}, end={last_t.last_stop_name[:18]}]: "
                    f"archi entranti={in_arcs}, uscenti={out_arcs}")
            break

    elapsed = time.time() - t0
    final_count = len(chains)
    log(f"  [VEH-ELIM] Fine: {initial_count} → {final_count} veicoli "
        f"(-{eliminated_total}), {passes_done} passate, {elapsed:.1f}s "
        f"[concat={eliminated_by_phase['concat']}, mid={eliminated_by_phase['mid_absorb']}, "
        f"block={eliminated_by_phase['block']}, reloc={eliminated_by_phase['relocate']}, "
        f"split={eliminated_by_phase['split']}, ruin={eliminated_by_phase['ruin']}]")

    return chains, {
        "initialVehicles": initial_count,
        "finalVehicles": final_count,
        "vehiclesEliminated": eliminated_total,
        "passesDone": passes_done,
        "elapsedSec": round(elapsed, 1),
        "byPhase": eliminated_by_phase,
    }


# ─── CHAIN -> VEHICLE SHIFT CONVERSION ──────────────────────────────────

def chains_to_shifts(
    chains: list[list[int]], trips: list[Trip],
    arcs_lookup: dict[tuple[int, int], Arc], rates: VehicleCostRates,
    route_names: dict[str, str] | None = None,
) -> list[VehicleShift]:
    """Convert solver chains to VehicleShift objects matching TypeScript format."""
    shifts: list[VehicleShift] = []

    for vi, chain in enumerate(chains):
        if not chain:
            continue

        vtype = assign_vehicle_type(chain, trips)
        vsize = VEHICLE_SIZE.get(vtype, 3)
        vid = f"V{str(vi + 1).zfill(3)}"

        cat_count = {"urbano": 0, "extraurbano": 0}
        for idx in chain:
            cat_count[trips[idx].category] = cat_count.get(trips[idx].category, 0) + 1
        category = max(cat_count, key=cat_count.get)

        vs = VehicleShift(
            vehicle_id=vid,
            vehicle_type=vtype,
            category=category,
        )

        for ci, trip_idx in enumerate(chain):
            t = trips[trip_idx]

            if ci > 0:
                prev_idx = chain[ci - 1]
                arc = arcs_lookup.get((prev_idx, trip_idx))
                prev_t = trips[prev_idx]

                if arc and arc.depot_return:
                    depot_dep = prev_t.arrival_min + max(1, arc.dh_min // 2)
                    depot_arr = t.departure_min - max(1, arc.dh_min // 2)
                    vs.trips.append(VShiftTrip(
                        type="depot", trip_id="", route_id="",
                        route_name="Rientro deposito", headsign=None,
                        departure_time=min_to_time(depot_dep),
                        arrival_time=min_to_time(depot_arr),
                        departure_min=depot_dep, arrival_min=depot_arr,
                    ))
                    vs.depot_returns += 1
                elif arc and arc.dh_km > 0.5:
                    dh_start = prev_t.arrival_min + MIN_LAYOVER
                    dh_end = min(dh_start + arc.dh_min, t.departure_min)
                    vs.trips.append(VShiftTrip(
                        type="deadhead", trip_id="", route_id="",
                        route_name=f"Vuoto ({arc.dh_km} km)",
                        headsign=None,
                        departure_time=min_to_time(dh_start),
                        arrival_time=min_to_time(dh_end),
                        departure_min=dh_start, arrival_min=dh_end,
                        deadhead_km=arc.dh_km, deadhead_min=arc.dh_min,
                    ))
                    vs.total_deadhead_min += arc.dh_min
                    vs.total_deadhead_km += arc.dh_km

            req_size = VEHICLE_SIZE.get(t.required_vehicle, 3)
            is_down = vsize < req_size
            rname = (route_names or {}).get(t.route_id, t.route_name)
            vs.trips.append(VShiftTrip(
                type="trip", trip_id=t.trip_id, route_id=t.route_id,
                route_name=rname, headsign=t.headsign,
                departure_time=t.departure_time, arrival_time=t.arrival_time,
                departure_min=t.departure_min, arrival_min=t.arrival_min,
                first_stop_name=t.first_stop_name, last_stop_name=t.last_stop_name,
                stop_count=t.stop_count, duration_min=t.duration_min,
                direction_id=t.direction_id,
                downsized=is_down,
                original_vehicle=t.required_vehicle if is_down else None,
            ))
            if is_down:
                vs.downsized_trips += 1

            vs.total_service_min += t.duration_min
            vs.trip_count += 1

        first_trip = next((e for e in vs.trips if e.type == "trip"), None)
        last_trip = next((e for e in reversed(vs.trips) if e.type == "trip"), None)
        if first_trip and last_trip:
            vs.start_min = first_trip.departure_min
            vs.end_min = last_trip.arrival_min
            vs.first_out = first_trip.departure_min
            vs.last_in = last_trip.arrival_min
            vs.shift_duration = vs.end_min - vs.start_min

        shifts.append(vs)

    shifts.sort(key=lambda s: s.first_out)
    for idx, s in enumerate(shifts):
        s.fifo_order = idx + 1

    return shifts


def compute_shift_costs(
    chains: list[list[int]], trips: list[Trip],
    arcs_lookup: dict[tuple[int, int], Arc], rates: VehicleCostRates,
) -> dict:
    """Post-processing: detailed cost breakdown per shift and aggregated."""
    shift_costs: list[dict] = []
    totals = VehicleShiftCost()

    for v_idx, chain in enumerate(chains):
        if not chain:
            continue
        sc = chain_cost_detailed(chain, trips, arcs_lookup, rates)
        d = sc.to_dict()
        d["vehicleId"] = v_idx + 1
        d["vehicleType"] = assign_vehicle_type(chain, trips)
        d["numTrips"] = len(chain)
        shift_costs.append(d)
        totals.fixed_daily += sc.fixed_daily
        totals.service_km_cost += sc.service_km_cost
        totals.deadhead_km_cost += sc.deadhead_km_cost
        totals.idle_cost += sc.idle_cost
        totals.depot_return_cost += sc.depot_return_cost
        totals.balance_penalty += sc.balance_penalty
        totals.gap_penalty += sc.gap_penalty
        totals.downsize_penalty += sc.downsize_penalty
        totals.total += sc.total

    return {
        "perShift": shift_costs,
        "aggregated": totals.to_dict(),
        "numVehicles": len(shift_costs),
    }


# ─── MULTI-SCENARIO PORTFOLIO ───────────────────────────────────────────

def optimize_vsp_multi_scenario(
    trips: list[Trip], arcs: list[Arc], arcs_lookup: dict[tuple[int, int], Arc],
    rates: VehicleCostRates, total_time_limit: int,
    greedy_chains: list[list[int]],
    vsp_config: VSPConfig,
    new_vehicle_penalty_eur: float = 0.0,
) -> tuple[list[list[int]], dict]:
    """Esegue N scenari CP-SAT con strategie + seed + warm-start diversificati,
    applica no-good cuts per forzare diversità, e ritorna il migliore.

    FIX-1: warm-start split (prima metà diversificazione, seconda metà intensificazione)
    FIX-3: no-good cuts verso soluzioni già esplorate
    FIX-5: polish con strategia complementare al best
    """
    global LAST_VSP_SCENARIOS, LAST_VSP_ANALYSIS

    LAST_VSP_SCENARIOS = []
    LAST_VSP_ANALYSIS = {}

    intensity = vsp_config.intensity
    use_detailed_ls = vsp_config.ls_use_detailed_cost

    # Numero scenari
    if vsp_config.scenarios_override is not None:
        n_scenarios = max(1, int(vsp_config.scenarios_override))
    else:
        n_scenarios = {"fast": 3, "normal": 5, "deep": 8, "extreme": 12}.get(intensity, 5)

    # Limita al numero di strategie disponibili * 2 (max 2 seed per strategia)
    n_scenarios = min(n_scenarios, len(vsp_config.strategies_enabled) * 2)
    n_scenarios = max(1, n_scenarios)

    # Budget tempi
    polish_time = 0
    if vsp_config.enable_polish:
        polish_time = max(20, int(total_time_limit * vsp_config.polish_time_pct))
    scenario_budget = max(15, int((total_time_limit - polish_time) / n_scenarios))

    log(f"  [VSP-MULTI] {n_scenarios} scenari × {scenario_budget}s + polish {polish_time}s "
        f"(totale {total_time_limit}s, int={intensity})")
    log(f"  [VSP-MULTI] Config: {vsp_config.summary()}")

    # ── REGOLA #1: calcolo bonus priorità min veicoli ──────────────
    # Il bonus viene sommato al fixed_cost di ogni potenziale "primo trip"
    # di una catena. Più alto è, più il solver risparmierà veicoli.
    #   off            -> 0 (nessun bonus extra)
    #   soft           -> bonus pari a 1x il fixed_daily medio (~42 EUR)
    #   strict         -> bonus pari a 5x il fixed_daily medio (~210 EUR)
    #   lexicographic  -> bonus = upper-bound del costo TOTALE di tutti gli
    #                     archi possibili. Garantisce che ridurre di 1 il
    #                     numero di veicoli batta SEMPRE qualunque aumento
    #                     di costo variabile (ordine lessicografico vero).
    avg_fixed = sum(rates.fixed_daily.values()) / max(1, len(rates.fixed_daily))
    prio = vsp_config.min_vehicles_priority
    if prio == "off":
        veh_prio_bonus = 0
    elif prio == "strict":
        veh_prio_bonus = int(avg_fixed * 5.0 * COST_SCALE)
    elif prio == "lexicographic":
        # Upper bound (in COST_SCALE units): max costo arco × num archi × safety
        max_arc_cost = 0
        # Pre-calcolo costo balanced per stimare ub
        tmp_costs = precompute_arc_costs(arcs, trips, rates,
                                         strategy=VSP_STRATEGIES["balanced"],
                                         amplifier=vsp_config.strategy_amplifier)
        if tmp_costs:
            max_arc_cost = max(tmp_costs.values())
        # Bound = (max costo arco × num archi possibili) + max fixed × n trips, ×2 safety
        ub_var = max_arc_cost * max(1, len(arcs))
        ub_fix = int(max(rates.fixed_daily.values()) * COST_SCALE) * len(trips)
        veh_prio_bonus = (ub_var + ub_fix) * 2 + 1
        log(f"  [VSP-MULTI] LEXICOGRAPHIC: vehicle_priority_bonus={veh_prio_bonus} "
            f"(garantisce min veicoli prima del costo)")
    else:  # soft
        veh_prio_bonus = int(avg_fixed * 1.0 * COST_SCALE)
    log(f"  [VSP-MULTI] Priorità min-veicoli: {prio} → bonus={veh_prio_bonus} "
        f"(scaled, ~EUR {veh_prio_bonus / COST_SCALE:.0f})")

    # Scelta strategie: prima 'balanced' poi rotazione.
    # Se prefer_monolinea: 'monolinea' diventa prima e duplicata per più seed.
    available = list(vsp_config.strategies_enabled)
    if vsp_config.prefer_monolinea:
        if "monolinea" not in available:
            available = ["monolinea"] + available
        else:
            available = ["monolinea"] + [s for s in available if s != "monolinea"]
        log(f"  [VSP-MULTI] prefer_monolinea ON → strategia monolinea prioritaria")
    elif "balanced" in available:
        available = ["balanced"] + [s for s in available if s != "balanced"]
    chosen = [available[i % len(available)] for i in range(n_scenarios)]

    # FIX-1: genera warm-start diversificati per i primi scenari
    n_diverse_ws = max(1, int(n_scenarios * vsp_config.warmstart_split))
    log(f"  [VSP-MULTI] warm-start: primi {n_diverse_ws} scenari con greedy diversificati, "
        f"poi {n_scenarios - n_diverse_ws} con hint dal best")
    diverse_ws = generate_diverse_warmstarts(
        trips, arcs, arcs_lookup, rates,
        n_variants=max(vsp_config.greedy_perturbations, n_diverse_ws),
        new_vehicle_penalty_eur=new_vehicle_penalty_eur,
    )
    if not diverse_ws:
        diverse_ws = [greedy_chains]

    # FIX-3: accumula set di archi delle soluzioni già esplorate per no-good cuts
    forbidden_arc_sets: list[set[tuple[int, int]]] = []

    best_chains: list[list[int]] = greedy_chains
    best_cost = sum(chain_cost_fast(c, trips, arcs_lookup, rates) for c in greedy_chains)
    best_label = "greedy"
    best_detailed_cost = sum(chain_cost_accept(c, trips, arcs_lookup, rates, use_detailed_ls)
                             for c in greedy_chains)

    for sc_idx, strat_key in enumerate(chosen):
        strat = VSP_STRATEGIES[strat_key]
        seed = 42 + sc_idx * 101

        # Pre-calcola costi per QUESTA strategia (con amplifier utente)
        # Se prefer_monolinea, amplifico ulteriormente di 1.5×
        eff_amp = vsp_config.strategy_amplifier
        if vsp_config.prefer_monolinea and strat_key in ("monolinea", "balanced"):
            eff_amp = eff_amp * 1.5
        arc_costs_s = precompute_arc_costs(arcs, trips, rates, strategy=strat,
                                           amplifier=eff_amp)
        fixed_costs_s = precompute_fixed_costs(trips, rates, strategy=strat,
                                               amplifier=eff_amp)

        # FIX-1: scegli warm-start
        if sc_idx < n_diverse_ws:
            ws = diverse_ws[sc_idx % len(diverse_ws)]
            ws_type = f"diverse#{sc_idx % len(diverse_ws)}"
        else:
            ws = best_chains
            ws_type = f"best_so_far({best_label})"

        # FIX-3: no-good cuts (solo se abilitati E abbiamo già soluzioni)
        nogood = forbidden_arc_sets if (vsp_config.enable_no_good_cuts and forbidden_arc_sets) else None

        progress_pct = 30 + int(40 * sc_idx / max(1, n_scenarios))
        report_progress("VSP", progress_pct,
                        f"Scenario {sc_idx + 1}/{n_scenarios}: {strat['label']} ({ws_type})")

        # FIX-VSP-2: dispatch a 2-fasi lessicografico vero quando richiesto
        if prio == "lexicographic":
            status, chains, metrics = solve_vsp_lexicographic(
                trips, arcs, arc_costs_s, fixed_costs_s, rates, "ALL",
                time_limit=scenario_budget,
                warmstart_chains=ws,
                intensity=intensity, seed=seed, label=strat_key,
                forbidden_arc_sets=nogood,
                min_arc_diff_pct=vsp_config.min_arc_diff_pct,
                min_arc_diff_abs=vsp_config.min_arc_diff_abs,
            )
        else:
            status, chains, metrics = solve_vsp_cost_based(
                trips, arcs, arc_costs_s, fixed_costs_s, rates, "ALL",
                time_limit=scenario_budget,
                warmstart_chains=ws,
                intensity=intensity, seed=seed, label=strat_key,
                forbidden_arc_sets=nogood,
                min_arc_diff_pct=vsp_config.min_arc_diff_pct,
                min_arc_diff_abs=vsp_config.min_arc_diff_abs,
                vehicle_priority_bonus=veh_prio_bonus,
            )
        if not chains:
            log(f"    Scenario {sc_idx + 1} ({strat_key}) → no solution")
            continue

        # Valutazione con funzione di accettazione (detailed se abilitato)
        cost_fast = sum(chain_cost_fast(c, trips, arcs_lookup, rates) for c in chains)
        cost_accept = sum(chain_cost_accept(c, trips, arcs_lookup, rates, use_detailed_ls)
                          for c in chains)

        improvement = best_detailed_cost - cost_accept
        is_best = cost_accept < best_detailed_cost

        LAST_VSP_SCENARIOS.append({
            "index": sc_idx + 1,
            "strategy": strat_key,
            "strategyLabel": strat["label"],
            "strategyDesc": strat["desc"],
            "seed": seed,
            "warmStartType": ws_type,
            "noGoodCutsApplied": len(nogood) if nogood else 0,
            "vehicles": len(chains),
            "costEur": round(cost_fast, 2),
            "costDetailedEur": round(cost_accept, 2),
            "improvementEur": round(improvement, 2),
            "isBest": is_best,
            "status": status,
            "solveTimeSec": metrics.get("solveTimeSec", 0),
        })

        log(f"    Scenario {sc_idx + 1} ({strat_key}, ws={ws_type}): "
            f"{len(chains)} veh, fast=EUR{cost_fast:.2f}, detailed=EUR{cost_accept:.2f} "
            f"({'+' if improvement > 0 else ''}{improvement:.2f}) "
            f"{'★ NEW BEST' if is_best else ''}")

        # Aggiungi la soluzione corrente al set di "già esplorate"
        forbidden_arc_sets.append(chains_to_arc_set(chains))

        if is_best:
            best_chains = chains
            best_cost = cost_fast
            best_detailed_cost = cost_accept
            best_label = strat_key

    # FIX-5: POLISH con strategia COMPLEMENTARE al best
    polish_improvement = 0.0
    if vsp_config.enable_polish and polish_time > 0:
        if vsp_config.polish_strategy == "auto":
            polish_key = POLISH_COMPLEMENT.get(best_label, "balanced")
        else:
            polish_key = vsp_config.polish_strategy
            if polish_key not in VSP_STRATEGIES:
                polish_key = "balanced"
        polish_strat = VSP_STRATEGIES[polish_key]
        log(f"  [VSP-MULTI] Polish: best={best_label} -> complement={polish_key}")
        report_progress("VSP", 72, f"Polish ({polish_strat['label']}): rifinitura...")

        arc_costs_p = precompute_arc_costs(arcs, trips, rates, strategy=polish_strat,
                                           amplifier=vsp_config.strategy_amplifier)
        fixed_costs_p = precompute_fixed_costs(trips, rates, strategy=polish_strat,
                                               amplifier=vsp_config.strategy_amplifier)
        # FIX-VSP-2: anche il polish in modalità lessicografica
        if prio == "lexicographic":
            p_status, p_chains, p_metrics = solve_vsp_lexicographic(
                trips, arcs, arc_costs_p, fixed_costs_p, rates, "ALL",
                time_limit=polish_time, warmstart_chains=best_chains,
                intensity=intensity, seed=99991, label=f"polish-{polish_key}",
                forbidden_arc_sets=None,
            )
        else:
            p_status, p_chains, p_metrics = solve_vsp_cost_based(
                trips, arcs, arc_costs_p, fixed_costs_p, rates, "ALL",
                time_limit=polish_time, warmstart_chains=best_chains,
                intensity=intensity, seed=99991, label=f"polish-{polish_key}",
                # Polish NON usa no-good cuts: deve poter raffinare il best
                forbidden_arc_sets=None,
                vehicle_priority_bonus=veh_prio_bonus,
            )
        if p_chains:
            polish_cost = sum(chain_cost_accept(c, trips, arcs_lookup, rates, use_detailed_ls)
                              for c in p_chains)
            polish_improvement = best_detailed_cost - polish_cost
            if polish_cost < best_detailed_cost:
                log(f"    Polish migliora: EUR{best_detailed_cost:.2f} → EUR{polish_cost:.2f}")
                best_chains = p_chains
                best_detailed_cost = polish_cost
                best_label = f"polish-{polish_key}"
            LAST_VSP_SCENARIOS.append({
                "index": len(LAST_VSP_SCENARIOS) + 1,
                "strategy": f"polish-{polish_key}",
                "strategyLabel": f"Polish ({polish_strat['label']})",
                "strategyDesc": f"Rifinitura complementare a {best_label}",
                "seed": 99991,
                "warmStartType": f"best({best_label})",
                "noGoodCutsApplied": 0,
                "vehicles": len(p_chains),
                "costEur": round(polish_cost, 2),
                "costDetailedEur": round(polish_cost, 2),
                "improvementEur": round(polish_improvement, 2),
                "isBest": best_label.startswith("polish"),
                "isPolish": True,
                "status": p_status,
                "solveTimeSec": p_metrics.get("solveTimeSec", 0),
            })

    costs_only = [s["costDetailedEur"] for s in LAST_VSP_SCENARIOS if s.get("costDetailedEur", 0) > 0]
    spread = (max(costs_only) - min(costs_only)) if costs_only else 0
    spread_pct = (spread / min(costs_only) * 100) if costs_only and min(costs_only) > 0 else 0

    LAST_VSP_ANALYSIS = {
        "scenariosRun": len([s for s in LAST_VSP_SCENARIOS if not s.get("isPolish")]),
        "totalScenarios": len(LAST_VSP_SCENARIOS),
        "strategiesUsed": sorted(set(s["strategy"] for s in LAST_VSP_SCENARIOS)),
        "bestStrategy": best_label,
        "bestStrategyLabel": VSP_STRATEGIES.get(best_label.replace("polish-", ""),
                                                 {}).get("label", best_label),
        "costSpreadEur": round(spread, 2),
        "costSpreadPct": round(spread_pct, 2),
        "polishImprovementEur": round(polish_improvement, 2) if polish_improvement > 0 else 0,
        "intensity": intensity,
        "totalTimeBudgetSec": total_time_limit,
        "nogoodCutsEnabled": vsp_config.enable_no_good_cuts,
        "warmstartDiversePhase": n_diverse_ws,
        "lsDetailedCost": use_detailed_ls,
        "minVehiclesPriority": vsp_config.min_vehicles_priority,
        "vehiclePriorityBonusEur": round(veh_prio_bonus / COST_SCALE, 2),
    }
    return best_chains, LAST_VSP_ANALYSIS


# ─── MAIN ───────────────────────────────────────────────────────────────

def main():
    t_start = time.time()
    data = load_input()
    config = data.get("config", {})
    forced = config.get("forced", False)

    # Parse cost rates from operator config
    vehicle_costs_cfg = config.get("vehicleCosts", {})
    rates = VehicleCostRates.from_config(vehicle_costs_cfg)

    # FIX-7: parametri utente avanzati
    vsp_config = VSPConfig.from_config(config)

    # Override costi dalla UI (vspAdvanced.costRatesOverride) — se presenti
    # vincono sui vehicleCosts globali. Permette all'utente di "fissare" i
    # parametri dei costi senza toccare la config operatore globale.
    if vsp_config.cost_rates_override:
        rates = VehicleCostRates.from_config({**vehicle_costs_cfg,
                                              **vsp_config.cost_rates_override})
        log(f"  [VSP] Cost rates override applicato: "
            f"{list(vsp_config.cost_rates_override.keys())}")

    # FIX-VSP-1/3/6/8 (wiring): coordinazione strict/lexicographic.
    # Se l'utente ha scelto strict o lexicographic come priorità min-veicoli,
    # attiviamo automaticamente:
    #   - finestra arc-creation più larga (max_idle_for_arc_min ≥ 600 min)
    #     se non già impostata dall'utente
    #   - saturation_mode in local search (no anti-saturation penalties)
    #   - new_vehicle_penalty_eur in greedy (~3× fixed_daily medio)
    if vsp_config.max_idle_for_arc_min is not None:
        rates.max_idle_for_arc_min = vsp_config.max_idle_for_arc_min
    elif vsp_config.min_vehicles_priority in ("strict", "lexicographic"):
        if rates.max_idle_for_arc_min < 600:
            log(f"  [VSP] min_vehicles_priority={vsp_config.min_vehicles_priority} "
                f"→ auto-raise max_idle_for_arc_min "
                f"{rates.max_idle_for_arc_min}→600 min")
            rates.max_idle_for_arc_min = 600

    saturation_mode = vsp_config.min_vehicles_priority in ("strict", "lexicographic")
    avg_fixed_eur = sum(rates.fixed_daily.values()) / max(1, len(rates.fixed_daily))
    new_vehicle_penalty_eur = avg_fixed_eur * 3.0 if saturation_mode else 0.0
    if saturation_mode:
        log(f"  [VSP] saturation_mode=ON (priority={vsp_config.min_vehicles_priority}) "
            f"new_vehicle_penalty=EUR{new_vehicle_penalty_eur:.2f}")

    intensity = vsp_config.intensity

    # Tempi totali
    if vsp_config.total_time_override_sec is not None:
        time_limit = int(vsp_config.total_time_override_sec)
    else:
        time_limit = {"fast": 60, "normal": 180, "deep": 420, "extreme": 900}.get(intensity, 180)

    # Local search budget
    if vsp_config.ls_time_override_sec is not None:
        ls_time = float(vsp_config.ls_time_override_sec)
    else:
        ls_time = {"fast": 8.0, "normal": 25.0, "deep": 60.0, "extreme": 120.0}.get(intensity, 25.0)
    if vsp_config.ls_iter_override is not None:
        ls_iter = int(vsp_config.ls_iter_override)
    else:
        ls_iter = {"fast": 1500, "normal": 5000, "deep": 12000, "extreme": 25000}.get(intensity, 5000)

    route_names: dict[str, str] = {}
    for rd in data.get("routeDetails", []):
        route_names[rd["routeId"]] = rd.get("routeName", rd["routeId"])

    trips_data = data.get("trips", [])
    if not trips_data:
        log("No trips provided")
        write_output({"vehicleShifts": [], "metrics": _empty_metrics(),
                       "costBreakdown": {"perShift": [], "aggregated": {}, "numVehicles": 0}})
        return

    trips: list[Trip] = [trip_from_dict(td, i) for i, td in enumerate(trips_data)]
    trips.sort(key=lambda t: (t.departure_min, t.arrival_min))
    for i, t in enumerate(trips):
        t.idx = i
    n = len(trips)

    log(f"=== CP-SAT Vehicle Scheduler v3 (Maior-inspired, diversity-aware) ===")
    log(f"  Trips: {n}, intensity: {intensity}, forced: {forced}")
    log(f"  {vsp_config.summary()}")
    report_progress("VSP", 5, f"Loaded {n} trips")

    # Build arcs
    report_progress("VSP", 10, "Building compatibility arcs...")
    arcs = build_compatible_arcs_fast(trips, rates)
    arcs_lookup: dict[tuple[int, int], Arc] = {(a.i, a.j): a for a in arcs}
    log(f"  Arcs: {len(arcs)}")
    report_progress("VSP", 15, f"Built {len(arcs)} arcs")

    # Greedy warmstart (solo baseline - le varianti diversificate sono generate dopo)
    report_progress("VSP", 20, "Greedy warmstart...")
    greedy_chains = greedy_warmstart(
        trips, arcs, arcs_lookup, rates,
        new_vehicle_penalty_eur=new_vehicle_penalty_eur,
    )
    greedy_cost_total = sum(chain_cost_fast(c, trips, arcs_lookup, rates) for c in greedy_chains)
    log(f"  Greedy baseline: {len(greedy_chains)} vehicles, EUR{greedy_cost_total:.2f}")
    report_progress("VSP", 25, f"Greedy: {len(greedy_chains)} vehicles")

    # CP-SAT MULTI-SCENARIO PORTFOLIO con fix 1/3/5
    report_progress("VSP", 30, "Avvio portfolio multi-scenario...")
    cpsat_chains, vsp_analysis = optimize_vsp_multi_scenario(
        trips, arcs, arcs_lookup, rates, time_limit, greedy_chains, vsp_config,
        new_vehicle_penalty_eur=new_vehicle_penalty_eur,
    )
    report_progress("VSP", 70,
                    f"CP-SAT: {len(cpsat_chains)} vehicles · {vsp_analysis['scenariosRun']} scenari")

    if not cpsat_chains:
        cpsat_chains = greedy_chains
        log("  Fallback to greedy solution")

    # FIX-4: Local search con cost function coerente
    report_progress("VSP", 75, "Local search optimization...")
    improved_chains = advanced_local_search(
        cpsat_chains, trips, arcs_lookup, rates,
        max_iter=ls_iter, max_time_sec=ls_time,
        use_detailed_cost=vsp_config.ls_use_detailed_cost,
        no_improve_limit=vsp_config.ls_no_improve_limit,
        saturation_mode=saturation_mode,
    )
    report_progress("VSP", 88, f"Post-LS: {len(improved_chains)} vehicles")

    # ── REGOLA #1 hard: post-pass eliminazione veicoli ──
    # Tenta di rimuovere veicoli ridistribuendo le loro corse su altri.
    # Eseguito DOPO la local search perché necessita di una soluzione stabile.
    elim_stats: dict = {}
    if vsp_config.enable_vehicle_elimination:
        report_progress("VSP", 90, "Eliminazione veicoli ridondanti...")
        # FIX-VSP-RUIN: budget alto di default (45s o tutto il ls_time).
        # L'utente preferisce attendere piuttosto che vedere turni in eccesso.
        if vsp_config.vehicle_elimination_time_sec is not None:
            elim_budget = float(vsp_config.vehicle_elimination_time_sec)
        else:
            elim_budget = max(45.0, ls_time)
        improved_chains, elim_stats = vehicle_elimination_pass(
            improved_chains, trips, arcs_lookup, rates,
            max_passes=vsp_config.vehicle_elimination_max_passes,
            time_budget_sec=elim_budget,
        )
        # Ulteriore LS rapido per pulire archi sub-ottimali post-eliminazione
        if elim_stats.get("vehiclesEliminated", 0) > 0:
            report_progress("VSP", 92, "Re-local search dopo eliminazione...")
            improved_chains = advanced_local_search(
                improved_chains, trips, arcs_lookup, rates,
                max_iter=max(500, ls_iter // 4),
                max_time_sec=max(5.0, ls_time / 4),
                use_detailed_cost=vsp_config.ls_use_detailed_cost,
                no_improve_limit=200,
                saturation_mode=saturation_mode,
            )
    report_progress("VSP", 93, f"Finale: {len(improved_chains)} vehicles")

    # ── REGOLA #1 ULTRA-HARD: Iterative Vehicle Reduction ──
    # Forza CP-SAT a cercare soluzioni con #veicoli SEMPRE PIÙ BASSO finché
    # dimostra infeasibility. È la mossa "valuta ogni combinazione" che
    # l'utente vuole — costoso ma può dimostrare matematicamente il minimo.
    iter_red_stats: dict = {}
    if vsp_config.enable_iterative_reduction and len(improved_chains) > 1:
        report_progress("VSP", 94, "Riduzione iterativa: forza il limite...")
        # Usa strategia "balanced" come tie-breaker
        ir_strat = VSP_STRATEGIES["balanced"]
        ir_arc_costs = precompute_arc_costs(arcs, trips, rates, strategy=ir_strat,
                                             amplifier=vsp_config.strategy_amplifier)
        ir_fixed_costs = precompute_fixed_costs(trips, rates, strategy=ir_strat,
                                                 amplifier=vsp_config.strategy_amplifier)
        improved_chains, iter_red_stats = iterative_vehicle_reduction(
            improved_chains, trips, arcs, ir_arc_costs, ir_fixed_costs,
            time_budget_sec=vsp_config.iterative_reduction_time_sec,
            intensity=intensity, seed=4242,
        )
        if iter_red_stats.get("vehiclesEliminated", 0) > 0:
            report_progress("VSP", 96, "Re-LS dopo riduzione iterativa...")
            improved_chains = advanced_local_search(
                improved_chains, trips, arcs_lookup, rates,
                max_iter=max(500, ls_iter // 4),
                max_time_sec=max(5.0, ls_time / 4),
                use_detailed_cost=vsp_config.ls_use_detailed_cost,
                no_improve_limit=200,
                saturation_mode=saturation_mode,
            )
    report_progress("VSP", 97, f"Pipeline finale: {len(improved_chains)} vehicles")

    # Convert to VehicleShift objects
    shifts = chains_to_shifts(improved_chains, trips, arcs_lookup, rates, route_names)

    # Cost breakdown
    cost_breakdown = compute_shift_costs(improved_chains, trips, arcs_lookup, rates)
    final_cost = cost_breakdown["aggregated"].get("total", 0)

    # Greedy comparison
    greedy_breakdown = compute_shift_costs(greedy_chains, trips, arcs_lookup, rates)
    greedy_total = greedy_breakdown["aggregated"].get("total", 0)
    savings = greedy_total - final_cost
    savings_pct = (savings / greedy_total * 100) if greedy_total > 0 else 0

    elapsed_total = time.time() - t_start
    log(f"\n=== RESULTS ===")
    log(f"  Vehicles: {len(improved_chains)} (greedy was {len(greedy_chains)})")
    log(f"  Cost: EUR{final_cost:.2f} (greedy EUR{greedy_total:.2f})")
    log(f"  Savings: EUR{savings:.2f} ({savings_pct:.1f}%)")
    log(f"  Scenario spread: EUR{vsp_analysis.get('costSpreadEur', 0):.2f} "
        f"({vsp_analysis.get('costSpreadPct', 0):.1f}%)")
    log(f"  Total time: {elapsed_total:.1f}s / {time_limit}s budget")

    # Metrics
    total_dh_km = sum(s.total_deadhead_km for s in shifts)
    total_dh_min = sum(s.total_deadhead_min for s in shifts)
    total_service_min = sum(s.total_service_min for s in shifts)
    metrics = {
        "vehicles": len(shifts),
        "totalTrips": n,
        "totalServiceKm": round(sum(_estimate_trip_km(trips[i], rates)
                                    for c in improved_chains for i in c), 1),
        "totalDeadheadKm": round(total_dh_km, 1),
        "totalDeadheadMin": round(total_dh_min, 0),
        "totalServiceMin": total_service_min,
        "status": "MULTI_SCENARIO_V3",
        "solveTimeSec": round(elapsed_total, 1),
        "costEur": round(final_cost, 2),
        "greedyVehicles": len(greedy_chains),
        "greedyCostEur": round(greedy_total, 2),
        "savingsEur": round(savings, 2),
        "savingsPct": round(savings_pct, 1),
        "intensity": intensity,
        "scenariosRun": vsp_analysis.get("scenariosRun", 0),
        "bestStrategy": vsp_analysis.get("bestStrategyLabel", "balanced"),
        "costSpreadPct": vsp_analysis.get("costSpreadPct", 0),
    }

    report_progress("VSP", 95, "Writing output...")
    output = {
        "vehicleShifts": [vehicle_shift_to_dict(s) for s in shifts],
        "metrics": metrics,
        "costBreakdown": cost_breakdown,
        "optimizationAnalysis": vsp_analysis,
        "scenarioRanking": LAST_VSP_SCENARIOS,
        "vehicleEliminationStats": elim_stats,
        "vspConfigApplied": {
            "intensity": vsp_config.intensity,
            "strategies": vsp_config.strategies_enabled,
            "nogoodCuts": vsp_config.enable_no_good_cuts,
            "minArcDiffPct": vsp_config.min_arc_diff_pct,
            "warmstartSplit": vsp_config.warmstart_split,
            "polishEnabled": vsp_config.enable_polish,
            "polishStrategy": vsp_config.polish_strategy,
            "lsDetailedCost": vsp_config.ls_use_detailed_cost,
            "strategyAmplifier": vsp_config.strategy_amplifier,
            "minVehiclesPriority": vsp_config.min_vehicles_priority,
            "costRatesOverride": vsp_config.cost_rates_override,
            "preferMonolinea": vsp_config.prefer_monolinea,
            "vehicleEliminationEnabled": vsp_config.enable_vehicle_elimination,
            "iterativeReductionEnabled": vsp_config.enable_iterative_reduction,
            "iterativeReductionStats": iter_red_stats,
        },
        "greedyComparison": {
            "vehicles": len(greedy_chains),
            "costBreakdown": greedy_breakdown,
        },
    }
    write_output(output)
    report_progress("VSP", 100, f"Done: {len(shifts)} vehicles, EUR{final_cost:.2f}")


if __name__ == "__main__":
    main()