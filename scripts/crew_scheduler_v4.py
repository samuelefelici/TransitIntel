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
import math
import signal
import threading
from dataclasses import dataclass, field
from typing import Any

from ortools.sat.python import cp_model

from optimizer_common import (
    # Costanti
    SHIFT_RULES, PRE_TURNO_MIN, PRE_TURNO_AUTO_MIN, MAX_IDLE_AT_TERMINAL, UNATTENDED_BUS_MAX,
    DEPOT_TRANSFER_CENTRAL, DEPOT_TRANSFER_OUTER,
    MAX_CONTINUOUS_DRIVING, MIN_BREAK_AFTER_DRIVING,
    TARGET_WORK_LOW, TARGET_WORK_HIGH, TARGET_WORK_MID,
    COMPANY_CARS,
    # Dataclass esistenti
    VShiftTrip, VehicleShift, CambioInfo, ClusterStop,
    VehicleBlock, CutCandidate, Segment, DriverDutyV3,
    Cluster, DEFAULT_CLUSTERS, DEFAULT_OPERATOR_CONFIG,
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

# Saturazione SOFT: un single sotto MIN_WORK_PER_DUTY (che avrebbe un pair
# possibile) costa questa penalità virtuale invece di essere VIETATO. Il
# divieto rendeva il modello infeasible appena i pezzi erano corti (copertura
# perfetta a coppie inesistente) e tutto finiva nel greedy: 24 turni invece
# di 17 sull'istanza di prova. Letto da config.bds.optimizer.saturationPenalty
# (0 = nessuna penalità).
SATURATION_PENALTY = 10000

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

# Fattori derivati dai pesi operatore (config.weights: gli stessi 6 slider
# 0-10 del pannello TG e di crewConfig.weights). 1.0 al peso di default →
# comportamento storico invariato finché l'operatore non tocca gli slider.
# Applicati AL PUNTO D'USO (mai mutando le altre globali) e ricalcolati da
# zero a ogni run(): nessun compounding fra i round del VCSP.
WEIGHT_FACTORS = {
    "duty": 1.0,       # minDrivers     → costo virtuale per turno + score portfolio
    "balance": 1.0,    # workBalance    → deviazione dal target di lavoro
    "suppl": 1.0,      # minSupplementi → costo dei supplementi
    "spezz": 1.0,      # preferIntero   → moltiplicatore degli spezzati
    "transfer": 1.0,   # minCambi       → costo trasferimenti/auto aziendali
    "quality": 1.0,    # qualityTarget  → penalità idle (turni compatti)
}

_WEIGHT_FACTOR_MAP = [
    ("minDrivers", "duty"),
    ("workBalance", "balance"),
    ("minSupplementi", "suppl"),
    ("preferIntero", "spezz"),
    ("minCambi", "transfer"),
    ("qualityTarget", "quality"),
]


def apply_operator_weights(cfg: dict) -> None:
    """Traduce config.weights in fattori sui costi del v4.

    Prima di questo hook i pesi erano letti SOLO dal vecchio motore cpsat:
    nel v4 gli slider del pannello operatore (e crewWeights via agente)
    erano una manopola morta. Il fattore è peso/default, clampato a
    [0.15, 3.0]: un peso a 0 indebolisce una spinta senza azzerare un costo
    reale (es. supplementi gratis)."""
    weights = (cfg or {}).get("weights") or {}
    neutrals = DEFAULT_OPERATOR_CONFIG["weights"]
    for ui_key, f_key in _WEIGHT_FACTOR_MAP:
        neutral = float(neutrals[ui_key])
        try:
            w = max(0.0, min(10.0, float(weights.get(ui_key, neutral))))
        except (ValueError, TypeError):
            w = neutral
        ratio = w / neutral
        if f_key == "spezz":
            # preferIntero: le strategie del portfolio SCONTANO gli spezzati
            # (fino a ×0,5); un fattore lineare (max 1,43) non basta a farli
            # perdere. Quadratico: 10 → ×2,04, 3 → ×0,18.
            ratio = ratio * ratio
        WEIGHT_FACTORS[f_key] = max(0.15, min(3.0, ratio))
    if weights:
        log("[V4] Pesi operatore → fattori: " + ", ".join(
            f"{k}={v:.2f}" for k, v in sorted(WEIGHT_FACTORS.items())))


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
    global SCORE_PER_DUTY, SATURATION_PENALTY

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
    SATURATION_PENALTY   = max(0, _set_int("saturationPenalty", SATURATION_PENALTY))

    log(f"[V4] Optimizer overrides: minWork={MIN_WORK_PER_DUTY}min, "
        f"maxCompanyCars={MAX_COMPANY_CARS}, "
        f"wDuty={WEIGHT_DUTY_COUNT}, wIdle={WEIGHT_IDLE_PENALTY} (cap {IDLE_PENALTY_MAX_MIN}min), "
        f"scorePerDuty={SCORE_PER_DUTY}")


def apply_fase2_overrides(cfg: dict) -> None:
    """Override parametri AVANZATI (Fase 2): soglie taglio, scoring tagli,
    penalità cap %, frazioni di tempo multi-scenario. Globali mutate IN-PLACE.

    Schema atteso:
      config.bds.cuts = {drivingBassoThreshold, minCutGap, collassaMinGap}
      config.bds.cutScoring = {gapBase, gapBonusPerMin, clusterBonus,
        noClusterPenalty, capolineaBonus, balanceMax, nastroPenaltyPerMin, sameRoutePenalty}
      config.bds.optimizer.pctOverPenalty
      config.bds.scenari = {timeFraction, polishFraction}   # count gestito a runtime

    NB: solo costanti effettivamente lette a runtime dal v4 (verificate).
    """
    global DRIVING_BASSO_THRESHOLD, MIN_CUT_GAP, COLLASSA_MIN_GAP
    global CUT_SCORE_GAP_BASE, CUT_SCORE_GAP_BONUS_PER_MIN, CUT_SCORE_CLUSTER_BONUS
    global CUT_NO_CLUSTER_PENALTY, CUT_SCORE_CAPOLINEA_BONUS, CUT_SCORE_BALANCE_MAX
    global CUT_NASTRO_PENALTY_PER_MIN, CUT_SAME_ROUTE_PENALTY
    global PCT_OVER_PENALTY
    global SCENARIO_TIME_FRACTION, POLISH_TIME_FRACTION
    global PAIR_AWARE_CUTS, PAIR_PIECE_TARGET_MIN, PAIR_MAX_PIECES, PAIR_EXTRA_TARGETS

    bds = cfg.get("bds", {}) if cfg else {}

    def _num(d: dict, key: str, cur, typ):
        if key in d:
            try:
                return typ(d[key])
            except (ValueError, TypeError):
                return cur
        return cur

    cuts = bds.get("cuts") or {}
    DRIVING_BASSO_THRESHOLD = _num(cuts, "drivingBassoThreshold", DRIVING_BASSO_THRESHOLD, int)
    MIN_CUT_GAP             = _num(cuts, "minCutGap", MIN_CUT_GAP, int)
    COLLASSA_MIN_GAP        = _num(cuts, "collassaMinGap", COLLASSA_MIN_GAP, int)
    if "pairAware" in cuts:
        PAIR_AWARE_CUTS = cuts["pairAware"] in (True, 1, "1", "true", "True", "on")
    PAIR_PIECE_TARGET_MIN   = max(0, _num(cuts, "pairPieceTargetMin", PAIR_PIECE_TARGET_MIN, int))
    PAIR_MAX_PIECES         = max(2, min(8, _num(cuts, "pairMaxPieces", PAIR_MAX_PIECES, int)))
    if isinstance(cuts.get("pairExtraTargets"), list):
        PAIR_EXTRA_TARGETS = tuple(int(x) for x in cuts["pairExtraTargets"]
                                   if str(x).lstrip("-").isdigit() and 120 <= int(x) <= 400)

    cs = bds.get("cutScoring") or {}
    CUT_SCORE_GAP_BASE          = _num(cs, "gapBase", CUT_SCORE_GAP_BASE, float)
    CUT_SCORE_GAP_BONUS_PER_MIN = _num(cs, "gapBonusPerMin", CUT_SCORE_GAP_BONUS_PER_MIN, float)
    CUT_SCORE_CLUSTER_BONUS     = _num(cs, "clusterBonus", CUT_SCORE_CLUSTER_BONUS, float)
    CUT_NO_CLUSTER_PENALTY      = _num(cs, "noClusterPenalty", CUT_NO_CLUSTER_PENALTY, float)
    CUT_SCORE_CAPOLINEA_BONUS   = _num(cs, "capolineaBonus", CUT_SCORE_CAPOLINEA_BONUS, float)
    CUT_SCORE_BALANCE_MAX       = _num(cs, "balanceMax", CUT_SCORE_BALANCE_MAX, float)
    CUT_NASTRO_PENALTY_PER_MIN  = _num(cs, "nastroPenaltyPerMin", CUT_NASTRO_PENALTY_PER_MIN, float)
    CUT_SAME_ROUTE_PENALTY      = _num(cs, "sameRoutePenalty", CUT_SAME_ROUTE_PENALTY, float)

    opt = bds.get("optimizer") or {}
    PCT_OVER_PENALTY = _num(opt, "pctOverPenalty", PCT_OVER_PENALTY, int)
    global PCT_CAP_HARD, PCT_CAP_TOLERANCE_SHIFTS
    if "pctCapHard" in opt:
        PCT_CAP_HARD = opt["pctCapHard"] in (True, 1, "1", "true", "True", "on")
    PCT_CAP_TOLERANCE_SHIFTS = max(0.0, min(0.99, _num(opt, "pctCapToleranceShifts", PCT_CAP_TOLERANCE_SHIFTS, float)))
    LAST_PCT_CAP.update({"hard": PCT_CAP_HARD, "toleranceShifts": PCT_CAP_TOLERANCE_SHIFTS, "relaxed": False, "carCapRelaxed": False})
    global CAR_CAP_HARD
    if "carCapHard" in opt:
        CAR_CAP_HARD = opt["carCapHard"] in (True, 1, "1", "true", "True", "on")

    scen = bds.get("scenari") or {}
    SCENARIO_TIME_FRACTION = _num(scen, "timeFraction", SCENARIO_TIME_FRACTION, float)
    POLISH_TIME_FRACTION   = _num(scen, "polishFraction", POLISH_TIME_FRACTION, float)

    if cuts or cs or opt.get("pctOverPenalty") is not None or scen:
        log(f"[V4] Fase2 overrides: minCutGap={MIN_CUT_GAP}, collassa={COLLASSA_MIN_GAP}, "
            f"clusterBonus={CUT_SCORE_CLUSTER_BONUS}, noCluster={CUT_NO_CLUSTER_PENALTY}, "
            f"pctOverPenalty={PCT_OVER_PENALTY}, scenTimeFrac={SCENARIO_TIME_FRACTION}")


_TIPOLOGIE_VALIDE = {"intero", "semiunico", "spezzato", "supplemento"}
_MISURE_VALIDE = {"lavoro", "nastro", "guida"}


def apply_vincoli_globali_config(cfg: dict) -> None:
    """Parsa config.bds.vincoliGlobali (BDSI cap. 14) nel global VINCOLI_GLOBALI.
    Voci malformate vengono scartate (mai un errore fatale)."""
    global VINCOLI_GLOBALI
    VINCOLI_GLOBALI = []
    raw = ((cfg or {}).get("bds", {}) or {}).get("vincoliGlobali")
    if not isinstance(raw, list):
        return

    def _opt_num(d, key):
        v = d.get(key)
        if v is None or v == "":
            return None
        try:
            return max(0, int(v))
        except (TypeError, ValueError):
            return None

    for v in raw[:20]:  # cap difensivo
        if not isinstance(v, dict):
            continue
        tipo = v.get("tipo")
        tipologie = [t for t in (v.get("tipologie") or []) if t in _TIPOLOGIE_VALIDE]
        if not tipologie:
            continue
        parsed: dict | None = None
        if tipo == "numerico":
            mn, mx = _opt_num(v, "min"), _opt_num(v, "max")
            if mn is None and mx is None:
                continue
            parsed = {"tipo": "numerico", "tipologie": tipologie, "min": mn, "max": mx,
                      "perResidenza": bool(v.get("perResidenza"))}
        elif tipo == "percentuale":
            mn, mx = _opt_num(v, "minPct"), _opt_num(v, "maxPct")
            if mn is None and mx is None:
                continue
            parsed = {"tipo": "percentuale", "tipologie": tipologie,
                      "minPct": mn, "maxPct": mx,
                      "perResidenza": bool(v.get("perResidenza"))}
        elif tipo == "media":
            misura = v.get("misura")
            if misura not in _MISURE_VALIDE:
                continue
            mn, mx = _opt_num(v, "minMin"), _opt_num(v, "maxMin")
            if mn is None and mx is None:
                continue
            parsed = {"tipo": "media", "tipologie": tipologie, "misura": misura,
                      "minMin": mn, "maxMin": mx}
        if parsed is not None:
            if v.get("label"):
                parsed["label"] = str(v["label"])[:80]
            VINCOLI_GLOBALI.append(parsed)

    if VINCOLI_GLOBALI:
        log(f"[V4][VINCOLI] {len(VINCOLI_GLOBALI)} vincoli globali attivi: "
            + "; ".join(_vincolo_label(v) for v in VINCOLI_GLOBALI))


# ----------------------------------------------------------------
# Costi avanzati BDS5 (Manuale configurazione algoritmo, cap. 3-4)
# ----------------------------------------------------------------
# config.bds.costiAvanzati = {
#   scalini: [{attributo: "nastro"|"lavoro"|"guida",
#              scalini: [{da: minuti, costo: eur}], tipologie?: [...]}],
#   quadratici: [{attributo: "nastro"|"lavoro"|"guida"|"durataRiprese"|
#                             "equilibrioRiprese"|"stacco",
#                 riferimento: min, termineNoto?: eur, lineare?: eur/min,
#                 quadratico?: eur/min², fasciaControllo?: min, tipologie?}],
#   cambioVettura: {coeffDeposito, coeffLinea, coeffDepLinea},   # eur/cambio
#   cambioPatente: {costo: eur, gruppo1: [tipi], gruppo2: [tipi]},
# }
# config.bds.cuts (estensioni): sosteSpezzantiMin, fasceSenzaCambi
# [{startMin,endMin}], lungPezziMin, lungPezziMinExtra
BDS5_COSTS: dict = {}
BDS5_FASCE_SENZA_CAMBI: list[tuple[int, int]] = []
BDS5_SOSTE_SPEZZANTI_MIN = 0      # 0 = off
BDS5_LUNG_PEZZI_MIN = 0           # lunghezza minima pezzi urbani (0 = off)
BDS5_LUNG_PEZZI_MIN_EXTRA = 0     # lunghezza minima pezzi extraurbani (0 = off)
FASCIA_SENZA_CAMBI_PENALTY = 100.0  # "preferenzialmente non ammessi" (BDS5 fascia_oraria)

_BDS5_ATTR_SCALARI = {"nastro", "lavoro", "guida"}
_BDS5_ATTR_LISTE = {"durataRiprese", "equilibrioRiprese", "stacco"}


def apply_bds5_config(cfg: dict) -> None:
    """Parsa config.bds.costiAvanzati + estensioni cuts BDS5 nei global."""
    global BDS5_COSTS, BDS5_FASCE_SENZA_CAMBI, BDS5_SOSTE_SPEZZANTI_MIN
    global BDS5_LUNG_PEZZI_MIN, BDS5_LUNG_PEZZI_MIN_EXTRA
    BDS5_COSTS = {}
    BDS5_FASCE_SENZA_CAMBI = []
    BDS5_SOSTE_SPEZZANTI_MIN = 0
    BDS5_LUNG_PEZZI_MIN = 0
    BDS5_LUNG_PEZZI_MIN_EXTRA = 0

    bds_cfg = (cfg or {}).get("bds", {}) or {}
    ca = bds_cfg.get("costiAvanzati") or {}

    def _fnum(v, default=0.0):
        try:
            return float(v)
        except (TypeError, ValueError):
            return default

    scalini = []
    for s in (ca.get("scalini") or [])[:10]:
        if not isinstance(s, dict) or s.get("attributo") not in _BDS5_ATTR_SCALARI:
            continue
        steps = sorted(
            [(int(_fnum(x.get("da"), -1)), _fnum(x.get("costo")))
             for x in (s.get("scalini") or []) if isinstance(x, dict) and x.get("da") is not None],
            key=lambda t: t[0])
        steps = [(da, c) for da, c in steps if da >= 0]
        if steps:
            scalini.append({"attributo": s["attributo"], "steps": steps,
                            "tipologie": set(s.get("tipologie") or []) or None})
    if scalini:
        BDS5_COSTS["scalini"] = scalini

    quadratici = []
    for q in (ca.get("quadratici") or [])[:10]:
        if not isinstance(q, dict):
            continue
        attr = q.get("attributo")
        if attr not in _BDS5_ATTR_SCALARI | _BDS5_ATTR_LISTE:
            continue
        quadratici.append({
            "attributo": attr,
            "riferimento": int(_fnum(q.get("riferimento"), 0)),
            "termineNoto": _fnum(q.get("termineNoto")),
            "lineare": _fnum(q.get("lineare")),
            "quadratico": _fnum(q.get("quadratico")),
            "fasciaControllo": int(_fnum(q.get("fasciaControllo"), 0)),
            "tipologie": set(q.get("tipologie") or []) or None,
        })
    if quadratici:
        BDS5_COSTS["quadratici"] = quadratici

    cv = ca.get("cambioVettura")
    if isinstance(cv, dict) and any(_fnum(cv.get(k)) for k in ("coeffDeposito", "coeffLinea", "coeffDepLinea")):
        BDS5_COSTS["cambioVettura"] = {
            "coeffDeposito": _fnum(cv.get("coeffDeposito")),
            "coeffLinea": _fnum(cv.get("coeffLinea")),
            "coeffDepLinea": _fnum(cv.get("coeffDepLinea")),
        }

    cp = ca.get("cambioPatente")
    if (isinstance(cp, dict) and _fnum(cp.get("costo")) > 0
            and cp.get("gruppo1") and cp.get("gruppo2")):
        BDS5_COSTS["cambioPatente"] = {
            "costo": _fnum(cp.get("costo")),
            "gruppo1": set(map(str, cp["gruppo1"])),
            "gruppo2": set(map(str, cp["gruppo2"])),
        }

    cuts = bds_cfg.get("cuts") or {}
    try:
        BDS5_SOSTE_SPEZZANTI_MIN = max(0, int(cuts.get("sosteSpezzantiMin") or 0))
    except (TypeError, ValueError):
        pass
    for f in (cuts.get("fasceSenzaCambi") or [])[:8]:
        try:
            a, b = int(f.get("startMin")), int(f.get("endMin"))
            if 0 <= a < b:
                BDS5_FASCE_SENZA_CAMBI.append((a, b))
        except (TypeError, ValueError, AttributeError):
            continue
    try:
        BDS5_LUNG_PEZZI_MIN = max(0, int(cuts.get("lungPezziMin") or 0))
        BDS5_LUNG_PEZZI_MIN_EXTRA = max(0, int(cuts.get("lungPezziMinExtra") or 0))
    except (TypeError, ValueError):
        pass

    active = list(BDS5_COSTS.keys())
    if BDS5_SOSTE_SPEZZANTI_MIN:
        active.append(f"sosteSpezzanti≥{BDS5_SOSTE_SPEZZANTI_MIN}'")
    if BDS5_FASCE_SENZA_CAMBI:
        active.append(f"fasceSenzaCambi×{len(BDS5_FASCE_SENZA_CAMBI)}")
    if BDS5_LUNG_PEZZI_MIN or BDS5_LUNG_PEZZI_MIN_EXTRA:
        active.append(f"lungPezzi≥{BDS5_LUNG_PEZZI_MIN}/{BDS5_LUNG_PEZZI_MIN_EXTRA}'")
    if active:
        log(f"[V4][BDS5] attivi: {', '.join(active)}")


def bds5_active() -> bool:
    return bool(BDS5_COSTS)


def bds5_duty_cost(
    duty_type: str,
    nastro: int,
    work: int,
    driving: int,
    riprese_durations: list[int],
    stacchi: list[int],
    cambi: dict[str, int] | None = None,
    vehicle_types: set[str] | None = None,
) -> float:
    """Costo BDS5 (eur) di un turno candidato. Usato IDENTICO nel modello
    CP-SAT (single/pair a build-time) e nel costo dettagliato all'estrazione."""
    if not BDS5_COSTS:
        return 0.0
    cost = 0.0
    scalar = {"nastro": nastro, "lavoro": work, "guida": driving}

    for s in BDS5_COSTS.get("scalini", []):
        if s["tipologie"] and duty_type not in s["tipologie"]:
            continue
        v = scalar[s["attributo"]]
        applicabile = None
        for da, c in s["steps"]:
            if v >= da:
                applicabile = c
            else:
                break
        if applicabile is not None:
            cost += applicabile

    for q in BDS5_COSTS.get("quadratici", []):
        if q["tipologie"] and duty_type not in q["tipologie"]:
            continue
        attr = q["attributo"]
        if attr in _BDS5_ATTR_SCALARI:
            values = [scalar[attr]]
        elif attr == "durataRiprese":
            values = riprese_durations
        elif attr == "stacco":
            values = stacchi
        else:  # equilibrioRiprese: somma scarti dalla media
            if len(riprese_durations) >= 2:
                media = sum(riprese_durations) / len(riprese_durations)
                values = [int(sum(abs(d - media) for d in riprese_durations))]
            else:
                values = []
        for v in values:
            if q["fasciaControllo"] and v < q["fasciaControllo"]:
                continue
            d = v - q["riferimento"]
            if d > 0:
                cost += q["termineNoto"] + d * q["lineare"] + d * d * q["quadratico"]

    cv = BDS5_COSTS.get("cambioVettura")
    if cv and cambi:
        cost += (cv["coeffDeposito"] * cambi.get("deposito", 0)
                 + cv["coeffLinea"] * cambi.get("linea", 0)
                 + cv["coeffDepLinea"] * cambi.get("depLinea", 0))

    cp = BDS5_COSTS.get("cambioPatente")
    if cp and vehicle_types:
        if vehicle_types & cp["gruppo1"] and vehicle_types & cp["gruppo2"]:
            cost += cp["costo"]

    return cost


def _bds5_cambi_from_segments(segments: list) -> dict[str, int]:
    """Conta i cambi di vettura tra segmenti consecutivi, per località:
    in linea se il cambio avviene a un cluster (punto di cambio in linea),
    deposito↔linea altrimenti (il conducente rientra/riparte dal deposito)."""
    cambi = {"deposito": 0, "linea": 0, "depLinea": 0}
    for a, b in zip(segments, segments[1:]):
        if a.vehicle_id == b.vehicle_id:
            continue
        if a.last_cluster and b.first_cluster:
            cambi["linea"] += 1
        else:
            cambi["depLinea"] += 1
    return cambi


def split_blocks_at_soste(blocks: list["VehicleBlock"], clusters: list) -> tuple[list["VehicleBlock"], int]:
    """BDS5 soste_spezzanti: ogni sosta ≥ soglia nel turno macchina diventa
    un confine OBBLIGATORIO — il blocco viene pre-spezzato in sotto-blocchi,
    così nessun pezzo può scavalcare la sosta."""
    if BDS5_SOSTE_SPEZZANTI_MIN <= 0:
        return blocks, 0
    out: list[VehicleBlock] = []
    splits = 0
    for b in blocks:
        groups: list[list] = [[]]
        for i, t in enumerate(b.trips):
            if groups[-1]:
                gap = t.departure_min - groups[-1][-1].arrival_min
                if gap >= BDS5_SOSTE_SPEZZANTI_MIN:
                    groups.append([])
                    splits += 1
            groups[-1].append(t)
        if len(groups) == 1:
            out.append(b)
            continue
        for gi, g in enumerate(groups):
            driving = sum(t.arrival_min - t.departure_min for t in g)
            # Bordi: la prima parte eredita l'uscita dal deposito, l'ultima il
            # rientro; a un rientro in deposito a metà blocco entrambe le parti
            # hanno il loro bordo (il bus ci va davvero).
            p_out = b.pullout_min if gi == 0 else 0
            p_in = b.pullin_min if gi == len(groups) - 1 else 0
            if gi > 0:
                lg = block_leg_between(b, groups[gi - 1][-1], g[0])
                if lg is not None and lg.type == "depot":
                    p_out = max(0, g[0].departure_min - lg.arrival_min)
            if gi < len(groups) - 1:
                lg = block_leg_between(b, g[-1], groups[gi + 1][0])
                if lg is not None and lg.type == "depot":
                    p_in = max(0, lg.departure_min - g[-1].arrival_min)
            out.append(VehicleBlock(
                vehicle_id=b.vehicle_id,
                vehicle_type=b.vehicle_type,
                category=b.category,
                trips=g,
                start_min=g[0].departure_min,
                end_min=g[-1].arrival_min,
                nastro_min=g[-1].arrival_min - g[0].departure_min,
                driving_min=driving,
                work_min=g[-1].arrival_min - g[0].departure_min,
                classification=b.classification,
                pullout_min=p_out,
                pullin_min=p_in,
                legs=list(b.legs),
            ))
    if splits:
        log(f"[V4][BDS5] soste spezzanti ≥{BDS5_SOSTE_SPEZZANTI_MIN}': "
            f"{splits} tagli obbligatori, {len(blocks)} → {len(out)} blocchi")
    return out, splits


def _bds5_in_fascia_senza_cambi(cut_min: int) -> bool:
    return any(a <= cut_min <= b for a, b in BDS5_FASCE_SENZA_CAMBI)


def _vincolo_label(v: dict) -> str:
    if v.get("label"):
        return v["label"]
    tip = "+".join(v["tipologie"])
    if v["tipo"] == "numerico":
        return f"n({tip}) in [{v.get('min') if v.get('min') is not None else '-'}"\
               f", {v.get('max') if v.get('max') is not None else '-'}]" \
               + (" per residenza" if v.get("perResidenza") else "")
    if v["tipo"] == "percentuale":
        return f"%({tip}) in [{v.get('minPct') if v.get('minPct') is not None else '-'}"\
               f", {v.get('maxPct') if v.get('maxPct') is not None else '-'}]" \
               + (" per residenza" if v.get("perResidenza") else "")
    return f"media {v.get('misura')}({tip}) in "\
           f"[{v.get('minMin') if v.get('minMin') is not None else '-'}"\
           f", {v.get('maxMin') if v.get('maxMin') is not None else '-'}] min"


def _duty_residenza_id(duty: "DriverDutyV3") -> str | None:
    if not duty.segments:
        return None
    res = RESIDENZA_BY_VEHICLE.get(duty.segments[0].vehicle_id)
    return res.get("id") if res else None


def evaluate_vincoli_globali(duties: list["DriverDutyV3"]) -> list[dict] | None:
    """Valuta i vincoli globali sulla soluzione FINALE → report per i metrics."""
    if not VINCOLI_GLOBALI:
        return None
    report: list[dict] = []
    n_total = len(duties)

    def _groups(per_residenza: bool):
        """[(scope_label, duties_del_gruppo, totale_del_gruppo)]"""
        if not per_residenza:
            return [(None, duties, n_total)]
        by_res: dict[str, list] = {}
        for d in duties:
            rid = _duty_residenza_id(d) or "?"
            by_res.setdefault(rid, []).append(d)
        return [(rid, ds, len(ds)) for rid, ds in sorted(by_res.items())]

    for v in VINCOLI_GLOBALI:
        tipset = set(v["tipologie"])
        entries: list[dict] = []
        ok_all = True
        for scope, group, group_total in _groups(bool(v.get("perResidenza"))):
            in_tip = [d for d in group if d.duty_type in tipset]
            cnt = len(in_tip)
            entry: dict = {"scope": scope, "count": cnt, "totale": group_total}
            if v["tipo"] == "numerico":
                attuale = cnt
                ok = ((v.get("min") is None or attuale >= v["min"])
                      and (v.get("max") is None or attuale <= v["max"]))
                entry["attuale"] = attuale
            elif v["tipo"] == "percentuale":
                attuale = round(cnt / max(group_total, 1) * 100, 1)
                ok = ((v.get("minPct") is None or attuale >= v["minPct"])
                      and (v.get("maxPct") is None or attuale <= v["maxPct"]))
                entry["attuale"] = attuale
            else:  # media
                key = {"lavoro": "work_min", "nastro": "nastro_min", "guida": "driving_min"}[v["misura"]]
                attuale = round(sum(getattr(d, key) for d in in_tip) / max(cnt, 1), 1) if cnt else 0.0
                ok = cnt == 0 or ((v.get("minMin") is None or attuale >= v["minMin"])
                                  and (v.get("maxMin") is None or attuale <= v["maxMin"]))
                entry["attuale"] = attuale
            entry["soddisfatto"] = ok
            ok_all = ok_all and ok
            entries.append(entry)
        report.append({**{k: val for k, val in v.items()},
                       "label": _vincolo_label(v),
                       "soddisfatto": ok_all,
                       "dettaglio": entries})
    return report


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
# Esito della gara fra segmentazioni (storica vs pair-aware a più bersagli)
SEGMENTATION_RESULT: dict | None = None

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
CUT_DEPOT_BONUS = 10.0            # taglio al passaggio in deposito: niente auto, vettura mai incustodita

# PAIR-AWARE: segmentazione alternativa in GARA con quella storica. I blocchi
# lunghi vengono tagliati in pezzi abbastanza corti da potersi ACCOPPIARE in
# semiunici/spezzati: due pezzi da 4h30 non stanno in un nastro da 9h15/10h30,
# quindi ogni pezzo diventava un turno intero e i turni guida esplodevano
# (prova reale: 19 vetture → 47 turni, 4,9h di lavoro medio).
PAIR_AWARE_CUTS = True             # config.bds.cuts.pairAware
PAIR_PIECE_TARGET_MIN = 0          # config.bds.cuts.pairPieceTargetMin (0 = dalle SHIFT_RULES)
PAIR_MAX_PIECES = 5                # config.bds.cuts.pairMaxPieces
PAIR_PIECE_MIN_LEN = 150           # sotto è un supplemento: non aiuta a ridurre i turni
# Bersagli EXTRA (config.bds.cuts.pairExtraTargets): pezzi più lunghi del
# limite "due pezzi uguali si accoppiano" — da soli non si accoppiano, ma un
# pezzo da 4h si accoppia con uno da 3h in semiunico (lavoro ≤ 8h). Blocchi
# da ≤12h45 diventano 3 pezzi invece di 4: meno pezzi, turni più pieni. La
# gara decide se rende.
PAIR_EXTRA_TARGETS: tuple[int, ...] = (240, 255)

# Penalità (cost-cents) per punto-percentuale-corsa oltre i cap soft dei tipi
# turno (semiunico/spezzato). Override-abile da config.bds.optimizer.pctOverPenalty.
PCT_OVER_PENALTY = 150
# Tetti percentuali dei tipi di turno (maxPct di semiunico/spezzato e vincoli
# globali percentuali) RIGIDI: la percentuale non va sforata; è ammesso lo
# sforamento di frazione di turno fino a PCT_CAP_TOLERANCE_SHIFTS (0,9), mai
# di un turno intero: count ≤ floor(pct·N/100 + 0,9). Se nessuno scenario è
# fattibile coi tetti rigidi si ripiega sui tetti flessibili (penalità) e lo
# si dichiara (pctCapRelaxed). Override: config.bds.optimizer.pctCapHard /
# pctCapToleranceShifts.
PCT_CAP_HARD = True
PCT_CAP_TOLERANCE_SHIFTS = 0.9
# Tetto di guida per ripresa (min) letto dalla BDS a inizio run: usato dalla
# scelta dei tagli (0 = non applicato)
MAX_GUIDA_RIPRESA = 0
LAST_PCT_CAP: dict = {"hard": True, "toleranceShifts": 0.9, "relaxed": False}


def pct_cap_allowed(max_pct: float | int | None, total: int) -> int | None:
    """Numero massimo di turni di un tipo dato il tetto percentuale e il
    totale: floor(pct·N/100 + tolleranza)."""
    if max_pct is None:
        return None
    return int(math.floor(float(max_pct) * total / 100.0 + PCT_CAP_TOLERANCE_SHIFTS + 1e-9))

# Vincoli GLOBALI di soluzione (BDSI cap. 14) da config.bds.vincoliGlobali:
#   {tipo:"numerico",   tipologie:[...], min?, max?, perResidenza?: bool}
#   {tipo:"percentuale",tipologie:[...], minPct?, maxPct?, perResidenza?: bool}
#   {tipo:"media",      tipologie:[...], misura:"lavoro"|"nastro"|"guida", minMin?, maxMin?}
# Nel CP-SAT sono quasi-hard: slack penalizzati in modo proibitivo, così il
# solver li viola solo se il problema sarebbe altrimenti infeasible; il report
# di soddisfacimento finisce nei metrics (evaluate_vincoli_globali).
VINCOLI_GLOBALI: list[dict] = []
VINCOLO_NUM_PENALTY = 5000 * COST_SCALE     # per turno di scarto (numerico)
VINCOLO_PCT_PENALTY = 3 * PCT_OVER_PENALTY  # per punto-percentuale-corsa
VINCOLO_MEDIA_PENALTY = 50 * COST_SCALE     # per minuto di scarto sull'aggregato

# ----------------------------------------------------------------
# Sosta inoperosa (extraurbano)
# ----------------------------------------------------------------
# Quando l'interruzione di un turno a 2 riprese avviene a un NODO DI SOSTA
# (cluster Planning Studio kind='rest', passato in config.restPoints), parte
# del tempo di sosta è retribuita: 12% se il luogo ha strutture/servizi
# igienici, 25% altrimenti. La sosta inoperosa è per definizione fuori
# residenza e si attiva solo oltre una durata minima.
REST_STOP_FACILITIES: dict[str, bool] = {}   # UPPER(stop_name) -> hasFacilities

# Residenza di servizio per veicolo (vehicleId -> {id,name,color}), dal turno
# macchina (assegnata geometricamente dal backend). Il turno guida eredita la
# residenza del veicolo del suo primo segmento (deposito di uscita).
RESIDENZA_BY_VEHICLE: dict[str, dict] = {}

# Prefisso codice turno guida per categoria/servizio (U/E/M), così urbano ed
# extraurbano hanno CODIFICHE DISTINTE e non collidono quando il processo misto
# li combina (es. U001 / E001 anziché due D001).
DUTY_CODE_PREFIX = "D"


def duty_residenza(duty) -> dict:
    """Residenza del turno guida = residenza del veicolo del primo segmento con
    una residenza nota (deposito di uscita)."""
    for seg in duty.segments:
        r = RESIDENZA_BY_VEHICLE.get(getattr(seg, "vehicle_id", None))
        if r:
            return r
    return {}
SOSTA_INOP_MIN_MIN = 31                       # durata minima (min) perché conti come sosta inoperosa
SOSTA_INOP_COEFF_FACILITIES = 0.12            # contributo all'orario con strutture
SOSTA_INOP_COEFF_NO_FACILITIES = 0.25         # contributo all'orario senza strutture
# Finestre orarie (minuti da mezzanotte): la ripresa del mattino deve FINIRE entro
# morning_end (15:15) e quella del pomeriggio deve INIZIARE dopo afternoon_start (11:50).
SOSTA_INOP_MORNING_END_MAX = 915              # 15:15
SOSTA_INOP_AFTERNOON_START_MIN = 710          # 11:50
# Cap soft combinato sosta inoperosa + semiunici (% sul totale turni principali).
SOSTA_INOP_MAX_PCT_WITH_SEMI = 39
# Nastro massimo del turno con sosta inoperosa (9h15). Oltre, non è una sosta inoperosa.
SOSTA_INOP_MAX_NASTRO = 555
# Tempi pre/post specifici della sosta inoperosa: 5' post (fine ripresa 1) + 5' pre
# (inizio ripresa 2) = 10', in sostituzione del pre_ripresa standard.
SOSTA_INOP_PREPOST_MIN = 10


def sosta_inoperosa_coeff(
    stop_name: str | None, interruption_min: int,
    r1_end: int | None = None, r2_start: int | None = None,
    nastro_min: int | None = None,
) -> float | None:
    """Coefficiente di retribuzione della sosta inoperosa se l'interruzione avviene
    a un nodo di sosta (fuori residenza) e rispetta durata minima, finestre orarie e
    nastro massimo (9h15); altrimenti None. Match per NOME fermata (i VShiftTrip non
    portano lo stop_id).

    finestre/nastro verificati solo se i rispettivi parametri sono forniti.
    """
    if not stop_name or interruption_min < SOSTA_INOP_MIN_MIN or not REST_STOP_FACILITIES:
        return None
    if r1_end is not None and r1_end > SOSTA_INOP_MORNING_END_MAX:
        return None
    if r2_start is not None and r2_start < SOSTA_INOP_AFTERNOON_START_MIN:
        return None
    if nastro_min is not None and nastro_min > SOSTA_INOP_MAX_NASTRO:
        return None
    fac = REST_STOP_FACILITIES.get(stop_name.strip().upper())
    if fac is None:
        return None
    return SOSTA_INOP_COEFF_FACILITIES if fac else SOSTA_INOP_COEFF_NO_FACILITIES


def apply_sosta_inoperosa_config(cfg: dict) -> None:
    """Popola REST_STOP_FACILITIES dai nodi di sosta (config.restPoints, match per
    nome fermata) e applica eventuali override da config.bds.sostaInoperosa
    (minInterruption, coeffFacilities, coeffNoFacilities). Muta i global IN-PLACE."""
    global REST_STOP_FACILITIES, SOSTA_INOP_MIN_MIN
    global SOSTA_INOP_COEFF_FACILITIES, SOSTA_INOP_COEFF_NO_FACILITIES
    global SOSTA_INOP_MORNING_END_MAX, SOSTA_INOP_AFTERNOON_START_MIN, SOSTA_INOP_MAX_PCT_WITH_SEMI
    global SOSTA_INOP_MAX_NASTRO, SOSTA_INOP_PREPOST_MIN

    REST_STOP_FACILITIES = {}
    for rp in (cfg.get("restPoints") or []):
        if not rp:
            continue
        fac = bool(rp.get("hasFacilities"))
        for nm in (rp.get("stopNames") or []):
            if nm:
                REST_STOP_FACILITIES[str(nm).strip().upper()] = fac

    si = (cfg.get("bds", {}) or {}).get("sostaInoperosa", {}) or {}
    if "minInterruption" in si:
        try:
            SOSTA_INOP_MIN_MIN = int(si["minInterruption"])
        except (ValueError, TypeError):
            pass
    if "coeffFacilities" in si:
        try:
            SOSTA_INOP_COEFF_FACILITIES = float(si["coeffFacilities"])
        except (ValueError, TypeError):
            pass
    if "coeffNoFacilities" in si:
        try:
            SOSTA_INOP_COEFF_NO_FACILITIES = float(si["coeffNoFacilities"])
        except (ValueError, TypeError):
            pass
    if "morningEndMax" in si:
        try:
            SOSTA_INOP_MORNING_END_MAX = int(si["morningEndMax"])
        except (ValueError, TypeError):
            pass
    if "afternoonStartMin" in si:
        try:
            SOSTA_INOP_AFTERNOON_START_MIN = int(si["afternoonStartMin"])
        except (ValueError, TypeError):
            pass
    if "maxPctWithSemi" in si:
        try:
            SOSTA_INOP_MAX_PCT_WITH_SEMI = int(si["maxPctWithSemi"])
        except (ValueError, TypeError):
            pass
    if "maxNastro" in si:
        try:
            SOSTA_INOP_MAX_NASTRO = int(si["maxNastro"])
        except (ValueError, TypeError):
            pass
    if "prePostMin" in si:
        try:
            SOSTA_INOP_PREPOST_MIN = int(si["prePostMin"])
        except (ValueError, TypeError):
            pass

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


def seg_transfer_out(s: "Segment", clusters: list) -> int:
    """Trasferimento in auto deposito→nodo PRIMA del pezzo: zero se il pezzo
    inizia con l'uscita del bus dal deposito (il conducente prende il bus lì)."""
    if getattr(s, "starts_at_depot", False):
        return 0
    return depot_transfer_min(s.first_stop, clusters)


def seg_transfer_back(s: "Segment", clusters: list) -> int:
    """Trasferimento in auto nodo→deposito DOPO il pezzo: zero se il pezzo
    finisce col rientro del bus in deposito."""
    if getattr(s, "ends_at_depot", False):
        return 0
    return depot_transfer_min(s.last_stop, clusters)


def _block_edge_transfers(b: "VehicleBlock", first_stop: str, last_stop: str,
                          at_start: bool, at_end: bool, clusters: list) -> tuple[int, int, int]:
    """(trasferimento andata, ritorno, minuti di uscita+rientro guidati) per un
    pezzo ipotetico che copre l'inizio (at_start) e/o la fine (at_end) del blocco."""
    t_out = 0 if at_start else depot_transfer_min(first_stop, clusters)
    t_back = 0 if at_end else depot_transfer_min(last_stop, clusters)
    extra = (b.pullout_min if at_start else 0) + (b.pullin_min if at_end else 0)
    return t_out, t_back, extra


def single_nastro_work(s: "Segment", bds: "BDSConfig", clusters: list) -> tuple[int, int]:
    """(nastro, work) di un turno mono-segmento. FONTE UNICA usata sia
    nell'obiettivo CP-SAT sia nell'estrazione: prima divergevano (il modello
    usava pre_turno_deposito=12 e trasferimenti fissi, l'estrazione pre_turno_for
    e i cluster reali), così il solver ottimizzava un nastro/work diverso da
    quello poi classificato/validato con RD 131/1938."""
    t = seg_transfer_out(s, clusters)
    tb = seg_transfer_back(s, clusters)
    pt = pre_turno_for(t)
    nastro = s.work_min + pt + t + tb
    work = s.work_min + pt + tb
    return nastro, work


def pair_nastro_work(s1: "Segment", s2: "Segment", bds: "BDSConfig", clusters: list,
                     ptype: str | None = None) -> tuple[int, int]:
    """(nastro, work) di un turno su due pezzi. FONTE UNICA condivisa fra
    obiettivo CP-SAT ed estrazione (vedi single_nastro_work).

    ptype "intero" = INTERO COMPOSTO: cambio vettura in linea senza
    interruzione — lo stacco breve è attesa retribuita, quindi lavoro = nastro
    (niente pre-ripresa, niente sosta inoperosa)."""
    if s1.start_min > s2.start_min:
        s1, s2 = s2, s1
    t = seg_transfer_out(s1, clusters)
    tb = seg_transfer_back(s2, clusters)
    pt = pre_turno_for(t)
    nastro = s2.end_min - s1.start_min + pt + t + tb
    if ptype == "intero":
        return nastro, nastro
    work = s1.work_min + s2.work_min + pt + tb + bds.pre_post.pre_ripresa
    # Sosta inoperosa: se l'interruzione avviene a un nodo di sosta, una quota
    # del tempo è retribuita (conta nell'orario di lavoro → cap maxLavoro + costo).
    interruption = s2.start_min - s1.end_min
    coeff = sosta_inoperosa_coeff(s1.last_stop, interruption, s1.end_min, s2.start_min, nastro)
    if coeff:
        # contributo sosta + pre/post sosta inoperosa (5'+5') in luogo del pre_ripresa
        work += int(interruption * coeff)
        work += SOSTA_INOP_PREPOST_MIN - bds.pre_post.pre_ripresa
    return nastro, work


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
    is_depot_start = duty.transfer_min > 0 or getattr(first_seg, "starts_at_depot", False)
    total += pre_turno_bds(is_depot_start, pp)

    # Post-turno
    is_depot_end = duty.transfer_back_min > 0 or getattr(last_seg, "ends_at_depot", False)
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
        # Uscita/rientro deposito del turno macchina: il primo e l'ultimo
        # conducente del bus li GUIDANO (niente auto aziendale ai bordi).
        pullout_min = 0
        pullin_min = 0
        legs: list[VShiftTrip] = []
        for t in raw_trips:
            if t.get("type") == "deadhead" and t.get("depotLeg") == "out":
                pullout_min = max(pullout_min, int(t.get("deadheadMin") or 0))
            elif t.get("type") == "deadhead" and t.get("depotLeg") == "in":
                pullin_min = max(pullin_min, int(t.get("deadheadMin") or 0))
            if t.get("type") in ("deadhead", "depot"):
                _dm = int(t.get("departureMin") if t.get("departureMin") is not None else _hhmm_to_min(t.get("departureTime", "")))
                _am = int(t.get("arrivalMin") if t.get("arrivalMin") is not None else _hhmm_to_min(t.get("arrivalTime", "")))
                legs.append(VShiftTrip(
                    type=str(t.get("type")),
                    trip_id="", route_id="",
                    route_name=str(t.get("routeName") or ""),
                    headsign=None,
                    departure_time=str(t.get("departureTime") or min_to_time(_dm)),
                    arrival_time=str(t.get("arrivalTime") or min_to_time(_am)),
                    departure_min=_dm, arrival_min=_am,
                    first_stop_name=str(t.get("firstStopName") or ""),
                    last_stop_name=str(t.get("lastStopName") or ""),
                    deadhead_km=float(t.get("deadheadKm") or 0),
                    deadhead_min=int(t.get("deadheadMin") or max(0, _am - _dm)),
                    depot_leg=t.get("depotLeg") or None,
                ))
        legs.sort(key=lambda x: (x.departure_min, x.arrival_min))
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
                variant_code=str(t.get("variantCode", "") or ""),
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
            pullout_min=pullout_min,
            pullin_min=pullin_min,
            legs=legs,
        ))

    blocks.sort(key=lambda b: b.start_min)
    return blocks


def block_leg_between(block: "VehicleBlock", prev: VShiftTrip, nxt: VShiftTrip) -> VShiftTrip | None:
    """La tratta non di servizio del blocco fra due corse consecutive (fuorilinea
    o rientro in deposito), se il turno macchina ne prevede una."""
    for leg in getattr(block, "legs", None) or []:
        if leg.departure_min >= prev.arrival_min and leg.arrival_min <= nxt.departure_min:
            return leg
    return None


def takeover_min(prev_arrival_min: int, drive_start_min: int) -> int:
    """Minuto in cui il montante prende il bus a un cambio in linea.

    Regola aziendale: il bus non resta incustodito più di UNATTENDED_BUS_MAX.
    Sosta fino a 2×UNATTENDED_BUS_MAX: il montante la copre per intero (così
    una sosta di 15-30′ resta una vera sosta al capolinea per chi monta, e il
    bus non aspetta da solo per pochi minuti); oltre, prende il bus
    UNATTENDED_BUS_MAX dopo l'arrivo dello smontante, o prima se deve già
    ripartire (fuorilinea o corsa). Mai prima dell'arrivo."""
    gap = drive_start_min - prev_arrival_min
    if gap <= 2 * UNATTENDED_BUS_MAX:
        return prev_arrival_min
    return max(prev_arrival_min, min(drive_start_min, prev_arrival_min + UNATTENDED_BUS_MAX))


def piece_start_min(block: "VehicleBlock", cut_index: int) -> int:
    """Inizio del pezzo che segue un taglio inter fra trips[cut_index] e
    trips[cut_index+1]: la stessa regola di _make_segment (montante entro
    UNATTENDED_BUS_MAX dall'arrivo della corsa precedente se la sosta è
    ≤ MAX_IDLE_AT_TERMINAL e il bus non va in deposito; altrimenti uscita dal
    deposito / partenza della corsa)."""
    trips = block.trips
    if cut_index < 0 or cut_index + 1 >= len(trips):
        return trips[-1].departure_min if trips else 0
    prev, nxt = trips[cut_index], trips[cut_index + 1]
    leg = block_leg_between(block, prev, nxt)
    if leg is not None and leg.type == "depot":
        return nxt.departure_min - max(0, nxt.departure_min - leg.arrival_min)
    if nxt.departure_min - prev.arrival_min <= MAX_IDLE_AT_TERMINAL:
        drive_start = leg.departure_min if (leg is not None and leg.type == "deadhead") else nxt.departure_min
        return takeover_min(prev.arrival_min, drive_start)
    return nxt.departure_min


def block_trip_index(block: "VehicleBlock", trip: VShiftTrip, edge: str = "both") -> int:
    """Indice della corsa nel blocco. edge="start": basta che coincida la
    PARTENZA (corsa intera o metà sinistra di un taglio intra-corsa: il pezzo
    inizia dove inizia la corsa del blocco); edge="end": basta che coincida
    l'ARRIVO (corsa intera o metà destra: il pezzo finisce dove finisce la
    corsa del blocco); "both": corsa intera. -1 se non c'è."""
    for i, bt in enumerate(block.trips):
        if bt.trip_id != trip.trip_id:
            continue
        ok_start = bt.departure_min == trip.departure_min
        ok_end = bt.arrival_min == trip.arrival_min
        if (edge == "start" and ok_start) or (edge == "end" and ok_end) or (edge == "both" and ok_start and ok_end):
            return i
    return -1


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

    # Guida cumulata COMPRESI i fuorilinea guidati: uscita dal deposito prima
    # della prima corsa, riposizionamenti fra corse (li guida il pezzo che
    # contiene la corsa che segue), rientro/uscita ai passaggi in deposito,
    # rientro finale. Così il tetto di guida per ripresa (max_guida_per_ripresa)
    # vale sui minuti reali del pezzo, non solo sulle corse.
    def _drive_of(i: int) -> int:
        t = trips[i]
        d = t.arrival_min - t.departure_min
        if i == 0:
            d += int(block.pullout_min or 0)
        else:
            leg = block_leg_between(block, trips[i - 1], t)
            if leg is not None and leg.type == "deadhead":
                d += max(0, leg.arrival_min - leg.departure_min)
            elif leg is not None and leg.type == "depot":
                d += max(0, t.departure_min - leg.arrival_min)
        if i == len(trips) - 1:
            d += int(block.pullin_min or 0)
        else:
            leg = block_leg_between(block, t, trips[i + 1])
            if leg is not None and leg.type == "depot":
                d += max(0, leg.departure_min - t.arrival_min)
        return d

    cum_driving = [0]
    for i in range(len(trips)):
        cum_driving.append(cum_driving[-1] + _drive_of(i))
    total_driving = cum_driving[-1]
    max_guida = int(getattr(getattr(bds, "riprese", None), "max_guida_per_ripresa", 0) or 0)

    # BDS5 lung_pezzi: lunghezza minima dei pezzi generati (per categoria)
    min_pezzo = (BDS5_LUNG_PEZZI_MIN_EXTRA if block.category == "extraurbano"
                 else BDS5_LUNG_PEZZI_MIN)

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
        _leg = block_leg_between(block, trips[i], trips[i + 1])
        if (_leg is None or _leg.type != "depot") and gap <= MAX_IDLE_AT_TERMINAL:
            # cambio in linea: il montante prende il bus entro UNATTENDED_BUS_MAX
            # dal taglio e copre il resto della sosta e l'eventuale fuorilinea
            right_work = trips[-1].arrival_min - piece_start_min(block, i)
        else:
            right_work = trips[-1].arrival_min - trips[i + 1].departure_min

        # BDS5 lung_pezzi: il taglio non deve creare pezzi sotto la lunghezza minima
        if min_pezzo > 0 and (left_work < min_pezzo or right_work < min_pezzo):
            continue

        # ── Scoring ──
        score = 0.0

        # BDS5 fascia_oraria: cambi preferenzialmente non ammessi in fascia
        if _bds5_in_fascia_senza_cambi(cut_time):
            score -= FASCIA_SENZA_CAMBI_PENALTY

        # Bonus gap
        if gap >= 5:
            score += CUT_SCORE_GAP_BASE + (min(gap, 20) - 5) * CUT_SCORE_GAP_BONUS_PER_MIN

        # Cluster bonus/penalità
        if cid:
            score += CUT_SCORE_CLUSTER_BONUS
        else:
            score -= CUT_NO_CLUSTER_PENALTY
        # Passaggio in deposito fra le due corse: il taglio ideale (chi smonta
        # rientra col bus, chi monta esce col bus: niente auto, mai incustodita)
        if _leg is not None and _leg.type == "depot":
            score += CUT_DEPOT_BONUS + CUT_NO_CLUSTER_PENALTY

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
        # Tetto di guida per ripresa (4h30 poi pausa): un taglio che lascia un
        # pezzo sopra il tetto è fortemente penalizzato
        if max_guida > 0:
            for _dv in (left_driving, right_driving):
                if _dv > max_guida:
                    score -= (_dv - max_guida) * CUT_NASTRO_PENALTY_PER_MIN * 3

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

            # BDS5 lung_pezzi anche per i tagli intra-corsa
            if min_pezzo > 0 and (left_work_intra < min_pezzo or right_work_intra < min_pezzo):
                continue

            # ── Scoring intra ──
            score_intra = INTRA_SCORE_BASE  # penalità base vs inter

            # BDS5 fascia_oraria: cambi preferenzialmente non ammessi in fascia
            if _bds5_in_fascia_senza_cambi(cut_time_intra):
                score_intra -= FASCIA_SENZA_CAMBI_PENALTY

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
            if max_guida > 0:
                for _dv in (left_driving_intra, right_driving_intra):
                    if _dv > max_guida:
                        score_intra -= (_dv - max_guida) * CUT_NASTRO_PENALTY_PER_MIN * 3

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

def block_total_driving(b: VehicleBlock) -> int:
    """Guida dell'intero blocco compresi uscita, rientro e fuorilinea guidati."""
    d = int(b.driving_min) + int(b.pullout_min or 0) + int(b.pullin_min or 0)
    for leg in getattr(b, "legs", None) or []:
        # solo i riposizionamenti FRA corse: uscita e rientro sono già pullout/pullin
        if leg.type == "deadhead" and getattr(leg, "depot_leg", None) not in ("out", "in"):
            d += max(0, leg.arrival_min - leg.departure_min)
    for i in range(len(b.trips) - 1):
        leg = block_leg_between(b, b.trips[i], b.trips[i + 1])
        if leg is not None and leg.type == "depot":
            d += max(0, leg.departure_min - b.trips[i].arrival_min) + max(0, b.trips[i + 1].departure_min - leg.arrival_min)
    return d


def classify_blocks(blocks: list[VehicleBlock], clusters: list[Cluster], max_driving: int = 0) -> None:
    """Classifica ogni blocco in CORTO, CORTO_BASSO, MEDIO, LUNGO. Un blocco
    che starebbe in un intero per nastro ma supera il tetto di guida per
    ripresa (fuorilinea compresi) va comunque tagliato: MEDIO."""
    for b in blocks:
        first_stop = b.trips[0].first_stop_name if b.trips else ""
        last_stop = b.trips[-1].last_stop_name if b.trips else ""
        # I bordi del blocco sono in deposito (uscita/rientro guidati, niente auto)
        transfer, transfer_back, extra = _block_edge_transfers(b, first_stop, last_stop, True, True, clusters)
        nastro = b.nastro_min + extra + pre_turno_for(transfer) + transfer + transfer_back

        if nastro <= NASTRO_INTERO_MAX:
            if max_driving > 0 and block_total_driving(b) > max_driving and b.cut_candidates:
                b.classification = "MEDIO"
            elif b.driving_min < DRIVING_BASSO_THRESHOLD:
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
    block: VehicleBlock | None = None,
) -> Segment:
    start = trips[0].departure_min
    end = trips[-1].arrival_min
    driving = sum(t.arrival_min - t.departure_min for t in trips)
    first_stop = trips[0].first_stop_name
    last_stop = trips[-1].last_stop_name
    # Bordi in deposito: il pezzo che contiene la PRIMA corsa del blocco inizia
    # con l'uscita del bus dal deposito (il conducente lo prende lì e guida
    # l'uscita); quello con l'ULTIMA finisce col rientro. Niente auto
    # aziendale a quei bordi, e uscita/rientro sono minuti di guida.
    starts_at_depot = ends_at_depot = False
    pullout = pullin = 0
    lead_idle = 0
    if block is not None and block.trips:
        b0, bl = block.trips[0], block.trips[-1]
        starts_at_depot = trips[0].trip_id == b0.trip_id and trips[0].departure_min == b0.departure_min
        ends_at_depot = trips[-1].trip_id == bl.trip_id and trips[-1].arrival_min == bl.arrival_min
        if starts_at_depot:
            pullout = int(block.pullout_min or 0)
            start -= pullout
            driving += pullout
        else:
            # CAMBIO IN LINEA: il montante prende il bus all'ARRIVO della corsa
            # precedente, al suo capolinea, e copre sosta ed eventuale
            # fuorilinea fino alla prima corsa del pezzo. Così il bus non resta
            # mai senza conducente e consegna/ritiro dell'auto aziendale si
            # accoppiano nello stesso nodo e nello stesso minuto. Se fra le
            # due corse il bus rientra in deposito, il pezzo inizia lì con
            # l'uscita (niente auto). Le metà di un taglio intra-corsa
            # (block_trip_index = -1) partono dalla fermata intermedia.
            k = block_trip_index(block, trips[0], edge="start")
            if k > 0:
                prev = block.trips[k - 1]
                leg = block_leg_between(block, prev, trips[0])
                if leg is not None and leg.type == "depot":
                    starts_at_depot = True
                    pullout = max(0, trips[0].departure_min - leg.arrival_min)
                    start = trips[0].departure_min - pullout
                    driving += pullout
                elif trips[0].departure_min - prev.arrival_min <= MAX_IDLE_AT_TERMINAL:
                    # Il bus può restare incustodito al nodo al massimo
                    # UNATTENDED_BUS_MAX: il montante lo prende entro quel tempo
                    # dall'arrivo, o prima se deve guidare il fuorilinea/ripartire.
                    _dh = 0
                    drive_start = trips[0].departure_min
                    if leg is not None and leg.type == "deadhead":
                        _dh = max(0, leg.arrival_min - leg.departure_min)
                        drive_start = leg.departure_min
                        driving += _dh
                    start = takeover_min(prev.arrival_min, drive_start)
                    first_stop = prev.last_stop_name or first_stop
                    lead_idle = max(0, trips[0].departure_min - start - _dh)
        if ends_at_depot:
            pullin = int(block.pullin_min or 0)
            end += pullin
            driving += pullin
        else:
            k = block_trip_index(block, trips[-1], edge="end")
            if 0 <= k < len(block.trips) - 1:
                leg = block_leg_between(block, trips[-1], block.trips[k + 1])
                if leg is not None and leg.type == "depot":
                    ends_at_depot = True
                    pullin = max(0, leg.departure_min - trips[-1].arrival_min)
                    end = trips[-1].arrival_min + pullin
                    driving += pullin
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
        starts_at_depot=starts_at_depot,
        ends_at_depot=ends_at_depot,
        pullout_min=pullout,
        pullin_min=pullin,
        lead_idle_min=lead_idle,
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

        lt_out, lt_back, l_extra = _block_edge_transfers(b, left_first, left_last, True, False, clusters)
        rt_out, rt_back, r_extra = _block_edge_transfers(b, right_first, right_last, False, True, clusters)
        left_nastro = c.left_work_min + l_extra + pre_turno_for(lt_out) + lt_out + lt_back
        right_nastro = c.right_work_min + r_extra + pre_turno_for(rt_out) + rt_out + rt_back

        if left_nastro <= max_nastro and right_nastro <= max_nastro:
            valid_cuts.append(c)

    # Fra i tagli validi per nastro, prima quelli che rispettano anche il
    # tetto di guida per ripresa (fuorilinea compresi)
    if valid_cuts and MAX_GUIDA_RIPRESA > 0:
        ok_driving = [c for c in valid_cuts
                      if c.left_driving_min <= MAX_GUIDA_RIPRESA and c.right_driving_min <= MAX_GUIDA_RIPRESA]
        if ok_driving:
            valid_cuts = ok_driving
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
            lo, lb, le = _block_edge_transfers(b, lf, ll, True, False, clusters)
            ro, rb, re_ = _block_edge_transfers(b, rf, rl, False, True, clusters)
            return max(
                c.left_work_min + le + pre_turno_for(lo) + lo + lb,
                c.right_work_min + re_ + pre_turno_for(ro) + ro + rb,
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
            seg = _make_segment(b.vehicle_id, b.vehicle_type, b.trips, "full", None, clusters, block=b)
            b.segments = [seg]
            all_segments.append(seg)

        elif b.classification == "MEDIO":
            best = _select_best_cut(b, clusters)
            if best:
                left_trips, right_trips = _split_trips_for_cut(b, best)
                seg1 = _make_segment(b.vehicle_id, b.vehicle_type, left_trips, "first", best.index, clusters, block=b)
                seg2 = _make_segment(b.vehicle_id, b.vehicle_type, right_trips, "second", best.index, clusters, block=b)
                b.segments = [seg1, seg2]
                all_segments.extend([seg1, seg2])
            else:
                seg = _make_segment(b.vehicle_id, b.vehicle_type, b.trips, "full", None, clusters, block=b)
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

                    mid_start = piece_start_min(b, c1_raw.index)
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

                    lt, lb, le = _block_edge_transfers(b, lf, ll, True, False, clusters)
                    mt, mb, _ = _block_edge_transfers(b, mf, ml, False, False, clusters)
                    rt, rb, re_ = _block_edge_transfers(b, rf, rl, False, True, clusters)
                    ln = c1_raw.left_work_min + le + pre_turno_for(lt) + lt + lb
                    mn = mid_work + pre_turno_for(mt) + mt + mb
                    rn = c2_raw.right_work_min + re_ + pre_turno_for(rt) + rt + rb
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
                    # c2 intra: right_trips_c2 = [metà destra] + corse dopo; il
                    # mezzo prende le corse fra i due tagli PIÙ la metà sinistra
                    # della corsa spezzata (altrimenti resta senza conducente)
                    left_c2, _right_c2 = _split_trips_for_cut(b, c2)
                    mid_trips = left_c2[len(left_trips_c1):]
                    if not mid_trips:
                        mid_trips = rest_after_c1

                seg1 = _make_segment(b.vehicle_id, b.vehicle_type, left_trips_c1, "first", c1.index, clusters, block=b)
                segs = [seg1]
                if mid_trips:
                    seg2 = _make_segment(b.vehicle_id, b.vehicle_type, mid_trips, "middle", c1.index, clusters, block=b)
                    segs.append(seg2)
                seg3 = _make_segment(b.vehicle_id, b.vehicle_type, right_trips_c2, "second", c2.index, clusters, block=b)
                segs.append(seg3)
                b.segments = segs
                all_segments.extend(segs)
            elif b.cut_candidates:
                best = _select_best_cut(b, clusters)
                if best:
                    l, r = _split_trips_for_cut(b, best)
                    seg1 = _make_segment(b.vehicle_id, b.vehicle_type, l, "first", best.index, clusters, block=b)
                    seg2 = _make_segment(b.vehicle_id, b.vehicle_type, r, "second", best.index, clusters, block=b)
                    b.segments = [seg1, seg2]
                    all_segments.extend([seg1, seg2])
                else:
                    seg = _make_segment(b.vehicle_id, b.vehicle_type, b.trips, "full", None, clusters, block=b)
                    b.segments = [seg]
                    all_segments.append(seg)
            else:
                seg = _make_segment(b.vehicle_id, b.vehicle_type, b.trips, "full", None, clusters, block=b)
                b.segments = [seg]
                all_segments.append(seg)

    return all_segments


def _pair_piece_max(rules: dict, kinds: tuple[str, ...] = ("semiunico", "spezzato")) -> int:
    """Lunghezza massima (min) di un pezzo perché DUE pezzi possano formare un
    semiunico o uno spezzato: dalle regole (nastro/lavoro max, interruzione
    minima) al netto di pre-turno e trasferimenti, come in _feasible_pair."""
    if PAIR_PIECE_TARGET_MIN > 0:
        return PAIR_PIECE_TARGET_MIN
    ovh = pre_turno_for(DEPOT_TRANSFER_CENTRAL) + DEPOT_TRANSFER_CENTRAL * 2
    bounds = []
    for kind in kinds:
        default_work = 480 if kind == "semiunico" else 450
        r = rules.get(kind, SHIFT_RULES[kind])
        by_nastro = (int(r["maxNastro"]) - ovh - int(r["intMin"])) // 2
        by_work = (int(r.get("maxLavoro", default_work)) - ovh) // 2
        bounds.append(min(by_nastro, by_work))
    return max(60, min(bounds))


def build_pair_aware_segments(
    blocks: list[VehicleBlock], clusters: list[Cluster], rules: dict,
    full_candidates: dict[str, list[CutCandidate]] | None = None,
    cut_only_at_clusters: bool = True,
    piece_max: int | None = None,
) -> tuple[list[Segment], dict[str, list[Segment]]] | None:
    """Segmentazione PAIR-AWARE: ogni blocco viene tagliato nel numero di pezzi
    necessario perché ciascun pezzo stia sotto _pair_piece_max. Scelta dei
    tagli con una DP sui candidati inter-corsa (già filtrati sui cluster):
    massimizza la somma dei punteggi di taglio, penalizza i pezzi troppo
    lunghi per accoppiarsi e quelli da supplemento.

    full_candidates: tagli PRIMA di collassa_cambi (che è tarato per 1-2 tagli
    e su un blocco lungo lascia solo pochi punti, spesso tutti nella stessa
    metà della giornata); qui il filtro sui cluster viene riapplicato.

    Ritorna (segmenti, mappa veicolo→segmenti) oppure None se nessun blocco
    cambia rispetto alla segmentazione storica (allora la gara non serve).
    """
    piece_max = int(piece_max) if piece_max else _pair_piece_max(rules)
    seg_all: list[Segment] = []
    seg_map: dict[str, list[Segment]] = {}
    changed = False

    def _pen(length: int) -> float:
        p = 0.0
        if length > piece_max:
            p += (length - piece_max) * 0.5
        if length < PAIR_PIECE_MIN_LEN:
            p += (PAIR_PIECE_MIN_LEN - length) * 0.3
        return p

    for b in blocks:
        legacy = list(b.segments)
        trips = b.trips
        need = -(-b.nastro_min // piece_max) if b.nastro_min > 0 else 1
        need = max(1, min(need, PAIR_MAX_PIECES))
        pool = (full_candidates or {}).get(b.vehicle_id, b.cut_candidates)
        cands = sorted((c for c in pool
                        if c.cut_type == "inter" and (c.allows_cambio or not cut_only_at_clusters)),
                       key=lambda c: c.index)
        if need <= 1 or need <= len(legacy) or len(cands) < need - 1:
            seg_map[b.vehicle_id] = legacy
            seg_all.extend(legacy)
            continue

        def _piece_len(i_from: int | None, j_to: int | None) -> int:
            start = trips[0].departure_min if i_from is None else piece_start_min(b, cands[i_from].index)
            end = trips[-1].arrival_min if j_to is None else trips[cands[j_to].index].arrival_min
            return end - start

        # Guida del pezzo (fuorilinea compresi) dai cumulati dei candidati:
        # un pezzo sopra il tetto di guida per ripresa è fortemente penalizzato
        total_drive = (cands[0].left_driving_min + cands[0].right_driving_min) if cands else 0

        def _piece_drive(i_from: int | None, j_to: int | None) -> int:
            lo = 0 if i_from is None else cands[i_from].left_driving_min
            hi = total_drive if j_to is None else cands[j_to].left_driving_min
            return max(0, hi - lo)

        def _pen_drive(i_from: int | None, j_to: int | None) -> float:
            if MAX_GUIDA_RIPRESA <= 0:
                return 0.0
            d = _piece_drive(i_from, j_to)
            return (d - MAX_GUIDA_RIPRESA) * 3.0 if d > MAX_GUIDA_RIPRESA else 0.0

        if MAX_GUIDA_RIPRESA > 0 and total_drive > MAX_GUIDA_RIPRESA:
            need = max(need, min(PAIR_MAX_PIECES, -(-total_drive // MAX_GUIDA_RIPRESA)))
            if len(cands) < need - 1:
                seg_map[b.vehicle_id] = legacy
                seg_all.extend(legacy)
                continue

        k_cuts = need - 1
        n = len(cands)
        NEG = float("-inf")
        best = [[NEG] * n for _ in range(k_cuts + 1)]
        back = [[-1] * n for _ in range(k_cuts + 1)]
        for j in range(n):
            best[1][j] = cands[j].score - _pen(_piece_len(None, j)) - _pen_drive(None, j)
        for k in range(2, k_cuts + 1):
            for j in range(n):
                for i in range(j):
                    if best[k - 1][i] == NEG or cands[j].index <= cands[i].index:
                        continue
                    v = best[k - 1][i] + cands[j].score - _pen(_piece_len(i, j)) - _pen_drive(i, j)
                    if v > best[k][j]:
                        best[k][j], back[k][j] = v, i
        bj, bv = -1, NEG
        for j in range(n):
            if best[k_cuts][j] == NEG:
                continue
            v = best[k_cuts][j] - _pen(_piece_len(j, None)) - _pen_drive(j, None)
            if v > bv:
                bv, bj = v, j
        if bj < 0:
            seg_map[b.vehicle_id] = legacy
            seg_all.extend(legacy)
            continue
        chosen: list[CutCandidate] = []
        k, j = k_cuts, bj
        while k >= 1 and j >= 0:
            chosen.append(cands[j])
            j = back[k][j]
            k -= 1
        chosen.sort(key=lambda c: c.index)

        segs: list[Segment] = []
        prev = 0
        for ci, c in enumerate(chosen):
            segs.append(_make_segment(b.vehicle_id, b.vehicle_type, trips[prev:c.index + 1],
                                      "first" if ci == 0 else "middle", c.index, clusters, block=b))
            prev = c.index + 1
        segs.append(_make_segment(b.vehicle_id, b.vehicle_type, trips[prev:], "second",
                                  chosen[-1].index, clusters, block=b))
        seg_map[b.vehicle_id] = segs
        seg_all.extend(segs)
        changed = True
        log(f"  [PAIR-AWARE] {b.vehicle_id}: {len(legacy)} → {len(segs)} pezzi "
            f"({', '.join(fmt_dur(s.end_min - s.start_min) for s in segs)}), target ≤{piece_max}')")

    if not changed:
        return None
    return seg_all, seg_map


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

    # 2b. Intero COMPOSTO: 2 pezzi con stacco sotto l'interruzione minima
    #     (cambio vettura in linea): nastro e lavoro entro i limiti dell'intero
    if n_segs >= 2 and interruzione < rules["semiunico"]["intMin"]:
        if nastro <= rules["intero"]["maxNastro"] and work <= max_lavoro_intero:
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

    # 5. Fallback con la STESSA tolleranza dei check nastro/lavoro (+15'
    #    intero, +5' semiunico/spezzato): senza, un semiunico di 556-560'
    #    passava i controlli ma il classificatore lo marcava "invalido" —
    #    violazioni fantasma in ogni giro reale.
    if n_segs == 1 and nastro <= rules["intero"]["maxNastro"] + 15:
        return "intero"
    if (n_segs >= 2 and interruzione < rules["semiunico"]["intMin"]
            and nastro <= rules["intero"]["maxNastro"] + 15
            and work <= max_lavoro_intero + 15):
        return "intero"
    if (n_segs >= 2
            and rules["semiunico"]["intMin"] <= interruzione <= rules["semiunico"]["intMax"]
            and nastro <= rules["semiunico"]["maxNastro"] + 5
            and work <= max_lavoro_semi + 5):
        return "semiunico"
    if (n_segs >= 2 and interruzione >= rules["spezzato"]["intMin"]
            and nastro <= rules["spezzato"]["maxNastro"] + 5
            and work <= max_lavoro_spez + 5):
        return "spezzato"

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
        # sosta coperta all'inizio del pezzo (montante all'arrivo)
        if int(getattr(seg, "lead_idle_min", 0) or 0) >= sosta_min:
            return True, []
        for i in range(len(seg.trips) - 1):
            gap = seg.trips[i + 1].departure_min - seg.trips[i].arrival_min
            if gap >= sosta_min:
                return True, []
    # Intero composto: lo stacco al cambio vettura è una sosta al nodo
    for si in range(len(duty.segments) - 1):
        if duty.segments[si + 1].start_min - duty.segments[si].end_min >= sosta_min:
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

    # Intervallo pasto: severità configurabile per azienda. "avviso" (default)
    # NON invalida il turno — la pausa mancante è un avvertimento, non una
    # violazione; "vincolo" la tratta come le altre regole dure.
    pasto_ok, pasto_viol = check_intervallo_pasto(duty, bds.pasto)
    if getattr(bds.pasto, "severita", "avviso") == "vincolo":
        result.intervallo_pasto_ok = pasto_ok
        result.violations.extend(pasto_viol)
    else:
        result.warnings.extend(pasto_viol)

    # Stacco minimo
    stacco_ok, stacco_viol = check_stacco_minimo(duty, bds.stacco)
    result.stacco_minimo_ok = stacco_ok
    result.violations.extend(stacco_viol)

    # Riprese
    riprese_ok, riprese_viol = check_riprese(duty, bds.riprese)
    result.riprese_ok = riprese_ok
    result.violations.extend(riprese_viol)

    return result


def pct_caps_status(duties: list[DriverDutyV3], bds: BDSConfig) -> dict:
    """Stato dei tetti percentuali per tipo di turno (semiunico/spezzato):
    tetto, massimo ammesso con la tolleranza, conteggio, esito."""
    # SHIFT_RULES è già allineato alla config (maxPct compreso)
    total = sum(1 for d in duties if d.duty_type != "supplemento")
    by_type: dict[str, dict] = {}
    for kind in ("semiunico", "spezzato"):
        r = SHIFT_RULES.get(kind, {})
        max_pct = r.get("maxPct") if isinstance(r, dict) else None
        if max_pct is None:
            continue
        count = sum(1 for d in duties if d.duty_type == kind)
        allowed = pct_cap_allowed(max_pct, total)
        by_type[kind] = {
            "maxPct": max_pct, "total": total, "count": count,
            "pct": round(count * 100.0 / total, 1) if total else 0.0,
            "allowed": allowed, "ok": (allowed is None or count <= allowed),
        }
    return {"hard": bool(LAST_PCT_CAP.get("hard", PCT_CAP_HARD)),
            "toleranceShifts": PCT_CAP_TOLERANCE_SHIFTS,
            "relaxed": bool(LAST_PCT_CAP.get("relaxed", False)),
            "byType": by_type}


def validate_all_bds(
    duties: list[DriverDutyV3],
    bds: BDSConfig,
    clusters: list[Cluster],
) -> dict:
    """Valida tutti i turni con BDS. Ritorna stats + lista violazioni."""
    total_violations = 0
    total_warnings = 0
    duty_violations: dict[str, list[str]] = {}
    duty_warnings: dict[str, list[str]] = {}
    bds_results: dict[str, dict] = {}

    for d in duties:
        v = validate_duty_bds(d, bds, clusters)
        d.bds_validation = v  # type: ignore[attr-defined]
        bds_results[d.driver_id] = v.to_dict()
        if not v.valid:
            duty_violations[d.driver_id] = v.violations
            total_violations += len(v.violations)
        if v.warnings:
            duty_warnings[d.driver_id] = v.warnings
            total_warnings += len(v.warnings)

    # Tetti percentuali dei tipi di turno (regola: mai sforati oltre la
    # frazione di turno ammessa): violazioni GLOBALI, contate fra le violazioni.
    global_violations: list[str] = []
    pct_caps = pct_caps_status(duties, bds)
    for k, v in pct_caps.get("byType", {}).items():
        if not v.get("ok", True):
            global_violations.append(
                f"{k}: {v['count']} turni su {v['total']} ({v['pct']}%) oltre il tetto {v['maxPct']}% "
                f"(massimo ammesso {v['allowed']}, tolleranza {PCT_CAP_TOLERANCE_SHIFTS} turno)")
    total_violations += len(global_violations)

    return {
        "totalViolations": total_violations,
        "dutiesWithViolations": len(duty_violations),
        "details": duty_violations,
        "globalViolations": global_violations,
        "pctCaps": pct_caps,
        # Avvertimenti (severità "avviso", es. pause pasto): fuori dal
        # conteggio violazioni, ma visibili per chi li vuole monitorare.
        "totalWarnings": total_warnings,
        "warningDetails": duty_warnings,
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
        idle += int(getattr(seg, "lead_idle_min", 0) or 0)   # sosta coperta prima della prima corsa
        for i in range(len(seg.trips) - 1):
            gap = seg.trips[i + 1].departure_min - seg.trips[i].arrival_min
            if gap > 0:
                idle += gap
    wc.idle_at_terminal_min = idle

    # Pre/post BDS
    wc.pre_post_min = compute_pre_post_total(duty, bds.pre_post, clusters)

    # Trasferimenti
    wc.transfer_min = duty.transfer_min + duty.transfer_back_min

    # Intero composto: lo stacco al cambio vettura è attesa retribuita
    if len(duty.segments) >= 2 and duty.duty_type == "intero":
        wc.idle_at_terminal_min += max(0, duty.interruption_min)
    # Soste fra riprese (per semiunico/spezzato)
    elif len(duty.segments) >= 2 and duty.interruption_min > 0:
        boundary_stop = duty.segments[0].last_stop
        _r1_end = duty.segments[0].end_min
        _r2_start = duty.segments[1].start_min
        sosta_coeff = sosta_inoperosa_coeff(boundary_stop, duty.interruption_min, _r1_end, _r2_start, duty.nastro_min)
        if sosta_coeff is not None:
            # Sosta inoperosa a un nodo di sosta (fuori residenza): quota retribuita
            wc.soste_fra_riprese_fr_min = duty.interruption_min
            wc.coeff_fr = sosta_coeff
            # pre/post sosta inoperosa (5'+5') in luogo del pre_ripresa standard
            wc.pre_post_min += SOSTA_INOP_PREPOST_MIN - bds.pre_post.pre_ripresa
            duty.is_sosta_inoperosa = True  # type: ignore[attr-defined]
        else:
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
    # FIX doppio-conteggio: la deviazione dal target è GIÀ addebitata da
    # undertime_cost (sotto target, stesso coefficiente work_imbalance_per_min)
    # e overtime_cost (sopra target). Ri-applicare qui `dev * work_imbalance_per_min`
    # contava la stessa deviazione due volte, gonfiando il costo riportato e lo
    # score del portfolio. La fascia [target-30, target+12] resta gratuita.
    c.work_imbalance_penalty = 0.0

    # 11. Costi avanzati BDS5 (scalini, quadratici, cambi vettura/patente) —
    #     STESSA funzione usata nell'obiettivo CP-SAT (fonte unica).
    if bds5_active():
        segs = sorted(duty.segments, key=lambda s: s.start_min)
        riprese_dur = [s.end_min - s.start_min for s in segs]
        stacchi = [max(0, b.start_min - a.end_min) for a, b in zip(segs, segs[1:])]
        c.bds5_cost = bds5_duty_cost(
            duty.duty_type, duty.nastro_min, duty.work_min, duty.driving_min,
            riprese_dur, stacchi,
            _bds5_cambi_from_segments(segs),
            {s.vehicle_type for s in segs},
        )

    c.compute()
    return c


# ═══════════════════════════════════════════════════════════════
#  FASE 4: OTTIMIZZAZIONE GLOBALE CP-SAT
# ═══════════════════════════════════════════════════════════════

def _car_deliver_window(s: Segment, clusters: list[Cluster]) -> tuple[int, int] | None:
    """Viaggio auto deposito→nodo PRIMA del segmento (stessa regola di
    compute_car_pool, Fase 6): serve solo se il capolinea è in un cluster."""
    t = seg_transfer_out(s, clusters)
    if t > 0 and s.first_cluster:
        return (s.start_min - t, s.start_min)
    return None


def _car_pickup_window(s: Segment, clusters: list[Cluster]) -> tuple[int, int] | None:
    """Viaggio auto nodo→deposito DOPO il segmento (come compute_car_pool)."""
    t = seg_transfer_back(s, clusters)
    if t > 0 and s.last_cluster:
        return (s.end_min, s.end_min + t)
    return None


def _car_events_single(s: Segment, clusters: list[Cluster]) -> list[tuple[int, int]]:
    """Eventi sul pool auto di un pezzo preso da solo: (+1) un'auto ESCE dal
    deposito per portare il conducente al nodo, (-1) un'auto RIENTRA quando il
    conducente torna dal nodo. Niente eventi ai bordi in deposito (il bus
    esce/rientra col conducente) né dove il capolinea non è un nodo."""
    ev: list[tuple[int, int]] = []
    t = seg_transfer_out(s, clusters)
    if t > 0 and s.first_cluster:
        ev.append((s.start_min - t, +1))
    tb = seg_transfer_back(s, clusters)
    if tb > 0 and s.last_cluster:
        ev.append((s.end_min + tb, -1))
    return ev


def _car_events_pair(s1: Segment, s2: Segment, clusters: list[Cluster],
                     segs_by_vehicle: dict[str, list] | None = None) -> list[tuple[int, int]]:
    """Eventi auto di una coppia: stesso bus e pezzi CONSECUTIVI = il
    conducente resta col mezzo nello stacco (solo i bordi esterni); altrimenti
    torna in deposito e riparte (i quattro bordi), come in compute_car_pool."""
    if s1.start_min > s2.start_min:
        s1, s2 = s2, s1
    if same_bus_consecutive(s1, s2, segs_by_vehicle) or walk_change(s1, s2):
        ev: list[tuple[int, int]] = []
        t = seg_transfer_out(s1, clusters)
        if t > 0 and s1.first_cluster:
            ev.append((s1.start_min - t, +1))
        tb = seg_transfer_back(s2, clusters)
        if tb > 0 and s2.last_cluster:
            ev.append((s2.end_min + tb, -1))
        return ev
    return _car_events_single(s1, clusters) + _car_events_single(s2, clusters)


# Penalità per ogni auto oltre il tetto in un istante: il vincolo è "inviolabile
# salvo impossibilità" (con una segmentazione che impone più cambi simultanei
# del tetto, un vincolo rigido renderebbe il modello infeasible senza dirlo).
CAR_CAP_PENALTY_EUR = 3000
_LAST_CAR_CAP_EXCESS_VARS: list = []
# Tetto auto aziendali RIGIDO nel modello (vincolo inviolabile dell'operatore):
# eccedenza vietata; se nessuno scenario è fattibile si ripiega nell'ordine
# tetti percentuali (tolleranza) → tetto auto (penalità), dichiarandolo.
CAR_CAP_HARD = True


def _interval_peak(ivs: list[tuple[int, int]]) -> int:
    """Massimo numero di intervalli [a, b) sovrapposti in un istante."""
    if not ivs:
        return 0
    pts = sorted({p for iv in ivs for p in iv})
    return max(sum(1 for a, b in ivs if a <= t < b) for t in pts)


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
    sr_int = rules.get("intero", SHIFT_RULES["intero"])

    # INTERO COMPOSTO: due pezzi con stacco sotto l'interruzione minima del
    # semiunico = cambio vettura in linea SENZA interruzione. È un intero
    # (nastro = lavoro ≤ 7h15): la forma da preferire nel festivo. Il cambio
    # è a piedi se i pezzi si passano allo stesso nodo (o è lo stesso bus),
    # altrimenti serve tempo per il trasferimento (stacco ≥ 30').
    if interruption < sr_semi["intMin"]:
        same_vehicle = s1.vehicle_id == s2.vehicle_id
        same_node = bool(s1.last_cluster) and s1.last_cluster == s2.first_cluster
        if same_vehicle or same_node or interruption >= 30:
            # RD 131: l'intero vuole almeno una sosta ≥ sostaMinCapolinea —
            # dentro un pezzo o allo stacco del cambio vettura.
            sosta_min = int(sr_int.get("sostaMinCapolinea", 15))
            has_rest = interruption >= sosta_min or any(
                seg.trips[i + 1].departure_min - seg.trips[i].arrival_min >= sosta_min
                for seg in (s1, s2) for i in range(len(seg.trips) - 1)) or any(
                int(getattr(seg, "lead_idle_min", 0) or 0) >= sosta_min for seg in (s1, s2))
            if (has_rest and nastro <= sr_int["maxNastro"]
                    and nastro <= sr_int.get("maxLavoro", 435)
                    and nastro >= 180):
                return "intero"
        return None

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
    hard_pct_caps: bool | None = None,
    hard_car_cap: bool | None = None,
) -> tuple[cp_model.CpModel, dict, dict, dict]:
    """Costruisce un modello CP-SAT. Parametri:
    - scenario_noise: perturba i costi per esplorare soluzioni alternative
    - strategy: profilo di pesi (vedi SCENARIO_STRATEGIES) per obiettivi alternativi.
    - hard_pct_caps: tetti percentuali dei tipi di turno rigidi (con tolleranza
      di frazione di turno); None = PCT_CAP_HARD.
    """
    if hard_pct_caps is None:
        hard_pct_caps = PCT_CAP_HARD
    if hard_car_cap is None:
        hard_car_cap = CAR_CAP_HARD
    # tolleranza in centesimi di turno: 100·count ≤ pct·N + tol100
    tol100 = int(round(PCT_CAP_TOLERANCE_SHIFTS * 100))
    import random

    strat = SCENARIO_STRATEGIES.get(strategy, SCENARIO_STRATEGIES["balanced"])
    # Pesi operatore: i fattori (1.0 ai default) modulano le spinte di OGNI
    # strategia del portfolio — la direzione la sceglie la strategia,
    # l'intensità la decide l'operatore.
    mul_cost = strat["mul_cost"]
    mul_balance = strat["mul_balance"] * WEIGHT_FACTORS["balance"]
    mul_suppl = strat["mul_suppl"] * WEIGHT_FACTORS["suppl"]
    mul_spezz = strat["mul_spezz"] * WEIGHT_FACTORS["spezz"]
    mul_transfer = strat["mul_transfer"] * WEIGHT_FACTORS["transfer"]

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
        _t = seg_transfer_out(s, clusters)
        _tb = seg_transfer_back(s, clusters)
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

    # -- SOFT: saturazione (min lavoro per turno intero) --
    # Un segmento che da solo (single) darebbe un turno "intero" sotto la
    # soglia minima di lavoro, se esiste almeno un pair che lo può coprire,
    # paga SATURATION_PENALTY nell'obiettivo. Era un divieto HARD: con pezzi
    # corti (segmentazione pair-aware) pretendeva una copertura perfetta a
    # coppie, spesso inesistente → tutti gli scenari INFEASIBLE → greedy.
    # I supplementi (nastro <= SUPPLEMENTO_NASTRO_MAX) sono esentati per
    # definizione: hanno regole di durata proprie.
    n_forbidden_single = 0
    short_single_vars: list[Any] = []
    if MIN_WORK_PER_DUTY > 0 and SATURATION_PENALTY > 0:
        for s in segments:
            _t = seg_transfer_out(s, clusters)
            _tb = seg_transfer_back(s, clusters)
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
                short_single_vars.append(single[s.idx])
                n_forbidden_single += 1
    if n_forbidden_single > 0:
        log(f"[V4][CPSAT] Saturazione: {n_forbidden_single} single sotto {MIN_WORK_PER_DUTY}min "
            f"lavoro penalizzati ({SATURATION_PENALTY} cad.)")

    # -- Vetture aziendali: tetto sulle auto FUORI DEPOSITO in ogni istante --
    # Ogni candidato (pezzo singolo o coppia) genera eventi sul pool: +1 quando
    # un'auto esce dal deposito per portare il conducente al nodo di cambio,
    # -1 quando rientra. I bordi in deposito (uscita/rientro del bus) non
    # generano nulla. Per ogni istante di evento: Σ auto fuori ≤ tetto, con
    # eccedenza penalizzata (CAR_CAP_PENALTY_EUR per auto) invece di un
    # vincolo rigido che renderebbe il modello infeasible in silenzio.
    global _LAST_CAR_CAP_EXCESS_VARS
    _LAST_CAR_CAP_EXCESS_VARS = []
    car_cap_terms: list[Any] = []
    if MAX_COMPANY_CARS > 0:
        cand_events: list[tuple[Any, list[tuple[int, int]]]] = []
        _segs_by_veh: dict[str, list] = {}
        for s in segments:
            _segs_by_veh.setdefault(s.vehicle_id, []).append(s)
        for s in segments:
            ev = _car_events_single(s, clusters)
            if ev:
                cand_events.append((single[s.idx], ev))
        for key, pv in pair_vars.items():
            ev = _car_events_pair(seg_by_idx[key[0]], seg_by_idx[key[1]], clusters, _segs_by_veh)
            if ev:
                cand_events.append((pv, ev))
        times = sorted({t for _, ev in cand_events for t, _ in ev})
        n_constr = 0
        for tau in times:
            terms = []
            for var, ev in cand_events:
                coef = sum(d for t, d in ev if t <= tau)
                if coef:
                    terms.append(coef * var)
            if not terms:
                continue
            exc = model.new_int_var(0, max(1, n_seg), f"car_exc_{tau}")
            model.add(sum(terms) <= MAX_COMPANY_CARS + exc)
            if hard_car_cap:
                model.add(exc == 0)   # vincolo inviolabile
            car_cap_terms.append(CAR_CAP_PENALTY_EUR * COST_SCALE * exc)
            _LAST_CAR_CAP_EXCESS_VARS.append(exc)
            n_constr += 1
        _fixed_windows = [w for s in segments
                          for w in (_car_deliver_window(s, clusters), _car_pickup_window(s, clusters)) if w]
        log(f"[V4][CPSAT] Vetture aziendali: tetto {MAX_COMPANY_CARS} auto fuori deposito, "
            f"{n_constr} istanti vincolati, {len(cand_events)} candidati con viaggi auto "
            f"(picco in transito se tutti singoli: {_interval_peak(_fixed_windows)})")

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
        _t = seg_transfer_out(seg, clusters)
        _tb = seg_transfer_back(seg, clusters)
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
        _t_out = seg_transfer_out(s, clusters)
        _t_back = seg_transfer_back(s, clusters)
        nastro_single = s.work_min + pre_turno_for(_t_out) + _t_out + _t_back
        if nastro_single <= SUPPLEMENTO_NASTRO_MAX:
            n_supplemento.append(single[s.idx])

    # Sosta inoperosa: pair la cui interruzione cade su un nodo di sosta (fuori
    # residenza) rispettando durata minima e finestre orarie. Quelli NON semiunici
    # vanno conteggiati a parte per il cap combinato (evita doppio conteggio).
    seg_by_idx = {s.idx: s for s in segments}
    n_sosta_inop = []
    for key, pv in pair_vars.items():
        ptype = pair_types[key]
        if ptype == "semiunico":
            n_semi.append(pv)
        else:
            n_spezzato.append(pv)
        a = seg_by_idx.get(key[0]); b = seg_by_idx.get(key[1])
        if a is not None and b is not None:
            if a.start_min > b.start_min:
                a, b = b, a
            _nastro_ab = pair_nastro_work(a, b, bds, clusters)[0]
            if sosta_inoperosa_coeff(a.last_stop, b.start_min - a.end_min, a.end_min, b.start_min, _nastro_ab) is not None:
                if ptype != "semiunico":
                    n_sosta_inop.append(pv)

    model.add(total_duties == sum(single.values()) + sum(pair_vars.values()))

    # Limiti percentuali SOFT (flessibili): l'eccesso sopra il cap è penalizzato
    # nell'obiettivo, non vietato. excess >= 100*count - maxPct*total (>=0 dal dominio).
    # Penalità per "punto-percentuale-corsa" oltre soglia: globale PCT_OVER_PENALTY
    # (override config.bds.optimizer.pctOverPenalty).
    pct_excess: list[Any] = []
    if n_supplemento:
        suppl_count = model.new_int_var(0, n_seg, "suppl_count")
        model.add(suppl_count == sum(n_supplemento))
        ex = model.new_int_var(0, 100 * n_seg, "suppl_excess")
        model.add(ex >= 100 * suppl_count - 10 * total_duties)
        pct_excess.append(ex)

    if n_semi:
        semi_count = model.new_int_var(0, n_seg, "semi_count")
        model.add(semi_count == sum(n_semi))
        semi_max_pct = rules.get("semiunico", SHIFT_RULES["semiunico"]).get("maxPct", 12)
        ex = model.new_int_var(0, 100 * n_seg, "semi_excess")
        model.add(ex >= 100 * semi_count - semi_max_pct * total_duties)
        pct_excess.append(ex)
        if hard_pct_caps:
            # RIGIDO: la percentuale non va sforata (tolleranza di frazione di turno)
            model.add(100 * semi_count <= int(semi_max_pct) * total_duties + tol100)

    if n_spezzato:
        spez_count = model.new_int_var(0, n_seg, "spez_count")
        model.add(spez_count == sum(n_spezzato))
        spez_max_pct = rules.get("spezzato", SHIFT_RULES["spezzato"]).get("maxPct", 13)
        ex = model.new_int_var(0, 100 * n_seg, "spez_excess")
        model.add(ex >= 100 * spez_count - spez_max_pct * total_duties)
        pct_excess.append(ex)
        if hard_pct_caps:
            model.add(100 * spez_count <= int(spez_max_pct) * total_duties + tol100)

    # Cap soft combinato: semiunici + sosta inoperosa ≤ SOSTA_INOP_MAX_PCT_WITH_SEMI%
    if n_semi or n_sosta_inop:
        semi_sosta_count = model.new_int_var(0, n_seg, "semi_sosta_count")
        model.add(semi_sosta_count == sum(n_semi) + sum(n_sosta_inop))
        ex = model.new_int_var(0, 100 * n_seg, "semi_sosta_excess")
        model.add(ex >= 100 * semi_sosta_count - SOSTA_INOP_MAX_PCT_WITH_SEMI * total_duties)
        pct_excess.append(ex)

    # -- Vincoli GLOBALI di soluzione (BDSI cap. 14): quasi-hard con slack --
    # Il tipo di turno di ogni variabile è noto a build-time (single→intero/
    # supplemento, pair→semiunico/spezzato), quindi numerico/percentuale/media
    # sono vincoli lineari esatti. Slack penalizzati in modo proibitivo: il
    # solver li viola solo se altrimenti il modello sarebbe infeasible.
    vincoli_slack_terms: list[Any] = []
    if VINCOLI_GLOBALI:
        # Penalità ancorate al costo-per-turno del modello (WEIGHT_DUTY_COUNT
        # × COST_SCALE per turno): una violazione deve costare più di diversi
        # turni extra, altrimenti la minimizzazione dei turni la domina.
        _duty_cost = max(1, WEIGHT_DUTY_COUNT) * COST_SCALE
        _pen_num = 10 * _duty_cost + VINCOLO_NUM_PENALTY          # per turno di scarto
        _pen_pct = _duty_cost // 10 + VINCOLO_PCT_PENALTY         # per punto-%-turno (≈100/turno)
        _pen_media = _duty_cost // 100 + VINCOLO_MEDIA_PENALTY    # per minuto di scarto aggregato
        var_info: list[tuple[Any, str, str, int, int, int]] = []
        for s in segments:
            nastro_s, work_s = single_nastro_work(s, bds, clusters)
            dtype = "supplemento" if nastro_s <= SUPPLEMENTO_NASTRO_MAX else "intero"
            res = RESIDENZA_BY_VEHICLE.get(s.vehicle_id)
            var_info.append((single[s.idx], dtype, (res or {}).get("id") or "?",
                             nastro_s, work_s, s.driving_min))
        for key, pv in pair_vars.items():
            a, b = seg_by_idx[key[0]], seg_by_idx[key[1]]
            if a.start_min > b.start_min:
                a, b = b, a
            nastro_p, work_p = pair_nastro_work(a, b, bds, clusters)
            res = RESIDENZA_BY_VEHICLE.get(a.vehicle_id)
            var_info.append((pv, pair_types[key], (res or {}).get("id") or "?",
                             nastro_p, work_p, a.driving_min + b.driving_min))

        for vk, vg in enumerate(VINCOLI_GLOBALI):
            tipset = set(vg["tipologie"])
            scopes = (sorted({i[2] for i in var_info})
                      if vg.get("perResidenza") else [None])
            for scope in scopes:
                in_scope = [i for i in var_info if scope is None or i[2] == scope]
                sel = [i for i in in_scope if i[1] in tipset]
                if not in_scope:
                    continue
                cnt = sum(i[0] for i in sel) if sel else 0
                sfx = f"vg{vk}_{scope or 'all'}"
                if vg["tipo"] == "numerico":
                    if vg.get("max") is not None and sel:
                        over = model.new_int_var(0, n_seg, f"{sfx}_over")
                        model.add(over >= cnt - vg["max"])
                        vincoli_slack_terms.append(_pen_num * over)
                    if vg.get("min") is not None:
                        under = model.new_int_var(0, n_seg, f"{sfx}_under")
                        model.add(under >= vg["min"] - cnt)
                        vincoli_slack_terms.append(_pen_num * under)
                elif vg["tipo"] == "percentuale":
                    tot = sum(i[0] for i in in_scope)
                    if vg.get("maxPct") is not None and sel:
                        over = model.new_int_var(0, 100 * n_seg, f"{sfx}_pover")
                        model.add(over >= 100 * cnt - vg["maxPct"] * tot)
                        vincoli_slack_terms.append(_pen_pct * over)
                        if hard_pct_caps:
                            model.add(100 * cnt <= int(vg["maxPct"]) * tot + tol100)
                    if vg.get("minPct") is not None:
                        under = model.new_int_var(0, 100 * n_seg, f"{sfx}_punder")
                        model.add(under >= vg["minPct"] * tot - 100 * cnt)
                        vincoli_slack_terms.append(_pen_pct * under)
                        if hard_pct_caps:
                            model.add(100 * cnt >= int(vg["minPct"]) * tot - tol100)
                else:  # media: Σ misura·x vs soglia·count (lineare)
                    if not sel:
                        continue
                    m_idx = {"nastro": 3, "lavoro": 4, "guida": 5}[vg["misura"]]
                    agg = sum(i[m_idx] * i[0] for i in sel)
                    bound = sum(i[m_idx] for i in sel) + 1
                    if vg.get("maxMin") is not None:
                        over = model.new_int_var(0, bound, f"{sfx}_mover")
                        model.add(over >= agg - vg["maxMin"] * cnt)
                        vincoli_slack_terms.append(_pen_media * over)
                    if vg.get("minMin") is not None:
                        under = model.new_int_var(0, max(bound, vg["minMin"] * n_seg + 1), f"{sfx}_munder")
                        model.add(under >= vg["minMin"] * cnt - agg)
                        vincoli_slack_terms.append(_pen_media * under)

    # -- Obiettivo (con noise per multi-scenario) --
    rng = random.Random(scenario_seed)
    obj_terms: list[Any] = []

    for s in segments:
        # FONTE UNICA: stessi nastro/work dell'estrazione (no più 12 vs 5 e
        # trasferimenti fissi vs cluster reali).
        nastro_s, work_with_overhead = single_nastro_work(s, bds, clusters)
        dev_from_target = abs(work_with_overhead - TARGET_WORK_MID)

        _dtype_s = "supplemento" if nastro_s <= SUPPLEMENTO_NASTRO_MAX else "intero"
        if nastro_s <= SUPPLEMENTO_NASTRO_MAX:
            cost_cents = int(rates.supplemento_daily * COST_SCALE * mul_suppl)
        else:
            hours = work_with_overhead / 60.0
            cost_cents = int((hours * rates.hourly_rate * mul_cost
                             + dev_from_target * rates.work_imbalance_per_min * mul_balance) * COST_SCALE)
        # BDS5: scalini/quadratici (nessun cambio vettura su un mono-segmento)
        if bds5_active():
            cost_cents += int(bds5_duty_cost(
                _dtype_s, nastro_s, work_with_overhead, s.driving_min,
                [s.end_min - s.start_min], [], None, {s.vehicle_type},
            ) * COST_SCALE)
            # FIX-CSP-1: penalita' idle CAPPATA per evitare doppia penalita' con
            # work_imbalance. Solo i primi IDLE_PENALTY_MAX_MIN minuti contano:
            # oltre, il segmento e' strutturalmente isolato e non c'e' alternativa.
            if WEIGHT_IDLE_PENALTY > 0:
                idle_min_raw = max(0, nastro_s - work_with_overhead)
                idle_min_capped = min(idle_min_raw, IDLE_PENALTY_MAX_MIN)
                cost_cents += int(WEIGHT_IDLE_PENALTY * WEIGHT_FACTORS["quality"]) * idle_min_capped * COST_SCALE

        # Perturbazione per esplorare soluzioni diverse
        if scenario_noise > 0:
            noise = rng.gauss(0, scenario_noise * cost_cents)
            cost_cents = max(1, int(cost_cents + noise))

        obj_terms.append(cost_cents * single[s.idx])

    for key, pv in pair_vars.items():
        s1_idx, s2_idx = key
        s1, s2 = seg_by_idx[s1_idx], seg_by_idx[s2_idx]
        ptype = pair_types[key]

        # FONTE UNICA: stesso work dell'estrazione (cluster reali + pre_turno_for)
        _nastro_pair, combined_work = pair_nastro_work(s1, s2, bds, clusters, ptype)
        hours = combined_work / 60.0
        dev = abs(combined_work - TARGET_WORK_MID)

        # Moltiplicatore per tipo: la strategia rincara gli spezzati (mul_spezz,
        # che include già il peso operatore); preferIntero (WEIGHT_FACTORS
        # "spezz") rincara OGNI bi-ripresa, semiunico compreso. L'intero
        # composto (cambio vettura senza interruzione) è un intero: nessun
        # rincaro, e nessuna auto per il cambio a piedi.
        if ptype == "intero":
            pair_type_mul = 1.0 / WEIGHT_FACTORS["spezz"]
        elif ptype == "spezzato":
            pair_type_mul = mul_spezz
        else:
            pair_type_mul = WEIGHT_FACTORS["spezz"]

        cost_cents = int((hours * rates.hourly_rate * mul_cost
                         + dev * rates.work_imbalance_per_min * mul_balance
                         + rates.company_car_per_use * mul_transfer) * COST_SCALE * pair_type_mul)

        # BDS5: scalini/quadratici/cambio vettura/cambio patente sul pair
        if bds5_active():
            _a, _b = (s1, s2) if s1.start_min <= s2.start_min else (s2, s1)
            cost_cents += int(bds5_duty_cost(
                ptype, _nastro_pair, combined_work, s1.driving_min + s2.driving_min,
                [_a.end_min - _a.start_min, _b.end_min - _b.start_min],
                [max(0, _b.start_min - _a.end_min)],
                _bds5_cambi_from_segments([_a, _b]),
                {s1.vehicle_type, s2.vehicle_type},
            ) * COST_SCALE)

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
        obj_terms.append(int(WEIGHT_DUTY_COUNT * WEIGHT_FACTORS["duty"]) * COST_SCALE * total_duties)

    # Saturazione SOFT: single corti scoraggiati, mai vietati
    for v in short_single_vars:
        obj_terms.append(SATURATION_PENALTY * COST_SCALE * v)

    # Penalità SOFT per superamento dei limiti percentuali (flessibili)
    for ex in pct_excess:
        obj_terms.append(PCT_OVER_PENALTY * ex)

    # Vincoli globali di soluzione (BDSI): slack quasi-hard
    obj_terms.extend(vincoli_slack_terms)

    # Tetto auto aziendali: eccedenza (quasi-hard)
    obj_terms.extend(car_cap_terms)

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
            transfer = seg_transfer_out(s, clusters)
            transfer_back = seg_transfer_back(s, clusters)
            pt = pre_turno_for(transfer)
            # FONTE UNICA: identico all'obiettivo CP-SAT
            nastro_s, work_s = single_nastro_work(s, bds, clusters)

            dtype = "supplemento" if nastro_s <= SUPPLEMENTO_NASTRO_MAX else "intero"

            duties.append(DriverDutyV3(
                idx=duty_idx,
                driver_id=f"{DUTY_CODE_PREFIX}{duty_idx + 1:03d}",
                duty_type=dtype,
                segments=[s],
                nastro_start=s.start_min - pt - transfer,
                nastro_end=s.end_min + transfer_back,
                nastro_min=nastro_s,
                work_min=work_s,
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
            transfer = seg_transfer_out(s1, clusters)
            transfer_back = seg_transfer_back(s2, clusters)
            pt = pre_turno_for(transfer)
            # FONTE UNICA: identico all'obiettivo CP-SAT (pair_nastro_work)
            nastro, work = pair_nastro_work(s1, s2, bds, clusters, ptype)

            duties.append(DriverDutyV3(
                idx=duty_idx,
                driver_id=f"{DUTY_CODE_PREFIX}{duty_idx + 1:03d}",
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

    # FIX-CSP-2 + coerenza obiettivo: il CP-SAT pesa OGNI turno con
    # WEIGHT_DUTY_COUNT*COST_SCALE (≈20.000 €-equivalenti) → il numero di turni
    # domina. Lo score del portfolio invece confronta scenari fra loro: con un
    # peso di soli 100 €/turno il conteggio veniva quasi ignorato e si potevano
    # scartare scenari con MENO autisti perché marginalmente più cari sul costo
    # orario — l'opposto dell'intento. Pesiamo ogni turno con il costo reale di
    # un turno-tipo (≈ ore target × tariffa oraria), con SCORE_PER_DUTY come
    # pavimento/override.
    per_duty_weight = max(SCORE_PER_DUTY, rates.hourly_rate * (rates.target_work_min / 60.0))
    score += n_total * per_duty_weight * WEIGHT_FACTORS["duty"]

    # preferIntero anche nella SELEZIONE fra scenari: ogni bi-ripresa
    # (semiunico/spezzato) pesa mezzo turno-tipo × (fattore − 1). Con il
    # fattore a 1 (slider al default) il termine è zero; sotto 1 (l'operatore
    # preferisce le bi-riprese) diventa un bonus.
    n_biriprese = sum(1 for d in duties if d.duty_type in ("semiunico", "spezzato"))
    score += n_biriprese * per_duty_weight * 0.5 * (WEIGHT_FACTORS["spezz"] - 1.0)

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
    relax_pct_caps: bool = False,
    relax_car_cap: bool = False,
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
    # Parità col vecchio motore: maxRounds (1-10, default 5) scala il numero
    # di scenari del portfolio — "più round" nel v4 significa più esplorazione.
    _mr = config.get("maxRounds")
    try:
        _mr = int(_mr) if _mr is not None else None
    except (ValueError, TypeError):
        _mr = None
    if _mr and _mr > 0 and _mr != 5:
        n_scenarios = max(1, round(n_scenarios * min(10, _mr) / 5.0))
    # Override esplicito del numero scenari da config.bds.scenari.count (0/assente = auto da intensità)
    _scen_count = ((config.get("bds", {}) or {}).get("scenari", {}) or {}).get("count")
    if _scen_count:
        try:
            n_scenarios = max(1, int(_scen_count))
        except (ValueError, TypeError):
            pass

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

    _ptypes: dict[str, int] = {}
    for _, _, _pt in feasible_pairs:
        _ptypes[_pt] = _ptypes.get(_pt, 0) + 1
    log(f"CP-SAT: {n_seg} segmenti, {len(feasible_pairs)} coppie fattibili {_ptypes}")

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
            hard_pct_caps=PCT_CAP_HARD and not relax_pct_caps,
            hard_car_cap=CAR_CAP_HARD and not relax_car_cap,
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
        if status in (cp_model.OPTIMAL, cp_model.FEASIBLE) and _LAST_CAR_CAP_EXCESS_VARS:
            _exc = sum(solver.value(v) for v in _LAST_CAR_CAP_EXCESS_VARS)
            if _exc > 0:
                log(f"[V4][CPSAT] ⚠️ tetto auto aziendali superato nel modello: eccedenza "
                    f"cumulata {_exc} auto·istanti (nessuna soluzione entro il tetto con questa segmentazione)")
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
                # FIX: None invece di float('inf') — JSON standard non ammette Infinity
                # e JSON.parse() lato JS fallisce. Lato UI rappresentare come "n/d".
                "score": None,
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

    # ── Verifica solver: distingue "veloce perché ottimo dimostrato" (corretto)
    #    da "veloce perché taglia corto" (budget non applicato → da indagare). ──
    _non_polish = [s for s in scenario_results if not s.get("isPolish")]
    n_optimal = sum(1 for s in _non_polish if s.get("status") == "OPTIMAL")
    n_feasible_only = sum(1 for s in _non_polish if s.get("status") == "FEASIBLE")
    n_other = len(_non_polish) - n_optimal - n_feasible_only
    log(f"[V4] Verifica solver: {n_optimal}/{len(_non_polish)} scenari OPTIMAL (ottimo DIMOSTRATO), "
        f"{n_feasible_only} FEASIBLE (budget {scenario_budget}s esaurito), {n_other} altri. "
        f"Modello: {n_seg} segmenti, {len(feasible_pairs)} coppie fattibili. "
        f"Tempo scenari usato {round(total_scenario_elapsed, 1)}s / {round(scenario_time_total, 1)}s di budget. "
        f"NB: se quasi tutti OPTIMAL, la rapidità è corretta (problema risolto all'ottimo); "
        f"per esplorare di più aumenta gli scenari (intensità).")

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
        # Verifica: quanti scenari hanno raggiunto l'OTTIMO DIMOSTRATO vs solo feasible.
        "nOptimal": n_optimal,
        "nFeasibleOnly": n_feasible_only,
        "nOtherStatus": n_other,
        "optimalProvenAllScenarios": (n_optimal == len(_non_polish) and len(_non_polish) > 0),
    }

    if best_duties is None and PCT_CAP_HARD and not relax_pct_caps:
        # Coi tetti percentuali rigidi nessuno scenario è fattibile: si ripiega
        # sui tetti flessibili e lo si dichiara (pctCapRelaxed nel riepilogo,
        # violazione globale se il tetto resta sforato).
        LAST_PCT_CAP["relaxed"] = True
        log("[V4][PCT-CAP] nessuno scenario fattibile coi tetti percentuali RIGIDI: "
            "ripiego sui tetti flessibili (penalità), sforamento dichiarato")
        return optimize_multi_scenario(blocks, segments, config, time_limit_sec, clusters, bds,
                                       relax_pct_caps=True, relax_car_cap=relax_car_cap)
    if best_duties is None and CAR_CAP_HARD and MAX_COMPANY_CARS > 0 and not relax_car_cap:
        # Neanche coi tetti percentuali flessibili: l'ultimo ripiego è il tetto
        # auto a penalità (sforamento dichiarato: companyCarsCapRelaxed).
        LAST_PCT_CAP["carCapRelaxed"] = True
        log("[V4][CAR-CAP] nessuno scenario fattibile col tetto auto RIGIDO: ripiego a penalità, sforamento dichiarato")
        return optimize_multi_scenario(blocks, segments, config, time_limit_sec, clusters, bds,
                                       relax_pct_caps=True, relax_car_cap=True)

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

    # Vetture aziendali, semantica reale (viaggi deposito↔nodo ai bordi dei
    # segmenti, come compute_car_pool): un pair su veicoli diversi NON aggiunge
    # viaggi rispetto ai due singoli, e un pair sullo stesso veicolo ne toglie
    # due — gli accoppiamenti non possono peggiorare il picco. Il picco dipende
    # solo dai tagli: lo misuriamo qui e lo lasciamo al post-check HARD.
    if MAX_COMPANY_CARS > 0:
        _fixed = [w for s in segments
                  for w in (_car_deliver_window(s, clusters), _car_pickup_window(s, clusters)) if w]
        log(f"[V4][GREEDY] Vetture aziendali: picco viaggi ai bordi = "
            f"{_interval_peak(_fixed)} (cap {MAX_COMPANY_CARS})")

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
            transfer = seg_transfer_out(s1, clusters)
            transfer_back = seg_transfer_back(s2, clusters)
            pt = pre_turno_for(transfer)
            # FONTE UNICA: stesso nastro/work di modello ed estrazione
            nastro, work = pair_nastro_work(s1, s2, bds, clusters, best_type)

            d = DriverDutyV3(
                idx=duty_idx,
                driver_id=f"{DUTY_CODE_PREFIX}{duty_idx + 1:03d}",
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
        transfer = seg_transfer_out(s, clusters)
        transfer_back = seg_transfer_back(s, clusters)
        pt = pre_turno_for(transfer)
        # FONTE UNICA: stesso nastro/work di modello ed estrazione
        nastro_s, work_s = single_nastro_work(s, bds, clusters)

        d = DriverDutyV3(
            idx=duty_idx,
            driver_id=f"{DUTY_CODE_PREFIX}{duty_idx + 1:03d}",
            duty_type="supplemento" if nastro_s <= SUPPLEMENTO_NASTRO_MAX else "intero",
            segments=[s],
            nastro_start=s.start_min - pt - transfer,
            nastro_end=s.end_min + transfer_back,
            nastro_min=nastro_s,
            work_min=work_s,
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
    handover_view,
    inline_handovers,
    CarTrip,
    compute_car_pool,
    car_pool_by_driver,
    same_bus_consecutive,
    walk_change,
    _max_simultaneous_cars_out,
    _cars_out_demand_peak,
    LAST_CAR_POOL_STATS,
)


# ═══════════════════════════════════════════════════════════════
#  SERIALIZZAZIONE OUTPUT
# ═══════════════════════════════════════════════════════════════

def _ripresa_deadheads(seg: Segment, legs: list | None) -> list[dict]:
    """Righe «Fuorilinea» del pezzo: uscita/rientro deposito, riposizionamenti
    e rientri in deposito a metà pezzo che il conducente GUIDA (tratte del
    turno macchina comprese fra inizio e fine del pezzo)."""
    out: list[dict] = []
    for leg in (legs or []):
        if leg.type == "depot":
            # rientro/uscita: basta la SOVRAPPOSIZIONE col pezzo (il pezzo che
            # finisce col rientro copre solo l'arrivo in deposito, quello che
            # riparte solo l'uscita)
            if leg.departure_min > seg.end_min or leg.arrival_min < seg.start_min:
                continue
            prev = max((t for t in seg.trips if t.arrival_min <= leg.departure_min), key=lambda t: t.arrival_min, default=None)
            nxt = min((t for t in seg.trips if t.departure_min >= leg.arrival_min), key=lambda t: t.departure_min, default=None)
            if prev is not None and not (seg.start_min <= prev.arrival_min <= leg.departure_min <= seg.end_min):
                prev = None
            if nxt is not None and not (seg.start_min <= leg.arrival_min <= nxt.departure_min <= seg.end_min):
                nxt = None
            if prev is not None:
                out.append({"kind": "depot_in", "fromStop": prev.last_stop_name or "?", "toStop": "Deposito",
                            "departureMin": prev.arrival_min, "arrivalMin": leg.departure_min,
                            "departureTime": min_to_time(prev.arrival_min), "arrivalTime": min_to_time(leg.departure_min),
                            "km": None, "minutes": max(0, leg.departure_min - prev.arrival_min), "label": "Fuorilinea · rientro deposito"})
            if nxt is not None:
                out.append({"kind": "depot_out", "fromStop": "Deposito", "toStop": nxt.first_stop_name or "?",
                            "departureMin": leg.arrival_min, "arrivalMin": nxt.departure_min,
                            "departureTime": min_to_time(leg.arrival_min), "arrivalTime": min_to_time(nxt.departure_min),
                            "km": None, "minutes": max(0, nxt.departure_min - leg.arrival_min), "label": "Fuorilinea · uscita deposito"})
            continue
        if leg.departure_min < seg.start_min or leg.arrival_min > seg.end_min:
            continue
        kind = "pullout" if leg.depot_leg == "out" else ("pullin" if leg.depot_leg == "in" else "reposition")
        label = {"pullout": "Fuorilinea · uscita deposito", "pullin": "Fuorilinea · rientro deposito"}.get(kind, "Fuorilinea")
        out.append({"kind": kind, "fromStop": leg.first_stop_name or "?", "toStop": leg.last_stop_name or "?",
                    "departureMin": leg.departure_min, "arrivalMin": leg.arrival_min,
                    "departureTime": min_to_time(leg.departure_min), "arrivalTime": min_to_time(leg.arrival_min),
                    "km": round(float(leg.deadhead_km or 0), 1) if leg.deadhead_km else None,
                    "minutes": max(0, leg.arrival_min - leg.departure_min), "label": label})
    out.sort(key=lambda r: (r["departureMin"], r["arrivalMin"]))
    return out


def _segment_to_ripresa(
    seg: Segment,
    is_first: bool,
    is_last: bool,
    duty: DriverDutyV3,
    clusters: list[Cluster] | None = None,
    legs: list | None = None,
) -> dict:
    """Converte un Segment nella struttura Ripresa per il frontend.

    startMin/endMin sono i confini di NASTRO della ripresa (pre-turno e
    trasferimento in auto prima delle corse, rientro in auto dopo): è ciò che
    la UI (Gantt, stampa) e il greedy TS hanno sempre assunto. Gli orari di
    servizio (prima presa in carico del bus → ultimo rilascio) stanno in
    serviceStartMin/serviceEndMin."""
    n_segs = len(duty.segments)
    diff_vehicles = n_segs >= 2 and duty.segments[0].vehicle_id != duty.segments[-1].vehicle_id

    if diff_vehicles:
        _si = next((i for i, x in enumerate(duty.segments) if x is seg), 0)
        _walk_in = _si > 0 and walk_change(duty.segments[_si - 1], seg)
        _walk_out = _si < n_segs - 1 and walk_change(seg, duty.segments[_si + 1])
        _transfer_out = 0 if _walk_in else seg_transfer_out(seg, clusters)
        _transfer_back = 0 if _walk_out else seg_transfer_back(seg, clusters)
        pre_turno = 0 if _walk_in else pre_turno_for(_transfer_out)
        transfer = _transfer_out
        transfer_back = _transfer_back
    else:
        pre_turno = duty.pre_turno_min if is_first else 0
        transfer = duty.transfer_min if is_first else 0
        transfer_back = duty.transfer_back_min if is_last else 0

    transfer_type = ("depot_to_start" if transfer > 0
                     else ("bus_from_depot" if getattr(seg, "starts_at_depot", False) else "none"))
    transfer_back_type = ("end_to_depot" if transfer_back > 0
                          else ("bus_to_depot" if getattr(seg, "ends_at_depot", False) else "none"))
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
            **({"variantCode": t.variant_code} if getattr(t, "variant_code", "") else {}),
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

    nastro_start = seg.start_min - pre_turno - transfer
    nastro_end = seg.end_min + transfer_back
    return {
        "startTime": min_to_time(max(0, nastro_start)),
        "endTime": min_to_time(nastro_end),
        "startMin": nastro_start,
        "endMin": nastro_end,
        "serviceStartMin": seg.start_min,
        "serviceEndMin": seg.end_min,
        "serviceStartTime": min_to_time(seg.start_min),
        "serviceEndTime": min_to_time(seg.end_min),
        "preTurnoMin": pre_turno,
        # "bus" = prende il bus in deposito (controlli), "auto" = raggiunge il nodo in auto
        "preTurnoKind": ("bus" if transfer == 0 else "auto") if pre_turno > 0 else "none",
        "transferMin": transfer,
        "transferType": transfer_type,
        "transferToStop": transfer_to_stop,
        "transferToCluster": transfer_to_cluster,
        "transferBackMin": transfer_back,
        "transferBackType": transfer_back_type,
        "lastStop": seg.last_stop or "?",
        "lastCluster": seg.last_cluster or None,
        "workMin": seg.work_min,
        "deadheads": _ripresa_deadheads(seg, legs),
        "startsAtDepot": bool(getattr(seg, "starts_at_depot", False)),
        "endsAtDepot": bool(getattr(seg, "ends_at_depot", False)),
        "pulloutMin": int(getattr(seg, "pullout_min", 0) or 0),
        "pullinMin": int(getattr(seg, "pullin_min", 0) or 0),
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
    # Tratte non di servizio per bus (uscite/rientri/fuorilinea): righe
    # «Fuorilinea» dentro le riprese. Le parti di un blocco spezzato
    # condividono la stessa lista.
    legs_by_vid: dict[str, list] = {}
    for b in blocks:
        if getattr(b, "legs", None):
            legs_by_vid.setdefault(b.vehicle_id, b.legs)

    for d in duties:
        riprese = []
        my_car = car_by_driver.get(d.driver_id, {})
        all_delivers: list = my_car.get("all_delivers", [])
        all_pickups: list = my_car.get("all_pickups", [])

        for si, seg in enumerate(d.segments):
            rip = _segment_to_ripresa(seg, si == 0, si == len(d.segments) - 1, d, clusters,
                                      legs_by_vid.get(seg.vehicle_id))

            # Viaggi auto agganciati al pezzo per ORARIO (non per indice): un
            # pezzo che esce dal deposito col bus non ha consegna, e la consegna
            # del pezzo successivo non deve finirgli addosso.
            deliver = next((t for t in all_delivers if t.arrive_min == seg.start_min), None)
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

            pickup = next((t for t in all_pickups
                           if t.depart_min - int(getattr(t, "wait_min", 0) or 0) == seg.end_min), None)
            if pickup:
                car_label = f"Auto {pickup.car_id}" if pickup.car_id else "⚠️ Nessuna auto"
                _wait = int(getattr(pickup, "wait_min", 0) or 0)
                rip["carPoolReturn"] = {
                    "carId": pickup.car_id,
                    "departMin": pickup.depart_min,
                    "departTime": min_to_time(pickup.depart_min),
                    "arriveMin": pickup.arrive_min,
                    "arriveTime": min_to_time(pickup.arrive_min),
                    "waitMin": _wait,
                    "description": (f"Prendi {car_label} da {pickup.cluster_name} al deposito"
                                    + (f" (attendi {_wait}′ l'auto in arrivo)" if _wait else "")),
                }
            else:
                rip["carPoolReturn"] = None

            riprese.append(rip)

        # Handover: ogni cambio scritto nel turno, «In [Nodo] lascia/prende la
        # vettura [bus] al/dal turno [codice]» con modalità (auto, a piedi,
        # deposito) e minuti di vettura incustodita.
        my_handovers = handovers_by_driver.get(d.driver_id, [])
        handovers_out = [handover_view(h, d.driver_id, cluster_names) for h in my_handovers]
        handover_labels: list[str] = [v["label"] for v in handovers_out]
        n_inline_handovers = len(inline_handovers(my_handovers))

        # BDS validation per duty
        bds_val = getattr(d, 'bds_validation', None)
        bds_val_dict = bds_val.to_dict() if bds_val else None

        # Work calculation BDS
        wc = getattr(d, 'work_calculation', None)
        wc_dict = wc.to_dict() if wc else None

        # Cost breakdown dettagliato
        cb_obj = getattr(d, 'cost_breakdown_obj', None)
        cb_dict = cb_obj.to_dict() if cb_obj else None

        _res = duty_residenza(d)
        driver_shifts.append({
            "driverId": d.driver_id,
            "type": d.duty_type,
            "residenzaDepotId": _res.get("id"),
            "residenzaName": _res.get("name"),
            "residenzaColor": _res.get("color"),
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
            "cambiCount": len(d.cambi) + n_inline_handovers,
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
            "sostaInoperosaCount": sum(1 for d in duties if getattr(d, "is_sosta_inoperosa", False)),
            "totalWorkHours": round(total_work_hours, 1),
            "avgWorkMin": round(avg_work, 0),
            "totalNastroHours": round(total_nastro_hours, 1),
            "avgNastroMin": round(avg_nastro, 0),
            "semiunicoPct": semi_pct,
            "spezzatoPct": spez_pct,
            # Tetti percentuali: rigidi con tolleranza di frazione di turno;
            # "relaxed" = nessuno scenario fattibile coi tetti rigidi
            "pctCaps": validation.get("pctCaps") if isinstance(validation, dict) else None,
            "pctCapRelaxed": bool(LAST_PCT_CAP.get("relaxed", False)),
            "companyCarsCapHard": bool(CAR_CAP_HARD),
            "companyCarsCapRelaxed": bool(LAST_PCT_CAP.get("carCapRelaxed", False)),
            "totalCambi": len(inline_handovers(handovers)),
            "totalInterCambi": sum(1 for h in inline_handovers(handovers) if getattr(h, 'cut_type', 'inter') == 'inter'),
            "totalIntraCambi": sum(1 for h in inline_handovers(handovers) if getattr(h, 'cut_type', 'inter') == 'intra'),
            "totalDepotChanges": sum(1 for h in handovers if getattr(h, 'kind', 'inline') == 'depot'),
            # Come si fanno i cambi in linea: con auto aziendale, a piedi fra
            # due bus allo stesso nodo; e quanto resta ferma una vettura senza
            # conducente (regola aziendale: al massimo UNATTENDED_BUS_MAX).
            "handoverModes": {
                "incomingCar": sum(1 for h in inline_handovers(handovers) if h.incoming_mode == "car"),
                "incomingWalk": sum(1 for h in inline_handovers(handovers) if h.incoming_mode == "walk"),
                "outgoingCar": sum(1 for h in inline_handovers(handovers) if h.outgoing_mode == "car"),
                "outgoingWalk": sum(1 for h in inline_handovers(handovers) if h.outgoing_mode == "walk"),
                "unattendedMaxMin": max([int(h.unattended_min or 0) for h in inline_handovers(handovers)] or [0]),
                "unattendedLimitMin": UNATTENDED_BUS_MAX,
                "withUnattended": sum(1 for h in inline_handovers(handovers) if int(h.unattended_min or 0) > 0),
                # chi sfora il limite (non dovrebbe succedere: diagnostica)
                "overLimit": [
                    {"vehicleId": h.vehicle_id, "atStop": h.at_stop, "atTime": min_to_time(h.at_min),
                     "takenTime": min_to_time(h.incoming_seg_start), "unattendedMin": int(h.unattended_min or 0),
                     "outgoing": h.outgoing_driver, "incoming": h.incoming_driver, "cutType": getattr(h, "cut_type", "inter")}
                    for h in sorted(inline_handovers(handovers), key=lambda x: -int(x.unattended_min or 0))
                    if int(h.unattended_min or 0) > UNATTENDED_BUS_MAX
                ][:10],
            },
            # Auto aziendali per i cambi in linea. "Used" era il numero di BUS
            # distinti toccati dai turni (19/5 in card): ora è il numero di
            # auto distinte impiegate; il picco conta TUTTI i viaggi richiesti
            # (anche quelli rimasti senza auto), altrimenti non poteva mai
            # superare il tetto per costruzione.
            "companyCarsUsed": len({t.car_id for t in car_movements if t.car_id is not None}),
            "companyCarsMovements": len(car_movements),
            "companyCarsConflicts": sum(1 for t in car_movements if t.car_id is None),
            # ritiri che nessuna consegna raggiunge (nessuno porta un'auto a quel nodo)
            "companyCarsUnpaired": int(LAST_CAR_POOL_STATS.get("unpaired", 0) or 0),
            "companyCarsMaxSimultaneous": _cars_out_demand_peak(car_movements),
            "companyCarsAssignedPeak": _max_simultaneous_cars_out(car_movements),
            "companyCarsCap": MAX_COMPANY_CARS,
            "companyCarsHardViolation": (
                MAX_COMPANY_CARS > 0
                and (_cars_out_demand_peak(car_movements) > MAX_COMPANY_CARS
                     or int(LAST_CAR_POOL_STATS.get("capConflicts", 0) or 0) > 0)
            ),
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
            # Duplicati QUI (oltre che alla radice dell'output) perché
            # l'orchestratore VCSP inoltra solo summary/metrics: senza,
            # dalla chat la gara e i pesi applicati restavano invisibili.
            "segmentation": SEGMENTATION_RESULT,
            "weightFactors": {k: round(v, 3) for k, v in WEIGHT_FACTORS.items()},
            # Pool auto aziendali (viaggi, conflitti, picco richiesto, tetto,
            # elenco dei viaggi): il compatto della chat lo legge da qui.
            "carPool": {
                "totalTrips": len(car_movements),
                "conflicts": sum(1 for t in car_movements if t.car_id is None),
                "unpaired": int(LAST_CAR_POOL_STATS.get("unpaired", 0) or 0),
                "maxSimultaneous": _cars_out_demand_peak(car_movements),
                "assignedPeak": _max_simultaneous_cars_out(car_movements),
                "cap": MAX_COMPANY_CARS,
                "waits": sum(1 for t in car_movements if getattr(t, "wait_min", 0)),
                "movements": [
                    {"duty": t.driver_id, "type": t.trip_type, "cluster": t.cluster_name,
                     "departTime": min_to_time(t.depart_min), "arriveTime": min_to_time(t.arrive_min),
                     "carId": t.car_id, "waitMin": int(getattr(t, "wait_min", 0) or 0)}
                    for t in sorted(car_movements, key=lambda x: x.depart_min)[:120]
                ],
            },
            "classifications": {
                "CORTO": sum(1 for b in blocks if b.classification == "CORTO"),
                "CORTO_BASSO": sum(1 for b in blocks if b.classification == "CORTO_BASSO"),
                "MEDIO": sum(1 for b in blocks if b.classification == "MEDIO"),
                "LUNGO": sum(1 for b in blocks if b.classification == "LUNGO"),
            },
            # Nodi di sosta (kind='rest') disponibili per le soste inoperose
            # extraurbane. Echo dei dati ricevuti dal backend: il consumo nella
            # generazione del duty-type "sosta inoperosa" è un follow-up.
            "restPoints": len(config.get("restPoints") or []),
            # Vincoli GLOBALI di soluzione (BDSI cap. 14): report soddisfacimento
            "vincoliGlobali": evaluate_vincoli_globali(duties),
            # Costi avanzati BDS5: cosa è attivo e quanto pesa sulla soluzione
            "bds5": ({
                "costi": sorted(BDS5_COSTS.keys()),
                "sosteSpezzantiMin": BDS5_SOSTE_SPEZZANTI_MIN or None,
                "fasceSenzaCambi": len(BDS5_FASCE_SENZA_CAMBI) or None,
                "lungPezziMin": BDS5_LUNG_PEZZI_MIN or None,
                "lungPezziMinExtra": BDS5_LUNG_PEZZI_MIN_EXTRA or None,
                "costoTotaleEur": round(sum(
                    getattr(getattr(d, "cost_breakdown_obj", None), "bds5_cost", 0.0) or 0.0
                    for d in duties), 2),
            } if (bds5_active() or BDS5_SOSTE_SPEZZANTI_MIN or BDS5_FASCE_SENZA_CAMBI
                  or BDS5_LUNG_PEZZI_MIN or BDS5_LUNG_PEZZI_MIN_EXTRA) else None),
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
            # Verificabilità: i fattori applicati dai pesi operatore (1.0 =
            # slider al default). Se restano tutti 1.0, i pesi non sono
            # arrivati fino a qui.
            "weightFactors": {k: round(v, 3) for k, v in WEIGHT_FACTORS.items()},
        },
        # Gara fra segmentazioni: quale ha vinto e con quanti turni/score
        "segmentation": SEGMENTATION_RESULT,
        "carPool": {
            "totalTrips": len(car_movements),
            "deliveries": sum(1 for t in car_movements if t.trip_type == "deliver"),
            "pickups": sum(1 for t in car_movements if t.trip_type == "pickup"),
            "conflicts": sum(1 for t in car_movements if t.car_id is None),
            "maxSimultaneous": _cars_out_demand_peak(car_movements),
            "assignedPeak": _max_simultaneous_cars_out(car_movements),
            "cap": MAX_COMPANY_CARS,
            "movements": [
                {"duty": t.driver_id, "type": t.trip_type, "cluster": t.cluster_name,
                 "departMin": t.depart_min, "arriveMin": t.arrive_min,
                 "departTime": min_to_time(t.depart_min), "arriveTime": min_to_time(t.arrive_min),
                 "carId": t.car_id, "waitMin": int(getattr(t, "wait_min", 0) or 0)}
                for t in sorted(car_movements, key=lambda x: x.depart_min)
            ],
        },
        "rates": rates.to_dict(),
    }


# ═══════════════════════════════════════════════════════════════
#  MAIN
# ═══════════════════════════════════════════════════════════════

def run(raw: dict, time_limit_sec: int = 240) -> dict:
    """Esegue il CSP su un input già parsato e RITORNA l'output (dict).

    Entrypoint riusabile dall'orchestratore VCSP (vcsp_orchestrator.py).
    main() resta il wrapper argv/stdin→stdout. I global di configurazione
    vengono riassegnati a ogni chiamata (safe per run ripetuti in-process).
    """
    t_start = time.time()
    vehicle_shifts_raw = raw.get("vehicleShifts", [])
    user_config = raw.get("config", {})
    config = merge_config(user_config)

    # Codifica turni distinta per categoria (U/E/M) — evita collisioni nel misto
    global DUTY_CODE_PREFIX
    _stype = (user_config.get("bds", {}) or {}).get("serviceType")
    DUTY_CODE_PREFIX = {"urbano": "U", "extraurbano": "E", "misto": "M"}.get(_stype, "D")

    # Residenza di servizio per veicolo (dal turno macchina) → ereditata dai turni guida
    global RESIDENZA_BY_VEHICLE
    global LAST_SCENARIO_RESULTS, LAST_OPTIMIZATION_ANALYSIS, SEGMENTATION_RESULT
    SEGMENTATION_RESULT = None
    RESIDENZA_BY_VEHICLE = {}
    for _sh in vehicle_shifts_raw:
        _vid = _sh.get("vehicleId")
        if _vid and _sh.get("residenzaDepotId"):
            RESIDENZA_BY_VEHICLE[_vid] = {
                "id": _sh.get("residenzaDepotId"),
                "name": _sh.get("residenzaName"),
                "color": _sh.get("residenzaColor"),
            }

    # Permetti override delle SHIFT_RULES da config.bds.shiftRules
    apply_shift_rules_override(config)
    # Override iperparametri ottimizzatore (saturazione, vetture, pesi)
    apply_optimizer_overrides(config)
    # Pesi operatore (slider pannello TG / crewConfig.weights) → fattori v4
    apply_operator_weights(config)
    # Override avanzati Fase 2 (soglie/scoring tagli, cap %, multi-scenario)
    apply_fase2_overrides(config)
    # Vincoli GLOBALI di soluzione (BDSI cap. 14)
    apply_vincoli_globali_config(config)
    # Costi avanzati + estensioni tagli BDS5 (manuale configurazione algoritmo)
    apply_bds5_config(config)

    clusters = parse_clusters_from_config(config)
    bds = BDSConfig.from_config(config)

    apply_sosta_inoperosa_config(config)
    rest_points = config.get("restPoints") or []
    log(f"=== Crew Scheduler V4 (BDS) ===")
    log(f"Input: {len(vehicle_shifts_raw)} turni macchina, timeLimit={time_limit_sec}s")
    if REST_STOP_FACILITIES:
        n_fac = sum(1 for v in REST_STOP_FACILITIES.values() if v)
        log(f"Nodi di sosta: {len(rest_points)} cluster, {len(REST_STOP_FACILITIES)} fermate "
            f"({n_fac} con strutture). Sosta inoperosa ≥{SOSTA_INOP_MIN_MIN}': "
            f"contributo {int(SOSTA_INOP_COEFF_FACILITIES*100)}%/{int(SOSTA_INOP_COEFF_NO_FACILITIES*100)}%.")
    log(f"BDS config: pre/post={bds.pre_post.pre_turno_deposito}/{bds.pre_post.post_turno_deposito}, "
        f"RD131={'ON' if bds.rd131.attivo else 'OFF'}, "
        f"pasto={'ON' if bds.pasto.attivo else 'OFF'}")
    report_progress("init", 5, f"{len(vehicle_shifts_raw)} turni macchina")

    # ── Fase 1: Parsing ──
    global MAX_GUIDA_RIPRESA
    MAX_GUIDA_RIPRESA = int(getattr(bds.riprese, "max_guida_per_ripresa", 0) or 0)
    blocks = parse_vehicle_blocks(vehicle_shifts_raw, clusters)
    # BDS5 soste_spezzanti: pre-spezza i blocchi alle soste ≥ soglia (tagli obbligatori)
    blocks, _bds5_splits = split_blocks_at_soste(blocks, clusters)
    log(f"Fase 1: {len(blocks)} vehicle blocks parsati")
    report_progress("parse", 10, f"{len(blocks)} blocchi")

    # ── Fase 2: Analisi con BDS ──
    for b in blocks:
        analyze_vehicle_block(b, clusters, bds)
    classify_blocks(blocks, clusters, max_driving=int(getattr(bds.riprese, "max_guida_per_ripresa", 0) or 0))

    # Snapshot dei tagli PRIMA del collasso: serve alla segmentazione pair-aware
    full_cut_candidates = {b.vehicle_id: list(b.cut_candidates) for b in blocks}

    # Collassa tagli troppo vicini (BDS)
    collassa_cambi(blocks, COLLASSA_MIN_GAP)  # global (override-abile) anziché il default-arg catturato all'import

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
    # PAIR-AWARE in gara: la segmentazione storica (2 tagli sui LUNGO) e quella
    # a pezzi accoppiabili corrono entrambe con metà budget; vince il punteggio
    # di _score_solution (costo + costo nascosto per turno).
    variants: list[tuple[str, list[Segment], dict[str, list[Segment]]]] = []
    if PAIR_AWARE_CUTS:
        _rules = config.get("shiftRules", SHIFT_RULES)
        # Bersagli: pezzi accoppiabili in ENTRAMBI i tipi (semiunico e spezzato)
        # e pezzi più lunghi accoppiabili solo in semiunico (lavoro fino a 8h):
        # il portfolio decide quale rende di più su questa rete.
        targets: list[int] = []
        for t in (_pair_piece_max(_rules), _pair_piece_max(_rules, ("semiunico",)), *PAIR_EXTRA_TARGETS):
            if t not in targets:
                targets.append(t)
        seen_shapes: set[tuple] = set()
        for t in targets:
            pv = build_pair_aware_segments(
                blocks, clusters, _rules,
                full_candidates=full_cut_candidates,
                cut_only_at_clusters=bool(config.get("cutOnlyAtClusters", True)),
                piece_max=t,
            )
            if pv is None:
                continue
            shape = tuple((s.vehicle_id, s.start_min, s.end_min) for s in pv[0])
            if shape in seen_shapes:
                continue
            seen_shapes.add(shape)
            variants.append((f"pair-aware ≤{t}'", pv[0], pv[1]))
    if not variants:
        duties = optimize_multi_scenario(blocks, segments, config, time_limit_sec, clusters, bds)
    else:
        legacy_map = {b.vehicle_id: list(b.segments) for b in blocks}
        rates_cmp = CostRates.from_config(config)
        share_tl = max(20, int(time_limit_sec / (1 + len(variants))))
        log(f"[V4][PAIR-AWARE] gara: storica ({len(segments)} seg.) vs "
            + ", ".join(f"{lab} ({len(sg)} seg.)" for lab, sg, _ in variants)
            + f" — {share_tl}s ciascuna")
        results: list[dict] = []
        best_pick = None   # (score, label, duties, segments, seg_map, snapshot)
        for label, segs, seg_map in [("storica", segments, legacy_map)] + variants:
            for b in blocks:
                b.segments = seg_map.get(b.vehicle_id, b.segments)
            d_var = optimize_multi_scenario(blocks, segs, config, share_tl, clusters, bds)
            sc = _score_solution(d_var, rates_cmp, bds, clusters)
            snap = (list(LAST_SCENARIO_RESULTS), dict(LAST_OPTIMIZATION_ANALYSIS))
            results.append({"label": label, "segments": len(segs), "duties": len(d_var),
                            "score": round(sc, 1)})
            log(f"[V4][PAIR-AWARE] {label}: {len(segs)} segmenti → {len(d_var)} turni (score {sc:.0f})")
            if best_pick is None or sc < best_pick[0]:
                best_pick = (sc, label, d_var, segs, seg_map, snap)
        _, win_label, duties, segments, win_map, win_snap = best_pick
        for b in blocks:
            b.segments = win_map.get(b.vehicle_id, b.segments)
        LAST_SCENARIO_RESULTS, LAST_OPTIMIZATION_ANALYSIS = win_snap
        SEGMENTATION_RESULT = {"winner": win_label, "variants": results}
        log(f"[V4][PAIR-AWARE] vince: {win_label}")

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
    log(f"Fase 6: {len(inline_handovers(handovers))} cambi bus in linea identificati "
        f"({sum(1 for h in handovers if h.kind == 'depot')} passaggi in deposito, "
        f"{sum(1 for h in inline_handovers(handovers) if h.incoming_mode == 'walk')} montate a piedi, "
        f"vettura incustodita max {max([h.unattended_min for h in inline_handovers(handovers)] or [0])}′ "
        f"su un limite di {UNATTENDED_BUS_MAX}′)")

    # Il pool reale usa il tetto dell'operatore (non la costante di modulo):
    # con tetto 2 l'allocatore deve fermarsi a 2 auto e dichiarare i conflitti.
    if MAX_COMPANY_CARS > 0:
        import crew_scheduler_v3 as _v3
        _v3.COMPANY_CARS = MAX_COMPANY_CARS
    car_movements = compute_car_pool(duties, clusters)
    n_conflicts = sum(1 for m in car_movements if m.car_id is None)
    max_sim = _cars_out_demand_peak(car_movements)
    log(f"Fase 6: {len(car_movements)} viaggi auto, {n_conflicts} conflitti, max {max_sim} auto fuori deposito")
    report_progress("carpool", 90, f"{len(car_movements)} viaggi auto")

    # ── Validazione HARD post-solve: cap vetture aziendali ──
    # Anche se il CP-SAT applica add_cumulative, il post-processing dei pair
    # potrebbe (in casi limite) eccedere; lo segnaliamo esplicitamente.
    n_unpaired = int(LAST_CAR_POOL_STATS.get("unpaired", 0) or 0)
    n_cap = int(LAST_CAR_POOL_STATS.get("capConflicts", 0) or 0)
    if n_unpaired:
        log(f"[V4][CAR-POOL] {n_unpaired} ritiri senza auto al nodo: nessuna consegna raggiunge quel nodo (dipende dal piano, non dal tetto)")
    if MAX_COMPANY_CARS > 0 and (max_sim > MAX_COMPANY_CARS or n_cap > 0):
        log(
            f"[V4][HARD-VIOLATION] Vetture aziendali: picco richiesto {max_sim} > cap={MAX_COMPANY_CARS} "
            f"oppure {n_conflicts} trasferimenti senza auto. "
            f"La soluzione viola il vincolo HARD richiesto dall'utente."
        )
    else:
        log(f"[V4][HARD-OK] Vetture aziendali simultanee max={max_sim} ≤ cap={MAX_COMPANY_CARS}")

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

    return output


def main() -> None:
    # Default tempo PIÙ ALTO (Maior-style): 240s anziché 120s, scala con intensità via UI
    time_limit_sec = int(sys.argv[1]) if len(sys.argv) > 1 else 240
    write_output(run(load_input(), time_limit_sec))


if __name__ == "__main__":
    main()
