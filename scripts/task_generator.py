"""
task_generator.py — Generazione task multi-granularità
Conerobus S.p.A. / TransitIntel

Genera task a 3 livelli (fine/medium/coarse) per ogni turno macchina.
Il solver sceglie quale livello usare tramite vincoli di esclusività.
"""

from __future__ import annotations
from dataclasses import dataclass
from typing import Any

from optimizer_common import (
    Task, VShiftTrip,
    match_cluster, cluster_by_id, depot_transfer_min,
    log,
)


# ═══════════════════════════════════════════════════════════════
#  COSTANTI
# ═══════════════════════════════════════════════════════════════

MIN_SPLIT_GAP_FINE_CLUSTER = 5     # gap minimo per taglio fine a cluster
MIN_SPLIT_GAP_FINE_OTHER = 20      # gap minimo per taglio fine senza cluster
MIN_SPLIT_GAP_MEDIUM = 15          # gap minimo per taglio medium


# ═══════════════════════════════════════════════════════════════
#  ESCLUSIVITÀ MULTI-LIVELLO
# ═══════════════════════════════════════════════════════════════

@dataclass
class ExclusivityGroup:
    """Gruppo di task mutuamente esclusivi per un turno macchina."""
    vehicle_id: str
    coarse_indices: list[int]      # indici task livello coarse (1 solo)
    fine_indices: list[int]        # indici task livello fine
    medium_indices: list[int]      # indici task livello medium
    trip_ids: list[str]            # trip_id delle corse coperte


# ═══════════════════════════════════════════════════════════════
#  HELPER
# ═══════════════════════════════════════════════════════════════

def _make_task(
    idx: int, vid: str, vtype: str,
    trips: list[VShiftTrip],
    granularity: str = "fine",
    vehicle_shift_id: str | None = None,
) -> Task:
    """Crea un Task da un segmento di corse."""
    first = trips[0]
    last = trips[-1]
    driving = sum(t.arrival_min - t.departure_min for t in trips)
    first_stop = first.first_stop_name or "?"
    last_stop = last.last_stop_name or "?"

    task = Task(
        idx=idx,
        vehicle_id=vid,
        vehicle_type=vtype,
        trips=trips,
        start_min=first.departure_min,
        end_min=last.arrival_min,
        duration_min=last.arrival_min - first.departure_min,
        driving_min=driving,
        first_stop=first_stop,
        last_stop=last_stop,
        first_cluster=match_cluster(first_stop),
        last_cluster=match_cluster(last_stop),
    )
    # Estensioni per multi-granularità
    task.granularity = granularity  # type: ignore[attr-defined]
    task.vehicle_shift_id = vehicle_shift_id  # type: ignore[attr-defined]

    # Coordinate GPS (dalla prima/ultima corsa, se disponibili)
    task.first_lat = getattr(first, "first_stop_lat", 0.0) or 0.0  # type: ignore[attr-defined]
    task.first_lon = getattr(first, "first_stop_lon", 0.0) or 0.0  # type: ignore[attr-defined]
    task.last_lat = getattr(last, "last_stop_lat", 0.0) or 0.0  # type: ignore[attr-defined]
    task.last_lon = getattr(last, "last_stop_lon", 0.0) or 0.0  # type: ignore[attr-defined]

    return task


def _split_trips_at(trips: list[VShiftTrip], cut_indices: list[int]) -> list[list[VShiftTrip]]:
    """Divide una lista di corse ai cut_indices indicati."""
    segments: list[list[VShiftTrip]] = []
    prev = 0
    for ci in sorted(set(cut_indices)):
        if ci > prev:
            segments.append(trips[prev:ci])
        prev = ci
    if prev < len(trips):
        segments.append(trips[prev:])
    return [s for s in segments if len(s) > 0]


def _parse_vehicle_shift(d: dict) -> tuple[str, str, list[VShiftTrip]]:
    """Parse a vehicle shift dict into (vehicleId, vehicleType, trips)."""
    vid = d["vehicleId"]
    vtype = d["vehicleType"]
    trips: list[VShiftTrip] = []
    for td in d.get("trips", []):
        trips.append(VShiftTrip(
            type=td["type"],
            trip_id=td.get("tripId", ""),
            route_id=td.get("routeId", ""),
            route_name=td.get("routeName", ""),
            headsign=td.get("headsign"),
            departure_time=td.get("departureTime", ""),
            arrival_time=td.get("arrivalTime", ""),
            departure_min=td.get("departureMin", 0),
            arrival_min=td.get("arrivalMin", 0),
            first_stop_name=td.get("firstStopName", ""),
            last_stop_name=td.get("lastStopName", ""),
            stop_count=td.get("stopCount", 0),
            duration_min=td.get("durationMin", 0),
            direction_id=td.get("directionId", 0),
            deadhead_km=td.get("deadheadKm", 0),
            deadhead_min=td.get("deadheadMin", 0),
            downsized=td.get("downsized", False),
            original_vehicle=td.get("originalVehicle"),
        ))
    return vid, vtype, trips


# ═══════════════════════════════════════════════════════════════
#  BUILD TASKS MULTI-LIVELLO
# ═══════════════════════════════════════════════════════════════

def build_tasks_multilevel(
    vehicle_shifts_raw: list[dict],
    task_granularity: str = "auto",
) -> tuple[list[Task], list[ExclusivityGroup]]:
    """
    Genera task a più livelli di granularità per ogni turno macchina urbano.

    Livelli:
      - COARSE: intero turno come singolo task (nessun cambio possibile)
      - MEDIUM: tagli solo a gap ≥ 15 min dove c'è un cluster
      - FINE: tagli a ogni punto cluster/gap (come il vecchio build_tasks)

    Il solver sceglie quale livello usare per ogni turno macchina.

    task_granularity:
      - "auto": genera tutti e 3 i livelli, il solver sceglie
      - "fine": solo livello fine
      - "medium": solo livello medium
      - "coarse": solo livello coarse

    Returns:
      (tasks, exclusivity_groups)
    """
    tasks: list[Task] = []
    exclusivity_groups: list[ExclusivityGroup] = []
    idx = 0

    for vs_dict in vehicle_shifts_raw:
        vid, vtype, all_trips = _parse_vehicle_shift(vs_dict)
        category = vs_dict.get("category", "urbano")

        if category != "urbano":
            continue

        trip_entries = [t for t in all_trips if t.type == "trip"]
        trip_entries.sort(key=lambda t: t.departure_min)

        if not trip_entries:
            continue

        trip_ids = [t.trip_id for t in trip_entries]

        # Identifica tutti i punti di taglio candidati
        cut_points: list[dict] = []
        for i in range(1, len(trip_entries)):
            prev, curr = trip_entries[i - 1], trip_entries[i]
            gap = curr.departure_min - prev.arrival_min
            prev_cluster = match_cluster(prev.last_stop_name)
            curr_cluster = match_cluster(curr.first_stop_name)
            at_cluster = (prev_cluster is not None or curr_cluster is not None)

            cut_points.append({
                "index": i,
                "gap": gap,
                "at_cluster": at_cluster,
                "same_cluster": prev_cluster is not None and prev_cluster == curr_cluster,
                "feasible_fine": (at_cluster and gap >= MIN_SPLIT_GAP_FINE_CLUSTER) or gap >= MIN_SPLIT_GAP_FINE_OTHER,
                "feasible_medium": gap >= MIN_SPLIT_GAP_MEDIUM and at_cluster,
            })

        fine_cuts = [cp["index"] for cp in cut_points if cp["feasible_fine"]]
        medium_cuts = [cp["index"] for cp in cut_points if cp["feasible_medium"]]

        group = ExclusivityGroup(
            vehicle_id=vid,
            coarse_indices=[],
            fine_indices=[],
            medium_indices=[],
            trip_ids=trip_ids,
        )

        generate_coarse = task_granularity in ("auto", "coarse")
        generate_medium = task_granularity in ("auto", "medium") and medium_cuts and medium_cuts != fine_cuts
        generate_fine = task_granularity in ("auto", "fine") and fine_cuts

        # Se solo 1 livello è utile (es. nessun taglio possibile), solo coarse
        if not fine_cuts and not medium_cuts:
            generate_coarse = True
            generate_fine = False
            generate_medium = False

        # COARSE: intero turno come singolo task
        if generate_coarse:
            t = _make_task(idx, vid, vtype, trip_entries, "coarse", vid)
            tasks.append(t)
            group.coarse_indices.append(idx)
            idx += 1

        # FINE: taglio a ogni punto feasible_fine
        if generate_fine:
            segments = _split_trips_at(trip_entries, fine_cuts)
            for seg in segments:
                t = _make_task(idx, vid, vtype, seg, "fine", vid)
                tasks.append(t)
                group.fine_indices.append(idx)
                idx += 1

        # MEDIUM: taglio solo a gap grandi con cluster
        if generate_medium:
            segments = _split_trips_at(trip_entries, medium_cuts)
            for seg in segments:
                t = _make_task(idx, vid, vtype, seg, "medium", vid)
                tasks.append(t)
                group.medium_indices.append(idx)
                idx += 1

        # Se nessun livello genera task, fallback coarse
        if not group.coarse_indices and not group.fine_indices and not group.medium_indices:
            t = _make_task(idx, vid, vtype, trip_entries, "coarse", vid)
            tasks.append(t)
            group.coarse_indices.append(idx)
            idx += 1

        exclusivity_groups.append(group)

    # Log
    n_coarse = sum(len(g.coarse_indices) for g in exclusivity_groups)
    n_fine = sum(len(g.fine_indices) for g in exclusivity_groups)
    n_medium = sum(len(g.medium_indices) for g in exclusivity_groups)
    n_multi = sum(1 for g in exclusivity_groups
                  if (len(g.coarse_indices) > 0) + (len(g.fine_indices) > 0) + (len(g.medium_indices) > 0) > 1)
    log(f"  [TaskGen] {len(tasks)} tasks: {n_coarse} coarse + {n_fine} fine + {n_medium} medium, "
        f"{n_multi} turni con multi-livello, {len(exclusivity_groups)} gruppi")

    return tasks, exclusivity_groups


# ═══════════════════════════════════════════════════════════════
#  BACKWARD COMPAT: build_tasks (solo fine, come prima)
# ═══════════════════════════════════════════════════════════════

def build_tasks(vehicle_shifts_raw: list[dict]) -> list[Task]:
    """
    Backward-compatible: genera solo task FINE (come il vecchio build_tasks).
    Nessun gruppo di esclusività.
    """
    tasks, _ = build_tasks_multilevel(vehicle_shifts_raw, task_granularity="fine")
    return tasks
