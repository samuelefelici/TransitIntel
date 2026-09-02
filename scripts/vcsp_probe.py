"""
vcsp_probe.py — Sonda di spostamento (cervello P↔TM↔TG, passo 2).

Dopo la convergenza del loop VCSP (VSP→CSP→costi-ombra), la sonda cerca gli
spostamenti di SINGOLE corse — dentro la flessibilità ±flexMin dichiarata in
Planning Studio — che permettono di fondere due blocchi veicolo:

  blocco A ─corse─▶ (ultima corsa arriva alle 13:02)      ┐ oggi servono
  blocco B ─corse─▶ (prima corsa parte alle 13:04)        ┘ 2 vetture

  se il trasferimento A→B richiede 7 min, mancano δ=5 min: spostare la prima
  corsa di B di +5′ (o l'ultima di A di −5′) fonde i blocchi → −1 vettura.

Ogni candidato viene VERIFICATO con un re-solve a caldo: VSP con gli orari
spostati (stesse penalità d'arco del best round) e, se i mezzi migliorano,
CSP sui nuovi blocchi. Si accetta solo se il costo TOTALE (mezzi + guida)
scende: uno spostamento che toglie una vettura ma peggiora i turni guida
viene scartato — è esattamente il punto dell'ottimizzazione congiunta.

Gli spostamenti accettati NON toccano Planning Studio: escono come proposte
(`timeShifts`) che l'operatore applica con un click dalla fucina.
"""
from __future__ import annotations

import time

from optimizer_common import MIN_LAYOVER, MAX_DEADHEAD_KM, estimate_deadhead, min_to_time, log
from vehicle_scheduler_cpsat import trips_vehicle_compatible
from optimizer_common import trip_from_dict

MAX_FLEX_MIN = 30          # tetto assoluto della flessibilità per corsa
COST_EPS = 0.01            # miglioramento minimo per accettare (EUR)


def _flex_of(trip_dict: dict) -> int:
    try:
        v = int(trip_dict.get("flexMin") or 0)
    except (TypeError, ValueError):
        return 0
    return max(0, min(MAX_FLEX_MIN, v))


def _service_trips(shift: dict) -> list[dict]:
    return [t for t in shift.get("trips", []) if t.get("type") == "trip"]


def _same_point(a: dict, b: dict) -> bool:
    """Ultima fermata di a == prima fermata di b (stesso capolinea fisico)."""
    if a.get("lastStopId") and a.get("lastStopId") == b.get("firstStopId"):
        return True
    try:
        return (abs(float(a["lastStopLat"]) - float(b["firstStopLat"])) < 0.001
                and abs(float(a["lastStopLon"]) - float(b["firstStopLon"])) < 0.001)
    except (KeyError, TypeError, ValueError):
        return False


def _link_requirement(a: dict, b: dict) -> tuple[float, int] | None:
    """(km, minuti minimi di aggancio) per concatenare la corsa a con la b.

    Rispecchia build_compatible_arcs_fast: stesso capolinea → 0/0, altrimenti
    deadhead stimato (matrice fuorilinea inclusa) con MIN_LAYOVER di guardia.
    None se il trasferimento supera MAX_DEADHEAD_KM (mai fondibile).
    """
    if _same_point(a, b):
        return 0.0, 0
    try:
        dh_km, dh_min = estimate_deadhead(
            float(a["lastStopLat"]), float(a["lastStopLon"]),
            float(b["firstStopLat"]), float(b["firstStopLon"]),
            str(a.get("category") or "urbano"))
    except (KeyError, TypeError, ValueError):
        return None
    if dh_km > MAX_DEADHEAD_KM:
        return None
    return dh_km, max(dh_min, MIN_LAYOVER)


def _intra_slack(prev: dict, nxt: dict) -> int:
    """Minuti di gioco fra due corse consecutive dello STESSO blocco."""
    req = _link_requirement(prev, nxt)
    if req is None:
        return 0
    need = req[1]
    return int(nxt["departureMin"]) - int(prev["arrivalMin"]) - need


def find_probe_candidates(vsp_out: dict, trips_by_id: dict[str, dict],
                          max_candidates: int = 40) -> list[dict]:
    """Coppie di blocchi quasi-fondibili entro la flessibilità dichiarata.

    Restituisce candidati ordinati per δ crescente, ciascuno:
      {"shifts": {tripId: ±δ}, "deltaNeeded": δ, "blockA": vid, "blockB": vid,
       "kind": "head+" | "tail-" | "split"}
    """
    blocks = []
    for s in vsp_out.get("vehicleShifts", []):
        service = _service_trips(s)
        if service:
            blocks.append((s.get("vehicleId"), service))

    candidates: list[dict] = []
    for vid_a, trips_a in blocks:
        ta = trips_a[-1]                       # ultima corsa di A
        ra = trips_by_id.get(ta.get("tripId"))
        if ra is None:
            continue
        for vid_b, trips_b in blocks:
            if vid_a == vid_b:
                continue
            tb = trips_b[0]                    # prima corsa di B
            rb = trips_by_id.get(tb.get("tripId"))
            if rb is None:
                continue
            req = _link_requirement(ra, rb)
            if req is None:
                continue
            delta = (int(ra["arrivalMin"]) + req[1]) - int(rb["departureMin"])
            # delta ≤ 0: già agganciabili senza spostare nulla (il solver ha
            # scelto altro per costo/tipo veicolo) — niente da proporre.
            if delta <= 0 or delta > MAX_FLEX_MIN:
                continue
            # compatibilità di tipo veicolo sull'arco di fusione
            tpa = trip_from_dict(ra, 0)
            tpb = trip_from_dict(rb, 1)
            if not trips_vehicle_compatible(tpa, tpb):
                continue

            flex_b = _flex_of(rb)
            slack_b = 10_000
            if len(trips_b) >= 2:
                rb2 = trips_by_id.get(trips_b[1].get("tripId"))
                slack_b = _intra_slack(rb, rb2) if rb2 else 0
            head_room = min(flex_b, max(0, slack_b))

            flex_a = _flex_of(ra)
            slack_a = 10_000
            if len(trips_a) >= 2:
                ra0 = trips_by_id.get(trips_a[-2].get("tripId"))
                slack_a = _intra_slack(ra0, ra) if ra0 else 0
            tail_room = min(flex_a, max(0, slack_a))

            base = {"deltaNeeded": delta, "blockA": vid_a, "blockB": vid_b}
            if head_room >= delta:
                candidates.append({**base, "kind": "head+",
                                   "shifts": {rb["tripId"]: delta}})
            elif tail_room >= delta:
                candidates.append({**base, "kind": "tail-",
                                   "shifts": {ra["tripId"]: -delta}})
            elif head_room + tail_room >= delta and head_room > 0 and tail_room > 0:
                candidates.append({**base, "kind": "split",
                                   "shifts": {rb["tripId"]: head_room,
                                              ra["tripId"]: -(delta - head_room)}})

    candidates.sort(key=lambda c: (c["deltaNeeded"], len(c["shifts"])))
    return candidates[:max_candidates]


CREW_TARGET_GAP_MIN = 45   # stacco a cui mirare fra i due pezzi (→ intero composto)


def find_crew_probe_candidates(crew_out: dict, trips_by_id: dict[str, dict],
                               max_candidates: int = 40) -> list[dict]:
    """Candidati GUIDATI DAI TURNI: per ogni bi-ripresa (semiunico/spezzato)
    prova a portare lo stacco fra i due pezzi sotto l'interruzione minima,
    così che il CSP possa farne un intero composto (o riaccoppiare meglio).

    Lo spostamento è di LINEA (tutte le corse delle linee servite dal pezzo),
    non di singolo bus: sulle linee a più vetture un bus solo spostato
    romperebbe la cadenza. Entro la flessibilità dichiarata in Planning
    (flexMin, minimo fra le corse coinvolte); 0 = niente candidato.
      kind "crew-early": anticipa le linee del SECONDO pezzo di δ
      kind "crew-late":  posticipa le linee del PRIMO pezzo di δ
    """
    route_trips: dict[str, list[dict]] = {}
    for t in trips_by_id.values():
        rid = t.get("routeId")
        if rid:
            route_trips.setdefault(rid, []).append(t)

    def _routes_of(piece: dict) -> set[str]:
        out: set[str] = set()
        for t in piece.get("trips") or []:
            r = trips_by_id.get(t.get("tripId"))
            if r and r.get("routeId"):
                out.add(r["routeId"])
        return out

    def _shift_for(routes: set[str], delta: int) -> dict[str, int] | None:
        shifts: dict[str, int] = {}
        for rid in routes:
            for r in route_trips.get(rid, []):
                shifts[r["tripId"]] = delta
        return shifts or None

    def _flex_cap(routes: set[str]) -> int:
        vals = [_flex_of(r) for rid in routes for r in route_trips.get(rid, [])]
        return min(vals) if vals else 0

    cands: list[dict] = []
    seen: set[frozenset] = set()
    for d in crew_out.get("driverShifts") or []:
        if d.get("type") not in ("semiunico", "spezzato"):
            continue
        pieces = d.get("riprese") or []
        if len(pieces) != 2:
            continue
        p1, p2 = pieces
        try:
            gap = int(p2["startMin"]) - int(p1["endMin"])
        except (KeyError, TypeError, ValueError):
            continue
        need = gap - CREW_TARGET_GAP_MIN
        if need <= 0:
            continue
        for kind, piece, sign in (("crew-early", p2, -1), ("crew-late", p1, +1)):
            routes = _routes_of(piece)
            if not routes:
                continue
            delta = min(need, _flex_cap(routes), MAX_FLEX_MIN)
            if delta <= 0:
                continue
            shifts = _shift_for(routes, sign * delta)
            if not shifts:
                continue
            key = frozenset(shifts.items())
            if key in seen:
                continue
            seen.add(key)
            v1 = (p1.get("vehicleIds") or ["?"])[0]
            v2 = (p2.get("vehicleIds") or ["?"])[0]
            cands.append({
                "shifts": shifts, "deltaNeeded": delta, "blockA": v1, "blockB": v2,
                "kind": kind, "duty": d.get("driverId"), "gapMin": gap,
                "routes": sorted(routes),
            })
    # prima gli spostamenti piccoli che chiudono di più lo stacco
    cands.sort(key=lambda c: (c["deltaNeeded"], -(c["gapMin"] - c["deltaNeeded"])))
    return cands[:max_candidates]


def _apply_shifts(trips: list[dict], shifts: dict[str, int]) -> list[dict]:
    """Nuova lista corse con gli orari traslati (copia, l'input resta intatto)."""
    out = []
    for t in trips:
        d = shifts.get(t.get("tripId"))
        if d:
            t = dict(t)
            t["departureMin"] = int(t["departureMin"]) + d
            t["arrivalMin"] = int(t["arrivalMin"]) + d
            t["departureTime"] = min_to_time(t["departureMin"])
            t["arrivalTime"] = min_to_time(t["arrivalMin"])
        out.append(t)
    return out


def _shift_details(shifts: dict[str, int], trips_by_id: dict[str, dict]) -> list[dict]:
    det = []
    for tid, d in shifts.items():
        r = trips_by_id.get(tid) or {}
        dep = int(r.get("departureMin") or 0)
        det.append({
            "tripId": tid,
            "routeId": r.get("routeId"),
            "routeName": r.get("routeName") or r.get("routeId"),
            "variantCode": r.get("variantCode") or None,
            "deltaMin": d,
            "from": min_to_time(dep),
            "to": min_to_time(dep + d),
        })
    return det


def run_probe_phase(
    vsp_payload: dict,
    best_vsp: dict,
    best_crew: dict,
    best_kpi: dict,
    *,
    vsp_run,
    csp_run,
    crew_config: dict,
    crew_time_limit: int,
    kpi_fn,
    arc_penalties: dict | None = None,
    trip_cluster_stops: dict | None = None,
    max_probes: int = 4,
    probe_vsp_time: int = 60,
    progress=None,
) -> dict:
    """Fase sonda: prova gli spostamenti candidati, tiene solo chi abbassa il
    costo totale. Ritorna {vsp, crew, kpi, probe}: se nessun candidato passa,
    vsp/crew/kpi sono gli input invariati e probe documenta i tentativi.
    """
    t0 = time.time()
    trips = list(vsp_payload.get("trips") or [])
    flex_trips = sum(1 for t in trips if _flex_of(t) > 0)
    section: dict = {
        "enabled": True, "flexTrips": flex_trips, "candidates": 0,
        "probesRun": 0, "accepted": [], "rejected": [], "timeShifts": {},
    }
    result = {"vsp": best_vsp, "crew": best_crew, "kpi": best_kpi, "probe": section}
    if flex_trips == 0:
        log("[PROBE] nessuna corsa con flessibilità dichiarata — sonda inattiva")
        section["elapsedSec"] = round(time.time() - t0, 1)
        return result

    # budget ridotto per i re-solve (il candidato deve BATTERE il best a piena
    # potenza: un falso rifiuto è possibile, un falso via libera no)
    probe_cfg = dict(vsp_payload.get("config") or {})
    adv = dict(probe_cfg.get("vspAdvanced") or {})
    adv["totalTimeOverrideSec"] = int(probe_vsp_time)
    adv["iterativeReductionTimeSec"] = min(45.0, float(adv.get("iterativeReductionTimeSec") or 180.0))
    probe_cfg["vspAdvanced"] = adv

    tried: set[frozenset] = set()
    probes_run = 0
    cur_trips = trips
    accepted_total: dict[str, int] = {}

    while probes_run < max_probes:
        trips_by_id = {t.get("tripId"): t for t in cur_trips}
        cands = ([c for c in find_crew_probe_candidates(result["crew"], trips_by_id)
                  if frozenset(c["shifts"].items()) not in tried]
                 + [c for c in find_probe_candidates(result["vsp"], trips_by_id)
                    if frozenset(c["shifts"].items()) not in tried])
        if probes_run == 0:
            section["candidates"] = len(cands)
        if not cands:
            break
        cand = cands[0]
        tried.add(frozenset(cand["shifts"].items()))
        probes_run += 1
        section["probesRun"] = probes_run
        if len(cand["shifts"]) <= 4:
            shifts_txt = ", ".join(f"{tid[:8]}…{d:+d}′" for tid, d in cand["shifts"].items())
        else:
            shifts_txt = f"{len(cand['shifts'])} corse {next(iter(cand['shifts'].values())):+d}′"
        if cand["kind"].startswith("crew"):
            log(f"[PROBE] {probes_run}/{max_probes}: {cand['kind']} δ={cand['deltaNeeded']}′ "
                f"({shifts_txt}) per il turno {cand.get('duty')} (stacco {cand.get('gapMin')}′)")
        else:
            log(f"[PROBE] {probes_run}/{max_probes}: {cand['kind']} δ={cand['deltaNeeded']}′ "
                f"({shifts_txt}) per fondere {cand['blockA']}+{cand['blockB']}")
        if progress:
            progress(f"Sonda {probes_run}/{max_probes}: corsa {cand['kind']} "
                     f"±{cand['deltaNeeded']}′ → re-solve…")

        probe_trips = _apply_shifts(cur_trips, cand["shifts"])
        probe_payload = dict(vsp_payload)
        probe_payload["trips"] = probe_trips
        probe_payload["config"] = probe_cfg
        if arc_penalties:
            probe_payload["arcPenalties"] = arc_penalties
        else:
            probe_payload.pop("arcPenalties", None)

        vsp_out = vsp_run(probe_payload)
        shifts_out = vsp_out.get("vehicleShifts", [])
        vm = vsp_out.get("metrics", {}) or {}
        best_vm = result["vsp"].get("metrics", {}) or {}
        rejected_entry = {
            "kind": cand["kind"], "deltaNeeded": cand["deltaNeeded"],
            "shifts": _shift_details(cand["shifts"], trips_by_id),
            "blocks": [cand["blockA"], cand["blockB"]],
        }
        vehicles_new = vm.get("vehicles", 0)
        vehicles_old = best_vm.get("vehicles", 0)
        cost_new = float(vm.get("costEur") or 0)
        cost_old = float(best_vm.get("costEur") or 0)
        _crew_cand = cand["kind"].startswith("crew")
        if (not shifts_out or vehicles_new > vehicles_old
                or (not _crew_cand and vehicles_new == vehicles_old
                    and cost_new >= cost_old - COST_EPS)):
            rejected_entry["reason"] = "vsp"   # i mezzi non migliorano: niente CSP
            section["rejected"].append(rejected_entry)
            log(f"[PROBE]   scartato (VSP: {vehicles_new} vs {vehicles_old} mezzi, "
                f"€{cost_new:.0f} vs €{cost_old:.0f})")
            continue

        # mezzi migliorati → verifica il lato guida (stessi relief points)
        if trip_cluster_stops:
            for s in shifts_out:
                for t in s.get("trips", []):
                    if t.get("type") == "trip":
                        cs_list = trip_cluster_stops.get(t.get("tripId"))
                        if cs_list:
                            t["clusterStops"] = cs_list
        crew_out = csp_run({"vehicleShifts": shifts_out, "config": crew_config},
                           crew_time_limit)
        kpi = kpi_fn(vsp_out, crew_out)
        # Stesso metro della selezione fra round: punteggio (costo + ombre
        # turni/violazioni), col costo secco come ripiego per kpi_fn legacy.
        _score_new = kpi.get("selectionScoreEur", kpi["totalCostEur"])
        _score_old = result["kpi"].get("selectionScoreEur", result["kpi"]["totalCostEur"])
        if _score_new < _score_old - COST_EPS:
            gain = result["kpi"]["totalCostEur"] - kpi["totalCostEur"]
            log(f"[PROBE]   ACCETTATO: €{result['kpi']['totalCostEur']} → "
                f"€{kpi['totalCostEur']} (−€{gain:.2f}), "
                f"{vehicles_old}→{vehicles_new} mezzi")
            section["accepted"].append({
                "kind": cand["kind"], "deltaNeeded": cand["deltaNeeded"],
                "shifts": _shift_details(cand["shifts"], trips_by_id),
                "mergedBlocks": [cand["blockA"], cand["blockB"]],
                "before": {"vehicles": vehicles_old,
                           "duties": result["kpi"].get("duties", 0),
                           "totalCostEur": result["kpi"]["totalCostEur"]},
                "after": {"vehicles": vehicles_new,
                          "duties": kpi.get("duties", 0),
                          "totalCostEur": kpi["totalCostEur"]},
            })
            for tid, d in cand["shifts"].items():
                accepted_total[tid] = accepted_total.get(tid, 0) + d
            cur_trips = probe_trips
            result = {"vsp": vsp_out, "crew": crew_out, "kpi": kpi, "probe": section}
        else:
            rejected_entry["reason"] = "crew"  # −mezzi ma la guida costa di più
            section["rejected"].append(rejected_entry)
            log(f"[PROBE]   scartato (totale €{kpi['totalCostEur']} ≥ "
                f"€{result['kpi']['totalCostEur']}: la guida mangia il risparmio)")

    section["timeShifts"] = accepted_total
    section["elapsedSec"] = round(time.time() - t0, 1)
    log(f"[PROBE] fine: {probes_run} sonde, {len(section['accepted'])} accettate, "
        f"{len(section['rejected'])} scartate in {section['elapsedSec']}s")
    return result
