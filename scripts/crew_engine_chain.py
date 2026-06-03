#!/usr/bin/env python3
"""
crew_engine_chain.py — Motore di crew scheduling a CATENA (set-partitioning).

Sostituisce il vecchio modello "single-or-pair" di crew_scheduler_v4 con un
modello professionale dove un TURNO GUIDA è una CATENA ordinata di "pezzi"
(porzioni di turno macchina tra due punti di cambio in cluster), collegati da:

  - continuazione   : stesso bus, pezzi consecutivi (l'autista prosegue);
  - cambio (relief) : a un cluster condiviso l'autista lascia il bus a un collega
                      e ne prende un altro (a piedi se stesso cluster, oppure con
                      auto/corriera/passeggero se cluster diverso);
  - interruzione    : pausa lunga (semiunico 75-179', spezzato ≥180') con rientro
                      in deposito (auto aziendale).

Si risolve come SET-PARTITIONING: copri ogni pezzo esattamente una volta,
minimizzando PRIMA il numero di turni e poi il costo, con auto/corriere come
risorse a capacità limitata. È questa concatenazione che abbatte il numero di
turni guida (un turno copre più pezzi di bus diversi, ~7h ciascuno).

Riusa classificazione/validazione/costi RD 131 di crew_scheduler_v4.
"""
from __future__ import annotations

import time
from dataclasses import dataclass, field
from typing import Any

from ortools.sat.python import cp_model

from optimizer_common import (
    SHIFT_RULES, MAX_CONTINUOUS_DRIVING, MIN_BREAK_AFTER_DRIVING,
    DEPOT_TRANSFER_CENTRAL, DEPOT_TRANSFER_OUTER, COMPANY_CARS,
    PRE_TURNO_MIN, PRE_TURNO_AUTO_MIN,
    Segment, DriverDutyV3, Cluster, VehicleBlock, VShiftTrip,
    match_cluster, depot_transfer_min, log,
)

COST_SCALE = 100

# Limiti di enumerazione (tenuti generosi ma finiti per tractabilità)
MAX_PIECES_PER_DUTY = 9          # un turno guida concatena al più N pezzi
MAX_CHAIN_GAP_MIN = 320          # gap massimo tra due pezzi consecutivi in catena (il nastro≤630 lo limita comunque)
MAX_TOTAL_CHAINS = 60000         # tetto colonne enumerate
RELIEF_CHANGEOVER_MIN = 3        # tempo minimo di cambio bus al cluster
MAX_LONG_INTERRUPTIONS = 1       # al più una interruzione lunga (semi/spezzato)
RELIEF_FANOUT = 6                # max successori considerati per pezzo (branching)
NODE_BUDGET = 1_500_000          # budget globale di nodi DFS (garantisce terminazione)
MAX_COLS_PER_START = 1500        # max colonne emesse a partire da ogni pezzo

# Soglie tipologia (da SHIFT_RULES, default RD 131)
_INTERO = SHIFT_RULES["intero"]
_SEMI = SHIFT_RULES["semiunico"]
_SPEZ = SHIFT_RULES["spezzato"]
_SUPPL = SHIFT_RULES["supplemento"]


def pre_turno_for(transfer_min: int) -> int:
    """Pre-turno: 5' se l'autista esce con auto aziendale (transfer>0), 12' altrimenti."""
    return PRE_TURNO_AUTO_MIN if transfer_min > 0 else PRE_TURNO_MIN


# ════════════════════════════════════════════════════════════════
#  STEP 1 — Generazione PEZZI (split blocchi ai punti di cambio cluster)
# ════════════════════════════════════════════════════════════════

def _build_piece(idx: int, vehicle_id: str, vtype: str,
                 trips: list[VShiftTrip], clusters: list[Cluster]) -> Segment:
    start = trips[0].departure_min
    end = trips[-1].arrival_min
    work = end - start
    driving = sum(t.arrival_min - t.departure_min for t in trips)
    first_stop = trips[0].first_stop_name
    last_stop = trips[-1].last_stop_name
    return Segment(
        idx=idx, vehicle_id=vehicle_id, vehicle_type=vtype, trips=list(trips),
        start_min=start, end_min=end, work_min=work, driving_min=driving,
        first_stop=first_stop, last_stop=last_stop,
        first_cluster=match_cluster(first_stop, clusters),
        last_cluster=match_cluster(last_stop, clusters),
        half="piece", cut_index=None,
    )


def build_pieces(blocks: list[VehicleBlock], clusters: list[Cluster]) -> list[Segment]:
    """Spezza ogni turno macchina nei punti di cambio: un confine tra due corse
    è un punto di cambio se la fermata di arrivo è in un cluster (relief point).
    Restituisce i pezzi minimali (porzioni di blocco tra due relief point)."""
    pieces: list[Segment] = []
    idx = 0
    for b in blocks:
        trips = b.trips
        if not trips:
            continue
        # punti dove possiamo "tagliare" (fine corsa i in cluster), i in [0, n-2]
        split_after = [
            i for i in range(len(trips) - 1)
            if match_cluster(trips[i].last_stop_name, clusters)
        ]
        # costruisci i run di corse tra i punti di split
        start_i = 0
        boundaries = split_after + [len(trips) - 1]
        for b_end in boundaries:
            run = trips[start_i:b_end + 1]
            if run:
                pieces.append(_build_piece(idx, b.vehicle_id, b.vehicle_type, run, clusters))
                idx += 1
            start_i = b_end + 1
    return pieces


# ════════════════════════════════════════════════════════════════
#  STEP 2 — Catene: link ammissibili + classificazione RD 131
# ════════════════════════════════════════════════════════════════

@dataclass
class ChainMetrics:
    feasible: bool
    duty_type: str
    nastro_min: int
    work_min: int
    driving_min: int
    interruption_min: int        # somma interruzioni lunghe (≥75')
    max_continuous: int
    n_long_interruptions: int
    transfer_out: int
    transfer_back: int
    pre_turno: int
    n_relief: int                # cambi bus (link tra veicoli diversi)


def _link_feasible(p: Segment, q: Segment) -> bool:
    """p precede q nella catena. Link ammissibile se condividono il cluster di
    snodo e q parte dopo la fine di p entro la finestra massima."""
    if p.last_cluster is None or q.first_cluster is None:
        return False
    if p.last_cluster != q.first_cluster:
        return False  # increment 1: solo cambio nello STESSO cluster (a piedi)
    gap = q.start_min - p.end_min
    if gap < 0:
        return False
    # se cambio bus (veicolo diverso) serve il changeover minimo
    if p.vehicle_id != q.vehicle_id and gap < RELIEF_CHANGEOVER_MIN:
        return False
    if gap > MAX_CHAIN_GAP_MIN:
        return False
    return True


def _classify(nastro: int, work: int, maxrun: int, n_long: int,
              long_gap: int, n_pieces: int) -> tuple[bool, str]:
    """Determina (fattibile, tipologia) RD 131 da scalari già calcolati."""
    if maxrun > MAX_CONTINUOUS_DRIVING:
        return False, "invalido"
    if n_long > MAX_LONG_INTERRUPTIONS:
        return False, "invalido"
    if n_long == 0:
        if nastro <= _SUPPL["maxNastro"] and n_pieces == 1:
            return True, "supplemento"
        if nastro <= _INTERO["maxNastro"] and work <= _INTERO["maxLavoro"]:
            return True, "intero"
        return False, "invalido"
    # n_long == 1
    if _SEMI["intMin"] <= long_gap <= _SEMI["intMax"]:
        if nastro <= _SEMI["maxNastro"] and work <= _SEMI["maxLavoro"]:
            return True, "semiunico"
        return False, "invalido"
    if long_gap >= _SPEZ["intMin"]:
        if nastro <= _SPEZ["maxNastro"] and work <= _SPEZ["maxLavoro"]:
            return True, "spezzato"
        return False, "invalido"
    return False, "invalido"


def chain_metrics(chain: list[Segment], clusters: list[Cluster]) -> ChainMetrics:
    """Calcola metriche RD 131 di una catena di pezzi e ne determina la
    fattibilità + tipologia (intero/semiunico/spezzato/supplemento)."""
    first, last = chain[0], chain[-1]
    transfer_out = depot_transfer_min(first.first_stop, clusters)
    transfer_back = depot_transfer_min(last.last_stop, clusters)
    pre = pre_turno_for(transfer_out)

    # nastro: da (uscita deposito) a (rientro deposito)
    nastro_start = first.start_min - pre - transfer_out
    nastro_end = last.end_min + transfer_back
    nastro = nastro_end - nastro_start

    total_driving = sum(s.driving_min for s in chain)

    # gap (interruzioni) tra pezzi consecutivi
    gaps = [chain[i + 1].start_min - chain[i].end_min for i in range(len(chain) - 1)]
    long_ints = [g for g in gaps if g >= _SEMI["intMin"]]   # ≥75'
    interruption = sum(long_ints)
    n_long = len(long_ints)
    n_relief = sum(1 for i in range(len(chain) - 1)
                   if chain[i].vehicle_id != chain[i + 1].vehicle_id)

    # lavoro = nastro meno le interruzioni lunghe (non retribuite)
    work = nastro - interruption

    # massima guida continuativa: scorri TUTTE le corse, reset su gap ≥15'
    maxrun = run = 0
    last_arr = None
    for s in chain:
        for t in s.trips:
            if last_arr is not None:
                if t.departure_min - last_arr >= MIN_BREAK_AFTER_DRIVING:
                    run = 0
            run += (t.arrival_min - t.departure_min)
            maxrun = max(maxrun, run)
            last_arr = t.arrival_min

    long_gap = long_ints[0] if n_long == 1 else 0
    feasible, duty_type = _classify(nastro, work, maxrun, n_long, long_gap, len(chain))

    return ChainMetrics(
        feasible=feasible, duty_type=duty_type, nastro_min=nastro, work_min=work,
        driving_min=total_driving, interruption_min=interruption, max_continuous=maxrun,
        n_long_interruptions=n_long, transfer_out=transfer_out, transfer_back=transfer_back,
        pre_turno=pre, n_relief=n_relief,
    )


# ════════════════════════════════════════════════════════════════
#  STEP 3 — Enumerazione catene fattibili (colonne del set-partitioning)
# ════════════════════════════════════════════════════════════════

@dataclass
class DutyColumn:
    piece_idxs: tuple[int, ...]
    metrics: ChainMetrics


def enumerate_duties(pieces: list[Segment], clusters: list[Cluster]) -> list[DutyColumn]:
    """DFS con potatura: enumera le catene fattibili (incluso ogni singoletto).
    Ogni pezzo deve poter essere coperto almeno come singoletto.

    Enumerazione TRACTABILE: il fan-out dei successori è limitato (continuazione
    sullo stesso bus + le prime RELIEF_FANOUT alternative di cambio/pausa più
    precoci) e c'è un budget globale di nodi, così l'esplosione combinatoria del
    grafo dei pezzi resta sotto controllo (il crew scheduling reale usa lo stesso
    principio: non si enumerano tutte le catene possibili)."""
    by_idx = {p.idx: p for p in pieces}
    pieces_sorted = sorted(pieces, key=lambda p: p.start_min)

    # successori: per ogni pezzo, i pezzi linkabili (stesso cluster, dopo, entro finestra),
    # ordinati per orario e troncati a fan-out limitato (continuazione SEMPRE inclusa).
    succ: dict[int, list[int]] = {}
    by_cluster_start: dict[str | None, list[Segment]] = {}
    for p in pieces_sorted:
        by_cluster_start.setdefault(p.first_cluster, []).append(p)
    for p in pieces:
        if p.last_cluster is None:
            succ[p.idx] = []
            continue
        cands = [q for q in by_cluster_start.get(p.last_cluster, [])
                 if q.idx != p.idx and _link_feasible(p, q)]
        cands.sort(key=lambda q: q.start_min)
        chosen: list[int] = []
        # continuazione (stesso veicolo, gap minimo) ha priorità
        cont = [q for q in cands if q.vehicle_id == p.vehicle_id]
        if cont:
            chosen.append(cont[0].idx)
        for q in cands:
            if len(chosen) >= RELIEF_FANOUT:
                break
            if q.idx not in chosen:
                chosen.append(q.idx)
        succ[p.idx] = chosen

    # Precompute per-pezzo: transfer/pre del pezzo come PRIMO della catena
    tr_out = {p.idx: depot_transfer_min(p.first_stop, clusters) for p in pieces}
    tr_back = {p.idx: depot_transfer_min(p.last_stop, clusters) for p in pieces}

    columns: list[DutyColumn] = []

    # (1) SINGOLETTI garantiti per OGNI pezzo (copertura sempre possibile)
    for p in pieces:
        m = chain_metrics([p], clusters)
        if not m.feasible:
            # un singolo pezzo che viola RD131 da solo: lo teniamo come supplemento
            # forzato (verrà segnalato in validazione) per non rendere infeasible il
            # set-partition. In pratica i pezzi sono tra cluster e raramente >4h30.
            m = ChainMetrics(
                feasible=True, duty_type="invalido", nastro_min=m.nastro_min,
                work_min=m.work_min, driving_min=m.driving_min,
                interruption_min=0, max_continuous=m.max_continuous,
                n_long_interruptions=0, transfer_out=tr_out[p.idx],
                transfer_back=tr_back[p.idx], pre_turno=pre_turno_for(tr_out[p.idx]),
                n_relief=0,
            )
        columns.append(DutyColumn(piece_idxs=(p.idx,), metrics=m))

    # (2) Catene multi-pezzo con stato INCREMENTALE (veloce) + budget di nodi.
    node_budget = [NODE_BUDGET]

    def dfs(idxs: list[int], chain_set: frozenset, per_start: list[int],
            fs_start: int, fs_first_stop_tr: int, fs_pre: int,
            last_end: int, last_arr: int, run: int, maxrun: int,
            driving: int, n_long: int, long_gap: int, n_relief: int,
            last_vehicle: str):
        if node_budget[0] <= 0 or per_start[0] >= MAX_COLS_PER_START:
            return
        node_budget[0] -= 1
        last_p = by_idx[idxs[-1]]
        for nxt in succ[idxs[-1]]:
            if nxt in chain_set:
                continue
            q = by_idx[nxt]
            gap = q.start_min - last_end
            # aggiorna guida continuativa e interruzioni con il gap inter-pezzo
            n_long2, long_gap2 = n_long, long_gap
            if gap >= _SEMI["intMin"]:
                n_long2 += 1
                long_gap2 = gap
                if n_long2 > MAX_LONG_INTERRUPTIONS:
                    continue
            run2, maxrun2, la = run, maxrun, last_arr
            if gap >= MIN_BREAK_AFTER_DRIVING:
                run2 = 0
            ok = True
            for t in q.trips:
                if t.departure_min - la >= MIN_BREAK_AFTER_DRIVING:
                    run2 = 0
                run2 += (t.arrival_min - t.departure_min)
                if run2 > maxrun2:
                    maxrun2 = run2
                la = t.arrival_min
            if maxrun2 > MAX_CONTINUOUS_DRIVING:
                # estendere non recupera: la guida continua è monotona finché non c'è break
                ok = False
            new_last_end = q.end_min
            interruption = long_gap2 if n_long2 == 1 else 0  # somma; con max 1 interruzione
            nastro = (new_last_end + tr_back[nxt]) - (fs_start - fs_pre - fs_first_stop_tr)
            work = nastro - interruption
            n_pieces = len(idxs) + 1
            feasible, dtype = _classify(nastro, work, maxrun2, n_long2, long_gap2, n_pieces)
            if feasible and ok:
                columns.append(DutyColumn(
                    piece_idxs=tuple(idxs) + (nxt,),
                    metrics=ChainMetrics(
                        feasible=True, duty_type=dtype, nastro_min=nastro, work_min=work,
                        driving_min=driving + q.driving_min, interruption_min=interruption,
                        max_continuous=maxrun2, n_long_interruptions=n_long2,
                        transfer_out=fs_first_stop_tr, transfer_back=tr_back[nxt],
                        pre_turno=fs_pre, n_relief=n_relief + (1 if q.vehicle_id != last_vehicle else 0),
                    ),
                ))
                per_start[0] += 1
            # potatura estensione
            if not ok:
                continue
            if n_pieces >= MAX_PIECES_PER_DUTY or nastro >= _SPEZ["maxNastro"]:
                continue
            dfs(idxs + [nxt], chain_set | {nxt}, per_start,
                fs_start, fs_first_stop_tr, fs_pre,
                new_last_end, la, run2, maxrun2,
                driving + q.driving_min, n_long2, long_gap2,
                n_relief + (1 if q.vehicle_id != last_vehicle else 0), q.vehicle_id)

    for p in pieces_sorted:
        if len(columns) >= MAX_TOTAL_CHAINS or node_budget[0] <= 0:
            break
        # stato iniziale dal pezzo p
        run0 = maxrun0 = 0
        la0 = None
        for t in p.trips:
            if la0 is not None and t.departure_min - la0 >= MIN_BREAK_AFTER_DRIVING:
                run0 = 0
            run0 += (t.arrival_min - t.departure_min)
            maxrun0 = max(maxrun0, run0)
            la0 = t.arrival_min
        dfs([p.idx], frozenset((p.idx,)), [0],
            p.start_min, tr_out[p.idx], pre_turno_for(tr_out[p.idx]),
            p.end_min, la0, run0, maxrun0, p.driving_min, 0, 0, 0, p.vehicle_id)

    return columns


def greedy_chain_cover(pieces: list[Segment], clusters: list[Cluster],
                       target_nastro: int | None = None) -> list[tuple[int, ...]]:
    """Costruisce una copertura GREEDY di catene (interi ben riempiti): parte dal
    pezzo libero più precoce ed estende con il successore libero più precoce finché
    resta fattibile e sotto il nastro target. Serve da warm-start per il CP-SAT."""
    if target_nastro is None:
        target_nastro = _INTERO["maxNastro"]
    by_idx = {p.idx: p for p in pieces}
    by_cluster_start: dict[str | None, list[Segment]] = {}
    for p in sorted(pieces, key=lambda x: x.start_min):
        by_cluster_start.setdefault(p.first_cluster, []).append(p)

    free = set(p.idx for p in pieces)
    order = sorted(pieces, key=lambda p: p.start_min)
    chains: list[tuple[int, ...]] = []

    for start in order:
        if start.idx not in free:
            continue
        chain = [start.idx]
        free.discard(start.idx)
        while True:
            tail = by_idx[chain[-1]]
            if tail.last_cluster is None:
                break
            best = None
            for q in by_cluster_start.get(tail.last_cluster, []):
                if q.idx not in free or not _link_feasible(tail, q):
                    continue
                m = chain_metrics([by_idx[i] for i in chain] + [q], clusters)
                if not m.feasible or m.duty_type in ("spezzato", "semiunico"):
                    continue  # greedy: solo interi continui (no biripresa)
                if m.nastro_min > target_nastro:
                    continue
                best = q.idx
                break  # primo (più precoce) successore fattibile
            if best is None:
                break
            chain.append(best)
            free.discard(best)
        chains.append(tuple(chain))
    return chains


# ════════════════════════════════════════════════════════════════
#  STEP 4 — Set-partitioning CP-SAT (min #turni, poi costo)
# ════════════════════════════════════════════════════════════════

def _column_cost_cents(col: DutyColumn, hourly_rate: float, car_cost: float) -> int:
    """Costo approssimato di una colonna (in centesimi * COST_SCALE).
    Lavoro orario + costo auto per ogni cambio bus/biripresa."""
    m = col.metrics
    hours = m.work_min / 60.0
    cost = hours * hourly_rate
    # auto: una per ogni biripresa (rientro deposito) + relief che richiede trasporto
    n_car = m.n_long_interruptions
    cost += n_car * car_cost
    return int(cost * COST_SCALE)


def solve_set_partition(
    pieces: list[Segment],
    columns: list[DutyColumn],
    clusters: list[Cluster],
    max_company_cars: int,
    weight_duty: int,
    hourly_rate: float,
    car_cost: float,
    time_limit: float,
    seed: int = 1,
    warmstart_cols: list[int] | None = None,
) -> tuple[str, list[DutyColumn]]:
    """Copri ogni pezzo esattamente una volta minimizzando #turni poi costo."""
    model = cp_model.CpModel()
    n_cols = len(columns)
    x = [model.new_bool_var(f"x{c}") for c in range(n_cols)]

    # indice: per ogni pezzo, le colonne che lo coprono
    cols_by_piece: dict[int, list[int]] = {p.idx: [] for p in pieces}
    for c, col in enumerate(columns):
        for pidx in col.piece_idxs:
            cols_by_piece[pidx].append(c)

    # copertura esatta
    for pidx, clist in cols_by_piece.items():
        if not clist:
            # pezzo non coperto da nessuna colonna -> modello infeasible by design
            log(f"[CHAIN] ATTENZIONE: pezzo {pidx} senza colonne!")
            continue
        model.add_exactly_one(x[c] for c in clist)

    # vincolo HARD vetture aziendali: due brevi trasferimenti per ogni biripresa
    if max_company_cars > 0:
        car_intervals = []
        for c, col in enumerate(columns):
            m = col.metrics
            if m.n_long_interruptions == 0:
                continue
            chain = col.piece_idxs
            by_idx = {p.idx: p for p in pieces}
            segs = [by_idx[i] for i in chain]
            for i in range(len(segs) - 1):
                gap = segs[i + 1].start_min - segs[i].end_min
                if gap < _SEMI["intMin"]:
                    continue
                tr = depot_transfer_min(segs[i].last_stop, clusters) or DEPOT_TRANSFER_CENTRAL
                # drop a inizio interruzione
                car_intervals.append(model.new_optional_fixed_size_interval_var(
                    start=segs[i].end_min, size=tr, is_present=x[c], name=f"cd{c}_{i}"))
                # pickup a fine interruzione
                car_intervals.append(model.new_optional_fixed_size_interval_var(
                    start=segs[i + 1].start_min - tr, size=tr, is_present=x[c], name=f"cp{c}_{i}"))
        if car_intervals:
            model.add_cumulative(car_intervals, [1] * len(car_intervals), max_company_cars)

    # obiettivo: #turni (dominante) + costo
    obj = []
    for c, col in enumerate(columns):
        obj.append((weight_duty * COST_SCALE + _column_cost_cents(col, hourly_rate, car_cost)) * x[c])
    model.minimize(sum(obj))

    # Warm-start: la copertura greedy come hint completo (scelte=1, resto=0).
    if warmstart_cols:
        ws = set(warmstart_cols)
        for c in range(n_cols):
            model.add_hint(x[c], 1 if c in ws else 0)

    solver = cp_model.CpSolver()
    solver.parameters.max_time_in_seconds = time_limit
    solver.parameters.num_workers = 8
    solver.parameters.random_seed = seed
    solver.parameters.log_search_progress = False
    status = solver.solve(model)
    status_name = solver.status_name(status)
    if status not in (cp_model.OPTIMAL, cp_model.FEASIBLE):
        return status_name, []
    chosen = [columns[c] for c in range(n_cols) if solver.value(x[c])]
    return status_name, chosen


# ════════════════════════════════════════════════════════════════
#  STEP 5 — Colonne scelte -> DriverDutyV3
# ════════════════════════════════════════════════════════════════

def columns_to_duties(
    chosen: list[DutyColumn],
    pieces: list[Segment],
    clusters: list[Cluster],
) -> list[DriverDutyV3]:
    by_idx = {p.idx: p for p in pieces}
    duties: list[DriverDutyV3] = []
    chosen_sorted = sorted(chosen, key=lambda col: by_idx[col.piece_idxs[0]].start_min)
    for di, col in enumerate(chosen_sorted):
        segs = [by_idx[i] for i in col.piece_idxs]
        m = col.metrics
        first, last = segs[0], segs[-1]
        nastro_start = first.start_min - m.pre_turno - m.transfer_out
        nastro_end = last.end_min + m.transfer_back
        duties.append(DriverDutyV3(
            idx=di,
            driver_id=f"D{di + 1:03d}",
            duty_type=m.duty_type,
            segments=segs,
            nastro_start=nastro_start,
            nastro_end=nastro_end,
            nastro_min=m.nastro_min,
            work_min=m.work_min,
            driving_min=m.driving_min,
            interruption_min=m.interruption_min,
            pre_turno_min=m.pre_turno,
            transfer_min=m.transfer_out,
            transfer_back_min=m.transfer_back,
        ))
    return duties


# ════════════════════════════════════════════════════════════════
#  ENTRY POINT
# ════════════════════════════════════════════════════════════════

def optimize_chain(
    blocks: list[VehicleBlock],
    config: dict,
    time_limit_sec: int,
    clusters: list[Cluster],
    bds: Any,
    max_company_cars: int = COMPANY_CARS,
    weight_duty: int = 100000,
    hourly_rate: float = 22.0,
    car_cost: float = 8.0,
) -> tuple[list[DriverDutyV3], dict]:
    """Pipeline completa del motore a catena. Ritorna (duties, analysis)."""
    t0 = time.time()
    pieces = build_pieces(blocks, clusters)
    log(f"[CHAIN] {len(pieces)} pezzi da {len(blocks)} turni macchina")

    t_enum = time.time()
    columns = enumerate_duties(pieces, clusters)
    log(f"[CHAIN] {len(columns)} colonne (turni candidati) in {time.time() - t_enum:.2f}s")

    # Warm-start: copertura greedy. Le sue catene vengono aggiunte come colonne
    # (se non già presenti) e usate come hint per il CP-SAT.
    greedy_chains = greedy_chain_cover(pieces, clusters)
    by_idx = {p.idx: p for p in pieces}
    col_index = {col.piece_idxs: i for i, col in enumerate(columns)}
    warm_cols: list[int] = []
    for ch in greedy_chains:
        if ch in col_index:
            warm_cols.append(col_index[ch])
        else:
            m = chain_metrics([by_idx[i] for i in ch], clusters)
            columns.append(DutyColumn(piece_idxs=ch, metrics=m))
            col_index[ch] = len(columns) - 1
            warm_cols.append(len(columns) - 1)
    log(f"[CHAIN] warm-start greedy: {len(greedy_chains)} turni")

    status, chosen = solve_set_partition(
        pieces, columns, clusters, max_company_cars, weight_duty,
        hourly_rate, car_cost, time_limit=max(5, time_limit_sec * 0.8),
        warmstart_cols=warm_cols,
    )
    log(f"[CHAIN] solve={status}: {len(chosen)} turni guida")

    # fallback: se il solver non ha trovato nulla di valido, usa il greedy
    if not chosen:
        chosen = [columns[c] for c in warm_cols]
        log(f"[CHAIN] uso copertura greedy ({len(chosen)} turni)")

    duties = columns_to_duties(chosen, pieces, clusters)
    analysis = {
        "engine": "chain",
        "nPieces": len(pieces),
        "nColumns": len(columns),
        "status": status,
        "nDuties": len(duties),
        "nGreedy": len(greedy_chains),
        "elapsedSec": round(time.time() - t0, 2),
    }
    return duties, analysis
