"""
duty_enumerator.py — Enumerazione turni guida con costi e trasferimenti
Conerobus S.p.A. / TransitIntel

Genera tutti i duty candidati (intero, semiunico, spezzato, supplemento)
considerando trasferimenti cross-cluster e costi reali.
"""

from __future__ import annotations
import bisect
from collections import defaultdict
from typing import Any

from optimizer_common import (
    Task, Duty, DutyBlock, Ripresa, CambioInfo,
    SHIFT_RULES, PRE_TURNO_MIN,
    TARGET_WORK_HIGH,
    MAX_CONTINUOUS_DRIVING,
    match_cluster, cluster_by_id, depot_transfer_min,
    log,
)
from transfer_matrix import (
    TaskTransfer,
    can_chain_extended,
    ChainResult,
    CAMBIO_TIME_MIN,
)
from cost_model import CostRates, compute_duty_cost


# ═══════════════════════════════════════════════════════════════
#  COSTANTI
# ═══════════════════════════════════════════════════════════════

_MAX_CHAIN_GAP = 120    # max gap nella stessa ripresa (esteso da 75 a 120 per cross-cluster)
_MAX_RIP_DEPTH = 5      # max task in una ripresa


# ═══════════════════════════════════════════════════════════════
#  BUILD RIPRESA
# ═══════════════════════════════════════════════════════════════

def build_ripresa(blocks: list[DutyBlock]) -> Ripresa:
    """Costruisce una Ripresa da blocchi di task."""
    first_stop = blocks[0].task.first_stop
    transfer = depot_transfer_min(first_stop)
    start = blocks[0].task.start_min - PRE_TURNO_MIN - transfer
    end = blocks[-1].task.end_min

    work = PRE_TURNO_MIN + transfer
    for b in blocks:
        work += b.task.driving_min
    # Gap inter-task contano come lavoro
    for i in range(1, len(blocks)):
        gap = blocks[i].task.start_min - blocks[i - 1].task.end_min
        work += gap

    return Ripresa(
        blocks=blocks, start_min=start, end_min=end,
        pre_turno_min=PRE_TURNO_MIN, transfer_min=transfer,
        transfer_type="auto", work_min=work,
    )


# ═══════════════════════════════════════════════════════════════
#  ENUMERAZIONE RIPRESE
# ═══════════════════════════════════════════════════════════════

def enumerate_riprese(
    tasks: list[Task],
    transfer_matrix: dict[tuple[int, int], TaskTransfer] | None = None,
    max_work: int = TARGET_WORK_HIGH + 30,
    max_riprese: int = 100_000,
    max_per_start: int = 200,
    enable_cross_cluster: bool = True,
) -> list[list[DutyBlock]]:
    """
    Enumera combinazioni di blocchi per singole riprese.
    Con transfer_matrix, permette cambi cross-cluster.
    """
    n = len(tasks)
    if n == 0:
        return []

    tasks_sorted = sorted(tasks, key=lambda t: t.start_min)
    start_mins = [t.start_min for t in tasks_sorted]

    riprese: list[list[DutyBlock]] = []

    for si in range(n):
        if len(riprese) >= max_riprese:
            break
        count_before = len(riprese)
        _enumerate_from(
            tasks_sorted, start_mins, si,
            [DutyBlock(task=tasks_sorted[si])],
            max_work, riprese, max_riprese,
            max_per_start, count_before,
            transfer_matrix=transfer_matrix,
            enable_cross_cluster=enable_cross_cluster,
            depth=0,
        )
    return riprese


def _enumerate_from(
    tasks: list[Task],
    start_mins: list[int],
    last_sorted_idx: int,
    current_blocks: list[DutyBlock],
    max_work: int,
    result: list[list[DutyBlock]],
    max_riprese: int,
    max_per_start: int,
    count_at_start: int,
    transfer_matrix: dict[tuple[int, int], TaskTransfer] | None,
    enable_cross_cluster: bool,
    depth: int,
):
    """DFS con ricerca limitata e supporto cross-cluster."""
    # Controlla fattibilità
    rip = build_ripresa(current_blocks)
    if rip.work_min > max_work:
        return

    # Driving continua
    total_driving = sum(b.task.driving_min for b in current_blocks)
    if total_driving > MAX_CONTINUOUS_DRIVING:
        return

    # Aggiungi combinazione corrente
    result.append(list(current_blocks))
    if len(result) >= max_riprese:
        return
    if len(result) - count_at_start >= max_per_start:
        return
    if depth >= _MAX_RIP_DEPTH:
        return

    # Estendi — cerco task compatibili dopo l'ultimo task
    last_task = current_blocks[-1].task
    max_gap = _MAX_CHAIN_GAP if enable_cross_cluster else 75

    lo = bisect.bisect_left(start_mins, last_task.end_min)
    hi = bisect.bisect_right(start_mins, last_task.end_min + max_gap)

    used_indices = {b.task.idx for b in current_blocks}

    for j in range(lo, hi):
        if len(result) >= max_riprese:
            return
        if len(result) - count_at_start >= max_per_start:
            return
        cand = tasks[j]
        if cand.idx in used_indices:
            continue

        # Usa can_chain_extended per supporto cross-cluster
        chain = can_chain_extended(
            last_task, cand,
            transfer_matrix=transfer_matrix if enable_cross_cluster else None,
            max_gap=max_gap,
        )
        if not chain.ok:
            continue

        block = DutyBlock(task=cand)
        if chain.is_cambio and chain.cluster:
            cl = cluster_by_id(chain.cluster)
            block.cambio = CambioInfo(
                cluster=chain.cluster,
                cluster_name=cl.name if cl else chain.cluster,
                from_vehicle=last_task.vehicle_id,
                to_vehicle=cand.vehicle_id,
            )
        elif chain.is_cambio:
            # Cross-cluster cambio (cluster diversi)
            block.cambio = CambioInfo(
                cluster=chain.cluster or "cross",
                cluster_name=f"{last_task.last_stop} → {cand.first_stop}",
                from_vehicle=last_task.vehicle_id,
                to_vehicle=cand.vehicle_id,
            )

        # Salva il costo del transfer sul blocco
        if chain.transfer:
            block.transfer_cost = chain.cost_euro  # type: ignore[attr-defined]
            block.transfer_type = chain.transfer_type  # type: ignore[attr-defined]
            block.transfer_time = chain.time_min  # type: ignore[attr-defined]

        current_blocks.append(block)
        _enumerate_from(
            tasks, start_mins, j, current_blocks,
            max_work, result, max_riprese,
            max_per_start, count_at_start,
            transfer_matrix=transfer_matrix,
            enable_cross_cluster=enable_cross_cluster,
            depth=depth + 1,
        )
        current_blocks.pop()


# ═══════════════════════════════════════════════════════════════
#  ENUMERAZIONE DUTY COMPLETA
# ═══════════════════════════════════════════════════════════════

def enumerate_duties_with_options(
    tasks: list[Task],
    transfer_matrix: dict[tuple[int, int], TaskTransfer] | None = None,
    rates: CostRates | None = None,
    max_duties: int = 80_000,
    enable_cross_cluster: bool = True,
) -> list[Duty]:
    """
    Enumera tutti i duty feasible con supporto per:
    - Trasferimenti cross-cluster
    - Costi pre-calcolati per ogni duty
    - Opzioni multiple (supplemento vs estensione vs cambio)
    """
    log(f"  [DutyEnum] Enumerating from {len(tasks)} tasks (cross_cluster={enable_cross_cluster})...")

    n = len(tasks)
    # Limiti di esplorazione più generosi per garantire buona copertura
    if n <= 200:
        max_rip = 200_000
        mps = 400
    elif n <= 500:
        max_rip = 100_000
        mps = 200
    elif n <= 1000:
        max_rip = 80_000
        mps = 100
    else:
        max_rip = 60_000
        mps = 80

    all_riprese_blocks = enumerate_riprese(
        tasks,
        transfer_matrix=transfer_matrix,
        max_riprese=max_rip,
        max_per_start=mps,
        enable_cross_cluster=enable_cross_cluster,
    )
    log(f"  [DutyEnum] {len(all_riprese_blocks)} feasible riprese found")

    # Copertura garantita: solo per task NON coperti da nessuna ripresa
    covered_tasks = set()
    for rblocks in all_riprese_blocks:
        for b in rblocks:
            covered_tasks.add(b.task.idx)
    missing = [t for t in tasks if t.idx not in covered_tasks]
    if missing:
        log(f"  [DutyEnum] Adding {len(missing)} singleton riprese for uncovered tasks")
        for t in missing:
            all_riprese_blocks.append([DutyBlock(task=t)])

    # Build Ripresa objects
    riprese = [build_ripresa(blocks) for blocks in all_riprese_blocks]

    duties: list[Duty] = []
    duty_idx = 0
    max_single = max_duties // 2

    # ── Single-ripresa: INTERO e SUPPLEMENTO ──
    for i, (rblocks, rip) in enumerate(zip(all_riprese_blocks, riprese)):
        if duty_idx >= max_single:
            break
        nastro = rip.end_min - rip.start_min
        work = rip.work_min
        task_indices = sorted({b.task.idx for b in rblocks})
        cambi = sum(1 for b in rblocks if b.cambio)
        n_tasks_in_rip = len(task_indices)

        # SUPPLEMENTO: max 150 min nastro, preferire solo se pochi task (1-2)
        if nastro <= SHIFT_RULES["supplemento"]["maxNastro"] and work <= 150:
            duties.append(Duty(
                idx=duty_idx, duty_type="supplemento",
                riprese=[rip],
                nastro_start=rip.start_min, nastro_end=rip.end_min,
                nastro_min=nastro, work_min=work, interruption_min=0,
                transfer_min=rip.transfer_min, pre_turno_min=PRE_TURNO_MIN,
                cambi_count=cambi, task_indices=task_indices,
            ))
            duty_idx += 1

        # INTERO: lavoro effettivo >= 30 min (molto rilassato: meglio un intero corto
        # che un supplemento — il modello di costo penalizzerà gli intero sotto-utilizzati)
        # Nastro ≤ 7h15 (435 min)
        if nastro <= SHIFT_RULES["intero"]["maxNastro"] and 30 <= work <= 435:
            duties.append(Duty(
                idx=duty_idx, duty_type="intero",
                riprese=[rip],
                nastro_start=rip.start_min, nastro_end=rip.end_min,
                nastro_min=nastro, work_min=work, interruption_min=0,
                transfer_min=rip.transfer_min, pre_turno_min=PRE_TURNO_MIN,
                cambi_count=cambi, task_indices=task_indices,
            ))
            duty_idx += 1

        if duty_idx >= max_single:
            break

    # ── Singleton safety net: solo per task senza copertura ──
    covered_by_duties = set()
    for d in duties:
        for ti in d.task_indices:
            covered_by_duties.add(ti)
    uncov = [t for t in tasks if t.idx not in covered_by_duties]
    singleton_count = 0
    if uncov:
        log(f"  [DutyEnum] {len(uncov)} tasks have no duty coverage — adding singletons")
        for t in uncov:
            rblocks_single = [DutyBlock(task=t)]
            rip_single = build_ripresa(rblocks_single)
            nastro = rip_single.end_min - rip_single.start_min
            work = rip_single.work_min

            s_type = "supplemento" if work <= 150 else "intero"

            duties.append(Duty(
                idx=duty_idx, duty_type=s_type,
                riprese=[rip_single],
                nastro_start=rip_single.start_min, nastro_end=rip_single.end_min,
                nastro_min=nastro, work_min=work, interruption_min=0,
                transfer_min=rip_single.transfer_min, pre_turno_min=PRE_TURNO_MIN,
                cambi_count=0, task_indices=[t.idx],
            ))
            duty_idx += 1
            singleton_count += 1

    log(f"  [DutyEnum] {singleton_count} singleton safety-net duties added")

    # ── Two-ripresa: SEMIUNICO e SPEZZATO ──
    log(f"  [DutyEnum] Generating 2-ripresa duties...")

    rip_indices_by_size = sorted(
        range(len(riprese)),
        key=lambda i: (len(all_riprese_blocks[i]), riprese[i].end_min),
    )

    rip_start_mins_list = [riprese[i].blocks[0].task.start_min for i in range(len(riprese))]
    rip_sorted_by_start = sorted(range(len(riprese)), key=lambda i: rip_start_mins_list[i])
    sorted_start_mins = [rip_start_mins_list[i] for i in rip_sorted_by_start]

    max_nastro = SHIFT_RULES["spezzato"]["maxNastro"]
    semi_int_min = SHIFT_RULES["semiunico"]["intMin"]

    pair_count = 0
    seen_pairs: set[tuple[int, int]] = set()

    for ii in rip_indices_by_size:
        if duty_idx >= max_duties:
            break
        rblocks1 = all_riprese_blocks[ii]
        rip1 = riprese[ii]
        tasks1 = {b.task.idx for b in rblocks1}
        end1 = rip1.blocks[-1].task.end_min

        min_start2 = end1 + semi_int_min
        max_start2 = rip1.start_min + max_nastro

        lo = bisect.bisect_left(sorted_start_mins, min_start2)
        hi = bisect.bisect_right(sorted_start_mins, max_start2)

        for jj in range(lo, hi):
            if duty_idx >= max_duties:
                break
            j = rip_sorted_by_start[jj]
            if j == ii:
                continue
            pair_key = (min(ii, j), max(ii, j))
            if pair_key in seen_pairs:
                continue
            seen_pairs.add(pair_key)

            rblocks2 = all_riprese_blocks[j]
            rip2 = riprese[j]

            tasks2 = {b.task.idx for b in rblocks2}
            if tasks1 & tasks2:
                continue

            raw_gap = rip2.blocks[0].task.start_min - end1
            effective_int = raw_gap - PRE_TURNO_MIN - rip2.transfer_min

            nastro = rip2.end_min - rip1.start_min
            total_work = rip1.work_min + rip2.work_min
            task_indices = sorted(tasks1 | tasks2)
            cambi = sum(1 for b in rblocks1 + rblocks2 if b.cambio)

            # SEMIUNICO: work 4h–8h
            if (SHIFT_RULES["semiunico"]["intMin"] <= effective_int <= SHIFT_RULES["semiunico"]["intMax"]
                    and nastro <= SHIFT_RULES["semiunico"]["maxNastro"]
                    and 240 <= total_work <= 480):
                duties.append(Duty(
                    idx=duty_idx, duty_type="semiunico",
                    riprese=[rip1, rip2],
                    nastro_start=rip1.start_min, nastro_end=rip2.end_min,
                    nastro_min=nastro, work_min=total_work,
                    interruption_min=effective_int,
                    transfer_min=rip1.transfer_min + rip2.transfer_min,
                    pre_turno_min=PRE_TURNO_MIN * 2,
                    cambi_count=cambi, task_indices=task_indices,
                ))
                duty_idx += 1
                pair_count += 1

            # SPEZZATO: work 4h–7h30
            if (SHIFT_RULES["spezzato"]["intMin"] <= effective_int
                    and nastro <= SHIFT_RULES["spezzato"]["maxNastro"]
                    and 240 <= total_work <= 450):
                duties.append(Duty(
                    idx=duty_idx, duty_type="spezzato",
                    riprese=[rip1, rip2],
                    nastro_start=rip1.start_min, nastro_end=rip2.end_min,
                    nastro_min=nastro, work_min=total_work,
                    interruption_min=effective_int,
                    transfer_min=rip1.transfer_min + rip2.transfer_min,
                    pre_turno_min=PRE_TURNO_MIN * 2,
                    cambi_count=cambi, task_indices=task_indices,
                ))
                duty_idx += 1
                pair_count += 1

    log(f"  [DutyEnum] Total duties: {duty_idx} ({pair_count} 2-ripresa pairs)")

    # ── Pre-calcola costo per ogni duty se rates disponibili ──
    if rates:
        log(f"  [DutyEnum] Computing cost for {len(duties)} duties...")
        for duty in duties:
            duty.cost_breakdown = compute_duty_cost(duty, rates)  # type: ignore[attr-defined]
            duty.cost_euro = duty.cost_breakdown.total  # type: ignore[attr-defined]

    return duties
