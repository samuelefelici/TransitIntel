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
            "final": {"vsp": {"metrics": {"vehicles": 1, "totalTrips": 4, "totalServiceKm": 40.0, "totalDeadheadKm": 3.2, "totalDeadheadMin": 15, "totalServiceMin": 360, "costEur": 100.0,
                                          "sagoma": {"corseDeclassate": 2, "pctDeclassate": 50.0, "declassateInPunta": 1,
                                                     "fuoriSagoma": 0, "doppiDeclassamenti": 0, "fascePunta": [[15, 20]],
                                                     "blocchiPerTipo": {"12m": 1}, "lineeDeclassate": {"3": 2},
                                                     "catenSpezzate": 1,
                                                     "superamenti": ["linea 3: 2 corse su 4 con un mezzo piu' piccolo"]}},
                                "costBreakdown": {"aggregated": {"total": 100.0, "vcspPenalty": 12.0}},
                                "vehicleShifts": shifts},
                      "crew": {"summary": {"totalDriverShifts": 2, "totalDailyCost": 600.0, "companyCarsMaxSimultaneous": 1, "byType": {"intero": 1, "spezzato": 1}}, "driverShifts": duties, "metrics": {}},
                      "vcsp": {"bestRound": 2, "selectedRound": 2,
                               "rounds": [{"round": 1, "vehicles": 2, "duties": 3, "supplementi": 0, "bdsViolations": 2,
                                           "totalCostEur": 900.0, "shadowPenaltyEur": 0.0, "selectionScoreEur": 1500.0},
                                          {"round": 2, "probe": True, "vehicles": 1, "duties": 2, "supplementi": 0,
                                           "bdsViolations": 0, "totalCostEur": 700.0, "shadowPenaltyEur": 12.0,
                                           "selectionScoreEur": 1200.0}],
                               "ciclo": {"passo": 0.5, "ancora": "best", "seme": True,
                                         "pazienza": 3, "controllo": True},
                               "feedback": [{"afterRound": 1, "passo": 0.5,
                                             "ancora": {"round": 1, "modo": "best", "cambiInRegola": True},
                                             "blocksPenalized": 2, "arcsPenalized": 7, "archiInVigore": 9,
                                             "massaPenalitaEur": 40.0, "distanzaDalPrecedenteEur": 40.0,
                                             "giunti": {"escalation": 1.0}}],
                               "probe": {"shiftedTrips": 2, "shiftedTripMin": 20, "probesRun": 3, "disruptionEur": 20.0,
                                         "shiftPenaltyEurPerTripMin": 1,
                                         "controllo": {"eseguito": True, "riferimento": "round",
                                                       "vetture": {"round": 2, "controllo": 2}},
                                         "memoria": {"giriLetti": 1, "lezioniLette": 5, "ripresi": 1, "rimandatiInCoda": 2},
                                         "accepted": [{"kind": "coincidenza", "disruptionEur": 20.0,
                                                       "shiftsByRoute": [{"routeName": "3", "deltaMin": -10, "trips": 2}],
                                                       "before": {"vehicles": 2, "duties": 3, "bdsViolations": 2},
                                                       "after": {"vehicles": 1, "duties": 2, "bdsViolations": 0}}],
                                         "lezioni": [{"firma": "linea:7:-11", "route": "7", "deltaMin": -11,
                                                      "esito": "scartato", "motivo": "coincidenza:catenaTroppoLunga",
                                                      "tentativi": 4},
                                                     {"firma": "tail-:x", "esito": "scartato", "motivo": "vsp",
                                                      "tentativi": 1}]}},
                      "params": {"vcsp": {"rounds": 2, "probes": 4}, "weights": {"preferIntero": 8}, "weightFactors": {"duty": 1.0, "spezz": 1.3}, "companyCars": 5,
                                 "shiftRules": {"intero": {"maxNastro": 435, "maxLavoro": 435, "intMin": 0, "intMax": 0, "maxPct": 100, "sostaMinCapolinea": 15},
                                                "spezzato": {"maxNastro": 630, "maxLavoro": 450, "intMin": 180, "intMax": 999, "maxPct": 13}},
                                 "provenance": {"crewConfig": "scenario", "vehicleCosts": "default"}}},
            "costs": {"notes": ["prova"]},
            "analisi": {"coincidenze": {
                "corse": 4, "corseConPassaggi": 2, "sogliaAttesaMin": 5, "attesaMinimaMin": 2, "minOccorrenze": 3,
                "esistenti": [{"node": "CAVOUR", "fromRoute": "1/4", "toRoute": "3", "occurrences": 4,
                               "attesaMin": {"min": 2, "max": 5, "mediana": 3}, "giaInCoincidenza": 0,
                               "sample": [{"arrivo": "08:40", "partenza": "08:43", "attesaMin": 3}]}],
                "mancatePerPoco": [{"node": "TAVERNELLE", "fromRoute": "3", "toRoute": "1/4", "occurrences": 6,
                                    "attesaMin": {"min": 8, "max": 14, "mediana": 11},
                                    "giaInCoincidenza": 0}],
                "opportunita": [{"route": "3", "corse": 12, "flexDichiarataMin": 10,
                                 "migliore": {"deltaMin": -7, "create": 2, "rotte": 0, "dentroLaFlessibilita": True}}],
                "nota": "nota di prova"}}}


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
    assert s["duties"] == 2 and s["vehicles"] == 1 and s["violations"] == 1 and s["isTest"] is True
    assert set(s["byType"]) == {"intero", "spezzato"}
    # moneta onesta: il costo vetture esce al NETTO delle penalita' inventate
    assert s["vehicleCostEur"] == 88.0, s["vehicleCostEur"]
    assert s["totalCostEur"] == 688.0, s["totalCostEur"]


def test_le_analisi_fatte_finiscono_tutte_nel_documento():
    """La relazione deve raccontare anche COME il piano e' stato prodotto e che
    servizio produce, non solo il risultato: il ciclo integrato con i suoi
    giri, il termometro del feedback, la sonda con le sue lezioni, la regola
    della sagoma e la mappa delle coincidenze."""
    html = rb.build(_dossier())
    for needle in ("7. Il ciclo integrato", "I giri del ciclo", "Come il segnale si è mosso",
                   "La sonda: spostare corse per salvare un turno", "Il controllo", "La memoria",
                   "8. Coincidenze fra linee", "Le relazioni che l'orario realizza",
                   "Le occasioni mancate per poco", "Che cosa si guadagnerebbe spostando una linea",
                   "Regola della sagoma", "9. Costi", "10. Scenari confrontati", "11. Allegati"):
        assert needle in html, needle
    # i motivi dei rifiuti sono spiegati a parole, non in gergo
    assert "la catena da trascinare è troppo lunga" in html
    assert "coincidenza:catenaTroppoLunga" not in html
    # le penalita' inventate sono dichiarate, non nascoste
    assert "non sono spesa" in html


def test_il_documento_regge_senza_le_analisi_nuove():
    """Uno scenario prodotto senza ciclo integrato e senza mappa deve comunque
    produrre il documento, dicendo che quelle analisi non ci sono."""
    d = _dossier()
    d["final"].pop("vcsp", None)
    d.pop("analisi", None)
    html = rb.build(d)
    assert "7. Il ciclo integrato" in html and "senza retroazione" in html
    assert "8. Coincidenze fra linee" in html and "non disponibile" in html


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


def test_il_termometro_si_legge_in_tutte_e_due_le_forme():
    """Il bug che ha fatto morire la prima relazione col capitolo 7.

    Il dossier porta il feedback GREZZO come esce dal motore: `ancora` e' un
    oggetto {round, modo, cambiInRegola}, non un numero. Il cruscotto invece
    lo appiattisce prima di mostrarlo. La relazione deve reggere entrambe le
    forme e leggerne gli stessi numeri, o si spacca a seconda di chi gliel'ha
    passata."""
    grezzo = {"afterRound": 2, "ancora": {"round": 1, "modo": "best", "cambiInRegola": False},
              "blocksPenalized": 4, "arcsPenalized": 11, "archiInVigore": 13,
              "massaPenalitaEur": 205.67, "distanzaDalPrecedenteEur": 103.05,
              "giunti": {"escalation": 1.5}}
    appiattito = {"dopoRound": 2, "ancora": 1, "modo": "best", "blocchiPenalizzati": 4,
                  "archiDalPiano": 11, "archiInVigore": 13, "massaPenalitaEur": 205.67,
                  "spostamentoEur": 103.05, "escalationGiunti": 1.5}
    a, b = rb._fb_termometro(grezzo), rb._fb_termometro(appiattito)
    for campo in ("dopoRound", "ancoraRound", "modo", "blocchi", "archiInVigore",
                  "massaEur", "spostamentoEur", "escalation"):
        assert a[campo] == b[campo], f"{campo}: {a[campo]!r} != {b[campo]!r}"
    assert a["ancoraRound"] == 1 and a["modo"] == "best" and a["massaEur"] == 205.67
    assert a["cambiInRegola"] is False


def test_il_capitolo_sette_dichiara_le_regole_dingaggio():
    """Le manopole con cui il ciclo ha girato vanno dette, non lasciate intendere."""
    d = _dossier()
    html = rb.render_ciclo(d)
    assert "regole d'ingaggio" in html
    assert "50 %" in html                      # passo 0.5
    assert "il giro migliore fin qui" in html  # ancora best
    assert "catene del piano migliore" in html # seme acceso
    assert "calcolo di controllo" in html      # controllo acceso


def test_le_attese_delle_coincidenze_si_leggono_dalla_forma_vera():
    """Il secondo bug della stessa famiglia.

    L'analisi delle coincidenze scrive l'attesa come oggetto
    {min, max, mediana}; la relazione la cercava in tre campi piatti che non
    esistono, e le colonne «Attesa» sarebbero uscite vuote."""
    oggetto = {"attesaMin": {"min": 8, "max": 14, "mediana": 11}}
    piatta = {"attesaMinMin": 8, "attesaMaxMin": 14, "attesaMedianaMin": 11}
    a, b = rb._attesa(oggetto), rb._attesa(piatta)
    assert a["min"] == b["min"] == 8
    assert a["max"] == b["max"] == 14
    assert a["mediana"] == b["mediana"] == 11
    assert rb._attesa({}) == {"min": None, "max": None, "mediana": None}


def test_le_attese_finiscono_davvero_nelle_tabelle():
    html = rb.render_coincidenze(_dossier())
    assert "2–5′" in html, "l'attesa delle relazioni realizzate non e' stampata"
    assert "8–14′" in html, "l'attesa delle relazioni mancate non e' stampata"


def test_i_formattatori_non_uccidono_la_relazione():
    """Un campo che cambia forma nel dossier deve costare una cella vuota,
    non il documento intero. E' cosi' che la relazione col capitolo 7 e' morta
    la prima volta: `ancora` da numero era diventato un oggetto, e
    f"{dict:,.0f}" ha fermato la generazione a meta'."""
    for strano in ({"round": 1, "modo": "best"}, [1, 2, 3], object(), "non un numero"):
        assert rc.fmt_n(strano) == "–"
        assert rc.fmt_eur(strano) == "–"
    assert rc.fmt_n(None) == "–" and rc.fmt_eur(None) == "–"
    # I numeri veri passano intatti, comunque siano scritti.
    assert rc.fmt_n(1234.5, 1) == "1.234,5"
    assert rc.fmt_n("1234.5", 1) == "1.234,5"
    assert rc.fmt_eur(1234) == "€ 1.234"
    # Il booleano non e' un numero: True non deve diventare 1.
    assert rc.fmt_n(True) == "–"


def test_un_capitolo_rotto_non_si_porta_via_la_relazione(monkeypatch, capsys):
    """La regola imparata sul campo: meglio un capitolo mancante, dichiarato,
    che un documento che non esiste. L'operatore deve avere comunque il resto,
    e il guasto deve restare nei log per essere corretto."""
    def esplode(_d):
        raise TypeError("unsupported format string passed to dict.__format__")
    monkeypatch.setattr(rb, "render_coincidenze", esplode)
    html = rb.build(_dossier())
    assert "non e' stato prodotto" in html.replace("'", "'")
    assert "TypeError" in html
    # Il resto c'e' tutto.
    assert "7. Il ciclo integrato" in html and "Turni guida" in html
    assert html.startswith("<!doctype html>") and html.rstrip().endswith("</html>")
    # E il guasto e' finito nei log, non solo nel documento.
    assert "coincidenze" in capsys.readouterr().err
