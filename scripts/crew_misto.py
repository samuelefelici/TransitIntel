#!/usr/bin/env python3
"""
crew_misto.py — Completamento turni / Turni MISTI (3° processo di ottimizzazione).

Prende i turni guida GIÀ creati (urbano + extraurbano) e le corse SCOPERTE
(o quelle dei supplementi che si vogliono riassorbire) e prova, con una euristica
greedy, a INCASTRARE ogni corsa scoperta in un turno esistente.

Punti chiave (come richiesto):
 - L'inserimento NON è semplice "buco temporale": ri-cuce la catena e RICALCOLA i
   fuorilinea (deadhead) — aggiunge quelli necessari, considera capolinea coincidenti
   (deadhead 0) tramite raggio cluster.
 - Urbano ed extraurbano usano VETTURE DIVERSE: inserire una corsa di categoria
   diversa richiede un CAMBIO VETTURA IN DEPOSITO (deadhead→deposito, stacco,
   deadhead→corsa, e ritorno). Un turno che assorbe altra categoria diventa MISTO.
 - Il turno misto è rivalidato con la normativa EXTRAURBANA (più tutelativa):
   nastro e lavoro massimi.

NON usa ortools (euristica greedy); riusa estimate_deadhead/haversine da
optimizer_common (ortools-free).

I/O: JSON su stdin → JSON su stdout.
  input  = {"shifts": [...], "uncovered": [...], "config": {...}}
  output = {"shifts": [...], "uncovered": [...], "stats": {...}}
"""
from __future__ import annotations
import json
import sys
from typing import Any

from optimizer_common import estimate_deadhead, haversine_km

# ── Default (override da config) ──────────────────────────────────────────────
DEFAULTS = {
    "preTurnoMin": 12,            # pre-turno (uscita deposito)
    "postTurnoMin": 0,            # post-turno (rientro deposito)
    "cambioVetturaMin": 15,       # stacco per cambio vettura in deposito
    "terminalClusterRadiusM": 250,  # capolinea entro questo raggio = stesso punto (dh 0)
    # Normativa MISTO = extraurbano (più tutelativa)
    "maxNastro": 630,             # 10h30 (spezzato extraurbano)
    "maxLavoro": 630,
}


def _pt(d: dict, lat_key: str, lon_key: str) -> tuple[float | None, float | None]:
    return d.get(lat_key), d.get(lon_key)


def _valid_pt(lat, lon) -> bool:
    return isinstance(lat, (int, float)) and isinstance(lon, (int, float))


def deadhead_min(from_lat, from_lon, to_lat, to_lon, category: str, radius_m: int) -> int | None:
    """Minuti di fuorilinea fra due punti. 0 se entro il raggio cluster (stesso
    capolinea). None se coordinate mancanti (non valutabile → trattato come non
    fattibile dal chiamante)."""
    if not (_valid_pt(from_lat, from_lon) and _valid_pt(to_lat, to_lon)):
        return None
    straight_m = haversine_km(from_lat, from_lon, to_lat, to_lon) * 1000.0
    if straight_m <= radius_m:
        return 0
    _km, minutes = estimate_deadhead(from_lat, from_lon, to_lat, to_lon, category)
    return minutes


def _trip_sort_key(t: dict) -> int:
    return int(t.get("departureMin", 0))


def shift_span(trips: list[dict], cfg: dict) -> tuple[int, int, int]:
    """(start, end, nastro) del turno includendo pre/post turno."""
    if not trips:
        return 0, 0, 0
    start = min(int(t["departureMin"]) for t in trips) - cfg["preTurnoMin"]
    end = max(int(t["arrivalMin"]) for t in trips) + cfg["postTurnoMin"]
    return start, end, end - start


def service_min(trips: list[dict]) -> int:
    return sum(int(t["arrivalMin"]) - int(t["departureMin"]) for t in trips)


def try_insert(shift: dict, trip: dict, cfg: dict) -> dict | None:
    """Prova a inserire `trip` in `shift`. Ritorna un dict con il nuovo turno e il
    costo aggiunto (minuti fuorilinea + cambio), oppure None se non fattibile.

    Ri-cuce la catena e ricalcola i fuorilinea; se la categoria differisce dal
    turno, modella il cambio vettura in deposito.
    """
    trips = sorted(shift["trips"], key=_trip_sort_key)
    radius = cfg["terminalClusterRadiusM"]
    cross = str(trip.get("category")) != str(shift.get("category"))
    dlat, dlon = _pt(shift, "depotLat", "depotLon")
    if cross and not _valid_pt(dlat, dlon):
        return None  # cambio vettura richiede il deposito, ma non ho le coord

    t_dep = int(trip["departureMin"]); t_arr = int(trip["arrivalMin"])
    t_cat = str(trip.get("category", shift.get("category")))
    s_cat = str(shift.get("category"))

    best: dict | None = None
    # posizioni: prima di trips[i] per i in 0..len; prev=trips[i-1], next=trips[i]
    for i in range(len(trips) + 1):
        prev = trips[i - 1] if i > 0 else None
        nxt = trips[i] if i < len(trips) else None

        added = 0  # minuti fuorilinea + cambio aggiunti
        ok = True

        # ── lato precedente: arrivo prev (o uscita deposito) → partenza trip ──
        if not cross:
            if prev is not None:
                dh = deadhead_min(prev.get("lastStopLat"), prev.get("lastStopLon"),
                                  trip.get("firstStopLat"), trip.get("firstStopLon"), t_cat, radius)
                if dh is None or prev["arrivalMin"] + dh > t_dep:
                    ok = False
                else:
                    added += dh
            # se prev None: il trip diventa nuovo inizio (pull-out ricalcolato a fine)
        else:
            # cambio vettura: prev → deposito → (cambio) → trip
            ref_lat = prev.get("lastStopLat") if prev else dlat
            ref_lon = prev.get("lastStopLon") if prev else dlon
            ref_t = prev["arrivalMin"] if prev else None
            dh1 = deadhead_min(ref_lat, ref_lon, dlat, dlon, s_cat, radius)
            dh2 = deadhead_min(dlat, dlon, trip.get("firstStopLat"), trip.get("firstStopLon"), t_cat, radius)
            if dh1 is None or dh2 is None:
                ok = False
            else:
                lead = dh1 + cfg["cambioVetturaMin"] + dh2
                added += lead
                if ref_t is not None and ref_t + lead > t_dep:
                    ok = False

        # ── lato successivo: arrivo trip → partenza next (o rientro deposito) ──
        if ok:
            if not cross:
                if nxt is not None:
                    dh = deadhead_min(trip.get("lastStopLat"), trip.get("lastStopLon"),
                                      nxt.get("firstStopLat"), nxt.get("firstStopLon"), t_cat, radius)
                    if dh is None or t_arr + dh > nxt["departureMin"]:
                        ok = False
                    else:
                        added += dh
            else:
                ref_lat = nxt.get("firstStopLat") if nxt else dlat
                ref_lon = nxt.get("firstStopLon") if nxt else dlon
                ref_t = nxt["departureMin"] if nxt else None
                dh3 = deadhead_min(trip.get("lastStopLat"), trip.get("lastStopLon"), dlat, dlon, t_cat, radius)
                dh4 = deadhead_min(dlat, dlon, ref_lat, ref_lon, s_cat, radius)
                if dh3 is None or dh4 is None:
                    ok = False
                else:
                    trail = dh3 + cfg["cambioVetturaMin"] + dh4
                    added += trail
                    if ref_t is not None and t_arr + trail > ref_t:
                        ok = False

        if not ok:
            continue

        # ── rivalidazione normativa (extraurbano) sul turno risultante ──
        new_trips = trips[:i] + [trip] + trips[i:]
        _start, _end, nastro = shift_span(new_trips, cfg)
        if nastro > cfg["maxNastro"]:
            continue
        work = service_min(new_trips) + added + cfg["preTurnoMin"] + cfg["postTurnoMin"]
        if work > cfg["maxLavoro"]:
            continue

        if best is None or added < best["added"]:
            best = {"position": i, "added": added, "nastro": nastro, "work": work,
                    "new_trips": new_trips, "cross": cross}

    return best


def run(data: dict) -> dict:
    cfg = {**DEFAULTS, **(data.get("config") or {})}
    shifts = [dict(s, trips=list(s.get("trips", []))) for s in data.get("shifts", [])]
    uncovered = list(data.get("uncovered", []))

    # corse difficili prima (per categoria/orario): proviamo per orario di partenza
    uncovered.sort(key=_trip_sort_key)

    inserted = 0
    inserted_cross = 0
    remaining: list[dict] = []

    for trip in uncovered:
        # candidati: tutti i turni; scegli l'inserimento valido a costo minimo,
        # preferendo stessa categoria (niente cambio vettura) a parità di costo.
        best_choice = None
        best_shift_idx = -1
        for idx, shift in enumerate(shifts):
            res = try_insert(shift, trip, cfg)
            if res is None:
                continue
            # ranking: (cross?, added) — stessa categoria e meno fuorilinea vince
            key = (1 if res["cross"] else 0, res["added"])
            if best_choice is None or key < (1 if best_choice["cross"] else 0, best_choice["added"]):
                best_choice = res
                best_shift_idx = idx

        if best_choice is None:
            remaining.append(trip)
            continue

        s = shifts[best_shift_idx]
        s["trips"] = best_choice["new_trips"]
        s["nastroMin"] = best_choice["nastro"]
        s["workMin"] = best_choice["work"]
        if best_choice["cross"]:
            s["isMisto"] = True
            inserted_cross += 1
        inserted += 1

    return {
        "shifts": shifts,
        "uncovered": remaining,
        "stats": {
            "insertedTotal": inserted,
            "insertedCrossCategory": inserted_cross,
            "remainingUncovered": len(remaining),
            "shiftsMisto": sum(1 for s in shifts if s.get("isMisto")),
            "shiftsTotal": len(shifts),
        },
    }


def main() -> None:
    raw = sys.stdin.read()
    data = json.loads(raw) if raw.strip() else {}
    print(json.dumps(run(data)))


if __name__ == "__main__":
    main()
