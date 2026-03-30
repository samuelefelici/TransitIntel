"""
transfer_matrix.py — Matrice trasferimenti tra task
Conerobus S.p.A. / TransitIntel

Calcola distanze, tempi e costi di trasferimento tra ogni coppia di task
compatibili. Estende can_chain() con trasferimenti cross-cluster.
"""

from __future__ import annotations
from dataclasses import dataclass
from typing import Any

from optimizer_common import (
    Task,
    haversine_km, match_cluster, cluster_by_id,
    DEFAULT_CLUSTERS, DEPOT_TRANSFER_CENTRAL,
    log,
)
from cost_model import CostRates


# ═══════════════════════════════════════════════════════════════
#  TIPI
# ═══════════════════════════════════════════════════════════════

@dataclass
class TaskTransfer:
    """Costo e tempo di trasferimento tra due task."""
    from_task_idx: int
    to_task_idx: int
    transfer_type: str          # "same_vehicle" | "same_stop" | "walk" | "company_car" | "taxi"
    distance_km: float
    time_min: int
    cost_euro: float


@dataclass
class ChainResult:
    """Risultato di can_chain_extended."""
    ok: bool
    transfer_type: str = "none"
    cost_euro: float = 0.0
    time_min: int = 0
    is_cambio: bool = False
    cluster: str | None = None
    transfer: TaskTransfer | None = None


# ═══════════════════════════════════════════════════════════════
#  MATRICE TRASFERIMENTI
# ═══════════════════════════════════════════════════════════════

def build_transfer_matrix(
    tasks: list[Task],
    rates: CostRates,
    max_gap: int = 180,
) -> dict[tuple[int, int], TaskTransfer]:
    """
    Pre-calcola la matrice dei trasferimenti tra tutte le coppie
    di task compatibili (b.start > a.end, gap ≤ max_gap).

    Ordine di precedenza:
      1. same_vehicle/same_stop → 0 costo
      2. same_cluster → cambio in linea (€5 overhead)
      3. walk (< 0.5 km) → tempo a piedi, €0 + retribuzione
      4. company_car (< 5 km) → €8/uso
      5. taxi (≥ 5 km) → €6 + km
    """
    import bisect

    matrix: dict[tuple[int, int], TaskTransfer] = {}
    n = len(tasks)
    if n == 0:
        return matrix

    tasks_by_start = sorted(range(n), key=lambda i: tasks[i].start_min)
    start_mins = [tasks[i].start_min for i in tasks_by_start]

    for a in tasks:
        # Solo task che iniziano dopo a.end e entro max_gap
        lo = bisect.bisect_left(start_mins, a.end_min)
        hi = bisect.bisect_right(start_mins, a.end_min + max_gap)

        for j_idx in range(lo, hi):
            bi = tasks_by_start[j_idx]
            b = tasks[bi]
            if b.idx == a.idx:
                continue

            gap = b.start_min - a.end_min
            if gap < 0 or gap > max_gap:
                continue

            # 1. Stesso veicolo → nessun trasferimento
            if a.vehicle_id == b.vehicle_id:
                matrix[(a.idx, b.idx)] = TaskTransfer(
                    a.idx, b.idx, "same_vehicle", 0, 0, 0)
                continue

            # 2. Stesso cluster → cambio in linea
            if (a.last_cluster and b.first_cluster
                    and a.last_cluster == b.first_cluster):
                matrix[(a.idx, b.idx)] = TaskTransfer(
                    a.idx, b.idx, "same_stop", 0, 3, rates.cambio_overhead)
                continue

            # 3-5. Calcola distanza reale se abbiamo coordinate
            a_lat = getattr(a, "last_lat", 0.0)
            a_lon = getattr(a, "last_lon", 0.0)
            b_lat = getattr(b, "first_lat", 0.0)
            b_lon = getattr(b, "first_lon", 0.0)

            if a_lat == 0 or b_lat == 0:
                # Nessuna coordinata → stima basata su cluster
                a_cl = cluster_by_id(a.last_cluster) if a.last_cluster else None
                b_cl = cluster_by_id(b.first_cluster) if b.first_cluster else None
                if a_cl and b_cl:
                    # Entrambi hanno cluster diversi: stima ~2km, auto aziendale
                    matrix[(a.idx, b.idx)] = TaskTransfer(
                        a.idx, b.idx, "company_car", 2.0, 10, rates.company_car_per_use)
                elif a_cl or b_cl:
                    # Uno ha cluster → stima 3km
                    matrix[(a.idx, b.idx)] = TaskTransfer(
                        a.idx, b.idx, "company_car", 3.0, 12, rates.company_car_per_use)
                # else: nessun cluster noto, nessun trasferimento possibile
                continue

            dist = haversine_km(a_lat, a_lon, b_lat, b_lon)

            if dist < 0.3:
                # Vicinissimi, forse stessa fermata/piazza → walk
                walk_time = max(2, int(dist / 0.08) + 1)  # ~5 km/h
                per_min = rates.hourly_rate / 60
                matrix[(a.idx, b.idx)] = TaskTransfer(
                    a.idx, b.idx, "walk", dist, walk_time,
                    walk_time * per_min)
            elif dist < 5:
                # Auto aziendale
                drive_time = max(5, int(dist / 25 * 60) + 3)
                matrix[(a.idx, b.idx)] = TaskTransfer(
                    a.idx, b.idx, "company_car", dist, drive_time,
                    rates.company_car_per_use)
            else:
                # Taxi
                drive_time = max(8, int(dist / 30 * 60) + 5)
                taxi_cost = rates.taxi_base + dist * rates.taxi_per_km
                matrix[(a.idx, b.idx)] = TaskTransfer(
                    a.idx, b.idx, "taxi", dist, drive_time, taxi_cost)

    log(f"  [Transfer] Matrix built: {len(matrix)} entries for {n} tasks")
    return matrix


# ═══════════════════════════════════════════════════════════════
#  CAN_CHAIN ESTESO
# ═══════════════════════════════════════════════════════════════

CAMBIO_TIME_MIN = 3

def can_chain_extended(
    a: Task,
    b: Task,
    transfer_matrix: dict[tuple[int, int], TaskTransfer] | None = None,
    max_gap: int = 120,
    safety_margin: int = 3,
) -> ChainResult:
    """
    Versione estesa di can_chain che considera tutti i tipi di trasferimento,
    non solo cambio allo stesso cluster.

    Returns ChainResult con ok, tipo trasferimento, costo, tempo.
    """
    gap = b.start_min - a.end_min
    if gap < 0:
        return ChainResult(ok=False)
    if gap > max_gap:
        return ChainResult(ok=False)

    # Stesso veicolo → sempre ok
    if a.vehicle_id == b.vehicle_id:
        return ChainResult(ok=True, transfer_type="same_vehicle", cost_euro=0, time_min=0)

    # Controlla transfer matrix
    if transfer_matrix:
        transfer = transfer_matrix.get((a.idx, b.idx))
        if transfer:
            # Il trasferimento deve rientrare nel gap (con margine)
            if transfer.time_min + safety_margin <= gap:
                return ChainResult(
                    ok=True,
                    transfer_type=transfer.transfer_type,
                    cost_euro=transfer.cost_euro,
                    time_min=transfer.time_min,
                    is_cambio=True,
                    cluster=a.last_cluster if a.last_cluster == b.first_cluster else None,
                    transfer=transfer,
                )

    # Fallback: stesso cluster, gap sufficiente
    if (a.last_cluster and b.first_cluster
            and a.last_cluster == b.first_cluster
            and gap >= CAMBIO_TIME_MIN):
        return ChainResult(
            ok=True,
            transfer_type="same_stop",
            cost_euro=5.0,  # default cambio overhead
            time_min=3,
            is_cambio=True,
            cluster=a.last_cluster,
        )

    return ChainResult(ok=False)
