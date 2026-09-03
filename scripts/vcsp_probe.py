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
from optimizer_common import trip_from_dict, SHIFT_RULES

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
# Disturbo all'orario pubblicato: ogni corsa·minuto spostato costa questo in
# fase di accettazione (vcsp.shiftPenaltyEur). Senza, la sonda accettava di
# muovere 86 corse di 10′ per togliere una violazione da 1′ (Giro K, Ancona).
SHIFT_PENALTY_EUR_PER_TRIP_MIN = 1.0
CREW_SHIFT_SCOPES = ("trip", "line")
# Diagnostica dell'ultima scansione dei turni (perché la sonda non propone
# nulla): bi-riprese esaminate, senza candidato e il δ minimo che servirebbe.
LAST_CREW_STATS: dict = {}


def crew_rules_from_config(crew_config: dict | None) -> tuple[int, int]:
    """(nastro massimo dell'intero, interruzione minima del semiunico) dalle
    regole di struttura in vigore: config.bds.shiftRules dell'operatore sopra
    i default di SHIFT_RULES. Servono a scartare i candidati che NON possono
    produrre un intero (stacco chiudibile ma nastro troppo lungo, o viceversa)."""
    base_int = dict(SHIFT_RULES.get("intero", {}))
    base_semi = dict(SHIFT_RULES.get("semiunico", {}))
    ov = ((crew_config or {}).get("bds") or {}).get("shiftRules") or {}
    base_int.update(ov.get("intero") or {})
    base_semi.update(ov.get("semiunico") or {})
    try:
        return int(base_int.get("maxNastro", 435)), int(base_semi.get("intMin", 75))
    except (TypeError, ValueError):
        return 435, 75


def _clamp(v: int, lo: int, hi: int) -> int:
    return max(lo, min(hi, v))


def find_crew_probe_candidates(crew_out: dict, trips_by_id: dict[str, dict],
                               max_candidates: int = 40, *,
                               scope: str = "trip",
                               intero_max_nastro: int = 435,
                               semi_int_min: int = 75) -> list[dict]:
    """Candidati GUIDATI DAI TURNI: per ogni bi-ripresa (semiunico/spezzato)
    prova a portare lo stacco fra i due pezzi sotto l'interruzione minima,
    così che il CSP possa farne un intero composto (o riaccoppiare meglio).

    Un candidato esiste solo se lo spostamento PUÒ produrre un intero:
      δ ≥ stacco − (intMin − 1)     → lo stacco scende sotto l'interruzione minima
      δ ≥ nastro − maxNastro intero  → il nastro rientra nel massimo dell'intero
    e δ resta entro la flessibilità dichiarata in Planning (flexMin, tetto
    MAX_FLEX_MIN). Se la finestra è vuota il turno NON genera sonde (erano
    re-solve buttati: 5 minuti l'uno).

    scope "trip" (default): sposta SOLO la corsa al confine dello stacco —
      l'ultima del primo pezzo (crew-late), la prima del secondo (crew-early),
      o entrambe dividendo δ (crew-both) quando una sola non basta. È il
      ritocco locale che farebbe un pianificatore a mano: la cadenza ha un
      solo intervallo irregolare e le coincidenze del resto della giornata
      restano intatte.
    scope "line": tutte le corse delle linee servite dal pezzo, per tutta la
      giornata (cadenza intatta, ma le coincidenze con le altre linee si
      spostano ovunque). Va chiesto esplicitamente (vcsp.crewShiftScope).
    """
    if scope not in CREW_SHIFT_SCOPES:
        scope = "trip"
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

    def _piece_edge_min(piece: dict, last: bool) -> int:
        """Orario di servizio al confine del pezzo: serviceStart/EndMin se il
        motore li emette, altrimenti prima partenza / ultimo arrivo delle corse,
        altrimenti i confini di nastro."""
        key = "serviceEndMin" if last else "serviceStartMin"
        if piece.get(key) is not None:
            return int(piece[key])
        vals = [int(t.get("arrivalMin" if last else "departureMin") or 0)
                for t in (piece.get("trips") or []) if t.get("arrivalMin" if last else "departureMin") is not None]
        if vals:
            return max(vals) if last else min(vals)
        return int(piece["endMin" if last else "startMin"])

    def _edge_trip(piece: dict, last: bool) -> dict | None:
        """Corsa al confine del pezzo (ultima o prima), letta dal payload."""
        best = None
        for t in piece.get("trips") or []:
            r = trips_by_id.get(t.get("tripId"))
            if not r:
                continue
            dep = int(r.get("departureMin") or 0)
            if best is None or (dep > best[0] if last else dep < best[0]):
                best = (dep, r)
        return best[1] if best else None

    cands: list[dict] = []
    seen: set[frozenset] = set()
    skipped_unreachable = 0
    unreachable: list[dict] = []
    n_biriprese = 0
    for d in crew_out.get("driverShifts") or []:
        if d.get("type") not in ("semiunico", "spezzato"):
            continue
        pieces = d.get("riprese") or []
        if len(pieces) != 2:
            continue
        p1, p2 = pieces
        try:
            # stacco fra i pezzi sugli orari di SERVIZIO (rilascio del bus →
            # presa in carico del bus), non sui confini di nastro che includono
            # pre-turno e trasferimenti in auto
            gap = _piece_edge_min(p2, last=False) - _piece_edge_min(p1, last=True)
            nastro = int(d.get("nastroMin") or (int(p2["endMin"]) - int(p1["startMin"])))
        except (KeyError, TypeError, ValueError):
            continue
        n_biriprese += 1
        need = gap - CREW_TARGET_GAP_MIN
        if need <= 0:
            continue
        delta_lo = max(1, gap - (semi_int_min - 1), nastro - intero_max_nastro)
        if delta_lo > MAX_FLEX_MIN:
            skipped_unreachable += 1
            unreachable.append({"duty": d.get("driverId"), "type": d.get("type"),
                                "gapMin": gap, "nastroMin": nastro, "deltaMin": delta_lo,
                                "why": "nastro" if nastro - intero_max_nastro >= gap - (semi_int_min - 1)
                                else "stacco"})
            continue
        v1 = (p1.get("vehicleIds") or ["?"])[0]
        v2 = (p2.get("vehicleIds") or ["?"])[0]
        options: list[tuple[str, dict[str, int], list[str]]] = []
        if scope == "line":
            for kind, piece, sign in (("crew-early", p2, -1), ("crew-late", p1, +1)):
                routes = _routes_of(piece)
                if not routes:
                    continue
                cap = min(_flex_cap(routes), MAX_FLEX_MIN)
                if cap < delta_lo:
                    continue
                shifts = _shift_for(routes, sign * _clamp(need, delta_lo, cap))
                if shifts:
                    options.append((kind, shifts, sorted(routes)))
        else:
            t1 = _edge_trip(p1, last=True)
            t2 = _edge_trip(p2, last=False)
            f1 = _flex_of(t1) if t1 else 0
            f2 = _flex_of(t2) if t2 else 0
            routes = sorted({r for r in ((t1 or {}).get("routeId"), (t2 or {}).get("routeId")) if r})
            if t1 and f1 >= delta_lo:
                options.append(("crew-late", {t1["tripId"]: +_clamp(need, delta_lo, f1)}, routes))
            if t2 and f2 >= delta_lo:
                options.append(("crew-early", {t2["tripId"]: -_clamp(need, delta_lo, f2)}, routes))
            if t1 and t2 and f1 > 0 and f2 > 0 and f1 + f2 >= delta_lo \
                    and t1["tripId"] != t2["tripId"]:
                dtot = _clamp(need, delta_lo, f1 + f2)
                d1 = min(f1, (dtot + 1) // 2)
                d2 = dtot - d1
                if d2 > f2:
                    d2, d1 = f2, dtot - f2
                if d1 > 0 and d2 > 0:
                    options.append(("crew-both", {t1["tripId"]: +d1, t2["tripId"]: -d2}, routes))
            if not options:
                skipped_unreachable += 1
                unreachable.append({"duty": d.get("driverId"), "type": d.get("type"),
                                    "gapMin": gap, "nastroMin": nastro, "deltaMin": delta_lo,
                                    "why": "flex"})
        for kind, shifts, routes in options:
            key = frozenset(shifts.items())
            if key in seen:
                continue
            seen.add(key)
            cands.append({
                "shifts": shifts,
                "deltaNeeded": sum(abs(v) for v in shifts.values()) if scope != "line"
                else abs(next(iter(shifts.values()))),
                "blockA": v1, "blockB": v2,
                "kind": kind, "duty": d.get("driverId"), "gapMin": gap,
                "nastroMin": nastro, "routes": routes, "scope": scope,
            })
    if skipped_unreachable:
        log(f"[PROBE] {skipped_unreachable}/{n_biriprese} bi-riprese senza candidato: l'intero "
            f"non è raggiungibile entro la flessibilità (nastro>{intero_max_nastro}′, "
            f"stacco troppo ampio o corse di confine inchiodate)")
    LAST_CREW_STATS.clear()
    LAST_CREW_STATS.update({
        "biRiprese": n_biriprese, "unreachable": skipped_unreachable,
        "candidates": len(cands), "scope": scope,
        "interoMaxNastro": intero_max_nastro, "semiIntMin": semi_int_min,
        "unreachableDetails": unreachable[:12],
    })
    # prima i ritocchi piccoli (poche corse·minuto) che chiudono di più lo stacco
    cands.sort(key=lambda c: (sum(abs(v) for v in c["shifts"].values()),
                              c["deltaNeeded"], -(c["gapMin"] - c["deltaNeeded"])))
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
    shift_penalty_eur: float = SHIFT_PENALTY_EUR_PER_TRIP_MIN,
    crew_scope: str = "trip",
) -> dict:
    """Fase sonda: prova gli spostamenti candidati, tiene solo chi abbassa il
    PUNTEGGIO (costo + ombre turni/violazioni + disturbo all'orario). Ritorna
    {vsp, crew, kpi, probe}: se nessun candidato passa, vsp/crew/kpi sono gli
    input invariati e probe documenta i tentativi.

    shift_penalty_eur: € per corsa·minuto spostato, sommato al punteggio del
    candidato (cumulato sugli spostamenti già accettati). È ciò che impedisce
    di muovere mezza rete per un guadagno da pochi euro.
    crew_scope: "trip" (ritocco alla corsa di confine) o "line" (linea intera)
    per i candidati guidati dai turni.
    """
    t0 = time.time()
    trips = list(vsp_payload.get("trips") or [])
    flex_trips = sum(1 for t in trips if _flex_of(t) > 0)
    shift_penalty_eur = max(0.0, float(shift_penalty_eur or 0.0))
    if crew_scope not in CREW_SHIFT_SCOPES:
        crew_scope = "trip"
    intero_max_nastro, semi_int_min = crew_rules_from_config(crew_config)
    section: dict = {
        "enabled": True, "flexTrips": flex_trips, "candidates": 0,
        "probesRun": 0, "accepted": [], "rejected": [], "timeShifts": {},
        "timeShiftDetails": [], "shiftedTrips": 0, "shiftedTripMin": 0,
        "disruptionEur": 0.0, "shiftPenaltyEurPerTripMin": shift_penalty_eur,
        "crewScope": crew_scope,
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
    orig_by_id = {t.get("tripId"): t for t in trips}
    accepted_total: dict[str, int] = {}

    def _disruption(total: dict[str, int]) -> float:
        return round(shift_penalty_eur * sum(abs(v) for v in total.values()), 2)

    def _merged(total: dict[str, int], shifts: dict[str, int]) -> dict[str, int]:
        out = dict(total)
        for tid, d in shifts.items():
            out[tid] = out.get(tid, 0) + d
        return {k: v for k, v in out.items() if v}

    # Punteggio del best SENZA disturbo (il disturbo si somma a parte, cumulato)
    cur_base_score = float(best_kpi.get("selectionScoreEur", best_kpi["totalCostEur"]))

    while probes_run < max_probes:
        trips_by_id = {t.get("tripId"): t for t in cur_trips}
        cands = ([c for c in find_crew_probe_candidates(
                      result["crew"], trips_by_id, scope=crew_scope,
                      intero_max_nastro=intero_max_nastro, semi_int_min=semi_int_min)
                  if frozenset(c["shifts"].items()) not in tried]
                 + [c for c in find_probe_candidates(result["vsp"], trips_by_id)
                    if frozenset(c["shifts"].items()) not in tried])
        if probes_run == 0:
            section["candidates"] = len(cands)
            section["crewStats"] = dict(LAST_CREW_STATS)
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
                f"({shifts_txt}) per il turno {cand.get('duty')} (stacco {cand.get('gapMin')}′, "
                f"nastro {cand.get('nastroMin')}′, linee {','.join(cand.get('routes') or [])})")
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
        # turni/violazioni), col costo secco come ripiego per kpi_fn legacy,
        # PIÙ il disturbo all'orario (corse·minuto spostate, cumulato).
        new_total = _merged(accepted_total, cand["shifts"])
        _base_new = float(kpi.get("selectionScoreEur", kpi["totalCostEur"]))
        _dis_old = _disruption(accepted_total)
        _dis_new = _disruption(new_total)
        _score_new = _base_new + _dis_new
        _score_old = cur_base_score + _dis_old
        if _score_new < _score_old - COST_EPS:
            gain = result["kpi"]["totalCostEur"] - kpi["totalCostEur"]
            log(f"[PROBE]   ACCETTATO: €{result['kpi']['totalCostEur']} → "
                f"€{kpi['totalCostEur']} (−€{gain:.2f}), "
                f"{vehicles_old}→{vehicles_new} mezzi, "
                f"{result['kpi'].get('duties', 0)}→{kpi.get('duties', 0)} turni, "
                f"punteggio {_score_old:.2f} → {_score_new:.2f} "
                f"(disturbo €{_dis_old:.0f} → €{_dis_new:.0f})")
            section["accepted"].append({
                "kind": cand["kind"], "deltaNeeded": cand["deltaNeeded"],
                "duty": cand.get("duty"), "gapMin": cand.get("gapMin"),
                "shifts": _shift_details(cand["shifts"], trips_by_id),
                "mergedBlocks": [cand["blockA"], cand["blockB"]],
                "before": {"vehicles": vehicles_old,
                           "duties": result["kpi"].get("duties", 0),
                           "bdsViolations": result["kpi"].get("bdsViolations", 0),
                           "totalCostEur": result["kpi"]["totalCostEur"],
                           "scoreEur": round(_score_old, 2)},
                "after": {"vehicles": vehicles_new,
                          "duties": kpi.get("duties", 0),
                          "bdsViolations": kpi.get("bdsViolations", 0),
                          "totalCostEur": kpi["totalCostEur"],
                          "scoreEur": round(_score_new, 2)},
                "disruptionEur": _dis_new,
            })
            accepted_total = new_total
            cur_base_score = _base_new
            kpi = dict(kpi)
            kpi["shiftedTrips"] = len(new_total)
            kpi["shiftedTripMin"] = sum(abs(v) for v in new_total.values())
            kpi["shiftPenaltyEur"] = _dis_new
            kpi["selectionScoreEur"] = round(_score_new, 2)
            cur_trips = probe_trips
            result = {"vsp": vsp_out, "crew": crew_out, "kpi": kpi, "probe": section}
        else:
            rejected_entry["reason"] = "crew"  # la guida (o il disturbo) mangia il risparmio
            rejected_entry["scoreBefore"] = round(_score_old, 2)
            rejected_entry["scoreAfter"] = round(_score_new, 2)
            rejected_entry["disruptionEur"] = _dis_new
            section["rejected"].append(rejected_entry)
            log(f"[PROBE]   scartato (punteggio {_score_new:.2f} ≥ {_score_old:.2f}: "
                f"costo €{kpi['totalCostEur']} vs €{result['kpi']['totalCostEur']}, "
                f"disturbo €{_dis_new:.0f})")

    section["timeShifts"] = accepted_total
    # Dettaglio leggibile (linea, variante, da→a) sugli orari ORIGINALI: è
    # ciò che l'agente racconta all'operatore e ciò che si applica al piano.
    section["timeShiftDetails"] = _shift_details(accepted_total, orig_by_id)
    section["shiftedTrips"] = len(accepted_total)
    section["shiftedTripMin"] = sum(abs(v) for v in accepted_total.values())
    section["disruptionEur"] = _disruption(accepted_total)
    section["elapsedSec"] = round(time.time() - t0, 1)
    log(f"[PROBE] fine: {probes_run} sonde, {len(section['accepted'])} accettate, "
        f"{len(section['rejected'])} scartate in {section['elapsedSec']}s")
    return result
