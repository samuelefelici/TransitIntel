#!/usr/bin/env python3
"""Input REALISTICO per il crew scheduler: N turni macchina lunghi (servizio
06:00-20:00) che fanno giri di andata/ritorno su un hub cluster ("Stazione FS").

Ogni giro (~round trip) e' un potenziale pezzo; il cambio conducente e' possibile
all'hub tra un giro e l'altro, anche tra bus diversi. Questo costringe a spezzare
i blocchi e premia la concatenazione (relief) per ridurre i turni guida.
Stampa JSON su stdout.  Uso: _gen_crew_realistic.py [n_blocchi] [round_min]
"""
import json
import sys

HUB = "Stazione FS"          # hub cluster (keyword match)
OUTER = "Capolinea Nord"     # fermata esterna (non cluster) -> giro di andata/ritorno


def trip(tid, route, dep, arr, frm, to):
    return {
        "type": "trip", "tripId": tid, "routeId": route, "routeName": route,
        "departureTime": f"{dep // 60:02d}:{dep % 60:02d}",
        "arrivalTime": f"{arr // 60:02d}:{arr % 60:02d}",
        "departureMin": dep, "arrivalMin": arr,
        "firstStopName": frm, "lastStopName": to,
        "stopCount": 12, "durationMin": arr - dep, "directionId": 0,
        "clusterStops": [],
    }


def make_long_block(vid, route, start=360, end=1200, half=22, sosta=6):
    """Giri di A/R dall'hub: hub->outer (half) sosta hub->... termina all'hub.
    round = 2*half + sosta. Ogni giro inizia e finisce all'hub (relief point)."""
    trips = []
    t = start
    i = 0
    while t + 2 * half + sosta <= end:
        # andata hub->outer
        trips.append(trip(f"{vid}_o{i}", route, t, t + half, HUB, OUTER))
        # ritorno outer->hub
        trips.append(trip(f"{vid}_r{i}", route, t + half, t + 2 * half, OUTER, HUB))
        t += 2 * half + sosta
        i += 1
    return {"vehicleId": vid, "vehicleType": "12m", "category": "urbano", "trips": trips}


def main():
    n = int(sys.argv[1]) if len(sys.argv) > 1 else 12
    half = int(sys.argv[2]) if len(sys.argv) > 2 else 22
    shifts = []
    for k in range(n):
        # leggero scaglionamento di inizio/fine per realismo
        shifts.append(make_long_block(
            f"V{k:02d}", f"R{k % 3}",
            start=360 + (k % 4) * 8,
            end=1170 + (k % 3) * 10,
            half=half,
        ))
    json.dump({"vehicleShifts": shifts, "config": {"solverIntensity": 2}}, open("/dev/stdout", "w"))


if __name__ == "__main__":
    main()
