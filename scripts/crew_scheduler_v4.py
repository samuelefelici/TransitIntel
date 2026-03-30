#!/usr/bin/env python3
"""
crew_scheduler_v4.py — BDS-inspired Crew Scheduler (MAIOR BDS v4)
Conerobus S.p.A. / TransitIntel

APPROCCIO VSF (Vehicle-Shift-First) con normativa BDS integrata:
  - PrePostRules multi-livello (turno/ripresa/pezzo)
  - CE 561/2006 guida continuativa con soste frazionate
  - Intervallo pasto (pranzo/cena)
  - Stacco minimo differenziato
  - GestoreRiprese con sosta che spezza
  - CoperturaSoste per tipo linea
  - CollegamentoConfig per trasferimenti strutturati
  - classify_duty() post-hoc (supplemento → intero → semiunico → spezzato)
  - validate_duty_bds() validazione completa
  - compute_duty_cost() con pre/post multi-livello

Pipeline:
  1. parse_vehicle_blocks     — JSON → VehicleBlock[]
  2. analyze_vehicle_block    — punti di taglio con copertura soste BDS
  3. collassa_cambi           — collasso gap < 45min tra tagli
  4. classify_blocks          — CORTO / CORTO_BASSO / MEDIO / LUNGO
  5. build_initial_segments   — applica tagli, genera segmenti
  6. optimize_global          — CP-SAT: scelta tagli + pairing
  7. classify_duty            — classificazione post-hoc BDS
  8. validate_all_bds         — validazione completa BDS
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
    VShiftTrip, VehicleShift, CambioInfo,
    VehicleBlock, CutCandidate, Segment, DriverDutyV3,
    Cluster, DEFAULT_CLUSTERS,
    # BDS dataclass
    PrePostRules, CEE561Config, IntervalloPastoConfig,
    StaccoMinimo, GestoreRiprese, CoperturaSosteConfig,
    CollegamentoConfig, WorkCalculation, BDSValidation,
    # Funzioni
    match_cluster, cluster_by_id, depot_transfer_min,
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
NASTRO_LUNGO_THRESHOLD = 870
MIN_CUT_GAP = 3
SUPPLEMENTO_NASTRO_MAX = 150
COLLASSA_MIN_GAP = 45  # gap minimo tra tagli per collasso

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


# ═══════════════════════════════════════════════════════════════
#  BDS CONFIG BUNDLE
# ═══════════════════════════════════════════════════════════════

@dataclass
class BDSConfig:
    """Bundle di tutte le configurazioni BDS."""
    pre_post: PrePostRules = field(default_factory=PrePostRules)
    cee561: CEE561Config = field(default_factory=CEE561Config)
    pasto: IntervalloPastoConfig = field(default_factory=IntervalloPastoConfig)
    stacco: StaccoMinimo = field(default_factory=StaccoMinimo)
    riprese: GestoreRiprese = field(default_factory=GestoreRiprese)
    copertura: CoperturaSosteConfig = field(default_factory=CoperturaSosteConfig)
    collegamento: CollegamentoConfig = field(default_factory=CollegamentoConfig)

    @classmethod
    def from_config(cls, cfg: dict) -> "BDSConfig":
        bds = cfg.get("bds", {})
        return cls(
            pre_post=PrePostRules.from_config(bds.get("prePost")),
            cee561=CEE561Config.from_config(bds.get("cee561")),
            pasto=IntervalloPastoConfig.from_config(bds.get("pasto")),
            stacco=StaccoMinimo.from_config(bds.get("stacco")),
            riprese=GestoreRiprese.from_config(bds.get("riprese")),
            copertura=CoperturaSosteConfig.from_config(bds.get("copertura")),
            collegamento=CollegamentoConfig.from_config(bds.get("collegamento")),
        )

    def to_dict(self) -> dict:
        return {
            "prePost": self.pre_post.to_dict(),
            "cee561": self.cee561.to_dict(),
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


def _select_best_cut(b: VehicleBlock, clusters: list[Cluster]) -> CutCandidate | None:
    """Seleziona il miglior taglio per un blocco MEDIO."""
    max_nastro = SHIFT_RULES["intero"]["maxNastro"]
    valid_cuts: list[CutCandidate] = []

    for c in b.cut_candidates:
        left_first = b.trips[0].first_stop_name
        left_last = b.trips[c.index].last_stop_name
        right_first = b.trips[c.index + 1].first_stop_name
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
            ll = b.trips[c.index].last_stop_name
            rf = b.trips[c.index + 1].first_stop_name
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
                left_trips = b.trips[:best.index + 1]
                right_trips = b.trips[best.index + 1:]
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
                left_trips = b.trips[:c1.index + 1]
                mid_trips = b.trips[c1.index + 1:c2.index + 1]
                right_trips = b.trips[c2.index + 1:]
                seg1 = _make_segment(b.vehicle_id, b.vehicle_type, left_trips, "first", c1.index, clusters)
                segs = [seg1]
                if mid_trips:
                    seg2 = _make_segment(b.vehicle_id, b.vehicle_type, mid_trips, "middle", c1.index, clusters)
                    segs.append(seg2)
                seg3 = _make_segment(b.vehicle_id, b.vehicle_type, right_trips, "second", c2.index, clusters)
                segs.append(seg3)
                b.segments = segs
                all_segments.extend(segs)
            elif b.cut_candidates:
                best = _select_best_cut(b, clusters)
                if best:
                    l = b.trips[:best.index + 1]
                    r = b.trips[best.index + 1:]
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
    """
    nastro = duty.nastro_min
    interruzione = duty.interruption_min
    n_segs = len(duty.segments)
    rules = SHIFT_RULES

    # 1. Supplemento: nastro ≤ 150 min, singolo segmento
    if nastro <= SUPPLEMENTO_NASTRO_MAX and n_segs == 1:
        return "supplemento"

    # 2. Intero: singolo segmento, nastro ≤ 435
    if n_segs == 1 and nastro <= rules["intero"]["maxNastro"]:
        return "intero"

    # 3. Semiunico: 2 segmenti, interruzione 75-179 min, nastro ≤ 555
    if n_segs >= 2 and interruzione >= rules["semiunico"]["intMin"] and interruzione <= rules["semiunico"]["intMax"]:
        if nastro <= rules["semiunico"]["maxNastro"]:
            return "semiunico"

    # 4. Spezzato: 2 segmenti, interruzione ≥ 180 min, nastro ≤ 630
    if n_segs >= 2 and interruzione >= rules["spezzato"]["intMin"]:
        if nastro <= rules["spezzato"]["maxNastro"]:
            return "spezzato"

    # 5. Fallback: intero con tolleranza se singolo segmento
    if n_segs == 1 and nastro <= rules["intero"]["maxNastro"] + 15:
        return "intero"

    # 6. Invalido
    return "invalido"


# ═══════════════════════════════════════════════════════════════
#  VALIDAZIONE BDS
# ═══════════════════════════════════════════════════════════════

def check_cee561(duty: DriverDutyV3, cee: CEE561Config) -> tuple[bool, list[str]]:
    """Verifica CE 561/2006: guida continuativa max 4h30 con soste frazionate.

    Supporta soste frazionate: 2×15 min o 1×15 + 1×30 min per comporre
    la pausa di 45 min.
    """
    if not cee.attivo:
        return True, []

    violations: list[str] = []

    for seg in duty.segments:
        continuous_driving = 0
        accumulated_break = 0
        break_count = 0

        for i, t in enumerate(seg.trips):
            dur = t.arrival_min - t.departure_min
            continuous_driving += dur

            if continuous_driving > cee.max_periodo_continuativo:
                violations.append(
                    f"guida continuativa {continuous_driving}min > max {cee.max_periodo_continuativo}min "
                    f"(segmento {seg.vehicle_id}, trip {t.trip_id})"
                )
                break

            # Controlla se c'è un gap dopo questa corsa
            if i + 1 < len(seg.trips):
                gap = seg.trips[i + 1].departure_min - t.arrival_min
                if gap >= cee.min_sosta:
                    # Questa è una sosta valida (≥ 15 min)
                    accumulated_break += gap
                    break_count += 1

                    # Se la pausa cumulata raggiunge la soglia completa, reset
                    if accumulated_break >= cee.sosta_che_spezza:
                        continuous_driving = 0
                        accumulated_break = 0
                        break_count = 0
                    elif break_count >= cee.max_soste:
                        # Troppe soste senza raggiungere la pausa completa
                        if accumulated_break < cee.sosta_che_spezza:
                            violations.append(
                                f"dopo {break_count} soste cumulate {accumulated_break}min "
                                f"< {cee.sosta_che_spezza}min richiesti "
                                f"(segmento {seg.vehicle_id})"
                            )

    return len(violations) == 0, violations


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
    """Validazione completa BDS di un turno guida."""
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

    # CE 561/2006
    cee_ok, cee_viol = check_cee561(duty, bds.cee561)
    result.cee561_ok = cee_ok
    result.violations.extend(cee_viol)

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
    """Verifica se due segmenti possono formare un turno biripresa."""
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

    # Semiunico
    sr = rules.get("semiunico", SHIFT_RULES["semiunico"])
    if (sr["intMin"] <= interruption <= sr["intMax"]
            and nastro <= sr["maxNastro"]
            and work >= 180):
        return "semiunico"

    # Spezzato
    sr = rules.get("spezzato", SHIFT_RULES["spezzato"])
    if (interruption >= sr["intMin"]
            and nastro <= sr["maxNastro"]
            and work >= 180):
        return "spezzato"

    return None


def optimize_global(
    blocks: list[VehicleBlock],
    segments: list[Segment],
    config: dict,
    time_limit_sec: int,
    clusters: list[Cluster],
    bds: BDSConfig,
) -> list[DriverDutyV3]:
    """CP-SAT compatto BDS-aware."""
    rules = config.get("shiftRules", SHIFT_RULES)
    rates = CostRates.from_config(config)

    report_progress("optimize", 30, f"CP-SAT v4: {len(segments)} segmenti")

    model = cp_model.CpModel()
    n_seg = len(segments)
    seg_by_idx = {s.idx: s for s in segments}

    # ── Variabili single ──
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

    # ── Coppie fattibili ──
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

    log(f"CP-SAT v4: {n_seg} segmenti, {len(feasible_pairs)} coppie fattibili")
    report_progress("optimize", 35, f"{len(feasible_pairs)} coppie candidate")

    # ── Variabili pair ──
    pair_vars: dict[tuple[int, int], Any] = {}
    pair_types: dict[tuple[int, int], str] = {}
    for s1_idx, s2_idx, ptype in feasible_pairs:
        key = (s1_idx, s2_idx)
        pair_vars[key] = model.new_bool_var(f"pair_{s1_idx}_{s2_idx}")
        pair_types[key] = ptype

    # ── Vincoli: copertura ──
    for s in segments:
        involved = [single[s.idx]]
        for key, pv in pair_vars.items():
            if s.idx in key:
                involved.append(pv)
        model.add_exactly_one(involved)

    # ── Penalità nastro violato ──
    nastro_violation_penalty: dict[int, int] = {}
    forced_pair_count = 0
    for s_idx in too_long_for_single:
        has_pair = any(s_idx in key for key in pair_vars)
        seg = seg_by_idx[s_idx]
        _t = depot_transfer_min(seg.first_stop, clusters)
        _tb = depot_transfer_min(seg.last_stop, clusters)
        nastro_s = seg.work_min + pre_turno_for(_t) + _t + _tb
        excess = nastro_s - SHIFT_RULES["intero"]["maxNastro"]
        if has_pair:
            nastro_violation_penalty[s_idx] = excess * 500 * COST_SCALE
            forced_pair_count += 1
        else:
            nastro_violation_penalty[s_idx] = excess * 200 * COST_SCALE

    if forced_pair_count:
        log(f"CP-SAT v4: {forced_pair_count} segmenti penalizzati per nastro > intero max")

    # ── Conta turni per tipo ──
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

    # ── Obiettivo ──
    obj_terms: list[Any] = []

    for s in segments:
        _t = depot_transfer_min(s.first_stop, clusters)
        _tb = depot_transfer_min(s.last_stop, clusters)
        _pt = pre_turno_for(_t)
        nastro_s = s.work_min + _pt + _t + _tb

        # Pre/post BDS per single
        pp = bds.pre_post
        pre_post_bds = pp.pre_turno_deposito if _t > 0 else pp.pre_turno_cambio
        pre_post_bds += pp.post_turno_deposito if _tb > 0 else pp.post_turno_cambio

        work_with_overhead = s.work_min + pre_post_bds + _tb
        dev_from_target = abs(work_with_overhead - TARGET_WORK_MID)

        if nastro_s <= SUPPLEMENTO_NASTRO_MAX:
            cost_cents = int(rates.supplemento_daily * COST_SCALE)
        else:
            hours = work_with_overhead / 60.0
            cost_cents = int((hours * rates.hourly_rate
                             + dev_from_target * rates.work_imbalance_per_min) * COST_SCALE)

        obj_terms.append(cost_cents * single[s.idx])

    for key, pv in pair_vars.items():
        s1_idx, s2_idx = key
        s1, s2 = seg_by_idx[s1_idx], seg_by_idx[s2_idx]

        pp = bds.pre_post
        combined_work = (s1.work_min + s2.work_min
                        + pp.pre_turno_deposito + pp.post_turno_deposito
                        + pp.pre_ripresa + pp.post_ripresa
                        + DEPOT_TRANSFER_CENTRAL * 2)
        hours = combined_work / 60.0
        dev = abs(combined_work - TARGET_WORK_MID)

        cost_cents = int((hours * rates.hourly_rate
                         + dev * rates.work_imbalance_per_min
                         + rates.company_car_per_use) * COST_SCALE)

        obj_terms.append(cost_cents * pv)

    for s_idx, penalty in nastro_violation_penalty.items():
        obj_terms.append(penalty * single[s_idx])

    model.minimize(sum(obj_terms))

    # ── Solve ──
    solver = cp_model.CpSolver()
    solver.parameters.max_time_in_seconds = time_limit_sec
    solver.parameters.num_workers = 8
    solver.parameters.log_search_progress = False
    solver.parameters.random_seed = int(time.time()) % 10000
    solver.parameters.linearization_level = 2

    report_progress("optimize", 40, "Avvio CP-SAT v4...")
    t0 = time.time()
    status = solver.solve(model)
    elapsed = time.time() - t0

    status_name = {
        cp_model.OPTIMAL: "OPTIMAL",
        cp_model.FEASIBLE: "FEASIBLE",
        cp_model.INFEASIBLE: "INFEASIBLE",
        cp_model.MODEL_INVALID: "MODEL_INVALID",
        cp_model.UNKNOWN: "UNKNOWN",
    }.get(status, f"CODE_{status}")

    log(f"CP-SAT v4: status={status_name}, elapsed={elapsed:.1f}s, "
        f"obj={solver.objective_value if status in (cp_model.OPTIMAL, cp_model.FEASIBLE) else 'N/A'}")
    report_progress("optimize", 60, f"CP-SAT v4: {status_name} in {elapsed:.1f}s")

    if status not in (cp_model.OPTIMAL, cp_model.FEASIBLE):
        log("CP-SAT v4 infeasible — fallback a greedy")
        return greedy_fallback(blocks, segments, config, clusters, bds)

    # ── Estrai soluzione ──
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
            work = s1.work_min + s2.work_min + pt + transfer_back

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

    # ── Post-hoc: riclassifica con BDS ──
    for d in duties:
        classified = classify_duty(d, bds, clusters)
        if classified != d.duty_type:
            log(f"  {d.driver_id}: riclassificato {d.duty_type} → {classified}")
            d.duty_type = classified

    return duties


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
            work = s1.work_min + s2.work_min + pt + transfer_back

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
            handovers_out.append({
                "vehicleId": h.vehicle_id,
                "atMin": h.at_min,
                "atTime": min_to_time(h.at_min),
                "atStop": h.at_stop,
                "cluster": h.cluster,
                "clusterName": cluster_label,
                "role": "outgoing" if is_outgoing else "incoming",
                "otherDriver": h.incoming_driver if is_outgoing else h.outgoing_driver,
                "description": (
                    f"LASCIA bus {h.vehicle_id} AL TURNO {h.incoming_driver} a {cluster_label}"
                    if is_outgoing else
                    f"PRENDE bus {h.vehicle_id} DAL TURNO {h.outgoing_driver} a {cluster_label}"
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
    time_limit_sec = int(sys.argv[1]) if len(sys.argv) > 1 else 120
    raw = load_input()
    vehicle_shifts_raw = raw.get("vehicleShifts", [])
    user_config = raw.get("config", {})
    config = merge_config(user_config)
    clusters = parse_clusters_from_config(config)
    bds = BDSConfig.from_config(config)

    log(f"=== Crew Scheduler V4 (BDS) ===")
    log(f"Input: {len(vehicle_shifts_raw)} turni macchina, timeLimit={time_limit_sec}s")
    log(f"BDS config: pre/post={bds.pre_post.pre_turno_deposito}/{bds.pre_post.post_turno_deposito}, "
        f"CEE561={'ON' if bds.cee561.attivo else 'OFF'}, "
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

    # ── Fase 4: Ottimizzazione CP-SAT BDS ──
    duties = optimize_global(blocks, segments, config, time_limit_sec, clusters, bds)

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

    log(f"=== DONE in {elapsed:.1f}s — {n_total} turni, {n_suppl} supplementi "
        f"({n_suppl * 100 // max(n_total, 1)}%), €{output['summary']['totalDailyCost']:.0f}/giorno, "
        f"{n_viol} violazioni BDS ===")
    report_progress("done", 100, f"{n_total} turni, €{output['summary']['totalDailyCost']:.0f}/giorno")

    write_output(output)


if __name__ == "__main__":
    main()
