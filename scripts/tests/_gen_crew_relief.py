#!/usr/bin/env python3
"""Input che esercita la CONCATENAZIONE CON CAMBIO (relief).

12 COPPIE di blocchi macchina corti (~3h ciascuno) sullo stesso hub cluster.
Nella coppia k: blocco A (mattina) e blocco B che riparte ~20' dopo la fine di A
allo stesso hub. Un autista intelligente fa A, stacco 20' all'hub, poi prende il
bus B (di un altro turno macchina) -> UN turno intero da ~6h.

- Il modello a CATENA deve produrre ~12 turni guida (1 per coppia).
- Il modello single/pair di v4 NON puo' concatenare (gap 20' < 75' della biripresa,
  e i due pezzi sono su veicoli diversi) -> ~24 turni.
Stampa JSON su stdout.  Uso: _gen_crew_relief.py [n_coppie]
"""
import json
import sys

HUB = "Stazione FS"
OUTER = "Capolinea"


def trip(tid, route, dep, arr, frm, to):
    return {
        "type": "trip", "tripId": tid, "routeId": route, "routeName": route,
        "departureTime": f"{dep // 60:02d}:{dep % 60:02d}",
        "arrivalTime": f"{arr // 60:02d}:{arr % 60:02d}",
        "departureMin": dep, "arrivalMin": arr,
        "firstStopName": frm, "lastStopName": to,
        "stopCount": 10, "durationMin": arr - dep, "directionId": 0, "clusterStops": [],
    }


def make_block(vid, route, start, n_round=4, half=22, sosta=6):
    """n_round giri A/R dall'hub; inizia e finisce all'hub."""
    trips = []
    t = start
    for i in range(n_round):
        trips.append(trip(f"{vid}_o{i}", route, t, t + half, HUB, OUTER))
        trips.append(trip(f"{vid}_r{i}", route, t + half, t + 2 * half, OUTER, HUB))
        t += 2 * half + sosta
    return {"vehicleId": vid, "vehicleType": "12m", "category": "urbano", "trips": trips}, t


def main():
    n = int(sys.argv[1]) if len(sys.argv) > 1 else 12
    shifts = []
    for k in range(n):
        base = 360 + (k % 6) * 20          # mattine scaglionate 06:00..07:40
        a, a_end = make_block(f"A{k:02d}", f"R{k % 3}", base, n_round=4)
        # B riparte 20' dopo la fine di A, stesso hub -> stacco che resetta la guida
        b, _ = make_block(f"B{k:02d}", f"R{k % 3}", a_end + 14, n_round=4)
        shifts.append(a)
        shifts.append(b)
    json.dump({"vehicleShifts": shifts, "config": {"solverIntensity": 2}}, open("/dev/stdout", "w"))


if __name__ == "__main__":
    main()
