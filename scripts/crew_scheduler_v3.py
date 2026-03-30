#!/usr/bin/env python3
"""
crew_scheduler_v3.py — Vehicle-Shift-First (VSF) Crew Scheduler
Conerobus S.p.A. / TransitIntel

APPROCCIO:
  Non decomponiamo i turni macchina in task atomici.
  Partiamo dai ~90 turni macchina interi, li classifichiamo per durata,
  identifichiamo i punti di taglio ottimali (gap tra corse dove un
  cambio conducente è possibile), e risolviamo un CP-SAT compatto
  (~2000-3000 variabili binarie) che decide:
    - Quali tagli attivare
    - Come accoppiare i segmenti risultanti in turni guida validi CCNL
  
  Target: ~100-120 conducenti, ≤10% supplementi, €40-50k/giorno.

Pipeline:
  1. parse_vehicle_blocks   — JSON → VehicleBlock[]
  2. analyze_vehicle_block  — identifica punti di taglio e li valuta
  3. classify_blocks        — CORTO / CORTO_BASSO / MEDIO / LUNGO
  4. build_segments         — applica tagli, genera segmenti
  5. optimize_global        — CP-SAT: scelta tagli + pairing segmenti
  6. refine_with_cambi      — cambi in linea opzionali cross-vehicle
  7. validate_all           — verifica CCNL tutti i turni
  8. serialize_output       — JSON per il backend
"""

from __future__ import annotations

import json
import sys
import time
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
    # Dataclass
    VShiftTrip, VehicleShift, CambioInfo,
    VehicleBlock, CutCandidate, Segment, DriverDutyV3,
    Cluster, DEFAULT_CLUSTERS,
    # Funzioni
    match_cluster, cluster_by_id, depot_transfer_min,
    min_to_time, fmt_dur,
    load_input, write_output, log, report_progress,
    merge_config, parse_clusters_from_config,
)
from cost_model import CostRates, DutyCostBreakdown, compute_duty_cost


# ═══════════════════════════════════════════════════════════════
#  COSTANTI V3
# ═══════════════════════════════════════════════════════════════

# Classificazione turni macchina
NASTRO_INTERO_MAX = 435            # un solo conducente può coprire
DRIVING_BASSO_THRESHOLD = 120      # guida < 2h → supplemento / merge
NASTRO_LUNGO_THRESHOLD = 870       # >14h30 → 3 conducenti (2 tagli)

# Punteggi taglio
CUT_SCORE_GAP_BASE = 1.0          # base per gap ≥ 5 min
CUT_SCORE_GAP_BONUS_PER_MIN = 0.1 # per minuto di gap oltre 5
CUT_SCORE_CLUSTER_BONUS = 3.0     # fermata in un cluster
CUT_SCORE_BALANCE_MAX = 5.0       # massimo bonus bilanciamento
CUT_NASTRO_PENALTY_PER_MIN = 0.05 # penalità se nastro risultante > max
CUT_SAME_ROUTE_PENALTY = 15.0     # FORTE penalità se corse adiacenti sono sulla stessa linea
                                   # (es. 43 Ancona→Varano, 43 Varano→Ancona → non tagliare!)
CUT_NO_CLUSTER_PENALTY = 8.0      # penalità se la fermata NON è in un cluster definito

# Gap minimo per un taglio valido (min)
MIN_CUT_GAP = 3

# Supplemento: nastro max 150 min
SUPPLEMENTO_NASTRO_MAX = 150

# Scala costi per CP-SAT (centesimi)
COST_SCALE = 100


def pre_turno_for(transfer_min: int) -> int:
    """Pre-turno: 5 min se il conducente usa l'auto aziendale (transfer>0), 12 min altrimenti."""
    return PRE_TURNO_AUTO_MIN if transfer_min > 0 else PRE_TURNO_MIN


# ═══════════════════════════════════════════════════════════════
#  FASE 1: PARSING
# ═══════════════════════════════════════════════════════════════

def parse_vehicle_blocks(vehicle_shifts: list[dict], clusters: list[Cluster]) -> list[VehicleBlock]:
    """Converte i turni macchina JSON in VehicleBlock, filtrando solo le corse reali."""
    blocks: list[VehicleBlock] = []
    
    for vs_dict in vehicle_shifts:
        vid = vs_dict.get("vehicleId", "?")
        vtype = vs_dict.get("vehicleType", "12m")
        category = vs_dict.get("category", "urbano")
        
        # Filtra solo type=="trip"
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
        # work = driving + attese interne tra corse
        work = end - start  # approssimazione: nastro ≈ work per un singolo veicolo
        
        blocks.append(VehicleBlock(
            vehicle_id=vid,
            vehicle_type=vtype,
            category=category,
            trips=trips,
            start_min=start,
            end_min=end,
            nastro_min=end - start,
            driving_min=driving,
            work_min=work,
            classification="",  # verrà assegnato dopo
        ))
    
    blocks.sort(key=lambda b: b.start_min)
    return blocks


# ═══════════════════════════════════════════════════════════════
#  FASE 2: ANALISI & CLASSIFICAZIONE
# ═══════════════════════════════════════════════════════════════

def analyze_vehicle_block(block: VehicleBlock, clusters: list[Cluster]) -> None:
    """Identifica e valuta tutti i punti di taglio per un VehicleBlock."""
    trips = block.trips
    if len(trips) < 2:
        return
    
    candidates: list[CutCandidate] = []
    total_driving = block.driving_min
    
    # Pre-calcola driving cumulativo
    cum_driving = [0]  # cum_driving[i] = guida dalle trip 0..i-1
    for i, t in enumerate(trips):
        cum_driving.append(cum_driving[-1] + (t.arrival_min - t.departure_min))
    
    for i in range(len(trips) - 1):
        gap = trips[i + 1].departure_min - trips[i].arrival_min
        if gap < MIN_CUT_GAP:
            continue
        
        cut_time = trips[i].arrival_min
        stop_name = trips[i].last_stop_name
        cid = match_cluster(stop_name, clusters)
        transfer_cost = depot_transfer_min(stop_name, clusters)
        
        # Driving/work a sinistra e destra
        left_driving = cum_driving[i + 1]
        right_driving = total_driving - left_driving
        left_work = trips[i].arrival_min - trips[0].departure_min
        right_work = trips[-1].arrival_min - trips[i + 1].departure_min
        
        # ── Scoring ──
        score = 0.0
        
        # Bonus gap: più lungo il gap, meglio è
        if gap >= 5:
            score += CUT_SCORE_GAP_BASE + (gap - 5) * CUT_SCORE_GAP_BONUS_PER_MIN
        
        # Bonus cluster: cambio in linea possibile — è un capolinea CENTRALE
        if cid:
            score += CUT_SCORE_CLUSTER_BONUS
        else:
            # Forte penalità: tagliare fuori cluster = capolinea PERIFERICO
            # Il conducente non può essere raggiunto/sostituito facilmente.
            # Le linee Conerobus sono radiali: centro→periferia→centro.
            # Al capolinea periferico il bus fa solo inversione (sosta corta),
            # quindi il taglio lì è sempre sbagliato.
            score -= CUT_NO_CLUSTER_PENALTY
        
        # ── COMPRENSIONE STRUTTURA RADIALE ──
        # Le linee sono radiali: partono da zone centrali (cluster), vanno in
        # periferia, e tornano al centro. La sosta al capolinea periferico è
        # breve (inversione 3-8 min). Il bus fa SEMPRE andata+ritorno.
        #
        # Regola fondamentale: NON tagliare MAI al capolinea periferico.
        # Tagliare SOLO ai capolinea centrali (cluster) dove ci sono soste
        # più lunghe e il conducente può essere raggiunto.
        
        trip_before = trips[i]
        trip_after = trips[i + 1]
        
        # Caso 1: stessa linea, direzione diversa → inversione al capolinea periferico
        # Es: Linea 43 dir 0 (Ancona→Varano), poi Linea 43 dir 1 (Varano→Ancona)
        # MAI tagliare qui: il bus sta solo invertendo la marcia
        same_route = (trip_before.route_id and trip_after.route_id 
                      and trip_before.route_id == trip_after.route_id)
        diff_direction = trip_before.direction_id != trip_after.direction_id
        
        if same_route and diff_direction:
            # Inversione al capolinea periferico — penalità MASSIMA
            score -= CUT_SAME_ROUTE_PENALTY * 1.5
        elif same_route:
            # Stessa linea, stessa direzione — il bus ripete la stessa corsa
            # (es. 43 Ancona→Varano, poi di nuovo 43 Ancona→Varano)
            # Questo può succedere se il bus torna al centro (non registrato)
            # e riparte. Il gap potrebbe essere significativo.
            if not cid:
                score -= CUT_SAME_ROUTE_PENALTY
            else:
                # Stessa linea MA al cluster (centro) — potrebbe essere ok
                # se il gap è sufficientemente lungo
                if gap < 15:
                    score -= CUT_SAME_ROUTE_PENALTY * 0.5
        
        # Caso 2: linee diverse, ma fermata NON è un cluster
        # Significa che siamo a un capolinea periferico dove due linee
        # si incrociano casualmente. Comunque non è un buon posto per tagliare.
        if not same_route and not cid:
            score -= CUT_NO_CLUSTER_PENALTY * 0.5  # penalità aggiuntiva
        
        # Bonus bilanciamento: quanto i due segmenti sono bilanciati
        if total_driving > 0:
            balance = 1.0 - abs(left_driving - right_driving) / total_driving
            score += balance * CUT_SCORE_BALANCE_MAX
        
        # Penalità nastro: se il segmento risultante supera il max intero
        # transfer_cost ≈ sia andata che ritorno (stessa durata)
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
    
    # Ordina per score decrescente
    candidates.sort(key=lambda c: -c.score)
    block.cut_candidates = candidates


def filter_cuts_by_cluster(blocks: list[VehicleBlock], config: dict) -> None:
    """Se cutOnlyAtClusters=true, rimuove i punti di taglio non su cluster definiti."""
    cut_only = config.get("cutOnlyAtClusters", True)  # default: solo su cluster
    if not cut_only:
        return
    
    for b in blocks:
        original = len(b.cut_candidates)
        b.cut_candidates = [c for c in b.cut_candidates if c.allows_cambio]
        filtered = original - len(b.cut_candidates)
        if filtered > 0:
            log(f"  {b.vehicle_id}: rimossi {filtered}/{original} tagli non su cluster")


def classify_blocks(blocks: list[VehicleBlock], clusters: list[Cluster]) -> None:
    """Classifica ogni blocco in CORTO, CORTO_BASSO, MEDIO, LUNGO.
    Usa il trasferimento reale (basato sulla fermata di partenza) per calcolare il nastro."""
    for b in blocks:
        # Trasferimento reale basato su prima/ultima fermata
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
#  FASE 2B: COSTRUZIONE SEGMENTI
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
    """Costruisce un Segment da una lista di trip."""
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
    """
    Seleziona il miglior punto di taglio per un blocco MEDIO.
    Priorità: entrambi i segmenti devono avere nastro ≤ 435 (INTERO max).
    Tra quelli validi, sceglie quello con score più alto.
    Se nessuno produce due segmenti validi, sceglie il migliore in assoluto.
    """
    max_nastro = SHIFT_RULES["intero"]["maxNastro"]
    valid_cuts: list[CutCandidate] = []
    
    for c in b.cut_candidates:
        # Calcola nastro reale dei due segmenti risultanti (con rientro)
        left_first_stop = b.trips[0].first_stop_name
        left_last_stop = b.trips[c.index].last_stop_name
        right_first_stop = b.trips[c.index + 1].first_stop_name
        right_last_stop = b.trips[-1].last_stop_name
        
        lt_out = depot_transfer_min(left_first_stop, clusters)
        lt_back = depot_transfer_min(left_last_stop, clusters)
        rt_out = depot_transfer_min(right_first_stop, clusters)
        rt_back = depot_transfer_min(right_last_stop, clusters)
        left_nastro = c.left_work_min + pre_turno_for(lt_out) + lt_out + lt_back
        right_nastro = c.right_work_min + pre_turno_for(rt_out) + rt_out + rt_back
        
        if left_nastro <= max_nastro and right_nastro <= max_nastro:
            valid_cuts.append(c)
    
    if valid_cuts:
        return max(valid_cuts, key=lambda c: c.score)
    
    # Nessun taglio produce due intero validi — prendi il migliore che minimizza il nastro peggiore
    if b.cut_candidates:
        def worst_nastro(c: CutCandidate) -> int:
            left_first = b.trips[0].first_stop_name
            left_last = b.trips[c.index].last_stop_name
            right_first = b.trips[c.index + 1].first_stop_name
            right_last = b.trips[-1].last_stop_name
            lt_o = depot_transfer_min(left_first, clusters)
            lt_b = depot_transfer_min(left_last, clusters)
            rt_o = depot_transfer_min(right_first, clusters)
            rt_b = depot_transfer_min(right_last, clusters)
            ln = c.left_work_min + pre_turno_for(lt_o) + lt_o + lt_b
            rn = c.right_work_min + pre_turno_for(rt_o) + rt_o + rt_b
            return max(ln, rn)
        return min(b.cut_candidates, key=worst_nastro)
    
    return None


def build_initial_segments(blocks: list[VehicleBlock], clusters: list[Cluster]) -> list[Segment]:
    """
    Genera i segmenti iniziali in base alla classificazione:
      - CORTO:       1 segmento "full" (un intero)
      - CORTO_BASSO: 1 segmento "full" (supplemento o merge)
      - MEDIO:       2 segmenti "first"+"second" usando il miglior taglio valido
      - LUNGO:       3 segmenti usando i 2 migliori tagli
    """
    global _seg_counter
    _seg_counter = 0
    all_segments: list[Segment] = []
    
    for b in blocks:
        if b.classification == "CORTO":
            seg = _make_segment(b.vehicle_id, b.vehicle_type, b.trips, "full", None, clusters)
            b.segments = [seg]
            all_segments.append(seg)
        
        elif b.classification == "CORTO_BASSO":
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
                # Nessun taglio valido: forza come full (sarà molto lungo)
                seg = _make_segment(b.vehicle_id, b.vehicle_type, b.trips, "full", None, clusters)
                b.segments = [seg]
                all_segments.append(seg)
        
        elif b.classification == "LUNGO":
            # Trova la migliore coppia di tagli che produce 3 segmenti ciascuno ≤ nastro intero
            max_nastro = SHIFT_RULES["intero"]["maxNastro"]
            best_pair_cuts = None
            best_pair_score = -999
            
            cands = b.cut_candidates
            for ci in range(len(cands)):
                for cj in range(ci + 1, len(cands)):
                    c1_raw, c2_raw = cands[ci], cands[cj]
                    # Ordina per posizione
                    if c1_raw.index > c2_raw.index:
                        c1_raw, c2_raw = c2_raw, c1_raw
                    
                    left_work = c1_raw.left_work_min
                    right_work = c2_raw.right_work_min
                    mid_start = b.trips[c1_raw.index + 1].departure_min
                    mid_end = b.trips[c2_raw.index].arrival_min
                    mid_work = mid_end - mid_start if mid_end > mid_start else 0
                    
                    left_first = b.trips[0].first_stop_name
                    left_last = b.trips[c1_raw.index].last_stop_name
                    mid_first = b.trips[c1_raw.index + 1].first_stop_name if c1_raw.index + 1 < len(b.trips) else ""
                    mid_last = b.trips[c2_raw.index].last_stop_name
                    right_first = b.trips[c2_raw.index + 1].first_stop_name if c2_raw.index + 1 < len(b.trips) else ""
                    right_last = b.trips[-1].last_stop_name
                    
                    lt = depot_transfer_min(left_first, clusters)
                    lt_b = depot_transfer_min(left_last, clusters)
                    mt = depot_transfer_min(mid_first, clusters)
                    mt_b = depot_transfer_min(mid_last, clusters)
                    rt = depot_transfer_min(right_first, clusters)
                    rt_b = depot_transfer_min(right_last, clusters)
                    ln = left_work + pre_turno_for(lt) + lt + lt_b
                    mn = mid_work + pre_turno_for(mt) + mt + mt_b
                    rn = right_work + pre_turno_for(rt) + rt + rt_b
                    
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
            elif len(b.cut_candidates) >= 1:
                # Solo 1+ taglio ma non trovata coppia valida: tratta come MEDIO
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
            else:
                seg = _make_segment(b.vehicle_id, b.vehicle_type, b.trips, "full", None, clusters)
                b.segments = [seg]
                all_segments.append(seg)
    
    return all_segments


# ═══════════════════════════════════════════════════════════════
#  FASE 3: OTTIMIZZAZIONE GLOBALE CP-SAT
# ═══════════════════════════════════════════════════════════════

def _nastro_of_pair(s1: Segment, s2: Segment) -> int:
    """Nastro se due segmenti formano un turno con interruzione."""
    return max(s1.end_min, s2.end_min) - min(s1.start_min, s2.start_min)


def _interruption_of_pair(s1: Segment, s2: Segment) -> int:
    """Interruzione tra due segmenti (gap tra fine primo e inizio secondo)."""
    if s1.end_min <= s2.start_min:
        return s2.start_min - s1.end_min
    elif s2.end_min <= s1.start_min:
        return s1.start_min - s2.end_min
    return 0  # si sovrappongono — non valido


def _feasible_pair(s1: Segment, s2: Segment, rules: dict) -> str | None:
    """
    Verifica se due segmenti possono formare un turno guida biripresa.
    Restituisce il tipo ("semiunico" o "spezzato") se fattibile, None altrimenti.
    
    VINCOLO CLUSTER: se i segmenti sono su veicoli diversi, serve un handover.
    L'handover può avvenire SOLO a fermate in un cluster definito.
    Quindi: last_cluster di s1 E first_cluster di s2 devono essere non-None.
    """
    # Ordina per tempo
    if s1.start_min > s2.start_min:
        s1, s2 = s2, s1
    
    interruption = s2.start_min - s1.end_min
    if interruption < 0:
        return None  # sovrapposti
    
    # ── VINCOLO CLUSTER per veicoli diversi ──
    # Se i due segmenti sono su veicoli diversi, il conducente deve:
    # - lasciare il bus del seg1 all'ultimo capolinea → deve essere in cluster
    # - prendere il bus del seg2 al primo capolinea → deve essere in cluster
    if s1.vehicle_id != s2.vehicle_id:
        if not s1.last_cluster or not s2.first_cluster:
            return None  # handover impossibile: fermate fuori cluster
    
    nastro = s2.end_min - s1.start_min + pre_turno_for(DEPOT_TRANSFER_CENTRAL) + DEPOT_TRANSFER_CENTRAL + DEPOT_TRANSFER_CENTRAL
    work = s1.work_min + s2.work_min + pre_turno_for(DEPOT_TRANSFER_CENTRAL) + DEPOT_TRANSFER_CENTRAL + DEPOT_TRANSFER_CENTRAL
    
    # Prova semiunico
    sr = rules.get("semiunico", SHIFT_RULES["semiunico"])
    if (sr["intMin"] <= interruption <= sr["intMax"]
            and nastro <= sr["maxNastro"]
            and work >= 180):  # almeno 3h lavoro totale
        return "semiunico"
    
    # Prova spezzato
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
) -> list[DriverDutyV3]:
    """
    CP-SAT compatto:
    
    Variabili:
      - single[s]:    segmento s coperto da un conducente SOLO (intero o supplemento)
      - pair[s1,s2]:  segmenti s1,s2 coperti dallo STESSO conducente (semiunico/spezzato)
    
    Vincoli:
      - Ogni segmento coperto esattamente 1 volta (single OPPURE in esattamente 1 pair)
      - Limiti percentuali per tipo (supplementi ≤ 10%)
    
    Obiettivo:
      - Minimizzare: n_conducenti + penalità_costo
    """
    rules = config.get("shiftRules", SHIFT_RULES)
    rates = CostRates.from_config(config)
    
    report_progress("optimize", 30, f"CP-SAT: {len(segments)} segmenti")
    
    model = cp_model.CpModel()
    
    n_seg = len(segments)
    seg_by_idx = {s.idx: s for s in segments}
    
    # ── Variabili single ──
    single: dict[int, Any] = {}
    for s in segments:
        single[s.idx] = model.new_bool_var(f"single_{s.idx}")
    
    # ── Vincoli nastro: segmenti troppo lunghi per intero NON possono essere single ──
    # (a meno che siano supplemento, cioè nastro ≤ 150)
    too_long_for_single: set[int] = set()
    for s in segments:
        _t = depot_transfer_min(s.first_stop, clusters)
        _tb = depot_transfer_min(s.last_stop, clusters)
        nastro_s = s.work_min + pre_turno_for(_t) + _t + _tb
        is_suppl = nastro_s <= SUPPLEMENTO_NASTRO_MAX
        intero_max = rules.get("intero", SHIFT_RULES["intero"]).get("maxNastro", 435)
        if not is_suppl and nastro_s > intero_max:
            too_long_for_single.add(s.idx)
    
    # ── Identifica coppie fattibili ──
    feasible_pairs: list[tuple[int, int, str]] = []  # (s1.idx, s2.idx, tipo)
    
    for i in range(n_seg):
        for j in range(i + 1, n_seg):
            s1, s2 = segments[i], segments[j]
            
            # Ottimizzazione: skip se troppo distanti nel tempo
            gap_between = abs(s1.start_min - s2.end_min)
            if gap_between > 700:  # >11h: impossibile in un nastro
                continue
            if s1.end_min > s2.start_min and s2.end_min > s1.start_min:
                continue  # si sovrappongono
            
            pair_type = _feasible_pair(s1, s2, rules)
            if pair_type:
                feasible_pairs.append((s1.idx, s2.idx, pair_type))
    
    log(f"CP-SAT v3: {n_seg} segmenti, {len(feasible_pairs)} coppie fattibili")
    report_progress("optimize", 35, f"{len(feasible_pairs)} coppie candidate")
    
    # ── Variabili pair ──
    pair_vars: dict[tuple[int, int], Any] = {}
    pair_types: dict[tuple[int, int], str] = {}
    for s1_idx, s2_idx, ptype in feasible_pairs:
        key = (s1_idx, s2_idx)
        pair_vars[key] = model.new_bool_var(f"pair_{s1_idx}_{s2_idx}")
        pair_types[key] = ptype
    
    # ── Vincoli: ogni segmento coperto esattamente 1 volta ──
    for s in segments:
        involved = [single[s.idx]]
        for key, pv in pair_vars.items():
            if s.idx in key:
                involved.append(pv)
        model.add_exactly_one(involved)
    
    # ── Vincoli: segmenti troppo lunghi per intero — penalizzare (soft) o forzare (hard) in pair ──
    forced_pair_count = 0
    # Li penalizziamo pesantemente nell'obiettivo invece di forzare hard constraint
    # così il solver trova comunque una soluzione feasible
    nastro_violation_penalty: dict[int, int] = {}
    for s_idx in too_long_for_single:
        has_pair = any(s_idx in key for key in pair_vars)
        seg = seg_by_idx[s_idx]
        _t = depot_transfer_min(seg.first_stop, clusters)
        _tb = depot_transfer_min(seg.last_stop, clusters)
        nastro_s = seg.work_min + pre_turno_for(_t) + _t + _tb
        excess = nastro_s - SHIFT_RULES["intero"]["maxNastro"]
        if has_pair:
            # Forte penalità per disincentivare il singolo
            nastro_violation_penalty[s_idx] = excess * 500 * COST_SCALE  # €5/min excess * 100
            forced_pair_count += 1
        else:
            # Nessun pair: penalità ma non infeasible
            nastro_violation_penalty[s_idx] = excess * 200 * COST_SCALE
    
    if forced_pair_count:
        log(f"CP-SAT v3: {forced_pair_count} segmenti penalizzati per nastro > intero max ({len(too_long_for_single)} totali troppo lunghi)")
    
    # ── Conta turni per tipo ──
    n_intero = []
    n_supplemento = []
    n_semi = []
    n_spezzato = []
    
    # Single → determinare se intero o supplemento
    for s in segments:
        # È supplemento SOLO se il nastro (lavoro + pre-turno + trasferimento) ≤ 150 min
        # La poca guida da sola non basta — il nastro deve essere corto
        _t_out = depot_transfer_min(s.first_stop, clusters)
        _t_back = depot_transfer_min(s.last_stop, clusters)
        nastro_single = s.work_min + pre_turno_for(_t_out) + _t_out + _t_back
        if nastro_single <= SUPPLEMENTO_NASTRO_MAX:
            n_supplemento.append(single[s.idx])
        else:
            n_intero.append(single[s.idx])
    
    for key, pv in pair_vars.items():
        ptype = pair_types[key]
        if ptype == "semiunico":
            n_semi.append(pv)
        else:
            n_spezzato.append(pv)
    
    # ── Conta turni totali ──
    total_duties = model.new_int_var(0, n_seg, "total_duties")
    model.add(total_duties == sum(single.values()) + sum(pair_vars.values()))
    
    # ── Vincolo: supplementi ≤ 10% dei turni totali ──
    # suppl_count ≤ 0.10 * total → 10 * suppl_count ≤ total
    if n_supplemento:
        suppl_count = model.new_int_var(0, n_seg, "suppl_count")
        model.add(suppl_count == sum(n_supplemento))
        model.add(10 * suppl_count <= total_duties)
    
    # ── Vincolo: semiunico ≤ 12%, spezzato ≤ 13% ──
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
    
    # ── Obiettivo: minimizzare conducenti + penalità qualità ──
    
    # Costo per singolo (intero ≈ 6.5h retribuzione + extra_driver)
    obj_terms: list[Any] = []
    
    for s in segments:
        _t = depot_transfer_min(s.first_stop, clusters)
        _tb = depot_transfer_min(s.last_stop, clusters)
        _pt = pre_turno_for(_t)
        nastro_s = s.work_min + _pt + _t + _tb
        
        # Penalità: quanto il segmento devia dal target 6h30
        work_with_overhead = s.work_min + _pt + _tb
        dev_from_target = abs(work_with_overhead - TARGET_WORK_MID)
        
        if nastro_s <= SUPPLEMENTO_NASTRO_MAX:
            # Supplemento: costo fisso supplemento
            cost_cents = int(rates.supplemento_daily * COST_SCALE)
        else:
            # Intero: retribuzione oraria * ore + penalità deviazione
            hours = work_with_overhead / 60.0
            cost_cents = int((hours * rates.hourly_rate + dev_from_target * rates.work_imbalance_per_min) * COST_SCALE)
        
        obj_terms.append(cost_cents * single[s.idx])
    
    # Costo per coppia (una coppia = 1 conducente con 2 riprese)
    for key, pv in pair_vars.items():
        s1_idx, s2_idx = key
        s1, s2 = seg_by_idx[s1_idx], seg_by_idx[s2_idx]
        
        combined_work = s1.work_min + s2.work_min + pre_turno_for(DEPOT_TRANSFER_CENTRAL) + DEPOT_TRANSFER_CENTRAL + DEPOT_TRANSFER_CENTRAL
        hours = combined_work / 60.0
        dev = abs(combined_work - TARGET_WORK_MID)
        
        cost_cents = int((hours * rates.hourly_rate
                          + dev * rates.work_imbalance_per_min
                          + rates.company_car_per_use  # trasferimento per la ripresa extra
                          ) * COST_SCALE)
        
        obj_terms.append(cost_cents * pv)
    
    # ── Penalità per segmenti troppo lunghi come single ──
    for s_idx, penalty in nastro_violation_penalty.items():
        obj_terms.append(penalty * single[s_idx])
    
    model.minimize(sum(obj_terms))
    
    # ── Solve ──
    solver = cp_model.CpSolver()
    # Usa il tempo completo passato dall'utente (default 120s)
    solver.parameters.max_time_in_seconds = time_limit_sec
    solver.parameters.num_workers = 8
    solver.parameters.log_search_progress = False
    # Diversificazione: seed basato sul timestamp per evitare
    # di ottenere sempre la stessa identica soluzione
    solver.parameters.random_seed = int(time.time()) % 10000
    # Esplora più soluzioni per trovare quella migliore
    solver.parameters.enumerate_all_solutions = False
    # Linearization level più aggressivo per problemi piccoli
    solver.parameters.linearization_level = 2
    
    report_progress("optimize", 40, "Avvio CP-SAT...")
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
    
    log(f"CP-SAT v3: status={status_name}, elapsed={elapsed:.1f}s, obj={solver.objective_value if status in (cp_model.OPTIMAL, cp_model.FEASIBLE) else 'N/A'}")
    report_progress("optimize", 60, f"CP-SAT: {status_name} in {elapsed:.1f}s")
    
    if status not in (cp_model.OPTIMAL, cp_model.FEASIBLE):
        log("CP-SAT infeasible/unknown — fallback a greedy")
        return greedy_fallback(blocks, segments, config, clusters)
    
    # ── Estrai soluzione ──
    duties: list[DriverDutyV3] = []
    duty_idx = 0
    
    for s in segments:
        if solver.value(single[s.idx]):
            transfer = depot_transfer_min(s.first_stop, clusters)
            transfer_back = depot_transfer_min(s.last_stop, clusters)
            pt = pre_turno_for(transfer)
            nastro_s = s.work_min + pt + transfer + transfer_back
            
            if nastro_s <= SUPPLEMENTO_NASTRO_MAX:
                dtype = "supplemento"
            else:
                dtype = "intero"
            
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
            
            # Ordina per tempo
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
    
    return duties


# ═══════════════════════════════════════════════════════════════
#  GREEDY FALLBACK
# ═══════════════════════════════════════════════════════════════

def greedy_fallback(
    blocks: list[VehicleBlock],
    segments: list[Segment],
    config: dict,
    clusters: list[Cluster],
) -> list[DriverDutyV3]:
    """
    Fallback greedy se CP-SAT non trova soluzione.
    Ogni segmento diventa un turno guida singolo.
    Poi prova pairing greedy per ridurre i conducenti.
    """
    rules = config.get("shiftRules", SHIFT_RULES)
    duties: list[DriverDutyV3] = []
    used: set[int] = set()
    duty_idx = 0
    
    # Ordina per start_min
    sorted_segs = sorted(segments, key=lambda s: s.start_min)
    
    # Pass 1: prova pairing greedy (segmenti mattina + pomeriggio)
    morning = [s for s in sorted_segs if s.end_min <= 840]  # prima delle 14:00
    afternoon = [s for s in sorted_segs if s.start_min >= 720]  # dopo le 12:00
    
    for sm in morning:
        if sm.idx in used:
            continue
        best_pair = None
        best_type = None
        best_score = -1
        
        for sa in afternoon:
            if sa.idx in used or sa.idx == sm.idx:
                continue
            ptype = _feasible_pair(sm, sa, rules)
            if ptype:
                # Score: preferisci paire che bilanciano le ore
                combined_work = sm.work_min + sa.work_min
                dev = abs(combined_work + pre_turno_for(DEPOT_TRANSFER_CENTRAL) + DEPOT_TRANSFER_CENTRAL - TARGET_WORK_MID)
                score = 1000 - dev
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
            
            duties.append(DriverDutyV3(
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
            ))
            used.add(sm.idx)
            used.add(best_pair.idx)
            duty_idx += 1
    
    # Pass 2: segmenti rimasti → intero o supplemento
    for s in sorted_segs:
        if s.idx in used:
            continue
        
        transfer = depot_transfer_min(s.first_stop, clusters)
        transfer_back = depot_transfer_min(s.last_stop, clusters)
        pt = pre_turno_for(transfer)
        nastro_s = s.work_min + pt + transfer + transfer_back
        
        if nastro_s <= SUPPLEMENTO_NASTRO_MAX:
            dtype = "supplemento"
        else:
            dtype = "intero"
        
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
        used.add(s.idx)
        duty_idx += 1
    
    return duties


# ═══════════════════════════════════════════════════════════════
#  FASE 4A: RAFFINAMENTO CAMBI IN LINEA
# ═══════════════════════════════════════════════════════════════

def refine_with_cambi(
    duties: list[DriverDutyV3],
    clusters: list[Cluster],
    config: dict,
) -> list[DriverDutyV3]:
    """
    Post-processing: cerca opportunità di cambio in linea cross-vehicle
    dove due conducenti si scambiano veicoli a un cluster comune.
    Questo è un raffinamento opzionale — se non migliora, non applica.
    """
    # Per ora, skip — il pairing CP-SAT già copre i casi principali.
    # Implementazione futura: scambio tra turni che condividono una fermata cluster
    # nello stesso intervallo temporale.
    return duties


# ═══════════════════════════════════════════════════════════════
#  FASE 4B: VALIDAZIONE CCNL
# ═══════════════════════════════════════════════════════════════

def validate_duty(duty: DriverDutyV3, rules: dict) -> list[str]:
    """Valida un turno guida contro le regole CCNL. Ritorna lista di violazioni."""
    violations: list[str] = []
    dtype = duty.duty_type
    rule = rules.get(dtype, SHIFT_RULES.get(dtype, {}))
    
    # Nastro massimo (con tolleranza operativa di 15min per turni intero)
    max_nastro = rule.get("maxNastro", 999)
    tolerance = 15 if dtype == "intero" else 5
    if duty.nastro_min > max_nastro + tolerance:
        violations.append(f"nastro {duty.nastro_min}min > max {max_nastro}min (+{duty.nastro_min - max_nastro})")
    
    # Interruzione
    if dtype in ("semiunico", "spezzato"):
        int_min = rule.get("intMin", 0)
        int_max = rule.get("intMax", 999)
        if duty.interruption_min < int_min:
            violations.append(f"interruzione {duty.interruption_min}min < min {int_min}min")
        if duty.interruption_min > int_max:
            violations.append(f"interruzione {duty.interruption_min}min > max {int_max}min")
    
    # Guida continuativa (usa soglia pratica: gap ≥ 10min conta come pausa)
    PRACTICAL_BREAK_MIN = 10  # nella pratica gap ≥ 10min al capolinea è una pausa
    for seg in duty.segments:
        continuous = 0
        for i, t in enumerate(seg.trips):
            dur = t.arrival_min - t.departure_min
            continuous += dur
            if continuous > MAX_CONTINUOUS_DRIVING:
                violations.append(f"guida continua {continuous}min > {MAX_CONTINUOUS_DRIVING}min in seg {seg.idx}")
                break
            # Reset se gap ≥ soglia pratica
            if i + 1 < len(seg.trips):
                gap = seg.trips[i + 1].departure_min - t.arrival_min
                if gap >= PRACTICAL_BREAK_MIN:
                    continuous = 0
    
    return violations


def validate_all(duties: list[DriverDutyV3], config: dict) -> dict:
    """Valida tutti i turni. Ritorna stats + lista violazioni."""
    rules = config.get("shiftRules", SHIFT_RULES)
    total_violations = 0
    duty_violations: dict[str, list[str]] = {}
    
    for d in duties:
        viol = validate_duty(d, rules)
        if viol:
            duty_violations[d.driver_id] = viol
            total_violations += len(viol)
    
    return {
        "totalViolations": total_violations,
        "dutiesWithViolations": len(duty_violations),
        "details": duty_violations,
    }


# ═══════════════════════════════════════════════════════════════
#  FASE 4D: CALCOLO HANDOVER (cambi bus tra conducenti)
# ═══════════════════════════════════════════════════════════════

@dataclass
class Handover:
    """Un cambio fisico di bus tra due conducenti al capolinea."""
    vehicle_id: str
    at_min: int            # minuto del cambio
    at_stop: str           # fermata/capolinea dove avviene
    cluster: str | None    # cluster di riferimento
    outgoing_driver: str   # conducente che LASCIA il bus
    outgoing_seg_end: int  # fine segmento del conducente uscente
    incoming_driver: str   # conducente che PRENDE il bus
    incoming_seg_start: int  # inizio segmento del conducente entrante
    car_driver_to: str     # chi PORTA l'auto aziendale al capolinea (= incoming)
    car_driver_from: str   # chi RIPORTA l'auto al deposito (= outgoing)


def compute_handovers(
    duties: list[DriverDutyV3],
    clusters: list[Cluster],
) -> list[Handover]:
    """
    Identifica tutti i punti dove un bus cambia conducente.
    
    Logica: se due conducenti diversi hanno segmenti sullo stesso vehicle_id,
    e i segmenti sono consecutivi (fine A ≈ inizio B), c'è un handover.
    
    Il conducente B arriva con l'auto aziendale, prende il bus.
    Il conducente A rientra al deposito con l'auto aziendale.
    """
    # Mappa: vehicle_id → lista di (segment, duty)
    vehicle_segments: dict[str, list[tuple[Segment, DriverDutyV3]]] = {}
    for d in duties:
        for seg in d.segments:
            vehicle_segments.setdefault(seg.vehicle_id, []).append((seg, d))
    
    handovers: list[Handover] = []
    
    for vid, seg_list in vehicle_segments.items():
        if len(seg_list) < 2:
            continue
        
        # Ordina per tempo di inizio
        seg_list.sort(key=lambda x: x[0].start_min)
        
        for i in range(len(seg_list) - 1):
            seg_out, duty_out = seg_list[i]
            seg_in, duty_in = seg_list[i + 1]
            
            # Verifica che siano conducenti diversi
            if duty_out.driver_id == duty_in.driver_id:
                continue
            
            # Il punto di cambio è alla fine del segmento uscente / inizio entrante
            at_stop = seg_out.last_stop or seg_in.first_stop or "?"
            cluster_id = seg_out.last_cluster or seg_in.first_cluster
            
            if not cluster_id:
                log(f"❌ Handover bus {vid} a '{at_stop}' ({min_to_time(seg_out.end_min)}) "
                    f"NON è in un cluster definito — SKIP! "
                    f"({duty_out.driver_id} → {duty_in.driver_id})")
                continue  # non creare handover fuori cluster
            
            handovers.append(Handover(
                vehicle_id=vid,
                at_min=seg_out.end_min,
                at_stop=at_stop,
                cluster=cluster_id,
                outgoing_driver=duty_out.driver_id,
                outgoing_seg_end=seg_out.end_min,
                incoming_driver=duty_in.driver_id,
                incoming_seg_start=seg_in.start_min,
                car_driver_to=duty_in.driver_id,    # entrante porta l'auto
                car_driver_from=duty_out.driver_id,  # uscente riporta l'auto
            ))
    
    handovers.sort(key=lambda h: h.at_min)
    return handovers


def serialize_handovers(handovers: list[Handover], clusters: list[Cluster]) -> list[dict]:
    cluster_names = {c.id: c.name for c in clusters}
    return [
        {
            "vehicleId": h.vehicle_id,
            "atMin": h.at_min,
            "atTime": min_to_time(h.at_min),
            "atStop": h.at_stop,
            "cluster": h.cluster,
            "clusterName": cluster_names.get(h.cluster or "", h.cluster or ""),
            "outgoingDriver": h.outgoing_driver,
            "incomingDriver": h.incoming_driver,
            "carDriverTo": h.car_driver_to,
            "carDriverFrom": h.car_driver_from,
            "description": (
                f"Bus {h.vehicle_id}: "
                f"{h.incoming_driver} viene portato al capolinea con auto aziendale, prende il bus. "
                f"{h.outgoing_driver} viene riportato al deposito con auto aziendale."
            ),
        }
        for h in handovers
    ]


# ═══════════════════════════════════════════════════════════════
#  FASE 4D-bis: CAR POOL (accoppiamento auto aziendali)
# ═══════════════════════════════════════════════════════════════
#
#  MODELLO REALE:
#  - L'autista che INIZIA il turno a un cluster prende un'auto aziendale
#    dal deposito, la guida fino al cluster, la LASCIA LÌ.
#  - L'autista che FINISCE il turno a un cluster PRENDE un'auto che
#    si trova al cluster e la guida fino al deposito.
#  - Le auto vengono matchate per cluster: quelle portate da chi inizia
#    sono disponibili per chi finisce.
#  - Un'auto può servire più persone: A la porta, poi B (e C) la usano.
#
#  Con 5 auto aziendali, bisogna verificare che non ci siano
#  più di 5 auto fuori deposito contemporaneamente.
#
#  MODELLO REALE:
#  - DELIVER: un autista che INIZIA il turno a un cluster prende un'auto
#    dal deposito, guida fino al cluster, lascia l'auto AL CLUSTER.
#  - PICKUP: un autista che FINISCE il turno a un cluster prende un'auto
#    che si trova AL CLUSTER, guida fino al deposito, la riporta.
#  - Le auto vengono matchate per cluster: quelle lasciate dai deliver
#    vengono poi prese dai pickup.
#  - Un'auto può servire più autisti: A la porta al cluster, poi B (e C)
#    che finiscono al cluster la usano per tornare.

@dataclass
class CarTrip:
    """Un singolo viaggio con auto aziendale (autista guida personalmente)."""
    driver_id: str          # conducente che guida l'auto
    cluster_id: str | None  # cluster
    cluster_name: str       # nome leggibile
    stop_name: str          # fermata specifica
    trip_type: str          # "deliver" = deposito→cluster, "pickup" = cluster→deposito
    depart_min: int         # minuto partenza
    arrive_min: int         # minuto arrivo
    transfer_min: int       # durata tratta
    car_id: int | None = None  # auto assegnata (1-5), None se conflitto


def compute_car_pool(
    duties: list[DriverDutyV3],
    clusters: list[Cluster],
) -> list[CarTrip]:
    """
    Calcola tutti i viaggi auto aziendale necessari.

    Per ogni RIPRESA (segmento) di un turno:
      - Se il conducente deve raggiungere un capolinea dal deposito → DELIVER
        (guida auto deposito→cluster, la lascia lì)
      - Se il conducente finisce a un capolinea e deve tornare al deposito → PICKUP
        (prende auto dal cluster, guida cluster→deposito)

    Turno singolo (1 segmento):
      • DELIVER: deposito → primo cluster   (durata = transfer_min)
      • PICKUP:  ultimo cluster → deposito   (durata = transfer_back_min)

    Turno biripresa - STESSO veicolo su entrambi i segmenti:
      • DELIVER: deposito → primo cluster del seg1   (durata = transfer_min)
      • PICKUP:  ultimo cluster del seg2 → deposito  (durata = transfer_back_min)
      (durante l'interruzione il conducente resta col bus — nessun viaggio auto)

    Turno biripresa - VEICOLI DIVERSI:
      • DELIVER₁: deposito → primo cluster seg1      (transfer_min)
      • PICKUP₁:  ultimo cluster seg1 → deposito     (transfer da ultimo cluster seg1)
      • DELIVER₂: deposito → primo cluster seg2      (transfer da primo cluster seg2)
      • PICKUP₂:  ultimo cluster seg2 → deposito     (transfer_back_min)
      (durante l'interruzione il conducente torna al deposito e poi riparte)

    L'assegnazione auto avviene con simulazione cronologica:
    - Ogni auto ha una posizione (deposito o cluster X).
    - DELIVER: auto esce dal deposito, arriva al cluster.
    - PICKUP: auto esce dal cluster, rientra al deposito.
    """
    cluster_names = {c.id: c.name for c in clusters}

    trips: list[CarTrip] = []

    for d in duties:
        if not d.segments:
            continue

        n_segs = len(d.segments)
        same_vehicle = n_segs == 1 or (
            n_segs == 2 and d.segments[0].vehicle_id == d.segments[1].vehicle_id
        )

        if same_vehicle:
            # ── Singolo o biripresa su stesso veicolo ──
            # Solo DELIVER all'inizio e PICKUP alla fine
            first_seg = d.segments[0]
            last_seg = d.segments[-1]
            t_out = d.transfer_min       # deposito → primo cluster
            t_back = d.transfer_back_min  # ultimo cluster → deposito

            first_cluster = first_seg.first_cluster
            last_cluster = last_seg.last_cluster

            # DELIVER
            if t_out > 0 and first_cluster:
                trips.append(CarTrip(
                    driver_id=d.driver_id,
                    cluster_id=first_cluster,
                    cluster_name=cluster_names.get(first_cluster, first_seg.first_stop or "?"),
                    stop_name=first_seg.first_stop or "?",
                    trip_type="deliver",
                    depart_min=first_seg.start_min - t_out,
                    arrive_min=first_seg.start_min,
                    transfer_min=t_out,
                ))
            elif t_out > 0:
                log(f"⚠️  Car pool: {d.driver_id} prima fermata '{first_seg.first_stop}' NON è in un cluster — no deliver")

            # PICKUP
            if t_back > 0 and last_cluster:
                trips.append(CarTrip(
                    driver_id=d.driver_id,
                    cluster_id=last_cluster,
                    cluster_name=cluster_names.get(last_cluster, last_seg.last_stop or "?"),
                    stop_name=last_seg.last_stop or "?",
                    trip_type="pickup",
                    depart_min=last_seg.end_min,
                    arrive_min=last_seg.end_min + t_back,
                    transfer_min=t_back,
                ))
            elif t_back > 0:
                log(f"⚠️  Car pool: {d.driver_id} ultima fermata '{last_seg.last_stop}' NON è in un cluster — no pickup")
        else:
            # ── Biripresa su veicoli diversi ──
            # Il conducente torna al deposito tra le riprese
            for si, seg in enumerate(d.segments):
                seg_first_cluster = seg.first_cluster
                seg_last_cluster = seg.last_cluster
                t_to_first = depot_transfer_min(seg.first_stop, clusters)
                t_from_last = depot_transfer_min(seg.last_stop, clusters)

                # DELIVER: deposito → primo cluster di questo segmento
                if t_to_first > 0 and seg_first_cluster:
                    trips.append(CarTrip(
                        driver_id=d.driver_id,
                        cluster_id=seg_first_cluster,
                        cluster_name=cluster_names.get(seg_first_cluster, seg.first_stop or "?"),
                        stop_name=seg.first_stop or "?",
                        trip_type="deliver",
                        depart_min=seg.start_min - t_to_first,
                        arrive_min=seg.start_min,
                        transfer_min=t_to_first,
                    ))
                elif t_to_first > 0:
                    log(f"⚠️  Car pool: {d.driver_id} seg{si+1} prima fermata '{seg.first_stop}' NON è in un cluster — no deliver")

                # PICKUP: ultimo cluster di questo segmento → deposito
                if t_from_last > 0 and seg_last_cluster:
                    trips.append(CarTrip(
                        driver_id=d.driver_id,
                        cluster_id=seg_last_cluster,
                        cluster_name=cluster_names.get(seg_last_cluster, seg.last_stop or "?"),
                        stop_name=seg.last_stop or "?",
                        trip_type="pickup",
                        depart_min=seg.end_min,
                        arrive_min=seg.end_min + t_from_last,
                        transfer_min=t_from_last,
                    ))
                elif t_from_last > 0:
                    log(f"⚠️  Car pool: {d.driver_id} seg{si+1} ultima fermata '{seg.last_stop}' NON è in un cluster — no pickup")

    # ── Assegnazione auto per cluster (simulazione cronologica) ──
    # Ordiniamo TUTTI gli eventi per tempo.
    # Per deliver: l'auto esce dal deposito a depart_min e arriva al cluster a arrive_min
    # Per pickup: l'auto esce dal cluster a depart_min e rientra al deposito a arrive_min
    #
    # Usiamo due tipi di evento per timing corretto:
    #   deliver_depart  → auto lascia deposito
    #   deliver_arrive  → auto arriva al cluster (diventa disponibile)
    #   pickup_depart   → auto lascia cluster (deve essere disponibile!)
    #   pickup_arrive   → auto rientra al deposito
    all_events: list[tuple[int, str, CarTrip]] = []
    for t in trips:
        if t.trip_type == "deliver":
            all_events.append((t.depart_min, "deliver_depart", t))
            all_events.append((t.arrive_min, "deliver_arrive", t))
        else:
            all_events.append((t.depart_min, "pickup_depart", t))
            all_events.append((t.arrive_min, "pickup_arrive", t))

    # Ordina per tempo; a parità: arrivi prima di partenze (così auto appena arrivate sono disponibili)
    EVENT_ORDER = {"deliver_arrive": 0, "pickup_arrive": 1, "deliver_depart": 2, "pickup_depart": 3}
    all_events.sort(key=lambda e: (e[0], EVENT_ORDER.get(e[1], 9)))

    car_ids_at_depot: list[int] = list(range(1, COMPANY_CARS + 1))
    car_ids_at_cluster: dict[str, list[int]] = {}
    car_assignment: dict[int, int] = {}  # id(trip) → car_id
    conflicts: list[CarTrip] = []

    for _, event_type, trip in all_events:
        cid = trip.cluster_id or "unknown"

        if event_type == "deliver_depart":
            # Auto esce dal deposito
            if car_ids_at_depot:
                car_id = car_ids_at_depot.pop(0)
                car_assignment[id(trip)] = car_id
                trip.car_id = car_id
            else:
                trip.car_id = None
                conflicts.append(trip)

        elif event_type == "deliver_arrive":
            # Auto arriva al cluster — la parcheggiamo lì
            car_id = car_assignment.get(id(trip))
            if car_id is not None:
                car_ids_at_cluster.setdefault(cid, []).append(car_id)

        elif event_type == "pickup_depart":
            # Autista prende un'auto dal cluster
            if car_ids_at_cluster.get(cid):
                car_id = car_ids_at_cluster[cid].pop(0)
                car_assignment[id(trip)] = car_id
                trip.car_id = car_id
            else:
                trip.car_id = None
                conflicts.append(trip)

        elif event_type == "pickup_arrive":
            # Auto rientra al deposito
            car_id = car_assignment.get(id(trip))
            if car_id is not None:
                car_ids_at_depot.append(car_id)

    if conflicts:
        log(f"⚠️  Car pool: {len(conflicts)} trasferimenti senza auto disponibile!")
        for c in conflicts:
            log(f"    {c.driver_id} {c.trip_type} alle {min_to_time(c.depart_min)} ({c.cluster_name})")

    assigned = [t for t in trips if t.car_id is not None]
    log(f"🚗 Car pool: {len(assigned)}/{len(trips)} viaggi assegnati, "
        f"{len(conflicts)} conflitti, "
        f"max {_max_simultaneous_cars_out(trips)} auto fuori deposito")

    return trips


def car_pool_by_driver(trips: list[CarTrip]) -> dict[str, dict[str, CarTrip | list[CarTrip] | None]]:
    """Indicizza i viaggi auto per conducente.
    
    Ritorna: {driver_id: {"deliver": CarTrip, "pickup": CarTrip, "all_delivers": [...], "all_pickups": [...]}}
    Per compatibilità: "deliver"/"pickup" contengono il PRIMO deliver / l'ULTIMO pickup.
    """
    result: dict[str, dict[str, Any]] = {}
    for t in trips:
        if t.driver_id not in result:
            result[t.driver_id] = {"deliver": None, "pickup": None, "all_delivers": [], "all_pickups": []}
        if t.trip_type == "deliver":
            result[t.driver_id]["all_delivers"].append(t)
            if result[t.driver_id]["deliver"] is None:
                result[t.driver_id]["deliver"] = t  # primo deliver
        else:
            result[t.driver_id]["all_pickups"].append(t)
            result[t.driver_id]["pickup"] = t  # ultimo pickup (sovrascrive)
    return result


def _max_simultaneous_cars_out(trips: list[CarTrip]) -> int:
    """Calcola il massimo di auto aziendali fuori dal deposito contemporaneamente.
    
    Un'auto è "fuori deposito" dal momento in cui un deliver parte dal deposito
    fino a quando un pickup arriva al deposito.
    """
    if not trips:
        return 0
    events: list[tuple[int, int]] = []
    for t in trips:
        if t.car_id is None:
            continue
        if t.trip_type == "deliver":
            events.append((t.depart_min, +1))   # auto esce dal deposito
        else:  # pickup
            events.append((t.arrive_min, -1))    # auto rientra al deposito
    events.sort(key=lambda e: (e[0], e[1]))
    current = 0
    max_sim = 0
    for _, delta in events:
        current += delta
        max_sim = max(max_sim, current)
    return max_sim


# ═══════════════════════════════════════════════════════════════
#  FASE 4E: SERIALIZZAZIONE OUTPUT (formato compatibile con frontend)
# ═══════════════════════════════════════════════════════════════

def _serialize_segment_raw(seg: Segment) -> dict:
    """Serializzazione interna di un segmento (per metriche)."""
    return {
        "vehicleId": seg.vehicle_id,
        "vehicleType": seg.vehicle_type,
        "startMin": seg.start_min,
        "endMin": seg.end_min,
        "startTime": min_to_time(seg.start_min),
        "endTime": min_to_time(seg.end_min),
        "workMin": seg.work_min,
        "drivingMin": seg.driving_min,
        "firstStop": seg.first_stop,
        "lastStop": seg.last_stop,
        "firstCluster": seg.first_cluster,
        "lastCluster": seg.last_cluster,
        "half": seg.half,
        "trips": [
            {
                "type": t.type,
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
                "durationMin": t.duration_min,
                "directionId": t.direction_id,
            }
            for t in seg.trips
        ],
    }


def _segment_to_ripresa(seg: Segment, is_first: bool, is_last: bool, duty: "DriverDutyV3",
                        clusters: list["Cluster"] | None = None) -> dict:
    """Converte un Segment nella struttura Ripresa attesa dal frontend."""
    # pre-turno e transfer solo sulla prima ripresa (turno singolo o stessi veicoli)
    # Per biripresa veicoli diversi, ogni ripresa ha il suo pre-turno e transfer
    n_segs = len(duty.segments)
    diff_vehicles = n_segs >= 2 and duty.segments[0].vehicle_id != duty.segments[-1].vehicle_id

    if diff_vehicles:
        # Ogni segmento è indipendente: ha il suo transfer e transfer_back
        _transfer_out = depot_transfer_min(seg.first_stop, clusters)
        _transfer_back = depot_transfer_min(seg.last_stop, clusters)
        pre_turno = pre_turno_for(_transfer_out)
        transfer = _transfer_out
        transfer_back = _transfer_back
    else:
        # Singolo o biripresa stesso veicolo: solo primo ha transfer, ultimo ha transfer_back
        pre_turno = duty.pre_turno_min if is_first else 0
        transfer = duty.transfer_min if is_first else 0
        transfer_back = duty.transfer_back_min if is_last else 0

    transfer_type = "depot_to_start" if transfer > 0 else "none"
    transfer_back_type = "end_to_depot" if transfer_back > 0 else "none"

    # Destinazione del trasferimento: primo capolinea del segmento
    transfer_to_stop = seg.first_stop or "?"
    transfer_to_cluster = seg.first_cluster or None

    vehicle_ids = list(dict.fromkeys([seg.vehicle_id]))  # unique, mantenendo ordine

    # Mappo i trip al formato RipresaTrip del frontend
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
    handovers: list[Handover] | None = None,
    car_movements: list[CarTrip] | None = None,
) -> dict:
    """Serializza il risultato nel formato esatto atteso dal frontend driver-shifts.tsx."""
    rates = CostRates.from_config(config)
    
    if handovers is None:
        handovers = []
    if car_movements is None:
        car_movements = []
    
    # Pre-calcola handover per conducente
    handovers_by_driver: dict[str, list[Handover]] = {}
    for h in handovers:
        handovers_by_driver.setdefault(h.outgoing_driver, []).append(h)
        handovers_by_driver.setdefault(h.incoming_driver, []).append(h)
    
    # Pre-calcola car pool per conducente
    car_by_driver = car_pool_by_driver(car_movements)

    # ── Calcolo costi ──
    total_cost = 0.0
    for d in duties:
        per_min = rates.hourly_rate / 60.0
        cost = d.work_min * per_min + (d.transfer_min + d.transfer_back_min) * per_min
        if d.duty_type == "supplemento":
            cost = rates.supplemento_daily
        elif d.work_min > TARGET_WORK_MID + 12:
            excess = d.work_min - TARGET_WORK_MID
            cost += excess * per_min * (rates.overtime_multiplier - 1)
        cost += rates.company_car_per_use * len(d.segments)
        d.cost_euro = round(cost, 2)
        total_cost += cost

    # ── Summary per tipo ──
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
    total_cambi = sum(len(d.cambi) for d in duties)
    company_cars_used = len({seg.vehicle_id for d in duties for seg in d.segments})

    semi_pct = round(type_counts.get("semiunico", 0) / max(n_princ, 1) * 100, 1)
    spez_pct = round(type_counts.get("spezzato", 0) / max(n_princ, 1) * 100, 1)

    # ── Serializza driver shifts nel formato frontend ──
    cluster_names = {c.id: c.name for c in clusters}
    driver_shifts = []
    for d in duties:
        riprese = []
        my_car = car_by_driver.get(d.driver_id, {})
        all_delivers: list = my_car.get("all_delivers", [])
        all_pickups: list = my_car.get("all_pickups", [])
        
        for si, seg in enumerate(d.segments):
            rip = _segment_to_ripresa(seg, si == 0, si == len(d.segments) - 1, d, clusters)
            
            # Arricchisci con info auto pool DELIVER (andata al capolinea)
            # Per biripresa veicoli diversi, ogni segmento ha il suo deliver
            deliver = all_delivers[si] if si < len(all_delivers) else None
            if deliver:
                car_label = f"Auto {deliver.car_id}" if deliver.car_id else "⚠️ Nessuna auto disponibile"
                rip["carPoolOut"] = {
                    "carId": deliver.car_id,
                    "departMin": deliver.depart_min,
                    "departTime": min_to_time(deliver.depart_min),
                    "arriveMin": deliver.arrive_min,
                    "arriveTime": min_to_time(deliver.arrive_min),
                    "description": (
                        f"Guidi {car_label} dal deposito a {deliver.cluster_name} "
                        f"({min_to_time(deliver.depart_min)} → {min_to_time(deliver.arrive_min)}). "
                        f"Lasci l'auto al capolinea."
                    ),
                }
            else:
                rip["carPoolOut"] = None
            
            # Arricchisci con info auto pool PICKUP (rientro al deposito)
            # Per biripresa veicoli diversi, ogni segmento ha il suo pickup
            pickup = all_pickups[si] if si < len(all_pickups) else None
            if pickup:
                car_label = f"Auto {pickup.car_id}" if pickup.car_id else "⚠️ Nessuna auto disponibile"
                rip["carPoolReturn"] = {
                    "carId": pickup.car_id,
                    "departMin": pickup.depart_min,
                    "departTime": min_to_time(pickup.depart_min),
                    "arriveMin": pickup.arrive_min,
                    "arriveTime": min_to_time(pickup.arrive_min),
                    "description": (
                        f"Prendi {car_label} a {pickup.cluster_name} "
                        f"e guidi al deposito "
                        f"({min_to_time(pickup.depart_min)} → {min_to_time(pickup.arrive_min)})."
                    ),
                }
            else:
                rip["carPoolReturn"] = None
            
            riprese.append(rip)

        # Handover associati a questo conducente
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
                    f"LASCIA bus {h.vehicle_id} AL TURNO {h.incoming_driver} a {cluster_label} — rientri al deposito con auto aziendale"
                    if is_outgoing else
                    f"PRENDE bus {h.vehicle_id} DAL TURNO {h.outgoing_driver} a {cluster_label} — arrivi con auto aziendale"
                ),
            })

        # Costruisci etichette sintetiche LASCIA/PRENDE
        handover_labels: list[str] = []
        for h in my_handovers:
            is_outgoing = (h.outgoing_driver == d.driver_id)
            cl = cluster_names.get(h.cluster or "", h.at_stop or "?")
            if is_outgoing:
                handover_labels.append(f"LASCIA bus {h.vehicle_id} AL TURNO {h.incoming_driver}")
            else:
                handover_labels.append(f"PRENDE bus {h.vehicle_id} DAL TURNO {h.outgoing_driver}")

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
            "costBreakdown": {
                "base": round(d.work_min * rates.hourly_rate / 60.0, 2),
                "transfer": round((d.transfer_min + d.transfer_back_min) * rates.hourly_rate / 60.0, 2),
            },
        })

    return {
        "driverShifts": driver_shifts,
        "handovers": serialize_handovers(handovers, clusters),
        "summary": {
            # Campi principali attesi dal frontend
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
            "companyCarsUsed": company_cars_used,
            # Campi costo
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
            "solver": "cpsat_v3_vsf",
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
    
    log(f"=== Crew Scheduler V3 (VSF) ===")
    log(f"Input: {len(vehicle_shifts_raw)} turni macchina, timeLimit={time_limit_sec}s")
    report_progress("init", 5, f"{len(vehicle_shifts_raw)} turni macchina")
    
    # ── Fase 1: Parsing ──
    blocks = parse_vehicle_blocks(vehicle_shifts_raw, clusters)
    log(f"Fase 1: {len(blocks)} vehicle blocks parsati")
    report_progress("parse", 10, f"{len(blocks)} blocchi")
    
    # ── Fase 2: Analisi e classificazione ──
    for b in blocks:
        analyze_vehicle_block(b, clusters)
    classify_blocks(blocks, clusters)
    
    # Filtra tagli: solo su cluster definiti (se abilitato)
    filter_cuts_by_cluster(blocks, config)
    
    class_summary = {}
    for b in blocks:
        class_summary[b.classification] = class_summary.get(b.classification, 0) + 1
    log(f"Fase 2: classificazione = {class_summary}")
    report_progress("analyze", 20, f"Classificati: {class_summary}")
    
    # ── Fase 2B: Costruzione segmenti ──
    segments = build_initial_segments(blocks, clusters)
    log(f"Fase 2B: {len(segments)} segmenti generati")
    report_progress("segments", 25, f"{len(segments)} segmenti")
    
    # ── Fase 3: Ottimizzazione ──
    duties = optimize_global(blocks, segments, config, time_limit_sec, clusters)
    
    n_total = len(duties)
    n_suppl = sum(1 for d in duties if d.duty_type == "supplemento")
    log(f"Fase 3: {n_total} turni guida ({n_total - n_suppl} principali + {n_suppl} supplementi)")
    report_progress("duties", 70, f"{n_total} turni ({n_suppl} suppl)")
    
    # ── Fase 4A: Raffinamento cambi ──
    duties = refine_with_cambi(duties, clusters, config)
    report_progress("refine", 80, "Raffinamento completato")
    
    # ── Fase 4B: Validazione ──
    validation = validate_all(duties, config)
    log(f"Fase 4B: validazione — {validation['totalViolations']} violazioni")
    report_progress("validate", 90, f"{validation['totalViolations']} violazioni")
    
    # ── Fase 4C: Handover (cambi bus tra conducenti) ──
    handovers = compute_handovers(duties, clusters)
    log(f"Fase 4C: {len(handovers)} cambi bus identificati")
    
    # ── Fase 4C-bis: Car Pool (accoppiamento auto aziendali) ──
    car_movements = compute_car_pool(duties, clusters)
    n_conflicts = sum(1 for m in car_movements if m.car_id is None)
    max_sim = _max_simultaneous_cars_out(car_movements)
    log(f"Fase 4C-bis: {len(car_movements)} viaggi auto, {n_conflicts} conflitti, max {max_sim} auto fuori deposito")
    
    # ── Fase 4D: Output ──
    elapsed = time.time() - t_start
    output = serialize_output(duties, blocks, segments, config, clusters, validation, elapsed, handovers, car_movements)
    
    log(f"=== DONE in {elapsed:.1f}s — {n_total} turni, {n_suppl} supplementi ({n_suppl * 100 // max(n_total, 1)}%), €{output['summary']['totalDailyCost']:.0f}/giorno ===")
    report_progress("done", 100, f"{n_total} turni, €{output['summary']['totalDailyCost']:.0f}/giorno")
    
    write_output(output)


if __name__ == "__main__":
    main()
