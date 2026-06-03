#!/usr/bin/env python3
"""Genera un input sintetico per crew_scheduler_v4 (turni guida).

Crea N blocchi di picco mattutino + N di picco pomeridiano APPAIABILI come
turni biripresa (spezzato): interruzione ~3-4h, nastro complessivo entro i
limiti RD 131. Le interruzioni si sovrappongono tutte a mezzogiorno -> stressa
il vincolo vetture aziendali (cumulative) e i cap percentuali. Stampa JSON su
stdout.
"""
import json
import sys


def trip(tid, route, dep, arr, frm, to):
    return {
        "type": "trip",
        "tripId": tid,
        "routeId": route,
        "routeName": route,
        "departureTime": f"{dep // 60:02d}:{dep % 60:02d}",
        "arrivalTime": f"{arr // 60:02d}:{arr % 60:02d}",
        "departureMin": dep,
        "arrivalMin": arr,
        "firstStopName": frm,
        "lastStopName": to,
        "stopCount": 10,
        "durationMin": arr - dep,
        "directionId": 0,
        "clusterStops": [],
    }


def make_block(vid, route, start, end, leg=42, gap=6):
    """Blocco: corse avanti/indietro tra CentroA/CentroB da start a end."""
    trips = []
    t = start
    i = 0
    while t + leg <= end:
        frm, to = ("Stazione FS", "Tavernelle") if i % 2 == 0 else ("Tavernelle", "Stazione FS")
        trips.append(trip(f"{vid}_t{i}", route, t, t + leg, frm, to))
        t += leg + gap
        i += 1
    return {"vehicleId": vid, "vehicleType": "12m", "category": "urbano", "trips": trips}


def main():
    n = int(sys.argv[1]) if len(sys.argv) > 1 else 12
    shifts = []
    # N picchi mattina ~06:30-09:00, orari SCAGLIONATI (dati realistici):
    # le finestre di trasferimento vettura NON coincidono tutte allo stesso minuto.
    for k in range(n):
        shifts.append(make_block(f"M{k:02d}", f"R{k % 4}", start=390 + 6 * k, end=540 + 6 * k))
    # N picchi pomeriggio ~12:30-15:00, scaglionati in parallelo ai mattutini.
    for k in range(n):
        shifts.append(make_block(f"A{k:02d}", f"R{k % 4}", start=750 + 6 * k, end=900 + 6 * k))
    # Per ogni k: interruzione (750+6k)-(540+6k)=210min (3.5h -> spezzato),
    # nastro span (900+6k)-(390+6k)=510min+overhead < 630 (10h30) OK.
    # interruzione tra mattina (fine ~540) e pomeriggio (inizio ~750) = ~210min (3.5h)
    # -> spezzato (>=3h), nastro span 900-390=510 + overhead < 630 (10h30) OK

    payload = {
        "vehicleShifts": shifts,
        "config": {
            "solverIntensity": 2,
        },
    }
    json.dump(payload, sys.stdout)


if __name__ == "__main__":
    main()
