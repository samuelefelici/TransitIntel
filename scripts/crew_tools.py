"""crew_tools.py — Strumenti BDSI-style sul risultato dei turni guida.

Tre modalità (campo "mode" nell'input JSON su stdin, output JSON su stdout):

1. "validate"    — ri-verifica BDS di turni guida modificati a mano nel
                   workspace (BDSI §10.1: verificatore di correttezza).
                   Input:  { mode, shifts: [DriverShiftData-like], config }
                   Output: { results: { [driverId]: {type, bdsValidation,
                             nastroMin, workMin, drivingMin, interruptionMin} } }

2. "swap"        — euristica "Scambia con pezzo..." (BDSI §12.2): dato un
                   pezzo scoperto (lista corse), propone i turni guida che
                   possono assorbirlo rilasciando una loro ripresa/pezzo,
                   validando il turno risultante.
                   Input:  { mode, piece: {trips:[...]}, shifts, config,
                             maxProposals? }
                   Output: { proposals: [{driverId, releasedTrips, valid,
                             violations, deltaWorkMin, newType}] }

3. "turni_unici" — euristica "Turni unici" (BDSI §12.1): dentro una fascia
                   oraria crea turni guida composti da un solo pezzo che
                   massimizzano il tempo di lavoro, dai pezzi scoperti.
                   Input:  { mode, pieces: [{vehicleId, vehicleType, trips}],
                             fasciaStartMin?, fasciaEndMin?, config }
                   Output: { duties: [DriverShiftData-like], skipped: [...] }

Riusa la FONTE UNICA di crew_scheduler_v4 (classify_duty, validate_duty_bds,
single/pair_nastro_work): la verifica qui è identica a quella del solver.
"""
from __future__ import annotations

import json
import sys

from optimizer_common import DriverDutyV3, VShiftTrip, min_to_time, parse_clusters_from_config
from crew_scheduler_v4 import (
    BDSConfig,
    _make_segment,
    apply_fase2_overrides,
    apply_optimizer_overrides,
    apply_shift_rules_override,
    apply_sosta_inoperosa_config,
    classify_duty,
    compute_work_bds,
    depot_transfer_min,
    merge_config,
    pair_nastro_work,
    pre_turno_for,
    single_nastro_work,
    validate_duty_bds,
)


def _setup(config_raw: dict):
    """Config identica a crew_scheduler_v4.run(): stessi override, stessi cluster."""
    config = merge_config(config_raw or {})
    apply_shift_rules_override(config)
    apply_optimizer_overrides(config)
    apply_fase2_overrides(config)
    apply_sosta_inoperosa_config(config)
    clusters = parse_clusters_from_config(config)
    bds = BDSConfig.from_config(config)
    return config, clusters, bds


def _trip_from_dict(t: dict) -> VShiftTrip | None:
    dep = t.get("departureMin")
    arr = t.get("arrivalMin")
    if dep is None or arr is None:
        return None
    dep, arr = int(dep), int(arr)
    return VShiftTrip(
        type="trip",
        trip_id=str(t.get("tripId", "")),
        route_id=str(t.get("routeId", "") or ""),
        route_name=str(t.get("routeName", "") or t.get("routeId", "") or ""),
        headsign=t.get("headsign"),
        departure_time=t.get("departureTime") or min_to_time(dep),
        arrival_time=t.get("arrivalTime") or min_to_time(arr),
        departure_min=dep,
        arrival_min=arr,
        first_stop_name=str(t.get("firstStopName", "") or ""),
        last_stop_name=str(t.get("lastStopName", "") or ""),
        duration_min=max(0, arr - dep),
        variant_code=str(t.get("variantCode", "") or ""),
    )


def _segments_from_riprese(riprese: list[dict], clusters) -> list:
    """Ricostruisce i Segment dalle riprese serializzate (una ripresa = un segmento)."""
    segments = []
    for rip in riprese or []:
        trips = []
        for t in rip.get("trips", []) or []:
            vt = _trip_from_dict(t)
            if vt is not None:
                trips.append(vt)
        if not trips:
            continue
        trips.sort(key=lambda x: x.departure_min)
        vehicle_id = str((rip.get("vehicleIds") or [None])[0]
                         or (rip.get("trips") or [{}])[0].get("vehicleId", "") or "")
        vehicle_type = str(rip.get("vehicleType", "") or "12m")
        segments.append(_make_segment(vehicle_id, vehicle_type, trips, "full", None, clusters))
    segments.sort(key=lambda s: s.start_min)
    return segments


def duty_from_segments(driver_id: str, segments: list, bds, clusters) -> DriverDutyV3 | None:
    """Costruisce un DriverDutyV3 da 1-2 segmenti, con nastro/work FONTE UNICA."""
    if not segments:
        return None
    if len(segments) == 1:
        s = segments[0]
        transfer = depot_transfer_min(s.first_stop, clusters)
        transfer_back = depot_transfer_min(s.last_stop, clusters)
        pt = pre_turno_for(transfer)
        nastro, work = single_nastro_work(s, bds, clusters)
        interruption = 0
        driving = s.driving_min
        nastro_start = s.start_min - pt - transfer
        nastro_end = s.end_min + transfer_back
    else:
        # >2 riprese non è previsto dalla normativa: usa primo+ultimo per i
        # calcoli, la classificazione segnalerà comunque l'invalidità.
        s1, s2 = segments[0], segments[-1]
        transfer = depot_transfer_min(s1.first_stop, clusters)
        transfer_back = depot_transfer_min(s2.last_stop, clusters)
        pt = pre_turno_for(transfer)
        nastro, work = pair_nastro_work(s1, s2, bds, clusters)
        # lavoro dei segmenti intermedi (caso anomalo >2 riprese)
        for mid in segments[1:-1]:
            work += mid.work_min
        interruption = max(0, s2.start_min - s1.end_min)
        driving = sum(s.driving_min for s in segments)
        nastro_start = s1.start_min - pt - transfer
        nastro_end = s2.end_min + transfer_back

    d = DriverDutyV3(
        idx=0,
        driver_id=driver_id,
        duty_type="intero",
        segments=segments,
        nastro_start=nastro_start,
        nastro_end=nastro_end,
        nastro_min=nastro,
        work_min=work,
        driving_min=driving,
        interruption_min=interruption,
        pre_turno_min=pre_turno_for(depot_transfer_min(segments[0].first_stop, clusters)),
        transfer_min=depot_transfer_min(segments[0].first_stop, clusters),
        transfer_back_min=depot_transfer_min(segments[-1].last_stop, clusters),
    )
    d.duty_type = classify_duty(d, bds, clusters)
    return d


def duty_from_shift(shift: dict, bds, clusters) -> DriverDutyV3 | None:
    segments = _segments_from_riprese(shift.get("riprese", []), clusters)
    return duty_from_segments(str(shift.get("driverId", "?")), segments, bds, clusters)


def _duty_report(d: DriverDutyV3, bds, clusters) -> dict:
    v = validate_duty_bds(d, bds, clusters)
    wc = compute_work_bds(d, bds, clusters)
    return {
        "type": d.duty_type,
        "bdsValidation": v.to_dict(),
        "nastroMin": d.nastro_min,
        "workMin": d.work_min,
        "drivingMin": d.driving_min,
        "interruptionMin": d.interruption_min,
        "workCalculation": wc.to_dict() if hasattr(wc, "to_dict") else None,
        # Fuorilinea calcolati dalla FONTE UNICA (per la Finestra di lavoro:
        # il turno rimpacchettato riceve pre-turno/trasferimenti automatici)
        "preTurnoMin": d.pre_turno_min,
        "transferMin": d.transfer_min,
        "transferBackMin": d.transfer_back_min,
        "nastroStartMin": d.nastro_start,
        "nastroEndMin": d.nastro_end,
    }


# ═══════════════════════════════════════════════════════════════
#  MODE 1 — VALIDATE (BDSI §10.1)
# ═══════════════════════════════════════════════════════════════

def run_validate(raw: dict) -> dict:
    _, clusters, bds = _setup(raw.get("config", {}))
    results: dict[str, dict] = {}
    for shift in raw.get("shifts", []) or []:
        driver_id = str(shift.get("driverId", "?"))
        try:
            d = duty_from_shift(shift, bds, clusters)
            if d is None:
                results[driver_id] = {"error": "nessuna corsa nel turno"}
                continue
            results[driver_id] = _duty_report(d, bds, clusters)
        except Exception as e:  # noqa: BLE001 — un turno malformato non blocca gli altri
            results[driver_id] = {"error": str(e)}
    return {"results": results}


# ═══════════════════════════════════════════════════════════════
#  MODE 2 — SCAMBIA CON PEZZO (BDSI §12.2)
# ═══════════════════════════════════════════════════════════════

def _overlaps(a_start: int, a_end: int, b_start: int, b_end: int) -> bool:
    return a_start < b_end and b_start < a_end


def run_swap(raw: dict) -> dict:
    """Per ogni turno guida: prova (a) l'inserimento diretto del pezzo scoperto,
    (b) lo scambio rilasciando una delle sue riprese. Ritorna le proposte
    valide (o quasi) ordinate per lavoro guadagnato."""
    _, clusters, bds = _setup(raw.get("config", {}))
    piece = raw.get("piece", {}) or {}
    piece_trips = [t for t in (piece.get("trips") or [])]
    max_proposals = int(raw.get("maxProposals", 10) or 10)
    if not piece_trips:
        return {"proposals": [], "error": "pezzo vuoto"}

    piece_vts = sorted([vt for vt in (_trip_from_dict(t) for t in piece_trips) if vt],
                       key=lambda x: x.departure_min)
    if not piece_vts:
        return {"proposals": [], "error": "corse del pezzo senza orari"}
    p_start, p_end = piece_vts[0].departure_min, piece_vts[-1].arrival_min
    p_vid = str(piece.get("vehicleId", "") or piece_trips[0].get("vehicleId", "") or "")
    p_vtype = str(piece.get("vehicleType", "") or "12m")
    piece_seg_proto = [dict(t) for t in piece_trips]

    proposals: list[dict] = []
    for shift in raw.get("shifts", []) or []:
        driver_id = str(shift.get("driverId", "?"))
        riprese = shift.get("riprese", []) or []
        base_segments = _segments_from_riprese(riprese, clusters)
        if not base_segments:
            continue
        base_duty = duty_from_segments(driver_id, list(base_segments), bds, clusters)
        base_work = base_duty.work_min if base_duty else 0

        # Candidati: (etichetta, riprese risultanti come liste di segmenti)
        candidates: list[tuple[str, list, list[dict]]] = []

        # (a) inserimento diretto: il pezzo diventa una nuova ripresa, se non
        #     si sovrappone a nessun segmento esistente e restiamo ≤2 riprese
        if len(base_segments) < 2 and not any(
                _overlaps(p_start, p_end, s.start_min, s.end_min) for s in base_segments):
            piece_seg = _make_segment(p_vid, p_vtype, list(piece_vts), "full", None, clusters)
            candidates.append(("insert", sorted(base_segments + [piece_seg],
                                                key=lambda s: s.start_min), []))

        # (b) scambio: rilascia una ripresa e mettici il pezzo (se compatibile
        #     con le riprese rimanenti)
        for ri, seg in enumerate(base_segments):
            rest = [s for si, s in enumerate(base_segments) if si != ri]
            if any(_overlaps(p_start, p_end, s.start_min, s.end_min) for s in rest):
                continue
            piece_seg = _make_segment(p_vid, p_vtype, list(piece_vts), "full", None, clusters)
            released = [
                {
                    "tripId": t.trip_id, "routeName": t.route_name,
                    "departureMin": t.departure_min, "arrivalMin": t.arrival_min,
                    "departureTime": t.departure_time, "arrivalTime": t.arrival_time,
                    "firstStopName": t.first_stop_name, "lastStopName": t.last_stop_name,
                    "vehicleId": seg.vehicle_id, "vehicleType": seg.vehicle_type,
                }
                for t in seg.trips
            ]
            candidates.append((f"swap_ripresa_{ri}",
                               sorted(rest + [piece_seg], key=lambda s: s.start_min),
                               released))

        for label, segs, released in candidates:
            duty = duty_from_segments(driver_id, segs, bds, clusters)
            if duty is None:
                continue
            v = validate_duty_bds(duty, bds, clusters)
            delta_work = duty.work_min - base_work
            # per uno scambio (non inserimento) vogliamo assorbire rilasciando
            # un pezzo più corto: il rilasciato torna scoperto ma più facile da
            # piazzare. Teniamo comunque anche i pareggi.
            proposals.append({
                "driverId": driver_id,
                "kind": "insert" if label == "insert" else "swap",
                "releasedTrips": released,
                "valid": bool(v.valid),
                "newType": duty.duty_type,
                "violations": list(v.violations),
                "deltaWorkMin": delta_work,
                "newNastroMin": duty.nastro_min,
                "newWorkMin": duty.work_min,
            })

    # Ordina: prima i validi, poi per lavoro guadagnato decrescente
    proposals.sort(key=lambda p: (not p["valid"], -p["deltaWorkMin"]))
    return {
        "proposals": proposals[:max_proposals],
        "pieceSpan": {"startMin": p_start, "endMin": p_end,
                      "trips": len(piece_vts)},
        "evaluated": len(proposals),
    }


# ═══════════════════════════════════════════════════════════════
#  MODE 3 — TURNI UNICI (BDSI §12.1)
# ═══════════════════════════════════════════════════════════════

def run_turni_unici(raw: dict) -> dict:
    """Per ogni pezzo scoperto dentro la fascia crea un turno guida mono-pezzo
    (il più lungo possibile = tutte le corse del pezzo), se conforme."""
    _, clusters, bds = _setup(raw.get("config", {}))
    fascia_start = int(raw.get("fasciaStartMin", 0) or 0)
    fascia_end = int(raw.get("fasciaEndMin", 32 * 60) or 32 * 60)
    prefix = str(raw.get("dutyPrefix", "TU") or "TU")
    require_valid = bool(raw.get("requireValid", True))

    duties_out: list[dict] = []
    skipped: list[dict] = []
    counter = 1

    for piece in raw.get("pieces", []) or []:
        vts = sorted([vt for vt in (_trip_from_dict(t) for t in (piece.get("trips") or [])) if vt],
                     key=lambda x: x.departure_min)
        if not vts:
            continue
        vid = str(piece.get("vehicleId", "") or "")
        vtype = str(piece.get("vehicleType", "") or "12m")
        if vts[0].departure_min < fascia_start or vts[-1].arrival_min > fascia_end:
            skipped.append({"vehicleId": vid, "reason": "fuori fascia",
                            "startMin": vts[0].departure_min, "endMin": vts[-1].arrival_min})
            continue

        # Turno unico massimale = tutte le corse; se scorretto, prova a
        # ridurre dalla coda finché conforme (massimizza comunque il lavoro).
        best = None
        trips_try = list(vts)
        while trips_try:
            seg = _make_segment(vid, vtype, list(trips_try), "full", None, clusters)
            duty = duty_from_segments(f"{prefix}{counter:03d}", [seg], bds, clusters)
            if duty is None:
                break
            v = validate_duty_bds(duty, bds, clusters)
            if v.valid or not require_valid:
                best = (duty, v, list(trips_try))
                break
            trips_try.pop()  # accorcia dalla coda

        if best is None:
            skipped.append({"vehicleId": vid, "reason": "nessun turno conforme possibile",
                            "trips": len(vts)})
            continue

        duty, v, used = best
        counter += 1
        leftover = [t for t in vts if t not in used]
        duties_out.append({
            "driverId": duty.driver_id,
            "type": duty.duty_type,
            "nastroMin": duty.nastro_min,
            "workMin": duty.work_min,
            "drivingMin": duty.driving_min,
            "interruptionMin": duty.interruption_min,
            "bdsValidation": v.to_dict(),
            "riprese": [{
                # confini di NASTRO (pre-turno + trasferimento … rientro), come
                # il CSP v4 e il greedy: la UI li disegna così
                "startTime": min_to_time(max(0, used[0].departure_min - duty.pre_turno_min - duty.transfer_min)),
                "endTime": min_to_time(used[-1].arrival_min + duty.transfer_back_min),
                "startMin": used[0].departure_min - duty.pre_turno_min - duty.transfer_min,
                "endMin": used[-1].arrival_min + duty.transfer_back_min,
                "serviceStartMin": used[0].departure_min,
                "serviceEndMin": used[-1].arrival_min,
                "preTurnoMin": duty.pre_turno_min,
                "preTurnoKind": ("bus" if duty.transfer_min == 0 else "auto") if duty.pre_turno_min > 0 else "none",
                "transferMin": duty.transfer_min,
                "transferType": "depot_to_start" if duty.transfer_min > 0 else "none",
                "transferBackMin": duty.transfer_back_min,
                "transferBackType": "end_to_depot" if duty.transfer_back_min > 0 else "none",
                "workMin": duty.work_min,
                "vehicleIds": [vid],
                "vehicleType": vtype,
                "cambi": [],
                "trips": [{
                    "tripId": t.trip_id, "routeId": t.route_id, "routeName": t.route_name,
                    **({"variantCode": t.variant_code} if getattr(t, "variant_code", "") else {}),
                    "headsign": t.headsign, "departureTime": t.departure_time,
                    "arrivalTime": t.arrival_time, "departureMin": t.departure_min,
                    "arrivalMin": t.arrival_min, "firstStopName": t.first_stop_name,
                    "lastStopName": t.last_stop_name, "vehicleId": vid, "vehicleType": vtype,
                } for t in used],
            }],
            "leftoverTrips": [{
                "tripId": t.trip_id, "departureMin": t.departure_min,
                "arrivalMin": t.arrival_min, "routeName": t.route_name,
            } for t in leftover],
        })

    return {"duties": duties_out, "skipped": skipped,
            "created": len(duties_out)}


# ═══════════════════════════════════════════════════════════════

def run(raw: dict) -> dict:
    mode = str(raw.get("mode", "validate"))
    if mode == "validate":
        return run_validate(raw)
    if mode == "swap":
        return run_swap(raw)
    if mode == "turni_unici":
        return run_turni_unici(raw)
    return {"error": f"mode sconosciuto: {mode}"}


def main() -> None:
    raw = json.loads(sys.stdin.read())
    print(json.dumps(run(raw), ensure_ascii=False))


if __name__ == "__main__":
    main()
