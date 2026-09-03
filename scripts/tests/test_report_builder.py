"""Relazione di processo: la libreria grafici rispetta le regole di forma e il
builder regge dossier vuoti, parziali e completi producendo tutte le sezioni."""
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import report_builder as rb  # noqa: E402
import report_charts as rc  # noqa: E402


def _duty(did, dtype, pieces, nastro, work, interruption=0, cost=300.0, viol=0):
    return {"driverId": did, "type": dtype, "nastroMin": nastro, "workMin": work, "interruptionMin": interruption,
            "nastroStartMin": pieces[0]["startMin"], "cambiCount": len(pieces) - 1, "costEuro": cost,
            "costBreakdown": {"baseSalary": cost * 0.8, "transferDepotCost": cost * 0.2, "total": cost},
            "bdsValidation": {"violations": [{"message": "violazione di prova"}] * viol, "warnings": []},
            "riprese": pieces}


def _piece(veh, start, end, trips):
    return {"startMin": start, "endMin": end, "vehicleIds": [veh],
            "trips": [{"tripId": f"t{start}{i}", "routeName": r, "departureMin": s, "arrivalMin": e, "vehicleId": veh} for i, (r, s, e) in enumerate(trips)]}


def _dossier():
    shifts = [{"vehicleId": "V1", "vehicleType": "12m", "startMin": 420, "endMin": 900, "tripCount": 4, "totalServiceMin": 360, "totalDeadheadKm": 3.2, "depotReturns": 0, "shiftDuration": 480,
               "trips": [{"type": "deadhead", "departureMin": 420, "arrivalMin": 435, "deadheadKm": 3.2, "deadheadMin": 15, "depotLeg": "out", "firstStopName": "Deposito", "lastStopName": "Cavour"},
                         {"type": "trip", "routeName": "1/4", "departureMin": 440, "arrivalMin": 520, "departureTime": "07:20", "arrivalTime": "08:40", "firstStopName": "Cavour", "lastStopName": "Tavernelle"},
                         {"type": "trip", "routeName": "1/4", "departureMin": 530, "arrivalMin": 610, "firstStopName": "Tavernelle", "lastStopName": "Cavour"},
                         {"type": "trip", "routeName": "3", "departureMin": 620, "arrivalMin": 700}, {"type": "trip", "routeName": "3", "departureMin": 710, "arrivalMin": 890}]}]
    duties = [_duty("U1", "intero", [_piece("V1", 440, 700, [("1/4", 440, 520), ("1/4", 530, 610), ("3", 620, 700)]), _piece("V1", 710, 890, [("3", 710, 890)])], 450, 440, 10, viol=1),
              _duty("U2", "spezzato", [_piece("V1", 440, 610, [("1/4", 440, 520), ("1/4", 530, 610)]), _piece("V1", 800, 890, [("3", 800, 890)])], 450, 260, 190)]
    return {"meta": {"projectName": "P", "udpName": "U", "serviceDate": "2026-09-20", "isTest": True, "scenarioName": "S"},
            "network": {"lines": [{"name": "1/4", "routeId": "r1", "trips": 2, "km": 12.5, "firstDep": "07:20", "lastDep": "08:50", "headway": "30′", "vehicleType": "12m", "flexMin": 10}],
                        "stopsCount": 2, "nodes": ["CAVOUR"], "polylines": [{"name": "1/4", "points": [(43.6, 13.5), (43.61, 13.52)]}],
                        "stops": [{"name": "Cavour", "lat": 43.6, "lon": 13.5, "node": True}]},
            "planning": {"timeline": [{"at": "2026-09-01 10:00", "action": "ps.trips.generate", "who": "op", "via": "argos", "detail": "×2"}],
                         "decisions": [{"kind": "decisione", "content": "cadenza 30′"}], "plans": [{"id": 1, "at": "2026-09-01", "goal": "g", "summary": "s", "status": "completed"}],
                         "validities": [{"name": "U", "trips": 4, "dayTypes": ["Festivo"]}], "flex": [{"line": "1/4", "flexMin": 10}]},
            "runs": [{"name": "A", "at": "2026-09-01 11:00", "kpi": {"vehicles": 1, "duties": 3, "violations": 1, "byType": {"intero": 1, "semiunico": 1, "spezzato": 1}, "vehicleCostEur": 100, "crewCostEur": 900, "totalCostEur": 1000, "selectionScoreEur": 1700}},
                     {"name": "B", "at": "2026-09-01 12:00", "selected": True, "kpi": {"vehicles": 1, "duties": 2, "violations": 1, "byType": {"intero": 1, "spezzato": 1}, "vehicleCostEur": 100, "crewCostEur": 600, "totalCostEur": 700, "selectionScoreEur": 1200}}],
            "final": {"vsp": {"metrics": {"vehicles": 1, "totalTrips": 4, "totalServiceKm": 40.0, "totalDeadheadKm": 3.2, "totalDeadheadMin": 15, "totalServiceMin": 360, "costEur": 100.0}, "vehicleShifts": shifts},
                      "crew": {"summary": {"totalDriverShifts": 2, "totalDailyCost": 600.0, "companyCarsMaxSimultaneous": 1, "byType": {"intero": 1, "spezzato": 1}}, "driverShifts": duties, "metrics": {}},
                      "params": {"vcsp": {"rounds": 2, "probes": 4}, "weights": {"preferIntero": 8}, "weightFactors": {"duty": 1.0, "spezz": 1.3}, "companyCars": 5,
                                 "shiftRules": {"intero": {"maxNastro": 435, "maxLavoro": 435, "intMin": 0, "intMax": 0, "maxPct": 100, "sostaMinCapolinea": 15},
                                                "spezzato": {"maxNastro": 630, "maxLavoro": 450, "intMin": 180, "intMax": 999, "maxPct": 13}},
                                 "provenance": {"crewConfig": "scenario", "vehicleCosts": "default"}}},
            "costs": {"notes": ["prova"]}}


def test_charts_have_table_twin_and_legend_rules():
    one = rc.bar_h([("a", 1), ("b", 2)], "T", unit="u")
    assert "<svg" in one and 'class="tv"' in one and 'class="legend"' not in one   # una serie: niente legenda
    two = rc.columns(["x", "y"], [("s1", [1, 2]), ("s2", [2, 1])], "T", stacked=True)
    assert 'class="legend"' in two and two.count("<i style") == 2 and 'class="tv"' in two
    ln = rc.lines(["06", "07", "08"], [("v", [1, 3, 2])], "T")
    assert "<polyline" in ln and 'stroke-width="2"' in ln and 'class="legend"' not in ln
    gt = rc.gantt([{"label": "U1", "segments": [{"start": 400, "end": 460, "kind": "trip"}, {"start": 460, "end": 520, "kind": "break"}]}], "G")
    assert "<rect" in gt and "interruzione" in gt
    mp = rc.network_map([{"name": "1", "points": [(43.6, 13.5), (43.61, 13.51)]}], [{"name": "N", "lat": 43.6, "lon": 13.5, "node": True}], "M")
    assert "<path" in mp and "N" in mp
    assert rc.bar_h([], "vuoto") == "" and rc.gantt([], "vuoto") == ""


def test_palette_is_the_reference_instance():
    assert rc.SERIES[0] == "#2a78d6" and len(rc.SERIES) == 8 and rc.SURFACE == "#fcfcfb"


def test_builder_on_empty_and_partial_dossier():
    html = rb.build({})
    assert "<h1>" in html and "Relazione" in html
    for _, title in rb.TOC:
        assert title in html
    html2 = rb.build({"meta": {"isTest": True}, "final": {"vsp": {"metrics": {"vehicles": 0}}}})
    assert "Versione di prova" in html2


def test_builder_full_dossier_sections_and_summary():
    d = _dossier()
    html = rb.build(d)
    for needle in ("1. Sintesi per la direzione", "Diagramma tempo-vettura", "Diagramma tempo-turno", "Distribuzione del nastro",
                   "Valori unitari in uso", "Scenari confrontati", "Turni macchina, corsa per corsa", "Turni guida, pezzo per pezzo",
                   "violazione di prova", "Tariffa oraria conducente", "Regole di struttura", "Sonda di spostamento", "Disegno della rete",
                   "cadenza 30′", "ps.trips.generate", "Paga base"):
        assert needle in html, needle
    assert "★ B" in html
    s = rb.summary_of(d)
    assert s["duties"] == 2 and s["vehicles"] == 1 and s["violations"] == 1 and s["totalCostEur"] == 700.0 and s["isTest"] is True
    assert set(s["byType"]) == {"intero", "spezzato"}


def test_json_mode_roundtrip(tmp_path):
    import subprocess
    d = _dossier()
    p = tmp_path / "d.json"
    p.write_text(json.dumps(d), encoding="utf-8")
    out = subprocess.run([sys.executable, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "report_builder.py"), str(p), "--json"],
                         capture_output=True, text=True, timeout=60)
    assert out.returncode == 0, out.stderr[-500:]
    j = json.loads(out.stdout)
    assert j["summary"]["duties"] == 2 and j["html"].startswith("<!doctype html>")


def test_derivations():
    d = _dossier()
    labels, counts = rb.vehicles_by_hour(d["final"]["vsp"]["vehicleShifts"])
    assert labels and max(counts) == 1
    rows_, agg = rb.deadhead_table(d["final"]["vsp"]["vehicleShifts"])
    assert len(rows_) == 1 and abs(sum(agg.values()) - 3.2) < 1e-9
    st = rb.crew_stats(d["final"]["crew"]["driverShifts"])
    assert st["byType"]["intero"] == 1 and st["violations"] == 1 and st["interruptions"] == [190]
    rows_g = rb.duty_gantt_rows(d["final"]["crew"]["driverShifts"])
    kinds = {sg["kind"] for r in rows_g for sg in r["segments"]}
    assert "trip" in kinds and "break" in kinds
    units = rb.unit_cost_table({"vcsp": {"shiftPenaltyEur": 2}})
    assert any(u["label"].startswith("Tariffa oraria") for u in units) and any(u["value"] == 2 for u in units)
